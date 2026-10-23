// SPDX-License-Identifier: AGPL-3.0-only
// My schedule (P1.4), the app's start screen: the coming four weeks of my
// groups' and my wards' activities, across clubs, by day. Chips narrow it to
// one person. Pull to refresh; offline it shows the persisted cache (with
// its age) and leaves out what has already ended. Cancelled activities stay,
// marked, with the reason. Answers per person go through the offline outbox
// (P1.5). Planning is on the web.

import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/shared";
import { router, Stack } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { type ScheduleEntry, useSchedule } from "../../api/queries.ts";
import { DataAge } from "../../components/data-age.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { OutboxBanner } from "../../components/outbox-banner.tsx";
import { ResponseButtons } from "../../components/response-buttons.tsx";
import { RoleBadge } from "../../components/role-badge.tsx";
import { scheduleDays } from "../../components/schedule-days.ts";
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
import { BUILD_VARIANT } from "../../config.ts";
import { useTheme } from "../../theme.ts";

/**
 * Logs when the start screen first shows data, and whether it came from the
 * persisted cache, for the cold-start measurement (scripts/measure-cold-start.sh
 * reads "home ready" from logcat). Not in production builds; no personal data.
 */
function useColdStartMarker(dataUpdatedAt: number | undefined) {
  const logged = useRef(false);
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    if (dataUpdatedAt === undefined || logged.current) return;
    if (BUILD_VARIANT !== "development" && BUILD_VARIANT !== "preview") return;
    logged.current = true;
    const source = dataUpdatedAt < mountedAt.current ? "cache" : "network";
    console.info(`ClubAdmin: home ready (${source})`);
  }, [dataUpdatedAt]);
}

export default function ScheduleScreen() {
  const t = useTranslations();
  const theme = useTheme();
  const format = useFormatter();
  const schedule = useSchedule();
  const [person, setPerson] = useState<string | null>(null);
  useColdStartMarker(schedule.data === undefined ? undefined : schedule.dataUpdatedAt);
  const people = schedule.data?.people ?? [];
  const days = useMemo(
    () => scheduleDays(schedule.data?.items ?? [], person, Date.now()),
    [schedule.data, person],
  );

  const header = (
    <View style={{ flexDirection: "row", gap: theme.space(2) }}>
      <LinkButton
        label={t("mobile.clubs")}
        onPress={() => router.push("/home")}
        testID="open-home"
      />
      <LinkButton
        label={t("mobile.settings")}
        onPress={() => router.push("/settings")}
        testID="open-settings"
      />
    </View>
  );

  if (!schedule.data) {
    if (schedule.isError)
      return (
        <Screen testID="schedule-screen">
          <Stack.Screen options={{ headerRight: () => header }} />
          <ErrorView error={schedule.error} onRetry={() => void schedule.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }

  const time = (entry: ScheduleEntry, value: string) =>
    format.dateTime(new Date(value), { timeStyle: "short", timeZone: entry.club.timeZone });
  const several = people.length > 1;

  return (
    <Screen
      refreshing={schedule.isRefetching}
      onRefresh={() => void schedule.refetch()}
      testID="schedule-screen"
    >
      <Stack.Screen options={{ headerRight: () => header }} />
      <DataAge updatedAt={schedule.dataUpdatedAt} />
      <OutboxBanner />
      {several ? (
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) }}
          accessibilityRole="tablist"
        >
          {[null, ...people].map((p) => {
            const id = p?.id ?? null;
            const selected = person === id;
            return (
              <Pressable
                key={id ?? "everyone"}
                onPress={() => setPerson(id)}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                testID={`schedule-person-${id ?? "everyone"}`}
                style={{
                  borderWidth: 1,
                  borderColor: selected ? theme.colors.accent : theme.colors.border,
                  backgroundColor: selected ? theme.colors.accentSoft : "transparent",
                  borderRadius: 999,
                  paddingHorizontal: theme.space(3),
                  paddingVertical: theme.space(1),
                }}
              >
                <Text style={{ color: theme.colors.fg }}>
                  {p ? personLabel(p) : t("schedule.everyone")}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {days.length === 0 ? (
        <EmptyState title={t("schedule.empty")} />
      ) : (
        days.map((day) => (
          <Section
            key={day.date}
            title={format.dateTime(new Date(`${day.date}T12:00:00Z`), {
              dateStyle: "full",
              timeZone: "UTC",
            })}
          >
            {day.items.map((entry, index) => {
              const cancelled = entry.status === "cancelled";
              return (
                <Row
                  key={entry.activityId}
                  onPress={() => router.push(`/activities/${entry.activityId}`)}
                  accessibilityLabel={entry.title}
                  last={index === day.items.length - 1}
                  testID={`schedule-item-${entry.activityId}`}
                >
                  <Body
                    style={{
                      fontWeight: "600",
                      textDecorationLine: cancelled ? "line-through" : "none",
                    }}
                  >
                    {entry.allDay
                      ? `${t("activities.allDay")} · ${entry.title}`
                      : `${time(entry, entry.startsAt)}–${time(entry, entry.endsAt)} · ${entry.title}`}
                  </Body>
                  <Muted>
                    {[entry.place, entry.groups.map((g) => g.name).join(", "), entry.club.name]
                      .filter(Boolean)
                      .join(" · ")}
                  </Muted>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(1) }}>
                    <RoleBadge label={t(enumKey("activityKinds", entry.kind))} />
                    {cancelled ? (
                      <RoleBadge tone="accent" label={t("activities.cancelled")} />
                    ) : null}
                    {several && person === null
                      ? entry.people.map((p) => <RoleBadge key={p.id} label={personLabel(p)} />)
                      : null}
                  </View>
                  {cancelled && entry.cancelledReason ? <Body>{entry.cancelledReason}</Body> : null}
                  {!cancelled
                    ? (entry.responses ?? [])
                        .filter((r) => r.canRespond && (person === null || r.personId === person))
                        .map((r) => {
                          const who = entry.people.find((p) => p.id === r.personId);
                          return (
                            <ResponseButtons
                              key={r.personId}
                              activityId={entry.activityId}
                              personId={r.personId}
                              status={r.status}
                              deadlinePassed={
                                entry.respondBy ? Date.parse(entry.respondBy) < Date.now() : false
                              }
                              {...(several && who ? { label: personLabel(who) } : {})}
                            />
                          );
                        })
                    : null}
                  {!cancelled &&
                  entry.responseMode === "requested" &&
                  (entry.responses ?? []).some((r) => r.canRespond && r.status === null) ? (
                    <RoleBadge tone="accent" label={t("responses.answerNeeded")} />
                  ) : null}
                </Row>
              );
            })}
          </Section>
        ))
      )}
    </Screen>
  );
}
