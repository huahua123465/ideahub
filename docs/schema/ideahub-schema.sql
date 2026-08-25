--
-- PostgreSQL database dump
--

\restrict cVP6k9IwPqx3UMlWtTBqg6XkPYJDU58BzQekvX81p6Culy0yojh9IH2xRmm3AFk

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

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
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: client_stage; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.client_stage AS ENUM (
    'lead',
    'wechat',
    'profiled',
    'consulted',
    'coaching',
    'renewed',
    'lost'
);


--
-- Name: idea_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.idea_status AS ENUM (
    'draft',
    'pending',
    'reviewing',
    'adopted',
    'rejected',
    'archived'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'member',
    'reviewer',
    'admin'
);


--
-- Name: work_channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.work_channel AS ENUM (
    'persona',
    'matrix',
    'live'
);


--
-- Name: work_side; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.work_side AS ENUM (
    'own',
    'benchmark'
);


--
-- Name: cn_bigrams(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cn_bigrams(t text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT coalesce(array_agg(DISTINCT g), '{}')
  FROM (
    SELECT regexp_replace(lower(coalesce(t, '')), '[[:space:][:punct:]「」【】（），。、；：？！…—]', '', 'g') AS s
  ) x,
  LATERAL (
    SELECT substring(x.s FROM i FOR 2) AS g
    FROM generate_series(1, GREATEST(length(x.s) - 1, 1)) AS i
    WHERE length(x.s) > 0
  ) y;
$$;


--
-- Name: cn_similarity(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cn_similarity(a text, b text) RETURNS real
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE WHEN u = 0 THEN 0::real ELSE i::real / u::real END
  FROM (
    SELECT
      cardinality(ARRAY(SELECT unnest(cn_bigrams(a)) INTERSECT SELECT unnest(cn_bigrams(b)))) AS i,
      cardinality(ARRAY(SELECT unnest(cn_bigrams(a)) UNION     SELECT unnest(cn_bigrams(b)))) AS u
  ) t;
$$;


--
-- Name: hot_of(integer, integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hot_of(votes integer, comments integer, created timestamp with time zone) RETURNS real
    LANGUAGE sql STABLE
    AS $$
  SELECT ((votes * 2 + comments + 1)::real
          / POWER(EXTRACT(EPOCH FROM (now() - created)) / 86400 + 2, 1.5)::real)::real;
$$;


--
-- Name: recalc_hot_scores(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recalc_hot_scores() RETURNS void
    LANGUAGE sql
    AS $$
  UPDATE ideas SET hot_score = hot_of(vote_count, comment_count, created_at)
  WHERE status IN ('pending', 'reviewing');
$$;


--
-- Name: set_hot_score(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_hot_score() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.hot_score := hot_of(NEW.vote_count, NEW.comment_count, NEW.created_at);
  RETURN NEW;
END $$;


--
-- Name: sync_comment_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_comment_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE ideas SET comment_count = comment_count + 1, updated_at = now() WHERE id = NEW.idea_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE ideas SET comment_count = GREATEST(comment_count - 1, 0), updated_at = now() WHERE id = OLD.idea_id;
  END IF;
  RETURN NULL;
END $$;


--
-- Name: sync_vote_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_vote_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE ideas SET vote_count = vote_count + 1, updated_at = now() WHERE id = NEW.idea_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE ideas SET vote_count = GREATEST(vote_count - 1, 0), updated_at = now() WHERE id = OLD.idea_id;
  END IF;
  RETURN NULL;
END $$;


--
-- Name: title_similarity(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.title_similarity(a text, b text) RETURNS real
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT GREATEST(similarity(a, b), cn_similarity(a, b));
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id bigint NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_keys_id_seq OWNED BY public.api_keys.id;


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id bigint NOT NULL,
    scope text NOT NULL,
    ref_id bigint NOT NULL,
    side text DEFAULT 'submit'::text NOT NULL,
    orig_name text NOT NULL,
    stored_name text NOT NULL,
    mime text NOT NULL,
    size bigint NOT NULL,
    note text,
    uploaded_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attachments_id_seq OWNED BY public.attachments.id;


--
-- Name: cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cases (
    id bigint NOT NULL,
    client_id bigint,
    code text,
    title text NOT NULL,
    client_tags text,
    male_tags text,
    problem text,
    judgement text,
    strategy text,
    feedback text,
    outcome text,
    reusable boolean DEFAULT false NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_type text DEFAULT 'manual'::text NOT NULL,
    source_url text,
    source_ref text,
    deleted_at timestamp with time zone
);


--
-- Name: cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cases_id_seq OWNED BY public.cases.id;


--
-- Name: channel_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_accounts (
    id bigint NOT NULL,
    channel public.work_channel NOT NULL,
    side public.work_side NOT NULL,
    platform text DEFAULT '小红书'::text NOT NULL,
    handle text NOT NULL,
    url text,
    followers integer DEFAULT 0 NOT NULL,
    positioning text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: channel_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.channel_accounts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: channel_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.channel_accounts_id_seq OWNED BY public.channel_accounts.id;


--
-- Name: chat_deletes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_deletes (
    message_id bigint NOT NULL,
    user_id bigint NOT NULL
);


--
-- Name: chat_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_group_members (
    group_id bigint NOT NULL,
    user_id bigint NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_group_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_group_reads (
    group_id bigint NOT NULL,
    user_id bigint NOT NULL,
    last_read_id bigint DEFAULT 0 NOT NULL
);


--
-- Name: chat_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_groups (
    id bigint NOT NULL,
    name text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chat_groups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chat_groups_id_seq OWNED BY public.chat_groups.id;


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id bigint NOT NULL,
    from_id bigint NOT NULL,
    to_id bigint,
    body text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    group_id bigint,
    mentions bigint[],
    edited_at timestamp with time zone,
    recalled_at timestamp with time zone
);


--
-- Name: chat_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chat_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chat_messages_id_seq OWNED BY public.chat_messages.id;


--
-- Name: client_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_deliveries (
    id bigint NOT NULL,
    client_id bigint NOT NULL,
    happened_at date DEFAULT CURRENT_DATE NOT NULL,
    kind text,
    summary text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: client_deliveries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_deliveries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_deliveries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_deliveries_id_seq OWNED BY public.client_deliveries.id;


--
-- Name: client_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_files (
    id bigint NOT NULL,
    client_id bigint NOT NULL,
    orig_name text NOT NULL,
    stored_name text NOT NULL,
    mime text NOT NULL,
    size bigint NOT NULL,
    note text,
    uploaded_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: client_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_files_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_files_id_seq OWNED BY public.client_files.id;


--
-- Name: clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clients (
    id bigint NOT NULL,
    alias text NOT NULL,
    tier text,
    stage public.client_stage DEFAULT 'lead'::public.client_stage NOT NULL,
    source text,
    owner_id bigint,
    female jsonb DEFAULT '{}'::jsonb NOT NULL,
    male jsonb DEFAULT '{}'::jsonb NOT NULL,
    relation jsonb DEFAULT '{}'::jsonb NOT NULL,
    timeline text,
    evidence text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_type text DEFAULT 'manual'::text NOT NULL,
    source_url text,
    source_ref text,
    ai_situation text,
    ai_user text,
    ai_updated_at timestamp with time zone,
    deal jsonb DEFAULT '{}'::jsonb NOT NULL,
    external_id text,
    deleted_at timestamp with time zone
);


--
-- Name: clients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clients_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clients_id_seq OWNED BY public.clients.id;


--
-- Name: demands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demands (
    id bigint NOT NULL,
    title text NOT NULL,
    quote text,
    scene text,
    real_goal text,
    note text,
    source_type text DEFAULT 'manual'::text NOT NULL,
    source_url text,
    source_ref text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: demands_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.demands_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: demands_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.demands_id_seq OWNED BY public.demands.id;


--
-- Name: entity_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_tags (
    entity text NOT NULL,
    entity_id bigint NOT NULL,
    tag_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: idea_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idea_activities (
    id bigint NOT NULL,
    idea_id bigint NOT NULL,
    actor_id bigint,
    action text NOT NULL,
    from_status public.idea_status,
    to_status public.idea_status,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: idea_activities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.idea_activities_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: idea_activities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.idea_activities_id_seq OWNED BY public.idea_activities.id;


--
-- Name: idea_code_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.idea_code_seq
    START WITH 33
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: idea_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idea_comments (
    id bigint NOT NULL,
    idea_id bigint NOT NULL,
    user_id bigint NOT NULL,
    parent_id bigint,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_anonymous boolean DEFAULT false NOT NULL
);


--
-- Name: idea_comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.idea_comments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: idea_comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.idea_comments_id_seq OWNED BY public.idea_comments.id;


--
-- Name: idea_votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idea_votes (
    idea_id bigint NOT NULL,
    user_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ideas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ideas (
    id bigint NOT NULL,
    code text,
    title text NOT NULL,
    content text NOT NULL,
    category text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    status public.idea_status DEFAULT 'pending'::public.idea_status NOT NULL,
    author_id bigint NOT NULL,
    is_anonymous boolean DEFAULT false NOT NULL,
    vote_count integer DEFAULT 0 NOT NULL,
    comment_count integer DEFAULT 0 NOT NULL,
    view_count integer DEFAULT 0 NOT NULL,
    hot_score real DEFAULT 0 NOT NULL,
    owner_id bigint,
    adopted_at timestamp with time zone,
    adopted_by bigint,
    progress integer DEFAULT 0 NOT NULL,
    doc_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_type text DEFAULT 'manual'::text NOT NULL,
    source_url text,
    source_ref text,
    deleted_at timestamp with time zone,
    promoted_at timestamp with time zone
);


--
-- Name: ideas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ideas_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ideas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ideas_id_seq OWNED BY public.ideas.id;


--
-- Name: links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.links (
    id bigint NOT NULL,
    from_entity text NOT NULL,
    from_id bigint NOT NULL,
    to_entity text NOT NULL,
    to_id bigint NOT NULL,
    note text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.links_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.links_id_seq OWNED BY public.links.id;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    actor_id bigint,
    kind text NOT NULL,
    title text NOT NULL,
    body text,
    board text,
    ref_id bigint,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: playbook_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_items (
    id bigint NOT NULL,
    board text NOT NULL,
    section text NOT NULL,
    label text,
    title text NOT NULL,
    body text,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: playbook_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playbook_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playbook_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playbook_items_id_seq OWNED BY public.playbook_items.id;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    user_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    user_agent text
);


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id bigint NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tags_id_seq OWNED BY public.tags.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    name text NOT NULL,
    dept text,
    role public.user_role DEFAULT 'member'::public.user_role NOT NULL,
    avatar_hue text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    username text,
    password_hash text,
    last_login_at timestamp with time zone
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: work_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_analyses (
    work_id bigint NOT NULL,
    task_id text,
    platform text,
    schema_ver integer,
    payload json NOT NULL,
    digest jsonb DEFAULT '{}'::jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    cover_file text
);


--
-- Name: work_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_reports (
    id bigint NOT NULL,
    author_id bigint NOT NULL,
    reviewer_id bigint,
    report_date date DEFAULT CURRENT_DATE NOT NULL,
    title text NOT NULL,
    summary text,
    feedback text,
    reviewed_at timestamp with time zone,
    reviewed_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    result_url text,
    blockers text,
    need_help text
);


--
-- Name: work_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.work_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: work_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.work_reports_id_seq OWNED BY public.work_reports.id;


--
-- Name: works; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.works (
    id bigint NOT NULL,
    channel public.work_channel NOT NULL,
    side public.work_side NOT NULL,
    account_id bigint,
    title text NOT NULL,
    url text,
    pillar text,
    published_at date,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    note text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_type text DEFAULT 'manual'::text NOT NULL,
    source_url text,
    source_ref text,
    deleted_at timestamp with time zone
);


--
-- Name: works_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.works_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: works_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.works_id_seq OWNED BY public.works.id;


--
-- Name: api_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys ALTER COLUMN id SET DEFAULT nextval('public.api_keys_id_seq'::regclass);


--
-- Name: attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments ALTER COLUMN id SET DEFAULT nextval('public.attachments_id_seq'::regclass);


--
-- Name: cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases ALTER COLUMN id SET DEFAULT nextval('public.cases_id_seq'::regclass);


--
-- Name: channel_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_accounts ALTER COLUMN id SET DEFAULT nextval('public.channel_accounts_id_seq'::regclass);


--
-- Name: chat_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_groups ALTER COLUMN id SET DEFAULT nextval('public.chat_groups_id_seq'::regclass);


--
-- Name: chat_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages ALTER COLUMN id SET DEFAULT nextval('public.chat_messages_id_seq'::regclass);


--
-- Name: client_deliveries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_deliveries ALTER COLUMN id SET DEFAULT nextval('public.client_deliveries_id_seq'::regclass);


--
-- Name: client_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_files ALTER COLUMN id SET DEFAULT nextval('public.client_files_id_seq'::regclass);


--
-- Name: clients id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients ALTER COLUMN id SET DEFAULT nextval('public.clients_id_seq'::regclass);


--
-- Name: demands id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demands ALTER COLUMN id SET DEFAULT nextval('public.demands_id_seq'::regclass);


--
-- Name: idea_activities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_activities ALTER COLUMN id SET DEFAULT nextval('public.idea_activities_id_seq'::regclass);


--
-- Name: idea_comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_comments ALTER COLUMN id SET DEFAULT nextval('public.idea_comments_id_seq'::regclass);


--
-- Name: ideas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ideas ALTER COLUMN id SET DEFAULT nextval('public.ideas_id_seq'::regclass);


--
-- Name: links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links ALTER COLUMN id SET DEFAULT nextval('public.links_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: playbook_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_items ALTER COLUMN id SET DEFAULT nextval('public.playbook_items_id_seq'::regclass);


--
-- Name: tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags ALTER COLUMN id SET DEFAULT nextval('public.tags_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: work_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_reports ALTER COLUMN id SET DEFAULT nextval('public.work_reports_id_seq'::regclass);


--
-- Name: works id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.works ALTER COLUMN id SET DEFAULT nextval('public.works_id_seq'::regclass);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_stored_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_stored_name_key UNIQUE (stored_name);


--
-- Name: cases cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_pkey PRIMARY KEY (id);


--
-- Name: channel_accounts channel_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_accounts
    ADD CONSTRAINT channel_accounts_pkey PRIMARY KEY (id);


--
-- Name: chat_deletes chat_deletes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_deletes
    ADD CONSTRAINT chat_deletes_pkey PRIMARY KEY (message_id, user_id);


--
-- Name: chat_group_members chat_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_members
    ADD CONSTRAINT chat_group_members_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: chat_group_reads chat_group_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_reads
    ADD CONSTRAINT chat_group_reads_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: chat_groups chat_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_groups
    ADD CONSTRAINT chat_groups_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: client_deliveries client_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_deliveries
    ADD CONSTRAINT client_deliveries_pkey PRIMARY KEY (id);


--
-- Name: client_files client_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_files
    ADD CONSTRAINT client_files_pkey PRIMARY KEY (id);


--
-- Name: client_files client_files_stored_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_files
    ADD CONSTRAINT client_files_stored_name_key UNIQUE (stored_name);


--
-- Name: clients clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);


--
-- Name: demands demands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demands
    ADD CONSTRAINT demands_pkey PRIMARY KEY (id);


--
-- Name: entity_tags entity_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_tags
    ADD CONSTRAINT entity_tags_pkey PRIMARY KEY (entity, entity_id, tag_id);


--
-- Name: idea_activities idea_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_activities
    ADD CONSTRAINT idea_activities_pkey PRIMARY KEY (id);


--
-- Name: idea_comments idea_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_comments
    ADD CONSTRAINT idea_comments_pkey PRIMARY KEY (id);


--
-- Name: idea_votes idea_votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_votes
    ADD CONSTRAINT idea_votes_pkey PRIMARY KEY (idea_id, user_id);


--
-- Name: ideas ideas_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ideas
    ADD CONSTRAINT ideas_code_key UNIQUE (code);


--
-- Name: ideas ideas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ideas
    ADD CONSTRAINT ideas_pkey PRIMARY KEY (id);


--
-- Name: links links_from_entity_from_id_to_entity_to_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_from_entity_from_id_to_entity_to_id_key UNIQUE (from_entity, from_id, to_entity, to_id);


--
-- Name: links links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: playbook_items playbook_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_items
    ADD CONSTRAINT playbook_items_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: tags tags_kind_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_kind_name_key UNIQUE (kind, name);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: work_analyses work_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_analyses
    ADD CONSTRAINT work_analyses_pkey PRIMARY KEY (work_id);


--
-- Name: work_reports work_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_reports
    ADD CONSTRAINT work_reports_pkey PRIMARY KEY (id);


--
-- Name: works works_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.works
    ADD CONSTRAINT works_pkey PRIMARY KEY (id);


--
-- Name: idx_accounts_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_channel ON public.channel_accounts USING btree (channel, side);


--
-- Name: idx_activities_idea; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activities_idea ON public.idea_activities USING btree (idea_id, created_at);


--
-- Name: idx_attachments; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachments ON public.attachments USING btree (scope, ref_id, created_at DESC);


--
-- Name: idx_cases_alive; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_alive ON public.cases USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_cases_outcome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_outcome ON public.cases USING btree (outcome, id DESC);


--
-- Name: idx_cases_source_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cases_source_ref ON public.cases USING btree (source_type, source_ref) WHERE (source_ref IS NOT NULL);


--
-- Name: idx_channel_accounts_alive; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channel_accounts_alive ON public.channel_accounts USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_chat_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_group ON public.chat_messages USING btree (group_id, id DESC);


--
-- Name: idx_chat_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_pair ON public.chat_messages USING btree (from_id, to_id, id DESC);


--
-- Name: idx_chat_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_unread ON public.chat_messages USING btree (to_id, read_at NULLS FIRST, id DESC);


--
-- Name: idx_client_deliveries; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_deliveries ON public.client_deliveries USING btree (client_id, happened_at DESC);


--
-- Name: idx_client_files; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_files ON public.client_files USING btree (client_id, created_at DESC);


--
-- Name: idx_clients_alive; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clients_alive ON public.clients USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_clients_external; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_clients_external ON public.clients USING btree (external_id) WHERE (external_id IS NOT NULL);


--
-- Name: idx_clients_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clients_stage ON public.clients USING btree (stage, tier);


--
-- Name: idx_comments_idea; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comments_idea ON public.idea_comments USING btree (idea_id, created_at);


--
-- Name: idx_demands_source_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_demands_source_ref ON public.demands USING btree (source_type, source_ref) WHERE (source_ref IS NOT NULL);


--
-- Name: idx_demands_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demands_time ON public.demands USING btree (created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_entity_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_tags_tag ON public.entity_tags USING btree (tag_id, entity, entity_id);


--
-- Name: idx_ideas_alive; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ideas_alive ON public.ideas USING btree (status, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_ideas_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ideas_author ON public.ideas USING btree (author_id);


--
-- Name: idx_ideas_source_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ideas_source_ref ON public.ideas USING btree (source_type, source_ref) WHERE (source_ref IS NOT NULL);


--
-- Name: idx_ideas_status_hot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ideas_status_hot ON public.ideas USING btree (status, hot_score DESC);


--
-- Name: idx_ideas_status_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ideas_status_time ON public.ideas USING btree (status, created_at DESC);


--
-- Name: idx_ideas_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ideas_tags ON public.ideas USING gin (tags);


--
-- Name: idx_ideas_title_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ideas_title_trgm ON public.ideas USING gin (title public.gin_trgm_ops);


--
-- Name: idx_links_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_links_from ON public.links USING btree (from_entity, from_id);


--
-- Name: idx_links_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_links_to ON public.links USING btree (to_entity, to_id);


--
-- Name: idx_notif_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notif_user ON public.notifications USING btree (user_id, read_at NULLS FIRST, created_at DESC);


--
-- Name: idx_playbook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook ON public.playbook_items USING btree (board, section, sort);


--
-- Name: idx_playbook_items_alive; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_items_alive ON public.playbook_items USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_tags_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_kind ON public.tags USING btree (kind, sort, id);


--
-- Name: idx_work_analyses_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_work_analyses_task ON public.work_analyses USING btree (task_id);


--
-- Name: idx_work_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_work_author ON public.work_reports USING btree (author_id, report_date DESC);


--
-- Name: idx_work_reviewer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_work_reviewer ON public.work_reports USING btree (reviewer_id, report_date DESC);


--
-- Name: idx_works_alive; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_works_alive ON public.works USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_works_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_works_channel ON public.works USING btree (channel, side, published_at DESC);


--
-- Name: idx_works_source_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_works_source_ref ON public.works USING btree (source_type, source_ref) WHERE (source_ref IS NOT NULL);


--
-- Name: sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: users_username_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_username_uniq ON public.users USING btree (lower(username));


--
-- Name: idea_comments trg_comment_count; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_comment_count AFTER INSERT OR DELETE ON public.idea_comments FOR EACH ROW EXECUTE FUNCTION public.sync_comment_count();


--
-- Name: ideas trg_hot_score; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_hot_score BEFORE INSERT OR UPDATE OF vote_count, comment_count ON public.ideas FOR EACH ROW EXECUTE FUNCTION public.set_hot_score();


--
-- Name: idea_votes trg_vote_count; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vote_count AFTER INSERT OR DELETE ON public.idea_votes FOR EACH ROW EXECUTE FUNCTION public.sync_vote_count();


--
-- Name: api_keys api_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: attachments attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: cases cases_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;


--
-- Name: cases cases_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: chat_deletes chat_deletes_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_deletes
    ADD CONSTRAINT chat_deletes_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.chat_messages(id) ON DELETE CASCADE;


--
-- Name: chat_deletes chat_deletes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_deletes
    ADD CONSTRAINT chat_deletes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_group_members chat_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_members
    ADD CONSTRAINT chat_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.chat_groups(id) ON DELETE CASCADE;


--
-- Name: chat_group_members chat_group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_members
    ADD CONSTRAINT chat_group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_group_reads chat_group_reads_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_reads
    ADD CONSTRAINT chat_group_reads_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.chat_groups(id) ON DELETE CASCADE;


--
-- Name: chat_group_reads chat_group_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_reads
    ADD CONSTRAINT chat_group_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_groups chat_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_groups
    ADD CONSTRAINT chat_groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_from_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_from_id_fkey FOREIGN KEY (from_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.chat_groups(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_to_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_to_id_fkey FOREIGN KEY (to_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: client_deliveries client_deliveries_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_deliveries
    ADD CONSTRAINT client_deliveries_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: client_deliveries client_deliveries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_deliveries
    ADD CONSTRAINT client_deliveries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: client_files client_files_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_files
    ADD CONSTRAINT client_files_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: client_files client_files_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_files
    ADD CONSTRAINT client_files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: clients clients_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: demands demands_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demands
    ADD CONSTRAINT demands_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: entity_tags entity_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_tags
    ADD CONSTRAINT entity_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: idea_activities idea_activities_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_activities
    ADD CONSTRAINT idea_activities_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: idea_activities idea_activities_idea_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_activities
    ADD CONSTRAINT idea_activities_idea_id_fkey FOREIGN KEY (idea_id) REFERENCES public.ideas(id) ON DELETE CASCADE;


--
-- Name: idea_comments idea_comments_idea_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_comments
    ADD CONSTRAINT idea_comments_idea_id_fkey FOREIGN KEY (idea_id) REFERENCES public.ideas(id) ON DELETE CASCADE;


--
-- Name: idea_comments idea_comments_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_comments
    ADD CONSTRAINT idea_comments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.idea_comments(id) ON DELETE CASCADE;


--
-- Name: idea_comments idea_comments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_comments
    ADD CONSTRAINT idea_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: idea_votes idea_votes_idea_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_votes
    ADD CONSTRAINT idea_votes_idea_id_fkey FOREIGN KEY (idea_id) REFERENCES public.ideas(id) ON DELETE CASCADE;


--
-- Name: idea_votes idea_votes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idea_votes
    ADD CONSTRAINT idea_votes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: ideas ideas_adopted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ideas
    ADD CONSTRAINT ideas_adopted_by_fkey FOREIGN KEY (adopted_by) REFERENCES public.users(id);


--
-- Name: ideas ideas_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ideas
    ADD CONSTRAINT ideas_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: ideas ideas_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ideas
    ADD CONSTRAINT ideas_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: links links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: playbook_items playbook_items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_items
    ADD CONSTRAINT playbook_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: work_analyses work_analyses_work_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_analyses
    ADD CONSTRAINT work_analyses_work_id_fkey FOREIGN KEY (work_id) REFERENCES public.works(id) ON DELETE CASCADE;


--
-- Name: work_reports work_reports_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_reports
    ADD CONSTRAINT work_reports_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: work_reports work_reports_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_reports
    ADD CONSTRAINT work_reports_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: work_reports work_reports_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_reports
    ADD CONSTRAINT work_reports_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: works works_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.works
    ADD CONSTRAINT works_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.channel_accounts(id) ON DELETE SET NULL;


--
-- Name: works works_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.works
    ADD CONSTRAINT works_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

\unrestrict cVP6k9IwPqx3UMlWtTBqg6XkPYJDU58BzQekvX81p6Culy0yojh9IH2xRmm3AFk

