# 4. Breach

Someone had unauthorised access to production (servers, database,
credentials). Contain, keep evidence, rebuild clean, restore from **before**
the intrusion, rotate everything. The incident process in docs/security.md
(notification within 72 hours, post-mortem) runs alongside.

1. **Preserve evidence. Do not restore over it.**
   - Snapshot the affected disks or volumes at the provider (or
     `docker run --rm -v clubadmin_postgres-data:/d -v "$PWD":/out alpine tar czf /out/pgdata.tgz -C /d .`).
   - Copy logs (application, Caddy, Zitadel, provider audit logs) and
     `audit.events` / `history.record_changes` to separate storage.
   - Note times, IP addresses, accounts.

2. **Contain:** take the service offline (maintenance page), revoke the
   attacker's access paths you know of, but keep the compromised machines for
   analysis (isolated, not deleted).

3. **Determine the intrusion point** from the audit log, record history,
   access logs and provider logs: the earliest time anything was touched.
   Choose a restore point before it: `T=2026-10-20T00:00:00Z`.

4. **Rebuild clean** infrastructure (new servers, new OS images; runbook 3,
   step 1), never reusing the compromised machines. Use the release you
   trust; check the repository and CI for tampering.

5. **Rotate every secret** before the new site starts (generate new values,
   never reuse):

   | Secret | Notes |
   |---|---|
   | `POSTGRES_PASSWORD`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `DB_OPERATOR_PASSWORD`, `DB_RETENTION_PASSWORD`, `ZITADEL_DB_PASSWORD` | After the restore: `pnpm db:bootstrap` sets the role passwords; Zitadel's with `ALTER ROLE`. |
   | `ENCRYPTION_MASTER_KEYS` | Add a new key first in the list; the data keys are re-wrapped with it (docs/security.md); remove the old key afterwards. |
   | `BLIND_INDEX_KEY` | Changing it requires recomputing the blind indexes; rotate if the key may have leaked. |
   | `SESSION_ENCRYPTION_KEY` | Ends every web session. |
   | `DEV_AUTH_KEY` | Must never be set in production; remove it. |
   | `ZITADEL_MASTERKEY` | Encrypts Zitadel's data and cannot simply be changed: if it leaked, set up a new Zitadel instance and migrate users (see the Zitadel documentation). |
   | `ZITADEL_ADMIN_PASSWORD`, `ZITADEL_LOGIN_COOKIE_SECRET`, `ZITADEL_API_TOKEN` (and the machine user's other keys) | In Zitadel: new password, remove old PATs and keys, then `pnpm auth:configure`. |
   | `AUTH_WEB_CLIENT_SECRET` | Regenerate in Zitadel (`pnpm auth:configure`). |
   | Zitadel signing keys | Instance settings → keys: create new, remove the old ones: all issued access and ID tokens become invalid. |
   | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | New application key; delete the old one. |
   | `BACKUP_S3_*`, `FILES_SOURCE_S3_*`, `FILES_REPLICA_S3_*` | New keys at the backup provider; delete the old ones after the restore. |
   | `BACKUP_CIPHER_PASS` | New repositories with a new passphrase (`BACKUP_PATH`), see infra/backup/README.md; keep the old one only to read the old backups. |
   | `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` | If Garage is used. |
   | `SMTP_PASSWORD`, Valkey password (if any), CI and deployment secrets, provider API tokens, SSH keys | Everything the attacker could have read. |

6. **Restore from before the intrusion** on the new site (the backups are
   immutable, so the attacker could not change them):

   ```sh
   pnpm ops:restore --time "$T" --yes
   ```

   It replays the deletion ledger (people erased after `T` stay erased). Data
   written between `T` and the breach is lost unless it can be re-entered
   from trusted sources (not from the compromised database).

7. **Force everyone to log in again:** the new `SESSION_ENCRYPTION_KEY` ends
   web sessions; the new signing keys invalidate tokens; end all Zitadel
   sessions (console or API) so refresh tokens of the mobile app stop
   working; tell users to change their passwords if credentials may have
   leaked.

8. Files: restore from the replica (runbook 3, step 3) if the files bucket
   may have been altered; the replica's versioning keeps the state before `T`.

9. Ledger and verification:

   ```sh
   pnpm ops:verify-backup
   ```

   Then bring the service back, monitor closely, and publish the
   post-mortem to the affected clubs.
