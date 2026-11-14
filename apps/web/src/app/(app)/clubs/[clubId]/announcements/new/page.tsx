// SPDX-License-Identifier: AGPL-3.0-only
// Writing an announcement (P2.3): of the club, or of a group (?groupId=),
// whose audience stays within the group.
import { isUuid } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { AnnouncementComposer } from "../../../../../../components/announcements.tsx";
import { FormError } from "../../../../../../components/form-error.tsx";
import {
  getClub,
  getClubGroups,
  getClubRolesIfAllowed,
  getGroup,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("announcements.new") };
}

export default async function NewAnnouncementPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const groupId = typeof query.groupId === "string" && isUuid(query.groupId) ? query.groupId : null;
  const [t, club, roles] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getClubRolesIfAllowed(clubId),
  ]);
  const group = groupId ? await getGroup(groupId) : null;
  const groups = group
    ? [{ id: group.id, name: group.name }]
    : (await getClubGroups(club.id)).map((g) => ({ id: g.id, name: g.name }));
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <a
            href={group ? `/groups/${group.id}/announcements` : `/clubs/${club.id}/announcements`}
            className="underline"
          >
            {group ? group.name : club.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("announcements.new")}</h1>
      </div>
      <FormError code={query.error} />
      <AnnouncementComposer
        clubId={club.id}
        groupId={group?.id ?? null}
        timeZone={club.timeZone}
        existing={null}
        audience={
          group
            ? [{ kind: "group", groupId: group.id, groupName: group.name, roleIds: [] }]
            : [{ kind: "club", groupId: null, groupName: null, roleIds: [] }]
        }
        groups={groups}
        roles={roles?.items ?? null}
      />
    </div>
  );
}
