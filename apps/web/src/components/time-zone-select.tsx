// SPDX-License-Identifier: AGPL-3.0-only
// A time zone select (P1.6b): the IANA zones as Intl lists them, grouped by
// region, with the city in the viewer's language where Intl names it, and
// optionally "The club's time zone" (empty value) first. A native select:
// typing jumps to a zone.
import { getLocale, getTranslations } from "next-intl/server";

import { inputClass } from "./action-form.tsx";

/** The zones by region ("Europe" → ["Europe/Oslo", ...]); UTC under "Etc". */
function zonesByRegion(): Map<string, string[]> {
  const zones = Intl.supportedValuesOf("timeZone");
  const regions = new Map<string, string[]>();
  for (const zone of zones.includes("UTC") ? zones : [...zones, "UTC"]) {
    const region = zone.includes("/") ? zone.slice(0, zone.indexOf("/")) : "Etc";
    regions.set(region, [...(regions.get(region) ?? []), zone]);
  }
  return regions;
}

/** "Stockholm (CET)": the city and the zone's short name in the viewer's language. */
function zoneLabel(zone: string, locale: string): string {
  const city = (zone.split("/").pop() ?? zone).replaceAll("_", " ");
  const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "shortGeneric" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;
  return name && name !== city ? `${city} (${name})` : city;
}

export async function TimeZoneSelect({
  id,
  name,
  value,
  clubOption,
  required,
  testId,
}: {
  id: string;
  name: string;
  value: string | null;
  /** The label of the empty choice ("The club's time zone"); none when required. */
  clubOption?: string;
  required?: boolean;
  testId?: string;
}) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const regions = zonesByRegion();
  return (
    <select
      id={id}
      name={name}
      defaultValue={value ?? ""}
      required={required}
      className={inputClass}
      data-testid={testId}
    >
      {clubOption ? <option value="">{clubOption}</option> : null}
      {[...regions].map(([region, zones]) => (
        <optgroup key={region} label={region === "Etc" ? t("timeZones.other") : region}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zoneLabel(zone, locale)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
