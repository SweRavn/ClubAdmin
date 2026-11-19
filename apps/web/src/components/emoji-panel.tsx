// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// The emoji panel (P2.7b), loaded on the picker's first open: emoji by
// category with the category names and search terms in the viewer's
// language (emojibase-data: sv, nb or en), recently used first (this
// browser only), searchable, and usable with the keyboard: the search
// field has focus, arrow keys move in the grid, Enter picks.

import { useEffect, useMemo, useRef, useState } from "react";

export type EmojiTexts = {
  /** The button's accessible name. */
  open: string;
  search: string;
  recent: string;
  none: string;
  loading: string;
};

type Emoji = { unicode: string; label: string; tags: string[]; group: number };
type Group = { order: number; name: string };
type Data = { emoji: Emoji[]; groups: Group[] };

type CompactEntry = {
  unicode: string;
  label: string;
  tags?: string[];
  group?: number;
  order?: number;
};
type Messages = { groups: { order: number; message: string }[] };

/** The emojibase group of skin tones and hair components: not offered alone. */
const COMPONENT_GROUP = 2;
const RECENT_KEY = "clubadmin.emoji.recent";
const RECENT_MAX = 24;
/** Emoji per row of the grid (arrow keys move by this much up and down). */
const COLUMNS = 8;

const cache = new Map<string, Promise<Data>>();

/** The viewer's data, loaded once per language. */
function load(locale: string): Promise<Data> {
  const language = locale.slice(0, 2);
  const lang = language === "sv" || language === "nb" ? language : "en";
  let data = cache.get(lang);
  if (!data) {
    const files: Promise<[{ default: unknown }, { default: unknown }]> =
      lang === "sv"
        ? Promise.all([
            import("emojibase-data/sv/compact.json"),
            import("emojibase-data/sv/messages.json"),
          ])
        : lang === "nb"
          ? Promise.all([
              import("emojibase-data/nb/compact.json"),
              import("emojibase-data/nb/messages.json"),
            ])
          : Promise.all([
              import("emojibase-data/en/compact.json"),
              import("emojibase-data/en/messages.json"),
            ]);
    data = files.then(([compact, messages]) => ({
      emoji: (compact.default as CompactEntry[])
        .filter(
          (e): e is CompactEntry & { group: number } =>
            e.group !== undefined && e.group !== COMPONENT_GROUP,
        )
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((e) => ({ unicode: e.unicode, label: e.label, tags: e.tags ?? [], group: e.group })),
      groups: (messages.default as Messages).groups
        .filter((g) => g.order !== COMPONENT_GROUP)
        .map((g) => ({ order: g.order, name: g.message })),
    }));
    cache.set(lang, data);
  }
  return data;
}

function readRecent(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function remember(emoji: string): void {
  try {
    const next = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: nothing is remembered.
  }
}

export function EmojiPanel({
  texts,
  locale,
  onPick,
}: {
  texts: EmojiTexts;
  locale: string;
  onPick: (emoji: string) => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<number | "recent">("recent");
  const [recent] = useState(readRecent);
  const grid = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    void load(locale).then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, [locale]);

  useEffect(() => {
    if (data && recent.length === 0 && group === "recent") setGroup(data.groups[0]?.order ?? 0);
  }, [data, recent.length, group]);

  const shown = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLocaleLowerCase(locale);
    if (q) {
      return data.emoji
        .filter(
          (e) =>
            e.label.toLocaleLowerCase(locale).includes(q) ||
            e.tags.some((t) => t.toLocaleLowerCase(locale).startsWith(q)),
        )
        .slice(0, 120);
    }
    if (group === "recent") {
      const byUnicode = new Map(data.emoji.map((e) => [e.unicode, e]));
      return recent.map((u) => byUnicode.get(u) ?? { unicode: u, label: u, tags: [], group: -1 });
    }
    return data.emoji.filter((e) => e.group === group);
  }, [data, query, group, recent, locale]);

  const pick = (emoji: string) => {
    remember(emoji);
    onPick(emoji);
  };

  const move = (from: number, by: number) => {
    const buttons = grid.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!buttons || buttons.length === 0) return;
    const to = Math.max(0, Math.min(buttons.length - 1, from + by));
    buttons[to]?.focus();
  };

  return (
    <div
      className="w-80 max-w-[calc(100vw-2rem)] space-y-2 rounded-md border border-border bg-raised p-2 shadow-lg"
      data-testid="emoji-panel"
    >
      <input
        type="search"
        // The panel opens to search: focus goes to the field.
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(0, 0);
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (shown[0]) pick(shown[0].unicode);
          }
        }}
        placeholder={texts.search}
        aria-label={texts.search}
        className="w-full rounded-md border border-border bg-bg px-2 py-1 text-sm"
        data-testid="emoji-search"
      />
      {!query && data ? (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label={texts.open}>
          {recent.length > 0 ? (
            <CategoryTab
              label={texts.recent}
              icon="🕘"
              selected={group === "recent"}
              onSelect={() => setGroup("recent")}
            />
          ) : null}
          {data.groups.map((g) => (
            <CategoryTab
              key={g.order}
              label={g.name}
              icon={data.emoji.find((e) => e.group === g.order)?.unicode ?? "•"}
              selected={group === g.order}
              onSelect={() => setGroup(g.order)}
            />
          ))}
        </div>
      ) : null}
      {!data ? (
        <p className="p-2 text-sm text-muted">{texts.loading}</p>
      ) : shown.length === 0 ? (
        <p className="p-2 text-sm text-muted">{texts.none}</p>
      ) : (
        <div
          ref={grid}
          className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto"
          data-testid="emoji-grid"
        >
          {shown.map((e, i) => (
            <button
              key={e.unicode}
              type="button"
              title={e.label}
              aria-label={e.label}
              className="rounded p-1 text-xl hover:bg-surface focus:bg-accent-soft"
              data-testid="emoji-option"
              onClick={() => pick(e.unicode)}
              onKeyDown={(event) => {
                const by =
                  event.key === "ArrowRight"
                    ? 1
                    : event.key === "ArrowLeft"
                      ? -1
                      : event.key === "ArrowDown"
                        ? COLUMNS
                        : event.key === "ArrowUp"
                          ? -COLUMNS
                          : 0;
                if (by !== 0) {
                  event.preventDefault();
                  move(i, by);
                }
              }}
            >
              {e.unicode}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryTab({
  label,
  icon,
  selected,
  onSelect,
}: {
  label: string;
  icon: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={label}
      title={label}
      className="rounded px-1 text-lg aria-selected:bg-accent-soft"
      onClick={onSelect}
    >
      {icon}
    </button>
  );
}
