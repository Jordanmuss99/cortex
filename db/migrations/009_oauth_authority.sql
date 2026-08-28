-- OAuth authority for the hosted Cortex gateway.
--
-- This migration is additive. PostgreSQL becomes the sole live authority for
-- OAuth principals, agent bindings, grants, browser sessions, and revocation.

CREATE TYPE public.oauth_scope AS ENUM (
  'cortex:read',
  'cortex:write',
  'mcp'
);

CREATE TYPE public.oauth_principal_status AS ENUM ('active', 'disabled');
CREATE TYPE public.oauth_binding_status AS ENUM ('active', 'revoked');
CREATE TYPE public.oauth_client_status AS ENUM ('active', 'disabled');
CREATE TYPE public.oauth_client_kind AS ENUM ('dynamic', 'static', 'legacy');
CREATE TYPE public.oauth_token_endpoint_auth_method AS ENUM (
  'none',
  'client_secret_basic',
  'client_secret_post'
);
CREATE TYPE public.oauth_grant_status AS ENUM (
  'active',
  'revoked',
  'expired',
  'superseded'
);
CREATE TYPE public.oauth_refresh_kind AS ENUM ('v2', 'legacy');
CREATE TYPE public.oauth_audit_actor_type AS ENUM (
  'connector',
  'browser',
  'operator',
  'migration',
  'system'
);
CREATE TYPE public.oauth_state_migration_outcome AS ENUM (
  'imported',
  'fresh_install'
);

CREATE FUNCTION public.oauth_redirect_uris_are_canonical(p_redirect_uris text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT
    pg_catalog.array_ndims(p_redirect_uris) = 1
    AND pg_catalog.cardinality(p_redirect_uris) BETWEEN 1 AND 5
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(p_redirect_uris) AS redirect(uri)
      WHERE redirect.uri IS NULL
        OR redirect.uri <> pg_catalog.btrim(redirect.uri)
        OR pg_catalog.length(redirect.uri) NOT BETWEEN 1 AND 2048
    )
    AND pg_catalog.cardinality(p_redirect_uris) = (
      SELECT pg_catalog.count(DISTINCT redirect.uri)
      FROM pg_catalog.unnest(p_redirect_uris) AS redirect(uri)
    )
$function$;

