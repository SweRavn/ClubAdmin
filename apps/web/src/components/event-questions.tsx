// SPDX-License-Identifier: AGPL-3.0-only
// The sign-up form's questions (P1.6): one input per question type, large
// touch targets, "Only the organisers see this" next to sensitive ones.
// Fields are named answer.<questionId>; type.<questionId> tells the action
// how to read them.
import type { EventQuestion } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { inputClass } from "./action-form.tsx";

type Answer = string | number | boolean | string[];

export async function EventQuestions({
  questions,
  answers = {},
}: {
  questions: readonly EventQuestion[];
  answers?: Record<string, Answer>;
}) {
  const t = await getTranslations();
  return (
    <div className="space-y-3">
      {questions.map((q) => {
        const name = `answer.${q.id}`;
        const value = answers[q.id];
        const label = (
          <span className="text-sm">
            {q.label}
            {q.required ? " *" : ""}
            {q.sensitive ? (
              <span className="block text-xs text-muted">{t("events.sensitiveHint")}</span>
            ) : null}
          </span>
        );
        const hidden = <input type="hidden" name={`type.${q.id}`} value={q.type} />;
        switch (q.type) {
          case "long_text":
            return (
              <label key={q.id} className="block space-y-1">
                {label}
                {hidden}
                <textarea
                  name={name}
                  rows={3}
                  maxLength={2000}
                  required={q.required}
                  className={inputClass}
                  defaultValue={typeof value === "string" ? value : ""}
                />
              </label>
            );
          case "choice":
            return (
              <fieldset key={q.id} className="space-y-1">
                <legend>{label}</legend>
                {hidden}
                {(q.options ?? []).map((o) => (
                  <label key={o} className="flex items-center gap-2 py-1">
                    <input
                      type="radio"
                      name={name}
                      value={o}
                      required={q.required}
                      defaultChecked={value === o}
                      className="h-5 w-5"
                    />
                    {o}
                  </label>
                ))}
              </fieldset>
            );
          case "choices":
            return (
              <fieldset key={q.id} className="space-y-1">
                <legend>{label}</legend>
                {hidden}
                {(q.options ?? []).map((o) => (
                  <label key={o} className="flex items-center gap-2 py-1">
                    <input
                      type="checkbox"
                      name={name}
                      value={o}
                      defaultChecked={Array.isArray(value) && value.includes(o)}
                      className="h-5 w-5"
                    />
                    {o}
                  </label>
                ))}
              </fieldset>
            );
          case "yes_no":
            return (
              <fieldset key={q.id} className="space-y-1">
                <legend>{label}</legend>
                {hidden}
                {(["yes", "no"] as const).map((o) => (
                  <label key={o} className="mr-4 inline-flex items-center gap-2 py-1">
                    <input
                      type="radio"
                      name={name}
                      value={o}
                      required={q.required}
                      defaultChecked={value === (o === "yes")}
                      className="h-5 w-5"
                    />
                    {t(o === "yes" ? "events.yes" : "events.no")}
                  </label>
                ))}
              </fieldset>
            );
          default:
            return (
              <label key={q.id} className="block space-y-1">
                {label}
                {hidden}
                <input
                  name={name}
                  type={q.type === "number" ? "number" : "text"}
                  required={q.required}
                  maxLength={q.type === "number" ? undefined : 200}
                  className={inputClass}
                  defaultValue={
                    typeof value === "string" || typeof value === "number" ? String(value) : ""
                  }
                />
              </label>
            );
        }
      })}
    </div>
  );
}

/** An answer as text (lists, yes/no). */
export function answerText(value: Answer | undefined, yes: string, no: string): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? yes : no;
  return String(value);
}
