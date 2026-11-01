// SPDX-License-Identifier: AGPL-3.0-only
// Banners above every signed-in screen: offline (with the age of the shown
// data), "viewing as" a ward, a planned account deletion (P1.8b) and an
// available update.

import { personLabel } from "@clubadmin/shared";
import { onlineManager, useIsRestoring } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useFormatter, useTranslations } from "use-intl";

import { useAccountDeletion, useMe, useMyWards } from "../api/queries.ts";
import { useSession } from "../state/session.tsx";
import { UpdateNotice } from "./gates.tsx";
import { Banner, LinkButton } from "./ui.tsx";

export function useOnline(): boolean {
  return useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
  );
}

export function OfflineBanner() {
  const t = useTranslations("mobile");
  const online = useOnline();
  const restoring = useIsRestoring();
  if (online || restoring) return null;
  return (
    <Banner tone="warning" testID="offline-banner">
      {t("offline")}
    </Banner>
  );
}

export function ViewingAsBanner() {
  const t = useTranslations("viewingAs");
  const { viewingAs, setViewingAs } = useSession();
  const wards = useMyWards();
  if (!viewingAs) return null;
  const ward = wards.data?.wards.find((w) => w.person.id === viewingAs);
  if (!ward) return null;
  const name = personLabel(ward.person);
  return (
    <Banner
      testID="viewing-as-banner"
      action={
        <LinkButton label={t("stop")} onPress={() => setViewingAs(null)} testID="viewing-as-stop" />
      }
    >
      {t("banner", { name })}
    </Banner>
  );
}

export function DeletionBanner() {
  const t = useTranslations("privacy.deletion");
  const format = useFormatter();
  const me = useMe();
  const { cancel } = useAccountDeletion();
  const scheduledFor = me.data?.pendingDeletion?.scheduledFor;
  if (!scheduledFor) return null;
  return (
    <Banner
      tone="warning"
      testID="deletion-banner"
      action={
        <LinkButton
          label={t("bannerCancel")}
          onPress={() => cancel.mutate()}
          testID="banner-cancel-deletion"
        />
      }
    >
      {t("banner", { date: format.dateTime(new Date(scheduledFor), { dateStyle: "long" }) })}
    </Banner>
  );
}

export function Banners() {
  return (
    <>
      <OfflineBanner />
      <ViewingAsBanner />
      <DeletionBanner />
      <UpdateNotice />
    </>
  );
}
