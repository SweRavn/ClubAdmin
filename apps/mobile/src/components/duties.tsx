// SPDX-License-Identifier: AGPL-3.0-only
// Volunteer duties in the app (P2.6, ADR 0050): a shift with who is on it
// (as the API shows them: the club's visibility setting and protected
// identity), signing up oneself counting for a child in the shift's group,
// cancelling one's own sign-up, and in "Mina uppgifter" the family's
// quotas, open shifts and swaps (take an offer, answer a request, withdraw
// one's own). Planning shifts happens on the web. Cache first: the cached
// lists show at once.

import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/shared";
import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import {
  type DutyShift,
  type MyDuties,
  useAnswerDutySwap,
  useDutyCancel,
  useDutySignUp,
  useMyGroups,
  useMyWards,
} from "../api/queries.ts";
import { useTheme } from "../theme.ts";
import { RoleBadge } from "./role-badge.tsx";
import { Body, Button, Muted, Row, Section } from "./ui.tsx";

/** The children I act for who are in the shift's group (a club shift: all of them). */
function useCountsFor(groupId: string | null) {
  const wards = useMyWards();
  const groups = useMyGroups();
  const acting = (wards.data?.wards ?? []).filter((w) => w.rights.includes("act_on_behalf"));
  const inGroup = new Set(
    (groups.data?.wards ?? [])
      .filter((w) => groupId === null || w.groups.some((g) => g.group.id === groupId))
      .map((w) => w.personId),
  );
  return acting.filter((w) => inGroup.has(w.person.id)).map((w) => w.person);
}

function ShiftRow({ shift, last }: { shift: DutyShift; last: boolean }) {
  const t = useTranslations();
  const format = useFormatter();
  const theme = useTheme();
  const signUp = useDutySignUp();
  const cancel = useDutyCancel();
  const children = useCountsFor(shift.groupId);
  const open = Date.parse(shift.startsAt) > Date.now();
  const free = shift.filled < shift.needed;
  const when = `${format.dateTime(new Date(shift.startsAt), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: shift.timeZone,
  })} – ${format.dateTime(new Date(shift.endsAt), { timeStyle: "short", timeZone: shift.timeZone })}`;
  const busy = (id: string | null) =>
    signUp.isPending &&
    signUp.variables?.shiftId === shift.id &&
    (signUp.variables.countsForPersonId ?? null) === id;
  return (
    <Row last={last} testID="duty-shift">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(1) }}>
        <Body style={{ fontWeight: "600" }}>{shift.title}</Body>
        <RoleBadge
          tone={free ? "accent" : "neutral"}
          label={t("duties.filled", { filled: shift.filled, needed: shift.needed })}
        />
        {shift.dutyType.childContact !== "none" ? (
          <RoleBadge label={t(enumKey("duties.childContacts", shift.dutyType.childContact))} />
        ) : null}
      </View>
      <Muted>{[when, shift.locationName, shift.groupName].filter(Boolean).join(" · ")}</Muted>
      {shift.note ? <Body>{shift.note}</Body> : null}
      {shift.assignments.map((a) => (
        <View
          key={a.id}
          style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}
          testID="duty-assignment"
        >
          <Body>
            {a.person ? personLabel(a.person) : t("duties.someone")}
            {a.countsFor && a.countsFor.id !== a.person?.id
              ? ` (${t("duties.countsFor", { name: personLabel(a.countsFor) })})`
              : ""}
          </Body>
          {open && a.mine && a.source !== "assigned" ? (
            <Button
              kind="secondary"
              label={t("duties.cancel")}
              busy={cancel.isPending && cancel.variables?.assignmentId === a.id}
              onPress={() =>
                cancel.mutate({ clubId: shift.clubId, shiftId: shift.id, assignmentId: a.id })
              }
              testID={`duty-cancel-${a.id}`}
            />
          ) : null}
        </View>
      ))}
      {open && free
        ? (children.length === 0 ? [null] : children).map((child) => (
            <Button
              key={child?.id ?? "me"}
              kind="secondary"
              label={
                child
                  ? `${t("duties.signUp")} (${t("duties.countsFor", { name: personLabel(child) })})`
                  : t("duties.signUp")
              }
              busy={busy(child?.id ?? null)}
              onPress={() =>
                signUp.mutate({
                  clubId: shift.clubId,
                  shiftId: shift.id,
                  ...(child ? { countsForPersonId: child.id } : {}),
                })
              }
              testID={`duty-signup-${shift.id}${child ? `-${child.id}` : ""}`}
            />
          ))
        : null}
    </Row>
  );
}

