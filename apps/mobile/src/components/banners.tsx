// SPDX-License-Identifier: AGPL-3.0-only
// Banners above every signed-in screen: offline (with the age of the shown
// data), "viewing as" a ward, a planned account deletion (P1.8b) and an
// available update.

import { personLabel } from "@clubadmin/shared";
import { onlineManager, useIsRestoring } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useFormatter, useTranslations } from "use-intl";

import {
  useAccountDeletion,
  useEntitlements,
  useMe,
  useMyClubs,
  useMyWards,
} from "../api/queries.ts";
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

/**
 * The club's billing notice (P1.13), text only: no plans, prices or payment
 * in the app (store rules). Read-only for everyone; a payment overdue for
 * club managers and treasurers, who are told to use the web. Nothing with
 * billing off.
 */
export function BillingNotice({ clubId }: { clubId: string }) {
  const t = useTranslations("mobile.billing");
  const entitlements = useEntitlements(clubId);
  const clubs = useMyClubs();
  const e = entitlements.data;
  if (!e?.billingEnabled) return null;
  const permissions = clubs.data?.clubs.find((c) => c.club.id === clubId)?.permissions ?? [];
  const payer = permissions.includes("billing.invoices.read");
  if (e.accessState === "read_only") {
    return (
      <Banner tone="warning" testID="billing-read-only">
        {e.accessStateSource === "billing"
          ? `${t("readOnly")} ${payer ? t("payOnWeb") : t("contactManager")}`
          : t("readOnlyOperator")}
      </Banner>
    );
  }
  if (e.subscriptionStatus === "past_due" && payer) {
    return (
      <Banner tone="warning" testID="billing-past-due">
        {`${t("pastDue")} ${t("payOnWeb")}`}
      </Banner>
    );
  }
  return null;
}
