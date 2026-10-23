// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// The guardians of "Add member" (P1.3b): as many as the child has, each an
// existing member of the club or a new person (name, phone and optionally an
// email: with an email they are invited and linked when they accept). The
// fieldsets post as guardian.<i>.<field>. "Add guardian" adds one; without
// JavaScript its link reloads the form with one more.

import { useState } from "react";

const inputClass = "w-full rounded-md border border-border bg-bg px-3 py-2";

export interface GuardianFieldsetTexts {
  legend: string;
  source: string;
  sourceNew: string;
  sourceMember: string;
  member: string;
  chooseMember: string;
  given: string;
  family: string;
  phone: string;
  email: string;
  emailHint: string;
  kind: string;
  consentNote: string;
  consentHint: string;
  add: string;
  remove: string;
}

export function GuardianFieldsets({
  initial,
  members,
  kinds,
  texts,
  addHref,
}: {
  initial: number;
  members: readonly { id: string; label: string }[];
  kinds: readonly { value: string; label: string; linked: boolean }[];
  texts: GuardianFieldsetTexts;
  addHref: string;
}) {
  const [keys, setKeys] = useState(() => Array.from({ length: initial }, (_, i) => i));
  const [sources, setSources] = useState<Record<number, string>>({});
  const [chosenKinds, setChosenKinds] = useState<Record<number, string>>({});
  return (
    <div className="space-y-4" data-testid="guardians">
      {keys.map((key, position) => {
        const source = sources[key] ?? "new";
        const kind = chosenKinds[key] ?? "parent";
        const linked = kinds.find((k) => k.value === kind)?.linked ?? false;
        const field = (name: string) => `guardian.${key}.${name}`;
        return (
          <fieldset
            key={key}
            className="space-y-2 rounded-md border border-border p-3"
            data-testid="guardian-fieldset"
          >
            <legend className="px-1 font-medium">
              {texts.legend.replace("{number}", String(position + 1))}
            </legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {(["new", "member"] as const).map((value) => (
                <label key={value} className="inline-flex items-center gap-1">
                  <input
                    type="radio"
                    name={field("source")}
                    value={value}
                    checked={source === value}
                    onChange={() => setSources({ ...sources, [key]: value })}
                  />
                  {value === "new" ? texts.sourceNew : texts.sourceMember}
                </label>
              ))}
            </div>
            {source === "member" ? (
              <label className="block space-y-1">
                <span className="text-sm">{texts.member}</span>
                <select name={field("personId")} className={inputClass} defaultValue="">
                  <option value="">{texts.chooseMember}</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-sm">{texts.given}</span>
                  <input
                    name={field("givenName")}
                    maxLength={100}
                    className={inputClass}
                    data-testid={`guardian-${position}-given`}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">{texts.family}</span>
                  <input
                    name={field("familyName")}
                    maxLength={100}
                    className={inputClass}
                    data-testid={`guardian-${position}-family`}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">{texts.phone}</span>
                  <input type="tel" name={field("phone")} className={inputClass} />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">{texts.email}</span>
                  <input
                    type="email"
                    name={field("email")}
                    className={inputClass}
                    data-testid={`guardian-${position}-email`}
                  />
                  <span className="block text-xs text-muted">{texts.emailHint}</span>
                </label>
              </div>
            )}
            <label className="block space-y-1">
              <span className="text-sm">{texts.kind}</span>
              <select
                name={field("kind")}
                className={inputClass}
                value={kind}
                onChange={(event) => setChosenKinds({ ...chosenKinds, [key]: event.target.value })}
                data-testid={`guardian-${position}-kind`}
              >
                {kinds.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            {linked ? (
              <label className="block space-y-1">
                <span className="text-sm">{texts.consentNote}</span>
                <input
                  name={field("consentNote")}
                  maxLength={500}
                  required
                  className={inputClass}
                  data-testid={`guardian-${position}-consent`}
                />
                <span className="block text-xs text-muted">{texts.consentHint}</span>
              </label>
            ) : null}
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setKeys(keys.filter((k) => k !== key))}
            >
              {texts.remove}
            </button>
          </fieldset>
        );
      })}
      <a
        href={addHref}
        className="inline-block rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface"
        data-testid="add-guardian"
        onClick={(event) => {
          event.preventDefault();
          setKeys([...keys, (keys.at(-1) ?? -1) + 1]);
        }}
      >
        {texts.add}
      </a>
    </div>
  );
}
