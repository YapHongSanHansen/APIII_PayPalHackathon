// End-to-end smoke test against a running server: `node scripts/smoke.mjs [baseUrl]`.
// Works in PayPal mock mode out of the box. With real sandbox credentials, vault
// approval needs a human, so it stops after printing the approval link.
import crypto from "node:crypto";

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
let failures = 0;

async function req(method, path, { body, token, redirect = "follow" } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(path.startsWith("http") ? path : BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, headers: r.headers, body: json };
}

function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : "");
  }
}

const setMode = (mode) => req("POST", "/api/demo-seller/mode", { body: { mode } });

const status = (await req("GET", "/api/status")).body;
console.log(`APIII smoke test → ${BASE} (paypal=${status.paypal.mode}, openai=${status.openai.enabled}, db=${status.database})`);
const mock = status.paypal.mode === "mock";
await setMode("ok");

console.log("\n1. Seller lists an API");
const probe = await req("POST", "/api/onboard/probe", {
  body: { baseUrl: `${BASE}/demo-seller`, samples: [{ method: "GET", path: "deals?q=airpods pro" }], keyHeader: "x-demo-key", keyValue: "demo-secret-key" },
});
check("probe returns 200 and a draft", probe.status === 200 && probe.body.draft, probe.body);
check("probe reached the demo seller with the key", probe.body.probes?.[0]?.status === 200, probe.body.probes);
check("draft promise has a freshness field", probe.body.draft?.promise?.timeField === "fetched_at", probe.body.draft?.promise);
const pub = await req("POST", "/api/onboard/publish", {
  body: {
    sellerEmail: "seller-dealfinder@example.com",
    name: "Deal Finder",
    slug: `deal-finder-${Date.now().toString(36)}`,
    description: probe.body.draft.description,
    baseUrl: `${BASE}/demo-seller`,
    keyHeader: "x-demo-key",
    keyValue: "demo-secret-key",
    samples: [{ method: "GET", path: "deals?q=airpods pro" }],
    promise: probe.body.draft.promise,
    pricePerCallCents: 2,
    probes: probe.body.probes,
  },
});
check("publish returns 201", pub.status === 201, pub.body);
check("listing never exposes the sealed key", !JSON.stringify(pub.body).includes("demo-secret-key"));
const slug = pub.body.slug;

console.log("\n2. Owner creates a wallet and vaults PayPal");
const w = await req("POST", "/api/wallets", { body: { ownerEmail: "owner-alice@example.com", budgetCents: 2000, maxPricePerCallCents: 10 } });
check("wallet created with a wk_ key", w.status === 201 && w.body.walletKey?.startsWith("wk_"), w.body);
const walletKey = w.body.walletKey;
const v = await req("POST", `/api/wallets/${w.body.wallet.id}/vault`);
check("vault setup returns an approval link", Boolean(v.body.approveUrl), v.body);
if (!mock) {
  console.log(`\nReal sandbox: approve the vault in a browser, then re-run with a vaulted wallet:\n  ${v.body.approveUrl}`);
  process.exit(failures ? 1 : 0);
}
await req("GET", v.body.approveUrl, { redirect: "manual" }); // mock: approval loops straight back
const wInfo = (await req("GET", `/api/wallets/${w.body.wallet.id}`)).body;
check("wallet is PayPal-connected", wInfo.paypal_connected === true, wInfo);

console.log("\n3. Agent: 402 → buy escrow pack → calls");
const noPack = await req("GET", `/v1/apis/${slug}/deals?q=airpods`);
check("call without pack → 402 with payment offer", noPack.status === 402 && noPack.body.pay?.method === "paypal", noPack.body);
const buy = await req("POST", "/v1/packs", { body: { api: slug, mode: "escrow" }, token: walletKey });
check("vaulted wallet buys pack with no human (201 active)", buy.status === 201 && buy.body.pack.status === "active", buy.body);
check("escrow pack holds an authorization", Boolean(buy.body.pack.paypal.authorization_id), buy.body.pack);
const packToken = buy.body.pack_token;
const packId = buy.body.pack.id;

for (let i = 0; i < 3; i++) {
  const c = await req("GET", `/v1/apis/${slug}/deals?q=airpods`, { token: packToken });
  check(`good answer #${i + 1} → 200, charged`, c.status === 200 && c.headers.get("x-apiii-verdict") === "pass", c.body);
}
await setMode("stale");
const stale = await req("GET", `/v1/apis/${slug}/deals?q=airpods`, { token: packToken });
check("stale answer → 422, not charged", stale.status === 422 && stale.body.verdict === "stale" && stale.body.charged === false, stale.body);
await setMode("broken");
const broken = await req("GET", `/v1/apis/${slug}/deals?q=airpods`, { token: packToken });
check("broken answer → 422 (schema), not charged", broken.status === 422 && broken.body.verdict === "bad", broken.body);
await setMode("ok");
const good4 = await req("GET", `/v1/apis/${slug}/deals?q=airpods`, { token: packToken });
check("good answer #4 → 200", good4.status === 200, good4.body);
check("credits left = 96 (only 4 good answers charged)", good4.headers.get("x-apiii-credits-left") === "96");

