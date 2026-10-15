import { demoSellerKey, findDeals, getDemoMode } from "@/lib/demoSeller";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Demo seller's own API (not part of APIII). Requires x-demo-key, which the seller
 * gives to APIII once; the gateway injects it from the sealed vault.
 */
export async function GET(req: Request) {
  if (req.headers.get("x-demo-key") !== demoSellerKey()) {
    return json({ error: "unauthorized", message: "missing or wrong x-demo-key" }, 401);
  }
  const query = new URL(req.url).searchParams.get("q")?.trim() || "airpods pro";
  const mode = await getDemoMode();
  if (mode === "down") return json({ error: "service unavailable" }, 503);

  const { offers, source } = await findDeals(query);
  if (mode === "broken") return json({ query, message: "temporarily returning partial data" });

  const fetchedAt = mode === "stale" ? new Date(Date.now() - 2 * 3600_000) : new Date();
  return json({
    query,
    best: offers[0],
    offers,
    currency: "USD",
    source,
    fetched_at: fetchedAt.toISOString(),
  });
}
