# APIII: Architecture

Technical architecture for the product defined in [`PROJECT.md`](PROJECT.md). Prizes and sponsors are in [`SPONSORS.md`](SPONSORS.md).

> **APIII in one line:** list any API in 3 minutes; AI agents buy it with PayPal and pay **only for answers that keep the seller's promise**, with funds held (authorized) until delivery.

---

## 1. System overview

```
 SELLER (human)            OWNER (human)                 AGENT (autonomous)
     │                          │                               │
     │ /sell wizard             │ /wallet                       │ MCP tools / HTTP
     ▼                          ▼                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              APIII (Next.js on Vercel)                       │
│                                                                              │
│  [Onboarding]──AI probe/describe/promise/price──►[Catalog + MCP + manifest]  │
│       │ seal key                                         ▲  find_api         │
│       ▼                                                  │                   │
│  [Vault of sealed keys]       [Wallets + budgets]◄───────┼── buy_pack        │
│       │                              │                   │                   │
│       ▼                              ▼                   │                   │
│  [Gateway /v1/apis/*] ──► [Promise verifier] ──► [Credits ledger]            │
│       │  inject key            pass/422/503          │                       │
│       ▼                                              ▼                       │
│  Seller's upstream API                       [Receipts (signed)]             │
│                                                      │                       │
│  [Settlement]: Direct capture │ Escrow authorize → partial capture → void   │
│  [Payouts]: Payouts API or multiparty platform_fees                         │
│  [Dashboards]: AG Grid seller dashboard, /receipts, AG Studio AI assistant  │
└──────────────────────────────────────────────────────────────────────────────┘
          │                           │                          │
          ▼                           ▼                          ▼
   OpenAI (Responses API)      PayPal REST (sandbox)       Postgres (Neon/Supabase)
   + ChatGPT app (MCP)
                               Orders v2 · Vault v3 ·
                               Payouts · Webhooks
```

**Core idea:** the gateway sits between the agent and the seller's API, so it can grade every answer. The agent is charged only when an answer passes. The other components exist to support that loop.

---

## 2. Components

| # | Component | Responsibility | Key tech |
|---|---|---|---|
| 1 | **Onboarding** | Takes a base URL + example requests. Probes them (with SSRF guard), then the AI writes the description and OpenAPI, drafts the promise and suggests a price | OpenAI Responses API (structured outputs), `fetch` |
| 2 | **Key vault** | Seals the upstream API key. Only the gateway decrypts it, in memory, per call | AES-256-GCM, `APIII_SEAL_KEY` env |
| 3 | **Catalog** | Public listings, semantic search, promise + hash, status, SDK links | Postgres, embeddings or keyword search |
| 4 | **MCP server** | `find_api`, `get_promise`, `buy_pack`, `call_api`, `close_pack` | MCP TypeScript SDK |
| 5 | **Manifest** | `/.well-known/apiii.json`, a machine-readable catalog entry point | Static JSON route |
| 6 | **Wallets** | The owner's PayPal vault token, budget, per-call max price, pause | PayPal Vault v3 |
| 7 | **Gateway** | Auth by pack token → injects the key → calls upstream → verifies → meters | Next.js route handlers `/v1/*` |
| 8 | **Promise verifier** | JSON Schema + freshness (+ optional LLM judge) | Ajv, small OpenAI model (P2) |
| 9 | **Credits ledger** | Pack credits. An atomic decrement happens **only on pass** | Postgres transaction / `UPDATE … WHERE credits_used < credits_total` |
| 10 | **Receipts** | One signed record per call with its verdict; public `/receipts` page | Ed25519, AG Grid |
| 11 | **Settlement** | Direct (`CAPTURE`) or Escrow (`AUTHORIZE` → partial capture → void) | PayPal Orders v2 / Payments v2 |
| 12 | **Payouts** | Seller earnings minus the 3% fee | Payouts API, or multiparty `platform_fees` |
| 13 | **Health** | Failure streak → `down` → stop selling; status page | Counter on `apis.fail_streak` |
| 14 | **Dashboards** | Seller dashboard, owner spend, receipts; AI Q&A | AG Grid + AG Studio |
| 15 | **SDK/docs** | Inferred OpenAPI → SDKs + docs portal | APIMatic |

