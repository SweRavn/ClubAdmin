// SPDX-License-Identifier: AGPL-3.0-only
// Taking attendance in the hall (P1.5): the roster and the leaders with
// large present / absent / excused buttons, prefilled from the answers. The
// marks go through the offline outbox: saved on the phone, sent in order
// when online (the newer mark wins on the server). The sheet itself comes
// from the persisted cache when there is no coverage. Guests are added on
// the web. Screenshots are blocked while protected people are shown.

import { enumKey } from "@clubadmin/i18n";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslations } from "use-intl";

import { useOutbox, usePendingWrites } from "../../../api/outbox.ts";
import { type Attendance, useAttendance } from "../../../api/queries.ts";
import { ErrorView } from "../../../components/error-view.tsx";
import { OutboxBanner } from "../../../components/outbox-banner.tsx";
import { PersonName } from "../../../components/person-name.tsx";
import { useProtectScreen } from "../../../components/protect-screen.ts";
import { useIdParam } from "../../../components/route-id.ts";
import { Body, Button, Loading, Muted, Row, Screen, Section } from "../../../components/ui.tsx";
import { useSession } from "../../../state/session.tsx";
import { useTheme } from "../../../theme.ts";
import NotFound from "../../+not-found.tsx";

const STATUSES = ["present", "absent", "excused"] as const;
type Status = (typeof STATUSES)[number];
type Mark = Attendance["participants"][number];

export default function AttendanceScreen() {
  const activityId = useIdParam("activityId");
  if (!activityId) return <NotFound />;
  return <Sheet activityId={activityId} />;
}

function useOnline(): boolean {
  return useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
  );
}

function Sheet({ activityId }: { activityId: string }) {
  const t = useTranslations();
  const theme = useTheme();
  const client = useQueryClient();
  const { personId, viewingAs } = useSession();
  const sheet = useAttendance(activityId);
  const send = useOutbox();
  const online = useOnline();
  const waiting = usePendingWrites().filter(
    (w) => w.kind === "attendance" && w.activityId === activityId,
  ).length;
  const [marks, setMarks] = useState<Record<string, Status>>({});
  const [reason, setReason] = useState("");
  const data = sheet.data;
  useProtectScreen(data?.hasProtected === true, `attendance-${activityId}`);

  // The sheet's marks (or the answers' suggestions) until the leader changes them.
  useEffect(() => {
    if (!data) return;
    setMarks((current) => {
      const next = { ...current };
      for (const m of [...data.participants, ...data.leaders]) {
        const initial = m.status ?? m.suggested;
        if (!(m.person.id in next) && initial) next[m.person.id] = initial;
      }
      return next;
    });
  }, [data]);

  if (!data) {
    if (sheet.isError)
      return (
        <Screen>
          <ErrorView error={sheet.error} onRetry={() => void sheet.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }

  const editable = data.canRecord || data.canCorrect;
  const everyone = [...data.participants, ...data.leaders];
  const save = () => {
    const list = everyone.flatMap((m) => {
      const status = marks[m.person.id];
      return status ? [{ personId: m.person.id, status, role: m.role }] : [];
    });
    if (list.length === 0) return;
    send({
      kind: "attendance",
      activityId,
      marks: list,
      ...(data.canCorrect && reason.trim() ? { correctedReason: reason.trim() } : {}),
    });
    // The cached sheet shows the marks at once (also after a restart offline).
    client.setQueryData<Attendance>(
      ["attendance", activityId, personId, viewingAs ?? "self"],
      (old) =>
        old
          ? {
              ...old,
              participants: old.participants.map((m) => ({
                ...m,
                status: marks[m.person.id] ?? m.status,
              })),
              leaders: old.leaders.map((m) => ({ ...m, status: marks[m.person.id] ?? m.status })),
            }
          : old,
    );
  };

  const row = (m: Mark, index: number, list: readonly Mark[]) => (
    <Row key={m.person.id} last={index === list.length - 1} testID={`attendance-${m.person.id}`}>
      <PersonName person={m.person} />
      <View style={{ flexDirection: "row", gap: theme.space(2), flexWrap: "wrap" }}>
        {STATUSES.map((status) => {
          const selected = marks[m.person.id] === status;
          return (
            <Pressable
              key={status}
              disabled={!editable}
              onPress={() => setMarks((current) => ({ ...current, [m.person.id]: status }))}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled: !editable }}
              accessibilityLabel={t(enumKey("attendanceStatus", status))}
              testID={`mark-${status}-${m.person.id}`}
              style={{
                minHeight: 48,
                minWidth: 96,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 8,
                borderWidth: 1,
                borderColor: selected ? theme.colors.accent : theme.colors.border,
                backgroundColor: selected ? theme.colors.accent : "transparent",
                opacity: editable ? 1 : 0.6,
              }}
            >
              <Text
                style={{
                  color: selected ? theme.colors.accentFg : theme.colors.fg,
                  fontWeight: "600",
                }}
              >
                {t(enumKey("attendanceStatus", status))}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Row>
  );

  return (
    <Screen
      refreshing={sheet.isRefetching}
      onRefresh={() => void sheet.refetch()}
      testID="attendance-screen"
    >
      <Stack.Screen options={{ title: t("attendance.title") }} />
      <OutboxBanner />
      {!online ? <Muted>{t("mobile.attendanceOffline")}</Muted> : null}
      {data.hasProtected ? <Muted>{t("attendance.protectedNotice")}</Muted> : null}
      {!data.open ? <Body>{t("attendance.notOpen")}</Body> : null}
      {data.locked ? <Body>{t("attendance.locked")}</Body> : null}
      {data.hints.map((h) => (
        <Muted key={h.code}>{t(enumKey("grantHints.lok", h.code))}</Muted>
      ))}
      <Section title={t("attendance.participants")}>{data.participants.map(row)}</Section>
      <Section title={t("attendance.leaders")}>{data.leaders.map(row)}</Section>
      {data.canCorrect ? (
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder={t("attendance.correctionReason")}
          maxLength={300}
          testID="correction-reason"
          style={{
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            padding: theme.space(3),
            color: theme.colors.fg,
          }}
        />
      ) : null}
      {editable ? (
        <Button
          label={data.canCorrect ? t("attendance.correct") : t("attendance.save")}
          onPress={save}
          disabled={data.canCorrect && reason.trim() === ""}
          testID="attendance-save"
        />
      ) : null}
      {waiting > 0 ? <Muted>{t("mobile.outboxWaiting", { count: waiting })}</Muted> : null}
    </Screen>
  );
}
