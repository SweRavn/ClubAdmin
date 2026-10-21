// SPDX-License-Identifier: AGPL-3.0-only
// Content Security Policy and other security headers (docs/security.md,
// "Application hardening"). Pages get a fresh nonce per request from the
// proxy (src/proxy.ts); Next.js puts it on its own scripts. No inline
// scripts or styles without the nonce, no eval (except `next dev`), no
// framing, and Trusted Types for DOM script sinks (production; `next dev`
// evaluates code for hot reloading, which Trusted Types would block).

export interface CspOptions {
  nonce: string;
  /**
   * `next dev` only: eval and inline styles for React's error overlay and hot
   * reloading. Production never has them (tested against the production build).
   */
  development: boolean;
  /** Origins forms may submit or redirect to besides this site (the identity provider's logout). */
  formActions: readonly string[];
}

export function contentSecurityPolicy({ nonce, development, formActions }: CspOptions): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(development ? ["'unsafe-eval'"] : []),
    ],
    // `next dev` injects its error overlay's styles without a nonce.
    "style-src": ["'self'", ...(development ? ["'unsafe-inline'"] : [`'nonce-${nonce}'`])],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...(development ? ["ws:", "wss:"] : [])],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'", ...formActions],
    "frame-ancestors": ["'none'"],
    "manifest-src": ["'self'"],
    "worker-src": ["'self'"],
    "upgrade-insecure-requests": [],
  };
  if (!development) {
    // DOM script sinks (innerHTML, script.src, eval) only through these
    // policies: Next.js and its bundler's chunk loader.
    directives["require-trusted-types-for"] = ["'script'"];
    directives["trusted-types"] = ["nextjs", "nextjs#bundler", "'allow-duplicates'"];
  }
  return Object.entries(directives)
    .map(([name, values]) => [name, ...values].join(" "))
    .join("; ");
}

/** Headers on every response (also static files and route handlers). */
export const SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

/** A random nonce (128 bits, base64). */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}
