// SPDX-License-Identifier: AGPL-3.0-only
// The activity form (P2.7g) for a new activity of a group and for changing
// one: kind, the title that follows the kind until one is written (P2.7e),
// date and times with the phone's pickers in the club's time zone, place,
// meeting, match details, answers, transport and the way home, notes, and
// for a new one the call-up list (all ticked; those unticked are not called
// up). Needs a connection: offline, the button says so. The API's field
// errors are shown next to their fields.

import { enumKey } from "@clubadmin/i18n";
import type { PersonSummary } from "@clubadmin/shared";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslations } from "use-intl";

import type { Location } from "../api/queries.ts";
import { useTheme } from "../theme.ts";
import {
  activityBody,
  type ActivityValues,
  errorsByField,
  followTitle,
  HOME_AWAY_VALUES,
  type Kind,
  KINDS,
  kindTitle,
  leftOut,
  RESPONSE_MODE_VALUES,
  TRANSPORT_VALUES,
} from "./activity-logic.ts";
import {
  Choice,
  DateTimeField,
  FormError,
  type FormErrors,
  formErrorsOf,
  SwitchField,
  TextField,
  useOnline,
} from "./form.tsx";
import { PersonName } from "./person-name.tsx";
import { Button, Muted, Section } from "./ui.tsx";

export function useKindTitles(): Record<Kind, string> {
  const t = useTranslations();
  return Object.fromEntries(KINDS.map((k) => [k, t(enumKey("activityKinds", k))])) as Record<
    Kind,
    string
  >;
}

