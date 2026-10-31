// SPDX-License-Identifier: AGPL-3.0-only
// The home page's joining parts (P1.1): onboarding for people without a
// club, and what is in progress (join requests with their preferred groups,
// places on waiting lists (P1.6b), club creation requests, manager
// hand-overs proposed to me). Also on /me.
import { enumKey } from "@clubadmin/i18n";
import { EmptyState, personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import {
  getMyCreationRequests,
  getMyHandovers,
  getMyJoinRequests,
  getMyProfile,
  getMyWaitlists,
} from "../server/data.ts";
import { ActionForm, buttonClass, inputClass, secondaryButtonClass } from "./action-form.tsx";

const linkButton = "inline-block rounded-md bg-accent px-4 py-2 text-sm text-accent-fg";

export async function Onboarding() {
  const [t, profile] = await Promise.all([getTranslations(), getMyProfile()]);
  if (!profile.complete) {
    return (
      <div data-testid="onboarding">
        <EmptyState
          title={t("onboarding.completeProfile")}
          actions={
            <a href="/me/profile?next=%2F" className={linkButton} data-testid="complete-profile">
              {t("profileForm.title")}
            </a>
          }
        >
          <p>{t("onboarding.completeProfileText")}</p>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid="onboarding">
      <h2 className="text-xl font-semibold">{t("onboarding.startTitle")}</h2>
      <p className="text-muted">{t("onboarding.startText")}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <section className="space-y-2 rounded-lg border border-border bg-raised p-4">
          <h3 className="font-semibold">{t("onboarding.haveCode")}</h3>
          <ActionForm action="accept-invitation" className="space-y-2">
            <label className="block space-y-1">
              <span className="text-sm">{t("onboarding.code")}</span>
              <input
                name="code"
                required
                autoComplete="off"
                autoCapitalize="characters"
                className={inputClass}
                data-testid="invitation-code"
              />
            </label>
            <button type="submit" className={buttonClass}>
              {t("onboarding.useCode")}
            </button>
          </ActionForm>
          <p className="text-sm text-muted">{t("onboarding.haveLink")}</p>
        </section>
        <section className="space-y-2 rounded-lg border border-border bg-raised p-4">
          <h3 className="font-semibold">{t("onboarding.findClub")}</h3>
          <a href="/clubs/find" className={linkButton} data-testid="find-club">
            {t("onboarding.findClub")}
          </a>
        </section>
        <section className="space-y-2 rounded-lg border border-border bg-raised p-4">
          <h3 className="font-semibold">{t("onboarding.createClub")}</h3>
          {profile.clubCreation === "not_allowed" ? (
            <p className="text-sm text-muted">{t("onboarding.creationNotAllowed")}</p>
          ) : (
            <a href="/clubs/new" className={linkButton} data-testid="create-club">
              {profile.clubCreation === "request"
                ? t("onboarding.requestClub")
                : t("onboarding.createClub")}
            </a>
          )}
        </section>
      </div>
    </div>
  );
}

export async function InProgress() {
  const [t, requests, creations, handovers, waitlists] = await Promise.all([
    getTranslations(),
    getMyJoinRequests(),
    getMyCreationRequests(),
    getMyHandovers(),
    getMyWaitlists(),
  ]);
  const pending = requests.items.filter((r) => r.status === "pending");
  const pendingCreations = creations.items.filter((r) => r.status === "pending");
  const preferred = new Map(
    waitlists.joinRequests.map((r) => [r.id, r.preferredGroups.map((g) => g.name)]),
  );
  if (
    pending.length +
      pendingCreations.length +
      handovers.incoming.length +
      waitlists.entries.length ===
    0
  ) {
    return null;
  }
  return (
    <section aria-labelledby="in-progress" data-testid="in-progress" className="space-y-2">
      <h2 id="in-progress" className="text-xl font-semibold">
        {t("pending.title")}
      </h2>
      <ul className="divide-y divide-border rounded-lg border border-border bg-raised">
        {handovers.incoming.map((h) => (
          <li
            key={h.id}
            className="flex flex-wrap items-center gap-3 px-4 py-3"
            data-testid="handover"
          >
            <span>
              {t("pending.handover", {
                from: h.from ? personLabel(h.from) : t("protected.label"),
                club: h.club.name,
              })}
            </span>
            <ActionForm action="respond-handover" className="ml-auto flex gap-2">
              <input type="hidden" name="handoverId" value={h.id} />
              <button type="submit" name="response" value="accept" className={buttonClass}>
                {t("pending.accept")}
              </button>
              <button
                type="submit"
                name="response"
                value="decline"
                className={secondaryButtonClass}
              >
                {t("pending.decline")}
              </button>
            </ActionForm>
          </li>
        ))}
        {pending.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-3 px-4 py-3"
            data-testid="join-request"
          >
            <span>
              {t("pending.joinRequest", { club: r.club.name, person: personLabel(r.person) })}
            </span>
            <span className="text-sm text-muted">{t(enumKey("joinRequestStatus", r.status))}</span>
            {preferred.get(r.id)?.length ? (
              <span className="text-sm text-muted" data-testid="join-request-groups">
                {t("pending.preferredGroups", { groups: preferred.get(r.id)!.join(", ") })}
              </span>
            ) : null}
            <ActionForm action="withdraw-join-request" className="ml-auto">
              <input type="hidden" name="joinRequestId" value={r.id} />
              <button type="submit" className={secondaryButtonClass}>
                {t("pending.withdraw")}
              </button>
            </ActionForm>
          </li>
        ))}
        {waitlists.entries.map((e) => (
          <li
            key={e.id}
            className="flex flex-wrap items-center gap-3 px-4 py-3"
            data-testid="waitlist-entry"
          >
            <span>
              {e.position === null
                ? t("pending.waitlistOffered", {
                    person: personLabel(e.person),
                    group: e.group.name,
                    club: e.club.name,
                  })
                : t("pending.waitlist", {
                    person: personLabel(e.person),
                    group: e.group.name,
                    club: e.club.name,
                    position: e.position,
                    waiting: e.waiting,
                  })}
            </span>
          </li>
        ))}
        {pendingCreations.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span>{t("pending.creationRequest", { club: r.name })}</span>
            <span className="text-sm text-muted">{t(enumKey("creationStatus", r.status))}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
