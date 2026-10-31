// SPDX-License-Identifier: AGPL-3.0-only
// A new group (P1.6b): club managers anywhere, owners under the groups they
// own (?parentGroupId preselects the parent; the API checks).
import { isUuid } from "@clubadmin/shared";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../../../components/action-form.tsx";
import { FormError } from "../../../../../../components/form-error.tsx";
import { GroupFields } from "../../../../../../components/group-fields.tsx";
import { formDraft, getClub, getClubGroups, getMyClubs } from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("groupForm.newTitle") };
}

export default async function NewGroupPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, groups, mine, draft] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getClubGroups(clubId),
    getMyClubs(),
    formDraft("create-group", query),
  ]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.groups.create")) forbidden();
  const parent =
    typeof query.parentGroupId === "string" && isUuid(query.parentGroupId)
      ? query.parentGroupId
      : null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        <a href={`/clubs/${club.id}/groups`} className="underline">
          {t("groups.title", { club: club.name })}
        </a>
      </p>
      <h1 className="text-2xl font-semibold">{t("groupForm.newTitle")}</h1>
      <FormError code={query.error} />
      <ActionForm action="create-group" className="space-y-4" testId="new-group-form">
        <input type="hidden" name="clubId" value={club.id} />
        <GroupFields
          parents={groups}
          values={{
            kind: "team",
            parentGroupId: parent,
            admissionMode: "direct",
            offerReplyDays: 7,
          }}
          draft={draft}
        />
        <button type="submit" className={buttonClass} data-testid="group-create">
          {t("groupForm.create")}
        </button>
      </ActionForm>
    </div>
  );
}
