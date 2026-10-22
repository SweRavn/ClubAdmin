// SPDX-License-Identifier: AGPL-3.0-only
// Idempotent setup of the single-node Garage cluster through its admin API (v2):
// cluster layout, the access keys from .env.local, and the buckets.

export interface GarageKey {
  accessKeyId: string;
  secretAccessKey: string;
  name: string;
  /** Buckets this key may use; read-only unless write is true. */
  grants: readonly { bucket: string; write: boolean }[];
}

export interface GarageSetup {
  adminUrl: string;
  adminToken: string;
  /** The application's key: read and write on every bucket in `buckets`. */
  accessKeyId: string;
  secretAccessKey: string;
  buckets: readonly string[];
  /** Further keys with their own grants (backup credentials, separate from the application's). */
  keys?: readonly GarageKey[];
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

  // 2. Access keys with the credentials from .env.local.
  const keys: GarageKey[] = [
    {
      accessKeyId: setup.accessKeyId,
      secretAccessKey: setup.secretAccessKey,
      name: "clubadmin-dev",
      grants: setup.buckets.map((bucket) => ({ bucket, write: true })),
    },
    ...(setup.keys ?? []),
  ];
  for (const k of keys) {
    const key = await client.call("GetKeyInfo", { query: { id: k.accessKeyId } });
    if (key.ok) continue;
    expect(
      await client.call("ImportKey", {
        body: { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, name: k.name },
      }),
      "ImportKey",
    );
    changes.push(`imported access key ${k.accessKeyId}`);
  }

  // 3. Buckets, and each key's permissions on them.
  const buckets = [...new Set(keys.flatMap((k) => k.grants.map((g) => g.bucket)))];
  for (const bucket of buckets) {
    let info = await client.call<BucketInfo>("GetBucketInfo", { query: { globalAlias: bucket } });
    if (!info.ok) {
      info = await client.call<BucketInfo>("CreateBucket", { body: { globalAlias: bucket } });
      expect(info, `CreateBucket ${bucket}`);
      changes.push(`created bucket ${bucket}`);
    }
    for (const k of keys) {
      const grant = k.grants.find((g) => g.bucket === bucket);
      if (!grant) continue;
      const granted = info.data.keys.some(
        (existing) =>
          existing.accessKeyId === k.accessKeyId &&
          existing.permissions.read &&
          (!grant.write || existing.permissions.write),
      );
      if (granted) continue;
      expect(
        await client.call("AllowBucketKey", {
          body: {
            bucketId: info.data.id,
            accessKeyId: k.accessKeyId,
            permissions: { read: true, write: grant.write, owner: grant.write },
          },
        }),
        `AllowBucketKey ${bucket}`,
      );
      changes.push(
        `granted ${grant.write ? "read/write" : "read"} on ${bucket} to ${k.accessKeyId}`,
      );
    }
  }
  return changes;
}
