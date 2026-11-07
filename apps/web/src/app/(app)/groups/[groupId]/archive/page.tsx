// SPDX-License-Identifier: AGPL-3.0-only
// Archiving a group (P1.10a): what it ends and closes, then the confirmation.
// Its players and leaders leave it (they stay club members), its waiting
// list closes and the applicants are told; restoring brings back only the
// group. Refused while it has subgroups that are not archived.
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../../components/action-form.tsx";
import { FormError } from "../../../../../components/form-error.tsx";
import { getGroup, getGroupArchivePreview } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("groupForm.archiveTitle") };
}

export default async function ArchiveGroupPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const [t, group] = await Promise.all([getTranslations(), getGroup(groupId)]);
  if (!group.canManage || group.archived) forbidden();
  const preview = await getGroupArchivePreview(group.id);
  return (
    <div className="space-y-6" data-testid="group-archive-page">
      <div className="space-y-2">
        <p className="text-sm text-muted">
          <a href={`/groups/${group.id}`} className="underline">
            {group.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">
          {t("groupAdmin.archiveTitle", { group: group.name })}
        </h1>
        <FormError code={query.error} />
      </div>
      {preview.activeChildren > 0 ? (
        <p className="rounded-md bg-notice px-3 py-2 text-notice-fg" data-testid="archive-children">
          {t("groupAdmin.archiveChildren", { count: preview.activeChildren })}
        </p>
      ) : (
        <>
          <div className="space-y-2" data-testid="archive-preview">
            <p>{t("groupAdmin.archiveIntro")}</p>
            <ul className="ml-5 list-disc">
              <li>{t("groupAdmin.archiveMembers", { count: preview.members })}</li>
              <li>{t("groupAdmin.archiveLeaders", { count: preview.leaders })}</li>
              <li>{t("groupAdmin.archiveWaitlist", { count: preview.waitlist })}</li>
            </ul>
            <p className="text-sm text-muted">{t("groupAdmin.archiveStay")}</p>
            <p className="text-sm text-muted">{t("groupAdmin.archiveRestoreNote")}</p>
          </div>
          <ActionForm action="archive-group">
            <input type="hidden" name="groupId" value={group.id} />
            <input type="hidden" name="what" value="archive" />
            <button type="submit" className={buttonClass} data-testid="group-archive-confirm">
              {t("groupAdmin.archiveConfirm")}
            </button>
          </ActionForm>
        </>
      )}
    </div>
  );
}
