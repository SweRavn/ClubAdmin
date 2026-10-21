// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm auth:configure`: applies the desired Zitadel configuration in
// infra/zitadel/ (project, OIDC apps, login and password policies, branding,
// languages and login texts) through the Zitadel API, idempotently. Uses the
// personal access token of the `clubadmin-config` machine user (IAM_OWNER),
// created by Zitadel's first-instance setup (infra/docker/compose.yml).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./paths.ts";

export const zitadelConfigDir = join(repoRoot, "infra", "zitadel");

type Json = Record<string, unknown>;

export interface DesiredApp {
  type: "oidc" | "api";
  appType?: string;
  authMethodType: string;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
}

export interface DesiredConfig {
  project: { name: string };
  apps: Record<string, DesiredApp>;
  serviceUser: { userName: string; name: string; instanceRoles: string[] };
  loginPolicy: Json;
  passwordComplexity: Json;
  lockout: Json;
  /** Token lifetimes: access and ID tokens at most 10 minutes (docs/architecture.md). */
  oidcSettings: Json;
  domainPolicy: Json;
  branding: Json;
  languages: { default: string; allowed: string[] };
  /** Which hosted login UI the apps use (v1 is built into Zitadel; v2 is the separate login app). */
  loginVersion: "v1" | "v2";
}

/** Values written to .env.local (development) or printed for operators. */
export interface ConfigureOutputs {
  AUTH_PROJECT_ID: string;
  AUTH_WEB_CLIENT_ID: string;
  AUTH_WEB_CLIENT_SECRET?: string;
  AUTH_MOBILE_CLIENT_ID: string;
  ZITADEL_API_TOKEN?: string;
}

export interface ConfigureOptions {
  /** Zitadel's public URL (the issuer), e.g. https://auth.clubadmin.localhost */
  baseUrl: string;
  token: string;
  /** Replaces ${VAR} in the desired configuration. */
  variables: ReadonlyMap<string, string>;
  /** USER_SIGNUP: self-registration on (open) or off (invite_only). */
  userSignup: "open" | "invite_only";
  /** Secrets from an earlier run; reused so a rerun does not rotate them. */
  existing?: {
    webClientId?: string | undefined;
    webClientSecret?: string | undefined;
    apiToken?: string | undefined;
  };
  desired?: DesiredConfig;
  log?: (message: string) => void;
  fetch?: typeof fetch;
}

export class ZitadelError extends Error {
  readonly status: number;
  /** gRPC status code from the body (9 = failed precondition, e.g. "no changes"). */
  readonly code: number | undefined;
  constructor(method: string, path: string, status: number, body: string) {
    super(`Zitadel ${method} ${path} failed (${status}): ${body.slice(0, 500)}`);
    this.name = "ZitadelError";
    this.status = status;
    try {
      this.code = (JSON.parse(body) as { code?: number }).code;
    } catch {
      this.code = undefined;
    }
  }
}

function substitute<T>(value: T, variables: ReadonlyMap<string, string>): T {
  return JSON.parse(
    JSON.stringify(value).replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name: string) => {
      const v = variables.get(name);
      if (v === undefined) throw new Error(`infra/zitadel: ${name} is not set`);
      return v.replace(/\/$/, "");
    }),
  ) as T;
}

export function loadDesiredConfig(variables: ReadonlyMap<string, string>): DesiredConfig {
  const raw = JSON.parse(readFileSync(join(zitadelConfigDir, "clubadmin.json"), "utf8")) as Json;
  delete raw.$comment;
  return substitute(raw as unknown as DesiredConfig, variables);
}

/** Custom login texts per language (infra/zitadel/login-texts/<lang>.json), sections of the v1 login texts. */
export function loadLoginTexts(languages: string[]): Map<string, Json> {
  const texts = new Map<string, Json>();
  for (const lang of languages) {
    const file = join(zitadelConfigDir, "login-texts", `${lang}.json`);
    if (existsSync(file)) texts.set(lang, JSON.parse(readFileSync(file, "utf8")) as Json);
  }
  return texts;
}

/** Zitadel's JSON returns 64-bit numbers as strings. */
const normalise = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "number" ? String(v) : v));

/** Every desired field already has this value (is an update needed?). */
function sameValues(desired: Json, current: Json | undefined): boolean {
  if (!current) return false;
  return Object.entries(desired).every(([k, v]) => normalise(v) === normalise(current[k]));
}

