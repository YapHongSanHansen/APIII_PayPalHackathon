import { randomId, signReceipt } from "./crypto";
import { one, q } from "./db";
import type { Verdict } from "./promise";

export interface ReceiptInput {
  packId: string | null;
  apiId: string;
  method: string;
  path: string;
  requestHash: string;
  responseHash: string;
  verdict: Verdict;
  httpStatus: number;
  upstreamStatus: number | null;
  latencyMs: number;
  charged: boolean;
  detail: string | null;
}

/** Exactly the fields that are signed. Anyone can re-verify with /v1/receipts/public-key. */
export function receiptPayload(r: {
  id: string;
  pack_id: string | null;
  api_id: string;
  ts: Date | string;
  method: string;
  path: string;
  request_hash: string;
  response_hash: string;
  verdict: string;
  http_status: number;
  charged: boolean;
}) {
  return {
    id: r.id,
    pack_id: r.pack_id,
    api_id: r.api_id,
    ts: new Date(r.ts).toISOString(),
    method: r.method,
    path: r.path,
    request_hash: r.request_hash,
    response_hash: r.response_hash,
    verdict: r.verdict,
    http_status: r.http_status,
    charged: r.charged,
  };
}

export async function writeReceipt(r: ReceiptInput): Promise<string> {
  const row = {
    id: randomId("rcpt"),
    pack_id: r.packId,
    api_id: r.apiId,
    ts: new Date().toISOString(),
    method: r.method,
    path: r.path,
    request_hash: r.requestHash,
    response_hash: r.responseHash,
    verdict: r.verdict,
    http_status: r.httpStatus,
    charged: r.charged,
  };
  const signature = signReceipt(receiptPayload(row));
  await q(
    `INSERT INTO receipts (id, pack_id, api_id, ts, method, path, request_hash, response_hash, verdict,
                           http_status, upstream_status, latency_ms, charged, detail, signature)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      row.id,
      row.pack_id,
      row.api_id,
      row.ts,
      row.method,
      row.path,
      row.request_hash,
      row.response_hash,
      row.verdict,
      row.http_status,
      r.upstreamStatus,
      r.latencyMs,
      row.charged,
      r.detail,
      signature,
    ],
  );
  return row.id;
}

export async function listReceipts(opts: { packId?: string | null; apiSlug?: string | null; limit?: number }) {
  const rows = await q(
    `SELECT r.*, a.slug AS api_slug FROM receipts r JOIN apis a ON a.id = r.api_id
     WHERE ($1::text IS NULL OR r.pack_id = $1) AND ($2::text IS NULL OR a.slug = $2)
     ORDER BY r.ts DESC LIMIT $3`,
    [opts.packId || null, opts.apiSlug || null, Math.min(opts.limit ?? 100, 500)],
  );
  return rows.map((r) => ({
    ...receiptPayload(r),
    api_slug: r.api_slug,
    upstream_status: r.upstream_status,
    latency_ms: r.latency_ms,
    detail: r.detail,
    signature: r.signature,
  }));
}

export async function receiptStats() {
  return one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE verdict = 'pass')::int AS pass,
            count(*) FILTER (WHERE verdict = 'stale')::int AS stale,
            count(*) FILTER (WHERE verdict = 'bad')::int AS bad,
            count(*) FILTER (WHERE verdict = 'down')::int AS down
     FROM receipts`,
  );
}
