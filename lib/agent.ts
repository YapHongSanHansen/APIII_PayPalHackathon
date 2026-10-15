import { aiEnabled, aiModel, openai, truncate } from "./ai";
import { getApi, searchApis } from "./apis";
import { handleCall } from "./gateway";
import { ApiError } from "./http";
import { buyPack, closePack } from "./packs";

/**
 * Demo buyer agent: goal → find an API → buy a pack with PayPal (within the
 * owner's budget) → call it → close the pack. Uses OpenAI function calling when
 * OPENAI_API_KEY is set, otherwise a fixed script with the same tools.
 * Secrets (wallet key, pack tokens) stay server-side; the model never sees them.
 */
export interface AgentStep {
  kind: "thought" | "tool_call" | "tool_result" | "answer";
  name?: string;
  data: unknown;
}

const TOOLS = [
  {
    type: "function" as const,
    name: "find_api",
    description: "Search the APIII marketplace for paid APIs that can help with the task.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query", "max_price_cents"],
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'deal' or 'price'" },
        max_price_cents: { type: ["integer", "null"], description: "Max price per call in cents" },
      },
    },
  },
  {
    type: "function" as const,
    name: "buy_pack",
    description:
      "Buy a pack of calls for an API using the owner's PayPal wallet. 'escrow' holds the money and only captures good answers when the pack is closed.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "mode"],
      properties: { slug: { type: "string" }, mode: { type: "string", enum: ["escrow", "direct"] } },
    },
  },
  {
    type: "function" as const,
    name: "call_api",
    description: "Call a purchased API through the APIII gateway. Only answers that keep the seller's promise are charged.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "path"],
      properties: {
        slug: { type: "string" },
        path: { type: "string", description: "Path and query below the API base, e.g. 'deals?q=airpods pro'" },
      },
    },
  },
  {
    type: "function" as const,
    name: "close_pack",
    description: "Close the pack when done so PayPal settles: pay only for good answers, release the rest.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: { slug: { type: "string" } },
    },
  },
];

export async function runAgent(input: { goal: string; walletKey: string; appUrl: string; mode?: "escrow" | "direct" }) {
  const steps: AgentStep[] = [];
  const packs = new Map<string, { id: string; token: string }>();

  async function tool(name: string, args: any): Promise<unknown> {
    steps.push({ kind: "tool_call", name, data: args });
    let result: unknown;
    try {
      result = await runTool(name, args);
    } catch (err) {
      result = err instanceof ApiError ? { error: err.code, message: err.message, ...err.extra } : { error: (err as Error).message };
    }
    steps.push({ kind: "tool_result", name, data: result });
    return result;
  }

  async function runTool(name: string, args: any): Promise<unknown> {
    switch (name) {
      case "find_api": {
        const found = await searchApis({ q: args.query, maxPriceCents: args.max_price_cents ?? undefined });
        const results = found.length ? found : await searchApis({ maxPriceCents: args.max_price_cents ?? undefined });
        return results.slice(0, 5).map((a) => ({
          slug: a.slug,
          name: a.name,
          description: a.description,
          status: a.status,
          price_per_call_cents: a.price_per_call_cents,
          pack: a.pack,
          endpoints: a.endpoints,
          promise_requires: (a.promise.schema as any)?.required ?? [],
          freshness_sec: a.promise.maxAgeSec,
        }));
      }
      case "buy_pack": {
        const res = await buyPack({ walletKey: input.walletKey, slug: args.slug, mode: args.mode || input.mode, appUrl: input.appUrl });
        packs.set(args.slug, { id: res.pack.id, token: res.pack_token });
        return { pack: res.pack, next: res.next };
      }
      case "call_api": {
        const pack = packs.get(args.slug);
        const raw = String(args.path || "");
        const [p, ...rest] = raw.replace(/^\/+/, "").split("?");
        const search = rest.length ? "?" + new URLSearchParams(rest.join("?")).toString() : "";
        const res = await handleCall({
          packToken: pack?.token ?? null,
          slug: args.slug,
          method: "GET",
          path: p,
          search,
          contentType: null,
          body: null,
        });
        return { status: res.status, verdict: res.headers["x-apiii-verdict"], credits_left: res.headers["x-apiii-credits-left"], body: truncate(res.body, 3000) };
      }
      case "close_pack": {
        const pack = packs.get(args.slug);
        if (!pack) return { error: "no pack bought for this API in this run" };
        return closePack(pack.id, { packToken: pack.token });
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  if (!aiEnabled()) {
    steps.push({ kind: "thought", data: "No OPENAI_API_KEY: running the scripted agent with the same tools." });
    const found = (await tool("find_api", { query: "deal", max_price_cents: null })) as any[];
    const target = Array.isArray(found) ? found.find((a) => a.status === "live") : null;
    if (!target) {
      steps.push({ kind: "answer", data: "No live API found. Publish one in step 1 first." });
      return { mode: "scripted", steps };
    }
    const bought: any = await tool("buy_pack", { slug: target.slug, mode: input.mode ?? "escrow" });
    if (bought?.pack?.status !== "active") {
      steps.push({ kind: "answer", data: "Pack is not active (owner approval needed or payment failed). Stopping." });
      return { mode: "scripted", steps };
    }
    const api = await getApi(target.slug);
    const samplePath = api.samples_json[0]?.path?.split("?")[0] ?? "";
    const call: any = await tool("call_api", { slug: target.slug, path: `${samplePath}?q=${input.goal}` });
    await tool("close_pack", { slug: target.slug });
    const best = call?.body?.best;
    steps.push({
      kind: "answer",
      data: best ? `Best deal: ${best.title} for $${best.price_usd} at ${best.retailer}` : `API answered with status ${call?.status} (${call?.verdict}).`,
    });
    return { mode: "scripted", steps };
  }

  const instructions =
    "You are a shopping agent with a PayPal-funded APIII wallet (budget set by your human owner). " +
    "To answer the user's goal: find a suitable API with find_api, buy an escrow pack with buy_pack, " +
    "call it with call_api (use the endpoint paths from find_api and put the user's request in the query), " +
    "then ALWAYS close_pack so PayPal only captures good answers. If buy_pack needs owner approval or fails, stop and explain. " +
    "Finish with a short answer for the user.";

  let res: any = await openai().responses.create({ model: aiModel(), instructions, input: input.goal, tools: TOOLS as any });
  for (let i = 0; i < 8; i++) {
    const calls = (res.output ?? []).filter((o: any) => o.type === "function_call");
    if (!calls.length) break;
    const outputs = [];
    for (const c of calls) {
      const result = await tool(c.name, JSON.parse(c.arguments || "{}"));
      outputs.push({ type: "function_call_output", call_id: c.call_id, output: JSON.stringify(result) });
    }
    res = await openai().responses.create({
      model: aiModel(),
      instructions,
      previous_response_id: res.id,
      input: outputs as any,
      tools: TOOLS as any,
    });
  }
  // Safety net: never leave an escrow hold open if the model forgot to close.
  for (const [slug] of packs) {
    const closed = steps.some((s) => s.kind === "tool_call" && s.name === "close_pack" && (s.data as any).slug === slug);
    if (!closed) await tool("close_pack", { slug });
  }
  steps.push({ kind: "answer", data: res.output_text || "(no final answer)" });
  return { mode: "openai", model: aiModel(), steps };
}