---

## 3. Credentials & tokens

| Token | Who holds it | Purpose | Stored as |
|---|---|---|---|
| `wk_…` wallet key | Agent (given by its owner) | Buy packs within the wallet budget | SHA-256 hash |
| `pk_…` pack token | Agent | Call one API, limited to the pack's credits | SHA-256 hash |
| Sealed upstream key | Gateway only | Call the seller's API | AES-GCM ciphertext |
| PayPal vault ID | Server only | Charge the owner's saved payment method | Plain (server-side only) |
| Receipt signing key | Server only | Sign receipts | `APIII_RECEIPT_SK` env; public key published |

---

## 4. Public API surface (`/v1`)

| Method & path | Auth | Description |
|---|---|---|
| `GET /v1/apis?q=&max_price=` | none | Search the catalog |
| `GET /v1/apis/{slug}` | none | Listing: description, price, status, promise JSON + `sha256` hash, OpenAPI |
| `ANY /v1/apis/{slug}/{path…}` | `pk_` | **Gateway call.** No or empty pack → `402` |
| `POST /v1/packs` | `wk_` | Buy a pack `{api, mode: direct\|escrow}` |
| `GET /v1/packs/{id}` | `wk_`/`pk_` | Credits left, receipts, status |
| `POST /v1/packs/{id}/close` | `wk_` | Close the pack → settle (escrow: partial capture + void) |
| `GET /v1/receipts?pack=&api=` | none | Public signed receipts |
| `POST /v1/paypal/webhook` | PayPal sig | Order/capture/void/refund/payout events |

Internal (session auth): `/api/onboard/probe`, `/api/onboard/publish`, `/api/wallets/*`, `/api/paypal/vault/*`, `/api/dashboard/*`.

### Response codes from the gateway
| Code | Meaning | Charged? |
|---|---|---|
| `200` | Answer passed the promise | ✅ 1 credit |
| `402` | No pack or credits used up → body tells the agent how to buy | — |
| `422` | Answer broke the promise (schema or freshness) | ❌ |
| `503` | Upstream unreachable / timeout / 5xx, or API is `down` | ❌ |
| `401` | Invalid pack token | — |

Headers on every response: `X-APIII-Credits-Left`, `X-APIII-Receipt-Id`, `X-APIII-Verdict`.

---

## 5. Flows

### 5.1 Seller onboarding ("3 minutes")
```
Seller ─► /sell: base URL + 1–3 sample requests (+ optional upstream key)
APIII  ─► SSRF guard (block private IPs/localhost) ─► probe each sample ×2
       ─► OpenAI (structured output): description, OpenAPI, promise draft {schema, timeField, maxAgeSec}, price
Seller ─► edit/accept ─► "Test promise" (re-probe → must pass)
APIII  ─► canonicalize promise JSON → sha256 → store; seal key
Seller ─► Connect PayPal (merchant ID) ─► (optional) DNS TXT verify
APIII  ─► publish: catalog + MCP + manifest; APIMatic SDK/docs job
```

