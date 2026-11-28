// SPDX-License-Identifier: AGPL-3.0-only
// A programme in the app (P2.9, ADR 0054 decision 12): a cup or a camp as a
// list per day, by place, each activity with its time and groups and its
// shifts (filled of needed, mine marked). What the person sees is what they
// see today (their family's groups); organisers see conflicts. Cache first:
// the programme and the activity's day are prefetched with the schedule.
// Editing and laying out stay on the web.

import { router, Stack, useLocalSearchParams } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import {
  type ProgrammeTimeline,
  useProgramme,
  useProgrammeTimeline,
} from "../../../../api/queries.ts";
import { ErrorView } from "../../../../components/error-view.tsx";
import { useIdParam } from "../../../../components/route-id.ts";
import { Body, Loading, Muted, Row, Screen, Section } from "../../../../components/ui.tsx";
import { useTheme } from "../../../../theme.ts";
import NotFound from "../../../+not-found.tsx";

export default function ProgrammeScreen() {
  const clubId = useIdParam("clubId");
  const programmeId = useIdParam("programmeId");
  const { day } = useLocalSearchParams<{ day?: string }>();
  if (!clubId || !programmeId) return <NotFound />;
  return (
    <Programme
      clubId={clubId}
      programmeId={programmeId}
      asked={typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null}
    />
  );
}

type Activity = ProgrammeTimeline["activities"][number];
type Shift = ProgrammeTimeline["shifts"][number];

function Programme({
  clubId,
  programmeId,
  asked,
}: {
  clubId: string;
  programmeId: string;
  asked: string | null;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const theme = useTheme();
  const programme = useProgramme(clubId, programmeId);
  const p = programme.data;
  const day = p ? (asked && p.days.includes(asked) ? asked : (p.days[0] ?? null)) : null;
  const timeline = useProgrammeTimeline(clubId, programmeId, day);
  if (!p) {
    if (programme.isError) {
      return (
        <Screen>
          <ErrorView error={programme.error} onRetry={() => void programme.refetch()} />
        </Screen>
      );
    }
    return <Loading label={t("common.loading")} />;
  }
  const time = (iso: string) =>
    format.dateTime(new Date(iso), { timeStyle: "short", timeZone: p.timeZone });
  const dayName = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const data = timeline.data;
  const places = data
    ? p.places.filter(
        (place) =>
          data.activities.some((a) => (a.locationId ?? null) === place.locationId) ||
          data.shifts.some((s) => !s.activityId && (s.locationId ?? null) === place.locationId),
      )
    : [];
  return (
    <Screen
      refreshing={programme.isRefetching || timeline.isRefetching}
      onRefresh={() => {
        void programme.refetch();
        void timeline.refetch();
      }}
      testID="programme-screen"
    >
      <Stack.Screen options={{ title: p.title }} />
      <View style={{ gap: 4 }}>
        <Body style={{ fontWeight: "700", fontSize: 20 }}>{p.title}</Body>
        <Muted>{p.groups.map((g) => g.name).join(", ")}</Muted>
      </View>
      {p.days.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) }}>
          {p.days.map((d) => {
            const selected = d === day;
            return (
              <Pressable
                key={d}
                onPress={() => router.setParams({ day: d })}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                testID={`programme-day-${d}`}
                style={{
                  minHeight: theme.touch,
                  paddingHorizontal: theme.space(3),
                  justifyContent: "center",
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: selected ? theme.colors.accent : theme.colors.border,
                  backgroundColor: selected ? theme.colors.accent : "transparent",
                }}
              >
                <Text
                  style={{
                    color: selected ? theme.colors.accentFg : theme.colors.fg,
                    fontWeight: "600",
                  }}
                >
                  {dayName(d)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {!data ? (
        timeline.isError ? (
          <ErrorView error={timeline.error} onRetry={() => void timeline.refetch()} />
        ) : (
          <Loading label={t("common.loading")} />
        )
      ) : places.length === 0 ? (
        <Muted>{t("programmes.nothingThisDay")}</Muted>
      ) : (
        places.map((place) => (
          <Section key={place.locationId ?? "none"} title={place.name ?? t("programmes.noPlace")}>
            {itemsAt(data, place.locationId).map((item, index, all) =>
              item.kind === "activity" ? (
                <Row
                  key={item.activity.id}
                  last={index === all.length - 1}
                  onPress={() => router.push(`/activities/${item.activity.id}`)}
                  accessibilityLabel={item.activity.title}
                  testID={`programme-activity-${item.activity.id}`}
                >
                  <Muted>
                    {time(item.activity.startsAt)}–{time(item.activity.endsAt)}
                  </Muted>
                  <Body style={{ fontWeight: "600" }}>{item.activity.title}</Body>
                  <Muted>{item.activity.groups.map((g) => g.name).join(", ")}</Muted>
                  {item.activity.conflict ? (
                    <Text style={{ color: theme.colors.danger }}>{t("programmes.conflict")}</Text>
                  ) : null}
                  {item.shifts.map((s) => (
                    <ShiftLine key={s.id} shift={s} time={time} />
                  ))}
                </Row>
              ) : (
                <Row key={item.shift.id} last={index === all.length - 1}>
                  <ShiftLine shift={item.shift} time={time} />
                </Row>
              ),
            )}
          </Section>
        ))
      )}
    </Screen>
  );
}

function ShiftLine({ shift, time }: { shift: Shift; time: (iso: string) => string }) {
  const t = useTranslations();
  return (
    <Muted testID={`programme-shift-${shift.id}`}>
      {time(shift.startsAt)}–{time(shift.endsAt)} {shift.title} ·{" "}
      {t("programmes.filled", { filled: shift.filled, needed: shift.needed })}
      {shift.mine ? ` · ${t("programmes.mine")}` : ""}
    </Muted>
  );
}

function itemsAt(
  timeline: ProgrammeTimeline,
  locationId: string | null,
): (
  | { kind: "activity"; activity: Activity; shifts: Shift[]; at: string }
  | { kind: "shift"; shift: Shift; at: string }
)[] {
  const shown = new Set(timeline.activities.map((a) => a.id));
  return [
    ...timeline.activities
      .filter((a) => (a.locationId ?? null) === locationId)
      .map((activity) => ({
        kind: "activity" as const,
        activity,
        shifts: timeline.shifts.filter((s) => s.activityId === activity.id),
        at: activity.startsAt,
      })),
    ...timeline.shifts
      .filter(
        (s) => (!s.activityId || !shown.has(s.activityId)) && (s.locationId ?? null) === locationId,
      )
      .map((shift) => ({ kind: "shift" as const, shift, at: shift.startsAt })),
  ].sort((a, b) => a.at.localeCompare(b.at));
}
