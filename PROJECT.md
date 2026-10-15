# APIII: Final Build Spec (PayPal AI Hackathon)

> **One-liner:** List any API in 3 minutes and let AI agents buy it with PayPal. Agents pay **only for answers that keep the seller's promise**, and the money is held until delivery.

Related docs: [`SPONSORS.md`](SPONSORS.md) (prizes) · [`ARCHITECTURE.md`](ARCHITECTURE.md) (technical deep dive)

---

## 1. The problem

- AI agents increasingly need paid data and tools: prices, shipping rates, risk scores, weather, product data.
- API owners can't sell to agents easily. Agents can't sign up, can't enter a card, and can't sit through a sales call.
- Existing agent-payment options (x402 marketplaces, Cloudflare Monetization Gateway) settle in **stablecoins**, need a **crypto wallet**, and charge for every call **whether the answer was good or not**.
- Businesses that own valuable APIs (banks, logistics, data providers) don't want crypto. They want fiat in an account they already have.

## 2. The solution

APIII is a **verifying payment gateway + marketplace** between AI agents and APIs:

1. **Sellers** paste a base URL. AI probes the API, describes it, drafts a **promise** (the required fields plus a freshness limit) and a price. They connect PayPal and go live in about 3 minutes, with **no code changes**.
2. **Agent owners** (humans) approve PayPal **once**, set a budget, and hand their agent a wallet key.
3. **Agents** discover APIs (through MCP or the catalog), hit `402 Payment Required`, buy a **pack of 100 calls** through PayPal within their budget, and call the API through our gateway.
4. **The gateway grades every answer** against the published promise. If it passes, one credit is used. If it fails, the agent gets a `422` and pays nothing.
5. **Escrow mode:** the money is only *authorized* on PayPal. When the pack closes, we **capture only for good answers** and **void the rest**.

## 3. Why we win (positioning)

| | x402 marketplaces | Cloudflare Monetization GW | Nevermined | **APIII** |
|---|---|---|---|---|
| Agent pays without a human each time | ✅ | ✅ | ✅ | ✅ |
| Fiat via PayPal (no crypto wallet) | ❌ | ❌ | Stripe | ✅ **PayPal** |
| Seller onboarding without code changes | Partial | ✅ (beta) | ❌ SDK | ✅ |
| **Pays only for verified good answers** | ❌ | ❌ | ❌ | ✅ |
| **Escrow: hold, then capture only what was delivered** | Needs a contract | ❌ | ❌ | ✅ PayPal authorization |
| Seller paid into an existing PayPal account | ❌ | ❌ | ❌ | ✅ |
| AI-generated listing + promise | ❌ | ❌ | ❌ | ✅ |

**Pitch line:** *"x402 made APIs payable by agents. APIII makes them trustworthy: agents pay with PayPal, only for answers that keep the promise."*

> Concept credit: the "promise-verified answers" model is inspired by Hirakumi (Cardano). We rebuild it independently, from scratch, on PayPal rails with fiat escrow. Say this openly in the submission.

---

## 4. Users & core flows

### 4.1 Seller: "List your API in 3 minutes"
1. Sign in → **Connect PayPal** (merchant ID captured)
2. Paste a base URL + 1–3 example requests (+ an optional upstream API key, which is sealed)
3. AI probes the endpoints → shows: a description, an inferred OpenAPI spec, a **draft promise** (JSON Schema + freshness) and a suggested price per call
4. Seller edits or accepts → the promise is hashed (SHA-256) and shown publicly
5. Prove the domain (DNS TXT; can be skipped in the demo)
6. Publish → the listing appears in the catalog, the MCP server and `/.well-known/apiii.json`. APIMatic generates SDKs and docs
7. Dashboard (AG Grid): live calls, verdicts, credits sold, revenue, payouts, and AI Q&A

### 4.2 Agent owner (human): "Give my agent a budget"
1. Create a wallet → **save a PayPal payment method through Vault** (one approval)
2. Set a budget (e.g. $20/week) and a max price per call
3. Copy the wallet key `wk_…` into the agent's config
4. See spend, packs and receipts; pause the wallet anytime

### 4.3 Agent (no human in the loop)
```
find_api("cheapest price for AirPods Pro", max_price=0.05)    ← MCP tool
GET  /v1/apis/deal-finder/search?q=airpods                       → 402 {price, promise, pack}
POST /v1/packs {api, mode:"escrow"}  (Bearer wk_…)               → PayPal AUTHORIZE via vault → pk_…
GET  /v1/apis/deal-finder/search?q=airpods (Bearer pk_…)         → 200 answer + X-Credits-Left: 99
   …stale answer…                                                → 422, credits unchanged
POST /v1/packs/{id}/close                                        → partial capture + void
```

---

## 5. MVP scope

