// SPDX-License-Identifier: AGPL-3.0-only
// A form posting to one of the form actions (server/actions.ts), with the
// CSRF token and where to come back to. Works without client JavaScript;
// with it, the change happens in place without reloading the page
// (EnhancedForm, ADR 0055).
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { currentPath, requireSession } from "../server/data.ts";
import { EnhancedForm } from "./enhanced-form.tsx";

export async function ActionForm({
  action,
  children,
  back,
  className,
  testId,
  guard,
  draft,
}: {
  action: string;
  children: ReactNode;
  /** Where to return (default: the current page, without its error). */
  back?: string;
  className?: string;
  testId?: string;
  /**
   * Ask before leaving the page with unsaved changes (P2.7b): forms where
   * more than one field is typed (an event, an activity, a role).
   */
  guard?: boolean;
  /**
   * Also keep what was typed as a draft in this browser under this name
   * (a new event), offered again when the form is opened. Implies guard.
   */
  draft?: string;
}) {
  const [session, path, t] = await Promise.all([
    requireSession(),
    currentPath(),
    getTranslations("unsaved"),
  ]);
  const url = new URL(back ?? path, "https://internal.invalid");
  for (const key of NOTICE_PARAMS) url.searchParams.delete(key);
  const guarded = Boolean(guard || draft);
  return (
    <EnhancedForm
      action={`/actions/${action}`}
      className={className}
      testId={testId}
      guard={
        guarded
          ? {
              question: t("question"),
              draftKept: draft ? t("draftKept") : null,
              stay: t("stay"),
              leave: t("leave"),
            }
          : null
      }
      draft={
        draft
          ? {
              // Per person: another person on this browser never sees it.
              key: `${session.record.personId}.${draft}`,
              messages: { found: t("draftFound"), resume: t("resume"), discard: t("discard") },
            }
          : null
      }
    >
      <input type="hidden" name="csrf" value={session.record.csrf} />
      <input type="hidden" name="back" value={`${url.pathname}${url.search}`} />
      {children}
    </EnhancedForm>
  );
}

/** Result flags the actions add to the return path (shown once as a notice). */
const NOTICE_PARAMS = [
  "error",
  "removed",
  "created",
  "protection",
  "protectedChild",
  "decided",
  "requested",
  "updated",
  "added",
  "invited",
  "linked",
  "resent",
  "ended",
  "accepted",
  "ownLogin",
  "merged",
  "undone",
  "saved",
  "locked",
  "deleted",
  "uploaded",
  "answered",
  "stale",
  "rows",
  "draft",
  "qrows",
  "srows",
  "prows",
  "owner",
  "member",
  "season",
  "archived",
  "adopted",
  "signed",
  "assembled",
];

export const buttonClass = "rounded-md bg-accent px-4 py-2 text-sm text-accent-fg";
export const secondaryButtonClass =
  "rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface";
export const inputClass = "w-full rounded-md border border-border bg-bg px-3 py-2";
