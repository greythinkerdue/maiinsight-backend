// From-scratch occupancy forecasting: Holt's linear-trend (double
// exponential smoothing) over a weekly occupancy-rate series for one
// day-of-week + session + court-type combination. Kept as pure functions
// (no Prisma) so the math is independently unit-testable; the raw series
// comes from lowOccupancyTargeting.service.js's getWeeklyOccupancySeries.

const roundNumber = (value, precision = 1) => Number(Number(value || 0).toFixed(precision))

const MIN_SERIES_LENGTH = 4
const MIN_GRID_SEARCH_LENGTH = 6
const ALPHA_CANDIDATES = [0.2, 0.4, 0.6]
const BETA_CANDIDATES = [0.1, 0.2, 0.3]
const DEFAULT_ALPHA = 0.4
const DEFAULT_BETA = 0.2
// ~80% one-step-ahead interval around the point forecast.
const CONFIDENCE_Z = 1.28

/**
 * Replays a Holt's linear-trend smoother across `values` with fixed
 * alpha/beta, scoring every step's one-step-ahead forecast against what the
 * series actually did next. Returns the final level/trend (for forecasting)
 * and the in-sample squared-error sum (for choosing alpha/beta and for the
 * forecast's uncertainty band).
 */
const simulateHoltWalkForward = (values, alpha, beta) => {
  let level = values[0]
  let trend = values[1] - values[0]
  let sumSquaredError = 0
  let scored = 0

  for (let index = 1; index < values.length; index += 1) {
    const forecast = level + trend
    if (index >= 2) {
      const error = values[index] - forecast
      sumSquaredError += error * error
      scored += 1
    }

    const observed = values[index]
    const nextLevel = alpha * observed + (1 - alpha) * (level + trend)
    const nextTrend = beta * (nextLevel - level) + (1 - beta) * trend
    level = nextLevel
    trend = nextTrend
  }

  return { level, trend, sumSquaredError, scored }
}

/**
 * Small grid search over alpha/beta, minimizing one-step-ahead in-sample
 * mean squared error (a walk-forward validation, not a single global fit).
 * Falls back to fixed defaults when the series is too short for the search
 * itself to be meaningful.
 */
export const chooseSmoothingParams = (values) => {
  if (values.length < MIN_GRID_SEARCH_LENGTH) {
    return { alpha: DEFAULT_ALPHA, beta: DEFAULT_BETA, method: "default" }
  }

  let best = null
  for (const alpha of ALPHA_CANDIDATES) {
    for (const beta of BETA_CANDIDATES) {
      const { sumSquaredError, scored } = simulateHoltWalkForward(values, alpha, beta)
      if (!scored) continue
      const meanSquaredError = sumSquaredError / scored
      if (!best || meanSquaredError < best.meanSquaredError) {
        best = { alpha, beta, meanSquaredError }
      }
    }
  }

  return best
    ? { alpha: best.alpha, beta: best.beta, method: "walk_forward_grid_search" }
    : { alpha: DEFAULT_ALPHA, beta: DEFAULT_BETA, method: "default" }
}

/**
 * Forecasts next week's occupancy rate for a chronological series of
 * `{ occupancyRate }` points (one per historical occurrence of the same
 * weekday+session+court combination, oldest first).
 */
export const forecastNextValue = (series) => {
  const values = (series || [])
    .map((point) => point.occupancyRate)
    .filter((value) => Number.isFinite(value))

  if (values.length < MIN_SERIES_LENGTH) {
    return {
      available: false,
      forecastOccupancyRate: null,
      trendPerWeek: null,
      confidenceBandLow: null,
      confidenceBandHigh: null,
      historicalWeeks: values.length,
      method: null,
      reason: `Fewer than ${MIN_SERIES_LENGTH} historical weeks are available for this day, session, and court combination.`,
    }
  }

  const { alpha, beta, method } = chooseSmoothingParams(values)
  const { level, trend, sumSquaredError, scored } = simulateHoltWalkForward(values, alpha, beta)

  const forecast = level + trend
  const residualStd = scored > 0 ? Math.sqrt(sumSquaredError / scored) : 0
  const margin = CONFIDENCE_Z * residualStd
  const clip = (value) => Math.min(100, Math.max(0, value))

  return {
    available: true,
    forecastOccupancyRate: roundNumber(clip(forecast)),
    trendPerWeek: roundNumber(trend, 2),
    confidenceBandLow: roundNumber(clip(forecast - margin)),
    confidenceBandHigh: roundNumber(clip(forecast + margin)),
    historicalWeeks: values.length,
    method: `holt_linear_trend(alpha=${alpha},beta=${beta},params=${method})`,
  }
}
