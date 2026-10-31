// SPDX-License-Identifier: AGPL-3.0-only
// The fields of the group forms (P1.6b): name, kind, parent group and the
// optional details. A failed save shows the values typed (form drafts).
import { enumKey } from "@clubadmin/i18n";
import {
  ADMISSION_MODES,
  GENDER_CATEGORIES,
  GROUP_KINDS,
  type GroupResponse,
} from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import type { FormDraft } from "../server/form-drafts.ts";
import { inputClass } from "./action-form.tsx";

export interface GroupFieldValues {
  name?: string;
  kind?: string;
  parentGroupId?: string | null;
  sport?: string | null;
  birthYearFrom?: number | null;
  birthYearTo?: number | null;
  genderCategory?: string | null;
  level?: string | null;
  capacity?: number | null;
  admissionMode?: string;
  offerReplyDays?: number;
}

export async function GroupFields({
  values = {},
  parents,
  draft = null,
}: {
  values?: GroupFieldValues;
  /** The groups that may be the parent (not the group itself). */
  parents: readonly GroupResponse[];
  draft?: FormDraft | null;
}) {
  const t = await getTranslations();
  const value = (name: keyof GroupFieldValues) =>
    draft ? (draft.get(name)?.[0] ?? "") : String(values[name] ?? "");
  const input = (
    name: keyof GroupFieldValues,
    label: string,
    props: Record<string, unknown> = {},
  ) => (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <input
        name={name}
        className={inputClass}
        defaultValue={value(name)}
        data-testid={`group-${name}`}
        {...props}
      />
    </label>
  );
  const select = (
    name: keyof GroupFieldValues,
    label: string,
    options: readonly { value: string; label: string }[],
  ) => (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <select
        name={name}
        className={inputClass}
        defaultValue={value(name)}
        data-testid={`group-${name}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {input("name", t("groupForm.name"), { required: true, maxLength: 100 })}
      {select(
        "kind",
        t("group.kind"),
        GROUP_KINDS.map((k) => ({ value: k, label: t(enumKey("kinds", k)) })),
      )}
      {select("parentGroupId", t("group.partOf"), [
        { value: "", label: t("groupForm.noParent") },
        ...parents.filter((g) => !g.archived).map((g) => ({ value: g.id, label: g.name })),
      ])}
      {input("sport", t("group.sport"), { maxLength: 50 })}
      {input("birthYearFrom", t("groupForm.birthYearFrom"), {
        type: "number",
        min: 1900,
        max: 2100,
      })}
      {input("birthYearTo", t("groupForm.birthYearTo"), { type: "number", min: 1900, max: 2100 })}
      {select("genderCategory", t("groupForm.genderCategory"), [
        { value: "", label: t("groupForm.notSet") },
        ...GENDER_CATEGORIES.map((g) => ({
          value: g,
          label: t(enumKey("groupForm.genderCategories", g)),
        })),
      ])}
      {input("level", t("groupForm.level"), { maxLength: 50 })}
      {input("capacity", t("group.capacity"), { type: "number", min: 0, max: 10000 })}
      {select(
        "admissionMode",
        t("groupForm.admissionMode"),
        ADMISSION_MODES.map((m) => ({
          value: m,
          label: t(enumKey("groupForm.admissionModes", m)),
        })),
      )}
      {input("offerReplyDays", t("groupForm.offerReplyDays"), { type: "number", min: 1, max: 60 })}
    </div>
  );
}
