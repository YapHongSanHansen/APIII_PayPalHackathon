import { appUrl } from "@/lib/http";
import { completeVault } from "@/lib/wallets";

export const dynamic = "force-dynamic";

// PayPal redirects here after the owner approves saving PayPal.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const base = appUrl(req);
  try {
    await completeVault(id, url.searchParams.get("approval_token_id"));
    return Response.redirect(`${base}/?wallet=${id}&vault=connected`, 302);
  } catch (err) {
    return Response.redirect(`${base}/?wallet=${id}&vault=error&message=${encodeURIComponent((err as Error).message)}`, 302);
  }
}