### Must have (P0): the demo depends on these
- [ ] Seller onboarding: base URL → AI probe → description + promise draft + price → publish
- [ ] Sealed upstream API keys (AES-GCM, server-only key)
- [ ] Gateway proxy: pack-token check → inject key → call upstream → **validate the promise** → pass / 422 / 503
- [ ] Credits ledger (packs of 100, decremented atomically only on pass)
- [ ] `402` response with the price, promise hash and how to buy
- [ ] **PayPal Vault**: the agent owner saves a payment method once
- [ ] **PayPal Orders v2**: buy a pack in Direct mode (`CAPTURE`) and Escrow mode (`AUTHORIZE`)
- [ ] **Escrow close**: partial capture for good answers + void the rest
- [ ] Signed receipts per call + a public `/receipts` page (AG Grid)
- [ ] Demo buyer agent (OpenAI Agents SDK + MCP tools) that runs the whole loop by itself
- [ ] Demo seller API: "Deal Finder", built on **Channel3**

### Should have (P1)
- [ ] MCP server: `find_api`, `get_promise`, `buy_pack`, `call_api`, `close_pack`
- [ ] Seller dashboard with AG Grid + AG Studio charts + AI assistant
- [ ] Wallet budget enforcement + spend view for the agent owner
- [ ] API health: repeated failures → status `down` → stop selling; status page
- [ ] APIMatic: inferred OpenAPI → SDK + docs portal link on each listing
- [ ] Seller payouts via the **Payouts API** (or multiparty `platform_fees` if sandbox allows)

### Nice to have (P2)
- [ ] LLM judge on top of schema checks ("does this answer the question?")
- [ ] DNS TXT ownership verification
- [ ] Bryntum timeline: pack lifecycle (authorize → calls → capture → payout)
- [ ] Auto-refund of unused Direct-mode credits when an API goes down

### Out of scope
Real money / live PayPal, multi-currency, seller KYC, rate-limit tiers, a mobile app.

---

## 6. PayPal integration (what judges should see)

| PayPal feature | Where it's used | Why it's meaningful |
|---|---|---|
| **Vault (save payment method)** | Agent owner setup | The human approves once and the agent spends on its own: **agentic commerce** |
| **Orders v2 `CAPTURE`** | Direct-mode pack purchase | Instant settlement for trusted sellers |
| **Orders v2 `AUTHORIZE` → partial capture → void** | Escrow-mode packs | **Pay only for delivered value**, with no smart contract |
| **Refunds API** | API outage on Direct packs | Trust for agent buyers |
| **Payouts API / multiparty `platform_fees`** | Seller earnings, 3% platform fee | A complete marketplace money loop |
| **PayPal Agent Toolkit / MCP** | Demo buyer agent | The agent uses PayPal through standard agent tooling |
| **Webhooks** | Capture/void/refund events → ledger | The ledger stays in sync with PayPal |

**Why packs, not per-call charges:** PayPal's fixed fee per transaction is larger than a $0.02 call. Packs spread it across 100 calls.

## 7. AI usage

| Where | What the AI does |
|---|---|
| Onboarding | Probes the API, writes the listing, generates OpenAPI, **drafts the promise schema**, suggests a price |
| Discovery | Semantic search over listings (`find_api` MCP tool) |
| Verification (P2) | LLM judge for answers that pass the schema but are wrong |
| Buyer agent | Autonomous goal → discover → pay → call → answer |
| Seller analytics | AG Studio AI assistant ("which agents spent most this week?") |

**AI provider: OpenAI.** Three ways the AI is paid for:

