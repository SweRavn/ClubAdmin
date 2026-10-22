# PostgreSQL with pgBackRest and rclone (docs/operations/backup-restore.md).
# The same image runs the database (archive_command pushes WAL with
# pgBackRest) and the backup sidecar (scheduled backups, file replication,
# deletion-ledger export, restores). Configuration comes from environment
# variables (BACKUP_*, FILES_*), see infra/backup/README.md.
FROM postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873

# pgBackRest and rclone from Alpine's community repository (both MIT).
RUN apk add --no-cache pgbackrest rclone \
  && pgbackrest version && rclone version | head -n 1 \
  && install -d -o postgres -g postgres -m 0750 /var/log/pgbackrest /tmp/pgbackrest

COPY bin/ /usr/local/bin/
RUN chmod 0755 /usr/local/bin/clubadmin-*

# Hash of this directory, set by `pnpm dev:services` to rebuild when it changes.
ARG SOURCE_HASH=unknown
LABEL org.clubadmin.source-hash=$SOURCE_HASH
