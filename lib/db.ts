import fs from "node:fs";
import path from "node:path";

/**
 * Tiny SQL layer: Postgres via DATABASE_URL (Neon/Supabase), otherwise an
 * embedded PGlite (Postgres in WASM) stored in .data/ so local testing needs no setup.
 */
export interface Db {
  kind: "pglite" | "postgres";
  query(sql: string, params?: unknown[]): Promise<any[]>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sellers (
  id                 TEXT PRIMARY KEY,
  email              TEXT UNIQUE NOT NULL,
  paypal_email       TEXT,
  paypal_merchant_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS apis (
  id                   TEXT PRIMARY KEY,
  seller_id            TEXT NOT NULL REFERENCES sellers(id),
  slug                 TEXT UNIQUE NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  category             TEXT NOT NULL DEFAULT '',
  base_url             TEXT NOT NULL,
  key_header           TEXT,
  sealed_key           TEXT,
  samples_json         JSONB NOT NULL DEFAULT '[]',
  openapi_json         JSONB,
  promise_json         JSONB NOT NULL,
  promise_hash         TEXT NOT NULL,
  price_per_call_cents INT NOT NULL,
  pack_size            INT NOT NULL DEFAULT 100,
  status               TEXT NOT NULL DEFAULT 'live',
  fail_streak          INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  id                       TEXT PRIMARY KEY,
  owner_email              TEXT NOT NULL,
  key_hash                 TEXT UNIQUE NOT NULL,
  paypal_vault_id          TEXT,
  vault_setup_token        TEXT,
  budget_cents             INT NOT NULL,
  budget_period_days       INT NOT NULL DEFAULT 7,
  spent_cents              INT NOT NULL DEFAULT 0,
  period_start             TIMESTAMPTZ NOT NULL DEFAULT now(),
  max_price_per_call_cents INT NOT NULL DEFAULT 10,
  active                   BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS packs (
  id                   TEXT PRIMARY KEY,
  api_id               TEXT NOT NULL REFERENCES apis(id),
  wallet_id            TEXT NOT NULL REFERENCES wallets(id),
  token_hash           TEXT UNIQUE NOT NULL,
  mode                 TEXT NOT NULL,
  credits_total        INT NOT NULL,
  credits_used         INT NOT NULL DEFAULT 0,
  price_per_call_cents INT NOT NULL,
  amount_cents         INT NOT NULL,
  promise_json         JSONB NOT NULL,
  promise_hash         TEXT NOT NULL,
  paypal_order_id      TEXT,
  paypal_auth_id       TEXT,
  paypal_capture_id    TEXT,
  approve_url          TEXT,
  captured_cents       INT NOT NULL DEFAULT 0,
  refunded_cents       INT NOT NULL DEFAULT 0,
  status               TEXT NOT NULL,
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at            TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS receipts (
  id              TEXT PRIMARY KEY,
  pack_id         TEXT REFERENCES packs(id),
  api_id          TEXT NOT NULL REFERENCES apis(id),
  ts              TIMESTAMPTZ NOT NULL,
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_hash   TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  http_status     INT NOT NULL,
  upstream_status INT,
  latency_ms      INT NOT NULL,
  charged         BOOLEAN NOT NULL,
  detail          TEXT,
  signature       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_pack_idx ON receipts(pack_id);
CREATE INDEX IF NOT EXISTS receipts_api_idx ON receipts(api_id);

CREATE TABLE IF NOT EXISTS payouts (
  id              TEXT PRIMARY KEY,
  seller_id       TEXT NOT NULL REFERENCES sellers(id),
  amount_cents    INT NOT NULL,
  fee_cents       INT NOT NULL,
  paypal_batch_id TEXT,
  status          TEXT NOT NULL,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paypal_events (
  id          TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  resource_id TEXT,
  verified    BOOLEAN,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
`;

export function dataDir(): string {
  const dir =
    process.env.APIII_DATA_DIR ||
    (process.env.VERCEL ? "/tmp/apiii" : path.join(process.cwd(), ".data"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function open(): Promise<Db> {
  if (process.env.DATABASE_URL) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    await pool.query(SCHEMA);
    return {
      kind: "postgres",
      async query(sql, params = []) {
        return (await pool.query(sql, params as any[])).rows;
      },
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(path.join(dataDir(), "pglite"));
  await pg.exec(SCHEMA);
  return {
    kind: "pglite",
    async query(sql, params = []) {
      return (await pg.query(sql, params as any[])).rows as any[];
    },
  };
}

// One connection per process; route bundles share globalThis but not module state.
type G = typeof globalThis & { __apiiiDb?: Promise<Db> };

export function db(): Promise<Db> {
  const g = globalThis as G;
  if (!g.__apiiiDb) {
    g.__apiiiDb = open().catch((err) => {
      g.__apiiiDb = undefined;
      throw err;
    });
  }
  return g.__apiiiDb;
}

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db()).query(sql, params) as Promise<T[]>;
}

export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}
