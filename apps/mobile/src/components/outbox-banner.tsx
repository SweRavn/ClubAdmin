// SPDX-License-Identifier: AGPL-3.0-only
// The outbox's state (P1.5): how many changes wait for coverage, and the
// ones the server refused, with the reason, until dismissed.
import { enumKey } from "@clubadmin/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { dismissOutboxFailures, useOutboxFailures, usePendingWrites } from "../api/outbox.ts";
import { Banner, LinkButton } from "./ui.tsx";

export function OutboxBanner() {
  const t = useTranslations();
  const client = useQueryClient();
  const pending = usePendingWrites();
  const failures = useOutboxFailures().data;
  return (
    <>
      {pending.length > 0 ? (
        <Banner testID="outbox-pending">
          {t("mobile.outboxWaiting", { count: pending.length })}
        </Banner>
      ) : null}
      {failures.length > 0 ? (
        <Banner
          tone="warning"
          testID="outbox-failed"
          action={
            <LinkButton
              label={t("mobile.outboxDismiss")}
              onPress={() => dismissOutboxFailures(client)}
              testID="outbox-dismiss"
            />
          }
        >
          {[
            t("mobile.outboxFailed", { count: failures.length }),
            ...[...new Set(failures.map((f) => f.code))].map((code) => {
              const key = enumKey("joinErrors", code);
              return key === "common.other" ? t("joinErrors.failed") : t(key);
            }),
          ].join(" ")}
        </Banner>
      ) : null}
    </>
  );
}
