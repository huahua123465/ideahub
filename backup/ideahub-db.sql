--
-- PostgreSQL database dump
--

\restrict e28p85eBh7aWaO3hEDTNUa71Mn81a8i9LZEQyIbj5m8P4L70TH8csIa4Hsj640X

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
-- Data for Name: api_keys; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.api_keys (id, name, key_hash, scopes, created_by, created_at, last_used_at, revoked_at) FROM stdin;
16	技术1（验收自测 08-25，用完即停）	dfc560a01c260e5f5e2d47f7b8e522682557eeb7b01e2f139500ec82d6e3193c	{tech1}	\N	2026-08-25 07:03:47.33308+00	2026-08-25 07:04:06.952859+00	2026-08-25 07:10:02.971304+00
18	技术1（封面自测 08-25，用完即停）	d0b27ba8aa7189465ec44d8dd97c81a534a8b0f8c86e2fff45589fc34fa3aafc	{tech1}	\N	2026-08-25 07:49:10.637184+00	2026-08-25 07:53:06.459047+00	2026-08-25 07:53:51.869286+00
19	技术1（图文自测 08-25，用完即停）	a195301f9497295cfda59e7162e5f18d8b018598c8c9cd9b056f498652a7627b	{tech1}	\N	2026-08-25 08:33:54.131209+00	2026-08-25 08:33:54.260188+00	2026-08-25 08:36:53.709694+00
20	技术1（翻页自测 08-25，用完即停）	b38b185c79dbb1972fb4e54be4371342d1815f8132f497888f09cb52eecc4c23	{tech1}	\N	2026-08-25 08:50:22.821166+00	2026-08-25 08:50:22.935007+00	2026-08-25 08:52:04.660016+00
14	技术2	e394cef8a28b0a4c3fb023cd4e0c7cccb327c18de3641bef1b7615aec80b4dc5	{tech2}	1	2026-08-25 02:35:22.902497+00	2026-08-25 03:00:55.343314+00	\N
17	技术1	bfab7b9a2329555e84c55e151346ec8909ccf646ce8c08fa209f50990d624cfa	{tech1}	1	2026-08-25 07:12:31.252352+00	2026-08-25 09:43:01.901805+00	\N
15	技术1（联调自测，用完就停）	7423c9c623ae4b21f5cc76d7cdd8160384853d765eb87216ee18a3d63aaaaf45	{tech1}	\N	2026-08-25 06:34:47.612673+00	2026-08-25 06:41:31.323016+00	2026-08-25 06:48:08.67567+00
\.


--
-- Data for Name: attachments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.attachments (id, scope, ref_id, side, orig_name, stored_name, mime, size, note, uploaded_by, created_at) FROM stdin;
1	client	1	submit	小华_微信聊天记录综合分析报告.html	158cd2cd1a74ebd355d4193a7314f338.html	text/html; charset=utf-8	40070	\N	1	2026-08-21 06:42:08.98788+00
9	report	3	submit	output_真诚关系咨询Mini_武志红心理学_已填写.xlsx	c135dae2629df541fd8dc72f8d78377a.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	49783	\N	7	2026-08-21 07:40:07.222272+00
11	report	4	submit	小华_微信聊天记录综合分析报告.html	8274b1380be7b56cfe108dbfaefab81e.html	text/html; charset=utf-8	40070	\N	1	2026-08-21 07:52:18.911739+00
12	report	5	submit	情感赛道_业务观察工作簿第一周_已填写.xlsx	d3f518b28208eef64642b18b0e5efaf3.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	45356	\N	11	2026-08-21 07:59:20.577476+00
14	chat	10	submit	小华_微信聊天记录综合分析报告.html	80b691977158e31d8d05cbc26c6c49a1.html	text/html; charset=utf-8	40070	\N	1	2026-08-21 08:04:27.662142+00
15	chat	11	submit	canvas-image-image-1785226933218-dsjrx.png	d41f2aadc86a985cd9f056628539f07c.png	image/png	2338930	\N	1	2026-08-21 08:04:51.195144+00
16	chat	12	submit	Receipt-2354-9635-2195.pdf	70769236673a3ecb688c0fc32e073056.pdf	application/pdf	38193	\N	1	2026-08-21 08:04:55.906133+00
17	chat	13	submit	已生成图像 1 (1).png	f1e57fdaa3dcc42d9e7489ad72ddb193.png	image/png	2106028	\N	1	2026-08-21 08:05:00.044862+00
38	client	6	submit	E2E-附件.html	cdc283c1226c2142735459e02c24b588.html	text/html; charset=utf-8	93	\N	1	2026-08-21 14:18:16.40685+00
39	client	6	submit	E2E-附件.html	13e2ddea331695c1967d2b81c9b6422f.html	text/html; charset=utf-8	93	\N	1	2026-08-21 14:19:37.492237+00
42	report	15	submit	情感赛道_业务观察工作簿第一周.xlsx	d18a67671927aec00d701e8a54d03a59.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	44128	\N	7	2026-08-24 07:53:08.477187+00
43	report	16	submit	情感赛道_业务观察工作簿第一周.xlsx	9ce157f69703a4a57393cbd06ce3f925.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	44851	\N	10	2026-08-24 09:31:15.215755+00
44	report	17	submit	情感赛道_业务观察工作簿第一周.xlsx	24b04263188e73e73caba3cbc09e6f27.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	45281	\N	7	2026-08-25 06:32:16.469056+00
53	report	19	submit	01_封面.png	85eeb1fa525bcdf38480198db7b69925.png	image/png	1060637	\N	7	2026-08-25 08:27:27.60622+00
54	report	19	submit	02_护手霜接触.png	2d7414f4f244025684303693beb58bc6.png	image/png	1140078	\N	7	2026-08-25 08:27:32.679636+00
55	report	19	submit	03_明天找你.png	00a9b6787ca71ea366a567afef7877c4.png	image/png	963239	\N	7	2026-08-25 08:27:39.291926+00
56	report	19	submit	04_整理衣领眼神.png	2edb9513d1f4b078348114f3dc1ec5b8.png	image/png	1152525	\N	7	2026-08-25 08:27:46.148907+00
57	report	19	submit	05_节奏总结.png	dd516bf18e3d1077adf375b0505c1a33.png	image/png	1059979	\N	7	2026-08-25 08:28:16.51547+00
58	report	20	submit	海绵宝宝工位壁纸_6_紫皮茄_来自小红书网页版.jpg	7f635556ae82336fa9fced534103d8b9.jpg	image/jpeg	557660	\N	1	2026-08-25 08:51:09.36666+00
59	report	20	submit	海绵宝宝工位壁纸_5_紫皮茄_来自小红书网页版.jpg	92a73a9c5567dc4e64db0eaad8305519.jpg	image/jpeg	639704	\N	1	2026-08-25 08:51:09.795388+00
60	report	20	submit	海绵宝宝工位壁纸_4_紫皮茄_来自小红书网页版.jpg	d7b89f51a6835b68f0c7a5a5dabceb6f.jpg	image/jpeg	570281	\N	1	2026-08-25 08:51:10.186114+00
61	report	20	submit	海绵宝宝工位壁纸_3_紫皮茄_来自小红书网页版.jpg	52f3fd0f69aac46c31393541f377b2fe.jpg	image/jpeg	486472	\N	1	2026-08-25 08:51:10.427019+00
63	report	22	submit	微信图片_20260825172425_140_20.png	c5a0694061b23a50df728f3478bbb559.png	image/png	859046	\N	10	2026-08-25 09:27:42.535778+00
64	report	22	submit	微信图片_20260825172425_139_20.png	1dd1a29accf08db80e7f826de59a0210.png	image/png	826602	\N	10	2026-08-25 09:27:42.78213+00
65	report	22	submit	微信图片_20260825172345_138_20.png	e93faddbd568bb5f6fdaa4f3b0d4c846.png	image/png	859072	\N	10	2026-08-25 09:27:43.04405+00
66	report	23	submit	情感赛道_业务观察工作簿第一周.xlsx	1d974b81056bbd283a69b50c1c573336.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	47268	\N	10	2026-08-25 09:28:32.138235+00
\.


--
-- Data for Name: cases; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cases (id, client_id, code, title, client_tags, male_tags, problem, judgement, strategy, feedback, outcome, reusable, created_by, created_at, updated_at, source_type, source_url, source_ref, deleted_at) FROM stdin;
1	1	CASE-2026-001	高价值男性回避承诺，如何验证长择意愿	29岁/产品经理/上海/暧昧后期/推进确定关系	33岁/投行/独子/回避型依恋/社交圈窄	暧昧不推进：稳定见面但拒绝谈未来	核心卡点是他把「确定关系」等同于「失去自由」。风险：拖延成本高。概率判断：长择意愿存在但需要外部推力。	沟通：停止追问未来，改为展示自身选择权；见面：降频到两周一次；边界：明确不再单方面配合行程；验证：观察他是否主动补位；退出条件：60 天内无实质推进则撤退。	第 3 周对方主动约见并提出见朋友；第 6 周主动谈及同居。客户执行偏差：中途一次破例秒回，已纠偏。	推进成功	t	\N	2026-08-21 04:19:32.342303+00	2026-08-21 04:19:32.342303+00	manual	\N	\N	\N
2	4	CASE-2026-002	异地分手后的断联期该做什么	24岁/设计/成都/已分手/挽回	25岁/销售/本地/社交广/回避冲突	挽回：异地矛盾导致分手，断联 2 周	核心卡点不是感情消失，是异地下的现实成本无解。风险：复合后原问题原样复现。概率判断：短期复合可能性中等，长期稳定性低。	沟通：断联期不主动联系；边界：不做情绪索取；验证：观察对方是否在共同好友处打听；退出条件：断联满 45 天无任何主动信号则彻底放下。	第 4 周对方通过共同好友试探。客户执行到位，未破戒。	复合	t	\N	2026-08-21 04:19:32.344996+00	2026-08-21 04:19:32.344996+00	manual	\N	\N	\N
3	5	CASE-2026-003	相亲推进期的疑虑该不该说出口	31岁/医生/深圳/确定中/判断是否继续投入	35岁/公务员/离异/本地有弟/家庭责任重	冲突：见家长后对未来分工产生疑虑	核心卡点是双方对「婚后家庭责任」的预期没有对齐，而不是感情问题。风险：回避讨论会在婚后爆发。	沟通：用具体场景而非抽象立场提问；验证：观察他对弟弟经济支持的实际态度；节点：三个月内必须完成一次财务与家庭责任的明确对话。	进行中 —— 第一次场景化提问已完成，对方回应模糊，需要二次验证。	进行中	f	\N	2026-08-21 04:19:32.348428+00	2026-08-21 04:19:32.348428+00	manual	\N	\N	\N
4	3	CASE-2026-004	无单一对象客户的择偶系统怎么搭	34岁/创业者/北京/无单一对象/长期择偶	—（无特定对象）	识人与择偶：不知道该按什么标准筛选	核心卡点是过往三段关系都在重复同一个选择偏差 —— 被高强度情绪表达吸引，忽略稳定性指标。	能力训练：建立三层筛选标准（现实条件 / 关系能力 / 长期一致性）；社交圈：每月两个新场景；复盘：每两周一次择偶决策复盘。	第二期续费。已能独立完成初筛判断，咨询频次从每周降到每月。	长期稳定	t	\N	2026-08-21 04:19:32.350487+00	2026-08-21 04:19:32.350487+00	manual	\N	\N	\N
68	\N	\N	智能导入全路径自测-1787555517124-案例	\N	\N	测试	测试	测试	\N	测试	f	1	2026-08-24 07:11:57.1553+00	2026-08-24 07:11:57.1553+00	manual		smart:615027849b8c2336e311:5	2026-08-24 07:11:57.295033+00
\.


--
-- Data for Name: channel_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.channel_accounts (id, channel, side, platform, handle, url, followers, positioning, note, created_at, updated_at, deleted_at) FROM stdin;
1	persona	own	小红书	主理人真人号	\N	0	建立深度信任：强判断、案例拆解、方法论、直播	PDF 02：让用户相信「这个人能看懂我的关系」	2026-08-21 04:19:32.254802+00	2026-08-21 04:19:32.254802+00	\N
2	persona	benchmark	小红书	（待填）对标真人号 A	\N	0	同赛道头部，判断力标签清晰	对标理由：看它怎么把「判断力」做成人设标签	2026-08-21 04:19:32.259206+00	2026-08-21 04:19:32.259206+00	\N
3	persona	benchmark	抖音	（待填）对标真人号 B	\N	0	案例拆解型	对标理由：拆解结构完整，推理链展示得好	2026-08-21 04:19:32.261742+00	2026-08-21 04:19:32.261742+00	\N
4	matrix	own	小红书	矩阵号 01	\N	0	扩大流量覆盖：高频问题、情绪痛点	PDF 02：批量生产、多账号分发、关键词引流	2026-08-21 04:19:32.26362+00	2026-08-21 04:19:32.26362+00	\N
5	matrix	own	抖音	矩阵号 02	\N	0	扩大流量覆盖：男女差异、识人信号	持续获得低成本线索	2026-08-21 04:19:32.266044+00	2026-08-21 04:19:32.266044+00	\N
6	matrix	benchmark	小红书	（待填）对标矩阵号	\N	0	高频问题型	对标理由：选题密度高，可直接进选题库	2026-08-21 04:19:32.267678+00	2026-08-21 04:19:32.267678+00	\N
7	live	own	视频号	主理人直播间	\N	0	把诊断能力变成成交现场	PDF 03：让用户亲眼看到「如何从零散信息中快速判断」	2026-08-21 04:19:32.269017+00	2026-08-21 04:19:32.269017+00	\N
8	live	benchmark	抖音	（待填）对标直播间	\N	0	连麦诊断型	对标理由：看它的连麦提问顺序和成交话术	2026-08-21 04:19:32.27035+00	2026-08-21 04:19:32.27035+00	\N
13	matrix	benchmark	小红书	恰芒芒不恰	https://www.xiaohongshu.com/user/profile/69133fb50000000037032e19	1340	🎥 影视爱好者  | 🎙️ 采访观察者\n💡 输出有温度、有深度的观点\n🟢🫧zyq_coinouo	\N	2026-08-25 08:22:43.976607+00	2026-08-25 08:37:53.693897+00	\N
16	matrix	benchmark	小红书	治愈果（kakki在说啥）	https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266	162886	🐳百万粉丝心理创作者｜心理师\n🐳累计500+小时个案\n🐳Queen Mary 法学硕士🇬🇧 \n🐳亲密关系｜终身成长：zhiyuguo820\n@愈果 YU GUO	\N	2026-08-25 09:20:49.338864+00	2026-08-25 09:20:49.338864+00	\N
9	persona	benchmark	小红书	可可拆爆款	https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1	122838	👩全网100W➕粉丝\n🎉你却的不是方法，而是一个带你的人\n🌲账号定位｜流量卡点｜爆款模板\n🔗下方进👗	\N	2026-08-25 06:36:40.164413+00	2026-08-25 09:20:56.490278+00	\N
10	matrix	benchmark	小红书	可可拆爆款	https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1	122838	👩全网100W➕粉丝\n🎉你却的不是方法，而是一个带你的人\n🌲账号定位｜流量卡点｜爆款模板\n🔗下方进👗	\N	2026-08-25 06:36:49.417507+00	2026-08-25 09:21:00.094163+00	\N
12	matrix	benchmark	小红书	野生老板商业思维	https://www.xiaohongshu.com/user/profile/5dd7f2730000000001007929	27555	2020福布斯U30，地产资管公司创始人\n强势文化｜国学智慧｜关系运作｜商业思维\n@野生老板 官方授权	\N	2026-08-25 07:15:31.145945+00	2026-08-25 07:15:31.145945+00	\N
14	matrix	benchmark	小红书	枕书凉.	https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01	230	8️⃣年心理研究专家\n擅长分析情感困惑，带你理性恋爱\n🉑  1v1文字or语音☎️ （非公益）咨-询\n亲密关系/自我提升/关系修复	\N	2026-08-25 08:23:40.916423+00	2026-08-25 09:21:04.408365+00	\N
18	persona	benchmark	小红书	枕书凉.	https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01	230	8️⃣年心理研究专家\n擅长分析情感困惑，带你理性恋爱\n🉑  1v1文字or语音☎️ （非公益）咨-询\n亲密关系/自我提升/关系修复	\N	2026-08-25 09:21:42.313642+00	2026-08-25 09:21:42.313642+00	\N
11	persona	benchmark	小红书	野生老板商业思维	https://www.xiaohongshu.com/user/profile/5dd7f2730000000001007929	27555	2020福布斯U30，地产资管公司创始人\n强势文化｜国学智慧｜关系运作｜商业思维\n@野生老板 官方授权	\N	2026-08-25 07:15:31.122084+00	2026-08-25 09:23:21.497988+00	\N
17	persona	benchmark	小红书	治愈果（kakki在说啥）	https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266	162886	🐳百万粉丝心理创作者｜心理师\n🐳累计500+小时个案\n🐳Queen Mary 法学硕士🇬🇧 \n🐳亲密关系｜终身成长：zhiyuguo820\n@愈果 YU GUO	\N	2026-08-25 09:20:51.915968+00	2026-08-25 09:43:02.477594+00	\N
\.


--
-- Data for Name: chat_deletes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.chat_deletes (message_id, user_id) FROM stdin;
37	1
37	10
\.


--
-- Data for Name: chat_group_members; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.chat_group_members (group_id, user_id, joined_at) FROM stdin;
4	1	2026-08-21 08:31:05.47784+00
4	7	2026-08-21 08:31:05.481847+00
4	3	2026-08-21 08:31:05.489854+00
4	4	2026-08-21 08:31:05.493269+00
4	8	2026-08-21 08:31:05.503172+00
4	9	2026-08-21 08:47:05.422968+00
4	10	2026-08-21 08:47:05.427206+00
4	11	2026-08-21 08:47:05.429238+00
\.


--
-- Data for Name: chat_group_reads; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.chat_group_reads (group_id, user_id, last_read_id) FROM stdin;
4	3	97
4	9	97
4	7	97
4	1	97
4	8	97
4	10	97
4	4	81
\.


--
-- Data for Name: chat_groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.chat_groups (id, name, created_by, created_at) FROM stdin;
4	乘势而上	1	2026-08-21 08:31:05.473818+00
\.


--
-- Data for Name: chat_messages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.chat_messages (id, from_id, to_id, body, read_at, created_at, group_id, mentions, edited_at, recalled_at) FROM stdin;
52	1	12	ni	2026-08-22 01:58:48.125248+00	2026-08-22 01:58:36.659993+00	\N	\N	\N	\N
53	12	1	在的	2026-08-22 01:58:53.421014+00	2026-08-22 01:58:51.680646+00	\N	\N	\N	\N
54	12	1	好的	2026-08-22 01:59:38.29434+00	2026-08-22 01:59:05.559261+00	\N	\N	\N	\N
55	12	1	测试	2026-08-22 01:59:38.29434+00	2026-08-22 01:59:11.90793+00	\N	\N	\N	\N
56	12	1	弹窗	2026-08-22 01:59:38.29434+00	2026-08-22 01:59:14.81543+00	\N	\N	\N	\N
57	1	12	1	2026-08-22 02:10:49.408406+00	2026-08-22 02:10:48.814225+00	\N	\N	\N	\N
58	1	12	你好	2026-08-22 02:11:03.579054+00	2026-08-22 02:11:03.467071+00	\N	\N	\N	\N
13	1	7	\N	2026-08-21 08:06:15.201064+00	2026-08-21 08:04:58.851298+00	\N	\N	\N	\N
12	1	7	\N	2026-08-21 08:06:15.201064+00	2026-08-21 08:04:55.73119+00	\N	\N	\N	\N
11	1	7	\N	2026-08-21 08:06:15.201064+00	2026-08-21 08:04:49.413335+00	\N	\N	\N	\N
10	1	7	\N	2026-08-21 08:06:15.201064+00	2026-08-21 08:04:27.655225+00	\N	\N	\N	\N
9	1	7	dd	2026-08-21 08:06:15.201064+00	2026-08-21 08:04:20.513996+00	\N	\N	\N	\N
8	1	7	你在干嘛	2026-08-21 08:06:15.201064+00	2026-08-21 08:04:12.799726+00	\N	\N	\N	\N
7	1	7	测试一下	2026-08-21 08:06:15.201064+00	2026-08-21 08:04:09.31806+00	\N	\N	\N	\N
6	1	7	在干嘛	2026-08-21 08:06:15.201064+00	2026-08-21 08:04:04.649695+00	\N	\N	\N	\N
5	1	7	在吗	2026-08-21 08:06:15.201064+00	2026-08-21 08:04:01.059725+00	\N	\N	\N	\N
4	1	7	你好	2026-08-21 08:06:15.201064+00	2026-08-21 08:03:57.467706+00	\N	\N	\N	\N
59	12	1	我在‘	2026-08-22 02:11:16.506666+00	2026-08-22 02:11:15.306629+00	\N	\N	\N	\N
60	12	1	好的	2026-08-22 02:11:19.835137+00	2026-08-22 02:11:19.559081+00	\N	\N	\N	\N
61	12	1	测	2026-08-22 02:12:02.496171+00	2026-08-22 02:12:00.729792+00	\N	\N	\N	\N
62	1	12	测试一下	2026-08-22 02:13:20.444524+00	2026-08-22 02:13:18.900704+00	\N	\N	\N	\N
63	1	12	测试	2026-08-22 02:16:41.488517+00	2026-08-22 02:16:40.991832+00	\N	\N	\N	\N
14	7	1	艰苦艰苦	2026-08-21 08:23:01.569945+00	2026-08-21 08:06:34.417117+00	\N	\N	\N	\N
15	7	1	回娘家拜年	2026-08-21 08:23:01.569945+00	2026-08-21 08:06:35.692735+00	\N	\N	\N	\N
16	7	1	你们v不能、	2026-08-21 08:23:01.569945+00	2026-08-21 08:06:37.128675+00	\N	\N	\N	\N
17	7	1	们能不能	2026-08-21 08:23:01.569945+00	2026-08-21 08:06:38.222851+00	\N	\N	\N	\N
64	12	1	你好	2026-08-22 02:38:56.040263+00	2026-08-22 02:38:39.688432+00	\N	\N	\N	\N
65	1	11	ces	\N	2026-08-24 02:23:53.587928+00	\N	\N	\N	\N
66	1	7	测试	2026-08-24 02:32:31.15889+00	2026-08-24 02:31:35.425809+00	\N	\N	\N	\N
67	1	7	测试	2026-08-24 02:32:31.15889+00	2026-08-24 02:31:36.713421+00	\N	\N	\N	\N
68	1	7	测	2026-08-24 02:33:19.448718+00	2026-08-24 02:33:08.497983+00	\N	\N	\N	\N
69	7	1	1	2026-08-24 02:33:21.499508+00	2026-08-24 02:33:21.310011+00	\N	\N	\N	\N
28	7	1	这是谁发的	2026-08-21 08:33:04.682455+00	2026-08-21 08:31:20.658829+00	\N	\N	\N	\N
29	7	1	我记得我没发啊	2026-08-21 08:33:04.682455+00	2026-08-21 08:31:46.902536+00	\N	\N	\N	\N
70	7	1	1	2026-08-24 02:33:22.319705+00	2026-08-24 02:33:22.276737+00	\N	\N	\N	\N
50	1	8	你好	2026-08-25 03:46:19.464+00	2026-08-21 09:29:44.427933+00	\N	\N	\N	\N
71	1	7	测试	2026-08-25 06:40:34.429441+00	2026-08-24 08:01:57.223292+00	\N	\N	\N	\N
36	1	\N	测试	\N	2026-08-21 08:49:18.158053+00	4	\N	\N	\N
37	1	\N	创下二	\N	2026-08-21 08:49:20.484386+00	4	\N	\N	\N
35	1	\N	\N	\N	2026-08-21 08:49:16.188099+00	4	\N	\N	2026-08-21 08:49:25.08117+00
72	1	7	测试	2026-08-25 06:40:34.429441+00	2026-08-24 08:02:01.717293+00	\N	\N	\N	\N
38	1	3	你好	2026-08-21 08:49:54.532684+00	2026-08-21 08:49:32.117179+00	\N	\N	\N	\N
73	1	7	测试	2026-08-25 06:40:34.429441+00	2026-08-24 08:02:05.298805+00	\N	\N	\N	\N
30	1	7	？	2026-08-21 09:02:06.818107+00	2026-08-21 08:33:12.472535+00	\N	\N	\N	\N
31	1	7	什么意思	2026-08-21 09:02:06.818107+00	2026-08-21 08:33:20.287642+00	\N	\N	\N	\N
18	10	7	1	2026-08-21 09:02:07.459464+00	2026-08-21 08:07:46.816988+00	\N	\N	\N	\N
75	4	\N	测试，看见请回一	\N	2026-08-25 07:38:11.543919+00	4	\N	\N	\N
74	9	4	1	2026-08-25 07:38:21.105112+00	2026-08-25 07:38:08.637727+00	\N	\N	\N	\N
76	9	\N	一	\N	2026-08-25 07:38:30.689958+00	4	\N	\N	\N
77	4	\N	业务的那个表格多些思考，越多越好，可以展开联想，哪怕和那条视频本身没有相关性	\N	2026-08-25 07:40:45.772795+00	4	\N	\N	\N
78	4	\N	工作台的输入框可以大一点，三行文字左右，可以支持直接截图粘贴发送	\N	2026-08-25 07:43:03.500777+00	4	\N	\N	\N
79	1	\N	1	\N	2026-08-25 07:44:36.208651+00	4	\N	\N	\N
80	10	\N	1	\N	2026-08-25 07:45:03.401511+00	4	\N	\N	\N
81	3	\N	1	\N	2026-08-25 07:45:48.093169+00	4	\N	\N	\N
91	3	\N	1	\N	2026-08-25 07:47:15.179309+00	4	\N	\N	\N
82	1	3	1	2026-08-25 07:47:19.187355+00	2026-08-25 07:46:41.594398+00	\N	\N	\N	\N
83	1	3	1	2026-08-25 07:47:19.187355+00	2026-08-25 07:46:44.421751+00	\N	\N	\N	\N
84	1	3	1	2026-08-25 07:47:19.187355+00	2026-08-25 07:46:45.376149+00	\N	\N	\N	\N
85	1	3	1	2026-08-25 07:47:19.187355+00	2026-08-25 07:46:46.373624+00	\N	\N	\N	\N
86	1	3	1	2026-08-25 07:47:19.187355+00	2026-08-25 07:46:59.884389+00	\N	\N	\N	\N
87	1	3	1	2026-08-25 07:47:19.187355+00	2026-08-25 07:47:02.62441+00	\N	\N	\N	\N
88	1	3	1	2026-08-25 07:47:19.187355+00	2026-08-25 07:47:04.409992+00	\N	\N	\N	\N
89	1	3	1	2026-08-25 07:47:19.187355+00	2026-08-25 07:47:05.414216+00	\N	\N	\N	\N
90	1	3	1	2026-08-25 07:47:19.187355+00	2026-08-25 07:47:06.527478+00	\N	\N	\N	\N
97	3	\N	1	\N	2026-08-25 07:48:58.103446+00	4	\N	\N	\N
92	3	1	1	2026-08-25 07:53:06.38728+00	2026-08-25 07:47:21.623425+00	\N	\N	\N	\N
93	3	1	1	2026-08-25 07:53:06.38728+00	2026-08-25 07:47:22.993475+00	\N	\N	\N	\N
94	3	1	1	2026-08-25 07:53:06.38728+00	2026-08-25 07:47:24.519676+00	\N	\N	\N	\N
95	3	1	1	2026-08-25 07:53:06.38728+00	2026-08-25 07:47:26.065581+00	\N	\N	\N	\N
96	3	1	1	2026-08-25 07:53:06.38728+00	2026-08-25 07:47:52.170805+00	\N	\N	\N	\N
98	1	3	1	2026-08-25 08:04:20.821671+00	2026-08-25 08:04:09.052799+00	\N	\N	\N	\N
99	1	3	1	2026-08-25 08:37:31.810671+00	2026-08-25 08:36:00.451185+00	\N	\N	\N	\N
100	1	3	1	2026-08-25 08:37:31.810671+00	2026-08-25 08:36:01.235836+00	\N	\N	\N	\N
101	1	3	1	2026-08-25 08:37:31.810671+00	2026-08-25 08:36:01.746503+00	\N	\N	\N	\N
102	1	3	1	2026-08-25 08:37:31.810671+00	2026-08-25 08:36:02.222835+00	\N	\N	\N	\N
103	1	3	1	2026-08-25 08:37:31.810671+00	2026-08-25 08:36:02.661355+00	\N	\N	\N	\N
104	1	3	1	2026-08-25 08:37:31.810671+00	2026-08-25 08:36:03.072668+00	\N	\N	\N	\N
105	3	10	1	2026-08-25 08:37:37.325033+00	2026-08-25 08:37:24.746921+00	\N	\N	\N	\N
106	10	3	2	2026-08-25 08:37:44.513175+00	2026-08-25 08:37:40.094693+00	\N	\N	\N	\N
107	3	10	3	2026-08-25 08:38:04.055939+00	2026-08-25 08:37:47.877088+00	\N	\N	\N	\N
108	3	7	1	\N	2026-08-25 08:39:01.346171+00	\N	\N	\N	\N
109	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:39:21.49546+00	\N	\N	\N	\N
110	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:39:31.813044+00	\N	\N	\N	\N
111	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:39:51.895218+00	\N	\N	\N	\N
112	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:39:55.638037+00	\N	\N	\N	\N
113	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:16.270027+00	\N	\N	\N	\N
114	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:19.973355+00	\N	\N	\N	\N
115	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:20.687157+00	\N	\N	\N	\N
116	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:21.261643+00	\N	\N	\N	\N
117	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:21.725158+00	\N	\N	\N	\N
118	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:22.21327+00	\N	\N	\N	\N
119	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:22.677063+00	\N	\N	\N	\N
\.


