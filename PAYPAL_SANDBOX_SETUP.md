# PayPal Sandbox Setup: What to Prepare

Checklist to get ready before coding APIII on the PayPal sandbox. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how each piece is used.

> Dashboard menu names change from time to time. If a label below doesn't match, look for the closest equivalent on https://developer.paypal.com. Also check the hackathon's Devpost **Resources** page; PayPal sometimes provides hackathon-specific sandbox help or contacts.

---

## 1. Accounts

- [ ] **PayPal developer account**: log in at https://developer.paypal.com with a real PayPal account (a Business account is recommended, but a personal one works for sandbox)
- [ ] Switch the dashboard toggle to **Sandbox**

## 2. Sandbox test accounts

Go to **Testing Tools → Sandbox Accounts → Create account**. Make one per role in the demo:

| Sandbox account | Type | Role in APIII | Notes |
|---|---|---|---|
| `platform@…` | **Business** | APIII itself (receives funds, takes the 3% fee, sends payouts) | Give it a **large balance** (e.g. $5,000) so Payouts work |
| `seller-dealfinder@…` | **Business** | Demo seller (Deal Finder on Channel3) | Gets payouts / is payee in multiparty |
| `seller-2@…` | Business | Second seller (makes the catalog and dashboard look real) | Optional |
| `owner-alice@…` | **Personal** | Agent owner who vaults PayPal and sets a budget | Give it a balance + a sandbox card |
| `owner-bob@…` | Personal | Second agent owner (for multi-agent dashboard data) | Optional |

- [ ] Write down each account's **email + password** (click the account → View/Edit). You'll log in with these on the sandbox approval pages.
- [ ] Generate test cards with **Testing Tools → Credit Card Generator** if you want card-based payments.

## 3. REST app (API credentials)

**Apps & Credentials → Create App** (Sandbox):
- [ ] Name: `APIII`
- [ ] Linked sandbox account: **`platform@…`** (the business account)
- [ ] App type: **Platform** if it's offered (needed for multiparty / partner onboarding); otherwise Merchant
- [ ] Copy the **Client ID** and **Secret**

**App feature settings**: turn these on (names may differ slightly):
- [ ] Accept payments (Orders)
- [ ] **Vault / Save payment methods** (for owner wallets)
- [ ] **Payouts** (for seller earnings)
- [ ] Log in with PayPal (optional: seller sign-in / merchant ID capture)
- [ ] Future payments / billing agreements if listed (helps merchant-initiated vault charges)

## 4. Webhooks

You need a **public HTTPS URL**, either your Vercel preview URL or a tunnel during local dev:
- [ ] Install a tunnel: `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`
- [ ] In the app → **Webhooks → Add webhook** → `https://<public-url>/v1/paypal/webhook`
- [ ] Subscribe to:
  - `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.ORDER.COMPLETED`
  - `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`
  - `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`
  - `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED`
  - `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED`
- [ ] Copy the **Webhook ID** (needed to verify signatures)
- [ ] Use **Testing Tools → Webhooks Simulator** to send test events

## 5. Environment variables

`.env.local` (never commit; make sure `.env*` is in `.gitignore`):

```bash
# PayPal sandbox
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
PAYPAL_WEBHOOK_ID=
PAYPAL_PLATFORM_MERCHANT_ID=        # platform@ sandbox account's merchant ID (Account info)
PAYPAL_PARTNER_ATTRIBUTION_ID=      # BN code, only if you get multiparty/partner access

# APIII
APIII_SEAL_KEY=                     # 32 random bytes, base64: openssl rand -base64 32
APIII_RECEIPT_SK=                   # Ed25519 private key (generate in phase 1)
APP_URL=http://localhost:3000       # used for PayPal return/cancel URLs

# Other services
OPENAI_API_KEY=                     # platform.openai.com key (NOT a ChatGPT subscription)
OPENAI_MODEL=                       # main model for onboarding + agent
OPENAI_MODEL_SMALL=                 # cheap model for the judge
DATABASE_URL=
CHANNEL3_API_KEY=                   # promo code PAYPAL-HACKATHON-2026
```

---

## 6. Smoke tests: run these BEFORE writing app code

These prove that the four risky PayPal features in `PROJECT.md` §14 actually work in sandbox. Use Git Bash (curl) or Postman (PayPal publishes an official Postman collection).

### 6.1 Get an access token
```bash
TOKEN=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
  -d grant_type=client_credentials \
  "$PAYPAL_API_BASE/v1/oauth2/token" | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
echo $TOKEN
```

### 6.2 Escrow: AUTHORIZE → partial capture → release ✅ critical
```bash
# 1) create order with intent AUTHORIZE ($2.00 = 100 calls × $0.02)
curl -s -X POST "$PAYPAL_API_BASE/v2/checkout/orders" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"intent":"AUTHORIZE",
       "purchase_units":[{"amount":{"currency_code":"USD","value":"2.00"}}],
       "payment_source":{"paypal":{"experience_context":{
          "return_url":"https://example.com/return","cancel_url":"https://example.com/cancel"}}}}'
# → open the "payer-action" link, log in as owner-alice@ sandbox, approve

# 2) authorize
curl -s -X POST "$PAYPAL_API_BASE/v2/checkout/orders/<ORDER_ID>/authorize" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"
# → note purchase_units[0].payments.authorizations[0].id

# 3) partial capture: 7 good answers × $0.02 = $0.14, release the rest
curl -s -X POST "$PAYPAL_API_BASE/v2/payments/authorizations/<AUTH_ID>/capture" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"amount":{"currency_code":"USD","value":"0.14"},"final_capture":true}'

# 4) (separate test) void a fresh authorization with 0 good answers
curl -s -X POST "$PAYPAL_API_BASE/v2/payments/authorizations/<AUTH_ID>/void" \
  -H "Authorization: Bearer $TOKEN"
```
**Pass if:** the capture returns `COMPLETED` for $0.14, and the authorization shows the remaining amount released.

