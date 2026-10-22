// SPDX-License-Identifier: AGPL-3.0-only
// AWS Signature Version 4 for the dev smoke test and the ops tooling, from the
// application's object storage client (no S3 SDK).

export { type SignInput, signV4 } from "@clubadmin/server-kit/object-storage";
