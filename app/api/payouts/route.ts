import { handle, json } from "@/lib/http";
import { listPayouts, runPayouts } from "@/lib/payouts";

export const dynamic = "force-dynamic";

// Pay sellers what agents paid for good answers, minus the 3% platform fee.
export const POST = handle(async () => json(await runPayouts()));

export const GET = handle(async () => json(await listPayouts()));