### 6.3 Vault: save PayPal without a purchase ✅ critical
```bash
# 1) setup token
curl -s -X POST "$PAYPAL_API_BASE/v3/vault/setup-tokens" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "PayPal-Request-Id: $(date +%s)" \
  -d '{"payment_source":{"paypal":{"usage_type":"MERCHANT",
        "experience_context":{"return_url":"https://example.com/return",
                              "cancel_url":"https://example.com/cancel"}}}}'
# → open the "approve" link, log in as owner-alice@, approve

# 2) exchange for a payment token (this id = vault_id stored on the wallet)
curl -s -X POST "$PAYPAL_API_BASE/v3/vault/payment-tokens" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "PayPal-Request-Id: $(date +%s)" \
  -d '{"payment_source":{"token":{"id":"<SETUP_TOKEN_ID>","type":"SETUP_TOKEN"}}}'

# 3) agent-style purchase with NO human approval, using the vault id
curl -s -X POST "$PAYPAL_API_BASE/v2/checkout/orders" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "PayPal-Request-Id: $(date +%s)" \
  -d '{"intent":"AUTHORIZE",
       "purchase_units":[{"amount":{"currency_code":"USD","value":"2.00"}}],
       "payment_source":{"paypal":{"vault_id":"<PAYMENT_TOKEN_ID>"}}}'
```
**Pass if:** step 3 comes back already approved or authorized **without** a payer-action link. That is the moment the agent pays by itself.
**If it fails:** use the fallback, which is to vault during the first purchase with `"attributes":{"vault":{"store_in_vault":"ON_SUCCESS","usage_type":"MERCHANT"}}` inside `payment_source.paypal`.

### 6.4 Payouts: pay a seller
```bash
curl -s -X POST "$PAYPAL_API_BASE/v1/payments/payouts" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sender_batch_header":{"sender_batch_id":"test-'$(date +%s)'",
        "email_subject":"APIII earnings"},
       "items":[{"recipient_type":"EMAIL",
                 "amount":{"value":"0.14","currency":"USD"},
                 "receiver":"seller-dealfinder@<your-sandbox-domain>"}]}'
```
**Pass if:** the batch status becomes `SUCCESS` (check with `GET /v1/payments/payouts/<batch_id>`).

### 6.5 Multiparty platform fee (optional, P1)
```bash
# Order where the seller is payee and APIII takes 3%
"purchase_units":[{"amount":{"currency_code":"USD","value":"2.00"},
  "payee":{"merchant_id":"<SELLER_MERCHANT_ID>"},
  "payment_instruction":{"platform_fees":[{"amount":{"currency_code":"USD","value":"0.06"}}]}}]
```
**If it errors** (e.g. permission or not-enabled errors): skip multiparty and use 6.4 Payouts instead. That's already the documented fallback.

### Results log
| Test | Result | Notes |
|---|---|---|
| 6.2 Authorize + partial capture + void | ☐ | |
| 6.3 Vault without purchase + unattended charge | ☐ | |
| 6.4 Payouts | ☐ | |
| 6.5 Multiparty platform fees | ☐ | |
| Webhook received + signature verified | ☐ | |

---

## 7. Agent tooling (nice to have)

- [ ] **PayPal Agent Toolkit / MCP server**: configure it with the sandbox credentials so the demo agent can use PayPal tools (mention this in the submission)
- [ ] **APIMatic Context Plugin**: install it in your coding agent before writing `/lib/paypal` (screenshot it for the APIMatic prize)

## 8. Other services to prepare (non-PayPal)

| Service | What you need |
|---|---|
| OpenAI | API key from platform.openai.com with a few dollars of credit (separate from ChatGPT Plus/Pro billing) |
| ChatGPT (P1) | Plus/Pro account with **developer mode** on (Settings → Connectors) to add APIII as a ChatGPT app |
| "Sign in with ChatGPT" (stretch) | Apply for access; limited preview, don't depend on it |
| Channel3 | Account + API key, redeem `PAYPAL-HACKATHON-2026` (20k credits) |
| Postgres | Neon or Supabase project → `DATABASE_URL` |
| Vercel | Account + project linked to this repo (gives a stable public URL for webhooks) |
| AG Grid | Check whether AG Studio / Enterprise needs a trial license key for the hackathon |
| APIMatic | Account (for SDK/docs generation + Context Plugin) |
| GitHub | Public repo for submission |

---

## 9. Sandbox gotchas

- Sandbox is **slower and sometimes flaky**. Add retries, and don't demo live without a recorded backup.
- Always send a **`PayPal-Request-Id`** header on create/capture calls (idempotency), so retries don't double-charge.
- **Authorizations expire**: honor period about 3 days. Close demo packs quickly.
- **Amounts are strings** with 2 decimals (`"0.14"`). Store cents as integers in your database.
- Sandbox approval pages need you to **log in as the sandbox personal account**, not your real PayPal.
- Never put real credentials or real PayPal accounts anywhere in the code or the demo.
