import { handle, json, readJson } from "@/lib/http";
import { getWallet, publicWallet, setWalletActive } from "@/lib/wallets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  return json(publicWallet(await getWallet(id)));
});

// Owner: pause / resume the agent's spending.
export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await readJson<{ active: boolean }>(req);
  return json(await setWalletActive(id, Boolean(body.active)));
});
