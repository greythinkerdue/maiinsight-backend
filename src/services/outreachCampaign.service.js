import { prisma } from "../config/prisma.js"
import { HttpError, badRequest } from "../utils/http-error.js"
import {
  buildAudienceCoverage,
  buildWhatsappMessage,
  getJakartaWeekdayIndex,
  getOccupancyBaseline,
  getRecommendedCustomers,
  getSlotAvailability,
  WEEKDAY_NAMES,
} from "./lowOccupancyTargeting.service.js"
import { CANONICAL_TRANSACTION_STATUSES } from "./transactionStatus.service.js"

export const OUTREACH_WINDOW_DAYS = 7
export const MAX_CAMPAIGN_AUDIENCE = 500

// The two court types the venue actually operates; "all" is a filter value,
// never a real court to scan when looking for low-occupancy slots to draft.
const AUTO_DRAFT_COURT_TYPES = ["mini_soccer", "basketball"]
const AUTO_DRAFT_SESSION_NAMES = ["Morning", "Afternoon", "Evening", "Night"]
export const AUTO_DRAFT_LOOKAHEAD_DAYS = 7
export const AUTO_DRAFT_OCCUPANCY_THRESHOLD = 40
export const AUTO_DRAFT_MIN_AUDIENCE = 5
export const AUTO_DRAFT_BASELINE_WEEKS = 4
export const AUTO_DRAFT_SOURCE = "auto_weekly_scan"

const toNumber = (value) => {
  if (value === null || value === undefined) return 0
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "object" && typeof value.toNumber === "function") return value.toNumber()
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const roundNumber = (value, precision = 2) => Number(Number(value || 0).toFixed(precision))

const startOfDay = (value) => {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

const addDays = (value, days) => new Date(value.getTime() + days * 86400000)

const formatIsoDateLocal = (value) => {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export const normalizePhoneForWhatsapp = (value) => {
  const digits = String(value || "").replace(/\D/g, "")
  if (!digits) return null
  if (digits.startsWith("62")) return digits
  if (digits.startsWith("0")) return `62${digits.slice(1)}`
  return digits
}

export const buildWhatsappUrl = ({ phone, message }) => {
  const normalizedPhone = normalizePhoneForWhatsapp(phone)
  if (!normalizedPhone) return null
  return `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(String(message || ""))}`
}

export const buildPromoCode = (prefix, campaignId, sequence) => {
  const safePrefix = String(prefix || "MAIIN").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "") || "MAIIN"
  return `${safePrefix}-${campaignId}-${String(sequence).padStart(3, "0")}`
}

/**
 * Every Nth recipient becomes a holdout. Only applied when the audience is
 * large enough for a holdout to be meaningful; a two-person "control group"
 * would create noise, not measurement.
 */
export const assignControlFlags = (recipients, controlPercent = 10) => {
  const safePercent = Math.max(0, Math.min(Number(controlPercent) || 0, 50))
  if (!safePercent || recipients.length < 20) {
    return recipients.map((recipient) => ({ ...recipient, isControl: false }))
  }

  const step = Math.max(2, Math.round(100 / safePercent))
  return recipients.map((recipient, index) => ({
    ...recipient,
    isControl: index % step === 0,
  }))
}

const normalizePromoText = (value) => String(value || "").toUpperCase()

const bookingMatchesPromo = (booking, promoCodes) => {
  // tipeVoucher is a separate free-text field some imports use for the
  // redeemed voucher/promo code instead of promoName/promosi — checking it
  // too catches promo codes the front desk logged in that column.
  const text = normalizePromoText(
    `${booking.promoName || ""} ${booking.promosi || ""} ${booking.tipeVoucher || ""}`
  )
  if (!text.trim()) return null
  for (const code of promoCodes) {
    if (code && text.includes(normalizePromoText(code))) return code
  }
  return null
}

// --- Statistical inference helpers ------------------------------------
// From-scratch two-proportion z-test (no stats library) for judging whether
// the holdout-vs-treatment conversion lift is distinguishable from sampling
// noise, rather than just reporting a raw percentage difference.

const erf = (x) => {
  // Abramowitz & Stegun 7.1.26 approximation (max error ~1.5e-7) — enough
  // precision for a p-value/CI on marketing-campaign sample sizes.
  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const t = 1 / (1 + p * absX)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX)
  return sign * y
}

