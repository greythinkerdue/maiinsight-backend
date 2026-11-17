import test from "node:test"
import assert from "node:assert/strict"

import {
  assignControlFlags,
  buildPromoCode,
  buildWhatsappUrl,
  computeOutreachMetrics,
  normalCdf,
  normalizePhoneForWhatsapp,
  twoProportionConfidenceInterval,
  twoProportionZTest,
} from "../outreachCampaign.service.js"

test("buildPromoCode is stable, uppercase, and campaign-scoped", () => {
  assert.equal(buildPromoCode("maiin", 12, 3), "MAIIN-12-003")
  assert.equal(buildPromoCode("maiin", 12, 3), buildPromoCode("maiin", 12, 3))
  assert.notEqual(buildPromoCode("maiin", 12, 3), buildPromoCode("maiin", 12, 4))
})

test("normalizePhoneForWhatsapp produces an international number", () => {
  assert.equal(normalizePhoneForWhatsapp("0812-3456-7890"), "6281234567890")
  assert.equal(normalizePhoneForWhatsapp("+62 812 3456 7890"), "6281234567890")
  assert.equal(normalizePhoneForWhatsapp(""), null)
})

test("buildWhatsappUrl URL-encodes the message and escapes the phone", () => {
  const url = buildWhatsappUrl({
    phone: "0812 3456 7890",
    message: "Hai kak, yuk main lagi & amankan jadwalmu.",
  })
  assert.match(url, /^https:\/\/wa\.me\/6281234567890\?text=/)
  assert.match(url, /%26/)
})

test("control flags stay off for small audiences and are assigned deterministically", () => {
  const small = Array.from({ length: 19 }, (_, index) => ({ id: index + 1 }))
  assert.ok(assignControlFlags(small, 10).every((recipient) => recipient.isControl === false))

  const large = Array.from({ length: 20 }, (_, index) => ({ id: index + 1 }))
  const flagged = assignControlFlags(large, 10)
  assert.equal(flagged.filter((recipient) => recipient.isControl).length, 2)
  assert.equal(flagged[0].isControl, true)
  assert.equal(flagged[1].isControl, false)
  assert.ok(assignControlFlags(large, 0).every((recipient) => recipient.isControl === false))
})

test("outreach metrics attribute only the recipient's own promo code", () => {
  const recipients = [
    {
      customerKey: "a",
      promoCode: "MAIIN-1-0001",
      isControl: false,
      status: "sent",
    },
    {
      customerKey: "b",
      promoCode: "MAIIN-1-0002",
      isControl: false,
      status: "sent",
    },
    {
      customerKey: "c",
      promoCode: "MAIIN-1-0003",
      isControl: true,
      status: "sent",
    },
  ]

  const metrics = computeOutreachMetrics({
    recipients,
    bookings: [
      {
        customerKey: "a",
        bookingEventKey: "a-1",
        playDate: "2026-11-20",
        netRevenue: 100000,
        promoName: "MAIIN-1-0001",
      },
      {
        customerKey: "b",
        bookingEventKey: "b-1",
        playDate: "2026-11-21",
        netRevenue: 200000,
        promoName: "MAIIN-1-0002",
        promosi: "Promo lain",
      },
      {
        customerKey: "c",
        bookingEventKey: "c-1",
        playDate: "2026-11-21",
        netRevenue: 50000,
      },
      {
        customerKey: "a",
        bookingEventKey: "a-1",
        playDate: "2026-11-20",
        netRevenue: 100000,
        promoName: "MAIIN-1-0001",
      },
    ],
  })

  assert.equal(metrics.audienceSize, 3)
  assert.equal(metrics.treatmentSize, 2)
  assert.equal(metrics.controlSize, 1)
  assert.equal(metrics.attributedBookingCount, 2)
  assert.equal(metrics.attributedRevenue, 300000)
  assert.equal(metrics.attributedCustomers, 2)
  assert.equal(metrics.windowRevenue, 350000)
  assert.equal(metrics.redemptionRate, 100)
  assert.equal(metrics.cannibalizationRate, 0)
  assert.equal(metrics.responseRate, null)
})

