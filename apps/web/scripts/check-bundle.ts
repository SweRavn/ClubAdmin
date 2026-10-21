// SPDX-License-Identifier: AGPL-3.0-only
// Budget check (docs/performance.md): the JavaScript a member page loads
// initially, compressed, must stay under 150 KB. Reads each page's HTML from
// the running production build, collects every script it makes the browser
// load (script tags, and the client-component chunks named in the inline RSC
// payload, which the runtime loads before hydrating) and sums their gzip
// size: what the reverse proxy serves (Caddy compresses with zstd or gzip,
// which come out about the same). Inline scripts count too; `nomodule`
// polyfills do not (modern browsers skip them).
//
//   node apps/web/scripts/check-bundle.ts <baseUrl> "<cookie header>" <path>...

import { gzipSync } from "node:zlib";

export const BUDGET_BYTES = 150 * 1024;

const compressed = (text: string) => gzipSync(Buffer.from(text), { level: 6 }).length;

export async function initialJavaScript(
  baseUrl: string,
  cookie: string,
  path: string,
): Promise<{ files: Map<string, number>; inline: number }> {
  const get = async (url: string) => {
    const res = await fetch(new URL(url, baseUrl), { headers: { cookie }, redirect: "manual" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.text();
  };
  const html = await get(path);
  const skipped = new Set(
    [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*\bnomodule\b/gi)].map((m) => m[1]!),
  );
  const sources = new Set<string>();
  // The RSC payload names chunks without the /_next/ prefix.
  for (const match of html.matchAll(/(?:\/_next\/)?static\/chunks\/[A-Za-z0-9._~%()/-]+?\.js/g)) {
    const src = match[0].startsWith("/_next/") ? match[0] : `/_next/${match[0]}`;
    if (!skipped.has(src)) sources.add(src);
  }
  const files = new Map<string, number>();
  for (const src of sources) files.set(src, compressed(await get(src)));
  const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .join("\n");
  return { files, inline: compressed(inline) };
}

if (import.meta.main) {
  const [baseUrl, cookie, ...paths] = process.argv.slice(2);
  if (!baseUrl || cookie === undefined || paths.length === 0) {
    throw new Error('usage: check-bundle.ts <baseUrl> "<cookie>" <path>...');
  }
  let failed = false;
  for (const path of paths) {
    const { files, inline } = await initialJavaScript(baseUrl, cookie, path);
    const total = [...files.values()].reduce((a, b) => a + b, 0) + inline;
    const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
    console.log(
      `${path}: ${kb(total)} (${files.size} files, inline ${kb(inline)}) of ${kb(BUDGET_BYTES)}`,
    );
    for (const [file, size] of [...files].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`  ${kb(size).padStart(9)}  ${file}`);
    }
    if (total > BUDGET_BYTES) failed = true;
  }
  if (failed) {
    console.error("Initial JavaScript over budget (docs/performance.md).");
    process.exit(1);
  }
}
