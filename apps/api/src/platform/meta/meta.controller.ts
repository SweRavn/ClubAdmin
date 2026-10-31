// SPDX-License-Identifier: AGPL-3.0-only
// Version, source and client endpoints. /meta/source is required by AGPL-3.0
// section 13: users of the network service can get its exact source.
// /meta/client tells installed apps which versions are supported and what
// this server can do (ADR 0029).

import {
  API_MAJOR_VERSION,
  type AppSupport,
  type ClientInfoResponse,
  ClientInfoResponseSchema,
  compareVersions,
  parseFeatureFlags,
  SERVER_FEATURES,
  type SourceResponse,
  SourceResponseSchema,
  type VersionResponse,
  VersionResponseSchema,
} from "@clubadmin/shared";
import { Controller, Header, Inject } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { Endpoint } from "../http/endpoint.ts";

/** URL of the exact source tree for a commit (GitHub-style `/tree/<commit>`). */
export function sourceUrlFor(baseUrl: string, commit: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return commit === "unknown" ? base : `${base}/tree/${commit}`;
}

/** The app versions a server supports, from configuration (per-platform values win). */
export function appSupport(config: ApiConfig, platform: "IOS" | "ANDROID"): AppSupport {
  const minimum = config[`MOBILE_MIN_VERSION_${platform}`] ?? config.MOBILE_MIN_VERSION;
  const recommended =
    config[`MOBILE_RECOMMENDED_VERSION_${platform}`] ?? config.MOBILE_RECOMMENDED_VERSION;
  return {
    minimumVersion: minimum,
    // A recommendation below the minimum would be meaningless.
    recommendedVersion: compareVersions(recommended, minimum) < 0 ? minimum : recommended,
    storeUrl: config[`MOBILE_STORE_URL_${platform}`] ?? null,
  };
}

@Controller("meta")
export class MetaController {
  private readonly config: ApiConfig;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.config = config;
  }

  @Endpoint({
    method: "GET",
    path: "version",
    summary: "Running version",
    tags: ["meta"],
    access: { public: true },
    response: VersionResponseSchema,
  })
  version(): VersionResponse {
    return { version: this.config.APP_VERSION, commit: this.config.GIT_COMMIT };
  }

  @Endpoint({
    method: "GET",
    path: "source",
    summary: "Where to get the source code of the running version (AGPL-3.0 section 13)",
    tags: ["meta"],
    access: { public: true },
    response: SourceResponseSchema,
  })
  source(): SourceResponse {
    return {
      url: sourceUrlFor(this.config.SOURCE_URL, this.config.GIT_COMMIT),
      license: "AGPL-3.0-only",
      commit: this.config.GIT_COMMIT,
    };
  }

  @Endpoint({
    method: "GET",
    path: "client",
    summary: "Supported app versions, feature flags and server capabilities (ADR 0029)",
    tags: ["meta"],
    access: { public: true },
    response: ClientInfoResponseSchema,
  })
  @Header("Cache-Control", "public, max-age=300")
  client(): ClientInfoResponse {
    return {
      apiVersion: API_MAJOR_VERSION,
      serverVersion: this.config.APP_VERSION,
      apps: { ios: appSupport(this.config, "IOS"), android: appSupport(this.config, "ANDROID") },
      // Push only with a push provider (P1.7); the app then asks for permission.
      features: SERVER_FEATURES.filter(
        (f) => f !== "notifications.push" || this.config.PUSH_PROVIDER !== undefined,
      ),
      flags: parseFeatureFlags(this.config.FEATURE_FLAGS),
    };
  }
}
