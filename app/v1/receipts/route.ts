import { handle, json } from "@/lib/http";
import { listReceipts } from "@/lib/receipts";

export const dynamic = "force-dynamic";

// Public, signed log of every paid call and its verdict.
export const GET = handle(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  return json(await listReceipts({ packId: sp.get("pack"), apiSlug: sp.get("api"), limit: Number(sp.get("limit") || 100) }));
});
