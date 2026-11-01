// SPDX-License-Identifier: AGPL-3.0-only
// Expo's Metro transformer, with the message catalogues of @clubadmin/i18n
// trimmed: namespaces only the web app, emails or the server use
// (src/i18n/web-only-namespaces.json) are left out of the app bundle, so
// they do not count against its size budget (ADR 0028). A test keeps the
// app from using a namespace on the list.
/* eslint-disable @typescript-eslint/no-require-imports -- Metro loads transformers as CommonJS */
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const upstreamPath = process.env.CLUBADMIN_UPSTREAM_TRANSFORMER;
if (!upstreamPath) throw new Error("metro.config.js sets CLUBADMIN_UPSTREAM_TRANSFORMER");
const upstream = require(upstreamPath);

const listFile = path.join(__dirname, "src", "i18n", "web-only-namespaces.json");
const listText = readFileSync(listFile, "utf8");
const webOnly = new Set(JSON.parse(listText));
const CATALOGUE = /[\\/]packages[\\/]i18n[\\/]messages[\\/][a-z]{2}\.json$/;

module.exports = {
  ...upstream,
  transform(config, projectRoot, filename, data, options) {
    if (CATALOGUE.test(filename)) {
      const catalogue = JSON.parse(data.toString("utf8"));
      for (const namespace of webOnly) delete catalogue[namespace];
      data = Buffer.from(JSON.stringify(catalogue), "utf8");
    }
    return upstream.transform(config, projectRoot, filename, data, options);
  },
  getCacheKey(config) {
    const own = createHash("sha256")
      .update(readFileSync(__filename))
      .update(listText)
      .digest("hex");
    return `${upstream.getCacheKey(config)}-${own}`;
  },
};
