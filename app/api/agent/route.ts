import { runAgent } from "@/lib/agent";
import { ApiError, appUrl, handle, json, readJson } from "@/lib/http";

export const maxDuration = 60;

// Run the demo buyer agent with a wallet key and a goal.
export const POST = handle(async (req: Request) => {
  const body = await readJson<{ goal: string; walletKey: string; mode?: "escrow" | "direct" }>(req);
  if (!body.goal || !body.walletKey) throw new ApiError(400, "missing_field", "goal and walletKey are required");
  return json(await runAgent({ ...body, appUrl: appUrl(req) }));
});