export const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2))

/**
 * Two-proportion z-test. x1/n1 is the treatment group (converted / size),
 * x2/n2 is the holdout/control group. Uses the pooled proportion for the
 * standard error, as is standard for the hypothesis test (the confidence
 * interval below intentionally uses the unpooled SE instead).
 */
export const twoProportionZTest = ({ x1, n1, x2, n2 }) => {
  if (!n1 || !n2) return null
  const p1 = x1 / n1
  const p2 = x2 / n2
  const pooledProportion = (x1 + x2) / (n1 + n2)
  const standardError = Math.sqrt(pooledProportion * (1 - pooledProportion) * (1 / n1 + 1 / n2))
  if (!standardError) {
    return { pooledProportion, standardError: 0, zScore: 0, pValue: 1, significant: false }
  }
  const zScore = (p1 - p2) / standardError
  const pValue = 2 * (1 - normalCdf(Math.abs(zScore)))
  return {
    pooledProportion: roundNumber(pooledProportion, 4),
    standardError: roundNumber(standardError, 4),
    zScore: roundNumber(zScore, 4),
    pValue: roundNumber(pValue, 4),
    significant: pValue < 0.05,
  }
}

/** Wald confidence interval on the difference in proportions (p1 - p2). */
export const twoProportionConfidenceInterval = ({ x1, n1, x2, n2, confidenceLevel = 0.95 }) => {
  if (!n1 || !n2) return null
  const p1 = x1 / n1
  const p2 = x2 / n2
  const standardError = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2)
  const zCritical = confidenceLevel === 0.99 ? 2.576 : confidenceLevel === 0.9 ? 1.645 : 1.96
  const marginOfError = zCritical * standardError
  const diff = p1 - p2
  return {
    lower: roundNumber(diff - marginOfError, 4),
    upper: roundNumber(diff + marginOfError, 4),
    marginOfError: roundNumber(marginOfError, 4),
  }
}

// Below this size per group, a z-test's normal approximation is unreliable
// and the existing controlNote already tells the caller to treat lift as
// directional — so significance isn't computed at all rather than reporting
// a misleadingly precise p-value.
const MIN_GROUP_SIZE_FOR_SIGNIFICANCE = 5

const buildLiftSignificance = ({ treatmentMetrics, controlMetrics }) => {
  if (
    treatmentMetrics.size < MIN_GROUP_SIZE_FOR_SIGNIFICANCE ||
    controlMetrics.size < MIN_GROUP_SIZE_FOR_SIGNIFICANCE
  ) {
    return null
  }
  const params = {
    x1: treatmentMetrics.convertedCustomers,
    n1: treatmentMetrics.size,
    x2: controlMetrics.convertedCustomers,
    n2: controlMetrics.size,
  }
  const zTest = twoProportionZTest(params)
  const confidenceInterval = twoProportionConfidenceInterval(params)
  if (!zTest || !confidenceInterval) return null
  return {
    pValue: zTest.pValue,
    zScore: zTest.zScore,
    significant: zTest.significant,
    confidenceIntervalPct: [
      roundNumber(confidenceInterval.lower * 100, 1),
      roundNumber(confidenceInterval.upper * 100, 1),
    ],
    method: "two_proportion_z_test",
  }
}

/**
 * Pure attribution/KPI calculation. Kept independent from Prisma so the
 * formulas can be unit-tested without a database.
 */
