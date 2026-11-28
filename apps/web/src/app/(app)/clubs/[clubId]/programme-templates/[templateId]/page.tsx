// SPDX-License-Identifier: AGPL-3.0-only
// A programme template (P2.9, ADR 0054): its items as a list per day (add,
// move between days, remove; shifts under their activity), its teams
// (slots) with their default groups, the sign-up laid out with it, the
// editions laid out from it, and "Lägg ut". No people are ever in it.
import { enumKey } from "@clubadmin/i18n";
import type { ProgrammeTemplate } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import {
  getClub,
  getClubGroups,
  getDutyTypes,
  getLocations,
  getProgrammeTemplate,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string; templateId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const ACTIVITY_KINDS = ["training", "match", "meeting", "other"] as const;

export async function generateMetadata({ params }: Props) {
  const { clubId, templateId } = await params;
  return { title: (await getProgrammeTemplate(clubId, templateId)).name };
}

/** The items as the editor's actions take them (their IDs as refs). */
function asInput(items: ProgrammeTemplate["items"]) {
  return items.map(({ id, parentItemId, ...rest }) => ({
    ...rest,
    ref: id,
    parentRef: parentItemId,
  }));
}

export default async function TemplatePage({ params, searchParams }: Props) {
  const [{ clubId, templateId }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations(),
  ]);
  const [club, template] = await Promise.all([
    getClub(clubId),
    getProgrammeTemplate(clubId, templateId),
  ]);
  const [groups, locations, dutyTypes] = await Promise.all([
    getClubGroups(club.id),
    getLocations(club.id),
    template.canManage ? getDutyTypes(club.id) : null,
  ]);
  const here = `/clubs/${club.id}/programme-templates/${template.id}`;
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const placeName = new Map(locations.map((l) => [l.id, l.name]));
  const slotLabel = new Map(template.slots.map((s) => [s.key, s.label]));
  const items = JSON.stringify(asInput(template.items));
  const days = Array.from({ length: template.dayCount }, (_, n) => n);
  const ids = (
    <>
      <input type="hidden" name="clubId" value={club.id} />
      <input type="hidden" name="templateId" value={template.id} />
    </>
  );
  const activities = template.items.filter((i) => i.kind === "activity");

  return (
    <div className="space-y-6" data-testid="programme-template-page">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          <a
            href={
              template.groupId
                ? `/groups/${template.groupId}/programmes`
                : `/clubs/${club.id}/programmes`
            }
            className="underline"
          >
            {template.groupId ? (groupName.get(template.groupId) ?? club.name) : club.name}
          </a>
          {" · "}
          {template.groupId ? t("programmes.groupTemplate") : t("programmes.clubTemplate")}
        </p>
        <h1 className="text-2xl font-semibold" data-testid="programme-template-name">
          {template.name}
        </h1>
        {template.description ? (
          <p className="max-w-prose text-muted">{template.description}</p>
        ) : null}
        <p className="text-sm text-muted">
          {t("programmes.dayCount", { count: template.dayCount })} ·{" "}
          {t("programmes.itemCount", { count: template.itemCount })}
          {template.archived ? ` · ${t("programmes.archived")}` : ""}
        </p>
      </div>
      <FormError code={query.error} />
      {typeof query.saved === "string" ? (
        <Notice>{t(enumKey("programmes.saved", query.saved))}</Notice>
      ) : null}
      {!template.archived ? (
        <a href={`${here}/apply`} className={buttonClass} data-testid="programme-template-apply">
          {t("programmes.layOut")}
        </a>
      ) : null}

      <section className="space-y-3" aria-labelledby="template-items">
        <h2 id="template-items" className="text-lg font-semibold">
          {t("programmes.items")}
        </h2>
        {days.map((day) => {
          const ofDay = template.items.filter((i) => i.dayOffset === day && i.kind === "activity");
          const loose = template.items.filter(
            (i) => i.dayOffset === day && i.kind === "duty_shift" && !i.parentItemId,
          );
          return (
            <div key={day} className="space-y-1" data-testid={`template-day-${day}`}>
              <h3 className="font-medium">{t("programmes.dayN", { n: day + 1 })}</h3>
              {ofDay.length + loose.length === 0 ? (
                <p className="text-sm text-muted">{t("programmes.nothingThisDay")}</p>
              ) : null}
              <ul className="space-y-1">
                {[...ofDay, ...loose]
                  .sort((a, b) => a.startTime.localeCompare(b.startTime))
                  .map((item) => (
                    <li
                      key={item.id}
                      className="rounded-md bg-surface p-2 text-sm"
                      data-testid={`template-item-${item.id}`}
                    >
                      <Item item={item} slotLabel={slotLabel} placeName={placeName} />
                      <ul className="ml-4 space-y-1">
                        {template.items
                          .filter((s) => s.parentItemId === item.id)
                          .map((s) => (
                            <li key={s.id} className="text-muted">
                              <Item item={s} slotLabel={slotLabel} placeName={placeName} />
                            </li>
                          ))}
                      </ul>
                      {template.canManage ? (
                        <div className="mt-1 flex flex-wrap gap-2">
                          <ActionForm
                            action="programme-template-items"
                            back={here}
                            className="flex gap-1"
                          >
                            {ids}
                            <input type="hidden" name="items" value={items} />
                            <input type="hidden" name="op" value="move" />
                            <input type="hidden" name="ref" value={item.id} />
                            <select
                              name="day"
                              defaultValue={String(day)}
                              className="rounded-md border border-border bg-bg px-2"
                              aria-label={t("programmes.moveTo")}
                            >
                              {days.map((d) => (
                                <option key={d} value={d}>
                                  {t("programmes.dayN", { n: d + 1 })}
                                </option>
                              ))}
                            </select>
                            <button type="submit" className="underline">
                              {t("programmes.move")}
                            </button>
                          </ActionForm>
                          <ActionForm action="programme-template-items" back={here}>
                            {ids}
                            <input type="hidden" name="items" value={items} />
                            <input type="hidden" name="op" value="remove" />
                            <input type="hidden" name="ref" value={item.id} />
                            <button
                              type="submit"
                              className="underline"
                              data-testid={`template-remove-${item.id}`}
                            >
                              {t("programmes.remove")}
                            </button>
                          </ActionForm>
                        </div>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </div>
          );
        })}
      </section>

      {template.canManage ? (
        <section className="max-w-xl space-y-3" aria-labelledby="template-add">
          <h2 id="template-add" className="text-lg font-semibold">
            {t("programmes.addItem")}
          </h2>
          <ActionForm
            action="programme-template-items"
            back={here}
            className="grid gap-3 sm:grid-cols-2"
            testId="template-add-item"
          >
            {ids}
            <input type="hidden" name="items" value={items} />
            <input type="hidden" name="op" value="add" />
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.itemKind")}</span>
              <select name="kind" className={inputClass} data-testid="template-add-kind">
                {ACTIVITY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(enumKey("activityKinds", k))}
                  </option>
                ))}
                {dutyTypes && dutyTypes.items.length > 0 ? (
                  <option value="duty_shift">{t("programmes.shiftItem")}</option>
                ) : null}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.name")}</span>
              <input
                name="title"
                required
                maxLength={200}
                className={inputClass}
                data-testid="template-add-title"
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.dayN", { n: "" }).trim()}</span>
              <select name="day" className={inputClass}>
                {days.map((d) => (
                  <option key={d} value={d}>
                    {t("programmes.dayN", { n: d + 1 })}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.slot")}</span>
              <select name="slot" className={inputClass}>
                {template.slots.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
                <option value="">{t("programmes.noGroup")}</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.start")}</span>
              <input
                type="time"
                name="startTime"
                required
                className={inputClass}
                data-testid="template-add-start"
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.end")}</span>
              <input
                type="time"
                name="endTime"
                required
                className={inputClass}
                data-testid="template-add-end"
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.place")}</span>
              <select name="locationId" className={inputClass}>
                <option value="">—</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.placeText")}</span>
              <input name="locationText" maxLength={200} className={inputClass} />
            </label>
            {dutyTypes && dutyTypes.items.length > 0 ? (
              <>
                <label className="block space-y-1">
                  <span className="font-medium">{t("programmes.dutyType")}</span>
                  <select name="dutyTypeId" className={inputClass}>
                    <option value="">—</option>
                    {dutyTypes.items.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="font-medium">{t("programmes.needed")}</span>
                  <input
                    type="number"
                    name="needed"
                    min={1}
                    max={50}
                    defaultValue={1}
                    className={inputClass}
                  />
                </label>
                <label className="block space-y-1 sm:col-span-2">
                  <span className="font-medium">{t("programmes.parent")}</span>
                  <select name="parentRef" className={inputClass}>
                    <option value="">{t("programmes.noParent")}</option>
                    {activities.map((a) => (
                      <option key={a.id} value={a.id}>
                        {t("programmes.dayN", { n: a.dayOffset + 1 })} {a.startTime} {a.title}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            <div className="sm:col-span-2">
              <button type="submit" className={buttonClass} data-testid="template-add-submit">
                {t("programmes.addItem")}
              </button>
            </div>
          </ActionForm>
        </section>
      ) : null}

      {template.canManage ? (
        <section className="max-w-xl space-y-3" aria-labelledby="template-slots">
          <h2 id="template-slots" className="text-lg font-semibold">
            {t("programmes.slots")}
          </h2>
          <ActionForm action="programme-template-slots" back={here} className="space-y-3">
            {ids}
            <input
              type="hidden"
              name="slotKeys"
              value={template.slots.map((s) => s.key).join(",")}
            />
            {template.slots.map((s) => (
              <div key={s.key} className="grid gap-2 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-sm">{t("programmes.slotLabel")}</span>
                  <input
                    name={`label_${s.key}`}
                    defaultValue={s.label}
                    maxLength={60}
                    className={inputClass}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">{t("programmes.defaultGroup")}</span>
                  <select
                    name={`group_${s.key}`}
                    defaultValue={s.defaultGroupId ?? ""}
                    className={inputClass}
                  >
                    <option value="">{t("programmes.noGroup")}</option>
                    {groups
                      .filter((g) => !g.archived)
                      .map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            ))}
            <label className="block space-y-1">
              <span className="text-sm">{t("programmes.addSlot")}</span>
              <input name="newSlot" maxLength={60} className={inputClass} />
            </label>
            <button type="submit" className={secondaryButtonClass}>
              {t("programmes.saveSlots")}
            </button>
          </ActionForm>
        </section>
      ) : null}

      <section className="max-w-xl space-y-3" aria-labelledby="template-event">
        <h2 id="template-event" className="text-lg font-semibold">
          {t("programmes.event")}
        </h2>
        {template.eventSettings ? (
          <p>{template.eventSettings.title}</p>
        ) : (
          <p className="text-muted">{t("programmes.noEvent")}</p>
        )}
        {template.canManage ? (
          <>
            <p className="text-sm text-muted">{t("programmes.eventHint")}</p>
            <ActionForm
              action="programme-template-event"
              back={here}
              className="grid gap-3 sm:grid-cols-2"
            >
              {ids}
              <label className="block space-y-1 sm:col-span-2">
                <span className="text-sm">{t("programmes.eventTitle")}</span>
                <input
                  name="eventTitle"
                  maxLength={200}
                  defaultValue={template.eventSettings?.title ?? template.name}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-sm">{t("programmes.capacity")}</span>
                <input
                  type="number"
                  name="capacity"
                  min={1}
                  defaultValue={template.eventSettings?.capacity ?? ""}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-sm">{t("programmes.opensDaysBefore")}</span>
                <input
                  type="number"
                  name="opensDaysBefore"
                  min={0}
                  defaultValue={template.eventSettings?.opensDaysBefore ?? ""}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-sm">{t("programmes.closesDaysBefore")}</span>
                <input
                  type="number"
                  name="closesDaysBefore"
                  min={0}
                  defaultValue={template.eventSettings?.closesDaysBefore ?? ""}
                  className={inputClass}
                />
              </label>
              <input
                type="hidden"
                name="audience"
                value={template.eventSettings?.audience ?? "groups"}
              />
              <div className="flex gap-2 sm:col-span-2">
                <button type="submit" className={secondaryButtonClass}>
                  {template.eventSettings ? t("programmes.save") : t("programmes.addEvent")}
                </button>
              </div>
            </ActionForm>
            {template.eventSettings ? (
              <ActionForm action="programme-template-event" back={here}>
                {ids}
                <input type="hidden" name="remove" value="1" />
                <button type="submit" className="text-sm underline">
                  {t("programmes.removeEvent")}
                </button>
              </ActionForm>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="space-y-2" aria-labelledby="template-editions">
        <h2 id="template-editions" className="text-lg font-semibold">
          {t("programmes.editions")}
        </h2>
        {template.editions.length === 0 ? (
          <p className="text-muted">{t("programmes.noEditions")}</p>
        ) : (
          <ul className="space-y-1" data-testid="template-editions">
            {template.editions.map((e) => (
              <li key={e.programmeId}>
                <a href={`/clubs/${club.id}/programmes/${e.programmeId}`} className="underline">
                  {e.title}
                </a>
                <span className="text-sm text-muted">
                  {" "}
                  {e.edition ?? ""} · {e.firstDay}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {template.canManage ? (
        <section
          className="max-w-xl space-y-3 border-t border-border pt-4"
          aria-labelledby="template-details"
        >
          <h2 id="template-details" className="text-lg font-semibold">
            {t("programmes.details")}
          </h2>
          <ActionForm action="programme-template-details" back={here} className="space-y-3">
            {ids}
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.name")}</span>
              <input
                name="name"
                required
                maxLength={120}
                defaultValue={template.name}
                className={inputClass}
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.description")}</span>
              <textarea
                name="description"
                maxLength={2000}
                defaultValue={template.description ?? ""}
                className={inputClass}
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.dayCountLabel")}</span>
              <input
                type="number"
                name="dayCount"
                min={1}
                max={31}
                defaultValue={template.dayCount}
                className={inputClass}
              />
            </label>
            <button type="submit" className={secondaryButtonClass}>
              {t("programmes.save")}
            </button>
          </ActionForm>
          {!template.archived ? (
            <ActionForm action="programme-template-archive" back={here}>
              {ids}
              <button type="submit" className="text-sm underline">
                {t("programmes.archive")}
              </button>
            </ActionForm>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

async function Item({
  item,
  slotLabel,
  placeName,
}: {
  item: ProgrammeTemplate["items"][number];
  slotLabel: ReadonlyMap<string, string>;
  placeName: ReadonlyMap<string, string>;
}) {
  const t = await getTranslations();
  const place = item.locationId
    ? (placeName.get(item.locationId) ?? "")
    : (item.locationText ?? "");
  return (
    <span className="flex flex-wrap gap-x-2">
      <span>
        {item.startTime}–{item.endTime}
      </span>
      <span className="font-medium">{item.title}</span>
      {item.activityKind ? (
        <span className="text-muted">{t(enumKey("activityKinds", item.activityKind))}</span>
      ) : (
        <span className="text-muted">
          {t("programmes.shiftItem")} × {item.needed}
        </span>
      )}
      {item.slotKeys.length > 0 ? (
        <span className="text-muted">
          {item.slotKeys.map((k) => slotLabel.get(k) ?? k).join(", ")}
        </span>
      ) : null}
      {place ? <span className="text-muted">{place}</span> : null}
    </span>
  );
}
