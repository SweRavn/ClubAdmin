// SPDX-License-Identifier: AGPL-3.0-only
// Events (P1.6), from "My schedule": events open for my family and our
// registrations, across clubs, with the status per person. Organiser tools
// stay on the web.

import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/shared";
import { router } from "expo-router";
import { useFormatter, useTranslations } from "use-intl";

import { useMyEvents } from "../../../api/queries.ts";
import { DataAge } from "../../../components/data-age.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { Body, EmptyState, Loading, Muted, Row, Screen, Section } from "../../../components/ui.tsx";

export default function EventsScreen() {
  const t = useTranslations();
  const format = useFormatter();
  const events = useMyEvents();
  if (!events.data) {
    if (events.isError) {
      return (
        <Screen>
          <ErrorView error={events.error} onRetry={() => void events.refetch()} />
        </Screen>
      );
    }
    return <Loading label={t("common.loading")} />;
  }
  const items = events.data.items;
  return (
    <Screen
      refreshing={events.isRefetching}
      onRefresh={() => void events.refetch()}
      testID="events-screen"
    >
      <DataAge updatedAt={events.dataUpdatedAt} />
      {items.length === 0 ? (
        <EmptyState title={t("events.empty")} />
      ) : (
        <Section title={t("events.title")}>
          {items.map(({ event, people }, i) => (
            <Row
              key={event.id}
              last={i === items.length - 1}
              onPress={() => router.push(`/events/${event.id}`)}
              accessibilityLabel={event.title}
              testID="event-row"
            >
              <Body style={{ fontWeight: "600" }}>{event.title}</Body>
              <Muted>
                {format.dateTime(new Date(event.startsAt), {
                  dateStyle: "medium",
                  timeZone: event.timeZone,
                })}
                {event.open
                  ? ` · ${t("events.signUpBy")} ${format.dateTime(
                      new Date(event.registrationClosesAt),
                      {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: event.timeZone,
                      },
                    )}`
                  : ""}
              </Muted>
              {people.map((p) => (
                <Muted key={p.person.id}>
                  {people.length > 1 ? `${personLabel(p.person)}: ` : ""}
                  {p.status === "waitlisted" && p.position !== null
                    ? t("events.position", { position: p.position })
                    : p.status
                      ? t(enumKey("events.registrationStatus", p.status))
                      : p.canRegister
                        ? t("events.openForSignUp")
                        : t("events.notOpen")}
                </Muted>
              ))}
            </Row>
          ))}
        </Section>
      )}
    </Screen>
  );
}
