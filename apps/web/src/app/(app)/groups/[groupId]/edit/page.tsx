// SPDX-License-Identifier: AGPL-3.0-only
// Change a group (P1.6b): all its fields; archive or restore it; delete it
// while it was never used (the confirmation names the group).
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError } from "../../../../../components/form-error.tsx";
import { GroupFields } from "../../../../../components/group-fields.tsx";
import { formDraft, getClubGroups, getGroup, getMyClubs } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("groupForm.editTitle") };
}

export default async function EditGroupPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const [t, group, draft] = await Promise.all([
    getTranslations(),
    getGroup(groupId),
    formDraft("update-group", query),
  ]);
  if (!group.canManage) forbidden();
  const [groups, mine] = await Promise.all([getClubGroups(group.clubId), getMyClubs()]);
  const isManager =
    mine.clubs
      .find((c) => c.club.id === group.clubId)
      ?.permissions.includes("club.settings.update") ?? false;

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <p className="text-sm text-muted">
          <a href={`/groups/${group.id}`} className="underline">
            {group.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("groupForm.editTitle")}</h1>
        <FormError code={query.error} />
      </div>
      {group.archived ? (
        <p className="rounded-md bg-notice px-3 py-2 text-notice-fg">
          {t("groupForm.archivedHint")}
        </p>
      ) : (
        <ActionForm action="update-group" className="space-y-4" testId="edit-group-form">
          <input type="hidden" name="groupId" value={group.id} />
          <GroupFields
            parents={groups.filter((g) => g.id !== group.id)}
            values={group}
            draft={draft}
          />
          <button type="submit" className={buttonClass} data-testid="group-save">
            {t("groupForm.save")}
          </button>
        </ActionForm>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          {group.archived ? t("groupForm.restoreTitle") : t("groupForm.archiveTitle")}
        </h2>
        <p className="text-sm text-muted">
          {group.archived ? t("groupForm.restoreHint") : t("groupForm.archiveHint")}
        </p>
        {!group.archived || isManager ? (
          <ActionForm action="archive-group">
            <input type="hidden" name="groupId" value={group.id} />
            <input type="hidden" name="what" value={group.archived ? "restore" : "archive"} />
            <button type="submit" className={secondaryButtonClass} data-testid="group-archive">
              {group.archived ? t("groupForm.restore") : t("groupForm.archive")}
            </button>
          </ActionForm>
        ) : null}
      </section>

      {group.deletable ? (
        <section className="space-y-3" data-testid="group-delete-section">
          <h2 className="text-lg font-semibold">{t("groupForm.deleteTitle")}</h2>
          <p className="text-sm text-muted">{t("groupForm.deleteHint")}</p>
          <ActionForm action="delete-group" className="space-y-2">
            <input type="hidden" name="groupId" value={group.id} />
            <input type="hidden" name="clubId" value={group.clubId} />
            <label className="flex items-center gap-2">
              <input type="checkbox" name="confirm" required data-testid="group-delete-confirm" />
              {t("groupForm.deleteConfirm", { group: group.name })}
            </label>
            <button type="submit" className={secondaryButtonClass} data-testid="group-delete">
              {t("groupForm.delete")}
            </button>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
