// SPDX-License-Identifier: AGPL-3.0-only
// An event (P1.6): when and where, places left, and my family with the
// status per person; sign up with the form (every question type, large
// touch targets), change answers, cancel, accept or decline an offer.
// Registrations need a connection (the server decides places): offline the
// buttons are disabled with "Needs a connection". Participants are not
// listed in the app.

import { ApiError } from "@clubadmin/api-client";
import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/shared";
import { Stack } from "expo-router";
import { useState } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { type EventQuestion, useEvent, useRegistration } from "../../../api/queries.ts";
import { useOnline } from "../../../components/banners.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { PersonName } from "../../../components/person-name.tsx";
import { useIdParam } from "../../../components/route-id.ts";
import { Body, Button, Loading, Muted, Row, Screen, Section } from "../../../components/ui.tsx";
import { useTheme } from "../../../theme.ts";
import NotFound from "../../+not-found.tsx";

type Answer = string | number | boolean | string[];
type EventDetail = NonNullable<ReturnType<typeof useEvent>["data"]>;
type Mine = EventDetail["mine"][number];
const OPEN = ["confirmed", "waitlisted", "offered"];

export default function EventScreen() {
  const eventId = useIdParam("eventId");
  if (!eventId) return <NotFound />;
  return <Event eventId={eventId} />;
}

function Event({ eventId }: { eventId: string }) {
  const t = useTranslations();
  const format = useFormatter();
  const event = useEvent(eventId);
  const e = event.data;
  if (!e) {
    if (event.isError) {
      return (
        <Screen>
          <ErrorView error={event.error} onRetry={() => void event.refetch()} />
        </Screen>
      );
    }
    return <Loading label={t("common.loading")} />;
  }
  const at = (value: string) =>
    format.dateTime(new Date(value), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: e.timeZone,
    });
  const counts =
    e.counts.placesLeft === null
      ? t("events.countsUnlimited", { confirmed: e.counts.confirmed })
      : t("events.counts", {
          confirmed: e.counts.confirmed,
          left: e.counts.placesLeft,
          waiting: e.counts.waiting,
        });
  return (
    <Screen
      refreshing={event.isRefetching}
      onRefresh={() => void event.refetch()}
      testID="event-screen"
    >
      <Stack.Screen options={{ title: e.title }} />
      <View style={{ gap: 4 }}>
        <Body style={{ fontWeight: "700", fontSize: 20 }}>{e.title}</Body>
        <Muted>
          {at(e.startsAt)} – {at(e.endsAt)}
        </Muted>
        {e.location || e.locationText ? <Muted>{e.location?.name ?? e.locationText}</Muted> : null}
        {e.status === "cancelled" ? (
          <Body style={{ fontWeight: "600" }}>
            {t("events.cancelledHint")}
            {e.cancelledReason ? `: ${e.cancelledReason}` : ""}
          </Body>
        ) : null}
        {e.description ? <Body>{e.description}</Body> : null}
        {e.priceText ? <Muted>{`${t("events.priceText")}: ${e.priceText}`}</Muted> : null}
        <Muted testID="event-counts">{counts}</Muted>
        <Muted>{`${t("events.closesField")}: ${at(e.registrationClosesAt)}`}</Muted>
      </View>
      {e.mine.map((m) => (
        <Person key={m.person.id} event={e} mine={m} at={at} />
      ))}
    </Screen>
  );
}

