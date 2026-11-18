// SPDX-License-Identifier: AGPL-3.0-only
// "Mina samåkningar" (P2.5, ADR 0048): the person's drives and their own and
// their children's seats, coming ones by time; a child's seat that waits for
// a guardian (the only child with that driver, the rule of two) is shown
// first with the driver's name and confirmed here. Cache first: the cached
// list shows at once.
import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/shared";
import { router } from "expo-router";
import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { useConfirmCarpoolSeat, useMyCarpools, useMyClubs } from "../../../api/queries.ts";
import { DataAge } from "../../../components/data-age.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { RoleBadge } from "../../../components/role-badge.tsx";
import {
  Body,
  Button,
  EmptyState,
  Loading,
  Muted,
  Row,
  Screen,
  Section,
} from "../../../components/ui.tsx";
import { useTheme } from "../../../theme.ts";

export default function MyCarpools() {
  const t = useTranslations();
  const format = useFormatter();
  const theme = useTheme();
  const list = useMyCarpools();
  const confirm = useConfirmCarpoolSeat();
  const clubs = useMyClubs();
  const zone = new Map((clubs.data?.clubs ?? []).map((c) => [c.club.id, c.club.timeZone]));
  if (!list.data) {
    if (list.isError)
      return (
        <Screen>
          <ErrorView error={list.error} onRetry={() => void list.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const items = list.data.items;
  return (
    <Screen
      refreshing={list.isRefetching}
      onRefresh={() => void list.refetch()}
      testID="carpools-screen"
    >
      <DataAge updatedAt={list.dataUpdatedAt} />
      <Muted>{t("carpool.mineIntro")}</Muted>
      <Section title={t("carpool.mine")}>
        {items.length === 0 ? (
          <EmptyState title={t("carpool.mineEmpty")} />
        ) : (
          items.map((item, index) => {
            const waiting = item.status === "pending_guardian" && item.bookingId !== null;
            return (
              <Row
                key={`${item.offerId}-${item.bookingId ?? "drive"}`}
                last={index === items.length - 1}
                onPress={() => router.push(`/activities/${item.activityId}`)}
                accessibilityLabel={item.activityTitle}
                testID="my-carpool"
              >
                <Body style={{ fontWeight: "600" }}>{item.activityTitle}</Body>
                <Muted>
                  {[
                    item.clubName,
                    format.dateTime(new Date(item.startsAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: zone.get(item.clubId) ?? "UTC",
                    }),
                    t(enumKey("carpool.directions", item.direction)),
                  ].join(" · ")}
                </Muted>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(1) }}>
                  {item.driving ? <RoleBadge label={t("carpool.youDrive")} /> : null}
                  {item.passenger ? (
                    <Body>
                      {personLabel(item.passenger)}
                      {item.driver
                        ? ` · ${t("carpool.withDriver", { driver: personLabel(item.driver) })}`
                        : ""}
                    </Body>
                  ) : null}
                  {waiting ? <RoleBadge tone="accent" label={t("carpool.pending")} /> : null}
                </View>
                {waiting && item.passenger && item.driver ? (
                  <>
                    <Body>
                      {t("carpool.confirmText", {
                        child: personLabel(item.passenger),
                        driver: personLabel(item.driver),
                      })}
                    </Body>
                    <Button
                      label={t("carpool.confirmButton")}
                      busy={confirm.isPending && confirm.variables === item.bookingId}
                      onPress={() => confirm.mutate(item.bookingId!)}
                      testID={`carpool-confirm-${item.bookingId}`}
                    />
                  </>
                ) : null}
              </Row>
            );
          })
        )}
      </Section>
    </Screen>
  );
}
