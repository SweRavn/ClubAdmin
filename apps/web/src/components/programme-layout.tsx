// SPDX-License-Identifier: AGPL-3.0-only
// Laying out a template or copying a programme (P2.9, ADR 0054 decision 9):
// the first day, the groups of each slot and the places to replace as a GET
// form whose result is the preview (new times, warnings in amber, refusals
// in red), then one form that creates everything at once.
import { enumKey } from "@clubadmin/i18n";
import type { ProgrammePreview } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass, secondaryButtonClass } from "./action-form.tsx";
import { FormError } from "./form-error.tsx";

export interface LayoutChoices {
  firstDay: string;
  title: string;
  edition: string;
  /** Slot key → chosen group IDs. */
  slots: Record<string, string[]>;
  /** Place → replacement (absent: the same). */
  locations: Record<string, string>;
}

/** The choices of the GET form (or the defaults before the first preview). */
export function choicesOf(
  query: Record<string, string | string[] | undefined>,
  slots: readonly { key: string; defaultGroupId: string | null }[],
  locationIds: readonly string[],
): { choices: LayoutChoices; asked: boolean } {
  const one = (name: string) => (typeof query[name] === "string" ? query[name] : "");
  const many = (name: string) => {
    const v = query[name];
    return (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x) =>
      /^[0-9a-f-]{36}$/.test(x),
    );
  };
  const asked = /^\d{4}-\d{2}-\d{2}$/.test(one("firstDay"));
  return {
    asked,
    choices: {
      firstDay: one("firstDay"),
      title: one("title"),
      edition: one("edition"),
      slots: Object.fromEntries(
        slots.map((s) => [
          s.key,
          asked ? many(`slot_${s.key}`) : s.defaultGroupId ? [s.defaultGroupId] : [],
        ]),
      ),
      locations: Object.fromEntries(
        locationIds.flatMap((id) => {
          const to = one(`loc_${id}`);
          return /^[0-9a-f-]{36}$/.test(to) && to !== id ? [[id, to]] : [];
        }),
      ),
    },
  };
}

/** The request body of the preview for these choices. */
export function layoutRequest(
  choices: LayoutChoices,
  withEdition: boolean,
): Record<string, unknown> {
  return {
    firstDay: choices.firstDay,
    slots: choices.slots,
    locations: choices.locations,
    ...(choices.title ? { title: choices.title } : {}),
    ...(withEdition && choices.edition ? { edition: choices.edition } : {}),
  };
}

