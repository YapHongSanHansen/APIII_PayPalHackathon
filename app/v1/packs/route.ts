import { appUrl, bearer, handle, json, readJson } from "@/lib/http";
import { buyPack } from "@/lib/packs";

// Agent buys a pack: Authorization: Bearer <wk_ wallet key>, body { api, mode }.
export const POST = handle(async (req: Request) => {
  const body = await readJson<{ api: string; mode?: string }>(req);
  const res = await buyPack({ walletKey: bearer(req), slug: body.api, mode: body.mode, appUrl: appUrl(req) });
  return json(res, res.pack.status === "active" ? 201 : 202);
});
