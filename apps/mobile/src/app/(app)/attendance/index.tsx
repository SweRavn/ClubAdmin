// SPDX-License-Identifier: AGPL-3.0-only
// "Närvaro" (P2.7g): the sessions of the groups I lead (or one group, from
// its page) from the last days that have started and have no marks yet,
// newest first; a tap opens the attendance screen. Cached for the hall:
// the list shows offline what was last fetched.

import { router, Stack, useLocalSearchParams } from "expo-router";
import { useFormatter, useTranslations } from "use-intl";

import { useMyGroups, useSessionsWaitingForAttendance } from "../../../api/queries.ts";
import { isLeaderFunction, waitingSessions } from "../../../components/attendance-logic.ts";
import { DataAge } from "../../../components/data-age.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { Body, EmptyState, Loading, Muted, Row, Screen, Section } from "../../../components/ui.tsx";

export default function AttendanceListScreen() {
  const t = useTranslations();
  const format = useFormatter();
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const myGroups = useMyGroups();
  const led = (myGroups.data?.groups ?? []).filter(
    (g) => g.functions.some(isLeaderFunction) && (!groupId || g.group.id === groupId),
  );
  const names = new Map(led.map((g) => [g.group.id, g.group.name]));
  const { results, sessions } = useSessionsWaitingForAttendance(led.map((g) => g.group.id));
  const waiting = waitingSessions(sessions, Date.now());
  const loading = myGroups.isPending || results.some((r) => r.isPending && !r.data);
  const failed = results.find((r) => r.isError && !r.data);
  const refresh = () => {
    void myGroups.refetch();
    for (const r of results) void r.refetch();
  };
  const updatedAt = Math.min(...results.map((r) => r.dataUpdatedAt || Infinity));

  return (
    <Screen
      refreshing={results.some((r) => r.isRefetching)}
      onRefresh={refresh}
      testID="attendance-list-screen"
    >
      <Stack.Screen options={{ title: t("attendance.title") }} />
      {Number.isFinite(updatedAt) ? <DataAge updatedAt={updatedAt} /> : null}
      <Muted>{t("mobile.attendanceWaitingIntro")}</Muted>
      {loading ? (
        <Loading label={t("common.loading")} />
      ) : failed ? (
        <ErrorView error={failed.error} onRetry={refresh} />
      ) : waiting.length === 0 ? (
        <EmptyState title={t("mobile.attendanceNoneWaiting")} />
      ) : (
        <Section title={t("mobile.attendanceWaiting")}>
          {waiting.map((s, index) => (
            <Row
              key={s.activityId}
              onPress={() => router.push(`/attendance/${s.activityId}`)}
              last={index === waiting.length - 1}
              testID={`waiting-${s.activityId}`}
            >
              <Body style={{ fontWeight: "600" }}>{s.title}</Body>
              <Muted>
                {`${format.dateTime(new Date(s.startsAt), {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: s.timeZone,
                })} · ${names.get(s.groupId) ?? ""}`}
              </Muted>
            </Row>
          ))}
        </Section>
      )}
    </Screen>
  );
}
