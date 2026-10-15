import { getApi, publicListing } from "@/lib/apis";
import { handle, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Listing incl. the promise and its hash (published before any sale).
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  return json(publicListing(await getApi(slug)));
});
