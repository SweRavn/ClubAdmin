// SPDX-License-Identifier: AGPL-3.0-only
// Start: My schedule (from the cache) when logged in, else the login screen.

import { Redirect } from "expo-router";
import { useTranslations } from "use-intl";

import { Loading } from "../components/ui.tsx";
import { useSession } from "../state/session.tsx";

export default function Index() {
  const { status } = useSession();
  const t = useTranslations("common");
  if (status === "starting") return <Loading label={t("loading")} />;
  return <Redirect href={status === "signedIn" ? "/schedule" : "/login"} />;
}
