// SPDX-License-Identifier: AGPL-3.0-only
// A form posting to one of the joining actions (server/actions.ts), with the
// CSRF token and where to come back to. Works without client JavaScript.
import type { ReactNode } from "react";

import { currentPath, requireSession } from "../server/data.ts";

export async function ActionForm({
  action,
  children,
  back,
  className,
  testId,
}: {
  action: string;
  children: ReactNode;
  /** Where to return (default: the current page, without its error). */
  back?: string;
  className?: string;
  testId?: string;
}) {
  const [session, path] = await Promise.all([requireSession(), currentPath()]);
  const url = new URL(back ?? path, "https://internal.invalid");
  for (const key of NOTICE_PARAMS) url.searchParams.delete(key);
  return (
    <form method="post" action={`/actions/${action}`} className={className} data-testid={testId}>
      <input type="hidden" name="csrf" value={session.record.csrf} />
      <input type="hidden" name="back" value={`${url.pathname}${url.search}`} />
      {children}
    </form>
  );
}

/** Result flags the actions add to the return path (shown once as a notice). */
const NOTICE_PARAMS = [
  "error",
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
  "deleted",
  "answered",
  "stale",
];

export const buttonClass = "rounded-md bg-accent px-4 py-2 text-sm text-accent-fg";
export const secondaryButtonClass =
  "rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface";
export const inputClass = "w-full rounded-md border border-border bg-bg px-3 py-2";
