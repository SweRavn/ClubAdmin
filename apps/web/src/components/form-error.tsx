// SPDX-License-Identifier: AGPL-3.0-only
// The translated error of a joining action (?error=<detail code>).
import { enumKey } from "@clubadmin/i18n";
import { getTranslations } from "next-intl/server";

export async function FormError({ code }: { code: string | string[] | undefined }) {
  if (typeof code !== "string" || code === "") return null;
  const t = await getTranslations();
  const key = enumKey("joinErrors", code);
  return (
    <p role="alert" className="rounded-md bg-protected-soft px-3 py-2" data-testid="form-error">
      {key === "common.other" ? t("joinErrors.failed") : t(key)}
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
