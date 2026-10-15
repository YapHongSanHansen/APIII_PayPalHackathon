import { aiEnabled, aiModel } from "@/lib/ai";
import { db } from "@/lib/db";
import { getDemoMode } from "@/lib/demoSeller";
import { appUrl, handle, json } from "@/lib/http";
import { paypalMode } from "@/lib/paypal";
import { receiptStats } from "@/lib/receipts";
import { privateUpstreamsAllowed } from "@/lib/ssrf";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  const d = await db();
  return json({
    app_url: appUrl(req),
    paypal: { mode: paypalMode(), api_base: process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com", webhook_verification: Boolean(process.env.PAYPAL_WEBHOOK_ID) },
    openai: { enabled: aiEnabled(), model: aiEnabled() ? aiModel() : null },
    database: d.kind,
    channel3: Boolean(process.env.CHANNEL3_API_KEY),
    demo_seller_mode: await getDemoMode(),
    private_upstreams_allowed: privateUpstreamsAllowed(),
    receipts: await receiptStats(),
  });
});
