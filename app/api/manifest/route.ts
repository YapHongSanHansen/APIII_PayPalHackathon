import { searchApis } from "@/lib/apis";
import { handle, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Served at /.well-known/apiii.json (see next.config.ts) for agent discovery.
export const GET = handle(async () => {
  const apis = await searchApis({});
  return json({
    name: "APIII",
    description: "APIs for AI agents. Pay with PayPal, only for answers that keep the seller's promise.",
    endpoints: {
      catalog: "/v1/apis?q={query}&max_price={cents}",
      listing: "/v1/apis/{slug}",
      call: "/v1/apis/{slug}/{path}",
      buy_pack: "POST /v1/packs",
      pack: "/v1/packs/{id}",
      close_pack: "POST /v1/packs/{id}/close",
      receipts: "/v1/receipts",
      receipt_public_key: "/v1/receipts/public-key",
    },
    payment: { provider: "paypal", settlement: ["direct", "escrow"], unit: "pack" },
    apis: apis.map((a) => ({ slug: a.slug, name: a.name, price_per_call_cents: a.price_per_call_cents, status: a.status })),
  });
});
