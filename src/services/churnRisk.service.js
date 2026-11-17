import { prisma } from "../config/prisma.js"
import { CANONICAL_TRANSACTION_STATUSES } from "./transactionStatus.service.js"

// --- From-scratch logistic regression (pure, DB-independent) -----------
// Mirrors the "from scratch, no ML library" style already used for K-Means++
// in rfmSegmentation.service.js, but for supervised learning: a customer
// either churns (no booking in the next OUTCOME_WINDOW_DAYS) or doesn't, and
// the model predicts that probability from recency/frequency/monetary-style
// behavioral features.

export const sigmoid = (z) => 1 / (1 + Math.exp(-z))

/** Fits mean/std per feature column. Must be fit on the TRAIN set only — the
 * same means/stds are then applied to test data and to live scoring data so
 * no information from outside the training set leaks into the features. */
export const standardizeFeatures = (matrix) => {
  const rowCount = matrix.length
  const featureCount = matrix[0]?.length || 0
  const means = Array(featureCount).fill(0)
  const stds = Array(featureCount).fill(1)
  if (!rowCount) return { means, stds }

  for (let col = 0; col < featureCount; col += 1) {
    let sum = 0
    for (let row = 0; row < rowCount; row += 1) sum += matrix[row][col]
    means[col] = sum / rowCount
  }
  for (let col = 0; col < featureCount; col += 1) {
    let variance = 0
    for (let row = 0; row < rowCount; row += 1) variance += (matrix[row][col] - means[col]) ** 2
    variance /= rowCount
    // A zero-variance (constant) feature would divide by zero; leave it at
    // scale 1 so it just becomes a constant zero after centering instead.
    stds[col] = variance > 0 ? Math.sqrt(variance) : 1
  }

  return { means, stds }
}

export const applyStandardization = (matrix, means, stds) =>
  matrix.map((row) => row.map((value, col) => (value - means[col]) / stds[col]))

/**
 * Batch gradient descent, L2-regularized logistic regression. Deterministic
 * (zero-initialized weights, no RNG) so repeated training on the same
 * dataset yields identical models.
 */
export const trainLogisticRegression = ({
  X,
  y,
  learningRate = 0.1,
  iterations = 500,
  l2 = 0.01,
}) => {
  const sampleCount = X.length
  const featureCount = X[0]?.length || 0
  const weights = Array(featureCount).fill(0)
  let intercept = 0
  const lossHistory = []

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const weightGradients = Array(featureCount).fill(0)
    let interceptGradient = 0
    let loss = 0

    for (let row = 0; row < sampleCount; row += 1) {
      let z = intercept
      for (let col = 0; col < featureCount; col += 1) z += X[row][col] * weights[col]
      const prediction = sigmoid(z)
      const error = prediction - y[row]

      for (let col = 0; col < featureCount; col += 1) {
        weightGradients[col] += error * X[row][col]
      }
      interceptGradient += error

      const clamped = Math.min(Math.max(prediction, 1e-12), 1 - 1e-12)
      loss += -(y[row] * Math.log(clamped) + (1 - y[row]) * Math.log(1 - clamped))
    }

    for (let col = 0; col < featureCount; col += 1) {
      weights[col] -= learningRate * (weightGradients[col] / sampleCount + l2 * weights[col])
    }
    intercept -= learningRate * (interceptGradient / sampleCount)

    const l2Penalty = (l2 / 2) * weights.reduce((sum, weight) => sum + weight * weight, 0)
    lossHistory.push(loss / sampleCount + l2Penalty)
  }

  return { weights, intercept, lossHistory }
}

export const predictProbabilities = (X, weights, intercept) =>
  X.map((row) => sigmoid(row.reduce((sum, value, index) => sum + value * weights[index], intercept)))

/**
 * Area under the ROC curve via the rank-sum (Mann-Whitney U) formulation —
 * no library, and no need to sweep thresholds explicitly. Ties share the
 * average rank of their block.
 */
