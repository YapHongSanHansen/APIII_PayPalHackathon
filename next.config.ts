import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  async rewrites() {
    return [{ source: "/.well-known/apiii.json", destination: "/api/manifest" }];
  },
};

export default nextConfig;
