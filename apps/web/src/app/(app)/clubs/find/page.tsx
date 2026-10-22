// SPDX-License-Identifier: AGPL-3.0-only
// Finding a club and asking to join it, for oneself and one's children (P1.1).
import { enumKey } from "@clubadmin/i18n";
import { EmptyState, personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../components/action-form.tsx";
import { FormError } from "../../../../components/form-error.tsx";
import { getMe, getMyWards, searchClubs } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("findClub.title") };
}

export default async function FindClubPage({ searchParams }: Props) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const cursor = typeof params.cursor === "string" ? params.cursor : null;
  const [t, me, wards, result] = await Promise.all([
    getTranslations(),
    getMe(),
    getMyWards(),
    q.length >= 2 ? searchClubs(q, cursor) : Promise.resolve(null),
  ]);
  const children = wards.wards.filter((w) => w.rights.includes("act_on_behalf"));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("findClub.title")}</h1>
      <FormError code={params.error} />
      <form method="get" action="/clubs/find" role="search" className="flex max-w-lg gap-2">
        <label htmlFor="q" className="sr-only">
          {t("findClub.search")}
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={q}
          minLength={2}
          placeholder={t("findClub.search")}
          className={inputClass}
          data-testid="club-search"
        />
        <button type="submit" className={buttonClass}>
          {t("findClub.searchButton")}
        </button>
      </form>

      {result === null ? (
        <p className="text-muted">{t("findClub.prompt")}</p>
      ) : result.items.length === 0 ? (
        <EmptyState title={t("findClub.empty")} headingLevel={2} />
      ) : (
        <ul className="space-y-3" data-testid="club-results">
          {result.items.map((club) => (
            <li key={club.id} className="rounded-lg border border-border bg-raised p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-lg font-semibold">{club.name}</h2>
                {club.city ? <span className="text-sm text-muted">{club.city}</span> : null}
                <span className="ml-auto text-sm text-muted">
                  {t(enumKey("joinPolicies", club.joinPolicy))}
                </span>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-accent">{t("findClub.ask")}</summary>
                <ActionForm action="request-join" className="mt-3 space-y-3">
                  <input type="hidden" name="clubId" value={club.id} />
                  <fieldset className="space-y-1">
                    <legend className="font-medium">{t("findClub.for")}</legend>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="personId" value={me.personId} defaultChecked />
                      {t("findClub.yourself")} ({personLabel(me.person)})
                    </label>
                    {children.map((w) => (
                      <label key={w.person.id} className="flex items-center gap-2">
                        <input type="checkbox" name="personId" value={w.person.id} />
                        {personLabel(w.person)}
                      </label>
                    ))}
                  </fieldset>
                  <label className="block space-y-1">
                    <span>{t("findClub.message")}</span>
                    <textarea name="message" maxLength={1000} rows={3} className={inputClass} />
                  </label>
                  <button type="submit" className={buttonClass} data-testid={`ask-${club.id}`}>
                    {t("findClub.send")}
                  </button>
                </ActionForm>
              </details>
            </li>
          ))}
        </ul>
      )}
      {result?.nextCursor ? (
        <a
          href={`/clubs/find?q=${encodeURIComponent(q)}&cursor=${result.nextCursor}`}
          className="text-accent underline"
        >
          {t("findClub.more")}
        </a>
      ) : null}
    </div>
  );
}
