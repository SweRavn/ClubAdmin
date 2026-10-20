// SPDX-License-Identifier: AGPL-3.0-only
// Version and source endpoints. /meta/source is required by AGPL-3.0
// section 13: users of the network service can get its exact source.

import {
  type SourceResponse,
  SourceResponseSchema,
  type VersionResponse,
  VersionResponseSchema,
} from "@clubadmin/shared";
import { Controller, Inject } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { Endpoint } from "../http/endpoint.ts";

/** URL of the exact source tree for a commit (GitHub-style `/tree/<commit>`). */
export function sourceUrlFor(baseUrl: string, commit: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return commit === "unknown" ? base : `${base}/tree/${commit}`;
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
}
