// SPDX-License-Identifier: AGPL-3.0-only
import { loadEnvFiles } from "@clubadmin/server-kit/env";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { SECURITY_HEADERS } from "./src/server/security-headers.ts";

// Development: the repository's .env.local (pnpm dev). In production the
// environment comes from the deployment.
loadEnvFiles();

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Workspace packages are TypeScript source.
  transpilePackages: [
    "@clubadmin/shared",
    "@clubadmin/i18n",
    "@clubadmin/server-kit",
    "@clubadmin/ui",
    "@clubadmin/api-client",
  ],
  serverExternalPackages: ["ioredis"],
  typedRoutes: false,
  // Do not write an AGENTS.md into the app directory.
  agentRules: false,
  // forbidden() for API 403s (the forbidden page).
  experimental: { authInterrupts: true },
  headers() {
    return Promise.resolve([{ source: "/:path*", headers: [...SECURITY_HEADERS] }]);
  },
};

export default withNextIntl(config);
