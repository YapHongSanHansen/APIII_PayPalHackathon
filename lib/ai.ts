import OpenAI from "openai";
import { checkAnswer, heuristicPromise, normalizePromise, type ApiPromise } from "./promise";

/**
 * All server-side AI goes through this file (mode A in ARCHITECTURE.md §12).
 * Without OPENAI_API_KEY everything falls back to deterministic heuristics.
 */
export function aiEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function aiModel(): string {
  return process.env.OPENAI_MODEL || "gpt-5-mini";
}

let client: OpenAI | null = null;
export function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export interface ProbeResult {
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  ok: boolean;
  body: unknown;
  error?: string;
}

export interface ListingDraft {
  name: string;
  description: string;
  category: string;
  promise: ApiPromise;
  pricePerCallCents: number;
  source: "openai" | "heuristic";
  notes: string;
}

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "description",
    "category",
    "promise_schema_json",
    "time_field",
    "max_age_sec",
    "price_per_call_cents",
    "notes",
  ],
  properties: {
    name: { type: "string", description: "Short product name for the API listing" },
    description: { type: "string", description: "2-3 sentences, written for AI agents deciding whether to buy" },
    category: { type: "string" },
    promise_schema_json: {
      type: "string",
      description:
        "A JSON Schema (draft 2020-12 compatible, as a JSON string) that every good answer must match. Require the fields a buyer needs; do not over-constrain values.",
    },
    time_field: {
      type: "string",
      description: "Dot path to the timestamp that proves freshness, or empty string if none",
    },
    max_age_sec: { type: "integer", description: "Maximum age in seconds for time_field (e.g. 900)" },
    price_per_call_cents: { type: "integer", description: "Suggested USD price per successful call in cents (1-100)" },
    notes: { type: "string", description: "One sentence on why this promise and price" },
  },
} as const;

export async function draftListing(baseUrl: string, probes: ProbeResult[]): Promise<ListingDraft> {
  const good = probes.filter((p) => p.ok && p.body && typeof p.body === "object");
  const sample = good[0]?.body ?? probes[0]?.body ?? {};
  const fallback = (): ListingDraft => ({
    name: guessName(baseUrl),
    description: `API at ${new URL(baseUrl).host}. Endpoints: ${probes.map((p) => `${p.method} ${p.path}`).join(", ")}.`,
    category: "data",
    promise: heuristicPromise(sample),
    pricePerCallCents: 2,
    source: "heuristic",
    notes: aiEnabled() ? "AI draft failed; promise inferred from the sample response." : "No OPENAI_API_KEY; promise inferred from the sample response.",
  });
  if (!aiEnabled() || good.length === 0) return fallback();

  try {
    const res = await openai().responses.create({
      model: aiModel(),
      instructions:
        "You onboard APIs onto APIII, a marketplace where AI agents buy API calls and pay only for answers that keep the seller's promise. " +
        "Given probe results, write the listing and draft the promise: a JSON Schema for a good answer plus an optional freshness rule. " +
        "The schema must accept the sample responses shown. Prefer requiring the fields an agent actually needs.",
      input: JSON.stringify({
        base_url: baseUrl,
        probes: probes.map((p) => ({ ...p, body: truncate(p.body) })),
      }),
      text: { format: { type: "json_schema", name: "listing_draft", strict: true, schema: DRAFT_SCHEMA as any } },
    });
    const out = JSON.parse(res.output_text);
    const promise = normalizePromise({
      schema: JSON.parse(out.promise_schema_json),
      timeField: out.time_field || null,
      maxAgeSec: out.max_age_sec,
    });
    // Safety net: the AI's promise must accept the seller's own good samples.
    const failing = good.map((p) => checkAnswer(promise, p.body)).find((r) => r.verdict !== "pass");
    const draft: ListingDraft = {
      name: out.name,
      description: out.description,
      category: out.category,
      promise,
      pricePerCallCents: Math.min(100, Math.max(1, Math.round(out.price_per_call_cents))),
      source: "openai",
      notes: out.notes,
    };
    if (failing) {
      draft.promise = heuristicPromise(sample);
      draft.notes += ` (AI schema rejected a sample: ${failing.detail}; using inferred schema instead.)`;
    }
    return draft;
  } catch (err) {
    const d = fallback();
    d.notes = `AI draft failed (${(err as Error).message}); promise inferred from the sample response.`;
    return d;
  }
}

function guessName(baseUrl: string): string {
  const u = new URL(baseUrl);
  const seg = u.pathname.split("/").filter(Boolean).pop() || u.hostname.split(".")[0];
  return seg.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) + " API";
}

export function truncate(body: unknown, max = 4000): unknown {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  if (!s || s.length <= max) return body;
  return s.slice(0, max) + "…(truncated)";
}

/** Minimal OpenAPI 3.1 doc built from probes + promise (input for APIMatic SDK generation). */
export function buildOpenApi(name: string, description: string, baseUrl: string, probes: ProbeResult[], promise: ApiPromise) {
  const paths: Record<string, any> = {};
  for (const p of probes) {
    const url = new URL(p.path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
    const key = "/" + url.pathname.slice(new URL(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/").pathname.length);
    paths[key] ??= {};
    paths[key][p.method.toLowerCase()] = {
      summary: `${p.method} ${key}`,
      parameters: [...url.searchParams.keys()].map((k) => ({ name: k, in: "query", schema: { type: "string" } })),
      responses: {
        "200": { description: "Answer that keeps the promise", content: { "application/json": { schema: promise.schema } } },
        "402": { description: "Payment required: buy a pack via APIII" },
        "422": { description: "Answer broke the promise (not charged)" },
      },
    };
  }
  return { openapi: "3.1.0", info: { title: name, description, version: "1.0.0" }, servers: [{ url: baseUrl }], paths };
}