export const computeAUC = (yTrue, yScores) => {
  const paired = yTrue.map((label, index) => ({ label, score: yScores[index] }))
  const positives = paired.filter((point) => point.label === 1)
  const negatives = paired.filter((point) => point.label === 0)
  if (!positives.length || !negatives.length) return null

  const sorted = [...paired].sort((a, b) => a.score - b.score)
  const rankByPoint = new Map()
  let index = 0
  while (index < sorted.length) {
    let end = index
    while (end + 1 < sorted.length && sorted[end + 1].score === sorted[index].score) end += 1
    const averageRank = (index + 1 + end + 1) / 2
    for (let tieIndex = index; tieIndex <= end; tieIndex += 1) rankByPoint.set(sorted[tieIndex], averageRank)
    index = end + 1
  }

  const sumPositiveRanks = positives.reduce((sum, point) => sum + rankByPoint.get(point), 0)
  const nPos = positives.length
  const nNeg = negatives.length
  return (sumPositiveRanks - (nPos * (nPos + 1)) / 2) / (nPos * nNeg)
}

export const computeConfusionMetrics = (yTrue, yScores, threshold = 0.5) => {
  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0

  yTrue.forEach((label, index) => {
    const predicted = yScores[index] >= threshold ? 1 : 0
    if (predicted === 1 && label === 1) tp += 1
    else if (predicted === 1 && label === 0) fp += 1
    else if (predicted === 0 && label === 0) tn += 1
    else fn += 1
  })

  const precision = tp + fp > 0 ? tp / (tp + fp) : null
  const recall = tp + fn > 0 ? tp / (tp + fn) : null
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null

  return { tp, fp, tn, fn, precision, recall, f1 }
}

// --- Leakage-safe snapshot/label construction (pure) --------------------

const DAY_MS = 86400000
export const OUTCOME_WINDOW_DAYS = 90
export const ELIGIBILITY_RECENCY_DAYS = 180
const TRAILING_WINDOW_DAYS = 180
const SNAPSHOT_BUFFER_DAYS = 180
const SNAPSHOT_STEP_DAYS = 30
const MAX_SNAPSHOTS = 36

export const CHURN_FEATURE_NAMES = [
  "recencyDays",
  "log1pFrequency180",
  "log1pMonetary180",
  "bookingTrend",
  "avgDaysBetweenBookings",
  "tenureDays",
]

const daysBetween = (laterDate, earlierDate) =>
  Math.round((laterDate.getTime() - earlierDate.getTime()) / DAY_MS)

const roundNumber = (value, precision = 4) => Number(Number(value || 0).toFixed(precision))

/**
 * One labeled training/scoring row for `timeline` as of `snapshotDate`.
 * Every feature is computed strictly from entries before snapshotDate —
 * the label alone looks forward, into (snapshotDate, snapshotDate+window] —
 * so there is no leakage between what the model sees and what it predicts.
 * Returns null when the customer wasn't "active" as of snapshotDate (no
 * prior booking, or last booking too long ago to count as currently active).
 */
export const computeSnapshotFeatures = (
  timeline,
  snapshotDate,
  { outcomeWindowDays = OUTCOME_WINDOW_DAYS, eligibilityRecencyDays = ELIGIBILITY_RECENCY_DAYS } = {}
) => {
  const history = timeline.entries.filter((entry) => entry.playDate < snapshotDate)
  if (!history.length) return null

  const latest = history[history.length - 1]
  const recencyDays = daysBetween(snapshotDate, latest.playDate)
  if (recencyDays > eligibilityRecencyDays) return null

  const trailingStart = new Date(snapshotDate.getTime() - TRAILING_WINDOW_DAYS * DAY_MS)
  const trailing = history.filter((entry) => entry.playDate >= trailingStart)
  const frequency180 = trailing.length
  const monetary180 = trailing.reduce((sum, entry) => sum + entry.revenue, 0)

  const recentStart = new Date(snapshotDate.getTime() - 90 * DAY_MS)
  const freqRecent90 = history.filter((entry) => entry.playDate >= recentStart).length
  const freqPrior90 = history.filter(
    (entry) => entry.playDate >= trailingStart && entry.playDate < recentStart
  ).length
  const bookingTrend = (freqRecent90 + 1) / (freqPrior90 + 1)

  const first = history[0]
  const tenureDays = daysBetween(snapshotDate, first.playDate)
  const avgDaysBetweenBookings = history.length >= 2
    ? daysBetween(latest.playDate, first.playDate) / (history.length - 1)
    : recencyDays

  const outcomeEnd = new Date(snapshotDate.getTime() + outcomeWindowDays * DAY_MS)
  const hasFutureBooking = timeline.entries.some(
    (entry) => entry.playDate > snapshotDate && entry.playDate <= outcomeEnd
  )

  return {
    customerKey: timeline.customerKey,
    customerName: timeline.customerName,
    snapshotDate,
    features: [
      recencyDays,
      Math.log1p(Math.max(0, frequency180)),
      Math.log1p(Math.max(0, monetary180)),
      bookingTrend,
      avgDaysBetweenBookings,
      tenureDays,
    ],
    label: hasFutureBooking ? 0 : 1,
  }
}

