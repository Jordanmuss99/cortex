-- Durable Cortex memory lifecycle (first vertical subset).
--
-- This migration remains mutable until the release-candidate slice freezes
-- its checksum. Until then it is exercised only on guarded disposable data.

DO $preflight$
DECLARE
  bad_successors bigint;
  bad_synapses bigint;
  bad_codes bigint;
  bad_valence bigint;
BEGIN
  SELECT pg_catalog.count(*)
  INTO bad_successors
  FROM public.memory_nodes AS node
  LEFT JOIN public.memory_nodes AS successor
    ON successor.id = node.superseded_by
  WHERE node.superseded_by IS NOT NULL
    AND (successor.id IS NULL OR successor.agent_id <> node.agent_id);

  SELECT pg_catalog.count(*)
  INTO bad_synapses
  FROM public.memory_synapses AS edge
  LEFT JOIN public.memory_nodes AS left_node ON left_node.id = edge.memory_a
  LEFT JOIN public.memory_nodes AS right_node ON right_node.id = edge.memory_b
  WHERE left_node.id IS NULL
     OR right_node.id IS NULL
     OR left_node.agent_id <> right_node.agent_id;

  SELECT pg_catalog.count(*)
  INTO bad_codes
  FROM public.hippocampal_codes AS code
  LEFT JOIN public.memory_nodes AS node ON node.id = code.memory_id
  WHERE node.id IS NULL OR node.agent_id <> code.agent_id;

  SELECT pg_catalog.count(*)
  INTO bad_valence
  FROM public.emotional_valence AS valence
  LEFT JOIN public.memory_nodes AS node ON node.id = valence.memory_id
  WHERE node.id IS NULL OR node.agent_id <> valence.agent_id;

  IF bad_successors + bad_synapses + bad_codes + bad_valence > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = pg_catalog.format(
        'memory lifecycle preflight failed: successors=%s synapses=%s codes=%s valence=%s',
        bad_successors,
        bad_synapses,
        bad_codes,
        bad_valence
      );
  END IF;
END
$preflight$;

ALTER TABLE public.memory_nodes
  ADD CONSTRAINT memory_nodes_id_agent_key UNIQUE (id, agent_id);

-- Fact validity is an instant, not a server-local wall clock. Historical
-- values were written as UTC-shaped timestamps, so preserve that meaning.
ALTER TABLE public.memory_nodes
  ALTER COLUMN valid_from TYPE timestamptz
    USING valid_from AT TIME ZONE 'UTC',
  ALTER COLUMN valid_until TYPE timestamptz
    USING valid_until AT TIME ZONE 'UTC';

ALTER TABLE public.memory_nodes
  ADD CONSTRAINT memory_nodes_superseded_by_agent_fkey
    FOREIGN KEY (superseded_by, agent_id)
    REFERENCES public.memory_nodes(id, agent_id);

ALTER TABLE public.memory_synapses
  ADD COLUMN agent_id integer;

UPDATE public.memory_synapses AS edge
SET agent_id = node.agent_id
FROM public.memory_nodes AS node
WHERE node.id = edge.memory_a;

DROP INDEX public.idx_synapses_pair;

