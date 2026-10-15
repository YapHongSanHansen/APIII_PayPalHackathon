import { handle, json } from "@/lib/http";
import { listPacks } from "@/lib/packs";

export const dynamic = "force-dynamic";

export const GET = handle(async () => json(await listPacks()));
