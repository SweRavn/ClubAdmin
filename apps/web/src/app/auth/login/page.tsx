// SPDX-License-Identifier: AGPL-3.0-only
// Login page: the persona picker when DEV_AUTH is on, and the real login
// (Zitadel) button. The picker lists people from GET /api/v1/dev/personas.

import { type PersonaList, PersonaListSchema } from "@clubadmin/shared";

import { apiFetch } from "../../../server/api.ts";
import { oidcConfigured, webConfig } from "../../../server/config.ts";
import { safeReturnTo } from "../../../server/return-to.ts";
import { translator } from "../../i18n.ts";

export const dynamic = "force-dynamic";

async function personas(): Promise<PersonaList["personas"]> {
  const res = await apiFetch("/api/v1/dev/personas", null);
  if (!res.ok) return [];
  return PersonaListSchema.parse(await res.json()).personas;
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
  const { t } = await translator();
  const start = `/auth/login/start?${new URLSearchParams({ returnTo, ...(invitation ? { invitation } : {}) })}`;

  return (
    <main>
      <h1>{t("web.login.title")}</h1>
      {error === "rate_limited" && <p role="alert">{t("web.login.rateLimited")}</p>}
      {error && error !== "rate_limited" && <p role="alert">{t("web.login.failed")}</p>}
      {oidcConfigured(config) ? (
        <p>
          <a href={start} data-testid="real-login">
            {t("web.login.email")}
          </a>{" "}
          · <a href={`${start}&signup=1`}>{t("web.login.signUp")}</a>
        </p>
      ) : (
        <p>{t("web.login.notConfigured")}</p>
      )}
      {config.DEV_AUTH && (
        <section aria-labelledby="dev-login">
          <h2 id="dev-login">{t("web.login.dev.title")}</h2>
          <p>{t("web.login.dev.hint")}</p>
          <DevPicker personas={await personas()} returnTo={returnTo} t={t} />
        </section>
      )}
    </main>
  );
}

function DevPicker({
  personas,
  returnTo,
  t,
}: {
  personas: PersonaList["personas"];
  returnTo: string;
  t: Awaited<ReturnType<typeof translator>>["t"];
}) {
  if (personas.length === 0) return <p>{t("web.login.dev.empty")}</p>;
  return (
    <form method="post" action="/auth/dev-login">
      <input type="hidden" name="returnTo" value={returnTo} />
      <p>
        <label>
          <input type="checkbox" name="mfa" value="1" /> {t("web.login.dev.mfa")}
        </label>
      </p>
      <ul>
        {personas.map((persona) => (
          <li key={persona.person.id}>
            <button type="submit" name="personId" value={persona.person.id}>
              {t("web.login.dev.loginAs", { name: persona.person.displayName })}
            </button>{" "}
            <small>
              {persona.clubs
                .map((c) => `${c.clubName}${c.roles.length ? ` (${c.roles.join(", ")})` : ""}`)
                .join(" · ")}
            </small>
          </li>
        ))}
      </ul>
    </form>
  );
}
