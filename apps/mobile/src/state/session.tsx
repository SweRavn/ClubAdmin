// SPDX-License-Identifier: AGPL-3.0-only
// The login, the API client and the per-account query cache. On start a
// stored login is restored and its encrypted cache opened, so the last
// screens render before any request (offline too). Logging out, a refused
// refresh token or another account logging in wipes tokens, the cache and
// its key.

import type { ApiClient } from "@clubadmin/api-client";
import { ID_TOKEN_HEADER } from "@clubadmin/shared";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import * as Application from "expo-application";
import * as Device from "expo-device";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";

import { createAppApiClient } from "../api/client.ts";
import { registerOutbox } from "../api/outbox.ts";
import { createQueryClient } from "../api/query-client.ts";
import { fetchDevTokens } from "../auth/dev-login.ts";
import { refreshWithZitadel, signInWithZitadel, signOutOfZitadel } from "../auth/oidc.ts";
import { secureStorage } from "../auth/secure-storage.ts";
import { TokenManager, type TokenSet } from "../auth/tokens.ts";
import {
  CACHE_SCHEMA_VERSION,
  type KeyValueStorage,
  openAccountCache,
  wipeAccountCache,
} from "../cache/account-cache.ts";
import { appSettings } from "../cache/settings.ts";
import { APP_VERSION, appConfig } from "../config.ts";

export type SessionStatus = "starting" | "signedOut" | "signedIn";

export interface Session {
  status: SessionStatus;
  personId: string | null;
  api: ApiClient;
  /** The ward a guardian is viewing as (X-On-Behalf-Of), or null. */
  viewingAs: string | null;
  setViewingAs: (wardId: string | null) => void;
  signIn: () => Promise<"success" | "cancelled">;
  signInAsPersona: (personId: string, mfa: boolean) => Promise<void>;
  signOut: () => Promise<void>;
  /** Preferred languages for API calls (set by the locale provider). */
  setAcceptLanguage: (value: string) => void;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside SessionProvider");
  return session;
}

const deviceName = () =>
  [
    Device.modelName,
    Device.osName && Device.osVersion ? `(${Device.osName} ${Device.osVersion})` : "",
  ]
    .filter(Boolean)
    .join(" ");

