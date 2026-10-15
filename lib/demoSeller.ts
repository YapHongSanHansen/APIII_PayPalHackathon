import { one, q } from "./db";

/**
 * "Deal Finder": the demo seller API. It searches products via Channel3 when
 * CHANNEL3_API_KEY is set (falls back to sample data otherwise). The test page can
 * switch it into a failure mode to show that agents aren't charged for bad answers.
 */
export type DemoMode = "ok" | "stale" | "broken" | "down";
export const DEMO_MODES: DemoMode[] = ["ok", "stale", "broken", "down"];

export function demoSellerKey(): string {
  return process.env.DEMO_SELLER_KEY || "demo-secret-key";
}

export async function getDemoMode(): Promise<DemoMode> {
  const row = await one<{ value: DemoMode }>("SELECT value FROM kv WHERE key = 'demo_mode'");
  return row?.value ?? "ok";
}

export async function setDemoMode(mode: DemoMode) {
  await q(
    "INSERT INTO kv (key, value) VALUES ('demo_mode', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify(mode)],
  );
  return mode;
}

interface Offer {
  title: string;
  price_usd: number;
  retailer: string;
  url: string;
  image?: string;
}

export async function findDeals(query: string): Promise<{ offers: Offer[]; source: string }> {
  if (process.env.CHANNEL3_API_KEY) {
    try {
      return { offers: await channel3Search(query), source: "channel3" };
    } catch (err) {
      return { offers: mockOffers(query), source: `mock (channel3 error: ${(err as Error).message})` };
    }
  }
  return { offers: mockOffers(query), source: "mock (set CHANNEL3_API_KEY for live data)" };
}

// Endpoint and response shape are configurable because they must be checked against
// Channel3's current docs. Parsing is deliberately loose.
async function channel3Search(query: string): Promise<Offer[]> {
  const url = process.env.CHANNEL3_API_URL || "https://api.trychannel3.com/v0/search";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.CHANNEL3_API_KEY! },
    body: JSON.stringify({ query, limit: 10 }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: any = await res.json();
  const items: any[] = Array.isArray(data) ? data : data.products ?? data.results ?? data.data ?? [];
  const offers: Offer[] = [];
  for (const p of items) {
    const offer = Array.isArray(p.offers) ? p.offers[0] : undefined;
    const price = Number(offer?.price?.price ?? offer?.price ?? p.price?.price ?? p.price?.amount ?? p.price);
    if (!Number.isFinite(price)) continue;
    offers.push({
      title: String(p.title ?? p.name ?? "Untitled product"),
      price_usd: price,
      retailer: String(offer?.domain ?? offer?.merchant ?? p.merchant ?? p.retailer ?? p.brand ?? "unknown"),
      url: String(offer?.url ?? p.url ?? p.buy_url ?? p.link ?? ""),
      image: p.image_url ?? p.image ?? p.images?.[0],
    });
  }
  if (!offers.length) throw new Error("no priced products in response");
  return offers.sort((a, b) => a.price_usd - b.price_usd);
}

function mockOffers(query: string): Offer[] {
  const seed = [...query].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const retailers = ["Shoply", "MegaMart", "BuyRight", "Gadgetry", "PriceHub"];
  const base = 20 + (seed % 180);
  return retailers
    .map((r, i) => ({
      title: `${query} (sample listing ${i + 1})`,
      price_usd: Math.round((base * (0.85 + ((seed >> i) % 30) / 100)) * 100) / 100,
      retailer: r,
      url: `https://example.com/${r.toLowerCase()}/${encodeURIComponent(query)}`,
    }))
    .sort((a, b) => a.price_usd - b.price_usd);
}
