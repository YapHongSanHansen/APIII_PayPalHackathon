import { bearer, handle, json } from "@/lib/http";
import { closePack } from "@/lib/packs";

// Settle the pack. Bearer may be the pack token (pk_) or the owning wallet key (wk_).
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const token = bearer(req);
  return json(await closePack(id, token?.startsWith("pk_") ? { packToken: token } : { walletKey: token }));
});
