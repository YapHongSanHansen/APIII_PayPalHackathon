import { handleCall } from "@/lib/gateway";
import { bearer, handle, json } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; path: string[] }> };

// The gateway: every agent call goes through here.
const proxy = handle(async (req: Request, ctx: Ctx) => {
  const { slug, path } = await ctx.params;
  const url = new URL(req.url);
  const res = await handleCall({
    packToken: bearer(req),
    slug,
    method: req.method,
    path: path.map(encodeURIComponent).join("/"),
    search: url.search,
    contentType: req.headers.get("content-type"),
    body: req.method === "GET" || req.method === "HEAD" ? null : await req.text(),
  });
  return json(res.body, res.status, res.headers);
});

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
