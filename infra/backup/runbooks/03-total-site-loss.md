# 3. Total loss of the primary site

The servers, disks or the whole provider account are gone. Target: service
back within 4 hours (RTO), losing at most 5 minutes of database writes and
an hour of files.

You need, from outside the lost site: the backup bucket's credentials and
`BACKUP_CIPHER_PASS` (offline copy), the file replica's credentials, the
installation's other secrets (`ZITADEL_MASTERKEY` above all: Zitadel's data
is encrypted with it), and DNS access.

1. **Provision** new infrastructure in another region or at another
   provider (hosted service: the IaC in the private ops repository; placeholder
   until it exists):
   - servers with Docker, the same ClubAdmin release (`git checkout <tag>`);
   - a new files bucket for the application;
   - the installation's settings and secrets (`.env`), with the backup
     settings pointing at the **existing** backup bucket.

2. **Restore the database before PostgreSQL ever starts** (a first start
   would create an empty cluster):

   ```sh
   pnpm ops:restore --yes
   ```

   On a new machine there is nothing to stop; the restore goes into the new,
   empty volume (latest backup and all archived WAL), PostgreSQL starts and
   promotes, the deletion ledger is replayed and a full backup starts the new
   site's backup history.

3. **Restore the files** from the replica into the new files bucket (with
   credentials that can write it):

   ```sh
   docker compose --profile backup run --rm --no-deps backup sh -c '
     export RCLONE_CONFIG_REPLICA_TYPE=s3 RCLONE_CONFIG_REPLICA_PROVIDER=Other \
       RCLONE_CONFIG_REPLICA_ENDPOINT="$FILES_REPLICA_S3_ENDPOINT" \
       RCLONE_CONFIG_REPLICA_ACCESS_KEY_ID="$FILES_REPLICA_S3_ACCESS_KEY_ID" \
       RCLONE_CONFIG_REPLICA_SECRET_ACCESS_KEY="$FILES_REPLICA_S3_SECRET_ACCESS_KEY" \
       RCLONE_CONFIG_TARGET_TYPE=s3 RCLONE_CONFIG_TARGET_PROVIDER=Other \
       RCLONE_CONFIG_TARGET_ENDPOINT="<new files endpoint>" \
       RCLONE_CONFIG_TARGET_ACCESS_KEY_ID="<key>" RCLONE_CONFIG_TARGET_SECRET_ACCESS_KEY="<secret>"
     rclone sync "replica:$FILES_REPLICA_S3_BUCKET" "target:<new files bucket>" --fast-list --checksum'
   ```

   Then point `S3_*` (application) and `FILES_SOURCE_S3_*` at the new bucket.

4. Start everything (`docker compose up -d`, the application), run
   `pnpm auth:configure` if Zitadel's public URL changed.

5. **Switch DNS** to the new site (low TTLs are set in advance). Check
   logins and a few clubs.

6. Ledger and verification: `pnpm ops:restore` replayed the ledger (its
   output lists how many people were erased again). Verify:

   ```sh
   pnpm ops:verify-backup
   ```
