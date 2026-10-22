// SPDX-License-Identifier: AGPL-3.0-only
// A group: owners, leaders and members, as the API returns them (people the
// viewer may not see are left out by the API; protected people carry the
// crossed-camera icon). The roster is keyset-paginated. With protected
// people on screen, screenshots are blocked (Android) and the app switcher
// snapshot is blurred (iOS).

import { enumKey } from "@clubadmin/i18n";
import { Stack } from "expo-router";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { type RosterEntry, useGroup, useRoster } from "../../../api/queries.ts";
import { DataAge } from "../../../components/data-age.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { PersonName } from "../../../components/person-name.tsx";
import { useProtectScreen } from "../../../components/protect-screen.ts";
import { RoleBadge } from "../../../components/role-badge.tsx";
import { useIdParam } from "../../../components/route-id.ts";
import {
  Button,
  EmptyState,
  Loading,
  Muted,
  Row,
  Screen,
  Section,
} from "../../../components/ui.tsx";
import { useTheme } from "../../../theme.ts";
import NotFound from "../../+not-found.tsx";

export default function GroupScreen() {
  const groupId = useIdParam("groupId");
  if (!groupId) return <NotFound />;
  return <Group groupId={groupId} />;
}

function Group({ groupId }: { groupId: string }) {
  const t = useTranslations();
  const theme = useTheme();
  const group = useGroup(groupId);
  const roster = useRoster(groupId);
  const entries: RosterEntry[] = roster.data?.pages.flatMap((page) => page.items) ?? [];
  const showsProtected =
    entries.some((e) => e.person.protected) || (group.data?.owners ?? []).some((p) => p.protected);
  useProtectScreen(showsProtected, `group-${groupId}`);

  if (!group.data) {
    if (group.isError)
      return (
        <Screen>
          <ErrorView error={group.error} onRetry={() => void group.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const clubId = group.data.clubId;
  const leaders = entries.filter((e) => e.functions.some((fn) => fn !== "member"));
  const total = roster.data?.pages[0]?.totalCount ?? entries.length;
  const refresh = () => {
    void group.refetch();
    void roster.refetch();
  };
  const renderEntry = (
    entry: RosterEntry,
    index: number,
    list: RosterEntry[],
    onlyLeaders: boolean,
  ) => (
    <Row key={entry.person.id} last={index === list.length - 1}>
      <PersonName person={entry.person} href={`/people/${entry.person.id}?clubId=${clubId}`}>
        {entry.functions
          .filter((fn) => !onlyLeaders || fn !== "member")
          .map((fn) => (
            <RoleBadge
              key={fn}
              tone={fn === "member" ? "neutral" : "accent"}
              label={t(enumKey("functions", fn))}
            />
          ))}
      </PersonName>
    </Row>
  );

  return (
    <Screen
      refreshing={group.isRefetching || roster.isRefetching}
      onRefresh={refresh}
      testID="group-screen"
    >
      <Stack.Screen options={{ title: group.data.name }} />
      <View style={{ flexDirection: "row", gap: theme.space(2), flexWrap: "wrap" }}>
        <RoleBadge label={t(enumKey("kinds", group.data.kind))} />
        {group.data.sport ? <RoleBadge label={group.data.sport} /> : null}
      </View>
      <DataAge updatedAt={roster.dataUpdatedAt || group.dataUpdatedAt} />
      <Section title={t("group.owners")}>
        {group.data.owners.length === 0 ? (
          <EmptyState title={t("group.noOwners")} />
        ) : (
          group.data.owners.map((person, index) => (
            <Row key={person.id} last={index === group.data.owners.length - 1}>
              <PersonName person={person} href={`/people/${person.id}?clubId=${clubId}`} />
            </Row>
          ))
        )}
      </Section>
      {roster.isError ? (
        <Section title={t("group.members")}>
          <ErrorView error={roster.error} onRetry={() => void roster.refetch()} />
        </Section>
      ) : (
        <>
          <Section title={t("group.leaders")}>
            {leaders.length === 0 ? (
              <EmptyState title={t("group.noLeaders")} />
            ) : (
              leaders.map((entry, index, list) => renderEntry(entry, index, list, true))
            )}
          </Section>
          <Section title={t("group.members")}>
            <Muted style={{ paddingTop: theme.space(2) }}>
              {t("group.memberCount", { count: total })}
            </Muted>
            {entries.length === 0 && !roster.isPending ? (
              <EmptyState title={t("group.noMembers")} />
            ) : (
              entries.map((entry, index, list) => renderEntry(entry, index, list, false))
            )}
          </Section>
          {roster.hasNextPage ? (
            <Button
              label={t("common.loadMore")}
              kind="secondary"
              busy={roster.isFetchingNextPage}
              onPress={() => void roster.fetchNextPage()}
              testID="roster-more"
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}
