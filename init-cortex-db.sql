-- Cortex Database Schema Initialization
-- This script creates all base tables from Drizzle ORM schema definitions

-- Enable pgvector extension first
CREATE EXTENSION IF NOT EXISTS vector;

-- Create agents table
CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  external_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  owner_id VARCHAR(255),
  config JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create memory_nodes table (base table for all other memory structures)
CREATE TABLE IF NOT EXISTS memory_nodes (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  summary TEXT,
  source TEXT,
  source_type VARCHAR(64) DEFAULT 'markdown',
  chunk_index INTEGER DEFAULT 0,
  embedding vector(1024),
  entities TEXT[] DEFAULT '{}'::text[],
  semantic_tags TEXT[] DEFAULT '{}'::text[],
  priority INTEGER DEFAULT 2,
  resonance_score REAL DEFAULT 5.0,
  access_count INTEGER DEFAULT 0,
  last_accessed_at TIMESTAMP DEFAULT NOW(),
  status VARCHAR(32) DEFAULT 'active',
  valid_from TIMESTAMP DEFAULT NULL,
  valid_until TIMESTAMP DEFAULT NULL,
  superseded_by INTEGER DEFAULT NULL,
  novelty_score REAL DEFAULT NULL,
  last_recalled_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create indexes for memory_nodes
CREATE INDEX IF NOT EXISTS idx_memory_nodes_agent ON memory_nodes(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_status ON memory_nodes(status);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_priority ON memory_nodes(priority);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_resonance ON memory_nodes(resonance_score);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_source_type ON memory_nodes(source_type);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_created_at ON memory_nodes(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_entities ON memory_nodes USING GIN(entities);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_semantic_tags ON memory_nodes USING GIN(semantic_tags);
CREATE INDEX IF NOT EXISTS idx_mn_valid_until ON memory_nodes(valid_until) WHERE valid_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mn_agent_status_priority ON memory_nodes(agent_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_mn_embedding_hnsw ON memory_nodes USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_mn_agent_resonance ON memory_nodes(agent_id, resonance_score) WHERE status = 'active';

-- Create memory_synapses table
CREATE TABLE IF NOT EXISTS memory_synapses (
  id SERIAL PRIMARY KEY,
  memory_a INTEGER NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  memory_b INTEGER NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  connection_type VARCHAR(32) NOT NULL,
  connection_strength REAL DEFAULT 0.5 NOT NULL,
  activation_count INTEGER DEFAULT 0,
  decay_rate REAL DEFAULT 0.01,
  last_activated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create indexes for memory_synapses
CREATE INDEX IF NOT EXISTS idx_synapses_memory_a ON memory_synapses(memory_a);
CREATE INDEX IF NOT EXISTS idx_synapses_memory_b ON memory_synapses(memory_b);
CREATE INDEX IF NOT EXISTS idx_synapses_type ON memory_synapses(connection_type);
CREATE INDEX IF NOT EXISTS idx_synapses_strength ON memory_synapses(connection_strength);
CREATE INDEX IF NOT EXISTS idx_synapses_a_strength ON memory_synapses(memory_a, connection_strength);
CREATE INDEX IF NOT EXISTS idx_synapses_b_strength ON memory_synapses(memory_b, connection_strength);
CREATE UNIQUE INDEX IF NOT EXISTS idx_synapses_pair ON memory_synapses(memory_a, memory_b, connection_type);

-- Create hippocampal_codes table
CREATE TABLE IF NOT EXISTS hippocampal_codes (
  id SERIAL PRIMARY KEY,
  memory_id INTEGER NOT NULL UNIQUE REFERENCES memory_nodes(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  sparse_indices INTEGER[] NOT NULL,
  sparse_values REAL[] NOT NULL,
  sparse_dim INTEGER DEFAULT 4096,
  novelty_score REAL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create indexes for hippocampal_codes
CREATE INDEX IF NOT EXISTS idx_hc_agent ON hippocampal_codes(agent_id);
CREATE INDEX IF NOT EXISTS idx_hc_memory ON hippocampal_codes(memory_id);
CREATE INDEX IF NOT EXISTS idx_hc_indices ON hippocampal_codes USING GIN(sparse_indices);

-- Create emotional_valence table
CREATE TABLE IF NOT EXISTS emotional_valence (
  id SERIAL PRIMARY KEY,
  memory_id INTEGER NOT NULL UNIQUE REFERENCES memory_nodes(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
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
);

-- Create indexes for emotional_valence
CREATE INDEX IF NOT EXISTS idx_ev_agent ON emotional_valence(agent_id);
CREATE INDEX IF NOT EXISTS idx_ev_memory ON emotional_valence(memory_id);
CREATE INDEX IF NOT EXISTS idx_ev_intensity ON emotional_valence(intensity);
CREATE INDEX IF NOT EXISTS idx_ev_decay_resistance ON emotional_valence(decay_resistance);

-- Create procedural_memories table
CREATE TABLE IF NOT EXISTS procedural_memories (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
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
);

-- Create indexes for procedural_memories
CREATE INDEX IF NOT EXISTS idx_proc_agent ON procedural_memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_proc_type ON procedural_memories(procedural_type);
CREATE INDEX IF NOT EXISTS idx_proc_proficiency ON procedural_memories(proficiency);
CREATE INDEX IF NOT EXISTS idx_proc_domain_tags ON procedural_memories USING GIN(domain_tags);
CREATE INDEX IF NOT EXISTS idx_proc_status ON procedural_memories(status);

-- Create cognitive_artifacts table
CREATE TABLE IF NOT EXISTS cognitive_artifacts (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  session_id VARCHAR(128),
  artifact_type VARCHAR(32) NOT NULL,
  content JSONB NOT NULL,
  embedding vector(1024),
  resonance_score REAL DEFAULT 5.0,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create indexes for cognitive_artifacts
CREATE INDEX IF NOT EXISTS idx_artifacts_agent ON cognitive_artifacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON cognitive_artifacts(artifact_type);
CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON cognitive_artifacts(created_at);

-- Create dream_cycle_logs table
CREATE TABLE IF NOT EXISTS dream_cycle_logs (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  cycle_type VARCHAR(32) NOT NULL,
  stats JSONB DEFAULT '{}',
  insights_discovered JSONB DEFAULT '[]',
  started_at TIMESTAMP DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMP
);

-- Create indexes for dream_cycle_logs
CREATE INDEX IF NOT EXISTS idx_dream_logs_agent ON dream_cycle_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_dream_logs_started_at ON dream_cycle_logs(started_at);

-- Create self_diagnostics table
CREATE TABLE IF NOT EXISTS self_diagnostics (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  timestamp TIMESTAMP DEFAULT NOW() NOT NULL,
  skills_status JSONB DEFAULT '{}',
  cron_status JSONB DEFAULT '{}',
  channels_status JSONB DEFAULT '{}',
  drift_score REAL DEFAULT 0,
  drift_details JSONB DEFAULT '{}',
  alerts TEXT[] DEFAULT '{}'::text[],
  overall_health VARCHAR(32) DEFAULT 'healthy'
);

-- Create indexes for self_diagnostics
CREATE INDEX IF NOT EXISTS idx_self_diagnostics_agent ON self_diagnostics(agent_id);
CREATE INDEX IF NOT EXISTS idx_self_diagnostics_timestamp ON self_diagnostics(timestamp);
CREATE INDEX IF NOT EXISTS idx_self_diagnostics_health ON self_diagnostics(overall_health);

-- Create agent_state_logs table
CREATE TABLE IF NOT EXISTS agent_state_logs (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  timestamp TIMESTAMP DEFAULT NOW() NOT NULL,
  session_id VARCHAR(128),
  energy_state VARCHAR(32) DEFAULT 'normal',
  active_threads JSONB DEFAULT '[]',
  confidence REAL DEFAULT 0.5,
  memory_quality REAL DEFAULT 0.5,
  concerns TEXT[] DEFAULT '{}'::text[],
  notes TEXT
);

-- Create indexes for agent_state_logs
CREATE INDEX IF NOT EXISTS idx_agent_state_logs_agent ON agent_state_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_state_logs_timestamp ON agent_state_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_agent_state_logs_session ON agent_state_logs(session_id);

-- Create principal_state table
CREATE TABLE IF NOT EXISTS principal_state (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  timestamp TIMESTAMP DEFAULT NOW() NOT NULL,
  energy REAL DEFAULT 0.5,
  stress REAL DEFAULT 0.3,
  focus_state VARCHAR(32) DEFAULT 'normal',
  emotional_valence REAL DEFAULT 0,
  adhd_state VARCHAR(32) DEFAULT 'managed',
  raw_signals JSONB DEFAULT '{}',
  inferred_from TEXT,
  confidence_score REAL DEFAULT 0.5
);

-- Create indexes for principal_state
CREATE INDEX IF NOT EXISTS idx_principal_state_agent ON principal_state(agent_id);
CREATE INDEX IF NOT EXISTS idx_principal_state_timestamp ON principal_state(timestamp);

-- Create background_threads table
CREATE TABLE IF NOT EXISTS background_threads (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  thread_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) DEFAULT 'idle',
  last_run TIMESTAMP,
  findings JSONB DEFAULT '{"insights": [], "actions": [], "questions": []}',
  next_action TEXT,
  priority INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create indexes for background_threads
CREATE INDEX IF NOT EXISTS idx_bg_threads_agent ON background_threads(agent_id);
CREATE INDEX IF NOT EXISTS idx_bg_threads_type ON background_threads(thread_type);
CREATE INDEX IF NOT EXISTS idx_bg_threads_status ON background_threads(status);

-- Create relationship_graph table
CREATE TABLE IF NOT EXISTS relationship_graph (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  person_name VARCHAR(255) NOT NULL,
  person_email VARCHAR(255),
  relationship_type VARCHAR(32),
  last_contact TIMESTAMP,
  contact_frequency VARCHAR(32) DEFAULT 'as_needed',
  importance_score REAL DEFAULT 5,
  personality_model JSONB DEFAULT '{}',
  open_items JSONB DEFAULT '[]',
  communication_prefs JSONB DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create indexes for relationship_graph
CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship_agent_person ON relationship_graph(agent_id, person_name);
CREATE INDEX IF NOT EXISTS idx_relationship_agent ON relationship_graph(agent_id);
CREATE INDEX IF NOT EXISTS idx_relationship_person ON relationship_graph(person_name);
CREATE INDEX IF NOT EXISTS idx_relationship_type ON relationship_graph(relationship_type);
CREATE INDEX IF NOT EXISTS idx_relationship_importance ON relationship_graph(importance_score);