--
-- Data for Name: client_deliveries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.client_deliveries (id, client_id, happened_at, kind, summary, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: client_files; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.client_files (id, client_id, orig_name, stored_name, mime, size, note, uploaded_by, created_at) FROM stdin;
3	1	小华_微信聊天记录综合分析报告.html	158cd2cd1a74ebd355d4193a7314f338.html	text/html; charset=utf-8	40070	\N	1	2026-08-21 06:42:08.98788+00
\.


--
-- Data for Name: clients; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.clients (id, alias, tier, stage, source, owner_id, female, male, relation, timeline, evidence, note, created_at, updated_at, source_type, source_url, source_ref, ai_situation, ai_user, ai_updated_at, deal, external_id, deleted_at) FROM stdin;
1	C-01 阿柚	S	coaching	小红书私信	\N	{"城市": "上海", "年龄": 29, "职业": "产品经理", "婚恋史": "两段长恋", "当前诉求": "推进确定关系", "收入区间": "30–50w"}	{"家庭": "独子/父母在本地", "年龄": 33, "职业": "投行", "婚恋史": "一段5年", "社会关系": "圈子窄", "经济状况": "好"}	{"方式": "朋友介绍", "公开度": "未公开", "关系阶段": "暧昧后期", "当前状态": "稳定但不推进", "见面次数": "11", "认识时间": "5个月"}	认识(3月) → 升温(4-5月) → 关键事件:一起出差(6月) → 矛盾:回避谈未来(7月) → 变化:见面频率下降(8月) → 现在	聊天记录 3 个月、朋友圈近半年、约会照片若干、语音 2 段	典型的「高价值但回避承诺」型。已进入关系陪跑，重点是验证他的长择意愿。	2026-08-21 04:19:32.331338+00	2026-08-21 04:19:32.331338+00	manual	\N	\N	\N	\N	\N	{}	\N	\N
2	C-02 小林	A	consulted	直播连麦	\N	{"城市": "杭州", "年龄": 26, "职业": "运营", "婚恋史": "一段", "当前诉求": "看懂对方意图", "收入区间": "15–25w"}	{"家庭": "外地/普通", "年龄": 28, "职业": "程序员", "婚恋史": "无", "社会关系": "简单", "经济状况": "中"}	{"方式": "同事", "公开度": "同事知道", "关系阶段": "暧昧中", "当前状态": "升温中", "见面次数": "6", "认识时间": "2个月"}	认识(6月) → 频繁一起吃饭(7月) → 关键事件:主动送生日礼物(8月) → 现在	聊天记录 2 个月、朋友圈	信息还不够，缺男方社交圈的交叉验证。已做单次咨询，观察是否需要转陪跑。	2026-08-21 04:19:32.334386+00	2026-08-21 04:19:32.334386+00	manual	\N	\N	\N	\N	\N	{}	\N	\N
4	C-04 圆圆	B	profiled	小红书私信	\N	{"城市": "成都", "年龄": 24, "职业": "设计", "婚恋史": "无", "当前诉求": "分手挽回", "收入区间": "10–15w"}	{"家庭": "本地", "年龄": 25, "职业": "销售", "婚恋史": "一段", "社会关系": "广", "经济状况": "一般"}	{"方式": "同学", "公开度": "公开过", "关系阶段": "已分手", "当前状态": "断联 2 周", "见面次数": "多", "认识时间": "1年"}	在一起(去年9月) → 稳定期 → 矛盾:异地(今年3月) → 分手(7月) → 断联至今	聊天记录全量、共同好友信息	付费能力弱但问题真实，建议先走标准化产品（挽回课程 + 单次咨询）。	2026-08-21 04:19:32.337993+00	2026-08-21 04:19:32.337993+00	manual	\N	\N	\N	\N	\N	{}	\N	\N
5	C-05 阿May	A	wechat	直播连麦	\N	{"城市": "深圳", "年龄": 31, "职业": "医生", "婚恋史": "一段", "当前诉求": "判断是否继续投入", "收入区间": "40–60w"}	{"家庭": "本地/有弟", "年龄": 35, "职业": "公务员", "婚恋史": "离异", "社会关系": "稳定", "经济状况": "中上"}	{"方式": "相亲", "公开度": "双方家长知道", "关系阶段": "确定中", "当前状态": "推进中但有疑虑", "见面次数": "9", "认识时间": "4个月"}	相亲(4月) → 稳定见面(5-7月) → 关键事件:见家长(8月) → 现在	聊天记录 1 个月、相亲背景资料	刚加微信，档案还没补齐 —— 缺时间线细节和男方社交关系。	2026-08-21 04:19:32.339394+00	2026-08-21 04:19:32.339394+00	manual	\N	\N	\N	\N	\N	{}	\N	\N
6	C-06 团子	C	lost	小红书私信	\N	{"城市": "—", "年龄": 22, "职业": "学生", "婚恋史": "无", "当前诉求": "泛情绪倾诉", "收入区间": "无"}	{}	{"关系阶段": "无明确对象"}	—	无	无明确对象、白嫖倾向明显（PDF 04 的 C 级特征）。已转内容教育，标记流失。	2026-08-21 04:19:32.340935+00	2026-08-21 04:19:32.340935+00	manual	\N	\N	\N	\N	\N	{}	\N	\N
3	C-03 Nana	S	renewed	转介绍	\N	{"城市": "34", "年龄": 34, "职业": "34", "婚恋史": "离异无孩", "当前诉求": "80w+", "收入区间": "80w+"}	{"家庭": "—", "年龄": "—", "职业": "—", "婚恋史": "—", "社会关系": "—", "经济状况": "—"}	{"方式": "—", "公开度": "—", "关系阶段": "—", "当前状态": "—", "见面次数": "—", "认识时间": "—"}	无单一对象。目标是建立自己的识人和择偶判断标准。	过往三段关系的复盘材料	成员改的备注	2026-08-21 04:19:32.335948+00	2026-08-24 04:02:20.485409+00	manual	\N	\N	\N	\N	\N	{}	\N	\N
112	智能导入全路径自测-1787555517124	\N	lead	智能导入	1	{}	{}	{}		\N	测试	2026-08-24 07:11:57.1553+00	2026-08-24 07:11:57.1553+00	manual		smart:615027849b8c2336e311:4	\N	\N	\N	{}	\N	2026-08-24 07:11:57.282248+00
113	Tech2联调测试（无真实客户）	C	lead	\N	\N	{}	{}	{"记录类型": "系统接口联调", "真实客户数据": "无"}	\N	\N	\N	2026-08-25 03:00:55.041521+00	2026-08-25 03:00:55.543021+00	tech2	\N	tech2-integration-smoke-v1	仅用于验证技术2与 IdeaHub 的客户资料和情况分析接入，无真实客户数据。	仅用于验证 aiUser 独立字段，无真实用户资料。	2026-08-25 03:00:55.543021+00	{}	tech2-integration-smoke-v1	\N
\.


--
-- Data for Name: demands; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.demands (id, title, quote, scene, real_goal, note, source_type, source_url, source_ref, created_by, created_at, updated_at, deleted_at) FROM stdin;
29	智能导入全路径自测-1787555517124-需求	测试原话		测试目标		manual		smart:615027849b8c2336e311:1	1	2026-08-24 07:11:57.1553+00	2026-08-24 07:11:57.1553+00	2026-08-24 07:11:57.246263+00
30	直播线索跟进提醒	最近直播线索不少，但客服跟进慢，希望增加客户提醒机制。	直播产生客户线索后，由客服进行后续跟进。	让客服及时收到直播线索提醒并尽快跟进，减少线索因响应延迟而流失。	反馈人：张总。当前线索量较多，客服跟进速度不足。	manual		smart:77b523d91b3a9553dc11:0	10	2026-08-24 09:45:39.775253+00	2026-08-24 09:45:39.775253+00	\N
\.


--
-- Data for Name: entity_tags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.entity_tags (entity, entity_id, tag_id, created_at) FROM stdin;
\.


--
-- Data for Name: idea_activities; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.idea_activities (id, idea_id, actor_id, action, from_status, to_status, reason, created_at) FROM stdin;
2	2	1	created	\N	pending	\N	2026-08-20 16:43:48.103157+00
4	2	1	status_changed	pending	adopted	\N	2026-08-20 16:44:09.933077+00
11	7	1	created	\N	pending	\N	2026-08-20 17:10:31.158109+00
12	8	1	created	\N	pending	\N	2026-08-20 17:10:31.193847+00
13	9	1	created	\N	pending	\N	2026-08-20 17:10:31.207397+00
14	10	1	created	\N	pending	\N	2026-08-20 17:10:31.221595+00
15	11	1	created	\N	pending	\N	2026-08-20 17:10:31.235678+00
16	12	1	created	\N	pending	\N	2026-08-20 17:10:31.251264+00
17	11	1	status_changed	pending	adopted	\N	2026-08-20 17:13:03.236155+00
18	13	3	created	\N	pending	\N	2026-08-21 01:10:27.362773+00
19	14	3	created	\N	pending	\N	2026-08-21 01:10:34.053102+00
20	14	3	status_changed	pending	rejected	aaaaa	2026-08-21 01:13:05.841721+00
21	12	3	status_changed	pending	rejected	aaaaa	2026-08-21 01:46:07.398936+00
22	13	3	status_changed	pending	adopted	\N	2026-08-21 01:47:10.83503+00
27	13	1	progress_changed	\N	\N	60%	2026-08-21 02:41:11.032772+00
30	11	1	progress_changed	\N	\N	35%	2026-08-21 02:47:00.788735+00
31	16	3	created	\N	pending	\N	2026-08-21 02:47:55.862311+00
32	17	3	created	\N	pending	\N	2026-08-21 02:48:23.68218+00
33	16	3	status_changed	pending	adopted	\N	2026-08-21 02:49:28.313962+00
34	16	3	progress_changed	\N	\N	10%	2026-08-21 02:49:43.652906+00
35	16	3	progress_changed	\N	\N	100%	2026-08-21 02:50:23.118701+00
36	16	3	progress_changed	\N	\N	100%	2026-08-21 02:50:38.385297+00
37	18	3	created	\N	pending	\N	2026-08-21 02:51:52.710803+00
38	19	7	created	\N	pending	\N	2026-08-21 05:10:20.135443+00
39	19	7	status_changed	pending	adopted	\N	2026-08-21 05:10:35.270938+00
40	20	7	created	\N	pending	\N	2026-08-21 05:12:10.589465+00
41	21	7	created	\N	pending	\N	2026-08-21 06:11:11.538852+00
42	21	7	status_changed	pending	adopted	\N	2026-08-21 06:11:26.233451+00
43	19	7	progress_changed	\N	\N	0%	2026-08-21 06:26:33.943554+00
44	19	7	owner_changed	\N	\N	李年	2026-08-21 06:26:33.947014+00
45	21	1	progress_changed	\N	\N	50%	2026-08-21 06:31:14.692466+00
46	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:31:14.697584+00
47	21	1	progress_changed	\N	\N	0%	2026-08-21 06:31:18.651183+00
48	21	1	owner_changed	\N	\N	李年	2026-08-21 06:31:18.655459+00
49	21	1	progress_changed	\N	\N	50%	2026-08-21 06:32:17.972654+00
50	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:32:17.975746+00
51	21	1	progress_changed	\N	\N	0%	2026-08-21 06:32:21.915672+00
52	21	1	owner_changed	\N	\N	李年	2026-08-21 06:32:21.918021+00
53	21	1	progress_changed	\N	\N	50%	2026-08-21 06:44:04.962012+00
54	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:44:04.964967+00
55	21	1	progress_changed	\N	\N	0%	2026-08-21 06:44:08.870493+00
56	21	1	owner_changed	\N	\N	李年	2026-08-21 06:44:08.874258+00
57	21	1	progress_changed	\N	\N	50%	2026-08-21 06:45:07.101184+00
58	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:45:07.106908+00
59	21	1	progress_changed	\N	\N	0%	2026-08-21 06:45:11.11562+00
60	21	1	owner_changed	\N	\N	李年	2026-08-21 06:45:11.119038+00
61	21	1	progress_changed	\N	\N	50%	2026-08-21 06:47:17.100874+00
62	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:47:17.104818+00
63	21	1	progress_changed	\N	\N	0%	2026-08-21 06:47:21.092269+00
64	21	1	owner_changed	\N	\N	李年	2026-08-21 06:47:21.097803+00
65	21	1	progress_changed	\N	\N	50%	2026-08-21 06:48:23.171085+00
66	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:48:23.173955+00
67	21	1	progress_changed	\N	\N	0%	2026-08-21 06:48:27.128186+00
68	21	1	owner_changed	\N	\N	李年	2026-08-21 06:48:27.132908+00
69	21	1	progress_changed	\N	\N	50%	2026-08-21 06:50:30.822794+00
70	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:50:30.82659+00
71	21	1	progress_changed	\N	\N	0%	2026-08-21 06:50:34.819013+00
72	21	1	owner_changed	\N	\N	李年	2026-08-21 06:50:34.823486+00
73	21	1	progress_changed	\N	\N	50%	2026-08-21 06:51:41.800644+00
74	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:51:41.804108+00
75	21	1	progress_changed	\N	\N	0%	2026-08-21 06:51:45.759497+00
76	21	1	owner_changed	\N	\N	李年	2026-08-21 06:51:45.762845+00
77	21	1	progress_changed	\N	\N	50%	2026-08-21 06:54:05.751568+00
78	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:54:05.756739+00
79	21	1	progress_changed	\N	\N	0%	2026-08-21 06:54:09.690037+00
80	21	1	owner_changed	\N	\N	李年	2026-08-21 06:54:09.69255+00
81	21	1	progress_changed	\N	\N	50%	2026-08-21 06:55:15.653753+00
82	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:55:15.657557+00
83	21	1	progress_changed	\N	\N	0%	2026-08-21 06:55:19.592716+00
84	21	1	owner_changed	\N	\N	李年	2026-08-21 06:55:19.596874+00
85	21	1	progress_changed	\N	\N	50%	2026-08-21 06:57:22.978836+00
86	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:57:22.982785+00
87	21	1	progress_changed	\N	\N	0%	2026-08-21 06:57:26.943104+00
88	21	1	owner_changed	\N	\N	李年	2026-08-21 06:57:26.948015+00
89	21	1	progress_changed	\N	\N	50%	2026-08-21 06:58:31.724507+00
90	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 06:58:31.728032+00
91	21	1	progress_changed	\N	\N	0%	2026-08-21 06:58:35.672317+00
92	21	1	owner_changed	\N	\N	李年	2026-08-21 06:58:35.677451+00
93	21	1	progress_changed	\N	\N	50%	2026-08-21 07:33:34.621319+00
94	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 07:33:34.625583+00
95	21	1	progress_changed	\N	\N	0%	2026-08-21 07:33:38.631767+00
96	21	1	owner_changed	\N	\N	李年	2026-08-21 07:33:38.634822+00
97	21	1	progress_changed	\N	\N	50%	2026-08-21 07:34:45.146002+00
98	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 07:34:45.148719+00
99	21	1	progress_changed	\N	\N	0%	2026-08-21 07:34:49.368071+00
100	21	1	owner_changed	\N	\N	李年	2026-08-21 07:34:49.371718+00
101	21	1	progress_changed	\N	\N	50%	2026-08-21 07:39:12.716724+00
102	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 07:39:12.720976+00
103	21	1	progress_changed	\N	\N	0%	2026-08-21 07:39:16.749628+00
104	21	1	owner_changed	\N	\N	李年	2026-08-21 07:39:16.755295+00
105	21	1	progress_changed	\N	\N	50%	2026-08-21 07:40:26.162825+00
106	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 07:40:26.167208+00
107	21	1	progress_changed	\N	\N	0%	2026-08-21 07:40:30.289657+00
108	21	1	owner_changed	\N	\N	李年	2026-08-21 07:40:30.295026+00
109	21	1	progress_changed	\N	\N	50%	2026-08-21 08:17:56.129629+00
110	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 08:17:56.132911+00
111	21	1	progress_changed	\N	\N	0%	2026-08-21 08:18:00.154741+00
112	21	1	owner_changed	\N	\N	李年	2026-08-21 08:18:00.159114+00
113	21	1	progress_changed	\N	\N	50%	2026-08-21 08:19:09.395413+00
114	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 08:19:09.400097+00
115	21	1	progress_changed	\N	\N	0%	2026-08-21 08:19:13.631406+00
116	21	1	owner_changed	\N	\N	李年	2026-08-21 08:19:13.638873+00
117	20	1	status_changed	pending	rejected	不想	2026-08-21 08:29:43.932296+00
118	21	1	progress_changed	\N	\N	50%	2026-08-21 08:32:05.416869+00
119	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 08:32:05.422163+00
120	21	1	progress_changed	\N	\N	0%	2026-08-21 08:32:09.606626+00
121	21	1	owner_changed	\N	\N	李年	2026-08-21 08:32:09.61186+00
122	21	1	progress_changed	\N	\N	50%	2026-08-21 08:33:18.520451+00
123	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 08:33:18.525697+00
124	21	1	progress_changed	\N	\N	0%	2026-08-21 08:33:22.754682+00
125	21	1	owner_changed	\N	\N	李年	2026-08-21 08:33:22.757588+00
126	21	1	progress_changed	\N	\N	50%	2026-08-21 08:42:42.138728+00
127	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 08:42:42.144665+00
128	21	1	progress_changed	\N	\N	0%	2026-08-21 08:42:46.398469+00
129	21	1	owner_changed	\N	\N	李年	2026-08-21 08:42:46.402399+00
130	21	1	progress_changed	\N	\N	50%	2026-08-21 08:44:00.671003+00
131	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 08:44:00.675288+00
132	21	1	progress_changed	\N	\N	0%	2026-08-21 08:44:04.77013+00
133	21	1	owner_changed	\N	\N	李年	2026-08-21 08:44:04.776071+00
134	21	1	progress_changed	\N	\N	50%	2026-08-21 08:54:12.622561+00
135	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 08:54:12.626869+00
136	21	1	progress_changed	\N	\N	0%	2026-08-21 08:54:16.655488+00
137	21	1	owner_changed	\N	\N	李年	2026-08-21 08:54:16.659108+00
138	21	1	progress_changed	\N	\N	50%	2026-08-21 08:55:25.625478+00
139	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 08:55:25.628891+00
140	21	1	progress_changed	\N	\N	0%	2026-08-21 08:55:29.717401+00
141	21	1	owner_changed	\N	\N	李年	2026-08-21 08:55:29.72073+00
142	21	1	progress_changed	\N	\N	50%	2026-08-21 09:27:51.9077+00
143	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 09:27:51.91111+00
144	21	1	progress_changed	\N	\N	0%	2026-08-21 09:27:55.93151+00
145	21	1	owner_changed	\N	\N	李年	2026-08-21 09:27:55.934278+00
146	21	1	progress_changed	\N	\N	50%	2026-08-21 09:29:03.126718+00
147	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 09:29:03.133414+00
148	21	1	progress_changed	\N	\N	0%	2026-08-21 09:29:07.159252+00
149	21	1	owner_changed	\N	\N	李年	2026-08-21 09:29:07.164815+00
150	21	1	progress_changed	\N	\N	50%	2026-08-21 10:03:24.474374+00
151	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 10:03:24.478366+00
152	21	1	progress_changed	\N	\N	0%	2026-08-21 10:03:28.621458+00
153	21	1	owner_changed	\N	\N	李年	2026-08-21 10:03:28.628253+00
154	21	1	progress_changed	\N	\N	50%	2026-08-21 10:04:47.859245+00
155	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 10:04:47.862704+00
156	21	1	progress_changed	\N	\N	0%	2026-08-21 10:04:51.836005+00
157	21	1	owner_changed	\N	\N	李年	2026-08-21 10:04:51.839583+00
158	21	1	progress_changed	\N	\N	50%	2026-08-21 10:06:46.933616+00
159	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 10:06:46.935919+00
160	21	1	progress_changed	\N	\N	0%	2026-08-21 10:06:50.928637+00
161	21	1	owner_changed	\N	\N	李年	2026-08-21 10:06:50.931226+00
162	21	1	progress_changed	\N	\N	50%	2026-08-21 10:07:58.748725+00
163	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 10:07:58.751908+00
164	21	1	progress_changed	\N	\N	0%	2026-08-21 10:08:02.765809+00
165	21	1	owner_changed	\N	\N	李年	2026-08-21 10:08:02.768719+00
166	21	1	progress_changed	\N	\N	50%	2026-08-21 12:32:01.683893+00
167	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 12:32:01.68652+00
168	21	1	progress_changed	\N	\N	0%	2026-08-21 12:32:05.621291+00
169	21	1	owner_changed	\N	\N	李年	2026-08-21 12:32:05.625259+00
170	21	1	progress_changed	\N	\N	50%	2026-08-21 12:33:11.319179+00
171	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 12:33:11.322859+00
172	21	1	progress_changed	\N	\N	0%	2026-08-21 12:33:15.375378+00
173	21	1	owner_changed	\N	\N	李年	2026-08-21 12:33:15.378976+00
174	21	1	progress_changed	\N	\N	50%	2026-08-21 12:42:29.244162+00
175	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 12:42:29.248239+00
176	21	1	progress_changed	\N	\N	0%	2026-08-21 12:42:33.177121+00
177	21	1	owner_changed	\N	\N	李年	2026-08-21 12:42:33.178728+00
178	21	1	progress_changed	\N	\N	50%	2026-08-21 12:43:50.9236+00
179	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 12:43:50.926341+00
180	21	1	progress_changed	\N	\N	0%	2026-08-21 12:43:54.876621+00
181	21	1	owner_changed	\N	\N	李年	2026-08-21 12:43:54.879072+00
182	21	1	progress_changed	\N	\N	50%	2026-08-21 13:42:12.231067+00
183	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 13:42:12.234986+00
184	21	1	progress_changed	\N	\N	0%	2026-08-21 13:42:16.131452+00
185	21	1	owner_changed	\N	\N	李年	2026-08-21 13:42:16.135068+00
186	21	1	progress_changed	\N	\N	50%	2026-08-21 13:43:35.916+00
187	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 13:43:35.919965+00
188	21	1	progress_changed	\N	\N	0%	2026-08-21 13:43:39.776025+00
189	21	1	owner_changed	\N	\N	李年	2026-08-21 13:43:39.779297+00
190	21	1	progress_changed	\N	\N	50%	2026-08-21 14:18:06.195726+00
191	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 14:18:06.200211+00
192	21	1	progress_changed	\N	\N	0%	2026-08-21 14:18:10.096081+00
193	21	1	owner_changed	\N	\N	李年	2026-08-21 14:18:10.098423+00
194	21	1	progress_changed	\N	\N	50%	2026-08-21 14:19:27.147392+00
195	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 14:19:27.155658+00
196	21	1	progress_changed	\N	\N	0%	2026-08-21 14:19:31.120855+00
197	21	1	owner_changed	\N	\N	李年	2026-08-21 14:19:31.124694+00
198	21	1	progress_changed	\N	\N	50%	2026-08-21 14:21:28.624153+00
199	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 14:21:28.630115+00
200	21	1	progress_changed	\N	\N	0%	2026-08-21 14:21:32.493056+00
201	21	1	owner_changed	\N	\N	李年	2026-08-21 14:21:32.49726+00
202	21	1	progress_changed	\N	\N	50%	2026-08-21 14:22:51.119687+00
203	21	1	owner_changed	\N	\N	华俊杰	2026-08-21 14:22:51.124082+00
204	21	1	progress_changed	\N	\N	0%	2026-08-21 14:22:55.073222+00
205	21	1	owner_changed	\N	\N	李年	2026-08-21 14:22:55.079563+00
216	28	1	created	\N	pending	\N	2026-08-24 07:11:28.935267+00
217	29	1	created	\N	pending	\N	2026-08-24 07:11:57.1553+00
218	30	10	created	\N	pending	\N	2026-08-24 09:45:39.775253+00
\.


--
-- Data for Name: idea_comments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.idea_comments (id, idea_id, user_id, parent_id, body, created_at, is_anonymous) FROM stdin;
1	2	1	\N	不错i	2026-08-20 16:44:02.580053+00	f
4	13	3	\N	a	2026-08-21 01:47:29.356769+00	t
5	13	3	\N	a	2026-08-21 01:47:35.592301+00	f
6	10	1	\N	测试	2026-08-21 02:04:01.385518+00	f
7	8	1	\N	测试	2026-08-21 02:12:04.516223+00	f
8	8	1	\N	测试	2026-08-21 02:12:07.671735+00	t
9	13	1	\N	测试	2026-08-21 02:12:25.029227+00	f
10	16	3	\N	aaa	2026-08-21 02:48:57.633358+00	f
11	16	3	\N	aa	2026-08-21 02:49:02.163679+00	t
12	16	3	\N	aa	2026-08-21 02:49:50.213575+00	f
\.


--
-- Data for Name: idea_votes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.idea_votes (idea_id, user_id, created_at) FROM stdin;
2	1	2026-08-20 16:44:23.365851+00
12	3	2026-08-21 01:45:51.703377+00
10	3	2026-08-21 01:45:55.958574+00
13	3	2026-08-21 01:47:41.693809+00
13	1	2026-08-21 02:12:26.663137+00
10	1	2026-08-21 02:12:34.699823+00
11	1	2026-08-21 02:46:58.485099+00
16	3	2026-08-21 02:49:07.182019+00
7	7	2026-08-21 05:10:09.606036+00
17	1	2026-08-21 08:29:27.240106+00
18	1	2026-08-21 08:29:28.905559+00
9	1	2026-08-22 02:17:55.378265+00
7	1	2026-08-24 08:59:20.530318+00
\.


--
-- Data for Name: ideas; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ideas (id, code, title, content, category, tags, status, author_id, is_anonymous, vote_count, comment_count, view_count, hot_score, owner_id, adopted_at, adopted_by, progress, doc_url, created_at, updated_at, source_type, source_url, source_ref, deleted_at, promoted_at) FROM stdin;
11	IDEA-2026-0035	茶水间换一台好点的咖啡机	现在这台每天要坏一次，排队的时间比喝的时间长。	其他	{福利}	adopted	1	f	2	0	5	1.3445208	1	2026-08-20 17:13:03.236155+00	1	35	\N	2026-08-20 17:10:31.233387+00	2026-08-21 02:47:00.787142+00	manual	\N	\N	\N	2026-08-20 17:13:03.236155+00
2	IDEA-2026-0033	测试	测试士大夫地方萨芬啊	其他	{测试}	adopted	1	f	1	1	5	1.4038849	1	2026-08-20 16:44:09.933077+00	1	0	\N	2026-08-20 16:43:48.094505+00	2026-08-20 16:44:23.365851+00	manual	\N	\N	2026-08-24 06:14:44.691725+00	2026-08-20 16:44:09.933077+00
10	\N	新人入职清单线上化	现在靠老员工口口相传，每个人漏的东西都不一样。做成一张能勾选的清单，第一天该干什么一目了然。	流程	{入职}	pending	1	f	4	1	10	0.57874644	\N	\N	\N	0	\N	2026-08-20 17:10:31.219804+00	2026-08-21 02:12:34.699823+00	manual	\N	\N	\N	\N
9	\N	客户案例做成短视频	文字案例没人看完。同样的内容剪成 90 秒的短视频，销售拿去发朋友圈的转化会高得多。	运营	{内容}	pending	1	f	5	1	4	0.6944956	\N	\N	\N	0	\N	2026-08-20 17:10:31.205796+00	2026-08-22 02:17:55.378265+00	manual	\N	\N	\N	\N
21	IDEA-2026-0039	厕所	厕所	产品	{}	adopted	7	f	0	0	163	0.35355338	7	2026-08-21 06:11:26.233451+00	7	0	\N	2026-08-21 06:11:11.527978+00	2026-08-21 14:22:55.070242+00	manual	\N	\N	\N	2026-08-21 06:11:26.233451+00
19	IDEA-2026-0038	分割成	法国很多方面	产品	{}	adopted	7	f	0	0	7	0.35355338	7	2026-08-21 05:10:35.270938+00	7	0	\N	2026-08-21 05:10:20.129387+00	2026-08-21 06:26:33.940792+00	manual	\N	\N	\N	2026-08-21 05:10:35.270938+00
13	IDEA-2026-0036	aaaa	a	技术	{}	adopted	3	f	2	3	17	2.739506	3	2026-08-21 01:47:10.83503+00	3	60	\N	2026-08-21 01:10:27.355954+00	2026-08-21 02:41:11.02019+00	manual	\N	\N	\N	2026-08-21 01:47:10.83503+00
16	IDEA-2026-0037	xxxx	x	运营	{}	adopted	3	f	1	3	17	2.1192162	3	2026-08-21 02:49:28.313962+00	3	100	http://127.0.0.1:5000/	2026-08-21 02:47:55.855369+00	2026-08-21 02:50:38.383839+00	manual	\N	\N	\N	2026-08-21 02:49:28.313962+00
28	\N	智能导入接口自测（可删除）	验证统一写入与幂等处理。	技术	{自动化}	pending	1	f	0	0	0	0.18325269	\N	\N	\N	0	\N	2026-08-24 07:11:28.935267+00	2026-08-24 07:11:28.935267+00	manual		smart:a31f5c8ddac7f8e1ea83:0	2026-08-24 07:11:28.994108+00	\N
18	\N	1	1	产品	{}	pending	3	t	1	0	2	0.19063321	\N	\N	\N	0	\N	2026-08-21 02:51:52.707932+00	2026-08-21 08:29:28.905559+00	manual	\N	\N	2026-08-24 08:59:34.167813+00	\N
30	\N	测试企业微信线索通知	通过企业微信向客服发送直播线索通知，验证能否提升线索跟进及时性。计划下周先进行测试。	产品	{企业微信,通知机制,方案测试}	pending	10	f	0	0	3	0.1931752	\N	\N	\N	0	\N	2026-08-24 09:45:39.775253+00	2026-08-24 09:45:39.775253+00	manual		smart:77b523d91b3a9553dc11:1	\N	\N
12	\N	搜索支持拼音首字母	找同事和找文档都得打全名，打 zwj 就能出「张伟杰」会快很多。	产品	{搜索,体验}	rejected	1	f	1	0	1	0.058042575	\N	\N	\N	0	\N	2026-08-20 17:10:31.248907+00	2026-08-21 01:46:07.398936+00	manual	\N	\N	\N	\N
14	\N	a	a	产品	{}	rejected	3	t	0	0	5	0.2414722	\N	\N	\N	0	\N	2026-08-21 01:10:34.03293+00	2026-08-21 01:45:17.803511+00	manual	\N	\N	\N	\N
7	\N	把周报改成自动生成	从任务系统里抓本周动态，自动拼一份初稿，人只需要改两句就能发。现在每周五下午全公司都在写周报，这段时间加起来不少。	产品	{效率,自动化}	pending	1	f	11	6	52	1.6783643	\N	\N	\N	0	\N	2026-08-20 17:10:31.139742+00	2026-08-24 08:59:20.530318+00	manual	\N	\N	\N	\N
8	\N	给构建加个缓存层	CI 每次都从零装依赖，一次要六分多钟。加一层缓存能压到一分半以内，改一行代码的验证成本会低很多。	技术	{CI,构建}	pending	1	f	6	5	8	1.0417434	\N	\N	\N	0	\N	2026-08-20 17:10:31.191758+00	2026-08-24 02:28:26.910113+00	manual	\N	\N	\N	\N
29	\N	智能导入全路径自测-1787555517124-灵感	测试	技术	{}	pending	1	f	0	0	0	0.18328166	\N	\N	\N	0	\N	2026-08-24 07:11:57.1553+00	2026-08-24 07:11:57.1553+00	manual		smart:615027849b8c2336e311:0	2026-08-24 07:11:57.231381+00	\N
17	\N	xx	xx	其他	{}	pending	3	f	1	0	7	0.1905231	\N	\N	\N	0	\N	2026-08-21 02:48:23.667519+00	2026-08-21 08:29:27.240106+00	manual	\N	\N	2026-08-24 08:59:31.341837+00	\N
20	\N	重返香港v范德萨	第三方	产品	{}	rejected	7	f	0	0	2	0.3203421	\N	\N	\N	0	\N	2026-08-21 05:12:10.583512+00	2026-08-21 08:29:43.932296+00	manual	\N	\N	\N	\N
\.


--
-- Data for Name: links; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.links (id, from_entity, from_id, to_entity, to_id, note, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notifications (id, user_id, actor_id, kind, title, body, board, ref_id, read_at, created_at) FROM stdin;
3	1	7	report_assigned	李年 提交了「111」等你审核	\N	reports	3	2026-08-21 07:40:31.752723+00	2026-08-21 07:40:06.716299+00
4	7	1	report_feedback	华俊杰 反馈了你的「111」	可以看见不错，下次好好做，给你涨薪	reports	3	2026-08-21 07:41:14.968868+00	2026-08-21 07:40:58.282095+00
5	4	1	report_assigned	华俊杰 提交了「测试」等你审核	\N	reports	4	2026-08-21 07:52:51.005888+00	2026-08-21 07:52:18.430887+00
7	7	11	report_assigned	李敏 提交了「情感赛道」等你审核	\N	reports	5	2026-08-21 07:59:39.631077+00	2026-08-21 07:59:20.110319+00
6	1	4	report_feedback	朱涛 反馈了你的「测试」	111111	reports	4	2026-08-21 08:03:46.71388+00	2026-08-21 07:53:24.173705+00
9	4	7	report_assigned	李年 提交了「表格」等你审核	\N	reports	15	\N	2026-08-24 07:53:08.124762+00
10	4	10	report_assigned	杨池 提交了「表格」等你审核	\N	reports	16	\N	2026-08-24 09:31:14.873002+00
11	4	7	report_assigned	李年 提交了「表格」等你审核	\N	reports	17	\N	2026-08-25 06:32:15.964824+00
12	7	4	report_feedback	朱涛 反馈了你的「表格」	1	reports	17	\N	2026-08-25 07:34:13.505636+00
14	7	4	report_feedback	朱涛 反馈了你的「表格」	1	reports	15	\N	2026-08-25 07:37:36.966146+00
16	1	7	report_assigned	李年 提交了「情感赛道」等你审核	\N	reports	19	2026-08-25 08:28:05.711786+00	2026-08-25 08:27:16.803369+00
13	10	4	report_feedback	朱涛 反馈了你的「表格」	多找作品高收藏 500+，小于3000粉丝量的作品	reports	16	2026-08-25 08:41:14.559615+00	2026-08-25 07:37:28.203036+00
15	1	\N	report_assigned	上传自测（用完即删） 提交了「上传自测（用完即删）」等你审核	\N	reports	18	2026-08-25 08:48:10.417847+00	2026-08-25 08:14:21.505019+00
17	7	1	report_assigned	华俊杰 提交了「测试」等你审核	\N	reports	20	2026-08-25 08:51:26.223862+00	2026-08-25 08:51:08.366498+00
18	1	\N	report_assigned	翻页自测（用完即删） 提交了「翻页自测·单图（用完即删）」等你审核	\N	reports	21	2026-08-25 09:09:23.55237+00	2026-08-25 08:51:33.960174+00
19	4	10	report_assigned	杨池 提交了「作品」等你审核	\N	reports	22	\N	2026-08-25 09:27:41.490462+00
20	4	10	report_assigned	杨池 提交了「表格」等你审核	\N	reports	23	\N	2026-08-25 09:28:31.954217+00
\.


--
-- Data for Name: playbook_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.playbook_items (id, board, section, label, title, body, meta, sort, created_by, created_at, updated_at, deleted_at) FROM stdin;
1	sales	tier	S 级	S 级：明确对象 + 高紧迫度 + 高支付能力 + 高价值关系	建议承接：直接进入单次咨询，重点转陪跑。	{"优先级": "最高"}	10	\N	2026-08-21 04:19:32.293135+00	2026-08-21 04:19:32.293135+00	\N
2	sales	tier	A 级	A 级：明确问题 + 中高支付能力 + 配合度高	建议承接：正常推进咨询 / 陪跑。	{"优先级": "高"}	20	\N	2026-08-21 04:19:32.295217+00	2026-08-21 04:19:32.295217+00	\N
3	sales	tier	B 级	B 级：问题真实但付费弱，或需求较标准化	建议承接：单次咨询 / 课程 / 资料产品。	{"优先级": "中"}	30	\N	2026-08-21 04:19:32.296227+00	2026-08-21 04:19:32.296227+00	\N
4	sales	tier	C 级	C 级：泛情绪、无明确对象、白嫖倾向明显	建议承接：内容教育 / 低价标准化产品。	{"优先级": "低"}	40	\N	2026-08-21 04:19:32.29747+00	2026-08-21 04:19:32.29747+00	\N
5	sales	filter	真实问题	是否有明确对象	是否处于具体关系节点；是否能提供关键事实。	{}	10	\N	2026-08-21 04:19:32.298673+00	2026-08-21 04:19:32.298673+00	\N
6	sales	filter	紧迫度	近期要见面 / 回复 / 决策	刚分手 / 突然降温；关系进入关键现实节点。	{}	20	\N	2026-08-21 04:19:32.299757+00	2026-08-21 04:19:32.299757+00	\N
7	sales	filter	支付可能性	年龄、职业、城市、消费能力	对关系对象价值判断；是否愿意投入时间和资料。	{}	30	\N	2026-08-21 04:19:32.301914+00	2026-08-21 04:19:32.301914+00	\N
8	sales	filter	适配度	问题是否在团队能力范围	是否需要持续执行而非一次答疑；客户是否愿意配合信息收集。	{}	40	\N	2026-08-21 04:19:32.303922+00	2026-08-21 04:19:32.303922+00	\N
9	sales	intake	女方基础信息	年龄、城市、职业、收入区间、婚恋史、当前诉求	作用：判断资源、关系模式、现实约束。	{}	10	\N	2026-08-21 04:19:32.304883+00	2026-08-21 04:19:32.304883+00	\N
10	sales	intake	男方基础信息	年龄、职业、经济状况、家庭、婚恋史、社会关系	作用：建立人物与现实匹配画像。	{}	20	\N	2026-08-21 04:19:32.305752+00	2026-08-21 04:19:32.305752+00	\N
11	sales	intake	关系信息	认识时间、方式、见面次数、关系阶段、公开度、当前状态	作用：确定关系所处阶段。	{}	30	\N	2026-08-21 04:19:32.306515+00	2026-08-21 04:19:32.306515+00	\N
12	sales	intake	时间线	认识 → 升温 → 关键事件 → 矛盾 → 变化 → 现在	作用：避免只听主观感受，抓因果节点。	{}	40	\N	2026-08-21 04:19:32.307245+00	2026-08-21 04:19:32.307245+00	\N
13	sales	intake	证据材料	聊天记录、朋友圈、照片、语音、约会情况、现实投入	作用：用行为证据交叉验证陈述。	{}	50	\N	2026-08-21 04:19:32.308091+00	2026-08-21 04:19:32.308091+00	\N
14	sales	script	私信初筛	私信第一目标不是马上成交	而是快速判断：有没有真实问题、问题是否紧迫、有没有支付能力与付费意愿。\n（此处填你们实际在用的开场与追问话术）	{"场景": "私信"}	10	\N	2026-08-21 04:19:32.308981+00	2026-08-21 04:19:32.308981+00	\N
15	sales	script	加微建档	所有咨询师使用统一字段收集信息	避免每个人「自己聊一遍」，提高诊断效率、减少遗漏，并为后续案例数据库做结构化准备。\n内部动作顺序：建立档案 → 补齐关键缺口 → 形成初步假设 → 准备验证问题 → 安排咨询 → 咨询后更新档案。	{"场景": "微信"}	20	\N	2026-08-21 04:19:32.309828+00	2026-08-21 04:19:32.309828+00	\N
16	sales	script	单次咨询	一次完整咨询应输出六类结论	①男方人物画像 ②女方人物画像 ③双方匹配 ④当前关系判断 ⑤策略与验证 ⑥是否转陪跑。	{"场景": "咨询"}	30	\N	2026-08-21 04:19:32.310575+00	2026-08-21 04:19:32.310575+00	\N
17	sales	script	转陪跑	方向可以在咨询里讲清楚	如果真正的难点在于「接下来每一步都要根据反馈重新判断」，就进入陪跑。\n核心指标不是单次咨询毛利，而是「咨询 → 陪跑转化率 + 最终客户结果」。	{"场景": "成交"}	40	\N	2026-08-21 04:19:32.311909+00	2026-08-21 04:19:32.311909+00	\N
18	delivery	product	阶梯 1	免费内容	公域获客，建立判断力标签。	{"指标": "曝光 / 私信率", "类型": "内容"}	10	\N	2026-08-21 04:19:32.312893+00	2026-08-21 04:19:32.312893+00	\N
19	delivery	product	阶梯 2	直播 / 私信	现场证明能力，筛选客资。	{"指标": "连麦率 / 加微率", "类型": "内容"}	20	\N	2026-08-21 04:19:32.313821+00	2026-08-21 04:19:32.313821+00	\N
20	delivery	product	阶梯 3	低价课 / 资料	低门槛承接与教育。	{"指标": "购买率 / 完课率", "类型": "课程"}	30	\N	2026-08-21 04:19:32.314639+00	2026-08-21 04:19:32.314639+00	\N
21	delivery	product	阶梯 4	单次咨询	完成一次完整诊断 + 判断是否值得进入陪跑。	{"指标": "满意度 / 转陪跑率", "类型": "咨询"}	40	\N	2026-08-21 04:19:32.315404+00	2026-08-21 04:19:32.315404+00	\N
22	delivery	product	阶梯 5	关系陪跑（项目型）	追求、暧昧推进、恋爱冲突、挽回、复合；1–3 个月更常见。	{"指标": "结果率 / 客诉率", "类型": "陪跑"}	50	\N	2026-08-21 04:19:32.316197+00	2026-08-21 04:19:32.316197+00	\N
23	delivery	product	阶梯 6	成长陪跑（长期型）	识人、择偶、关系能力、情绪管理、社交圈、长期婚恋策略；3–6 个月甚至更长。	{"指标": "续费率 / LTV", "类型": "陪跑"}	60	\N	2026-08-21 04:19:32.316934+00	2026-08-21 04:19:32.316934+00	\N
24	delivery	product	阶梯 7	高阶课程	关系推进 + 两性博弈，为陪跑预教育。	{"指标": "升级咨询率", "类型": "课程"}	70	\N	2026-08-21 04:19:32.31768+00	2026-08-21 04:19:32.31768+00	\N
25	delivery	product	课程·基础	两性认知	建立男女关系基础认知；低门槛承接与教育。	{"层级": "基础", "类型": "课程"}	110	\N	2026-08-21 04:19:32.319195+00	2026-08-21 04:19:32.319195+00	\N
26	delivery	product	课程·中阶	识人 + 男性需求	提高人物判断与筛选能力；减少咨询中的基础解释。	{"层级": "中阶", "类型": "课程"}	120	\N	2026-08-21 04:19:32.320809+00	2026-08-21 04:19:32.320809+00	\N
27	delivery	product	课程·高阶	关系推进 + 两性博弈	解决真实关系中的策略问题；为陪跑预教育。	{"层级": "高阶", "类型": "课程"}	130	\N	2026-08-21 04:19:32.321691+00	2026-08-21 04:19:32.321691+00	\N
28	delivery	product	课程·实战	案例拆解	训练从信息到判断的推理能力；建立专业权威与高阶用户。	{"层级": "实战", "类型": "课程"}	140	\N	2026-08-21 04:19:32.322511+00	2026-08-21 04:19:32.322511+00	\N
29	delivery	flow	节点 1	目标确认	和客户确认这一期要达成什么、验证标准是什么。	{"负责人": "后端咨询师"}	10	\N	2026-08-21 04:19:32.323299+00	2026-08-21 04:19:32.323299+00	\N
30	delivery	flow	节点 2	阶段判断	判断关系当前所处阶段、卡点和风险。	{"负责人": "后端咨询师"}	20	\N	2026-08-21 04:19:32.324139+00	2026-08-21 04:19:32.324139+00	\N
31	delivery	flow	节点 3	制定策略	短期动作、中期目标、验证节点、升级/撤退条件。	{"负责人": "后端咨询师"}	30	\N	2026-08-21 04:19:32.325055+00	2026-08-21 04:19:32.325055+00	\N
32	delivery	flow	节点 4	客户执行	客户去做，咨询师不代聊 —— 代聊是低价值形态。	{"负责人": "客户"}	40	\N	2026-08-21 04:19:32.325939+00	2026-08-21 04:19:32.325939+00	\N
33	delivery	flow	节点 5	收集反馈	对方反应、关系变化、客户执行偏差。	{"负责人": "后端咨询师"}	50	\N	2026-08-21 04:19:32.326879+00	2026-08-21 04:19:32.326879+00	\N
34	delivery	flow	节点 6	复盘校准	根据反馈动态调整策略。	{"负责人": "后端咨询师"}	60	\N	2026-08-21 04:19:32.327664+00	2026-08-21 04:19:32.327664+00	\N
35	delivery	flow	节点 7	进入下一节点	闭环，回到阶段判断。	{"负责人": "后端咨询师"}	70	\N	2026-08-21 04:19:32.32856+00	2026-08-21 04:19:32.32856+00	\N
36	delivery	flow	交付原则	陪跑的价值必须从「代聊」中脱离	低价值形态：客户问一句咨询师回一句、高度依赖即时在线、可复制性差、容易陷入情绪劳动。\n高价值形态：先判断关系再决定动作、每个关键节点有目标与验证标准、根据反馈动态调整、客户逐渐获得自己的判断能力。	{"负责人": "—"}	80	\N	2026-08-21 04:19:32.330052+00	2026-08-21 04:19:32.330052+00	\N
140	sales	rule	测试	智能导入全路径自测-1787555517124-规则	测试	{"sourceUrl": "", "importedBy": "smart-import"}	0	1	2026-08-24 07:11:57.1553+00	2026-08-24 07:11:57.1553+00	2026-08-24 07:11:57.272671+00
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sessions (id, user_id, created_at, expires_at, user_agent) FROM stdin;
25f58c9e91760056fbe7b119edcbd6784ccf62a0b928c091613265cc7cc28fda	3	2026-08-21 01:09:55.492798+00	2026-09-20 01:09:55.492798+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
5817952f843fe7a151a837e1f93ff8d86b7773034a3bc2ba16d1ed5b1ea64908	1	2026-08-22 01:57:29.848889+00	2026-09-21 01:57:29.848889+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
990e20d8673b54aeee810a3039ff32434bf63e336e926f473a7358637d19ccd6	12	2026-08-22 01:58:20.624966+00	2026-09-21 01:58:20.624966+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
7657f87b6ab7c6c8e0af982b6bab2029df951ec3feec42cce6e3a2331030c44c	3	2026-08-24 02:17:02.741483+00	2026-09-23 02:17:02.741483+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
89a169ddcd5753978e52cfa92cdc74d255f9c3729fe443c42c66338c48bfa4d1	8	2026-08-24 02:19:59.365008+00	2026-09-23 02:19:59.365008+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
d7722dcd9b0f6ea1af42dc2cdfb7cd9322aaf6334cb80479e9df7c30fc283939	11	2026-08-24 02:21:10.670578+00	2026-09-23 02:21:10.670578+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
f7fc32f152d018eae3ebb873700b3dbe3f555a6fe1c8a1cacbfa990fee560e9b	10	2026-08-24 02:28:03.97465+00	2026-09-23 02:28:03.97465+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
f5c117d585f0f2c2ee1a34db6710aebfc75aa87b896ae81774c4c808bd447654	9	2026-08-24 02:30:51.149598+00	2026-09-23 02:30:51.149598+00	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36
7b02d6f9c5ebab849f88a73078e79094dd83b8e40f5ae4597dd600c59fad12eb	7	2026-08-24 02:32:27.33623+00	2026-09-23 02:32:27.33623+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
a931d17326c6dce1fcc3780a62a54573151471fc6c9142c6ef1826e60c30de23	7	2026-08-21 04:53:28.875646+00	2026-09-20 04:53:28.875646+00	Mozilla/5.0 (Linux; Android 15; LGE-AN00 Build/HONORLGE-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Mobile Safari/537.36 XWEB/1500047 MMWEBSDK/20260502 MMWEBID/3154 REV/379ee0b45c94853caaf778fe44cd28565b749bd1 MicroMessenger/8.0.72.3100(0x28004853) WeChat/arm64
99dc530c4e4f06479d76473f802c9ea09fd8e1b731fd3862f6843d24867a8640	7	2026-08-21 05:09:01.483352+00	2026-09-20 05:09:01.483352+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
e26cb03549c0d09fdb22485ea34e018cd025365a425a49f952f5fb3ed291bd4a	8	2026-08-21 06:02:11.828861+00	2026-09-20 06:02:11.828861+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
6d6f96f31c349f6942c4a3956e6ed43fba137e677400e0795789b54403bd0c0e	7	2026-08-24 07:38:56.785377+00	2026-09-23 07:38:56.785377+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 NetType/WIFI MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541c37) XWEB/25364 Flue
b2f37573ea229a209cf53592a3a442c08205ad3e73579adfeb90055c48ff2d9a	7	2026-08-24 07:51:43.691144+00	2026-09-23 07:51:43.691144+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
5f4483541ba868e9622805d3bdbc0e4dcd9da4ff07c63767aea52cb8739322fc	9	2026-08-21 07:21:38.180986+00	2026-09-20 07:21:38.180986+00	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36
c3bc58fef5f019556b7dcb17d3c2dde7668f15b0865e6e700597581827fc8499	10	2026-08-21 07:22:16.066883+00	2026-09-20 07:22:16.066883+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
173f054fb41b12a64797685afac485b5e7412a9306de7ca0d05cea37571e7c68	10	2026-08-21 07:48:35.968229+00	2026-09-20 07:48:35.968229+00	Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.69(0x18004539) NetType/WIFI Language/zh_CN
cd9fddfdc000407d655cccc505aac2821cc1d332c8b2b63123ff30ee14273fbf	11	2026-08-21 07:50:55.69515+00	2026-09-20 07:50:55.69515+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
d634e5de751a0724fc96eb23b3bfa3c7f696ae6069df854be9ba62c30b093b12	4	2026-08-25 07:24:42.142342+00	2026-09-24 07:24:42.142342+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
2f76581ed0b3a64361027d8500b4c7899fc68d1831f59afe04be72b741942a8e	3	2026-08-25 07:48:43.749617+00	2026-09-24 07:48:43.749617+00	Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1
e1692cf1a064282b0a96422d7dc47958817858e0edafd639afbd7b59a5ef6429	3	2026-08-25 08:05:07.157223+00	2026-09-24 08:05:07.157223+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
37a3e716279e23bd271105174435ceb6123061d9c75d5cb14a4cc064e1fe2034	8	2026-08-25 08:42:01.634599+00	2026-09-24 08:42:01.634599+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
\.


--
-- Data for Name: tags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tags (id, kind, name, sort, active, created_at) FROM stdin;
1	relation_stage	暧昧期	10	t	2026-08-24 02:31:56.959081+00
2	relation_stage	热恋期	20	t	2026-08-24 02:31:56.959081+00
3	relation_stage	冷淡期	30	t	2026-08-24 02:31:56.959081+00
4	relation_stage	冷战中	40	t	2026-08-24 02:31:56.959081+00
5	relation_stage	已分手	50	t	2026-08-24 02:31:56.959081+00
6	relation_stage	挽回中	60	t	2026-08-24 02:31:56.959081+00
7	relation_stage	复合后	70	t	2026-08-24 02:31:56.959081+00
8	relation_stage	婚姻中	80	t	2026-08-24 02:31:56.959081+00
9	problem_type	判断对方态度	10	t	2026-08-24 02:31:56.959081+00
10	problem_type	断联	20	t	2026-08-24 02:31:56.959081+00
11	problem_type	冷暴力	30	t	2026-08-24 02:31:56.959081+00
12	problem_type	异地	40	t	2026-08-24 02:31:56.959081+00
13	problem_type	第三者	50	t	2026-08-24 02:31:56.959081+00
14	problem_type	家庭反对	60	t	2026-08-24 02:31:56.959081+00
15	problem_type	沟通冲突	70	t	2026-08-24 02:31:56.959081+00
16	problem_type	推进不动	80	t	2026-08-24 02:31:56.959081+00
17	demand	想复合	10	t	2026-08-24 02:31:56.959081+00
18	demand	想判断要不要继续	20	t	2026-08-24 02:31:56.959081+00
19	demand	想让关系升温	30	t	2026-08-24 02:31:56.959081+00
20	demand	想被重视	40	t	2026-08-24 02:31:56.959081+00
21	demand	想体面退出	50	t	2026-08-24 02:31:56.959081+00
22	demand	想识别对方真实想法	60	t	2026-08-24 02:31:56.959081+00
23	content_type	强判断内容	10	t	2026-08-24 02:31:56.959081+00
24	content_type	识人内容	20	t	2026-08-24 02:31:56.959081+00
25	content_type	案例拆解	30	t	2026-08-24 02:31:56.959081+00
26	content_type	方法论内容	40	t	2026-08-24 02:31:56.959081+00
27	content_type	情绪共鸣	50	t	2026-08-24 02:31:56.959081+00
28	content_type	答疑	60	t	2026-08-24 02:31:56.959081+00
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, name, dept, role, avatar_hue, created_at, username, password_hash, last_login_at) FROM stdin;
4	朱涛	\N	reviewer	\N	2026-08-21 02:53:08.628673+00	ZT123	scrypt$16384$8$1$729731c5d25da09a91af09928a28247e$490d0f6c15ada13e58714dd30bd6ba412ac6c224669c33ae80f72f7e1f1b558e	2026-08-25 07:24:42.140389+00
1	华俊杰	技术部	admin	\N	2026-08-20 16:20:58.388805+00	fafa	scrypt$16384$8$1$b29352dac5f39aa4f878bb80304d4b18$8aa290fb2b067c09c463d7e39d4c98bdf48c21c6479ce572b74f3c7b0f0b4d03	2026-08-22 01:57:29.846921+00
11	李敏	\N	reviewer	\N	2026-08-21 07:50:55.686453+00	李敏	scrypt$16384$8$1$1a350d58d171ea3d76993b4d1e275955$3de4db9da0985e94c5e85970f5c036b5810d819e8b73c7d5a9723225d8905cce	2026-08-24 02:21:10.667228+00
10	杨池	\N	reviewer	\N	2026-08-21 07:22:15.994905+00	杨池	scrypt$16384$8$1$ac914aad522fa20dc071cdc501f90146$7e9a997c2b2daf056de0775af3fde591d18027379dd05ed72bb1d9b807acc7aa	2026-08-24 02:28:03.970715+00
9	杨俊杰	运营	reviewer	\N	2026-08-21 07:21:38.171351+00	杨俊杰	scrypt$16384$8$1$742d62188e40a936f6cda838ef4d31c6$ef71a9d1f96f8b5e688fbcabc839b417c57683d9f5e7ef7348d79db52297cef7	2026-08-24 02:30:51.146294+00
3	李鑫	\N	reviewer	\N	2026-08-21 01:09:55.486818+00	lixin	scrypt$16384$8$1$c70b42bdb7afb7f63c05e30a5fa1d102$623f0903627b08318dcbfd32893d49c4580700e518f81a31924f5a449a024941	2026-08-25 08:05:07.154927+00
13	技术1-测试（系统）	外部系统	member	\N	2026-08-24 02:46:14.568649+00	\N	\N	\N
7	李年	\N	reviewer	\N	2026-08-21 04:53:28.87073+00	李年	scrypt$16384$8$1$9f8324b02c8ac334c48622997806efc9$22fd1f1f1e46cde4dd6f2578ca0d6844a6593ec203c2db5f457b2c2cbad639fc	2026-08-24 07:51:43.68546+00
12	测试	\N	reviewer	\N	2026-08-22 01:58:20.620055+00	测试	scrypt$16384$8$1$cd9981c8fb86140dd475fced8b2f2e6f$591db77d097dd0da6a0adf03f20667649294527b3ecd844314d1ae57e9e4e789	\N
8	刘大增	\N	reviewer	\N	2026-08-21 06:02:11.821697+00	刘大增	scrypt$16384$8$1$cd958f1c038dbd9a1297e9cf97e107a5$4a13803a1a1827108e2995d4651dc77be5f18e8410a14dcf1ce736f682d1ae55	2026-08-25 08:42:01.629454+00
\.


--
-- Data for Name: work_analyses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.work_analyses (work_id, task_id, platform, schema_ver, payload, digest, received_at, cover_file) FROM stdin;
184	45ecbd25bd1f	xiaohongshu	13	{"schema_version":13,"task_id":"45ecbd25bd1f","source_url":"https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787555967&share_id=fab821cb47f44fdc8809fac52b9572c5","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787555967&share_id=fab821cb47f44fdc8809fac52b9572c5","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251422/d0a4f149ff89b3637ba6fe4f5a29abe0/1040g2sg323t3k20m0ae05nenu9pg8u99tt3aqdo!nd_prv_wlteh_jpg_3","duration_seconds":156.4,"width":480,"height":854,"size_bytes":10330816,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true}},"title":"顶级吸引力就是无所谓","description":"情绪管理 职场 野生老板","cover_title":"","cover_title_meta":{},"post_title":"顶级吸引力就是无所谓","post_description":"情绪管理 职场 野生老板","display_title":"顶级吸引力就是无所谓","author":"野生老板商业思维","account":{"name":"野生老板商业思维","profile_url":"https://www.xiaohongshu.com/user/profile/5dd7f2730000000001007929","bio":"2020福布斯U30，地产资管公司创始人\\n强势文化｜国学智慧｜关系运作｜商业思维\\n@野生老板 官方授权","following_count":"204","follower_count":"27555","likes_and_collections_count":"218882"},"page_text":"","text_same_as_description":false,"engagement":{"likes":"1386","collects":"912","comments":"37"},"topics":["人格魅力","吸引力","顶级思维","情绪管理","自我提升","职场","人性弱点","野生老板"],"video_text":"[00:00] 一个人的终极吸引力其实就\\n[00:01] 淡定 这个是道德经里非常\\n[00:03] 反常识的一个真相\\n[00:05] 在道德经第29章\\n[00:06] 他说天下神器不可为也\\n[00:08] 不可执也\\n[00:09] 为者败之\\n[00:10] 执者失之\\n[00:11] 他说的就是你越想用力抓住的东西\\n[00:12] 往往就是你失去的越快\\n[00:14] 而当你彻底放下执念\\n[00:16] 表现的云淡风轻\\n[00:17] 无欲则刚的时候\\n[00:18] 全世界的资源反而会主动的\\n[00:20] 向你靠拢\\n[00:21] 所有那些刻意展示出来的\\n[00:22] 魅力\\n[00:23] 其实都不够高级\\n[00:24] 精致的妆容\\n[00:24] 圆滑的情商\\n[00:25] 各种好听的话术\\n[00:26] 你越是主动\\n[00:27] 越是用力的去输出\\n[00:28] 在真正高手的眼里\\n[00:29] 你就显得越低级和匮乏\\n[00:31] 真正的顶级吸引力来自于你\\n[00:32] 你的冷静\\n[00:33] 你的克制\\n[00:33] 你的淡定\\n[00:34] 而在那个背后的本质\\n[00:35] 它其实是一种无为和不\\n[00:36] 执着的智慧\\n[00:38] 第一个 淡定的本质是不\\n[00:39] 不在乎\\n[00:39] 你不在意身边人的去留\\n[00:40] 不在意别人的眼光和评价\\n[00:42] 不在意一段关系里的得与失\\n[00:44] 你可以去留意一下\\n[00:45] 在关系里面最让人着迷\\n[00:46] 的那个人\\n[00:47] 从来不是那个患得患失\\n[00:49] 随时消息秒回\\n[00:50] 很在意你的人\\n[00:51] 而是那个\\n[00:52] 无论你走也好 留也好\\n[00:53] 回他消息也好 不理他也好\\n[00:54] 他都稳定的像石头一样\\n[00:56] 稳定的可怕的那个人\\n[00:57] 这种人的无所谓\\n[00:58] 他不是装出来的\\n[01:00] 他是真的无所谓\\n[01:01] 本质是我的人生\\n[01:02] 能做到绝对的自给自足\\n[01:03] 绝对的自我圆满\\n[01:05] 这种淡定感\\n[01:06] 他是会给对方带来\\n[01:07] 巨大的心理压迫感的\\n[01:08] 因为他会突然发现\\n[01:10] 在你这里我没有任何筹码\\n[01:11] 可以谈判\\n[01:12] 他不能用离开来威胁你\\n[01:13] 因为你不需要他\\n[01:14] 他也不能用冷暴力来\\n[01:15] 控制你\\n[01:16] 因为你一个人也活得很好\\n[01:17] 他更加不能用这种\\n[01:18] 夸奖赞美来去收买你\\n[01:19] 因为你的自我价值是\\n[01:20] 不需要他来确认的\\n[01:21] 而当一个人在关系里面\\n[01:22] 找不到任何一个可以拿捏你的点\\n[01:24] 那他只剩两条路可以走\\n[01:25] 要么主动靠近你去适应你\\n[01:27] 要么自觉退出离场\\n[01:29] 而你呢这两种结果其实\\n[01:31] 都能接受\\n[01:32] 这个才是真正关系里\\n[01:34] 的主动权并\\n[01:35] 不是你控制了他\\n[01:36] 而是你控制了自己\\n[01:37] 你让自己绝对的冷静克制\\n[01:38] 而他这个时候就不得不\\n[01:40] 跟着你的节奏去走了\\n[01:41] 第二个淡定\\n[01:42] 它是一种内在的状态\\n[01:43] 而不是装出来的冷漠\\n[01:44] 道德经里有一句话形容淡定\\n[01:46] 我觉得非常合适\\n[01:47] 说清静为天下正\\n[01:48] 清静啊才是这个天下万事\\n[01:49] 万物的标准\\n[01:51] 什么叫清静\\n[01:52] 说实话我是不认同现在那些\\n[01:53] 所谓的修行就要打坐冥想\\n[01:55] 与世隔绝的\\n[01:56] 在我看来真正的清静是在这个世俗\\n[01:57] 真正的清净是在这个世俗\\n[01:59] 你的内心依旧是满的\\n[02:01] 依旧是不需要外界来去填补的\\n[02:02] 不需要别人的认可来确认自己的价值\\n[02:04] 也不需要一段关系来证明自己值得被爱\\n[02:06] 不需要任何人来评价定义你\\n[02:09] 当你能够自给自足的时候\\n[02:11] 其实你的状态自然而然就会\\n[02:12] 淡定了\\n[02:13] 这个不是自我压抑出来的伪装\\n[02:14] 是外界根本没有什么东西是可以撼动你的\\n[02:17] 一个内在圆满的人他的淡定一定是\\n[02:19] 由内而外散发出来的状态\\n[02:21] 而不是装出来的外在的冷漠\\n[02:23] 所以顶级的魅力啊\\n[02:24] 他从来不是往自己身上做加法\\n[02:25] 去学什么话术去打扮自己\\n[02:26] 在我看来他是做减法\\n[02:28] 减掉你对外界的需要\\n[02:30] 减掉那些你拼命向外抓取的所有动作\\n[02:32] 你以为的魅力是你展示了什么\\n[02:34] 但真正的魅力其实是你\\n[02:35] 不展示什么","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":3,"chunks_succeeded":3,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":26,"replies_scanned":6,"primary_pages":2,"reply_pages":2,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.214,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T03:50:18.191741+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"以《道德经》为据，阐述顶级吸引力源于淡定、无为和不执着的智慧，而非刻意展示魅力。"},"target_audience":{"label":"针对什么人 / 场景","summary":"关注职场情绪管理、个人魅力提升的成年人，尤其是自称“野生老板”或处于关系博弈中的职场人士。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能困惑于如何提升自身吸引力或处理关系中的主动权，希望获得反直觉的实用心法。"},"content_structure":{"label":"内容怎么展开","summary":"先引用道德经第29章提出核心观点，再分两个层次展开：第一层解释淡定的本质是不在乎，并描述其在关系中的效果；第二层强调淡定是内在状态而非伪装，最后总结魅力是做减法。"},"solution":{"label":"给了什么解决办法","summary":"内容给出明确办法：通过减少对外界的需要、放下执念、实现自我圆满来培养淡定感，从而在关系中掌握主动权。"},"references":{"label":"值得参考什么","summary":"引用《道德经》第29章“天下神器不可为也”及“清静为天下正”等原文。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸制作具体场景案例，如职场谈判、亲密关系中的淡定应用；或对比“刻意魅力”与“淡定魅力”的实操差异。"}},"source_labels":["文字标题","作品描述","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "480×854", "cover": "http://sns-webpic-qc.xhscdn.com/202608251422/d0a4f149ff89b3637ba6fe4f5a29abe0/1040g2sg323t3k20m0ae05nenu9pg8u99tt3aqdo!nd_prv_wlteh_jpg_3", "taskId": "45ecbd25bd1f", "topics": ["人格魅力", "吸引力", "顶级思维", "情绪管理", "自我提升", "职场"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5dd7f2730000000001007929", "name": "野生老板商业思维", "followers": 27555}, "aiModel": "deepseek-v4-flash", "duration": "2分36秒", "platform": "xiaohongshu", "mainTopic": "以《道德经》为据，阐述顶级吸引力源于淡定、无为和不执着的智慧，而非刻意展示魅力。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "1386", "collects": "912", "comments": "37", "likesNum": 1386, "collectsNum": 912, "commentsNum": 37}, "topicCount": 8, "generatedAt": "2026-08-25T03:50:18.191741+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": 26, "transcriptChars": 2118}	2026-08-25 07:15:31.145945+00	8beb7209ed7cae9a3653b0e8142e5f39da032b5d.jpg
174	f90d29b0a27b	xiaohongshu	15	{"schema_version":15,"task_id":"f90d29b0a27b","source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251704/e311ac2f0961f3522764bd2742b83c75/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_dft_wlteh_jpg_3","duration_seconds":296.077,"width":1080,"height":1920,"size_bytes":35337961,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_b64":"（已落地为本地封面文件，原始 200271 字符）"}},"title":"女孩子无聊的本质是生命力的匮乏","description":"","cover_title":"女孩子无趣的本质是生命力的匮乏","cover_title_meta":{"text":"女孩子无趣的本质是生命力的匮乏","confidence":0.939,"font_ratio":1.31,"line_count":2,"lines":[{"text":"女孩子无趣的本质","confidence":0.998},{"text":"生命力的贵乏","confidence":0.88}],"source_image_index":1,"reference_corrected":true,"source":"video_cover"},"post_title":"女孩子无聊的本质是生命力的匮乏","post_description":"","display_title":"女孩子无趣的本质是生命力的匮乏","author":"可可拆爆款","account":{"name":"可可拆爆款","profile_url":"https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1","bio":"👩全网100W➕粉丝\\n🎉你却的不是方法，而是一个带你的人\\n🌲账号定位｜流量卡点｜爆款模板\\n🔗下方进👗","following_count":"1010","follower_count":"122838","likes_and_collections_count":"1149588"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"4万","collects":"3.2万","comments":"648"},"topics":["女孩子","女性智慧","女性成长","生命力","少女心事","girlstalk","本质","人生智慧"],"video_text":"[00:00] 女孩子无趣的本质\\n[00:01] 是生命力的匮乏\\n[00:03] 自己觉得越来越没有意思\\n[00:04] 请把这篇文章仔细看完\\n[00:06] 都适合看这篇文章的\\n[00:07] 如果你只是想要几个\\n[00:09] 让显得有趣的技巧\\n[00:10] 比如怎么接话\\n[00:11] 怎么聊天不冷场OK\\n[00:13] 那你可以划掉我了\\n[00:14] 但如果你有一种隐隐的感觉\\n[00:15] 好像活着活着\\n[00:16] 我自己变得越来越平\\n[00:18] 和人说话也没有什么好说的\\n[00:20] 独处时也找不到什么\\n[00:21] 真正让自己发光的东西\\n[00:23] 那这篇文章就是写给你的\\n[00:24] 我们来说一个很多人\\n[00:25] 都不敢承认的事实\\n[00:26] 叫做无趣\\n[00:27] 不是性格问题\\n[00:29] 那些\\n[00:30] 真正让人觉得无聊的女孩\\n[00:32] 往往不是因为她们沉默\\n[00:33] 而是她们内部空掉了\\n[00:35] 你坐在那里\\n[00:36] 笑得很得体\\n[00:37] 说话也没有失礼\\n[00:38] 但是就给人一种感觉\\n[00:39] 她好像没有在活着\\n[00:41] 眼神是漂浮的\\n[00:42] 热情是借来的\\n[00:43] 兴趣是假装的\\n[00:45] 这不是性格内向\\n[00:46] 这是生命力在悄悄流失\\n[00:48] 是从什么时候开始流失的呢\\n[00:50] 有一个概念叫做习得性无助\\n[00:53] 是斯坦福大学的心理学家\\n[00:54] 马丁格力塞尔\\n[00:56] 是斯坦心理学里心理学\\n[00:58] 心理学研究有个概念\\n[00:58] 是斯坦福心理学里心理学\\n[01:00] 叫做习得性无助\\n[01:01] 是斯坦福大学的心理学家\\n[01:03] 马丁塞利格曼\\n[01:05] 在长期研究中提出的\\n[01:06] 她说\\n[01:07] 当一个人在一个领域里\\n[01:08] 反复受挫\\n[01:09] 反复被否定\\n[01:10] 就会形成一种内在的信念\\n[01:12] 不管我做什么都没有用\\n[01:14] 最可怕的东西就在于\\n[01:16] 这种信念会蔓延\\n[01:17] 从一件事蔓延到整个\\n[01:18] 生活\\n[01:18] 从我不擅长这个\\n[01:19] 变成我不擅长任何事\\n[01:21] 从这件事情我失败了\\n[01:23] 变成我这个人本身就是失败的\\n[01:25] 然后就会出现一种症状\\n[01:26] 什么都提不起劲\\n[01:27] 没有特别想去做的事\\n[01:28] 没有特别想去的地方\\n[01:29] 没有特别喜欢的人\\n[01:30] 也没有特别在意的梦想\\n[01:31] 活着\\n[01:32] 就好像是在待机\\n[01:34] 那关键点来了啊\\n[01:36] 无趣的本质\\n[01:37] 是一个人和自己内在欲望的断联\\n[01:39] 你不是真的没有欲望\\n[01:41] 你只是慢慢学会不去感受它\\n[01:42] 因为感受之后会失望\\n[01:43] 会被否定\\n[01:44] 会被现实打脸\\n[01:46] 所以更安全的方式\\n[01:47] 是提前关掉那个开关\\n[01:49] 期待 不渴望 不热爱\\n[01:50] 不期待 不渴望 不热爱\\n[01:51] 看起来很平静\\n[01:52] 实则是生命力\\n[01:53] 在一点一点的露出去\\n[01:55] 而一个内部空掉的人\\n[01:56] 无论外表多精致\\n[01:58] 无论说话多礼貌\\n[01:59] 都很难真正的吸引人\\n[02:01] 也很难真正的被吸引\\n[02:02] 因为吸引的本质是能量\\n[02:04] 是那种活着在燃烧\\n[02:06] 对世界还有好奇心的能量\\n[02:08] 我见过很多这样的女孩啊\\n[02:10] 二0多岁大家上着还不错的班\\n[02:13] 长得很好看\\n[02:14] 说话也很得体\\n[02:15] 但是你跟她相处完之后\\n[02:16] 记不住她说了什么\\n[02:17] 她对什么真正的热情\\n[02:19] 她想说都行\\n[02:20] 你问她想做什么\\n[02:21] 她说随便\\n[02:22] 有没有什么想实现的事\\n[02:23] 她想了很久\\n[02:24] 说呃\\n[02:24] 其实也没有什么特别想的\\n[02:26] 那刻我突然很难过\\n[02:28] 我不是替她可怜\\n[02:29] 是替那个曾经也有过\\n[02:30] 欲望\\n[02:31] 和热情的小女孩\\n[02:33] 感到心疼\\n[02:34] 那些欲望没有消失\\n[02:35] 只是他们被压的太久了\\n[02:37] 慢慢的变得看不见了\\n[02:39] 那相反的人是什么呀\\n[02:41] 那种让人觉得哇\\n[02:42] 她好有趣\\n[02:43] 的女性\\n[02:44] 你有没有认真观察过\\n[02:45] 她们有什么共同点\\n[02:46] 不是因为她们更好笑\\n[02:47] 不是因为他们见识更广\\n[02:48] 不是因为他们天生外向\\n[02:49] 而是因为她们都有某种特质\\n[02:50] 叫做他们对某种事物\\n[02:51] 有着真实的\\n[02:53] 自己的感受\\n[02:54] 可能是某种食物\\n[02:55] 可能是某一个地方\\n[02:56] 可能是某一类书\\n[02:57] 也可能是某种手艺\\n[02:58] 不需要很多\\n[02:59] 甚至只需要一件\\n[03:00] 但那种热情是真实的\\n[03:01] 是从内往外涌的\\n[03:03] 而不是为了让别人觉得有趣\\n[03:05] 而表演出来的\\n[03:06] 而这就是生命力\\n[03:07] 那生命力是可以被找回来的吗\\n[03:09] 当然而且是有办法的\\n[03:11] 神经科学的研究已经证实\\n[03:12] 我们的大脑\\n[03:13] 其实具备很强的可塑性\\n[03:15] 即使是长期\\n[03:16] 处于低活跃状态的\\n[03:18] 也可以通过新的体验\\n[03:19] 和重复的行为\\n[03:20] 被重新激活\\n[03:21] 换句话说\\n[03:22] 那个曾经\\n[03:23] 对什么都有好奇心的自己\\n[03:24] 没有消失\\n[03:25] 只是睡着了\\n[03:26] 我们可以把它唤醒\\n[03:27] 那具体怎么做\\n[03:28] 去做一件没有用的事情\\n[03:30] 注意是没有用的\\n[03:31] 不是为了提高竞争力\\n[03:32] 不是为了填简历\\n[03:33] 不是为了让别人觉得哇\\n[03:34] 你好厉害\\n[03:36] 就是因为单纯的\\n[03:37] 觉得有点意思\\n[03:38] 可以是一种做饭的方法\\n[03:39] 你一直想学的东西\\n[03:40] 也可以是\\n[03:41] 某个从来没有去过的地方\\n[03:42] 可以是一本你之前翻了两页\\n[03:44] 哎就放下了书\\n[03:45] 不要去想它有没有意义\\n[03:46] 生命力的重启\\n[03:47] 往往从无用之事开始\\n[03:49] 第二步每天花五分钟\\n[03:50] 写今天\\n[03:51] 什么东西让我有新的感觉\\n[03:54] 就一句话\\n[03:55] 可以是情绪\\n[03:56] 可以是一个场景\\n[03:56] 可以是一种味道\\n[03:57] 可以是一段话\\n[03:58] 就是重新训练你的感受力\\n[04:00] 帮你重新学会感受\\n[04:02] 而不是麻木的过日子\\n[04:04] 第三步\\n[04:04] 给自己制造一点点陌生感\\n[04:06] 心理学研究发现\\n[04:07] 大脑在接触新奇事物时\\n[04:09] 会分泌多巴胺\\n[04:10] 而多巴胺正是驱使我们好奇\\n[04:11] 探索感受活着的关键物质\\n[04:14] 每周做一件从来没做过的小事\\n[04:16] 走一条没有走过的路\\n[04:17] 点一道从来没有吃过的菜\\n[04:18] 听一首完全不熟悉的音乐\\n[04:19] 不用太大\\n[04:20] 但要真实的去感受\\n[04:22] 生命力不是天赋\\n[04:23] 也不是性格\\n[04:24] 也不是某种你要么有\\n[04:25] 要么没有的东西\\n[04:27] 它是一个需要被滋养的东西\\n[04:28] 我们中的很多人\\n[04:30] 其实在成长的过程中\\n[04:31] 被告诉说不要太有想法\\n[04:34] 不要太敏感\\n[04:35] 不要表现的太渴望\\n[04:36] 要懂事\\n[04:37] 要乖平稳要稳定\\n[04:39] 于是我们慢慢就变成了一个\\n[04:41] 不太有想法\\n[04:42] 不太敏感\\n[04:43] 不太渴望什么的人\\n[04:44] 看起来成熟了\\n[04:45] 实则呢\\n[04:46] 是把生命力给训练掉了\\n[04:48] 但今天你看到了这一点\\n[04:49] 说明那个有生命力的你还在\\n[04:51] 她只是在等一个人\\n[04:53] 可以重新活的有热情一点吗","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":6,"chunks_succeeded":6,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T09:09:45.154752+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要讨论‘女孩子无趣的本质是生命力的匮乏’，将无趣归因于内在生命力流失，而非性格问题。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对感到自己越来越无趣、生活平淡、缺乏热情和内在动力的女性，尤其是那些在社交或独处中感到空虚的年轻女性。"},"user_need":{"label":"用户主要问题或需求","summary":"用户的核心需求是理解自己为何变得无趣，并希望找回内在的热情和生命力，而非仅仅学习表面社交技巧。"},"content_structure":{"label":"内容怎么展开","summary":"内容从提出问题（无趣是生命力匮乏）开始，引入心理学概念（习得性无助）解释原因，再对比有趣女性的特质，最后给出具体方法。"},"solution":{"label":"给了什么解决办法","summary":"给出了三步具体方法：做一件‘无用’的事、每天花五分钟记录新感受、每周制造一点陌生感（如走新路、尝新菜）。"},"references":{"label":"值得参考什么","summary":"值得参考的是内容中引用的心理学概念（习得性无助）和神经科学观点（大脑可塑性、多巴胺与新奇感），以及其对比分析（无趣vs有趣女性的特质）。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做‘如何具体执行三步方法’的实操指南、‘习得性无助’的科普解读、‘女性成长与生命力’的系列内容，或‘真实案例分享’等。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251704/e311ac2f0961f3522764bd2742b83c75/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_dft_wlteh_jpg_3", "taskId": "f90d29b0a27b", "topics": ["女孩子", "女性智慧", "女性成长", "生命力", "少女心事", "girlstalk"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1", "name": "可可拆爆款", "followers": 122838}, "aiModel": "deepseek-v4-flash", "duration": "4分56秒", "platform": "xiaohongshu", "coverFrom": "inline", "mainTopic": "这条内容主要讨论‘女孩子无趣的本质是生命力的匮乏’，将无趣归因于内在生命力流失，而非性格问题。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "4万", "collects": "3.2万", "comments": "648", "likesNum": 40000, "collectsNum": 32000, "commentsNum": 648}, "imageCount": 0, "imageFiles": [], "topicCount": 8, "generatedAt": "2026-08-25T09:09:45.154752+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 3707}	2026-08-25 09:20:56.490278+00	\N
183	45ecbd25bd1f	xiaohongshu	13	{"schema_version":13,"task_id":"45ecbd25bd1f","source_url":"https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787555967&share_id=fab821cb47f44fdc8809fac52b9572c5","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787555967&share_id=fab821cb47f44fdc8809fac52b9572c5","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251422/d0a4f149ff89b3637ba6fe4f5a29abe0/1040g2sg323t3k20m0ae05nenu9pg8u99tt3aqdo!nd_prv_wlteh_jpg_3","duration_seconds":156.4,"width":480,"height":854,"size_bytes":10330816,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true}},"title":"顶级吸引力就是无所谓","description":"情绪管理 职场 野生老板","cover_title":"","cover_title_meta":{},"post_title":"顶级吸引力就是无所谓","post_description":"情绪管理 职场 野生老板","display_title":"顶级吸引力就是无所谓","author":"野生老板商业思维","account":{"name":"野生老板商业思维","profile_url":"https://www.xiaohongshu.com/user/profile/5dd7f2730000000001007929","bio":"2020福布斯U30，地产资管公司创始人\\n强势文化｜国学智慧｜关系运作｜商业思维\\n@野生老板 官方授权","following_count":"204","follower_count":"27555","likes_and_collections_count":"218882"},"page_text":"","text_same_as_description":false,"engagement":{"likes":"1386","collects":"912","comments":"37"},"topics":["人格魅力","吸引力","顶级思维","情绪管理","自我提升","职场","人性弱点","野生老板"],"video_text":"[00:00] 一个人的终极吸引力其实就\\n[00:01] 淡定 这个是道德经里非常\\n[00:03] 反常识的一个真相\\n[00:05] 在道德经第29章\\n[00:06] 他说天下神器不可为也\\n[00:08] 不可执也\\n[00:09] 为者败之\\n[00:10] 执者失之\\n[00:11] 他说的就是你越想用力抓住的东西\\n[00:12] 往往就是你失去的越快\\n[00:14] 而当你彻底放下执念\\n[00:16] 表现的云淡风轻\\n[00:17] 无欲则刚的时候\\n[00:18] 全世界的资源反而会主动的\\n[00:20] 向你靠拢\\n[00:21] 所有那些刻意展示出来的\\n[00:22] 魅力\\n[00:23] 其实都不够高级\\n[00:24] 精致的妆容\\n[00:24] 圆滑的情商\\n[00:25] 各种好听的话术\\n[00:26] 你越是主动\\n[00:27] 越是用力的去输出\\n[00:28] 在真正高手的眼里\\n[00:29] 你就显得越低级和匮乏\\n[00:31] 真正的顶级吸引力来自于你\\n[00:32] 你的冷静\\n[00:33] 你的克制\\n[00:33] 你的淡定\\n[00:34] 而在那个背后的本质\\n[00:35] 它其实是一种无为和不\\n[00:36] 执着的智慧\\n[00:38] 第一个 淡定的本质是不\\n[00:39] 不在乎\\n[00:39] 你不在意身边人的去留\\n[00:40] 不在意别人的眼光和评价\\n[00:42] 不在意一段关系里的得与失\\n[00:44] 你可以去留意一下\\n[00:45] 在关系里面最让人着迷\\n[00:46] 的那个人\\n[00:47] 从来不是那个患得患失\\n[00:49] 随时消息秒回\\n[00:50] 很在意你的人\\n[00:51] 而是那个\\n[00:52] 无论你走也好 留也好\\n[00:53] 回他消息也好 不理他也好\\n[00:54] 他都稳定的像石头一样\\n[00:56] 稳定的可怕的那个人\\n[00:57] 这种人的无所谓\\n[00:58] 他不是装出来的\\n[01:00] 他是真的无所谓\\n[01:01] 本质是我的人生\\n[01:02] 能做到绝对的自给自足\\n[01:03] 绝对的自我圆满\\n[01:05] 这种淡定感\\n[01:06] 他是会给对方带来\\n[01:07] 巨大的心理压迫感的\\n[01:08] 因为他会突然发现\\n[01:10] 在你这里我没有任何筹码\\n[01:11] 可以谈判\\n[01:12] 他不能用离开来威胁你\\n[01:13] 因为你不需要他\\n[01:14] 他也不能用冷暴力来\\n[01:15] 控制你\\n[01:16] 因为你一个人也活得很好\\n[01:17] 他更加不能用这种\\n[01:18] 夸奖赞美来去收买你\\n[01:19] 因为你的自我价值是\\n[01:20] 不需要他来确认的\\n[01:21] 而当一个人在关系里面\\n[01:22] 找不到任何一个可以拿捏你的点\\n[01:24] 那他只剩两条路可以走\\n[01:25] 要么主动靠近你去适应你\\n[01:27] 要么自觉退出离场\\n[01:29] 而你呢这两种结果其实\\n[01:31] 都能接受\\n[01:32] 这个才是真正关系里\\n[01:34] 的主动权并\\n[01:35] 不是你控制了他\\n[01:36] 而是你控制了自己\\n[01:37] 你让自己绝对的冷静克制\\n[01:38] 而他这个时候就不得不\\n[01:40] 跟着你的节奏去走了\\n[01:41] 第二个淡定\\n[01:42] 它是一种内在的状态\\n[01:43] 而不是装出来的冷漠\\n[01:44] 道德经里有一句话形容淡定\\n[01:46] 我觉得非常合适\\n[01:47] 说清静为天下正\\n[01:48] 清静啊才是这个天下万事\\n[01:49] 万物的标准\\n[01:51] 什么叫清静\\n[01:52] 说实话我是不认同现在那些\\n[01:53] 所谓的修行就要打坐冥想\\n[01:55] 与世隔绝的\\n[01:56] 在我看来真正的清静是在这个世俗\\n[01:57] 真正的清净是在这个世俗\\n[01:59] 你的内心依旧是满的\\n[02:01] 依旧是不需要外界来去填补的\\n[02:02] 不需要别人的认可来确认自己的价值\\n[02:04] 也不需要一段关系来证明自己值得被爱\\n[02:06] 不需要任何人来评价定义你\\n[02:09] 当你能够自给自足的时候\\n[02:11] 其实你的状态自然而然就会\\n[02:12] 淡定了\\n[02:13] 这个不是自我压抑出来的伪装\\n[02:14] 是外界根本没有什么东西是可以撼动你的\\n[02:17] 一个内在圆满的人他的淡定一定是\\n[02:19] 由内而外散发出来的状态\\n[02:21] 而不是装出来的外在的冷漠\\n[02:23] 所以顶级的魅力啊\\n[02:24] 他从来不是往自己身上做加法\\n[02:25] 去学什么话术去打扮自己\\n[02:26] 在我看来他是做减法\\n[02:28] 减掉你对外界的需要\\n[02:30] 减掉那些你拼命向外抓取的所有动作\\n[02:32] 你以为的魅力是你展示了什么\\n[02:34] 但真正的魅力其实是你\\n[02:35] 不展示什么","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":3,"chunks_succeeded":3,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":26,"replies_scanned":6,"primary_pages":2,"reply_pages":2,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.214,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T03:50:18.191741+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"以《道德经》为据，阐述顶级吸引力源于淡定、无为和不执着的智慧，而非刻意展示魅力。"},"target_audience":{"label":"针对什么人 / 场景","summary":"关注职场情绪管理、个人魅力提升的成年人，尤其是自称“野生老板”或处于关系博弈中的职场人士。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能困惑于如何提升自身吸引力或处理关系中的主动权，希望获得反直觉的实用心法。"},"content_structure":{"label":"内容怎么展开","summary":"先引用道德经第29章提出核心观点，再分两个层次展开：第一层解释淡定的本质是不在乎，并描述其在关系中的效果；第二层强调淡定是内在状态而非伪装，最后总结魅力是做减法。"},"solution":{"label":"给了什么解决办法","summary":"内容给出明确办法：通过减少对外界的需要、放下执念、实现自我圆满来培养淡定感，从而在关系中掌握主动权。"},"references":{"label":"值得参考什么","summary":"引用《道德经》第29章“天下神器不可为也”及“清静为天下正”等原文。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸制作具体场景案例，如职场谈判、亲密关系中的淡定应用；或对比“刻意魅力”与“淡定魅力”的实操差异。"}},"source_labels":["文字标题","作品描述","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "480×854", "cover": "http://sns-webpic-qc.xhscdn.com/202608251422/d0a4f149ff89b3637ba6fe4f5a29abe0/1040g2sg323t3k20m0ae05nenu9pg8u99tt3aqdo!nd_prv_wlteh_jpg_3", "taskId": "45ecbd25bd1f", "topics": ["人格魅力", "吸引力", "顶级思维", "情绪管理", "自我提升", "职场"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5dd7f2730000000001007929", "name": "野生老板商业思维", "followers": 27555}, "aiModel": "deepseek-v4-flash", "duration": "2分36秒", "platform": "xiaohongshu", "coverFrom": "url", "mainTopic": "以《道德经》为据，阐述顶级吸引力源于淡定、无为和不执着的智慧，而非刻意展示魅力。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "1386", "collects": "912", "comments": "37", "likesNum": 1386, "collectsNum": 912, "commentsNum": 37}, "imageCount": 0, "imageFiles": [], "topicCount": 8, "generatedAt": "2026-08-25T03:50:18.191741+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": 26, "transcriptChars": 2118}	2026-08-25 09:23:21.497988+00	\N
181	ZZTEST0825	xiaohongshu	13	{"schema_version":13,"task_id":"ZZTEST0825","source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251136/9d938faac4ad47ede74adf800260ccdc/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_prv_wlteh_jpg_3","duration_seconds":296.077,"width":1080,"height":1920,"size_bytes":49044082,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true}},"title":"女孩子无聊的本质是生命力的匮乏","description":"","cover_title":"女孩子无趣的本质是生命力的匮乏","cover_title_meta":{"text":"女孩子无趣的本质是生命力的匮乏","confidence":0.954,"font_ratio":1.32,"line_count":2,"lines":[{"text":"女孩子无趣的本质","confidence":0.998},{"text":"生命力的匮乏","confidence":0.909}],"source_image_index":1,"reference_corrected":true,"source":"video_cover"},"post_title":"女孩子无聊的本质是生命力的匮乏","post_description":"","display_title":"女孩子无趣的本质是生命力的匮乏","author":"可可拆爆款","account":{"name":"可可拆爆款","profile_url":"https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1","bio":"👩全网100W➕粉丝\\n🎉你却的不是方法，而是一个带你的人\\n🌲账号定位｜流量卡点｜爆款模板\\n🔗下方进👗","following_count":"1010","follower_count":"122814","likes_and_collections_count":"1148511"},"page_text":"","text_same_as_description":false,"engagement":{"likes":"4万","collects":"3.2万","comments":"647"},"topics":["女孩子","女性智慧","女性成长","生命力","少女心事","girlstalk","本质","人生智慧"],"video_text":"[00:00] 女孩子无趣的本质\\n[00:00] 是生命力的匮乏\\n[00:02] 自己觉得越来越没有意思\\n[00:04] 请把这篇文章仔细看完\\n[00:05] 不是所有人都适合看这篇文章的\\n[00:07] 如果你只是想要几个\\n[00:08] 让显得有趣的技巧\\n[00:10] 比如怎么接话\\n[00:10] 怎么聊天不冷场OK\\n[00:12] 那你可以划掉我了\\n[00:13] 但如果你有一种隐隐的感觉\\n[00:15] 好像活着活着\\n[00:16] 我自己变得越来越平\\n[00:17] 和人说话也没有什么好说的\\n[00:19] 独处时也找不到什么\\n[00:21] 真正让自己发光的东西\\n[00:22] 那这篇文章就是写给你的\\n[00:24] 我们来说一个很多人\\n[00:25] 都不敢承认的事实\\n[00:26] 叫做无趣\\n[00:27] 不是性格问题\\n[00:28] 也不是不会说话\\n[00:29] 那些\\n[00:30] 真正让人觉得无聊的女孩\\n[00:32] 往往不是因为她们沉默\\n[00:33] 而是她们内部空掉了\\n[00:34] 你坐在那里\\n[00:35] 笑得很得体\\n[00:36] 说话也没有失礼\\n[00:37] 但是就给人一种感觉\\n[00:38] 她好像没有在活着\\n[00:40] 眼神是漂浮的\\n[00:42] 聊天是应付的\\n[00:43] 热情是借来的\\n[00:44] 兴趣是假装的\\n[00:45] 这不是性格内向\\n[00:46] 这是生命力在悄悄流失\\n[00:48] 是什么时候开始流失的呢\\n[00:50] 有一个概念叫做习得性无助\\n[00:52] 是斯坦福大学的心理学家\\n[00:54] 马丁格力塞尔\\n[00:56] 是斯坦心理学里心理学\\n[00:58] 心理学\\n[00:58] 心理学研究有个概念\\n[01:00] 叫做习得性无助\\n[01:02] 是斯坦福大学的心理学家\\n[01:03] 马丁塞利格曼\\n[01:05] 在长期研究中提出的\\n[01:06] 她说\\n[01:07] 当一个人在一个领域里\\n[01:08] 反复受挫\\n[01:09] 反复被否定\\n[01:11] 就会形成一种内在的信念\\n[01:12] 不管我做什么都没有用\\n[01:14] 最可怕的东西就在于\\n[01:16] 这种信念会蔓延\\n[01:17] 从一件事蔓延到整个\\n[01:18] 生活从我不擅长这个\\n[01:19] 变成我不擅长任何事\\n[01:21] 从这件事情我失败了\\n[01:23] 我个人本身就是失败的\\n[01:25] 然后就会出现一种症状\\n[01:26] 什么都提不起劲\\n[01:27] 没有特别想去做的事\\n[01:28] 没有特别想去的地方\\n[01:29] 没有特别喜欢的人\\n[01:31] 也没有特别在意的梦想\\n[01:32] 活着就好像是在待机\\n[01:35] 那关键点来了啊\\n[01:36] 无趣的本质\\n[01:37] 是一个人和自己内在欲望的断联\\n[01:39] 你不是真的没有欲望\\n[01:41] 你只是慢慢学会不去感受它\\n[01:42] 因为感受之后会失望\\n[01:44] 会被否定\\n[01:45] 会被现实打脸\\n[01:46] 所以更安全的方式\\n[01:48] 是提前关掉那个开关\\n[01:49] 期待\\n[01:50] 不渴望\\n[01:51] 看起来很平静\\n[01:52] 实质是生命力\\n[01:53] 在一点点的露出出去\\n[01:55] 而一个内部空掉的人\\n[01:56] 无论外表多精致\\n[01:57] 无论说话多礼貌\\n[01:58] 都很难真正的吸引人\\n[02:00] 也很难真正的被吸引\\n[02:01] 因为吸引的本质是能量\\n[02:04] 是那种活着在燃烧\\n[02:05] 对世界还有好奇心的能量\\n[02:07] 我见过很多这样的女孩啊\\n[02:09] 二0多岁大家上着还不错的班\\n[02:12] 长得也很好看\\n[02:13] 说话也很得体\\n[02:14] 但是你跟她相处完之后\\n[02:15] 记不住她说了什么\\n[02:16] 也感受不到她对什么真正的热情\\n[02:18] 她说都行\\n[02:19] 你问她想做什么\\n[02:20] 她说随便\\n[02:21] 有没有什么想实现的事\\n[02:22] 她想很久\\n[02:23] 说呃\\n[02:24] 其实也没有什么特别想的\\n[02:25] 那刻我突然很难过\\n[02:27] 我不是替她可怜\\n[02:28] 是替那个\\n[02:29] 曾经也有过欲望\\n[02:30] 和热情的小女孩\\n[02:32] 感到心疼\\n[02:33] 那些欲望没有消失\\n[02:35] 只是他们被压的太久了\\n[02:36] 慢慢的\\n[02:37] 变得看不见了\\n[02:38] 那相反的人是什么呀\\n[02:40] 那种让人觉得哇\\n[02:41] 她好有趣的女性\\n[02:43] 你有没有认真观察过\\n[02:44] 她们有什么共同点\\n[02:45] 不是因为他们更好笑\\n[02:46] 不是因为他们见识更广\\n[02:47] 不是因为他们天生外向\\n[02:48] 而是因为她们都有某种特质\\n[02:49] 叫做他们对某种事物\\n[02:51] 有着真实的\\n[02:52] 自己的感受\\n[02:53] 可能是某一种食物\\n[02:54] 可能是某种食物\\n[02:54] 可能是某一个地方\\n[02:55] 可能是某一类书\\n[02:56] 也可能是某种手艺\\n[02:58] 不需要很多\\n[02:59] 甚至只需要一件\\n[03:00] 但那种热情是真实的\\n[03:01] 是从内往外涌的\\n[03:03] 而不是为了让别人觉得有趣\\n[03:05] 而表演出来的\\n[03:06] 而这就是生命力\\n[03:07] 那生命力是可以被找回来的吗\\n[03:09] 当然而且是有办法的\\n[03:11] 神经科学的研究已经证实\\n[03:13] 我们的大脑\\n[03:14] 其实具备很强的可塑性\\n[03:15] 即使是长期\\n[03:16] 处于低活跃状态的\\n[03:18] 也可以通过新的体验\\n[03:19] 和重复的行为\\n[03:20] 被重新激活\\n[03:21] 换句话说\\n[03:22] 那个曾经\\n[03:23] 对什么都有好奇心的自己\\n[03:25] 没有消失\\n[03:25] 只是睡着了\\n[03:26] 我们可以把她唤醒\\n[03:27] 那具体怎么做\\n[03:28] 去做一件没有用的事情\\n[03:30] 注意是没有用的\\n[03:31] 不是为了提高竞争力\\n[03:32] 不是为了填简历\\n[03:33] 不是为了让别人觉得哇\\n[03:35] 你好厉害\\n[03:36] 就是因为单纯的\\n[03:37] 觉得有点意思\\n[03:38] 可以是一种做饭的方法\\n[03:39] 你一直想学的东西\\n[03:41] 也可以是\\n[03:41] 某个从来没有去过的地方\\n[03:42] 可以是一本你之前翻了两页\\n[03:44] 哎就放下了书\\n[03:45] 不要去想它有没有意义\\n[03:46] 生命力的重启\\n[03:47] 往往从无用之事开始\\n[03:49] 第二步每天花五分钟\\n[03:50] 写今天\\n[03:51] 什么东西让我有新的感觉\\n[03:54] 就一句话\\n[03:55] 可以是情绪\\n[03:56] 可以是一种味\\n[03:57] 道可以是一段话\\n[03:58] 就是重新训练你的感受力\\n[04:00] 帮你重新学会感受\\n[04:02] 而不是麻木的过日子\\n[04:03] 第三步\\n[04:04] 给自己制造一点点陌生感\\n[04:06] 心理学研究就发现\\n[04:07] 大脑在接触新奇事物时\\n[04:08] 会分泌多巴胺\\n[04:09] 而多巴胺正是驱使我们好奇\\n[04:11] 探索感受活着的关键物质\\n[04:14] 做一件从来没做过的小事\\n[04:16] 哎走一条没有走过的路\\n[04:17] 点一道从来没有吃过的菜\\n[04:18] 听一首完全不熟悉的音乐\\n[04:20] 不求大\\n[04:21] 但要真实的去感受\\n[04:22] 生命力不是天赋\\n[04:24] 也不是某种你要么有\\n[04:25] 要么没有的东西\\n[04:26] 它是一个需要被滋养的东西\\n[04:28] 我们中的很多人\\n[04:29] 其实在成长的过程中\\n[04:31] 被告诉说不要太有想法\\n[04:34] 不要太敏感\\n[04:35] 不要表现的太渴望\\n[04:36] 要懂事\\n[04:37] 要乖平稳要稳定\\n[04:39] 于是\\n[04:40] 我们慢慢就变成了\\n[04:41] 不太有想法\\n[04:42] 不太敏感\\n[04:43] 不太渴望什么的人\\n[04:44] 看起来成熟了\\n[04:45] 实则呢\\n[04:46] 是把生命力给训练掉了\\n[04:48] 但今天你看到了这一点\\n[04:49] 说明那个有生命力的你还在\\n[04:51] 她只在等一个人\\n[04:53] 可以重新活的有热情一点吗","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":6,"chunks_succeeded":6,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[{"id":"6a796d3400000000070176e5","type":"comment","author":"橙几","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo30r5v4e87185g5nkk1lcg8n1c6e8gdb8?imageView2/2/w/120/format/jpg","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"created_at":1786342709000,"reply_count":10,"parent_comment_id":"","reply_to_author":""},{"id":"6a79b4ee0000000029036fff","type":"comment","author":"睡个好觉","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31j07eoorhg605o2ojsbgbv0si122gug?imageView2/2/w/120/format/jpg","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"created_at":1786361070000,"reply_count":11,"parent_comment_id":"","reply_to_author":""},{"id":"6a7a0398000000002901a909","type":"comment","author":"小捻","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo317f355ec4a605o98nvc0898k9qmgosg?imageView2/2/w/120/format/jpg","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"created_at":1786381209000,"reply_count":6,"parent_comment_id":"","reply_to_author":""},{"id":"6a796dfb00000000140140c3","type":"comment","author":"momo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo316fdh7p7he705o7ru3lg81ouq63m18o?imageView2/2/w/120/format/jpg","text":"男女无趣都是生命力的匮乏","like_count":288,"created_at":1786342907000,"reply_count":0,"parent_comment_id":"","reply_to_author":""},{"id":"6a7f15d80000000014016763","type":"comment","author":"路飞","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/650c37d238e68b556633e3eb.jpg?imageView2/2/w/120/format/jpg","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"created_at":1786713561000,"reply_count":9,"parent_comment_id":"","reply_to_author":""}],"comment_summary":{"threshold":20,"limit":5,"returned":5,"scanned":107,"replies_scanned":77,"primary_pages":3,"reply_pages":15,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.89,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":true,"stable_pages":12},"images":[],"ai_analysis":{"schema_version":1,"status":"ok","model":"deepseek-v4-flash","generated_at":"2026-08-25T03:41:10.606536+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对感到自己生活无趣、缺乏热情、与人交流平淡，且不满足于表面社交技巧的女性。"},"user_need":{"label":"用户主要问题或需求","summary":"用户需要理解自己为何变得无趣、内心空洞，并希望找到重新点燃热情和生命力的具体方法。"},"content_structure":{"label":"内容怎么展开","summary":"先以封面标题引出主题，区分两类读者，然后提出核心观点（无趣是生命力匮乏），用心理学概念（习得性无助）解释成因，对比无趣与有趣女性的差异，最后给出三步具体做法（做无用之事、写感受日记、制造陌生感）并总结鼓励。"},"solution":{"label":"给了什么解决办法","summary":"内容给出了三步具体方法：1. 做一件没有用但觉得有意思的事；2. 每天花五分钟记录让自己有感觉的事物；3. 给自己制造小陌生感（如走新路、尝新菜）。"},"references":{"label":"值得参考什么","summary":"引用了斯坦福大学心理学家马丁·塞利格曼的习得性无助概念，以及神经科学关于大脑可塑性和多巴胺与新奇事物关系的发现。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸做：如何识别并克服习得性无助的日常案例；不同领域（如职场、亲密关系）中生命力匮乏的表现与恢复；从心理学角度深入解析多巴胺与兴趣培养的关系；观众实践三步法后的反馈与故事。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"ok","message":"","sample_size":5,"items":{"main_questions":{"label":"大家主要在问什么","summary":"现有样本未形成明确结论。","evidence_comments":[]},"high_frequency_needs":{"label":"高频需求","summary":"现有样本未形成明确结论。评论中提及通过跳舞、散步、尝试新事物等方式恢复生命力，但样本量小，不足以判断高频需求。","evidence_comments":[{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"},{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},"worries":{"label":"最担心什么","summary":"现有样本未形成明确结论。评论提到拖延症导致的习得性无助和低谷期，但未明确表达担忧。","evidence_comments":[{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},"unclear_points":{"label":"博主没讲清什么","summary":"有评论指出博主内容缺乏有效方法，但未具体说明哪些点未讲清。","evidence_comments":[{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"}]},"key_comments":{"label":"哪些评论值得重点看","entries":[{"comment":{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"},"reason":"详细描述了从低谷到恢复生命力的个人经历，提供了具体行动（跳舞）和效果，具有参考价值。"},{"comment":{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"},"reason":"分享了多种恢复生命力的方法（如无用之事、尝试新事物、写幸福小事），并提及习得性无助，内容充实。"},{"comment":{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"},"reason":"直接指出视频缺乏有效方法，是重要的负面反馈，可能代表部分观众需求。"},{"comment":{"id":"6a79b4ee0000000029036fff","author":"睡个好觉","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"type":"comment"},"reason":"以幽默方式提出“抠”作为无趣原因，简短但引发共鸣。"},{"comment":{"id":"6a796dfb00000000140140c3","author":"momo","text":"男女无趣都是生命力的匮乏","like_count":288,"type":"comment"},"reason":"概括性观点，将无趣与生命力匮乏关联，简洁有力。"}]},"topic_extensions":{"label":"可以延伸什么选题","entries":[{"idea":"如何通过兴趣爱好（如跳舞）恢复自信和生命力","evidence_comments":[{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"}]},{"idea":"拖延症与习得性无助的关系及应对方法","evidence_comments":[{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},{"idea":"低成本或无成本的方式提升生活趣味（如抠门与无趣）","evidence_comments":[{"id":"6a79b4ee0000000029036fff","author":"睡个好觉","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"type":"comment"}]},{"idea":"男女无趣的共性原因分析","evidence_comments":[{"id":"6a796dfb00000000140140c3","author":"momo","text":"男女无趣都是生命力的匮乏","like_count":288,"type":"comment"}]},{"idea":"针对“无有效方法”的反馈，提供具体可操作的建议","evidence_comments":[{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"}]}]}}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251136/9d938faac4ad47ede74adf800260ccdc/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_prv_wlteh_jpg_3", "taskId": "ZZTEST0825", "topics": ["女孩子", "女性智慧", "女性成长", "生命力", "少女心事", "girlstalk"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1", "name": "可可拆爆款", "followers": 122814}, "aiModel": "deepseek-v4-flash", "duration": "4分56秒", "platform": "xiaohongshu", "mainTopic": "分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "4万", "collects": "3.2万", "comments": "647", "likesNum": 40000, "collectsNum": 32000, "commentsNum": 647}, "topicCount": 8, "generatedAt": "2026-08-25T03:41:10.606536+00:00", "aiVideoCount": 7, "commentsShown": 5, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 6, "commentsScanned": 107, "transcriptChars": 3693}	2026-08-25 07:04:07.118378+00	\N
182	ZZTEST0825	xiaohongshu	13	{"schema_version":13,"task_id":"ZZTEST0825","source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251136/9d938faac4ad47ede74adf800260ccdc/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_prv_wlteh_jpg_3","duration_seconds":296.077,"width":1080,"height":1920,"size_bytes":49044082,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true}},"title":"女孩子无聊的本质是生命力的匮乏","description":"","cover_title":"女孩子无趣的本质是生命力的匮乏","cover_title_meta":{"text":"女孩子无趣的本质是生命力的匮乏","confidence":0.954,"font_ratio":1.32,"line_count":2,"lines":[{"text":"女孩子无趣的本质","confidence":0.998},{"text":"生命力的匮乏","confidence":0.909}],"source_image_index":1,"reference_corrected":true,"source":"video_cover"},"post_title":"女孩子无聊的本质是生命力的匮乏","post_description":"","display_title":"女孩子无趣的本质是生命力的匮乏","author":"可可拆爆款","account":{"name":"可可拆爆款","profile_url":"https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1","bio":"👩全网100W➕粉丝\\n🎉你却的不是方法，而是一个带你的人\\n🌲账号定位｜流量卡点｜爆款模板\\n🔗下方进👗","following_count":"1010","follower_count":"122814","likes_and_collections_count":"1148511"},"page_text":"","text_same_as_description":false,"engagement":{"likes":"4万","collects":"3.2万","comments":"647"},"topics":["女孩子","女性智慧","女性成长","生命力","少女心事","girlstalk","本质","人生智慧"],"video_text":"[00:00] 女孩子无趣的本质\\n[00:00] 是生命力的匮乏\\n[00:02] 自己觉得越来越没有意思\\n[00:04] 请把这篇文章仔细看完\\n[00:05] 不是所有人都适合看这篇文章的\\n[00:07] 如果你只是想要几个\\n[00:08] 让显得有趣的技巧\\n[00:10] 比如怎么接话\\n[00:10] 怎么聊天不冷场OK\\n[00:12] 那你可以划掉我了\\n[00:13] 但如果你有一种隐隐的感觉\\n[00:15] 好像活着活着\\n[00:16] 我自己变得越来越平\\n[00:17] 和人说话也没有什么好说的\\n[00:19] 独处时也找不到什么\\n[00:21] 真正让自己发光的东西\\n[00:22] 那这篇文章就是写给你的\\n[00:24] 我们来说一个很多人\\n[00:25] 都不敢承认的事实\\n[00:26] 叫做无趣\\n[00:27] 不是性格问题\\n[00:28] 也不是不会说话\\n[00:29] 那些\\n[00:30] 真正让人觉得无聊的女孩\\n[00:32] 往往不是因为她们沉默\\n[00:33] 而是她们内部空掉了\\n[00:34] 你坐在那里\\n[00:35] 笑得很得体\\n[00:36] 说话也没有失礼\\n[00:37] 但是就给人一种感觉\\n[00:38] 她好像没有在活着\\n[00:40] 眼神是漂浮的\\n[00:42] 聊天是应付的\\n[00:43] 热情是借来的\\n[00:44] 兴趣是假装的\\n[00:45] 这不是性格内向\\n[00:46] 这是生命力在悄悄流失\\n[00:48] 是什么时候开始流失的呢\\n[00:50] 有一个概念叫做习得性无助\\n[00:52] 是斯坦福大学的心理学家\\n[00:54] 马丁格力塞尔\\n[00:56] 是斯坦心理学里心理学\\n[00:58] 心理学\\n[00:58] 心理学研究有个概念\\n[01:00] 叫做习得性无助\\n[01:02] 是斯坦福大学的心理学家\\n[01:03] 马丁塞利格曼\\n[01:05] 在长期研究中提出的\\n[01:06] 她说\\n[01:07] 当一个人在一个领域里\\n[01:08] 反复受挫\\n[01:09] 反复被否定\\n[01:11] 就会形成一种内在的信念\\n[01:12] 不管我做什么都没有用\\n[01:14] 最可怕的东西就在于\\n[01:16] 这种信念会蔓延\\n[01:17] 从一件事蔓延到整个\\n[01:18] 生活从我不擅长这个\\n[01:19] 变成我不擅长任何事\\n[01:21] 从这件事情我失败了\\n[01:23] 我个人本身就是失败的\\n[01:25] 然后就会出现一种症状\\n[01:26] 什么都提不起劲\\n[01:27] 没有特别想去做的事\\n[01:28] 没有特别想去的地方\\n[01:29] 没有特别喜欢的人\\n[01:31] 也没有特别在意的梦想\\n[01:32] 活着就好像是在待机\\n[01:35] 那关键点来了啊\\n[01:36] 无趣的本质\\n[01:37] 是一个人和自己内在欲望的断联\\n[01:39] 你不是真的没有欲望\\n[01:41] 你只是慢慢学会不去感受它\\n[01:42] 因为感受之后会失望\\n[01:44] 会被否定\\n[01:45] 会被现实打脸\\n[01:46] 所以更安全的方式\\n[01:48] 是提前关掉那个开关\\n[01:49] 期待\\n[01:50] 不渴望\\n[01:51] 看起来很平静\\n[01:52] 实质是生命力\\n[01:53] 在一点点的露出出去\\n[01:55] 而一个内部空掉的人\\n[01:56] 无论外表多精致\\n[01:57] 无论说话多礼貌\\n[01:58] 都很难真正的吸引人\\n[02:00] 也很难真正的被吸引\\n[02:01] 因为吸引的本质是能量\\n[02:04] 是那种活着在燃烧\\n[02:05] 对世界还有好奇心的能量\\n[02:07] 我见过很多这样的女孩啊\\n[02:09] 二0多岁大家上着还不错的班\\n[02:12] 长得也很好看\\n[02:13] 说话也很得体\\n[02:14] 但是你跟她相处完之后\\n[02:15] 记不住她说了什么\\n[02:16] 也感受不到她对什么真正的热情\\n[02:18] 她说都行\\n[02:19] 你问她想做什么\\n[02:20] 她说随便\\n[02:21] 有没有什么想实现的事\\n[02:22] 她想很久\\n[02:23] 说呃\\n[02:24] 其实也没有什么特别想的\\n[02:25] 那刻我突然很难过\\n[02:27] 我不是替她可怜\\n[02:28] 是替那个\\n[02:29] 曾经也有过欲望\\n[02:30] 和热情的小女孩\\n[02:32] 感到心疼\\n[02:33] 那些欲望没有消失\\n[02:35] 只是他们被压的太久了\\n[02:36] 慢慢的\\n[02:37] 变得看不见了\\n[02:38] 那相反的人是什么呀\\n[02:40] 那种让人觉得哇\\n[02:41] 她好有趣的女性\\n[02:43] 你有没有认真观察过\\n[02:44] 她们有什么共同点\\n[02:45] 不是因为他们更好笑\\n[02:46] 不是因为他们见识更广\\n[02:47] 不是因为他们天生外向\\n[02:48] 而是因为她们都有某种特质\\n[02:49] 叫做他们对某种事物\\n[02:51] 有着真实的\\n[02:52] 自己的感受\\n[02:53] 可能是某一种食物\\n[02:54] 可能是某种食物\\n[02:54] 可能是某一个地方\\n[02:55] 可能是某一类书\\n[02:56] 也可能是某种手艺\\n[02:58] 不需要很多\\n[02:59] 甚至只需要一件\\n[03:00] 但那种热情是真实的\\n[03:01] 是从内往外涌的\\n[03:03] 而不是为了让别人觉得有趣\\n[03:05] 而表演出来的\\n[03:06] 而这就是生命力\\n[03:07] 那生命力是可以被找回来的吗\\n[03:09] 当然而且是有办法的\\n[03:11] 神经科学的研究已经证实\\n[03:13] 我们的大脑\\n[03:14] 其实具备很强的可塑性\\n[03:15] 即使是长期\\n[03:16] 处于低活跃状态的\\n[03:18] 也可以通过新的体验\\n[03:19] 和重复的行为\\n[03:20] 被重新激活\\n[03:21] 换句话说\\n[03:22] 那个曾经\\n[03:23] 对什么都有好奇心的自己\\n[03:25] 没有消失\\n[03:25] 只是睡着了\\n[03:26] 我们可以把她唤醒\\n[03:27] 那具体怎么做\\n[03:28] 去做一件没有用的事情\\n[03:30] 注意是没有用的\\n[03:31] 不是为了提高竞争力\\n[03:32] 不是为了填简历\\n[03:33] 不是为了让别人觉得哇\\n[03:35] 你好厉害\\n[03:36] 就是因为单纯的\\n[03:37] 觉得有点意思\\n[03:38] 可以是一种做饭的方法\\n[03:39] 你一直想学的东西\\n[03:41] 也可以是\\n[03:41] 某个从来没有去过的地方\\n[03:42] 可以是一本你之前翻了两页\\n[03:44] 哎就放下了书\\n[03:45] 不要去想它有没有意义\\n[03:46] 生命力的重启\\n[03:47] 往往从无用之事开始\\n[03:49] 第二步每天花五分钟\\n[03:50] 写今天\\n[03:51] 什么东西让我有新的感觉\\n[03:54] 就一句话\\n[03:55] 可以是情绪\\n[03:56] 可以是一种味\\n[03:57] 道可以是一段话\\n[03:58] 就是重新训练你的感受力\\n[04:00] 帮你重新学会感受\\n[04:02] 而不是麻木的过日子\\n[04:03] 第三步\\n[04:04] 给自己制造一点点陌生感\\n[04:06] 心理学研究就发现\\n[04:07] 大脑在接触新奇事物时\\n[04:08] 会分泌多巴胺\\n[04:09] 而多巴胺正是驱使我们好奇\\n[04:11] 探索感受活着的关键物质\\n[04:14] 做一件从来没做过的小事\\n[04:16] 哎走一条没有走过的路\\n[04:17] 点一道从来没有吃过的菜\\n[04:18] 听一首完全不熟悉的音乐\\n[04:20] 不求大\\n[04:21] 但要真实的去感受\\n[04:22] 生命力不是天赋\\n[04:24] 也不是某种你要么有\\n[04:25] 要么没有的东西\\n[04:26] 它是一个需要被滋养的东西\\n[04:28] 我们中的很多人\\n[04:29] 其实在成长的过程中\\n[04:31] 被告诉说不要太有想法\\n[04:34] 不要太敏感\\n[04:35] 不要表现的太渴望\\n[04:36] 要懂事\\n[04:37] 要乖平稳要稳定\\n[04:39] 于是\\n[04:40] 我们慢慢就变成了\\n[04:41] 不太有想法\\n[04:42] 不太敏感\\n[04:43] 不太渴望什么的人\\n[04:44] 看起来成熟了\\n[04:45] 实则呢\\n[04:46] 是把生命力给训练掉了\\n[04:48] 但今天你看到了这一点\\n[04:49] 说明那个有生命力的你还在\\n[04:51] 她只在等一个人\\n[04:53] 可以重新活的有热情一点吗","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":6,"chunks_succeeded":6,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[{"id":"6a796d3400000000070176e5","type":"comment","author":"橙几","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo30r5v4e87185g5nkk1lcg8n1c6e8gdb8?imageView2/2/w/120/format/jpg","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"created_at":1786342709000,"reply_count":10,"parent_comment_id":"","reply_to_author":""},{"id":"6a79b4ee0000000029036fff","type":"comment","author":"睡个好觉","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31j07eoorhg605o2ojsbgbv0si122gug?imageView2/2/w/120/format/jpg","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"created_at":1786361070000,"reply_count":11,"parent_comment_id":"","reply_to_author":""},{"id":"6a7a0398000000002901a909","type":"comment","author":"小捻","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo317f355ec4a605o98nvc0898k9qmgosg?imageView2/2/w/120/format/jpg","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"created_at":1786381209000,"reply_count":6,"parent_comment_id":"","reply_to_author":""},{"id":"6a796dfb00000000140140c3","type":"comment","author":"momo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo316fdh7p7he705o7ru3lg81ouq63m18o?imageView2/2/w/120/format/jpg","text":"男女无趣都是生命力的匮乏","like_count":288,"created_at":1786342907000,"reply_count":0,"parent_comment_id":"","reply_to_author":""},{"id":"6a7f15d80000000014016763","type":"comment","author":"路飞","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/650c37d238e68b556633e3eb.jpg?imageView2/2/w/120/format/jpg","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"created_at":1786713561000,"reply_count":9,"parent_comment_id":"","reply_to_author":""}],"comment_summary":{"threshold":20,"limit":5,"returned":5,"scanned":107,"replies_scanned":77,"primary_pages":3,"reply_pages":15,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.89,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":true,"stable_pages":12},"images":[],"ai_analysis":{"schema_version":1,"status":"ok","model":"deepseek-v4-flash","generated_at":"2026-08-25T03:41:10.606536+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对感到自己生活无趣、缺乏热情、与人交流平淡，且不满足于表面社交技巧的女性。"},"user_need":{"label":"用户主要问题或需求","summary":"用户需要理解自己为何变得无趣、内心空洞，并希望找到重新点燃热情和生命力的具体方法。"},"content_structure":{"label":"内容怎么展开","summary":"先以封面标题引出主题，区分两类读者，然后提出核心观点（无趣是生命力匮乏），用心理学概念（习得性无助）解释成因，对比无趣与有趣女性的差异，最后给出三步具体做法（做无用之事、写感受日记、制造陌生感）并总结鼓励。"},"solution":{"label":"给了什么解决办法","summary":"内容给出了三步具体方法：1. 做一件没有用但觉得有意思的事；2. 每天花五分钟记录让自己有感觉的事物；3. 给自己制造小陌生感（如走新路、尝新菜）。"},"references":{"label":"值得参考什么","summary":"引用了斯坦福大学心理学家马丁·塞利格曼的习得性无助概念，以及神经科学关于大脑可塑性和多巴胺与新奇事物关系的发现。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸做：如何识别并克服习得性无助的日常案例；不同领域（如职场、亲密关系）中生命力匮乏的表现与恢复；从心理学角度深入解析多巴胺与兴趣培养的关系；观众实践三步法后的反馈与故事。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"ok","message":"","sample_size":5,"items":{"main_questions":{"label":"大家主要在问什么","summary":"现有样本未形成明确结论。","evidence_comments":[]},"high_frequency_needs":{"label":"高频需求","summary":"现有样本未形成明确结论。评论中提及通过跳舞、散步、尝试新事物等方式恢复生命力，但样本量小，不足以判断高频需求。","evidence_comments":[{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"},{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},"worries":{"label":"最担心什么","summary":"现有样本未形成明确结论。评论提到拖延症导致的习得性无助和低谷期，但未明确表达担忧。","evidence_comments":[{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},"unclear_points":{"label":"博主没讲清什么","summary":"有评论指出博主内容缺乏有效方法，但未具体说明哪些点未讲清。","evidence_comments":[{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"}]},"key_comments":{"label":"哪些评论值得重点看","entries":[{"comment":{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"},"reason":"详细描述了从低谷到恢复生命力的个人经历，提供了具体行动（跳舞）和效果，具有参考价值。"},{"comment":{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"},"reason":"分享了多种恢复生命力的方法（如无用之事、尝试新事物、写幸福小事），并提及习得性无助，内容充实。"},{"comment":{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"},"reason":"直接指出视频缺乏有效方法，是重要的负面反馈，可能代表部分观众需求。"},{"comment":{"id":"6a79b4ee0000000029036fff","author":"睡个好觉","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"type":"comment"},"reason":"以幽默方式提出“抠”作为无趣原因，简短但引发共鸣。"},{"comment":{"id":"6a796dfb00000000140140c3","author":"momo","text":"男女无趣都是生命力的匮乏","like_count":288,"type":"comment"},"reason":"概括性观点，将无趣与生命力匮乏关联，简洁有力。"}]},"topic_extensions":{"label":"可以延伸什么选题","entries":[{"idea":"如何通过兴趣爱好（如跳舞）恢复自信和生命力","evidence_comments":[{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"}]},{"idea":"拖延症与习得性无助的关系及应对方法","evidence_comments":[{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},{"idea":"低成本或无成本的方式提升生活趣味（如抠门与无趣）","evidence_comments":[{"id":"6a79b4ee0000000029036fff","author":"睡个好觉","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"type":"comment"}]},{"idea":"男女无趣的共性原因分析","evidence_comments":[{"id":"6a796dfb00000000140140c3","author":"momo","text":"男女无趣都是生命力的匮乏","like_count":288,"type":"comment"}]},{"idea":"针对“无有效方法”的反馈，提供具体可操作的建议","evidence_comments":[{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"}]}]}}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251136/9d938faac4ad47ede74adf800260ccdc/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_prv_wlteh_jpg_3", "taskId": "ZZTEST0825", "topics": ["女孩子", "女性智慧", "女性成长", "生命力", "少女心事", "girlstalk"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1", "name": "可可拆爆款", "followers": 122814}, "aiModel": "deepseek-v4-flash", "duration": "4分56秒", "platform": "xiaohongshu", "mainTopic": "分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "4万", "collects": "3.2万", "comments": "647", "likesNum": 40000, "collectsNum": 32000, "commentsNum": 647}, "topicCount": 8, "generatedAt": "2026-08-25T03:41:10.606536+00:00", "aiVideoCount": 7, "commentsShown": 5, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 6, "commentsScanned": 107, "transcriptChars": 3693}	2026-08-25 07:04:07.182037+00	\N
189	f69e5eb15a7d	xiaohongshu	9	{"schema_version":9,"task_id":"f69e5eb15a7d","source_url":"https://www.xiaohongshu.com/discovery/item/6a7d8fef0000000022015197?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=normal&xsec_token=CBffYgL6gBopIxJWIDvrhpA-7m7jwLrdp_su-l08koLKE=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556084&share_id=ad26c36c89574ab291a1205c062dd285","platform":"xiaohongshu","collection_mode":"archive","collection_mode_label":"完整归档","storage":{"policy":"persistent","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"李银河聊亲密关系这段值得每个人熟读并背诵","description":"很久没听过这么实用的方法论分享了！ 看了李银河老师在@about编辑部新书《有余地的生活》的对谈，不但解答了很多关于亲密关系的疑惑，还给出了很多实用的方法。 我以前对于爱情的理解是：两个人既然相爱，那就要互相坦诚、事事报备，要一起看电影、听音乐、逛街、吃美食，我们要成为对方的唯一。 但实际进入亲密关系后就会发现，激情会褪去，生活会归于平淡，对方会有自己的交友圈、生活习惯，也会有偶尔想要独处的时候。 时间久了，过于依赖伴侣的那一方就会开始患得患失，会慢慢丢掉自己的生活与思想。因为一旦自己的情感寄托在对方身上，我们就开始没有了自我，进而亲密关系也会开始变得岌岌可危。 对于这些，李银河老师在对谈中都给我们聊透了。 比如生活中出现哪些信号时，需要停下来好好沟通，重新进行规划了呢？ - 情绪上的冲突开始变多，总会因为某件事一直不停的争吵； - 需要一直不停的解释自己，证明我不是不爱你，哪怕我只是出去跟朋友喝了杯茶； - 生活中突然遭遇了大的冲击，带来了很多不确定性； 任何一段关系的发展都是从浓到淡，所以在这期间会有变化，一点也不奇怪，我们需要做的只是在好好沟通之后，经营好自己的生活就可以。 在亲密关系中拥有独立的人格，对生活保有热爱和独立思考，才能拥有一段真正成熟、健康的关系。 就像李银河老师说的那样： 理想关系是高度的信任和无话不谈，可以成为彼此的树洞。双方在价值、审美、各种兴趣爱好上都有共鸣，且互相欣赏。 你可以在客厅打游戏，我在房间追剧；你喜酸，我爱吃辣；你喜欢钓鱼，我爱宅家，但是我们需要帮忙的时候，对方又可以给予支持和陪伴。这种互相独立又互相理解、尊重和帮助的关系，也是我之追求。 情绪价值","cover_title":"about关于","cover_title_meta":{"text":"about关于","confidence":0.917,"font_ratio":1.36,"line_count":2,"source_image_index":1},"post_title":"李银河聊亲密关系这段值得每个人熟读并背诵","post_description":"很久没听过这么实用的方法论分享了！ 看了李银河老师在@about编辑部新书《有余地的生活》的对谈，不但解答了很多关于亲密关系的疑惑，还给出了很多实用的方法。 我以前对于爱情的理解是：两个人既然相爱，那就要互相坦诚、事事报备，要一起看电影、听音乐、逛街、吃美食，我们要成为对方的唯一。 但实际进入亲密关系后就会发现，激情会褪去，生活会归于平淡，对方会有自己的交友圈、生活习惯，也会有偶尔想要独处的时候。 时间久了，过于依赖伴侣的那一方就会开始患得患失，会慢慢丢掉自己的生活与思想。因为一旦自己的情感寄托在对方身上，我们就开始没有了自我，进而亲密关系也会开始变得岌岌可危。 对于这些，李银河老师在对谈中都给我们聊透了。 比如生活中出现哪些信号时，需要停下来好好沟通，重新进行规划了呢？ - 情绪上的冲突开始变多，总会因为某件事一直不停的争吵； - 需要一直不停的解释自己，证明我不是不爱你，哪怕我只是出去跟朋友喝了杯茶； - 生活中突然遭遇了大的冲击，带来了很多不确定性； 任何一段关系的发展都是从浓到淡，所以在这期间会有变化，一点也不奇怪，我们需要做的只是在好好沟通之后，经营好自己的生活就可以。 在亲密关系中拥有独立的人格，对生活保有热爱和独立思考，才能拥有一段真正成熟、健康的关系。 就像李银河老师说的那样： 理想关系是高度的信任和无话不谈，可以成为彼此的树洞。双方在价值、审美、各种兴趣爱好上都有共鸣，且互相欣赏。 你可以在客厅打游戏，我在房间追剧；你喜酸，我爱吃辣；你喜欢钓鱼，我爱宅家，但是我们需要帮忙的时候，对方又可以给予支持和陪伴。这种互相独立又互相理解、尊重和帮助的关系，也是我之追求。 情绪价值","display_title":"about关于","author":"恰芒芒不恰","account":{"name":"恰芒芒不恰","profile_url":"https://www.xiaohongshu.com/user/profile/69133fb50000000037032e19","bio":"🎥 影视爱好者  | 🎙️ 采访观察者\\n💡 输出有温度、有深度的观点\\n🟢🫧zyq_coinouo","following_count":"2","follower_count":"1340","likes_and_collections_count":"45822"},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 恰芒芒不恰 关注 1/10 恰芒芒不恰 关注 李银河聊亲密关系这段值得每个人熟读并背诵 很久没听过这么实用的方法论分享了！ 看了李银河老师在@about编辑部新书《有余地的生活》的对谈，不但解答了很多关于亲密关系的疑惑，还给出了很多实用的方法。 我以前对于爱情的理解是：两个人既然相爱，那就要互相坦诚、事事报备，要一起看电影、听音乐、逛街、吃美食，我们要成为对方的唯一。 但实际进入亲密关系后就会发现，激情会褪去，生活会归于平淡，对方会有自己的交友圈、生活习惯，也会有偶尔想要独处的时候。 时间久了，过于依赖伴侣的那一方就会开始患得患失，会慢慢丢掉自己的生活与思想。因为一旦自己的情感寄托在对方身上，我们就开始没有了自我，进而亲密关系也会开始变得岌岌可危。 对于这些，李银河老师在对谈中都给我们聊透了。 比如生活中出现哪些信号时，需要停下来好好沟通，重新进行规划了呢？ - 情绪上的冲突开始变多，总会因为某件事一直不停的争吵； - 需要一直不停的解释自己，证明我不是不爱你，哪怕我只是出去跟朋友喝了杯茶； - 生活中突然遭遇了大的冲击，带来了很多不确定性； 任何一段关系的发展都是从浓到淡，所以在这期间会有变化，一点也不奇怪，我们需要做的只是在好好沟通之后，经营好自己的生活就可以。 在亲密关系中拥有独立的人格，对生活保有热爱和独立思考，才能拥有一段真正成熟、健康的关系。 就像李银河老师说的那样： 理想关系是高度的信任和无话不谈，可以成为彼此的树洞。双方在价值、审美、各种兴趣爱好上都有共鸣，且互相欣赏。 你可以在客厅打游戏，我在房间追剧；你喜酸，我爱吃辣；你喜欢钓鱼，我爱宅家，但是我们需要帮忙的时候，对方又可以给予支持和陪伴。这种互相独立又互相理解、尊重和帮助的关系，也是我之追求。 #恋爱观 #女性成长 #女性力量 #女性智慧 #李银河 #有余地的生活 #about编辑部 #about关于 #情绪价值 #girltalk 08-13 安徽 加载中","text_same_as_description":true,"engagement":{"likes":"2110","collects":"1319","comments":"32"},"topics":["恋爱观","女性成长","女性力量","女性智慧","李银河","有余地的生活","about编辑部","about关于","情绪价值","girltalk"],"video_text":"","audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":32,"replies_scanned":10,"primary_pages":3,"reply_pages":4,"scope":"bounded_platform_hot_stream","truncated":false,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.24,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[{"index":1,"filename":"image_01.webp","text":"about 关于 @恰芒芒不恰 abo From小红书 如果一段关系 从一开始就以高度融合 为唯一的运行方式的话 那么一旦激情回落之后 关系就会立即面临危机 因此在最亲密的时候 为关系保留一点冷静或者疏离 并不是去削弱爱情 而是对关系的一种保护","width":1080,"height":1440,"size_bytes":176876,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241623/a74690152c4f62d51026384130400971/1040g008323q9tbd0n4005q8j7uqtubgpp2cq510!nd_dft_wlteh_webp_3"},{"index":2,"filename":"image_02.webp","text":"bout 关于 @恰芒芒不恰 From小红书 关于 我觉得给对方留点空间 在很多情况下 确实是能起到延缓 甚至是防止关系崩溃的作用 为关系提供了一个缓冲带 另外留给个人的一点点空间 要有好几个维度共同组成的","width":1080,"height":1440,"size_bytes":146990,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241623/f607572aa3a5155ef1a6278481abff43/1040g008323q9tbd0n40g5q8j7uqtubgpi7sr0ag!nd_dft_wlteh_webp_3"},{"index":3,"filename":"image_03.webp","text":"about 时间维度 01 关于 @恰芒芒不恰 From小红书 关于 第一个是时间的维度 两个人关系当中 被默认允许的独处的时间 而不是说要求全天候同步 第二个是空间的维度 包括各自的活动范围私人空间 独立生活的安排 允许在某个时候某时段 不共享同一个空间或者是生活节奏 比如他另外有爱好 他爱听音乐会我不爱听","width":1080,"height":1440,"size_bytes":171552,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241623/71fc5a47bf319f6322a6c71c4a10601d/1040g008323q9tbd0n4105q8j7uqtubgp6dvnq40!nd_dft_wlteh_webp_3"},{"index":4,"filename":"image_04.webp","text":"about 时间维度 01 关于 空间维度 02 情绪维度 03 @恰芒芒不恰 From小红书 关于 第三个是情绪的维度 并不是所有的情绪问题 都必须立刻在这个关系当中把它处理掉 要允许情绪延后消化 通过其他的方式来调节 而不是全部都倾倒给伴侣 第四个是社交维度 就是两个人的关系之外的 朋友兴趣社会角色 也不应当被压缩 你可以自己去交你的朋友","width":1080,"height":1440,"size_bytes":179500,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241623/877a13624df959a67a772d3ce279c67d/1040g008323q9tbd0n41g5q8j7uqtubgpb5vver0!nd_dft_wlteh_webp_3"},{"index":5,"filename":"image_05.webp","text":"about 时间维度 关于 空间维度 情绪维度 @恰芒芒不恰 社交维度 From小红书 心理和认知维房 关于 第五个是心理和认知的维度 彼此都承认对方 有不被完全理解 不被完全透明的部分 在恋爱初期 人类天然地有融合的冲动 这是爱情最本真的状态 人在恋爱中会渴望确认 渴望回应 希望和对方是高度地贴近 这个是爱情自然的属性","width":1080,"height":1440,"size_bytes":210814,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241623/d38b649a71428e9dc2c743fc183a19ad/1040g008323q9tbd0n4205q8j7uqtubgpech11sg!nd_dft_wlteh_webp_3"},{"index":6,"filename":"image_06.webp","text":"about 关于 @恰芒芒不恰 From小红书 abo 如果一段关系 从一开始就以高度融合 为唯一的运行方式的话 那么一旦激情回落之后 关系就会立即面临危机 因此在最亲密的时候 为关系保留一点冷静或者疏离 并不是去削弱爱情 而是对关系的一种保护","width":1080,"height":1440,"size_bytes":175880,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241623/ef28373b6a71cdb209cac596dee9bd6f/1040g008323q9tbd0n42g5q8j7uqtubgphd4fqjo!nd_dft_wlteh_webp_3"},{"index":7,"filename":"image_07.webp","text":"@恰芒芒不恰 From小红书 这里面必须要强调一个前提 给对方留有的空间不是秘密 更不是不忠 而是我不需要通过控制你 来确认你属于我 在最亲密的时候 主动为关系降一点温 不是疏离 而是为长期稳定所做的理性安排","width":1080,"height":1440,"size_bytes":185914,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241623/a98725231175e6b3bc036cbef49cd0f2/1040g008323q9tbd0n4305q8j7uqtubgpvor6ang!nd_dft_wlteh_webp_3"},{"index":8,"filename":"image_08.webp","text":"about 关于 @恰芒芒不恰 From小红书 生活中出现哪些信号时，需要停下来 好好沟通，重新进行规划了呢？ 比如第一个信号就是 情绪冲突明显增多 某个争吵的主题反复出现 比如说围绕着时间分配 回应的速度社交边界 要不断地争执的话 这个时候就是需要重新沟通 和调整规则的时候了","width":1080,"height":1440,"size_bytes":190666,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241623/ca1adc00a7f05af425360bfab398bf36/1040g008323q9tbd0n43g5q8j7uqtubgpld44mkg!nd_dft_wlteh_webp_3"},{"index":9,"filename":"image_09.webp","text":"about 关于 @恰芒芒不恰 From小红书 第二个就是 需要频繁地解释自己 或者反复证明我不是不爱你了 只不过就是跟这个人去喝茶而已 他就是老得解释 老得证明我没变心没变心 第三个信号就是 生活条件发生明显变化的时候 比如说失业了 突发疾病了","width":1080,"height":1440,"size_bytes":171120,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241623/5be31190532eb41c0f2427e27345cfaa/1040g008323q9tbd0n4405q8j7uqtubgp9hpdhrg!nd_dft_wlteh_webp_3"},{"index":10,"filename":"image_10.webp","text":"about 关于 @恰芒芒不恰 abo From小红书 这些外部的冲击 带来的就不仅是现实层面的压力 也伴随着强烈的不确定性 要根据双方的实际情况 重新讨论空间的模式和具体的方式 所以这个外部冲击 真正考验到的并不是亲密关系 能不能变得更紧密 而是它能不能在 高度不稳定的情境当中 依然为个体保留独立的空间","width":1080,"height":1440,"size_bytes":178294,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241623/1b03a931453f102684eca5621ab18e0e/1040g008323q9tbd0n44g5q8j7uqtubgpverdqho!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-24T08:26:15.844471+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"李银河关于亲密关系中保留个人空间的方法论，包括时间、空间、情绪、社交、心理认知五个维度，以及需要重新沟通的信号。"},"target_audience":{"label":"针对什么人 / 场景","summary":"处于亲密关系中感到过度依赖或失去自我的人，或对关系维护方法感兴趣的读者。"},"user_need":{"label":"用户主要问题或需求","summary":"解决亲密关系中激情消退后关系危机、过度依赖导致失去自我、以及如何平衡独立与亲密的问题。"},"content_structure":{"label":"内容怎么展开","summary":"先以个人经历引出常见困惑，再引用李银河对谈内容，分五个维度阐述保留空间的具体做法，最后列出需要重新沟通的三个信号。"},"solution":{"label":"给了什么解决办法","summary":"内容给出了明确办法：在亲密关系中主动保留时间、空间、情绪、社交、心理认知五个维度的个人空间，并识别情绪冲突增多、频繁解释自己、生活条件变化等信号时进行重新沟通和规划。"},"references":{"label":"值得参考什么","summary":"李银河在@about编辑部新书《有余地的生活》中的对谈内容，以及图片中引用的具体观点。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸做具体案例分享，如不同维度空间的实际操作示例；或制作信号识别清单，帮助用户自查关系状态。"}},"source_labels":["封面标题","文字标题","作品描述","图片 OCR","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "?×?", "cover": null, "taskId": "f69e5eb15a7d", "topics": ["恋爱观", "女性成长", "女性力量", "女性智慧", "李银河", "有余地的生活"], "account": {"url": "https://www.xiaohongshu.com/user/profile/69133fb50000000037032e19", "name": "恰芒芒不恰", "followers": 1340}, "aiModel": "deepseek-v4-flash", "duration": null, "platform": "xiaohongshu", "coverFrom": null, "mainTopic": "李银河关于亲密关系中保留个人空间的方法论，包括时间、空间、情绪、社交、心理认知五个维度，以及需要重新沟通的信号。", "mediaType": "image_post", "coverLocal": false, "engagement": {"likes": "2110", "collects": "1319", "comments": "32", "likesNum": 2110, "collectsNum": 1319, "commentsNum": 32}, "topicCount": 10, "generatedAt": "2026-08-24T08:26:15.844471+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": false, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": 32, "transcriptChars": 0}	2026-08-25 08:22:43.976607+00	\N
190	f772530c0c4f	xiaohongshu	9	{"schema_version":9,"task_id":"f772530c0c4f","source_url":"https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"archive","collection_mode_label":"完整归档","storage":{"policy":"persistent","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"NPD有一个藏不住的语言习惯","description":"","cover_title":"NPD有一个藏不住的语言习惯","cover_title_meta":{"text":"NPD有一个藏不住的语言习惯","confidence":0.995,"font_ratio":2.76,"line_count":3,"source_image_index":1},"post_title":"NPD有一个藏不住的语言习惯","post_description":"","display_title":"NPD有一个藏不住的语言习惯","author":"枕书凉.","account":{"name":"枕书凉.","profile_url":"https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01","bio":"8️⃣年心理研究专家\\n擅长分析情感困惑，带你理性恋爱\\n🉑  1v1文字or语音☎️ （非公益）咨-询\\n亲密关系/自我提升/关系修复","following_count":"0","follower_count":"230","likes_and_collections_count":"9807"},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 枕书凉. 关注 1/8 枕书凉. 关注 NPD有一个藏不住的语言习惯 #我重新相信相亲角了 #贵族 #npd #光子嫩肤 #股票 #高尔夫 #留学生 #这个夏天造点啥 08-01 湖北 加载中","text_same_as_description":false,"engagement":{"likes":"1285","collects":"944","comments":"283"},"topics":["我重新相信相亲角了","贵族","npd","光子嫩肤","股票","高尔夫","留学生","这个夏天造点啥"],"video_text":"","audio_text":"","comments":[{"id":"6a72cbc6000000002901b106","type":"reply","author":"momo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/645b7f257b3e7e60e53504de.jpg?imageView2/2/w/120/format/jpg","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"created_at":1785908166000,"reply_count":0,"parent_comment_id":"6a721851000000002a02fe66","reply_to_author":"Momooo","parent_excerpt":"Npd绝对不会轻易夸人"},{"id":"6a6f0f5800000000150176b2","type":"comment","author":"水枪装尿呲谁谁叫","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31gureq033s005n0nfs3hap3732d8ot8?imageView2/2/w/120/format/jpg","text":"正常人：你这个不会？\\nnpd：你连这个都不会？","like_count":118,"created_at":1785663321000,"reply_count":16,"parent_comment_id":"","reply_to_author":""},{"id":"6a721851000000002a02fe66","type":"comment","author":"Momooo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31spc96te5s6g5q955grsl8jntuvp62o?imageView2/2/w/120/format/jpg","text":"Npd绝对不会轻易夸人","like_count":68,"created_at":1785862226000,"reply_count":28,"parent_comment_id":"","reply_to_author":""},{"id":"6a70d570000000000403afdf","type":"comment","author":"夏熙cc惜夏","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/635fa744a38044a4446559d9.jpg?imageView2/2/w/120/format/jpg","text":"你说：今天天气好热啊！\\n对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"created_at":1785779568000,"reply_count":10,"parent_comment_id":"","reply_to_author":""},{"id":"6a6eb60c0000000015015722","type":"comment","author":"Leo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/5fd23174f18f4f0001f720d1.jpg?imageView2/2/w/120/format/jpg","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"created_at":1785640460000,"reply_count":1,"parent_comment_id":"","reply_to_author":""}],"comment_summary":{"threshold":20,"limit":5,"returned":5,"scanned":110,"replies_scanned":80,"primary_pages":3,"reply_pages":17,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.837,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":true,"stable_pages":2},"images":[{"index":1,"filename":"image_01.webp","text":"NAME You are everything tome,and Iwas so blessed whenGodsentyouhereforme. --枕书凉-- NPD有一个 藏不住 的语言习惯 今天教你们一个识破NPD的绝招：不用看 他对你多好，不用听他表白的多甜，就看 他怎么说话。 我研究了上千个NPD案例，发现他们有一 个藏不住的语言习惯，就是他们永远不会 用关心的方式开启对话，只会用审判的方 式质问。","width":1080,"height":1440,"size_bytes":104984,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/6067cd4c0535d544ed9a16b93e1c6e39/1040g0083239t0slnna5g5qhfo5o4030119ucv38!nd_dft_wlteh_webp_3"},{"index":2,"filename":"image_02.webp","text":"001@枕书凉 我给你举个例子，你就懂了。 正常人想知道你起床了没，会问：“你起床 了吗？”你吃饭了吗？” 这是开放式的关心，答案可以是yes，也可 以是n0 。 但NPD会怎么问？“你已经起来了？”“你已 经吃完了？” 发现没有？他们的提问里，根本没有“no” 这个选项。","width":1080,"height":1440,"size_bytes":82466,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/58006cad862c0c019a4f37d48a59838c/1040g0083239t0slnna3g5qhfo5o40301um8viv0!nd_dft_wlteh_webp_3"},{"index":3,"filename":"image_03.webp","text":"002@枕书凉 他们问的不是你的状态，而是在确认一个 预设：“你必须已经起来了。你必须已经吃 完了。你必须满足我的期待。” 02这背后藏着一个可怕的思维模式： 正常人提问，是想了解对方；NPD提问, 是想控制结果。 他们接受不了拒绝，接受不了不符合预 期。因为在他们的世界里，“你不顺从\\"=“你 攻击我”。 那当你说“没有，我还没起”的时候，会发生 什么？","width":1080,"height":1440,"size_bytes":113990,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/cbcbc63662e9e227be7048a6fb49508a/1040g0083239t0slnna4g5qhfo5o40301cs5j4so!nd_dft_wlteh_webp_3"},{"index":4,"filename":"image_04.webp","text":"003@枕书凉 低阶NPD当场破防：甩脸色、冷暴力、直 接骂你，“你什么毛病？都几点了还不起？” 高阶NPD更阴： 嘴上说着“没事没事，你睡吧”，但你明显能 感觉到气氛不对了。然后接下来，他会想 方设法解决你这个“拒绝”： 你没起床？他就在旁边制造噪音，让你睡 不着。 你拒绝他的观点？他就疯狂给你发视频、 发文章，直到你认可为止。","width":1080,"height":1440,"size_bytes":109634,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/43d3272aea99ce34eae660d85ce13add/1040g0083239t0slnna205qhfo5o40301940r130!nd_dft_wlteh_webp_3"},{"index":5,"filename":"image_05.webp","text":"004@枕书凉 你不想做的事？他会用各种方式让你觉得 “不做就是你的错”。 为什么？ 因为他们无法接受身边有任何人和自己不 一样。承认你的不同，意味着他的世界观 被挑战了；允许你拒绝，意味着他的自恋 受损了。 这就是为什么，正常人会内耗、会反思， NPD完全不会。 03正常人遇到不同意见，会想：是不是我 错了？是不是可以求同存异？","width":1080,"height":1440,"size_bytes":107596,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/413f285ae9fbf30119a3d64bbeddad3d/1040g0083239t0slnna105qhfo5o40301lr6vm5o!nd_dft_wlteh_webp_3"},{"index":6,"filename":"image_06.webp","text":"005@枕书凉 但NPD的脑子里只有一种程序：“你不听我 的，就是攻击我；你攻击我，我就必须消 灭你。” 他们的世界里，没有容纳，没有理解。承 认别人，等于否定自己。所以他们只能不 停地赢、不停地控制、不停地消灭所有“不 一样”。 这也是为什么，你会觉得NPD目的性特别 强，执行力特别强。 为了让你顺从他，他可以无所不用其极; 为了让你认错，他可以跟你耗三天三夜。 但你发现没有？","width":1080,"height":1440,"size_bytes":121262,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/685c3cb6047b6febb29d818bb976caae/1040g0083239t0slnna2g5qhfo5o403019knafm0!nd_dft_wlteh_webp_3"},{"index":7,"filename":"image_07.webp","text":"006@枕书凉 他们的目的，从来不是为了真正解决问 题，也不是为了让自己变得更好，只是为 了满足那个“我赢了”的感觉。 所以你会看到一种奇观：NPD十年如一日 地愚蠢，十年如一日地原地踏步。他们用 尽所有力气去控制别人，却没有一分力气 用来成长自己。 为什么？因为他们的能量，全部用来维持 自恋了，没有余力，去拓展世界观。 我是枕书凉，一个从回避型成长为安全型 的心理咨询师，从事回避型依恋，婚姻关 系，感情修复等咨询已有8年。让你们更懂 回避型，如果你们遇到感情问题，希望能 帮到你们","width":1080,"height":1440,"size_bytes":153898,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/573b1c5330a520bbb185cb8156c94fb3/1040g0083239t0slnna405qhfo5o403016pfpukg!nd_dft_wlteh_webp_3"},{"index":8,"filename":"image_08.webp","text":"007@枕书凉 如果你们的感情出现了以下几种情况，都 还有机会可以重归于好; 第一种：分开之后没有删除拉黑你，但 是态度很冷漠；写A 第二种：分开之后正常跟你聊天，但是 不愿意提及复合；写B 第三种：分开之后删除拉黑你，不愿沟 通态度决绝；写C 第四种：在一起经常吵架，或者对方经 常断联消失，消息电话不回。写D 有以上情况可以找我给你看看，我来帮你 从根本上解决你们的相处问题。","width":1080,"height":1440,"size_bytes":129020,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/69f321a31d3133d7125880dd0988c43c/1040g0083239t0slnna505qhfo5o40301nse5ft8!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"ok","model":"deepseek-v4-flash","generated_at":"2026-08-24T07:59:05.268358+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"NPD（自恋型人格障碍）的语言习惯特征，即用审判式质问而非关心式提问，并解释其背后的控制思维。"},"target_audience":{"label":"针对什么人 / 场景","summary":"对NPD感兴趣或怀疑身边人有NPD的普通网友，以及遇到感情问题、寻求关系修复建议的人群。"},"user_need":{"label":"用户主要问题或需求","summary":"用户希望识别NPD的隐蔽特征，理解其行为模式，并可能寻求解决或应对感情问题的方法。"},"content_structure":{"label":"内容怎么展开","summary":"内容从提出识别NPD的绝招开始，通过对比正常人与NPD的提问方式，分析NPD提问背后的控制思维，区分低阶和高阶NPD的反应，解释其思维模式，最后引出作者身份和咨询服务，并列出四种感情问题情境引导用户互动。"},"solution":{"label":"给了什么解决办法","summary":"内容未给出明确解决办法，但提供了识别NPD的语言习惯作为认知工具，并在结尾引导有感情问题的用户联系作者咨询。"},"references":{"label":"值得参考什么","summary":"作者自称研究了上千个NPD案例，并自述为心理咨询师，有8年相关咨询经验。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸做NPD其他语言习惯的识别、如何应对NPD的审判式提问、NPD与回避型依恋的区别、感情修复的具体案例分享等内容。"}},"source_labels":["封面标题","文字标题","图片 OCR","公开互动数据"]},"comments":{"status":"ok","message":"","sample_size":5,"items":{"main_questions":{"label":"大家主要在问什么","summary":"现有样本未形成明确结论。评论主要围绕NPD（自恋型人格障碍）的言语行为模式展开，但未直接提出明确问题。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"type":"reply"},{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":118,"type":"comment"},{"id":"6a721851000000002a02fe66","author":"Momooo","text":"Npd绝对不会轻易夸人","like_count":68,"type":"comment"}]},"high_frequency_needs":{"label":"高频需求","summary":"现有样本未形成明确结论。评论者多表达对NPD言语模式的观察或共鸣，但未直接提出需求。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"type":"reply"},{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":118,"type":"comment"}]},"worries":{"label":"最担心什么","summary":"现有样本未形成明确结论。评论者担忧NPD的贬低性言语和否定性回应，但未直接表达担忧。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"type":"reply"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},"unclear_points":{"label":"博主没讲清什么","summary":"现有样本未形成明确结论。","evidence_comments":[]},"key_comments":{"label":"哪些评论值得重点看","entries":[{"comment":{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"type":"reply"},"reason":"指出NPD夸人后常伴随贬低，揭示其言语模式中的矛盾性，获得高赞。"},{"comment":{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":118,"type":"comment"},"reason":"用对比方式生动展示NPD的贬低性回应，引发共鸣。"},{"comment":{"id":"6a721851000000002a02fe66","author":"Momooo","text":"Npd绝对不会轻易夸人","like_count":68,"type":"comment"},"reason":"直接断言NPD不会轻易夸人，提供不同视角。"},{"comment":{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},"reason":"具体举例说明NPD如何否定他人感受，具有代表性。"},{"comment":{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"},"reason":"指出NPD在对话中预设答案并试图绕回，揭示其控制性。"}]},"topic_extensions":{"label":"可以延伸什么选题","entries":[{"idea":"NPD的言语模式：如何识别和应对","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"type":"reply"},{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":118,"type":"comment"}]},{"idea":"NPD为何不轻易夸人：心理机制探讨","evidence_comments":[{"id":"6a721851000000002a02fe66","author":"Momooo","text":"Npd绝对不会轻易夸人","like_count":68,"type":"comment"}]},{"idea":"NPD如何否定他人感受：具体场景分析","evidence_comments":[{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},{"idea":"NPD对话中的控制策略：如何识别和应对","evidence_comments":[{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]}]}}}}}	{"size": "1080×1440", "cover": "http://sns-webpic-qc.xhscdn.com/202608241555/6067cd4c0535d544ed9a16b93e1c6e39/1040g0083239t0slnna5g5qhfo5o4030119ucv38!nd_dft_wlteh_webp_3", "taskId": "f772530c0c4f", "topics": ["我重新相信相亲角了", "贵族", "npd", "光子嫩肤", "股票", "高尔夫"], "account": {"url": "https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01", "name": "枕书凉.", "followers": 230}, "aiModel": "deepseek-v4-flash", "duration": null, "platform": "xiaohongshu", "coverFrom": null, "mainTopic": "NPD（自恋型人格障碍）的语言习惯特征，即用审判式质问而非关心式提问，并解释其背后的控制思维。", "mediaType": "image_post", "coverLocal": false, "engagement": {"likes": "1285", "collects": "944", "comments": "283", "likesNum": 1285, "collectsNum": 944, "commentsNum": 283}, "imageCount": 8, "imageFiles": [], "topicCount": 8, "generatedAt": "2026-08-24T07:59:05.268358+00:00", "aiVideoCount": 7, "commentsShown": 5, "hasTranscript": false, "platformLabel": "小红书", "aiCommentCount": 6, "commentsScanned": 110, "transcriptChars": 0}	2026-08-25 09:21:04.408365+00	\N
176	f90d29b0a27b	xiaohongshu	15	{"schema_version":15,"task_id":"f90d29b0a27b","source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251704/e311ac2f0961f3522764bd2742b83c75/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_dft_wlteh_jpg_3","duration_seconds":296.077,"width":1080,"height":1920,"size_bytes":35337961,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_b64":"（已落地为本地封面文件，原始 200271 字符）"}},"title":"女孩子无聊的本质是生命力的匮乏","description":"","cover_title":"女孩子无趣的本质是生命力的匮乏","cover_title_meta":{"text":"女孩子无趣的本质是生命力的匮乏","confidence":0.939,"font_ratio":1.31,"line_count":2,"lines":[{"text":"女孩子无趣的本质","confidence":0.998},{"text":"生命力的贵乏","confidence":0.88}],"source_image_index":1,"reference_corrected":true,"source":"video_cover"},"post_title":"女孩子无聊的本质是生命力的匮乏","post_description":"","display_title":"女孩子无趣的本质是生命力的匮乏","author":"可可拆爆款","account":{"name":"可可拆爆款","profile_url":"https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1","bio":"👩全网100W➕粉丝\\n🎉你却的不是方法，而是一个带你的人\\n🌲账号定位｜流量卡点｜爆款模板\\n🔗下方进👗","following_count":"1010","follower_count":"122838","likes_and_collections_count":"1149588"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"4万","collects":"3.2万","comments":"648"},"topics":["女孩子","女性智慧","女性成长","生命力","少女心事","girlstalk","本质","人生智慧"],"video_text":"[00:00] 女孩子无趣的本质\\n[00:01] 是生命力的匮乏\\n[00:03] 自己觉得越来越没有意思\\n[00:04] 请把这篇文章仔细看完\\n[00:06] 都适合看这篇文章的\\n[00:07] 如果你只是想要几个\\n[00:09] 让显得有趣的技巧\\n[00:10] 比如怎么接话\\n[00:11] 怎么聊天不冷场OK\\n[00:13] 那你可以划掉我了\\n[00:14] 但如果你有一种隐隐的感觉\\n[00:15] 好像活着活着\\n[00:16] 我自己变得越来越平\\n[00:18] 和人说话也没有什么好说的\\n[00:20] 独处时也找不到什么\\n[00:21] 真正让自己发光的东西\\n[00:23] 那这篇文章就是写给你的\\n[00:24] 我们来说一个很多人\\n[00:25] 都不敢承认的事实\\n[00:26] 叫做无趣\\n[00:27] 不是性格问题\\n[00:29] 那些\\n[00:30] 真正让人觉得无聊的女孩\\n[00:32] 往往不是因为她们沉默\\n[00:33] 而是她们内部空掉了\\n[00:35] 你坐在那里\\n[00:36] 笑得很得体\\n[00:37] 说话也没有失礼\\n[00:38] 但是就给人一种感觉\\n[00:39] 她好像没有在活着\\n[00:41] 眼神是漂浮的\\n[00:42] 热情是借来的\\n[00:43] 兴趣是假装的\\n[00:45] 这不是性格内向\\n[00:46] 这是生命力在悄悄流失\\n[00:48] 是从什么时候开始流失的呢\\n[00:50] 有一个概念叫做习得性无助\\n[00:53] 是斯坦福大学的心理学家\\n[00:54] 马丁格力塞尔\\n[00:56] 是斯坦心理学里心理学\\n[00:58] 心理学研究有个概念\\n[00:58] 是斯坦福心理学里心理学\\n[01:00] 叫做习得性无助\\n[01:01] 是斯坦福大学的心理学家\\n[01:03] 马丁塞利格曼\\n[01:05] 在长期研究中提出的\\n[01:06] 她说\\n[01:07] 当一个人在一个领域里\\n[01:08] 反复受挫\\n[01:09] 反复被否定\\n[01:10] 就会形成一种内在的信念\\n[01:12] 不管我做什么都没有用\\n[01:14] 最可怕的东西就在于\\n[01:16] 这种信念会蔓延\\n[01:17] 从一件事蔓延到整个\\n[01:18] 生活\\n[01:18] 从我不擅长这个\\n[01:19] 变成我不擅长任何事\\n[01:21] 从这件事情我失败了\\n[01:23] 变成我这个人本身就是失败的\\n[01:25] 然后就会出现一种症状\\n[01:26] 什么都提不起劲\\n[01:27] 没有特别想去做的事\\n[01:28] 没有特别想去的地方\\n[01:29] 没有特别喜欢的人\\n[01:30] 也没有特别在意的梦想\\n[01:31] 活着\\n[01:32] 就好像是在待机\\n[01:34] 那关键点来了啊\\n[01:36] 无趣的本质\\n[01:37] 是一个人和自己内在欲望的断联\\n[01:39] 你不是真的没有欲望\\n[01:41] 你只是慢慢学会不去感受它\\n[01:42] 因为感受之后会失望\\n[01:43] 会被否定\\n[01:44] 会被现实打脸\\n[01:46] 所以更安全的方式\\n[01:47] 是提前关掉那个开关\\n[01:49] 期待 不渴望 不热爱\\n[01:50] 不期待 不渴望 不热爱\\n[01:51] 看起来很平静\\n[01:52] 实则是生命力\\n[01:53] 在一点一点的露出去\\n[01:55] 而一个内部空掉的人\\n[01:56] 无论外表多精致\\n[01:58] 无论说话多礼貌\\n[01:59] 都很难真正的吸引人\\n[02:01] 也很难真正的被吸引\\n[02:02] 因为吸引的本质是能量\\n[02:04] 是那种活着在燃烧\\n[02:06] 对世界还有好奇心的能量\\n[02:08] 我见过很多这样的女孩啊\\n[02:10] 二0多岁大家上着还不错的班\\n[02:13] 长得很好看\\n[02:14] 说话也很得体\\n[02:15] 但是你跟她相处完之后\\n[02:16] 记不住她说了什么\\n[02:17] 她对什么真正的热情\\n[02:19] 她想说都行\\n[02:20] 你问她想做什么\\n[02:21] 她说随便\\n[02:22] 有没有什么想实现的事\\n[02:23] 她想了很久\\n[02:24] 说呃\\n[02:24] 其实也没有什么特别想的\\n[02:26] 那刻我突然很难过\\n[02:28] 我不是替她可怜\\n[02:29] 是替那个曾经也有过\\n[02:30] 欲望\\n[02:31] 和热情的小女孩\\n[02:33] 感到心疼\\n[02:34] 那些欲望没有消失\\n[02:35] 只是他们被压的太久了\\n[02:37] 慢慢的变得看不见了\\n[02:39] 那相反的人是什么呀\\n[02:41] 那种让人觉得哇\\n[02:42] 她好有趣\\n[02:43] 的女性\\n[02:44] 你有没有认真观察过\\n[02:45] 她们有什么共同点\\n[02:46] 不是因为她们更好笑\\n[02:47] 不是因为他们见识更广\\n[02:48] 不是因为他们天生外向\\n[02:49] 而是因为她们都有某种特质\\n[02:50] 叫做他们对某种事物\\n[02:51] 有着真实的\\n[02:53] 自己的感受\\n[02:54] 可能是某种食物\\n[02:55] 可能是某一个地方\\n[02:56] 可能是某一类书\\n[02:57] 也可能是某种手艺\\n[02:58] 不需要很多\\n[02:59] 甚至只需要一件\\n[03:00] 但那种热情是真实的\\n[03:01] 是从内往外涌的\\n[03:03] 而不是为了让别人觉得有趣\\n[03:05] 而表演出来的\\n[03:06] 而这就是生命力\\n[03:07] 那生命力是可以被找回来的吗\\n[03:09] 当然而且是有办法的\\n[03:11] 神经科学的研究已经证实\\n[03:12] 我们的大脑\\n[03:13] 其实具备很强的可塑性\\n[03:15] 即使是长期\\n[03:16] 处于低活跃状态的\\n[03:18] 也可以通过新的体验\\n[03:19] 和重复的行为\\n[03:20] 被重新激活\\n[03:21] 换句话说\\n[03:22] 那个曾经\\n[03:23] 对什么都有好奇心的自己\\n[03:24] 没有消失\\n[03:25] 只是睡着了\\n[03:26] 我们可以把它唤醒\\n[03:27] 那具体怎么做\\n[03:28] 去做一件没有用的事情\\n[03:30] 注意是没有用的\\n[03:31] 不是为了提高竞争力\\n[03:32] 不是为了填简历\\n[03:33] 不是为了让别人觉得哇\\n[03:34] 你好厉害\\n[03:36] 就是因为单纯的\\n[03:37] 觉得有点意思\\n[03:38] 可以是一种做饭的方法\\n[03:39] 你一直想学的东西\\n[03:40] 也可以是\\n[03:41] 某个从来没有去过的地方\\n[03:42] 可以是一本你之前翻了两页\\n[03:44] 哎就放下了书\\n[03:45] 不要去想它有没有意义\\n[03:46] 生命力的重启\\n[03:47] 往往从无用之事开始\\n[03:49] 第二步每天花五分钟\\n[03:50] 写今天\\n[03:51] 什么东西让我有新的感觉\\n[03:54] 就一句话\\n[03:55] 可以是情绪\\n[03:56] 可以是一个场景\\n[03:56] 可以是一种味道\\n[03:57] 可以是一段话\\n[03:58] 就是重新训练你的感受力\\n[04:00] 帮你重新学会感受\\n[04:02] 而不是麻木的过日子\\n[04:04] 第三步\\n[04:04] 给自己制造一点点陌生感\\n[04:06] 心理学研究发现\\n[04:07] 大脑在接触新奇事物时\\n[04:09] 会分泌多巴胺\\n[04:10] 而多巴胺正是驱使我们好奇\\n[04:11] 探索感受活着的关键物质\\n[04:14] 每周做一件从来没做过的小事\\n[04:16] 走一条没有走过的路\\n[04:17] 点一道从来没有吃过的菜\\n[04:18] 听一首完全不熟悉的音乐\\n[04:19] 不用太大\\n[04:20] 但要真实的去感受\\n[04:22] 生命力不是天赋\\n[04:23] 也不是性格\\n[04:24] 也不是某种你要么有\\n[04:25] 要么没有的东西\\n[04:27] 它是一个需要被滋养的东西\\n[04:28] 我们中的很多人\\n[04:30] 其实在成长的过程中\\n[04:31] 被告诉说不要太有想法\\n[04:34] 不要太敏感\\n[04:35] 不要表现的太渴望\\n[04:36] 要懂事\\n[04:37] 要乖平稳要稳定\\n[04:39] 于是我们慢慢就变成了一个\\n[04:41] 不太有想法\\n[04:42] 不太敏感\\n[04:43] 不太渴望什么的人\\n[04:44] 看起来成熟了\\n[04:45] 实则呢\\n[04:46] 是把生命力给训练掉了\\n[04:48] 但今天你看到了这一点\\n[04:49] 说明那个有生命力的你还在\\n[04:51] 她只是在等一个人\\n[04:53] 可以重新活的有热情一点吗","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":6,"chunks_succeeded":6,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T09:09:45.154752+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要讨论‘女孩子无趣的本质是生命力的匮乏’，将无趣归因于内在生命力流失，而非性格问题。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对感到自己越来越无趣、生活平淡、缺乏热情和内在动力的女性，尤其是那些在社交或独处中感到空虚的年轻女性。"},"user_need":{"label":"用户主要问题或需求","summary":"用户的核心需求是理解自己为何变得无趣，并希望找回内在的热情和生命力，而非仅仅学习表面社交技巧。"},"content_structure":{"label":"内容怎么展开","summary":"内容从提出问题（无趣是生命力匮乏）开始，引入心理学概念（习得性无助）解释原因，再对比有趣女性的特质，最后给出具体方法。"},"solution":{"label":"给了什么解决办法","summary":"给出了三步具体方法：做一件‘无用’的事、每天花五分钟记录新感受、每周制造一点陌生感（如走新路、尝新菜）。"},"references":{"label":"值得参考什么","summary":"值得参考的是内容中引用的心理学概念（习得性无助）和神经科学观点（大脑可塑性、多巴胺与新奇感），以及其对比分析（无趣vs有趣女性的特质）。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做‘如何具体执行三步方法’的实操指南、‘习得性无助’的科普解读、‘女性成长与生命力’的系列内容，或‘真实案例分享’等。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251704/e311ac2f0961f3522764bd2742b83c75/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_dft_wlteh_jpg_3", "taskId": "f90d29b0a27b", "topics": ["女孩子", "女性智慧", "女性成长", "生命力", "少女心事", "girlstalk"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1", "name": "可可拆爆款", "followers": 122838}, "aiModel": "deepseek-v4-flash", "duration": "4分56秒", "platform": "xiaohongshu", "coverFrom": "inline", "mainTopic": "这条内容主要讨论‘女孩子无趣的本质是生命力的匮乏’，将无趣归因于内在生命力流失，而非性格问题。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "4万", "collects": "3.2万", "comments": "648", "likesNum": 40000, "collectsNum": 32000, "commentsNum": 648}, "imageCount": 0, "imageFiles": [], "topicCount": 8, "generatedAt": "2026-08-25T09:09:45.154752+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 3707}	2026-08-25 09:21:00.094163+00	9a56249d92573157cb568c817dfed03c3ef89b01.jpg
195	b36f1b924b66	xiaohongshu	15	{"schema_version":15,"task_id":"b36f1b924b66","source_url":"https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251704/c5f783a389998530e7b56ff71b1626ac/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_prv_wlteh_jpg_3","duration_seconds":458.306,"width":1080,"height":1920,"size_bytes":61079166,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_b64":"（已落地为本地封面文件，原始 150335 字符）"}},"title":"看完痴迷，发现最恐怖的是无色无味老实人？","description":"心理学的脆弱型自恋者，望周知～","cover_title":"脆弱型自恋患者","cover_title_meta":{"text":"脆弱型自恋患者","confidence":0.996,"font_ratio":1.57,"line_count":1,"lines":[{"text":"脆弱型自恋患者","confidence":0.996}],"source_image_index":1,"source":"video_cover"},"post_title":"看完痴迷，发现最恐怖的是无色无味老实人？","post_description":"心理学的脆弱型自恋者，望周知～","display_title":"脆弱型自恋患者","author":"治愈果（kakki在说啥）","account":{"name":"治愈果（kakki在说啥）","profile_url":"https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266","bio":"🐳百万粉丝心理创作者｜心理师\\n🐳累计500+小时个案\\n🐳Queen Mary 法学硕士🇬🇧 \\n🐳亲密关系｜终身成长：zhiyuguo820\\n@愈果 YU GUO","following_count":"104","follower_count":"162886","likes_and_collections_count":"1232628"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"784","collects":"349","comments":"75"},"topics":["痴迷","治愈果","心理学","惊悚片","自恋"],"video_text":"[00:00] 本人是一个恐怖电影爱好者\\n[00:02] 豆瓣的高分恐怖片清单\\n[00:04] 我基本上都刷了一个遍\\n[00:06] 最近\\n[00:07] 在海外有一部爆火的电影叫做《痴迷》\\n[00:09] 刚刚也在内地院线上映了\\n[00:10] 本人已经看完了\\n[00:12] 看完以后真的表示非常的兴奋\\n[00:14] 因为我觉得它不仅吓到我了\\n[00:16] 它也笑到我了\\n[00:17] 甚至有点惊艳到我了\\n[00:19] 我已经准备去电影院再二刷一次了\\n[00:21] 但我想要专门出一期视频\\n[00:23] 不只是因为它好看\\n[00:24] 而是因为\\n[00:25] 我觉得这个题材实在是太特别了\\n[00:27] 它不是那种传统意义上的鬼怪恐怖\\n[00:30] 而是把亲密关系\\n[00:31] 拍成了心理恐怖片的电影\\n[00:34] 可以说是刚好切到了我的内容赛道\\n[00:36] 所以想要先给大家推荐介绍一下剧情\\n[00:39] 男主贝尔是一个非常平凡\\n[00:41] 自卑又对爱情充满执念的一个男青年\\n[00:45] 他呢偶然听说了\\n[00:46] 小镇上有一个关于心愿柳的一个传说\\n[00:49] 是那种把柳条柳枝折断了\\n[00:52] 许个愿然后愿望就能实现\\n[00:54] 他有一天就去商店里面买了买了这个柳条\\n[00:55] 许愿\\n[00:56] 自己暗恋的女孩Nikki能够爱上自己\\n[00:59] OK 愿望成真了\\n[01:00] 两个人真的走到一起了\\n[01:03] 但是很快就发现 被召唤来的真的不是纯粹的爱情\\n[01:06] 而是纯纯的恐怖\\n[01:08] 女主被夺舍了 然后发了疯一样的爱上了男主贝尔\\n[01:12] 占有 控制 几乎惊恐到了变态的程度\\n[01:16] 而这部电影 我觉得它最讽刺的地方就是\\n[01:18] 它在用一种非常之极端的方式 拍出了很多人在亲密关系里面\\n[01:24] 既要 又要 还要\\n[01:25] 我看到一个非常有意思的影评\\n[01:27] 当然有点尖锐\\n[01:27] 男主属于是既要0元购又想免费退 占完便宜还想跑\\n[01:33] 就发现自己又跑不掉了 就开始害怕了\\n[01:35] 可是正当他要付出代价的时候 他又舍不得了”\\n[01:38] 这个就很像是感情里的某一部分人\\n[01:42] 喜欢漂亮的姑娘 但是又要对方只爱自己\\n[01:45] 喜欢独立的人 但又希望对方能够粘着自己\\n[01:48] 那对方太粘了 又嫌他不给自己空间\\n[01:51] 那对方开始真的有自我了 自信放光芒了 又觉得没有安全感了\\n[01:55] 不少不管男女\\n[01:56] 不少不管是男女\\n[01:57] 这个世界上哪里有这么好的事情\\n[01:59] 你想得到到底是伴侣\\n[02:00] 还是一个既能满足你所有需求\\n[02:02] 又不需要你承担任何代价的\\n[02:04] 人型许愿机？\\n[02:07] 我觉得这部电影它更厉害的地方在于\\n[02:09] 它拍出了一种\\n[02:10] 非常容易被大家忽略的人物类型\\n[02:13] 叫做脆弱型自恋者\\n[02:15] 从人格心理学和临床研究的角度来说\\n[02:18] 自恋存在两种稳定的维度\\n[02:21] 大家都很熟悉\\n[02:23] 也是网上最常看到的那种NPD的类型\\n[02:26] 脆弱型自恋\\n[02:28] 这是一种非常之隐蔽的自恋\\n[02:30] 大家都不太了解\\n[02:32] 像男主贝尔\\n[02:33] 他表面上很害羞\\n[02:34] 很自卑很老实\\n[02:35] 甚至还有一点点可怜\\n[02:36] 你是不是就很容易觉得\\n[02:38] 他是一个不太喜欢表达\\n[02:40] 但是挺善良的一个普通人\\n[02:42] 但如果你仔细看电影\\n[02:44] 你们会发现\\n[02:44] 其实这个不是单纯的内向\\n[02:46] 更不是什么温柔\\n[02:47] 他是那种“无色无味的剧毒老实人”\\n[02:50] 他的自恋不是那种高高在上\\n[02:52] 夸夸其谈的自恋\\n[02:54] 而是一种隐藏在不行动不付出\\n[02:54] 而是一种藏在不行动不付出\\n[02:56] 不表态和退缩背后的自恋\\n[02:59] 你就看他向心愿柳留许的愿望是什么嘛\\n[03:02] 不是那种请给我勇气去表白吧\\n[03:05] 也不是请让我有机会了解我的女神吧\\n[03:08] 而是直接要求让Nikki爱上我\\n[03:11] 胜过爱世界上任何一个人\\n[03:13] 你们细品\\n[03:14] 就这个愿望\\n[03:16] 它的背后就说明了\\n[03:16] 他其实想要的\\n[03:17] 根本就不是一段真实的关系\\n[03:19] 或者说这个人他对关系就是有一种错误的理解\\n[03:21] 他要的是一种究极的排他\\n[03:23] 是一种绝对的优先\\n[03:25] 是一种无条件围绕他运转\\n[03:27] 但又不提要求的爱\\n[03:29] 但真正的爱是这样吗\\n[03:30] 不是的\\n[03:32] 真正的爱应该是是我走向你\\n[03:33] 我了解你\\n[03:35] 我知道你的喜好\\n[03:36] 我付出一些爱的行为\\n[03:38] 然后我尊重你的选择\\n[03:39] 而这个男主的爱是跳过了了解\\n[03:41] 追求甚至是对方的意愿\\n[03:43] 直接让对方变成了自己的所有物\\n[03:45] 而且是独一无二的\\n[03:46] 这就根本就不是爱\\n[03:47] 这个是恐怖片\\n[03:49] 因为他关注的始终是她为什么不爱我\\n[03:51] 我怎么样才能得到她\\n[03:52] 而不是她真正需要什么\\n[03:54] 她的梦想是什么\\n[03:55] 她喜欢什么\\n[03:56] 以及她愿不愿意\\n[03:57] 而且这个电影\\n[03:58] 还有很多细节都在说明这一点\\n[04:00] 他对他死去的猫是非常冷漠的\\n[04:03] 那个猫咪刚刚离世\\n[04:04] 他就可以出去跟别人吃喝玩乐\\n[04:06] 心里就想着\\n[04:07] 是要不要表白这一类的事情\\n[04:08] 又比如说这个男主\\n[04:09] 他对一直都暗恋他\\n[04:11] 关心他的朋友同事\\n[04:13] 也是那种非常习惯性的\\n[04:15] 接受对方的好意\\n[04:16] 但是却从来没有想过\\n[04:17] 真正付出一点相对等的回应\\n[04:19] 就这种人\\n[04:20] 他真的可能不一定会在现实生活中\\n[04:23] 主动的去伤害你\\n[04:24] 但是这样的人\\n[04:25] 你一旦跟他进入关系\\n[04:27] 他一定一定会索取很多\\n[04:29] 他会索取关注照顾\\n[04:30] 索取情绪价值\\n[04:31] 但他却会很少真正看见别人\\n[04:35] 就是他用不行动来保护自己\\n[04:37] 很多人会觉得\\n[04:38] 脆弱型自恋者是因为自尊太低\\n[04:40] 所以不太敢行动\\n[04:42] 但其实恰恰相反哦\\n[04:44] 他们内心往往有一种非常强烈的自尊\\n[04:46] 但这种自尊\\n[04:47] 他不是强大\\n[04:48] 而是强烈\\n[04:49] 甚至可以说这种自尊他太脆弱了\\n[04:50] 这种自尊\\n[04:51] 他太脆弱了\\n[04:52] 因为他们这种人\\n[04:53] 他们就很害怕被拒绝\\n[04:54] 很害怕失败\\n[04:55] 很害怕现实证明自己没有那么特别\\n[04:57] 所以就干脆不表白了\\n[04:58] 就不努力了\\n[04:59] 因为这样就不承担风险\\n[05:00] 毕竟只要不行动\\n[05:02] 就永远不会被现实检验出所谓的结果\\n[05:05] 当然啊这我一定要强调\\n[05:07] 不要因为一个人内向害羞或者社恐\\n[05:10] 就随随便便给人家贴上一个什么\\n[05:12] 剧毒老好人的标签和NPD的标签\\n[05:15] 没有这回事儿\\n[05:16] 内向和自恋\\n[05:17] 是完完全全的独立存在的两种事情\\n[05:20] 两回事\\n[05:21] 而真正害羞但是又同时善良的人\\n[05:24] 他们一定会\\n[05:25] 看到对方的\\n[05:26] 一定会记得对方说过的话\\n[05:27] 一定会付出关心的行为\\n[05:28] 也会在被拒绝之后\\n[05:30] 下一次想着\\n[05:31] 我应该尊重别人的边界\\n[05:33] 他不会把自己的喜欢\\n[05:35] 当成对方必须回应的义务\\n[05:36] 但是脆弱型自恋者可不一样哦\\n[05:38] 他们不一定是张牙舞爪的\\n[05:40] 甚至他们是内向的\\n[05:42] 害羞的甚至是无害的\\n[05:43] 但是他在关系里\\n[05:45] 一定会持续的表现出\\n[05:46] 那种以自我为中心的情感\\n[05:47] 索取和逃避责任\\n[05:49] 以及躲避后果\\n[05:51] 他想要的不是你\\n[05:52] 而是你证明我值得被爱\\n[05:54] 而这个电影真正恐怖的地方也在这儿\\n[05:56] 当Nikki因为贝尔的许愿被夺舍之后\\n[05:59] 失去自我\\n[06:00] 折磨到已经几乎不成人形的时候\\n[06:03] 她在半夜的时候\\n[06:04] 短暂恢复意识的那几分钟\\n[06:06] 她非常痛苦的哀求着男主贝尔\\n[06:09] 她说你杀了我吧\\n[06:11] 我求求你了\\n[06:12] 你让我解脱吧\\n[06:13] 结果你们知道男主说了句什么吗\\n[06:14] 男主说：和我在一起到底有什么不好\\n[06:18] 我靠就这句话出来\\n[06:20] 我相信电影院一定是一片哗然的\\n[06:23] 因为在那一刻\\n[06:24] 经历了那么多恐怖的事情之后\\n[06:26] 他看到的还是仍然不是对方的痛苦\\n[06:29] 而是自己的委屈\\n[06:30] 她不成人形了\\n[06:32] 她在求救了\\n[06:33] 但这个男生还在想\\n[06:34] 我都给你我的爱了\\n[06:35] 你到底有什么不满意呀\\n[06:36] 你们看\\n[06:37] 这个就是极端自我的人最可怕的地方\\n[06:40] 因为在他们的世界里\\n[06:41] 伴侣不是一个有感受有想法\\n[06:44] 有喜怒哀乐有意志的人\\n[06:45] 而是一个应该满足自己配合自己\\n[06:48] 证明自己的工具角色\\n[06:51] 所以我真的觉得《痴迷》\\n[06:52] 表面上它讲的是一个什么禁忌\\n[06:54] 许愿的一个恐怖故事\\n[06:56] 但其实\\n[06:56] 他讲的是亲密关系里的恐怖故事\\n[06:59] 强制爱别人不会有什么好下场的\\n[07:01] 以及爱一旦只想着满足自己的话\\n[07:04] 就一定伴随着抹杀对方\\n[07:06] 真正健康的爱\\n[07:07] 不是对方完全符合你的期待\\n[07:09] 而是你能看到ta是一个独立的人\\n[07:11] ta有自己的痛苦边界和选择\\n[07:14] 也有不围着你转的权利\\n[07:16] 讲真的这部电影\\n[07:18] 把恐怖喜剧和情感的议题结合的非常好\\n[07:21] 它吓人但又不只是吓人\\n[07:23] 它荒诞但又特别现实\\n[07:25] 我真的希望这样的作品\\n[07:27] 被更多的人看到\\n[07:29] 但是这个人一定是大胆的人\\n[07:30] 如果大家很胆小\\n[07:31] 就不要去看了\\n[07:32] 因为这个电影真的是蛮恐怖的\\n[07:34] 好了今天的分享就到这了\\n[07:35] 我们下期再见啦拜拜","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":8,"chunks_succeeded":8,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T09:09:47.270396+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对对心理学、亲密关系议题感兴趣的人群，以及恐怖电影爱好者或关注情感关系问题的观众。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能希望了解电影《痴迷》的看点，同时理解“脆弱型自恋者”这一隐蔽人格类型，以及如何在亲密关系中识别和应对类似行为。"},"content_structure":{"label":"内容怎么展开","summary":"内容先以个人观影体验引入，接着介绍电影剧情，然后通过影评和心理学概念分析角色行为，最后总结电影主题并给出观影建议。"},"solution":{"label":"给了什么解决办法","summary":"内容未给出明确解决办法，但通过分析脆弱型自恋者的行为模式，提醒观众在亲密关系中注意识别类似特征，并强调健康爱的关系应尊重对方独立性。"},"references":{"label":"值得参考什么","summary":"值得参考电影《痴迷》的剧情设定和影评观点，以及心理学中关于自恋两种维度（显性自恋和脆弱型自恋）的区分。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸制作关于脆弱型自恋者与内向性格的区别、亲密关系中的边界设定、或电影中其他心理学元素的解读等内容。"}},"source_labels":["封面标题","文字标题","作品描述","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251704/c5f783a389998530e7b56ff71b1626ac/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_prv_wlteh_jpg_3", "taskId": "b36f1b924b66", "topics": ["痴迷", "治愈果", "心理学", "惊悚片", "自恋"], "account": {"url": "https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266", "name": "治愈果（kakki在说啥）", "followers": 162886}, "aiModel": "deepseek-v4-flash", "duration": "7分38秒", "platform": "xiaohongshu", "coverFrom": "inline", "mainTopic": "这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "784", "collects": "349", "comments": "75", "likesNum": 784, "collectsNum": 349, "commentsNum": 75}, "imageCount": 0, "imageFiles": [], "topicCount": 5, "generatedAt": "2026-08-25T09:09:47.270396+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 4766}	2026-08-25 09:20:49.338864+00	c37c2d3a0081e1cff187b2a71f0cf6802968ffc5.jpg
200	f772530c0c4f	xiaohongshu	9	{"schema_version":9,"task_id":"f772530c0c4f","source_url":"https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"archive","collection_mode_label":"完整归档","storage":{"policy":"persistent","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"NPD有一个藏不住的语言习惯","description":"","cover_title":"NPD有一个藏不住的语言习惯","cover_title_meta":{"text":"NPD有一个藏不住的语言习惯","confidence":0.995,"font_ratio":2.76,"line_count":3,"source_image_index":1},"post_title":"NPD有一个藏不住的语言习惯","post_description":"","display_title":"NPD有一个藏不住的语言习惯","author":"枕书凉.","account":{"name":"枕书凉.","profile_url":"https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01","bio":"8️⃣年心理研究专家\\n擅长分析情感困惑，带你理性恋爱\\n🉑  1v1文字or语音☎️ （非公益）咨-询\\n亲密关系/自我提升/关系修复","following_count":"0","follower_count":"230","likes_and_collections_count":"9807"},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 枕书凉. 关注 1/8 枕书凉. 关注 NPD有一个藏不住的语言习惯 #我重新相信相亲角了 #贵族 #npd #光子嫩肤 #股票 #高尔夫 #留学生 #这个夏天造点啥 08-01 湖北 加载中","text_same_as_description":false,"engagement":{"likes":"1285","collects":"944","comments":"283"},"topics":["我重新相信相亲角了","贵族","npd","光子嫩肤","股票","高尔夫","留学生","这个夏天造点啥"],"video_text":"","audio_text":"","comments":[{"id":"6a72cbc6000000002901b106","type":"reply","author":"momo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/645b7f257b3e7e60e53504de.jpg?imageView2/2/w/120/format/jpg","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"created_at":1785908166000,"reply_count":0,"parent_comment_id":"6a721851000000002a02fe66","reply_to_author":"Momooo","parent_excerpt":"Npd绝对不会轻易夸人"},{"id":"6a6f0f5800000000150176b2","type":"comment","author":"水枪装尿呲谁谁叫","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31gureq033s005n0nfs3hap3732d8ot8?imageView2/2/w/120/format/jpg","text":"正常人：你这个不会？\\nnpd：你连这个都不会？","like_count":118,"created_at":1785663321000,"reply_count":16,"parent_comment_id":"","reply_to_author":""},{"id":"6a721851000000002a02fe66","type":"comment","author":"Momooo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31spc96te5s6g5q955grsl8jntuvp62o?imageView2/2/w/120/format/jpg","text":"Npd绝对不会轻易夸人","like_count":68,"created_at":1785862226000,"reply_count":28,"parent_comment_id":"","reply_to_author":""},{"id":"6a70d570000000000403afdf","type":"comment","author":"夏熙cc惜夏","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/635fa744a38044a4446559d9.jpg?imageView2/2/w/120/format/jpg","text":"你说：今天天气好热啊！\\n对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"created_at":1785779568000,"reply_count":10,"parent_comment_id":"","reply_to_author":""},{"id":"6a6eb60c0000000015015722","type":"comment","author":"Leo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/5fd23174f18f4f0001f720d1.jpg?imageView2/2/w/120/format/jpg","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"created_at":1785640460000,"reply_count":1,"parent_comment_id":"","reply_to_author":""}],"comment_summary":{"threshold":20,"limit":5,"returned":5,"scanned":110,"replies_scanned":80,"primary_pages":3,"reply_pages":17,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.837,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":true,"stable_pages":2},"images":[{"index":1,"filename":"image_01.webp","text":"NAME You are everything tome,and Iwas so blessed whenGodsentyouhereforme. --枕书凉-- NPD有一个 藏不住 的语言习惯 今天教你们一个识破NPD的绝招：不用看 他对你多好，不用听他表白的多甜，就看 他怎么说话。 我研究了上千个NPD案例，发现他们有一 个藏不住的语言习惯，就是他们永远不会 用关心的方式开启对话，只会用审判的方 式质问。","width":1080,"height":1440,"size_bytes":104984,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/6067cd4c0535d544ed9a16b93e1c6e39/1040g0083239t0slnna5g5qhfo5o4030119ucv38!nd_dft_wlteh_webp_3"},{"index":2,"filename":"image_02.webp","text":"001@枕书凉 我给你举个例子，你就懂了。 正常人想知道你起床了没，会问：“你起床 了吗？”你吃饭了吗？” 这是开放式的关心，答案可以是yes，也可 以是n0 。 但NPD会怎么问？“你已经起来了？”“你已 经吃完了？” 发现没有？他们的提问里，根本没有“no” 这个选项。","width":1080,"height":1440,"size_bytes":82466,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/58006cad862c0c019a4f37d48a59838c/1040g0083239t0slnna3g5qhfo5o40301um8viv0!nd_dft_wlteh_webp_3"},{"index":3,"filename":"image_03.webp","text":"002@枕书凉 他们问的不是你的状态，而是在确认一个 预设：“你必须已经起来了。你必须已经吃 完了。你必须满足我的期待。” 02这背后藏着一个可怕的思维模式： 正常人提问，是想了解对方；NPD提问, 是想控制结果。 他们接受不了拒绝，接受不了不符合预 期。因为在他们的世界里，“你不顺从\\"=“你 攻击我”。 那当你说“没有，我还没起”的时候，会发生 什么？","width":1080,"height":1440,"size_bytes":113990,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/cbcbc63662e9e227be7048a6fb49508a/1040g0083239t0slnna4g5qhfo5o40301cs5j4so!nd_dft_wlteh_webp_3"},{"index":4,"filename":"image_04.webp","text":"003@枕书凉 低阶NPD当场破防：甩脸色、冷暴力、直 接骂你，“你什么毛病？都几点了还不起？” 高阶NPD更阴： 嘴上说着“没事没事，你睡吧”，但你明显能 感觉到气氛不对了。然后接下来，他会想 方设法解决你这个“拒绝”： 你没起床？他就在旁边制造噪音，让你睡 不着。 你拒绝他的观点？他就疯狂给你发视频、 发文章，直到你认可为止。","width":1080,"height":1440,"size_bytes":109634,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/43d3272aea99ce34eae660d85ce13add/1040g0083239t0slnna205qhfo5o40301940r130!nd_dft_wlteh_webp_3"},{"index":5,"filename":"image_05.webp","text":"004@枕书凉 你不想做的事？他会用各种方式让你觉得 “不做就是你的错”。 为什么？ 因为他们无法接受身边有任何人和自己不 一样。承认你的不同，意味着他的世界观 被挑战了；允许你拒绝，意味着他的自恋 受损了。 这就是为什么，正常人会内耗、会反思， NPD完全不会。 03正常人遇到不同意见，会想：是不是我 错了？是不是可以求同存异？","width":1080,"height":1440,"size_bytes":107596,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/413f285ae9fbf30119a3d64bbeddad3d/1040g0083239t0slnna105qhfo5o40301lr6vm5o!nd_dft_wlteh_webp_3"},{"index":6,"filename":"image_06.webp","text":"005@枕书凉 但NPD的脑子里只有一种程序：“你不听我 的，就是攻击我；你攻击我，我就必须消 灭你。” 他们的世界里，没有容纳，没有理解。承 认别人，等于否定自己。所以他们只能不 停地赢、不停地控制、不停地消灭所有“不 一样”。 这也是为什么，你会觉得NPD目的性特别 强，执行力特别强。 为了让你顺从他，他可以无所不用其极; 为了让你认错，他可以跟你耗三天三夜。 但你发现没有？","width":1080,"height":1440,"size_bytes":121262,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/685c3cb6047b6febb29d818bb976caae/1040g0083239t0slnna2g5qhfo5o403019knafm0!nd_dft_wlteh_webp_3"},{"index":7,"filename":"image_07.webp","text":"006@枕书凉 他们的目的，从来不是为了真正解决问 题，也不是为了让自己变得更好，只是为 了满足那个“我赢了”的感觉。 所以你会看到一种奇观：NPD十年如一日 地愚蠢，十年如一日地原地踏步。他们用 尽所有力气去控制别人，却没有一分力气 用来成长自己。 为什么？因为他们的能量，全部用来维持 自恋了，没有余力，去拓展世界观。 我是枕书凉，一个从回避型成长为安全型 的心理咨询师，从事回避型依恋，婚姻关 系，感情修复等咨询已有8年。让你们更懂 回避型，如果你们遇到感情问题，希望能 帮到你们","width":1080,"height":1440,"size_bytes":153898,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/573b1c5330a520bbb185cb8156c94fb3/1040g0083239t0slnna405qhfo5o403016pfpukg!nd_dft_wlteh_webp_3"},{"index":8,"filename":"image_08.webp","text":"007@枕书凉 如果你们的感情出现了以下几种情况，都 还有机会可以重归于好; 第一种：分开之后没有删除拉黑你，但 是态度很冷漠；写A 第二种：分开之后正常跟你聊天，但是 不愿意提及复合；写B 第三种：分开之后删除拉黑你，不愿沟 通态度决绝；写C 第四种：在一起经常吵架，或者对方经 常断联消失，消息电话不回。写D 有以上情况可以找我给你看看，我来帮你 从根本上解决你们的相处问题。","width":1080,"height":1440,"size_bytes":129020,"source_url":"http://sns-webpic-qc.xhscdn.com/202608241555/69f321a31d3133d7125880dd0988c43c/1040g0083239t0slnna505qhfo5o40301nse5ft8!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"ok","model":"deepseek-v4-flash","generated_at":"2026-08-24T07:59:05.268358+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"NPD（自恋型人格障碍）的语言习惯特征，即用审判式质问而非关心式提问，并解释其背后的控制思维。"},"target_audience":{"label":"针对什么人 / 场景","summary":"对NPD感兴趣或怀疑身边人有NPD的普通网友，以及遇到感情问题、寻求关系修复建议的人群。"},"user_need":{"label":"用户主要问题或需求","summary":"用户希望识别NPD的隐蔽特征，理解其行为模式，并可能寻求解决或应对感情问题的方法。"},"content_structure":{"label":"内容怎么展开","summary":"内容从提出识别NPD的绝招开始，通过对比正常人与NPD的提问方式，分析NPD提问背后的控制思维，区分低阶和高阶NPD的反应，解释其思维模式，最后引出作者身份和咨询服务，并列出四种感情问题情境引导用户互动。"},"solution":{"label":"给了什么解决办法","summary":"内容未给出明确解决办法，但提供了识别NPD的语言习惯作为认知工具，并在结尾引导有感情问题的用户联系作者咨询。"},"references":{"label":"值得参考什么","summary":"作者自称研究了上千个NPD案例，并自述为心理咨询师，有8年相关咨询经验。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸做NPD其他语言习惯的识别、如何应对NPD的审判式提问、NPD与回避型依恋的区别、感情修复的具体案例分享等内容。"}},"source_labels":["封面标题","文字标题","图片 OCR","公开互动数据"]},"comments":{"status":"ok","message":"","sample_size":5,"items":{"main_questions":{"label":"大家主要在问什么","summary":"现有样本未形成明确结论。评论主要围绕NPD（自恋型人格障碍）的言语行为模式展开，但未直接提出明确问题。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"type":"reply"},{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":118,"type":"comment"},{"id":"6a721851000000002a02fe66","author":"Momooo","text":"Npd绝对不会轻易夸人","like_count":68,"type":"comment"}]},"high_frequency_needs":{"label":"高频需求","summary":"现有样本未形成明确结论。评论者多表达对NPD言语模式的观察或共鸣，但未直接提出需求。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"type":"reply"},{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":118,"type":"comment"}]},"worries":{"label":"最担心什么","summary":"现有样本未形成明确结论。评论者担忧NPD的贬低性言语和否定性回应，但未直接表达担忧。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"type":"reply"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},"unclear_points":{"label":"博主没讲清什么","summary":"现有样本未形成明确结论。","evidence_comments":[]},"key_comments":{"label":"哪些评论值得重点看","entries":[{"comment":{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"type":"reply"},"reason":"指出NPD夸人后常伴随贬低，揭示其言语模式中的矛盾性，获得高赞。"},{"comment":{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":118,"type":"comment"},"reason":"用对比方式生动展示NPD的贬低性回应，引发共鸣。"},{"comment":{"id":"6a721851000000002a02fe66","author":"Momooo","text":"Npd绝对不会轻易夸人","like_count":68,"type":"comment"},"reason":"直接断言NPD不会轻易夸人，提供不同视角。"},{"comment":{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},"reason":"具体举例说明NPD如何否定他人感受，具有代表性。"},{"comment":{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"},"reason":"指出NPD在对话中预设答案并试图绕回，揭示其控制性。"}]},"topic_extensions":{"label":"可以延伸什么选题","entries":[{"idea":"NPD的言语模式：如何识别和应对","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":128,"type":"reply"},{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":118,"type":"comment"}]},{"idea":"NPD为何不轻易夸人：心理机制探讨","evidence_comments":[{"id":"6a721851000000002a02fe66","author":"Momooo","text":"Npd绝对不会轻易夸人","like_count":68,"type":"comment"}]},{"idea":"NPD如何否定他人感受：具体场景分析","evidence_comments":[{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},{"idea":"NPD对话中的控制策略：如何识别和应对","evidence_comments":[{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]}]}}}}}	{"size": "1080×1440", "cover": "http://sns-webpic-qc.xhscdn.com/202608241555/6067cd4c0535d544ed9a16b93e1c6e39/1040g0083239t0slnna5g5qhfo5o4030119ucv38!nd_dft_wlteh_webp_3", "taskId": "f772530c0c4f", "topics": ["我重新相信相亲角了", "贵族", "npd", "光子嫩肤", "股票", "高尔夫"], "account": {"url": "https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01", "name": "枕书凉.", "followers": 230}, "aiModel": "deepseek-v4-flash", "duration": null, "platform": "xiaohongshu", "coverFrom": null, "mainTopic": "NPD（自恋型人格障碍）的语言习惯特征，即用审判式质问而非关心式提问，并解释其背后的控制思维。", "mediaType": "image_post", "coverLocal": false, "engagement": {"likes": "1285", "collects": "944", "comments": "283", "likesNum": 1285, "collectsNum": 944, "commentsNum": 283}, "imageCount": 8, "imageFiles": [], "topicCount": 8, "generatedAt": "2026-08-24T07:59:05.268358+00:00", "aiVideoCount": 7, "commentsShown": 5, "hasTranscript": false, "platformLabel": "小红书", "aiCommentCount": 6, "commentsScanned": 110, "transcriptChars": 0}	2026-08-25 09:21:42.313642+00	\N
196	b36f1b924b66	xiaohongshu	16	{"schema_version":16,"task_id":"b36f1b924b66","source_url":"https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251704/c5f783a389998530e7b56ff71b1626ac/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_prv_wlteh_jpg_3","duration_seconds":458.306,"width":1080,"height":1920,"size_bytes":61079166,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_b64":"（已落地为本地封面文件，原始 179139 字符）","cover_image_source":"platform_video_cover","cover_image_url":"http://sns-webpic-qc.xhscdn.com/202608251739/808b4a3a343eee15ed8f07049ca7d3e7/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_dft_wlteh_webp_3","cover_image_width":1080,"cover_image_height":1440,"cover_image_size_bytes":134336}},"title":"看完痴迷，发现最恐怖的是无色无味老实人？","description":"心理学的脆弱型自恋者，望周知～","cover_title":"脆弱型自恋患者","cover_title_meta":{"text":"脆弱型自恋患者","confidence":0.994,"font_ratio":1.66,"line_count":1,"lines":[{"text":"脆弱型自恋患者","confidence":0.994}],"source_image_index":1,"source":"platform_video_cover"},"post_title":"看完痴迷，发现最恐怖的是无色无味老实人？","post_description":"心理学的脆弱型自恋者，望周知～","display_title":"脆弱型自恋患者","author":"治愈果（kakki在说啥）","account":{"name":"治愈果（kakki在说啥）","profile_url":"https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266","bio":"🐳百万粉丝心理创作者｜心理师\\n🐳累计500+小时个案\\n🐳Queen Mary 法学硕士🇬🇧 \\n🐳亲密关系｜终身成长：zhiyuguo820\\n@愈果 YU GUO","following_count":"104","follower_count":"162886","likes_and_collections_count":"1232628"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"784","collects":"349","comments":"75"},"topics":["痴迷","治愈果","心理学","惊悚片","自恋"],"video_text":"[00:00] 本人是一个恐怖电影爱好者\\n[00:02] 豆瓣的高分恐怖片清单\\n[00:04] 我基本上都刷了一个遍\\n[00:06] 最近\\n[00:07] 在海外有一部爆火的电影叫做《痴迷》\\n[00:09] 刚刚也在内地院线上映了\\n[00:10] 本人已经看完了\\n[00:12] 看完以后真的表示非常的兴奋\\n[00:14] 因为我觉得它不仅吓到我了\\n[00:16] 它也笑到我了\\n[00:17] 甚至有点惊艳到我了\\n[00:19] 我已经准备去电影院再二刷一次了\\n[00:21] 但我想要专门出一期视频\\n[00:23] 不只是因为它好看\\n[00:24] 而是因为\\n[00:25] 我觉得这个题材实在是太特别了\\n[00:27] 它不是那种传统意义上的鬼怪恐怖\\n[00:30] 而是把亲密关系\\n[00:31] 拍成了心理恐怖片的电影\\n[00:34] 可以说是刚好切到了我的内容赛道\\n[00:36] 所以想要先给大家推荐介绍一下剧情\\n[00:39] 男主贝尔是一个非常平凡\\n[00:41] 自卑又对爱情充满执念的一个男青年\\n[00:45] 他呢偶然听说了\\n[00:46] 小镇上有一个关于心愿柳的一个传说\\n[00:49] 是那种把柳条柳枝折断了\\n[00:52] 许个愿然后愿望就能实现\\n[00:54] 他有一天就去商店里面买了买了这个柳条\\n[00:55] 许愿\\n[00:56] 自己暗恋的女孩Nikki能够爱上自己\\n[00:59] OK 愿望成真了\\n[01:00] 两个人真的走到一起了\\n[01:03] 但是很快就发现 被召唤来的真的不是纯粹的爱情\\n[01:06] 而是纯纯的恐怖\\n[01:08] 女主被夺舍了 然后发了疯一样的爱上了男主贝尔\\n[01:12] 占有 控制 几乎惊恐到了变态的程度\\n[01:16] 而这部电影 我觉得它最讽刺的地方就是\\n[01:18] 它在用一种非常之极端的方式 拍出了很多人在亲密关系里面\\n[01:24] 既要 又要 还要\\n[01:25] 我看到一个非常有意思的影评\\n[01:27] 当然有点尖锐\\n[01:27] 男主属于是既要0元购又想免费退 占完便宜还想跑\\n[01:33] 就发现自己又跑不掉了 就开始害怕了\\n[01:35] 可是正当他要付出代价的时候 他又舍不得了”\\n[01:38] 这个就很像是感情里的某一部分人\\n[01:42] 喜欢漂亮的姑娘 但是又要对方只爱自己\\n[01:45] 喜欢独立的人 但又希望对方能够粘着自己\\n[01:48] 那对方太粘了 又嫌他不给自己空间\\n[01:51] 那对方开始真的有自我了 自信放光芒了 又觉得没有安全感了\\n[01:55] 不少不管男女\\n[01:56] 不少不管是男女\\n[01:57] 这个世界上哪里有这么好的事情\\n[01:59] 你想得到到底是伴侣\\n[02:00] 还是一个既能满足你所有需求\\n[02:02] 又不需要你承担任何代价的\\n[02:04] 人型许愿机？\\n[02:07] 我觉得这部电影它更厉害的地方在于\\n[02:09] 它拍出了一种\\n[02:10] 非常容易被大家忽略的人物类型\\n[02:13] 叫做脆弱型自恋者\\n[02:15] 从人格心理学和临床研究的角度来说\\n[02:18] 自恋存在两种稳定的维度\\n[02:21] 大家都很熟悉\\n[02:23] 也是网上最常看到的那种NPD的类型\\n[02:26] 脆弱型自恋\\n[02:28] 这是一种非常之隐蔽的自恋\\n[02:30] 大家都不太了解\\n[02:32] 像男主贝尔\\n[02:33] 他表面上很害羞\\n[02:34] 很自卑很老实\\n[02:35] 甚至还有一点点可怜\\n[02:36] 你是不是就很容易觉得\\n[02:38] 他是一个不太喜欢表达\\n[02:40] 但是挺善良的一个普通人\\n[02:42] 但如果你仔细看电影\\n[02:44] 你们会发现\\n[02:44] 其实这个不是单纯的内向\\n[02:46] 更不是什么温柔\\n[02:47] 他是那种“无色无味的剧毒老实人”\\n[02:50] 他的自恋不是那种高高在上\\n[02:52] 夸夸其谈的自恋\\n[02:54] 而是一种隐藏在不行动不付出\\n[02:54] 而是一种藏在不行动不付出\\n[02:56] 不表态和退缩背后的自恋\\n[02:59] 你就看他向心愿柳留许的愿望是什么嘛\\n[03:02] 不是那种请给我勇气去表白吧\\n[03:05] 也不是请让我有机会了解我的女神吧\\n[03:08] 而是直接要求让Nikki爱上我\\n[03:11] 胜过爱世界上任何一个人\\n[03:13] 你们细品\\n[03:14] 就这个愿望\\n[03:16] 它的背后就说明了\\n[03:16] 他其实想要的\\n[03:17] 根本就不是一段真实的关系\\n[03:19] 或者说这个人他对关系就是有一种错误的理解\\n[03:21] 他要的是一种究极的排他\\n[03:23] 是一种绝对的优先\\n[03:25] 是一种无条件围绕他运转\\n[03:27] 但又不提要求的爱\\n[03:29] 但真正的爱是这样吗\\n[03:30] 不是的\\n[03:32] 真正的爱应该是是我走向你\\n[03:33] 我了解你\\n[03:35] 我知道你的喜好\\n[03:36] 我付出一些爱的行为\\n[03:38] 然后我尊重你的选择\\n[03:39] 而这个男主的爱是跳过了了解\\n[03:41] 追求甚至是对方的意愿\\n[03:43] 直接让对方变成了自己的所有物\\n[03:45] 而且是独一无二的\\n[03:46] 这就根本就不是爱\\n[03:47] 这个是恐怖片\\n[03:49] 因为他关注的始终是她为什么不爱我\\n[03:51] 我怎么样才能得到她\\n[03:52] 而不是她真正需要什么\\n[03:54] 她的梦想是什么\\n[03:55] 她喜欢什么\\n[03:56] 以及她愿不愿意\\n[03:57] 而且这个电影\\n[03:58] 还有很多细节都在说明这一点\\n[04:00] 他对他死去的猫是非常冷漠的\\n[04:03] 那个猫咪刚刚离世\\n[04:04] 他就可以出去跟别人吃喝玩乐\\n[04:06] 心里就想着\\n[04:07] 是要不要表白这一类的事情\\n[04:08] 又比如说这个男主\\n[04:09] 他对一直都暗恋他\\n[04:11] 关心他的朋友同事\\n[04:13] 也是那种非常习惯性的\\n[04:15] 接受对方的好意\\n[04:16] 但是却从来没有想过\\n[04:17] 真正付出一点相对等的回应\\n[04:19] 就这种人\\n[04:20] 他真的可能不一定会在现实生活中\\n[04:23] 主动的去伤害你\\n[04:24] 但是这样的人\\n[04:25] 你一旦跟他进入关系\\n[04:27] 他一定一定会索取很多\\n[04:29] 他会索取关注照顾\\n[04:30] 索取情绪价值\\n[04:31] 但他却会很少真正看见别人\\n[04:35] 就是他用不行动来保护自己\\n[04:37] 很多人会觉得\\n[04:38] 脆弱型自恋者是因为自尊太低\\n[04:40] 所以不太敢行动\\n[04:42] 但其实恰恰相反哦\\n[04:44] 他们内心往往有一种非常强烈的自尊\\n[04:46] 但这种自尊\\n[04:47] 他不是强大\\n[04:48] 而是强烈\\n[04:49] 甚至可以说这种自尊他太脆弱了\\n[04:50] 这种自尊\\n[04:51] 他太脆弱了\\n[04:52] 因为他们这种人\\n[04:53] 他们就很害怕被拒绝\\n[04:54] 很害怕失败\\n[04:55] 很害怕现实证明自己没有那么特别\\n[04:57] 所以就干脆不表白了\\n[04:58] 就不努力了\\n[04:59] 因为这样就不承担风险\\n[05:00] 毕竟只要不行动\\n[05:02] 就永远不会被现实检验出所谓的结果\\n[05:05] 当然啊这我一定要强调\\n[05:07] 不要因为一个人内向害羞或者社恐\\n[05:10] 就随随便便给人家贴上一个什么\\n[05:12] 剧毒老好人的标签和NPD的标签\\n[05:15] 没有这回事儿\\n[05:16] 内向和自恋\\n[05:17] 是完完全全的独立存在的两种事情\\n[05:20] 两回事\\n[05:21] 而真正害羞但是又同时善良的人\\n[05:24] 他们一定会\\n[05:25] 看到对方的\\n[05:26] 一定会记得对方说过的话\\n[05:27] 一定会付出关心的行为\\n[05:28] 也会在被拒绝之后\\n[05:30] 下一次想着\\n[05:31] 我应该尊重别人的边界\\n[05:33] 他不会把自己的喜欢\\n[05:35] 当成对方必须回应的义务\\n[05:36] 但是脆弱型自恋者可不一样哦\\n[05:38] 他们不一定是张牙舞爪的\\n[05:40] 甚至他们是内向的\\n[05:42] 害羞的甚至是无害的\\n[05:43] 但是他在关系里\\n[05:45] 一定会持续的表现出\\n[05:46] 那种以自我为中心的情感\\n[05:47] 索取和逃避责任\\n[05:49] 以及躲避后果\\n[05:51] 他想要的不是你\\n[05:52] 而是你证明我值得被爱\\n[05:54] 而这个电影真正恐怖的地方也在这儿\\n[05:56] 当Nikki因为贝尔的许愿被夺舍之后\\n[05:59] 失去自我\\n[06:00] 折磨到已经几乎不成人形的时候\\n[06:03] 她在半夜的时候\\n[06:04] 短暂恢复意识的那几分钟\\n[06:06] 她非常痛苦的哀求着男主贝尔\\n[06:09] 她说你杀了我吧\\n[06:11] 我求求你了\\n[06:12] 你让我解脱吧\\n[06:13] 结果你们知道男主说了句什么吗\\n[06:14] 男主说：和我在一起到底有什么不好\\n[06:18] 我靠就这句话出来\\n[06:20] 我相信电影院一定是一片哗然的\\n[06:23] 因为在那一刻\\n[06:24] 经历了那么多恐怖的事情之后\\n[06:26] 他看到的还是仍然不是对方的痛苦\\n[06:29] 而是自己的委屈\\n[06:30] 她不成人形了\\n[06:32] 她在求救了\\n[06:33] 但这个男生还在想\\n[06:34] 我都给你我的爱了\\n[06:35] 你到底有什么不满意呀\\n[06:36] 你们看\\n[06:37] 这个就是极端自我的人最可怕的地方\\n[06:40] 因为在他们的世界里\\n[06:41] 伴侣不是一个有感受有想法\\n[06:44] 有喜怒哀乐有意志的人\\n[06:45] 而是一个应该满足自己配合自己\\n[06:48] 证明自己的工具角色\\n[06:51] 所以我真的觉得《痴迷》\\n[06:52] 表面上它讲的是一个什么禁忌\\n[06:54] 许愿的一个恐怖故事\\n[06:56] 但其实\\n[06:56] 他讲的是亲密关系里的恐怖故事\\n[06:59] 强制爱别人不会有什么好下场的\\n[07:01] 以及爱一旦只想着满足自己的话\\n[07:04] 就一定伴随着抹杀对方\\n[07:06] 真正健康的爱\\n[07:07] 不是对方完全符合你的期待\\n[07:09] 而是你能看到ta是一个独立的人\\n[07:11] ta有自己的痛苦边界和选择\\n[07:14] 也有不围着你转的权利\\n[07:16] 讲真的这部电影\\n[07:18] 把恐怖喜剧和情感的议题结合的非常好\\n[07:21] 它吓人但又不只是吓人\\n[07:23] 它荒诞但又特别现实\\n[07:25] 我真的希望这样的作品\\n[07:27] 被更多的人看到\\n[07:29] 但是这个人一定是大胆的人\\n[07:30] 如果大家很胆小\\n[07:31] 就不要去看了\\n[07:32] 因为这个电影真的是蛮恐怖的\\n[07:34] 好了今天的分享就到这了\\n[07:35] 我们下期再见啦拜拜","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":8,"chunks_succeeded":8,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T09:09:47.270396+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对对心理学、亲密关系议题感兴趣的人群，以及恐怖电影爱好者或关注情感关系问题的观众。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能希望了解电影《痴迷》的看点，同时理解“脆弱型自恋者”这一隐蔽人格类型，以及如何在亲密关系中识别和应对类似行为。"},"content_structure":{"label":"内容怎么展开","summary":"内容先以个人观影体验引入，接着介绍电影剧情，然后通过影评和心理学概念分析角色行为，最后总结电影主题并给出观影建议。"},"solution":{"label":"给了什么解决办法","summary":"内容未给出明确解决办法，但通过分析脆弱型自恋者的行为模式，提醒观众在亲密关系中注意识别类似特征，并强调健康爱的关系应尊重对方独立性。"},"references":{"label":"值得参考什么","summary":"值得参考电影《痴迷》的剧情设定和影评观点，以及心理学中关于自恋两种维度（显性自恋和脆弱型自恋）的区分。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸制作关于脆弱型自恋者与内向性格的区别、亲密关系中的边界设定、或电影中其他心理学元素的解读等内容。"}},"source_labels":["封面标题","文字标题","作品描述","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251739/808b4a3a343eee15ed8f07049ca7d3e7/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_dft_wlteh_webp_3", "taskId": "b36f1b924b66", "topics": ["痴迷", "治愈果", "心理学", "惊悚片", "自恋"], "account": {"url": "https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266", "name": "治愈果（kakki在说啥）", "followers": 162886}, "aiModel": "deepseek-v4-flash", "duration": "7分38秒", "platform": "xiaohongshu", "coverFrom": "inline", "mainTopic": "这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "784", "collects": "349", "comments": "75", "likesNum": 784, "collectsNum": 349, "commentsNum": 75}, "imageCount": 0, "imageFiles": [], "topicCount": 5, "generatedAt": "2026-08-25T09:09:47.270396+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 4766}	2026-08-25 09:43:02.477594+00	3f7398d2856a44b21729dbcffadf30be359df71d.webp
\.


--
-- Data for Name: work_reports; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.work_reports (id, author_id, reviewer_id, report_date, title, summary, feedback, reviewed_at, reviewed_by, created_at, updated_at, result_url, blockers, need_help) FROM stdin;
3	7	1	2026-08-21	111	不错	可以看见不错，下次好好做，给你涨薪	2026-08-21 07:40:58.275016+00	1	2026-08-21 07:40:06.704883+00	2026-08-21 07:40:58.275016+00	\N	\N	\N
4	1	4	2026-08-21	测试	测试	111111	2026-08-21 07:53:24.169062+00	4	2026-08-21 07:52:18.4251+00	2026-08-21 07:53:24.169062+00	\N	\N	\N
5	11	7	2026-08-21	情感赛道	\N	\N	\N	\N	2026-08-21 07:59:20.103401+00	2026-08-21 07:59:20.103401+00	\N	\N	\N
17	7	4	2026-08-25	表格	填表	1	2026-08-25 07:34:13.495692+00	4	2026-08-25 06:32:15.951365+00	2026-08-25 07:34:13.495692+00	\N	\N	\N
16	10	4	2026-08-24	表格	\N	多找作品高收藏 500+，小于3000粉丝量的作品	2026-08-25 07:37:28.196293+00	4	2026-08-24 09:31:14.854367+00	2026-08-25 07:37:28.196293+00	\N	\N	\N
15	7	4	2026-08-24	表格	填完了	1	2026-08-25 07:37:36.961506+00	4	2026-08-24 07:53:08.084396+00	2026-08-25 07:37:36.961506+00	\N	\N	\N
19	7	1	2026-08-25	情感赛道	\N	\N	\N	\N	2026-08-25 08:27:16.794467+00	2026-08-25 08:27:16.794467+00	\N	\N	\N
20	1	7	2026-08-25	测试	测试	\N	\N	\N	2026-08-25 08:51:08.355649+00	2026-08-25 08:51:08.355649+00	\N	错误	测试
22	10	4	2026-08-25	作品	标题：0-3岁没有被满足的安全感，会影响90%的亲密关系\n文案：有些女性并不是没有感情，而是不习惯面对和表达自己的恐惧、委屈、孤独、羞耻与愤怒。\n她可能关心伴侣的工作、生活和安排，却很少主动谈论彼此的感受。面对情绪时，她常说：\n“没事。”\n“别想太多。”\n“我自己消化一下就好。”\n“我也不知道自己怎么了。”\n这不一定代表冷漠，更可能是她长期习惯了压低、切断或隐藏情绪。\n常见表现\n- 很难说清自己真实的感受\n- 难过时习惯独自消化，不愿求助\n- 表达需求时感到羞耻，担心给别人添麻烦\n- 能处理现实问题，却不知道如何面对情绪\n- 被关心、安慰或拥抱时，反而僵硬、尴尬或想逃\n- 讲事情很清楚，却很少谈自己的感受\n- 发生冲突后沉默、转移话题或暂时退出关系\n在亲密关系中的复现\n她可能渴望被理解，却不知道怎样直接表达需要；期待伴侣主动看懂自己，但当对方真正靠近时，又会感到不自在。\n她也可能更容易被情绪不可得的人吸引，因为冷淡是熟悉的，而持续、稳定的温柔反而让她无所适从。\n关系中的核心矛盾是：\n渴望被看见，却不知道如何让别人看见；渴望靠近，又害怕靠近后的脆弱。\n如何判断是不是情感回避？\n不要因为一次沉默、冷淡或争吵就下结论，而要观察这种模式是否：\n- 在亲密关系中长期存在\n- 面对情绪和冲突时反复出现\n- 伴随僵硬、逃避、麻木或强颜欢笑等反应\n- 已经影响需求表达、接受安慰和建立亲密连接的能力\n可以试着观察：\n- 她难过时，会不会允许伴侣听她说完？\n- 发生冲突后，她是表达感受，还是立刻关闭自己？\n- 被关心时，她感到安心，还是尴尬、警惕甚至想逃？\n- 她能否直接说出“我需要你陪我”或“这件事让我受伤”？\n情感回避不等于她不爱，也不能仅凭几个表现给一个人贴标签。\n它更可能意味着：她有感受，也渴望连接，只是还没有学会识别、表达和接住自己的情绪。\n看见这种模式，不是为了责怪谁，而是为了让关系有机会从回避走向理解。	\N	\N	\N	2026-08-25 09:27:41.47813+00	2026-08-25 09:27:41.47813+00	\N	\N	\N
23	10	4	2026-08-25	表格	\N	\N	\N	\N	2026-08-25 09:28:31.947848+00	2026-08-25 09:28:31.947848+00	\N	\N	\N
\.


--
-- Data for Name: works; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.works (id, channel, side, account_id, title, url, pillar, published_at, metrics, note, created_by, created_at, updated_at, source_type, source_url, source_ref, deleted_at) FROM stdin;
1	persona	own	1	男人有没有责任心，看这 4 个行为	\N	A 强判断内容	2026-08-18	{"完播": 12600, "收藏": 3100, "曝光": 42000, "私信": 210, "主页访问": 1850}	先给结论，再解释机制。目标：建立「判断力」标签。	\N	2026-08-21 04:19:32.273572+00	2026-08-21 04:19:32.273572+00	manual	\N	\N	\N
2	persona	own	1	朋友圈能看出一个人的依附类型吗	\N	B 识人内容	2026-08-15	{"完播": 9200, "收藏": 2400, "曝光": 28000, "私信": 145, "主页访问": 1230}	朋友圈、语言、关系姿态、依附性、攻击性等可观察信息与交叉验证。目标：形成差异化方法论。	\N	2026-08-21 04:19:32.277819+00	2026-08-21 04:19:32.277819+00	manual	\N	\N	\N
3	persona	own	1	暧昧三个月突然变冷，问题出在哪一步	\N	C 案例拆解	2026-08-12	{"完播": 21000, "收藏": 5800, "曝光": 63000, "私信": 380, "主页访问": 2900}	信息 → 假设 → 验证 → 判断，展示推理链而不是只给观点。目标：证明诊断能力。	\N	2026-08-21 04:19:32.279059+00	2026-08-21 04:19:32.279059+00	manual	\N	\N	\N
4	persona	own	1	我们怎么做一次完整的关系诊断	\N	D 方法论内容	2026-08-09	{"完播": 11800, "收藏": 4200, "曝光": 35000, "私信": 265, "主页访问": 2020}	基础信息 → 时间线 → 关键事件 → 行为模式 → 策略。目标：为成交做预教育。	\N	2026-08-21 04:19:32.280112+00	2026-08-21 04:19:32.280112+00	manual	\N	\N	\N
6	matrix	own	4	他为什么总是秒回却从不主动约我	\N	高频问题	2026-08-03	{"完播": 4100, "收藏": 620, "曝光": 8600, "私信": 96, "主页访问": 540}	PDF 02 矩阵内容特征。关键结果：持续获得低成本线索	\N	2026-08-21 04:19:32.282372+00	2026-08-21 04:19:32.282372+00	manual	\N	\N	\N
7	matrix	own	4	等一个不确定的人，最耗人的是什么	\N	情绪痛点	2026-07-31	{"完播": 5900, "收藏": 880, "曝光": 12400, "私信": 132, "主页访问": 710}	PDF 02 矩阵内容特征。关键结果：持续获得低成本线索	\N	2026-08-21 04:19:32.283897+00	2026-08-21 04:19:32.283897+00	manual	\N	\N	\N
8	matrix	own	4	男人说「我最近很忙」的时候在想什么	\N	男女差异	2026-07-28	{"完播": 2800, "收藏": 410, "曝光": 6200, "私信": 68, "主页访问": 380}	PDF 02 矩阵内容特征。关键结果：持续获得低成本线索	\N	2026-08-21 04:19:32.284861+00	2026-08-21 04:19:32.284861+00	manual	\N	\N	\N
9	matrix	own	4	第一次见面就该注意的 3 个信号	\N	识人信号	2026-07-25	{"完播": 4600, "收藏": 730, "曝光": 9800, "私信": 104, "主页访问": 590}	PDF 02 矩阵内容特征。关键结果：持续获得低成本线索	\N	2026-08-21 04:19:32.2859+00	2026-08-21 04:19:32.2859+00	manual	\N	\N	\N
10	matrix	benchmark	6	（待填）对标矩阵号的高播放作品	\N	高频问题	2026-07-22	{"完播": 0, "收藏": 0, "曝光": 0, "私信": 0, "主页访问": 0}	对标理由：选题密度高，可直接进选题库	\N	2026-08-21 04:19:32.287042+00	2026-08-21 04:19:32.287042+00	manual	\N	\N	\N
11	live	own	7	长短择、识人、关系推进、优质男筛选（建议 20–30 分钟）	\N	主题干货	2026-07-19	{"私信": 42, "预约": 5, "连麦数": 0, "停留分钟": 6, "在线峰值": 340}	用户感受「有认知差」，转化作用：拉新与停留。	\N	2026-08-21 04:19:32.287888+00	2026-08-21 04:19:32.287888+00	manual	\N	\N	\N
12	live	own	7	用真实或脱敏案例走完整推理链（建议 20–30 分钟）	\N	案例拆解	2026-07-16	{"私信": 88, "预约": 14, "连麦数": 0, "停留分钟": 11, "在线峰值": 520}	用户感受「确实会分析」，转化作用：建立专业信任。	\N	2026-08-21 04:19:32.289356+00	2026-08-21 04:19:32.289356+00	manual	\N	\N	\N
13	live	own	7	信息收集 → 判断 → 验证 → 策略方向（核心时段）	\N	连麦诊断	2026-07-13	{"私信": 156, "预约": 31, "连麦数": 7, "停留分钟": 19, "在线峰值": 610}	连麦四组信息：①基础关系 ②关键事件 ③投入与现实推进 ④男方特征。用户感受「我的问题也能被拆清楚」，强成交。	\N	2026-08-21 04:19:32.290838+00	2026-08-21 04:19:32.290838+00	manual	\N	\N	\N
14	live	benchmark	8	（待填）对标直播间回放	\N	连麦诊断	2026-07-10	{"私信": 0, "预约": 0, "连麦数": 0, "停留分钟": 0, "在线峰值": 0}	重点看：连麦提问顺序、成交话术、怎么引导私信/预约	\N	2026-08-21 04:19:32.292124+00	2026-08-21 04:19:32.292124+00	manual	\N	\N	\N
173	persona	own	\N	智能导入全路径自测-1787555517124-作品			\N	{}	测试	1	2026-08-24 07:11:57.1553+00	2026-08-24 07:11:57.1553+00	manual		smart:615027849b8c2336e311:2	2026-08-24 07:11:57.259162+00
190	matrix	benchmark	14	NPD有一个藏不住的语言习惯	https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share	\N	\N	{"收藏": 944, "点赞": 1285, "评论": 283}	NPD（自恋型人格障碍）的语言习惯特征，即用审判式质问而非关心式提问，并解释其背后的控制思维。	\N	2026-08-25 08:23:40.916423+00	2026-08-25 09:21:04.408365+00	tech1	https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share	t1:f772530c0c4f:matrix	\N
200	persona	benchmark	18	NPD有一个藏不住的语言习惯	https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share	\N	\N	{"收藏": 944, "点赞": 1285, "评论": 283}	NPD（自恋型人格障碍）的语言习惯特征，即用审判式质问而非关心式提问，并解释其背后的控制思维。	\N	2026-08-25 09:21:42.313642+00	2026-08-25 09:21:42.313642+00	tech1	https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share	t1:f772530c0c4f:persona	\N
5	persona	benchmark	2	（待填）把对标账号的爆款链接贴进来	\N	A 强判断内容	2026-08-06	{"完播": 0, "收藏": 0, "曝光": 0, "私信": 0, "主页访问": 0}	PDF 00 流量系统：选题库 / 爆款库 / 脚本库 —— 对标作品是爆款库的来源	\N	2026-08-21 04:19:32.281111+00	2026-08-21 04:19:32.281111+00	manual	\N	\N	2026-08-25 09:23:20.301351+00
181	persona	benchmark	9	女孩子无聊的本质是生命力的匮乏	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	\N	\N	{"收藏": 32000, "点赞": 40000, "评论": 647}	分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。	\N	2026-08-25 07:04:07.118378+00	2026-08-25 07:04:07.118378+00	tech1	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	t1:ZZTEST0825:persona	2026-08-25 07:10:02.566912+00
189	matrix	benchmark	13	李银河聊亲密关系这段值得每个人熟读并背诵	https://www.xiaohongshu.com/discovery/item/6a7d8fef0000000022015197?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=normal&xsec_token=CBffYgL6gBopIxJWIDvrhpA-7m7jwLrdp_su-l08koLKE=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556084&share_id=ad26c36c89574ab291a1205c062dd285	\N	\N	{"收藏": 1319, "点赞": 2110, "评论": 32}	李银河关于亲密关系中保留个人空间的方法论，包括时间、空间、情绪、社交、心理认知五个维度，以及需要重新沟通的信号。	\N	2026-08-25 08:22:43.976607+00	2026-08-25 08:22:43.976607+00	tech1	https://www.xiaohongshu.com/discovery/item/6a7d8fef0000000022015197?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=normal&xsec_token=CBffYgL6gBopIxJWIDvrhpA-7m7jwLrdp_su-l08koLKE=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556084&share_id=ad26c36c89574ab291a1205c062dd285	t1:f69e5eb15a7d:matrix	\N
176	matrix	benchmark	10	女孩子无聊的本质是生命力的匮乏	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	\N	\N	{"收藏": 32000, "点赞": 40000, "评论": 648}	分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。	\N	2026-08-25 06:36:49.417507+00	2026-08-25 09:21:00.094163+00	tech1	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	t1:f90d29b0a27b:matrix	\N
182	matrix	benchmark	10	女孩子无聊的本质是生命力的匮乏	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	\N	\N	{"收藏": 32000, "点赞": 40000, "评论": 647}	分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。	\N	2026-08-25 07:04:07.182037+00	2026-08-25 07:04:07.182037+00	tech1	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	t1:ZZTEST0825:matrix	2026-08-25 07:10:02.607002+00
184	matrix	benchmark	12	顶级吸引力就是无所谓	https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787555967&share_id=fab821cb47f44fdc8809fac52b9572c5	\N	\N	{"收藏": 912, "点赞": 1386, "评论": 37}	以《道德经》为据，阐述顶级吸引力源于淡定、无为和不执着的智慧，而非刻意展示魅力。	\N	2026-08-25 07:15:31.145945+00	2026-08-25 07:15:31.145945+00	tech1	https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787555967&share_id=fab821cb47f44fdc8809fac52b9572c5	t1:45ecbd25bd1f:matrix	\N
174	persona	benchmark	9	女孩子无聊的本质是生命力的匮乏	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	\N	\N	{"收藏": 32000, "点赞": 40000, "评论": 648}	分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。	\N	2026-08-25 06:36:40.164413+00	2026-08-25 09:20:56.490278+00	tech1	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	t1:f90d29b0a27b:persona	2026-08-25 09:22:22.085164+00
195	matrix	benchmark	16	看完痴迷，发现最恐怖的是无色无味老实人？	https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13	\N	\N	{"收藏": 349, "点赞": 784, "评论": 75}	这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。	\N	2026-08-25 09:20:49.338864+00	2026-08-25 09:20:49.338864+00	tech1	https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13	t1:b36f1b924b66:matrix	\N
183	persona	benchmark	11	顶级吸引力就是无所谓	https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787555967&share_id=fab821cb47f44fdc8809fac52b9572c5	\N	\N	{"收藏": 912, "点赞": 1386, "评论": 37}	以《道德经》为据，阐述顶级吸引力源于淡定、无为和不执着的智慧，而非刻意展示魅力。	\N	2026-08-25 07:15:31.122084+00	2026-08-25 09:23:21.497988+00	tech1	https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787555967&share_id=fab821cb47f44fdc8809fac52b9572c5	t1:45ecbd25bd1f:persona	2026-08-25 09:23:55.700607+00
196	persona	benchmark	17	看完痴迷，发现最恐怖的是无色无味老实人？	https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13	\N	\N	{"收藏": 349, "点赞": 784, "评论": 75}	这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。	\N	2026-08-25 09:20:51.915968+00	2026-08-25 09:43:02.477594+00	tech1	https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13	t1:b36f1b924b66:persona	\N
\.


--
-- Name: api_keys_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.api_keys_id_seq', 20, true);


--
-- Name: attachments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.attachments_id_seq', 66, true);


--
-- Name: cases_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cases_id_seq', 68, true);


--
-- Name: channel_accounts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.channel_accounts_id_seq', 18, true);


--
-- Name: chat_groups_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.chat_groups_id_seq', 6, true);


--
-- Name: chat_messages_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.chat_messages_id_seq', 119, true);


--
-- Name: client_deliveries_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.client_deliveries_id_seq', 1, true);


--
-- Name: client_files_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.client_files_id_seq', 11, true);


--
-- Name: clients_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.clients_id_seq', 114, true);


--
-- Name: demands_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.demands_id_seq', 30, true);


--
-- Name: idea_activities_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.idea_activities_id_seq', 218, true);


--
-- Name: idea_code_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.idea_code_seq', 44, true);


--
-- Name: idea_comments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.idea_comments_id_seq', 12, true);


--
-- Name: ideas_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ideas_id_seq', 30, true);


--
-- Name: links_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.links_id_seq', 23, true);


--
-- Name: notifications_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.notifications_id_seq', 20, true);


--
-- Name: playbook_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.playbook_items_id_seq', 140, true);


--
-- Name: tags_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.tags_id_seq', 84, true);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.users_id_seq', 22, true);


--
-- Name: work_reports_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.work_reports_id_seq', 23, true);


--
-- Name: works_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.works_id_seq', 203, true);


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

\unrestrict e28p85eBh7aWaO3hEDTNUa71Mn81a8i9LZEQyIbj5m8P4L70TH8csIa4Hsj640X

