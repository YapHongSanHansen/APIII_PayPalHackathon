import { FAIL_STREAK_DOWN, getApi, publicListing, upstreamUrl, type ApiRow } from "./apis";
import { sha256, unseal } from "./crypto";
import { q } from "./db";
import { consumeCredit, packByToken, type PackRow } from "./packs";
import { checkAnswer, type Verdict } from "./promise";
import { writeReceipt } from "./receipts";
import { assertSafeUrl } from "./ssrf";

export interface GatewayRequest {
  packToken: string | null;
  slug: string;
  method: string;
  path: string; // path below the API base, e.g. "deals"
  search: string; // "?q=airpods" or ""
  contentType: string | null;
  body: string | null;
}

export interface GatewayResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export function paymentRequired(api: ApiRow, reason: string): GatewayResponse {
  const listing = publicListing(api);
  return {
    status: 402,
    headers: {},
    body: {
      error: "payment_required",
      reason,
      api: api.slug,
      price_per_call_cents: api.price_per_call_cents,
      currency: "USD",
      pack: listing.pack,
      promise: { hash: api.promise_hash, url: `/v1/apis/${api.slug}` },
      settlement: ["direct", "escrow"],
      pay: {
        method: "paypal",
        buy_pack_url: "/v1/packs",
        request: { api: api.slug, mode: "escrow" },
        auth: "Authorization: Bearer <wallet key wk_…>",
      },
    },
  };
}

/**
 * The core of APIII: forward the call with the sealed key, grade the answer
 * against the promise, and charge one credit only when it passes.
 */
export async function handleCall(req: GatewayRequest): Promise<GatewayResponse> {
  const api = await getApi(req.slug);
  if (!req.packToken) return paymentRequired(api, "no pack token");

  const pack = await packByToken(req.packToken);
  if (!pack) return { status: 401, headers: {}, body: { error: "bad_pack_token", message: "Unknown pack token" } };
  if (pack.api_id !== api.id) return { status: 403, headers: {}, body: { error: "wrong_api", message: "This pack is for a different API" } };
  if (pack.status === "pending_approval") {
    const r = paymentRequired(api, "pack awaiting owner approval in PayPal");
    return { ...r, body: { ...(r.body as object), approve_url: pack.approve_url } };
  }
  if (pack.status !== "active") return paymentRequired(api, `pack is ${pack.status}`);
  if (pack.credits_used >= pack.credits_total) return paymentRequired(api, "pack has no credits left");

  const target = upstreamUrl(api.base_url, req.path) + (req.search || "");
  await assertSafeUrl(target);
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "APIII-Gateway/0.1" };
  if (req.contentType) headers["content-type"] = req.contentType;
  if (api.key_header && api.sealed_key) headers[api.key_header] = unseal(api.sealed_key); // never leaves the server

  const requestHash = sha256(`${req.method} /${req.path}${req.search}\n${req.body ?? ""}`);
  const started = Date.now();
  let upstreamStatus: number | null = null;
  let text = "";
  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body ?? undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    upstreamStatus = res.status;
    text = await res.text();
  } catch (err) {
    return fail(api, pack, req, requestHash, started, null, "", "down", `upstream unreachable: ${(err as Error).message}`);
  }
  if (upstreamStatus >= 500 || upstreamStatus === 429) {
    return fail(api, pack, req, requestHash, started, upstreamStatus, text, "down", `upstream returned ${upstreamStatus}`);
  }
  if (upstreamStatus >= 300) {
    return fail(api, pack, req, requestHash, started, upstreamStatus, text, "bad", `upstream returned ${upstreamStatus}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(api, pack, req, requestHash, started, upstreamStatus, text, "bad", "upstream answer is not JSON");
  }

  // Graded against the promise snapshot taken when the pack was bought.
  const check = checkAnswer(pack.promise_json, body);
  if (check.verdict !== "pass") {
    return fail(api, pack, req, requestHash, started, upstreamStatus, text, check.verdict, check.detail);
  }

  const left = await consumeCredit(pack.id);
  if (left === null) return paymentRequired(api, "pack has no credits left");
  await q("UPDATE apis SET fail_streak = 0, status = 'live' WHERE id = $1 AND (fail_streak > 0 OR status <> 'live')", [api.id]);
  const receiptId = await writeReceipt({
    packId: pack.id,
    apiId: api.id,
    method: req.method,
    path: `/${req.path}${req.search}`,
    requestHash,
    responseHash: sha256(text),
    verdict: "pass",
    httpStatus: 200,
    upstreamStatus,
    latencyMs: Date.now() - started,
    charged: true,
    detail: null,
  });
  return {
    status: 200,
    body,
    headers: { "x-apiii-verdict": "pass", "x-apiii-credits-left": String(left), "x-apiii-receipt-id": receiptId },
  };
}

async function fail(
  api: ApiRow,
  pack: PackRow,
  req: GatewayRequest,
  requestHash: string,
  started: number,
  upstreamStatus: number | null,
  text: string,
  verdict: Exclude<Verdict, "pass">,
  detail: string,
): Promise<GatewayResponse> {
  const status = verdict === "down" ? 503 : 422;
  // Repeated failures mark the API down so it stops selling new packs.
  await q(
    `UPDATE apis SET fail_streak = fail_streak + 1,
                     status = CASE WHEN fail_streak + 1 >= $2 THEN 'down' ELSE status END
     WHERE id = $1`,
    [api.id, FAIL_STREAK_DOWN],
  );
  const receiptId = await writeReceipt({
    packId: pack.id,
    apiId: api.id,
    method: req.method,
    path: `/${req.path}${req.search}`,
    requestHash,
    responseHash: sha256(text),
    verdict,
    httpStatus: status,
    upstreamStatus,
    latencyMs: Date.now() - started,
    charged: false,
    detail,
  });
  const left = pack.credits_total - pack.credits_used;
  return {
    status,
    headers: { "x-apiii-verdict": verdict, "x-apiii-credits-left": String(left), "x-apiii-receipt-id": receiptId },
    body: {
      error: verdict === "down" ? "upstream_unavailable" : "promise_broken",
      verdict,
      detail,
      charged: false,
      credits_left: left,
      receipt_id: receiptId,
    },
  };
}