export const computeOutreachMetrics = ({
  recipients = [],
  bookings = [],
  slotAvailability = null,
  baselineOccupancy = null,
  costBudget = 0,
  windowDays = OUTREACH_WINDOW_DAYS,
}) => {
  const audienceSize = recipients.length
  const optedOutCount = recipients.filter((recipient) => recipient.status === "opted_out").length
  const sentCount = recipients.filter((recipient) => recipient.status === "sent").length
  const pendingCount = recipients.filter((recipient) => recipient.status === "pending").length
  const treatment = recipients.filter(
    (recipient) => !recipient.isControl && recipient.status !== "opted_out"
  )
  const control = recipients.filter(
    (recipient) => recipient.isControl && recipient.status !== "opted_out"
  )
  const promoCodeByCustomer = new Map(
    recipients.map((recipient) => [recipient.customerKey, recipient.promoCode])
  )
  const promoTextOwner = new Map(
    recipients.map((recipient) => [recipient.promoCode, recipient.customerKey])
  )

  const bookingEvents = new Map()
  let windowRevenue = 0
  let attributedRevenue = 0
  let attributedBookingCount = 0
  const attributedCustomerKeys = new Set()

  for (const booking of bookings) {
    const customerKey = booking.customerKey
    if (!customerKey) continue
    const eventKey = booking.bookingEventKey || `${customerKey}:${booking.playDate}`
    if (bookingEvents.has(eventKey)) continue

    const event = {
      customerKey,
      eventKey,
      revenue: toNumber(booking.netRevenue),
      promoMatched: false,
    }
    const matchedCode = bookingMatchesPromo(booking, [...promoTextOwner.keys()])
    if (matchedCode && promoTextOwner.get(matchedCode) === customerKey) {
      event.promoMatched = true
    } else if (matchedCode) {
      // The code belongs to another recipient; do not attribute it here.
      event.promoMatched = false
    } else if (promoCodeByCustomer.get(customerKey)) {
      event.promoMatched = false
    }

    bookingEvents.set(eventKey, event)
    windowRevenue += event.revenue

    if (event.promoMatched) {
      attributedRevenue += event.revenue
      attributedBookingCount += 1
      attributedCustomerKeys.add(customerKey)
    }
  }

  const eventsByCustomer = new Map()
  for (const event of bookingEvents.values()) {
    const bucket = eventsByCustomer.get(event.customerKey) || []
    bucket.push(event)
    eventsByCustomer.set(event.customerKey, bucket)
  }

  const summarizeGroup = (group) => {
    let convertedCustomers = 0
    let bookingCount = 0
    let revenue = 0
    let convertedWithoutPromo = 0

    for (const recipient of group) {
      const events = eventsByCustomer.get(recipient.customerKey) || []
      if (!events.length) continue
      convertedCustomers += 1
      bookingCount += events.length
      revenue += events.reduce((sum, event) => sum + event.revenue, 0)
      if (!events.some((event) => event.promoMatched)) convertedWithoutPromo += 1
    }

    return {
      size: group.length,
      convertedCustomers,
      bookingCount,
      revenue,
      convertedWithoutPromo,
      conversionRate: group.length > 0 ? roundNumber((convertedCustomers / group.length) * 100) : 0,
      revenuePerRecipient: group.length > 0 ? roundNumber(revenue / group.length) : 0,
    }
  }

  const treatmentMetrics = summarizeGroup(treatment)
  const controlMetrics = summarizeGroup(control)

  // Same underlying bookings as convertedWithoutPromo above, but surfaced as
  // a reviewable worklist: a treatment customer who booked in-window without
  // their promo code showing up is either genuine organic demand, or a promo
  // code the front desk forgot to log. Only a human checking the receipt can
  // tell the two apart — this list is what they'd check.
  const possibleUnmatchedConversions = []
  for (const recipient of treatment) {
    const events = eventsByCustomer.get(recipient.customerKey) || []
    const unmatchedEvents = events.filter((event) => !event.promoMatched)
    if (!unmatchedEvents.length) continue
    possibleUnmatchedConversions.push({
      customerKey: recipient.customerKey,
      customerName: recipient.customerName || recipient.customerKey,
      promoCode: recipient.promoCode,
      bookingCount: unmatchedEvents.length,
      revenue: roundNumber(unmatchedEvents.reduce((sum, event) => sum + event.revenue, 0)),
    })
  }
  const controlBookingRate = controlMetrics.size > 0
    ? controlMetrics.bookingCount / controlMetrics.size
    : 0
  const estimatedIncrementalBookings = Math.max(
    0,
    treatmentMetrics.bookingCount - controlBookingRate * treatmentMetrics.size
  )
  const controlRevenuePerRecipient = controlMetrics.size > 0
    ? controlMetrics.revenue / controlMetrics.size
    : 0
  const estimatedIncrementalRevenue =
    treatmentMetrics.revenue - controlRevenuePerRecipient * treatmentMetrics.size
  const liftPct = controlMetrics.conversionRate > 0
    ? roundNumber(
        ((treatmentMetrics.conversionRate - controlMetrics.conversionRate) /
          controlMetrics.conversionRate) *
          100
      )
    : null
  const emptySlots = Math.max(0, slotAvailability?.availableCourtHours || 0)
  const audienceCoverage = slotAvailability
    ? buildAudienceCoverage({ audienceSize, slotAvailability })
    : null
  const currentOccupancyRate = slotAvailability?.occupancyRate ?? null
  const baselineOccupancyRate = baselineOccupancy?.averageOccupancyRate ?? null
  const occupancyLiftPct =
    currentOccupancyRate !== null && baselineOccupancyRate !== null && baselineOccupancyRate > 0
      ? roundNumber(
          ((currentOccupancyRate - baselineOccupancyRate) / baselineOccupancyRate) * 100
        )
      : null
  const costPerBooking = costBudget > 0 && attributedBookingCount > 0
    ? roundNumber(costBudget / attributedBookingCount)
    : null

  return {
    windowDays,
    audienceSize,
    sentCount,
    pendingCount,
    optedOutCount,
    treatmentSize: treatmentMetrics.size,
    controlSize: controlMetrics.size,
    treatmentConvertedCustomers: treatmentMetrics.convertedCustomers,
    treatmentBookings: treatmentMetrics.bookingCount,
    treatmentRevenue: roundNumber(treatmentMetrics.revenue),
    controlConvertedCustomers: controlMetrics.convertedCustomers,
    controlBookings: controlMetrics.bookingCount,
    conversionRate: treatmentMetrics.conversionRate,
    controlConversionRate: controlMetrics.conversionRate,
    liftPct,
    liftSignificance: buildLiftSignificance({ treatmentMetrics, controlMetrics }),
    estimatedIncrementalBookings: roundNumber(estimatedIncrementalBookings),
    estimatedIncrementalRevenue: roundNumber(estimatedIncrementalRevenue),
    attributedBookingCount,
    attributedRevenue: roundNumber(attributedRevenue),
    attributedCustomers: attributedCustomerKeys.size,
    windowRevenue: roundNumber(windowRevenue),
    redemptionRate: treatmentMetrics.size > 0
      ? roundNumber((attributedCustomerKeys.size / treatmentMetrics.size) * 100)
      : 0,
    revenuePerRecipient: treatmentMetrics.revenuePerRecipient,
    costBudget: roundNumber(costBudget),
    costPerBooking,
    returnOnCampaignSpend:
      costBudget > 0 ? roundNumber(attributedRevenue / costBudget) : null,
    responseRate: null,
    responseRateNote:
      "WhatsApp replies are not connected yet. Log replies manually or connect a WhatsApp Business API to track response rate.",
    optOutRate: audienceSize > 0 ? roundNumber((optedOutCount / audienceSize) * 100) : 0,
    cannibalizationRate:
      treatmentMetrics.convertedCustomers > 0
        ? roundNumber(
            (treatmentMetrics.convertedWithoutPromo / treatmentMetrics.convertedCustomers) * 100
          )
        : 0,
    possibleUnmatchedConversions,
    possibleUnmatchedConversionsNote:
      possibleUnmatchedConversions.length > 0
        ? "These customers received this campaign's message and booked within the window, but no promo code was recorded. Verify at the register whether the code was missed, or whether this was unrelated organic demand."
        : null,
    emptySlots,
    audienceCoverage,
    occupancyRate: currentOccupancyRate,
    baselineOccupancyRate,
    occupancyLiftPct,
    controlNote:
      controlMetrics.size === 0
        ? "No holdout group for this campaign. Incremental lift cannot be separated from normal demand."
        : controlMetrics.size < 5
          ? "Holdout group is small; treat lift as directional, not statistically reliable."
          : null,
  }
}

