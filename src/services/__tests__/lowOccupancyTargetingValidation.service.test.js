import test from "node:test"
import assert from "node:assert/strict"

import {
  validateLowOccupancySessionInput,
  validateRecommendedCustomersInput,
} from "../lowOccupancyTargetingValidation.service.js"

test("validateLowOccupancySessionInput applies defaults", () => {
  assert.deepEqual(validateLowOccupancySessionInput({}), {
    date: null,
    courtType: "all",
    threshold: 40,
  })
})

test("validateRecommendedCustomersInput normalizes valid query params", () => {
  assert.deepEqual(
    validateRecommendedCustomersInput({
      campaignDay: "Friday",
      analysisPeriodMonths: "4",
      courtType: "mini_soccer",
      sessionName: "Morning",
      customerType: "non_membership",
      segmentName: "Occasional Players",
      limit: "25",
      offset: "5",
    }),
    {
      campaignDay: "Friday",
      analysisPeriodMonths: 4,
      courtType: "mini_soccer",
      sessionName: "Morning",
      customerType: "non_membership",
      segmentName: "Occasional Players",
      campaignDate: null,
      limit: 25,
      offset: 5,
      search: null,
      priorityLabel: null,
      avgSpendMin: null,
      avgSpendMax: null,
    }
  )
})

test("validateRecommendedCustomersInput normalizes the table-filter params", () => {
  const result = validateRecommendedCustomersInput({
    sessionName: "Morning",
    search: "  Budi  ",
    priorityLabel: "High Priority",
    avgSpendMin: "100000",
    avgSpendMax: "500000",
  })

  assert.equal(result.search, "Budi")
  assert.equal(result.priorityLabel, "High Priority")
  assert.equal(result.avgSpendMin, 100000)
  assert.equal(result.avgSpendMax, 500000)
})

test("validateRecommendedCustomersInput rejects an unsupported priorityLabel", () => {
  assert.throws(
    () => validateRecommendedCustomersInput({ sessionName: "Morning", priorityLabel: "Urgent" }),
    /priorityLabel must be one of/
  )
})

test("validateRecommendedCustomersInput validates campaignDate format", () => {
  const valid = validateRecommendedCustomersInput({
    campaignDay: "Friday",
    campaignDate: "2026-11-20",
    sessionName: "Morning",
  })
  assert.equal(valid.campaignDate, "2026-11-20")

  assert.throws(
    () =>
      validateRecommendedCustomersInput({
        campaignDay: "Friday",
        campaignDate: "20-11-2026",
        sessionName: "Morning",
      }),
    /campaignDate must be in YYYY-MM-DD format/
  )
})

test("validateRecommendedCustomersInput rejects invalid sessionName", () => {
  assert.throws(
    () =>
      validateRecommendedCustomersInput({
        sessionName: "Late Night",
      }),
    /sessionName must be one of Morning, Afternoon, Evening, or Night/
  )
})

test("validateLowOccupancySessionInput rejects invalid date format", () => {
  assert.throws(
    () => validateLowOccupancySessionInput({ date: "07-10-2026" }),
    /date must be in YYYY-MM-DD format/
  )
})
