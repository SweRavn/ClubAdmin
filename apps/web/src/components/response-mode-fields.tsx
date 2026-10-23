// SPDX-License-Identifier: AGPL-3.0-only
// Whether an activity or series asks for answers, and the deadline in hours
// before the start (P1.5). Empty mode: the default of the activity's kind.
import { enumKey } from "@clubadmin/i18n";
import { RESPONSE_MODES } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { inputClass } from "./action-form.tsx";

export async function ResponseModeFields({
  mode,
  hours,
}: {
  mode?: string | null | undefined;
  hours?: number | null | undefined;
}) {
  const t = await getTranslations();
  return (
    <>
      <label className="block space-y-1">
        <span className="text-sm">{t("responses.mode")}</span>
        <select
          name="responseMode"
          className={inputClass}
          defaultValue={mode ?? ""}
          data-testid="response-mode"
        >
          <option value="">{t("responses.modeDefault")}</option>
          {RESPONSE_MODES.map((m) => (
            <option key={m} value={m}>
              {t(enumKey("responseModes", m))}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-sm">{t("responses.respondBy")}</span>
        <input
          name="respondByHours"
          type="number"
          min={0}
          max={336}
          step={1}
          className={inputClass}
          defaultValue={hours ?? ""}
          data-testid="respond-by-hours"
        />
        <span className="block text-xs text-muted">{t("responses.respondByHint")}</span>
      </label>
    </>
  );
}
