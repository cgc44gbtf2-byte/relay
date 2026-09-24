import { Router } from "express";
import { recordDeliveryEvent } from "../lib/invitation-delivery";
import { parseDeliveryEvent, verifyResendSignature } from "../lib/invitation-webhook-signature";

const router = Router();
router.post("/", async (req, res) => {
  if (!process.env.RESEND_WEBHOOK_SECRET?.trim()) {
    res.status(503).json({ error: "Webhook signing is not configured." });
    return;
  }
  const body = req.body;
  if (!Buffer.isBuffer(body) || !verifyResendSignature(body, {
    id: req.get("svix-id"), timestamp: req.get("svix-timestamp"), signature: req.get("svix-signature"),
  }, process.env.RESEND_WEBHOOK_SECRET)) {
    res.status(401).json({ error: "Invalid webhook signature." });
    return;
  }
  let payload: unknown;
  try { payload = JSON.parse(body.toString("utf8")); }
  catch { res.status(400).json({ error: "Invalid webhook payload." }); return; }
  const event = parseDeliveryEvent(payload);
  if (event) await recordDeliveryEvent(event);
  res.status(200).json({ ok: true });
});
export default router;