// SPDX-License-Identifier: AGPL-3.0-only
// "Ny aktivitet" (P2.7g): a new activity of a group, for those who manage
// its activities, with the call-up list of its players. Needs a connection;
// opens the new activity when it is created.

import { router, Stack } from "expo-router";
import { useMemo } from "react";
import { useTranslations } from "use-intl";

import {
  useClub,
  useCreateActivity,
  useGroup,
  useGroupCalendar,
  useGroupMembers,
  useLocations,
} from "../../../../api/queries.ts";
import { ActivityForm, useKindTitles } from "../../../../components/activity-form.tsx";
import { newActivityValues } from "../../../../components/activity-logic.ts";
import { ErrorView } from "../../../../components/error-view.tsx";
import { useProtectScreen } from "../../../../components/protect-screen.ts";
import { useIdParam } from "../../../../components/route-id.ts";
import { EmptyState, Loading, Muted, Screen } from "../../../../components/ui.tsx";
import NotFound from "../../../+not-found.tsx";

export default function NewActivityScreen() {
  const groupId = useIdParam("groupId");
  if (!groupId) return <NotFound />;
  return <NewActivity groupId={groupId} />;
}

function NewActivity({ groupId }: { groupId: string }) {
  const t = useTranslations();
  const titles = useKindTitles();
  const group = useGroup(groupId);
  const calendar = useGroupCalendar(groupId);
  const club = useClub(group.data?.clubId ?? "");
  const locations = useLocations(group.data?.clubId);
  const members = useGroupMembers(groupId);
  const create = useCreateActivity(groupId);
  // The players to call up; leaders take part anyway (as the web, P2.7e).
  const players = useMemo(
    () => (members.data ?? []).filter((m) => m.functions.includes("member")).map((m) => m.person),
    [members.data],
  );
  useProtectScreen(
    players.some((p) => p.protected),
    `new-activity-${groupId}`,
  );
  const zone = club.data?.timeZone;
  // The form keeps its first values (ActivityForm's state); later renders keep what was typed.
  const initial = zone ? newActivityValues(new Date(), zone, titles) : null;

  if (group.isError) {
    return (
      <Screen>
        <ErrorView error={group.error} onRetry={() => void group.refetch()} />
      </Screen>
    );
  }
  if (!group.data || !calendar.data || !initial || !zone || members.isPending) {
    return <Loading label={t("common.loading")} />;
  }
  if (!calendar.data.canManage) {
    return (
      <Screen>
        <EmptyState title={t("errors.forbidden.title")} body={t("errors.forbidden.text")} />
      </Screen>
    );
  }
  return (
    <Screen testID="new-activity-screen">
      <Stack.Screen options={{ title: t("activities.newTitle") }} />
      <Muted>{group.data.name}</Muted>
      <ActivityForm
        initial={initial}
        timeZone={zone}
        locations={locations.data ?? []}
        players={players}
        submitLabel={t("activities.create")}
        busy={create.isPending}
        error={create.error}
        onSubmit={(body, notCalledUp) =>
          create.mutate(
            {
              ...(body as Parameters<typeof create.mutate>[0]),
              ...(notCalledUp.length > 0 ? { notCalledUp } : {}),
            },
            { onSuccess: (created) => router.replace(`/activities/${created.id}`) },
          )
        }
      />
    </Screen>
  );
}
