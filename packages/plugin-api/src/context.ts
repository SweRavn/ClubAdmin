// SPDX-License-Identifier: AGPL-3.0-only
// The context the host gives every call (ADR 0051 decision 3): the club, its
// validated configuration and decrypted secrets, a clock, a logger that
// refuses personal data, an HTTP client limited to the manifest's hosts and
// a small key-value state per club and plugin. A plugin never gets a
// database connection or anything else of the host's.

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface PluginClub {
  id: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** IANA time zone. */
  timeZone: string;
  /** BCP 47, e.g. sv-SE. */
  locale: string;
}

/** Field values a log line may carry: IDs, codes, numbers and booleans, never names or free text. */
export type LogValue = string | number | boolean | null;

export interface PluginLogger {
  info: (event: string, fields?: Record<string, LogValue>) => void;
  warn: (event: string, fields?: Record<string, LogValue>) => void;
}

export interface PluginHttpRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  /** A string body (JSON or XML, as the remote service wants). */
  body?: string;
}

export interface PluginHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface PluginHttp {
  /** Only `https://` URLs to the manifest's `network` hosts; anything else throws. */
  request: (url: string, init?: PluginHttpRequest) => Promise<PluginHttpResponse>;
}

export interface PluginState {
  get: (key: string) => Promise<JsonValue | null>;
  set: (key: string, value: JsonValue) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

export interface PluginContext {
  club: PluginClub;
  /** Validated against the manifest's `config`. */
  config: Readonly<Record<string, string | number | boolean>>;
  /** The manifest's `secrets`, decrypted for this call. */
  secrets: Readonly<Record<string, string>>;
  now: () => Date;
  log: PluginLogger;
  http: PluginHttp;
  state: PluginState;
}

/** Thrown by the restricted HTTP client for an undeclared host or a non-HTTPS URL. */
export class PluginNetworkError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`host not declared: ${host}`);
    this.host = host;
    this.name = "PluginNetworkError";
  }
}

/** An HTTP client that only reaches the declared hosts over HTTPS. */
export function restrictedHttp(
  network: readonly string[],
  send: (url: string, init: PluginHttpRequest) => Promise<PluginHttpResponse>,
  onRefused?: (host: string) => void,
): PluginHttp {
  const allowed = new Set(network);
  return {
    async request(url, init = {}) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        onRefused?.("invalid-url");
        throw new PluginNetworkError("invalid-url");
      }
      if (parsed.protocol !== "https:" || !allowed.has(parsed.hostname) || parsed.username) {
        onRefused?.(parsed.hostname);
        throw new PluginNetworkError(parsed.hostname);
      }
      return send(parsed.toString(), init);
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/**
 * Whether a log value is safe: numbers, booleans, null, UUIDs and lower-case
 * codes. Anything else (a name, an email, a personal identity number, free
 * text) is replaced by "[redacted]" before it reaches the host's log.
 */
export function isSafeLogValue(value: LogValue): boolean {
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  return UUID.test(value) || (CODE.test(value) && !/\d{6}/.test(value));
}

/** A logger that redacts unsafe values and tells the host it did. */
export function safeLogger(
  sink: (level: "info" | "warn", event: string, fields: Record<string, LogValue>) => void,
  onRedacted?: (event: string, field: string) => void,
): PluginLogger {
  const clean = (event: string, fields: Record<string, LogValue> = {}) => {
    const out: Record<string, LogValue> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (isSafeLogValue(value)) out[key] = value;
      else {
        out[key] = "[redacted]";
        onRedacted?.(event, key);
      }
    }
    return out;
  };
  const safeEvent = (event: string) => (CODE.test(event) ? event : "plugin.event");
  return {
    info: (event, fields) => sink("info", safeEvent(event), clean(event, fields)),
    warn: (event, fields) => sink("warn", safeEvent(event), clean(event, fields)),
  };
}

/** A state kept in memory (tests and the conformance suite). */
export function memoryState(): PluginState & { entries: Map<string, JsonValue> } {
  const entries = new Map<string, JsonValue>();
  return {
    entries,
    get: (key) => Promise.resolve(entries.get(key) ?? null),
    set: (key, value) => {
      entries.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: (key) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}
