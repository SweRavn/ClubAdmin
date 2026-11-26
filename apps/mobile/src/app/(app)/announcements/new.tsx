// SPDX-License-Identifier: AGPL-3.0-only
// "Nytt anslag" (P2.7g): an announcement to one of my groups or (with the
// club's permission) the whole club: title, text in the web's Markdown
// subset with a preview, "important"; how many it reaches before sending.
// With `announcementId`, changing one's own (as on the web). Needs a
// connection; the announcement opens when it is sent.

import { isUuid } from "@clubadmin/shared";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import {
  useAnnouncement,
  useAnnouncementPreview,
  useClubGroups,
  useCreateAnnouncement,
  useMyPermissions,
  useUpdateAnnouncement,
} from "../../../api/queries.ts";
import { announceGroups, mayAnnounceToClub } from "../../../components/announcement-logic.ts";
import { ErrorView } from "../../../components/error-view.tsx";
import {
  Choice,
  FormError,
  formErrorsOf,
  SwitchField,
  TextField,
  useOnline,
} from "../../../components/form.tsx";
import { Markdown } from "../../../components/markdown.tsx";
import { Body, Button, EmptyState, Loading, Muted, Screen } from "../../../components/ui.tsx";
import { useTheme } from "../../../theme.ts";
import NotFound from "../../+not-found.tsx";

const CLUB = "club";

/** What the composer changes of an existing announcement. */
interface Existing {
  id: string;
  title: string;
  body: string;
  important: boolean;
  status: string;
}

export default function NewAnnouncementScreen() {
  const params = useLocalSearchParams<{
    clubId?: string;
    groupId?: string;
    announcementId?: string;
  }>();
  const clubId = params.clubId && isUuid(params.clubId) ? params.clubId : null;
  const groupId = params.groupId && isUuid(params.groupId) ? params.groupId : null;
  const announcementId =
    params.announcementId && isUuid(params.announcementId) ? params.announcementId : null;
  if (!clubId) return <NotFound />;
  return announcementId ? (
    <EditAnnouncement clubId={clubId} announcementId={announcementId} />
  ) : (
    <Composer clubId={clubId} groupId={groupId} existing={null} />
  );
}

function EditAnnouncement({ clubId, announcementId }: { clubId: string; announcementId: string }) {
  const t = useTranslations();
  const detail = useAnnouncement(clubId, announcementId);
  if (!detail.data) {
    if (detail.isError)
      return (
        <Screen>
          <ErrorView error={detail.error} onRetry={() => void detail.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  return (
    <Composer
      clubId={clubId}
      groupId={detail.data.announcement.groupId}
      existing={detail.data.announcement}
    />
  );
}

function Composer({
  clubId,
  groupId,
  existing,
}: {
  clubId: string;
  groupId: string | null;
  existing: Existing | null;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const online = useOnline();
  const permissions = useMyPermissions(clubId);
  const groups = useClubGroups(clubId);
  const create = useCreateAnnouncement();
  const update = useUpdateAnnouncement(clubId, existing?.id ?? "");
  const [target, setTarget] = useState<string>(groupId ?? (existing ? CLUB : ""));
  const [title, setTitle] = useState(existing?.title ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [important, setImportant] = useState(existing?.important ?? false);
  const [preview, setPreview] = useState(false);
  const [local, setLocal] = useState<Record<string, string>>({});
  const sent = existing?.status === "sent";
  const reach = useAnnouncementPreview(
    clubId,
    target === CLUB ? null : target,
    target !== "" && !sent && online,
  );

  if (!permissions.data || !groups.data) {
    if (permissions.isError)
      return (
        <Screen>
          <ErrorView error={permissions.error} onRetry={() => void permissions.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const club = mayAnnounceToClub(permissions.data);
  const targets = [
    ...announceGroups(
      permissions.data,
      groups.data.filter((g) => !g.archived).map((g) => ({ id: g.id, name: g.name })),
    ).map((g) => ({ value: g.id, label: g.name })),
    ...(club ? [{ value: CLUB, label: t("mobile.wholeClub") }] : []),
  ];
  if (targets.length === 0 && !existing) {
    return (
      <Screen>
        <EmptyState title={t("errors.forbidden.title")} body={t("errors.forbidden.text")} />
      </Screen>
    );
  }
  const mutation = existing ? update : create;
  const remote = formErrorsOf(mutation.error);
  const errors = { form: remote.form, fields: { ...remote.fields, ...local } };
  const submit = () => {
    const wrong: Record<string, string> = {};
    if (!title.trim()) wrong.title = "required";
    if (!body.trim()) wrong.body = "required";
    if (!existing && !target) wrong.audience = "required";
    setLocal(wrong);
    if (Object.keys(wrong).length > 0) return;
    if (existing) {
      update.mutate(
        { title: title.trim(), body, ...(sent ? {} : { important }) },
        { onSuccess: () => router.back() },
      );
      return;
    }
    const toGroup = target === CLUB ? null : target;
    create.mutate(
      {
        clubId,
        groupId: toGroup,
        body: {
          title: title.trim(),
          body,
          channels: ["board", "push"],
          important,
          audience: toGroup ? [{ kind: "group", groupId: toGroup }] : [{ kind: "club" }],
          send: true,
        },
      },
      { onSuccess: (created) => router.replace(`/announcements/${clubId}/${created.id}`) },
    );
  };
  return (
    <Screen testID="announcement-composer">
      <Stack.Screen
        options={{ title: existing ? t("announcements.edit") : t("mobile.newAnnouncement") }}
      />
      {existing ? null : (
        <Choice
          label={t("mobile.announcementTo")}
          name="announcement-to"
          value={target}
          onChange={setTarget}
          options={targets}
          error={errors.fields.audience}
        />
      )}
      <TextField
        label={t("announcements.form.title")}
        name="announcement-title"
        value={title}
        onChange={setTitle}
        maxLength={150}
        error={errors.fields.title}
      />
      <View style={{ flexDirection: "row", gap: theme.space(2) }}>
        <Button
          kind={preview ? "secondary" : "primary"}
          label={t("mobile.write")}
          onPress={() => setPreview(false)}
          testID="announcement-write"
        />
        <Button
          kind={preview ? "primary" : "secondary"}
          label={t("mobile.preview")}
          onPress={() => setPreview(true)}
          testID="announcement-preview"
        />
      </View>
      {preview ? (
        <Markdown source={body} testID="announcement-preview-body" />
      ) : (
        <TextField
          label={t("announcements.form.body")}
          name="announcement-body"
          multiline
          value={body}
          onChange={setBody}
          maxLength={10_000}
          hint={t("announcements.form.bodyHelp")}
          error={errors.fields.body}
        />
      )}
      {sent ? null : (
        <>
          <SwitchField
            label={t("announcements.form.important")}
            name="announcement-important"
            value={important}
            onChange={setImportant}
          />
          <Muted>{t("announcements.form.importantHelp")}</Muted>
        </>
      )}
      {reach.data ? (
        <Body testID="announcement-reach">
          {t("announcements.reach", {
            recipients: reach.data.recipients,
            email: reach.data.withEmail,
            app: reach.data.withApp,
          })}
        </Body>
      ) : null}
      <FormError errors={errors} />
      {online ? null : <Muted>{t("mobile.needsConnection")}</Muted>}
      <Button
        label={existing ? t("announcements.form.saveSent") : t("announcements.form.sendNow")}
        disabled={!online}
        busy={mutation.isPending}
        onPress={submit}
        testID="announcement-send"
      />
    </Screen>
  );
}