### 5.2 Owner wallet setup (one-time human approval)
```
Owner ─► /wallet "Connect PayPal"
APIII ─► PayPal Vault v3: create setup token ─► owner approves on PayPal
APIII ─► exchange for payment token (vault ID) ─► store on wallet
Owner ─► set budget {amount, period}, max_price_per_call ─► copy wk_ key to agent
```
**Fallback** (if "save without purchase" isn't available in sandbox): vault during the first pack purchase while the owner is present (`store_in_vault: ON_SUCCESS`), then reuse the vault ID afterwards.

### 5.3 Agent purchase + calls
```
Agent ─► GET /v1/apis/deal-finder/search?q=airpods            (no pk_)
APIII ─► 402 { price_per_call, pack:{calls:100,total}, promise:{hash,url},
               settlement:[direct,escrow], pay:{method:"paypal", buy_pack_url:"/v1/packs"} }
Agent ─► POST /v1/packs {api, mode:"escrow"}  Bearer wk_
APIII ─► check: wallet active, total ≤ remaining budget, price ≤ max_price_per_call
       ─► PayPal Orders v2 create {intent: AUTHORIZE, payment_source: vault_id}
       ─► authorize ─► store order_id, authorization_id ─► 201 {pk_, credits:100}
Agent ─► GET …/search?q=airpods  Bearer pk_  ─► gateway (§6) ─► 200 / 422 / 503
```

### 5.4 Settlement
**Direct mode** (`intent: CAPTURE`): paid when the pack is bought. Unused credits stay usable; if the API goes `down`, unused credits are **refunded** pro rata through the Refunds API.

**Escrow mode** (`intent: AUTHORIZE`):
```
close (agent calls /close, credits used up, or timer before honor period ends)
  good = count(receipts where verdict = pass)
  if good > 0:
     POST /v2/payments/authorizations/{auth_id}/capture
          { amount: good × price, final_capture: true,
            payment_instruction: { platform_fees: [3%] } }     ← if multiparty is available
  else:
     POST /v2/payments/authorizations/{auth_id}/void
  (final_capture releases the rest of the hold)
```
⚠️ Authorization honor period is about 3 days (valid about 29 days with reauthorization). Demo packs close within minutes. A cron job closes open escrow packs before the honor period ends.

### 5.5 Seller payouts
- **Preferred:** multiparty, where the seller is `payee` on the order and APIII takes `platform_fees` (3%). Needs partner setup; verify in sandbox.
- **Fallback:** funds are captured to the APIII account → a periodic **Payouts API** batch pays each seller `Σ(good × price) × 0.97`.

### 5.6 Webhooks
`PAYMENT.AUTHORIZATION.CREATED/VOIDED`, `PAYMENT.CAPTURE.COMPLETED/REFUNDED`, `PAYMENT.PAYOUTS-ITEM.*` → verify the signature → update `packs` / `payouts`. The ledger never trusts client calls for money state.

---

## 6. Gateway call path

```ts
async function gateway(req, slug, path) {
  const pack = await findPackByToken(req.bearer)           // 401 if invalid
  if (!pack || pack.creditsLeft <= 0) return paymentRequired(slug)   // 402
  const api = await loadApi(slug)
  if (api.status === 'down') return unavailable(pack)                 // 503, no charge

  const key = unseal(api.sealedKey)                         // in memory only
  let res
  try { res = await fetchUpstream(api.baseUrl + path, req, key, { timeoutMs: 10_000 }) }
  catch { await fail(api, pack, 'down'); return unavailable(pack) }   // 503
  if (res.status >= 500) { await fail(api, pack, 'down'); return unavailable(pack) }

  const body = await res.json()
  const ok = ajv.validate(api.promise.schema, body)
          && isFresh(body, api.promise.timeField, api.promise.maxAgeSec)
  if (!ok) { await fail(api, pack, ajv.errors ? 'bad' : 'stale'); return unprocessable(pack) } // 422

  const used = await db.consumeCredit(pack.id)              // atomic; false if a race used the last credit
  if (!used) return paymentRequired(slug)
  await resetFailStreak(api)
  const receipt = await signAndStoreReceipt(pack, req, body, 'pass')
  return json(body, { headers: apiiiHeaders(pack, receipt, 'pass') })
}
// fail(): store a signed receipt with the verdict, increment api.fail_streak; when it passes the threshold, mark api.status='down'
```

---

## 7. Data model

```sql
sellers   (id, email, paypal_merchant_id, domain, domain_verified_at, created_at)

apis      (id, seller_id, slug UNIQUE, name, base_url, sealed_key, description,
           openapi_json, promise_json, promise_hash, price_per_call_cents,
           pack_size DEFAULT 100, status ['live','down','draft'], fail_streak,
           apimatic_portal_url, created_at)

wallets   (id, owner_email, key_hash, paypal_vault_id, budget_cents, budget_period,
           spent_cents, period_start, max_price_per_call_cents, active)

packs     (id, api_id, wallet_id, token_hash, mode ['direct','escrow'],
           credits_total, credits_used, amount_cents,
           paypal_order_id, paypal_auth_id, paypal_capture_id,
           status ['authorized','captured','open','closed','voided','refunded'],
           created_at, closed_at, expires_at)

receipts  (id, pack_id, api_id, ts, method, path, request_hash, response_hash,
           verdict ['pass','stale','bad','down'], latency_ms, signature)

payouts   (id, seller_id, amount_cents, fee_cents, paypal_batch_id, status, created_at)
```

---

## 8. Security

| Threat | Mitigation |
|---|---|
| **SSRF** through probe/gateway (seller URL points to an internal host) | Resolve DNS, block private/loopback/link-local ranges, HTTPS only, follow no redirects to blocked IPs |
| Leaking upstream keys | AES-GCM sealed; never returned by any endpoint; decrypted per call only |
| Token theft | Store only hashes of `wk_`/`pk_`; wallet budget caps the damage; owner can pause |
| Agent overspending | Budget + max price checked **server-side** before every PayPal call |
| Double-spending credits | Atomic conditional `UPDATE … WHERE credits_used < credits_total` |
| Forged PayPal events | Verify webhook signatures; reconcile with `GET /v2/checkout/orders/{id}` |
| Seller changes the promise after sale | Promise hash locked per pack (`packs.promise_hash` snapshot) |
| Disputes on the count | Ed25519-signed receipts, public key published, `/receipts` page public |

---

## 9. Tech stack & repo layout

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router) + TypeScript, deployed on Vercel |
| UI | Tailwind + shadcn/ui; AG Grid + AG Studio; (Bryntum P2) |
| DB | Postgres (Neon or Supabase) + Drizzle ORM |
| AI | OpenAI SDK (Responses API, model from `OPENAI_MODEL` / `OPENAI_MODEL_SMALL`); OpenAI Agents SDK (demo agent); ChatGPT Apps SDK (in-ChatGPT agent). See §12 |
| Payments | PayPal REST sandbox: Orders v2, Payments v2, Vault v3, Payouts, Webhooks |
| Validation | Ajv |
| Crypto | Node `crypto` (AES-256-GCM, Ed25519) |
| Agent | MCP TypeScript SDK + demo agent script |

