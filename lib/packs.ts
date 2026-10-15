import { getApi, type ApiRow } from "./apis";
import { newToken, randomId, sha256 } from "./crypto";
import { one, q } from "./db";
import { ApiError } from "./http";
import {
  captureAuthorization,
  completeOrder,
  createPackOrder,
  refundCapture,
  voidAuthorization,
} from "./paypal";
import type { ApiPromise } from "./promise";
import { getWallet, releaseBudget, reserveBudget, walletByKey } from "./wallets";

export type PackMode = "direct" | "escrow";

export interface PackRow {
  id: string;
  api_id: string;
  wallet_id: string;
  token_hash: string;
  mode: PackMode;
  credits_total: number;
  credits_used: number;
  price_per_call_cents: number;
  amount_cents: number;
  promise_json: ApiPromise;
  promise_hash: string;
  paypal_order_id: string | null;
  paypal_auth_id: string | null;
  paypal_capture_id: string | null;
  approve_url: string | null;
  captured_cents: number;
  refunded_cents: number;
  status: string; // creating | pending_approval | active | closing | closed | cancelled | failed
  error: string | null;
  created_at: Date;
  closed_at: Date | null;
}

export function publicPack(p: PackRow, apiSlug?: string) {
  return {
    id: p.id,
    api: apiSlug,
    mode: p.mode,
    status: p.status,
    credits_total: p.credits_total,
    credits_used: p.credits_used,
    credits_left: p.credits_total - p.credits_used,
    price_per_call_cents: p.price_per_call_cents,
    amount_cents: p.amount_cents,
    captured_cents: p.captured_cents,
    refunded_cents: p.refunded_cents,
    promise_hash: p.promise_hash,
    paypal: {
      order_id: p.paypal_order_id,
      authorization_id: p.paypal_auth_id,
      capture_id: p.paypal_capture_id,
      approve_url: p.status === "pending_approval" ? p.approve_url : null,
    },
    error: p.error,
    created_at: p.created_at,
    closed_at: p.closed_at,
  };
}

async function slugOf(apiId: string): Promise<string | undefined> {
  return (await one<{ slug: string }>("SELECT slug FROM apis WHERE id = $1", [apiId]))?.slug;
}

export async function getPack(id: string): Promise<PackRow> {
  const p = await one<PackRow>("SELECT * FROM packs WHERE id = $1", [id]);
  if (!p) throw new ApiError(404, "pack_not_found", "Pack not found");
  return p;
}

export async function packByToken(token: string): Promise<PackRow | null> {
  return one<PackRow>("SELECT * FROM packs WHERE token_hash = $1", [sha256(token)]);
}

export async function packView(id: string) {
  const p = await getPack(id);
  return publicPack(p, await slugOf(p.api_id));
}

export async function listPacks(limit = 50) {
  const rows = await q<PackRow & { api_slug: string }>(
    "SELECT p.*, a.slug AS api_slug FROM packs p JOIN apis a ON a.id = p.api_id ORDER BY p.created_at DESC LIMIT $1",
    [limit],
  );
  return rows.map((r) => publicPack(r, r.api_slug));
}

/**
 * Agent buys a pack of calls with its wallet key. If the owner vaulted PayPal,
 * this completes with no human; otherwise it returns an approval link.
 */
export async function buyPack(input: { walletKey: string | null; slug: string; mode?: string; appUrl: string }) {
  const wallet = await walletByKey(input.walletKey);
  if (!wallet.active) throw new ApiError(403, "wallet_paused", "This wallet is paused by its owner");
  const mode: PackMode = input.mode === "direct" ? "direct" : "escrow";
  const api: ApiRow = await getApi(input.slug);
  if (api.status !== "live") throw new ApiError(503, "api_down", `${api.slug} is down and not selling packs right now`);
  if (api.price_per_call_cents > wallet.max_price_per_call_cents) {
    throw new ApiError(403, "price_above_wallet_max", `Price ${api.price_per_call_cents}¢/call exceeds the wallet max of ${wallet.max_price_per_call_cents}¢`);
  }
  const amount = api.price_per_call_cents * api.pack_size;
  if (!(await reserveBudget(wallet.id, amount))) {
    throw new ApiError(402, "budget_exceeded", `Pack costs ${amount}¢; wallet has ${wallet.budget_cents - wallet.spent_cents}¢ left this period`);
  }

  const id = randomId("pack");
  const { token, hash } = newToken("pk");
  await q(
    `INSERT INTO packs (id, api_id, wallet_id, token_hash, mode, credits_total, price_per_call_cents, amount_cents,
                        promise_json, promise_hash, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'creating')`,
    [id, api.id, wallet.id, hash, mode, api.pack_size, api.price_per_call_cents, amount, JSON.stringify(api.promise_json), api.promise_hash],
  );

  try {
    const order = await createPackOrder({
      packId: id,
      intent: mode === "escrow" ? "AUTHORIZE" : "CAPTURE",
      amountCents: amount,
      description: `APIII pack: ${api.pack_size} calls to ${api.name}`,
      vaultId: wallet.paypal_vault_id,
      returnUrl: `${input.appUrl}/api/packs/${id}/return`,
      cancelUrl: `${input.appUrl}/api/packs/${id}/cancel`,
    });
    await applyOrder(id, wallet.id, mode, amount, order);
  } catch (err) {
    await releaseBudget(wallet.id, amount);
    await q("UPDATE packs SET status = 'failed', error = $2 WHERE id = $1", [id, (err as Error).message]);
    throw new ApiError(502, "paypal_error", (err as Error).message, { pack_id: id });
  }

  const view = await packView(id);
  return {
    pack: view,
    pack_token: token, // shown once
    next:
      view.status === "active"
        ? `Call /v1/apis/${api.slug}/{path} with Authorization: Bearer <pack_token>`
        : `Owner must approve the payment: ${view.paypal.approve_url}`,
  };
}

