// SPDX-License-Identifier: AGPL-3.0-only
// Volunteer duties (P2.6, ADR 0050): a shift with who is on it (as the API
// shows them: the visibility setting and protected identity), the family's
// sign-up and cancellation, the leaders' assigning, removing and marking,
// and the family's quotas, open shifts and swaps in "Mina uppgifter".

import { enumKey } from "@clubadmin/i18n";
import type { DutyShift, MyDuties, PersonSummary } from "@clubadmin/shared";
import { personLabel, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass, secondaryButtonClass } from "./action-form.tsx";
import { ClubTime } from "./club-time.tsx";

/** Whom a shift could count for: the caller and their children (the API checks the group). */
export interface Family {
  me: PersonSummary;
  children: readonly PersonSummary[];
}

function CountsFor({ family, label }: { family: Family; label: string }) {
  if (family.children.length === 0) return null;
  return (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <select name="countsForPersonId" className={inputClass} defaultValue="">
        <option value="">–</option>
        {[family.me, ...family.children].map((p) => (
          <option key={p.id} value={p.id}>
            {personLabel(p)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One shift: what, when, how many, who. */
export async function ShiftSummary({ shift }: { shift: DutyShift }) {
  const t = await getTranslations();
  const unstaffed = shift.filled < shift.needed;
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{shift.title}</span>
        <RoleBadge
          tone={unstaffed ? "accent" : "neutral"}
          label={t("duties.filled", { filled: shift.filled, needed: shift.needed })}
        />
        {shift.dutyType.childContact !== "none" ? (
          <RoleBadge label={t(enumKey("duties.childContacts", shift.dutyType.childContact))} />
        ) : null}
      </p>
      <p className="text-sm text-muted">
        <ClubTime
          value={shift.startsAt}
          timeZone={shift.timeZone}
          dateStyle="medium"
          timeStyle="short"
        />
        {" – "}
        <ClubTime value={shift.endsAt} timeZone={shift.timeZone} timeStyle="short" />
        {shift.locationName ? ` · ${shift.locationName}` : ""}
        {shift.groupName ? ` · ${shift.groupName}` : ""}
      </p>
      {shift.note ? <p className="text-sm">{shift.note}</p> : null}
      {shift.assignments.length > 0 ? (
        <ul className="text-sm" data-testid="duty-assignments">
          {shift.assignments.map((a) => (
            <li key={a.id}>
              {a.person ? personLabel(a.person) : t("duties.someone")}
              {a.countsFor && a.countsFor.id !== a.person?.id
                ? ` (${t("duties.countsFor", { name: personLabel(a.countsFor) })})`
                : ""}
              {a.status !== "planned" ? ` · ${t(enumKey("tasks.statuses", a.status))}` : ""}
              {/* P2.8: shown to the shift's planners; the shift is not cancelled. */}
              {a.missingBackgroundCheck ? (
                <span
                  className="ml-2 rounded bg-protected-soft px-2 text-xs"
                  data-testid="duty-missing-check"
                >
                  {t("duties.missingCheck")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The family's sign-up for a shift with a free place, and cancelling their own. */
export async function ShiftSignUp({
  shift,
  family,
  back,
}: {
  shift: DutyShift;
  family: Family;
  back: string;
}) {
  const t = await getTranslations();
  const started = Date.parse(shift.startsAt) <= Date.now();
  if (started) return null;
  const mine = shift.assignments.filter((a) => a.mine && a.source !== "assigned");
  return (
    <div className="flex flex-wrap items-end gap-3">
      {shift.filled < shift.needed && shift.backgroundCheckRequired ? (
        // P2.8: not offered without the club's background check; why, and where to see it.
        <p className="text-sm" data-testid="duty-needs-check">
          {t("duties.needsCheck")}{" "}
          <a href="/me/background-checks" className="underline">
            {t("backgroundChecks.mineTitle")}
          </a>
        </p>
      ) : shift.filled < shift.needed ? (
        <ActionForm action="duty-signup" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="clubId" value={shift.clubId} />
          <input type="hidden" name="shiftId" value={shift.id} />
          <input type="hidden" name="back" value={back} />
          <CountsFor family={family} label={t("duties.countsForLabel")} />
          <button type="submit" className={buttonClass} data-testid="duty-signup">
            {t("duties.signUp")}
          </button>
        </ActionForm>
      ) : null}
      {mine.map((a) => (
        <ActionForm key={a.id} action="duty-cancel">
          <input type="hidden" name="clubId" value={shift.clubId} />
          <input type="hidden" name="shiftId" value={shift.id} />
          <input type="hidden" name="assignmentId" value={a.id} />
          <input type="hidden" name="back" value={back} />
          <button type="submit" className={secondaryButtonClass} data-testid="duty-cancel">
            {t("duties.cancel")}
          </button>
        </ActionForm>
      ))}
    </div>
  );
}

/** An activity's shifts (P2.6): who is on them as the visibility allows, and the family's sign-up. */
export async function ActivityDuties({
  shifts,
  family,
  back,
}: {
  shifts: DutyShift[];
  family: Family;
  back: string;
}) {
  if (shifts.length === 0) return null;
  const t = await getTranslations();
  return (
    <section aria-labelledby="duties" className="space-y-3" data-testid="activity-duties">
      <h2 id="duties" className="text-lg font-semibold">
        {t("duties.title")}
      </h2>
      <ul className="space-y-3">
        {shifts.map((s) => (
          <li key={s.id} className="space-y-2 rounded-lg border border-border p-3">
            <ShiftSummary shift={s} />
            <ShiftSignUp shift={s} family={family} back={back} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Mina uppgifter" (P2.6): the family's quotas, open shifts and swaps in a club. */
export async function MyDutiesSection({
  duties,
  family,
  back,
}: {
  duties: MyDuties;
  family: Family;
  back: string;
}) {
  const t = await getTranslations();
  return (
    <div className="space-y-6" data-testid="my-duties">
      <section aria-labelledby="quotas" className="space-y-2">
        <h2 id="quotas" className="text-lg font-semibold">
          {t("duties.quotas")}
        </h2>
        {duties.quotas.length === 0 ? (
          <p className="text-sm text-muted">{t("duties.noQuotas")}</p>
        ) : (
          <ul className="text-sm" data-testid="duty-quotas">
            {duties.quotas.map((q) => (
              <li key={`${q.groupId}-${q.player?.id ?? "hidden"}`}>
                {q.player ? personLabel(q.player) : t("duties.someone")} · {q.groupName}:{" "}
                {t("duties.quotaLine", {
                  done: q.done,
                  planned: q.planned,
                  quota: q.shiftsPerPlayer,
                })}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="swaps" className="space-y-2">
        <h2 id="swaps" className="text-lg font-semibold">
          {t("duties.swaps")}
        </h2>
        {duties.swaps.length === 0 ? (
          <p className="text-sm text-muted">{t("duties.noSwaps")}</p>
        ) : (
          <ul className="space-y-2" data-testid="duty-swaps">
            {duties.swaps.map((w) => (
              <li key={w.id} className="space-y-1 rounded-lg border border-border p-3">
                <p className="text-sm">
                  {t(enumKey("duties.swapKinds", w.kind))}: {w.shift.title}
                  {w.holder ? ` · ${personLabel(w.holder)}` : ""}
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  {w.canTake ? (
                    <ActionForm
                      action="duty-swap-answer"
                      className="flex flex-wrap items-end gap-2"
                    >
                      <input type="hidden" name="clubId" value={duties.clubId} />
                      <input type="hidden" name="swapId" value={w.id} />
                      <input type="hidden" name="answer" value="take" />
                      <input type="hidden" name="back" value={back} />
                      <CountsFor family={family} label={t("duties.countsForLabel")} />
                      <button type="submit" className={buttonClass} data-testid="duty-swap-take">
                        {t("duties.take")}
                      </button>
                    </ActionForm>
                  ) : null}
                  {w.canAccept
                    ? (["accept", "decline"] as const).map((answer) => (
                        <ActionForm key={answer} action="duty-swap-answer">
                          <input type="hidden" name="clubId" value={duties.clubId} />
                          <input type="hidden" name="swapId" value={w.id} />
                          <input type="hidden" name="answer" value={answer} />
                          <input type="hidden" name="back" value={back} />
                          <button
                            type="submit"
                            className={answer === "accept" ? buttonClass : secondaryButtonClass}
                            data-testid={`duty-swap-${answer}`}
                          >
                            {t(answer === "accept" ? "duties.accept" : "duties.decline")}
                          </button>
                        </ActionForm>
                      ))
                    : null}
                  {w.mine ? (
                    <ActionForm action="duty-swap-answer">
                      <input type="hidden" name="clubId" value={duties.clubId} />
                      <input type="hidden" name="swapId" value={w.id} />
                      <input type="hidden" name="answer" value="withdraw" />
                      <input type="hidden" name="back" value={back} />
                      <button
                        type="submit"
                        className={secondaryButtonClass}
                        data-testid="duty-swap-withdraw"
                      >
                        {t("duties.withdraw")}
                      </button>
                    </ActionForm>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="open-shifts" className="space-y-2">
        <h2 id="open-shifts" className="text-lg font-semibold">
          {t("duties.openShifts")}
        </h2>
        {duties.openShifts.length === 0 ? (
          <p className="text-sm text-muted">{t("duties.noOpenShifts")}</p>
        ) : (
          <ul className="space-y-3" data-testid="duty-open-shifts">
            {duties.openShifts.map((s) => (
              <li key={s.id} className="space-y-2 rounded-lg border border-border p-3">
                <ShiftSummary shift={s} />
                <ShiftSignUp shift={s} family={family} back={back} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
