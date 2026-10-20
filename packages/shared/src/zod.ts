// SPDX-License-Identifier: AGPL-3.0-only
// Zod with OpenAPI metadata support. Import `z` from here (or from the package
// root), never from "zod" directly, so `.openapi()` is always available.

import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export { z };
