// SPDX-License-Identifier: AGPL-3.0-only
// The translated error of a joining action (?error=<detail code>).
import { enumKey } from "@clubadmin/i18n";
import { getTranslations } from "next-intl/server";

import { webConfig } from "../server/config.ts";
import { currentPath } from "../server/data.ts";

export async function FormError({ code }: { code: string | string[] | undefined }) {
  if (typeof code !== "string" || code === "") return null;
  const t = await getTranslations();
  const key = enumKey("joinErrors", code);
  // Development (DEV_AUTH, P1.6b): how to log in with the second factor.
  const devMfa = code === "mfa_required" && webConfig().DEV_AUTH;
  const back = devMfa ? new URL(await currentPath(), "https://internal.invalid") : null;
  back?.searchParams.delete("error");
  return (
    <p role="alert" className="rounded-md bg-protected-soft px-3 py-2" data-testid="form-error">
      {key === "common.other" ? t("joinErrors.failed") : t(key)}
      {back ? (
        <span className="mt-1 block text-sm" data-testid="dev-mfa-hint">
          {t("joinErrors.devMfaHint")}{" "}
          <a
            href={`/login?mfa=1&returnTo=${encodeURIComponent(`${back.pathname}${back.search}`)}`}
            className="underline"
          >
            {t("joinErrors.devMfaLink")}
          </a>
        </span>
      ) : null}
    </p>
  );
}

export function Notice({ children }: { children: string }) {
  return (
    <p role="status" className="rounded-md bg-accent-soft px-3 py-2" data-testid="notice">
      {children}
    </p>
  );
}
