// SPDX-License-Identifier: AGPL-3.0-only
// Runs once when the server starts: refuses DEV_AUTH outside development and
// validates the configuration before the first request.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ webConfig }, { DEV_AUTH_WARNING }] = await Promise.all([
    import("./server/config.ts"),
    import("@clubadmin/shared"),
  ]);
  // Throws (and the server does not start) on invalid settings, e.g. DEV_AUTH in production.
  const config = webConfig();
  if (config.DEV_AUTH) console.warn(DEV_AUTH_WARNING);
}
