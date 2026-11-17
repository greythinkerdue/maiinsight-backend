import { badRequest } from "../utils/http-error.js"

const MAX_PAGE_SIZE = 500
const DEFAULT_PAGE_SIZE = 50
const ALLOWED_RISK_LABELS = new Set(["High", "Medium", "Low"])
const ALLOWED_SORT_FIELDS = new Set(["customer", "probability", "riskLabel"])
const ALLOWED_SORT_DIRECTIONS = new Set(["asc", "desc"])

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== ""

const normalizePositiveInteger = (value, fallback, max) => {
  if (!hasValue(value)) return fallback

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw badRequest("limit and offset must be positive integers.")
  }

  return Math.min(Math.round(parsed), max ?? Math.round(parsed))
}

export const validateChurnRiskLatestInput = (input = {}) => {
  const riskLabel = hasValue(input.riskLabel) ? String(input.riskLabel).trim() : null
  if (riskLabel && !ALLOWED_RISK_LABELS.has(riskLabel)) {
    throw badRequest(`riskLabel must be one of: ${[...ALLOWED_RISK_LABELS].join(", ")}.`)
  }

  const sortBy = hasValue(input.sortBy) ? String(input.sortBy).trim() : null
  if (sortBy && !ALLOWED_SORT_FIELDS.has(sortBy)) {
    throw badRequest(`sortBy must be one of: ${[...ALLOWED_SORT_FIELDS].join(", ")}.`)
  }

  const sortDirection = hasValue(input.sortDirection) ? String(input.sortDirection).trim() : "desc"
  if (!ALLOWED_SORT_DIRECTIONS.has(sortDirection)) {
    throw badRequest("sortDirection must be asc or desc.")
  }

  const limit = normalizePositiveInteger(input.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const offset = hasValue(input.offset) ? Math.max(0, Math.round(Number(input.offset)) || 0) : 0

  return {
    riskLabel,
    search: hasValue(input.search) ? String(input.search).trim() : null,
    sortBy,
    sortDirection,
    limit,
    offset,
  }
}
