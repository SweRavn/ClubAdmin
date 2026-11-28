// SPDX-License-Identifier: AGPL-3.0-only
// TanStack Query for the app: cached data is shown at once and refreshed in
// the background; requests pause while offline (NetInfo) and refetch when the
// app comes back to the foreground. A 429 is retried after its Retry-After;
// other client errors are not retried.

import { ApiError } from "@clubadmin/api-client";
import NetInfo, { NetInfoStateType } from "@react-native-community/netinfo";
import {
  focusManager,
  MutationCache,
  onlineManager,
  QueryCache,
  QueryClient,
} from "@tanstack/react-query";
import { AppState, type AppStateStatus } from "react-native";

import { BUILD_VARIANT } from "../config.ts";
import { noteResult } from "./server-status.ts";

let wired = false;
function wireOnlineAndFocus() {
  if (wired) return;
  wired = true;
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => {
      // Offline is no network. Android's "internet reachable" check fails
      // behind proxies, VPNs and emulators while the network works; whether
      // ClubAdmin's server answers is told apart (server-status.ts).
      setOnline(state.isConnected !== false && state.type !== NetInfoStateType.none);
    }),
  );
  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      handleFocus(state === "active");
    });
    return () => subscription.remove();
  });
}

/** "Name: message" of an error, for diagnostics in development builds. */
export function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.status === 429) return failureCount < 3;
    if (error.status < 500) return false;
  }
  return failureCount < 2;
}

export function retryDelay(attempt: number, error: unknown): number {
  if (error instanceof ApiError && error.status === 429 && error.retryAfter) {
    return error.retryAfter * 1000;
  }
  return Math.min(1000 * 2 ** attempt, 15_000);
}

export function createQueryClient(): QueryClient {
  wireOnlineAndFocus();
  return new QueryClient({
    // Development and preview builds: why a request failed, in logcat / the
    // console (error name and message, never response data).
    queryCache: new QueryCache({
      onSuccess: () => noteResult(null),
      onError: (error, query) => {
        noteResult(error);
        if (BUILD_VARIANT === "production") return;
        console.warn(
          `ClubAdmin: query ${String(query.queryKey[0])} failed: ${errorSummary(error)}`,
        );
      },
    }),
    mutationCache: new MutationCache({
      onSuccess: () => noteResult(null),
      onError: (error) => noteResult(error),
    }),
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        // Keep cached data for offline use as long as the persisted cache lives.
        gcTime: 30 * 24 * 60 * 60 * 1000,
        retry: shouldRetry,
        retryDelay,
        networkMode: "offlineFirst",
      },
    },
  });
}
