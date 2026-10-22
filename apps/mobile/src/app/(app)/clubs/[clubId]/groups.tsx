// SPDX-License-Identifier: AGPL-3.0-only
// The club's groups as a tree (sections, teams, training groups), with kind labels.

import { enumKey } from "@clubadmin/i18n";
import { Link } from "expo-router";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { useClubGroups } from "../../../../api/queries.ts";
import { ErrorView } from "../../../../components/error-view.tsx";
import { groupTree } from "../../../../components/group-tree.ts";
import { RoleBadge } from "../../../../components/role-badge.tsx";
import { useIdParam } from "../../../../components/route-id.ts";
import { Body, EmptyState, Loading, Row, Screen, Section } from "../../../../components/ui.tsx";
import { useTheme } from "../../../../theme.ts";
import NotFound from "../../../+not-found.tsx";

export default function ClubGroups() {
  const clubId = useIdParam("clubId");
  if (!clubId) return <NotFound />;
  return <Groups clubId={clubId} />;
}

function Groups({ clubId }: { clubId: string }) {
  const t = useTranslations();
  const theme = useTheme();
  const groups = useClubGroups(clubId);
  if (!groups.data) {
    if (groups.isError)
      return (
        <Screen>
          <ErrorView error={groups.error} onRetry={() => void groups.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const tree = groupTree(groups.data.filter((g) => !g.archived));
  return (
    <Screen refreshing={groups.isRefetching} onRefresh={() => void groups.refetch()}>
      <Section title={t("club.groups")}>
        {tree.length === 0 ? (
          <EmptyState title={t("groups.empty")} />
        ) : (
          tree.map(({ group, depth }, index) => (
            <Row key={group.id} last={index === tree.length - 1}>
              <View
                style={{
                  paddingLeft: depth * theme.space(4),
                  flexDirection: "row",
                  alignItems: "center",
                  gap: theme.space(2),
                  flexWrap: "wrap",
                }}
              >
                <Link href={`/groups/${group.id}`}>
                  <Body
                    style={{ color: theme.colors.accent, fontWeight: depth === 0 ? "700" : "500" }}
                  >
                    {group.name}
                  </Body>
                </Link>
                <RoleBadge label={t(enumKey("kinds", group.kind))} />
              </View>
            </Row>
          ))
        )}
      </Section>
    </Screen>
  );
}
