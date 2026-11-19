// SPDX-License-Identifier: AGPL-3.0-only
// The installation's plugins (P2.7 part C, operators): each plugin's
// version, publisher, licence, contract version, regions, the data it is
// given and the hosts it calls. Incompatible plugins never get here: the API
// refuses to start with one.
import { enumKey } from "@clubadmin/i18n";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { getOpsPlugins } from "../../../../server/data.ts";

export async function generateMetadata() {
  return { title: (await getTranslations())("plugins.opsTitle") };
}

export default async function OpsPluginsPage() {
  const [t, plugins] = await Promise.all([getTranslations(), getOpsPlugins()]);
  if (!plugins) forbidden();
  return (
    <div className="space-y-4" data-testid="ops-plugins">
      <h1 className="text-2xl font-semibold">{t("plugins.opsTitle")}</h1>
      <p>{t("plugins.opsIntro", { version: plugins.pluginApi })}</p>
      {plugins.items.length === 0 ? <p>{t("plugins.none")}</p> : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="py-1 pr-3">{t("plugins.id")}</th>
            <th className="py-1 pr-3">{t("plugins.version")}</th>
            <th className="py-1 pr-3">{t("plugins.regions")}</th>
            <th className="py-1 pr-3">{t("plugins.capabilitiesTitle")}</th>
            <th className="py-1">{t("plugins.dataTitle")}</th>
          </tr>
        </thead>
        <tbody>
          {plugins.items.map((p) => (
            <tr key={p.id} className="border-b border-border align-top" data-testid="ops-plugin">
              <td className="py-1 pr-3">
                {p.id}
                <div className="text-muted">
                  {p.publisher} · {p.licence}
                </div>
              </td>
              <td className="py-1 pr-3">
                {p.version}
                <div className="text-muted">{t("plugins.contract", { range: p.pluginApi })}</div>
              </td>
              <td className="py-1 pr-3">{p.regions.join(", ")}</td>
              <td className="py-1 pr-3">
                {p.capabilities.map((c) => t(enumKey("plugins.capabilities", c))).join(", ")}
              </td>
              <td className="py-1">
                {p.data.map((d) => t(enumKey("plugins.dataFields", d))).join(", ")}
                {p.network.length > 0 ? (
                  <div className="text-muted">
                    {t("plugins.network", { hosts: p.network.join(", ") })}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
