// SPDX-License-Identifier: AGPL-3.0-only
// 404: also what a person sees for another club's pages or a person they
// may not see (the API answers 404, never revealing that it exists).

import { getTranslations } from "next-intl/server";

import { ErrorPage } from "../components/error-page.tsx";

export default async function NotFound() {
  const t = await getTranslations();
  return (
    <ErrorPage
      testId="not-found"
      title={t("errors.notFound.title")}
      text={t("errors.notFound.text")}
    />
  );
}
