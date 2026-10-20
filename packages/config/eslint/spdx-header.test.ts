// SPDX-License-Identifier: AGPL-3.0-only
import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import { SPDX_HEADER, spdxHeader } from "./spdx-header.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 2023, sourceType: "module" } });

ruleTester.run("spdx-header", spdxHeader, {
  valid: [
    { code: `${SPDX_HEADER}\nexport const a = 1;\n` },
    { code: `#!/usr/bin/env node\n${SPDX_HEADER}\nconsole.log(1);\n` },
  ],
  invalid: [
    {
      code: "export const a = 1;\n",
      errors: [{ messageId: "missing" }],
      output: `${SPDX_HEADER}\nexport const a = 1;\n`,
    },
    {
      code: "// SPDX-License-Identifier: MIT\nexport const a = 1;\n",
      errors: [{ messageId: "missing" }],
      output: `${SPDX_HEADER}\n// SPDX-License-Identifier: MIT\nexport const a = 1;\n`,
    },
    {
      code: "#!/usr/bin/env node\nconsole.log(1);\n",
      errors: [{ messageId: "missing" }],
      output: `#!/usr/bin/env node\n${SPDX_HEADER}\nconsole.log(1);\n`,
    },
  ],
});
