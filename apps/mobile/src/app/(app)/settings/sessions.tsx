// SPDX-License-Identifier: AGPL-3.0-only
// Where I am logged in: browsers and app installations. Revoking one ends
// its Zitadel session (that device has to log in again).

import { useTranslations } from "use-intl";

import { useRevokeSession, useSessions } from "../../../api/queries.ts";
import { DateTime } from "../../../components/date-time.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import {
  Body,
  EmptyState,
  LinkButton,
  Loading,
  Muted,
  Row,
  Screen,
  Section,
} from "../../../components/ui.tsx";

export default function Sessions() {
  const t = useTranslations();
  const sessions = useSessions();
  const revoke = useRevokeSession();
  if (!sessions.data) {
    if (sessions.isError)
      return (
        <Screen>
          <ErrorView error={sessions.error} onRetry={() => void sessions.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const list = sessions.data.sessions;
  return (
    <Screen
      refreshing={sessions.isRefetching}
      onRefresh={() => void sessions.refetch()}
      testID="sessions-screen"
    >
      <Section title={t("sessions.title")}>
        {list.length === 0 ? (
          <EmptyState title={t("sessions.empty")} />
        ) : (
          list.map((session, index) => (
            <Row key={session.id} last={index === list.length - 1} testID={`session-${session.id}`}>
              <Body style={{ fontWeight: "600" }}>
                {session.current ? t("mobile.thisDevice") : session.device}
              </Body>
              <Muted>
                {session.client === "mobile" ? t("mobile.clientApp") : t("mobile.clientWeb")}
              </Muted>
              <DateTime value={session.lastSeenAt} style={{ fontSize: 14 }} />
              {session.current ? null : (
                <LinkButton
                  label={t("sessions.revoke")}
                  onPress={() => revoke.mutate(session.id)}
                  testID={`revoke-${session.id}`}
                />
              )}
            </Row>
          ))
        )}
      </Section>
    </Screen>
  );
}
