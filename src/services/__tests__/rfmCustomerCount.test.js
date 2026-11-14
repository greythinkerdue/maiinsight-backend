import test from "node:test"
import assert from "node:assert/strict"

import {
  aggregateCustomerMetrics,
  applyRecencyStatsToClusterProfiles,
  countEligibleCanonicalCustomers,
} from "../rfmSegmentation.service.js"

const eligibleTransaction = (customerKey, index = 0) => ({
  customerKey,
  customerName: customerKey,
  bookingType: "GeloraApp Booking",
  status: "Payment Completed",
  playDate: new Date(2026, 6, 1 + index),
  bookingEventKey: `${customerKey}-EVENT-${index}`,
  netRevenue: 100000,
})

test("RFM aggregation counts one canonical customer regardless of transaction count", () => {
  const transactions = [
    ...Array.from({ length: 5 }, (_, index) => eligibleTransaction("CUST-A", index)),
    ...Array.from({ length: 3 }, (_, index) => eligibleTransaction("CUST-B", index)),
    eligibleTransaction("CUST-C"),
  ]

  assert.equal(aggregateCustomerMetrics(transactions, new Date(2026, 7, 1)).length, 3)
})

test("RFM aggregation excludes missing and non-canonical customer keys", () => {
  const transactions = [
    eligibleTransaction("CUST-VALID"),
    eligibleTransaction(null),
    eligibleTransaction(""),
    eligibleTransaction("SYS-INTERNAL"),
    eligibleTransaction("INVALID"),
  ]

  assert.deepEqual(
    aggregateCustomerMetrics(transactions, new Date(2026, 7, 1)).map(({ customerKey }) => customerKey),
    ["CUST-VALID"]
  )
})

test("eligible customer count is a database count over canonical customers with RFM-eligible transactions", async () => {
  let receivedWhere
  const db = {
    customer: {
      count: async ({ where }) => {
        receivedWhere = where
        return 3
      },
    },
  }

  const count = await countEligibleCanonicalCustomers({ db })

  assert.equal(count, 3)
  assert.equal(receivedWhere.customerKey.startsWith, "CUST-")
  const transactionWhere = receivedWhere.facilityTransactions.some
  assert.equal(transactionWhere.playDate.not, null)
  assert.ok(transactionWhere.AND.some(({ validBooking }) => validBooking === true))
  assert.ok(transactionWhere.AND.some(({ netRevenue }) => netRevenue?.gt === 0))
  assert.ok(transactionWhere.AND.some(({ customerKey }) => customerKey?.startsWith === "CUST-"))
})

test("recency-filtered profiles use reachable customer stats and keep every segment", () => {
  const profiles = [
    {
      clusterId: 0,
      segmentName: "High-Value Players",
      customerCount: 10,
      avgRecency: 100,
      avgFrequency: 8,
      avgMonetary: 800000,
      avgRScore: 4.2,
      avgFScore: 4.1,
      avgMScore: 4.3,
      labelReason: "Full-run label",
    },
    {
      clusterId: 3,
      segmentName: "Lapsed Players",
      customerCount: 20,
      avgRecency: 900,
      avgFrequency: 1,
      avgMonetary: 100000,
      avgRScore: 1,
      avgFScore: 1,
      avgMScore: 1,
      labelReason: "Full-run lapsed label",
    },
  ]
  const groupedStats = [
    {
      segmentName: "High-Value Players",
      _count: { _all: 4 },
      _avg: {
        recency: 20,
        frequency: 6,
        monetary: 500000,
        rScore: 4.5,
        fScore: 4,
        mScore: 4.2,
      },
    },
  ]

  const filtered = applyRecencyStatsToClusterProfiles(profiles, groupedStats)

  assert.equal(filtered.length, 2)
  assert.equal(filtered[0].customerCount, 4)
  assert.equal(filtered[0].avgRecency, 20)
  assert.match(filtered[0].labelReason, /Average R\/F\/M scores are 4\.50\/4\.00\/4\.20/)
  assert.equal(filtered[1].customerCount, 0)
  assert.match(filtered[1].labelReason, /No customers in this segment/)
})
