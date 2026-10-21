// SPDX-License-Identifier: AGPL-3.0-only
import { loadEnvFiles } from "@clubadmin/server-kit/env";
import type { NextConfig } from "next";

// Development: the repository's .env.local (pnpm dev). In production the
// environment comes from the deployment.
loadEnvFiles();

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Workspace packages are TypeScript source.
  transpilePackages: ["@clubadmin/shared", "@clubadmin/i18n", "@clubadmin/server-kit"],
  serverExternalPackages: ["ioredis"],
  typedRoutes: false,
  // Do not write an AGENTS.md into the app directory.
  agentRules: false,
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ]);
  },
};

export default config;