```
/app
  /(marketing)/page.tsx            landing
  /sell/                           onboarding wizard
  /dashboard/                      seller dashboard (AG Grid)
  /wallet/                         owner wallet + PayPal vault
  /apis/[slug]/                    listing page
  /receipts/                       public receipts
  /try/                            live agent demo
  /v1/...                          public API + gateway (route handlers)
  /api/...                         internal routes (onboard, wallets, paypal)
  /.well-known/apiii.json/route.ts manifest
/lib
  paypal/  (client, orders, vault, payouts, webhooks)
  gateway/ (proxy, verifier, ledger, receipts)
  ai/      (probe, describe, promise, judge)
  crypto/  (seal, sign)
  db/      (schema, queries)
/mcp       MCP server (find_api, get_promise, buy_pack, call_api, close_pack)
/agent     demo buyer agent (OpenAI Agents SDK + MCP)
/demo-seller  "Deal Finder" API built on Channel3
```

---

## 10. Sponsor hooks

| Sponsor | Where in the architecture |
|---|---|
| **AG Grid / AG Studio** | `/dashboard` (calls, verdicts, revenue, payouts), `/receipts`, AI assistant over the seller's data |
| **APIMatic** | Onboarding publish step: OpenAPI → SDKs + docs portal (`apis.apimatic_portal_url`); Context Plugin used while coding `/lib/paypal` |
| **Channel3** | `/demo-seller`: the Deal Finder API calls Channel3 product search |
| **Bryntum** (P2) | Pack lifecycle timeline: authorize → calls → capture/void → payout |

