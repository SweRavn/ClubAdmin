// SPDX-License-Identifier: AGPL-3.0-only
// Calendar subscription in the app (P1.11, ADR 0044): "Subscribe in my
// calendar" creates a feed of my schedule and all my children's (also later
// ones) and opens its webcal:// URL, which the phone's calendar subscribes
// to; the URL is not kept. The list shows my subscriptions (never their
// links); choosing people, renaming, new links and removing are on the web.

import { Linking } from "react-native";
import { useTranslations } from "use-intl";

import { useCalendarFeeds, useCreateCalendarFeed } from "../../../api/queries.ts";
import { DateTime } from "../../../components/date-time.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import {
  Body,
  Button,
  EmptyState,
  LinkButton,
  Loading,
  Muted,
  Row,
  Screen,
  Section,
} from "../../../components/ui.tsx";
import { appConfig } from "../../../config.ts";

/** The web app next to the API (api.<host> → <host>). */
const webUrl = (path: string) => `${appConfig.apiUrl.replace("://api.", "://")}${path}`;

export default function CalendarSubscriptionScreen() {
  const t = useTranslations();
  const feeds = useCalendarFeeds();
  const create = useCreateCalendarFeed();
  if (!feeds.data) {
    if (feeds.isError)
      return (
        <Screen>
          <ErrorView error={feeds.error} onRetry={() => void feeds.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const list = feeds.data.items;
  const full = list.length >= feeds.data.max;
  return (
    <Screen
      refreshing={feeds.isRefetching}
      onRefresh={() => void feeds.refetch()}
      testID="calendar-screen"
    >
      <Muted>{t("calendar.ui.intro")}</Muted>
      <Body>{t("calendar.ui.warning")}</Body>
      {full ? (
        <Muted>{t("calendar.ui.max", { max: feeds.data.max })}</Muted>
      ) : (
        <Button
          label={t("calendar.ui.subscribe")}
          busy={create.isPending}
          testID="subscribe-calendar"
          onPress={() =>
            create.mutate(undefined, {
              onSuccess: (created) => void Linking.openURL(created.webcalUrl),
            })
          }
        />
      )}
      {create.isError ? <Body>{t("joinErrors.failed")}</Body> : null}
      <Section title={t("calendar.ui.list")}>
        {list.length === 0 ? (
          <EmptyState title={t("calendar.ui.empty")} />
        ) : (
          list.map((feed, index) => (
            <Row key={feed.id} last={index === list.length - 1} testID={`calendar-feed-${feed.id}`}>
              <Body style={{ fontWeight: "600" }}>
                {feed.label ?? t(`calendar.ui.scopes.${feed.scope}`)}
              </Body>
              {feed.group || feed.club ? (
                <Muted>{feed.group?.name ?? feed.club?.name}</Muted>
              ) : null}
              {feed.lastFetchedAt ? (
                <DateTime value={feed.lastFetchedAt} style={{ fontSize: 14 }} />
              ) : (
                <Muted>{t("calendar.ui.neverFetched")}</Muted>
              )}
            </Row>
          ))
        )}
      </Section>
      <LinkButton
        label={t("calendar.ui.manageOnWeb")}
        onPress={() => void Linking.openURL(webUrl("/me/calendar"))}
        testID="manage-calendar-web"
      />
    </Screen>
  );
}
