// SPDX-License-Identifier: AGPL-3.0-only
// "Coming" / "Not coming" for one person and activity (P1.5, P1.6b). Two
// forms, both without client JavaScript:
// - ResponseForm (the activity page): one tap on "Coming" / "Not coming"
//   saves the answer (P2.7b, ADR 0055); the note to the leaders, a textarea
//   pre-filled with the current note, is saved with "Save the message" once
//   there is an answer (emptying it clears it).
// - ResponseButtons (agenda rows, the leaders' table): two submit buttons,
//   one per answer; the note is left out, so it stays as it is.
// The current answer is marked; after the deadline only "Not coming" is
// offered, except to leaders (`leader`), whom the deadline does not bind.
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass as saveClass, inputClass } from "./action-form.tsx";

type Status = "attending" | "not_attending" | null;

const buttonClass = (active: boolean) =>
  `rounded-md border px-3 py-1 text-sm ${
    active ? "border-accent bg-accent text-accent-fg" : "border-border hover:bg-surface"
  }`;

export async function ResponseForm({
  activityId,
  personId,
  status,
  note,
  deadlinePassed = false,
  label,
  testId = "response",
}: {
  activityId: string;
  personId: string;
  status: Status;
  note: string | null | undefined;
  deadlinePassed?: boolean;
  label?: string;
  testId?: string;
}) {
  const t = await getTranslations();
  // One tap saves the answer (ADR 0055); the note to the leaders is optional
  // and saved with its own button once there is an answer.
  const choice = (value: "attending" | "not_attending", text: string) => (
    <button
      type="submit"
      name="status"
      value={value}
      className={buttonClass(status === value)}
      aria-pressed={status === value}
      data-testid={`${testId}-${value === "attending" ? "attending" : "not-attending"}`}
    >
      {text}
    </button>
  );
  return (
    <ActionForm action="respond" className="space-y-2" testId={`${testId}-${personId}`}>
      <input type="hidden" name="activityId" value={activityId} />
      <input type="hidden" name="personId" value={personId} />
      <input type="hidden" name="noteField" value="1" />
      <div
        role="group"
        aria-label={label ?? t("responses.yourAnswer")}
        className="flex flex-wrap items-center gap-2"
      >
        {label ? <span className="text-sm">{label}</span> : null}
        {deadlinePassed ? null : choice("attending", t("responses.coming"))}
        {choice("not_attending", t("responses.notComing"))}
      </div>
      <label className="block space-y-1 text-sm">
        <span>{t("responses.noteLabel")}</span>
        <textarea
          name="note"
          rows={2}
          maxLength={200}
          className={inputClass}
          defaultValue={note ?? ""}
          data-testid={`${testId}-note`}
        />
        <span className="block text-xs text-muted">{t("responses.noteHint")}</span>
      </label>
      {status ? (
        <button
          type="submit"
          name="status"
          value={status}
          className={saveClass}
          data-testid={`${testId}-save`}
        >
          {t("responses.saveNote")}
        </button>
      ) : null}
    </ActionForm>
  );
}

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
  status: Status;
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
    </ActionForm>
  );
}
