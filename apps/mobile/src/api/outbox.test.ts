// SPDX-License-Identifier: AGPL-3.0-only
import { type ApiClient, ApiError } from "@clubadmin/api-client";
import { QueryClient } from "@tanstack/react-query";

import { OUTBOX_KEY, type OutboxFailure, registerOutbox, sendWrite } from "./outbox.ts";

jest.mock("expo-crypto", () => ({ randomUUID: () => "0199d2a0-0000-4000-8000-000000000001" }));

const ACTIVITY = "0199d2a0-0000-7000-8000-00000000000a";
const PERSON = "0199d2a0-0000-7000-8000-00000000000b";

function fakeApi(fail?: ApiError) {
  const calls: { method: string; path: string; init: unknown }[] = [];
  const call = (method: string) => (path: string, init: unknown) => {
    calls.push({ method, path, init });
    return fail ? Promise.reject(fail) : Promise.resolve({ data: {} });
  };
  return { api: { PUT: call("PUT"), DELETE: call("DELETE") } as unknown as ApiClient, calls };
}

describe("outbox", () => {
  it("sends answers and marks with the idempotency key and the time they were made", async () => {
    const { api, calls } = fakeApi();
    await sendWrite(api, {
      kind: "attendance",
      activityId: ACTIVITY,
      marks: [{ personId: PERSON, status: "present", role: "participant" }],
      key: "k1",
      madeAt: "2026-10-20T17:05:00.000Z",
    });
    await sendWrite(api, {
      kind: "response",
      activityId: ACTIVITY,
      personId: PERSON,
      status: null,
      key: "k2",
      madeAt: "2026-10-20T17:06:00.000Z",
    });
    expect(calls).toEqual([
      {
        method: "PUT",
        path: "/api/v1/activities/{activityId}/attendance",
        init: {
          params: { path: { activityId: ACTIVITY } },
          headers: { "idempotency-key": "k1" },
          body: {
            marks: [
              {
                personId: PERSON,
                status: "present",
                role: "participant",
                recordedAt: "2026-10-20T17:05:00.000Z",
              },
            ],
          },
        },
      },
      {
        method: "DELETE",
        path: "/api/v1/activities/{activityId}/responses/{personId}",
        init: {
          params: { path: { activityId: ACTIVITY, personId: PERSON } },
          headers: { "idempotency-key": "k2" },
        },
      },
    ]);
  });

  it("keeps a refused write as a failure with its reason, without retrying it", async () => {
    const refused = new ApiError(
      409,
      {
        type: "https://clubadmin.example/problems#conflict",
        title: "Conflict",
        status: 409,
        detail: "response_closed",
        requestId: "0199d2a0-0000-7000-8000-0000000000ff",
      },
      undefined,
    );
    const { api, calls } = fakeApi(refused);
    const client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
    registerOutbox(client, api);
    const mutation = client.getMutationCache().build(client, { mutationKey: OUTBOX_KEY });
    await expect(
      mutation.execute({
        kind: "response",
        activityId: ACTIVITY,
        personId: PERSON,
        status: "attending",
        key: "k3",
        madeAt: "2026-10-20T17:07:00.000Z",
      }),
    ).rejects.toBe(refused);
    expect(calls).toHaveLength(1);
    expect(client.getQueryData<OutboxFailure[]>(["outbox", "failures"])).toEqual([
      { key: "k3", kind: "response", activityId: ACTIVITY, code: "response_closed" },
    ]);
  });
});
