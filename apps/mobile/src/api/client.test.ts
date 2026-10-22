// SPDX-License-Identifier: AGPL-3.0-only
import type { TokenSet } from "../auth/tokens.ts";
import { authorizedFetch, type RequestContext } from "./client.ts";

const set = (name: string): TokenSet => ({
  accessToken: name,
  idToken: `id-${name}`,
  expiresAt: 0,
});

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tokens: () => Promise.resolve(set("a1")),
    renew: () => Promise.resolve(set("a2")),
    loginEnded: () => undefined,
    onBehalfOf: () => null,
    acceptLanguage: () => "sv, en;q=0.5",
    client: { platform: "android", version: "1.2.0", device: "Pixel 8 (Android 16)" },
    ...overrides,
  };
}

const ok = () => new Response("{}", { status: 200 });

describe("authorizedFetch", () => {
  it("adds the tokens, language and app headers", async () => {
    const base = jest.fn((_request: Request) => Promise.resolve(ok()));
    await authorizedFetch(
      context(),
      base as unknown as typeof fetch,
    )("https://api.example/api/v1/me");
    const request = base.mock.calls[0]![0];
    expect(request.headers.get("authorization")).toBe("Bearer a1");
    expect(request.headers.get("x-id-token")).toBe("id-a1");
    expect(request.headers.get("accept-language")).toBe("sv, en;q=0.5");
    expect(request.headers.get("x-client-platform")).toBe("android");
    expect(request.headers.get("x-client-version")).toBe("1.2.0");
    expect(request.headers.get("x-client-device")).toBe("Pixel 8 (Android 16)");
  });

  it("sends X-On-Behalf-Of only where it applies", async () => {
    const base = jest.fn((_request: Request) => Promise.resolve(ok()));
    const fetchAs = authorizedFetch(
      context({ onBehalfOf: () => "ward-1" }),
      base as unknown as typeof fetch,
    );
    await fetchAs("https://api.example/api/v1/me/groups");
    await fetchAs("https://api.example/api/v1/me/wards");
    await fetchAs("https://api.example/api/v1/me");
    expect(base.mock.calls.map(([r]) => r.headers.get("x-on-behalf-of"))).toEqual([
      "ward-1",
      null,
      null,
    ]);
  });

  it("refreshes once after a 401 and retries the request", async () => {
    const base = jest
      .fn<Promise<Response>, [Request]>()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(ok());
    const renew = jest.fn(() => Promise.resolve(set("a2")));
    const res = await authorizedFetch(
      context({ renew }),
      base as unknown as typeof fetch,
    )("https://api.example/api/v1/me/clubs");
    expect(res.status).toBe(200);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(base.mock.calls[1]![0].headers.get("authorization")).toBe("Bearer a2");
  });

  it("ends the login when fresh tokens are refused too (revoked session)", async () => {
    const base = jest.fn(() => Promise.resolve(new Response("", { status: 401 })));
    const loginEnded = jest.fn();
    const res = await authorizedFetch(
      context({ loginEnded }),
      base,
    )("https://api.example/api/v1/me");
    expect(res.status).toBe(401);
    expect(loginEnded).toHaveBeenCalledTimes(1);
  });

  it("does not retry without a login", async () => {
    const base = jest.fn(() => Promise.resolve(new Response("", { status: 401 })));
    const renew = jest.fn(() => Promise.resolve(set("a2")));
    const res = await authorizedFetch(
      context({ tokens: () => Promise.resolve(null), renew }),
      base,
    )("https://api.example/api/v1/meta/client");
    expect(res.status).toBe(401);
    expect(renew).not.toHaveBeenCalled();
    expect(base).toHaveBeenCalledTimes(1);
  });
});
