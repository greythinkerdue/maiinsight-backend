import cron from "node-cron"

import { env } from "./env.js"
import { prisma } from "./prisma.js"
import { runHealthReminder } from "../services/healthReminder.service.js"
import { extractCampaignAttributions } from "../services/campaignAttribution.service.js"
import { generateAutoDraftCampaigns } from "../services/outreachCampaign.service.js"
import { createNotificationsForRoles } from "../services/notification.service.js"

export const startReminderScheduler = () => {
  if (!env.healthReminderEnabled) {
    return null
  }

  if (!cron.validate(env.healthReminderCron)) {
    console.warn("[reminder] Invalid HEALTH_REMINDER_CRON, scheduler disabled.", {
      cron: env.healthReminderCron,
    })
    return null
  }

  const task = cron.schedule(
    env.healthReminderCron,
    async () => {
      try {
        const result = await runHealthReminder()
        console.log("[reminder] Automated health reminder run completed.", result)
      } catch (error) {
        console.error("[reminder] Automated health reminder run failed.", error)
      }
    },
    { timezone: "Asia/Jakarta" },
  )

  console.log(`[reminder] Scheduler started (${env.healthReminderCron}, Asia/Jakarta).`)
  return task
}


export const startCampaignAttributionScheduler = () => {
  if (!env.campaignAttributionEnabled) return null
  if (!cron.validate(env.campaignAttributionCron)) {
    console.warn("[campaign-attribution] Invalid CAMPAIGN_ATTRIBUTION_CRON, scheduler disabled.", { cron: env.campaignAttributionCron })
    return null
  }
  const task = cron.schedule(env.campaignAttributionCron, async () => {
    try {
      const result = await extractCampaignAttributions()
      console.log("[campaign-attribution] Extraction completed.", result)
    } catch (error) {
      console.error("[campaign-attribution] Extraction failed.", error)
    }
  }, { timezone: "Asia/Jakarta" })
  console.log("[campaign-attribution] Scheduler started (" + env.campaignAttributionCron + ", Asia/Jakarta).")
  return task
}

export const startAutoDraftCampaignScheduler = () => {
  if (!env.autoDraftCampaignEnabled) return null
  if (!cron.validate(env.autoDraftCampaignCron)) {
    console.warn("[auto-draft-campaign] Invalid AUTO_DRAFT_CAMPAIGN_CRON, scheduler disabled.", {
      cron: env.autoDraftCampaignCron,
    })
    return null
  }
  const task = cron.schedule(env.autoDraftCampaignCron, async () => {
    try {
      const result = await generateAutoDraftCampaigns()
      console.log("[auto-draft-campaign] Weekly scan completed.", {
        created: result.created.length,
        scannedDays: result.scannedDays,
      })
      if (result.created.length > 0) {
        await createNotificationsForRoles(prisma, ["operational", "management", "it_support"], {
          title: "New draft campaigns ready for review",
          message: `${result.created.length} low-occupancy slot(s) next week got a draft outreach campaign. Review and confirm consent before sending.`,
        })
      }
    } catch (error) {
      console.error("[auto-draft-campaign] Weekly scan failed.", error)
    }
  }, { timezone: "Asia/Jakarta" })
  console.log("[auto-draft-campaign] Scheduler started (" + env.autoDraftCampaignCron + ", Asia/Jakarta).")
  return task
}
