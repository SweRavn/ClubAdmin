// SPDX-License-Identifier: AGPL-3.0-only
// Errors as the API describes them (RFC 9457 problem types): not found for
// cross-club links and people one may not see, forbidden for a missing
// permission, a hint for actions that need a second factor (step-up on
// mobile comes later), and the problem's translated title for types this
// app version does not know (ADR 0029).

import { ApiError } from "@clubadmin/api-client";
import { useTranslations } from "use-intl";

import { Button, EmptyState } from "./ui.tsx";

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTranslations();
  if (error instanceof ApiError) {
    switch (error.type) {
      case "not-found":
        return <EmptyState title={t("errors.notFound.title")} body={t("errors.notFound.text")} />;
      case "forbidden":
        return <EmptyState title={t("errors.forbidden.title")} body={t("errors.forbidden.text")} />;
      case "mfa-required":
      case "reauthentication-required":
        return <EmptyState title={t("mobile.stepUpTitle")} body={t("mobile.stepUpBody")} />;
      case "rate-limited":
        return <EmptyState title={t("problem.rate-limited")} />;
      default:
        if (error.problem?.title) return <EmptyState title={error.problem.title} />;
    }
  }
  return (
    <>
      <EmptyState title={t("mobile.loadFailed")} />
      {onRetry ? <Button label={t("common.retry")} onPress={onRetry} kind="secondary" /> : null}
    </>
  );
}
