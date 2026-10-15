# PayPal AI Hackathon: Target Prizes & Sponsors

Hackathon: https://paypalaihackathon.devpost.com/

**Project concept:** A platform where anyone can list and sell their API in about 3 minutes. The buyers are **AI agents**: they discover, pay for, and call APIs on their own.

> Prize amounts and rules below were copied from the pasted summary. Before submitting, check each sponsor's exact judging criteria on Devpost.

---

## 1. PayPal (main prizes, required for everyone)

**Rule:** The project must meaningfully use **both PayPal and AI**. There are no tracks.

| Prize | Amount |
|---|---|
| 1st place | $12,000 |
| 2nd place | $8,000 |
| 3rd place | $5,000 |
| Best Use of PayPal + AI | $5,000 |
| **Best Use of Agentic Commerce** | $5,000 (our main target) |

You don't need any sponsor tool to win these, but the PayPal integration has to be central to the project.

---

## 2. Sponsors with stackable prizes

### AG Grid: biggest sponsor pot
- **What they make:** A high-performance data grid/table library for web apps. For this event they're pushing **AG Studio**, which adds self-serve dashboards, drag-and-drop charts and an AI assistant to your app.
- **Prizes:** $5,000 (1st), $2,000 (2nd), $1,000 each for three 3rd-place winners
- **Fit for us:** ⭐⭐⭐ Strong
- **How we use it:** The seller dashboard. Show every API call, which agent made it, revenue, refunds and payouts in AG Grid. Add AG Studio charts and its AI assistant so sellers can ask things like *"Which agents spent the most this week?"* or *"Which endpoint fails most?"*

### APIMatic
- **What they make:** SDKs and docs generated from API specs. Their angle for this event is a **Context Plugin** that gives your coding agent PayPal context, so it writes correct PayPal API calls.
- **Prizes:** $1,000 cash for 3 winners, plus 6 months of the APIMatic business subscription
- **Fit for us:** ⭐⭐⭐ Strong. APIMatic's core product (spec → SDKs + docs) matches "sell your API in 3 minutes"
- **How we use it:**
  1. **While building:** Use the APIMatic Context Plugin in our coding agent to write the PayPal integration (Orders, Payouts, Vault). Say so in the submission.
  2. **In the product:** When a seller uploads an OpenAPI spec, call APIMatic to generate SDKs and a docs portal for their API automatically.

### Bryntum
- **What they make:** JavaScript UI components for scheduling, Gantt charts, calendars and task boards.
- **Prize:** $1,000 cash, 3 winners
- **Fit for us:** ⭐ Weak or a stretch
- **Possible uses:**
  - A payout calendar showing when each seller's PayPal payouts settle
  - A Scheduler timeline showing agent usage sessions or rate-limit windows per API key
  - Calendar views for subscription renewals and credit top-ups
- **Recommendation:** Treat it as optional. Add it only if the core is done.

### Channel3
- **What they make:** A product-data API for AI shopping. One API returns clean, normalized product data (titles, images, prices, variants, availability, buy links) across 100M+ products from 25,000+ retailers.
- **Rule:** Your project must actually **call** the Channel3 API. Only mentioning it doesn't qualify.
- **Free credits:** 20,000 API credits with promo code `PAYPAL-HACKATHON-2026`
- **Prize:** $1,500 cash, 1 winner
- **Fit for us:** ⭐⭐ Medium. Works well as part of the demo story.
- **How we use it:** For the demo, a seller lists an API built on top of Channel3 (for example a "best deal finder" or "price comparison" API). A buyer shopping agent then finds that API on our marketplace, pays for it with PayPal, and calls it. This links Channel3 to the **Agentic Commerce** prize.

---

## 3. Priority order

| Priority | Target | Why |
|---|---|---|
| P0 | PayPal main + Agentic Commerce + PayPal+AI | This is the core of the project |
| P1 | AG Grid | Biggest sponsor pot, and the seller dashboard needs it anyway |
| P1 | APIMatic | Natural fit with spec → SDK/docs |
| P2 | Channel3 | Use it as the demo seller's API |
| P3 | Bryntum | Only if there's time left |
