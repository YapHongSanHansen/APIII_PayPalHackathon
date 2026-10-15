import { appUrl } from "@/lib/http";
import { cancelPack } from "@/lib/packs";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await cancelPack(id);
  return Response.redirect(`${appUrl(req)}/?pack=${id}&approved=0`, 302);
}