export async function ProgrammeLayout({
  clubId,
  action,
  hidden,
  path,
  slots,
  places,
  groups,
  locations,
  choices,
  preview,
  error,
  withEdition,
}: {
  clubId: string;
  /** "programme-apply" or "programme-copy". */
  action: string;
  /** The template's or the programme's ID fields. */
  hidden: Record<string, string>;
  /** This page (the GET form's target). */
  path: string;
  slots: readonly { key: string; label: string }[];
  /** The places the items use (to replace archived ones). */
  places: readonly { id: string; name: string; archived: boolean }[];
  groups: readonly { id: string; name: string }[];
  locations: readonly { id: string; name: string }[];
  choices: LayoutChoices;
  preview: ProgrammePreview | null;
  error: string | null;
  withEdition: boolean;
}) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const when = (iso: string, tz: string) =>
    new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz,
    }).format(new Date(iso));
  return (
    <div className="space-y-6">
      <form
        method="get"
        action={path}
        className="max-w-xl space-y-4"
        data-testid="programme-layout-form"
      >
        <label className="block space-y-1">
          <span className="font-medium">{t("programmes.firstDay")}</span>
          <input
            type="date"
            name="firstDay"
            required
            defaultValue={choices.firstDay}
            className={inputClass}
            data-testid="programme-first-day"
          />
        </label>
        <label className="block space-y-1">
          <span className="font-medium">{t("programmes.programmeTitle")}</span>
          <input name="title" maxLength={200} defaultValue={choices.title} className={inputClass} />
        </label>
        {withEdition ? (
          <label className="block space-y-1">
            <span className="font-medium">{t("programmes.edition")}</span>
            <input
              name="edition"
              maxLength={60}
              defaultValue={choices.edition}
              className={inputClass}
            />
          </label>
        ) : null}
        {slots.length > 0 ? (
          <fieldset className="space-y-3">
            <legend className="font-medium">{t("programmes.slots")}</legend>
            {slots.map((slot) => (
              <div key={slot.key} className="space-y-1">
                <p className="text-sm">{t("programmes.slotGroups", { label: slot.label })}</p>
                <div className="flex flex-wrap gap-3">
                  {groups.map((g) => (
                    <label key={g.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name={`slot_${slot.key}`}
                        value={g.id}
                        defaultChecked={(choices.slots[slot.key] ?? []).includes(g.id)}
                        data-testid={`programme-slot-${slot.key}-${g.id}`}
                      />
                      {g.name}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>
        ) : null}
        {places.length > 0 ? (
          <fieldset className="space-y-2">
            <legend className="font-medium">{t("programmes.places")}</legend>
            {places.map((p) => (
              <label key={p.id} className="block space-y-1">
                <span className="text-sm">
                  {t("programmes.replacePlace", { name: p.name })}
                  {p.archived ? ` (${t("programmes.archived")})` : ""}
                </span>
                <select
                  name={`loc_${p.id}`}
                  defaultValue={choices.locations[p.id] ?? ""}
                  className={inputClass}
                  data-testid={`programme-place-${p.id}`}
                >
                  <option value="">{t("programmes.samePlace")}</option>
                  {locations
                    .filter((l) => l.id !== p.id)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </fieldset>
        ) : null}
        <button type="submit" className={secondaryButtonClass} data-testid="programme-preview">
          {t("programmes.preview")}
        </button>
      </form>

      {error ? <FormError code={error} /> : null}
      {preview ? (
        <section className="space-y-3" data-testid="programme-preview-result">
          <h2 className="text-lg font-semibold">{t("programmes.previewTitle")}</h2>
          {preview.refusals.length > 0 ? (
            <div className="rounded-md border border-danger p-3" data-testid="programme-refusals">
              <p className="font-medium text-danger">{t("programmes.refusalsTitle")}</p>
              <ul className="list-disc pl-5 text-sm text-danger">
                {[...new Set(preview.refusals.map((r) => r.code))].map((code) => (
                  <li key={code}>{t(enumKey("programmes.refusals", code))}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {preview.warnings.length > 0 ? (
            <div
              className="rounded-md border border-amber-500 p-3"
              data-testid="programme-warnings"
            >
              <p className="font-medium text-amber-700 dark:text-amber-400">
                {t("programmes.warningsTitle")}
              </p>
              <ul className="list-disc pl-5 text-sm text-amber-700 dark:text-amber-400">
                {[...new Set(preview.warnings.map((w) => w.code))].map((code) => (
                  <li key={code}>{t(enumKey("programmes.warnings", code))}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <ul className="divide-y divide-border rounded-md border border-border text-sm">
            {preview.items.map((item) => (
              <li
                key={item.itemId}
                className={`flex flex-wrap gap-x-3 p-2 ${item.kind === "duty_shift" ? "pl-6 text-muted" : ""}`}
              >
                <span>{when(item.startsAt, preview.timeZone)}</span>
                <span className="font-medium">{item.title}</span>
                <span>{item.groupIds.map((id) => groupName.get(id) ?? "").join(", ")}</span>
                {item.needed ? <span>× {item.needed}</span> : null}
              </li>
            ))}
          </ul>
          {preview.refusals.length === 0 ? (
            <ActionForm action={action} testId="programme-confirm-form">
              <input type="hidden" name="clubId" value={clubId} />
              {Object.entries(hidden).map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}
              <input type="hidden" name="firstDay" value={choices.firstDay} />
              <input type="hidden" name="title" value={choices.title} />
              {withEdition ? <input type="hidden" name="edition" value={choices.edition} /> : null}
              <input type="hidden" name="slotKeys" value={slots.map((s) => s.key).join(",")} />
              {slots.flatMap((s) =>
                (choices.slots[s.key] ?? []).map((g) => (
                  <input key={`${s.key}-${g}`} type="hidden" name={`slot_${s.key}`} value={g} />
                )),
              )}
              <input
                type="hidden"
                name="locationIds"
                value={Object.keys(choices.locations).join(",")}
              />
              {Object.entries(choices.locations).map(([from, to]) => (
                <input key={from} type="hidden" name={`loc_${from}`} value={to} />
              ))}
              <button type="submit" className={buttonClass} data-testid="programme-confirm">
                {t("programmes.confirm")}
              </button>
            </ActionForm>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
