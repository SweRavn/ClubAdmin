// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ApiError, createApiClient } from "./index.ts";

function fakeFetch(handler: (request: Request) => Response): {
  fetch: typeof fetch;
  requests: Request[];
} {
  const requests: Request[] = [];
  const fetchImpl = ((input: Request) => {
    requests.push(input);
    return Promise.resolve(handler(input));
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

describe("createApiClient", () => {
  it("returns typed data and sends request ID and language", async () => {
    const { fetch, requests } = fakeFetch(() => Response.json({ version: "1.2.3", commit: "abc" }));
    const client = createApiClient({
      baseUrl: "https://clubadmin.localhost/",
      fetch,
      acceptLanguage: "sv",
      requestId: () => "0190f0e0-1234-7abc-8def-0123456789ab",
    });
    const { data } = await client.GET("/api/v1/meta/version");
    expect(data?.version).toBe("1.2.3");
    expect(requests[0]?.url).toBe("https://clubadmin.localhost/api/v1/meta/version");
    expect(requests[0]?.headers.get("x-request-id")).toBe("0190f0e0-1234-7abc-8def-0123456789ab");
    expect(requests[0]?.headers.get("accept-language")).toBe("sv");
  });

  it("throws ApiError with the problem details for error responses", async () => {
    const problem = {
      type: "https://github.com/SweRavn/ClubAdmin/blob/main/docs/api/problems.md#not-found",
      title: "Not found",
      status: 404,
      requestId: "r1",
    };
    const { fetch } = fakeFetch(
      () =>
        new Response(JSON.stringify(problem), {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        }),
    );
    const client = createApiClient({ baseUrl: "https://clubadmin.localhost", fetch });
    const error = await client.GET("/api/v1/meta/source").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      type: "not-found",
      requestId: "r1",
      message: "Not found",
    });
  });
});
