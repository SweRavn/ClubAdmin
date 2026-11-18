// SPDX-License-Identifier: AGPL-3.0-only
// "Mina uppgifter" (P2.4, ADR 0052): the action items given to the person and
// their children, open ones by due date; the assignee marks one done. Cache
// first: the cached list shows at once.
import { useState } from "react";
import { Text, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { useMyTasks, useSetTaskStatus } from "../../../api/queries.ts";
import { DataAge } from "../../../components/data-age.tsx";
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
                  task.meeting ? t("tasks.from", { meeting: task.meeting.title }) : null,
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
    </Screen>
  );
}
