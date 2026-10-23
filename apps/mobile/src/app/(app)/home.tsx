// SPDX-License-Identifier: AGPL-3.0-only
// Clubs and groups (from My schedule, the start screen, P1.4): my clubs
// (with the club switcher), my groups, my children's groups,
// and the "viewing as" switcher for guardians. People without a club see the
// onboarding placeholder. Requests run in parallel; cached data shows first.

import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/shared";
import { Link, router, Stack } from "expo-router";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { useMe, useMyClubs, useMyGroups, useMyWards } from "../../api/queries.ts";
import { DataAge } from "../../components/data-age.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { RoleBadge } from "../../components/role-badge.tsx";
import {
  Body,
  EmptyState,
  LinkButton,
  Loading,
  Muted,
  Row,
  Screen,
  Section,
} from "../../components/ui.tsx";
import { useCurrentClub } from "../../state/club.tsx";
import { useSession } from "../../state/session.tsx";
import { useTheme } from "../../theme.ts";

export default function Home() {
  const t = useTranslations();
  const theme = useTheme();
  const { viewingAs, setViewingAs } = useSession();
  // All four in parallel (no waterfall).
  const me = useMe();
  const clubs = useMyClubs();
  const groups = useMyGroups();
  const wards = useMyWards();
  const { club: current, setClub } = useCurrentClub();

  const refreshing = me.isRefetching || clubs.isRefetching || groups.isRefetching;
  const refresh = () => {
    void me.refetch();
    void clubs.refetch();
    void groups.refetch();
    void wards.refetch();
  };

  const settingsLink = (
    <LinkButton
      label={t("mobile.settings")}
      onPress={() => router.push("/settings")}
      testID="open-settings"
    />
  );

  if (!clubs.data && !groups.data) {
    if (clubs.isError)
      return (
        <Screen>
          <ErrorView error={clubs.error} onRetry={refresh} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }

  const myClubs = clubs.data?.clubs ?? [];
  const actingWards = (wards.data?.wards ?? []).filter((w) => w.rights.includes("act_on_behalf"));

  return (
    <Screen refreshing={refreshing} onRefresh={refresh} testID="home-screen">
      <Stack.Screen options={{ headerRight: () => settingsLink }} />
      {me.data ? (
        <Body style={{ fontSize: 20, fontWeight: "700" }}>
          {t("home.greeting", { name: personLabel(me.data.person) })}
        </Body>
      ) : null}
      <DataAge updatedAt={clubs.dataUpdatedAt} />

      {actingWards.length > 0 ? (
        <Section title={t("viewingAs.label")}>
          {[null, ...actingWards].map((ward, index) => {
            const id = ward?.person.id ?? null;
            const selected = viewingAs === id;
            return (
              <Row
                key={id ?? "self"}
                onPress={() => setViewingAs(id)}
                accessibilityLabel={ward ? personLabel(ward.person) : t("viewingAs.self")}
                last={index === actingWards.length}
                testID={`viewing-as-${id ?? "self"}`}
              >
                <Body style={{ fontWeight: selected ? "700" : "400" }}>
                  {ward ? personLabel(ward.person) : t("viewingAs.self")}
                  {selected ? ` · ${t("mobile.selected")}` : ""}
                </Body>
              </Row>
            );
          })}
        </Section>
      ) : null}

      {myClubs.length === 0 ? (
        <Section title={t("onboarding.title")}>
          <EmptyState title={t("onboarding.text")} body={t("onboarding.comingSoon")} />
        </Section>
      ) : (
        <Section title={t("home.myClubs")}>
          {myClubs.map((entry, index) => {
            const selected = current?.club.id === entry.club.id;
            return (
              <Row
                key={entry.club.id}
                onPress={() => {
                  setClub(entry.club.id);
                  router.push(`/clubs/${entry.club.id}`);
                }}
                accessibilityLabel={entry.club.name}
                last={index === myClubs.length - 1}
                testID={`club-${entry.club.id}`}
              >
                <Body style={{ fontWeight: "600" }}>
                  {entry.club.name}
                  {selected && myClubs.length > 1 ? ` · ${t("mobile.currentClub")}` : ""}
                </Body>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(1) }}>
                  {entry.membership ? (
                    <RoleBadge label={t(enumKey("membershipStatus", entry.membership.status))} />
                  ) : null}
                  {entry.roles.map((role) => (
                    <RoleBadge key={role} tone="accent" label={t(enumKey("roles", role))} />
                  ))}
                </View>
              </Row>
            );
          })}
        </Section>
      )}

      <Section title={t("home.myGroups")}>
        {(groups.data?.groups ?? []).length === 0 ? (
          <EmptyState title={t("home.noGroups")} />
        ) : (
          (groups.data?.groups ?? []).map((entry, index, all) => (
            <Row key={entry.group.id} last={index === all.length - 1}>
              <Link href={`/groups/${entry.group.id}`} testID={`group-${entry.group.id}`}>
                <Body style={{ color: theme.colors.accent, fontWeight: "600" }}>
                  {entry.group.name}
                </Body>
              </Link>
              <Muted>{`${t(enumKey("kinds", entry.group.kind))} · ${entry.club.name}`}</Muted>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(1) }}>
                {entry.functions.map((fn) => (
                  <RoleBadge
                    key={fn}
                    tone={fn === "member" ? "neutral" : "accent"}
                    label={t(enumKey("functions", fn))}
                  />
                ))}
              </View>
            </Row>
          ))
        )}
      </Section>

      {(groups.data?.wards ?? []).map((ward) => {
        const person = wards.data?.wards.find((w) => w.person.id === ward.personId)?.person;
        if (!person) return null;
        return (
          <Section key={ward.personId} title={t("home.wardGroups", { name: personLabel(person) })}>
            {ward.groups.length === 0 ? (
              <EmptyState title={t("home.noWardGroups")} />
            ) : (
              ward.groups.map((entry, index) => (
                <Row key={entry.group.id} last={index === ward.groups.length - 1}>
                  <Link href={`/groups/${entry.group.id}`}>
                    <Body style={{ color: theme.colors.accent, fontWeight: "600" }}>
                      {entry.group.name}
                    </Body>
                  </Link>
                  <Muted>{entry.club.name}</Muted>
                </Row>
              ))
            )}
          </Section>
        );
      })}
    </Screen>
  );
}
