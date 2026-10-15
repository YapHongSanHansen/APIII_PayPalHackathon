import { randomId } from "@/lib/crypto";
import { q } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { verifyWebhook } from "@/lib/paypal";

// PayPal webhook receiver. Events are verified and logged; the ledger itself is
// driven by our own API calls, so webhooks are an audit trail, not the source of truth.
export const POST = handle(async (req: Request) => {
  const event: any = await req.json();
  const verified = await verifyWebhook(req.headers, event);
  if (verified === false) return json({ error: "invalid_signature" }, 400);
  await q(
    "INSERT INTO paypal_events (id, event_type, resource_id, verified, payload) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (id) DO NOTHING",
    [event.id || randomId("evt"), event.event_type || "unknown", event.resource?.id ?? null, verified, JSON.stringify(event)],
  );
  return json({ received: true, verified });
});