/** Monthly snapshot dates spanning (earliest+buffer) through (latest-window). */
export const buildSnapshotDates = ({
  earliestDate,
  latestDate,
  bufferDays = SNAPSHOT_BUFFER_DAYS,
  outcomeWindowDays = OUTCOME_WINDOW_DAYS,
  stepDays = SNAPSHOT_STEP_DAYS,
  maxSnapshots = MAX_SNAPSHOTS,
}) => {
  const start = new Date(earliestDate.getTime() + bufferDays * DAY_MS)
  const end = new Date(latestDate.getTime() - outcomeWindowDays * DAY_MS)
  if (start > end) return []

  const dates = []
  let cursor = start
  while (cursor <= end && dates.length < maxSnapshots) {
    dates.push(cursor)
    cursor = new Date(cursor.getTime() + stepDays * DAY_MS)
  }
  return dates
}

/** Sweeps every (customer timeline x snapshot date) combination into a flat labeled dataset. */
export const buildChurnDataset = (timelines, snapshotDates, options = {}) => {
  const records = []
  for (const timeline of timelines) {
    for (const snapshotDate of snapshotDates) {
      const record = computeSnapshotFeatures(timeline, snapshotDate, options)
      if (record) records.push(record)
    }
  }
  return records
}

// --- DB orchestration -----------------------------------------------------

const MIN_DATASET_SIZE = 100
const MIN_SPLIT_SIZE = 20
const TEST_SPLIT_LOOKBACK_DAYS = 180
const DEFAULT_THRESHOLD = 0.5
const HIGH_RISK_THRESHOLD = 0.7
const MEDIUM_RISK_THRESHOLD = 0.4

export const classifyChurnRisk = (probability) =>
  probability >= HIGH_RISK_THRESHOLD ? "High" : probability >= MEDIUM_RISK_THRESHOLD ? "Medium" : "Low"

