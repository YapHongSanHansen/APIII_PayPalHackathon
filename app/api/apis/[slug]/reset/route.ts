import { resetApi } from "@/lib/apis";
import { handle, json } from "@/lib/http";

// Seller: mark the API live again after fixing an outage.
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  return json(await resetApi(slug));
});