| Mode | Who pays for the model | Used for | Status |
|---|---|---|---|
| **A. APIII server key** (OpenAI API key, Responses API) | APIII (platform billing, a few dollars for the whole hackathon) | Onboarding, judge, analytics Q&A, scripted demo agent | **Default, P0** |
| **B. ChatGPT app** (Apps SDK, connects to the APIII MCP server) | The user's **ChatGPT subscription** (ChatGPT itself is the buyer agent) | "Buy & call APIs from inside ChatGPT" | **P1**, needs ChatGPT developer mode |
| **C. "Sign in with ChatGPT"** (OAuth, bills the user's Plus/Pro plan) | The seller's / owner's ChatGPT plan | Onboarding AI running on the seller's own plan | **Stretch.** Limited preview, apply but don't depend on it |

All server-side AI goes through one `/lib/ai` wrapper (model from `OPENAI_MODEL` env), so the modes can be swapped.

## 8. Sponsors

| Sponsor | Integration | Priority |
|---|---|---|
| **AG Grid / AG Studio** | Seller dashboard + public `/receipts` grid + AI assistant | P1 |
| **APIMatic** | Context Plugin used while coding the PayPal calls; SDK/docs generated from the inferred OpenAPI | P1 |
| **Channel3** | The demo seller API "Deal Finder" calls Channel3 search (credits code `PAYPAL-HACKATHON-2026`) | P0 (as demo) |
| **Bryntum** | Pack lifecycle timeline | P2 |

---

## 9. Tech stack

| Layer | Choice |
|---|---|
| App + landing + dashboards | **Next.js (App Router) + TypeScript + Tailwind + shadcn/ui**, deployed on Vercel |
| Gateway | Next.js route handlers under `/v1/*` (split into a separate Hono service only if needed) |
| Database | Postgres (Neon or Supabase) + Drizzle ORM |
| Validation | Ajv (JSON Schema) + freshness check |
| Crypto | Node `crypto`: AES-256-GCM for sealed keys, Ed25519 for receipts |
| AI | OpenAI SDK (Responses API) + OpenAI Agents SDK for the demo agent; ChatGPT Apps SDK for the in-ChatGPT agent |
| Payments | PayPal REST APIs (sandbox): Orders v2, Vault v3, Payouts, Webhooks |
| Agent tooling | MCP server (TypeScript SDK) + demo agent script |
| Grids | AG Grid + AG Studio |

## 10. Data model (summary)

`sellers` · `apis` (promise_json, promise_hash, sealed_key, price, status) · `wallets` (paypal_vault_id, budget) · `packs` (mode, credits, paypal_order_id, paypal_auth_id, status) · `receipts` (verdict, hashes, signature) · `payouts`. See `ARCHITECTURE.md` §5.

## 11. Pages

| Route | Purpose |
|---|---|
| `/` | Landing: hero, problem, how it works, buyer flow, comparison, live proof, FAQ |
| `/sell` | 3-minute onboarding wizard |
| `/dashboard` | Seller dashboard (AG Grid) |
| `/wallet` | Agent owner: PayPal vault, budget, spend |
| `/apis` / `/apis/[slug]` | Catalog + listing (promise, price, status, SDKs) |
| `/receipts` | Public signed receipts |
| `/try` | Live demo: watch the buyer agent run, step by step |

---

## 12. Demo script (3 min video)

1. **(0:00) Hook:** "Agents need data. Paying for it is broken: crypto wallets, and paying for bad answers."
2. **(0:20) Seller lists in under 3 min:** paste the Deal Finder URL (built on Channel3) → AI drafts the description, promise and price → connect PayPal → publish. Show the APIMatic SDK link.
3. **(1:00) Owner sets a budget:** one PayPal approval (Vault), $20/week.
4. **(1:20) Agent runs alone:** "Find me the cheapest AirPods Pro" → `find_api` → 402 → buys an escrow pack through PayPal → calls → answer.
5. **(1:50) Promise in action:** we make the upstream return stale data → 422, **credits unchanged**.
6. **(2:10) Settlement:** close the pack → PayPal partial capture for 7 good answers, void the remainder. Show the PayPal sandbox transaction IDs.
7. **(2:30) Seller dashboard:** AG Grid with live receipts and revenue; ask the AI assistant "how much did agents spend today?"
8. **(2:50) Close:** the pitch line + comparison table.

---

## 13. Build plan

| Phase | Deliverable | Done when |
|---|---|---|
| 1. Core | Gateway + promise validator + credits with a fake payment | Curl shows pass / 422 / 503 with correct credit counts |
| 2. PayPal Direct | Orders `CAPTURE` → pack issued | A sandbox order buys 100 credits |
| 3. Vault + budget | Owner saves a payment method; agent buys without a human | The agent script buys a pack unattended |
| 4. Escrow | `AUTHORIZE` → partial capture → void | The PayPal sandbox shows the partial capture + void |
| 5. AI onboarding | URL → probe → description/promise/price → publish | The Deal Finder listing is created in < 3 min |
| 6. Demo agent + MCP | OpenAI agent + `find_api` etc.; then the same MCP server as a ChatGPT app | The full loop runs end to end (script, then inside ChatGPT) |
| 7. Dashboards | AG Grid receipts + seller dashboard + AI assistant | Live data visible |
| 8. Sponsors extra | APIMatic SDK gen, payouts, (Bryntum) | Links work in the listing |
| 9. Ship | Landing page, README, demo video, Devpost write-up | Submitted |

**Rule:** Never start phase N+1 while phase N is broken. Phases 1–4 alone are a valid Agentic Commerce submission.

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Vault "save without purchase" is not available in sandbox | Fallback: vault on the first pack purchase (buyer present), reuse it afterwards |
| Multiparty `platform_fees` needs partner approval | Fallback: capture to the platform, pay sellers with the Payouts API minus 3% |
| Authorization honor period (~3 days) | Demo packs close within minutes; document reauthorization for longer packs |
| Promise too strict / too loose | AI draft + seller edit + a "test promise" button before publishing |
| Trust ("you control the count") | Signed receipts, a public promise hash before sale, a public `/receipts` page |
| Seen as a copy of Hirakumi | Credit the inspiration; original code, brand and wording; PayPal-native escrow is our own contribution |

## 15. Submission checklist
- [ ] Public repo + README (setup, architecture diagram, sandbox credentials how-to)
- [ ] Deployed URL on Vercel
- [ ] Demo video under 3 min
- [ ] Devpost write-up: problem, solution, **how PayPal is used**, **how AI is used**, sponsor usage sections
- [ ] Channel3 API calls visible in the code
- [ ] APIMatic Context Plugin usage mentioned (+ screenshot)
- [ ] AG Grid dashboard screenshot
- [ ] Note that everything runs on the PayPal sandbox
