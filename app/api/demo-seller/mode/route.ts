import { DEMO_MODES, getDemoMode, setDemoMode, type DemoMode } from "@/lib/demoSeller";
import { ApiError, handle, json, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = handle(async () => json({ mode: await getDemoMode() }));

// Test page: make the demo seller answer ok / stale / broken / down.
export const POST = handle(async (req: Request) => {
  const { mode } = await readJson<{ mode: DemoMode }>(req);
  if (!DEMO_MODES.includes(mode)) throw new ApiError(400, "bad_mode", `mode must be one of ${DEMO_MODES.join(", ")}`);
  return json({ mode: await setDemoMode(mode) });
});
