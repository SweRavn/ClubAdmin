// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Unexpected errors inside the app frame. Production hides the message; the
// digest identifies the error in the server logs.

import { useClientTexts } from "../../components/client-texts.tsx";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const texts = useClientTexts();
  return (
    <div role="alert" className="mx-auto max-w-xl space-y-4 py-12 text-center" data-testid="error">
      <h1 className="text-2xl font-semibold">{texts.errorTitle}</h1>
      <p className="text-muted">{texts.errorText}</p>
      {error.digest ? (
        <p className="font-mono text-sm">{texts.errorReference.replace("{id}", error.digest)}</p>
      ) : null}
      <button type="button" onClick={reset} className="rounded-md border border-border px-3 py-1.5">
        {texts.retry}
      </button>
    </div>
  );
}
