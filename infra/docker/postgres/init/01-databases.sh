#!/bin/sh
# Runs once, when the Postgres data volume is first created.
# Creates the Zitadel role and database and enables pg_stat_statements in the
# application database. Application roles (owner/app/operator) are created by
# `pnpm db:bootstrap` in P0.4, not here.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v zitadel_user="$ZITADEL_DB_USER" -v zitadel_password="$ZITADEL_DB_PASSWORD" <<'SQL'
CREATE ROLE :"zitadel_user" LOGIN PASSWORD :'zitadel_password';
CREATE DATABASE zitadel OWNER :"zitadel_user";
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SQL
