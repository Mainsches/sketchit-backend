-- The backend is the only client of its tables. Supabase grants objects in the
-- public schema to its Data API roles (anon, authenticated, service_role),
-- both directly and through default privileges. This migration removes that
-- access for existing and future objects created by the migrating role, which
-- owns all backend tables. Every statement is idempotent.

-- Row level security without policies hides all rows from roles that are
-- neither the owner nor BYPASSRLS. The owner (the backend) is unaffected
-- because RLS is not forced.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE users, auth_tokens, daily_usage, generations, schema_migrations FROM PUBLIC;

-- New functions are executable by PUBLIC through a built-in global default;
-- a schema-level REVOKE cannot remove it, so it is revoked globally for
-- objects created by this role.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $$
DECLARE
  api_role TEXT;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      -- service_role has BYPASSRLS, so only revoking its grants protects the tables.
      EXECUTE format(
        'REVOKE ALL ON TABLE users, auth_tokens, daily_usage, generations, schema_migrations FROM %I',
        api_role
      );
      -- ALTER DEFAULT PRIVILEGES without FOR ROLE applies to objects created by
      -- the current role. Schema-level and global entries are separate, so both
      -- are revoked.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I',
        current_schema(), api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I',
        current_schema(), api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM %I',
        current_schema(), api_role
      );
      EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
