// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm dev:trust-ca`: exports Caddy's local root CA and installs it in the
// operating system trust store, so https://clubadmin.localhost works without
// warnings. With --print, only prints the commands.

import { existsSync, readFileSync } from "node:fs";

import { exportCaddyRootCert } from "./caddy.ts";
import { caddyRootCertFile } from "./paths.ts";
import { capture, run } from "./process.ts";

interface Step {
  command: string;
  args: string[];
}

const isWsl = () =>
  process.platform === "linux" &&
  existsSync("/proc/version") &&
  /microsoft/i.test(readFileSync("/proc/version", "utf8"));

export function trustSteps(platform: NodeJS.Platform, certFile: string): Step[] {
  if (platform === "darwin") {
    return [
      {
        command: "sudo",
        args: [
          "security",
          "add-trusted-cert",
          "-d",
          "-r",
          "trustRoot",
          "-k",
          "/Library/Keychains/System.keychain",
          certFile,
        ],
      },
    ];
  }
  if (platform === "linux") {
    if (existsSync("/usr/local/share/ca-certificates")) {
      return [
        {
          command: "sudo",
          args: ["cp", certFile, "/usr/local/share/ca-certificates/clubadmin-dev-ca.crt"],
        },
        { command: "sudo", args: ["update-ca-certificates"] },
      ];
    }
    if (existsSync("/etc/pki/ca-trust/source/anchors")) {
      return [
        {
          command: "sudo",
          args: ["cp", certFile, "/etc/pki/ca-trust/source/anchors/clubadmin-dev-ca.crt"],
        },
        { command: "sudo", args: ["update-ca-trust"] },
      ];
    }
  }
  return [];
}

export async function trustCa(printOnly: boolean): Promise<boolean> {
  exportCaddyRootCert();
  console.log(`Exported Caddy's local root CA to ${caddyRootCertFile}`);

  const isRoot = process.getuid?.() === 0;
  // Already root (e.g. in a container): run the commands without sudo.
  const steps = trustSteps(process.platform, caddyRootCertFile).map((step) =>
    isRoot && step.command === "sudo"
      ? { command: step.args[0] ?? "", args: step.args.slice(1) }
      : step,
  );
  if (process.platform === "win32" || isWsl()) {
    const windowsPath = isWsl()
      ? capture("wslpath", ["-w", caddyRootCertFile]).stdout.trim()
      : caddyRootCertFile;
    console.log(
      "\nOn Windows, import it into your user's trusted roots (PowerShell):\n" +
        `  Import-Certificate -FilePath "${windowsPath}" -CertStoreLocation Cert:\\CurrentUser\\Root\n`,
    );
  }
  if (steps.length === 0) {
    console.log(
      "No automatic installation for this system; import the file above as a trusted root CA.",
    );
    return true;
  }

  console.log(
    printOnly ? "\nRun these commands:" : "\nInstalling (you may be asked for your password):",
  );
  for (const step of steps) {
    console.log(`  ${step.command} ${step.args.join(" ")}`);
    if (!printOnly && (await run(step.command, step.args)) !== 0) {
      console.error("Installing the certificate failed. Run the commands above manually.");
      return false;
    }
  }
  if (process.platform === "linux") {
    console.log(
      "\nChrome and Firefox on Linux use their own certificate store (NSS). If they still warn,\n" +
        `import ${caddyRootCertFile} under Settings → Certificates → Authorities.`,
    );
  }
  return true;
}
