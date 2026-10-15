import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { canonicalJson, sha256 } from "./crypto";
import { ApiError } from "./http";

/** What a seller guarantees about every answer. */
export interface ApiPromise {
  schema: Record<string, unknown>; // JSON Schema the answer body must match
  timeField: string | null; // dot path to a timestamp in the answer
  maxAgeSec: number | null; // how old that timestamp may be
}

export type Verdict = "pass" | "bad" | "stale" | "down";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const compiled = new Map<string, ValidateFunction>();

function validatorFor(schema: Record<string, unknown>): ValidateFunction {
  const key = canonicalJson(schema);
  let v = compiled.get(key);
  if (!v) {
    v = ajv.compile(schema);
    compiled.set(key, v);
  }
  return v;
}

export function hashPromise(p: ApiPromise): string {
  return `sha256:${sha256(canonicalJson(p))}`;
}

export function normalizePromise(input: any): ApiPromise {
  if (!input || typeof input !== "object" || !input.schema || typeof input.schema !== "object") {
    throw new ApiError(400, "bad_promise", "promise.schema must be a JSON Schema object");
  }
  try {
    validatorFor(input.schema);
  } catch (err) {
    throw new ApiError(400, "bad_promise", `promise.schema does not compile: ${(err as Error).message}`);
  }
  const maxAge = input.maxAgeSec == null || input.maxAgeSec === "" ? null : Number(input.maxAgeSec);
  if (maxAge != null && (!Number.isFinite(maxAge) || maxAge <= 0)) {
    throw new ApiError(400, "bad_promise", "promise.maxAgeSec must be a positive number");
  }
  return {
    schema: input.schema,
    timeField: input.timeField ? String(input.timeField) : null,
    maxAgeSec: input.timeField ? maxAge ?? 900 : null,
  };
}

export function checkAnswer(p: ApiPromise, body: unknown): { verdict: Verdict; detail: string } {
  const validate = validatorFor(p.schema);
  if (!validate(body)) {
    return { verdict: "bad", detail: ajv.errorsText(validate.errors, { separator: "; " }) };
  }
  if (p.timeField && p.maxAgeSec) {
    const t = parseTime(getPath(body, p.timeField));
    if (t == null) return { verdict: "bad", detail: `${p.timeField} is missing or not a timestamp` };
    const ageSec = (Date.now() - t) / 1000;
    if (ageSec > p.maxAgeSec) {
      return { verdict: "stale", detail: `${p.timeField} is ${Math.round(ageSec)}s old (max ${p.maxAgeSec}s)` };
    }
    if (ageSec < -300) return { verdict: "bad", detail: `${p.timeField} is in the future` };
  }
  return { verdict: "pass", detail: "ok" };
}

export function getPath(obj: unknown, dotPath: string): unknown {
  return dotPath.split(".").reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as any)[k] : undefined), obj);
}

export function parseTime(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string" && v.trim()) {
    if (/^\d+(\.\d+)?$/.test(v)) return parseTime(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// ---- Heuristic promise inference (used when no AI key, and as a safety net) ----

export function inferSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (Array.isArray(value)) {
    return { type: "array", ...(value.length && depth < 3 ? { items: inferSchema(value[0], depth + 1) } : {}) };
  }
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object": {
      if (depth >= 3) return { type: "object" };
      const entries = Object.entries(value as Record<string, unknown>);
      return {
        type: "object",
        properties: Object.fromEntries(entries.map(([k, v]) => [k, inferSchema(v, depth + 1)])),
        required: entries.filter(([, v]) => v !== null && v !== undefined).map(([k]) => k),
      };
    }
    default:
      return {};
  }
}

const TIME_KEY = /(fetched|updated|generated|retrieved|as_?of|timestamp|^time$|_at$|At$|date)/i;

export function detectTimeField(body: unknown): string | null {
  const recent = (v: unknown) => {
    const t = parseTime(v);
    return t != null && Math.abs(Date.now() - t) < 5 * 365 * 86400_000;
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  for (const [k, v] of Object.entries(body)) if (TIME_KEY.test(k) && recent(v)) return k;
  for (const [k, v] of Object.entries(body)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) if (TIME_KEY.test(k2) && recent(v2)) return `${k}.${k2}`;
    }
  }
  return null;
}

export function heuristicPromise(sampleBody: unknown): ApiPromise {
  const timeField = detectTimeField(sampleBody);
  return { schema: inferSchema(sampleBody), timeField, maxAgeSec: timeField ? 900 : null };
}
