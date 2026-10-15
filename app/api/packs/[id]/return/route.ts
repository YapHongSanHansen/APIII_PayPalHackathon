import { appUrl } from "@/lib/http";
import { approvePack } from "@/lib/packs";

export const dynamic = "force-dynamic";

// PayPal redirects here after the owner approves a pack purchase (no-vault fallback).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pack = await approvePack(id);
  return Response.redirect(`${appUrl(req)}/?pack=${id}&approved=${pack.status === "active" ? 1 : 0}`, 302);
}
