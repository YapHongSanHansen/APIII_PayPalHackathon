import crypto from "node:crypto";
import { centsToUsd } from "./http";

/**
 * PayPal REST client (sandbox). Without PAYPAL_CLIENT_ID/SECRET it runs in
 * "mock" mode: same flow and shapes, fake IDs, approval links that loop back to us.
 */
export function paypalMode(): "sandbox" | "mock" {
  return process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? "sandbox" : "mock";
}

const BASE = () => (process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com").replace(/\/$/, "");

export class PayPalError extends Error {
  constructor(public status: number, public body: any) {
    super(`PayPal ${status}: ${body?.name ?? ""} ${body?.message ?? ""} ${JSON.stringify(body?.details ?? "")}`.trim());
  }
}

let cachedToken: { value: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE()}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(res.status, body);
  cachedToken = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

async function pp(method: string, path: string, body?: unknown, requestId?: string): Promise<any> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${await accessToken()}`,
    "content-type": "application/json",
    prefer: "return=representation",
  };
  if (requestId) headers["paypal-request-id"] = requestId; // idempotency: retries never double-charge
  const res = await fetch(`${BASE()}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new PayPalError(res.status, data);
  return data;
}

const mockId = (kind: string) => `MOCK-${kind}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
const usd = (cents: number) => ({ currency_code: "USD", value: centsToUsd(cents) });

export interface OrderResult {
  orderId: string;
  status: string;
  approveUrl?: string;
  authId?: string;
  captureId?: string;
  vaultId?: string;
}

function readOrder(order: any): OrderResult {
  const payments = order.purchase_units?.[0]?.payments ?? {};
  return {
    orderId: order.id,
    status: order.status,
    approveUrl: order.links?.find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href,
    authId: payments.authorizations?.[0]?.id,
    captureId: payments.captures?.[0]?.id,
    vaultId: order.payment_source?.paypal?.attributes?.vault?.id,
  };
}

/**
 * Creates the order for a pack. With a vaultId the owner's saved PayPal is charged
 * with no human present (the agentic part). Without one, PayPal returns an approval
 * link and asks to vault the payment method on success (fallback flow).
 */
export async function createPackOrder(opts: {
  packId: string;
  intent: "CAPTURE" | "AUTHORIZE";
  amountCents: number;
  description: string;
  vaultId?: string | null;
  returnUrl: string;
  cancelUrl: string;
}): Promise<OrderResult> {
  if (paypalMode() === "mock") {
    const orderId = mockId("ORDER");
    if (opts.vaultId) {
      return opts.intent === "AUTHORIZE"
        ? { orderId, status: "COMPLETED", authId: mockId("AUTH") }
        : { orderId, status: "COMPLETED", captureId: mockId("CAPTURE") };
    }
    return { orderId, status: "PAYER_ACTION_REQUIRED", approveUrl: `${opts.returnUrl}?token=${orderId}&mock=1` };
  }

  const purchase_units = [
    {
      reference_id: opts.packId,
      custom_id: opts.packId,
      description: opts.description.slice(0, 127),
      amount: usd(opts.amountCents),
    },
  ];
  const experience_context = {
    return_url: opts.returnUrl,
    cancel_url: opts.cancelUrl,
    user_action: "PAY_NOW",
    shipping_preference: "NO_SHIPPING",
    brand_name: "APIII",
  };

  let order: any;
  if (opts.vaultId) {
    order = await pp(
      "POST",
      "/v2/checkout/orders",
      { intent: opts.intent, purchase_units, payment_source: { paypal: { vault_id: opts.vaultId } } },
      `${opts.packId}-create`,
    );
  } else {
    try {
      order = await pp(
        "POST",
        "/v2/checkout/orders",
        {
          intent: opts.intent,
          purchase_units,
          payment_source: {
            paypal: {
              experience_context,
              attributes: { vault: { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT" } },
            },
          },
        },
        `${opts.packId}-create`,
      );
    } catch (err) {
      // App may not have Vault enabled; retry as a plain approval checkout.
      if (!(err instanceof PayPalError) || err.status >= 500) throw err;
      order = await pp(
        "POST",
        "/v2/checkout/orders",
        { intent: opts.intent, purchase_units, payment_source: { paypal: { experience_context } } },
        `${opts.packId}-create-novault`,
      );
    }
  }

  const result = readOrder(order);
  if (result.status === "APPROVED") return completeOrder(result.orderId, opts.intent, opts.packId);
  return result;
}

/** After the buyer approves: authorize (escrow) or capture (direct) the order. */
export async function completeOrder(orderId: string, intent: "CAPTURE" | "AUTHORIZE", packId: string): Promise<OrderResult> {
  if (paypalMode() === "mock") {
    return intent === "AUTHORIZE"
      ? { orderId, status: "COMPLETED", authId: mockId("AUTH"), vaultId: mockId("VAULT") }
      : { orderId, status: "COMPLETED", captureId: mockId("CAPTURE"), vaultId: mockId("VAULT") };
  }
  const path = intent === "AUTHORIZE" ? "authorize" : "capture";
  return readOrder(await pp("POST", `/v2/checkout/orders/${orderId}/${path}`, {}, `${packId}-${path}`));
}

/** Escrow settlement: capture only what was delivered and release the rest of the hold. */
export async function captureAuthorization(authId: string, amountCents: number, packId: string) {
  if (paypalMode() === "mock") return { captureId: mockId("CAPTURE"), status: "COMPLETED" };
  const res = await pp(
    "POST",
    `/v2/payments/authorizations/${authId}/capture`,
    { amount: usd(amountCents), final_capture: true, invoice_id: packId },
    `${packId}-settle`,
  );
  return { captureId: res.id as string, status: res.status as string };
}

export async function voidAuthorization(authId: string, packId: string) {
  if (paypalMode() === "mock") return { status: "VOIDED" };
  await pp("POST", `/v2/payments/authorizations/${authId}/void`, undefined, `${packId}-void`);
  return { status: "VOIDED" };
}

export async function refundCapture(captureId: string, amountCents: number, packId: string) {
  if (paypalMode() === "mock") return { refundId: mockId("REFUND"), status: "COMPLETED" };
  const res = await pp(
    "POST",
    `/v2/payments/captures/${captureId}/refund`,
    { amount: usd(amountCents), note_to_payer: "APIII: unused or failed calls refunded" },
    `${packId}-refund`,
  );
  return { refundId: res.id as string, status: res.status as string };
}

// ---- Vault v3: owner saves PayPal once so their agent can pay unattended ----

export async function createVaultSetupToken(opts: { walletId: string; returnUrl: string; cancelUrl: string }) {
  if (paypalMode() === "mock") {
    const id = mockId("SETUP");
    return { setupTokenId: id, approveUrl: `${opts.returnUrl}?approval_token_id=${id}&mock=1` };
  }
  const res = await pp(
    "POST",
    "/v3/vault/setup-tokens",
    {
      payment_source: {
        paypal: {
          usage_type: "MERCHANT",
          description: "APIII agent wallet: lets your AI agent buy API call packs within your budget",
          experience_context: {
            brand_name: "APIII",
            return_url: opts.returnUrl,
            cancel_url: opts.cancelUrl,
            shipping_preference: "NO_SHIPPING",
          },
        },
      },
    },
    `${opts.walletId}-setup-${Date.now()}`,
  );
  return {
    setupTokenId: res.id as string,
    approveUrl: res.links?.find((l: any) => l.rel === "approve")?.href as string | undefined,
  };
}

export async function createVaultPaymentToken(setupTokenId: string) {
  if (paypalMode() === "mock") return { vaultId: mockId("VAULT") };
  const res = await pp(
    "POST",
    "/v3/vault/payment-tokens",
    { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
    `${setupTokenId}-exchange`,
  );
  return { vaultId: res.id as string };
}

// ---- Payouts: pay sellers ----

export async function createPayout(opts: {
  batchId: string;
  items: { email: string; amountCents: number; note: string; itemId: string }[];
}) {
  if (paypalMode() === "mock") return { payoutBatchId: mockId("PAYOUT"), status: "SUCCESS" };
  const res = await pp("POST", "/v1/payments/payouts", {
    sender_batch_header: {
      sender_batch_id: opts.batchId,
      email_subject: "You have APIII earnings",
      email_message: "Your API earned money from AI agents on APIII.",
    },
    items: opts.items.map((i) => ({
      recipient_type: "EMAIL",
      receiver: i.email,
      amount: { value: centsToUsd(i.amountCents), currency: "USD" },
      note: i.note,
      sender_item_id: i.itemId,
    })),
  });
  return { payoutBatchId: res.batch_header?.payout_batch_id as string, status: res.batch_header?.batch_status as string };
}

// ---- Webhooks ----

/** true/false when PAYPAL_WEBHOOK_ID is configured, null when verification isn't possible. */
export async function verifyWebhook(headers: Headers, event: unknown): Promise<boolean | null> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId || paypalMode() === "mock") return null;
  const res = await pp("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: event,
  });
  return res.verification_status === "SUCCESS";
}
