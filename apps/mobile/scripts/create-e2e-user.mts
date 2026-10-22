// SPDX-License-Identifier: AGPL-3.0-only
// Creates a Zitadel user with a verified email and a password for the
// Maestro login flow (CI), using the admin token. Prints the email.
// Usage: ZITADEL_PAT=... node scripts/create-e2e-user.mts <password>

const issuer = process.env.AUTH_ISSUER ?? "https://auth.clubadmin.localhost";
const token = process.env.ZITADEL_PAT;
const password = process.argv[2];
if (!token || !password) throw new Error("usage: ZITADEL_PAT=... create-e2e-user.mts <password>");

const email = `maestro-${Date.now().toString(36)}@example.test`;
const res = await fetch(`${issuer}/v2/users/human`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({
    username: email,
    profile: { givenName: "Mia", familyName: "Mobil" },
    email: { email, isVerified: true },
    password: { password, changeRequired: false },
  }),
});
if (!res.ok) throw new Error(`Zitadel: HTTP ${res.status} ${await res.text()}`);
console.log(email);