export const getSlotAvailabilityForCampaign = (input) => getSlotAvailability(input)

const mapRecipientForClient = (recipient, campaign) => {
  const message = buildWhatsappMessage({
    customerName: recipient.customerName,
    preferredSession: recipient.preferredSession,
    courtType: campaign.courtType,
    rfmSegmentName: recipient.rfmSegmentName,
    customerTypeLabel: recipient.customerTypeLabel,
    totalBookingCount: recipient.totalBookingCount,
    recencyDays: recipient.recencyDays,
    campaignDate: campaign.campaignDate,
    promoCode: recipient.promoCode,
  })

  return {
    id: recipient.id,
    customerKey: recipient.customerKey,
    customerName: recipient.customerName,
    phone: recipient.phone,
    rfmSegmentName: recipient.rfmSegmentName,
    preferredSession: recipient.preferredSession,
    customerTypeLabel: recipient.customerTypeLabel,
    suggestedAction: recipient.suggestedAction,
    promoCode: recipient.promoCode,
    isControl: recipient.isControl,
    status: recipient.status,
    sentAt: recipient.sentAt,
    whatsappMessage: recipient.isControl ? null : message,
    whatsappUrl: recipient.isControl ? null : buildWhatsappUrl({ phone: recipient.phone, message }),
  }
}