test("a promo code belonging to another recipient is not attributed", () => {
  const metrics = computeOutreachMetrics({
    recipients: [
      { customerKey: "a", promoCode: "MAIIN-2-0001", isControl: false, status: "sent" },
      { customerKey: "b", promoCode: "MAIIN-2-0002", isControl: false, status: "sent" },
    ],
    bookings: [
      {
        customerKey: "a",
        bookingEventKey: "a-1",
        playDate: "2026-11-20",
        netRevenue: 100000,
        promosi: "MAIIN-2-0002",
      },
    ],
  })

  assert.equal(metrics.attributedBookingCount, 0)
  assert.equal(metrics.attributedRevenue, 0)
  assert.equal(metrics.cannibalizationRate, 100)
})

test("occupancy, coverage, opt-out, and cost KPIs use their documented inputs", () => {
  const metrics = computeOutreachMetrics({
    recipients: [
      { customerKey: "a", promoCode: "X-1-0001", isControl: false, status: "sent" },
      { customerKey: "b", promoCode: "X-1-0002", isControl: false, status: "pending" },
      { customerKey: "c", promoCode: "X-1-0003", isControl: false, status: "opted_out" },
    ],
    bookings: [
      {
        customerKey: "a",
        bookingEventKey: "a-1",
        playDate: "2026-11-20",
        netRevenue: 200000,
        promoName: "X-1-0001",
      },
    ],
    slotAvailability: {
      availableCourtHours: 10,
      capacityCourtHours: 20,
      occupancyRate: 50,
    },
    baselineOccupancy: { averageOccupancyRate: 40 },
    costBudget: 100000,
  })

  assert.equal(metrics.sentCount, 1)
  assert.equal(metrics.pendingCount, 1)
  assert.equal(metrics.optedOutCount, 1)
  assert.equal(metrics.optOutRate, 33.33)
  assert.equal(metrics.costPerBooking, 100000)
  assert.equal(metrics.returnOnCampaignSpend, 2)
  assert.equal(metrics.occupancyRate, 50)
  assert.equal(metrics.baselineOccupancyRate, 40)
  assert.equal(metrics.occupancyLiftPct, 25)
  assert.equal(metrics.emptySlots, 10)
  assert.equal(metrics.audienceCoverage?.coverageStatus, "insufficient")
})

test("a converted treatment customer without a promo match is surfaced for manual reconciliation", () => {
  const metrics = computeOutreachMetrics({
    recipients: [
      { customerKey: "a", customerName: "Andi", promoCode: "X-1-0001", isControl: false, status: "sent" },
      { customerKey: "b", customerName: "Budi", promoCode: "X-1-0002", isControl: false, status: "sent" },
    ],
    bookings: [
      {
        customerKey: "a",
        bookingEventKey: "a-1",
        playDate: "2026-11-20",
        netRevenue: 150000,
        promoName: "X-1-0001",
      },
      {
        customerKey: "b",
        bookingEventKey: "b-1",
        playDate: "2026-11-21",
        netRevenue: 90000,
      },
    ],
  })

  assert.equal(metrics.possibleUnmatchedConversions.length, 1)
  assert.equal(metrics.possibleUnmatchedConversions[0].customerKey, "b")
  assert.equal(metrics.possibleUnmatchedConversions[0].customerName, "Budi")
  assert.equal(metrics.possibleUnmatchedConversions[0].revenue, 90000)
  assert.match(String(metrics.possibleUnmatchedConversionsNote), /Verify at the register/)
})

test("a code logged in tipeVoucher instead of promoName still attributes", () => {
  const metrics = computeOutreachMetrics({
    recipients: [
      { customerKey: "a", promoCode: "X-1-0001", isControl: false, status: "sent" },
    ],
    bookings: [
      {
        customerKey: "a",
        bookingEventKey: "a-1",
        playDate: "2026-11-20",
        netRevenue: 150000,
        tipeVoucher: "X-1-0001",
      },
    ],
  })

  assert.equal(metrics.attributedBookingCount, 1)
  assert.equal(metrics.possibleUnmatchedConversions.length, 0)
})

