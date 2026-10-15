import { newToken, randomId, sha256 } from "./crypto";
import { one, q } from "./db";
import { ApiError } from "./http";
import { createVaultPaymentToken, createVaultSetupToken } from "./paypal";

export interface WalletRow {
  id: string;
  owner_email: string;
  key_hash: string;
  paypal_vault_id: string | null;
  vault_setup_token: string | null;
  budget_cents: number;
  budget_period_days: number;
  spent_cents: number;
  period_start: Date;
  max_price_per_call_cents: number;
  active: boolean;
  created_at: Date;
}

export function publicWallet(w: WalletRow) {
  return {
    id: w.id,
    owner_email: w.owner_email,
    paypal_connected: Boolean(w.paypal_vault_id),
    paypal_vault_id: w.paypal_vault_id,
    budget_cents: w.budget_cents,
    budget_period_days: w.budget_period_days,
    spent_cents: w.spent_cents,
    remaining_cents: Math.max(0, w.budget_cents - w.spent_cents),
    period_start: w.period_start,
    max_price_per_call_cents: w.max_price_per_call_cents,
    active: w.active,
  };
}

export async function createWallet(input: {
  ownerEmail: string;
  budgetCents: number;
  budgetPeriodDays?: number;
  maxPricePerCallCents?: number;
}) {
  if (!input.ownerEmail) throw new ApiError(400, "missing_field", "ownerEmail is required");
  const budget = Math.round(Number(input.budgetCents));
  if (!(budget >= 100 && budget <= 1_000_000)) throw new ApiError(400, "bad_budget", "budgetCents must be 100..1000000");
  const { token, hash } = newToken("wk");
  const row = await one<WalletRow>(
    `INSERT INTO wallets (id, owner_email, key_hash, budget_cents, budget_period_days, max_price_per_call_cents)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      randomId("wal"),
      input.ownerEmail,
      hash,
      budget,
      Math.round(Number(input.budgetPeriodDays ?? 7)),
      Math.round(Number(input.maxPricePerCallCents ?? 10)),
    ],
  );
  // The wallet key is shown exactly once; only its hash is stored.
  return { wallet: publicWallet(row!), walletKey: token };
}

export async function getWallet(id: string): Promise<WalletRow> {
  const w = await one<WalletRow>("SELECT * FROM wallets WHERE id = $1", [id]);
  if (!w) throw new ApiError(404, "wallet_not_found", "Wallet not found");
  return w;
}

export async function walletByKey(key: string | null): Promise<WalletRow> {
  if (!key || !key.startsWith("wk_")) throw new ApiError(401, "wallet_key_required", "Send Authorization: Bearer <wallet key wk_…>");
  const w = await one<WalletRow>("SELECT * FROM wallets WHERE key_hash = $1", [sha256(key)]);
  if (!w) throw new ApiError(401, "bad_wallet_key", "Unknown wallet key");
  return w;
}

export async function listWallets() {
  return (await q<WalletRow>("SELECT * FROM wallets ORDER BY created_at DESC LIMIT 50")).map(publicWallet);
}

/** Owner step: start PayPal Vault (save PayPal once, no purchase). */
export async function startVault(walletId: string, appUrl: string) {
  await getWallet(walletId);
  const { setupTokenId, approveUrl } = await createVaultSetupToken({
    walletId,
    returnUrl: `${appUrl}/api/wallets/${walletId}/vault/return`,
    cancelUrl: `${appUrl}/?vault=cancelled`,
  });
  await q("UPDATE wallets SET vault_setup_token = $2 WHERE id = $1", [walletId, setupTokenId]);
  return { setupTokenId, approveUrl };
}

/** PayPal redirected back after approval: exchange the setup token for a reusable vault ID. */
export async function completeVault(walletId: string, setupTokenId?: string | null) {
  const w = await getWallet(walletId);
  const token = setupTokenId || w.vault_setup_token;
  if (!token) throw new ApiError(400, "no_setup_token", "No vault setup in progress for this wallet");
  const { vaultId } = await createVaultPaymentToken(token);
  const row = await one<WalletRow>(
    "UPDATE wallets SET paypal_vault_id = $2, vault_setup_token = NULL WHERE id = $1 RETURNING *",
    [walletId, vaultId],
  );
  return publicWallet(row!);
}

export async function setWalletActive(walletId: string, active: boolean) {
  const row = await one<WalletRow>("UPDATE wallets SET active = $2 WHERE id = $1 RETURNING *", [walletId, active]);
  if (!row) throw new ApiError(404, "wallet_not_found", "Wallet not found");
  return publicWallet(row);
}

/** Atomically reserve budget for a pack. Returns false if it would exceed the budget. */
export async function reserveBudget(walletId: string, cents: number): Promise<boolean> {
  await q(
    `UPDATE wallets SET spent_cents = 0, period_start = now()
     WHERE id = $1 AND period_start + make_interval(days => budget_period_days) < now()`,
    [walletId],
  );
  const row = await one(
    "UPDATE wallets SET spent_cents = spent_cents + $2 WHERE id = $1 AND active AND spent_cents + $2 <= budget_cents RETURNING id",
    [walletId, cents],
  );
  return Boolean(row);
}

export async function releaseBudget(walletId: string, cents: number) {
  if (cents > 0) await q("UPDATE wallets SET spent_cents = GREATEST(spent_cents - $2, 0) WHERE id = $1", [walletId, cents]);
}
