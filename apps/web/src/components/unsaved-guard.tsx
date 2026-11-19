// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Leaving a form with unsaved changes (P2.7b): an ActionForm with `guard`
// asks first. Closing the tab or reloading gets the browser's own prompt;
// a link inside the app gets an in-app dialog ("Stanna kvar" / "Lämna
// sidan"). With `draft` the form's values are also kept in this browser
// (localStorage, per person and form, never sent to the server) while the
// user types, and the form offers to continue them the next time it is
// opened. A successful submit clears the draft. Without JavaScript nothing
// of this happens and the form works as before.

import {
  type ComponentProps,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export type GuardMessages = {
  question: string;
  draftKept: string | null;
  stay: string;
  leave: string;
};

export type DraftMessages = { found: string; resume: string; discard: string };

const DRAFT_PREFIX = "clubadmin.draft.";
/** Fields never kept in a draft (the CSRF token, where to return). */
const SKIPPED = new Set(["csrf", "back"]);

type Stored = { savedAt: number; fields: [string, string][] };

function readDraft(key: string): Stored | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    return Array.isArray(parsed.fields) && parsed.fields.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function removeDraft(key: string): void {
  try {
    window.localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    // Storage blocked: there is nothing to remove.
  }
}

function writeDraft(key: string, form: HTMLFormElement): void {
  const fields: [string, string][] = [];
  for (const [name, value] of new FormData(form)) {
    if (SKIPPED.has(name) || typeof value !== "string") continue;
    fields.push([name, value]);
  }
  try {
    window.localStorage.setItem(
      DRAFT_PREFIX + key,
      JSON.stringify({ savedAt: Date.now(), fields } satisfies Stored),
    );
  } catch {
    // Storage full or blocked: the guard still asks.
  }
}

/** Puts a draft's values back into the form's fields (those that still exist). */
function fillForm(form: HTMLFormElement, fields: [string, string][]): void {
  const values = new Map<string, string[]>();
  for (const [name, value] of fields) values.set(name, [...(values.get(name) ?? []), value]);
  for (const element of Array.from(form.elements)) {
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ) ||
      !element.name ||
      SKIPPED.has(element.name) ||
      (element instanceof HTMLInputElement &&
        (element.type === "hidden" || element.type === "file"))
    ) {
      continue;
    }
    const wanted = values.get(element.name) ?? [];
    if (
      element instanceof HTMLInputElement &&
      (element.type === "checkbox" || element.type === "radio")
    ) {
      element.checked = wanted.includes(element.value);
    } else if (element instanceof HTMLSelectElement && element.multiple) {
      for (const option of Array.from(element.options)) {
        option.selected = wanted.includes(option.value);
      }
    } else if (wanted.length > 0) {
      // Several fields with one name (rows): each takes the next value.
      element.value = wanted.shift() ?? "";
      values.set(element.name, wanted);
    }
  }
}

/** A plain left click on a link to another page of this site. */
function leavingLink(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest?.("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === window.location.pathname && url.search === window.location.search) {
    return null;
  }
  return url.toString();
}

export function useUnsavedGuard({
  formRef,
  enabled,
  draftKey,
}: {
  formRef: RefObject<HTMLFormElement | null>;
  enabled: boolean;
  draftKey: string | null;
}) {
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [stored, setStored] = useState<Stored | null>(null);

  useEffect(() => {
    if (draftKey) setStored(readDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (!enabled) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      event.preventDefault();
      // Older browsers need returnValue set to show their prompt.
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if (!dirty.current) return;
      const href = leavingLink(event);
      if (!href) return;
      event.preventDefault();
      event.stopPropagation();
      setPending(href);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [enabled]);

  const onChange = useCallback(() => {
    if (!enabled) return;
    dirty.current = true;
    const form = formRef.current;
    if (!draftKey || !form) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => writeDraft(draftKey, form), 300);
  }, [enabled, draftKey, formRef]);

  /** Before the form is sent: the page may change, so nothing to ask. */
  const onSubmitting = useCallback(() => {
    dirty.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  /** The form came back with an error: its changes are still unsaved. */
  const onFailed = useCallback(() => {
    if (enabled) dirty.current = true;
  }, [enabled]);

  /** Saved: the draft is done with. */
  const onSaved = useCallback(() => {
    if (draftKey) removeDraft(draftKey);
  }, [draftKey]);

  const stay = useCallback(() => setPending(null), []);
  const leave = useCallback(() => {
    const href = pending;
    if (!href) return;
    if (draftKey && formRef.current) writeDraft(draftKey, formRef.current);
    dirty.current = false;
    setPending(null);
    window.location.assign(href);
  }, [pending, draftKey, formRef]);

  const resume = useCallback(() => {
    if (stored && formRef.current) {
      fillForm(formRef.current, stored.fields);
      dirty.current = enabled;
    }
    setStored(null);
  }, [stored, formRef, enabled]);

  const discard = useCallback(() => {
    if (draftKey) removeDraft(draftKey);
    setStored(null);
  }, [draftKey]);

  return {
    pending,
    stored,
    onChange,
    onSubmitting,
    onFailed,
    onSaved,
    stay,
    leave,
    resume,
    discard,
  };
}

export function LeaveDialog({
  messages,
  onStay,
  onLeave,
}: {
  messages: GuardMessages;
  onStay: () => void;
  onLeave: () => void;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="max-w-sm rounded-lg border border-border bg-raised p-4 text-fg backdrop:bg-black/40"
      aria-labelledby="unsaved-question"
      data-testid="unsaved-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onStay();
      }}
    >
      <p id="unsaved-question" className="font-medium">
        {messages.question}
      </p>
      {messages.draftKept ? <p className="mt-1 text-sm text-muted">{messages.draftKept}</p> : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-2 text-sm text-accent-fg"
          onClick={onStay}
          data-testid="unsaved-stay"
          autoFocus
        >
          {messages.stay}
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface"
          onClick={onLeave}
          data-testid="unsaved-leave"
        >
          {messages.leave}
        </button>
      </div>
    </dialog>
  );
}

export function DraftBanner({
  messages,
  savedAt,
  onResume,
  onDiscard,
}: {
  messages: DraftMessages;
  savedAt: number;
  onResume: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-accent-soft p-3 text-sm"
      role="status"
      data-testid="draft-banner"
    >
      <span>
        {messages.found}{" "}
        <time dateTime={new Date(savedAt).toISOString()}>
          {new Date(savedAt).toLocaleString(document.documentElement.lang || undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </time>
      </span>
      <span className="ml-auto flex gap-2">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg"
          onClick={onResume}
          data-testid="draft-resume"
        >
          {messages.resume}
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface"
          onClick={onDiscard}
          data-testid="draft-discard"
        >
          {messages.discard}
        </button>
      </span>
    </div>
  );
}

/**
 * A plain form (a GET form leading to a review step, such as a role's
 * permissions) that asks before the user leaves it with changes.
 */
export function GuardedForm({
  messages,
  children,
  ...props
}: ComponentProps<"form"> & { messages: GuardMessages; "data-testid"?: string }) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const unsaved = useUnsavedGuard({ formRef, enabled: true, draftKey: null });
  return (
    <>
      <form
        {...props}
        ref={formRef}
        onInput={unsaved.onChange}
        onChange={unsaved.onChange}
        onSubmit={unsaved.onSubmitting}
      >
        {children}
      </form>
      {unsaved.pending ? (
        <LeaveDialog messages={messages} onStay={unsaved.stay} onLeave={unsaved.leave} />
      ) : null}
    </>
  );
}
