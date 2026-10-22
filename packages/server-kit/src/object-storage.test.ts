// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ObjectStorage, objectStorageConfig, presignGetUrl } from "./object-storage.ts";

describe("object storage", () => {
  it("is off without an endpoint and credentials", () => {
    expect(
      objectStorageConfig({ S3_REGION: "garage", S3_BUCKET_FILES: "files", S3_ENDPOINT: "http://s3" }),
    ).toBeNull();
  });

  it("pre-signs downloads on the public endpoint, path style", () => {
    const storage = new ObjectStorage({
      endpoint: "http://garage:3900",
      publicEndpoint: "https://s3.example.test",
      region: "garage",
      bucket: "clubadmin-files",
      accessKeyId: "GKexample",
      secretAccessKey: "secret",
    });
    const url = new URL(
      storage.presignDownload("exports/club/one.csv", { expiresSeconds: 300, filename: 'a"b.csv' }),
    );
    expect(url.origin).toBe("https://s3.example.test");
    expect(url.pathname).toBe("/clubadmin-files/exports/club/one.csv");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="ab.csv"');
  });

  // AWS's documented example of query-string authentication (Signature Version 4).
  it("matches the AWS example signature", () => {
    const url = presignGetUrl({
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 86_400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
});
