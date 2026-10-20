// SPDX-License-Identifier: AGPL-3.0-only
// Idempotent setup of the single-node Garage cluster through its admin API (v2):
// cluster layout, the access key from .env.local, and the buckets.

export interface GarageSetup {
  adminUrl: string;
  adminToken: string;
  accessKeyId: string;
  secretAccessKey: string;
  buckets: readonly string[];
  /** Capacity assigned to the single dev node, in bytes. */
  capacity?: number;
}

type Fetch = typeof fetch;

export class GarageAdminClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: Fetch;

  constructor(baseUrl: string, token: string, fetchImpl: Fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async call<T>(
    endpoint: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ) {
    const url = new URL(`${this.baseUrl}/v2/${endpoint}`);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    const response = await this.fetchImpl(url, {
      method: options.body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: options.body === undefined ? null : JSON.stringify(options.body),
    });
    const text = await response.text();
    const data = text === "" ? undefined : (JSON.parse(text) as unknown);
    return { ok: response.ok, status: response.status, data: data as T };
  }
}

interface ClusterStatus {
  nodes: { id: string; role: unknown }[];
}
interface ClusterLayout {
  version: number;
  roles: { id: string }[];
}
interface BucketInfo {
  id: string;
  keys: { accessKeyId: string; permissions: { read: boolean; write: boolean } }[];
}

/** Returns a list of the changes it made (empty when everything already existed). */
export async function setupGarage(setup: GarageSetup, fetchImpl: Fetch = fetch): Promise<string[]> {
  const client = new GarageAdminClient(setup.adminUrl, setup.adminToken, fetchImpl);
  const changes: string[] = [];
  const expect = <T>(result: { ok: boolean; status: number; data: T }, what: string): T => {
    if (!result.ok) throw new Error(`Garage admin API: ${what} failed (HTTP ${result.status})`);
    return result.data;
  };

  // 1. Layout: give the single node a role, once.
  const layout = expect(await client.call<ClusterLayout>("GetClusterLayout"), "GetClusterLayout");
  if (layout.roles.length === 0) {
    const status = expect(await client.call<ClusterStatus>("GetClusterStatus"), "GetClusterStatus");
    const node = status.nodes[0];
    if (!node) throw new Error("Garage reports no nodes");
    expect(
      await client.call("UpdateClusterLayout", {
        body: {
          roles: [
            { id: node.id, zone: "dev", capacity: setup.capacity ?? 10_000_000_000, tags: [] },
          ],
        },
      }),
      "UpdateClusterLayout",
    );
    expect(
      await client.call("ApplyClusterLayout", { body: { version: layout.version + 1 } }),
      "ApplyClusterLayout",
    );
    changes.push("applied single-node cluster layout");
  }

  // 2. Access key with the credentials from .env.local.
  const key = await client.call("GetKeyInfo", { query: { id: setup.accessKeyId } });
  if (!key.ok) {
    expect(
      await client.call("ImportKey", {
        body: {
          accessKeyId: setup.accessKeyId,
          secretAccessKey: setup.secretAccessKey,
          name: "clubadmin-dev",
        },
      }),
      "ImportKey",
    );
    changes.push(`imported access key ${setup.accessKeyId}`);
  }

  // 3. Buckets, each readable and writable with that key.
  for (const bucket of setup.buckets) {
    let info = await client.call<BucketInfo>("GetBucketInfo", { query: { globalAlias: bucket } });
    if (!info.ok) {
      info = await client.call<BucketInfo>("CreateBucket", { body: { globalAlias: bucket } });
      expect(info, `CreateBucket ${bucket}`);
      changes.push(`created bucket ${bucket}`);
    }
    const granted = info.data.keys.some(
      (k) => k.accessKeyId === setup.accessKeyId && k.permissions.read && k.permissions.write,
    );
    if (!granted) {
      expect(
        await client.call("AllowBucketKey", {
          body: {
            bucketId: info.data.id,
            accessKeyId: setup.accessKeyId,
            permissions: { read: true, write: true, owner: true },
          },
        }),
        `AllowBucketKey ${bucket}`,
      );
      changes.push(`granted read/write on ${bucket}`);
    }
  }
  return changes;
}
