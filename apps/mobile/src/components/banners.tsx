// SPDX-License-Identifier: AGPL-3.0-only
// Banners above every signed-in screen: offline (with the age of the shown
// data), "viewing as" a ward, and an available update.

import { personLabel } from "@clubadmin/shared";
import { onlineManager, useIsRestoring } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useTranslations } from "use-intl";

import { useMyWards } from "../api/queries.ts";
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

export function Banners() {
  return (
    <>
      <OfflineBanner />
      <ViewingAsBanner />
      <UpdateNotice />
    </>
  );
}
