// SPDX-License-Identifier: AGPL-3.0-only
// "Mina uppgifter" (P2.4, ADR 0052): the action items given to the person and
// their children, open ones by due date; the assignee marks one done. Duty
// shifts (P2.6) can be offered to another family, and below the list are the
// family's duties in a club: quotas, swaps and shifts that need more people.
// Cache first: the cached lists show at once.
import { useState } from "react";
import { Text, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import {
  useCreateDutySwap,
  useMyClubs,
  useMyDuties,
  useMyTasks,
  useMyWards,
  useSetTaskStatus,
} from "../../../api/queries.ts";
import { DataAge } from "../../../components/data-age.tsx";
import { MyDutiesSections } from "../../../components/duties.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { Button, EmptyState, Loading, Muted, Screen, Section } from "../../../components/ui.tsx";
import { useTheme } from "../../../theme.ts";

export default function MyTasks() {
  const t = useTranslations();
  const format = useFormatter();
  const theme = useTheme();
  const [status, setStatus] = useState<"open" | "closed">("open");
  const tasks = useMyTasks(status);
  const mark = useSetTaskStatus();
  const offer = useCreateDutySwap();
  const clubs = useMyClubs();
  const wards = useMyWards();
  // The family's clubs: mine and those of the children I act for.
  const dutyClubs = new Map<string, string>();
  for (const c of clubs.data?.clubs ?? []) dutyClubs.set(c.club.id, c.club.name);
  for (const w of wards.data?.wards ?? []) {
    if (!w.rights.includes("act_on_behalf")) continue;
    for (const c of w.clubs ?? []) if (!dutyClubs.has(c.id)) dutyClubs.set(c.id, c.name);
  }
  const [chosenClub, setClub] = useState<string | null>(null);
  const clubId = chosenClub ?? [...dutyClubs.keys()][0] ?? null;
  const duties = useMyDuties(clubId);
  if (!tasks.data) {
    if (tasks.isError)
      return (
        <Screen>
          <ErrorView error={tasks.error} onRetry={() => void tasks.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const items = tasks.data.pages.flatMap((page) => page.items);
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  return (
    <Screen
      refreshing={tasks.isRefetching}
      onRefresh={() => void tasks.refetch()}
      testID="tasks-screen"
    >
      <DataAge updatedAt={tasks.dataUpdatedAt} />
      <Muted>{t("tasks.intro")}</Muted>
      <View style={{ flexDirection: "row", gap: theme.space(2) }}>
        <Button
          label={t("tasks.open")}
          kind={status === "open" ? "primary" : "secondary"}
          onPress={() => setStatus("open")}
          testID="tasks-open"
        />
        <Button
          label={t("tasks.closed")}
          kind={status === "closed" ? "primary" : "secondary"}
          onPress={() => setStatus("closed")}
          testID="tasks-closed"
        />
      </View>
      <Section title={status === "open" ? t("tasks.open") : t("tasks.closed")}>
        {items.length === 0 ? (
          <EmptyState title={t("tasks.empty")} />
        ) : (
          items.map((task) => (
            <View
              key={task.assignmentId}
              style={{ gap: theme.space(1), paddingVertical: theme.space(2) }}
              testID="task"
            >
              <Text style={{ color: theme.colors.fg, fontWeight: "600" }}>{task.title}</Text>
              <Muted>
                {[
                  task.groupName ?? task.clubName,
                  task.dueDate ? t("tasks.due", { date: day(task.dueDate) }) : null,
                  // A shift's activity is where it is done, not where it was decided.
                  task.meeting
                    ? task.kind === "duty_shift"
                      ? task.meeting.title
                      : t("tasks.from", { meeting: task.meeting.title })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Muted>
              {/* Shifts (P2.6) are marked by their planners. */}
              {task.kind === "action_item" ? (
                <Button
                  label={task.status === "planned" ? t("tasks.markDone") : t("tasks.markPlanned")}
                  kind="secondary"
                  busy={mark.isPending && mark.variables?.assignmentId === task.assignmentId}
                  onPress={() =>
                    mark.mutate({
                      assignmentId: task.assignmentId,
                      status: task.status === "planned" ? "done" : "planned",
                    })
                  }
                  testID={`task-toggle-${task.assignmentId}`}
                />
              ) : null}
              {task.kind === "duty_shift" &&
              task.status === "planned" &&
              task.startsAt &&
              Date.parse(task.startsAt) > Date.now() ? (
                <Button
                  label={t("duties.offer")}
                  kind="secondary"
                  busy={offer.isPending && offer.variables?.assignmentId === task.assignmentId}
                  onPress={() =>
                    offer.mutate({
                      clubId: task.clubId,
                      assignmentId: task.assignmentId,
                      kind: "offer",
                    })
                  }
                  testID={`duty-offer-${task.assignmentId}`}
                />
              ) : null}
            </View>
          ))
        )}
      </Section>
      {tasks.hasNextPage ? (
        <Button
          label={t("documents.more")}
          kind="secondary"
          busy={tasks.isFetchingNextPage}
          onPress={() => void tasks.fetchNextPage()}
        />
      ) : null}
      {dutyClubs.size > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) }}>
          {[...dutyClubs].map(([id, name]) => (
            <Button
              key={id}
              label={name}
              kind={id === clubId ? "primary" : "secondary"}
              onPress={() => setClub(id)}
            />
          ))}
        </View>
      ) : null}
      {duties.data ? <MyDutiesSections duties={duties.data} /> : null}
    </Screen>
  );
}
