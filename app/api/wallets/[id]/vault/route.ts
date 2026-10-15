import { appUrl, handle, json } from "@/lib/http";
import { startVault } from "@/lib/wallets";

// Owner: start "save PayPal" (Vault v3 setup token). Open approveUrl to approve.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return json(await startVault(id, appUrl(req)));
});