export async function configureZitadel(options: ConfigureOptions): Promise<{
  changes: string[];
  outputs: ConfigureOutputs;
}> {
  const base = options.baseUrl.replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const desired = options.desired ?? loadDesiredConfig(options.variables);
  const changes: string[] = [];
  const changed = (message: string) => {
    changes.push(message);
    options.log?.(message);
  };

  const api = async <T = Json>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": "en",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new ZitadelError(method, path, res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  };
  /** PUT a policy; Zitadel answers "no changes" (400 / code 9) when nothing differs. */
  const putPolicy = async (path: string, body: Json, label: string, current?: Json) => {
    if (sameValues(body, current)) return;
    try {
      await api("PUT", path, body);
      changed(`${label} updated`);
    } catch (error) {
      if (error instanceof ZitadelError && error.status === 400 && error.code === 9) return;
      throw error;
    }
  };

  // Project.
  const projects = await api<{ result?: { id: string; name: string }[] }>(
    "POST",
    "/management/v1/projects/_search",
    {
      queries: [{ nameQuery: { name: desired.project.name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
    },
  );
  let projectId = projects.result?.[0]?.id;
  if (!projectId) {
    ({ id: projectId } = await api<{ id: string }>("POST", "/management/v1/projects", {
      name: desired.project.name,
      projectRoleAssertion: false,
      projectRoleCheck: false,
      hasProjectCheck: false,
    }));
    changed(`project ${desired.project.name} created`);
  }

  // Applications.
  const { result: apps = [] } = await api<{
    result?: {
      id: string;
      name: string;
      oidcConfig?: Json & { clientId: string };
      apiConfig?: { clientId: string };
    }[];
  }>("POST", `/management/v1/projects/${projectId}/apps/_search`, {});
  const clientIds: Record<string, string> = {};
  let webClientSecret = options.existing?.webClientSecret;

  for (const [name, app] of Object.entries(desired.apps)) {
    const current = apps.find((a) => a.name === name);
    if (app.type === "api") {
      if (current) {
        clientIds[name] = current.apiConfig?.clientId ?? "";
      } else {
        const created = await api<{ clientId: string }>(
          "POST",
          `/management/v1/projects/${projectId}/apps/api`,
          {
            name,
            authMethodType: app.authMethodType,
          },
        );
        clientIds[name] = created.clientId;
        changed(`app ${name} created`);
      }
      continue;
    }
    const oidc: Json = {
      redirectUris: app.redirectUris ?? [],
      postLogoutRedirectUris: app.postLogoutRedirectUris ?? [],
      responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
      appType: app.appType,
      authMethodType: app.authMethodType,
      version: "OIDC_VERSION_1_0",
      // JWT access tokens let the API validate locally (JWKS), without introspection.
      accessTokenType: "OIDC_TOKEN_TYPE_JWT",
      accessTokenRoleAssertion: false,
      idTokenRoleAssertion: false,
      idTokenUserinfoAssertion: true,
      devMode: false,
      clockSkew: "0s",
      additionalOrigins: [],
      skipNativeAppSuccessPage: true,
      backChannelLogoutUri: "",
      loginVersion: desired.loginVersion === "v1" ? { loginV1: {} } : { loginV2: { baseUri: "" } },
    };
    if (!current) {
      const created = await api<{ appId: string; clientId: string; clientSecret?: string }>(
        "POST",
        `/management/v1/projects/${projectId}/apps/oidc`,
        { name, ...oidc },
      );
      clientIds[name] = created.clientId;
      if (name === "web") webClientSecret = created.clientSecret;
      changed(`app ${name} created`);
      continue;
    }
    clientIds[name] = current.oidcConfig?.clientId ?? "";
    await putPolicy(
      `/management/v1/projects/${projectId}/apps/${current.id}/oidc_config`,
      oidc,
      `app ${name}`,
      current.oidcConfig,
    );
    // The secret is only shown once; make a new one if we do not have it.
    if (
      name === "web" &&
      app.authMethodType !== "OIDC_AUTH_METHOD_TYPE_NONE" &&
      (!webClientSecret || options.existing?.webClientId !== clientIds[name])
    ) {
      ({ clientSecret: webClientSecret } = await api<{ clientSecret: string }>(
        "POST",
        `/management/v1/projects/${projectId}/apps/${current.id}/oidc_config/_generate_client_secret`,
        {},
      ));
      changed("app web: new client secret");
    }
  }

  // Machine user for the API (deleting Zitadel sessions when a session is revoked).
  const users = await api<{ result?: { id: string }[] }>("POST", "/management/v1/users/_search", {
    queries: [
      {
        userNameQuery: {
          userName: desired.serviceUser.userName,
          method: "TEXT_QUERY_METHOD_EQUALS",
        },
      },
    ],
  });
  let serviceUserId = users.result?.[0]?.id;
  let apiToken = options.existing?.apiToken;
  if (!serviceUserId) {
    ({ userId: serviceUserId } = await api<{ userId: string }>(
      "POST",
      "/management/v1/users/machine",
      {
        userName: desired.serviceUser.userName,
        name: desired.serviceUser.name,
        accessTokenType: "ACCESS_TOKEN_TYPE_BEARER",
      },
    ));
    changed(`machine user ${desired.serviceUser.userName} created`);
    apiToken = undefined;
  }
  const members = await api<{ result?: { userId: string; roles: string[] }[] }>(
    "POST",
    "/admin/v1/members/_search",
    {
      queries: [{ userIdQuery: { userId: serviceUserId } }],
    },
  );
  const member = members.result?.find((m) => m.userId === serviceUserId);
  if (!member) {
    await api("POST", "/admin/v1/members", {
      userId: serviceUserId,
      roles: desired.serviceUser.instanceRoles,
    });
    changed(
      `machine user ${desired.serviceUser.userName}: roles ${desired.serviceUser.instanceRoles.join(", ")}`,
    );
  } else if (
    JSON.stringify([...member.roles].sort()) !==
    JSON.stringify([...desired.serviceUser.instanceRoles].sort())
  ) {
    await api("PUT", `/admin/v1/members/${serviceUserId}`, {
      roles: desired.serviceUser.instanceRoles,
    });
    changed(`machine user ${desired.serviceUser.userName}: roles updated`);
  }
  if (!apiToken) {
    ({ token: apiToken } = await api<{ token: string }>(
      "POST",
      `/management/v1/users/${serviceUserId}/pats`,
      {
        expirationDate: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      },
    ));
    changed(`machine user ${desired.serviceUser.userName}: new access token`);
  }

  // Instance-wide policies.
  const login = await api<{ policy?: Json }>("GET", "/admin/v1/policies/login");
  await putPolicy(
    "/admin/v1/policies/login",
    { ...desired.loginPolicy, allowRegister: options.userSignup === "open" },
    "login policy",
    login.policy,
  );
  const complexity = await api<{ policy?: Json }>("GET", "/admin/v1/policies/password/complexity");
  await putPolicy(
    "/admin/v1/policies/password/complexity",
    desired.passwordComplexity,
    "password policy",
    complexity.policy,
  );
  // Lockout cannot be changed instance-wide through the REST API in Zitadel v4;
  // the organisation (where people sign up) gets its own policy instead.
  const lockout = await api<{ policy?: Json & { isDefault?: boolean } }>(
    "GET",
    "/management/v1/policies/lockout",
  );
  if (lockout.policy?.isDefault) {
    await api("POST", "/management/v1/policies/lockout", desired.lockout);
    changed("lockout policy created");
  } else {
    await putPolicy(
      "/management/v1/policies/lockout",
      desired.lockout,
      "lockout policy",
      lockout.policy,
    );
  }
  const oidcSettings = await api<{ settings?: Json }>("GET", "/admin/v1/settings/oidc");
  await putPolicy(
    "/admin/v1/settings/oidc",
    desired.oidcSettings,
    "token lifetimes",
    oidcSettings.settings,
  );
  const domain = await api<{ policy?: Json }>("GET", "/admin/v1/policies/domain");
  await putPolicy(
    "/admin/v1/policies/domain",
    desired.domainPolicy,
    "domain policy",
    domain.policy,
  );

  // Branding (preview, then activate).
  const label = await api<{ policy?: Json }>("GET", "/admin/v1/policies/label/_preview");
  if (!sameValues(desired.branding, label.policy)) {
    await putPolicy("/admin/v1/policies/label", desired.branding, "branding");
    await api("POST", "/admin/v1/policies/label/_activate", {});
  }

  // Languages and login texts.
  const restrictions = await api<{ allowedLanguages?: string[] }>("GET", "/admin/v1/restrictions");
  if (
    JSON.stringify(restrictions.allowedLanguages ?? []) !==
    JSON.stringify(desired.languages.allowed)
  ) {
    await api("PUT", "/admin/v1/restrictions", {
      allowedLanguages: { list: desired.languages.allowed },
    });
    changed(`languages: ${desired.languages.allowed.join(", ")}`);
  }
  const defaultLanguage = await api<{ language?: string }>("GET", "/admin/v1/languages/default");
  if (defaultLanguage.language !== desired.languages.default) {
    await api("PUT", `/admin/v1/languages/default/${desired.languages.default}`, {});
    changed(`default language: ${desired.languages.default}`);
  }
  for (const [language, sections] of loadLoginTexts(desired.languages.allowed)) {
    const current = await api<{ customText?: Json }>("GET", `/admin/v1/text/login/${language}`);
    const differs = Object.entries(sections).some(
      ([section, texts]) =>
        !sameValues(texts as Json, current.customText?.[section] as Json | undefined),
    );
    if (!differs) continue;
    await api("PUT", `/admin/v1/text/login/${language}`, sections);
    changed(`login texts (${language}) updated`);
  }

  // Login UI version for the whole instance (apps choose theirs above).
  const features = await api<{ loginV2?: { required?: boolean } }>("GET", "/v2/features/instance");
  const requireV2 = desired.loginVersion === "v2";
  if ((features.loginV2?.required ?? false) !== requireV2) {
    await api("PUT", "/v2/features/instance", { loginV2: { required: requireV2 } });
    changed(`login UI ${desired.loginVersion} for the instance`);
  }

  return {
    changes,
    outputs: {
      AUTH_PROJECT_ID: projectId,
      AUTH_WEB_CLIENT_ID: clientIds.web ?? "",
      ...(webClientSecret ? { AUTH_WEB_CLIENT_SECRET: webClientSecret } : {}),
      AUTH_MOBILE_CLIENT_ID: clientIds.mobile ?? "",
      ...(apiToken ? { ZITADEL_API_TOKEN: apiToken } : {}),
    },
  };
}
