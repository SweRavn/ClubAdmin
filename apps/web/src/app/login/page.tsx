// SPDX-License-Identifier: AGPL-3.0-only
// Login page: the real login (Zitadel) and, with DEV_AUTH, the persona
// picker grouped by club with the personas' descriptions and tags from
// docs/demodata (GET /api/v1/dev/personas).

import { type PersonaList, PersonaListSchema } from "@clubadmin/shared";
import { personLabel, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { apiFetch } from "../../server/api.ts";
import { oidcConfigured, webConfig } from "../../server/config.ts";
import { safeReturnTo } from "../../server/return-to.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: (await getTranslations())("login.title") };
}

type Persona = PersonaList["personas"][number];

async function personas(): Promise<Persona[]> {
  try {
    const res = await apiFetch("/api/v1/dev/personas", null);
    if (!res.ok) return [];
    return PersonaListSchema.parse(await res.json()).personas;
  } catch {
    return [];
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const returnTo = safeReturnTo(one(params.returnTo));
  const invitation = one(params.invitation);
  const error = one(params.error);
  const config = webConfig();
  const t = await getTranslations();
  const start = `/auth/login/start?${new URLSearchParams({ returnTo, ...(invitation ? { invitation } : {}) })}`;

  return (
    <main id="main" className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t("login.title")}</h1>
      {error === "rate_limited" ? (
        <p role="alert" className="rounded-md bg-protected-soft px-3 py-2">
          {t("login.rateLimited")}
        </p>
      ) : null}
      {error && error !== "rate_limited" ? (
        <p role="alert" className="rounded-md bg-protected-soft px-3 py-2">
          {t("login.failed")}
        </p>
      ) : null}
      {oidcConfigured(config) ? (
        <p className="flex flex-wrap gap-3">
          <a
            href={start}
            data-testid="real-login"
            className="rounded-md bg-accent px-4 py-2 text-accent-fg"
          >
            {t("login.email")}
          </a>
          <a href={`${start}&signup=1`} className="rounded-md border border-border px-4 py-2">
            {t("login.signUp")}
          </a>
        </p>
      ) : (
        <p>{t("login.notConfigured")}</p>
      )}
      {config.DEV_AUTH ? (
        <section
          aria-labelledby="dev-login"
          className="space-y-3 rounded-lg border border-dashed border-border p-4"
        >
          <h2 id="dev-login" className="text-xl font-semibold">
            {t("login.dev.title")}
          </h2>
          <p className="text-muted">{t("login.dev.hint")}</p>
          <DevPicker personas={await personas()} returnTo={returnTo} />
        </section>
      ) : null}
    </main>
  );
}

async function DevPicker({ personas, returnTo }: { personas: Persona[]; returnTo: string }) {
  const t = await getTranslations();
  if (personas.length === 0) return <p>{t("login.dev.empty")}</p>;
  // Grouped by club; someone in several clubs is listed under each.
  const groups = new Map<
    string,
    { name: string; entries: { persona: Persona; roles: string[] }[] }
  >();
  for (const persona of personas) {
    const clubs = persona.clubs.length > 0 ? persona.clubs : [null];
    for (const club of clubs) {
      const key = club?.clubId ?? "";
      const group = groups.get(key) ?? {
        name: club?.clubName ?? t("login.dev.noClub"),
        entries: [],
      };
      group.entries.push({ persona, roles: club?.roles.map((r) => t(`roles.${r}`)) ?? [] });
      groups.set(key, group);
    }
  }
  const ordered = [...groups.entries()].sort(([a, x], [b, y]) =>
    a === "" ? 1 : b === "" ? -1 : x.name.localeCompare(y.name),
  );
  return (
    <form method="post" action="/auth/dev-login" className="space-y-4">
      <input type="hidden" name="returnTo" value={returnTo} />
      <p>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" name="mfa" value="1" className="size-4" /> {t("login.dev.mfa")}
        </label>
      </p>
      {ordered.map(([key, group]) => (
        <fieldset key={key || "none"} className="space-y-2">
          <legend className="text-lg font-semibold">{group.name}</legend>
          <ul className="grid gap-2 sm:grid-cols-2">
            {group.entries.map(({ persona, roles }) => (
              <li key={persona.person.id} className="rounded-md border border-border bg-raised p-3">
                <button
                  type="submit"
                  name="personId"
                  value={persona.person.id}
                  className="font-medium text-accent underline-offset-2 hover:underline"
                >
                  {t("login.dev.loginAs", { name: personLabel(persona.person) })}
                </button>
                {roles.length > 0 ? (
                  <p className="mt-1 text-sm text-muted">
                    {t("login.dev.roles", { roles: roles.join(", ") })}
                  </p>
                ) : null}
                {/* Demo data (docs/demodata): what the persona is for, in the data's own words. */}
                {persona.description ? <p className="mt-1 text-sm">{persona.description}</p> : null}
                {persona.tags.length > 0 ? (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {persona.tags.map((tag) => (
                      <RoleBadge key={tag} label={tag} />
                    ))}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </fieldset>
      ))}
    </form>
  );
}
