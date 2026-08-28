import postgres, { type Sql } from "postgres";
import { isIP } from "node:net";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SQL } from "drizzle-orm";
import * as schema from "./schema.js";
import {
  assertRequiredMigrations,
  REQUIRED_MIGRATIONS,
} from "./migrations.js";
import "dotenv/config";

const DATABASE_URL = process.env.DATABASE_URL!;

export function postgresTlsOptions(databaseUrl: string | undefined): { ssl?: "verify-full" } {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  try {
    const url = new URL(databaseUrl);
    if (
      !new Set(["postgres:", "postgresql:"]).has(url.protocol) ||
      databaseUrl.includes("#") ||
      (databaseUrl.includes("?") && url.search !== "?sslmode=verify-full")
    ) {
      throw new Error("invalid");
    }
    for (const [key, value] of url.searchParams) {
      if (
        key !== "sslmode" ||
        url.searchParams.getAll(key).length !== 1 ||
        value !== "verify-full"
      ) {
        throw new Error("unsupported");
      }
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const octets = host.split(".").map(Number);
    const isPrivateIpv4 =
      octets.length === 4 &&
      octets.every((octet) => Number.isInteger(octet)) &&
      (octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168));
    const isPrivate =
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      (!host.includes(".") && !host.includes(":")) ||
      isPrivateIpv4 ||
      (isIP(host) === 6 && /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host));
    return !isPrivate && !url.searchParams.has("sslmode")
      ? { ssl: "verify-full" }
      : {};
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL with safe TLS parameters");
  }
}

const client = postgres(DATABASE_URL, {
  ...postgresTlsOptions(DATABASE_URL),
  onnotice: () => {
    console.error("[db notice] PostgreSQL notice received");
  },
});

export const sqlClient = client;

const rawDb = drizzle(client, { schema });

// Neon HTTP driver returns { rows: [...], rowCount: N }.
// postgres-js returns RowList (array-like, no .rows).
// This shim adds .rows/.rowCount at runtime so the entire codebase works unchanged.
interface NeonCompatResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

type CortexDb = Omit<PostgresJsDatabase<typeof schema>, "execute"> & {
  execute: (query: SQL) => Promise<NeonCompatResult>;
};

const origExecute = rawDb.execute.bind(rawDb);
const patchedDb = rawDb as unknown as CortexDb;
(patchedDb as any).execute = async (query: SQL): Promise<NeonCompatResult> => {
  const result = await origExecute(query);
  const arr = Array.isArray(result) ? [...result] : [];
  // postgres-js reports affected rows for INSERT/UPDATE/DELETE on result.count;
  // the array itself is empty unless RETURNING is used. Deriving rowCount from
  // arr.length made every write query report 0 (dream-cycle stats showed
  // phase1_resonanceUpdated=0 etc. every night while the updates ran fine).
  // For SELECT, count === arr.length, so preferring count is always correct.
  const affected = (result as unknown as { count?: number }).count;
  return Object.assign(result, {
    rows: arr,
    rowCount: typeof affected === "number" ? affected : arr.length,
  }) as unknown as NeonCompatResult;
};

export const db = patchedDb;

let databaseInitPromise: Promise<void> | null = null;

// Runtime services never execute DDL. They only assert that the migration owner
// applied the exact checked-in security migration before the process starts.
export async function initDatabase(): Promise<void> {
  if (!databaseInitPromise) {
    databaseInitPromise = assertRequiredMigrations(client, REQUIRED_MIGRATIONS).catch((error) => {
      databaseInitPromise = null;
      throw error;
    });
  }

  return databaseInitPromise;
}

