import { env } from "../config/env.js"
import { prisma } from "../config/prisma.js"
import { buildConfigSnapshot } from "./appConfig.service.js"
import { normalizePhoneForWhatsapp } from "./outreachCampaign.service.js"
import { HttpError } from "../utils/http-error.js"

// WhatsApp Cloud API requires an approved message template for any
// business-initiated (marketing) message to a customer who hasn't messaged
// first in the last 24 hours — free-form text is rejected by Meta outside
// that window. The template itself is configured and approved on Meta's
// side; this file only supplies the parameters in the order the approved
// template expects. Until a real template exists, sends are not possible —
// getWhatsappStatus().configured tells callers whether to even try.

const COURT_TYPE_LABELS = {
  mini_soccer: "Mini Soccer",
  basketball: "Basketball",
  all: "lapangan tersedia",
}

const formatCampaignDateLabel = (campaignDate) => {
  if (!campaignDate) return "jadwal terdekat"
  const isoDate = campaignDate instanceof Date
    ? campaignDate.toISOString().slice(0, 10)
    : String(campaignDate).slice(0, 10)
  const date = new Date(`${isoDate}T00:00:00`)
  if (Number.isNaN(date.getTime())) return "jadwal terdekat"
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date)
}

export const getWhatsappStatus = async () => {
  const config = await buildConfigSnapshot()
  const configured = Boolean(
    config.whatsappAccessToken && config.whatsappPhoneNumberId && config.whatsappTemplateName
  )
  return {
    configured,
    enabled: config.whatsappEnabled,
    ready: configured && config.whatsappEnabled,
    phoneNumberId: config.whatsappPhoneNumberId || null,
    templateName: config.whatsappTemplateName || null,
    templateLanguage: config.whatsappTemplateLanguage || "id",
    graphVersion: config.whatsappGraphVersion || "v25.0",
    setupMessage: configured
      ? null
      : "WhatsApp Business API is not configured. Set the phone number ID, access token, and an approved template name in System Settings > Integrations.",
  }
}

/**
 * Builds the ordered parameter list for the approved template, in the
 * {{1}}..{{4}} convention this integration assumes: customer name, the
 * session+court being filled, the campaign date, and the promo code.
 */
export const buildTemplateParameters = ({ recipient, campaign }) => [
  recipient.customerName || "Kak",
  `${campaign.sessionName} ${COURT_TYPE_LABELS[campaign.courtType] || campaign.courtType}`,
  formatCampaignDateLabel(campaign.campaignDate),
  recipient.promoCode || "-",
]

const sendTemplateMessage = async ({ config, to, parameters, templateName, templateLanguage }) => {
  const baseUrl = (env.whatsappApiBaseUrl || "https://graph.facebook.com").replace(/\/$/, "")
  const url = `${baseUrl}/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/messages`

  // A template with no variables (e.g. Meta's default "hello_world") rejects
  // a body component with an empty parameters array — omit components
  // entirely rather than guessing a parameter count the caller didn't give.
  const components = parameters && parameters.length > 0
    ? [
        {
          type: "body",
          parameters: parameters.map((text) => ({ type: "text", text: String(text) })),
        },
      ]
    : undefined

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName || config.whatsappTemplateName,
        language: { code: templateLanguage || config.whatsappTemplateLanguage },
        ...(components ? { components } : {}),
      },
    }),
  })

  const result = await response.json().catch(() => null)
  if (!response.ok || result?.error) {
    return {
      success: false,
      error: result?.error?.message || `WhatsApp API returned status ${response.status}.`,
    }
  }

  return {
    success: true,
    messageId: result?.messages?.[0]?.id || null,
  }
}

/**
 * Sends one message to one number using whatever template is configured —
 * for verifying the phone number id / access token actually work before
 * trusting them with a real campaign. Accepts an optional parameter
 * override so a template that does take variables can still be tested.
 */
export const sendTestMessage = async ({ to, parameters = [], templateName, templateLanguage }) => {
  const status = await getWhatsappStatus()
  if (!status.configured) {
    throw new HttpError(400, status.setupMessage)
  }
  if (!status.enabled) {
    throw new HttpError(400, "WhatsApp Business API is disabled in System Settings > Integrations.")
  }

  const normalizedTo = normalizePhoneForWhatsapp(to)
  if (!normalizedTo) {
    throw new HttpError(400, "Enter a valid phone number, e.g. +628888575989.")
  }

  const config = await buildConfigSnapshot()
  const result = await sendTemplateMessage({
    config,
    to: normalizedTo,
    parameters,
    templateName,
    templateLanguage,
  })

  if (!result.success) {
    throw new HttpError(400, result.error)
  }

  return { to: normalizedTo, messageId: result.messageId }
}

/**
 * Sends the campaign's ready message to every pending, non-control,
 * non-suppressed recipient with a phone number. Stops at the first
 * configuration error, but keeps going past per-recipient send failures so
 * one bad number doesn't block the rest of the audience. Never sends to a
 * campaign that hasn't had consent confirmed — that gate belongs to
 * updateCampaignStatus, this function just trusts the campaign it's given.
 */
export const sendBulkCampaignMessages = async ({ campaignId, delayMs = 250 }) => {
  const status = await getWhatsappStatus()
  if (!status.ready) {
    throw new HttpError(
      400,
      status.enabled
        ? status.setupMessage
        : "WhatsApp Business API is disabled in System Settings > Integrations."
    )
  }

  const campaign = await prisma.outreachCampaign.findUnique({ where: { id: campaignId } })
  if (!campaign) throw new HttpError(404, "Outreach campaign not found.")
  if (!campaign.consentConfirmed) {
    throw new HttpError(400, "This campaign's consent has not been confirmed yet. Activate it first.")
  }

  const config = await buildConfigSnapshot()
  const recipients = await prisma.outreachRecipient.findMany({
    where: { campaignId, isControl: false, status: "pending" },
  })

  const result = { attempted: 0, sent: 0, failed: 0, skippedNoPhone: 0, errors: [] }

  for (const recipient of recipients) {
    const to = normalizePhoneForWhatsapp(recipient.phone)
    if (!to) {
      result.skippedNoPhone += 1
      continue
    }

    result.attempted += 1
    const parameters = buildTemplateParameters({ recipient, campaign })
    const sendResult = await sendTemplateMessage({ config, to, parameters })

    if (sendResult.success) {
      await prisma.outreachRecipient.update({
        where: { id: recipient.id },
        data: { status: "sent", sentAt: new Date() },
      })
      result.sent += 1
    } else {
      result.failed += 1
      result.errors.push({ customerKey: recipient.customerKey, error: sendResult.error })
    }

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  return result
}
