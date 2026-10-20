// SPDX-License-Identifier: AGPL-3.0-only
// pnpm api:openapi — writes packages/api-client/openapi.json.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  generateOpenApiDocument,
  OPENAPI_FILE,
  serialiseOpenApi,
} from "../platform/openapi/document.ts";

const document = await generateOpenApiDocument();
writeFileSync(OPENAPI_FILE, serialiseOpenApi(document));
process.stdout.write(
  `Wrote ${fileURLToPath(OPENAPI_FILE)} (${Object.keys(document.paths ?? {}).length} paths)\n`,
);
