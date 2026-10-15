import { searchApis } from "@/lib/apis";
import { handle, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Public catalog search for agents.
export const GET = handle(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const max = sp.get("max_price");
  return json(await searchApis({ q: sp.get("q") ?? undefined, maxPriceCents: max ? Number(max) : undefined }));
});
