// SPDX-License-Identifier: AGPL-3.0-only
// Privacy and protection (P1.12, ADR 0022): the caller's protected identity
// (turn on with an explanation and a confirmation, off behind a recent login
// and the consequences), and who has viewed their profile. Children's
// protection is on the family page.
import { getTranslations } from "next-intl/server";

import { FormError, Notice } from "../../../../components/form-error.tsx";
import { ProtectionControls } from "../../../../components/protection.tsx";
import { getMe, getPerson } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("protection.title") };
}

export default async function ProtectionPage({ searchParams }: Props) {
  const [query, t, me] = await Promise.all([searchParams, getTranslations(), getMe()]);
  const profile = await getPerson(me.personId, null);
  return (
    <div className="max-w-2xl space-y-6" data-testid="protection-page">
      <h1 className="text-2xl font-semibold">{t("protection.title")}</h1>
      <FormError code={query.error} />
      {query.protection === "on" ? <Notice>{t("protection.turnedOn")}</Notice> : null}
      {query.protection === "off" ? <Notice>{t("protection.turnedOff")}</Notice> : null}
      <section aria-labelledby="protected-identity" className="space-y-2">
        <h2 id="protected-identity" className="text-lg font-semibold">
          {t("protection.name")}
        </h2>
        {profile.protection ? (
          <ProtectionControls personId={me.personId} protection={profile.protection} />
        ) : null}
        <p className="text-sm">
          <a href="/help/protected-identity" className="underline">
            {t("protection.help")}
          </a>
        </p>
      </section>
      <section aria-labelledby="access-log" className="space-y-2">
        <h2 id="access-log" className="text-lg font-semibold">
          {t("protection.accessLog")}
        </h2>
        <p className="text-sm text-muted">{t("protection.accessLogIntro")}</p>
        <a
          href={`/people/${me.personId}/access-log`}
          className="underline"
          data-testid="my-access-log"
        >
          {t("protection.accessLog")}
        </a>
      </section>
      <p>
        <a href="/me/family" className="underline">
          {t("family.title")}
        </a>
      </p>
    </div>
  );
}
