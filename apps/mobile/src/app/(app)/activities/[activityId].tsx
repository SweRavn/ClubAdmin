// SPDX-License-Identifier: AGPL-3.0-only
// An activity (P1.4): when and where (a map link opens the system's map),
// meeting time, notes and the leaders of its groups; never participants.
// Offline, before the details were ever loaded, the schedule's cached entry
// is shown. Read-only: activities are planned on the web.

import { enumKey } from "@clubadmin/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { Linking, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { type SchedulePage, useActivity } from "../../../api/queries.ts";
import { DataAge } from "../../../components/data-age.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { PersonName } from "../../../components/person-name.tsx";
import { useProtectScreen } from "../../../components/protect-screen.ts";
import { RoleBadge } from "../../../components/role-badge.tsx";
import { useIdParam } from "../../../components/route-id.ts";
import { Body, Button, Loading, Muted, Row, Screen, Section } from "../../../components/ui.tsx";
import { useSession } from "../../../state/session.tsx";
import { useTheme } from "../../../theme.ts";
import NotFound from "../../+not-found.tsx";

export default function ActivityScreen() {
  const activityId = useIdParam("activityId");
  if (!activityId) return <NotFound />;
  return <Activity activityId={activityId} />;
}

/** The schedule's cached entry for this activity, if any. */
function useCachedEntry(activityId: string) {
  const client = useQueryClient();
  const { personId, viewingAs } = useSession();
  const page = client.getQueryData<SchedulePage>(["schedule", personId, viewingAs ?? "self"]);
  return page?.items.find((i) => i.activityId === activityId) ?? null;
}

function Activity({ activityId }: { activityId: string }) {
  const t = useTranslations();
  const theme = useTheme();
  const format = useFormatter();
  const activity = useActivity(activityId);
  const cached = useCachedEntry(activityId);
  useProtectScreen(
    (activity.data?.leaders ?? []).some((p) => p.protected),
    `activity-${activityId}`,
  );

  const a = activity.data;
  if (!a && !cached) {
    if (activity.isError)
      return (
        <Screen>
          <ErrorView error={activity.error} onRetry={() => void activity.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }

  const zone = a?.timeZone ?? cached!.club.timeZone;
  const title = a?.title ?? cached!.title;
  const kind = a?.kind ?? cached!.kind;
  const status = a?.status ?? cached!.status;
  const reason = a?.cancelledReason ?? cached?.cancelledReason ?? null;
  const startsAt = new Date(a?.startsAt ?? cached!.startsAt);
  const endsAt = new Date(a?.endsAt ?? cached!.endsAt);
  const meetAt = a?.meetAt ?? cached?.meetAt ?? null;
  const place = a ? (a.location?.name ?? a.locationText) : cached!.place;
  const groups = a?.groups ?? cached!.groups;
  const cancelled = status === "cancelled";
  const when =
    (a?.allDay ?? cached?.allDay)
      ? format.dateTime(startsAt, { dateStyle: "full", timeZone: zone })
      : `${format.dateTime(startsAt, { dateStyle: "full", timeStyle: "short", timeZone: zone })}–${format.dateTime(endsAt, { timeStyle: "short", timeZone: zone })}`;
  const address = a?.location
    ? [a.location.street, [a.location.postalCode, a.location.city].filter(Boolean).join(" ")]
        .filter(Boolean)
        .join(", ")
    : null;

  return (
    <Screen
      refreshing={activity.isRefetching}
      onRefresh={() => void activity.refetch()}
      testID="activity-screen"
    >
      <Stack.Screen options={{ title }} />
      {a ? <DataAge updatedAt={activity.dataUpdatedAt} /> : null}
      <Body
        style={{
          fontSize: 20,
          fontWeight: "700",
          textDecorationLine: cancelled ? "line-through" : "none",
        }}
      >
        {title}
      </Body>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(1) }}>
        <RoleBadge label={t(enumKey("activityKinds", kind))} />
        {cancelled ? <RoleBadge tone="accent" label={t("activities.cancelled")} /> : null}
      </View>
      {cancelled ? (
        <Body>
          {reason
            ? t("activities.cancelledBecause", { reason })
            : t("activities.cancelledNoReason")}
        </Body>
      ) : null}

      <Section title={t("activities.when")}>
        <Row last>
          <Body>{when}</Body>
          {meetAt || a?.meetPlace ? (
            <Muted>
              {`${t("activities.meet")}: ${[
                meetAt
                  ? format.dateTime(new Date(meetAt), { timeStyle: "short", timeZone: zone })
                  : null,
                a?.meetPlace,
              ]
                .filter(Boolean)
                .join(", ")}`}
            </Muted>
          ) : null}
        </Row>
      </Section>

      {place ? (
        <Section title={t("activities.where")}>
          <Row last testID="activity-place">
            <Body>{place}</Body>
            {address ? <Muted>{address}</Muted> : null}
            {a?.location?.directions ? <Body>{a.location.directions}</Body> : null}
            {a?.location?.mapUrl ? (
              <Button
                kind="secondary"
                label={t("activities.map")}
                onPress={() => void Linking.openURL(a.location!.mapUrl!)}
                testID="activity-map"
              />
            ) : null}
          </Row>
        </Section>
      ) : null}

      {a?.opponent || a?.competition ? (
        <Section title={t("activities.opponent")}>
          <Row last>
            {a.opponent ? (
              <Body>
                {a.opponent}
                {a.homeAway ? ` (${t(enumKey("homeAway", a.homeAway))})` : ""}
              </Body>
            ) : null}
            {a.competition ? <Muted>{a.competition}</Muted> : null}
          </Row>
        </Section>
      ) : null}

      {a?.notes || a?.leaderNotes ? (
        <Section title={t("activities.notes")}>
          {a.notes ? (
            <Row last={!a.leaderNotes}>
              <Body>{a.notes}</Body>
            </Row>
          ) : null}
          {a.leaderNotes ? (
            <Row last>
              <Muted>{t("activities.leaderNotes")}</Muted>
              <Body>{a.leaderNotes}</Body>
            </Row>
          ) : null}
        </Section>
      ) : null}

      <Section title={t("activities.leaders")}>
        {a ? (
          a.leaders.length === 0 ? (
            <Row last>
              <Muted>{t("activities.noLeaders")}</Muted>
            </Row>
          ) : (
            a.leaders.map((person, index) => (
              <Row key={person.id} last={index === a.leaders.length - 1}>
                <PersonName person={person} href={`/people/${person.id}?clubId=${a.clubId}`} />
              </Row>
            ))
          )
        ) : (
          <Row last>
            <Muted>{t("mobile.offline")}</Muted>
          </Row>
        )}
      </Section>
      <Muted>{groups.map((g) => g.name).join(", ")}</Muted>
    </Screen>
  );
}
