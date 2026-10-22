// SPDX-License-Identifier: AGPL-3.0-only
// Unknown deep links and routes.

import { router } from "expo-router";
import { useTranslations } from "use-intl";

import { Button, EmptyState, Screen } from "../components/ui.tsx";

export default function NotFound() {
  const t = useTranslations();
  return (
    <Screen>
      <EmptyState title={t("errors.notFound.title")} body={t("errors.notFound.text")} />
      <Button label={t("common.backHome")} onPress={() => router.replace("/")} kind="secondary" />
    </Screen>
  );
}