-- Audit metadata is deliberately a small, scalar-only vocabulary. This keeps
-- the append-only security log from becoming an accidental bearer, identifier,
-- or arbitrary-document store while retaining the fixed operational counters
-- used by migration, operator, surface, and lifecycle events.
CREATE FUNCTION public.oauth_audit_metadata_is_safe(p_metadata jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT
    pg_catalog.jsonb_typeof(p_metadata) = 'object'
    AND (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.jsonb_each(p_metadata)
    ) <= 16
    AND pg_catalog.octet_length(p_metadata::text) <= 4096
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_each(p_metadata) AS entry(key, value)
      WHERE entry.key <> ALL (ARRAY[
          'actor',
          'reason',
          'surface',
          'sourceVersion',
          'version',
          'generation',
          'source_generation',
          'presented_generation',
          'current_generation',
          'replacement_generation',
          'token_use',
          'clientsImported',
          'clientsExisting',
          'codesImported',
          'codesExpired',
          'principal_count',
          'grant_count',
          'code_count',
          'session_count',
          'audit_event_count',
          'authorization_code_count',
          'refresh_token_count',
          'login_session_count'
        ]::text[])
        OR pg_catalog.jsonb_typeof(entry.value) NOT IN (
          'string', 'number', 'boolean', 'null'
        )
        OR (
          pg_catalog.jsonb_typeof(entry.value) = 'string'
          AND pg_catalog.octet_length(entry.value #>> '{}') > 1024
        )
        OR (
          pg_catalog.jsonb_typeof(entry.value) = 'number'
          AND entry.value::text !~ '^-?(0|[1-9][0-9]{0,9})$'
        )
    )
$function$;

CREATE TABLE public.oauth_principals (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  status public.oauth_principal_status NOT NULL DEFAULT 'active',
  authentication_epoch integer NOT NULL DEFAULT 0,
  legacy_not_before timestamptz NOT NULL DEFAULT 'epoch'::timestamptz,
  disabled_at timestamptz,
  disabled_reason text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT oauth_principals_identity_key UNIQUE (issuer, subject),
  CONSTRAINT oauth_principals_issuer_check
    CHECK (issuer = pg_catalog.btrim(issuer) AND pg_catalog.length(issuer) BETWEEN 1 AND 2048),
  CONSTRAINT oauth_principals_subject_check
    CHECK (subject = pg_catalog.btrim(subject) AND pg_catalog.length(subject) BETWEEN 1 AND 512),
  CONSTRAINT oauth_principals_authentication_epoch_check
    CHECK (authentication_epoch >= 0),
  CONSTRAINT oauth_principals_disabled_state_check CHECK (
    (status = 'active' AND disabled_at IS NULL AND disabled_reason IS NULL)
    OR
    (
      status = 'disabled'
      AND disabled_at IS NOT NULL
      AND disabled_reason IS NOT NULL
      AND disabled_reason = pg_catalog.btrim(disabled_reason)
      AND pg_catalog.length(disabled_reason) BETWEEN 1 AND 1024
    )
  )
);

CREATE TABLE public.oauth_agent_bindings (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES public.oauth_principals(id),
  agent_id integer NOT NULL REFERENCES public.agents(id),
  status public.oauth_binding_status NOT NULL DEFAULT 'active',
  is_default boolean NOT NULL DEFAULT false,
  binding_version integer NOT NULL DEFAULT 1,
  allowed_scopes public.oauth_scope[] NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT oauth_agent_bindings_principal_agent_key UNIQUE (principal_id, agent_id),
  CONSTRAINT oauth_agent_bindings_id_principal_key UNIQUE (id, principal_id),
  CONSTRAINT oauth_agent_bindings_agent_id_check CHECK (agent_id > 0),
  CONSTRAINT oauth_agent_bindings_version_check CHECK (binding_version >= 1),
  CONSTRAINT oauth_agent_bindings_scopes_check CHECK (
    allowed_scopes IN (
      ARRAY['cortex:read']::public.oauth_scope[],
      ARRAY['cortex:write']::public.oauth_scope[],
      ARRAY['mcp']::public.oauth_scope[],
      ARRAY['cortex:read', 'cortex:write']::public.oauth_scope[],
      ARRAY['cortex:read', 'mcp']::public.oauth_scope[],
      ARRAY['cortex:write', 'mcp']::public.oauth_scope[],
      ARRAY['cortex:read', 'cortex:write', 'mcp']::public.oauth_scope[]
    )
  ),
  CONSTRAINT oauth_agent_bindings_revoked_state_check CHECK (
    (
      status = 'active'
      AND revoked_at IS NULL
      AND revoked_reason IS NULL
    )
    OR
    (
      status = 'revoked'
      AND is_default = false
      AND revoked_at IS NOT NULL
      AND revoked_reason IS NOT NULL
      AND revoked_reason = pg_catalog.btrim(revoked_reason)
      AND pg_catalog.length(revoked_reason) BETWEEN 1 AND 1024
    )
  )
);

CREATE UNIQUE INDEX oauth_agent_bindings_one_active_default_idx
  ON public.oauth_agent_bindings (principal_id)
  WHERE status = 'active' AND is_default;

CREATE INDEX oauth_agent_bindings_live_lookup_idx
  ON public.oauth_agent_bindings (principal_id, status, is_default);

CREATE INDEX oauth_agent_bindings_agent_idx
  ON public.oauth_agent_bindings (agent_id);

CREATE TABLE public.oauth_clients (
  id uuid PRIMARY KEY,
  client_id text NOT NULL,
  client_kind public.oauth_client_kind NOT NULL,
  redirect_uris text[] NOT NULL,
  client_name text,
  token_endpoint_auth_method public.oauth_token_endpoint_auth_method NOT NULL,
  status public.oauth_client_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT oauth_clients_client_id_key UNIQUE (client_id),
  CONSTRAINT oauth_clients_client_id_check
    CHECK (client_id = pg_catalog.btrim(client_id) AND pg_catalog.length(client_id) BETWEEN 1 AND 512),
  CONSTRAINT oauth_clients_redirect_uris_check CHECK (
    public.oauth_redirect_uris_are_canonical(redirect_uris)
  ),
  CONSTRAINT oauth_clients_dynamic_auth_method_check CHECK (
    client_kind <> 'dynamic' OR token_endpoint_auth_method = 'none'
  ),
  CONSTRAINT oauth_clients_client_name_check CHECK (
    client_name IS NULL
    OR (
      client_name = pg_catalog.btrim(client_name)
      AND pg_catalog.length(client_name) BETWEEN 1 AND 200
    )
  )
);

CREATE TABLE public.oauth_authorization_codes (
  id uuid PRIMARY KEY,
  code_digest bytea NOT NULL,
  oauth_client_id uuid NOT NULL REFERENCES public.oauth_clients(id),
  principal_id uuid NOT NULL REFERENCES public.oauth_principals(id),
  binding_id uuid NOT NULL REFERENCES public.oauth_agent_bindings(id),
  authentication_epoch integer NOT NULL,
  binding_version integer NOT NULL,
  redirect_uri text NOT NULL,
  scopes public.oauth_scope[] NOT NULL,
  code_challenge text NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT oauth_authorization_codes_digest_key UNIQUE (code_digest),
  CONSTRAINT oauth_authorization_codes_digest_check
    CHECK (pg_catalog.octet_length(code_digest) = 32),
  CONSTRAINT oauth_authorization_codes_authentication_epoch_check
    CHECK (authentication_epoch >= 0),
  CONSTRAINT oauth_authorization_codes_binding_version_check
    CHECK (binding_version >= 1),
  CONSTRAINT oauth_authorization_codes_redirect_uri_check
    CHECK (redirect_uri = pg_catalog.btrim(redirect_uri) AND pg_catalog.length(redirect_uri) BETWEEN 1 AND 2048),
  CONSTRAINT oauth_authorization_codes_scopes_check CHECK (
    scopes IN (
      ARRAY['cortex:read']::public.oauth_scope[],
      ARRAY['cortex:write']::public.oauth_scope[],
      ARRAY['mcp']::public.oauth_scope[],
      ARRAY['cortex:read', 'cortex:write']::public.oauth_scope[],
      ARRAY['cortex:read', 'mcp']::public.oauth_scope[],
      ARRAY['cortex:write', 'mcp']::public.oauth_scope[],
      ARRAY['cortex:read', 'cortex:write', 'mcp']::public.oauth_scope[]
    )
  ),
  CONSTRAINT oauth_authorization_codes_challenge_check
    CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT oauth_authorization_codes_resource_check
    CHECK (resource = pg_catalog.btrim(resource) AND pg_catalog.length(resource) BETWEEN 1 AND 2048),
  CONSTRAINT oauth_authorization_codes_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT oauth_authorization_codes_consumed_check
    CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CONSTRAINT oauth_authorization_codes_binding_principal_fkey
    FOREIGN KEY (binding_id, principal_id)
    REFERENCES public.oauth_agent_bindings(id, principal_id)
);

CREATE INDEX oauth_authorization_codes_expiry_idx
  ON public.oauth_authorization_codes (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX oauth_authorization_codes_client_idx
  ON public.oauth_authorization_codes (oauth_client_id);

CREATE TABLE public.oauth_grants (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES public.oauth_principals(id),
  binding_id uuid NOT NULL REFERENCES public.oauth_agent_bindings(id),
  oauth_client_id uuid NOT NULL REFERENCES public.oauth_clients(id),
  resource text NOT NULL,
  scopes public.oauth_scope[] NOT NULL,
  authentication_epoch integer NOT NULL,
  binding_version integer NOT NULL,
  status public.oauth_grant_status NOT NULL DEFAULT 'active',
  current_refresh_generation integer NOT NULL DEFAULT 0,
  inactivity_expires_at timestamptz NOT NULL,
  legacy_tuple_digest bytea,
  refreshed_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  superseded_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT oauth_grants_authentication_epoch_check CHECK (authentication_epoch >= 0),
  CONSTRAINT oauth_grants_binding_version_check CHECK (binding_version >= 1),
  CONSTRAINT oauth_grants_refresh_generation_check CHECK (current_refresh_generation >= 0),
  CONSTRAINT oauth_grants_resource_check
    CHECK (resource = pg_catalog.btrim(resource) AND pg_catalog.length(resource) BETWEEN 1 AND 2048),
  CONSTRAINT oauth_grants_scopes_check CHECK (
    scopes IN (
      ARRAY['cortex:read']::public.oauth_scope[],
      ARRAY['cortex:write']::public.oauth_scope[],
      ARRAY['mcp']::public.oauth_scope[],
      ARRAY['cortex:read', 'cortex:write']::public.oauth_scope[],
      ARRAY['cortex:read', 'mcp']::public.oauth_scope[],
      ARRAY['cortex:write', 'mcp']::public.oauth_scope[],
      ARRAY['cortex:read', 'cortex:write', 'mcp']::public.oauth_scope[]
    )
  ),
  CONSTRAINT oauth_grants_inactivity_expiry_check
    CHECK (inactivity_expires_at > created_at),
  CONSTRAINT oauth_grants_legacy_tuple_digest_check
    CHECK (legacy_tuple_digest IS NULL OR pg_catalog.octet_length(legacy_tuple_digest) = 32),
  CONSTRAINT oauth_grants_refreshed_at_check
    CHECK (refreshed_at IS NULL OR refreshed_at >= created_at),
  CONSTRAINT oauth_grants_binding_principal_fkey
    FOREIGN KEY (binding_id, principal_id)
    REFERENCES public.oauth_agent_bindings(id, principal_id),
  CONSTRAINT oauth_grants_superseded_by_fkey
    FOREIGN KEY (superseded_by)
    REFERENCES public.oauth_grants(id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT oauth_grants_terminal_state_check CHECK (
    (
      status IN ('active', 'expired')
      AND revoked_at IS NULL
      AND revoked_reason IS NULL
      AND superseded_by IS NULL
    )
    OR
    (
      status = 'revoked'
      AND revoked_at IS NOT NULL
      AND revoked_reason IS NOT NULL
      AND revoked_reason = pg_catalog.btrim(revoked_reason)
      AND pg_catalog.length(revoked_reason) BETWEEN 1 AND 1024
      AND superseded_by IS NULL
    )
    OR
    (
      status = 'superseded'
      AND superseded_by IS NOT NULL
      AND superseded_by <> id
      AND revoked_at IS NULL
      AND revoked_reason IS NULL
    )
  )
);

CREATE UNIQUE INDEX oauth_grants_one_active_tuple_idx
  ON public.oauth_grants (principal_id, binding_id, oauth_client_id, resource)
  WHERE status = 'active';

CREATE UNIQUE INDEX oauth_grants_legacy_tuple_digest_idx
  ON public.oauth_grants (legacy_tuple_digest)
  WHERE legacy_tuple_digest IS NOT NULL;

CREATE INDEX oauth_grants_live_lookup_idx
  ON public.oauth_grants (id, status, inactivity_expires_at);

CREATE INDEX oauth_grants_principal_status_idx
  ON public.oauth_grants (principal_id, status);

CREATE INDEX oauth_grants_binding_status_idx
  ON public.oauth_grants (binding_id, status);

CREATE INDEX oauth_grants_client_status_idx
  ON public.oauth_grants (oauth_client_id, status);

CREATE TABLE public.oauth_refresh_tokens (
  id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES public.oauth_grants(id) ON DELETE CASCADE,
  generation integer NOT NULL,
  kind public.oauth_refresh_kind NOT NULL,
  jti_digest bytea NOT NULL,
  reconstruction_nonce bytea,
  effective_scopes public.oauth_scope[] NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  replacement_generation integer,
  retry_deadline timestamptz,
  request_fingerprint bytea,
  CONSTRAINT oauth_refresh_tokens_grant_generation_key UNIQUE (grant_id, generation),
  CONSTRAINT oauth_refresh_tokens_grant_jti_key UNIQUE (grant_id, jti_digest),
  CONSTRAINT oauth_refresh_tokens_generation_check CHECK (generation >= -1),
  CONSTRAINT oauth_refresh_tokens_kind_generation_check CHECK (
    (
      kind = 'legacy'
      AND generation = -1
      AND reconstruction_nonce IS NULL
      AND consumed_at IS NOT NULL
      AND replacement_generation = 0
      AND retry_deadline IS NOT NULL
      AND request_fingerprint IS NOT NULL
    )
    OR
    (
      kind = 'v2'
      AND generation >= 0
      AND reconstruction_nonce IS NOT NULL
      AND pg_catalog.octet_length(reconstruction_nonce) = 32
    )
  ),
  CONSTRAINT oauth_refresh_tokens_jti_digest_check
    CHECK (pg_catalog.octet_length(jti_digest) = 32),
  CONSTRAINT oauth_refresh_tokens_scopes_check CHECK (
    effective_scopes IN (
      ARRAY['cortex:read']::public.oauth_scope[],
      ARRAY['cortex:write']::public.oauth_scope[],
      ARRAY['mcp']::public.oauth_scope[],
      ARRAY['cortex:read', 'cortex:write']::public.oauth_scope[],
      ARRAY['cortex:read', 'mcp']::public.oauth_scope[],
      ARRAY['cortex:write', 'mcp']::public.oauth_scope[],
      ARRAY['cortex:read', 'cortex:write', 'mcp']::public.oauth_scope[]
    )
  ),
  CONSTRAINT oauth_refresh_tokens_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT oauth_refresh_tokens_consumption_check CHECK (
    (
      consumed_at IS NULL
      AND replacement_generation IS NULL
      AND retry_deadline IS NULL
      AND request_fingerprint IS NULL
    )
    OR
    (
      consumed_at IS NOT NULL
      AND consumed_at >= issued_at
      AND replacement_generation = generation + 1
      AND retry_deadline IS NOT NULL
      AND retry_deadline >= consumed_at
      AND request_fingerprint IS NOT NULL
      AND pg_catalog.octet_length(request_fingerprint) = 32
    )
  )
);

CREATE INDEX oauth_refresh_tokens_expiry_idx
  ON public.oauth_refresh_tokens (expires_at);

CREATE TABLE public.oauth_login_sessions (
  id uuid PRIMARY KEY,
  session_digest bytea NOT NULL,
  legacy_cookie_digest bytea,
  principal_id uuid NOT NULL REFERENCES public.oauth_principals(id) ON DELETE CASCADE,
  ip_fingerprint bytea NOT NULL,
  authentication_epoch integer NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT oauth_login_sessions_digest_key UNIQUE (session_digest),
  CONSTRAINT oauth_login_sessions_session_digest_check
    CHECK (pg_catalog.octet_length(session_digest) = 32),
  CONSTRAINT oauth_login_sessions_legacy_digest_check
    CHECK (legacy_cookie_digest IS NULL OR pg_catalog.octet_length(legacy_cookie_digest) = 32),
  CONSTRAINT oauth_login_sessions_ip_fingerprint_check
    CHECK (pg_catalog.octet_length(ip_fingerprint) = 32),
  CONSTRAINT oauth_login_sessions_authentication_epoch_check
    CHECK (authentication_epoch >= 0),
  CONSTRAINT oauth_login_sessions_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT oauth_login_sessions_revoked_state_check CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR
    (
      revoked_at IS NOT NULL
      AND revoked_at >= issued_at
      AND revoked_reason IS NOT NULL
      AND revoked_reason = pg_catalog.btrim(revoked_reason)
      AND pg_catalog.length(revoked_reason) BETWEEN 1 AND 1024
    )
  )
);

CREATE UNIQUE INDEX oauth_login_sessions_legacy_cookie_digest_idx
  ON public.oauth_login_sessions (legacy_cookie_digest)
  WHERE legacy_cookie_digest IS NOT NULL;

CREATE INDEX oauth_login_sessions_principal_expiry_idx
  ON public.oauth_login_sessions (principal_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE public.oauth_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  outcome text NOT NULL,
  principal_id uuid REFERENCES public.oauth_principals(id) ON DELETE SET NULL,
  binding_id uuid REFERENCES public.oauth_agent_bindings(id) ON DELETE SET NULL,
  grant_id uuid REFERENCES public.oauth_grants(id) ON DELETE RESTRICT,
  oauth_client_id uuid REFERENCES public.oauth_clients(id) ON DELETE SET NULL,
  request_id text NOT NULL,
  actor_type public.oauth_audit_actor_type NOT NULL,
  ip_fingerprint bytea,
  user_agent_fingerprint bytea,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT oauth_audit_events_event_type_check
    CHECK (event_type = pg_catalog.btrim(event_type) AND pg_catalog.length(event_type) BETWEEN 1 AND 128),
  CONSTRAINT oauth_audit_events_outcome_check
    CHECK (outcome = pg_catalog.btrim(outcome) AND pg_catalog.length(outcome) BETWEEN 1 AND 64),
  CONSTRAINT oauth_audit_events_request_id_check
    CHECK (request_id = pg_catalog.btrim(request_id) AND pg_catalog.length(request_id) BETWEEN 1 AND 128),
  CONSTRAINT oauth_audit_events_ip_fingerprint_check
    CHECK (ip_fingerprint IS NULL OR pg_catalog.octet_length(ip_fingerprint) = 32),
  CONSTRAINT oauth_audit_events_user_agent_fingerprint_check
    CHECK (user_agent_fingerprint IS NULL OR pg_catalog.octet_length(user_agent_fingerprint) = 32),
  CONSTRAINT oauth_audit_events_metadata_check
    CHECK (public.oauth_audit_metadata_is_safe(metadata))
);

CREATE INDEX oauth_audit_events_created_at_idx
  ON public.oauth_audit_events (created_at);

CREATE INDEX oauth_audit_events_principal_created_idx
  ON public.oauth_audit_events (principal_id, created_at);

CREATE INDEX oauth_audit_events_grant_created_idx
  ON public.oauth_audit_events (grant_id, created_at);

CREATE TABLE public.oauth_state_migrations (
  id uuid PRIMARY KEY,
  version text NOT NULL,
  source_checksum bytea NOT NULL,
  outcome public.oauth_state_migration_outcome NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  report jsonb NOT NULL,
  CONSTRAINT oauth_state_migrations_version_key UNIQUE (version),
  CONSTRAINT oauth_state_migrations_version_check
    CHECK (version = pg_catalog.btrim(version) AND pg_catalog.length(version) BETWEEN 1 AND 128),
  CONSTRAINT oauth_state_migrations_checksum_check
    CHECK (pg_catalog.octet_length(source_checksum) = 32),
  CONSTRAINT oauth_state_migrations_time_check CHECK (completed_at >= started_at),
  CONSTRAINT oauth_state_migrations_report_check CHECK (
    pg_catalog.jsonb_typeof(report) = 'object'
    AND pg_catalog.octet_length(report::text) <= 4096
  )
);

-- Column-scoped UPDATE privileges intentionally do not authorize PostgreSQL's
-- stronger table-lock modes. These narrowly scoped helpers preserve the
-- gateway's existing authorization/session serialization while exposing no
-- owner DML capability. Locks live until the caller's transaction ends.
CREATE FUNCTION public.oauth_lock_authorization_codes()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  LOCK TABLE public.oauth_authorization_codes IN SHARE ROW EXCLUSIVE MODE;
END
$function$;

CREATE FUNCTION public.oauth_lock_login_sessions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  LOCK TABLE public.oauth_login_sessions IN SHARE ROW EXCLUSIVE MODE;
END
$function$;

-- Capability roles are deliberately separate from secret-managed LOGIN roles.
DO $roles$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname IN (
      'cortex_oauth_runtime',
      'cortex_oauth_operator',
      'cortex_oauth_gateway',
      'cortex_oauth_operator_user'
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'protected OAuth roles must not preexist migration 009';
  END IF;

  CREATE ROLE cortex_oauth_runtime NOLOGIN;
  CREATE ROLE cortex_oauth_operator NOLOGIN;
END
$roles$;

ALTER ROLE cortex_oauth_runtime
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE cortex_oauth_operator
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

CREATE VIEW public.oauth_operator_grants
WITH (security_barrier = true)
AS
SELECT
  grant_row.id AS grant_id,
  principal.issuer,
  principal.subject,
  grant_row.binding_id,
  agent.external_id AS agent_external_id,
  client.client_id,
  grant_row.resource,
  grant_row.scopes,
  grant_row.status,
  grant_row.current_refresh_generation,
  grant_row.inactivity_expires_at,
  grant_row.refreshed_at,
  grant_row.revoked_at,
  grant_row.revoked_reason,
  grant_row.superseded_by,
  grant_row.created_at,
  grant_row.updated_at
FROM public.oauth_grants AS grant_row
JOIN public.oauth_principals AS principal ON principal.id = grant_row.principal_id
JOIN public.oauth_agent_bindings AS binding ON binding.id = grant_row.binding_id
JOIN public.agents AS agent ON agent.id = binding.agent_id
JOIN public.oauth_clients AS client ON client.id = grant_row.oauth_client_id;

CREATE VIEW public.oauth_operator_principals
WITH (security_barrier = true)
AS
SELECT
  principal.id AS principal_id,
  principal.issuer,
  principal.subject,
  principal.status,
  principal.authentication_epoch,
  principal.legacy_not_before,
  principal.disabled_at,
  principal.disabled_reason,
  principal.created_at,
  principal.updated_at,
  pg_catalog.count(DISTINCT binding.id) FILTER (WHERE binding.status = 'active') AS active_binding_count,
  pg_catalog.count(DISTINCT grant_row.id) FILTER (WHERE grant_row.status = 'active') AS active_grant_count
FROM public.oauth_principals AS principal
LEFT JOIN public.oauth_agent_bindings AS binding ON binding.principal_id = principal.id
LEFT JOIN public.oauth_grants AS grant_row ON grant_row.principal_id = principal.id
GROUP BY principal.id;

CREATE VIEW public.oauth_operator_bindings
WITH (security_barrier = true)
AS
SELECT
  binding.id AS binding_id,
  principal.issuer,
  principal.subject,
  agent.external_id AS agent_external_id,
  binding.status,
  binding.is_default,
  binding.binding_version,
  binding.allowed_scopes,
  binding.revoked_at,
  binding.revoked_reason,
  binding.created_at,
  binding.updated_at,
  pg_catalog.count(grant_row.id) FILTER (WHERE grant_row.status = 'active') AS active_grant_count
FROM public.oauth_agent_bindings AS binding
JOIN public.oauth_principals AS principal ON principal.id = binding.principal_id
JOIN public.agents AS agent ON agent.id = binding.agent_id
LEFT JOIN public.oauth_grants AS grant_row ON grant_row.binding_id = binding.id
GROUP BY binding.id, principal.id, agent.id;

CREATE VIEW public.oauth_operator_rollout_status
WITH (security_barrier = true)
AS
SELECT
  state.version AS state_version,
  state.outcome AS state_outcome,
  state.started_at AS state_started_at,
  state.completed_at AS state_completed_at,
  state.report AS state_report,
  (SELECT pg_catalog.count(*) FROM public.oauth_principals) AS principal_count,
  (SELECT pg_catalog.count(*) FROM public.oauth_agent_bindings WHERE status = 'active') AS active_binding_count,
  (SELECT pg_catalog.count(*) FROM public.oauth_clients WHERE status = 'active') AS active_client_count,
  (SELECT pg_catalog.count(*) FROM public.oauth_grants WHERE status = 'active') AS active_grant_count
FROM (SELECT 1) AS anchor
LEFT JOIN LATERAL (
  SELECT migration.version, migration.outcome, migration.started_at, migration.completed_at, migration.report
  FROM public.oauth_state_migrations AS migration
  ORDER BY migration.completed_at DESC, migration.version DESC
  LIMIT 1
) AS state ON true;

CREATE FUNCTION public.oauth_operator_revoke_grant(
  p_grant_id uuid,
  p_actor text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz;
  v_status public.oauth_grant_status;
  v_matched boolean := false;
  v_changed boolean := false;
BEGIN
  IF p_grant_id IS NULL
    OR p_actor IS NULL
    OR pg_catalog.btrim(p_actor) = ''
    OR pg_catalog.length(p_actor) > 256
    OR p_reason IS NULL
    OR pg_catalog.btrim(p_reason) = ''
    OR pg_catalog.length(p_reason) > 1024
    OR pg_catalog.octet_length(
      pg_catalog.jsonb_build_object(
        'actor', pg_catalog.btrim(p_actor),
        'reason', pg_catalog.btrim(p_reason)
      )::text
    ) > 4096
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'grant id, actor, and reason are required';
  END IF;

  -- Refresh and explicit-revocation paths share grant -> refresh lock order.
  SELECT grant_row.status INTO v_status
  FROM public.oauth_grants AS grant_row
  WHERE grant_row.id = p_grant_id
  FOR UPDATE;
  v_matched := FOUND;

  -- A contender may have waited on the grant. One post-lock database clock
  -- drives the mutation, descriptor clipping, and audit chronology.
  v_now := pg_catalog.clock_timestamp();

  IF v_matched AND v_status = 'active' THEN
    UPDATE public.oauth_grants
    SET status = 'revoked',
        revoked_at = v_now,
        revoked_reason = pg_catalog.btrim(p_reason),
        updated_at = v_now
    WHERE id = p_grant_id;
    v_changed := true;
  END IF;

  IF v_changed THEN
    UPDATE public.oauth_refresh_tokens
    SET expires_at = GREATEST(
      issued_at + INTERVAL '1 microsecond',
      LEAST(expires_at, v_now)
    )
    WHERE grant_id = p_grant_id
      AND expires_at > v_now;
  END IF;

  -- Keep this event grant-only. Acquiring client/principal/binding FK locks
  -- after the family lock would reverse authorization exchange lock order.
  INSERT INTO public.oauth_audit_events (
    id, event_type, outcome, grant_id, request_id, actor_type, metadata, created_at
  ) VALUES (
    pg_catalog.gen_random_uuid(),
    'operator_grant_revoke',
    CASE WHEN NOT v_matched THEN 'not_found' WHEN v_changed THEN 'revoked' ELSE 'no_change' END,
    CASE WHEN v_matched THEN p_grant_id ELSE NULL END,
    'operator-' || pg_catalog.gen_random_uuid()::text,
    'operator',
    pg_catalog.jsonb_build_object('actor', pg_catalog.btrim(p_actor), 'reason', pg_catalog.btrim(p_reason)),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'matched', v_matched,
    'changed', v_changed,
    'grant_id', CASE WHEN v_matched THEN p_grant_id ELSE NULL END
  );
END
$function$;

CREATE FUNCTION public.oauth_operator_revoke_all_for_principal(
  p_issuer text,
  p_subject text,
  p_actor text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz;
  v_principal_id uuid;
  v_grant_count integer := 0;
  v_code_count integer := 0;
BEGIN
  IF p_issuer IS NULL OR pg_catalog.btrim(p_issuer) = '' OR pg_catalog.length(p_issuer) > 2048
    OR p_subject IS NULL OR pg_catalog.btrim(p_subject) = '' OR pg_catalog.length(p_subject) > 512
    OR p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' OR pg_catalog.length(p_actor) > 256
    OR p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' OR pg_catalog.length(p_reason) > 1024
    OR pg_catalog.octet_length(
      pg_catalog.jsonb_build_object(
        'actor', pg_catalog.btrim(p_actor),
        'reason', pg_catalog.btrim(p_reason),
        'grant_count', 2147483647,
        'code_count', 2147483647
      )::text
    ) > 4096
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'issuer, subject, actor, and reason are required';
  END IF;

  -- createAuthorization takes SHARE ROW EXCLUSIVE before it reads authority.
  -- Taking ROW EXCLUSIVE first orders code creation around this sweep while
  -- remaining compatible with an exchange already holding a code row.
  LOCK TABLE public.oauth_authorization_codes IN ROW EXCLUSIVE MODE;

  SELECT principal.id INTO v_principal_id
  FROM public.oauth_principals AS principal
  WHERE principal.issuer = pg_catalog.btrim(p_issuer)
    AND principal.subject = pg_catalog.btrim(p_subject)
  FOR NO KEY UPDATE;

  IF FOUND THEN
    -- Exchange locks code before grant. Lock the same rows in that order and
    -- use deterministic UUID order for multi-row operator actions.
    PERFORM authorization_code.id
    FROM public.oauth_authorization_codes AS authorization_code
    WHERE authorization_code.principal_id = v_principal_id
      AND authorization_code.consumed_at IS NULL
    ORDER BY authorization_code.id
    FOR UPDATE OF authorization_code;

    PERFORM grant_row.id
    FROM public.oauth_grants AS grant_row
    WHERE grant_row.principal_id = v_principal_id
    ORDER BY grant_row.id
    FOR UPDATE OF grant_row;

    v_now := pg_catalog.clock_timestamp();

    UPDATE public.oauth_authorization_codes
    SET consumed_at = GREATEST(v_now, created_at)
    WHERE principal_id = v_principal_id
      AND consumed_at IS NULL;
    GET DIAGNOSTICS v_code_count = ROW_COUNT;

    UPDATE public.oauth_grants
    SET status = 'revoked',
        revoked_at = v_now,
        revoked_reason = pg_catalog.btrim(p_reason),
        updated_at = v_now
    WHERE principal_id = v_principal_id AND status = 'active';
    GET DIAGNOSTICS v_grant_count = ROW_COUNT;

    UPDATE public.oauth_refresh_tokens AS refresh
    SET expires_at = GREATEST(
      refresh.issued_at + INTERVAL '1 microsecond',
      LEAST(refresh.expires_at, v_now)
    )
    WHERE refresh.grant_id IN (
      SELECT grant_row.id FROM public.oauth_grants AS grant_row
      WHERE grant_row.principal_id = v_principal_id
    ) AND refresh.expires_at > v_now;
  ELSE
    v_now := pg_catalog.clock_timestamp();
  END IF;

  INSERT INTO public.oauth_audit_events (
    id, event_type, outcome, principal_id, request_id, actor_type, metadata, created_at
  ) VALUES (
    pg_catalog.gen_random_uuid(),
    'operator_principal_revoke_all',
    CASE
      WHEN v_principal_id IS NULL THEN 'not_found'
      WHEN v_grant_count > 0 OR v_code_count > 0 THEN 'revoked'
      ELSE 'no_change'
    END,
    v_principal_id,
    'operator-' || pg_catalog.gen_random_uuid()::text,
    'operator',
    pg_catalog.jsonb_build_object(
      'actor', pg_catalog.btrim(p_actor),
      'reason', pg_catalog.btrim(p_reason),
      'grant_count', v_grant_count,
      'code_count', v_code_count
    ),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'matched', v_principal_id IS NOT NULL,
    'changed', v_grant_count > 0 OR v_code_count > 0,
    'grant_count', v_grant_count,
    'code_count', v_code_count
  );
END
$function$;

CREATE FUNCTION public.oauth_operator_disable_principal(
  p_issuer text,
  p_subject text,
  p_actor text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz;
  v_principal_id uuid;
  v_was_active boolean := false;
  v_grant_count integer := 0;
  v_code_count integer := 0;
  v_session_count integer := 0;
  v_changed boolean := false;
BEGIN
  IF p_issuer IS NULL OR pg_catalog.btrim(p_issuer) = '' OR pg_catalog.length(p_issuer) > 2048
    OR p_subject IS NULL OR pg_catalog.btrim(p_subject) = '' OR pg_catalog.length(p_subject) > 512
    OR p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' OR pg_catalog.length(p_actor) > 256
    OR p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' OR pg_catalog.length(p_reason) > 1024
    OR pg_catalog.octet_length(
      pg_catalog.jsonb_build_object(
        'actor', pg_catalog.btrim(p_actor),
        'reason', pg_catalog.btrim(p_reason),
        'principal_count', 2147483647,
        'grant_count', 2147483647,
        'code_count', 2147483647,
        'session_count', 2147483647
      )::text
    ) > 4096
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'issuer, subject, actor, and reason are required';
  END IF;

  LOCK TABLE public.oauth_authorization_codes IN ROW EXCLUSIVE MODE;
  LOCK TABLE public.oauth_login_sessions IN ROW EXCLUSIVE MODE;

  SELECT principal.id, principal.status = 'active'
    INTO v_principal_id, v_was_active
  FROM public.oauth_principals AS principal
  WHERE principal.issuer = pg_catalog.btrim(p_issuer)
    AND principal.subject = pg_catalog.btrim(p_subject)
  FOR NO KEY UPDATE;

  IF FOUND THEN
    PERFORM authorization_code.id
    FROM public.oauth_authorization_codes AS authorization_code
    WHERE authorization_code.principal_id = v_principal_id
      AND authorization_code.consumed_at IS NULL
    ORDER BY authorization_code.id
    FOR UPDATE OF authorization_code;

    PERFORM grant_row.id
    FROM public.oauth_grants AS grant_row
    WHERE grant_row.principal_id = v_principal_id
    ORDER BY grant_row.id
    FOR UPDATE OF grant_row;

    PERFORM session.id
    FROM public.oauth_login_sessions AS session
    WHERE session.principal_id = v_principal_id
      AND session.revoked_at IS NULL
    ORDER BY session.id
    FOR UPDATE OF session;

    v_now := pg_catalog.clock_timestamp();

    IF v_was_active THEN
      UPDATE public.oauth_principals
      SET status = 'disabled',
          authentication_epoch = authentication_epoch + 1,
          legacy_not_before = GREATEST(legacy_not_before, v_now),
          disabled_at = v_now,
          disabled_reason = pg_catalog.btrim(p_reason),
          updated_at = v_now
      WHERE id = v_principal_id;
    END IF;

    UPDATE public.oauth_authorization_codes
    SET consumed_at = GREATEST(v_now, created_at)
    WHERE principal_id = v_principal_id
      AND consumed_at IS NULL;
    GET DIAGNOSTICS v_code_count = ROW_COUNT;

    UPDATE public.oauth_grants
    SET status = 'revoked',
        revoked_at = v_now,
        revoked_reason = pg_catalog.btrim(p_reason),
        updated_at = v_now
    WHERE principal_id = v_principal_id AND status = 'active';
    GET DIAGNOSTICS v_grant_count = ROW_COUNT;

    UPDATE public.oauth_refresh_tokens AS refresh
    SET expires_at = GREATEST(
      refresh.issued_at + INTERVAL '1 microsecond',
      LEAST(refresh.expires_at, v_now)
    )
    WHERE refresh.grant_id IN (
      SELECT grant_row.id FROM public.oauth_grants AS grant_row
      WHERE grant_row.principal_id = v_principal_id
    ) AND refresh.expires_at > v_now;

    UPDATE public.oauth_login_sessions
    SET revoked_at = GREATEST(v_now, issued_at),
        revoked_reason = pg_catalog.btrim(p_reason)
    WHERE principal_id = v_principal_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_session_count = ROW_COUNT;
    v_changed := v_was_active OR v_grant_count > 0 OR v_code_count > 0 OR v_session_count > 0;
  ELSE
    v_now := pg_catalog.clock_timestamp();
  END IF;

  INSERT INTO public.oauth_audit_events (
    id, event_type, outcome, principal_id, request_id, actor_type, metadata, created_at
  ) VALUES (
    pg_catalog.gen_random_uuid(),
    'operator_principal_disable',
    CASE WHEN v_principal_id IS NULL THEN 'not_found' WHEN v_changed THEN 'disabled' ELSE 'no_change' END,
    v_principal_id,
    'operator-' || pg_catalog.gen_random_uuid()::text,
    'operator',
    pg_catalog.jsonb_build_object(
      'actor', pg_catalog.btrim(p_actor),
      'reason', pg_catalog.btrim(p_reason),
      'grant_count', v_grant_count,
      'code_count', v_code_count,
      'session_count', v_session_count
    ),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'matched', v_principal_id IS NOT NULL,
    'changed', v_changed,
    'grant_count', v_grant_count,
    'code_count', v_code_count,
    'session_count', v_session_count
  );
END
$function$;

CREATE FUNCTION public.oauth_operator_disable_binding(
  p_binding_id uuid,
  p_actor text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz;
  v_principal_id uuid;
  v_was_active boolean := false;
  v_grant_count integer := 0;
  v_code_count integer := 0;
  v_changed boolean := false;
BEGIN
  IF p_binding_id IS NULL
    OR p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' OR pg_catalog.length(p_actor) > 256
    OR p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' OR pg_catalog.length(p_reason) > 1024
    OR pg_catalog.octet_length(
      pg_catalog.jsonb_build_object(
        'actor', pg_catalog.btrim(p_actor),
        'reason', pg_catalog.btrim(p_reason),
        'principal_count', 2147483647,
        'grant_count', 2147483647,
        'code_count', 2147483647
      )::text
    ) > 4096
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'binding id, actor, and reason are required';
  END IF;

  LOCK TABLE public.oauth_authorization_codes IN ROW EXCLUSIVE MODE;

  SELECT binding.principal_id, binding.status = 'active'
    INTO v_principal_id, v_was_active
  FROM public.oauth_agent_bindings AS binding
  WHERE binding.id = p_binding_id
  FOR NO KEY UPDATE;

  IF FOUND THEN
    PERFORM authorization_code.id
    FROM public.oauth_authorization_codes AS authorization_code
    WHERE authorization_code.binding_id = p_binding_id
      AND authorization_code.consumed_at IS NULL
    ORDER BY authorization_code.id
    FOR UPDATE OF authorization_code;

    PERFORM grant_row.id
    FROM public.oauth_grants AS grant_row
    WHERE grant_row.binding_id = p_binding_id
    ORDER BY grant_row.id
    FOR UPDATE OF grant_row;

    v_now := pg_catalog.clock_timestamp();

    IF v_was_active THEN
      UPDATE public.oauth_agent_bindings
      SET status = 'revoked',
          is_default = false,
          binding_version = binding_version + 1,
          revoked_at = v_now,
          revoked_reason = pg_catalog.btrim(p_reason),
          updated_at = v_now
      WHERE id = p_binding_id;
    END IF;

    UPDATE public.oauth_authorization_codes
    SET consumed_at = GREATEST(v_now, created_at)
    WHERE binding_id = p_binding_id
      AND consumed_at IS NULL;
    GET DIAGNOSTICS v_code_count = ROW_COUNT;

    UPDATE public.oauth_grants
    SET status = 'revoked',
        revoked_at = v_now,
        revoked_reason = pg_catalog.btrim(p_reason),
        updated_at = v_now
    WHERE binding_id = p_binding_id AND status = 'active';
    GET DIAGNOSTICS v_grant_count = ROW_COUNT;

    UPDATE public.oauth_refresh_tokens AS refresh
    SET expires_at = GREATEST(
      refresh.issued_at + INTERVAL '1 microsecond',
      LEAST(refresh.expires_at, v_now)
    )
    WHERE refresh.grant_id IN (
      SELECT grant_row.id FROM public.oauth_grants AS grant_row
      WHERE grant_row.binding_id = p_binding_id
    ) AND refresh.expires_at > v_now;
    v_changed := v_was_active OR v_grant_count > 0 OR v_code_count > 0;
  ELSE
    v_now := pg_catalog.clock_timestamp();
  END IF;

  -- Binding is sufficient to correlate this audit. Omitting principal_id
  -- avoids acquiring a parent FK lock after binding/grant family locks.
  INSERT INTO public.oauth_audit_events (
    id, event_type, outcome, binding_id, request_id, actor_type, metadata, created_at
  ) VALUES (
    pg_catalog.gen_random_uuid(),
    'operator_binding_disable',
    CASE WHEN v_principal_id IS NULL THEN 'not_found' WHEN v_changed THEN 'disabled' ELSE 'no_change' END,
    CASE WHEN v_principal_id IS NULL THEN NULL ELSE p_binding_id END,
    'operator-' || pg_catalog.gen_random_uuid()::text,
    'operator',
    pg_catalog.jsonb_build_object(
      'actor', pg_catalog.btrim(p_actor),
      'reason', pg_catalog.btrim(p_reason),
      'grant_count', v_grant_count,
      'code_count', v_code_count
    ),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'matched', v_principal_id IS NOT NULL,
    'changed', v_changed,
    'grant_count', v_grant_count,
    'code_count', v_code_count,
    'binding_id', CASE WHEN v_principal_id IS NULL THEN NULL ELSE p_binding_id END
  );
END
$function$;

CREATE FUNCTION public.oauth_operator_security_logout(
  p_issuer text,
  p_subject text,
  p_actor text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz;
  v_principal_id uuid;
  v_authentication_epoch integer;
  v_grant_count integer := 0;
  v_code_count integer := 0;
  v_session_count integer := 0;
BEGIN
  IF p_issuer IS NULL OR pg_catalog.btrim(p_issuer) = '' OR pg_catalog.length(p_issuer) > 2048
    OR p_subject IS NULL OR pg_catalog.btrim(p_subject) = '' OR pg_catalog.length(p_subject) > 512
    OR p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' OR pg_catalog.length(p_actor) > 256
    OR p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' OR pg_catalog.length(p_reason) > 1024
    OR pg_catalog.octet_length(
      pg_catalog.jsonb_build_object(
        'actor', pg_catalog.btrim(p_actor),
        'reason', pg_catalog.btrim(p_reason),
        'principal_count', 2147483647,
        'grant_count', 2147483647,
        'code_count', 2147483647,
        'session_count', 2147483647
      )::text
    ) > 4096
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'issuer, subject, actor, and reason are required';
  END IF;

  LOCK TABLE public.oauth_authorization_codes IN ROW EXCLUSIVE MODE;
  LOCK TABLE public.oauth_login_sessions IN ROW EXCLUSIVE MODE;

  SELECT principal.id, principal.authentication_epoch
    INTO v_principal_id, v_authentication_epoch
  FROM public.oauth_principals AS principal
  WHERE principal.issuer = pg_catalog.btrim(p_issuer)
    AND principal.subject = pg_catalog.btrim(p_subject)
  FOR NO KEY UPDATE;

  IF FOUND THEN
    PERFORM authorization_code.id
    FROM public.oauth_authorization_codes AS authorization_code
    WHERE authorization_code.principal_id = v_principal_id
      AND authorization_code.consumed_at IS NULL
    ORDER BY authorization_code.id
    FOR UPDATE OF authorization_code;

    PERFORM grant_row.id
    FROM public.oauth_grants AS grant_row
    WHERE grant_row.principal_id = v_principal_id
    ORDER BY grant_row.id
    FOR UPDATE OF grant_row;

    PERFORM session.id
    FROM public.oauth_login_sessions AS session
    WHERE session.principal_id = v_principal_id
      AND session.revoked_at IS NULL
    ORDER BY session.id
    FOR UPDATE OF session;

    v_now := pg_catalog.clock_timestamp();

    UPDATE public.oauth_principals
    SET authentication_epoch = authentication_epoch + 1,
        legacy_not_before = GREATEST(legacy_not_before, v_now),
        updated_at = v_now
    WHERE id = v_principal_id
    RETURNING authentication_epoch INTO v_authentication_epoch;

    UPDATE public.oauth_authorization_codes
    SET consumed_at = GREATEST(v_now, created_at)
    WHERE principal_id = v_principal_id
      AND consumed_at IS NULL;
    GET DIAGNOSTICS v_code_count = ROW_COUNT;

    UPDATE public.oauth_grants
    SET status = 'revoked',
        revoked_at = v_now,
        revoked_reason = pg_catalog.btrim(p_reason),
        updated_at = v_now
    WHERE principal_id = v_principal_id AND status = 'active';
    GET DIAGNOSTICS v_grant_count = ROW_COUNT;

    UPDATE public.oauth_refresh_tokens AS refresh
    SET expires_at = GREATEST(
      refresh.issued_at + INTERVAL '1 microsecond',
      LEAST(refresh.expires_at, v_now)
    )
    WHERE refresh.grant_id IN (
      SELECT grant_row.id FROM public.oauth_grants AS grant_row
      WHERE grant_row.principal_id = v_principal_id
    ) AND refresh.expires_at > v_now;

    UPDATE public.oauth_login_sessions
    SET revoked_at = GREATEST(v_now, issued_at),
        revoked_reason = pg_catalog.btrim(p_reason)
    WHERE principal_id = v_principal_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_session_count = ROW_COUNT;
  ELSE
    v_now := pg_catalog.clock_timestamp();
  END IF;

  INSERT INTO public.oauth_audit_events (
    id, event_type, outcome, principal_id, request_id, actor_type, metadata, created_at
  ) VALUES (
    pg_catalog.gen_random_uuid(),
    'operator_security_logout',
    CASE WHEN v_principal_id IS NULL THEN 'not_found' ELSE 'logged_out' END,
    v_principal_id,
    'operator-' || pg_catalog.gen_random_uuid()::text,
    'operator',
    pg_catalog.jsonb_build_object(
      'actor', pg_catalog.btrim(p_actor),
      'reason', pg_catalog.btrim(p_reason),
      'grant_count', v_grant_count,
      'code_count', v_code_count,
      'session_count', v_session_count
    ),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'matched', v_principal_id IS NOT NULL,
    'changed', v_principal_id IS NOT NULL,
    'authentication_epoch', v_authentication_epoch,
    'grant_count', v_grant_count,
    'code_count', v_code_count,
    'session_count', v_session_count
  );
END
$function$;

CREATE FUNCTION public.oauth_operator_invalidate_issuer(
  p_issuer text,
  p_actor text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz;
  v_principal_count integer := 0;
  v_grant_count integer := 0;
  v_code_count integer := 0;
  v_session_count integer := 0;
BEGIN
  IF p_issuer IS NULL OR pg_catalog.btrim(p_issuer) = '' OR pg_catalog.length(p_issuer) > 2048
    OR p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' OR pg_catalog.length(p_actor) > 256
    OR p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' OR pg_catalog.length(p_reason) > 1024
    OR pg_catalog.octet_length(
      pg_catalog.jsonb_build_object(
        'actor', pg_catalog.btrim(p_actor),
        'reason', pg_catalog.btrim(p_reason),
        'principal_count', 2147483647,
        'grant_count', 2147483647,
        'code_count', 2147483647,
        'session_count', 2147483647
      )::text
    ) > 4096
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'issuer, actor, and reason are required';
  END IF;

  LOCK TABLE public.oauth_authorization_codes IN ROW EXCLUSIVE MODE;
  LOCK TABLE public.oauth_login_sessions IN ROW EXCLUSIVE MODE;

  -- Lock every affected parent in stable order before dependent authority.
  PERFORM principal.id
  FROM public.oauth_principals AS principal
  WHERE principal.issuer = pg_catalog.btrim(p_issuer)
  ORDER BY principal.id
  FOR NO KEY UPDATE OF principal;
  GET DIAGNOSTICS v_principal_count = ROW_COUNT;

  IF v_principal_count > 0 THEN
    PERFORM authorization_code.id
    FROM public.oauth_authorization_codes AS authorization_code
    JOIN public.oauth_principals AS principal
      ON principal.id = authorization_code.principal_id
    WHERE principal.issuer = pg_catalog.btrim(p_issuer)
      AND authorization_code.consumed_at IS NULL
    ORDER BY authorization_code.id
    FOR UPDATE OF authorization_code;

    PERFORM grant_row.id
    FROM public.oauth_grants AS grant_row
    JOIN public.oauth_principals AS principal
      ON principal.id = grant_row.principal_id
    WHERE principal.issuer = pg_catalog.btrim(p_issuer)
    ORDER BY grant_row.id
    FOR UPDATE OF grant_row;

    PERFORM session.id
    FROM public.oauth_login_sessions AS session
    JOIN public.oauth_principals AS principal
      ON principal.id = session.principal_id
    WHERE principal.issuer = pg_catalog.btrim(p_issuer)
      AND session.revoked_at IS NULL
    ORDER BY session.id
    FOR UPDATE OF session;
  END IF;

  v_now := pg_catalog.clock_timestamp();

  UPDATE public.oauth_principals
  SET authentication_epoch = authentication_epoch + 1,
      legacy_not_before = GREATEST(legacy_not_before, v_now),
      updated_at = v_now
  WHERE issuer = pg_catalog.btrim(p_issuer);

  UPDATE public.oauth_authorization_codes AS authorization_code
  SET consumed_at = GREATEST(v_now, authorization_code.created_at)
  WHERE authorization_code.consumed_at IS NULL
    AND authorization_code.principal_id IN (
      SELECT principal.id FROM public.oauth_principals AS principal
      WHERE principal.issuer = pg_catalog.btrim(p_issuer)
    );
  GET DIAGNOSTICS v_code_count = ROW_COUNT;

  UPDATE public.oauth_grants AS grant_row
  SET status = 'revoked',
      revoked_at = v_now,
      revoked_reason = pg_catalog.btrim(p_reason),
      updated_at = v_now
  WHERE grant_row.status = 'active'
    AND grant_row.principal_id IN (
      SELECT principal.id FROM public.oauth_principals AS principal
      WHERE principal.issuer = pg_catalog.btrim(p_issuer)
    );
  GET DIAGNOSTICS v_grant_count = ROW_COUNT;

  UPDATE public.oauth_refresh_tokens AS refresh
  SET expires_at = GREATEST(
    refresh.issued_at + INTERVAL '1 microsecond',
    LEAST(refresh.expires_at, v_now)
  )
  WHERE refresh.grant_id IN (
    SELECT grant_row.id
    FROM public.oauth_grants AS grant_row
    JOIN public.oauth_principals AS principal ON principal.id = grant_row.principal_id
    WHERE principal.issuer = pg_catalog.btrim(p_issuer)
  ) AND refresh.expires_at > v_now;

  UPDATE public.oauth_login_sessions AS session
  SET revoked_at = GREATEST(v_now, session.issued_at),
      revoked_reason = pg_catalog.btrim(p_reason)
  WHERE session.revoked_at IS NULL
    AND session.principal_id IN (
      SELECT principal.id FROM public.oauth_principals AS principal
      WHERE principal.issuer = pg_catalog.btrim(p_issuer)
    );
  GET DIAGNOSTICS v_session_count = ROW_COUNT;

  INSERT INTO public.oauth_audit_events (
    id, event_type, outcome, request_id, actor_type, metadata, created_at
  ) VALUES (
    pg_catalog.gen_random_uuid(),
    'operator_issuer_invalidate',
    CASE WHEN v_principal_count > 0 THEN 'invalidated' ELSE 'not_found' END,
    'operator-' || pg_catalog.gen_random_uuid()::text,
    'operator',
    pg_catalog.jsonb_build_object(
      'actor', pg_catalog.btrim(p_actor),
      'reason', pg_catalog.btrim(p_reason),
      'principal_count', v_principal_count,
      'grant_count', v_grant_count,
      'code_count', v_code_count,
      'session_count', v_session_count
    ),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'matched', v_principal_count > 0,
    'changed', v_principal_count > 0,
    'principal_count', v_principal_count,
    'grant_count', v_grant_count,
    'code_count', v_code_count,
    'session_count', v_session_count
  );
END
$function$;

-- One bounded lifecycle pass. The caller may request a historical instant for
-- deterministic maintenance/testing, but can never advance deletion beyond
-- the database wall clock. Ninety-three days exceeds the longest calendar
-- quarter. The additional access horizons cover the configured 24-hour
-- maximum access lifetime, five-minute refresh retry grace, and one minute of
-- token clock skew.
CREATE FUNCTION public.oauth_prune_expired(
  p_requested_now timestamptz,
  p_batch_size integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz;
  v_audit_event_count integer := 0;
  v_authorization_code_count integer := 0;
  v_refresh_token_count integer := 0;
  v_login_session_count integer := 0;
  v_grant_count integer := 0;
  v_row_count integer := 0;
  v_grant_id uuid;
BEGIN
  IF p_requested_now IS NULL
    OR NOT pg_catalog.isfinite(p_requested_now)
    OR p_batch_size IS NULL
    OR p_batch_size < 1
    OR p_batch_size > 1000
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'prune time and a batch size from 1 through 1000 are required';
  END IF;

  v_now := LEAST(p_requested_now, pg_catalog.clock_timestamp());

  WITH candidates AS MATERIALIZED (
    SELECT audit.id
    FROM public.oauth_audit_events AS audit
    WHERE audit.created_at <= v_now - INTERVAL '93 days'
    ORDER BY audit.created_at, audit.id
    LIMIT p_batch_size
    FOR UPDATE OF audit SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.oauth_audit_events AS audit
    USING candidates
    WHERE audit.id = candidates.id
    RETURNING audit.id
  )
  SELECT pg_catalog.count(*)::integer
  INTO v_audit_event_count
  FROM deleted;

  WITH candidates AS MATERIALIZED (
    SELECT authorization_code.id
    FROM public.oauth_authorization_codes AS authorization_code
    WHERE authorization_code.expires_at <= v_now
    ORDER BY authorization_code.expires_at, authorization_code.id
    LIMIT p_batch_size
    FOR UPDATE OF authorization_code SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.oauth_authorization_codes AS authorization_code
    USING candidates
    WHERE authorization_code.id = candidates.id
    RETURNING authorization_code.id
  )
  SELECT pg_catalog.count(*)::integer
  INTO v_authorization_code_count
  FROM deleted;

  WITH candidates AS MATERIALIZED (
    SELECT refresh.id
    FROM public.oauth_refresh_tokens AS refresh
    WHERE refresh.expires_at <= v_now
      AND GREATEST(
        refresh.issued_at,
        COALESCE(refresh.retry_deadline, refresh.issued_at)
      ) <= v_now - INTERVAL '24 hours 1 minute'
    ORDER BY refresh.expires_at, refresh.id
    LIMIT p_batch_size
    FOR UPDATE OF refresh SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.oauth_refresh_tokens AS refresh
    USING candidates
    WHERE refresh.id = candidates.id
    RETURNING refresh.id
  )
  SELECT pg_catalog.count(*)::integer
  INTO v_refresh_token_count
  FROM deleted;

  WITH candidates AS MATERIALIZED (
    SELECT login_session.id
    FROM public.oauth_login_sessions AS login_session
    WHERE login_session.expires_at <= v_now
    ORDER BY login_session.expires_at, login_session.id
    LIMIT p_batch_size
    FOR UPDATE OF login_session SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.oauth_login_sessions AS login_session
    USING candidates
    WHERE login_session.id = candidates.id
    RETURNING login_session.id
  )
  SELECT pg_catalog.count(*)::integer
  INTO v_login_session_count
  FROM deleted;

  -- Lock each candidate before the final attribution recheck. A concurrent
  -- audit insert either commits before this fresh DELETE snapshot (and keeps
  -- the grant) or waits on the grant lock and cannot create an orphan. The
  -- restrictive audit FK is the final invariant if either side changes later.
  FOR v_grant_id IN
    SELECT grant_row.id
    FROM public.oauth_grants AS grant_row
    WHERE grant_row.legacy_tuple_digest IS NULL
      AND (
        grant_row.status <> 'active'
        OR grant_row.inactivity_expires_at <= v_now
      )
      AND grant_row.updated_at <= v_now - INTERVAL '24 hours 6 minutes'
      -- Never let the grant FK cascade turn one bounded pass into an
      -- unbounded refresh-descriptor delete. A grant becomes eligible only
      -- after earlier bounded passes have removed every descriptor.
      AND NOT EXISTS (
        SELECT 1
        FROM public.oauth_refresh_tokens AS refresh
        WHERE refresh.grant_id = grant_row.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.oauth_audit_events AS audit
        WHERE audit.grant_id = grant_row.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.oauth_grants AS predecessor
        WHERE predecessor.superseded_by = grant_row.id
      )
    ORDER BY grant_row.updated_at, grant_row.id
    LIMIT p_batch_size
    FOR UPDATE OF grant_row SKIP LOCKED
  LOOP
    DELETE FROM public.oauth_grants AS grant_row
    WHERE grant_row.id = v_grant_id
      AND grant_row.legacy_tuple_digest IS NULL
      AND (
        grant_row.status <> 'active'
        OR grant_row.inactivity_expires_at <= v_now
      )
      AND grant_row.updated_at <= v_now - INTERVAL '24 hours 6 minutes'
      AND NOT EXISTS (
        SELECT 1
        FROM public.oauth_refresh_tokens AS refresh
        WHERE refresh.grant_id = grant_row.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.oauth_audit_events AS audit
        WHERE audit.grant_id = grant_row.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.oauth_grants AS predecessor
        WHERE predecessor.superseded_by = grant_row.id
      );
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_grant_count := v_grant_count + v_row_count;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'audit_event_count', v_audit_event_count,
    'authorization_code_count', v_authorization_code_count,
    'refresh_token_count', v_refresh_token_count,
    'login_session_count', v_login_session_count,
    'grant_count', v_grant_count
  );
END
$function$;

-- Rebuild the capability roles from an explicit deny baseline.
REVOKE ALL PRIVILEGES ON SCHEMA public FROM cortex_oauth_runtime;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM cortex_oauth_operator;
GRANT USAGE ON SCHEMA public TO cortex_oauth_runtime;
GRANT USAGE ON SCHEMA public TO cortex_oauth_operator;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM cortex_oauth_runtime;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM cortex_oauth_operator;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM cortex_oauth_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM cortex_oauth_operator;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM cortex_oauth_runtime;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM cortex_oauth_operator;

REVOKE ALL PRIVILEGES ON TABLE
  public.oauth_principals,
  public.oauth_agent_bindings,
  public.oauth_clients,
  public.oauth_authorization_codes,
  public.oauth_grants,
  public.oauth_refresh_tokens,
  public.oauth_login_sessions,
  public.oauth_audit_events,
  public.oauth_state_migrations,
  public.oauth_operator_grants,
  public.oauth_operator_principals,
  public.oauth_operator_bindings,
  public.oauth_operator_rollout_status
FROM PUBLIC;

GRANT SELECT ON TABLE
  public.cortex_schema_migrations,
  public.oauth_principals,
  public.oauth_agent_bindings
TO cortex_oauth_runtime;

GRANT SELECT (id, external_id) ON TABLE public.agents TO cortex_oauth_runtime;

GRANT SELECT, INSERT ON TABLE
  public.oauth_clients,
  public.oauth_authorization_codes,
  public.oauth_grants,
  public.oauth_refresh_tokens,
  public.oauth_login_sessions
TO cortex_oauth_runtime;

-- Runtime mutation is column-scoped. Stable identities, authority bindings,
-- token digests/nonces, issue timestamps, and the permanent legacy replay
-- tombstone digest cannot be rewritten by the gateway role.
GRANT UPDATE (
  redirect_uris,
  client_name,
  token_endpoint_auth_method,
  status,
  updated_at
) ON TABLE public.oauth_clients TO cortex_oauth_runtime;

GRANT UPDATE (consumed_at)
ON TABLE public.oauth_authorization_codes TO cortex_oauth_runtime;

GRANT UPDATE (
  status,
  current_refresh_generation,
  inactivity_expires_at,
  refreshed_at,
  revoked_at,
  revoked_reason,
  superseded_by,
  updated_at
) ON TABLE public.oauth_grants TO cortex_oauth_runtime;

GRANT UPDATE (
  expires_at,
  consumed_at,
  replacement_generation,
  retry_deadline,
  request_fingerprint
) ON TABLE public.oauth_refresh_tokens TO cortex_oauth_runtime;

GRANT UPDATE (expires_at, revoked_at, revoked_reason)
ON TABLE public.oauth_login_sessions TO cortex_oauth_runtime;

GRANT INSERT ON TABLE public.oauth_audit_events TO cortex_oauth_runtime;
GRANT SELECT, INSERT ON TABLE public.oauth_state_migrations TO cortex_oauth_runtime;

GRANT SELECT ON TABLE
  public.oauth_operator_grants,
  public.oauth_operator_principals,
  public.oauth_operator_bindings,
  public.oauth_operator_rollout_status
TO cortex_oauth_operator;

REVOKE ALL ON FUNCTION public.oauth_operator_revoke_grant(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.oauth_operator_revoke_all_for_principal(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.oauth_operator_disable_principal(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.oauth_operator_disable_binding(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.oauth_operator_security_logout(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.oauth_operator_invalidate_issuer(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.oauth_redirect_uris_are_canonical(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.oauth_audit_metadata_is_safe(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.oauth_lock_authorization_codes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.oauth_lock_login_sessions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.oauth_prune_expired(timestamptz, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.oauth_operator_revoke_grant(uuid, text, text) TO cortex_oauth_operator;
GRANT EXECUTE ON FUNCTION public.oauth_operator_revoke_all_for_principal(text, text, text, text) TO cortex_oauth_operator;
GRANT EXECUTE ON FUNCTION public.oauth_operator_disable_principal(text, text, text, text) TO cortex_oauth_operator;
GRANT EXECUTE ON FUNCTION public.oauth_operator_disable_binding(uuid, text, text) TO cortex_oauth_operator;
GRANT EXECUTE ON FUNCTION public.oauth_operator_security_logout(text, text, text, text) TO cortex_oauth_operator;
GRANT EXECUTE ON FUNCTION public.oauth_operator_invalidate_issuer(text, text, text) TO cortex_oauth_operator;
GRANT EXECUTE ON FUNCTION public.oauth_redirect_uris_are_canonical(text[]) TO cortex_oauth_runtime;
GRANT EXECUTE ON FUNCTION public.oauth_audit_metadata_is_safe(jsonb) TO cortex_oauth_runtime;
GRANT EXECUTE ON FUNCTION public.oauth_lock_authorization_codes() TO cortex_oauth_runtime;
GRANT EXECUTE ON FUNCTION public.oauth_lock_login_sessions() TO cortex_oauth_runtime;
GRANT EXECUTE ON FUNCTION public.oauth_prune_expired(timestamptz, integer) TO cortex_oauth_runtime;
