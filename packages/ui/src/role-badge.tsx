// SPDX-License-Identifier: AGPL-3.0-only
// A small label for a club role or group function ("Head coach", "Registrar").

export interface RoleBadgeProps {
  label: string;
  tone?: "neutral" | "accent";
}

export function RoleBadge({ label, tone = "neutral" }: RoleBadgeProps) {
  return (
    <span
      className={`inline-block rounded-sm px-1.5 py-0.5 text-xs font-medium ${
        tone === "accent" ? "bg-accent-soft text-fg" : "border border-border text-muted"
      }`}
    >
      {label}
    </span>
  );
}