async function applyOrder(
  packId: string,
  walletId: string,
  mode: PackMode,
  amount: number,
  order: { orderId: string; status: string; approveUrl?: string; authId?: string; captureId?: string; vaultId?: string },
) {
  const done = mode === "escrow" ? Boolean(order.authId) : Boolean(order.captureId);
  if (done) {
    await q(
      `UPDATE packs SET status = 'active', paypal_order_id = $2, paypal_auth_id = $3, paypal_capture_id = $4,
              captured_cents = $5, approve_url = NULL, error = NULL WHERE id = $1`,
      [packId, order.orderId, order.authId ?? null, order.captureId ?? null, mode === "direct" ? amount : 0],
    );
    // Fallback flow: PayPal vaulted the payment method during this first purchase.
    if (order.vaultId) {
      await q("UPDATE wallets SET paypal_vault_id = $2 WHERE id = $1 AND paypal_vault_id IS NULL", [walletId, order.vaultId]);
    }
  } else if (order.approveUrl) {
    await q("UPDATE packs SET status = 'pending_approval', paypal_order_id = $2, approve_url = $3 WHERE id = $1", [
      packId,
      order.orderId,
      order.approveUrl,
    ]);
  } else {
    throw new Error(`Unexpected PayPal order status ${order.status}`);
  }
}

/** PayPal redirected back after the owner approved a pack (no-vault fallback). */
export async function approvePack(packId: string) {
  const p = await getPack(packId);
  if (p.status !== "pending_approval") return packView(packId);
  try {
    const order = await completeOrder(p.paypal_order_id!, p.mode === "escrow" ? "AUTHORIZE" : "CAPTURE", p.id);
    await applyOrder(p.id, p.wallet_id, p.mode, p.amount_cents, order);
  } catch (err) {
    await releaseBudget(p.wallet_id, p.amount_cents);
    await q("UPDATE packs SET status = 'failed', error = $2 WHERE id = $1", [p.id, (err as Error).message]);
  }
  return packView(packId);
}

export async function cancelPack(packId: string) {
  const p = await one<PackRow>(
    "UPDATE packs SET status = 'cancelled', closed_at = now() WHERE id = $1 AND status IN ('creating','pending_approval') RETURNING *",
    [packId],
  );
  if (p) await releaseBudget(p.wallet_id, p.amount_cents);
  return packView(packId);
}

/** Atomically spend one credit. Called only after an answer passed the promise. */
export async function consumeCredit(packId: string): Promise<number | null> {
  const row = await one<{ left: number }>(
    `UPDATE packs SET credits_used = credits_used + 1
     WHERE id = $1 AND status = 'active' AND credits_used < credits_total
     RETURNING credits_total - credits_used AS left`,
    [packId],
  );
  return row ? row.left : null;
}

/**
 * Settle a pack. Escrow: capture good answers × price, release the rest of the hold.
 * Direct: refund the unused credits. Either way the agent pays only for good answers.
 */
export async function closePack(packId: string, auth: { walletKey?: string | null; packToken?: string | null }) {
  const p0 = await getPack(packId);
  const byPack = auth.packToken && sha256(auth.packToken) === p0.token_hash;
  if (!byPack) {
    const w = await walletByKey(auth.walletKey ?? null);
    if (w.id !== p0.wallet_id) throw new ApiError(403, "not_your_pack", "This pack belongs to another wallet");
  }
  const p = await one<PackRow>("UPDATE packs SET status = 'closing' WHERE id = $1 AND status = 'active' RETURNING *", [packId]);
  if (!p) throw new ApiError(409, "pack_not_active", `Pack is ${p0.status}, only active packs can be closed`);

  const good = p.credits_used; // credits are only spent on answers that passed
  const owed = good * p.price_per_call_cents;
  const settlement: Record<string, unknown> = { good_answers: good, owed_cents: owed, mode: p.mode };
  try {
    if (p.mode === "escrow") {
      if (owed > 0) {
        const cap = await captureAuthorization(p.paypal_auth_id!, owed, p.id);
        settlement.paypal = { action: "partial_capture_final", capture_id: cap.captureId, status: cap.status, released_cents: p.amount_cents - owed };
        await q("UPDATE packs SET paypal_capture_id = $2, captured_cents = $3 WHERE id = $1", [p.id, cap.captureId, owed]);
      } else {
        const v = await voidAuthorization(p.paypal_auth_id!, p.id);
        settlement.paypal = { action: "void", status: v.status, released_cents: p.amount_cents };
      }
    } else {
      const unused = p.amount_cents - owed;
      if (unused > 0 && p.paypal_capture_id) {
        const r = await refundCapture(p.paypal_capture_id, unused, p.id);
        settlement.paypal = { action: "refund_unused", refund_id: r.refundId, status: r.status, refunded_cents: unused };
        await q("UPDATE packs SET refunded_cents = $2 WHERE id = $1", [p.id, unused]);
      } else {
        settlement.paypal = { action: "none", note: "all credits used" };
      }
    }
  } catch (err) {
    await q("UPDATE packs SET status = 'active', error = $2 WHERE id = $1", [p.id, (err as Error).message]);
    throw new ApiError(502, "paypal_error", (err as Error).message);
  }

  await releaseBudget(p.wallet_id, p.amount_cents - owed);
  await q("UPDATE packs SET status = 'closed', closed_at = now(), error = NULL WHERE id = $1", [p.id]);
  const wallet = await getWallet(p.wallet_id);
  return { pack: await packView(p.id), settlement, wallet_spent_cents: wallet.spent_cents };
}