export const listSuppressions = async () => {
  const rows = await prisma.outreachSuppression.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
  })
  return rows.map((row) => ({
    id: row.id,
    customerKey: row.customerKey,
    reason: row.reason,
    createdAt: row.createdAt,
  }))
}

export const addSuppression = async ({ customerKey, reason, userId = null }) => {
  const existing = await prisma.outreachSuppression.findUnique({ where: { customerKey } })
  if (existing) return existing

  return prisma.outreachSuppression.create({
    data: {
      customerKey,
      reason,
      createdByUserId: userId,
    },
  })
}

export const removeSuppression = async (customerKey) => {
  const existing = await prisma.outreachSuppression.findUnique({ where: { customerKey } })
  if (!existing) return { removed: false }
  await prisma.outreachSuppression.delete({ where: { customerKey } })
  return { removed: true }
}

const buildEligibleAudience = async (recommendedCustomers) => {
  if (!recommendedCustomers.length) return []
  const suppressed = await prisma.outreachSuppression.findMany({
    where: { customerKey: { in: recommendedCustomers.map((customer) => customer.customerKey) } },
    select: { customerKey: true },
  })
  const suppressedKeys = new Set(suppressed.map((row) => row.customerKey))
  return recommendedCustomers.filter((customer) => !suppressedKeys.has(customer.customerKey))
}

const persistCampaignWithRecipients = async ({ data, eligible, controlPercent, promoCodePrefix }) => {
  const withControl = assignControlFlags(eligible, controlPercent)
  const campaign = await prisma.outreachCampaign.create({ data })

  await prisma.outreachRecipient.createMany({
    data: withControl.map((customer, index) => ({
      campaignId: campaign.id,
      customerKey: customer.customerKey,
      customerName: customer.customerName,
      phone: customer.phone,
      rfmSegmentName: customer.rfmSegmentName,
      preferredSession: customer.preferredSession,
      customerTypeLabel: customer.customerTypeLabel,
      totalBookingCount: customer.totalBookingCount,
      recencyDays: customer.recencyDays,
      suggestedAction: customer.suggestedAction,
      promoCode: buildPromoCode(promoCodePrefix, campaign.id, index + 1),
      isControl: customer.isControl,
      status: "pending",
    })),
  })

  return campaign
}

export const createOutreachCampaign = async ({ input, userId = null }) => {
  const recommendation = await getRecommendedCustomers({
    campaignDay: input.campaignDay,
    analysisPeriodMonths: input.analysisPeriodMonths,
    courtType: input.courtType,
    sessionName: input.sessionName,
    customerType: input.customerType,
    segmentName: input.segmentName,
    campaignDate: input.campaignDate,
    limit: MAX_CAMPAIGN_AUDIENCE,
    offset: 0,
  })

  const recommended = recommendation.customers || []
  if (!recommended.length) {
    throw badRequest(
      "No customers match this audience. Adjust the day, session, court type, customer type, or RFM segment before creating a campaign."
    )
  }

  const eligible = await buildEligibleAudience(recommended)
  if (!eligible.length) {
    throw badRequest("Every matching customer has opted out of promotional messages.")
  }

  // input.consentConfirmed is guaranteed true here because the HTTP route
  // validates it before calling this function (manual campaign creation).
  // The auto-draft scanner never goes through that validator and always
  // passes status "draft" + consentConfirmed false explicitly instead.
  const campaign = await persistCampaignWithRecipients({
    data: {
      name: input.name,
      promoCodePrefix: input.promoCodePrefix,
      campaignDate: new Date(`${input.campaignDate}T00:00:00`),
      campaignDay: input.campaignDay,
      sessionName: input.sessionName,
      courtType: input.courtType,
      segmentName: input.segmentName,
      customerType: input.customerType,
      status: input.status || "active",
      costBudget: input.costBudget,
      controlPercent: input.controlPercent,
      consentConfirmed: Boolean(input.consentConfirmed),
      consentConfirmedAt: input.consentConfirmed ? new Date() : null,
      audienceFilters: {
        analysisPeriodMonths: input.analysisPeriodMonths,
        campaignDay: input.campaignDay,
        sessionName: input.sessionName,
        courtType: input.courtType,
        customerType: input.customerType,
        segmentName: input.segmentName,
        campaignDate: input.campaignDate,
        historyLookbackMonths: recommendation.historyLookbackMonths,
        source: input.source || "manual",
      },
      createdByUserId: userId,
    },
    eligible,
    controlPercent: input.controlPercent,
    promoCodePrefix: input.promoCodePrefix,
  })

  return getOutreachCampaignDetail({ campaignId: campaign.id })
}

