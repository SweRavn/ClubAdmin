// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Tells the server the browser's time zone (a cookie), the last fallback for
// showing times when neither the account nor the club has one.

import { useEffect } from "react";

const COOKIE = "ca-tz";

export function BrowserTimeZone() {
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const current = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (zone && decodeURIComponent(current ?? "") !== zone) {
      document.cookie = `${COOKIE}=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax; secure`;
    }
  }, []);
  return null;
}
