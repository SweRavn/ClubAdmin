// SPDX-License-Identifier: AGPL-3.0-only
// A point in time in the club's (or the viewer's) time zone, with the
// viewer's own zone added when it differs, as on the web.

import { Text, type TextStyle } from "react-native";
import { useFormatter, useTimeZone } from "use-intl";

import { useTheme } from "../theme.ts";

export function DateTime({
  value,
  timeZone,
  style,
}: {
  value: string | Date;
  /** The zone the time belongs to, e.g. the club's; defaults to the viewer's. */
  timeZone?: string;
  style?: TextStyle;
}) {
  const format = useFormatter();
  const viewerZone = useTimeZone() ?? "UTC";
  const theme = useTheme();
  const date = typeof value === "string" ? new Date(value) : value;
  const zone = timeZone ?? viewerZone;
  const main = format.dateTime(date, { dateStyle: "medium", timeStyle: "short", timeZone: zone });
  const own =
    zone !== viewerZone
      ? format.dateTime(date, { timeStyle: "short", timeZone: viewerZone, timeZoneName: "short" })
      : null;
  return (
    <Text style={[{ color: theme.colors.fg }, style]}>
      {main}
      {own ? <Text style={{ color: theme.colors.muted }}>{` (${own})`}</Text> : null}
    </Text>
  );
}
