import { probeAndDraft } from "@/lib/apis";
import { handle, json, readJson } from "@/lib/http";

// Seller step 1: probe the API and let AI draft the listing, promise and price.
export const POST = handle(async (req: Request) => {
  const body = await readJson(req);
  return json(await probeAndDraft(body));
});