/**
 * Scans the next `lookaheadDays` for day/session/court combinations whose
 * historical occupancy (same weekday+session, averaged over
 * `baselineWeeks`) sits below `occupancyThreshold`, and drafts an outreach
 * campaign for each one that has a viable audience. Drafts are never
 * auto-activated: status is "draft" and consentConfirmed stays false, so a
 * human must review the audience and explicitly confirm consent before any
 * message goes out (see updateCampaignStatus).
 */
export const generateAutoDraftCampaigns = async ({
  lookaheadDays = AUTO_DRAFT_LOOKAHEAD_DAYS,
  occupancyThreshold = AUTO_DRAFT_OCCUPANCY_THRESHOLD,
  minAudience = AUTO_DRAFT_MIN_AUDIENCE,
  baselineWeeks = AUTO_DRAFT_BASELINE_WEEKS,
} = {}) => {
  const created = []
  const today = startOfDay(new Date())

  for (let offset = 1; offset <= lookaheadDays; offset += 1) {
    const candidateDate = addDays(today, offset)
    const campaignDate = formatIsoDateLocal(candidateDate)
    const campaignDay = WEEKDAY_NAMES[getJakartaWeekdayIndex(candidateDate)]

    for (const courtType of AUTO_DRAFT_COURT_TYPES) {
      for (const sessionName of AUTO_DRAFT_SESSION_NAMES) {
        // One draft per date+session+court, ever. Once a campaign exists
        // (auto-drafted, manually created, or already archived) for that
        // exact slot, never draft over it again.
        const existing = await prisma.outreachCampaign.findFirst({
          where: { campaignDate: new Date(`${campaignDate}T00:00:00`), sessionName, courtType },
          select: { id: true },
        })
        if (existing) continue

        const baseline = await getOccupancyBaseline({
          campaignDate,
          sessionName,
          courtType,
          weeks: baselineWeeks,
        })
        if (!baseline || baseline.averageOccupancyRate == null || baseline.averageOccupancyRate >= occupancyThreshold) {
          continue
        }

        const recommendation = await getRecommendedCustomers({
          campaignDay,
          sessionName,
          courtType,
          campaignDate,
          analysisPeriodMonths: 3,
          customerType: "all",
          segmentName: null,
          limit: MAX_CAMPAIGN_AUDIENCE,
          offset: 0,
        })
        const eligible = await buildEligibleAudience(recommendation.customers || [])
        if (eligible.length < minAudience) continue

        const promoCodePrefix = `FILL${candidateDate.getMonth() + 1}${candidateDate.getDate()}${sessionName.slice(0, 1)}`

        const campaign = await persistCampaignWithRecipients({
          data: {
            name: `Auto draft - ${sessionName} ${courtType === "mini_soccer" ? "Mini Soccer" : "Basketball"} - ${campaignDay} ${campaignDate}`,
            promoCodePrefix,
            campaignDate: new Date(`${campaignDate}T00:00:00`),
            campaignDay,
            sessionName,
            courtType,
            segmentName: null,
            customerType: "all",
            status: "draft",
            costBudget: 0,
            controlPercent: 10,
            consentConfirmed: false,
            consentConfirmedAt: null,
            audienceFilters: {
              analysisPeriodMonths: 3,
              campaignDay,
              sessionName,
              courtType,
              customerType: "all",
              segmentName: null,
              campaignDate,
              historyLookbackMonths: recommendation.historyLookbackMonths,
              source: AUTO_DRAFT_SOURCE,
              baselineOccupancyRate: baseline.averageOccupancyRate,
            },
            createdByUserId: null,
          },
          eligible,
          controlPercent: 10,
          promoCodePrefix,
        })

        created.push({
          campaignId: campaign.id,
          name: campaign.name,
          campaignDate,
          campaignDay,
          sessionName,
          courtType,
          audienceSize: eligible.length,
          baselineOccupancyRate: baseline.averageOccupancyRate,
        })
      }
    }
  }

  return { created, scannedDays: lookaheadDays, occupancyThreshold, minAudience }
}

