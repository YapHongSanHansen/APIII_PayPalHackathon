import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./db";

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

/** Bearer secrets (wk_ wallet keys, pk_ pack tokens). Only the hash is stored. */
export function newToken(prefix: string): { token: string; hash: string } {
  const token = `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
  return { token, hash: sha256(token) };
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON (sorted keys) so hashes and signatures are reproducible. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Env value, or a dev-only secret generated once and kept in .data/. */
function devSecret(envName: string, file: string, generate: () => string): string {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv.replace(/\\n/g, "\n");
  if (process.env.NODE_ENV === "production" && !process.env.APIII_ALLOW_DEV_SECRETS) {
    throw new Error(`${envName} must be set in production`);
  }
  const p = path.join(dataDir(), file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, generate(), { mode: 0o600 });
  return fs.readFileSync(p, "utf8");
}

// ---- Sealed upstream API keys (AES-256-GCM) ----

function sealKey(): Buffer {
  const key = Buffer.from(
    devSecret("APIII_SEAL_KEY", "seal.key", () => crypto.randomBytes(32).toString("base64")).trim(),
    "base64",
  );
  if (key.length !== 32) throw new Error("APIII_SEAL_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ct].map((x) => (typeof x === "string" ? x : x.toString("base64"))).join(".");
}

export function unseal(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1") throw new Error("unknown sealed key version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", sealKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

// ---- Receipt signing (Ed25519) ----

let receiptKey: crypto.KeyObject | null = null;

function receiptPrivateKey(): crypto.KeyObject {
  if (!receiptKey) {
    const pem = devSecret("APIII_RECEIPT_SK", "receipt-key.pem", () =>
      crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    receiptKey = crypto.createPrivateKey(pem);
  }
  return receiptKey;
}

export function signReceipt(payload: unknown): string {
  return crypto.sign(null, Buffer.from(canonicalJson(payload)), receiptPrivateKey()).toString("base64");
}

export function receiptPublicKeyPem(): string {
  return crypto.createPublicKey(receiptPrivateKey()).export({ type: "spki", format: "pem" }).toString();
}
