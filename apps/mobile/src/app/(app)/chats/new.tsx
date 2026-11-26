// SPDX-License-Identifier: AGPL-3.0-only
// "Ny kanal" in a group (P2.7g), for those who may create its channels: a
// name, open or closed, and who is in it: the whole group or its leaders
// (as the web; the child-safety rules add the children's guardians where a
// leader is with them). Members, archiving and safeguarding stay on the web.

import { isUuid } from "@clubadmin/shared";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslations } from "use-intl";

import { useCreateGroupChannel, useGroupMembers, useMe } from "../../../api/queries.ts";
import { isLeaderFunction } from "../../../components/attendance-logic.ts";
import {
  Choice,
  FormError,
  formErrorsOf,
  TextField,
  useOnline,
} from "../../../components/form.tsx";
import { Button, Muted, Screen } from "../../../components/ui.tsx";
import NotFound from "../../+not-found.tsx";

export default function NewChannelScreen() {
  const params = useLocalSearchParams<{ clubId?: string; groupId?: string }>();
  const clubId = params.clubId && isUuid(params.clubId) ? params.clubId : null;
  const groupId = params.groupId && isUuid(params.groupId) ? params.groupId : null;
  if (!clubId || !groupId) return <NotFound />;
  return <NewChannel clubId={clubId} groupId={groupId} />;
}

function NewChannel({ clubId, groupId }: { clubId: string; groupId: string }) {
  const t = useTranslations();
  const online = useOnline();
  const me = useMe();
  const members = useGroupMembers(groupId);
  const create = useCreateGroupChannel(clubId, groupId);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"closed" | "open">("closed");
  const [who, setWho] = useState<"group" | "leaders">("group");
  const [local, setLocal] = useState<Record<string, string>>({});
  const remote = formErrorsOf(create.error);
  const errors = { form: remote.form, fields: { ...remote.fields, ...local } };
  const leaders = (members.data ?? [])
    .filter((m) => m.functions.some(isLeaderFunction) && m.person.id !== me.data?.personId)
    .map((m) => m.person.id);
  const submit = () => {
    if (!name.trim()) {
      setLocal({ name: "required" });
      return;
    }
    setLocal({});
    create.mutate(
      {
        name: name.trim(),
        visibility,
        everyone: who === "group",
        memberIds: who === "group" ? [] : leaders,
      },
      { onSuccess: (chat) => router.replace(`/chats/${clubId}/${chat.id}`) },
    );
  };
  return (
    <Screen testID="new-channel-screen">
      <Stack.Screen options={{ title: t("chat.newChannel") }} />
      <Muted>{t("chat.groupChannelsHint")}</Muted>
      <TextField
        label={t("chat.name")}
        name="channel-name"
        value={name}
        onChange={setName}
        maxLength={80}
        error={errors.fields.name}
      />
      <Choice
        label={t("mobile.channelWho")}
        name="channel-who"
        value={who}
        onChange={setWho}
        options={[
          { value: "group", label: t("mobile.channelGroup") },
          { value: "leaders", label: t("mobile.channelLeaders") },
        ]}
        error={errors.fields.memberIds ?? errors.fields.everyone}
      />
      <Choice
        label={t("chat.visibility")}
        name="channel-visibility"
        value={visibility}
        onChange={setVisibility}
        options={[
          { value: "closed", label: t("chat.visibilities.closed") },
          { value: "open", label: t("chat.visibilities.open") },
        ]}
        error={errors.fields.visibility}
      />
      <Muted>{t("chat.leaderRule")}</Muted>
      <FormError errors={errors} />
      {online ? null : <Muted>{t("mobile.needsConnection")}</Muted>}
      <Button
        label={t("chat.create")}
        disabled={!online || (who === "leaders" && members.isPending)}
        busy={create.isPending}
        onPress={submit}
        testID="channel-create"
      />
    </Screen>
  );
}
