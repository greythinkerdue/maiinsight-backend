import { Router } from "express"
import { logActivity } from "../services/activityLog.service.js"

import { authenticate, authorize } from "../middleware/auth.js"
import { getLatestChurnRiskResult, runChurnModelTraining } from "../services/churnRisk.service.js"
import {
  validateChurnReactivationCampaignInput,
  validateChurnRiskLatestInput,
} from "../services/churnRiskValidation.service.js"
import { createChurnReactivationCampaign } from "../services/outreachCampaign.service.js"

export const churnRiskRouter = Router()

churnRiskRouter.use(authenticate)

churnRiskRouter.post(
  "/train",
  authorize("management", "it_support"),
  async (req, res, next) => {
    try {
      const run = await runChurnModelTraining({ performedByUserId: req.user.userId })

      await logActivity(req, "CHURN_MODEL_TRAINED", {
        jobName: "Churn Risk Model Training",
        status: run.status,
        trainSize: run.trainSize,
        testSize: run.testSize,
        aucTest: run.aucTest,
        completedAt: new Date().toISOString(),
      })

      res.status(201).json({
        success: true,
        message: "Churn risk model training completed",
        data: { run },
      })
    } catch (error) {
      await logActivity(req, "CHURN_MODEL_TRAINING_FAILED", {
        jobName: "Churn Risk Model Training",
        status: "failed",
        technicalMessage: error instanceof Error ? error.message : "Churn model training failed.",
        completedAt: new Date().toISOString(),
      }).catch(() => null)

      next(error)
    }
  }
)

churnRiskRouter.get(
  "/latest",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const input = validateChurnRiskLatestInput(req.query || {})
      const result = await getLatestChurnRiskResult(input)

      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  }
)

churnRiskRouter.post(
  "/reactivation-campaign",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const input = validateChurnReactivationCampaignInput(req.body || {})
      const campaign = await createChurnReactivationCampaign({ input, userId: req.user.userId })

      await logActivity(req, "CHURN_REACTIVATION_CAMPAIGN_CREATED", {
        jobName: "Churn Reactivation Campaign",
        riskLabel: input.riskLabel,
        recipientCount: campaign.campaign?.recipientCount || 0,
      })

      res.status(201).json({
        success: true,
        message: "Reactivation campaign created",
        data: campaign,
      })
    } catch (error) {
      next(error)
    }
  }
)
