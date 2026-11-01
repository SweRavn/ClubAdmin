// SPDX-License-Identifier: AGPL-3.0-only
// What stands in the way of deleting an account or erasing a child (P1.8b):
// per club, the assignments to step down from (with a link to that club's
// leave page, where each is ended), the last-manager handover, and invoices
// to settle with the club.

import { enumKey } from "@clubadmin/i18n";
import type { ErasureBlocker } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

const BLOCKERS = {
  roles_must_be_removed: "privacy.deletion.blocker.roles_must_be_removed",
  last_club_manager: "privacy.deletion.blocker.last_club_manager",
} as const;

export async function ErasureBlockers({ blockers }: { blockers: readonly ErasureBlocker[] }) {
  const t = await getTranslations();
  if (blockers.length === 0) return null;
  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-protected-soft p-4"
      data-testid="erasure-blockers"
    >
      <h2 className="font-semibold">{t("privacy.deletion.blockersTitle")}</h2>
      <ul className="space-y-2 text-sm">
        {blockers.map((b) => (
          <li key={`${b.personId}-${b.clubId}-${b.code}`} data-testid={`blocker-${b.code}`}>
            {b.code === "outstanding_invoices"
              ? t("privacy.deletion.blocker.outstanding_invoices", {
                  club: b.clubName,
                  count: b.count ?? 1,
                  role: t(enumKey("roles", b.contactRole ?? "treasurer")),
                })
              : t(BLOCKERS[b.code], { club: b.clubName })}
            {b.code === "roles_must_be_removed" ? (
              <>
                {" "}
                <a
                  href={`/me/privacy/leave?clubId=${b.clubId}&personId=${b.personId}`}
                  className="text-accent underline"
                >
                  {t("privacy.deletion.manageAssignments", { club: b.clubName })}
                </a>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
