// SPDX-License-Identifier: AGPL-3.0-only
// Hermes ships Intl.DateTimeFormat (with time zones) and NumberFormat on both
// platforms, but not Intl.PluralRules on every supported OS version, which
// ICU plural messages ("{count, plural, ...}") need. The polyfill installs
// itself only when the engine lacks it, with data for our languages.

import "@formatjs/intl-pluralrules/polyfill.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-pluralrules/locale-data/sv.js";
import "@formatjs/intl-pluralrules/locale-data/nb.js";
