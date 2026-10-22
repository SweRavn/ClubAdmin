// SPDX-License-Identifier: AGPL-3.0-only
// A person's profile with exactly the fields the API returns for this
// viewer (ADR 0022): nothing is filtered or hidden in the app itself.

import { enumKey } from "@clubadmin/i18n";
import { isUuid } from "@clubadmin/shared";
import { Link, Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { useClubGroups, usePerson } from "../../../api/queries.ts";
import { DataAge } from "../../../components/data-age.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { PersonName } from "../../../components/person-name.tsx";
import { useProtectScreen } from "../../../components/protect-screen.ts";
import { RoleBadge } from "../../../components/role-badge.tsx";
import { useIdParam } from "../../../components/route-id.ts";
import { Body, Loading, Muted, Row, Screen, Section } from "../../../components/ui.tsx";
import { useTheme } from "../../../theme.ts";
import NotFound from "../../+not-found.tsx";

export default function PersonScreen() {
  const personId = useIdParam("personId");
  const { clubId } = useLocalSearchParams<{ clubId?: string }>();
  if (!personId) return <NotFound />;
  return <Person personId={personId} clubId={clubId && isUuid(clubId) ? clubId : null} />;
}

function Person({ personId, clubId }: { personId: string; clubId: string | null }) {
  const t = useTranslations();
  const format = useFormatter();
  const theme = useTheme();
  const profile = usePerson(personId, clubId);
  const groups = useClubGroups(profile.data?.club?.clubId ?? clubId);
  useProtectScreen(profile.data?.person.protected === true, `person-${personId}`);

  if (!profile.data) {
    if (profile.isError)
      return (
        <Screen>
          <ErrorView error={profile.error} onRetry={() => void profile.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const p = profile.data;
  const groupName = new Map((groups.data ?? []).map((g) => [g.id, g.name]));
  const rows: { key: string; label: string; value: string }[] = [];
  if (p.birthDate) {
    rows.push({
      key: "birthDate",
      label: t("person.birthDate"),
      // A calendar date: no time zone shift.
      value: format.dateTime(new Date(`${p.birthDate}T00:00:00Z`), {
        dateStyle: "long",
        timeZone: "UTC",
      }),
    });
  }
  if (p.gender)
    rows.push({ key: "gender", label: t("person.gender"), value: t(enumKey("genders", p.gender)) });
  if (p.phone) rows.push({ key: "phone", label: t("person.phone"), value: p.phone });
  if (p.address) {
    rows.push({
      key: "address",
      label: t("person.address"),
      value: [
        p.address.street,
        `${p.address.postalCode} ${p.address.city}`,
        p.address.country,
      ].join(", "),
    });
  }
  if (p.club?.memberNumber !== undefined) {
    rows.push({
      key: "memberNumber",
      label: t("person.memberNumber"),
      value: String(p.club.memberNumber),
    });
  }
  if (p.club?.membership) {
    rows.push({
      key: "membership",
      label: t("person.membership"),
      value: t(enumKey("membershipStatus", p.club.membership.status)),
    });
  }

  return (
    <Screen
      refreshing={profile.isRefetching}
      onRefresh={() => void profile.refetch()}
      testID="person-screen"
    >
      <Stack.Screen options={{ title: t("person.title") }} />
      <PersonName person={p.person} />
      <DataAge updatedAt={profile.dataUpdatedAt} />
      {rows.length > 0 ? (
        <Section title={t("person.title")}>
          {rows.map((row, index) => (
            <Row key={row.key} last={index === rows.length - 1} testID={`field-${row.key}`}>
              <Muted>{row.label}</Muted>
              <Body>{row.value}</Body>
            </Row>
          ))}
        </Section>
      ) : (
        <Muted>{t("person.limited")}</Muted>
      )}
      {p.club?.groups?.length ? (
        <Section title={t("person.groups")}>
          {p.club.groups.map((g, index, all) => (
            <Row key={g.groupId} last={index === all.length - 1}>
              <Link href={`/groups/${g.groupId}`}>
                <Body style={{ color: theme.colors.accent }}>
                  {groupName.get(g.groupId) ?? t("nav.groups")}
                </Body>
              </Link>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(1) }}>
                {g.functions.map((fn) => (
                  <RoleBadge key={fn} label={t(enumKey("functions", fn))} />
                ))}
              </View>
            </Row>
          ))}
        </Section>
      ) : null}
      {p.guardians?.length ? (
        <Section title={t("person.guardians")}>
          {p.guardians.map((g, index, all) => (
            <Row key={g.person.id} last={index === all.length - 1}>
              <PersonName person={g.person}>
                <RoleBadge label={t(enumKey("guardianKinds", g.kind))} />
              </PersonName>
              {g.phone ? <Muted>{g.phone}</Muted> : null}
            </Row>
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}
