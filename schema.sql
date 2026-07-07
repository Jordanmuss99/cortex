--
-- PostgreSQL database dump
--

\restrict c6N7PFVYtMeYUcZ3KYfXOugCBElM6wYGvAkxyJewLFb4R1pdvwXJbiFmjoLp91t

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_state_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_state_logs (
    id integer NOT NULL,
    agent_id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL,
    session_id character varying(128),
    energy_state character varying(32) DEFAULT 'normal'::character varying,
    active_threads jsonb DEFAULT '[]'::jsonb,
    confidence real DEFAULT 0.5,
    memory_quality real DEFAULT 0.5,
    concerns text[] DEFAULT '{}'::text[],
    notes text
);


--
-- Name: agent_state_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_state_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_state_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_state_logs_id_seq OWNED BY public.agent_state_logs.id;


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id integer NOT NULL,
    external_id character varying(64) NOT NULL,
    name character varying(255) NOT NULL,
    owner_id character varying(255),
    config jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: agents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agents_id_seq OWNED BY public.agents.id;


--
-- Name: background_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.background_threads (
    id integer NOT NULL,
    agent_id integer NOT NULL,
    thread_type character varying(32) NOT NULL,
    status character varying(32) DEFAULT 'idle'::character varying,
    last_run timestamp without time zone,
    findings jsonb DEFAULT '{"actions": [], "insights": [], "questions": []}'::jsonb,
    next_action text,
    priority integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: background_threads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.background_threads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: background_threads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.background_threads_id_seq OWNED BY public.background_threads.id;


--
-- Name: cognitive_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cognitive_artifacts (
    id integer NOT NULL,
    agent_id integer NOT NULL,
    session_id character varying(128),
    artifact_type character varying(32) NOT NULL,
    content jsonb NOT NULL,
    embedding public.vector(1024),
    resonance_score real DEFAULT 5.0,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: cognitive_artifacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cognitive_artifacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cognitive_artifacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cognitive_artifacts_id_seq OWNED BY public.cognitive_artifacts.id;


--
-- Name: dream_cycle_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dream_cycle_logs (
    id integer NOT NULL,
    agent_id integer NOT NULL,
    cycle_type character varying(32) NOT NULL,
    stats jsonb DEFAULT '{}'::jsonb,
    insights_discovered jsonb DEFAULT '[]'::jsonb,
    started_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone
);


--
-- Name: dream_cycle_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dream_cycle_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dream_cycle_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dream_cycle_logs_id_seq OWNED BY public.dream_cycle_logs.id;


--
-- Name: emotional_valence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emotional_valence (
    id integer NOT NULL,
    memory_id integer NOT NULL,
    agent_id integer NOT NULL,
    valence real DEFAULT 0 NOT NULL,
    arousal real DEFAULT 0 NOT NULL,
    dominance real DEFAULT 0 NOT NULL,
    certainty real DEFAULT 0 NOT NULL,
    relevance real DEFAULT 0.3 NOT NULL,
    urgency real DEFAULT 0 NOT NULL,
    intensity real DEFAULT 0 NOT NULL,
    decay_resistance real DEFAULT 0 NOT NULL,
    recall_boost real DEFAULT 0 NOT NULL,
    dominant_dimension character varying(32),
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: emotional_valence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.emotional_valence_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: emotional_valence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.emotional_valence_id_seq OWNED BY public.emotional_valence.id;


--
-- Name: hippocampal_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hippocampal_codes (
    id integer NOT NULL,
    memory_id integer NOT NULL,
    agent_id integer NOT NULL,
    sparse_indices integer[] NOT NULL,
    sparse_values real[] NOT NULL,
    sparse_dim integer DEFAULT 4096,
    novelty_score real,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: hippocampal_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hippocampal_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hippocampal_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hippocampal_codes_id_seq OWNED BY public.hippocampal_codes.id;


--
-- Name: memory_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_nodes (
    id integer NOT NULL,
    agent_id integer NOT NULL,
    content text NOT NULL,
    summary text,
    source text,
    source_type character varying(64) DEFAULT 'markdown'::character varying,
    chunk_index integer DEFAULT 0,
    embedding public.vector(1024),
    entities text[] DEFAULT '{}'::text[],
    semantic_tags text[] DEFAULT '{}'::text[],
    priority integer DEFAULT 2,
    resonance_score real DEFAULT 5.0,
    access_count integer DEFAULT 0,
    last_accessed_at timestamp without time zone DEFAULT now(),
    status character varying(32) DEFAULT 'active'::character varying,
    valid_from timestamp without time zone,
    valid_until timestamp without time zone,
    superseded_by integer,
    novelty_score real,
    last_recalled_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_nodes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_nodes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memory_nodes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_nodes_id_seq OWNED BY public.memory_nodes.id;


--
-- Name: memory_synapses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_synapses (
    id integer NOT NULL,
    memory_a integer NOT NULL,
    memory_b integer NOT NULL,
    connection_type character varying(32) NOT NULL,
    connection_strength real DEFAULT 0.5 NOT NULL,
    activation_count integer DEFAULT 0,
    decay_rate real DEFAULT 0.01,
    last_activated_at timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_synapses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_synapses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memory_synapses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_synapses_id_seq OWNED BY public.memory_synapses.id;


--
-- Name: principal_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.principal_state (
    id integer NOT NULL,
    agent_id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL,
    energy real DEFAULT 0.5,
    stress real DEFAULT 0.3,
    focus_state character varying(32) DEFAULT 'normal'::character varying,
    emotional_valence real DEFAULT 0,
    adhd_state character varying(32) DEFAULT 'managed'::character varying,
    raw_signals jsonb DEFAULT '{}'::jsonb,
    inferred_from text,
    confidence_score real DEFAULT 0.5
);


--
-- Name: principal_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.principal_state_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: principal_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.principal_state_id_seq OWNED BY public.principal_state.id;


--
-- Name: procedural_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procedural_memories (
    id integer NOT NULL,
    agent_id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text NOT NULL,
    procedural_type character varying(32) NOT NULL,
    trigger_context text NOT NULL,
    steps text[] DEFAULT '{}'::text[],
    embedding public.vector(1024),
    proficiency character varying(32) DEFAULT 'novice'::character varying,
    execution_count integer DEFAULT 0,
    success_count integer DEFAULT 0,
    success_rate real DEFAULT 0,
    domain_tags text[] DEFAULT '{}'::text[],
    source_memory_ids integer[] DEFAULT '{}'::integer[],
    version integer DEFAULT 1,
    status character varying(32) DEFAULT 'active'::character varying,
    last_executed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: procedural_memories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.procedural_memories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: procedural_memories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.procedural_memories_id_seq OWNED BY public.procedural_memories.id;


--
-- Name: relationship_graph; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relationship_graph (
    id integer NOT NULL,
    agent_id integer NOT NULL,
    person_name character varying(255) NOT NULL,
    person_email character varying(255),
    relationship_type character varying(32),
    last_contact timestamp without time zone,
    contact_frequency character varying(32) DEFAULT 'as_needed'::character varying,
    importance_score real DEFAULT 5,
    personality_model jsonb DEFAULT '{}'::jsonb,
    open_items jsonb DEFAULT '[]'::jsonb,
    communication_prefs jsonb DEFAULT '{}'::jsonb,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: relationship_graph_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.relationship_graph_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: relationship_graph_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.relationship_graph_id_seq OWNED BY public.relationship_graph.id;


--
-- Name: self_diagnostics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.self_diagnostics (
    id integer NOT NULL,
    agent_id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL,
    skills_status jsonb DEFAULT '{}'::jsonb,
    cron_status jsonb DEFAULT '{}'::jsonb,
    channels_status jsonb DEFAULT '{}'::jsonb,
    drift_score real DEFAULT 0,
    drift_details jsonb DEFAULT '{}'::jsonb,
    alerts text[] DEFAULT '{}'::text[],
    overall_health character varying(32) DEFAULT 'healthy'::character varying
);


--
-- Name: self_diagnostics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.self_diagnostics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: self_diagnostics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.self_diagnostics_id_seq OWNED BY public.self_diagnostics.id;


--
-- Name: agent_state_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_state_logs ALTER COLUMN id SET DEFAULT nextval('public.agent_state_logs_id_seq'::regclass);


--
-- Name: agents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents ALTER COLUMN id SET DEFAULT nextval('public.agents_id_seq'::regclass);


--
-- Name: background_threads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_threads ALTER COLUMN id SET DEFAULT nextval('public.background_threads_id_seq'::regclass);


--
-- Name: cognitive_artifacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cognitive_artifacts ALTER COLUMN id SET DEFAULT nextval('public.cognitive_artifacts_id_seq'::regclass);


--
-- Name: dream_cycle_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dream_cycle_logs ALTER COLUMN id SET DEFAULT nextval('public.dream_cycle_logs_id_seq'::regclass);


--
-- Name: emotional_valence id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emotional_valence ALTER COLUMN id SET DEFAULT nextval('public.emotional_valence_id_seq'::regclass);


--
-- Name: hippocampal_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hippocampal_codes ALTER COLUMN id SET DEFAULT nextval('public.hippocampal_codes_id_seq'::regclass);


--
-- Name: memory_nodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_nodes ALTER COLUMN id SET DEFAULT nextval('public.memory_nodes_id_seq'::regclass);


--
-- Name: memory_synapses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_synapses ALTER COLUMN id SET DEFAULT nextval('public.memory_synapses_id_seq'::regclass);


--
-- Name: principal_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principal_state ALTER COLUMN id SET DEFAULT nextval('public.principal_state_id_seq'::regclass);


--
-- Name: procedural_memories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procedural_memories ALTER COLUMN id SET DEFAULT nextval('public.procedural_memories_id_seq'::regclass);


--
-- Name: relationship_graph id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationship_graph ALTER COLUMN id SET DEFAULT nextval('public.relationship_graph_id_seq'::regclass);


--
-- Name: self_diagnostics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_diagnostics ALTER COLUMN id SET DEFAULT nextval('public.self_diagnostics_id_seq'::regclass);


--
-- Name: agent_state_logs agent_state_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_state_logs
    ADD CONSTRAINT agent_state_logs_pkey PRIMARY KEY (id);


--
-- Name: agents agents_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_external_id_key UNIQUE (external_id);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: background_threads background_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_threads
    ADD CONSTRAINT background_threads_pkey PRIMARY KEY (id);


--
-- Name: cognitive_artifacts cognitive_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cognitive_artifacts
    ADD CONSTRAINT cognitive_artifacts_pkey PRIMARY KEY (id);


--
-- Name: dream_cycle_logs dream_cycle_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dream_cycle_logs
    ADD CONSTRAINT dream_cycle_logs_pkey PRIMARY KEY (id);


--
-- Name: emotional_valence emotional_valence_memory_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emotional_valence
    ADD CONSTRAINT emotional_valence_memory_id_key UNIQUE (memory_id);


--
-- Name: emotional_valence emotional_valence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emotional_valence
    ADD CONSTRAINT emotional_valence_pkey PRIMARY KEY (id);


--
-- Name: hippocampal_codes hippocampal_codes_memory_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hippocampal_codes
    ADD CONSTRAINT hippocampal_codes_memory_id_key UNIQUE (memory_id);


--
-- Name: hippocampal_codes hippocampal_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hippocampal_codes
    ADD CONSTRAINT hippocampal_codes_pkey PRIMARY KEY (id);


--
-- Name: memory_nodes memory_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_nodes
    ADD CONSTRAINT memory_nodes_pkey PRIMARY KEY (id);


--
-- Name: memory_synapses memory_synapses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_synapses
    ADD CONSTRAINT memory_synapses_pkey PRIMARY KEY (id);


--
-- Name: principal_state principal_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principal_state
    ADD CONSTRAINT principal_state_pkey PRIMARY KEY (id);


--
-- Name: procedural_memories procedural_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procedural_memories
    ADD CONSTRAINT procedural_memories_pkey PRIMARY KEY (id);


--
-- Name: relationship_graph relationship_graph_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationship_graph
    ADD CONSTRAINT relationship_graph_pkey PRIMARY KEY (id);


--
-- Name: self_diagnostics self_diagnostics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_diagnostics
    ADD CONSTRAINT self_diagnostics_pkey PRIMARY KEY (id);


--
-- Name: idx_agent_state_logs_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_state_logs_agent ON public.agent_state_logs USING btree (agent_id);


--
-- Name: idx_agent_state_logs_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_state_logs_session ON public.agent_state_logs USING btree (session_id);


--
-- Name: idx_agent_state_logs_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_state_logs_timestamp ON public.agent_state_logs USING btree ("timestamp");


--
-- Name: idx_artifacts_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_artifacts_agent ON public.cognitive_artifacts USING btree (agent_id);


--
-- Name: idx_artifacts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_artifacts_created_at ON public.cognitive_artifacts USING btree (created_at);


--
-- Name: idx_artifacts_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_artifacts_type ON public.cognitive_artifacts USING btree (artifact_type);


--
-- Name: idx_bg_threads_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bg_threads_agent ON public.background_threads USING btree (agent_id);


--
-- Name: idx_bg_threads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bg_threads_status ON public.background_threads USING btree (status);


--
-- Name: idx_bg_threads_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bg_threads_type ON public.background_threads USING btree (thread_type);


--
-- Name: idx_dream_logs_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dream_logs_agent ON public.dream_cycle_logs USING btree (agent_id);


--
-- Name: idx_dream_logs_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dream_logs_started_at ON public.dream_cycle_logs USING btree (started_at);


--
-- Name: idx_ev_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ev_agent ON public.emotional_valence USING btree (agent_id);


--
-- Name: idx_ev_decay_resistance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ev_decay_resistance ON public.emotional_valence USING btree (decay_resistance);


--
-- Name: idx_ev_intensity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ev_intensity ON public.emotional_valence USING btree (intensity);


--
-- Name: idx_ev_memory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ev_memory ON public.emotional_valence USING btree (memory_id);


--
-- Name: idx_hc_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hc_agent ON public.hippocampal_codes USING btree (agent_id);


--
-- Name: idx_hc_indices; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hc_indices ON public.hippocampal_codes USING gin (sparse_indices);


--
-- Name: idx_hc_memory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hc_memory ON public.hippocampal_codes USING btree (memory_id);


--
-- Name: idx_memory_nodes_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_nodes_agent ON public.memory_nodes USING btree (agent_id);


--
-- Name: idx_memory_nodes_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_nodes_created_at ON public.memory_nodes USING btree (created_at);


--
-- Name: idx_memory_nodes_entities; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_nodes_entities ON public.memory_nodes USING gin (entities);


--
-- Name: idx_memory_nodes_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_nodes_priority ON public.memory_nodes USING btree (priority);


--
-- Name: idx_memory_nodes_resonance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_nodes_resonance ON public.memory_nodes USING btree (resonance_score);


--
-- Name: idx_memory_nodes_semantic_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_nodes_semantic_tags ON public.memory_nodes USING gin (semantic_tags);


--
-- Name: idx_memory_nodes_source_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_nodes_source_type ON public.memory_nodes USING btree (source_type);


--
-- Name: idx_memory_nodes_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_nodes_status ON public.memory_nodes USING btree (status);


--
-- Name: idx_mn_agent_resonance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mn_agent_resonance ON public.memory_nodes USING btree (agent_id, resonance_score) WHERE ((status)::text = 'active'::text);


--
-- Name: idx_mn_agent_status_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mn_agent_status_priority ON public.memory_nodes USING btree (agent_id, status, priority);


--
-- Name: idx_mn_embedding_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mn_embedding_hnsw ON public.memory_nodes USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_mn_entities; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mn_entities ON public.memory_nodes USING gin (entities);


--
-- Name: idx_mn_valid_until; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mn_valid_until ON public.memory_nodes USING btree (valid_until) WHERE (valid_until IS NOT NULL);


--
-- Name: idx_principal_state_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_principal_state_agent ON public.principal_state USING btree (agent_id);


--
-- Name: idx_principal_state_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_principal_state_timestamp ON public.principal_state USING btree ("timestamp");


--
-- Name: idx_proc_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proc_agent ON public.procedural_memories USING btree (agent_id);


--
-- Name: idx_proc_domain_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proc_domain_tags ON public.procedural_memories USING gin (domain_tags);


--
-- Name: idx_proc_proficiency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proc_proficiency ON public.procedural_memories USING btree (proficiency);


--
-- Name: idx_proc_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proc_status ON public.procedural_memories USING btree (status);


--
-- Name: idx_proc_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proc_type ON public.procedural_memories USING btree (procedural_type);


--
-- Name: idx_relationship_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relationship_agent ON public.relationship_graph USING btree (agent_id);


--
-- Name: idx_relationship_agent_person; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_relationship_agent_person ON public.relationship_graph USING btree (agent_id, person_name);


--
-- Name: idx_relationship_importance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relationship_importance ON public.relationship_graph USING btree (importance_score);


--
-- Name: idx_relationship_person; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relationship_person ON public.relationship_graph USING btree (person_name);


--
-- Name: idx_relationship_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relationship_type ON public.relationship_graph USING btree (relationship_type);


--
-- Name: idx_self_diagnostics_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_self_diagnostics_agent ON public.self_diagnostics USING btree (agent_id);


--
-- Name: idx_self_diagnostics_health; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_self_diagnostics_health ON public.self_diagnostics USING btree (overall_health);


--
-- Name: idx_self_diagnostics_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_self_diagnostics_timestamp ON public.self_diagnostics USING btree ("timestamp");


--
-- Name: idx_synapses_a_strength; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_synapses_a_strength ON public.memory_synapses USING btree (memory_a, connection_strength);


--
-- Name: idx_synapses_b_strength; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_synapses_b_strength ON public.memory_synapses USING btree (memory_b, connection_strength);


--
-- Name: idx_synapses_memory_a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_synapses_memory_a ON public.memory_synapses USING btree (memory_a);


--
-- Name: idx_synapses_memory_b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_synapses_memory_b ON public.memory_synapses USING btree (memory_b);


--
-- Name: idx_synapses_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_synapses_pair ON public.memory_synapses USING btree (memory_a, memory_b, connection_type);


--
-- Name: idx_synapses_strength; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_synapses_strength ON public.memory_synapses USING btree (connection_strength);


--
-- Name: idx_synapses_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_synapses_type ON public.memory_synapses USING btree (connection_type);


--
-- Name: agent_state_logs agent_state_logs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_state_logs
    ADD CONSTRAINT agent_state_logs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: background_threads background_threads_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_threads
    ADD CONSTRAINT background_threads_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: cognitive_artifacts cognitive_artifacts_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cognitive_artifacts
    ADD CONSTRAINT cognitive_artifacts_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: dream_cycle_logs dream_cycle_logs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dream_cycle_logs
    ADD CONSTRAINT dream_cycle_logs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: emotional_valence emotional_valence_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emotional_valence
    ADD CONSTRAINT emotional_valence_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: emotional_valence emotional_valence_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emotional_valence
    ADD CONSTRAINT emotional_valence_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memory_nodes(id) ON DELETE CASCADE;


--
-- Name: hippocampal_codes hippocampal_codes_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hippocampal_codes
    ADD CONSTRAINT hippocampal_codes_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: hippocampal_codes hippocampal_codes_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hippocampal_codes
    ADD CONSTRAINT hippocampal_codes_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memory_nodes(id) ON DELETE CASCADE;


--
-- Name: memory_nodes memory_nodes_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_nodes
    ADD CONSTRAINT memory_nodes_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: memory_synapses memory_synapses_memory_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_synapses
    ADD CONSTRAINT memory_synapses_memory_a_fkey FOREIGN KEY (memory_a) REFERENCES public.memory_nodes(id) ON DELETE CASCADE;


--
-- Name: memory_synapses memory_synapses_memory_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_synapses
    ADD CONSTRAINT memory_synapses_memory_b_fkey FOREIGN KEY (memory_b) REFERENCES public.memory_nodes(id) ON DELETE CASCADE;


--
-- Name: principal_state principal_state_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principal_state
    ADD CONSTRAINT principal_state_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: procedural_memories procedural_memories_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procedural_memories
    ADD CONSTRAINT procedural_memories_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: relationship_graph relationship_graph_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationship_graph
    ADD CONSTRAINT relationship_graph_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: self_diagnostics self_diagnostics_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_diagnostics
    ADD CONSTRAINT self_diagnostics_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- PostgreSQL database dump complete
--

\unrestrict c6N7PFVYtMeYUcZ3KYfXOugCBElM6wYGvAkxyJewLFb4R1pdvwXJbiFmjoLp91t

