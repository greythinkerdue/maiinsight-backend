import { Router } from "express"

import { env } from "../config/env.js"

export const whatsappWebhookRouter = Router()

// Meta's one-time GET handshake to verify we control this endpoint before
// it will start sending events to it.
whatsappWebhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"]
  const token = req.query["hub.verify_token"]
  const challenge = req.query["hub.challenge"]

  if (mode === "subscribe" && env.whatsappWebhookVerifyToken && token === env.whatsappWebhookVerifyToken) {
    return res.status(200).send(challenge)
  }

  return res.sendStatus(403)
})

/**
 * Delivery/read status updates and inbound replies land here. Meta expects a
 * fast 200 regardless of what we do with the payload, so this only logs for
 * now rather than blocking on a database write. Persisting delivery status
 * and replies against a recipient (to actually close the "response rate"
 * gap) needs a schema addition once a real WhatsApp Business Account is
 * connected and this payload shape can be verified against real events.
 */
whatsappWebhookRouter.post("/", (req, res) => {
  const changes = req.body?.entry?.flatMap((entry) => entry.changes || []) || []

  for (const change of changes) {
    const value = change.value || {}
    for (const status of value.statuses || []) {
      console.log("[whatsapp-webhook] message status", {
        messageId: status.id,
        recipientId: status.recipient_id,
        status: status.status,
        timestamp: status.timestamp,
      })
    }
    for (const message of value.messages || []) {
      console.log("[whatsapp-webhook] inbound reply", {
        from: message.from,
        type: message.type,
        timestamp: message.timestamp,
      })
    }
  }

  res.sendStatus(200)
})
