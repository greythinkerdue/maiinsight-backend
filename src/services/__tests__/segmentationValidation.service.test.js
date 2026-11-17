import test from "node:test"
import assert from "node:assert/strict"

import {
  validateSegmentationCustomerInput,
  validateSegmentationLookupInput,
  validateSegmentationRunInput,
} from "../segmentationValidation.service.js"

test("validateSegmentationRunInput normalizes valid input", () => {
  const input = validateSegmentationRunInput({
    month: "Sep",
    year: "2026",
    periodType: "ytd",
    bookingType: "GeloraApp Booking",
    k: "4",
    minK: "2",
    maxK: "6",
    autoK: "false",
    analysisMode: "true",
  })

  assert.deepEqual(input, {
    month: "Sept",
    year: 2026,
    periodType: "YTD",
    venue: undefined,
    courtType: undefined,
    customerType: undefined,
    bookingType: "GeloraApp Booking",
    k: 4,
    minK: 2,
    maxK: 6,
    autoK: false,
    analysisMode: true,
  })
})

test("validateSegmentationLookupInput rejects invalid month", () => {
  assert.throws(
    () => validateSegmentationLookupInput({ month: "January" }),
    /month must be All Month or a valid month label/
  )
})

test("validateSegmentationLookupInput accepts canonical numeric month", () => {
  const input = validateSegmentationLookupInput({
    month: "9",
    year: "2026",
    periodType: "mtd",
  })

  assert.equal(input.month, "Sept")
  assert.equal(input.year, 2026)
  assert.equal(input.periodType, "MTD")
})

test("validateSegmentationLookupInput normalizes last-visit recency filter", () => {
  const input = validateSegmentationLookupInput({ maxRecencyDays: "365" })

  assert.equal(input.maxRecencyDays, 365)
})

test("validateSegmentationLookupInput rejects invalid last-visit recency filter", () => {
  assert.throws(
    () => validateSegmentationLookupInput({ maxRecencyDays: "0" }),
    /maxRecencyDays must be an integer greater than or equal to 1/
  )

  assert.throws(
    () => validateSegmentationLookupInput({ maxRecencyDays: "3660" }),
    /maxRecencyDays must be less than or equal to 3650/
  )
})

test("validateSegmentationCustomerInput applies safe pagination defaults", () => {
  const input = validateSegmentationCustomerInput({
    includeCustomers: "true",
    limit: "25",
    offset: "10",
    segmentName: "High-Value Players",
  })

  assert.equal(input.includeCustomers, true)
  assert.equal(input.limit, 25)
  assert.equal(input.offset, 10)
  assert.equal(input.segmentName, "High-Value Players")
})

test("validateSegmentationCustomerInput rejects oversized page size", () => {
  assert.throws(
    () => validateSegmentationCustomerInput({ limit: "501" }),
    /limit must be less than or equal to 500/
  )
})

test("validateSegmentationCustomerInput normalizes column filters and sorting", () => {
  const input = validateSegmentationCustomerInput({
    bookingTypeDominant: "manual walk-in",
    recencyMin: "31",
    recencyMax: "90",
    frequencyMin: "2",
    frequencyMax: "10",
    monetaryMin: "150000.5",
    monetaryMax: "2500000",
    clusterFit: "mixed_borderline",
    sortBy: "monetary",
    sortDirection: "desc",
  })

  assert.equal(input.bookingTypeDominant, "Manual/Walk-in")
  assert.equal(input.recencyMin, 31)
  assert.equal(input.recencyMax, 90)
  assert.equal(input.frequencyMin, 2)
  assert.equal(input.frequencyMax, 10)
  assert.equal(input.monetaryMin, 150000.5)
  assert.equal(input.monetaryMax, 2500000)
  assert.equal(input.clusterFit, "mixed_borderline")
  assert.equal(input.sortBy, "monetary")
  assert.equal(input.sortDirection, "desc")
})

test("validateSegmentationCustomerInput rejects unsupported sort and fit values", () => {
  assert.throws(
    () => validateSegmentationCustomerInput({ sortBy: "createdAt" }),
    /sortBy must be customer, bookingType, recency, frequency, monetary, segment, clusterFit/
  )

  assert.throws(
    () => validateSegmentationCustomerInput({ sortDirection: "sideways" }),
    /sortDirection must be asc, desc/
  )

  assert.throws(
    () => validateSegmentationCustomerInput({ clusterFit: "unknown" }),
    /clusterFit must be representative, reassigned, mixed_borderline/
  )

  assert.throws(
    () => validateSegmentationCustomerInput({ monetaryMin: "-1" }),
    /monetaryMin must be a non-negative number/
  )
})

