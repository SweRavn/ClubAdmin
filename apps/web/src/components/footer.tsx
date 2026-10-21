// SPDX-License-Identifier: AGPL-3.0-only
// AGPL-3.0 section 13: every page links to the exact source of the running
// version (docs/licensing.md).

import { getTranslations } from "next-intl/server";

import { getSource, getVersion } from "../server/data.ts";

export async function Footer() {
  const [t, source, version] = await Promise.all([getTranslations(), getSource(), getVersion()]);
  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-4 text-sm text-muted">
        <a
          href={source?.url ?? "/api/v1/meta/source"}
          className="text-accent underline"
          data-testid="source-link"
          rel="noopener"
        >
          {t("footer.source")}
        </a>
        {version ? (
          <span data-testid="version">
            {t("footer.version", { version: `${version.version} (${version.commit})` })}
          </span>
        ) : null}
        <span>{t("footer.licence")}</span>
      </div>
    </footer>
  );
}