console.log("\n4. Settle escrow");
const close = await req("POST", `/v1/packs/${packId}/close`, { token: packToken });
check("close → partial capture of 4 × 2¢ = 8¢", close.status === 200 && close.body.settlement.owed_cents === 8 && close.body.pack.captured_cents === 8, close.body);
check("rest of the hold released", close.body.settlement?.paypal?.released_cents === 192, close.body.settlement);
check("wallet only spent 8¢", close.body.wallet_spent_cents === 8, close.body);
const after = await req("GET", `/v1/apis/${slug}/deals?q=airpods`, { token: packToken });
check("closed pack → 402", after.status === 402, after.body);

console.log("\n5. Direct pack refunds unused credits");
const d = await req("POST", "/v1/packs", { body: { api: slug, mode: "direct" }, token: walletKey });
check("direct pack captured up front", d.status === 201 && d.body.pack.captured_cents === 200, d.body);
await req("GET", `/v1/apis/${slug}/deals?q=tv`, { token: d.body.pack_token });
const dClose = await req("POST", `/v1/packs/${d.body.pack.id}/close`, { token: walletKey });
check("close refunds 99 unused calls (198¢)", dClose.body.pack?.refunded_cents === 198, dClose.body);

console.log("\n6. Wallet without vault → owner approval fallback");
const w2 = await req("POST", "/api/wallets", { body: { ownerEmail: "owner-bob@example.com", budgetCents: 500, maxPricePerCallCents: 10 } });
const b2 = await req("POST", "/v1/packs", { body: { api: slug, mode: "escrow" }, token: w2.body.walletKey });
check("pack is pending_approval with approve link (202)", b2.status === 202 && b2.body.pack.status === "pending_approval", b2.body);
const pending = await req("GET", `/v1/apis/${slug}/deals?q=x`, { token: b2.body.pack_token });
check("calling a pending pack → 402 with approve_url", pending.status === 402 && Boolean(pending.body.approve_url), pending.body);
await req("GET", b2.body.pack.paypal.approve_url, { redirect: "manual" });
const p2 = (await req("GET", `/v1/packs/${b2.body.pack.id}`)).body;
check("after approval the pack is active", p2.status === "active", p2);
const w2Info = (await req("GET", `/api/wallets/${w2.body.wallet.id}`)).body;
check("PayPal vaulted during first purchase", w2Info.paypal_connected === true, w2Info);
const overBudget = await req("POST", "/v1/packs", { body: { api: slug, mode: "escrow" }, token: w2.body.walletKey });
check("third pack would exceed $5 budget → 402 budget_exceeded", overBudget.status === 201 || overBudget.body.error === "budget_exceeded", overBudget.body);
const overBudget2 = await req("POST", "/v1/packs", { body: { api: slug, mode: "escrow" }, token: w2.body.walletKey });
check("budget is enforced", overBudget2.status === 402 && overBudget2.body.error === "budget_exceeded", overBudget2.body);

console.log("\n7. Upstream outage → no charge → API marked down");
const b3 = await req("POST", "/v1/packs", { body: { api: slug, mode: "escrow" }, token: walletKey });
await setMode("down");
let last;
for (let i = 0; i < 3; i++) last = await req("GET", `/v1/apis/${slug}/deals?q=x`, { token: b3.body.pack_token });
check("outage → 503, not charged", last.status === 503 && last.body.charged === false, last.body);
const listing = (await req("GET", `/v1/apis/${slug}`)).body;
check("API marked down after 3 failures", listing.status === "down", listing.status);
const blocked = await req("POST", "/v1/packs", { body: { api: slug, mode: "escrow" }, token: walletKey });
check("down API doesn't sell packs", blocked.status === 503, blocked.body);
await setMode("ok");
await req("POST", `/api/apis/${slug}/reset`);
await req("POST", `/v1/packs/${b3.body.pack.id}/close`, { token: walletKey });

console.log("\n8. Autonomous agent");
const agent = await req("POST", "/api/agent", { body: { goal: "airpods pro", walletKey, mode: "escrow" } });
const tools = (agent.body.steps || []).filter((s) => s.kind === "tool_call").map((s) => s.name);
check(`agent ran (${agent.body.mode}) and used find/buy/call/close`, ["find_api", "buy_pack", "call_api", "close_pack"].every((t) => tools.includes(t)), agent.body);

console.log("\n9. Payouts + receipts");
const po = await req("POST", "/api/payouts");
check("payout to seller created", po.status === 200 && po.body.payouts.some((p) => p.status !== "failed"), po.body);
const receipts = (await req("GET", `/v1/receipts?api=${slug}&limit=200`)).body;
const pem = (await req("GET", "/v1/receipts/public-key")).body;
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const fields = ["id", "pack_id", "api_id", "ts", "method", "path", "request_hash", "response_hash", "verdict", "http_status", "charged"];
const allValid = receipts.every((r) =>
  crypto.verify(null, Buffer.from(JSON.stringify(canon(Object.fromEntries(fields.map((f) => [f, r[f]]))))), crypto.createPublicKey(pem), Buffer.from(r.signature, "base64")),
);
check(`all ${receipts.length} receipts verify with the public key`, receipts.length > 0 && allValid);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
