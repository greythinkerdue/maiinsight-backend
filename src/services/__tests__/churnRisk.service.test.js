import test from "node:test"
import assert from "node:assert/strict"

import {
  applyStandardization,
  buildChurnDataset,
  buildSnapshotDates,
  computeAUC,
  computeConfusionMetrics,
  computeSnapshotFeatures,
  predictProbabilities,
  sigmoid,
  standardizeFeatures,
  trainLogisticRegression,
} from "../churnRisk.service.js"

const utcDay = (offsetDays) => new Date(Date.UTC(2026, 0, 1 + offsetDays))

test("sigmoid is bounded between 0 and 1 and centered at 0.5", () => {
  assert.equal(sigmoid(0), 0.5)
  assert.ok(sigmoid(100) > 0.999999)
  assert.ok(sigmoid(-100) < 1e-10)
})

test("standardizeFeatures/applyStandardization round-trip to zero mean, unit variance", () => {
  const matrix = [[10, 100], [20, 200], [30, 300], [40, 400]]
  const { means, stds } = standardizeFeatures(matrix)
  const scaled = applyStandardization(matrix, means, stds)

  for (let col = 0; col < 2; col += 1) {
    const columnValues = scaled.map((row) => row[col])
    const mean = columnValues.reduce((sum, value) => sum + value, 0) / columnValues.length
    assert.ok(Math.abs(mean) < 1e-9)
  }
})

test("standardizeFeatures does not divide by zero for a constant feature", () => {
  const { means, stds } = standardizeFeatures([[5], [5], [5]])
  assert.equal(means[0], 5)
  assert.equal(stds[0], 1)
})

test("trainLogisticRegression classifies a trivially separable dataset near-perfectly", () => {
  const X = []
  const y = []
  for (let i = 1; i <= 15; i += 1) {
    X.push([-i])
    y.push(0)
    X.push([i])
    y.push(1)
  }
  const { means, stds } = standardizeFeatures(X)
  const scaled = applyStandardization(X, means, stds)
  const model = trainLogisticRegression({ X: scaled, y, iterations: 800, learningRate: 0.3 })
  const probabilities = predictProbabilities(scaled, model.weights, model.intercept)
  const confusion = computeConfusionMetrics(y, probabilities, 0.5)

  assert.equal(confusion.tp + confusion.tn, 30)
  assert.equal(confusion.fp + confusion.fn, 0)
  assert.equal(computeAUC(y, probabilities), 1)
})

test("computeAUC matches a hand-computed rank-sum example", () => {
  assert.equal(computeAUC([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8]), 0.75)
})

test("computeAUC returns null when only one class is present", () => {
  assert.equal(computeAUC([1, 1, 1], [0.2, 0.5, 0.9]), null)
})

test("computeConfusionMetrics matches a hand-computed confusion matrix", () => {
  const result = computeConfusionMetrics([1, 1, 0, 0], [0.9, 0.4, 0.3, 0.8], 0.5)
  assert.deepEqual(result, { tp: 1, fp: 1, tn: 1, fn: 1, precision: 0.5, recall: 0.5, f1: 0.5 })
})

test("computeSnapshotFeatures only uses history strictly before the snapshot date", () => {
  const timeline = {
    customerKey: "CUST-1",
    customerName: "Andi",
    entries: [
      { playDate: utcDay(0), revenue: 100000 },
      { playDate: utcDay(30), revenue: 100000 },
      { playDate: utcDay(60), revenue: 100000 },
      { playDate: utcDay(200), revenue: 100000 },
    ],
  }

  // At day 70, the day-200 booking is in the future relative to the
  // snapshot and outside the 90-day outcome window (160) -> churned.
  const atDay70 = computeSnapshotFeatures(timeline, utcDay(70))
  assert.equal(atDay70.label, 1)
  assert.equal(atDay70.features[0], 10) // recencyDays: 70 - 60

  // At day 170, the day-200 booking falls inside (170, 260] -> not churned.
  const atDay170 = computeSnapshotFeatures(timeline, utcDay(170))
  assert.equal(atDay170.label, 0)
  assert.equal(atDay170.features[0], 110) // recencyDays: 170 - 60
})

test("computeSnapshotFeatures excludes a customer who lapsed before the eligibility window", () => {
  const timeline = {
    customerKey: "CUST-2",
    customerName: "Budi",
    entries: [{ playDate: utcDay(0), revenue: 100000 }],
  }

  // 200 days of recency as of the snapshot exceeds the 180-day eligibility
  // window, so this customer should not be scored as "currently active".
  assert.equal(computeSnapshotFeatures(timeline, utcDay(200)), null)
})

test("computeSnapshotFeatures returns null before any booking exists", () => {
  const timeline = { customerKey: "CUST-3", customerName: "Citra", entries: [{ playDate: utcDay(10), revenue: 1 }] }
  assert.equal(computeSnapshotFeatures(timeline, utcDay(5)), null)
})

test("buildSnapshotDates spaces monthly snapshots inside the buffered window", () => {
  const dates = buildSnapshotDates({ earliestDate: utcDay(0), latestDate: utcDay(400) })
  assert.ok(dates.length > 0)
  assert.ok(dates[0].getTime() >= utcDay(180).getTime())
  assert.ok(dates[dates.length - 1].getTime() <= utcDay(400 - 90).getTime())
})

test("buildSnapshotDates returns nothing when the history is too short to buffer", () => {
  assert.deepEqual(buildSnapshotDates({ earliestDate: utcDay(0), latestDate: utcDay(100) }), [])
})

test("buildChurnDataset sweeps every timeline across every snapshot date, skipping ineligible rows", () => {
  const timelines = [
    {
      customerKey: "CUST-1",
      customerName: "Andi",
      entries: [{ playDate: utcDay(0), revenue: 100000 }, { playDate: utcDay(30), revenue: 100000 }],
    },
  ]
  const snapshotDates = [utcDay(40), utcDay(500)] // second date is far past eligibility
  const dataset = buildChurnDataset(timelines, snapshotDates)
  assert.equal(dataset.length, 1)
  assert.equal(dataset[0].customerKey, "CUST-1")
})
