// SPDX-License-Identifier: AGPL-3.0-only
// Building blocks of the family pages (P1.3): rights checkboxes for relatives
// and contact persons (acting on behalf only for relatives, with a warning),
// a guardian with their badges and actions, pending invitations, and the
// forms to invite or link someone. Server components; the forms post to the
// family actions and work without client JavaScript.

import { enumKey } from "@clubadmin/i18n";
import type { PendingGuardianInvitationSchema } from "@clubadmin/shared";
import {
  type GuardianEntry,
  GUARDIANSHIP_RIGHTS,
  type GuardianshipRight,
  isLinkedGuardianshipKind,
  LINKED_GUARDIANSHIP_KINDS,
  mayActOnBehalfKind,
  type z,
} from "@clubadmin/shared";
import { PersonName, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass, secondaryButtonClass } from "./action-form.tsx";

const LINK_KINDS = LINKED_GUARDIANSHIP_KINDS;

/** Rights of a relative or contact person; act_on_behalf only for relatives and when allowed. */
export async function RightsFields({
  selected,
  allowActOnBehalf,
  idPrefix,
}: {
  selected: readonly GuardianshipRight[];
  allowActOnBehalf: boolean;
  idPrefix: string;
}) {
  const t = await getTranslations();
  const rights = GUARDIANSHIP_RIGHTS.filter((r) => r !== "act_on_behalf" || allowActOnBehalf);
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm">{t("family.rights")}</legend>
      {rights.map((right) => (
        <label
          key={right}
          className="flex items-start gap-2 text-sm"
          htmlFor={`${idPrefix}-${right}`}
        >
          <input
            id={`${idPrefix}-${right}`}
            type="checkbox"
            name="right"
            value={right}
            defaultChecked={selected.includes(right)}
            data-testid={`right-${right}`}
          />
          <span>
            {t(enumKey("guardianRights", right))}
            {right === "act_on_behalf" ? (
              <span className="block text-protected">{t("family.actOnBehalfWarning")}</span>
            ) : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** One guardian, relative or contact person of a ward, with what the viewer may do. */
export async function GuardianRow({
  entry,
  allowActOnBehalf,
  clubId,
}: {
  entry: GuardianEntry;
  /** The viewer may give this relative act_on_behalf (a full guardian, or the adult ward). */
  allowActOnBehalf: boolean;
  /** The club's view (ending through the club's action). */
  clubId?: string;
}) {
  const t = await getTranslations();
  const linked = isLinkedGuardianshipKind(entry.kind);
  return (
    <li className="space-y-2 py-2" data-testid="guardian" data-person={entry.person.id}>
      <div className="flex flex-wrap items-center gap-2">
        <PersonName person={entry.person} protectedLabel={t("protected.tooltip")} />
        <RoleBadge label={t(enumKey("guardianKinds", entry.kind))} tone="accent" />
        {entry.isYou ? <RoleBadge label={t("family.you")} /> : null}
        {entry.recordedByClub ? <RoleBadge label={t("family.recordedByClub")} /> : null}
        {entry.phone ? <span className="text-sm text-muted">{entry.phone}</span> : null}
      </div>
      {linked ? (
        <p className="text-sm text-muted" data-testid="guardian-rights">
          {entry.rights.length === 0
            ? t("family.noRights")
            : entry.rights.map((r) => t(enumKey("guardianRights", r))).join(", ")}
        </p>
      ) : null}
      {entry.consentNote ? (
        <p className="text-sm text-muted">{t("family.consentNote", { note: entry.consentNote })}</p>
      ) : null}
      {entry.canChangeRights ? (
        <details>
          <summary className="cursor-pointer text-sm">{t("family.changeRights")}</summary>
          <ActionForm action="update-guardian-rights" className="mt-2 space-y-2">
            <input type="hidden" name="guardianshipId" value={entry.guardianshipId} />
            <RightsFields
              selected={entry.rights}
              allowActOnBehalf={allowActOnBehalf && mayActOnBehalfKind(entry.kind)}
              idPrefix={`rights-${entry.guardianshipId}`}
            />
            <button type="submit" className={secondaryButtonClass} data-testid="save-rights">
              {t("family.saveRights")}
            </button>
          </ActionForm>
        </details>
      ) : null}
      {entry.canEnd ? (
        clubId ? (
          <ActionForm action="club-end-guardianship" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="clubId" value={clubId} />
            <input type="hidden" name="guardianshipId" value={entry.guardianshipId} />
            {!linked ? (
              <label className="block space-y-1">
                <span className="text-sm">{t("family.endReason")}</span>
                <input name="reason" maxLength={500} className={inputClass} />
              </label>
            ) : null}
            <button
              type="submit"
              className={secondaryButtonClass}
              data-testid="club-end-guardianship"
            >
              {t("family.end")}
            </button>
          </ActionForm>
        ) : (
          <ActionForm action="end-guardianship" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="guardianshipId" value={entry.guardianshipId} />
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" name="confirm" required />
              {entry.isYou ? t("family.confirmEndOwn") : t("family.confirmEnd")}
            </label>
            <button type="submit" className={secondaryButtonClass} data-testid="end-guardianship">
              {entry.isYou ? t("family.endOwn") : t("family.end")}
            </button>
          </ActionForm>
        )
      ) : null}
    </li>
  );
}

export async function PendingInvitations({
  invitations,
}: {
  invitations: readonly z.infer<typeof PendingGuardianInvitationSchema>[];
}) {
  if (invitations.length === 0) return null;
  const t = await getTranslations();
  return (
    <ul className="space-y-2" data-testid="pending-invitations">
      {invitations.map((i) => (
        <li key={i.invitationId} className="flex flex-wrap items-center gap-2 text-sm">
          <RoleBadge label={t("family.pending")} />
          <RoleBadge label={t(enumKey("guardianKinds", i.kind))} />
          {i.email ? <span>{i.email}</span> : null}
          <span className="text-muted">{t("family.expires", { date: new Date(i.expiresAt) })}</span>
          {i.canManage ? (
            <>
              <ActionForm action="resend-guardian-invitation">
                <input type="hidden" name="invitationId" value={i.invitationId} />
                <button
                  type="submit"
                  className={secondaryButtonClass}
                  data-testid="resend-invitation"
                >
                  {t("family.resend")}
                </button>
              </ActionForm>
              <ActionForm action="revoke-guardian-invitation">
                <input type="hidden" name="invitationId" value={i.invitationId} />
                <button
                  type="submit"
                  className={secondaryButtonClass}
                  data-testid="revoke-invitation"
                >
                  {t("family.revoke")}
                </button>
              </ActionForm>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Invite guardian, relative or contact person": by email (any kind for a
 * full guardian; relatives and contact persons for oneself), or a person
 * without login (name and phone).
 */
export async function LinkForms({
  wardId,
  selfId,
  fullKinds,
  allowActOnBehalf,
}: {
  wardId: string;
  /** The caller's person ID: linking to oneself goes to /me/trusted-people. */
  selfId: string;
  /** Offer parent and legal guardian too (a full guardian inviting a co-guardian). */
  fullKinds: boolean;
  allowActOnBehalf: boolean;
}) {
  const t = await getTranslations();
  const kinds = fullKinds ? (["parent", "legal_guardian", ...LINK_KINDS] as const) : LINK_KINDS;
  const kindSelect = (name: string, options: readonly string[]) => (
    <label className="block space-y-1">
      <span className="text-sm">{t("family.kind")}</span>
      <select
        name={name}
        className={inputClass}
        defaultValue={options.includes("relative") ? "relative" : options[0]}
      >
        {options.map((k) => (
          <option key={k} value={k}>
            {t(enumKey("guardianKinds", k))}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <ActionForm
        action="invite-guardian"
        className="space-y-2 rounded-md border border-border p-3"
        testId="invite-form"
      >
        <h4 className="font-medium">{t("family.inviteByEmail")}</h4>
        <input type="hidden" name="wardId" value={wardId} />
        <input type="hidden" name="selfId" value={selfId} />
        <label className="block space-y-1">
          <span className="text-sm">{t("family.email")}</span>
          <input
            type="email"
            name="email"
            required
            className={inputClass}
            data-testid="invite-email"
          />
        </label>
        {kindSelect("kind", kinds)}
        <p className="text-xs text-muted">{t("family.rightsOnlyLinked")}</p>
        <RightsFields
          selected={["view_schedule"]}
          allowActOnBehalf={allowActOnBehalf}
          idPrefix={`invite-${wardId}`}
        />
        <button type="submit" className={buttonClass} data-testid="invite-submit">
          {t("family.sendInvitation")}
        </button>
      </ActionForm>
      <ActionForm
        action="add-linked-person"
        className="space-y-2 rounded-md border border-border p-3"
        testId="link-form"
      >
        <h4 className="font-medium">{t("family.addWithoutLogin")}</h4>
        <input type="hidden" name="wardId" value={wardId} />
        <input type="hidden" name="selfId" value={selfId} />
        <label className="block space-y-1">
          <span className="text-sm">{t("family.givenName")}</span>
          <input
            name="givenName"
            required
            maxLength={100}
            className={inputClass}
            data-testid="link-given"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">{t("family.familyName")}</span>
          <input
            name="familyName"
            required
            maxLength={100}
            className={inputClass}
            data-testid="link-family"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">{t("family.phone")}</span>
          <input type="tel" name="phone" className={inputClass} />
        </label>
        {kindSelect("kind", LINK_KINDS)}
        <RightsFields
          selected={["view_schedule", "receive_messages"]}
          allowActOnBehalf={allowActOnBehalf}
          idPrefix={`link-${wardId}`}
        />
        <button type="submit" className={buttonClass} data-testid="link-submit">
          {t("family.add")}
        </button>
      </ActionForm>
    </div>
  );
}

/** Whole years on a calendar date (birth dates are dates, ADR: times). */
export function ageOf(birthDate: string, today = new Date()): number {
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number];
  let age = today.getUTCFullYear() - y;
  const month = today.getUTCMonth() + 1;
  if (month < m || (month === m && today.getUTCDate() < d)) age--;
  return age;
}