const toNumber = (value) => {
  if (value === null || value === undefined) return 0
  if (typeof value === "number") return value
  if (typeof value === "object" && typeof value.toNumber === "function") return value.toNumber()
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const fetchEligibleTransactions = (db) =>
  db.facilityTransaction.findMany({
    where: {
      validBooking: true,
      netRevenue: { gt: 0 },
      status: {
        in: [CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED, CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN],
      },
      customerKey: { startsWith: "CUST-" },
      bookingEventKey: { not: "" },
      playDate: { not: null },
    },
    orderBy: [{ customerKey: "asc" }, { playDate: "asc" }],
    select: {
      customerKey: true,
      customerName: true,
      normalizedName: true,
      nama: true,
      playDate: true,
      netRevenue: true,
      bookingEventKey: true,
    },
  })

/** One booking-deduplicated timeline per customer, oldest entry first. */
const buildCustomerTimelines = (transactions) => {
  const timelines = new Map()
  const seenEventKeysByCustomer = new Map()

  for (const row of transactions) {
    if (!row.customerKey || row.customerKey.startsWith("SYS-")) continue

    const seenEventKeys = seenEventKeysByCustomer.get(row.customerKey) || new Set()
    if (seenEventKeys.has(row.bookingEventKey)) continue
    seenEventKeys.add(row.bookingEventKey)
    seenEventKeysByCustomer.set(row.customerKey, seenEventKeys)

    const timeline = timelines.get(row.customerKey) || {
      customerKey: row.customerKey,
      customerName: row.customerName || row.nama || row.normalizedName || row.customerKey,
      entries: [],
    }
    timeline.entries.push({ playDate: new Date(row.playDate), revenue: toNumber(row.netRevenue) })
    timelines.set(row.customerKey, timeline)
  }

  return [...timelines.values()].map((timeline) => ({
    ...timeline,
    entries: [...timeline.entries].sort((left, right) => left.playDate - right.playDate),
  }))
}

const serializeRun = (run) =>
  run && {
    id: run.id,
    trainedAt: run.trainedAt,
    status: run.status,
    errorMessage: run.errorMessage,
    featureNames: run.featureNames,
    threshold: run.threshold,
    trainSize: run.trainSize,
    testSize: run.testSize,
    trainPositiveRate: run.trainPositiveRate,
    testPositiveRate: run.testPositiveRate,
    aucTest: run.aucTest,
    precisionTest: run.precisionTest,
    recallTest: run.recallTest,
    f1Test: run.f1Test,
  }

const getChurnModelRunById = async (db, id) => serializeRun(await db.churnModelRun.findUnique({ where: { id } }))

const finalizeInsufficientData = async (db, runId, reason) => {
  await db.churnModelRun.update({
    where: { id: runId },
    data: { status: "insufficient_data", errorMessage: reason },
  })
  return getChurnModelRunById(db, runId)
}

/**
 * Full churn-risk pipeline: build a leakage-safe labeled dataset from
 * historical monthly snapshots, time-split it into train/test (not random —
 * train is strictly before test chronologically), train and honestly
 * evaluate a logistic regression on that split, then refit on the full
 * dataset for the model actually used to score currently-active customers.
 */
export const runChurnModelTraining = async ({ performedByUserId = null, db = prisma } = {}) => {
  const run = await db.churnModelRun.create({ data: { status: "running", performedByUserId } })

  try {
    const transactions = await fetchEligibleTransactions(db)
    const timelines = buildCustomerTimelines(transactions)

    if (!timelines.length) {
      return await finalizeInsufficientData(db, run.id, "No eligible customer transactions were found.")
    }

    let earliestTime = Infinity
    let latestTime = -Infinity
    for (const timeline of timelines) {
      for (const entry of timeline.entries) {
        const time = entry.playDate.getTime()
        if (time < earliestTime) earliestTime = time
        if (time > latestTime) latestTime = time
      }
    }
    const earliestDate = new Date(earliestTime)
    const latestDate = new Date(latestTime)

    const snapshotDates = buildSnapshotDates({ earliestDate, latestDate })
    if (!snapshotDates.length) {
      return await finalizeInsufficientData(
        db,
        run.id,
        "Not enough historical date range to build training snapshots (need earliest booking + 180 days through latest booking - 90 days)."
      )
    }

    const dataset = buildChurnDataset(timelines, snapshotDates)
    if (dataset.length < MIN_DATASET_SIZE) {
      return await finalizeInsufficientData(
        db,
        run.id,
        `Only ${dataset.length} eligible customer-snapshot rows were available; at least ${MIN_DATASET_SIZE} are required to train and evaluate a model.`
      )
    }

    const splitDate = new Date(latestDate.getTime() - TEST_SPLIT_LOOKBACK_DAYS * DAY_MS)
    const trainRecords = dataset.filter((record) => record.snapshotDate < splitDate)
    const testRecords = dataset.filter((record) => record.snapshotDate >= splitDate)

    if (trainRecords.length < MIN_SPLIT_SIZE || testRecords.length < MIN_SPLIT_SIZE) {
      return await finalizeInsufficientData(
        db,
        run.id,
        `The time-based train/test split produced ${trainRecords.length} train and ${testRecords.length} test rows; at least ${MIN_SPLIT_SIZE} of each are required.`
      )
    }

    const trainX = trainRecords.map((record) => record.features)
    const trainY = trainRecords.map((record) => record.label)
    const testX = testRecords.map((record) => record.features)
    const testY = testRecords.map((record) => record.label)

    // Scaler is fit on TRAIN only; applied identically to test (and, below,
    // a separately-fit full-dataset scaler is applied identically to live
    // scoring data) so no information leaks across the split.
    const { means: trainMeans, stds: trainStds } = standardizeFeatures(trainX)
    const evaluationModel = trainLogisticRegression({
      X: applyStandardization(trainX, trainMeans, trainStds),
      y: trainY,
    })
    const testProbabilities = predictProbabilities(
      applyStandardization(testX, trainMeans, trainStds),
      evaluationModel.weights,
      evaluationModel.intercept
    )
    const aucTest = computeAUC(testY, testProbabilities)
    const confusion = computeConfusionMetrics(testY, testProbabilities, DEFAULT_THRESHOLD)

    // The deployed scoring model is refit on train+test combined (more data,
    // better model) — its honest performance is still the test-split metrics
    // above, computed from a model that never saw the test rows.
    const fullX = dataset.map((record) => record.features)
    const fullY = dataset.map((record) => record.label)
    const { means: fullMeans, stds: fullStds } = standardizeFeatures(fullX)
    const deployedModel = trainLogisticRegression({
      X: applyStandardization(fullX, fullMeans, fullStds),
      y: fullY,
    })

    const scoringDate = new Date(latestDate.getTime() + DAY_MS)
    const liveRecords = timelines
      .map((timeline) => computeSnapshotFeatures(timeline, scoringDate))
      .filter(Boolean)
    const liveProbabilities = predictProbabilities(
      applyStandardization(liveRecords.map((record) => record.features), fullMeans, fullStds),
      deployedModel.weights,
      deployedModel.intercept
    )

    const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length

    await db.$transaction(async (transactionClient) => {
      if (liveRecords.length) {
        await transactionClient.customerChurnScore.createMany({
          data: liveRecords.map((record, index) => ({
            runId: run.id,
            customerKey: record.customerKey,
            customerName: record.customerName,
            churnProbability: roundNumber(liveProbabilities[index]),
            riskLabel: classifyChurnRisk(liveProbabilities[index]),
            featuresSnapshot: Object.fromEntries(
              CHURN_FEATURE_NAMES.map((name, featureIndex) => [name, roundNumber(record.features[featureIndex])])
            ),
          })),
        })
      }

      await transactionClient.churnModelRun.update({
        where: { id: run.id },
        data: {
          status: "completed",
          errorMessage: null,
          featureNames: CHURN_FEATURE_NAMES,
          coefficients: deployedModel.weights,
          intercept: deployedModel.intercept,
          featureMeans: fullMeans,
          featureStds: fullStds,
          threshold: DEFAULT_THRESHOLD,
          trainSize: trainRecords.length,
          testSize: testRecords.length,
          trainPositiveRate: roundNumber(average(trainY)),
          testPositiveRate: roundNumber(average(testY)),
          aucTest: aucTest === null ? null : roundNumber(aucTest),
          precisionTest: confusion.precision === null ? null : roundNumber(confusion.precision),
          recallTest: confusion.recall === null ? null : roundNumber(confusion.recall),
          f1Test: confusion.f1 === null ? null : roundNumber(confusion.f1),
        },
      })
    })

    return getChurnModelRunById(db, run.id)
  } catch (error) {
    await db.churnModelRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Churn model training failed.",
      },
    })
    throw error
  }
}