/** Shifts under a heading (an activity's, or open ones in "Mina uppgifter"). */
export function DutyShifts({
  title,
  shifts,
  empty,
}: {
  title: string;
  shifts: readonly DutyShift[];
  empty?: string;
}) {
  if (shifts.length === 0 && !empty) return null;
  return (
    <Section title={title}>
      {shifts.length === 0 ? (
        <Row last>
          <Muted>{empty}</Muted>
        </Row>
      ) : (
        shifts.map((s, i) => <ShiftRow key={s.id} shift={s} last={i === shifts.length - 1} />)
      )}
    </Section>
  );
}

/** "Mina uppgifter" (P2.6): the family's quotas, swaps and open shifts in a club. */
export function MyDutiesSections({ duties }: { duties: MyDuties }) {
  const t = useTranslations();
  const theme = useTheme();
  const answer = useAnswerDutySwap();
  const busy = (swapId: string, kind: string) =>
    answer.isPending && answer.variables?.swapId === swapId && answer.variables.answer === kind;
  return (
    <>
      <Section title={t("duties.quotas")}>
        {duties.quotas.length === 0 ? (
          <Row last>
            <Muted>{t("duties.noQuotas")}</Muted>
          </Row>
        ) : (
          duties.quotas.map((q, i) => (
            <Row
              key={`${q.groupId}-${q.player?.id ?? i}`}
              last={i === duties.quotas.length - 1}
              testID="duty-quota"
            >
              <Body>
                {`${q.player ? personLabel(q.player) : t("duties.someone")} · ${q.groupName}`}
              </Body>
              <Muted>
                {t("duties.quotaLine", {
                  done: q.done,
                  planned: q.planned,
                  quota: q.shiftsPerPlayer,
                })}
              </Muted>
            </Row>
          ))
        )}
      </Section>
      <Section title={t("duties.swaps")}>
        {duties.swaps.length === 0 ? (
          <Row last>
            <Muted>{t("duties.noSwaps")}</Muted>
          </Row>
        ) : (
          duties.swaps.map((w, i) => (
            <Row key={w.id} last={i === duties.swaps.length - 1} testID="duty-swap">
              <Body>
                {`${t(enumKey("duties.swapKinds", w.kind))}: ${w.shift.title}${
                  w.holder ? ` · ${personLabel(w.holder)}` : ""
                }`}
              </Body>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) }}>
                {w.canTake ? (
                  <Button
                    label={t("duties.take")}
                    busy={busy(w.id, "take")}
                    onPress={() =>
                      answer.mutate({ clubId: duties.clubId, swapId: w.id, answer: "take" })
                    }
                    testID={`duty-swap-take-${w.id}`}
                  />
                ) : null}
                {w.canAccept
                  ? (["accept", "decline"] as const).map((kind) => (
                      <Button
                        key={kind}
                        kind={kind === "accept" ? "primary" : "secondary"}
                        label={t(kind === "accept" ? "duties.accept" : "duties.decline")}
                        busy={busy(w.id, kind)}
                        onPress={() =>
                          answer.mutate({ clubId: duties.clubId, swapId: w.id, answer: kind })
                        }
                        testID={`duty-swap-${kind}-${w.id}`}
                      />
                    ))
                  : null}
                {w.mine ? (
                  <Button
                    kind="secondary"
                    label={t("duties.withdraw")}
                    busy={busy(w.id, "withdraw")}
                    onPress={() =>
                      answer.mutate({ clubId: duties.clubId, swapId: w.id, answer: "withdraw" })
                    }
                    testID={`duty-swap-withdraw-${w.id}`}
                  />
                ) : null}
              </View>
            </Row>
          ))
        )}
      </Section>
      <DutyShifts
        title={t("duties.openShifts")}
        shifts={duties.openShifts}
        empty={t("duties.noOpenShifts")}
      />
    </>
  );
}
