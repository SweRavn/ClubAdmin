// SPDX-License-Identifier: AGPL-3.0-only
// Club overview: name, managers, language and time zone, top-level groups.

import { enumKey } from "@clubadmin/i18n";
import { Link, Stack } from "expo-router";
import { useTranslations } from "use-intl";

import { useClub, useClubGroups } from "../../../../api/queries.ts";
import { DataAge } from "../../../../components/data-age.tsx";
import { DateTime } from "../../../../components/date-time.tsx";
import { ErrorView } from "../../../../components/error-view.tsx";
import { PersonName } from "../../../../components/person-name.tsx";
import { useIdParam } from "../../../../components/route-id.ts";
import {
  Body,
  EmptyState,
  Loading,
  Muted,
  Row,
  Screen,
  Section,
} from "../../../../components/ui.tsx";
import { useTheme } from "../../../../theme.ts";
import NotFound from "../../../+not-found.tsx";

export default function ClubOverview() {
  const clubId = useIdParam("clubId");
  if (!clubId) return <NotFound />;
  return <Club clubId={clubId} />;
}

function Club({ clubId }: { clubId: string }) {
  const t = useTranslations();
  const theme = useTheme();
  const club = useClub(clubId);
  const groups = useClubGroups(clubId);
  if (!club.data) {
    if (club.isError)
      return (
        <Screen>
          <ErrorView error={club.error} onRetry={() => void club.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const topLevel = (groups.data ?? []).filter((g) => !g.parentGroupId && !g.archived);
  return (
    <Screen
      refreshing={club.isRefetching}
      onRefresh={() => void club.refetch()}
      testID="club-screen"
    >
      <Stack.Screen options={{ title: club.data.name }} />
      <DataAge updatedAt={club.dataUpdatedAt} />
      <Section title={t("club.managers")}>
        {club.data.managers.length === 0 ? (
          <EmptyState title={t("club.noManagers")} />
        ) : (
          club.data.managers.map((person, index) => (
            <Row key={person.id} last={index === club.data.managers.length - 1}>
              <PersonName person={person} href={`/people/${person.id}?clubId=${clubId}`} />
            </Row>
          ))
        )}
      </Section>
      <Section title={t("club.details")}>
        <Row>
          <Muted>{t("club.language")}</Muted>
          <Body>{t(enumKey("locales", club.data.defaultLocale))}</Body>
        </Row>
        <Row>
          <Muted>{t("club.timeZone")}</Muted>
          <Body>{club.data.timeZone}</Body>
        </Row>
        <Row last>
          <Muted>{t("club.localTime")}</Muted>
          <DateTime value={new Date()} timeZone={club.data.timeZone} />
        </Row>
      </Section>
      <Section title={t("club.groups")}>
        {topLevel.length === 0 ? (
          <EmptyState title={t("groups.empty")} />
        ) : (
          topLevel.map((group) => (
            <Row key={group.id}>
              <Link href={`/groups/${group.id}`}>
                <Body style={{ color: theme.colors.accent, fontWeight: "600" }}>{group.name}</Body>
              </Link>
              <Muted>{t(enumKey("kinds", group.kind))}</Muted>
            </Row>
          ))
        )}
        <Row last>
          <Link href={`/clubs/${clubId}/groups`} testID="all-groups">
            <Body style={{ color: theme.colors.accent }}>{t("club.allGroups")}</Body>
          </Link>
        </Row>
      </Section>
    </Screen>
  );
}
