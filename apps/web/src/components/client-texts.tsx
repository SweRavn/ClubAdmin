// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Translated texts for client components that cannot get them as props (the
// error boundary). Keeps next-intl's client runtime and the catalogues out
// of the browser bundle (docs/performance.md): the server translates.

import { createContext, type ReactNode, useContext } from "react";

export interface ClientTexts {
  errorTitle: string;
  errorText: string;
  /** Contains "{id}". */
  errorReference: string;
  retry: string;
}

const Context = createContext<ClientTexts | null>(null);

export function ClientTextsProvider({
  texts,
  children,
}: {
  texts: ClientTexts;
  children: ReactNode;
}) {
  return <Context.Provider value={texts}>{children}</Context.Provider>;
}

export function useClientTexts(): ClientTexts {
  const texts = useContext(Context);
  if (!texts) throw new Error("ClientTextsProvider missing");
  return texts;
}
