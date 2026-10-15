import { handle, json, readJson } from "@/lib/http";
import { createWallet, listWallets } from "@/lib/wallets";

export const dynamic = "force-dynamic";

// Owner: create an agent wallet with a budget. Returns the wk_ key once.
export const POST = handle(async (req: Request) => {
  return json(await createWallet(await readJson(req)), 201);
});

export const GET = handle(async () => json(await listWallets()));
