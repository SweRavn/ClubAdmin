// SPDX-License-Identifier: AGPL-3.0-only
// A club's plugins (P2.7 part C, ADR 0051): the plugins for the club's
// country, on or off, their settings as the manifest declares them (text,
// number, yes/no, choice) and their secrets by name (a value is never shown;
// an empty field keeps it). Needs club.plugins.manage with a second factor;
// without one the page says so. What each plugin is given (its declared
// data) and which hosts it calls are shown before it is turned on.
import { enumKey } from "@clubadmin/i18n";
import type { ClubPlugin } from "@clubadmin/shared";
import { forbidden } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { pluginName } from "../../../../../components/plugins.ts";
import { getClub, getClubPlugins, getMyClubs } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("plugins.title") };
}

export default async function PluginsPage({ params, searchParams }: Props) {
  const [{ clubId }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations(),
    getLocale(),
  ]);
  const [club, mine, plugins] = await Promise.all([
    getClub(clubId),
    getMyClubs(),
    getClubPlugins(clubId, locale),
  ]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.plugins.manage")) forbidden();
  return (
    <div className="space-y-6" data-testid="plugins-page">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("plugins.title")}</h1>
        <p className="text-muted">{t("plugins.intro")}</p>
      </div>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("plugins.saved")}</Notice> : null}
      {plugins.error ? <FormError code={plugins.error} /> : null}
      {plugins.page && plugins.page.items.length === 0 ? <p>{t("plugins.none")}</p> : null}
      {plugins.page?.items.map((p) => (
        <PluginCard key={p.id} plugin={p} clubId={club.id} />
      ))}
      {permissions.includes("club.grants.read") ? (
        <a href={`/clubs/${club.id}/grants`} className="text-accent underline">
          {t("grants.title")}
        </a>
      ) : null}
    </div>
  );
}

async function PluginCard({ plugin, clubId }: { plugin: ClubPlugin; clubId: string }) {
  const t = await getTranslations();
  const label = (key: string) => plugin.texts[key] ?? key;
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-raised p-4"
      data-testid={`plugin-${plugin.id}`}
      aria-labelledby={`plugin-${plugin.id}-name`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 id={`plugin-${plugin.id}-name`} className="text-lg font-semibold">
          {pluginName(plugin)}
        </h2>
        <span
          className={`rounded px-2 text-xs ${plugin.enabled ? "bg-accent-soft" : "bg-muted/20"}`}
        >
          {plugin.enabled ? t("plugins.on") : t("plugins.off")}
        </span>
        <span className="text-sm text-muted">
          {plugin.id} {plugin.version} · {plugin.publisher}
        </span>
      </div>
      <p className="text-sm">
        {plugin.capabilities.map((c) => t(enumKey("plugins.capabilities", c))).join(", ")}
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer">{t("plugins.dataTitle")}</summary>
        <ul className="mt-1 list-disc pl-5">
          {plugin.data.map((d) => (
            <li key={d}>{t(enumKey("plugins.dataFields", d))}</li>
          ))}
        </ul>
        <p className="mt-1">
          {plugin.network.length > 0
            ? t("plugins.network", { hosts: plugin.network.join(", ") })
            : t("plugins.noNetwork")}
        </p>
      </details>
      <ActionForm
        action="club-plugin-save"
        className="space-y-3"
        testId={`plugin-form-${plugin.id}`}
      >
        <input type="hidden" name="clubId" value={clubId} />
        <input type="hidden" name="pluginId" value={plugin.id} />
        <input
          type="hidden"
          name="configKeys"
          value={plugin.configFields.map((f) => `${f.key}:${f.type}`).join(",")}
        />
        <input
          type="hidden"
          name="secretNames"
          value={plugin.secrets.map((s) => s.name).join(",")}
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={plugin.enabled}
            data-testid={`plugin-enabled-${plugin.id}`}
          />
          <span>{t("plugins.enable")}</span>
        </label>
        {plugin.configFields.map((f) => {
          const name = `config.${f.key}`;
          const value = plugin.config[f.key];
          if (f.type === "boolean") {
            return (
              <label key={f.key} className="flex items-center gap-2">
                <input type="checkbox" name={name} defaultChecked={value === true} />
                <span>{label(f.label)}</span>
              </label>
            );
          }
          return (
            <label key={f.key} className="block space-y-1">
              <span className="text-sm">
                {label(f.label)}
                {f.required ? " *" : ""}
              </span>
              {f.type === "choice" ? (
                <select name={name} className={inputClass} defaultValue={String(value ?? "")}>
                  {f.required ? null : <option value="">–</option>}
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {label(o)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={name}
                  type={f.type === "number" ? "number" : "text"}
                  defaultValue={value === undefined ? "" : String(value)}
                  required={f.required}
                  maxLength={f.maxLength}
                  pattern={f.pattern}
                  className={inputClass}
                />
              )}
            </label>
          );
        })}
        {plugin.secrets.map((s) => (
          <div key={s.name} className="space-y-1">
            <label className="block space-y-1">
              <span className="text-sm">
                {label(s.name)} ({s.set ? t("plugins.secretSet") : t("plugins.secretNotSet")})
              </span>
              <input
                name={`secret.${s.name}`}
                type="password"
                autoComplete="off"
                className={inputClass}
                placeholder={s.set ? t("plugins.secretKeep") : ""}
              />
            </label>
            {s.set ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={`secretRemove.${s.name}`} />
                <span>{t("plugins.secretRemove")}</span>
              </label>
            ) : null}
          </div>
        ))}
        <button type="submit" className={buttonClass} data-testid={`plugin-save-${plugin.id}`}>
          {t("plugins.save")}
        </button>
      </ActionForm>
    </section>
  );
}
