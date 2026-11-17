import { prisma } from "../config/prisma.js"
import { buildCourtHourUsageWhere, EXCLUDED_IMPORT_BATCH_FILE_NAMES, getCourtCount } from "./dashboardPeriod.service.js"
import { buildEmptySlotHeatmap } from "./emptySlotHeatmap.service.js"
import {
  CANONICAL_TRANSACTION_STATUSES,
  DASHBOARD_TRANSACTION_GROUPS,
  getDashboardTransactionGroup,
  isEligibleCustomerStatus,
} from "./transactionStatus.service.js"

const SESSION_DEFINITIONS = [
  { name: "Morning", startHour: 6, endHour: 10 },
  { name: "Afternoon", startHour: 11, endHour: 14 },
  { name: "Evening", startHour: 15, endHour: 18 },
  { name: "Night", startHour: 19, endHour: 23 },
]

const COURT_TYPE_LABELS = {
  mini_soccer: "Mini Soccer",
  basketball: "Basketball",
  all: "All Court Types",
}

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

const RFM_SEGMENT_SCORE = {
  "High-Value Players": 100,
  "Regular Players": 85,
  "Occasional Players": 70,
  "Lapsed Players": 55,
}

// Recommendations only need enough history to rank a customer's current
// behaviour; scanning every transaction ever imported made the endpoint grow
// without bound as the data set aged. Two years keeps seasonality intact while
// bounding the query and the in-memory aggregation.
export const CAMPAIGN_HISTORY_LOOKBACK_MONTHS = 24
const RECOMMENDATION_CACHE_TTL_MS = 60_000
const RECOMMENDATION_CACHE_MAX_ENTRIES = 24
const recommendationCache = new Map()

const buildRecommendationCacheKey = (params) => JSON.stringify(params)

const readRecommendationCache = (key) => {
  const entry = recommendationCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    recommendationCache.delete(key)
    return null
  }
  return entry.value
}

const writeRecommendationCache = (key, value) => {
  if (recommendationCache.size >= RECOMMENDATION_CACHE_MAX_ENTRIES) {
    const oldestKey = recommendationCache.keys().next().value
    if (oldestKey) recommendationCache.delete(oldestKey)
  }
  recommendationCache.set(key, {
    value,
    expiresAt: Date.now() + RECOMMENDATION_CACHE_TTL_MS,
  })
}

export const clearRecommendationCache = () => recommendationCache.clear()

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== ""

const toNumber = (value) => {
  if (value === null || value === undefined) return 0
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber()
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const roundNumber = (value, precision = 2) => Number(value.toFixed(precision))

const startOfDay = (value) => {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

const endOfDay = (value) => {
  const date = new Date(value)
  date.setHours(23, 59, 59, 999)
  return date
}

const formatIsoDate = (value) => {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

const parseHourValue = (value) => {
  if (!hasValue(value)) return null

  const text = String(value).trim()
  const [hourText] = text.split(":")
  const parsed = Number(hourText)

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) return null
  return parsed
}

export const getSessionDefinitionByName = (sessionName) =>
  SESSION_DEFINITIONS.find((session) => session.name === sessionName) || null

export const resolveSessionNameByHour = (hour) => {
  const session = SESSION_DEFINITIONS.find(
    (candidate) => hour >= candidate.startHour && hour <= candidate.endHour
  )

  return session?.name || null
}

export const sumCampaignRevenue = (rows) => {
  let revenue = 0
  const revenueEvents = new Set()

  for (const row of rows) {
    const group = getDashboardTransactionGroup(row.transaction?.status)
    if (
      group === DASHBOARD_TRANSACTION_GROUPS.GELORA_APP_BOOKING ||
      group === DASHBOARD_TRANSACTION_GROUPS.MANUAL_WALK_IN ||
      group === DASHBOARD_TRANSACTION_GROUPS.INTERNAL
    ) {
      const eventKey = row.transaction?.bookingEventKey
      if (!revenueEvents.has(eventKey)) {
        revenueEvents.add(eventKey)
        revenue += toNumber(row.transaction?.netRevenue)
      }
    }
  }

  return revenue
}

const mapCourtTypeLabel = (courtType) => COURT_TYPE_LABELS[courtType] || courtType || "Unknown"

const mapCustomerTypeLabel = (bookingTypeDominant) => {
  if (bookingTypeDominant === "Manual/Walk-in") return "Membership"
  if (bookingTypeDominant === "GeloraApp Booking") return "Non Membership"
  return bookingTypeDominant || "Mixed/Other"
}

const buildCustomerDisplayName = (transaction) =>
  transaction.customerName || transaction.nama || transaction.normalizedName || transaction.customerKey

const normalizeText = (value) => (hasValue(value) ? String(value).trim() : null)

const resolveContactInfo = (existingContact, transaction) => {
  const phone = normalizeText(transaction.normalizedPhone) || normalizeText(transaction.noTelepon)
  const email = normalizeText(transaction.normalizedEmail) || normalizeText(transaction.email)

  if (!existingContact) {
    return { phone, email }
  }

  return {
    phone: existingContact.phone || phone,
    email: existingContact.email || email,
  }
}

const buildDateRange = ({ date = null, startDate: requestedStartDate = null, endDate: requestedEndDate = null } = {}) => {
  const start = requestedStartDate || date || formatIsoDate(new Date())
  const end = requestedEndDate || date || start
  const startValue = new Date(start)
  const endValue = new Date(end)
  return {
    date: start === end ? formatIsoDate(startValue) : formatIsoDate(startValue) + " to " + formatIsoDate(endValue),
    startDate: startOfDay(startValue),
    endDate: endOfDay(endValue),
  }
}

const matchesCustomerTypeFilter = (customerTypeLabel, customerType) => {
  if (!customerType || customerType === "all") return true
  if (customerType === "membership") return customerTypeLabel === "Membership"
  if (customerType === "non_membership") return customerTypeLabel === "Non Membership"
  return true
}

const CAMPAIGN_VALID_PLAY_DATE_WHERE = {
  validBooking: true,
  customerKey: { not: "" },
  status: {
    in: [
      CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED,
      CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN,
    ],
  },
  netRevenue: { gt: 0 },
  NOT: {
    customerKey: {
      startsWith: "SYS-",
    },
  },
  bookingEventKey: { not: "" },
  playDate: { not: null },
  batch: {
    fileName: {
      not: "tmp-upload-sample.csv",
    },
  },
}

export const getLatestCampaignPlayDate = async (database = prisma) => {
  const result = await database.facilityTransaction.aggregate({
    where: CAMPAIGN_VALID_PLAY_DATE_WHERE,
    _max: { playDate: true },
  })

  return result?._max?.playDate || null
}

export const buildCampaignAnalysisRange = (latestPlayDate, analysisPeriodMonths) => {
  if (!latestPlayDate) return null

  const analysisEnd = endOfDay(latestPlayDate)
  return {
    analysisStart: new Date(
      analysisEnd.getFullYear(),
      analysisEnd.getMonth() - analysisPeriodMonths + 1,
      1
    ),
    analysisEnd,
  }
}

export const getJakartaWeekdayIndex = (value) => {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
  }).format(new Date(value))
  return WEEKDAY_NAMES.indexOf(weekday)
}