test("missing control group marks lift as unavailable rather than zero", () => {
  const metrics = computeOutreachMetrics({
    recipients: [
      { customerKey: "a", promoCode: "X-1-0001", isControl: false, status: "sent" },
      { customerKey: "b", promoCode: "X-1-0002", isControl: false, status: "sent" },
    ],
    bookings: [],
  })

  assert.equal(metrics.controlSize, 0)
  assert.equal(metrics.controlConversionRate, 0)
  assert.equal(metrics.liftPct, null)
  assert.equal(metrics.liftSignificance, null)
  assert.match(String(metrics.controlNote), /No holdout group/)
})

test("normalCdf matches standard normal distribution reference values", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6)
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3)
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3)
})

test("twoProportionZTest matches a hand-computed borderline example", () => {
  // p1=0.3 (30/100), p2=0.2 (20/100): pooled=0.25, SE~=0.06124, z~=1.633, p~=0.1026
  const result = twoProportionZTest({ x1: 30, n1: 100, x2: 20, n2: 100 })
  assert.ok(Math.abs(result.zScore - 1.633) < 0.01)
  assert.ok(Math.abs(result.pValue - 0.1026) < 0.01)
  assert.equal(result.significant, false)
})

test("twoProportionZTest flags a clear lift as significant", () => {
  const result = twoProportionZTest({ x1: 60, n1: 100, x2: 20, n2: 100 })
  assert.equal(result.significant, true)
  assert.ok(result.pValue < 0.001)
})

test("twoProportionConfidenceInterval brackets the observed proportion difference", () => {
  const ci = twoProportionConfidenceInterval({ x1: 30, n1: 100, x2: 20, n2: 100 })
  assert.ok(ci.lower < 0.1 && ci.upper > 0.1)
})

test("computeOutreachMetrics omits liftSignificance below the minimum group size", () => {
  const metrics = computeOutreachMetrics({
    recipients: [
      { customerKey: "a", promoCode: "X-1-0001", isControl: false, status: "sent" },
      { customerKey: "b", promoCode: "X-1-0002", isControl: true, status: "sent" },
    ],
    bookings: [],
  })

  assert.equal(metrics.liftSignificance, null)
})

test("computeOutreachMetrics reports a significant lift for a clearly separated holdout", () => {
  const treatment = Array.from({ length: 10 }, (_, index) => ({
    customerKey: `t${index + 1}`,
    promoCode: `T-1-${String(index + 1).padStart(4, "0")}`,
    isControl: false,
    status: "sent",
  }))
  const control = Array.from({ length: 10 }, (_, index) => ({
    customerKey: `c${index + 1}`,
    promoCode: `T-1-C${String(index + 1).padStart(3, "0")}`,
    isControl: true,
    status: "sent",
  }))
  const treatmentBookings = treatment.slice(0, 8).map((recipient) => ({
    customerKey: recipient.customerKey,
    bookingEventKey: `${recipient.customerKey}-1`,
    playDate: "2026-11-20",
    netRevenue: 100000,
    promoName: recipient.promoCode,
  }))
  const controlBookings = [
    {
      customerKey: "c1",
      bookingEventKey: "c1-1",
      playDate: "2026-11-20",
      netRevenue: 100000,
    },
  ]

  const metrics = computeOutreachMetrics({
    recipients: [...treatment, ...control],
    bookings: [...treatmentBookings, ...controlBookings],
  })

  assert.equal(metrics.treatmentSize, 10)
  assert.equal(metrics.controlSize, 10)
  assert.ok(metrics.liftSignificance)
  assert.equal(metrics.liftSignificance.method, "two_proportion_z_test")
  assert.equal(metrics.liftSignificance.significant, true)
  assert.ok(metrics.liftSignificance.pValue < 0.01)
})