export function SessionProvider({ children }: { children: ReactNode }) {
  const tokens = useMemo(
    () =>
      new TokenManager(secureStorage, {
        refresh: refreshWithZitadel,
        devTokens: fetchDevTokens,
      }),
    [],
  );
  const [status, setStatus] = useState<SessionStatus>("starting");
  const [personId, setPersonId] = useState<string | null>(null);
  const [cache, setCache] = useState<{ personId: string; storage: KeyValueStorage } | null>(null);
  const [viewingAs, setViewingAsState] = useState<string | null>(null);
  const viewingAsRef = useRef<string | null>(null);
  const acceptLanguageRef = useRef("en");

  const api = useMemo(
    () =>
      createAppApiClient(appConfig.apiUrl, {
        tokens: async (): Promise<TokenSet | null> => (tokens.signedIn ? tokens.current() : null),
        renew: () => tokens.renew(),
        // Revoked elsewhere (/me/sessions): forget the login; onLoginEnded wipes the cache.
        loginEnded: () => void tokens.end(),
        onBehalfOf: () => viewingAsRef.current,
        acceptLanguage: () => acceptLanguageRef.current,
        client: {
          platform: Platform.OS,
          version: Application.nativeApplicationVersion ?? APP_VERSION,
          device: deviceName(),
        },
      }),
    [tokens],
  );

  const enter = useCallback(async (id: string) => {
    setCache({ personId: id, storage: await openAccountCache(id, secureStorage) });
    const ward = appSettings.viewingAs(id);
    viewingAsRef.current = ward;
    setViewingAsState(ward);
    setPersonId(id);
    setStatus("signedIn");
  }, []);

  const leave = useCallback(async (id: string | null) => {
    if (id) {
      await wipeAccountCache(id, secureStorage);
      appSettings.forget(id);
    }
    viewingAsRef.current = null;
    setViewingAsState(null);
    setCache(null);
    setPersonId(null);
    setStatus("signedOut");
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const restored = await tokens.restore().catch(() => false);
      if (!active) return;
      if (restored && tokens.personId) await enter(tokens.personId);
      else setStatus("signedOut");
    })();
    // A refused refresh token (session revoked elsewhere) ends the login here too.
    const unsubscribe = tokens.onLoginEnded(() => {
      void leave(tokens.personId);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [tokens, enter, leave]);

  /** Who the tokens belong to: GET /me (also creates the account on the first login). */
  const whoAmI = useCallback(async (set: TokenSet): Promise<string> => {
    const res = await fetch(`${appConfig.apiUrl}/api/v1/me`, {
      headers: {
        authorization: `Bearer ${set.accessToken}`,
        ...(set.idToken ? { [ID_TOKEN_HEADER]: set.idToken } : {}),
        "accept-language": acceptLanguageRef.current,
      },
    });
    if (!res.ok) throw new Error(`me: HTTP ${res.status}`);
    const body = (await res.json()) as { personId: string };
    return body.personId;
  }, []);

  const switchTo = useCallback(
    async (id: string) => {
      // Another account than the last one: its cache must not survive.
      const previous = personId;
      if (previous && previous !== id) await wipeAccountCache(previous, secureStorage);
      await enter(id);
    },
    [personId, enter],
  );

  const signIn = useCallback(async () => {
    const result = await signInWithZitadel();
    if (result.kind === "cancelled") return "cancelled" as const;
    const id = await whoAmI(result.tokens);
    await tokens.signedInWith(
      {
        kind: "oidc",
        personId: id,
        refreshToken: result.refreshToken,
        idToken: result.tokens.idToken,
      },
      result.tokens,
    );
    await switchTo(id);
    return "success" as const;
  }, [tokens, whoAmI, switchTo]);

  const signInAsPersona = useCallback(
    async (id: string, mfa: boolean) => {
      const set = await fetchDevTokens(id, mfa);
      await whoAmI(set);
      await tokens.signedInWith({ kind: "dev", personId: id, mfa }, set);
      await switchTo(id);
    },
    [tokens, whoAmI, switchTo],
  );

  const signOut = useCallback(async () => {
    const id = tokens.personId;
    const kind = tokens.kind;
    const refreshToken = tokens.refreshToken;
    const idTokenHint = tokens.idTokenHint;
    await tokens.end();
    await leave(id);
    if (kind === "oidc") await signOutOfZitadel(refreshToken, idTokenHint);
  }, [tokens, leave]);

  const setViewingAs = useCallback(
    (wardId: string | null) => {
      viewingAsRef.current = wardId;
      setViewingAsState(wardId);
      if (personId) appSettings.setViewingAs(personId, wardId);
    },
    [personId],
  );

  const setAcceptLanguage = useCallback((value: string) => {
    acceptLanguageRef.current = value;
  }, []);

  const session: Session = {
    status,
    personId,
    api,
    viewingAs,
    setViewingAs,
    signIn,
    signInAsPersona,
    signOut,
    setAcceptLanguage,
  };

  return (
    <SessionContext.Provider value={session}>
      <QueryLayer key={cache?.personId ?? "signed-out"} cache={cache} api={api}>
        {children}
      </QueryLayer>
    </SessionContext.Provider>
  );
}

/** A fresh query client per account (keyed by person); persisted, encrypted, while signed in. */
function QueryLayer({
  cache,
  api,
  children,
}: {
  cache: { personId: string; storage: KeyValueStorage } | null;
  api: ApiClient;
  children: ReactNode;
}) {
  const [client] = useState<QueryClient>(() => {
    const created = createQueryClient();
    // Before the cache is restored: paused outbox writes resume with these defaults.
    registerOutbox(created, api);
    return created;
  });
  const [persister] = useState(() =>
    cache
      ? createSyncStoragePersister({ storage: cache.storage, key: "queries", throttleTime: 1000 })
      : null,
  );
  if (!persister) return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{
        persister,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        // A cache written by another app version (or cache layout) is discarded, not misread.
        buster: `${APP_VERSION}:${CACHE_SCHEMA_VERSION}`,
      }}
      // Writes made offline in an earlier run are sent now (in order).
      onSuccess={() => void client.resumePausedMutations()}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
