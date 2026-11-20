// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// The title follows the kind (P2.7e): "Match", "Träning", or what "Other"
// is called, until the person writes a title of their own. Without
// JavaScript the form starts with the default kind's name and the action
// uses the kind's name when the title is left empty.
import { useEffect, useRef } from "react";

export function TitleFromKind({ titles }: { titles: Record<string, string> }) {
  const marker = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const form = marker.current?.closest("form");
    if (!form) return;
    const kind = form.elements.namedItem("kind") as HTMLSelectElement | null;
    const label = form.elements.namedItem("kindLabel") as HTMLInputElement | null;
    const title = form.elements.namedItem("title") as HTMLInputElement | null;
    if (!kind || !title) return;
    const nameOf = () =>
      kind.value === "other" && label?.value.trim()
        ? label.value.trim()
        : (titles[kind.value] ?? "");
    // The title is the kind's own until the person changes it.
    let auto = title.value === "" || Object.values(titles).includes(title.value);
    if (auto && title.value === "") title.value = nameOf();
    const follow = () => {
      if (auto) title.value = nameOf();
    };
    const typed = () => {
      auto = title.value === "" || title.value === nameOf();
    };
    kind.addEventListener("change", follow);
    label?.addEventListener("input", follow);
    title.addEventListener("input", typed);
    return () => {
      kind.removeEventListener("change", follow);
      label?.removeEventListener("input", follow);
      title.removeEventListener("input", typed);
    };
  }, [titles]);
  return <span ref={marker} hidden />;
}
