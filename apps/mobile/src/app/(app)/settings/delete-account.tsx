// SPDX-License-Identifier: AGPL-3.0-only
// Deleting my account in the app (P1.8b; app stores require account
// deletion inside apps that create accounts): what happens and when, what
// must be settled first per club, my children without a login (deleted too
// unless I keep them), a confirmation, and "Cancel deletion" while it is
// planned. The cached preview shows at once and is refreshed before the
// confirmation can be pressed.

import { ApiError } from "@clubadmin/api-client";
import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/shared";
import { useState } from "react";
import { Linking, Switch, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { useAccountDeletion, useDeletionPreview } from "../../../api/queries.ts";
import { useOnline } from "../../../components/banners.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import {
  Body,
  Button,
  LinkButton,
  Loading,
  Muted,
  Row,
  Screen,
  Section,
} from "../../../components/ui.tsx";
import { appConfig } from "../../../config.ts";
import { useTheme } from "../../../theme.ts";

const webUrl = (path: string) => `${appConfig.apiUrl.replace("://api.", "://")}${path}`;

export default function DeleteAccountScreen() {
  const t = useTranslations();
  const format = useFormatter();
  const theme = useTheme();
  const online = useOnline();
  const preview = useDeletionPreview();
  const { schedule, cancel } = useAccountDeletion();
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  if (!preview.data) {
    if (preview.isError)
      return (
        <Screen>
          <ErrorView error={preview.error} onRetry={() => void preview.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const p = preview.data;
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "long" });
  const when = date(new Date(Date.now() + p.graceDays * 86_400_000).toISOString());
  const blockers = [...p.blockers, ...p.wards.flatMap((w) => w.blockers)];
  const failure = schedule.error ?? cancel.error;
  const error =
    failure instanceof ApiError && typeof failure.problem?.detail === "string"
      ? (() => {
          const key = enumKey("joinErrors", failure.problem.detail);
          return key === "common.other" ? t("joinErrors.failed") : t(key);
        })()
      : failure
        ? t("joinErrors.failed")
        : null;
  return (
    <Screen testID="delete-account-screen">
      {error ? <Body style={{ color: theme.colors.danger }}>{error}</Body> : null}
      {p.pending ? (
        <Section title={t("privacy.deletion.title")}>
          <Row>
            <Body>{t("privacy.deletion.scheduled", { date: date(p.pending.scheduledFor) })}</Body>
          </Row>
          <Row last>
            <Button
              label={t("privacy.deletion.cancelButton")}
              onPress={() => cancel.mutate()}
              busy={cancel.isPending}
              disabled={!online}
              testID="cancel-deletion"
            />
          </Row>
        </Section>
      ) : (
        <>
          <Muted>{t("privacy.deletion.whatHappens", { days: p.graceDays })}</Muted>
          {blockers.length > 0 ? (
            <Section title={t("privacy.deletion.blockersTitle")}>
              {blockers.map((b, i) => (
                <Row key={`${b.personId}-${b.clubId}-${b.code}`} last={i === blockers.length - 1}>
                  <Body>
                    {b.code === "outstanding_invoices"
                      ? t("privacy.deletion.blocker.outstanding_invoices", {
                          club: b.clubName,
                          count: b.count ?? 1,
                          role: t(enumKey("roles", b.contactRole ?? "treasurer")),
                        })
                      : b.code === "last_club_manager"
                        ? t("privacy.deletion.blocker.last_club_manager", { club: b.clubName })
                        : t("privacy.deletion.blocker.roles_must_be_removed", { club: b.clubName })}
                  </Body>
                  {b.code === "roles_must_be_removed" ? (
                    <LinkButton
                      label={t("privacy.deletion.manageAssignments", { club: b.clubName })}
                      onPress={() =>
                        void Linking.openURL(
                          webUrl(`/me/privacy/leave?clubId=${b.clubId}&personId=${b.personId}`),
                        )
                      }
                    />
                  ) : null}
                </Row>
              ))}
            </Section>
          ) : null}
          {p.wards.length > 0 ? (
            <Section title={t("privacy.deletion.wardsTitle")}>
              <Row>
                <Muted>{t("privacy.deletion.wardsIntro")}</Muted>
              </Row>
              {p.wards.map((w, i) => {
                const label = t("privacy.deletion.eraseWard", { name: personLabel(w.person) });
                return (
                  <Row key={w.person.id} last={i === p.wards.length - 1}>
                    <View
                      style={{ flexDirection: "row", alignItems: "center", gap: theme.space(3) }}
                    >
                      <Body style={{ flex: 1 }}>{label}</Body>
                      <Switch
                        value={!kept.has(w.person.id)}
                        accessibilityLabel={label}
                        testID={`erase-ward-${w.person.id}`}
                        onValueChange={(erase) => {
                          const next = new Set(kept);
                          if (erase) next.delete(w.person.id);
                          else next.add(w.person.id);
                          setKept(next);
                        }}
                      />
                    </View>
                  </Row>
                );
              })}
            </Section>
          ) : null}
          <Section title={t("privacy.deletion.title")}>
            <Row>
              <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(3) }}>
                <Body style={{ flex: 1 }}>{t("privacy.deletion.confirm", { date: when })}</Body>
                <Switch
                  value={confirmed}
                  accessibilityLabel={t("privacy.deletion.confirm", { date: when })}
                  testID="confirm-deletion"
                  onValueChange={setConfirmed}
                />
              </View>
            </Row>
            <Row last>
              <Button
                kind="danger"
                label={
                  preview.isFetching
                    ? t("privacy.deletion.refreshing")
                    : t("privacy.deletion.confirmButton")
                }
                busy={schedule.isPending}
                // The preview is always fresh before confirming (ADR 0040: cache first, but not here).
                disabled={!online || !confirmed || blockers.length > 0 || preview.isFetching}
                onPress={() =>
                  void preview.refetch().then((fresh) => {
                    if (!fresh.data || fresh.data.blockers.length > 0 || fresh.data.pending) return;
                    schedule.mutate(
                      fresh.data.wards.map((w) => w.person.id).filter((id) => !kept.has(id)),
                    );
                  })
                }
                testID="schedule-deletion"
              />
            </Row>
          </Section>
        </>
      )}
    </Screen>
  );
}
