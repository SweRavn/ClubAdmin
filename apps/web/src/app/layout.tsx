// SPDX-License-Identifier: AGPL-3.0-only
import "./globals.css";
import "../i18n/types.ts";

import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { BrowserTimeZone } from "../components/browser-time-zone.tsx";
import { ClientTextsProvider } from "../components/client-texts.tsx";
import { Footer } from "../components/footer.tsx";
import { getMe, getSession } from "../server/data.ts";

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: { default: t("common.appName"), template: `%s · ${t("common.appName")}` } };
}

async function theme(): Promise<"light" | "dark" | undefined> {
  if (!(await getSession())) return undefined;
  try {
    const preference = (await getMe()).preferences.theme;
    return preference === "light" || preference === "dark" ? preference : undefined;
  } catch {
    return undefined;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, t, dataTheme] = await Promise.all([getLocale(), getTranslations(), theme()]);
  // Client components get translated texts from the server, never the
  // catalogues (they stay out of the browser bundle).
  const texts = {
    errorTitle: t("errors.generic.title"),
    errorText: t("errors.generic.text"),
    errorReference: t.raw("errors.reference") as string,
    retry: t("common.retry"),
  };
  return (
    <html lang={locale} data-theme={dataTheme}>
      <body className="flex min-h-dvh flex-col bg-bg text-fg antialiased">
        <a
          href="#main"
          className="sr-only rounded-md bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
        >
          {t("common.skipToContent")}
        </a>
        <ClientTextsProvider texts={texts}>{children}</ClientTextsProvider>
        <Footer />
        <BrowserTimeZone />
      </body>
    </html>
  );
}
