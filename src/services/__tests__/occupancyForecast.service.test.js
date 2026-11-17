import test from "node:test"
import assert from "node:assert/strict"

import { chooseSmoothingParams, forecastNextValue } from "../occupancyForecast.service.js"

const series = (values) => values.map((occupancyRate) => ({ occupancyRate }))

test("forecastNextValue reports unavailable below the minimum series length", () => {
  const result = forecastNextValue(series([10, 20, 30]))
  assert.equal(result.available, false)
  assert.equal(result.forecastOccupancyRate, null)
  assert.match(result.reason, /Fewer than 4 historical weeks/)
})

test("forecastNextValue holds a flat series flat with a tight band", () => {
  const result = forecastNextValue(series([50, 50, 50, 50, 50]))
  assert.equal(result.available, true)
  assert.equal(result.forecastOccupancyRate, 50)
  assert.equal(result.trendPerWeek, 0)
  assert.equal(result.confidenceBandLow, 50)
  assert.equal(result.confidenceBandHigh, 50)
})

test("forecastNextValue continues a clean linear trend", () => {
  const result = forecastNextValue(series([40, 45, 50, 55, 60, 65, 70, 75]))
  assert.equal(result.available, true)
  assert.equal(result.forecastOccupancyRate, 80)
  assert.equal(result.trendPerWeek, 5)
  assert.ok(result.confidenceBandLow <= 80 && result.confidenceBandHigh >= 80)
})

test("forecastNextValue clips the forecast and band to [0, 100]", () => {
  const result = forecastNextValue(series([95, 97, 99, 100, 100, 100]))
  assert.ok(result.forecastOccupancyRate <= 100)
  assert.ok(result.confidenceBandHigh <= 100)
})

test("chooseSmoothingParams falls back to fixed defaults for short series", () => {
  const params = chooseSmoothingParams([10, 20, 30, 40, 50])
  assert.deepEqual(params, { alpha: 0.4, beta: 0.2, method: "default" })
})

test("chooseSmoothingParams grid-searches once enough points exist", () => {
  const params = chooseSmoothingParams([40, 45, 50, 55, 60, 65, 70, 75])
  assert.equal(params.method, "walk_forward_grid_search")
  assert.ok([0.2, 0.4, 0.6].includes(params.alpha))
  assert.ok([0.1, 0.2, 0.3].includes(params.beta))
})