export const matchesCampaignPlayContext = ({
  playDate,
  startHour,
  campaignDay,
  sessionName,
  rangeStart = null,
  rangeEnd = null,
}) => {
  if (!playDate) return false

  const date = new Date(playDate)
  if (rangeStart && date < rangeStart) return false
  if (rangeEnd && date > rangeEnd) return false

  const dayIndex = WEEKDAY_NAMES.indexOf(campaignDay)
  return (
    getJakartaWeekdayIndex(date) === dayIndex &&
    resolveSessionNameByHour(parseHourValue(startHour)) === sessionName
  )
}

const bucketRecencyScore = (recencyDays) => {
  if (recencyDays <= 30) return 100
  if (recencyDays <= 90) return 80
  if (recencyDays <= 180) return 60
  return 30
}

const getRfmSegmentWeight = (segmentName) => {
  if (!segmentName) return 50
  return RFM_SEGMENT_SCORE[segmentName] || 50
}

export const buildTargetPriorityScore = ({
  selectedSessionBookingCount,
  selectedCourtBookingCount,
  totalBookingCount,
  recencyDays,
  rfmSegmentName,
  hasPhone,
  hasEmail,
  maxSelectedSessionBookingCount,
  maxSelectedCourtBookingCount,
  maxTotalBookingCount,
}) => {
  const safeTotal = Math.max(totalBookingCount, 1)
  const sessionIntensity = maxSelectedSessionBookingCount > 0
    ? selectedSessionBookingCount / maxSelectedSessionBookingCount
    : 0
  const sessionShare = selectedSessionBookingCount / safeTotal
  const sessionScore = (sessionIntensity * 0.7 + sessionShare * 0.3) * 100

  const courtIntensity = maxSelectedCourtBookingCount > 0
    ? (selectedCourtBookingCount / maxSelectedCourtBookingCount) * 100
    : 0

  const recencyScore = bucketRecencyScore(recencyDays)
  const rfmScore = getRfmSegmentWeight(rfmSegmentName)
  const frequencyScore = maxTotalBookingCount > 0
    ? (totalBookingCount / maxTotalBookingCount) * 100
    : 0
  const contactScore = hasPhone ? 100 : hasEmail ? 60 : 10

  return roundNumber(
    sessionScore * 0.35 +
      courtIntensity * 0.2 +
      recencyScore * 0.15 +
      rfmScore * 0.15 +
      frequencyScore * 0.1 +
      contactScore * 0.05,
    2
  )
}

export const buildTargetPriorityLabel = (score) => {
  if (score >= 75) return "High Priority"
  if (score >= 50) return "Medium Priority"
  return "Low Priority"
}

export const buildSuggestedAction = ({ customerTypeLabel, rfmSegmentName }) => {
  if (rfmSegmentName === "High-Value Players") {
    return "Give VIP priority slot access and personalized loyalty perks."
  }

  if (customerTypeLabel === "Non Membership" && rfmSegmentName === "Regular Players") {
    return "Offer session promo or repeat booking package."
  }

  if (customerTypeLabel === "Non Membership" && rfmSegmentName === "Occasional Players") {
    return "Send follow-up promo to encourage repeat booking."
  }

  if (customerTypeLabel === "Membership" && rfmSegmentName === "Regular Players") {
    return "Offer priority slot reminder or membership package maintenance."
  }

  if (rfmSegmentName === "Lapsed Players") {
    return "Send comeback offer or low-touch reactivation message."
  }

  return "Offer available slot reminder."
}

const buildBookingHistoryPhrase = ({ totalBookingCount, recencyDays }) => {
  if (!Number.isFinite(recencyDays) || recencyDays >= 999) {
    return "Ini kesempatan pertama kami hubungi Kakak"
  }

  const timesPhrase = totalBookingCount > 1 ? `sudah ${totalBookingCount}x booking` : "pernah booking"
  const recencyPhrase =
    recencyDays <= 3
      ? "beberapa hari lalu"
      : recencyDays <= 30
        ? `sekitar ${recencyDays} hari lalu`
        : recencyDays <= 180
          ? `sekitar ${Math.round(recencyDays / 30)} bulan lalu`
          : "cukup lama"

  return `Kakak ${timesPhrase} bareng kami, terakhir ${recencyPhrase}`
}