export const getOutreachCampaignDetail = async ({ campaignId, includeRecipients = true }) => {
  const campaign = await prisma.outreachCampaign.findUnique({
    where: { id: campaignId },
    include: {
      recipients: { orderBy: { id: "asc" } },
    },
  })

  if (!campaign) throw new HttpError(404, "Outreach campaign not found.")

  const recipients = campaign.recipients
  const start = startOfDay(campaign.campaignDate)
  const endExclusive = addDays(start, OUTREACH_WINDOW_DAYS)
  const customerKeys = recipients.map((recipient) => recipient.customerKey)
  // getSlotAvailability/getOccupancyBaseline rebuild the date via
  // `${campaignDate}T00:00:00`, which only works for a "YYYY-MM-DD" string —
  // passing the Date object straight from Prisma stringifies to something
  // like "Tue Nov 24 2026 00:00:00 GMT+0700T00:00:00", an invalid date.
  const campaignDateString = formatIsoDateLocal(campaign.campaignDate)

  const [bookings, slotAvailability, baselineOccupancy] = await Promise.all([
    customerKeys.length
      ? prisma.facilityTransaction.findMany({
          where: {
            customerKey: { in: customerKeys },
            playDate: { gte: start, lt: endExclusive },
            validBooking: true,
            netRevenue: { gt: 0 },
            status: {
              in: [
                CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED,
                CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN,
              ],
            },
            batch: { fileName: { not: "tmp-upload-sample.csv" } },
          },
          select: {
            customerKey: true,
            bookingEventKey: true,
            netRevenue: true,
            promoName: true,
            promosi: true,
            tipeVoucher: true,
            playDate: true,
            startHour: true,
          },
        })
      : Promise.resolve([]),
    getSlotAvailability({
      campaignDate: campaignDateString,
      sessionName: campaign.sessionName,
      courtType: campaign.courtType,
    }),
    getOccupancyBaseline({
      campaignDate: campaignDateString,
      sessionName: campaign.sessionName,
      courtType: campaign.courtType,
    }),
  ])

  const performance = computeOutreachMetrics({
    recipients,
    bookings,
    slotAvailability,
    baselineOccupancy,
    costBudget: toNumber(campaign.costBudget),
  })

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      promoCodePrefix: campaign.promoCodePrefix,
      campaignDate: campaign.campaignDate,
      campaignDay: campaign.campaignDay,
      sessionName: campaign.sessionName,
      courtType: campaign.courtType,
      segmentName: campaign.segmentName,
      customerType: campaign.customerType,
      status: campaign.status,
      costBudget: toNumber(campaign.costBudget),
      controlPercent: campaign.controlPercent,
      consentConfirmed: campaign.consentConfirmed,
      consentConfirmedAt: campaign.consentConfirmedAt,
      audienceFilters: campaign.audienceFilters,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      recipientCount: recipients.length,
    },
    performance,
    slotAvailability,
    baselineOccupancy,
    recipients: includeRecipients
      ? recipients.map((recipient) => mapRecipientForClient(recipient, campaign))
      : undefined,
    recipientCount: recipients.length,
  }
}

