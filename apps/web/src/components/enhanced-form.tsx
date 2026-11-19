// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// The form of ActionForm with JavaScript (ADR 0055): it posts to the same
// BFF action with fetch, which answers where to go as JSON. When that is the
// page the user is on (a change in place), the page's server components are
// fetched again without a reload (the frame too: the bell's count): scroll,
// focus and open sections stay, and the notice or error appears. When it is
// another page (something created, deleted, left), the browser loads it, so
// the whole frame is current there too. Without JavaScript the plain form posts and redirects
// as before; any unexpected answer falls back to the plain post.

import { usePathname, useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState, useTransition } from "react";

import { type FieldError, markFields } from "./field-errors.ts";
import {
  DraftBanner,
  type DraftMessages,
  type GuardMessages,
  LeaveDialog,
  useUnsavedGuard,
} from "./unsaved-guard.tsx";

/** The header the action route checks (server/http.ts ENHANCED_HEADER). */
const ENHANCED_HEADER = "x-clubadmin-enhanced";

export function EnhancedForm({
  action,
  className,
  testId,
  guard,
  draft,
  fieldErrors,
  children,
}: {
  action: string;
  className?: string | undefined;
  testId?: string | undefined;
  /** Ask before leaving with unsaved changes (P2.7b). */
  guard?: GuardMessages | null | undefined;
  /** Keep the values as a draft in this browser under this key (P2.7b). */
  draft?: { key: string; messages: DraftMessages } | null | undefined;
  /** What is wrong per field after a failed post of this form (P2.7c). */
  fieldErrors?: readonly FieldError[] | undefined;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const native = useRef(false);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement | null>(null);
  // Each field's message next to it, the first field focused (P2.7c).
  const errorsKey = JSON.stringify(fieldErrors ?? []);
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const first = markFields(form, JSON.parse(errorsKey) as FieldError[]);
    first?.focus();
  }, [errorsKey]);
  const unsaved = useUnsavedGuard({
    formRef,
    enabled: Boolean(guard),
    draftKey: draft?.key ?? null,
  });

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    if (native.current) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter ?? null;
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    unsaved.onSubmitting();
    const fallback = () => {
      native.current = true;
      form.requestSubmit(submitter);
    };
    try {
      const res = await fetch(action, {
        method: "POST",
        body: new FormData(form, submitter),
        headers: { [ENHANCED_HEADER]: "1", accept: "application/json" },
        credentials: "same-origin",
      });
      const body = (await res.json().catch(() => null)) as {
        redirect?: unknown;
        external?: unknown;
      } | null;
      if (!res.ok || !body) return fallback();
      const failed =
        typeof body.redirect === "string" &&
        ["error", "draft"].some((key) =>
          new URL(body.redirect as string, window.location.origin).searchParams.has(key),
        );
      if (failed) unsaved.onFailed();
      else unsaved.onSaved();
      if (typeof body.external === "string") {
        window.location.assign(body.external);
        return;
      }
      if (typeof body.redirect !== "string" || !body.redirect.startsWith("/")) return fallback();
      const target = new URL(body.redirect, window.location.origin);
      if (target.pathname !== pathname) {
        window.location.assign(target.toString());
        return;
      }
      // In place: the same page again from the server, scroll kept (ADR 0055).
      startTransition(() => {
        router.replace(`${target.pathname}${target.search}`, { scroll: false });
        router.refresh();
      });
    } catch {
      fallback();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {draft && unsaved.stored ? (
        <DraftBanner
          messages={draft.messages}
          savedAt={unsaved.stored.savedAt}
          onResume={unsaved.resume}
          onDiscard={unsaved.discard}
        />
      ) : null}
      <form
        ref={formRef}
        method="post"
        action={action}
        className={className}
        data-testid={testId}
        data-enhanced="true"
        aria-busy={busy || undefined}
        onSubmit={(event) => void onSubmit(event)}
        onInput={guard ? unsaved.onChange : undefined}
        onChange={guard ? unsaved.onChange : undefined}
      >
        {children}
      </form>
      {guard && unsaved.pending ? (
        <LeaveDialog messages={guard} onStay={unsaved.stay} onLeave={unsaved.leave} />
      ) : null}
    </>
  );
}
