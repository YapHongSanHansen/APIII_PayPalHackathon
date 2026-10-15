import dns from "node:dns/promises";
import net from "node:net";
import { ApiError } from "./http";

/**
 * Blocks seller URLs that point at private/internal networks.
 * Private targets are allowed in development (so the built-in demo seller on
 * localhost works) unless APIII_ALLOW_PRIVATE_UPSTREAMS=false.
 */
export function privateUpstreamsAllowed(): boolean {
  const flag = process.env.APIII_ALLOW_PRIVATE_UPSTREAMS;
  if (flag) return flag === "true";
  return process.env.NODE_ENV !== "production";
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "bad_url", `Invalid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ApiError(400, "bad_url", "Only http(s) URLs are allowed");
  }
  if (privateUpstreamsAllowed()) return url;
  if (url.protocol !== "https:") throw new ApiError(400, "bad_url", "Upstream APIs must use https");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addrs.length === 0 || addrs.some(isPrivateIp)) {
    throw new ApiError(400, "blocked_url", `Refusing to call private/internal address for ${url.hostname}`);
  }
  return url;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}
