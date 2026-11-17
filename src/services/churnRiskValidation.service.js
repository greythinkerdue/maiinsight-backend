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

const normalizeIsoDate = (value, fieldName = "date") => {
  if (!hasValue(value)) return null

  const normalized = String(value).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw badRequest(`${fieldName} must be in YYYY-MM-DD format.`)
  }

  const parsedDate = new Date(`${normalized}T00:00:00`)
  if (Number.isNaN(parsedDate.getTime())) {
    throw badRequest(`${fieldName} must be a valid calendar date.`)
  }

  return normalized
}

const normalizeDecimal = (value, fieldName, { minimum = 0, maximum = null, fallback = null } = {}) => {
  if (!hasValue(value)) return fallback

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw badRequest(`${fieldName} must be a number greater than or equal to ${minimum}.`)
  }
  if (maximum !== null && parsed > maximum) {
    throw badRequest(`${fieldName} must be less than or equal to ${maximum}.`)
  }

  return parsed
}

const normalizePromoPrefix = (value) => {
  const normalized = String(value || "WINBACK")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 20)

  if (!normalized) throw badRequest("promoCodePrefix must contain letters or numbers.")
  return normalized
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

export const validateChurnReactivationCampaignInput = (input = {}) => {
  const consentConfirmed = input.consentConfirmed === true || String(input.consentConfirmed) === "true"
  if (!consentConfirmed) {
    throw badRequest(
      "consentConfirmed must be true: confirm these customers are existing customers who agreed to receive promotional messages."
    )
  }

  const riskLabel = hasValue(input.riskLabel) ? String(input.riskLabel).trim() : "High"
  if (!ALLOWED_RISK_LABELS.has(riskLabel)) {
    throw badRequest(`riskLabel must be one of: ${[...ALLOWED_RISK_LABELS].join(", ")}.`)
  }

  return {
    riskLabel,
    name: hasValue(input.name) ? String(input.name).trim().slice(0, 160) : null,
    campaignDate: normalizeIsoDate(input.campaignDate, "campaignDate"),
    promoCodePrefix: normalizePromoPrefix(input.promoCodePrefix),
    costBudget: normalizeDecimal(input.costBudget, "costBudget", {
      minimum: 0,
      maximum: 1_000_000_000_000,
      fallback: 0,
    }),
    controlPercent: normalizeDecimal(input.controlPercent, "controlPercent", {
      minimum: 0,
      maximum: 50,
      fallback: 10,
    }),
    consentConfirmed,
  }
}
