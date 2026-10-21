// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

import { translator } from "./i18n.ts";

export async function generateMetadata() {
  const { t } = await translator();
  return { title: t("web.title") };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale } = await translator();
  return (
    <html lang={locale}>
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: "40rem",
          margin: "3rem auto",
          padding: "0 1rem",
        }}
      >
        {children}
      </body>
    </html>
  );
}