function Person({
  event,
  mine,
  at,
}: {
  event: EventDetail;
  mine: Mine;
  at: (value: string) => string;
}) {
  const t = useTranslations();
  const online = useOnline();
  const change = useRegistration(event.id);
  const reg = mine.registration;
  const open = reg !== null && OPEN.includes(reg.status);
  const [editing, setEditing] = useState(false);
  const status = reg
    ? reg.status === "waitlisted" && reg.position !== null
      ? t("events.position", { position: reg.position })
      : t(enumKey("events.registrationStatus", reg.status))
    : null;
  const error =
    change.error instanceof ApiError && typeof change.error.problem?.detail === "string"
      ? (() => {
          const key = enumKey("joinErrors", change.error.problem.detail);
          return key === "common.other" ? t("joinErrors.failed") : t(key);
        })()
      : change.error
        ? t("joinErrors.failed")
        : null;
  const disabled = !online || change.isPending;
  const showForm = mine.canRegister && (!reg || (open && editing));

  return (
    <Section title={personLabel(mine.person)}>
      <Row last>
        <PersonName person={mine.person} />
        {status ? <Muted testID="registration-status">{status}</Muted> : null}
        {!online ? <Muted>{t("events.needsConnection")}</Muted> : null}
        {error ? <Muted testID="registration-error">{error}</Muted> : null}
        {reg?.status === "offered" && reg.offerExpiresAt ? (
          <View style={{ gap: 8 }}>
            <Body>{`${t("events.offerUntil")} ${at(reg.offerExpiresAt)}`}</Body>
            <Button
              label={t("events.accept")}
              disabled={disabled}
              onPress={() => change.mutate({ action: "accept", personId: mine.person.id })}
              testID="offer-accept"
            />
            <Button
              label={t("events.decline")}
              kind="secondary"
              disabled={disabled}
              onPress={() => change.mutate({ action: "decline", personId: mine.person.id })}
              testID="offer-decline"
            />
          </View>
        ) : null}
        {showForm ? (
          <SignUpForm
            questions={event.questions}
            initial={{ ...(reg?.answers ?? {}), ...(reg?.sensitiveAnswers ?? {}) }}
            submitLabel={reg ? t("events.saveAnswers") : t("events.register")}
            disabled={disabled}
            busy={change.isPending}
            onSubmit={(answers) =>
              change.mutate(
                { action: "register", personId: mine.person.id, answers },
                { onSuccess: () => setEditing(false) },
              )
            }
          />
        ) : null}
        {open && mine.canRegister && !editing ? (
          <Button
            label={t("events.changeAnswers")}
            kind="secondary"
            disabled={disabled}
            onPress={() => setEditing(true)}
          />
        ) : null}
        {open ? (
          <Button
            label={t("events.cancelRegistration")}
            kind="danger"
            disabled={disabled}
            onPress={() => change.mutate({ action: "cancel", personId: mine.person.id })}
            testID="registration-cancel"
          />
        ) : null}
        {!reg && !mine.canRegister ? (
          <Muted>{event.open ? t("events.cannotRegister") : t("events.notOpen")}</Muted>
        ) : null}
      </Row>
    </Section>
  );
}

function SignUpForm({
  questions,
  initial,
  submitLabel,
  disabled,
  busy,
  onSubmit,
}: {
  questions: readonly EventQuestion[];
  initial: Record<string, Answer>;
  submitLabel: string;
  disabled: boolean;
  busy: boolean;
  onSubmit: (answers: Record<string, unknown>) => void;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const [answers, setAnswers] = useState<Record<string, Answer>>(initial);
  const set = (id: string, value: Answer) => setAnswers((a) => ({ ...a, [id]: value }));
  const choice = (selected: boolean, label: string, onPress: () => void) => (
    <Pressable
      key={label}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={{
        minHeight: theme.touch,
        justifyContent: "center",
        paddingHorizontal: theme.space(3),
        borderRadius: 8,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accentSoft : "transparent",
      }}
    >
      <Text style={{ color: theme.colors.fg, fontSize: 16 }}>{label}</Text>
    </Pressable>
  );
  const input = {
    color: theme.colors.fg,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 6,
    minHeight: theme.touch,
    paddingHorizontal: theme.space(2),
    fontSize: 16,
  };
  return (
    <View style={{ gap: theme.space(3) }} testID="sign-up-form">
      {questions.map((q) => {
        const value = answers[q.id];
        const label = (
          <View>
            <Body>{`${q.label}${q.required ? " *" : ""}`}</Body>
            {q.sensitive ? <Muted>{t("events.sensitiveHint")}</Muted> : null}
          </View>
        );
        switch (q.type) {
          case "choice":
            return (
              <View key={q.id} style={{ gap: theme.space(1) }}>
                {label}
                {(q.options ?? []).map((o) => choice(value === o, o, () => set(q.id, o)))}
              </View>
            );
          case "choices": {
            const list = Array.isArray(value) ? value : [];
            return (
              <View key={q.id} style={{ gap: theme.space(1) }}>
                {label}
                {(q.options ?? []).map((o) =>
                  choice(list.includes(o), o, () =>
                    set(q.id, list.includes(o) ? list.filter((x) => x !== o) : [...list, o]),
                  ),
                )}
              </View>
            );
          }
          case "yes_no":
            return (
              <View
                key={q.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                {label}
                <Switch
                  value={value === true}
                  onValueChange={(v) => set(q.id, v)}
                  accessibilityLabel={q.label}
                />
              </View>
            );
          default:
            return (
              <View key={q.id} style={{ gap: theme.space(1) }}>
                {label}
                <TextInput
                  value={value === undefined ? "" : String(value)}
                  onChangeText={(text) =>
                    set(q.id, q.type === "number" && text !== "" ? Number(text) : text)
                  }
                  keyboardType={q.type === "number" ? "numeric" : "default"}
                  multiline={q.type === "long_text"}
                  accessibilityLabel={q.label}
                  style={input}
                />
              </View>
            );
        }
      })}
      <Button
        label={submitLabel}
        disabled={disabled}
        busy={busy}
        onPress={() => onSubmit(answers)}
        testID="register-submit"
      />
    </View>
  );
}
