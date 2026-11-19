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
import { type FormEvent, type ReactNode, useRef, useState, useTransition } from "react";

/** The header the action route checks (server/http.ts ENHANCED_HEADER). */
const ENHANCED_HEADER = "x-clubadmin-enhanced";

export function EnhancedForm({
  action,
  className,
  testId,
  children,
}: {
  action: string;
  className?: string | undefined;
  testId?: string | undefined;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const native = useRef(false);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    if (native.current) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter ?? null;
    event.preventDefault();
    if (busy) return;
    setBusy(true);
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
    <form
      method="post"
      action={action}
      className={className}
      data-testid={testId}
      data-enhanced="true"
      aria-busy={busy || undefined}
      onSubmit={(event) => void onSubmit(event)}
    >
      {children}
    </form>
  );
}
