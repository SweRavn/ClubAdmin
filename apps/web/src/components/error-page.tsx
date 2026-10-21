// SPDX-License-Identifier: AGPL-3.0-only
import { getTranslations } from "next-intl/server";

export async function ErrorPage({
  title,
  text,
  testId,
}: {
  title: string;
  text: string;
  testId: string;
}) {
  const t = await getTranslations();
  return (
    <main
      id="main"
      className="mx-auto w-full max-w-xl flex-1 space-y-4 px-4 py-16 text-center"
      data-testid={testId}
    >
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-muted">{text}</p>
      <p>
        <a href="/" className="text-accent underline">
          {t("common.backHome")}
        </a>
      </p>
    </main>
  );
}