export const listOutreachCampaigns = async () => {
  const campaigns = await prisma.outreachCampaign.findMany({
    orderBy: [{ campaignDate: "desc" }, { id: "desc" }],
    take: 100,
    include: {
      _count: { select: { recipients: true } },
    },
  })

  return campaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    promoCodePrefix: campaign.promoCodePrefix,
    campaignDate: campaign.campaignDate,
    campaignDay: campaign.campaignDay,
    sessionName: campaign.sessionName,
    courtType: campaign.courtType,
    segmentName: campaign.segmentName,
    customerType: campaign.customerType,
    status: campaign.status,
    costBudget: toNumber(campaign.costBudget),
    recipientCount: campaign._count.recipients,
    createdAt: campaign.createdAt,
  }))
}

export const updateRecipientStatus = async ({ campaignId, recipientId, status, userId = null }) => {
  const recipient = await prisma.outreachRecipient.findFirst({
    where: { id: recipientId, campaignId },
  })
  if (!recipient) throw new HttpError(404, "Campaign recipient not found.")

  const updated = await prisma.outreachRecipient.update({
    where: { id: recipient.id },
    data: {
      status,
      sentAt: status === "sent" ? new Date() : recipient.sentAt,
    },
  })

  if (status === "opted_out") {
    await addSuppression({
      customerKey: recipient.customerKey,
      reason: "Customer opted out during campaign outreach.",
      userId,
    })
  }

  return {
    id: updated.id,
    status: updated.status,
    sentAt: updated.sentAt,
  }
}

export const updateCampaignStatus = async ({ campaignId, status, confirmConsent = false }) => {
  const campaign = await prisma.outreachCampaign.findUnique({ where: { id: campaignId } })
  if (!campaign) throw new HttpError(404, "Outreach campaign not found.")

  // Auto-drafted campaigns are created with consentConfirmed=false on
  // purpose. Activating one is the moment a human takes responsibility for
  // the audience, so require the same explicit confirmation manual campaign
  // creation already requires before it can send anything.
  if (status === "active" && !campaign.consentConfirmed) {
    if (!confirmConsent) {
      throw badRequest(
        "confirmConsent must be true: confirm these customers are existing customers who agreed to receive promotional messages before activating this campaign."
      )
    }
    return prisma.outreachCampaign.update({
      where: { id: campaignId },
      data: { status, consentConfirmed: true, consentConfirmedAt: new Date() },
    })
  }

  return prisma.outreachCampaign.update({
    where: { id: campaignId },
    data: { status },
  })
}

export const getCampaignKpiOverview = async ({ campaignId = null } = {}) => {
  const campaigns = await listOutreachCampaigns()
  const selectedId = campaignId || campaigns[0]?.id || null
  const selected = selectedId
    ? await getOutreachCampaignDetail({ campaignId: selectedId, includeRecipients: false })
    : null

  return {
    campaigns,
    selected,
    kpiDefinitions: [
      {
        key: "occupancyRate",
        label: "Occupancy",
        description: "Paid court-hours divided by configured capacity on the campaign date and session.",
      },
      {
        key: "estimatedIncrementalBookings",
        label: "Incremental Bookings",
        description: "Treatment bookings above the conversion rate observed in the holdout group.",
      },
      {
        key: "attributedRevenue",
        label: "Revenue per Campaign",
        description: "Revenue from bookings that used the campaign promo code inside the 7-day window.",
      },
      {
        key: "costPerBooking",
        label: "Cost per Booking",
        description: "Campaign budget divided by promo-attributed bookings. Shows null when no budget is set.",
      },
      {
        key: "redemptionRate",
        label: "Redemption Rate",
        description: "Share of treated customers with at least one promo-coded booking.",
      },
      {
        key: "responseRate",
        label: "Response Rate",
        description: "Not tracked yet. WhatsApp replies need manual logging or a WhatsApp Business API integration.",
      },
      {
        key: "optOutRate",
        label: "Opt-out Rate",
        description: "Share of the audience that asked to stop receiving promotional messages.",
      },
      {
        key: "audienceCoverage",
        label: "Audience vs Empty Slots",
        description: "Audience size compared with empty court-hours to show whether the list can fill the gap.",
      },
      {
        key: "cannibalizationRate",
        label: "Cannibalization Rate",
        description: "Converted customers who booked without the promo code, indicating demand that may have existed anyway.",
      },
      {
        key: "possibleUnmatchedConversions",
        label: "Unmatched Promo Check",
        description: "Treatment customers who booked in-window without a matched promo code. Could be organic demand or a promo code the register missed — worth a manual check.",
      },
    ],
  }
}
