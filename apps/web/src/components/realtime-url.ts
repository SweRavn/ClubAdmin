// SPDX-License-Identifier: AGPL-3.0-only
// The real-time connection of the web app goes to the page's own host
// (P2.7b): the reverse proxy forwards `/api/v1/realtime` there to the API,
// so the browser needs no second certificate, host or CORS origin for it.
// The ticket's URL names the API's host (for the mobile app); only its
// path and ticket are kept.

export function sameOriginRealtimeUrl(ticketUrl: string, location: Location): string {
  const url = new URL(ticketUrl);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.host = location.host;
  return url.toString();
}
