// SPDX-License-Identifier: AGPL-3.0-only
// The offline outbox (P1.5, ADR 0035): answers and attendance marks taken
// without coverage are TanStack Query mutations that pause while offline,
// are persisted with the account's encrypted query cache and run when the
// phone is online again, one after another in the order they were made
// (one mutation scope). Each write carries an Idempotency-Key and the time
// it was made: the API's writes are idempotent by content, marks are
// ordered by that time (a newer mark wins), answers by when they arrive. A
// write the API refuses (a closed deadline, a locked list) is kept as a
// failure with its reason until the user dismisses it.

import { type ApiClient, ApiError } from "@clubadmin/api-client";
import { type QueryClient, useMutation, useMutationState, useQuery } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";

import { retryDelay, shouldRetry } from "./query-client.ts";

export const OUTBOX_KEY = ["outbox"] as const;
const FAILURES_KEY = ["outbox", "failures"] as const;

export type OutboxWrite =
  | {
      kind: "response";
      activityId: string;
      personId: string;
      /** null withdraws the answer. */
      status: "attending" | "not_attending" | null;
      note?: string | null;
      key: string;
      madeAt: string;
    }
  | {
      kind: "attendance";
      activityId: string;
      marks: {
        personId: string;
        status: "present" | "absent" | "excused";
        role: "participant" | "leader";
      }[];
      correctedReason?: string;
      key: string;
      madeAt: string;
    };

export interface OutboxFailure {
  key: string;
  kind: OutboxWrite["kind"];
  activityId: string;
  /** The problem's detail code (translated with joinErrors), or "failed". */
  code: string;
}

/** Writes without key and time, as the screens make them. */
export type NewOutboxWrite =
  | Omit<Extract<OutboxWrite, { kind: "response" }>, "key" | "madeAt">
  | Omit<Extract<OutboxWrite, { kind: "attendance" }>, "key" | "madeAt">;

/** Sends one write (also when the outbox replays it after a restart). */
export async function sendWrite(api: ApiClient, write: OutboxWrite): Promise<unknown> {
  const headers = { "idempotency-key": write.key };
  if (write.kind === "attendance") {
    const result = await api.PUT("/api/v1/activities/{activityId}/attendance", {
      params: { path: { activityId: write.activityId } },
      headers,
      body: {
        marks: write.marks.map((m) => ({ ...m, recordedAt: write.madeAt })),
        ...(write.correctedReason ? { correctedReason: write.correctedReason } : {}),
      },
    });
    return result.data;
  }
  const path = { activityId: write.activityId, personId: write.personId };
  if (write.status === null) {
    const result = await api.DELETE("/api/v1/activities/{activityId}/responses/{personId}", {
      params: { path },
      headers,
    });
    return result.data;
  }
  const result = await api.PUT("/api/v1/activities/{activityId}/responses/{personId}", {
    params: { path },
    headers,
    body: { status: write.status, ...(write.note ? { note: write.note } : {}) },
  });
  return result.data;
}

/**
 * Registers how outbox writes run, before the persisted cache is restored
 * (paused writes from an earlier run resume with these defaults).
 */
export function registerOutbox(client: QueryClient, api: ApiClient): void {
  client.setMutationDefaults(OUTBOX_KEY, {
    mutationFn: (write: OutboxWrite) => sendWrite(api, write),
    scope: { id: "outbox" },
    // Network failures and 5xx are retried; a refusal (4xx) is final. While
    // offline the writes pause instead (and keep their place in the queue).
    retry: (count, error) => (error instanceof ApiError ? shouldRetry(count, error) : count < 10),
    retryDelay,
    onError: (error, write) => {
      const code =
        error instanceof ApiError && typeof error.problem?.detail === "string"
          ? error.problem.detail
          : "failed";
      client.setQueryData<OutboxFailure[]>(FAILURES_KEY, (list = []) => [
        ...list,
        { key: write.key, kind: write.kind, activityId: write.activityId, code },
      ]);
    },
    onSettled: (_data, _error, write) => {
      void client.invalidateQueries({ queryKey: ["schedule"] });
      void client.invalidateQueries({ queryKey: ["activity", write.activityId] });
      void client.invalidateQueries({ queryKey: ["responses", write.activityId] });
      void client.invalidateQueries({ queryKey: ["attendance", write.activityId] });
    },
  });
}

/** Adds a write to the outbox (sent at once when online). */
export function useOutbox() {
  const mutation = useMutation<unknown, Error, OutboxWrite>({ mutationKey: OUTBOX_KEY });
  return (write: NewOutboxWrite) =>
    mutation.mutate({ ...write, key: randomUUID(), madeAt: new Date().toISOString() });
}

/** Writes not yet sent (waiting for coverage or in flight). */
export function usePendingWrites(): OutboxWrite[] {
  return useMutationState({
    filters: { mutationKey: OUTBOX_KEY, status: "pending" },
    select: (m) => m.state.variables as OutboxWrite,
  });
}

/** Refused writes, until dismissed. */
export function useOutboxFailures() {
  return useQuery<OutboxFailure[]>({
    queryKey: FAILURES_KEY,
    queryFn: () => [],
    staleTime: Number.POSITIVE_INFINITY,
    initialData: [],
  });
}

export function dismissOutboxFailures(client: QueryClient): void {
  client.setQueryData<OutboxFailure[]>(FAILURES_KEY, []);
}
