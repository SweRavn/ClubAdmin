// SPDX-License-Identifier: AGPL-3.0-only
/** Returns `url` pointing at another database on the same server. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/** Returns `url` with other credentials. */
export function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

export function databaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (name === "") throw new Error("Database URL has no database name");
  return name;
}

/** For log messages: the URL without its password. */
export function redactUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = "***";
  return parsed.toString();
}
