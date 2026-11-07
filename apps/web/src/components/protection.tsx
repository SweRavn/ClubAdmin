// SPDX-License-Identifier: AGPL-3.0-only
// Protected identity (P1.12, ADR 0022): the controls for turning the flag on
// and off (with the explanation and a confirmation that works without
// JavaScript: a <details> with the consequences and the button), the club
// managers' panel, and the list of profile views.
import { enumKey } from "@clubadmin/i18n";
import type { ProfileViewEntry, ProtectionState } from "@clubadmin/shared";
import { formatDateTime, personLabel, PersonName } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, secondaryButtonClass } from "./action-form.tsx";

/** The global flag of the caller or a ward: state, explanation, on/off with confirmation. */
export async function ProtectionControls({
  personId,
  protection,
  ward,
  testId = "protection",
}: {
  personId: string;
  protection: ProtectionState;
  /** A ward: turning it on asks the guardian to protect themselves too. */
  ward?: boolean;
  testId?: string;
}) {
  const [t, locale, timeZone] = await Promise.all([getTranslations(), getLocale(), getTimeZone()]);
  return (
    <div className="space-y-2" data-testid={testId}>
      <p className="font-medium" data-testid={`${testId}-state`}>
        {protection.global ? t("protection.stateOn") : t("protection.stateOff")}
        {protection.global && protection.globalSetAt ? (
          <span className="ml-2 text-sm text-muted">
            {t("protection.setAt", {
              date: formatDateTime(protection.globalSetAt, {
                locale,
                timeZone,
                dateStyle: "medium",
              }),
            })}
          </span>
        ) : null}
      </p>
      {!protection.canChangeGlobal ? null : !protection.global ? (
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer font-medium" data-testid={`${testId}-on`}>
            {t("protection.turnOn")}
          </summary>
          <div className="mt-2 space-y-2 text-sm">
            <p>{t("protection.explain")}</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("protection.othersDont")}</li>
              <li>{t("protection.whoSees")}</li>
              <li>{t("protection.addressDeleted")}</li>
            </ul>
            <ActionForm action="set-protection">
              <input type="hidden" name="personId" value={personId} />
              <input type="hidden" name="protected" value="1" />
              {ward ? <input type="hidden" name="ward" value="1" /> : null}
              <button type="submit" className={buttonClass} data-testid={`${testId}-confirm-on`}>
                {t("protection.turnOnConfirm")}
              </button>
            </ActionForm>
          </div>
        </details>
      ) : protection.canRemoveGlobal ? (
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer" data-testid={`${testId}-off`}>
            {t("protection.turnOff")}
          </summary>
          <div className="mt-2 space-y-2 text-sm">
            <p>{t("protection.turnOffConsequences")}</p>
            <ActionForm action="set-protection">
              <input type="hidden" name="personId" value={personId} />
              <input type="hidden" name="protected" value="0" />
              <button
                type="submit"
                className={secondaryButtonClass}
                data-testid={`${testId}-confirm-off`}
              >
                {t("protection.turnOffConfirm")}
              </button>
            </ActionForm>
          </div>
        </details>
      ) : (
        <p className="text-sm text-muted" data-testid={`${testId}-removal-refused`}>
          {t("protection.removalRefused")}
        </p>
      )}
    </div>
  );
}

/** Club managers' panel on a member's page: source, who set the club flag, on/off. */
export async function ClubProtectionPanel({
  personId,
  clubId,
  protection,
}: {
  personId: string;
  clubId: string;
  protection: ProtectionState;
}) {
  const [t, locale, timeZone] = await Promise.all([getTranslations(), getLocale(), getTimeZone()]);
  const source =
    protection.global && protection.club
      ? "both"
      : protection.global
        ? "global"
        : protection.club
          ? "club"
          : "none";
  return (
    <section
      aria-labelledby="club-protection"
      className="space-y-2 rounded-lg border border-border p-4"
      data-testid="club-protection"
    >
      <h2 id="club-protection" className="text-lg font-semibold">
        {t("protection.panelTitle")}
      </h2>
      <p data-testid="club-protection-source">{t(enumKey("protection.sources", source))}</p>
      {protection.club && protection.clubSetAt ? (
        <p className="text-sm text-muted">
          {t("protection.clubSetBy", {
            name: protection.clubSetBy ? personLabel(protection.clubSetBy) : "–",
            date: formatDateTime(protection.clubSetAt, { locale, timeZone, dateStyle: "medium" }),
          })}
        </p>
      ) : null}
      <p className="text-sm text-muted">{t("protection.clubHint")}</p>
      <div className="flex flex-wrap gap-2">
        <ActionForm action="set-protection">
          <input type="hidden" name="personId" value={personId} />
          <input type="hidden" name="clubId" value={clubId} />
          <input type="hidden" name="protected" value={protection.club ? "0" : "1"} />
          <button
            type="submit"
            className={protection.club ? secondaryButtonClass : buttonClass}
            data-testid="club-protection-toggle"
          >
            {protection.club ? t("protection.removeClubProtection") : t("protection.protectInClub")}
          </button>
        </ActionForm>
        <a
          href={`/clubs/${clubId}/profile-views?personId=${personId}`}
          className="self-center text-sm underline"
        >
          {t("protection.memberViews")}
        </a>
      </div>
    </section>
  );
}

/** One page of profile views (the person's log or the club's). */
export async function ProfileViewList({
  items,
  showPerson,
  emptyText,
  testId,
}: {
  items: readonly ProfileViewEntry[];
  showPerson?: boolean;
  emptyText: string;
  testId: string;
}) {
  const [t, locale, timeZone] = await Promise.all([getTranslations(), getLocale(), getTimeZone()]);
  const protectedLabel = t("protected.tooltip");
  const who = (v: ProfileViewEntry["viewer"]) =>
    v.kind === "person" ? (
      <PersonName person={v.person} protectedLabel={protectedLabel} />
    ) : (
      <span className="italic">{t(enumKey("protection.viewers", v.kind))}</span>
    );
  if (items.length === 0) {
    return (
      <p className="text-muted" data-testid={`${testId}-empty`}>
        {emptyText}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border rounded-lg border border-border" data-testid={testId}>
      {items.map((v) => (
        <li key={v.id} className="space-y-1 px-4 py-3" data-testid={`${testId}-item`}>
          <div className="flex flex-wrap items-center gap-2">
            {showPerson && v.person ? (
              <>
                {who(v.person)}
                <span aria-hidden>←</span>
              </>
            ) : null}
            {who(v.viewer)}
            {v.viewerRole ? (
              <span className="text-sm text-muted">
                (
                {v.viewerRole === "group_leader" ||
                v.viewerRole === "guardian" ||
                v.viewerRole === "member"
                  ? t(enumKey("protection.viewerRoles", v.viewerRole))
                  : t(enumKey("roles", v.viewerRole))}
                )
              </span>
            ) : null}
            {v.onBehalfOf ? (
              <span className="text-sm text-muted">
                {t("protection.onBehalfOf", { name: personLabel(v.onBehalfOf) })}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted">
            {formatDateTime(v.lastViewedAt, {
              locale,
              timeZone,
              dateStyle: "medium",
              timeStyle: "short",
            })}
            {" · "}
            {v.club ? v.club.name : t("protection.noClub")}
            {" · "}
            {t("protection.times", { count: v.count })}
            {v.surface === "history" ? ` · ${t("protection.surfaces.history")}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}
