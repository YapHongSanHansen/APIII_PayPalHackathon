import { randomId } from "./crypto";
import { q } from "./db";
import { createPayout, paypalMode } from "./paypal";

export const PLATFORM_FEE_BPS = 300; // 3%

/**
 * Pays every seller what agents paid for good answers (captured − refunded on closed
 * packs), minus the 3% platform fee and minus what was already paid out.
 */
export async function runPayouts() {
  const sellers = await q<{ id: string; email: string; paypal_email: string | null; net_cents: number; paid_cents: number }>(
    `SELECT s.id, s.email, s.paypal_email,
            COALESCE((SELECT sum(p.captured_cents - p.refunded_cents) FROM packs p JOIN apis a ON a.id = p.api_id
                      WHERE a.seller_id = s.id AND p.status = 'closed'), 0)::int AS net_cents,
            COALESCE((SELECT sum(o.amount_cents + o.fee_cents) FROM payouts o
                      WHERE o.seller_id = s.id AND o.status <> 'failed'), 0)::int AS paid_cents
     FROM sellers s`,
  );

  const results = [];
  for (const s of sellers) {
    const due = s.net_cents - s.paid_cents;
    if (due <= 0) continue;
    const fee = Math.round((due * PLATFORM_FEE_BPS) / 10_000);
    const amount = due - fee;
    const id = randomId("po");
    try {
      if (amount < 1) throw new Error("amount below 1¢");
      const res = await createPayout({
        batchId: id,
        items: [{ email: s.paypal_email || s.email, amountCents: amount, note: "APIII earnings from AI agents", itemId: id }],
      });
      await q(
        "INSERT INTO payouts (id, seller_id, amount_cents, fee_cents, paypal_batch_id, status) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, s.id, amount, fee, res.payoutBatchId, res.status || "PENDING"],
      );
      results.push({ seller: s.email, amount_cents: amount, fee_cents: fee, paypal_batch_id: res.payoutBatchId, status: res.status });
    } catch (err) {
      await q(
        "INSERT INTO payouts (id, seller_id, amount_cents, fee_cents, status, error) VALUES ($1,$2,$3,$4,'failed',$5)",
        [id, s.id, amount, fee, (err as Error).message],
      );
      results.push({ seller: s.email, amount_cents: amount, fee_cents: fee, status: "failed", error: (err as Error).message });
    }
  }
  return { mode: paypalMode(), payouts: results };
}

export async function listPayouts() {
  return q(
    `SELECT o.*, s.email AS seller_email FROM payouts o JOIN sellers s ON s.id = o.seller_id
     ORDER BY o.created_at DESC LIMIT 50`,
  );
}
