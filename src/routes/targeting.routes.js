import { Router } from "express"

import { prisma } from "../config/prisma.js"
import { authenticate, authorize } from "../middleware/auth.js"
import {
  getLowOccupancySessions,
  getRecommendedCustomers,
  getSlotAvailability,
} from "../services/lowOccupancyTargeting.service.js"
import {
  validateCampaignKpiInput,
  validateCampaignStatusInput,
  validateCreateOutreachCampaignInput,
  validateGenerateOutreachMessageInput,
  validateLowOccupancySessionInput,
  validateRecommendedCustomersInput,
  validateSlotAvailabilityInput,
  validateSuppressionInput,
  validateUpdateRecipientInput,
} from "../services/lowOccupancyTargetingValidation.service.js"
import {
  addSuppression,
  createOutreachCampaign,
  generateAutoDraftCampaigns,
  getCampaignKpiOverview,
  getOutreachCampaignDetail,
  listOutreachCampaigns,
  listSuppressions,
  removeSuppression,
  updateCampaignStatus,
  updateRecipientStatus,
} from "../services/outreachCampaign.service.js"
import { generateOutreachMessage, OUTREACH_MESSAGE_PLACEHOLDER } from "../services/aiProvider.service.js"
import { sendBulkCampaignMessages } from "../services/whatsappBusiness.service.js"
import { logActivity } from "../services/activityLog.service.js"
import { badRequest } from "../utils/http-error.js"

const parseRouteId = (value, fieldName) => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest(`${fieldName} must be a positive integer.`)
  }
  return parsed
}

export const targetingRouter = Router()

targetingRouter.use(authenticate)
targetingRouter.use(authorize("operational", "it_support"))

targetingRouter.get("/low-occupancy-sessions", async (req, res, next) => {
  try {
    const input = validateLowOccupancySessionInput(req.query || {})
    const sessions = await getLowOccupancySessions(input)

    res.json({
      success: true,
      data: {
        sessions,
      },
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.get("/recommended-customers", async (req, res, next) => {
  try {
    const input = validateRecommendedCustomersInput(req.query || {})
    const result = await getRecommendedCustomers(input)

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.post("/generate-message", async (req, res, next) => {
  try {
    const { customerName, ...signals } = validateGenerateOutreachMessageInput(req.body || {})
    const result = await generateOutreachMessage(signals)
    const message = result.message.split(OUTREACH_MESSAGE_PLACEHOLDER).join(customerName)

    const usage = result.usage || { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 }
    await prisma.aiUsageLog.create({
      data: {
        userId: req.user.userId,
        model: result.model,
        feature: "outreach_message_generation",
        promptTokens: Number(usage.promptTokens) || 0,
        candidatesTokens: Number(usage.candidatesTokens) || 0,
        totalTokens: Number(usage.totalTokens) || 0,
      },
    }).catch(() => null)

    res.json({
      success: true,
      data: {
        provider: result.provider,
        model: result.model,
        message,
      },
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.get("/slot-availability", async (req, res, next) => {
  try {
    const input = validateSlotAvailabilityInput(req.query || {})
    const slotAvailability = await getSlotAvailability(input)

    res.json({
      success: true,
      data: { slotAvailability },
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.post("/outreach-campaigns", async (req, res, next) => {
  try {
    const input = validateCreateOutreachCampaignInput(req.body || {})
    const campaign = await createOutreachCampaign({
      input,
      userId: req.user.userId,
    })

    res.status(201).json({
      success: true,
      data: campaign,
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.get("/outreach-campaigns", async (req, res, next) => {
  try {
    const campaigns = await listOutreachCampaigns()
    res.json({
      success: true,
      data: { campaigns },
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.get("/outreach-campaigns/:campaignId", async (req, res, next) => {
  try {
    const campaignId = parseRouteId(req.params.campaignId, "campaignId")
    const campaign = await getOutreachCampaignDetail({ campaignId })
    res.json({
      success: true,
      data: campaign,
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.patch("/outreach-campaigns/:campaignId/status", async (req, res, next) => {
  try {
    const campaignId = parseRouteId(req.params.campaignId, "campaignId")
    const { status, confirmConsent } = validateCampaignStatusInput(req.body || {})
    const campaign = await updateCampaignStatus({ campaignId, status, confirmConsent })
    res.json({
      success: true,
      data: { campaign },
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.post(
  "/outreach-campaigns/auto-draft/run",
  authorize("it_support"),
  async (req, res, next) => {
    try {
      const result = await generateAutoDraftCampaigns()
      await logActivity(req, "OUTREACH_AUTO_DRAFT_RUN", {
        createdCount: result.created.length,
        scannedDays: result.scannedDays,
      })
      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  }
)

targetingRouter.post("/outreach-campaigns/:campaignId/send", async (req, res, next) => {
  try {
    const campaignId = parseRouteId(req.params.campaignId, "campaignId")
    const result = await sendBulkCampaignMessages({ campaignId })
    await logActivity(req, "OUTREACH_WHATSAPP_SEND", {
      campaignId,
      attempted: result.attempted,
      sent: result.sent,
      failed: result.failed,
    })
    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.patch(
  "/outreach-campaigns/:campaignId/recipients/:recipientId",
  async (req, res, next) => {
    try {
      const campaignId = parseRouteId(req.params.campaignId, "campaignId")
      const recipientId = parseRouteId(req.params.recipientId, "recipientId")
      const { status } = validateUpdateRecipientInput(req.body || {})
      const recipient = await updateRecipientStatus({
        campaignId,
        recipientId,
        status,
        userId: req.user.userId,
      })
      res.json({
        success: true,
        data: { recipient },
      })
    } catch (error) {
      next(error)
    }
  }
)

targetingRouter.get("/outreach-suppressions", async (req, res, next) => {
  try {
    const suppressions = await listSuppressions()
    res.json({
      success: true,
      data: { suppressions },
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.post("/outreach-suppressions", async (req, res, next) => {
  try {
    const input = validateSuppressionInput(req.body || {})
    const suppression = await addSuppression({
      ...input,
      userId: req.user.userId,
    })
    res.status(201).json({
      success: true,
      data: { suppression },
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.delete("/outreach-suppressions/:customerKey", async (req, res, next) => {
  try {
    const customerKey = String(req.params.customerKey || "").trim()
    if (!customerKey) throw badRequest("customerKey is required.")
    const result = await removeSuppression(customerKey)
    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.get("/campaign-kpis", async (req, res, next) => {
  try {
    const input = validateCampaignKpiInput(req.query || {})
    const overview = await getCampaignKpiOverview(input)
    res.json({
      success: true,
      data: overview,
    })
  } catch (error) {
    next(error)
  }
})
