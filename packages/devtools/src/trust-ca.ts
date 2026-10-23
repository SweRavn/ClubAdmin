// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm dev:trust-ca`: exports Caddy's local root CA and installs it in the
// operating system trust store, so https://clubadmin.localhost works without
// warnings. With --print, only prints the commands. --ios adds it to booted
// iOS simulators; --android prepares a running Android emulator (user CA
// store for the browser, port 443 forwarded to this machine), see
// docs/development.md, "Mobile".

import { existsSync } from "node:fs";

import { exportCaddyRootCert } from "./caddy.ts";
import { caddyRootCertFile } from "./paths.ts";
import { isWsl } from "./platform.ts";
import { capture, run } from "./process.ts";

interface Step {
  command: string;
  args: string[];
}

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

/** Booted iOS simulators share this machine's network; they only need the CA. */
export function iosSimulatorSteps(certFile: string): Step[] {
  return [{ command: "xcrun", args: ["simctl", "keychain", "booted", "add-root-cert", certFile] }];
}

/**
 * A running Android emulator (Google APIs image, `adb root` allowed): the CA
 * in the user store (Chrome, used for the Zitadel login, trusts it; the app's
 * development build trusts it through its network security config), and
 * port 443 on the emulator forwarded to Caddy on this machine, so
 * https://*.clubadmin.localhost resolved to 127.0.0.1 reaches it.
 */
export function androidEmulatorSteps(certFile: string, subjectHash: string): Step[] {
  const target = `/data/misc/user/0/cacerts-added/${subjectHash}.0`;
  return [
    { command: "adb", args: ["root"] },
    { command: "adb", args: ["wait-for-device"] },
    { command: "adb", args: ["shell", "mkdir", "-p", "/data/misc/user/0/cacerts-added"] },
    { command: "adb", args: ["push", certFile, target] },
    { command: "adb", args: ["shell", "chmod", "644", target] },
    { command: "adb", args: ["reverse", "tcp:443", "tcp:443"] },
  ];
}

async function runSteps(steps: Step[], printOnly: boolean): Promise<boolean> {
  for (const step of steps) {
    console.log(`  ${step.command} ${step.args.join(" ")}`);
    if (!printOnly && (await run(step.command, step.args)) !== 0) {
      console.error("A step failed. Run the commands above manually.");
      return false;
    }
  }
  return true;
}

/** `pnpm dev:trust-ca --ios` / `--android`. */
export async function trustCaOnDevice(
  device: "ios" | "android",
  printOnly: boolean,
): Promise<boolean> {
  try {
    exportCaddyRootCert();
  } catch (error) {
    // Caddy not running: the copy exported earlier will do.
    if (!existsSync(caddyRootCertFile)) throw error;
  }
  if (device === "ios") {
    console.log("Adding Caddy's local CA to the booted iOS simulators:");
    return runSteps(iosSimulatorSteps(caddyRootCertFile), printOnly);
  }
  // Android names CA files after OpenSSL's old subject hash.
  const hash = capture("openssl", [
    "x509",
    "-subject_hash_old",
    "-noout",
    "-in",
    caddyRootCertFile,
  ]).stdout.trim();
  if (!/^[0-9a-f]{8}$/.test(hash)) {
    console.error("Could not compute the certificate's subject hash (is openssl installed?).");
    return false;
  }
  console.log("Preparing the running Android emulator:");
  return runSteps(androidEmulatorSteps(caddyRootCertFile, hash), printOnly);
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
    // Import-Certificate cannot read \\wsl.localhost\... paths ("could not be
    // found"): copy the file to a Windows folder first.
    const source = isWsl()
      ? `  Copy-Item "${windowsPath}" "$env:TEMP\\clubadmin-caddy-root.crt"\n`
      : "";
    const file = isWsl() ? "$env:TEMP\\clubadmin-caddy-root.crt" : windowsPath;
    console.log(
      "\nOn Windows, import it into your user's trusted roots (PowerShell):\n" +
        source +
        `  Import-Certificate -FilePath "${file}" -CertStoreLocation Cert:\\CurrentUser\\Root\n`,
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
  if (!(await runSteps(steps, printOnly))) return false;
  if (process.platform === "linux") {
    console.log(
      "\nChrome and Firefox on Linux use their own certificate store (NSS). If they still warn,\n" +
        `import ${caddyRootCertFile} under Settings → Certificates → Authorities.`,
    );
  }
  return true;
}
