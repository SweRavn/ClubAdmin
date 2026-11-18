// SPDX-License-Identifier: AGPL-3.0-only
// The club's volunteer duties (P2.6, ADR 0050): the duty types (name,
// instruction, minimum age, contact with children; "alone with children"
// only where the country pack and the club allow it), archiving and
// restoring them, and the club's settings (who sees names on shifts,
// whether groups may choose, the club's own ban on being alone with children).
import { enumKey } from "@clubadmin/i18n";
import { DUTY_CHILD_CONTACTS, DUTY_VISIBILITIES, type DutyType } from "@clubadmin/shared";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getClub, getDutySettings, getDutyTypes } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("duties.title") };
}

async function TypeFields({ type, aloneAllowed }: { type?: DutyType; aloneAllowed: boolean }) {
  const t = await getTranslations();
  const contacts = DUTY_CHILD_CONTACTS.filter(
    (c) => c !== "alone_with_children" || aloneAllowed || type?.childContact === c,
  );
  return (
    <>
      <label className="block space-y-1">
        <span className="text-sm">{t("duties.typeName")}</span>
        <input
          name="name"
          required
          maxLength={100}
          defaultValue={type?.name ?? ""}
          className={inputClass}
          data-testid="duty-type-name"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm">{t("duties.minAge")}</span>
        <input
          type="number"
          name="minAge"
          min={0}
          max={99}
          defaultValue={type?.minAge ?? ""}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm">{t("duties.childContact")}</span>
        <select
          name="childContact"
          className={inputClass}
          defaultValue={type?.childContact ?? "none"}
        >
          {contacts.map((c) => (
            <option key={c} value={c}>
              {t(enumKey("duties.childContacts", c))}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 sm:col-span-2">
        <span className="text-sm">{t("duties.instruction")}</span>
        <textarea
          name="instruction"
          rows={2}
          maxLength={2000}
          defaultValue={type?.instruction ?? ""}
          className={inputClass}
        />
      </label>
    </>
  );
}

export default async function ClubDutiesPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, types, archived, settings] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getDutyTypes(clubId),
    getDutyTypes(clubId, true),
    getDutySettings(clubId),
  ]);
  if (!types) forbidden();
  const back = `/clubs/${club.id}/duties`;
  const common = (
    <>
      <input type="hidden" name="clubId" value={club.id} />
      <input type="hidden" name="back" value={back} />
    </>
  );

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}`} className="underline">
            {club.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("duties.title")}</h1>
        <p className="text-sm text-muted">{t("duties.clubIntro")}</p>
      </div>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("duties.saved")}</Notice> : null}

      <section aria-labelledby="types" className="space-y-3">
        <h2 id="types" className="text-lg font-semibold">
          {t("duties.types")}
        </h2>
        {types.items.length === 0 ? (
          <p className="text-sm text-muted">{t("duties.noTypes")}</p>
        ) : (
          <ul className="space-y-3" data-testid="duty-types">
            {types.items.map((d) => (
              <li key={d.id} className="space-y-2 rounded-lg border border-border p-3">
                {types.canManage ? (
                  <>
                    <ActionForm action="duty-type-update" className="grid gap-3 sm:grid-cols-3">
                      {common}
                      <input type="hidden" name="typeId" value={d.id} />
                      <TypeFields type={d} aloneAllowed={types.aloneWithChildrenAllowed} />
                      <div>
                        <button type="submit" className={buttonClass}>
                          {t("duties.save")}
                        </button>
                      </div>
                    </ActionForm>
                    <ActionForm action="duty-type-update">
                      {common}
                      <input type="hidden" name="typeId" value={d.id} />
                      <input type="hidden" name="archive" value="archive" />
                      <button type="submit" className={secondaryButtonClass}>
                        {t("duties.archive")}
                      </button>
                    </ActionForm>
                  </>
                ) : (
                  <>
                    <p className="font-medium">{d.name}</p>
                    <p className="text-sm text-muted">
                      {t(enumKey("duties.childContacts", d.childContact))}
                      {d.minAge !== null ? ` · ${t("duties.fromAge", { age: d.minAge })}` : ""}
                    </p>
                    {d.instruction ? <p className="text-sm">{d.instruction}</p> : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {types.canManage ? (
        <section aria-labelledby="new-type" className="space-y-2">
          <h2 id="new-type" className="text-lg font-semibold">
            {t("duties.newType")}
          </h2>
          <ActionForm action="duty-type-create" className="grid gap-3 sm:grid-cols-3">
            {common}
            <TypeFields aloneAllowed={types.aloneWithChildrenAllowed} />
            <div>
              <button type="submit" className={buttonClass} data-testid="duty-type-create">
                {t("duties.createType")}
              </button>
            </div>
          </ActionForm>
          {!types.aloneWithChildrenAllowed ? (
            <p className="text-sm text-muted">{t("duties.aloneForbidden")}</p>
          ) : null}
        </section>
      ) : null}

      {types.canManage && archived && archived.items.length > 0 ? (
        <section aria-labelledby="archived" className="space-y-2">
          <h2 id="archived" className="text-lg font-semibold">
            {t("duties.archived")}
          </h2>
          <ul className="space-y-2">
            {archived.items.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 text-sm">
                <span>{d.name}</span>
                <ActionForm action="duty-type-update">
                  {common}
                  <input type="hidden" name="typeId" value={d.id} />
                  <input type="hidden" name="archive" value="restore" />
                  <button type="submit" className={secondaryButtonClass}>
                    {t("duties.restore")}
                  </button>
                </ActionForm>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {settings ? (
        <section aria-labelledby="settings" className="space-y-2">
          <h2 id="settings" className="text-lg font-semibold">
            {t("duties.settings")}
          </h2>
          <ActionForm action="duty-settings" className="space-y-3" testId="duty-settings">
            {common}
            <label className="block space-y-1">
              <span className="text-sm">{t("duties.visibility")}</span>
              <select name="visibility" className={inputClass} defaultValue={settings.visibility}>
                {DUTY_VISIBILITIES.map((v) => (
                  <option key={v} value={v}>
                    {t(enumKey("duties.visibilities", v))}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="groupsMayChangeVisibility"
                defaultChecked={settings.groupsMayChangeVisibility}
              />
              {t("duties.groupsMayChange")}
            </label>
            {settings.countryForbidsAloneWithChildren ? (
              <>
                <p className="text-sm text-muted">{t("duties.countryForbidsAlone")}</p>
                {settings.aloneWithChildrenForbidden ? (
                  <input type="hidden" name="aloneWithChildrenForbidden" value="on" />
                ) : null}
              </>
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="aloneWithChildrenForbidden"
                  defaultChecked={settings.aloneWithChildrenForbidden}
                />
                {t("duties.clubForbidsAlone")}
              </label>
            )}
            <button type="submit" className={buttonClass}>
              {t("duties.save")}
            </button>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
