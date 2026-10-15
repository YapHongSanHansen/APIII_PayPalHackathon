import { publishApi } from "@/lib/apis";
import { handle, json, readJson } from "@/lib/http";

// Seller step 2: publish the (edited) draft. Seals the upstream key and locks the promise hash.
export const POST = handle(async (req: Request) => {
  return json(await publishApi(await readJson(req)), 201);
});
