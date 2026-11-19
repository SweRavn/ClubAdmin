// SPDX-License-Identifier: AGPL-3.0-only
// The club's administration in one place (P2.7c): members, roles and
// permissions (the role matrix, giving a role), the club's settings, and
// privacy and logs. Each link only for those who hold its permission; the
// pages themselves check again.
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ADMINISTRATION_PERMISSIONS } from "../../../../../components/administration.ts";
import { getEntitlements, getMyClubs } from "../../../../../server/data.ts";

type Props = { params: Promise<{ clubId: string }> };

export async function generateMetadata() {
  return { title: (await getTranslations())("administration.title") };
}

export default async function AdministrationPage({ params }: Props) {
  const { clubId } = await params;
  const [t, mine, entitlements] = await Promise.all([
    getTranslations(),
    getMyClubs(),
    getEntitlements(clubId),
  ]);
  const club = mine.clubs.find((c) => c.club.id === clubId);
  const permissions: readonly string[] = club?.permissions ?? [];
  if (!club || !permissions.some((p) => ADMINISTRATION_PERMISSIONS.has(p))) notFound();
  const has = (...any: string[]) => any.some((p) => permissions.includes(p));
  const base = `/clubs/${clubId}`;
  /** "manage": a page where something is changed; "view": an overview that is only read (P2.7c). */
  type Link = { key: string; kind: "manage" | "view"; href: string; label: string; show: boolean };
  const sections: { key: string; title: string; links: Link[] }[] = [
    {
      key: "members",
      title: t("administration.members"),
      links: [
        {
          key: "register",
          kind: "manage",
          href: `${base}/members`,
          label: t("administration.register"),
          show: has("club.members.read"),
        },
        {
          key: "join-requests",
          kind: "manage",
          href: `${base}/join-requests`,
          label: t("administration.joinRequests"),
          show: has("club.join_requests.manage"),
        },
        {
          key: "invitations",
          kind: "manage",
          href: `${base}/invitations`,
          label: t("administration.invitations"),
          show: has("club.invitations.manage"),
        },
        {
          key: "waitlists",
          kind: "manage",
          href: `${base}/waitlists`,
          label: t("administration.waitlists"),
          show: has("club.waitlists.read"),
        },
        {
          key: "duplicates",
          kind: "manage",
          href: `${base}/duplicates`,
          label: t("administration.duplicates"),
          show: has("club.guardians.manage"),
        },
        {
          key: "import",
          kind: "manage",
          href: `${base}/members/import`,
          label: t("administration.import"),
          show: has("club.members.import"),
        },
      ],
    },
    {
      key: "roles",
      title: t("administration.roles"),
      links: [
        {
          key: "matrix",
          kind: "manage",
          href: `${base}/roles/matrix`,
          label: t("administration.matrix"),
          show: has("club.roles.read"),
        },
        {
          key: "roles",
          kind: "manage",
          href: `${base}/roles`,
          label: t("administration.roleList"),
          show: has("club.roles.read"),
        },
        {
          key: "who-can",
          kind: "view",
          href: `${base}/roles#who-can`,
          label: t("administration.whoCan"),
          show: has("club.roles.read"),
        },
        {
          key: "administrators",
          kind: "view",
          href: `${base}/administrators`,
          label: t("administration.administrators"),
          show: has("club.roles.read"),
        },
      ],
    },
    {
      key: "club",
      title: t("administration.club"),
      links: [
        {
          key: "settings",
          kind: "manage",
          href: `${base}/settings`,
          label: t("administration.settings"),
          show: has("club.settings.update"),
        },
        {
          key: "locations",
          kind: "manage",
          href: `${base}/locations`,
          label: t("administration.locations"),
          show: has("club.locations.manage", "club.locations.create"),
        },
        {
          key: "duties",
          kind: "manage",
          href: `${base}/duties`,
          label: t("administration.duties"),
          show: has("club.duties.read", "club.duty_types.manage"),
        },
        {
          key: "plugins",
          kind: "manage",
          href: `${base}/plugins`,
          label: t("administration.plugins"),
          show: has("club.plugins.manage"),
        },
        {
          key: "grants",
          kind: "manage",
          href: `${base}/grants`,
          label: t("administration.grants"),
          show: has("club.grants.read"),
        },
        {
          key: "billing",
          kind: "manage",
          href: `${base}/billing`,
          label: t("administration.billing"),
          show: entitlements?.billingEnabled === true && has("billing.subscription.read"),
        },
        {
          key: "storage",
          kind: "manage",
          href: `${base}/storage`,
          label: t("administration.storage"),
          show: has("club.documents.manage"),
        },
      ],
    },
    {
      key: "privacy",
      title: t("administration.privacy"),
      links: [
        {
          key: "privacy",
          kind: "view",
          href: `${base}/privacy`,
          label: t("administration.privacyPage"),
          show: true,
        },
        {
          key: "audit",
          kind: "view",
          href: `${base}/audit`,
          label: t("administration.audit"),
          show: has("club.audit.read"),
        },
        {
          key: "history",
          kind: "view",
          href: `${base}/history?scope=club`,
          label: t("administration.history"),
          show: has("club.history.read"),
        },
        {
          key: "protected",
          kind: "view",
          href: `${base}/protected`,
          label: t("administration.protected"),
          show: has("club.profile_views.read"),
        },
        {
          key: "profile-views",
          kind: "view",
          href: `${base}/profile-views`,
          label: t("administration.profileViews"),
          show: has("club.profile_views.read"),
        },
        {
          key: "safeguarding",
          kind: "manage",
          href: `${base}/safeguarding`,
          label: t("administration.safeguarding"),
          show: has("club.safeguarding.handle"),
        },
      ],
    },
  ];

  return (
    <div className="space-y-6" data-testid="administration">
      <h1 className="text-2xl font-semibold">{t("administration.title")}</h1>
      <p className="text-muted">{t("administration.intro")}</p>
      <p className="flex flex-wrap gap-3 text-sm" data-testid="administration-legend">
        <KindBadge kind="manage" label={t("administration.kindManage")} />
        <span className="text-muted">{t("administration.kindManageHint")}</span>
        <KindBadge kind="view" label={t("administration.kindView")} />
        <span className="text-muted">{t("administration.kindViewHint")}</span>
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((section) => {
          const links = section.links.filter((l) => l.show);
          if (links.length === 0) return null;
          return (
            <section
              key={section.key}
              aria-labelledby={`admin-${section.key}`}
              className="rounded-lg border border-border bg-raised p-4"
              data-testid={`administration-${section.key}`}
            >
              <h2 id={`admin-${section.key}`} className="mb-2 font-semibold">
                {section.title}
              </h2>
              <ul className="space-y-1">
                {links.map((l) => (
                  <li key={l.key} className="flex items-center gap-2" data-kind={l.kind}>
                    <KindBadge
                      kind={l.kind}
                      label={
                        l.kind === "manage"
                          ? t("administration.kindManage")
                          : t("administration.kindView")
                      }
                    />
                    <a
                      href={l.href}
                      className="text-accent underline"
                      data-testid={`administration-link-${l.key}`}
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Pages that change something and overviews that are only read look apart (P2.7c). */
function KindBadge({ kind, label }: { kind: "manage" | "view"; label: string }) {
  return (
    <span
      className={`inline-flex w-24 shrink-0 justify-center rounded px-1.5 py-0.5 text-xs ${
        kind === "manage" ? "bg-accent-soft text-fg" : "border border-border text-muted"
      }`}
      data-testid={`kind-${kind}`}
    >
      {kind === "manage" ? "⚙ " : "👁 "}
      {label}
    </span>
  );
}
