#!/bin/bash
# Local Postgres 18 that behaves like Neon for RLS purposes (DATA-MODEL.md §4.1, §8):
#  - `neon_superuser`: NOLOGIN, BYPASSRLS, CREATEDB, CREATEROLE (as on Neon).
#  - `neondb_owner`: a NON-superuser member of neon_superuser that owns the app databases,
#    exactly like the role the Vercel–Neon integration injects. Migrations run as this role.
#  - Databases: `edf` (development) and `edf_test` (the test suite recreates it).
# Development-only credentials; production uses Neon's own roles and secrets.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-'SQL'
  CREATE ROLE neon_superuser NOLOGIN BYPASSRLS CREATEDB CREATEROLE;
  CREATE ROLE neondb_owner LOGIN PASSWORD 'owner' BYPASSRLS CREATEDB CREATEROLE IN ROLE neon_superuser;
  CREATE DATABASE edf OWNER neondb_owner;
  CREATE DATABASE edf_test OWNER neondb_owner;
  REVOKE ALL ON DATABASE edf, edf_test FROM PUBLIC;
  GRANT CONNECT, TEMPORARY ON DATABASE edf, edf_test TO neondb_owner;
SQL
