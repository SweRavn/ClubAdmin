// SPDX-License-Identifier: AGPL-3.0-only
import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import { noJsxLiteralStrings } from "./jsx-literal-strings.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("no-jsx-literal-strings", noJsxLiteralStrings, {
  valid: [
    { code: "const a = <p>{t('home.title')}</p>;" },
    { code: "const a = <p>{name} · {role} — (1)</p>;" },
    { code: "const a = <p>{' '}</p>;" },
    {
      code: "const a = <a href='/groups' className='text-sm' data-testid='nav-groups'>{t('nav.groups')}</a>;",
    },
    { code: "const a = <button aria-label={t('userMenu.label')} />;" },
    { code: "const label = 'not in JSX';" },
  ],
  invalid: [
    { code: "const a = <p>Hello</p>;", errors: [{ messageId: "text" }] },
    { code: "const a = <p>{'Hej'}</p>;", errors: [{ messageId: "text" }] },
    { code: "const a = <p>{`Hi ${name}`}</p>;", errors: [{ messageId: "text" }] },
    { code: "const a = <img alt='Logo' />;", errors: [{ messageId: "text" }] },
    { code: "const a = <button aria-label='Close' />;", errors: [{ messageId: "text" }] },
    { code: "const a = <>Svenska</>;", errors: [{ messageId: "text" }] },
  ],
});