ALTER TABLE public.memory_synapses
  ALTER COLUMN agent_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS memory_synapses_memory_a_fkey,
  DROP CONSTRAINT IF EXISTS memory_synapses_memory_b_fkey,
  ADD CONSTRAINT memory_synapses_agent_id_fkey
    FOREIGN KEY (agent_id)
    REFERENCES public.agents(id),
  ADD CONSTRAINT memory_synapses_memory_a_agent_fkey
    FOREIGN KEY (memory_a, agent_id)
    REFERENCES public.memory_nodes(id, agent_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT memory_synapses_memory_b_agent_fkey
    FOREIGN KEY (memory_b, agent_id)
    REFERENCES public.memory_nodes(id, agent_id)
    ON DELETE CASCADE;

CREATE INDEX idx_synapses_agent
  ON public.memory_synapses(agent_id);
CREATE UNIQUE INDEX idx_synapses_pair
  ON public.memory_synapses (
    agent_id,
    memory_a,
    memory_b,
    connection_type
  );

ALTER TABLE public.hippocampal_codes
  DROP CONSTRAINT IF EXISTS hippocampal_codes_memory_id_fkey,
  ADD CONSTRAINT hippocampal_codes_memory_agent_fkey
    FOREIGN KEY (memory_id, agent_id)
    REFERENCES public.memory_nodes(id, agent_id)
    ON DELETE CASCADE;

ALTER TABLE public.emotional_valence
  DROP CONSTRAINT IF EXISTS emotional_valence_memory_id_fkey,
  ADD CONSTRAINT emotional_valence_memory_agent_fkey
    FOREIGN KEY (memory_id, agent_id)
    REFERENCES public.memory_nodes(id, agent_id)
    ON DELETE CASCADE;

CREATE TABLE public.memory_ingest_events (
  id uuid PRIMARY KEY,
  agent_id integer NOT NULL REFERENCES public.agents(id),
  idempotency_key text NOT NULL,
  raw_content text NOT NULL,
  request_hash text NOT NULL,
  content_hash text NOT NULL,
  source text,
  source_version text,
  source_type varchar(64) NOT NULL,
  observed_at timestamptz NOT NULL,
  observed_at_was_defaulted boolean NOT NULL,
  valid_from timestamptz,
  valid_until timestamptz,
  requested_priority smallint NOT NULL,
  effective_priority smallint NOT NULL,
  provided_entities text[] NOT NULL DEFAULT '{}'::text[],
  provided_semantic_tags text[] NOT NULL DEFAULT '{}'::text[],
  projection_mode varchar(32) NOT NULL DEFAULT 'append',
  predecessor_memory_id integer,
  force_new_projection boolean NOT NULL DEFAULT false,
  request_id varchar(128),
  session_id varchar(128),
  status varchar(32) NOT NULL DEFAULT 'accepted',
  total_attempts integer NOT NULL DEFAULT 0,
  cycle_attempts integer NOT NULL DEFAULT 0,
  manual_retry_count integer NOT NULL DEFAULT 0,
  lease_owner varchar(128),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  failure_code varchar(64),
  failure_message varchar(512),
  warning_codes text[] NOT NULL DEFAULT '{}'::text[],
  possible_update_ids integer[] NOT NULL DEFAULT '{}'::integer[],
  projection_count integer NOT NULL DEFAULT 0,
  synapse_count integer NOT NULL DEFAULT 0,
  accepted_at timestamptz NOT NULL,
  started_at timestamptz,
  projected_at timestamptz,
  indexed_at timestamptz,
  snapshot_valid_until timestamptz,
  replaced_by_event_id uuid,
  updated_at timestamptz NOT NULL,
  acceptance_build_id varchar(128) NOT NULL,
  indexed_build_id varchar(128),
  first_terminal_failure_at timestamptz,
  first_terminal_failure_build_id varchar(128),
  latest_terminal_failure_at timestamptz,
  latest_terminal_failure_build_id varchar(128),
  terminal_failure_transition_count integer NOT NULL DEFAULT 0,
  CONSTRAINT memory_ingest_events_agent_key UNIQUE (id, agent_id),
  CONSTRAINT memory_ingest_events_replaced_by_fkey
    FOREIGN KEY (replaced_by_event_id, agent_id)
    REFERENCES public.memory_ingest_events(id, agent_id),
  CONSTRAINT memory_ingest_events_idempotency_key
    UNIQUE (agent_id, idempotency_key),
  CONSTRAINT memory_ingest_events_idempotency_check CHECK (
    idempotency_key = pg_catalog.btrim(idempotency_key)
    AND pg_catalog.length(idempotency_key) BETWEEN 1 AND 256
  ),
  CONSTRAINT memory_ingest_events_content_check CHECK (
    pg_catalog.length(pg_catalog.btrim(raw_content)) > 0
  ),
  CONSTRAINT memory_ingest_events_request_hash_check CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT memory_ingest_events_content_hash_check CHECK (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT memory_ingest_events_source_type_check CHECK (
    source_type = pg_catalog.btrim(source_type)
    AND pg_catalog.length(source_type) BETWEEN 1 AND 64
  ),
  CONSTRAINT memory_ingest_events_priority_check CHECK (
    requested_priority BETWEEN 0 AND 4
    AND effective_priority BETWEEN 0 AND 4
  ),
  CONSTRAINT memory_ingest_events_projection_mode_check CHECK (
    projection_mode IN ('append', 'replace_source', 'reconsolidate')
  ),
  CONSTRAINT memory_ingest_events_source_snapshot_check CHECK (
    projection_mode <> 'replace_source'
    OR (
      source IS NOT NULL
      AND source = pg_catalog.btrim(source)
      AND pg_catalog.length(source) > 0
      AND pg_catalog.octet_length(source) <= 1024
      AND source_version IS NOT NULL
      AND source_version = pg_catalog.btrim(source_version)
      AND pg_catalog.length(source_version) > 0
      AND pg_catalog.octet_length(source_version) <= 1024
    )
  ),
  CONSTRAINT memory_ingest_events_status_check CHECK (
    status IN ('accepted', 'processing', 'indexed', 'failed', 'rejected')
  ),
  CONSTRAINT memory_ingest_events_validity_check CHECK (
    valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from
  ),
  CONSTRAINT memory_ingest_events_attempts_check CHECK (
    total_attempts >= 0
    AND cycle_attempts >= 0
    AND manual_retry_count >= 0
    AND cycle_attempts <= total_attempts
  ),
  CONSTRAINT memory_ingest_events_counts_check CHECK (
    projection_count >= 0 AND synapse_count >= 0
  ),
  CONSTRAINT memory_ingest_events_build_check CHECK (
    acceptance_build_id = pg_catalog.btrim(acceptance_build_id)
    AND pg_catalog.length(acceptance_build_id) BETWEEN 1 AND 128
    AND (
      indexed_build_id IS NULL
      OR (
        indexed_build_id = pg_catalog.btrim(indexed_build_id)
        AND pg_catalog.length(indexed_build_id) BETWEEN 1 AND 128
      )
    )
  ),
  CONSTRAINT memory_ingest_events_lease_check CHECK (
    (
      status = 'processing'
      AND lease_owner IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      status <> 'processing'
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT memory_ingest_events_retry_check CHECK (
    next_attempt_at IS NULL OR status = 'failed'
  ),
  CONSTRAINT memory_ingest_events_projection_check CHECK (
    (projected_at IS NULL AND projection_count = 0)
    OR (projected_at IS NOT NULL AND projection_count > 0)
  ),
  CONSTRAINT memory_ingest_events_indexed_check CHECK (
    (
      status = 'indexed'
      AND projected_at IS NOT NULL
      AND indexed_at IS NOT NULL
      AND indexed_build_id IS NOT NULL
    )
    OR (
      status <> 'indexed'
      AND indexed_at IS NULL
      AND indexed_build_id IS NULL
    )
  ),
  CONSTRAINT memory_ingest_events_failure_check CHECK (
    (
      status NOT IN ('failed', 'rejected')
      AND failure_code IS NULL
      AND failure_message IS NULL
    )
    OR (
      status IN ('failed', 'rejected')
      AND failure_code IS NOT NULL
      AND failure_message IS NOT NULL
      AND failure_code = pg_catalog.btrim(failure_code)
      AND pg_catalog.length(failure_code) BETWEEN 1 AND 64
      AND failure_message = pg_catalog.btrim(failure_message)
      AND pg_catalog.length(failure_message) BETWEEN 1 AND 512
    )
  ),
  CONSTRAINT memory_ingest_events_terminal_history_check CHECK (
    (
      terminal_failure_transition_count = 0
      AND first_terminal_failure_at IS NULL
      AND first_terminal_failure_build_id IS NULL
      AND latest_terminal_failure_at IS NULL
      AND latest_terminal_failure_build_id IS NULL
    )
    OR (
      terminal_failure_transition_count > 0
      AND first_terminal_failure_at IS NOT NULL
      AND first_terminal_failure_build_id IS NOT NULL
      AND first_terminal_failure_build_id = pg_catalog.btrim(first_terminal_failure_build_id)
      AND pg_catalog.length(first_terminal_failure_build_id) BETWEEN 1 AND 128
      AND latest_terminal_failure_at IS NOT NULL
      AND latest_terminal_failure_build_id IS NOT NULL
      AND latest_terminal_failure_build_id = pg_catalog.btrim(latest_terminal_failure_build_id)
      AND pg_catalog.length(latest_terminal_failure_build_id) BETWEEN 1 AND 128
      AND first_terminal_failure_at <= latest_terminal_failure_at
    )
  ),
  CONSTRAINT memory_ingest_events_terminal_state_check CHECK (
    status <> 'failed'
    OR next_attempt_at IS NOT NULL
    OR terminal_failure_transition_count > 0
  ),
  CONSTRAINT memory_ingest_events_snapshot_close_check CHECK (
    (
      snapshot_valid_until IS NULL
      AND replaced_by_event_id IS NULL
    )
    OR (
      projection_mode = 'replace_source'
      AND status = 'indexed'
      AND indexed_at IS NOT NULL
      AND snapshot_valid_until IS NOT NULL
      AND snapshot_valid_until >= indexed_at
      AND replaced_by_event_id IS NOT NULL
      AND replaced_by_event_id <> id
    )
  )
);

CREATE FUNCTION public.enforce_memory_ingest_event_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  old_terminal boolean;
  new_terminal boolean;
  replacement_is_valid boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'accepted'
       OR NEW.total_attempts <> 0
       OR NEW.cycle_attempts <> 0
       OR NEW.manual_retry_count <> 0
       OR NEW.projected_at IS NOT NULL
       OR NEW.indexed_at IS NOT NULL
       OR NEW.snapshot_valid_until IS NOT NULL
       OR NEW.replaced_by_event_id IS NOT NULL
       OR NEW.terminal_failure_transition_count <> 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'new memory ingest events must begin in accepted state';
    END IF;
    RETURN NEW;
  END IF;

  old_terminal := OLD.status = 'failed' AND OLD.next_attempt_at IS NULL;
  new_terminal := NEW.status = 'failed' AND NEW.next_attempt_at IS NULL;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'accepted' AND NEW.status = 'processing')
    OR (OLD.status = 'processing' AND NEW.status IN ('failed', 'indexed', 'rejected'))
    OR (
      OLD.status = 'failed'
      AND OLD.next_attempt_at IS NOT NULL
      AND NEW.status = 'processing'
    )
    OR (old_terminal AND NEW.status = 'accepted')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'invalid memory ingest event state transition';
  END IF;

  IF old_terminal AND NEW.status = 'accepted' AND (
    NEW.total_attempts IS DISTINCT FROM OLD.total_attempts
    OR NEW.cycle_attempts <> 0
    OR NEW.manual_retry_count <> OLD.manual_retry_count + 1
    OR NEW.next_attempt_at IS NOT NULL
    OR NEW.failure_code IS NOT NULL
    OR NEW.failure_message IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'terminal memory ingest retry requires a manual retry transition';
  END IF;

  IF OLD.status = 'failed'
     AND NEW.status = 'failed'
     AND old_terminal
     AND NOT new_terminal THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'terminal memory ingest events reopen only through manual retry';
  END IF;

  IF OLD.projected_at IS NULL
     AND NEW.projected_at IS NOT NULL
     AND (OLD.status <> 'processing' OR NEW.status <> 'processing') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'memory ingest projection checkpoints require processing state';
  END IF;

  IF OLD.status = 'processing'
     AND NEW.status = 'indexed'
     AND OLD.projected_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'memory ingest indexing requires a committed projection checkpoint';
  END IF;

  IF OLD.status = 'indexed' AND NEW.status <> 'indexed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'indexed memory ingest events are terminal';
  END IF;
  IF OLD.status = 'rejected' AND NEW.status <> 'rejected' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'rejected memory ingest events are terminal';
  END IF;
  IF OLD.projected_at IS NOT NULL AND (
    NEW.projected_at IS DISTINCT FROM OLD.projected_at
    OR NEW.projection_count IS DISTINCT FROM OLD.projection_count
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'memory ingest projection checkpoints are immutable';
  END IF;
  IF OLD.indexed_at IS NOT NULL AND (
    NEW.indexed_at IS DISTINCT FROM OLD.indexed_at
    OR NEW.indexed_build_id IS DISTINCT FROM OLD.indexed_build_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'memory ingest indexing evidence is immutable';
  END IF;

  IF OLD.snapshot_valid_until IS NOT NULL AND (
    NEW.snapshot_valid_until IS DISTINCT FROM OLD.snapshot_valid_until
    OR NEW.replaced_by_event_id IS DISTINCT FROM OLD.replaced_by_event_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'source snapshot replacement evidence is immutable';
  END IF;

  IF OLD.snapshot_valid_until IS NULL
     AND NEW.snapshot_valid_until IS NOT NULL THEN
    SELECT pg_catalog.count(*) = 1
    INTO replacement_is_valid
    FROM public.memory_ingest_events AS replacement
    WHERE replacement.id = NEW.replaced_by_event_id
      AND replacement.agent_id = NEW.agent_id
      AND replacement.projection_mode = 'replace_source'
      AND replacement.status = 'indexed'
      AND replacement.source = NEW.source
      AND (replacement.accepted_at, replacement.id)
        > (NEW.accepted_at, NEW.id);

    IF NOT replacement_is_valid THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'source snapshot replacement evidence is invalid';
    END IF;
  ELSIF NEW.snapshot_valid_until IS DISTINCT FROM OLD.snapshot_valid_until
     OR NEW.replaced_by_event_id IS DISTINCT FROM OLD.replaced_by_event_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'source snapshot replacement evidence must be written together';
  END IF;

  IF NOT old_terminal AND new_terminal THEN
    IF NEW.terminal_failure_transition_count <> OLD.terminal_failure_transition_count + 1
       OR NEW.latest_terminal_failure_at IS NULL
       OR NEW.latest_terminal_failure_build_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'terminal memory ingest transition requires failure evidence';
    END IF;
    IF OLD.terminal_failure_transition_count = 0 THEN
      IF NEW.first_terminal_failure_at IS DISTINCT FROM NEW.latest_terminal_failure_at
         OR NEW.first_terminal_failure_build_id IS DISTINCT FROM NEW.latest_terminal_failure_build_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'first terminal memory ingest evidence must match the first transition';
      END IF;
    ELSIF NEW.first_terminal_failure_at IS DISTINCT FROM OLD.first_terminal_failure_at
       OR NEW.first_terminal_failure_build_id IS DISTINCT FROM OLD.first_terminal_failure_build_id
       OR NEW.latest_terminal_failure_at < OLD.latest_terminal_failure_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'first terminal memory ingest evidence is immutable';
    END IF;
  ELSIF NEW.first_terminal_failure_at IS DISTINCT FROM OLD.first_terminal_failure_at
     OR NEW.first_terminal_failure_build_id IS DISTINCT FROM OLD.first_terminal_failure_build_id
     OR NEW.latest_terminal_failure_at IS DISTINCT FROM OLD.latest_terminal_failure_at
     OR NEW.latest_terminal_failure_build_id IS DISTINCT FROM OLD.latest_terminal_failure_build_id
     OR NEW.terminal_failure_transition_count IS DISTINCT FROM OLD.terminal_failure_transition_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'terminal memory ingest evidence changes only on a terminal transition';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER memory_ingest_events_history_guard
BEFORE INSERT OR UPDATE ON public.memory_ingest_events
FOR EACH ROW
EXECUTE FUNCTION public.enforce_memory_ingest_event_history();

CREATE INDEX memory_ingest_events_claim_idx
  ON public.memory_ingest_events (
    status,
    next_attempt_at,
    lease_expires_at,
    accepted_at
  )
  WHERE status IN ('accepted', 'processing', 'failed');

CREATE INDEX memory_ingest_events_source_idx
  ON public.memory_ingest_events (agent_id, source, accepted_at, id)
  WHERE projection_mode = 'replace_source' AND source IS NOT NULL;

CREATE FUNCTION public.build_memory_search_document(
  memory_content text,
  memory_summary text,
  memory_entities text[],
  memory_semantic_tags text[]
)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT
    pg_catalog.setweight(
      pg_catalog.to_tsvector(
        'english'::pg_catalog.regconfig,
        COALESCE(memory_content, '')
      ),
      'A'
    )
    || pg_catalog.setweight(
      pg_catalog.to_tsvector(
        'english'::pg_catalog.regconfig,
        COALESCE(memory_summary, '')
      ),
      'B'
    )
    || pg_catalog.setweight(
      pg_catalog.to_tsvector(
        'english'::pg_catalog.regconfig,
        COALESCE(pg_catalog.array_to_string(memory_entities, ' '), '')
      ),
      'A'
    )
    || pg_catalog.setweight(
      pg_catalog.to_tsvector(
        'english'::pg_catalog.regconfig,
        COALESCE(pg_catalog.array_to_string(memory_semantic_tags, ' '), '')
      ),
      'B'
    )
$function$;

ALTER TABLE public.memory_nodes
  ADD COLUMN ingest_event_id uuid,
  ADD COLUMN ingest_chunk_index integer,
  ADD COLUMN content_hash text,
  ADD COLUMN projection_fingerprint text,
  ADD COLUMN embedding_provider varchar(64),
  ADD COLUMN embedding_model varchar(128),
  ADD COLUMN derivation_expires_at timestamptz,
  ADD COLUMN resonance_components jsonb NOT NULL
    DEFAULT '{"version":"pending_recalculation"}'::jsonb,
  ADD COLUMN search_document tsvector
    GENERATED ALWAYS AS (
      public.build_memory_search_document(
        content,
        summary,
        entities,
        semantic_tags
      )
    ) STORED NOT NULL;

ALTER TABLE public.memory_nodes
  ADD CONSTRAINT memory_nodes_ingest_event_fkey
    FOREIGN KEY (ingest_event_id, agent_id)
    REFERENCES public.memory_ingest_events(id, agent_id),
  ADD CONSTRAINT memory_nodes_ingest_metadata_check CHECK (
    (
      ingest_event_id IS NULL
      AND ingest_chunk_index IS NULL
      AND content_hash IS NULL
      AND projection_fingerprint IS NULL
      AND embedding_provider IS NULL
      AND embedding_model IS NULL
    )
    OR
    (
      ingest_event_id IS NOT NULL
      AND ingest_chunk_index IS NOT NULL
      AND ingest_chunk_index >= 0
      AND content_hash IS NOT NULL
      AND content_hash ~ '^[0-9a-f]{64}$'
      AND projection_fingerprint IS NOT NULL
      AND projection_fingerprint ~ '^[0-9a-f]{64}$'
      AND embedding_provider IS NOT NULL
      AND pg_catalog.length(embedding_provider) BETWEEN 1 AND 64
      AND embedding_model IS NOT NULL
      AND pg_catalog.length(embedding_model) BETWEEN 1 AND 128
    )
  );

CREATE UNIQUE INDEX memory_nodes_ingest_chunk_key
  ON public.memory_nodes (ingest_event_id, ingest_chunk_index)
  WHERE ingest_event_id IS NOT NULL AND ingest_chunk_index IS NOT NULL;

CREATE INDEX memory_nodes_projection_fingerprint_idx
  ON public.memory_nodes (agent_id, projection_fingerprint)
  WHERE status = 'active' AND projection_fingerprint IS NOT NULL;

CREATE INDEX memory_nodes_search_document_idx
  ON public.memory_nodes USING gin (search_document);

ALTER TABLE public.memory_ingest_events
  ADD CONSTRAINT memory_ingest_events_predecessor_fkey
    FOREIGN KEY (predecessor_memory_id, agent_id)
    REFERENCES public.memory_nodes(id, agent_id);

CREATE TABLE public.memory_provenance (
  id uuid PRIMARY KEY,
  agent_id integer NOT NULL REFERENCES public.agents(id),
  memory_id integer NOT NULL,
  ingest_event_id uuid,
  source_memory_id integer,
  relation varchar(32) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT memory_provenance_memory_fkey
    FOREIGN KEY (memory_id, agent_id)
    REFERENCES public.memory_nodes(id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT memory_provenance_event_fkey
    FOREIGN KEY (ingest_event_id, agent_id)
    REFERENCES public.memory_ingest_events(id, agent_id),
  CONSTRAINT memory_provenance_source_memory_fkey
    FOREIGN KEY (source_memory_id, agent_id)
    REFERENCES public.memory_nodes(id, agent_id),
  CONSTRAINT memory_provenance_source_check CHECK (
    ingest_event_id IS NOT NULL OR source_memory_id IS NOT NULL
  ),
  CONSTRAINT memory_provenance_self_check CHECK (
    source_memory_id IS NULL OR source_memory_id <> memory_id
  ),
  CONSTRAINT memory_provenance_relation_check CHECK (
    relation = pg_catalog.btrim(relation)
    AND pg_catalog.length(relation) BETWEEN 1 AND 32
  ),
  CONSTRAINT memory_provenance_relation_key
    UNIQUE NULLS NOT DISTINCT (
      agent_id,
      memory_id,
      ingest_event_id,
      source_memory_id,
      relation
    )
);

CREATE INDEX memory_provenance_memory_idx
  ON public.memory_provenance (agent_id, memory_id);
CREATE INDEX memory_provenance_event_idx
  ON public.memory_provenance (agent_id, ingest_event_id)
  WHERE ingest_event_id IS NOT NULL;

CREATE TABLE public.working_memory_items (
  id uuid PRIMARY KEY,
  agent_id integer NOT NULL REFERENCES public.agents(id),
  caller_key varchar(256) NOT NULL,
  kind varchar(32) NOT NULL,
  content text NOT NULL,
  source_memory_id integer,
  source_event_id uuid,
  status varchar(32) NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  importance real NOT NULL DEFAULT 0.5,
  last_confirmed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution_reason varchar(512),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT working_memory_items_id_agent_key UNIQUE (id, agent_id),
  CONSTRAINT working_memory_items_agent_caller_key
    UNIQUE (agent_id, caller_key),
  CONSTRAINT working_memory_items_source_memory_fkey
    FOREIGN KEY (source_memory_id, agent_id)
    REFERENCES public.memory_nodes(id, agent_id),
  CONSTRAINT working_memory_items_source_event_fkey
    FOREIGN KEY (source_event_id, agent_id)
    REFERENCES public.memory_ingest_events(id, agent_id),
  CONSTRAINT working_memory_items_caller_key_check CHECK (
    caller_key = pg_catalog.btrim(caller_key)
    AND pg_catalog.octet_length(caller_key) BETWEEN 1 AND 256
  ),
  CONSTRAINT working_memory_items_kind_check CHECK (
    kind IN (
      'current_task', 'open_loop', 'constraint', 'correction', 'preference'
    )
  ),
  CONSTRAINT working_memory_items_content_check CHECK (
    pg_catalog.length(pg_catalog.btrim(content)) > 0
    AND pg_catalog.octet_length(content) <= 8192
  ),
  CONSTRAINT working_memory_items_status_check CHECK (
    status IN ('active', 'resolved', 'expired')
  ),
  CONSTRAINT working_memory_items_display_order_check CHECK (
    display_order BETWEEN -1000000 AND 1000000
  ),
  CONSTRAINT working_memory_items_importance_check CHECK (
    importance BETWEEN 0 AND 1
  ),
  CONSTRAINT working_memory_items_correction_source_check CHECK (
    kind <> 'correction' OR source_memory_id IS NOT NULL
  ),
  CONSTRAINT working_memory_items_time_check CHECK (
    last_confirmed_at >= created_at
    AND expires_at > last_confirmed_at
    AND expires_at <= last_confirmed_at + INTERVAL '30 days'
    AND updated_at >= created_at
    AND updated_at >= last_confirmed_at
    AND (resolved_at IS NULL OR resolved_at >= created_at)
    AND (resolved_at IS NULL OR updated_at >= resolved_at)
  ),
  CONSTRAINT working_memory_items_resolution_check CHECK (
    (
      status = 'active'
      AND resolved_at IS NULL
      AND resolution_reason IS NULL
    )
    OR (
      status IN ('resolved', 'expired')
      AND resolved_at IS NOT NULL
      AND resolution_reason IS NOT NULL
      AND resolution_reason = pg_catalog.btrim(resolution_reason)
      AND pg_catalog.octet_length(resolution_reason) BETWEEN 1 AND 512
    )
  )
);

CREATE INDEX working_memory_items_active_idx
  ON public.working_memory_items (
    agent_id,
    status,
    expires_at,
    display_order,
    importance DESC,
    last_confirmed_at DESC
  );
CREATE INDEX working_memory_items_source_memory_idx
  ON public.working_memory_items (source_memory_id, agent_id)
  WHERE source_memory_id IS NOT NULL;
CREATE INDEX working_memory_items_source_event_idx
  ON public.working_memory_items (source_event_id, agent_id)
  WHERE source_event_id IS NOT NULL;

CREATE TABLE public.memory_retrievals (
  id uuid PRIMARY KEY,
  agent_id integer NOT NULL REFERENCES public.agents(id),
  request_id varchar(128),
  session_id varchar(128),
  query text,
  query_hash text NOT NULL,
  channel varchar(32) NOT NULL,
  status varchar(32) NOT NULL,
  error_code varchar(64),
  algorithm_version varchar(128) NOT NULL,
  build_id varchar(128) NOT NULL,
  token_budget integer,
  candidate_count integer NOT NULL DEFAULT 0,
  returned_count integer NOT NULL DEFAULT 0,
  latency_ms integer,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  redacted_at timestamptz,
  CONSTRAINT memory_retrievals_id_agent_key UNIQUE (id, agent_id),
  CONSTRAINT memory_retrievals_request_id_check CHECK (
    request_id IS NULL OR (
      request_id = pg_catalog.btrim(request_id)
      AND pg_catalog.octet_length(request_id) BETWEEN 1 AND 128
    )
  ),
  CONSTRAINT memory_retrievals_session_id_check CHECK (
    session_id IS NULL OR (
      session_id = pg_catalog.btrim(session_id)
      AND pg_catalog.octet_length(session_id) BETWEEN 1 AND 128
    )
  ),
  CONSTRAINT memory_retrievals_query_check CHECK (
    (
      query IS NOT NULL
      AND pg_catalog.length(pg_catalog.btrim(query)) > 0
      AND pg_catalog.octet_length(query) <= 8192
    )
    OR (query IS NULL AND redacted_at IS NOT NULL)
  ),
  CONSTRAINT memory_retrievals_query_hash_check CHECK (
    query_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT memory_retrievals_channel_check CHECK (
    channel IN ('search', 'recall', 'init', 'hook', 'gateway', 'evaluation')
  ),
  CONSTRAINT memory_retrievals_status_check CHECK (
    status IN ('running', 'completed', 'failed')
  ),
  CONSTRAINT memory_retrievals_error_code_check CHECK (
    error_code IS NULL OR (
      error_code = pg_catalog.btrim(error_code)
      AND pg_catalog.octet_length(error_code) BETWEEN 1 AND 64
    )
  ),
  CONSTRAINT memory_retrievals_identity_check CHECK (
    algorithm_version = pg_catalog.btrim(algorithm_version)
    AND pg_catalog.octet_length(algorithm_version) BETWEEN 1 AND 128
    AND build_id = pg_catalog.btrim(build_id)
    AND pg_catalog.octet_length(build_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT memory_retrievals_token_budget_check CHECK (
    token_budget IS NULL OR token_budget BETWEEN 1 AND 32000
  ),
  CONSTRAINT memory_retrievals_count_check CHECK (
    candidate_count BETWEEN 0 AND 500
    AND returned_count BETWEEN 0 AND 50
    AND returned_count <= candidate_count
  ),
  CONSTRAINT memory_retrievals_latency_check CHECK (
    latency_ms IS NULL OR latency_ms >= 0
  ),
  CONSTRAINT memory_retrievals_time_check CHECK (
    (completed_at IS NULL OR completed_at >= created_at)
    AND (redacted_at IS NULL OR redacted_at >= created_at)
  ),
  CONSTRAINT memory_retrievals_state_check CHECK (
    (
      status = 'running'
      AND completed_at IS NULL
      AND error_code IS NULL
    )
    OR (
      status = 'completed'
      AND completed_at IS NOT NULL
      AND error_code IS NULL
    )
    OR (
      status = 'failed'
      AND completed_at IS NOT NULL
      AND error_code IS NOT NULL
    )
  ),
  CONSTRAINT memory_retrievals_redaction_check CHECK (
    redacted_at IS NULL
    OR (query IS NULL AND request_id IS NULL AND session_id IS NULL)
  )
);

CREATE INDEX memory_retrievals_agent_created_idx
  ON public.memory_retrievals (agent_id, created_at DESC);

CREATE FUNCTION public.is_valid_memory_retrieval_components(
  candidate_lanes text[],
  component_ranks jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = pg_catalog
AS $function$
DECLARE
  candidate_lane text;
  component jsonb;
  component_lane text;
  component_rank numeric;
  seen_candidate_lanes text[] := ARRAY[]::text[];
  seen_component_lanes text[] := ARRAY[]::text[];
BEGIN
  IF pg_catalog.cardinality(candidate_lanes) NOT BETWEEN 1 AND 6
     OR pg_catalog.jsonb_typeof(component_ranks) <> 'array'
     OR pg_catalog.jsonb_array_length(component_ranks) NOT BETWEEN 1 AND 6
     OR pg_catalog.octet_length(component_ranks::text) > 4096 THEN
    RETURN false;
  END IF;

  FOREACH candidate_lane IN ARRAY candidate_lanes LOOP
    IF candidate_lane IS NULL
       OR candidate_lane NOT IN (
         'working', 'lexical', 'vector', 'entity', 'graph', 'artifact'
       )
       OR candidate_lane = ANY(seen_candidate_lanes) THEN
      RETURN false;
    END IF;
    seen_candidate_lanes := pg_catalog.array_append(
      seen_candidate_lanes,
      candidate_lane
    );
  END LOOP;

  FOR component IN
    SELECT value
    FROM pg_catalog.jsonb_array_elements(component_ranks)
  LOOP
    IF pg_catalog.jsonb_typeof(component) <> 'object'
       OR NOT (component ? 'lane')
       OR NOT (component ? 'rank')
       OR component - ARRAY['lane', 'rank', 'sourceScore']::text[]
         <> '{}'::jsonb
       OR pg_catalog.jsonb_typeof(component -> 'lane') <> 'string'
       OR pg_catalog.jsonb_typeof(component -> 'rank') <> 'number'
       OR (
         component ? 'sourceScore'
         AND pg_catalog.jsonb_typeof(component -> 'sourceScore') <> 'number'
       ) THEN
      RETURN false;
    END IF;

    component_lane := component ->> 'lane';
    component_rank := (component ->> 'rank')::numeric;
    IF NOT component_lane = ANY(candidate_lanes)
       OR component_lane = ANY(seen_component_lanes)
       OR component_rank < 1
       OR component_rank > 500
       OR component_rank <> pg_catalog.trunc(component_rank) THEN
      RETURN false;
    END IF;
    seen_component_lanes := pg_catalog.array_append(
      seen_component_lanes,
      component_lane
    );
  END LOOP;

  RETURN pg_catalog.cardinality(seen_candidate_lanes)
    = pg_catalog.cardinality(seen_component_lanes);
END
$function$;

CREATE TABLE public.memory_retrieval_items (
  id uuid PRIMARY KEY,
  agent_id integer NOT NULL,
  retrieval_id uuid NOT NULL,
  memory_id integer,
  working_item_id uuid,
  content_hash text NOT NULL,
  candidate_lanes text[] NOT NULL,
  component_ranks jsonb NOT NULL,
  final_score real NOT NULL,
  final_rank integer NOT NULL,
  created_at timestamptz NOT NULL,
  returned_at timestamptz,
  CONSTRAINT memory_retrieval_items_id_agent_key UNIQUE (id, agent_id),
  CONSTRAINT memory_retrieval_items_retrieval_fkey
    FOREIGN KEY (retrieval_id, agent_id)
    REFERENCES public.memory_retrievals(id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT memory_retrieval_items_memory_fkey
    FOREIGN KEY (memory_id, agent_id)
    REFERENCES public.memory_nodes(id, agent_id),
  CONSTRAINT memory_retrieval_items_working_item_fkey
    FOREIGN KEY (working_item_id, agent_id)
    REFERENCES public.working_memory_items(id, agent_id),
  CONSTRAINT memory_retrieval_items_reference_check CHECK (
    pg_catalog.num_nonnulls(memory_id, working_item_id) = 1
  ),
  CONSTRAINT memory_retrieval_items_retrieval_memory_key
    UNIQUE (retrieval_id, memory_id),
  CONSTRAINT memory_retrieval_items_retrieval_working_key
    UNIQUE (retrieval_id, working_item_id),
  CONSTRAINT memory_retrieval_items_retrieval_rank_key
    UNIQUE (retrieval_id, final_rank),
  CONSTRAINT memory_retrieval_items_content_hash_check CHECK (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT memory_retrieval_items_candidate_lanes_check CHECK (
    pg_catalog.cardinality(candidate_lanes) BETWEEN 1 AND 6
    AND pg_catalog.array_position(candidate_lanes, NULL) IS NULL
    AND candidate_lanes <@ ARRAY[
      'working',
      'lexical',
      'vector',
      'entity',
      'graph',
      'artifact'
    ]::text[]
  ),
  CONSTRAINT memory_retrieval_items_component_ranks_check CHECK (
    public.is_valid_memory_retrieval_components(
      candidate_lanes,
      component_ranks
    )
  ),
  CONSTRAINT memory_retrieval_items_score_check CHECK (
    final_score BETWEEN 0 AND 1
  ),
  CONSTRAINT memory_retrieval_items_rank_check CHECK (
    final_rank BETWEEN 1 AND 500
  ),
  CONSTRAINT memory_retrieval_items_returned_time_check CHECK (
    returned_at IS NULL OR returned_at >= created_at
  )
);

CREATE INDEX memory_retrieval_items_memory_returned_idx
  ON public.memory_retrieval_items (memory_id, agent_id, returned_at DESC);

CREATE INDEX memory_retrieval_items_working_returned_idx
  ON public.memory_retrieval_items (
    working_item_id,
    agent_id,
    returned_at DESC
  )
  WHERE working_item_id IS NOT NULL;

CREATE INDEX memory_retrieval_items_returned_idx
  ON public.memory_retrieval_items (agent_id, returned_at DESC)
  WHERE returned_at IS NOT NULL;

CREATE FUNCTION public.enforce_memory_retrieval_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  persisted_candidate_count integer;
  persisted_returned_count integer;
  latest_candidate_at timestamptz;
  latest_returned_at timestamptz;
  redaction_only boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running'
       OR NEW.error_code IS NOT NULL
       OR NEW.candidate_count <> 0
       OR NEW.returned_count <> 0
       OR NEW.latency_ms IS NOT NULL
       OR NEW.completed_at IS NOT NULL
       OR NEW.redacted_at IS NOT NULL
       OR NEW.query IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'retrieval evidence must begin in the empty running state';
    END IF;
    RETURN NEW;
  END IF;

  redaction_only :=
    OLD.status IN ('completed', 'failed')
    AND OLD.redacted_at IS NULL
    AND NEW.redacted_at IS NOT NULL
    AND NEW.redacted_at >= OLD.completed_at
    AND NEW.query IS NULL
    AND NEW.request_id IS NULL
    AND NEW.session_id IS NULL
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.agent_id IS NOT DISTINCT FROM OLD.agent_id
    AND NEW.query_hash IS NOT DISTINCT FROM OLD.query_hash
    AND NEW.channel IS NOT DISTINCT FROM OLD.channel
    AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.error_code IS NOT DISTINCT FROM OLD.error_code
    AND NEW.algorithm_version IS NOT DISTINCT FROM OLD.algorithm_version
    AND NEW.build_id IS NOT DISTINCT FROM OLD.build_id
    AND NEW.token_budget IS NOT DISTINCT FROM OLD.token_budget
    AND NEW.candidate_count IS NOT DISTINCT FROM OLD.candidate_count
    AND NEW.returned_count IS NOT DISTINCT FROM OLD.returned_count
    AND NEW.latency_ms IS NOT DISTINCT FROM OLD.latency_ms
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
    AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at;

  IF redaction_only THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.query IS DISTINCT FROM OLD.query
     OR NEW.query_hash IS DISTINCT FROM OLD.query_hash
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.algorithm_version IS DISTINCT FROM OLD.algorithm_version
     OR NEW.build_id IS DISTINCT FROM OLD.build_id
     OR NEW.token_budget IS DISTINCT FROM OLD.token_budget
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.redacted_at IS DISTINCT FROM OLD.redacted_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'retrieval identity and raw evidence are immutable';
  END IF;

  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'terminal retrieval evidence is immutable';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (WHERE returned_at IS NOT NULL)::integer,
    pg_catalog.max(created_at),
    pg_catalog.max(returned_at)
  INTO
    persisted_candidate_count,
    persisted_returned_count,
    latest_candidate_at,
    latest_returned_at
  FROM public.memory_retrieval_items
  WHERE retrieval_id = OLD.id
    AND agent_id = OLD.agent_id;

  IF NEW.status = 'running' THEN
    IF NEW.error_code IS NOT NULL
       OR NEW.returned_count <> 0
       OR NEW.latency_ms IS NOT NULL
       OR NEW.completed_at IS NOT NULL
       OR persisted_returned_count <> 0
       OR NEW.candidate_count <> persisted_candidate_count
       OR (
         OLD.candidate_count <> 0
         AND NEW.candidate_count <> OLD.candidate_count
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'running retrieval evidence does not match persisted candidacy';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('completed', 'failed')
     OR NEW.completed_at IS NULL
     OR NEW.latency_ms IS NULL
     OR NEW.candidate_count <> OLD.candidate_count
     OR NEW.candidate_count <> persisted_candidate_count
     OR NEW.returned_count <> persisted_returned_count
     OR (
       latest_candidate_at IS NOT NULL
       AND latest_candidate_at > NEW.completed_at
     )
     OR (
       latest_returned_at IS NOT NULL
       AND latest_returned_at > NEW.completed_at
     )
     OR (NEW.status = 'failed' AND persisted_returned_count <> 0) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'terminal retrieval evidence does not match persisted delivery';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER memory_retrievals_history_guard
BEFORE INSERT OR UPDATE ON public.memory_retrievals
FOR EACH ROW
EXECUTE FUNCTION public.enforce_memory_retrieval_history();

CREATE FUNCTION public.enforce_memory_retrieval_item_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  parent_status text;
  parent_candidate_count integer;
  parent_created_at timestamptz;
  persisted_candidate_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status, candidate_count, created_at
    INTO parent_status, parent_candidate_count, parent_created_at
    FROM public.memory_retrievals
    WHERE id = NEW.retrieval_id
      AND agent_id = NEW.agent_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'retrieval candidate must reference an owned retrieval';
    END IF;

    IF NEW.returned_at IS NOT NULL
       OR parent_status <> 'running'
       OR parent_candidate_count <> 0
       OR NEW.created_at < parent_created_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'retrieval candidates must be inserted during candidacy';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.retrieval_id IS DISTINCT FROM OLD.retrieval_id
     OR NEW.memory_id IS DISTINCT FROM OLD.memory_id
     OR NEW.working_item_id IS DISTINCT FROM OLD.working_item_id
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.candidate_lanes IS DISTINCT FROM OLD.candidate_lanes
     OR NEW.component_ranks IS DISTINCT FROM OLD.component_ranks
     OR NEW.final_score IS DISTINCT FROM OLD.final_score
     OR NEW.final_rank IS DISTINCT FROM OLD.final_rank
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'retrieval candidate evidence is immutable';
  END IF;

  IF OLD.returned_at IS NOT NULL
     AND NEW.returned_at IS DISTINCT FROM OLD.returned_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'retrieval delivery evidence is append-only';
  END IF;

  IF OLD.returned_at IS NULL AND NEW.returned_at IS NOT NULL THEN
    SELECT status, candidate_count
    INTO parent_status, parent_candidate_count
    FROM public.memory_retrievals
    WHERE id = NEW.retrieval_id
      AND agent_id = NEW.agent_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'retrieval delivery must reference an owned retrieval';
    END IF;

    SELECT pg_catalog.count(*)::integer
    INTO persisted_candidate_count
    FROM public.memory_retrieval_items
    WHERE retrieval_id = NEW.retrieval_id
      AND agent_id = NEW.agent_id;

    IF parent_status <> 'running'
       OR parent_candidate_count <> persisted_candidate_count THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'retrieval delivery requires finalized running candidacy';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER memory_retrieval_items_history_guard
BEFORE INSERT OR UPDATE ON public.memory_retrieval_items
FOR EACH ROW
EXECUTE FUNCTION public.enforce_memory_retrieval_item_history();

CREATE FUNCTION public.enforce_working_memory_item_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active'
       OR NEW.resolved_at IS NOT NULL
       OR NEW.resolution_reason IS NOT NULL
       OR NEW.created_at IS DISTINCT FROM NEW.last_confirmed_at
       OR NEW.created_at IS DISTINCT FROM NEW.updated_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'working memory must begin as a freshly confirmed active item';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.caller_key IS DISTINCT FROM OLD.caller_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.last_confirmed_at < OLD.last_confirmed_at
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'working memory identity and chronology are append-only';
  END IF;

  IF OLD.status IN ('resolved', 'expired') THEN
    IF NEW.status <> 'active'
       OR NEW.last_confirmed_at < OLD.last_confirmed_at
       OR NEW.resolved_at IS NOT NULL
       OR NEW.resolution_reason IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'terminal working memory may only be explicitly reconfirmed';
    END IF;
  ELSIF OLD.status = 'active'
        AND NEW.status NOT IN ('active', 'resolved', 'expired') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'working memory status transition is invalid';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER working_memory_items_history_guard
BEFORE INSERT OR UPDATE ON public.working_memory_items
FOR EACH ROW
EXECUTE FUNCTION public.enforce_working_memory_item_history();

CREATE TABLE public.memory_operation_runs (
  id uuid PRIMARY KEY,
  agent_id integer REFERENCES public.agents(id),
  operation varchar(32) NOT NULL,
  status varchar(32) NOT NULL,
  build_id varchar(128) NOT NULL,
  worker_id varchar(128) NOT NULL,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code varchar(64),
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT memory_operation_runs_operation_check CHECK (
    operation IN ('ingest_worker', 'reflection')
  ),
  CONSTRAINT memory_operation_runs_status_check CHECK (
    status IN ('running', 'succeeded', 'failed', 'stopped')
  ),
  CONSTRAINT memory_operation_runs_identity_check CHECK (
    build_id = pg_catalog.btrim(build_id)
    AND pg_catalog.length(build_id) BETWEEN 1 AND 128
    AND worker_id = pg_catalog.btrim(worker_id)
    AND pg_catalog.length(worker_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT memory_operation_runs_counters_check CHECK (
    pg_catalog.jsonb_typeof(counters) = 'object'
    AND pg_catalog.octet_length(counters::text) <= 4096
  ),
  CONSTRAINT memory_operation_runs_time_check CHECK (
    heartbeat_at >= started_at
    AND (completed_at IS NULL OR completed_at >= started_at)
  ),
  CONSTRAINT memory_operation_runs_completion_check CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status <> 'running' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX memory_operation_runs_readiness_idx
  ON public.memory_operation_runs (operation, status, heartbeat_at DESC);

ALTER TABLE public.memory_nodes
  ALTER COLUMN last_accessed_at DROP DEFAULT,
  ALTER COLUMN resonance_score SET DEFAULT 0.5;

UPDATE public.memory_nodes
SET access_count = 0,
    last_accessed_at = NULL,
    last_recalled_at = NULL,
    resonance_score = 0.5,
    resonance_components = '{"version":"pending_recalculation"}'::jsonb;

DO $roles$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'cortex_memory_runtime'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'protected Cortex memory role must not preexist migration 010';
  END IF;

  CREATE ROLE cortex_memory_runtime NOLOGIN;
END
$roles$;

ALTER ROLE cortex_memory_runtime
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM cortex_memory_runtime;
GRANT USAGE ON SCHEMA public TO cortex_memory_runtime;

DO $runtime_schema_privileges$
BEGIN
  IF pg_catalog.has_schema_privilege(
    'cortex_memory_runtime',
    'public',
    'CREATE'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cortex memory runtime inherits forbidden schema create privilege';
  END IF;
END
$runtime_schema_privileges$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM cortex_memory_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM cortex_memory_runtime;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM cortex_memory_runtime;

REVOKE ALL PRIVILEGES ON TABLE
  public.memory_ingest_events,
  public.memory_provenance,
  public.working_memory_items,
  public.memory_retrievals,
  public.memory_retrieval_items,
  public.memory_operation_runs
FROM PUBLIC, cortex_oauth_runtime, cortex_oauth_operator;

REVOKE ALL PRIVILEGES ON FUNCTION
  public.build_memory_search_document(text, text, text[], text[]),
  public.is_valid_memory_retrieval_components(text[], jsonb),
  public.enforce_memory_retrieval_history(),
  public.enforce_memory_retrieval_item_history(),
  public.enforce_working_memory_item_history()
FROM PUBLIC, cortex_oauth_runtime, cortex_oauth_operator,
  cortex_memory_runtime;

GRANT EXECUTE ON FUNCTION
  public.build_memory_search_document(text, text, text[], text[]),
  public.is_valid_memory_retrieval_components(text[], jsonb)
TO cortex_memory_runtime;

GRANT SELECT ON TABLE public.cortex_schema_migrations TO cortex_memory_runtime;
GRANT SELECT (id, external_id) ON TABLE public.agents TO cortex_memory_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.memory_nodes,
  public.memory_synapses,
  public.hippocampal_codes,
  public.emotional_valence,
  public.procedural_memories,
  public.cognitive_artifacts,
  public.dream_cycle_logs,
  public.self_diagnostics,
  public.agent_state_logs,
  public.principal_state,
  public.background_threads,
  public.relationship_graph
TO cortex_memory_runtime;

GRANT SELECT, INSERT ON TABLE
  public.working_memory_items
TO cortex_memory_runtime;

GRANT UPDATE (
  kind,
  content,
  source_memory_id,
  source_event_id,
  status,
  display_order,
  importance,
  last_confirmed_at,
  expires_at,
  resolved_at,
  resolution_reason,
  updated_at
) ON public.working_memory_items TO cortex_memory_runtime;

GRANT SELECT, INSERT ON TABLE
  public.memory_ingest_events
TO cortex_memory_runtime;

GRANT UPDATE (
  status,
  total_attempts,
  cycle_attempts,
  manual_retry_count,
  lease_owner,
  lease_token,
  lease_expires_at,
  next_attempt_at,
  failure_code,
  failure_message,
  warning_codes,
  possible_update_ids,
  projection_count,
  synapse_count,
  started_at,
  projected_at,
  indexed_at,
  snapshot_valid_until,
  replaced_by_event_id,
  updated_at,
  indexed_build_id,
  first_terminal_failure_at,
  first_terminal_failure_build_id,
  latest_terminal_failure_at,
  latest_terminal_failure_build_id,
  terminal_failure_transition_count
) ON public.memory_ingest_events TO cortex_memory_runtime;

GRANT SELECT, INSERT ON TABLE
  public.memory_provenance
TO cortex_memory_runtime;

GRANT SELECT, INSERT ON TABLE
  public.memory_retrievals
TO cortex_memory_runtime;

GRANT UPDATE (
  status,
  error_code,
  candidate_count,
  returned_count,
  latency_ms,
  completed_at
) ON public.memory_retrievals TO cortex_memory_runtime;

GRANT SELECT, INSERT ON TABLE
  public.memory_retrieval_items
TO cortex_memory_runtime;

GRANT UPDATE (
  returned_at
) ON public.memory_retrieval_items TO cortex_memory_runtime;

GRANT SELECT, INSERT ON TABLE
  public.memory_operation_runs
TO cortex_memory_runtime;

GRANT UPDATE (
  status,
  counters,
  error_code,
  heartbeat_at,
  completed_at
) ON public.memory_operation_runs TO cortex_memory_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.memory_nodes_id_seq,
  public.memory_synapses_id_seq,
  public.hippocampal_codes_id_seq,
  public.emotional_valence_id_seq,
  public.procedural_memories_id_seq,
  public.cognitive_artifacts_id_seq,
  public.dream_cycle_logs_id_seq,
  public.self_diagnostics_id_seq,
  public.agent_state_logs_id_seq,
  public.principal_state_id_seq,
  public.background_threads_id_seq,
  public.relationship_graph_id_seq
TO cortex_memory_runtime;
