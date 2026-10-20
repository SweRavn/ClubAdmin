// SPDX-License-Identifier: AGPL-3.0-only
// Collects all @Endpoint routes at startup and refuses to start if a route
// was declared without @Endpoint (deny by default: no undeclared routes).

import { Injectable, type OnModuleInit } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";

import { ENDPOINT_METADATA, type EndpointOptions } from "./endpoint.ts";
import { API_PREFIX, UNPREFIXED_PATHS } from "./prefix.ts";

// Set by Nest's @Controller / @Get etc.
const PATH_METADATA = "path";
const METHOD_METADATA = "method";

export interface RegisteredEndpoint extends EndpointOptions {
  /** Full path as served, e.g. /api/v1/meta/version or /health/live. */
  fullPath: string;
  controller: string;
  handler: string;
}

export class UndeclaredRouteError extends Error {
  constructor(routes: string[]) {
    super(
      `Routes without @Endpoint (every route must declare its schemas and access rule):\n${routes
        .map((r) => `  - ${r}`)
        .join("\n")}`,
    );
    this.name = "UndeclaredRouteError";
  }
}

const joinPaths = (...parts: string[]) =>
  `/${parts
    .flatMap((p) => p.split("/"))
    .filter(Boolean)
    .join("/")}`;

@Injectable()
export class EndpointRegistry implements OnModuleInit {
  private readonly discovery: DiscoveryService;
  private readonly scanner: MetadataScanner;
  private readonly reflector: Reflector;
  private endpoints: RegisteredEndpoint[] = [];

  constructor(discovery: DiscoveryService, scanner: MetadataScanner, reflector: Reflector) {
    this.discovery = discovery;
    this.scanner = scanner;
    this.reflector = reflector;
  }

  onModuleInit(): void {
    const undeclared: string[] = [];
    const endpoints: RegisteredEndpoint[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance || !wrapper.metatype) continue;
      const controllerPath =
        (Reflect.getMetadata(PATH_METADATA, wrapper.metatype) as string | undefined) ?? "";
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== "function") continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue; // not a route
        const options = this.reflector.get<EndpointOptions | undefined>(ENDPOINT_METADATA, handler);
        if (!options) {
          undeclared.push(`${wrapper.name}.${methodName}`);
          continue;
        }
        const routePath = joinPaths(controllerPath, options.path);
        const unprefixed = UNPREFIXED_PATHS.some(
          (p) => routePath === p || routePath.startsWith(`${p}/`),
        );
        endpoints.push({
          ...options,
          fullPath: unprefixed ? routePath : joinPaths(API_PREFIX, routePath),
          controller: String(wrapper.name),
          handler: methodName,
        });
      }
    }
    if (undeclared.length > 0) throw new UndeclaredRouteError(undeclared);
    this.endpoints = endpoints.sort(
      (a, b) => a.fullPath.localeCompare(b.fullPath) || a.method.localeCompare(b.method),
    );
  }

  all(): readonly RegisteredEndpoint[] {
    return this.endpoints;
  }
}