const buildChurnScoreOrderBy = ({ sortBy = null, sortDirection = "desc" } = {}) => {
  const direction = sortDirection === "asc" ? "asc" : "desc"
  const tiebreaker = { customerKey: "asc" }

  switch (sortBy) {
    case "customer":
      return [{ customerName: direction }, tiebreaker]
    case "riskLabel":
      return [{ riskLabel: direction }, tiebreaker]
    case "probability":
    default:
      return [{ churnProbability: direction }, tiebreaker]
  }
}

export const getLatestChurnRiskResult = async ({
  riskLabel = null,
  search = null,
  sortBy = null,
  sortDirection = "desc",
  limit = 50,
  offset = 0,
  db = prisma,
} = {}) => {
  const latestRun = await db.churnModelRun.findFirst({ orderBy: { trainedAt: "desc" } })

  if (!latestRun) {
    return {
      run: null,
      customers: [],
      totalCustomers: 0,
      pagination: { limit, offset, returned: 0, totalCustomers: 0, hasMore: false },
    }
  }

  const where = { runId: latestRun.id }
  if (riskLabel) where.riskLabel = riskLabel
  if (search) {
    where.OR = [{ customerKey: { contains: search } }, { customerName: { contains: search } }]
  }

  const [totalCustomers, customers] = await db.$transaction([
    db.customerChurnScore.count({ where }),
    db.customerChurnScore.findMany({
      where,
      orderBy: buildChurnScoreOrderBy({ sortBy, sortDirection }),
      skip: offset,
      take: limit,
    }),
  ])

  return {
    run: serializeRun(latestRun),
    customers: customers.map((row) => ({
      customerKey: row.customerKey,
      customerName: row.customerName,
      churnProbability: row.churnProbability,
      riskLabel: row.riskLabel,
      featuresSnapshot: row.featuresSnapshot,
    })),
    totalCustomers,
    pagination: {
      limit,
      offset,
      returned: customers.length,
      totalCustomers,
      hasMore: offset + customers.length < totalCustomers,
    },
  }
}