const formatCampaignDatePhrase = (campaignDate) => {
  if (!campaignDate) return null
  const isoDate = campaignDate instanceof Date
    ? campaignDate.toISOString().slice(0, 10)
    : String(campaignDate).slice(0, 10)
  const date = new Date(`${isoDate}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date)
}

export const buildWhatsappMessage = ({
  customerName,
  preferredSession,
  courtType,
  rfmSegmentName,
  customerTypeLabel,
  totalBookingCount,
  recencyDays,
  campaignDate = null,
  promoCode = null,
}) => {
  const safeName = customerName || "Kak"
  const courtLabel = mapCourtTypeLabel(courtType)
  const sessionPhrase = preferredSession ? `sesi ${preferredSession}` : "jadwal yang biasa Kakak pilih"
  const historyPhrase = buildBookingHistoryPhrase({ totalBookingCount, recencyDays })
  const campaignDatePhrase = formatCampaignDatePhrase(campaignDate)
  const slotLine = campaignDatePhrase ? ` Slotnya untuk ${campaignDatePhrase}.` : ""
  const promoLine = promoCode ? ` Sebutkan kode ${promoCode} saat booking ya.` : ""

  if (rfmSegmentName === "High-Value Players") {
    return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase}, jadi kami mau kasih Kakak akses prioritas untuk slot ${courtLabel} di ${sessionPhrase}.${slotLine}${promoLine} Kabari kami ya kalau mau kami bantu amankan jadwalnya duluan.`
  }

  if (rfmSegmentName === "Lapsed Players") {
    return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase}, kami kangen main bareng Kakak lagi. Saat ini ada slot ${courtLabel} tersedia di ${sessionPhrase}.${slotLine}${promoLine} Yuk balik main bareng tim, kami siapin promo comeback khusus buat Kakak.`
  }

  if (customerTypeLabel === "Membership" && rfmSegmentName === "Regular Players") {
    return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase} di ${sessionPhrase}. Sebagai member rutin, kami mau ingetin ada slot ${courtLabel} yang bisa Kakak amankan lagi sesuai jadwal favorit.${slotLine}${promoLine}`
  }

  if (customerTypeLabel === "Non Membership" && rfmSegmentName === "Occasional Players") {
    return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase} di ${sessionPhrase}. Ada slot ${courtLabel} tersedia, plus promo khusus kalau Kakak booking lagi.${slotLine}${promoLine}`
  }

  if (customerTypeLabel === "Non Membership" && rfmSegmentName === "Regular Players") {
    return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase} di ${sessionPhrase}. Ada paket booking berulang yang bisa bikin Kakak lebih hemat kalau mau main rutin di sesi ini.${slotLine}${promoLine}`
  }

  return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase} di ${sessionPhrase}. Ada slot ${courtLabel} tersedia, kalau Kakak berminat kami bisa bantu cek jadwal dan promo yang ada.${slotLine}${promoLine}`
}

const buildSegmentMap = async (customerKeys) => {
  if (!customerKeys.length) return new Map()

  const latestRun = await prisma.segmentationRun.findFirst({
    where: { status: "completed" },
    orderBy: { runDate: "desc" },
    select: { id: true },
  })

  if (!latestRun) return new Map()

  const scores = await prisma.customerRfmScore.findMany({
    where: {
      runId: latestRun.id,
      customerKey: { in: customerKeys },
    },
    select: {
      customerKey: true,
      segmentName: true,
    },
  })

  return new Map(scores.map((score) => [score.customerKey, score.segmentName]))
}

const aggregateCustomerHistory = (transactions, { sessionName, courtType, campaignDay }) => {
  const customerMap = new Map()
  const campaignDayIndex = WEEKDAY_NAMES.indexOf(campaignDay)

  for (const transaction of transactions) {
    if (
      !transaction.customerKey ||
      transaction.customerKey.startsWith("SYS-") ||
      !isEligibleCustomerStatus(transaction.status) ||
      toNumber(transaction.netRevenue) <= 0 ||
      !transaction.bookingEventKey ||
      !transaction.playDate
    ) {
      continue
    }

    const playDate = new Date(transaction.playDate)
    const bookingEventKey = transaction.bookingEventKey
    const hour = parseHourValue(transaction.startHour)
    const derivedSessionName = hour === null ? null : resolveSessionNameByHour(hour)
    const existingCustomer = customerMap.get(transaction.customerKey) || {
      customerKey: transaction.customerKey,
      customerName: buildCustomerDisplayName(transaction),
      phone: null,
      email: null,
      latestPlayDate: null,
      totalRevenue: 0,
      bookingTypeCounts: new Map(),
      sessionCounts: new Map(),
      courtTypeCounts: new Map(),
      allBookingEventKeys: new Set(),
      campaignMatchEventKeys: new Set(),
      selectedCourtEventKeys: new Set(),
    }

    const contactInfo = resolveContactInfo({ phone: existingCustomer.phone, email: existingCustomer.email }, transaction)
    existingCustomer.phone = contactInfo.phone
    existingCustomer.email = contactInfo.email

    if (!existingCustomer.latestPlayDate || playDate > existingCustomer.latestPlayDate) {
      existingCustomer.latestPlayDate = playDate
    }

    if (!existingCustomer.allBookingEventKeys.has(bookingEventKey)) {
      existingCustomer.allBookingEventKeys.add(bookingEventKey)
      existingCustomer.totalRevenue += toNumber(transaction.netRevenue)
    }

    if (!existingCustomer.bookingTypeCounts.has(bookingEventKey)) {
      existingCustomer.bookingTypeCounts.set(bookingEventKey, transaction.bookingType || "other")
    }

    if (derivedSessionName) {
      const sessionEventKey = `${derivedSessionName}:${bookingEventKey}`
      if (!existingCustomer.sessionCounts.has(sessionEventKey)) {
        existingCustomer.sessionCounts.set(sessionEventKey, derivedSessionName)
      }

      if (derivedSessionName === sessionName && getJakartaWeekdayIndex(playDate) === campaignDayIndex) {
        existingCustomer.campaignMatchEventKeys.add(bookingEventKey)
      }
    }

    if (transaction.courtType) {
      if (!existingCustomer.courtTypeCounts.has(bookingEventKey)) {
        existingCustomer.courtTypeCounts.set(bookingEventKey, transaction.courtType)
      }

      if (!courtType || courtType === "all" || transaction.courtType === courtType) {
        existingCustomer.selectedCourtEventKeys.add(bookingEventKey)
      }
    }

    customerMap.set(transaction.customerKey, existingCustomer)
  }

  return [...customerMap.values()].map((customer) => {
    const bookingTypeCounter = new Map()
    customer.bookingTypeCounts.forEach((bookingType) => {
      bookingTypeCounter.set(bookingType, (bookingTypeCounter.get(bookingType) || 0) + 1)
    })

    const sortedBookingTypes = [...bookingTypeCounter.entries()].sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return left[0].localeCompare(right[0])
    })

    const bookingTypeDominant = sortedBookingTypes[0]?.[0] || "other"
    const preferredSessionCounter = new Map()

    customer.sessionCounts.forEach((sessionNameValue) => {
      preferredSessionCounter.set(
        sessionNameValue,
        (preferredSessionCounter.get(sessionNameValue) || 0) + 1
      )
    })

    const preferredSession = [...preferredSessionCounter.entries()].sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return left[0].localeCompare(right[0])
    })[0]?.[0] || null

    const courtTypeCounter = new Map()
    customer.courtTypeCounts.forEach((courtTypeValue) => {
      courtTypeCounter.set(courtTypeValue, (courtTypeCounter.get(courtTypeValue) || 0) + 1)
    })

    const preferredCourtType = [...courtTypeCounter.entries()].sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return left[0].localeCompare(right[0])
    })[0]?.[0] || null

    const totalBookingCount = customer.allBookingEventKeys.size
    const selectedSessionBookingCount = customer.campaignMatchEventKeys.size
    const selectedCourtBookingCount = customer.selectedCourtEventKeys.size
    const avgSpend = totalBookingCount > 0 ? customer.totalRevenue / totalBookingCount : 0

    return {
      customerKey: customer.customerKey,
      customerName: customer.customerName,
      phone: customer.phone,
      email: customer.email,
      bookingTypeDominant,
      customerTypeLabel: mapCustomerTypeLabel(bookingTypeDominant),
      preferredSession,
      preferredCourtType,
      selectedSessionBookingCount,
      selectedCourtBookingCount,
      totalBookingCount,
      lastBookingDate: customer.latestPlayDate ? formatIsoDate(customer.latestPlayDate) : null,
      latestPlayDate: customer.latestPlayDate,
      avgSpend: roundNumber(avgSpend),
      totalRevenue: roundNumber(customer.totalRevenue),
    }
  })
}

const buildCampaignDateBounds = (campaignDate) => {
  const date = new Date(`${campaignDate}T00:00:00`)
  const start = startOfDay(date)
  const endExclusive = new Date(start.getTime() + 86400000)
  return { start, endExclusive, date }
}

const summarizeUsageRows = ({ rows, session, courtCount }) => {
  const capacityCourtHours = (session.endHour - session.startHour + 1) * courtCount
  const occupiedKeys = new Set()
  const blockedKeys = new Set()

  for (const row of rows) {
    const hour = parseHourValue(row.hourStart)
    if (hour === null || hour < session.startHour || hour > session.endHour) continue
    if (row.transaction?.validBooking === false) continue

    const group = getDashboardTransactionGroup(row.transaction?.status)
    if (
      group === DASHBOARD_TRANSACTION_GROUPS.GELORA_APP_BOOKING ||
      group === DASHBOARD_TRANSACTION_GROUPS.MANUAL_WALK_IN ||
      group === DASHBOARD_TRANSACTION_GROUPS.INTERNAL
    ) {
      occupiedKeys.add(row.courtHourKey)
    } else if (group === DASHBOARD_TRANSACTION_GROUPS.TUTUP_MAINTENANCE) {
      blockedKeys.add(row.courtHourKey)
    }
  }

  // A closed court-hour cannot simultaneously be a paid court-hour. Keep the
  // blocked count separate, then subtract only what is still unblocked.
  const blockedCourtHours = blockedKeys.size
  const occupiedCourtHours = [...occupiedKeys].filter((key) => !blockedKeys.has(key)).length
  const availableCourtHours = Math.max(0, capacityCourtHours - occupiedCourtHours - blockedCourtHours)
  const occupancyRate = capacityCourtHours > 0
    ? roundNumber((occupiedCourtHours / capacityCourtHours) * 100)
    : 0

  return {
    capacityCourtHours,
    occupiedCourtHours,
    blockedCourtHours,
    availableCourtHours,
    occupancyRate,
  }
}

/**
 * Availability for a specific campaign date/session, derived from the latest
 * imported court-hour usage. Future dates with no uploads yet are reported as
 * fully available but flagged with dataAvailable=false so the UI can say the
 * number is an estimate rather than live inventory.
 */
export const getSlotAvailability = async ({
  campaignDate,
  sessionName,
  courtType = "all",
}) => {
  const session = getSessionDefinitionByName(sessionName)
  if (!session) {
    return {
      campaignDate,
      sessionName,
      sessionStartHour: null,
      sessionEndHour: null,
      courtType,
      courtTypeLabel: mapCourtTypeLabel(courtType),
      capacityCourtHours: 0,
      occupiedCourtHours: 0,
      blockedCourtHours: 0,
      availableCourtHours: 0,
      occupancyRate: 0,
      dataAvailable: false,
      note: "Unknown play session.",
    }
  }

  const { start, endExclusive } = buildCampaignDateBounds(campaignDate)
  const courtCount = getCourtCount(courtType === "all" ? null : courtType)
  const rows = await prisma.courtHourUsage.findMany({
    where: {
      playDate: { gte: start, lt: endExclusive },
      ...(courtType === "all" ? {} : { courtType }),
      transaction: {
        batch: {
          fileName: {
            notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
          },
        },
      },
    },
    select: {
      courtHourKey: true,
      hourStart: true,
      courtType: true,
      transaction: {
        select: {
          status: true,
          validBooking: true,
        },
      },
    },
  })

  const summary = summarizeUsageRows({ rows, session, courtCount })
  const dataAvailable = rows.length > 0

  return {
    campaignDate,
    sessionName,
    sessionStartHour: `${String(session.startHour).padStart(2, "0")}:00`,
    sessionEndHour: `${String(session.endHour).padStart(2, "0")}:59`,
    courtType,
    courtTypeLabel: mapCourtTypeLabel(courtType),
    ...summary,
    dataAvailable,
    note: dataAvailable
      ? "Based on the latest imported court-hour usage for this date."
      : "No court-hour usage has been uploaded for this date yet; availability is an estimate from configured court capacity.",
  }
}

/**
 * Average occupancy for the same weekday/session over the previous N weeks.
 * Used as the baseline for campaign lift instead of comparing against zero.
 */
export const getOccupancyBaseline = async ({
  campaignDate,
  sessionName,
  courtType = "all",
  weeks = 4,
}) => {
  const session = getSessionDefinitionByName(sessionName)
  if (!session) return null

  const { date } = buildCampaignDateBounds(campaignDate)
  const campaignDayIndex = date.getDay()
  const safeWeeks = Math.max(1, Math.min(Number(weeks) || 4, 12))
  const start = startOfDay(new Date(date.getTime() - safeWeeks * 7 * 86400000))
  const endExclusive = new Date(startOfDay(date).getTime())
  const courtCount = getCourtCount(courtType === "all" ? null : courtType)

  const rows = await prisma.courtHourUsage.findMany({
    where: {
      playDate: { gte: start, lt: endExclusive },
      ...(courtType === "all" ? {} : { courtType }),
      transaction: {
        batch: {
          fileName: {
            notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
          },
        },
      },
    },
    select: {
      playDate: true,
      courtHourKey: true,
      hourStart: true,
      transaction: {
        select: {
          status: true,
          validBooking: true,
        },
      },
    },
  })

  const rowsByDate = new Map()
  for (const row of rows) {
    const rowDate = startOfDay(row.playDate)
    if (rowDate.getDay() !== campaignDayIndex) continue
    const key = formatIsoDate(rowDate)
    const bucket = rowsByDate.get(key) || []
    bucket.push(row)
    rowsByDate.set(key, bucket)
  }

  const samples = [...rowsByDate.values()].map((sampleRows) =>
    summarizeUsageRows({ rows: sampleRows, session, courtCount })
  )

  if (!samples.length) {
    return {
      weeks: safeWeeks,
      sampleDays: 0,
      averageOccupancyRate: null,
      averageOccupiedCourtHours: null,
      averageAvailableCourtHours: null,
    }
  }

  const average = (values) =>
    roundNumber(values.reduce((sum, value) => sum + value, 0) / values.length)

  return {
    weeks: safeWeeks,
    sampleDays: samples.length,
    averageOccupancyRate: average(samples.map((sample) => sample.occupancyRate)),
    averageOccupiedCourtHours: average(samples.map((sample) => sample.occupiedCourtHours)),
    averageAvailableCourtHours: average(samples.map((sample) => sample.availableCourtHours)),
  }
}

export const buildAudienceCoverage = ({
  audienceSize,
  slotAvailability,
  recommendedCapacity = 1.5,
}) => {
  const emptySlots = Math.max(0, slotAvailability?.availableCourtHours || 0)
  const coveredSlots = emptySlots * recommendedCapacity
  const customersPerEmptySlot = emptySlots > 0
    ? roundNumber(audienceSize / emptySlots, 2)
    : null

  let coverageStatus = "unknown"
  if (emptySlots > 0) {
    if (audienceSize < emptySlots) coverageStatus = "insufficient"
    else if (audienceSize > coveredSlots) coverageStatus = "sufficient"
    else coverageStatus = "adequate"
  }

  return {
    emptySlots,
    capacityCourtHours: slotAvailability?.capacityCourtHours || 0,
    audienceSize,
    customersPerEmptySlot,
    recommendedCoveragePerSlot: recommendedCapacity,
    coverageStatus,
    note:
      coverageStatus === "insufficient"
        ? "The audience is smaller than the number of empty slots. Expect partial fill even if everyone converts."
        : coverageStatus === "adequate"
          ? "The audience roughly covers the empty slots at the recommended conversion buffer."
          : coverageStatus === "sufficient"
            ? "The audience is larger than the empty slots. Prioritise the highest-intent customers to avoid wasted outreach."
            : "Slot availability is unknown for this date.",
  }
}

export const getLowOccupancySessions = async ({ date, startDate: requestedStartDate, endDate: requestedEndDate, campaignDay = null, analysisPeriodMonths = 3, courtType = "all", threshold = 40 }) => {
  const { date: selectedDate, startDate, endDate } = buildDateRange({ date, startDate: requestedStartDate, endDate: requestedEndDate })
  const courtTypes = courtType === "all" ? ["mini_soccer", "basketball"] : [courtType]
  const weekdayNames = WEEKDAY_NAMES
  const effectiveCampaignDay = campaignDay || weekdayNames[getJakartaWeekdayIndex(startDate)]
  const campaignDayIndex = weekdayNames.indexOf(effectiveCampaignDay)
  const analysisRange = buildCampaignAnalysisRange(endDate, analysisPeriodMonths)

  const usageRows = await prisma.courtHourUsage.findMany({
    where: buildCourtHourUsageWhere({
      startDate,
      endDateExclusive: new Date(endDate.getTime() + 1),
      courtType: courtType === "all" ? null : courtType,
    }),
    select: {
      courtType: true,
      hourStart: true,
      courtHourKey: true,
    },
  })

  const occupiedBuckets = new Map()

  usageRows.forEach((row) => {
    const hour = parseHourValue(row.hourStart)
    if (hour === null || !row.courtType) return

    const derivedSessionName = resolveSessionNameByHour(hour)
    if (!derivedSessionName) return

    const bucketKey = `${row.courtType}:${derivedSessionName}`
    occupiedBuckets.set(bucketKey, (occupiedBuckets.get(bucketKey) || 0) + 1)
  })

  const relevantTransactions = await prisma.facilityTransaction.findMany({
    where: {
      validBooking: true,
      customerKey: { not: "" },
      playDate: { gte: analysisRange.analysisStart, lte: analysisRange.analysisEnd },
      status: {
        in: [
          CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED,
          CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN,
        ],
      },
      netRevenue: { gt: 0 },
      NOT: {
        customerKey: {
          startsWith: "SYS-",
        },
      },
      bookingEventKey: { not: "" },
      ...(courtType === "all" ? {} : { courtType }),
      batch: {
        fileName: {
          not: "tmp-upload-sample.csv",
        },
      },
    },
    select: {
      customerKey: true,
      status: true,
      netRevenue: true,
      startHour: true,
      playDate: true,
      courtType: true,
    },
  })

  const potentialTargetBuckets = new Map()

  relevantTransactions.forEach((transaction) => {
    const hour = parseHourValue(transaction.startHour)
    const derivedSessionName = hour === null ? null : resolveSessionNameByHour(hour)
    if (!derivedSessionName || !transaction.courtType) return
    if (campaignDayIndex >= 0 && getJakartaWeekdayIndex(transaction.playDate) !== campaignDayIndex) return

    const bucketKey = `${transaction.courtType}:${derivedSessionName}`
    const set = potentialTargetBuckets.get(bucketKey) || new Set()
    set.add(transaction.customerKey)
    potentialTargetBuckets.set(bucketKey, set)
  })

  return courtTypes.flatMap((selectedCourtType) =>
    SESSION_DEFINITIONS.map((session) => {
      const occupiedCourtHours = occupiedBuckets.get(`${selectedCourtType}:${session.name}`) || 0
      const sessionDurationHours = session.endHour - session.startHour + 1
      const dayCount = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime() + 1) / 86400000))
      const courtCount = getCourtCount(selectedCourtType)
      const availableCourtHours = sessionDurationHours * courtCount * dayCount
      const occupancyRate = availableCourtHours > 0
        ? roundNumber((occupiedCourtHours / availableCourtHours) * 100)
        : 0

      return {
        date: selectedDate,
        courtType: selectedCourtType,
        courtTypeLabel: mapCourtTypeLabel(selectedCourtType),
        sessionName: session.name,
        sessionStartHour: `${String(session.startHour).padStart(2, "0")}:00`,
        sessionEndHour: `${String(session.endHour).padStart(2, "0")}:59`,
        occupiedCourtHours,
        availableCourtHours,
        occupancyRate,
        status: occupancyRate < threshold ? "Low" : "Normal",
        potentialTargetCount: (potentialTargetBuckets.get(`${selectedCourtType}:${session.name}`) || new Set()).size,
      }
    })
  )
}

export const getRecommendedCustomers = async ({
  campaignDay = "Monday",
  analysisPeriodMonths = 3,
  courtType = "all",
  sessionName,
  customerType = "all",
  segmentName = null,
  limit = 50,
  offset = 0,
  campaignDate = null,
}) => {
  const normalizedCampaignDate = campaignDate ? String(campaignDate).slice(0, 10) : null
  const cacheKey = buildRecommendationCacheKey({
    campaignDay,
    analysisPeriodMonths,
    courtType,
    sessionName,
    customerType,
    segmentName,
    limit,
    offset,
    campaignDate: normalizedCampaignDate,
  })
  const cached = readRecommendationCache(cacheKey)
  if (cached) return cached

  const latestPlayDate = await getLatestCampaignPlayDate(prisma)
  if (!latestPlayDate) {
    return { campaignDay, analysisPeriodMonths, latestPlayDate: null, unavailableReason: "LATEST_PLAY_DATE_NOT_AVAILABLE", monthlyPerformance: [], historicalSummary: null, courtType, sessionName, segmentName, customerType, campaignDate: normalizedCampaignDate, historyLookbackMonths: CAMPAIGN_HISTORY_LOOKBACK_MONTHS, slotAvailability: null, audienceCoverage: null, customers: [], totalCustomers: 0, pagination: { limit, offset, returned: 0, totalCustomers: 0, hasMore: false } }
  }
  const { analysisStart, analysisEnd } = buildCampaignAnalysisRange(
    latestPlayDate,
    analysisPeriodMonths
  )
  const selectedDate = formatIsoDate(latestPlayDate)
  const dayIndex = WEEKDAY_NAMES.indexOf(campaignDay)
  const session = getSessionDefinitionByName(sessionName)
  const historyLookbackStart = new Date(selectedDate)
  historyLookbackStart.setMonth(
    historyLookbackStart.getMonth() - CAMPAIGN_HISTORY_LOOKBACK_MONTHS
  )

  // Recommendations are ranked from a bounded booking history (two years by
  // default), not just the analysisPeriodMonths window — that window is still
  // used below for the separate Historical Campaign Performance figures.
  const transactions = await prisma.facilityTransaction.findMany({
    where: {
      validBooking: true,
      customerKey: { not: "" },
      playDate: { gte: historyLookbackStart },
      status: {
        in: [
          CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED,
          CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN,
        ],
      },
      netRevenue: { gt: 0 },
      NOT: {
        customerKey: {
          startsWith: "SYS-",
        },
      },
      bookingEventKey: { not: "" },
      batch: {
        fileName: {
          not: "tmp-upload-sample.csv",
        },
      },
    },
    orderBy: [{ customerKey: "asc" }, { playDate: "desc" }, { bookingEventKey: "asc" }],
    select: {
      customerKey: true,
      customerName: true,
      normalizedName: true,
      nama: true,
      normalizedPhone: true,
      noTelepon: true,
      normalizedEmail: true,
      email: true,
      bookingType: true,
      status: true,
      playDate: true,
      startHour: true,
      bookingEventKey: true,
      courtType: true,
      netRevenue: true,
    },
  })

  const aggregatedCustomers = aggregateCustomerHistory(transactions, { sessionName, courtType, campaignDay })

  const segmentByCustomerKey = await buildSegmentMap(
    aggregatedCustomers.map((customer) => customer.customerKey)
  )

  const filteredCustomers = aggregatedCustomers
    .map((customer) => {
      const rfmSegmentName = segmentByCustomerKey.get(customer.customerKey) || null
      const recencyDays = customer.latestPlayDate
        ? Math.max(
            0,
            Math.round(
              (startOfDay(new Date(selectedDate)).getTime() -
                startOfDay(customer.latestPlayDate).getTime()) /
                86400000
            )
          )
        : 999

      return {
        ...customer,
        recencyDays,
        rfmSegmentName,
      }
    })
    .filter((customer) => (segmentName ? customer.rfmSegmentName === segmentName : true))
    .filter((customer) => customer.preferredSession === sessionName)
    .filter((customer) => (courtType && courtType !== "all" ? customer.preferredCourtType === courtType : true))
    .filter((customer) => matchesCustomerTypeFilter(customer.customerTypeLabel, customerType))
    // Only recommend customers who have actually booked this exact
    // campaign weekday + session combination before — matching the
    // customer's general preferred session isn't enough to call them a
    // fit for filling this specific campaign slot.
    .filter((customer) => customer.selectedSessionBookingCount > 0)

  const maxSelectedSessionBookingCount = Math.max(
    ...filteredCustomers.map((customer) => customer.selectedSessionBookingCount),
    0
  )
  const maxSelectedCourtBookingCount = Math.max(
    ...filteredCustomers.map((customer) => customer.selectedCourtBookingCount),
    0
  )
  const maxTotalBookingCount = Math.max(
    ...filteredCustomers.map((customer) => customer.totalBookingCount),
    0
  )

  const rankedCustomers = filteredCustomers
    .map((customer) => {
      const targetPriorityScore = buildTargetPriorityScore({
        selectedSessionBookingCount: customer.selectedSessionBookingCount,
        selectedCourtBookingCount: customer.selectedCourtBookingCount,
        totalBookingCount: customer.totalBookingCount,
        recencyDays: customer.recencyDays,
        rfmSegmentName: customer.rfmSegmentName,
        hasPhone: Boolean(customer.phone),
        hasEmail: Boolean(customer.email),
        maxSelectedSessionBookingCount,
        maxSelectedCourtBookingCount,
        maxTotalBookingCount,
      })
      const targetPriorityLabel = buildTargetPriorityLabel(targetPriorityScore)
      const suggestedAction = buildSuggestedAction({
        customerTypeLabel: customer.customerTypeLabel,
        rfmSegmentName: customer.rfmSegmentName,
      })
      const whatsappMessage = buildWhatsappMessage({
        customerName: customer.customerName,
        preferredSession: customer.preferredSession,
        courtType,
        rfmSegmentName: customer.rfmSegmentName,
        customerTypeLabel: customer.customerTypeLabel,
        totalBookingCount: customer.totalBookingCount,
        recencyDays: customer.recencyDays,
        campaignDate: normalizedCampaignDate,
      })

      return {
        customerKey: customer.customerKey,
        customerName: customer.customerName,
        phone: customer.phone,
        email: customer.email,
        customerTypeLabel: customer.customerTypeLabel,
        bookingTypeDominant: customer.bookingTypeDominant,
        preferredSession: customer.preferredSession,
        selectedSessionBookingCount: customer.selectedSessionBookingCount,
        selectedCourtBookingCount: customer.selectedCourtBookingCount,
        totalBookingCount: customer.totalBookingCount,
        lastBookingDate: customer.lastBookingDate,
        recencyDays: customer.recencyDays,
        avgSpend: customer.avgSpend,
        totalRevenue: customer.totalRevenue,
        rfmSegmentName: customer.rfmSegmentName || "Not segmented",
        targetPriorityScore,
        targetPriorityLabel,
        suggestedAction,
        whatsappMessage,
      }
    })
    .sort((left, right) => {
      if (right.targetPriorityScore !== left.targetPriorityScore) {
        return right.targetPriorityScore - left.targetPriorityScore
      }

      if (right.selectedSessionBookingCount !== left.selectedSessionBookingCount) {
        return right.selectedSessionBookingCount - left.selectedSessionBookingCount
      }

      return (left.customerName || left.customerKey).localeCompare(
        right.customerName || right.customerKey
      )
    })

  const pagedCustomers = rankedCustomers.slice(offset, offset + limit)

  const capacityCourtCount = courtType === "all" ? 2 : 1
  const allUsage = await prisma.courtHourUsage.findMany({
    where: buildCourtHourUsageWhere({
      startDate: analysisStart,
      endDateExclusive: new Date(analysisEnd.getTime() + 1),
      courtType: courtType === "all" ? null : courtType,
      customerType: "all",
      bookingType: "all",
      includeOperational: true,
    }),
    select: { courtHourKey: true, playDate: true, hourStart: true, transaction: { select: { status: true, netRevenue: true, bookingEventKey: true } } },
  })
  const monthlyPerformance = []
  for (let offsetMonth = analysisPeriodMonths - 1; offsetMonth >= 0; offsetMonth -= 1) {
    const monthStart = new Date(analysisEnd.getFullYear(), analysisEnd.getMonth() - offsetMonth, 1)
    const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1)
    const monthEnd = nextMonth > analysisEnd ? analysisEnd : new Date(nextMonth.getTime() - 1)
    const matching = allUsage.filter((row) => {
      const playDate = new Date(row.playDate)
      const hour = parseHourValue(row.hourStart)
      return playDate >= monthStart && playDate <= monthEnd && getJakartaWeekdayIndex(playDate) === dayIndex && (!session || (hour >= session.startHour && hour <= session.endHour))
    })
    const monthUsage = allUsage.filter((row) => new Date(row.playDate) >= monthStart && new Date(row.playDate) <= monthEnd)
    const heatmap = buildEmptySlotHeatmap({ usageRows: monthUsage, startDate: monthStart, endDate: monthEnd, courtCount: capacityCourtCount })
    const dayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayIndex]
    const campaignCells = heatmap.slots.filter((cell) => {
      const hour = parseHourValue(cell.startHour)
      return cell.day_short === dayShort && (!session || (hour >= session.startHour && hour <= session.endHour))
    })
    const occupiedSlots = campaignCells.reduce((sum, cell) => sum + cell.occupiedSlots, 0)
    const totalPossibleSlots = campaignCells.reduce((sum, cell) => sum + cell.totalPossibleSlots, 0)
    const revenue = sumCampaignRevenue(matching)
    const emptySlots = Math.max(0, totalPossibleSlots - occupiedSlots)
    monthlyPerformance.push({
      month: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`,
      monthLabel: monthStart.toLocaleString("en-US", { month: "long", year: "numeric" }),
      dataThrough: formatIsoDate(monthEnd), totalPossibleSlots, occupiedSlots, emptySlots,
      occupancyRate: totalPossibleSlots > 0 ? roundNumber((occupiedSlots / totalPossibleSlots) * 100, 1) : null,
      revenue: roundNumber(revenue),
    })
  }
  const availableMonths = monthlyPerformance.filter((month) => month.occupancyRate !== null)
  const totalRevenue = monthlyPerformance.reduce((sum, month) => sum + month.revenue, 0)
  const historicalSummary = {
    analysisPeriodMonths,
    averageOccupancy: availableMonths.length ? roundNumber(availableMonths.reduce((sum, month) => sum + month.occupancyRate, 0) / availableMonths.length, 1) : null,
    averageFilledSlots: roundNumber(monthlyPerformance.reduce((sum, month) => sum + month.occupiedSlots, 0) / monthlyPerformance.length, 1),
    totalRevenue: roundNumber(totalRevenue),
    averageMonthlyRevenue: roundNumber(totalRevenue / monthlyPerformance.length),
  }

  const slotAvailability = normalizedCampaignDate
    ? await getSlotAvailability({
        campaignDate: normalizedCampaignDate,
        sessionName,
        courtType,
      })
    : null
  const audienceCoverage = slotAvailability
    ? buildAudienceCoverage({
        audienceSize: rankedCustomers.length,
        slotAvailability,
      })
    : null

  const result = {
    campaignDay, analysisPeriodMonths, latestPlayDate: selectedDate, unavailableReason: null,
    courtType,
    sessionName,
    segmentName,
    customerType,
    campaignDate: normalizedCampaignDate,
    historyLookbackMonths: CAMPAIGN_HISTORY_LOOKBACK_MONTHS,
    slotAvailability,
    audienceCoverage,
    customers: pagedCustomers,
    totalCustomers: rankedCustomers.length,
    monthlyPerformance,
    historicalSummary,
    pagination: {
      limit,
      offset,
      returned: pagedCustomers.length,
      totalCustomers: rankedCustomers.length,
      hasMore: offset + pagedCustomers.length < rankedCustomers.length,
    },
  }

  writeRecommendationCache(cacheKey, result)
  return result
}

