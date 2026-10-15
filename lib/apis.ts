import { buildOpenApi, draftListing, truncate, type ProbeResult } from "./ai";
import { randomId, seal } from "./crypto";
import { one, q } from "./db";
import { ApiError } from "./http";
import { hashPromise, normalizePromise, type ApiPromise } from "./promise";
import { assertSafeUrl } from "./ssrf";

export interface Sample {
  method: string;
  path: string;
}

export interface ApiRow {
  id: string;
  seller_id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  base_url: string;
  key_header: string | null;
  sealed_key: string | null;
  samples_json: Sample[];
  openapi_json: unknown;
  promise_json: ApiPromise;
  promise_hash: string;
  price_per_call_cents: number;
  pack_size: number;
  status: string;
  fail_streak: number;
  created_at: Date;
}

export const FAIL_STREAK_DOWN = 3;

export function upstreamUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

export async function probe(input: {
  baseUrl: string;
  samples: Sample[];
  keyHeader?: string;
  keyValue?: string;
}): Promise<ProbeResult[]> {
  await assertSafeUrl(input.baseUrl);
  if (!input.samples?.length) throw new ApiError(400, "no_samples", "Give at least one sample request");
  const results: ProbeResult[] = [];
  for (const s of input.samples.slice(0, 3)) {
    const method = (s.method || "GET").toUpperCase();
    const url = upstreamUrl(input.baseUrl, s.path);
    await assertSafeUrl(url);
    const headers: Record<string, string> = { accept: "application/json" };
    if (input.keyHeader && input.keyValue) headers[input.keyHeader] = input.keyValue;
    const started = Date.now();
    try {
      const res = await fetch(url, { method, headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      results.push({ method, path: s.path, status: res.status, latencyMs: Date.now() - started, ok: res.ok, body: truncate(body, 20_000) });
    } catch (err) {
      results.push({ method, path: s.path, status: 0, latencyMs: Date.now() - started, ok: false, body: null, error: (err as Error).message });
    }
  }
  return results;
}

/** Step 1 of "list in 3 minutes": probe the API, let AI draft listing + promise + price. */
export async function probeAndDraft(input: { baseUrl: string; samples: Sample[]; keyHeader?: string; keyValue?: string }) {
  const probes = await probe(input);
  const draft = await draftListing(input.baseUrl, probes);
  return { probes, draft, promiseHash: hashPromise(draft.promise) };
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "api";
}

export async function publishApi(input: {
  sellerEmail: string;
  paypalEmail?: string;
  paypalMerchantId?: string;
  name: string;
  slug?: string;
  description?: string;
  category?: string;
  baseUrl: string;
  keyHeader?: string;
  keyValue?: string;
  samples: Sample[];
  promise: unknown;
  pricePerCallCents: number;
  packSize?: number;
  probes?: ProbeResult[];
}) {
  if (!input.sellerEmail) throw new ApiError(400, "missing_field", "sellerEmail is required");
  if (!input.name) throw new ApiError(400, "missing_field", "name is required");
  await assertSafeUrl(input.baseUrl);
  const promise = normalizePromise(input.promise);
  const price = Math.round(Number(input.pricePerCallCents));
  if (!(price >= 1 && price <= 10_000)) throw new ApiError(400, "bad_price", "pricePerCallCents must be 1..10000");
  const packSize = Math.round(Number(input.packSize ?? 100));
  if (!(packSize >= 1 && packSize <= 10_000)) throw new ApiError(400, "bad_pack_size", "packSize must be 1..10000");

  let slug = slugify(input.slug || input.name);
  if (await one("SELECT 1 FROM apis WHERE slug = $1", [slug])) slug = `${slug}-${randomId("x").slice(2, 6)}`;

  const seller =
    (await one<{ id: string }>(
      `UPDATE sellers SET paypal_email = COALESCE($2, paypal_email), paypal_merchant_id = COALESCE($3, paypal_merchant_id)
       WHERE email = $1 RETURNING id`,
      [input.sellerEmail, input.paypalEmail || null, input.paypalMerchantId || null],
    )) ??
    (await one<{ id: string }>(
      "INSERT INTO sellers (id, email, paypal_email, paypal_merchant_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [randomId("sel"), input.sellerEmail, input.paypalEmail || input.sellerEmail, input.paypalMerchantId || null],
    ));

  const openapi = buildOpenApi(input.name, input.description ?? "", input.baseUrl, input.probes ?? input.samples.map((s) => ({ ...s, status: 200, latencyMs: 0, ok: true, body: null })), promise);

  const row = await one<ApiRow>(
    `INSERT INTO apis (id, seller_id, slug, name, description, category, base_url, key_header, sealed_key,
                       samples_json, openapi_json, promise_json, promise_hash, price_per_call_cents, pack_size)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15) RETURNING *`,
    [
      randomId("api"),
      seller!.id,
      slug,
      input.name,
      input.description ?? "",
      input.category ?? "",
      input.baseUrl,
      input.keyHeader && input.keyValue ? input.keyHeader : null,
      input.keyHeader && input.keyValue ? seal(input.keyValue) : null,
      JSON.stringify(input.samples.map((s) => ({ method: (s.method || "GET").toUpperCase(), path: s.path }))),
      JSON.stringify(openapi),
      JSON.stringify(promise),
      hashPromise(promise),
      price,
      packSize,
    ],
  );
  return publicListing(row!);
}

/** Listing as shown to agents. Never includes the sealed key. */
export function publicListing(api: ApiRow) {
  return {
    slug: api.slug,
    name: api.name,
    description: api.description,
    category: api.category,
    status: api.status,
    price_per_call_cents: api.price_per_call_cents,
    currency: "USD",
    pack: { calls: api.pack_size, total_cents: api.pack_size * api.price_per_call_cents },
    promise: { ...api.promise_json, hash: api.promise_hash },
    settlement: ["direct", "escrow"],
    endpoints: api.samples_json,
    call_url: `/v1/apis/${api.slug}/{path}`,
    openapi: api.openapi_json,
    created_at: api.created_at,
  };
}

export async function getApi(slug: string): Promise<ApiRow> {
  const api = await one<ApiRow>("SELECT * FROM apis WHERE slug = $1", [slug]);
  if (!api) throw new ApiError(404, "api_not_found", `No API with slug "${slug}"`);
  return api;
}

export async function searchApis(opts: { q?: string; maxPriceCents?: number }) {
  const rows = await q<ApiRow>(
    `SELECT * FROM apis
     WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%' OR category ILIKE '%' || $1 || '%')
       AND ($2::int IS NULL OR price_per_call_cents <= $2)
     ORDER BY (status = 'live') DESC, created_at DESC LIMIT 50`,
    [opts.q?.trim() || null, opts.maxPriceCents ?? null],
  );
  return rows.map(publicListing);
}

export async function resetApi(slug: string) {
  const api = await one<ApiRow>("UPDATE apis SET status = 'live', fail_streak = 0 WHERE slug = $1 RETURNING *", [slug]);
  if (!api) throw new ApiError(404, "api_not_found", `No API with slug "${slug}"`);
  return publicListing(api);
}