export function ActivityForm({
  initial,
  timeZone,
  locations,
  players,
  submitLabel,
  busy,
  error,
  onSubmit,
  edit,
}: {
  initial: ActivityValues;
  timeZone: string;
  locations: readonly Location[];
  /** The group's players for the call-up list (new activities only). */
  players?: readonly PersonSummary[];
  submitLabel: string;
  busy: boolean;
  /** The failed request's error, if any. */
  error: unknown;
  onSubmit: (body: Record<string, unknown>, notCalledUp: string[]) => void;
  /** Changing an activity: empty fields clear, no "all day" (as the API). */
  edit?: boolean;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const online = useOnline();
  const titles = useKindTitles();
  const [v, setV] = useState<ActivityValues>(initial);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set((players ?? []).map((p) => p.id)),
  );
  const remote = formErrorsOf(error);
  const errors: FormErrors = {
    form: remote.form,
    fields: errorsByField({ ...remote.fields, ...local }),
  };
  const e = (name: keyof ActivityValues) => errors.fields[name];
  const set = <K extends keyof ActivityValues>(name: K, value: ActivityValues[K]) =>
    setV((old) => ({ ...old, [name]: value }));
  const setKind = (kind: Kind, kindLabel = v.kindLabel) =>
    setV((old) => ({
      ...old,
      kind,
      kindLabel,
      title: followTitle(
        old.title,
        kindTitle(old.kind, old.kindLabel, titles),
        kindTitle(kind, kindLabel, titles),
        titles,
      ),
    }));

  const submit = () => {
    const result = activityBody(v, timeZone, titles, edit === true);
    if ("fields" in result) {
      setLocal(result.fields);
      return;
    }
    setLocal({});
    onSubmit(
      result.body,
      leftOut(
        (players ?? []).map((p) => p.id),
        ticked,
      ),
    );
  };

  return (
    <View style={{ gap: theme.space(3) }} testID="activity-form">
      <Choice
        label={t("activities.kind")}
        name="activity-kind"
        value={v.kind}
        onChange={(kind) => setKind(kind)}
        options={KINDS.map((k) => ({ value: k, label: titles[k] }))}
        error={e("kind")}
      />
      {v.kind === "other" ? (
        <TextField
          label={t("activities.kindLabel")}
          name="kindLabel"
          value={v.kindLabel}
          onChange={(label) => setKind("other", label)}
          maxLength={60}
          error={e("kindLabel")}
        />
      ) : null}
      <TextField
        label={t("activities.titleField")}
        name="title"
        value={v.title}
        onChange={(title) => set("title", title)}
        maxLength={120}
        error={e("title")}
      />
      <DateTimeField
        label={t("activities.date")}
        mode="date"
        name="date"
        value={v.date}
        onChange={(date) => set("date", date)}
        error={e("date")}
        hint={t("activities.timeZoneHint", { zone: timeZone })}
      />
      {edit ? null : (
        <SwitchField
          label={t("activities.allDay")}
          name="activity-allDay"
          value={v.allDay}
          onChange={(allDay) => set("allDay", allDay)}
        />
      )}
      {v.allDay ? null : (
        <View style={{ flexDirection: "row", gap: theme.space(3) }}>
          <View style={{ flex: 1 }}>
            <DateTimeField
              label={t("activities.startTime")}
              mode="time"
              name="startTime"
              date={v.date}
              value={v.startTime}
              onChange={(time) => set("startTime", time)}
              error={e("startTime")}
            />
          </View>
          <View style={{ flex: 1 }}>
            <DateTimeField
              label={t("activities.endTime")}
              mode="time"
              name="endTime"
              date={v.date}
              value={v.endTime}
              onChange={(time) => set("endTime", time)}
              error={e("endTime")}
            />
          </View>
        </View>
      )}
      <Choice
        label={t("activities.location")}
        name="activity-location"
        value={v.locationId}
        onChange={(id) => set("locationId", id)}
        options={[
          ...locations.map((l) => ({ value: l.id, label: l.name })),
          { value: "", label: t("activities.otherPlace") },
        ]}
        error={e("locationId")}
      />
      {v.locationId === "" ? (
        <TextField
          label={t("activities.locationText")}
          name="locationText"
          value={v.locationText}
          onChange={(text) => set("locationText", text)}
          maxLength={200}
          error={e("locationText")}
        />
      ) : null}
      {v.allDay ? null : (
        <DateTimeField
          label={t("activities.meetTime")}
          mode="time"
          name="meetTime"
          date={v.date}
          optional
          value={v.meetTime}
          onChange={(time) => set("meetTime", time)}
          error={e("meetTime")}
        />
      )}
      <TextField
        label={t("activities.meetPlace")}
        name="meetPlace"
        value={v.meetPlace}
        onChange={(text) => set("meetPlace", text)}
        maxLength={200}
        error={e("meetPlace")}
      />
      {v.kind === "match" ? (
        <>
          <TextField
            label={t("activities.opponent")}
            name="opponent"
            value={v.opponent}
            onChange={(text) => set("opponent", text)}
            maxLength={120}
            error={e("opponent")}
          />
          <Choice
            label={t("activities.homeAway")}
            name="activity-homeAway"
            value={v.homeAway}
            onChange={(value) => set("homeAway", value)}
            options={[
              { value: "" as const, label: t("activities.notGiven") },
              ...HOME_AWAY_VALUES.map((h) => ({ value: h, label: t(enumKey("homeAway", h)) })),
            ]}
            error={e("homeAway")}
          />
          <TextField
            label={t("activities.competition")}
            name="competition"
            value={v.competition}
            onChange={(text) => set("competition", text)}
            maxLength={120}
            error={e("competition")}
          />
        </>
      ) : null}
      <Choice
        label={t("responses.mode")}
        name="activity-responseMode"
        value={v.responseMode}
        onChange={(mode) => set("responseMode", mode)}
        options={RESPONSE_MODE_VALUES.map((m) => ({
          value: m,
          label: t(enumKey("responseModes", m)),
        }))}
        error={e("responseMode")}
      />
      {v.responseMode === "none" ? null : (
        <View style={{ flexDirection: "row", gap: theme.space(3) }}>
          <View style={{ flex: 1 }}>
            <DateTimeField
              label={`${t("mobile.respondBy")}: ${t("responses.respondByDate")}`}
              mode="date"
              name="respondByDate"
              optional
              value={v.respondByDate}
              onChange={(date) => set("respondByDate", date)}
              error={e("respondByDate")}
              hint={t("responses.respondByDateHint")}
            />
          </View>
          <View style={{ flex: 1 }}>
            <DateTimeField
              label={t("responses.respondByTime")}
              mode="time"
              name="respondByTime"
              optional
              date={v.respondByDate}
              value={v.respondByTime}
              onChange={(time) => set("respondByTime", time)}
            />
          </View>
        </View>
      )}
      <Choice
        label={t("carpool.transportMode")}
        name="activity-transportMode"
        value={v.transportMode}
        onChange={(mode) => set("transportMode", mode)}
        options={[
          { value: "" as const, label: t("activities.notGiven") },
          ...TRANSPORT_VALUES.map((m) => ({
            value: m,
            label: t(enumKey("carpool.transportModes", m)),
          })),
        ]}
        hint={t("carpool.transportModeHint")}
        error={e("transportMode")}
      />
      {v.transportMode === "shared" ? null : (
        <TextField
          label={t("carpool.returnMinutes")}
          name="carpoolReturnMinutes"
          keyboardType="number-pad"
          value={v.carpoolReturnMinutes}
          onChange={(text) => set("carpoolReturnMinutes", text.replace(/[^0-9]/g, ""))}
          maxLength={3}
          hint={t("carpool.returnMinutesHint")}
          error={e("carpoolReturnMinutes")}
        />
      )}
      <TextField
        label={t("activities.notes")}
        name="notes"
        multiline
        value={v.notes}
        onChange={(text) => set("notes", text)}
        maxLength={2000}
        error={e("notes")}
      />
      <TextField
        label={t("activities.leaderNotes")}
        name="leaderNotes"
        multiline
        value={v.leaderNotes}
        onChange={(text) => set("leaderNotes", text)}
        maxLength={2000}
        hint={t("activities.leaderNotesHint")}
        error={e("leaderNotes")}
      />
      {players && players.length > 0 ? (
        <CallUpList
          players={players}
          ticked={ticked}
          onToggle={(id) =>
            setTicked((old) => {
              const next = new Set(old);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
        />
      ) : null}
      <FormError errors={errors} />
      {online ? null : <Muted testID="needs-connection">{t("mobile.needsConnection")}</Muted>}
      <Button
        label={submitLabel}
        busy={busy}
        disabled={!online}
        onPress={submit}
        testID="activity-submit"
      />
    </View>
  );
}

/** The players to call up (P2.7e): all ticked; untick those who are not called up. */
function CallUpList({
  players,
  ticked,
  onToggle,
}: {
  players: readonly PersonSummary[];
  ticked: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const t = useTranslations();
  const theme = useTheme();
  return (
    <Section title={`${t("callUp.title")} · ${t("callUp.count", { count: ticked.size })}`}>
      <Muted style={{ paddingTop: theme.space(2) }}>{t("callUp.hint")}</Muted>
      {players.map((p) => {
        const on = ticked.has(p.id);
        return (
          <Pressable
            key={p.id}
            onPress={() => onToggle(p.id)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            testID={`call-up-${p.id}`}
            style={{
              minHeight: theme.touch,
              flexDirection: "row",
              alignItems: "center",
              gap: theme.space(3),
            }}
          >
            <Text
              style={{
                width: 24,
                textAlign: "center",
                fontSize: 18,
                color: on ? theme.colors.accent : theme.colors.muted,
              }}
            >
              {on ? "☑" : "☐"}
            </Text>
            <PersonName person={p} />
          </Pressable>
        );
      })}
    </Section>
  );
}