// The historical Build 1-8 routine remains idempotent, but only migration
// entrypoints call it. Runtime services call initDatabase() above.
export async function runLegacyBuildMigrations(migrationSql: Sql = client): Promise<void> {
  await migrationSql.begin(async (transaction) => {
    await transaction`SET LOCAL search_path = pg_catalog, public`;
    await transaction`SELECT pg_catalog.pg_advisory_xact_lock(1129469016, 1279608643)`;
    await transaction`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`;
  // Build 1: novelty_score for surprise-gated ingestion
  await transaction`ALTER TABLE public.memory_nodes ADD COLUMN IF NOT EXISTS novelty_score REAL DEFAULT NULL`;
  // Build 3: last_recalled_at for memory reconsolidation
  await transaction`ALTER TABLE public.memory_nodes ADD COLUMN IF NOT EXISTS last_recalled_at TIMESTAMP DEFAULT NULL`;
  // Build 4: hippocampal codes table for DG pattern separation
  await transaction`CREATE TABLE IF NOT EXISTS public.hippocampal_codes (
    id SERIAL PRIMARY KEY,
    memory_id INTEGER NOT NULL UNIQUE REFERENCES public.memory_nodes(id) ON DELETE CASCADE,
    agent_id INTEGER NOT NULL REFERENCES public.agents(id),
    sparse_indices INTEGER[] NOT NULL,
    sparse_values REAL[] NOT NULL,
    sparse_dim INTEGER DEFAULT 4096,
    novelty_score REAL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  )`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_hc_agent ON public.hippocampal_codes(agent_id)`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_hc_memory ON public.hippocampal_codes(memory_id)`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_hc_indices ON public.hippocampal_codes USING GIN(sparse_indices)`;
  // Build 5: emotional valence table for multi-dimensional emotional context
  await transaction`CREATE TABLE IF NOT EXISTS public.emotional_valence (
    id SERIAL PRIMARY KEY,
    memory_id INTEGER NOT NULL UNIQUE REFERENCES public.memory_nodes(id) ON DELETE CASCADE,
    agent_id INTEGER NOT NULL REFERENCES public.agents(id),
    valence REAL NOT NULL DEFAULT 0,
    arousal REAL NOT NULL DEFAULT 0,
    dominance REAL NOT NULL DEFAULT 0,
    certainty REAL NOT NULL DEFAULT 0,
    relevance REAL NOT NULL DEFAULT 0.3,
    urgency REAL NOT NULL DEFAULT 0,
    intensity REAL NOT NULL DEFAULT 0,
    decay_resistance REAL NOT NULL DEFAULT 0,
    recall_boost REAL NOT NULL DEFAULT 0,
    dominant_dimension VARCHAR(32),
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  )`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_ev_agent ON public.emotional_valence(agent_id)`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_ev_memory ON public.emotional_valence(memory_id)`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_ev_intensity ON public.emotional_valence(intensity)`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_ev_decay_resistance ON public.emotional_valence(decay_resistance)`;
  // Build 6: procedural memories table for skill/workflow/habit storage
  await transaction`CREATE TABLE IF NOT EXISTS public.procedural_memories (
    id SERIAL PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES public.agents(id),
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    procedural_type VARCHAR(32) NOT NULL,
    trigger_context TEXT NOT NULL,
    steps TEXT[] DEFAULT '{}'::text[],
    embedding vector(1024),
    proficiency VARCHAR(32) DEFAULT 'novice',
    execution_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    success_rate REAL DEFAULT 0,
    domain_tags TEXT[] DEFAULT '{}'::text[],
    source_memory_ids INTEGER[] DEFAULT '{}'::int[],
    version INTEGER DEFAULT 1,
    status VARCHAR(32) DEFAULT 'active',
    last_executed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
  )`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_proc_agent ON public.procedural_memories(agent_id)`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_proc_type ON public.procedural_memories(procedural_type)`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_proc_proficiency ON public.procedural_memories(proficiency)`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_proc_domain_tags ON public.procedural_memories USING GIN(domain_tags)`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_proc_status ON public.procedural_memories(status)`;

  // Build 7: Temporal validity windows (Zep-competitive feature)
  await transaction`ALTER TABLE public.memory_nodes ADD COLUMN IF NOT EXISTS valid_from TIMESTAMP DEFAULT NULL`;
  await transaction`ALTER TABLE public.memory_nodes ADD COLUMN IF NOT EXISTS valid_until TIMESTAMP DEFAULT NULL`;
  await transaction`ALTER TABLE public.memory_nodes ADD COLUMN IF NOT EXISTS superseded_by INTEGER DEFAULT NULL`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_mn_valid_until ON public.memory_nodes(valid_until) WHERE valid_until IS NOT NULL`;

  // Build 8: Performance indexes for production-scale query patterns
  // Composite index for synapse traversal (CA3 pattern completion, dream pruning)
  await transaction`CREATE INDEX IF NOT EXISTS idx_synapses_a_strength ON public.memory_synapses(memory_a, connection_strength)`;
  await transaction`CREATE INDEX IF NOT EXISTS idx_synapses_b_strength ON public.memory_synapses(memory_b, connection_strength)`;
  // Composite index for common memory filtering (search, dream, background threads)
  await transaction`CREATE INDEX IF NOT EXISTS idx_mn_agent_status_priority ON public.memory_nodes(agent_id, status, priority)`;
  // HNSW index for vector similarity search (pgvector 0.5+)
  await transaction`CREATE INDEX IF NOT EXISTS idx_mn_embedding_hnsw ON public.memory_nodes USING hnsw (embedding public.vector_cosine_ops) WITH (m = 16, ef_construction = 64)`;
  // Index for resonance-based queries (dream pruning, consolidation)
  await transaction`CREATE INDEX IF NOT EXISTS idx_mn_agent_resonance ON public.memory_nodes(agent_id, resonance_score) WHERE status = 'active'`;
  // GIN index for entity-overlap queries (batched synapse formation uses &&)
  await transaction`CREATE INDEX IF NOT EXISTS idx_mn_entities ON public.memory_nodes USING GIN(entities)`;

  console.error("[db] pgvector extension enabled, legacy Build 1-8 migrations applied");
  });
}

export async function closeDatabaseConnection(): Promise<void> {
  await client.end({ timeout: 5 });
}

export { schema };
