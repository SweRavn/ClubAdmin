// SPDX-License-Identifier: AGPL-3.0-only
// 403: the person is related to the club but lacks the permission.

import { getTranslations } from "next-intl/server";

import { ErrorPage } from "../components/error-page.tsx";

export default async function Forbidden() {
  const t = await getTranslations();
  return (
    <ErrorPage
      testId="forbidden"
      title={t("errors.forbidden.title")}
      text={t("errors.forbidden.text")}
    />
  );
}
