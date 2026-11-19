// SPDX-License-Identifier: AGPL-3.0-only
// A group's duty shifts for its planners (P2.6, ADR 0050): unstaffed first,
// new shifts, putting the group's members on them and taking them off,
// "Att markera" (past shifts with someone still planned: done or missed),
// the quota per player and season with the statistics as CSV, and the
// group's visibility when the club lets groups choose.
import { enumKey } from "@clubadmin/i18n";
import { DUTY_VISIBILITIES } from "@clubadmin/shared";
import { personLabel } from "@clubadmin/ui";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { ShiftSummary } from "../../../../../components/duties.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  getClubSeasons,
  getDutyQuota,
  getDutyTypes,
  getGroup,
  getGroupDutiesToMark,
  getGroupDutySettings,
  getGroupDutyShifts,
  getGroupMembers,
  getMyClubs,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("duties.title") };
}

export default async function GroupDutiesPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const [t, group, clubs] = await Promise.all([getTranslations(), getGroup(groupId), getMyClubs()]);
  const today = new Date().toISOString().slice(0, 10);
  const until = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const shifts = await getGroupDutyShifts(group.clubId, group.id, today, until);
  if (!shifts) notFound();
  const [types, toMark, settings, seasons, roster] = await Promise.all([
    getDutyTypes(group.clubId),
    getGroupDutiesToMark(group.clubId, group.id),
    getGroupDutySettings(group.clubId, group.id),
    getClubSeasons(group.clubId),
    getGroupMembers(group.id, 200),
  ]);
  const timeZone =
    clubs.clubs.find((c) => c.club.id === group.clubId)?.club.timeZone ?? "Europe/Stockholm";
  const season =
    seasons.items.find((s) => s.id === query.seasonId) ??
    seasons.items.find((s) => s.startsOn <= today && s.endsOn >= today) ??
    seasons.items[0];
  const quota = season ? await getDutyQuota(group.clubId, group.id, season.id) : null;
  const back = `/groups/${group.id}/duties`;
  const people = roster?.items.map((i) => i.person) ?? [];
  const players =
    roster?.items.filter((i) => i.functions.includes("member")).map((i) => i.person) ?? [];
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const common = (
    <>
      {hidden("clubId", group.clubId)}
      {hidden("groupId", group.id)}
      {hidden("back", back)}
    </>
  );

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm">
          <a href={`/groups/${group.id}`} className="underline">
            {group.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("duties.title")}</h1>
      </div>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("duties.saved")}</Notice> : null}

      <section aria-labelledby="shifts" className="space-y-3">
        <h2 id="shifts" className="text-lg font-semibold">
          {t("duties.coming")}
        </h2>
        {shifts.items.length === 0 ? (
          <p className="text-sm text-muted">{t("duties.noShifts")}</p>
        ) : (
          <ul className="space-y-3" data-testid="group-shifts">
            {shifts.items.map((s) => (
              <li
                key={s.id}
                className="space-y-2 rounded-lg border border-border p-3"
                data-testid="group-shift"
              >
                <ShiftSummary shift={s} />
                <div className="flex flex-wrap items-end gap-3">
                  {s.assignments.map((a) => (
                    <ActionForm key={a.id} action="duty-unassign">
                      {common}
                      {hidden("shiftId", s.id)}
                      {hidden("assignmentId", a.id)}
                      <button type="submit" className={secondaryButtonClass}>
                        {t("duties.remove", { name: a.person ? personLabel(a.person) : "–" })}
                      </button>
                    </ActionForm>
                  ))}
                  {s.filled < s.needed && people.length > 0 ? (
                    <ActionForm action="duty-assign" className="flex flex-wrap items-end gap-2">
                      {common}
                      {hidden("shiftId", s.id)}
                      <label className="block space-y-1">
                        <span className="text-sm">{t("duties.who")}</span>
                        <select name="personId" className={inputClass} required>
                          {people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {personLabel(p)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block space-y-1">
                        <span className="text-sm">{t("duties.countsForLabel")}</span>
                        <select name="countsForPersonId" className={inputClass} defaultValue="">
                          <option value="">–</option>
                          {players.map((p) => (
                            <option key={p.id} value={p.id}>
                              {personLabel(p)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="submit" className={buttonClass} data-testid="duty-assign">
                        {t("duties.assign")}
                      </button>
                    </ActionForm>
                  ) : null}
                  <ActionForm action="duty-shift-delete">
                    {common}
                    {hidden("shiftId", s.id)}
                    <button type="submit" className={secondaryButtonClass}>
                      {t("duties.deleteShift")}
                    </button>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {types && types.items.length > 0 ? (
        <section aria-labelledby="new-shift" className="space-y-2">
          <h2 id="new-shift" className="text-lg font-semibold">
            {t("duties.newShift")}
          </h2>
          <ActionForm
            action="duty-shift-create"
            guard
            className="grid gap-3 sm:grid-cols-2"
            testId="duty-shift-form"
          >
            {common}
            {hidden("timeZone", timeZone)}
            <label className="block space-y-1">
              <span className="text-sm">{t("duties.type")}</span>
              <select name="dutyTypeId" className={inputClass} required>
                {types.items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm">{t("duties.shiftTitle")}</span>
              <input name="title" maxLength={200} className={inputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-sm">{t("duties.date")}</span>
              <input type="date" name="date" required className={inputClass} />
            </label>
            <div className="flex gap-2">
              <label className="block space-y-1">
                <span className="text-sm">{t("duties.from")}</span>
                <input type="time" name="startTime" required className={inputClass} />
              </label>
              <label className="block space-y-1">
                <span className="text-sm">{t("duties.to")}</span>
                <input type="time" name="endTime" required className={inputClass} />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-sm">{t("duties.needed")}</span>
              <input
                type="number"
                name="needed"
                min={1}
                max={50}
                defaultValue={2}
                className={inputClass}
              />
            </label>
            <label className="block space-y-1 sm:col-span-2">
              <span className="text-sm">{t("duties.note")}</span>
              <input name="note" maxLength={2000} className={inputClass} />
            </label>
            <div>
              <button type="submit" className={buttonClass} data-testid="duty-shift-create">
                {t("duties.createShift")}
              </button>
            </div>
          </ActionForm>
        </section>
      ) : types ? (
        // No duty types yet (P2.7b): say why there is no form, and who adds them.
        <p className="rounded-md bg-accent-soft px-3 py-2 text-sm" data-testid="duty-no-types">
          {t("duties.noTypes")}{" "}
          {clubs.clubs
            .find((c) => c.club.id === group.clubId)
            ?.permissions.includes("club.duty_types.manage") ? (
            <a href={`/clubs/${group.clubId}/duties`} className="underline">
              {t("duties.addTypes")}
            </a>
          ) : null}
        </p>
      ) : null}

      <section aria-labelledby="to-mark" className="space-y-3">
        <h2 id="to-mark" className="text-lg font-semibold">
          {t("duties.toMark")}
        </h2>
        {toMark.items.length === 0 ? (
          <p className="text-sm text-muted">{t("duties.nothingToMark")}</p>
        ) : (
          <ul className="space-y-3" data-testid="duties-to-mark">
            {toMark.items.map((s) => (
              <li key={s.id} className="space-y-2 rounded-lg border border-border p-3">
                <ShiftSummary shift={s} />
                {s.assignments
                  .filter((a) => a.status === "planned")
                  .map((a) => (
                    <div key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span>{a.person ? personLabel(a.person) : t("duties.someone")}</span>
                      {(["done", "missed"] as const).map((status) => (
                        <ActionForm key={status} action="duty-mark">
                          {common}
                          {hidden("shiftId", s.id)}
                          {hidden("assignmentId", a.id)}
                          {hidden("status", status)}
                          <button
                            type="submit"
                            className={status === "done" ? buttonClass : secondaryButtonClass}
                            data-testid={`duty-mark-${status}`}
                          >
                            {t(enumKey("tasks.statuses", status))}
                          </button>
                        </ActionForm>
                      ))}
                    </div>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      {season ? (
        <section aria-labelledby="quota" className="space-y-3">
          <h2 id="quota" className="text-lg font-semibold">
            {t("duties.quota", { season: season.name })}
          </h2>
          <ActionForm action="duty-quota" className="flex flex-wrap items-end gap-3">
            {common}
            {hidden("seasonId", season.id)}
            <label className="block space-y-1">
              <span className="text-sm">{t("duties.shiftsPerPlayer")}</span>
              <input
                type="number"
                name="shiftsPerPlayer"
                min={0}
                max={100}
                defaultValue={quota?.shiftsPerPlayer ?? ""}
                className={inputClass}
                data-testid="duty-quota-input"
              />
            </label>
            <button type="submit" className={buttonClass}>
              {t("duties.save")}
            </button>
          </ActionForm>
          {quota && quota.players.length > 0 ? (
            <table className="w-full text-sm" data-testid="duty-quota">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-3 font-normal">{t("duties.player")}</th>
                  <th className="py-1 pr-3 font-normal">{t("duties.done")}</th>
                  <th className="py-1 font-normal">{t("duties.planned")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {quota.players.map((p, i) => (
                  <tr key={p.person?.id ?? `hidden-${i}`}>
                    <td className="py-1 pr-3">
                      {p.person ? personLabel(p.person) : t("duties.someone")}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">
                      {p.done}
                      {quota.shiftsPerPlayer !== null ? ` / ${quota.shiftsPerPlayer}` : ""}
                    </td>
                    <td className="py-1 tabular-nums">{p.planned}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <a
            href={`/api/v1/clubs/${group.clubId}/groups/${group.id}/duty-stats?seasonId=${season.id}`}
            className="text-sm underline"
            data-testid="duty-stats"
          >
            {t("duties.statistics")}
          </a>
        </section>
      ) : null}

      {settings.mayChange ? (
        <section aria-labelledby="visibility" className="space-y-2">
          <h2 id="visibility" className="text-lg font-semibold">
            {t("duties.visibility")}
          </h2>
          <ActionForm action="duty-group-settings" className="flex flex-wrap items-end gap-3">
            {common}
            <select
              name="visibility"
              className={inputClass}
              defaultValue={settings.visibility ?? ""}
            >
              <option value="">{t("duties.clubDefault")}</option>
              {DUTY_VISIBILITIES.map((v) => (
                <option key={v} value={v}>
                  {t(enumKey("duties.visibilities", v))}
                </option>
              ))}
            </select>
            <button type="submit" className={buttonClass}>
              {t("duties.save")}
            </button>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
