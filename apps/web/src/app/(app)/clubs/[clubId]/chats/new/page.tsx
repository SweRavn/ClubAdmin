// SPDX-License-Identifier: AGPL-3.0-only
// A new channel (P2.1): in a group (?groupId=, its people to choose from) or
// for the club. Open or closed; the child-safety rules apply whoever is
// chosen (the API adds the children's guardians where a leader is with them).
import { personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../../../components/action-form.tsx";
import { FormError } from "../../../../../../components/form-error.tsx";
import { getGroup, getGroupMembers, getMe, requireId } from "../../../../../../server/data.ts";

type Params = {
  params: Promise<{ clubId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("chat.newChannel") };
}

export default async function NewChannelPage({ params, searchParams }: Params) {
  const clubId = requireId((await params).clubId);
  const query = (await searchParams) ?? {};
  const groupId = typeof query.groupId === "string" ? requireId(query.groupId) : null;
  const [t, me, group, roster] = await Promise.all([
    getTranslations(),
    getMe(),
    groupId ? getGroup(groupId) : null,
    groupId ? getGroupMembers(groupId, 200) : null,
  ]);
  const people = (roster?.items ?? []).filter((r) => r.person.id !== me.personId);
  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">{t("chat.newChannel")}</h1>
      <p className="text-sm text-muted">{t("chat.groupChannelsHint")}</p>
      {group ? <p className="text-muted">{group.name}</p> : null}
      <FormError code={query.error} />
      <ActionForm action="create-channel" className="space-y-4" testId="new-channel-form">
        <input type="hidden" name="clubId" value={clubId} />
        {groupId ? <input type="hidden" name="groupId" value={groupId} /> : null}
        <label className="block">
          <span className="block text-sm font-medium">{t("chat.name")}</span>
          <input name="name" required maxLength={80} className={inputClass} />
        </label>
        <label className="block">
          <span className="block text-sm font-medium">{t("chat.description")}</span>
          <input name="description" maxLength={500} className={inputClass} />
        </label>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("chat.visibility")}</legend>
          {(["closed", "open"] as const).map((v) => (
            <label key={v} className="flex items-center gap-2">
              <input type="radio" name="visibility" value={v} defaultChecked={v === "closed"} />
              {t(`chat.visibilities.${v}`)}
            </label>
          ))}
        </fieldset>
        {groupId ? (
          <label className="flex items-center gap-2">
            <input type="checkbox" name="everyone" />
            {t("chat.everyone")}
          </label>
        ) : null}
        {people.length > 0 ? (
          <fieldset className="max-h-80 space-y-1 overflow-y-auto">
            <legend className="text-sm font-medium">{t("chat.chooseMembers")}</legend>
            {people.map((r) => (
              <label key={r.person.id} className="flex items-center gap-2">
                <input type="checkbox" name="memberId" value={r.person.id} />
                {personLabel(r.person)}
              </label>
            ))}
          </fieldset>
        ) : null}
        <p className="text-sm text-muted">{t("chat.leaderRule")}</p>
        <button type="submit" className={buttonClass}>
          {t("chat.create")}
        </button>
      </ActionForm>
    </div>
  );
}
