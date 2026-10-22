// SPDX-License-Identifier: AGPL-3.0-only
// Route parameters from deep links are untrusted: only UUIDs are accepted.

import { isUuid } from "@clubadmin/shared";
import { useLocalSearchParams } from "expo-router";

export function useIdParam(name: string): string | null {
  const params = useLocalSearchParams();
  const value = params[name];
  const id = Array.isArray(value) ? value[0] : value;
  return typeof id === "string" && isUuid(id) ? id : null;
}
