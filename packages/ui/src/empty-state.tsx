// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  children?: ReactNode;
  /** Buttons or links below the text. */
  actions?: ReactNode;
  headingLevel?: 2 | 3;
}

export function EmptyState({ title, children, actions, headingLevel = 2 }: EmptyStateProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface p-6 text-center">
      <Heading className="text-lg font-semibold">{title}</Heading>
      {children ? <div className="mt-2 text-muted">{children}</div> : null}
      {actions ? <div className="mt-4 flex flex-wrap justify-center gap-3">{actions}</div> : null}
    </div>
  );
}

/** Placeholder lines while a section loads. */
export function Skeleton({ lines = 3, label }: { lines?: number; label: string }) {
  return (
    <div role="status" aria-live="polite" className="animate-pulse space-y-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={`h-4 rounded-sm bg-surface ${i % 2 ? "w-2/3" : "w-full"}`} />
      ))}
    </div>
  );
}
