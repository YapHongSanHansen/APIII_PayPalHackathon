import { handle, json } from "@/lib/http";
import { packView } from "@/lib/packs";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return json(await packView(id));
});
