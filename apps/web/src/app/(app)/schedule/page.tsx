// SPDX-License-Identifier: AGPL-3.0-only
// "Mitt schema" is on Home since P2.7d: links and bookmarks to /schedule
// (with their week and person) still work.
import { redirect } from "next/navigation";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SchedulePage({ searchParams }: Props) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value);
  }
  const qs = query.toString();
  redirect(qs ? `/?${qs}` : "/");
}
