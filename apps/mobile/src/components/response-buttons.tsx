// SPDX-License-Identifier: AGPL-3.0-only
// "Coming" / "Not coming" for one person (P1.5). The answer goes through the
// outbox (sent at once when online, later when not) and shows at once in
// the cached schedule; after the deadline only "Not coming" is offered.
// Leaders answer for participants with the same control (P1.6b, `onAnswer`
// updates their list).
import { useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { useTranslations } from "use-intl";

import { useOutbox } from "../api/outbox.ts";
import type { SchedulePage } from "../api/queries.ts";
import { useSession } from "../state/session.tsx";
import { useTheme } from "../theme.ts";

type Status = "attending" | "not_attending";

/** Sets the answer in the cached schedule (optimistic; the refetch after sending confirms it). */
function useOptimisticAnswer() {
  const client = useQueryClient();
  const { personId, viewingAs } = useSession();
  return (activityId: string, who: string, status: Status) =>
    client.setQueryData<SchedulePage>(["schedule", personId, viewingAs ?? "self"], (page) =>
      page
        ? {
            ...page,
            items: page.items.map((item) =>
              item.activityId === activityId
                ? {
                    ...item,
                    responses: (item.responses ?? []).map((r) =>
                      r.personId === who ? { ...r, status } : r,
                    ),
                  }
                : item,
            ),
          }
        : page,
    );
}

export function ResponseButtons({
  activityId,
  personId,
  status,
  deadlinePassed,
  label,
  onAnswer,
}: {
  activityId: string;
  personId: string;
  status: Status | null;
  deadlinePassed: boolean;
  label?: string;
  onAnswer?: (status: Status) => void;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const send = useOutbox();
  const optimistic = useOptimisticAnswer();
  const answer = (next: Status) => {
    if (next === status) return;
    optimistic(activityId, personId, next);
    onAnswer?.(next);
    send({ kind: "response", activityId, personId, status: next });
  };
  const button = (value: Status, text: string) => {
    const selected = status === value;
    return (
      <Pressable
        key={value}
        onPress={() => answer(value)}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={label ? `${label}: ${text}` : text}
        testID={`answer-${value}-${activityId}-${personId}`}
        style={{
          minHeight: theme.touch,
          justifyContent: "center",
          paddingHorizontal: theme.space(3),
          borderRadius: 8,
          borderWidth: 1,
          borderColor: selected ? theme.colors.accent : theme.colors.border,
          backgroundColor: selected ? theme.colors.accent : "transparent",
        }}
      >
        <Text
          style={{ color: selected ? theme.colors.accentFg : theme.colors.fg, fontWeight: "600" }}
        >
          {text}
        </Text>
      </Pressable>
    );
  };
  return (
    <View
      style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}
    >
      {label ? <Text style={{ color: theme.colors.fg }}>{label}</Text> : null}
      {deadlinePassed ? null : button("attending", t("responses.coming"))}
      {button("not_attending", t("responses.notComing"))}
    </View>
  );
}