---

## 11. Fallbacks

| If this fails in sandbox | Do this |
|---|---|
| Vault without purchase | Vault during the first purchase (owner present), reuse afterwards |
| Multiparty `platform_fees` | Capture to the platform → Payouts API minus 3% |
| Partial capture on an authorization | Capture full → refund the unused part (costs more in fees; fine for the demo) |
| AG Studio access | Plain AG Grid + a simple OpenAI Q&A over the same data |
| ChatGPT developer mode / Apps SDK unavailable | Demo with the scripted OpenAI Agents SDK agent against the same MCP server |
| "Sign in with ChatGPT" access not granted | Use the APIII server OpenAI key (mode A) |

---

## 12. AI provider: OpenAI

The PayPal sandbox is the payment layer **no matter which AI mode runs**. The AI never touches money directly. It only calls APIII tools, and APIII calls PayPal.

```
                ┌──────────── Mode A (default) ────────────┐
 /sell wizard ─►│ /lib/ai → OpenAI Responses API (APIII key)│─► listing, promise, price
 demo agent  ──►│ OpenAI Agents SDK → APIII MCP server      │─► buy_pack ─► PayPal sandbox
                └───────────────────────────────────────────┘
                ┌──────────── Mode B (ChatGPT app) ─────────┐
 ChatGPT user ─►│ ChatGPT (user's subscription) = the agent │
                │   → APIII MCP server (OAuth → wallet)     │─► buy_pack ─► PayPal sandbox
                └───────────────────────────────────────────┘
                ┌──────────── Mode C (stretch) ─────────────┐
 seller ───────►│ "Sign in with ChatGPT" → user's plan      │─► onboarding AI on their plan
                └───────────────────────────────────────────┘
```

**Rules**
- **Subscription ≠ API key.** A ChatGPT Plus/Pro subscription can't be used as APIII's server key. Never reuse a personal ChatGPT/Codex login token in the backend. Server-side AI uses a normal OpenAI API key from platform.openai.com (billed separately).
- **Mode B is how users "connect" on their own subscription:** APIII's MCP server is registered as a ChatGPT app. The user links their APIII wallet via OAuth, and ChatGPT runs the reasoning on the user's plan while calling `find_api`, `buy_pack`, `call_api`, `close_pack`.
- In mode B, payment still goes through **APIII wallet → PayPal sandbox Vault/Orders**, not ChatGPT's built-in checkout. That keeps escrow (authorize → partial capture → void) under our control.
- The MCP server needs **OAuth** (not a bare bearer token) to work as a ChatGPT app. Map the OAuth user to a `wallets` row.
- `/lib/ai` exposes `describeApi()`, `draftPromise()`, `suggestPrice()`, `judge()`, `askAnalytics()`. Swapping providers or modes touches only this file.

---

## Appendix: concept reference (Hirakumi → APIII)

The "promise-verified answers" model is inspired by Hirakumi (Cardano/Masumi, https://hirakumi.vercel.app/). APIII is an independent implementation on PayPal rails. We reuse the concept only; code, wording and branding are our own.

| Concept | Hirakumi | APIII |
|---|---|---|
| Payment | x402, USDM on Cardano | PayPal Orders v2 via the owner's vaulted payment method |
| Agent wallet | Crypto wallet | PayPal Vault + budget-limited `wk_` key |
| Escrow | Aiken smart contract | PayPal authorization → partial capture → void |
| Directory | Masumi registry | Own catalog + MCP server + `/.well-known` manifest |
| Receipts | Agent-signed | Gateway-signed (Ed25519), public |
| Seller payout | On-chain | PayPal Payouts / multiparty, fiat |
| Trust model | Trustless contract | Trusts PayPal + APIII, made up for by public signed receipts and promise hashes |
