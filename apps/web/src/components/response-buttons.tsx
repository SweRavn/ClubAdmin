// SPDX-License-Identifier: AGPL-3.0-only
// "Coming" / "Not coming" for one person and activity (P1.5): one form with
// two submit buttons and an optional note to the leaders behind a
// disclosure, so it works without client JavaScript. The current answer is
// marked (aria-pressed); after the deadline only "Not coming" is offered.
import { getTranslations } from "next-intl/server";

import { ActionForm, inputClass } from "./action-form.tsx";

const buttonClass = (active: boolean) =>
  `rounded-md border px-3 py-1 text-sm ${
    active ? "border-accent bg-accent text-accent-fg" : "border-border hover:bg-surface"
  }`;

export async function ResponseButtons({
  activityId,
  personId,
  status,
  deadlinePassed = false,
  label,
  testId = "response",
}: {
  activityId: string;
  personId: string;
  status: "attending" | "not_attending" | null;
  deadlinePassed?: boolean;
  /** Whose answer, when the viewer answers for several people. */
  label?: string;
  testId?: string;
}) {
  const t = await getTranslations();
  return (
    <ActionForm
      action="respond"
      className="flex flex-wrap items-center gap-2"
      testId={`${testId}-${personId}`}
    >
      <input type="hidden" name="activityId" value={activityId} />
      <input type="hidden" name="personId" value={personId} />
      {label ? <span className="text-sm">{label}</span> : null}
      {deadlinePassed ? null : (
        <button
          type="submit"
          name="status"
          value="attending"
          className={buttonClass(status === "attending")}
          aria-pressed={status === "attending"}
          data-testid={`${testId}-attending`}
        >
          {t("responses.coming")}
        </button>
      )}
      <button
        type="submit"
        name="status"
        value="not_attending"
        className={buttonClass(status === "not_attending")}
        aria-pressed={status === "not_attending"}
        data-testid={`${testId}-not-attending`}
      >
        {t("responses.notComing")}
      </button>
      <details className="w-full text-sm">
        <summary className="cursor-pointer text-muted">{t("responses.addNote")}</summary>
        <label className="mt-1 block space-y-1">
          <span>{t("responses.noteLabel")}</span>
          <input name="note" maxLength={200} className={inputClass} />
          <span className="block text-xs text-muted">{t("responses.noteHint")}</span>
        </label>
      </details>
    </ActionForm>
  );
}
