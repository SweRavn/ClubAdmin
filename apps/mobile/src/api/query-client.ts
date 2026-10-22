// SPDX-License-Identifier: AGPL-3.0-only
// TanStack Query for the app: cached data is shown at once and refreshed in
// the background; requests pause while offline (NetInfo) and refetch when the
// app comes back to the foreground. A 429 is retried after its Retry-After;
// other client errors are not retried.

import { ApiError } from "@clubadmin/api-client";
import NetInfo from "@react-native-community/netinfo";
import { focusManager, onlineManager, QueryClient } from "@tanstack/react-query";
import { AppState, type AppStateStatus } from "react-native";

let wired = false;
function wireOnlineAndFocus() {
  if (wired) return;
  wired = true;
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => {
      setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    }),
  );
  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      handleFocus(state === "active");
    });
    return () => subscription.remove();
  });
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
