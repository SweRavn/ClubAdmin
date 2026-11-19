// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// The chat's emoji button (P2.7b): opens a searchable panel with categories
// and recently used emoji. The panel and its data (emojibase-data, in the
// viewer's language) are loaded on the first open, so neither is in the
// page's initial JavaScript (ADR 0027). Used for the message field (insert
// at the cursor) and for reactions.

import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";

import type { EmojiTexts } from "./emoji-panel.tsx";

export type { EmojiTexts } from "./emoji-panel.tsx";

const EmojiPanel = lazy(() => import("./emoji-panel.tsx").then((m) => ({ default: m.EmojiPanel })));

export function EmojiPicker({
  texts,
  locale,
  onPick,
  trigger,
  testId,
  align = "end",
}: {
  texts: EmojiTexts;
  locale: string;
  onPick: (emoji: string) => void;
  /** What the button shows (default: a smiley). */
  trigger?: ReactNode;
  testId?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={texts.open}
        title={texts.open}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="rounded-md px-2 py-1 text-lg hover:bg-surface"
        data-testid={testId ?? "emoji-open"}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger ?? "😊"}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={texts.open}
          className={`absolute bottom-full z-20 mb-1 ${align === "end" ? "right-0" : "left-0"}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <Suspense
            fallback={
              <p className="rounded-md border border-border bg-raised p-3 text-sm">
                {texts.loading}
              </p>
            }
          >
            <EmojiPanel
              texts={texts}
              locale={locale}
              onPick={(emoji) => {
                onPick(emoji);
                setOpen(false);
              }}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
