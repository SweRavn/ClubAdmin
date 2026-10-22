// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { setupGarage } from "./garage.ts";

/** In-memory imitation of the Garage v2 admin API endpoints used by setupGarage. */
function fakeGarage() {
  const state = {
    layoutVersion: 0,
    roles: [] as { id: string }[],
    keys: new Set<string>(),
    buckets: new Map<
      string,
      {
        id: string;
        keys: { accessKeyId: string; permissions: { read: boolean; write: boolean } }[];
      }
    >(),
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const handle = (input: URL | Request | string, init?: RequestInit): Response => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, unknown>;
    switch (url.pathname) {
      case "/v2/GetClusterLayout":
        return json(200, { version: state.layoutVersion, roles: state.roles });
      case "/v2/GetClusterStatus":
        return json(200, { nodes: [{ id: "node1", role: null }] });
      case "/v2/UpdateClusterLayout":
        state.roles = body.roles as { id: string }[];
        return json(200, {});
      case "/v2/ApplyClusterLayout":
        state.layoutVersion = body.version as number;
        return json(200, {});
      case "/v2/GetKeyInfo":
        return state.keys.has(url.searchParams.get("id") ?? "") ? json(200, {}) : json(404, {});
      case "/v2/ImportKey":
        state.keys.add(body.accessKeyId as string);
        return json(200, {});
      case "/v2/GetBucketInfo": {
        const bucket = state.buckets.get(url.searchParams.get("globalAlias") ?? "");
        return bucket ? json(200, bucket) : json(404, {});
      }
      case "/v2/CreateBucket": {
        const bucket = { id: `id-${body.globalAlias as string}`, keys: [] };
        state.buckets.set(body.globalAlias as string, bucket);
        return json(200, bucket);
      }
      case "/v2/AllowBucketKey": {
        const bucket = [...state.buckets.values()].find((b) => b.id === body.bucketId);
        const permissions = body.permissions as { read: boolean; write: boolean };
        bucket?.keys.push({
          accessKeyId: body.accessKeyId as string,
          permissions: { read: permissions.read, write: permissions.write },
        });
        return json(200, bucket);
      }
      default:
        return json(404, {});
    }
  };
  const fetchImpl = ((input: URL | Request | string, init?: RequestInit) =>
    Promise.resolve(handle(input, init))) as typeof fetch;
  return { state, fetchImpl };
}

const setup = {
  adminUrl: "http://garage:3903",
  adminToken: "token",
  accessKeyId: "GK000000000000000000000001",
  secretAccessKey: "secret",
  buckets: ["files", "backups"],
};

describe("setupGarage", () => {
  it("sets up layout, key and buckets once, and is idempotent", async () => {
    const { state, fetchImpl } = fakeGarage();
    const first = await setupGarage(setup, fetchImpl);
    expect(first).toEqual([
      "applied single-node cluster layout",
      "imported access key GK000000000000000000000001",
      "created bucket files",
      "granted read/write on files to GK000000000000000000000001",
      "created bucket backups",
      "granted read/write on backups to GK000000000000000000000001",
    ]);
    expect(state.layoutVersion).toBe(1);
    expect(await setupGarage(setup, fetchImpl)).toEqual([]);
  });

  it("gives further keys only their own grants", async () => {
    const { state, fetchImpl } = fakeGarage();
    const backupKey = {
      accessKeyId: "GK000000000000000000000002",
      secretAccessKey: "backup-secret",
      name: "clubadmin-dev-backup",
      grants: [
        { bucket: "files", write: false },
        { bucket: "backups", write: true },
        { bucket: "files-replica", write: true },
      ],
    };
    const changes = await setupGarage(
      { ...setup, buckets: ["files"], keys: [backupKey] },
      fetchImpl,
    );
    expect(changes).toContain("granted read on files to GK000000000000000000000002");
    expect(changes).toContain("created bucket files-replica");
    expect(state.buckets.get("files")?.keys).toEqual([
      { accessKeyId: "GK000000000000000000000001", permissions: { read: true, write: true } },
      { accessKeyId: "GK000000000000000000000002", permissions: { read: true, write: false } },
    ]);
    // The application's key is not given the backup buckets.
    expect(state.buckets.get("backups")?.keys.map((k) => k.accessKeyId)).toEqual([
      "GK000000000000000000000002",
    ]);
    expect(
      await setupGarage({ ...setup, buckets: ["files"], keys: [backupKey] }, fetchImpl),
    ).toEqual([]);
  });
});
