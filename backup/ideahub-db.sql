--
-- PostgreSQL database dump
--

\restrict A5FjEAK8hdAWbaedPCvdPNXSw5SdkGGu0rktNNd6Kg0h4EVlbKIHVcJXBuR8IBz

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
-- Name: content_component_lifecycle_apply(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.content_component_lifecycle_apply() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_state TEXT;
BEGIN
  SELECT lifecycle_state INTO v_state FROM content_components WHERE id=NEW.component_id FOR UPDATE;
  IF (NEW.event_type='retired' AND v_state<>'active') OR (NEW.event_type='reactivated' AND v_state<>'retired') THEN
    RAISE EXCEPTION 'illegal component lifecycle transition' USING ERRCODE='23514';
  END IF;
  UPDATE content_components SET lifecycle_state=CASE WHEN NEW.event_type='retired' THEN 'retired' ELSE 'active' END
   WHERE id=NEW.component_id;
  RETURN NEW;
END $$;


--
-- Name: content_component_revision_child_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.content_component_revision_child_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_state TEXT; v_revision BIGINT; v_count INT;
BEGIN
  v_revision := CASE WHEN TG_OP='DELETE' THEN OLD.revision_id ELSE NEW.revision_id END;
  SELECT state INTO v_state FROM content_component_revisions WHERE id=v_revision;
  IF v_state<>'draft' THEN RAISE EXCEPTION 'component revision sources and tags are immutable after submit' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' AND TG_TABLE_NAME='content_component_revision_sources' THEN
    SELECT count(*) INTO v_count FROM content_component_revision_sources WHERE revision_id=v_revision;
    IF v_count>=20 THEN RAISE EXCEPTION 'component revision source limit exceeded' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='INSERT' AND TG_TABLE_NAME='content_component_revision_tags' THEN
    SELECT count(*) INTO v_count FROM content_component_revision_tags WHERE revision_id=v_revision;
    IF v_count>=30 THEN RAISE EXCEPTION 'component revision tag limit exceeded' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM tags WHERE id=NEW.tag_id AND active) THEN
      RAISE EXCEPTION 'component revision tags must be active' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;


--
-- Name: content_component_revision_decision_apply(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.content_component_revision_decision_apply() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r content_component_revisions%ROWTYPE;
BEGIN
  SELECT * INTO r FROM content_component_revisions WHERE id=NEW.revision_id AND component_id=NEW.component_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'component revision does not exist' USING ERRCODE='23503'; END IF;
  IF NEW.decision='submitted' THEN
    IF r.state<>'draft' THEN RAISE EXCEPTION 'only draft revisions may be submitted' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(
      SELECT 1 FROM content_component_revision_sources s
      JOIN sample_element_extractions e ON e.id=s.extraction_id AND e.status='complete'
      JOIN sample_element_extraction_sources es ON es.extraction_id=e.id AND es.source_role='primary'
      JOIN sample_comparison_snapshots x ON x.id=es.snapshot_id AND x.evidence_state='verified'
      WHERE s.revision_id=r.id AND s.source_role='primary'
    ) THEN RAISE EXCEPTION 'submit requires a verified primary extraction chain' USING ERRCODE='23514'; END IF;
    UPDATE content_component_revisions SET state='submitted' WHERE id=r.id;
  ELSIF NEW.decision IN ('approved','changes_requested') THEN
    IF r.state<>'submitted' THEN RAISE EXCEPTION 'review requires a submitted revision' USING ERRCODE='23514'; END IF;
    IF NEW.actor_role NOT IN ('reviewer','admin') THEN RAISE EXCEPTION 'reviewer role required' USING ERRCODE='42501'; END IF;
    UPDATE content_component_revisions SET state=NEW.decision WHERE id=r.id;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: content_component_revision_row_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.content_component_revision_row_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'component revisions are immutable' USING ERRCODE='55000'; END IF;
  IF pg_trigger_depth()<2 OR to_jsonb(NEW)-'state' IS DISTINCT FROM to_jsonb(OLD)-'state' THEN
    RAISE EXCEPTION 'component revision content is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: content_component_row_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.content_component_row_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'content components are immutable' USING ERRCODE='55000'; END IF;
  IF pg_trigger_depth()<2 OR to_jsonb(NEW)-'lifecycle_state' IS DISTINCT FROM to_jsonb(OLD)-'lifecycle_state' THEN
    RAISE EXCEPTION 'stable component identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: content_component_selection_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.content_component_selection_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_state TEXT; v_decision TEXT; v_revision BIGINT;
BEGIN
  PERFORM 1 FROM content_components WHERE id=NEW.component_id FOR UPDATE;
  SELECT state INTO v_state FROM content_component_revisions WHERE id=NEW.revision_id AND component_id=NEW.component_id;
  SELECT decision,revision_id INTO v_decision,v_revision FROM content_component_revision_decisions WHERE id=NEW.decision_id;
  IF v_state IS DISTINCT FROM 'approved' OR v_decision IS DISTINCT FROM 'approved' OR v_revision IS DISTINCT FROM NEW.revision_id THEN
    RAISE EXCEPTION 'component selection requires its approving decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


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
-- Name: sample_analysis_apply_selection(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_analysis_apply_selection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_status TEXT; v_job_status TEXT; v_select BOOLEAN;
BEGIN
  SELECT v.status,j.status,j.select_on_success INTO v_status,v_job_status,v_select
    FROM sample_analysis_versions v
    LEFT JOIN sample_analysis_jobs j ON j.id=v.job_id
   WHERE v.sample_id=NEW.sample_id AND v.id=NEW.version_id;
  IF v_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'only complete analysis versions can become current';
  END IF;
  IF NEW.reason='run_success' AND (v_job_status IS DISTINCT FROM 'succeeded' OR v_select IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'run_success selection requires a succeeded select-on-success job';
  END IF;
  UPDATE samples SET current_analysis_version_id=NEW.version_id,updated_at=now()
   WHERE id=NEW.sample_id;
  RETURN NEW;
END $$;


--
-- Name: sample_analysis_guard_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_analysis_guard_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only',TG_TABLE_NAME;
END $$;


--
-- Name: sample_analysis_guard_version_child(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_analysis_guard_version_child() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_version_id BIGINT; v_status TEXT; v_source TEXT; v_capture BIGINT; v_old_status TEXT;
BEGIN
  IF TG_OP='UPDATE' THEN
    SELECT status INTO v_old_status FROM sample_analysis_versions WHERE id=OLD.version_id;
    IF v_old_status='complete' THEN
      RAISE EXCEPTION 'children of complete sample analysis versions are immutable';
    END IF;
  END IF;
  v_version_id := CASE WHEN TG_OP='DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  SELECT status,source,source_capture_id INTO v_status,v_source,v_capture
    FROM sample_analysis_versions WHERE id=v_version_id;
  IF v_status='complete' THEN
    RAISE EXCEPTION 'children of complete sample analysis versions are immutable';
  END IF;
  IF TG_OP<>'DELETE' AND TG_TABLE_NAME='sample_analysis_elements'
     AND v_source='manual' AND (to_jsonb(NEW)->>'confidence') IS NOT NULL THEN
    RAISE EXCEPTION 'manual analysis element confidence must be NULL';
  END IF;
  IF TG_OP<>'DELETE' AND TG_TABLE_NAME='sample_evidence_sources'
     AND (to_jsonb(NEW)->>'source_capture_id')::BIGINT <> v_capture THEN
    RAISE EXCEPTION 'evidence source capture must match analysis version capture';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;


--
-- Name: sample_analysis_guard_version_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_analysis_guard_version_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status='complete' THEN
    RAISE EXCEPTION 'complete sample analysis versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;


--
-- Name: sample_analysis_validate_completion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_analysis_validate_completion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_count INT; v_bad_ai INT;
BEGIN
  IF TG_OP='INSERT' AND NEW.status='complete' THEN
    RAISE EXCEPTION 'analysis versions must be created as building before completion';
  END IF;
  IF TG_OP='INSERT' AND NEW.source='ai' AND NOT EXISTS (
    SELECT 1 FROM sample_analysis_jobs j
     WHERE j.id=NEW.job_id AND j.sample_id=NEW.sample_id
       AND j.source_capture_id=NEW.source_capture_id AND j.input_sha256=NEW.input_sha256
  ) THEN
    RAISE EXCEPTION 'AI analysis version must preserve its job input and capture';
  END IF;
  IF TG_OP='UPDATE' AND NEW.status='complete' AND OLD.status IS DISTINCT FROM 'complete' THEN
    SELECT count(*) INTO v_count FROM sample_analysis_elements WHERE version_id=NEW.id;
    IF v_count <> 15 THEN
      RAISE EXCEPTION 'a complete analysis version must contain exactly 15 dimensions (got %)',v_count;
    END IF;
    IF NEW.source='ai' THEN
      SELECT count(*) INTO v_bad_ai
        FROM sample_analysis_elements e
       WHERE e.version_id=NEW.id AND e.confidence IS NULL;
      IF v_bad_ai > 0 THEN
        RAISE EXCEPTION 'AI analysis dimensions require confidence';
      END IF;
      SELECT count(*) INTO v_bad_ai
        FROM sample_analysis_elements e
       WHERE e.version_id=NEW.id
         AND NOT EXISTS (
           SELECT 1 FROM sample_element_evidence ee
            WHERE ee.version_id=NEW.id AND ee.element_id=e.id
              AND ee.verification_status='verified'
         )
         AND (e.state <> 'insufficient' OR e.confidence IS NULL OR e.confidence > 0.2);
      IF v_bad_ai > 0 THEN
        RAISE EXCEPTION 'AI dimensions without verified evidence must be insufficient with confidence <= 0.2';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: sample_comparison_assessment_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_comparison_assessment_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_status TEXT; v_target TEXT; v_scope BIGINT; v_comparison BIGINT;
BEGIN
  SELECT status INTO v_status FROM sample_comparison_scopes WHERE id=NEW.scope_id AND comparison_id=NEW.comparison_id;
  IF v_status IS DISTINCT FROM 'complete' THEN RAISE EXCEPTION 'assessments require a complete scope' USING ERRCODE='23514'; END IF;
  IF NEW.job_id IS NOT NULL THEN
    SELECT target,scope_id,comparison_id INTO v_target,v_scope,v_comparison FROM sample_comparison_assessment_jobs WHERE id=NEW.job_id;
    IF (v_target,v_scope,v_comparison) IS DISTINCT FROM (NEW.target,NEW.scope_id,NEW.comparison_id) THEN
      RAISE EXCEPTION 'AI assessment job ownership mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: sample_comparison_job_transition_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_comparison_job_transition_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'queued' OR NEW.attempts<>0 THEN
      RAISE EXCEPTION 'assessment jobs must start queued with zero attempts' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM sample_comparison_scopes WHERE id=NEW.scope_id AND comparison_id=NEW.comparison_id AND status='complete') THEN
      RAISE EXCEPTION 'assessment jobs require a complete scope' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.comparison_id,OLD.scope_id,OLD.target,OLD.request_sha256,OLD.provider,OLD.model_name,OLD.requested_by)
     IS DISTINCT FROM
     (NEW.comparison_id,NEW.scope_id,NEW.target,NEW.request_sha256,NEW.provider,NEW.model_name,NEW.requested_by) THEN
    RAISE EXCEPTION 'assessment job identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status IN ('succeeded','failed','cancelled') THEN
    RAISE EXCEPTION 'terminal assessment jobs are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.status='queued' AND NEW.status IN ('queued','running','cancelled')) OR
          (OLD.status='running' AND NEW.status IN ('running','queued','succeeded','failed','cancelled'))) THEN
    RAISE EXCEPTION 'illegal assessment job transition % -> %',OLD.status,NEW.status USING ERRCODE='23514';
  END IF;
  IF OLD.status='queued' AND NEW.status='running' AND NEW.attempts<>OLD.attempts+1 THEN
    RAISE EXCEPTION 'starting an assessment job must increment attempts once' USING ERRCODE='23514';
  END IF;
  IF NEW.status IN ('succeeded','failed','cancelled') AND NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'terminal assessment jobs require finished_at' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: sample_comparison_scope_child_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_comparison_scope_child_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_scope BIGINT; v_status TEXT; v_old_status TEXT;
BEGIN
  IF TG_OP='UPDATE' THEN
    SELECT status INTO v_old_status FROM sample_comparison_scopes WHERE id=OLD.scope_id;
    IF v_old_status='complete' THEN RAISE EXCEPTION 'children of complete comparison scopes are immutable' USING ERRCODE='55000'; END IF;
  END IF;
  v_scope := CASE WHEN TG_OP='DELETE' THEN OLD.scope_id ELSE NEW.scope_id END;
  SELECT status INTO v_status FROM sample_comparison_scopes WHERE id=v_scope;
  IF v_status='complete' THEN RAISE EXCEPTION 'children of complete comparison scopes are immutable' USING ERRCODE='55000'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;


--
-- Name: sample_comparison_scope_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_comparison_scope_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_member_count INT; v_bad INT;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='complete' THEN RAISE EXCEPTION 'complete comparison scopes are immutable' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' AND NEW.status<>'building' THEN
    RAISE EXCEPTION 'comparison scopes must be created as building' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='complete' THEN
    RAISE EXCEPTION 'complete comparison scopes are immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND NEW.status='complete' AND OLD.status='building' THEN
    SELECT count(*) INTO v_member_count FROM sample_comparison_scope_members WHERE scope_id=NEW.id;
    IF v_member_count NOT BETWEEN 2 AND 6 THEN
      RAISE EXCEPTION 'a complete comparison scope requires 2-6 members (got %)',v_member_count USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO v_bad FROM sample_comparison_scope_members m
     WHERE m.scope_id=NEW.id AND (
       m.ordinal NOT BETWEEN 1 AND v_member_count OR
       NOT EXISTS (SELECT 1 FROM sample_analysis_versions v WHERE v.id=m.analysis_version_id AND v.sample_id=m.sample_id AND v.status='complete') OR
       NOT EXISTS (SELECT 1 FROM samples s WHERE s.id=m.sample_id AND s.current_analysis_version_id=m.analysis_version_id) OR
       m.metric_snapshot_id IS DISTINCT FROM (
         SELECT ms.id FROM sample_metric_snapshots ms WHERE ms.sample_id=m.sample_id ORDER BY ms.observed_at DESC,ms.id DESC LIMIT 1
       ) OR
       15 <> (SELECT count(*) FROM sample_comparison_snapshots x WHERE x.scope_id=NEW.id AND x.sample_id=m.sample_id) OR
       15 <> (SELECT count(DISTINCT x.dimension_key) FROM sample_comparison_snapshots x WHERE x.scope_id=NEW.id AND x.sample_id=m.sample_id)
     );
    IF v_bad>0 THEN RAISE EXCEPTION 'comparison scope members must freeze current complete analyses, latest metric and exactly 15 dimensions' USING ERRCODE='23514'; END IF;
    SELECT count(*) INTO v_bad FROM sample_comparison_snapshots x
     WHERE x.scope_id=NEW.id AND x.latest_decision_id IS DISTINCT FROM (
       SELECT d.id FROM sample_element_decisions d WHERE d.element_id=x.element_id ORDER BY d.id DESC LIMIT 1
     );
    IF v_bad>0 THEN RAISE EXCEPTION 'comparison snapshots must freeze the latest element decision' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: sample_comparison_selection_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_comparison_selection_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM 1 FROM sample_comparisons WHERE id=NEW.comparison_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'comparison does not exist' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;


--
-- Name: sample_element_decisions_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_element_decisions_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT v.status INTO v_status
    FROM sample_analysis_elements e
    JOIN sample_analysis_versions v ON v.id=e.version_id
   WHERE e.id=NEW.element_id;
  IF v_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'manual decisions may only review complete analysis versions';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: sample_element_extraction_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_element_extraction_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_count INT; v_primary INT;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='complete' THEN RAISE EXCEPTION 'complete extractions are immutable' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' AND NEW.status<>'building' THEN RAISE EXCEPTION 'extractions must start building' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM sample_comparison_scopes WHERE id=NEW.scope_id AND comparison_id=NEW.comparison_id AND status='complete') THEN
    RAISE EXCEPTION 'extractions require a complete scope' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='complete' THEN RAISE EXCEPTION 'complete extractions are immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND OLD.status='building' AND NEW.status='complete' THEN
    SELECT count(*),count(*) FILTER(WHERE source_role='primary') INTO v_count,v_primary
      FROM sample_element_extraction_sources WHERE extraction_id=NEW.id;
    IF v_count NOT BETWEEN 1 AND 18 OR v_primary<1 THEN
      RAISE EXCEPTION 'complete extraction requires 1-18 sources and at least one primary' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: sample_element_extraction_source_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_element_extraction_source_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_status TEXT; v_old_status TEXT;
BEGIN
  IF TG_OP='UPDATE' THEN
    SELECT status INTO v_old_status FROM sample_element_extractions WHERE id=OLD.extraction_id;
    IF v_old_status='complete' THEN RAISE EXCEPTION 'sources of complete extractions are immutable' USING ERRCODE='55000'; END IF;
  END IF;
  SELECT status INTO v_status FROM sample_element_extractions WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.extraction_id ELSE NEW.extraction_id END;
  IF v_status='complete' THEN RAISE EXCEPTION 'sources of complete extractions are immutable' USING ERRCODE='55000'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;


--
-- Name: sample_element_tags_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_element_tags_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_kind TEXT; v_active BOOLEAN; v_version_status TEXT;
BEGIN
  SELECT kind,active INTO v_kind,v_active FROM tags WHERE id=NEW.tag_id;
  IF v_kind IS DISTINCT FROM NEW.dimension_key THEN
    RAISE EXCEPTION 'element tag kind must equal its analysis dimension';
  END IF;
  IF NEW.origin='ai' AND NOT COALESCE(v_active,false) THEN
    RAISE EXCEPTION 'AI may only reference an existing active tag';
  END IF;
  SELECT status INTO v_version_status FROM sample_analysis_versions WHERE id=NEW.version_id;
  IF NEW.origin IN ('ai','legacy') AND v_version_status IS DISTINCT FROM 'building' THEN
    RAISE EXCEPTION 'AI and legacy element tags must be fixed before version completion';
  END IF;
  IF NEW.origin='manual' AND v_version_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'manual element tags may only review complete versions';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: sample_relation_event_apply(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_relation_event_apply() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r sample_relations%ROWTYPE; v_next TEXT; v_has_cycle BOOLEAN;
BEGIN
  SELECT * INTO r FROM sample_relations WHERE id=NEW.relation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'relation does not exist' USING ERRCODE='23503'; END IF;
  IF NEW.event_type='proposed' THEN
    IF EXISTS(SELECT 1 FROM sample_relation_events WHERE relation_id=NEW.relation_id) OR r.current_state<>'proposed' THEN
      RAISE EXCEPTION 'proposed may only be the first relation event' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  v_next := NEW.event_type;
  IF NOT (
    (r.current_state='proposed' AND v_next IN ('confirmed','rejected','withdrawn','superseded')) OR
    (r.current_state='confirmed' AND v_next IN ('withdrawn','superseded')) OR
    (r.current_state='withdrawn' AND v_next IN ('confirmed','superseded'))
  ) THEN RAISE EXCEPTION 'illegal relation state transition % -> %',r.current_state,v_next USING ERRCODE='23514'; END IF;
  IF v_next='confirmed' THEN
    IF NOT EXISTS(SELECT 1 FROM sample_relation_evidence WHERE relation_id=r.id) THEN
      RAISE EXCEPTION 'confirmed relations require verified endpoint evidence' USING ERRCODE='23514';
    END IF;
    IF r.relation_type IN ('imitation','evolution') THEN
      PERFORM pg_advisory_xact_lock(730082913);
      WITH RECURSIVE reachable(node) AS (
        SELECT x.object_sample_id FROM sample_relations x
         WHERE x.current_state='confirmed' AND x.relation_type IN ('imitation','evolution')
           AND x.subject_sample_id=r.object_sample_id
        UNION
        SELECT x.object_sample_id FROM sample_relations x JOIN reachable p ON x.subject_sample_id=p.node
         WHERE x.current_state='confirmed' AND x.relation_type IN ('imitation','evolution')
      ) SELECT EXISTS(SELECT 1 FROM reachable WHERE node=r.subject_sample_id) INTO v_has_cycle;
      IF v_has_cycle THEN RAISE EXCEPTION 'confirmed lineage relation would create a cycle' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  UPDATE sample_relations SET current_state=v_next WHERE id=r.id;
  RETURN NEW;
END $$;


--
-- Name: sample_relation_evidence_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_relation_evidence_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_status TEXT;
BEGIN
  IF NOT ((NEW.endpoint_sample_id=NEW.subject_sample_id AND NEW.endpoint_analysis_version_id=NEW.subject_analysis_version_id) OR
          (NEW.endpoint_sample_id=NEW.object_sample_id AND NEW.endpoint_analysis_version_id=NEW.object_analysis_version_id)) THEN
    RAISE EXCEPTION 'relation evidence must belong to a pinned endpoint analysis' USING ERRCODE='23514';
  END IF;
  SELECT verification_status INTO v_status FROM sample_element_evidence
    WHERE id=NEW.element_evidence_id AND version_id=NEW.endpoint_analysis_version_id;
  IF v_status IS DISTINCT FROM 'verified' THEN RAISE EXCEPTION 'relation evidence must be verified' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;


--
-- Name: sample_relation_insert_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_relation_insert_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sample_analysis_versions WHERE id=NEW.subject_analysis_version_id AND sample_id=NEW.subject_sample_id AND status='complete') OR
     NOT EXISTS(SELECT 1 FROM sample_analysis_versions WHERE id=NEW.object_analysis_version_id AND sample_id=NEW.object_sample_id AND status='complete') THEN
    RAISE EXCEPTION 'relation endpoints require complete pinned analyses' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: sample_relation_row_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_relation_row_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'sample relations are immutable' USING ERRCODE='55000'; END IF;
  IF pg_trigger_depth()<2 OR to_jsonb(NEW)-'current_state' IS DISTINCT FROM to_jsonb(OLD)-'current_state' THEN
    RAISE EXCEPTION 'sample relation structure is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: sample_stage3_append_only_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage3_append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only',TG_TABLE_NAME USING ERRCODE='55000';
END $$;


--
-- Name: sample_stage4_append_only_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 RAISE EXCEPTION '% rows are append-only',TG_TABLE_NAME USING ERRCODE='55000'; END $$;


--
-- Name: sample_stage4_build_item_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_build_item_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN IF TG_OP<>'INSERT'THEN RAISE EXCEPTION 'build items are append-only' USING ERRCODE='55000';END IF;IF NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.status='running')THEN RAISE EXCEPTION 'build items require a running build' USING ERRCODE='23514';END IF;RETURN NEW;END $$;


--
-- Name: sample_stage4_cluster_run_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_cluster_run_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE inputs INT;assigned INT;bad INT;BEGIN IF TG_OP='DELETE'OR OLD.status IN('complete','failed')THEN RAISE EXCEPTION 'terminal cluster run immutable' USING ERRCODE='55000';END IF;
 IF NEW.status='complete'AND OLD.status='building'THEN SELECT count(*)INTO inputs FROM sample_cluster_run_profiles WHERE run_id=NEW.id;SELECT count(*)INTO assigned FROM sample_cluster_members WHERE run_id=NEW.id;
 SELECT count(*)INTO bad FROM sample_cluster_members m WHERE m.run_id=NEW.id AND((m.is_outlier AND m.cluster_id IS NOT NULL)OR(NOT m.is_outlier AND m.cluster_id IS NULL));
 IF EXISTS(SELECT 1 FROM sample_clusters c WHERE c.run_id=NEW.id AND((SELECT count(*)FROM sample_cluster_members m WHERE m.run_id=c.run_id AND m.cluster_id=c.id)<3 OR(SELECT count(*)FROM sample_cluster_members m WHERE m.run_id=c.run_id AND m.cluster_id=c.id AND m.representative)<>1 OR NOT EXISTS(SELECT 1 FROM sample_cluster_members m WHERE m.run_id=c.run_id AND m.cluster_id=c.id AND m.sample_id=c.representative_sample_id AND m.representative)))THEN bad:=bad+1;END IF;
 IF inputs<>NEW.profile_count OR assigned<>inputs OR bad<>0 THEN RAISE EXCEPTION 'complete cluster run must assign every input exactly once and validate clusters' USING ERRCODE='23514';END IF;END IF;RETURN NEW;END $$;


--
-- Name: sample_stage4_component_profile_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_component_profile_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE n INT;BEGIN IF TG_OP='DELETE'AND OLD.status='complete'THEN RAISE EXCEPTION 'complete component profile immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='UPDATE'AND OLD.status='complete'THEN RAISE EXCEPTION 'complete component profile immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='INSERT'AND NEW.status<>'building'THEN RAISE EXCEPTION 'profile starts building' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT'AND NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.algorithm_id=NEW.algorithm_id AND b.status='running')THEN RAISE EXCEPTION 'component profile requires its running algorithm build' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE'AND NEW.status='complete'THEN SELECT count(*)INTO n FROM component_retrieval_vectors WHERE profile_id=NEW.id;IF n<>1 THEN RAISE EXCEPTION 'complete component profile requires one vector' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM content_components c JOIN content_component_revisions r ON r.id=NEW.revision_id JOIN content_component_revision_decisions d ON d.id=NEW.approving_decision_id WHERE c.id=NEW.component_id AND c.lifecycle_state='active'AND r.state='approved'AND d.decision='approved')THEN RAISE EXCEPTION 'component profile must pin active approved revision' USING ERRCODE='23514';END IF;END IF;
 RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;


--
-- Name: sample_stage4_component_vector_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_component_vector_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ DECLARE s TEXT;BEGIN SELECT status INTO s FROM component_retrieval_profiles WHERE id=CASE WHEN TG_OP='DELETE'THEN OLD.profile_id ELSE NEW.profile_id END;IF s='complete'THEN RAISE EXCEPTION 'complete profile children immutable' USING ERRCODE='55000';END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;


--
-- Name: sample_stage4_insight_feature_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_insight_feature_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE canonical BIGINT[];tag_kind TEXT;tag_origin TEXT;observed_state TEXT;BEGIN SELECT array_agg(DISTINCT x ORDER BY x)INTO canonical FROM unnest(NEW.tag_ids)x;IF canonical IS DISTINCT FROM NEW.tag_ids THEN RAISE EXCEPTION 'feature tag_ids must be sorted and distinct' USING ERRCODE='23514';END IF;
 IF NEW.feature_type='single'THEN SELECT kind INTO tag_kind FROM tags WHERE id=NEW.tag_id;IF tag_kind IS DISTINCT FROM NEW.dimension_key THEN RAISE EXCEPTION 'single feature tag kind must match dimension' USING ERRCODE='23514';END IF;END IF;
 IF NEW.source='explicit_observation'THEN SELECT state INTO observed_state FROM sample_element_tag_observations WHERE id=NEW.observation_id;IF observed_state IS DISTINCT FROM NEW.state THEN RAISE EXCEPTION 'explicit feature state must equal its observation state' USING ERRCODE='23514';END IF;END IF;
 IF NEW.source IN('manual_tag','effective_tag')THEN SELECT origin INTO tag_origin FROM sample_element_tags WHERE id=NEW.element_tag_id;IF NEW.source='manual_tag'AND tag_origin IS DISTINCT FROM'manual'THEN RAISE EXCEPTION 'manual feature provenance requires a manual element tag' USING ERRCODE='23514';END IF;END IF;RETURN NEW;END $$;


--
-- Name: sample_stage4_insight_run_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_insight_run_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN IF TG_OP='DELETE'OR OLD.status IN('complete','failed','cancelled')THEN RAISE EXCEPTION 'terminal insight run immutable' USING ERRCODE='55000';END IF;
 IF NEW.status='complete'AND OLD.status='running'THEN
  IF NOT EXISTS(SELECT 1 FROM sample_insight_run_members WHERE run_id=NEW.id AND outcome_state='observed')THEN RAISE EXCEPTION 'complete insight needs observed outcomes' USING ERRCODE='23514';END IF;
  IF EXISTS(WITH expected AS(
    SELECT 'tag:'||value feature_key,'single'feature_type,ARRAY[value::bigint]tag_ids FROM jsonb_array_elements_text(NEW.normalized_request#>'{features,singleTagIds}')
    UNION ALL SELECT'tags:'||x.feature_key,'combination',x.tag_ids FROM jsonb_array_elements(NEW.normalized_request#>'{features,combinations}')combo
      CROSS JOIN LATERAL(SELECT string_agg(value,'+'ORDER BY ord)feature_key,array_agg(value::bigint ORDER BY ord)tag_ids FROM jsonb_array_elements_text(combo.value)WITH ORDINALITY z(value,ord))x)
    SELECT 1 FROM sample_insight_run_members m WHERE m.run_id=NEW.id AND(
      EXISTS(SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM sample_insight_run_features f WHERE f.run_id=NEW.id AND f.member_id=m.id AND f.feature_key=e.feature_key AND f.feature_type=e.feature_type AND f.tag_ids=e.tag_ids))OR
      EXISTS(SELECT 1 FROM sample_insight_run_features f WHERE f.run_id=NEW.id AND f.member_id=m.id AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.feature_key=f.feature_key AND e.feature_type=f.feature_type AND e.tag_ids=f.tag_ids))))
  THEN RAISE EXCEPTION 'every insight member must freeze the exact canonical requested feature set' USING ERRCODE='23514';END IF;
  IF EXISTS(WITH expected AS(
    SELECT 'tag:'||value feature_key,'single'feature_type FROM jsonb_array_elements_text(NEW.normalized_request#>'{features,singleTagIds}')
    UNION ALL SELECT'tags:'||x.feature_key,'combination'FROM jsonb_array_elements(NEW.normalized_request#>'{features,combinations}')combo
      CROSS JOIN LATERAL(SELECT string_agg(value,'+'ORDER BY ord)feature_key FROM jsonb_array_elements_text(combo.value)WITH ORDINALITY z(value,ord))x)
    SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM sample_insight_statistics s WHERE s.run_id=NEW.id AND s.feature_key=e.feature_key AND s.feature_type=e.feature_type)
    UNION ALL SELECT 1 FROM sample_insight_statistics s WHERE s.run_id=NEW.id AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.feature_key=s.feature_key AND e.feature_type=s.feature_type))
  THEN RAISE EXCEPTION 'insight statistics must equal the canonical requested feature set' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;


--
-- Name: sample_stage4_job_state_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_job_state_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE final_success TEXT;BEGIN IF TG_OP='DELETE'THEN RAISE EXCEPTION 'job audit rows cannot be deleted' USING ERRCODE='55000';END IF;final_success:=CASE WHEN TG_TABLE_NAME='sample_insight_runs'THEN'complete'ELSE'succeeded'END;
 IF OLD.status IN(final_success,'failed','cancelled')THEN RAISE EXCEPTION 'terminal jobs are immutable' USING ERRCODE='55000';END IF;
 IF NEW.status=OLD.status THEN RETURN NEW;END IF;
 IF OLD.status='queued'AND NEW.status NOT IN('running','cancelled')THEN RAISE EXCEPTION 'invalid queued job transition' USING ERRCODE='23514';END IF;
 IF OLD.status='running'AND NEW.status NOT IN('queued',final_success,'failed','cancelled')THEN RAISE EXCEPTION 'invalid running job transition' USING ERRCODE='23514';END IF;
 IF OLD.status='running'AND NEW.status='queued'AND(OLD.lease_expires_at IS NULL OR OLD.lease_expires_at>=now()OR OLD.attempts>=OLD.max_attempts)THEN RAISE EXCEPTION 'only an expired retryable lease may requeue' USING ERRCODE='23514';END IF;RETURN NEW;END $$;


--
-- Name: sample_stage4_mark_component_dirty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_mark_component_dirty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE cid BIGINT;BEGIN IF TG_TABLE_NAME='content_components'THEN cid:=COALESCE(NEW.id,OLD.id);ELSE cid:=COALESCE(NEW.component_id,OLD.component_id);END IF;
 INSERT INTO component_retrieval_states(component_id,dirty,dirty_generation)VALUES(cid,true,1)ON CONFLICT(component_id)DO UPDATE SET dirty=true,dirty_generation=component_retrieval_states.dirty_generation+1,updated_at=now();RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;


--
-- Name: sample_stage4_mark_entity_tag_dirty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_mark_entity_tag_dirty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE e TEXT;eid BIGINT;BEGIN e:=CASE WHEN TG_OP='DELETE'THEN OLD.entity ELSE NEW.entity END;eid:=CASE WHEN TG_OP='DELETE'THEN OLD.entity_id ELSE NEW.entity_id END;
 IF e='sample'THEN INSERT INTO sample_retrieval_states(sample_id,dirty,dirty_generation)VALUES(eid,true,1)ON CONFLICT(sample_id)DO UPDATE SET dirty=true,dirty_generation=sample_retrieval_states.dirty_generation+1,updated_at=now();END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;


--
-- Name: sample_stage4_mark_sample_dirty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_mark_sample_dirty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE sid BIGINT;BEGIN
 IF TG_TABLE_NAME='samples'THEN sid:=COALESCE(NEW.id,OLD.id);
 ELSIF TG_TABLE_NAME='sample_analysis_selections'THEN sid:=NEW.sample_id;
 ELSIF TG_TABLE_NAME='sample_element_decisions'THEN SELECT v.sample_id INTO sid FROM sample_analysis_elements e JOIN sample_analysis_versions v ON v.id=e.version_id JOIN samples s ON s.id=v.sample_id AND s.current_analysis_version_id=v.id WHERE e.id=NEW.element_id;
 ELSIF TG_TABLE_NAME='sample_element_tags'THEN SELECT v.sample_id INTO sid FROM sample_analysis_versions v JOIN samples s ON s.id=v.sample_id AND s.current_analysis_version_id=v.id WHERE v.id=NEW.version_id;
 ELSE RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END IF;
 IF sid IS NULL THEN RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END IF;
 INSERT INTO sample_retrieval_states(sample_id,dirty,dirty_generation)VALUES(sid,true,1)ON CONFLICT(sample_id)DO UPDATE SET dirty=true,dirty_generation=sample_retrieval_states.dirty_generation+1,updated_at=now();RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;


--
-- Name: sample_stage4_mark_tag_dictionary_dirty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_mark_tag_dictionary_dirty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN IF OLD.name IS NOT DISTINCT FROM NEW.name AND OLD.active IS NOT DISTINCT FROM NEW.active AND OLD.kind IS NOT DISTINCT FROM NEW.kind THEN RETURN NEW;END IF;
 INSERT INTO sample_retrieval_states(sample_id,dirty,dirty_generation)
 SELECT DISTINCT s.id,true,1 FROM samples s LEFT JOIN entity_tags et ON et.entity='sample'AND et.entity_id=s.id LEFT JOIN sample_analysis_elements e ON e.version_id=s.current_analysis_version_id LEFT JOIN sample_element_tags st ON st.element_id=e.id WHERE et.tag_id=NEW.id OR st.tag_id=NEW.id
 ON CONFLICT(sample_id)DO UPDATE SET dirty=true,dirty_generation=sample_retrieval_states.dirty_generation+1,updated_at=now();
 INSERT INTO component_retrieval_states(component_id,dirty,dirty_generation)SELECT DISTINCT rt.component_id,true,1 FROM content_component_revision_tags rt WHERE rt.tag_id=NEW.id ON CONFLICT(component_id)DO UPDATE SET dirty=true,dirty_generation=component_retrieval_states.dirty_generation+1,updated_at=now();RETURN NEW;END $$;


--
-- Name: sample_stage4_parent_child_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_parent_child_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE rid BIGINT;s TEXT;BEGIN rid:=CASE WHEN TG_OP='DELETE'THEN OLD.run_id ELSE NEW.run_id END;
 IF TG_TABLE_NAME LIKE 'sample_cluster_%' THEN SELECT status INTO s FROM sample_cluster_runs WHERE id=rid;ELSE SELECT status INTO s FROM sample_insight_runs WHERE id=rid;END IF;
 IF TG_OP='INSERT'THEN
  IF TG_TABLE_NAME='sample_cluster_run_profiles'THEN
   IF NOT EXISTS(SELECT 1 FROM sample_cluster_runs r JOIN sample_retrieval_algorithm_selections sel ON sel.id=r.algorithm_selection_id JOIN sample_retrieval_profiles p ON p.id=NEW.profile_id AND p.sample_id=NEW.sample_id AND p.build_id=sel.build_id AND p.algorithm_id=sel.algorithm_id AND p.status='complete'JOIN sample_retrieval_states st ON st.sample_id=NEW.sample_id AND st.last_profile_id=p.id AND NOT st.dirty AND st.current_fingerprint=p.input_sha256 WHERE r.id=NEW.run_id AND r.algorithm_selection_id=NEW.algorithm_selection_id)THEN RAISE EXCEPTION 'cluster input must pin a fresh selected profile' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME='sample_insight_statistics'THEN
   IF NOT EXISTS(SELECT 1 FROM sample_insight_run_features f WHERE f.run_id=NEW.run_id AND f.feature_key=NEW.feature_key)THEN RAISE EXCEPTION 'statistic feature must belong to the same run' USING ERRCODE='23503';END IF;
  END IF;
 END IF;
 IF s IN('complete','failed','cancelled')THEN RAISE EXCEPTION 'terminal run children immutable' USING ERRCODE='55000';END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;


--
-- Name: sample_stage4_profile_child_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_profile_child_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE s TEXT;pid BIGINT;BEGIN pid:=CASE WHEN TG_OP='DELETE'THEN OLD.profile_id ELSE NEW.profile_id END;SELECT status INTO s FROM sample_retrieval_profiles WHERE id=pid;
 IF s='complete'THEN RAISE EXCEPTION 'complete profile children are immutable' USING ERRCODE='55000';END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;


--
-- Name: sample_stage4_profile_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_profile_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE n INT;bad INT;BEGIN
 IF TG_OP='DELETE' AND OLD.status='complete' THEN RAISE EXCEPTION 'complete profile is immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='UPDATE' AND OLD.status='complete' THEN RAISE EXCEPTION 'complete profile is immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='INSERT' AND NEW.status<>'building' THEN RAISE EXCEPTION 'profile starts building' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT'AND NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.algorithm_id=NEW.algorithm_id AND b.status='running')THEN RAISE EXCEPTION 'profile requires its running algorithm build' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND NEW.status='complete' THEN SELECT count(*),count(*)FILTER(WHERE v.dimension_key IS NULL) INTO n,bad FROM sample_analysis_dimensions d LEFT JOIN sample_retrieval_dimension_vectors v ON v.profile_id=NEW.id AND v.dimension_key=d.dimension_key;
   IF n<>15 OR bad<>0 THEN RAISE EXCEPTION 'complete sample profile requires exactly 15 canonical vectors' USING ERRCODE='23514';END IF;
   IF NOT EXISTS(SELECT 1 FROM sample_analysis_versions av WHERE av.id=NEW.analysis_version_id AND av.sample_id=NEW.sample_id AND av.status='complete')THEN RAISE EXCEPTION 'profile analysis must be complete' USING ERRCODE='23514';END IF;
 END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;


--
-- Name: sample_stage4_selection_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_selection_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN IF TG_TABLE_NAME='sample_retrieval_algorithm_selections'THEN
  IF NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.algorithm_id=NEW.algorithm_id AND b.status='succeeded'AND b.failed_count=0 AND b.eligible_count=b.succeeded_count+b.excluded_count AND b.succeeded_count=(SELECT count(*)FROM sample_retrieval_build_items i WHERE i.build_id=b.id AND i.status='succeeded')AND b.excluded_count=(SELECT count(*)FROM sample_retrieval_build_items i WHERE i.build_id=b.id AND i.status='excluded')AND NOT EXISTS(SELECT 1 FROM sample_retrieval_build_items i WHERE i.build_id=b.id AND i.status='failed'))THEN RAISE EXCEPTION 'algorithm selection requires complete successful coverage' USING ERRCODE='23514';END IF;
 ELSE IF NOT EXISTS(SELECT 1 FROM sample_cluster_runs r WHERE r.id=NEW.run_id AND r.algorithm_selection_id=NEW.algorithm_selection_id AND r.status='complete')THEN RAISE EXCEPTION 'cluster selection requires a complete matching run' USING ERRCODE='23514';END IF;END IF;RETURN NEW;END $$;


--
-- Name: sample_stage4_tag_observation_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_tag_observation_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE k TEXT;active BOOLEAN;BEGIN SELECT kind,t.active INTO k,active FROM tags t WHERE id=NEW.tag_id;IF k IS DISTINCT FROM NEW.dimension_key OR active IS DISTINCT FROM true THEN RAISE EXCEPTION 'observation tag must be active and match dimension' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM sample_analysis_versions v WHERE v.id=NEW.analysis_version_id AND v.sample_id=NEW.sample_id AND v.status='complete')THEN RAISE EXCEPTION 'observation requires complete analysis' USING ERRCODE='23514';END IF;RETURN NEW;END $$;


--
-- Name: sample_stage4_vector_numeric_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sample_stage4_vector_numeric_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE calculated_norm BIGINT;calculated_nonzero INT;BEGIN SELECT COALESCE(sum(x::bigint*x::bigint),0),count(*)FILTER(WHERE x<>0)INTO calculated_norm,calculated_nonzero FROM unnest(NEW.vector)x;
 IF EXISTS(SELECT 1 FROM unnest(NEW.vector)x WHERE x=-32768)THEN RAISE EXCEPTION 'Q15 vectors may not contain -32768' USING ERRCODE='23514';END IF;
 IF calculated_norm<>NEW.norm_sq OR calculated_nonzero<>NEW.nonzero_count THEN RAISE EXCEPTION 'vector norm_sq/nonzero_count must equal its Q15 array' USING ERRCODE='23514';END IF;
 IF NEW.band_0<>(substring(NEW.simhash FROM 1 FOR 8)::bit(8)::int)OR NEW.band_1<>(substring(NEW.simhash FROM 9 FOR 8)::bit(8)::int)OR NEW.band_2<>(substring(NEW.simhash FROM 17 FOR 8)::bit(8)::int)OR NEW.band_3<>(substring(NEW.simhash FROM 25 FOR 8)::bit(8)::int)OR NEW.band_4<>(substring(NEW.simhash FROM 33 FOR 8)::bit(8)::int)OR NEW.band_5<>(substring(NEW.simhash FROM 41 FOR 8)::bit(8)::int)OR NEW.band_6<>(substring(NEW.simhash FROM 49 FOR 8)::bit(8)::int)OR NEW.band_7<>(substring(NEW.simhash FROM 57 FOR 8)::bit(8)::int)THEN RAISE EXCEPTION 'LSH bands must match simhash big-endian bit order' USING ERRCODE='23514';END IF;RETURN NEW;END $$;


--
-- Name: samples_validate_current_analysis_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.samples_validate_current_analysis_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_status TEXT;
BEGIN
  IF NEW.current_analysis_version_id IS NULL THEN RETURN NEW; END IF;
  SELECT status INTO v_status FROM sample_analysis_versions
   WHERE sample_id=NEW.id AND id=NEW.current_analysis_version_id;
  IF v_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'samples.current_analysis_version_id must reference a complete version';
  END IF;
  RETURN NEW;
END $$;


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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_url text
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
-- Name: component_retrieval_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.component_retrieval_profiles (
    id bigint NOT NULL,
    build_id bigint NOT NULL,
    algorithm_id bigint NOT NULL,
    component_id bigint NOT NULL,
    selection_id bigint NOT NULL,
    revision_id bigint NOT NULL,
    approving_decision_id bigint NOT NULL,
    dimension_key text NOT NULL,
    status text DEFAULT 'building'::text NOT NULL,
    input_sha256 text NOT NULL,
    frozen_name text NOT NULL,
    frozen_summary text NOT NULL,
    frozen_applicability text,
    frozen_limitations text,
    frozen_source_count integer NOT NULL,
    frozen_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT component_retrieval_profiles_completion_chk CHECK (((status = 'complete'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT component_retrieval_profiles_hash_chk CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT component_retrieval_profiles_source_count_chk CHECK ((frozen_source_count >= 0)),
    CONSTRAINT component_retrieval_profiles_status_chk CHECK ((status = ANY (ARRAY['building'::text, 'complete'::text])))
);


--
-- Name: component_retrieval_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.component_retrieval_profiles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: component_retrieval_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.component_retrieval_profiles_id_seq OWNED BY public.component_retrieval_profiles.id;


--
-- Name: component_retrieval_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.component_retrieval_states (
    component_id bigint NOT NULL,
    dirty boolean DEFAULT true NOT NULL,
    dirty_generation bigint DEFAULT 1 NOT NULL,
    current_fingerprint text,
    last_profile_id bigint,
    last_build_id bigint,
    last_error_code text,
    last_error_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT component_retrieval_states_generation_chk CHECK ((dirty_generation >= 1))
);


--
-- Name: component_retrieval_vectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.component_retrieval_vectors (
    id bigint NOT NULL,
    profile_id bigint NOT NULL,
    component_id bigint NOT NULL,
    selection_id bigint NOT NULL,
    revision_id bigint NOT NULL,
    approving_decision_id bigint NOT NULL,
    dimension_key text NOT NULL,
    vector smallint[] NOT NULL,
    norm_sq bigint NOT NULL,
    nonzero_count smallint NOT NULL,
    simhash bit(64) NOT NULL,
    band_0 smallint NOT NULL,
    band_1 smallint NOT NULL,
    band_2 smallint NOT NULL,
    band_3 smallint NOT NULL,
    band_4 smallint NOT NULL,
    band_5 smallint NOT NULL,
    band_6 smallint NOT NULL,
    band_7 smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT component_retrieval_vectors_bands_chk CHECK ((((band_0 >= 0) AND (band_0 <= 255)) AND ((band_1 >= 0) AND (band_1 <= 255)) AND ((band_2 >= 0) AND (band_2 <= 255)) AND ((band_3 >= 0) AND (band_3 <= 255)) AND ((band_4 >= 0) AND (band_4 <= 255)) AND ((band_5 >= 0) AND (band_5 <= 255)) AND ((band_6 >= 0) AND (band_6 <= 255)) AND ((band_7 >= 0) AND (band_7 <= 255)))),
    CONSTRAINT component_retrieval_vectors_norm_chk CHECK (((norm_sq >= 0) AND ((nonzero_count >= 0) AND (nonzero_count <= 256)))),
    CONSTRAINT component_retrieval_vectors_shape_chk CHECK (((array_ndims(vector) = 1) AND (array_lower(vector, 1) = 1) AND (array_length(vector, 1) = 256)))
);


--
-- Name: component_retrieval_vectors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.component_retrieval_vectors_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: component_retrieval_vectors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.component_retrieval_vectors_id_seq OWNED BY public.component_retrieval_vectors.id;


--
-- Name: content_component_lifecycle_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_component_lifecycle_events (
    id bigint NOT NULL,
    component_id bigint NOT NULL,
    event_type text NOT NULL,
    reason text,
    actor_id bigint,
    actor_role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_component_lifecycle_events_reason_chk CHECK (((reason IS NULL) OR (char_length(reason) <= 4000))),
    CONSTRAINT content_component_lifecycle_events_role_chk CHECK ((actor_role = 'admin'::text)),
    CONSTRAINT content_component_lifecycle_events_type_chk CHECK ((event_type = ANY (ARRAY['retired'::text, 'reactivated'::text])))
);


--
-- Name: content_component_lifecycle_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_component_lifecycle_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_component_lifecycle_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_component_lifecycle_events_id_seq OWNED BY public.content_component_lifecycle_events.id;


--
-- Name: content_component_revision_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_component_revision_decisions (
    id bigint NOT NULL,
    component_id bigint NOT NULL,
    revision_id bigint NOT NULL,
    decision text NOT NULL,
    note text,
    actor_id bigint,
    actor_role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_component_revision_decisions_decision_chk CHECK ((decision = ANY (ARRAY['submitted'::text, 'approved'::text, 'changes_requested'::text]))),
    CONSTRAINT content_component_revision_decisions_note_chk CHECK (((note IS NULL) OR (char_length(note) <= 4000))),
    CONSTRAINT content_component_revision_decisions_role_chk CHECK ((actor_role = ANY (ARRAY['member'::text, 'reviewer'::text, 'admin'::text])))
);


--
-- Name: content_component_revision_decisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_component_revision_decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_component_revision_decisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_component_revision_decisions_id_seq OWNED BY public.content_component_revision_decisions.id;


--
-- Name: content_component_revision_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_component_revision_sources (
    id bigint NOT NULL,
    component_id bigint NOT NULL,
    revision_id bigint NOT NULL,
    revision_dimension_key text NOT NULL,
    extraction_id bigint NOT NULL,
    extraction_dimension_key text NOT NULL,
    source_role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_component_revision_sources_dimension_chk CHECK ((revision_dimension_key = extraction_dimension_key)),
    CONSTRAINT content_component_revision_sources_role_chk CHECK ((source_role = ANY (ARRAY['primary'::text, 'supporting'::text])))
);


--
-- Name: content_component_revision_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_component_revision_sources_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_component_revision_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_component_revision_sources_id_seq OWNED BY public.content_component_revision_sources.id;


--
-- Name: content_component_revision_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_component_revision_tags (
    id bigint NOT NULL,
    component_id bigint NOT NULL,
    revision_id bigint NOT NULL,
    tag_id bigint NOT NULL,
    origin text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_component_revision_tags_origin_chk CHECK ((origin = ANY (ARRAY['manual'::text, 'ai'::text])))
);


--
-- Name: content_component_revision_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_component_revision_tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_component_revision_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_component_revision_tags_id_seq OWNED BY public.content_component_revision_tags.id;


--
-- Name: content_component_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_component_revisions (
    id bigint NOT NULL,
    component_id bigint NOT NULL,
    revision integer NOT NULL,
    dimension_key text NOT NULL,
    origin text NOT NULL,
    state text DEFAULT 'draft'::text NOT NULL,
    name text NOT NULL,
    pattern_text text NOT NULL,
    function_text text NOT NULL,
    applicability text NOT NULL,
    limitations text NOT NULL,
    do_not_copy text NOT NULL,
    content_sha256 text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_component_revisions_fields_chk CHECK ((((char_length(name) >= 1) AND (char_length(name) <= 200)) AND ((char_length(pattern_text) >= 1) AND (char_length(pattern_text) <= 12000)) AND ((char_length(function_text) >= 1) AND (char_length(function_text) <= 12000)) AND ((char_length(applicability) >= 1) AND (char_length(applicability) <= 12000)) AND ((char_length(limitations) >= 1) AND (char_length(limitations) <= 12000)) AND ((char_length(do_not_copy) >= 1) AND (char_length(do_not_copy) <= 12000)))),
    CONSTRAINT content_component_revisions_hash_chk CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT content_component_revisions_origin_chk CHECK ((origin = ANY (ARRAY['manual'::text, 'ai'::text]))),
    CONSTRAINT content_component_revisions_revision_chk CHECK ((revision > 0)),
    CONSTRAINT content_component_revisions_state_chk CHECK ((state = ANY (ARRAY['draft'::text, 'submitted'::text, 'approved'::text, 'changes_requested'::text])))
);


--
-- Name: content_component_revisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_component_revisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_component_revisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_component_revisions_id_seq OWNED BY public.content_component_revisions.id;


--
-- Name: content_component_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_component_selections (
    id bigint NOT NULL,
    component_id bigint NOT NULL,
    revision_id bigint NOT NULL,
    decision_id bigint NOT NULL,
    selected_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: content_component_selections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_component_selections_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_component_selections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_component_selections_id_seq OWNED BY public.content_component_selections.id;


--
-- Name: content_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_components (
    id bigint NOT NULL,
    name text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_components_lifecycle_chk CHECK ((lifecycle_state = ANY (ARRAY['active'::text, 'retired'::text]))),
    CONSTRAINT content_components_name_chk CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200)))
);


--
-- Name: content_components_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_components_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_components_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_components_id_seq OWNED BY public.content_components.id;


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
-- Name: sample_analysis_dimensions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_analysis_dimensions (
    dimension_key text NOT NULL,
    ordinal smallint NOT NULL,
    label text NOT NULL,
    description text NOT NULL,
    CONSTRAINT sample_analysis_dimensions_key_chk CHECK ((dimension_key = ANY (ARRAY['audience'::text, 'user_need'::text, 'topic'::text, 'core_viewpoint'::text, 'breakout_point'::text, 'title_mechanism'::text, 'opening_method'::text, 'content_structure'::text, 'argumentation_method'::text, 'language_style'::text, 'length'::text, 'layout'::text, 'visual_style'::text, 'bgm'::text, 'cta'::text]))),
    CONSTRAINT sample_analysis_dimensions_label_chk CHECK (((char_length(label) >= 1) AND (char_length(label) <= 40))),
    CONSTRAINT sample_analysis_dimensions_ordinal_chk CHECK (((ordinal >= 1) AND (ordinal <= 15)))
);


--
-- Name: sample_analysis_elements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_analysis_elements (
    id bigint NOT NULL,
    version_id bigint NOT NULL,
    dimension_key text NOT NULL,
    state text DEFAULT 'insufficient'::text NOT NULL,
    value_json jsonb,
    function_text text,
    confidence numeric(4,3),
    evidence_strength text DEFAULT 'none'::text NOT NULL,
    applicability text,
    limitations text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_analysis_elements_confidence_chk CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT sample_analysis_elements_evidence_strength_chk CHECK ((evidence_strength = ANY (ARRAY['none'::text, 'weak'::text, 'medium'::text, 'strong'::text]))),
    CONSTRAINT sample_analysis_elements_state_chk CHECK ((state = ANY (ARRAY['value'::text, 'insufficient'::text, 'not_applicable'::text]))),
    CONSTRAINT sample_analysis_elements_value_chk CHECK ((((state = 'value'::text) AND (value_json IS NOT NULL) AND (value_json <> 'null'::jsonb)) OR ((state = ANY (ARRAY['insufficient'::text, 'not_applicable'::text])) AND (value_json IS NULL))))
);


--
-- Name: sample_analysis_elements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_analysis_elements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_analysis_elements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_analysis_elements_id_seq OWNED BY public.sample_analysis_elements.id;


--
-- Name: sample_analysis_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_analysis_jobs (
    id bigint NOT NULL,
    sample_id bigint NOT NULL,
    source_capture_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    input_sha256 text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 3 NOT NULL,
    select_on_success boolean DEFAULT true NOT NULL,
    provider text,
    model_name text,
    requested_by bigint,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_analysis_jobs_attempts_chk CHECK ((((attempts >= 0) AND (attempts <= 20)) AND ((max_attempts >= 1) AND (max_attempts <= 20)) AND (attempts <= max_attempts))),
    CONSTRAINT sample_analysis_jobs_idempotency_chk CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 160))),
    CONSTRAINT sample_analysis_jobs_input_sha256_chk CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_analysis_jobs_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: sample_analysis_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_analysis_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_analysis_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_analysis_jobs_id_seq OWNED BY public.sample_analysis_jobs.id;


--
-- Name: sample_analysis_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_analysis_selections (
    id bigint NOT NULL,
    sample_id bigint NOT NULL,
    version_id bigint NOT NULL,
    reason text NOT NULL,
    selected_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_analysis_selections_reason_chk CHECK ((reason = ANY (ARRAY['run_success'::text, 'explicit'::text, 'migration'::text])))
);


--
-- Name: sample_analysis_selections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_analysis_selections_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_analysis_selections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_analysis_selections_id_seq OWNED BY public.sample_analysis_selections.id;


--
-- Name: sample_analysis_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_analysis_versions (
    id bigint NOT NULL,
    sample_id bigint NOT NULL,
    job_id bigint,
    source_capture_id bigint NOT NULL,
    revision integer NOT NULL,
    source text NOT NULL,
    status text DEFAULT 'building'::text NOT NULL,
    input_sha256 text NOT NULL,
    schema_version text NOT NULL,
    prompt_version text,
    model_provider text,
    model_name text,
    model_version text,
    manifest_sha256 text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT sample_analysis_versions_ai_metadata_chk CHECK (((source <> 'ai'::text) OR ((prompt_version IS NOT NULL) AND (model_provider IS NOT NULL) AND (model_name IS NOT NULL) AND (model_version IS NOT NULL)))),
    CONSTRAINT sample_analysis_versions_completion_chk CHECK ((((status = 'building'::text) AND (completed_at IS NULL)) OR ((status = 'complete'::text) AND (completed_at IS NOT NULL)))),
    CONSTRAINT sample_analysis_versions_input_sha256_chk CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_analysis_versions_manifest_sha256_chk CHECK ((manifest_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_analysis_versions_revision_chk CHECK ((revision > 0)),
    CONSTRAINT sample_analysis_versions_source_chk CHECK ((source = ANY (ARRAY['ai'::text, 'manual'::text, 'legacy'::text]))),
    CONSTRAINT sample_analysis_versions_source_job_chk CHECK ((((source = 'ai'::text) AND (job_id IS NOT NULL)) OR ((source = ANY (ARRAY['manual'::text, 'legacy'::text])) AND (job_id IS NULL)))),
    CONSTRAINT sample_analysis_versions_status_chk CHECK ((status = ANY (ARRAY['building'::text, 'complete'::text])))
);


--
-- Name: sample_analysis_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_analysis_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_analysis_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_analysis_versions_id_seq OWNED BY public.sample_analysis_versions.id;


--
-- Name: sample_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_assets (
    id bigint NOT NULL,
    sample_id bigint NOT NULL,
    capture_id bigint,
    kind text NOT NULL,
    storage_key text NOT NULL,
    original_name text,
    mime_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    byte_size bigint NOT NULL,
    sha256 text NOT NULL,
    width integer,
    height integer,
    duration_ms bigint,
    source_url text,
    archive_quality text DEFAULT 'unknown'::text NOT NULL,
    uploaded_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT sample_assets_dimensions_chk CHECK ((((width IS NULL) OR (width >= 0)) AND ((height IS NULL) OR (height >= 0)) AND ((duration_ms IS NULL) OR (duration_ms >= 0)))),
    CONSTRAINT sample_assets_kind_chk CHECK ((kind = ANY (ARRAY['cover'::text, 'image'::text, 'video'::text, 'audio'::text, 'other'::text]))),
    CONSTRAINT sample_assets_quality_chk CHECK ((archive_quality = ANY (ARRAY['original'::text, 'original_images'::text, 'platform_available'::text, 'platform_archive'::text, 'bounded_720p'::text, 'preview'::text, 'user_upload'::text, 'unavailable'::text, 'unknown'::text]))),
    CONSTRAINT sample_assets_sha256_chk CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_assets_size_chk CHECK ((byte_size >= 0)),
    CONSTRAINT sample_assets_storage_key_chk CHECK ((storage_key ~ '^[0-9a-f]{48}$'::text))
);


--
-- Name: sample_assets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_assets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_assets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_assets_id_seq OWNED BY public.sample_assets.id;


--
-- Name: sample_captures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_captures (
    id bigint NOT NULL,
    sample_id bigint NOT NULL,
    capture_key text,
    capture_type text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    source_url text,
    raw_payload json DEFAULT '{}'::json NOT NULL,
    normalized_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload_sha256 text NOT NULL,
    completeness_score smallint DEFAULT 0 NOT NULL,
    missing_fields text[] DEFAULT '{}'::text[] NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_captures_score_chk CHECK (((completeness_score >= 0) AND (completeness_score <= 100))),
    CONSTRAINT sample_captures_sha256_chk CHECK ((payload_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_captures_type_chk CHECK ((capture_type = ANY (ARRAY['manual'::text, 'link'::text, 'upload'::text, 'collector'::text, 'legacy'::text])))
);


--
-- Name: sample_captures_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_captures_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_captures_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_captures_id_seq OWNED BY public.sample_captures.id;


--
-- Name: sample_cluster_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_cluster_jobs (
    id bigint NOT NULL,
    algorithm_selection_id bigint NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    idempotency_key text NOT NULL,
    request_sha256 text NOT NULL,
    requested_by bigint,
    attempts smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 3 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT sample_cluster_jobs_attempts_chk CHECK ((((attempts >= 0) AND (attempts <= max_attempts)) AND (max_attempts = 3))),
    CONSTRAINT sample_cluster_jobs_hash_chk CHECK ((request_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_cluster_jobs_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT sample_cluster_jobs_terminal_chk CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) = (finished_at IS NOT NULL)))
);


--
-- Name: sample_cluster_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_cluster_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_cluster_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_cluster_jobs_id_seq OWNED BY public.sample_cluster_jobs.id;


--
-- Name: sample_cluster_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_cluster_members (
    run_id bigint NOT NULL,
    sample_id bigint NOT NULL,
    profile_id bigint NOT NULL,
    cluster_id bigint,
    is_outlier boolean NOT NULL,
    representative boolean DEFAULT false NOT NULL,
    pair_mean numeric(8,7),
    CONSTRAINT sample_cluster_members_assignment_chk CHECK (((is_outlier AND (cluster_id IS NULL) AND (NOT representative)) OR ((NOT is_outlier) AND (cluster_id IS NOT NULL)))),
    CONSTRAINT sample_cluster_members_pair_mean_chk CHECK (((pair_mean IS NULL) OR ((pair_mean >= ('-1'::integer)::numeric) AND (pair_mean <= (1)::numeric))))
);


--
-- Name: sample_cluster_run_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_cluster_run_profiles (
    run_id bigint NOT NULL,
    algorithm_selection_id bigint NOT NULL,
    sample_id bigint NOT NULL,
    profile_id bigint NOT NULL,
    ordinal integer NOT NULL,
    CONSTRAINT sample_cluster_run_profiles_ordinal_chk CHECK ((ordinal > 0))
);


--
-- Name: sample_cluster_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_cluster_runs (
    id bigint NOT NULL,
    job_id bigint NOT NULL,
    algorithm_selection_id bigint NOT NULL,
    status text DEFAULT 'building'::text NOT NULL,
    algorithm_version text NOT NULL,
    input_sha256 text NOT NULL,
    profile_count integer DEFAULT 0 NOT NULL,
    limitation text DEFAULT '聚类仅描述结构相似性，不代表内容价值或表现因果。'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT sample_cluster_runs_completion_chk CHECK (((status = ANY (ARRAY['complete'::text, 'failed'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT sample_cluster_runs_hash_chk CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_cluster_runs_status_chk CHECK ((status = ANY (ARRAY['building'::text, 'complete'::text, 'failed'::text])))
);


--
-- Name: sample_cluster_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_cluster_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_cluster_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_cluster_runs_id_seq OWNED BY public.sample_cluster_runs.id;


--
-- Name: sample_cluster_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_cluster_selections (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    algorithm_selection_id bigint NOT NULL,
    selected_by bigint,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_cluster_selections_reason_chk CHECK ((reason = ANY (ARRAY['job_success'::text, 'explicit'::text, 'rollback'::text])))
);


--
-- Name: sample_cluster_selections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_cluster_selections_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_cluster_selections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_cluster_selections_id_seq OWNED BY public.sample_cluster_selections.id;


--
-- Name: sample_clusters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_clusters (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    ordinal integer NOT NULL,
    cluster_key text NOT NULL,
    representative_sample_id bigint NOT NULL,
    label text NOT NULL,
    summary text NOT NULL,
    cohesion numeric(8,7),
    common_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    distinguishing_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    dimension_contributions jsonb DEFAULT '[]'::jsonb NOT NULL,
    limitation text NOT NULL,
    CONSTRAINT sample_clusters_cohesion_chk CHECK (((cohesion IS NULL) OR ((cohesion >= ('-1'::integer)::numeric) AND (cohesion <= (1)::numeric)))),
    CONSTRAINT sample_clusters_key_chk CHECK ((cluster_key ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_clusters_ordinal_chk CHECK ((ordinal > 0))
);


--
-- Name: sample_clusters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_clusters_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_clusters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_clusters_id_seq OWNED BY public.sample_clusters.id;


--
-- Name: sample_comparison_assessment_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_comparison_assessment_jobs (
    id bigint NOT NULL,
    comparison_id bigint NOT NULL,
    scope_id bigint NOT NULL,
    target text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    request_sha256 text NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 3 NOT NULL,
    provider text NOT NULL,
    model_name text NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    error_code text,
    error_message text,
    requested_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT sample_comparison_assessment_jobs_attempts_chk CHECK ((((attempts >= 0) AND (attempts <= max_attempts)) AND ((max_attempts >= 1) AND (max_attempts <= 20)))),
    CONSTRAINT sample_comparison_assessment_jobs_error_chk CHECK (((error_message IS NULL) OR (char_length(error_message) <= 400))),
    CONSTRAINT sample_comparison_assessment_jobs_hash_chk CHECK ((request_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_comparison_assessment_jobs_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT sample_comparison_assessment_jobs_target_chk CHECK ((target = ANY (ARRAY['traffic'::text, 'persona'::text, 'expertise'::text, 'conversion'::text])))
);


--
-- Name: sample_comparison_assessment_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_comparison_assessment_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_comparison_assessment_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_comparison_assessment_jobs_id_seq OWNED BY public.sample_comparison_assessment_jobs.id;


--
-- Name: sample_comparison_assessment_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_comparison_assessment_selections (
    id bigint NOT NULL,
    comparison_id bigint NOT NULL,
    target text NOT NULL,
    assessment_id bigint NOT NULL,
    reason text,
    selected_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_comparison_assessment_selections_reason_chk CHECK (((reason IS NULL) OR (char_length(reason) <= 4000))),
    CONSTRAINT sample_comparison_assessment_selections_target_chk CHECK ((target = ANY (ARRAY['traffic'::text, 'persona'::text, 'expertise'::text, 'conversion'::text])))
);


--
-- Name: sample_comparison_assessment_selections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_comparison_assessment_selections_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_comparison_assessment_selections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_comparison_assessment_selections_id_seq OWNED BY public.sample_comparison_assessment_selections.id;


--
-- Name: sample_comparison_assessments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_comparison_assessments (
    id bigint NOT NULL,
    comparison_id bigint NOT NULL,
    scope_id bigint NOT NULL,
    job_id bigint,
    target text NOT NULL,
    source text NOT NULL,
    revision integer NOT NULL,
    common_points jsonb DEFAULT '[]'::jsonb NOT NULL,
    key_differences jsonb DEFAULT '[]'::jsonb NOT NULL,
    strengths jsonb DEFAULT '[]'::jsonb NOT NULL,
    limitations jsonb DEFAULT '[]'::jsonb NOT NULL,
    worth_learning jsonb DEFAULT '[]'::jsonb NOT NULL,
    do_not_copy jsonb DEFAULT '[]'::jsonb NOT NULL,
    hypotheses jsonb DEFAULT '[]'::jsonb NOT NULL,
    open_questions jsonb DEFAULT '[]'::jsonb NOT NULL,
    method_limitations jsonb DEFAULT '[]'::jsonb NOT NULL,
    input_sha256 text NOT NULL,
    schema_version text NOT NULL,
    prompt_version text,
    model_provider text,
    model_name text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_comparison_assessments_ai_metadata_chk CHECK ((((source = 'manual'::text) AND (job_id IS NULL) AND (prompt_version IS NULL) AND (model_provider IS NULL) AND (model_name IS NULL)) OR ((source = 'ai'::text) AND (job_id IS NOT NULL) AND (prompt_version IS NOT NULL) AND (model_provider IS NOT NULL) AND (model_name IS NOT NULL)))),
    CONSTRAINT sample_comparison_assessments_arrays_chk CHECK (((jsonb_typeof(common_points) = 'array'::text) AND (jsonb_typeof(key_differences) = 'array'::text) AND (jsonb_typeof(strengths) = 'array'::text) AND (jsonb_typeof(limitations) = 'array'::text) AND (jsonb_typeof(worth_learning) = 'array'::text) AND (jsonb_typeof(do_not_copy) = 'array'::text) AND (jsonb_typeof(hypotheses) = 'array'::text) AND (jsonb_typeof(open_questions) = 'array'::text) AND (jsonb_typeof(method_limitations) = 'array'::text))),
    CONSTRAINT sample_comparison_assessments_hash_chk CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_comparison_assessments_revision_chk CHECK ((revision > 0)),
    CONSTRAINT sample_comparison_assessments_source_chk CHECK ((source = ANY (ARRAY['manual'::text, 'ai'::text]))),
    CONSTRAINT sample_comparison_assessments_target_chk CHECK ((target = ANY (ARRAY['traffic'::text, 'persona'::text, 'expertise'::text, 'conversion'::text])))
);


--
-- Name: sample_comparison_assessments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_comparison_assessments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_comparison_assessments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_comparison_assessments_id_seq OWNED BY public.sample_comparison_assessments.id;


--
-- Name: sample_comparison_finding_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_comparison_finding_evidence (
    id bigint NOT NULL,
    assessment_id bigint NOT NULL,
    finding_id bigint NOT NULL,
    member_sample_id bigint NOT NULL,
    scope_id bigint NOT NULL,
    snapshot_id bigint NOT NULL,
    dimension_key text NOT NULL,
    evidence_token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_comparison_finding_evidence_token_chk CHECK (((char_length(evidence_token) >= 1) AND (char_length(evidence_token) <= 160)))
);


--
-- Name: sample_comparison_finding_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_comparison_finding_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_comparison_finding_evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_comparison_finding_evidence_id_seq OWNED BY public.sample_comparison_finding_evidence.id;


--
-- Name: sample_comparison_findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_comparison_findings (
    id bigint NOT NULL,
    comparison_id bigint NOT NULL,
    scope_id bigint NOT NULL,
    assessment_id bigint NOT NULL,
    target text NOT NULL,
    member_sample_id bigint,
    kind text NOT NULL,
    claim_text text NOT NULL,
    limitations text,
    evidence_state text NOT NULL,
    ordinal smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_comparison_findings_claim_chk CHECK (((char_length(claim_text) >= 1) AND (char_length(claim_text) <= 4000))),
    CONSTRAINT sample_comparison_findings_evidence_chk CHECK ((evidence_state = ANY (ARRAY['verified'::text, 'manual_unverified'::text, 'insufficient'::text]))),
    CONSTRAINT sample_comparison_findings_hypothesis_chk CHECK (((kind <> 'hypothesis'::text) OR ((char_length(COALESCE(limitations, ''::text)) >= 1) AND (char_length(COALESCE(limitations, ''::text)) <= 12000)))),
    CONSTRAINT sample_comparison_findings_kind_chk CHECK ((kind = ANY (ARRAY['observation'::text, 'hypothesis'::text, 'recommendation'::text]))),
    CONSTRAINT sample_comparison_findings_ordinal_chk CHECK (((ordinal >= 1) AND (ordinal <= 60)))
);


--
-- Name: sample_comparison_findings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_comparison_findings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_comparison_findings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_comparison_findings_id_seq OWNED BY public.sample_comparison_findings.id;


--
-- Name: sample_comparison_scope_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_comparison_scope_members (
    id bigint NOT NULL,
    comparison_id bigint NOT NULL,
    scope_id bigint NOT NULL,
    sample_id bigint NOT NULL,
    analysis_version_id bigint NOT NULL,
    ordinal smallint NOT NULL,
    frozen_title text NOT NULL,
    frozen_account_name text,
    frozen_account_handle text,
    frozen_platform text NOT NULL,
    frozen_published_at timestamp with time zone,
    metric_snapshot_id bigint,
    frozen_metric_observed_at timestamp with time zone,
    observation_window_seconds bigint,
    frozen_metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_comparison_scope_members_metrics_chk CHECK ((jsonb_typeof(frozen_metrics) = 'object'::text)),
    CONSTRAINT sample_comparison_scope_members_ordinal_chk CHECK (((ordinal >= 1) AND (ordinal <= 6))),
    CONSTRAINT sample_comparison_scope_members_title_chk CHECK (((char_length(frozen_title) >= 1) AND (char_length(frozen_title) <= 500))),
    CONSTRAINT sample_comparison_scope_members_window_chk CHECK (((observation_window_seconds IS NULL) OR (observation_window_seconds >= 0)))
);


--
-- Name: sample_comparison_scope_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_comparison_scope_members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_comparison_scope_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_comparison_scope_members_id_seq OWNED BY public.sample_comparison_scope_members.id;


--
-- Name: sample_comparison_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_comparison_scopes (
    id bigint NOT NULL,
    comparison_id bigint NOT NULL,
    revision integer NOT NULL,
    status text DEFAULT 'building'::text NOT NULL,
    topic_basis text NOT NULL,
    purpose text,
    input_sha256 text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT sample_comparison_scopes_completion_chk CHECK ((((status = 'building'::text) AND (completed_at IS NULL)) OR ((status = 'complete'::text) AND (completed_at IS NOT NULL)))),
    CONSTRAINT sample_comparison_scopes_hash_chk CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_comparison_scopes_purpose_chk CHECK (((purpose IS NULL) OR (char_length(purpose) <= 4000))),
    CONSTRAINT sample_comparison_scopes_revision_chk CHECK ((revision > 0)),
    CONSTRAINT sample_comparison_scopes_status_chk CHECK ((status = ANY (ARRAY['building'::text, 'complete'::text]))),
    CONSTRAINT sample_comparison_scopes_topic_chk CHECK (((char_length(topic_basis) >= 1) AND (char_length(topic_basis) <= 160)))
);


--
-- Name: sample_comparison_scopes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_comparison_scopes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_comparison_scopes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_comparison_scopes_id_seq OWNED BY public.sample_comparison_scopes.id;


--
-- Name: sample_comparison_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_comparison_snapshots (
    id bigint NOT NULL,
    comparison_id bigint NOT NULL,
    scope_id bigint NOT NULL,
    sample_id bigint NOT NULL,
    analysis_version_id bigint NOT NULL,
    element_id bigint NOT NULL,
    dimension_key text NOT NULL,
    latest_decision_id bigint,
    effective_state text NOT NULL,
    effective_value jsonb,
    function_text text,
    applicability text,
    limitations text,
    evidence_state text NOT NULL,
    evidence_tokens jsonb DEFAULT '[]'::jsonb NOT NULL,
    value_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_comparison_snapshots_evidence_state_chk CHECK ((evidence_state = ANY (ARRAY['verified'::text, 'manual_unverified'::text, 'insufficient'::text]))),
    CONSTRAINT sample_comparison_snapshots_hash_chk CHECK ((value_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_comparison_snapshots_state_chk CHECK ((effective_state = ANY (ARRAY['value'::text, 'insufficient'::text, 'not_applicable'::text, 'rejected'::text]))),
    CONSTRAINT sample_comparison_snapshots_tokens_chk CHECK (((jsonb_typeof(evidence_tokens) = 'array'::text) AND (jsonb_array_length(evidence_tokens) <= 20))),
    CONSTRAINT sample_comparison_snapshots_value_chk CHECK ((((effective_state = 'value'::text) AND (effective_value IS NOT NULL) AND (effective_value <> 'null'::jsonb)) OR ((effective_state <> 'value'::text) AND (effective_value IS NULL))))
);


--
-- Name: sample_comparison_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_comparison_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_comparison_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_comparison_snapshots_id_seq OWNED BY public.sample_comparison_snapshots.id;


--
-- Name: sample_comparisons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_comparisons (
    id bigint NOT NULL,
    title text NOT NULL,
    purpose text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_comparisons_purpose_chk CHECK (((purpose IS NULL) OR (char_length(purpose) <= 4000))),
    CONSTRAINT sample_comparisons_title_chk CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200)))
);


--
-- Name: sample_comparisons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_comparisons_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_comparisons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_comparisons_id_seq OWNED BY public.sample_comparisons.id;


--
-- Name: sample_element_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_element_decisions (
    id bigint NOT NULL,
    element_id bigint NOT NULL,
    decision text NOT NULL,
    value_json jsonb,
    function_text text,
    applicability text,
    limitations text,
    note text,
    idempotency_key text,
    decided_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_element_decisions_decision_chk CHECK ((decision = ANY (ARRAY['confirmed'::text, 'edited'::text, 'rejected'::text]))),
    CONSTRAINT sample_element_decisions_idempotency_chk CHECK (((idempotency_key IS NULL) OR ((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 160)))),
    CONSTRAINT sample_element_decisions_value_chk CHECK ((((decision = 'edited'::text) AND (value_json IS NOT NULL) AND (value_json <> 'null'::jsonb)) OR ((decision = ANY (ARRAY['confirmed'::text, 'rejected'::text])) AND (value_json IS NULL))))
);


--
-- Name: sample_element_decisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_element_decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_element_decisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_element_decisions_id_seq OWNED BY public.sample_element_decisions.id;


--
-- Name: sample_element_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_element_evidence (
    id bigint NOT NULL,
    version_id bigint NOT NULL,
    element_id bigint NOT NULL,
    source_id text NOT NULL,
    verification_status text DEFAULT 'unresolved'::text NOT NULL,
    quote_text text,
    quote_sha256 text,
    start_offset integer,
    end_offset integer,
    time_start_ms bigint,
    time_end_ms bigint,
    json_path text,
    comment_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_element_evidence_offsets_chk CHECK ((((start_offset IS NULL) AND (end_offset IS NULL)) OR ((start_offset IS NOT NULL) AND (end_offset IS NOT NULL) AND (start_offset >= 0) AND (end_offset >= start_offset)))),
    CONSTRAINT sample_element_evidence_quote_chk CHECK (((verification_status <> 'verified'::text) OR ((quote_text IS NOT NULL) AND (char_length(quote_text) > 0) AND (quote_sha256 ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT sample_element_evidence_quote_sha256_chk CHECK (((quote_sha256 IS NULL) OR (quote_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT sample_element_evidence_status_chk CHECK ((verification_status = ANY (ARRAY['verified'::text, 'unresolved'::text, 'invalid'::text]))),
    CONSTRAINT sample_element_evidence_times_chk CHECK ((((time_start_ms IS NULL) AND (time_end_ms IS NULL)) OR ((time_start_ms IS NOT NULL) AND (time_end_ms IS NOT NULL) AND (time_start_ms >= 0) AND (time_end_ms >= time_start_ms))))
);


--
-- Name: sample_element_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_element_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_element_evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_element_evidence_id_seq OWNED BY public.sample_element_evidence.id;


--
-- Name: sample_element_extraction_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_element_extraction_sources (
    id bigint NOT NULL,
    extraction_id bigint NOT NULL,
    extraction_dimension_key text NOT NULL,
    comparison_id bigint NOT NULL,
    scope_id bigint NOT NULL,
    sample_id bigint NOT NULL,
    snapshot_id bigint NOT NULL,
    snapshot_dimension_key text NOT NULL,
    source_role text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_element_extraction_sources_dimension_chk CHECK ((extraction_dimension_key = snapshot_dimension_key)),
    CONSTRAINT sample_element_extraction_sources_note_chk CHECK (((note IS NULL) OR (char_length(note) <= 4000))),
    CONSTRAINT sample_element_extraction_sources_role_chk CHECK ((source_role = ANY (ARRAY['primary'::text, 'supporting'::text, 'counterexample'::text])))
);


--
-- Name: sample_element_extraction_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_element_extraction_sources_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_element_extraction_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_element_extraction_sources_id_seq OWNED BY public.sample_element_extraction_sources.id;


--
-- Name: sample_element_extractions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_element_extractions (
    id bigint NOT NULL,
    comparison_id bigint NOT NULL,
    scope_id bigint NOT NULL,
    assessment_id bigint,
    dimension_key text NOT NULL,
    origin text NOT NULL,
    status text DEFAULT 'building'::text NOT NULL,
    pattern_text text NOT NULL,
    function_text text NOT NULL,
    rationale text NOT NULL,
    applicability text NOT NULL,
    limitations text NOT NULL,
    do_not_copy text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT sample_element_extractions_completion_chk CHECK ((((status = 'building'::text) AND (completed_at IS NULL)) OR ((status = 'complete'::text) AND (completed_at IS NOT NULL)))),
    CONSTRAINT sample_element_extractions_fields_chk CHECK ((((char_length(pattern_text) >= 1) AND (char_length(pattern_text) <= 12000)) AND ((char_length(function_text) >= 1) AND (char_length(function_text) <= 12000)) AND ((char_length(rationale) >= 1) AND (char_length(rationale) <= 12000)) AND ((char_length(applicability) >= 1) AND (char_length(applicability) <= 12000)) AND ((char_length(limitations) >= 1) AND (char_length(limitations) <= 12000)) AND ((char_length(do_not_copy) >= 1) AND (char_length(do_not_copy) <= 12000)))),
    CONSTRAINT sample_element_extractions_origin_chk CHECK ((origin = ANY (ARRAY['manual'::text, 'ai'::text]))),
    CONSTRAINT sample_element_extractions_status_chk CHECK ((status = ANY (ARRAY['building'::text, 'complete'::text])))
);


--
-- Name: sample_element_extractions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_element_extractions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_element_extractions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_element_extractions_id_seq OWNED BY public.sample_element_extractions.id;


--
-- Name: sample_element_tag_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_element_tag_observations (
    id bigint NOT NULL,
    sample_id bigint NOT NULL,
    analysis_version_id bigint NOT NULL,
    element_id bigint NOT NULL,
    dimension_key text NOT NULL,
    tag_id bigint NOT NULL,
    state text NOT NULL,
    note text,
    idempotency_key text NOT NULL,
    request_sha256 text NOT NULL,
    observed_by bigint NOT NULL,
    observer_role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_element_tag_observations_hash_chk CHECK ((request_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_element_tag_observations_note_chk CHECK (((note IS NULL) OR (char_length(note) <= 2000))),
    CONSTRAINT sample_element_tag_observations_role_chk CHECK ((observer_role = ANY (ARRAY['reviewer'::text, 'admin'::text]))),
    CONSTRAINT sample_element_tag_observations_state_chk CHECK ((state = ANY (ARRAY['present'::text, 'absent'::text])))
);


--
-- Name: sample_element_tag_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_element_tag_observations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_element_tag_observations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_element_tag_observations_id_seq OWNED BY public.sample_element_tag_observations.id;


--
-- Name: sample_element_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_element_tags (
    id bigint NOT NULL,
    version_id bigint NOT NULL,
    element_id bigint NOT NULL,
    dimension_key text NOT NULL,
    tag_id bigint NOT NULL,
    origin text NOT NULL,
    confidence numeric(4,3),
    idempotency_key text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_element_tags_ai_confidence_chk CHECK (((origin <> 'ai'::text) OR (confidence IS NOT NULL))),
    CONSTRAINT sample_element_tags_confidence_chk CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT sample_element_tags_idempotency_chk CHECK (((idempotency_key IS NULL) OR ((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 160)))),
    CONSTRAINT sample_element_tags_manual_confidence_chk CHECK (((origin <> 'manual'::text) OR (confidence IS NULL))),
    CONSTRAINT sample_element_tags_origin_chk CHECK ((origin = ANY (ARRAY['ai'::text, 'manual'::text, 'legacy'::text])))
);


--
-- Name: sample_element_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_element_tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_element_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_element_tags_id_seq OWNED BY public.sample_element_tags.id;


--
-- Name: sample_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_evaluations (
    id bigint NOT NULL,
    sample_id bigint NOT NULL,
    analysis_version_id bigint,
    target text NOT NULL,
    source text NOT NULL,
    revision integer NOT NULL,
    summary text,
    strengths jsonb DEFAULT '[]'::jsonb NOT NULL,
    weaknesses jsonb DEFAULT '[]'::jsonb NOT NULL,
    worth_learning jsonb DEFAULT '[]'::jsonb NOT NULL,
    avoid_copying jsonb DEFAULT '[]'::jsonb NOT NULL,
    effect_hypotheses jsonb DEFAULT '[]'::jsonb NOT NULL,
    evidence_source_ids text[] DEFAULT '{}'::text[] NOT NULL,
    confidence numeric(4,3),
    input_sha256 text,
    prompt_version text,
    model_provider text,
    model_name text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_evaluations_arrays_chk CHECK (((jsonb_typeof(strengths) = 'array'::text) AND (jsonb_typeof(weaknesses) = 'array'::text) AND (jsonb_typeof(worth_learning) = 'array'::text) AND (jsonb_typeof(avoid_copying) = 'array'::text) AND (jsonb_typeof(effect_hypotheses) = 'array'::text))),
    CONSTRAINT sample_evaluations_confidence_chk CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT sample_evaluations_input_sha256_chk CHECK (((input_sha256 IS NULL) OR (input_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT sample_evaluations_revision_chk CHECK ((revision > 0)),
    CONSTRAINT sample_evaluations_source_chk CHECK ((source = ANY (ARRAY['ai'::text, 'manual'::text]))),
    CONSTRAINT sample_evaluations_source_metadata_chk CHECK ((((source = 'manual'::text) AND (confidence IS NULL) AND (input_sha256 IS NULL) AND (prompt_version IS NULL) AND (model_provider IS NULL) AND (model_name IS NULL)) OR ((source = 'ai'::text) AND (confidence IS NOT NULL) AND (input_sha256 IS NOT NULL) AND (prompt_version IS NOT NULL) AND (model_provider IS NOT NULL) AND (model_name IS NOT NULL)))),
    CONSTRAINT sample_evaluations_target_chk CHECK ((target = ANY (ARRAY['traffic'::text, 'persona'::text, 'expertise'::text, 'conversion'::text])))
);


--
-- Name: sample_evaluations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_evaluations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_evaluations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_evaluations_id_seq OWNED BY public.sample_evaluations.id;


--
-- Name: sample_evidence_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_evidence_sources (
    id bigint NOT NULL,
    version_id bigint NOT NULL,
    sample_id bigint NOT NULL,
    source_capture_id bigint NOT NULL,
    asset_id bigint,
    source_id text NOT NULL,
    source_kind text NOT NULL,
    locator jsonb NOT NULL,
    content_sha256 text NOT NULL,
    content_length bigint,
    display_label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_evidence_sources_kind_chk CHECK ((source_kind = ANY (ARRAY['body'::text, 'ocr'::text, 'transcript'::text, 'comment'::text, 'metadata'::text, 'asset'::text]))),
    CONSTRAINT sample_evidence_sources_length_chk CHECK (((content_length IS NULL) OR (content_length >= 0))),
    CONSTRAINT sample_evidence_sources_locator_chk CHECK ((jsonb_typeof(locator) = 'object'::text)),
    CONSTRAINT sample_evidence_sources_sha256_chk CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_evidence_sources_source_id_chk CHECK (((char_length(source_id) >= 1) AND (char_length(source_id) <= 120)))
);


--
-- Name: sample_evidence_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_evidence_sources_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_evidence_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_evidence_sources_id_seq OWNED BY public.sample_evidence_sources.id;


--
-- Name: sample_insight_run_features; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_insight_run_features (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    member_id bigint NOT NULL,
    sample_id bigint NOT NULL,
    analysis_version_id bigint NOT NULL,
    feature_key text NOT NULL,
    feature_type text NOT NULL,
    dimension_key text,
    tag_ids bigint[] NOT NULL,
    tag_id bigint,
    state text NOT NULL,
    element_id bigint,
    observation_id bigint,
    element_tag_id bigint,
    source text NOT NULL,
    frozen_label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_insight_run_features_provenance_chk CHECK ((((feature_type = 'single'::text) AND (tag_id = tag_ids[1]) AND (dimension_key IS NOT NULL) AND (((source = 'explicit_observation'::text) AND (state = ANY (ARRAY['present'::text, 'absent'::text])) AND (observation_id IS NOT NULL) AND (element_id IS NOT NULL) AND (element_tag_id IS NULL)) OR ((source = ANY (ARRAY['manual_tag'::text, 'effective_tag'::text])) AND (state = 'present'::text) AND (observation_id IS NULL) AND (element_id IS NOT NULL) AND (element_tag_id IS NOT NULL)) OR ((source = 'unknown'::text) AND (state = 'unknown'::text) AND (observation_id IS NULL) AND (element_id IS NULL) AND (element_tag_id IS NULL)))) OR ((feature_type = 'combination'::text) AND (source = 'combination'::text) AND (tag_id IS NULL) AND (dimension_key IS NULL) AND (observation_id IS NULL) AND (element_id IS NULL) AND (element_tag_id IS NULL)))),
    CONSTRAINT sample_insight_run_features_source_chk CHECK ((source = ANY (ARRAY['explicit_observation'::text, 'manual_tag'::text, 'effective_tag'::text, 'combination'::text, 'unknown'::text]))),
    CONSTRAINT sample_insight_run_features_state_chk CHECK ((state = ANY (ARRAY['present'::text, 'absent'::text, 'unknown'::text]))),
    CONSTRAINT sample_insight_run_features_tags_chk CHECK (((array_ndims(tag_ids) = 1) AND (array_lower(tag_ids, 1) = 1) AND ((array_length(tag_ids, 1) >= 1) AND (array_length(tag_ids, 1) <= 3)) AND ((feature_type = 'single'::text) = (array_length(tag_ids, 1) = 1)))),
    CONSTRAINT sample_insight_run_features_type_chk CHECK ((feature_type = ANY (ARRAY['single'::text, 'combination'::text])))
);


--
-- Name: sample_insight_run_features_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_insight_run_features_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_insight_run_features_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_insight_run_features_id_seq OWNED BY public.sample_insight_run_features.id;


--
-- Name: sample_insight_run_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_insight_run_members (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    sample_id bigint NOT NULL,
    analysis_version_id bigint NOT NULL,
    metric_snapshot_id bigint,
    account_key text NOT NULL,
    account_key_quality text NOT NULL,
    frozen_title text NOT NULL,
    frozen_platform text NOT NULL,
    frozen_published_at timestamp with time zone,
    frozen_metric_observed_at timestamp with time zone,
    observation_seconds bigint,
    outcome_state text NOT NULL,
    outcome_value numeric,
    exclusion_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_insight_run_members_outcome_chk CHECK ((((outcome_state = 'observed'::text) AND (metric_snapshot_id IS NOT NULL) AND (outcome_value IS NOT NULL) AND (exclusion_reason IS NULL)) OR ((outcome_state <> 'observed'::text) AND (outcome_value IS NULL) AND (exclusion_reason IS NOT NULL)))),
    CONSTRAINT sample_insight_run_members_quality_chk CHECK ((account_key_quality = ANY (ARRAY['verified_handle'::text, 'name_fallback'::text, 'missing_singleton'::text]))),
    CONSTRAINT sample_insight_run_members_state_chk CHECK ((outcome_state = ANY (ARRAY['observed'::text, 'missing_metric'::text, 'parse_warning'::text, 'missing_published_at'::text, 'outside_window'::text])))
);


--
-- Name: sample_insight_run_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_insight_run_members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_insight_run_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_insight_run_members_id_seq OWNED BY public.sample_insight_run_members.id;


--
-- Name: sample_insight_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_insight_runs (
    id bigint NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    idempotency_key text NOT NULL,
    request_sha256 text NOT NULL,
    manifest_sha256 text,
    normalized_request jsonb NOT NULL,
    platform text NOT NULL,
    goal text NOT NULL,
    outcome_metric text NOT NULL,
    outcome_transform text NOT NULL,
    analysis_trust text NOT NULL,
    cutoff_at timestamp with time zone NOT NULL,
    requested_by bigint,
    attempts smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 3 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    eligible_count integer,
    outcome_observed_count integer,
    feature_observed_count integer,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    exclusion_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT sample_insight_runs_attempts_chk CHECK ((((attempts >= 0) AND (attempts <= max_attempts)) AND (max_attempts = 3))),
    CONSTRAINT sample_insight_runs_goal_chk CHECK ((goal = ANY (ARRAY['traffic'::text, 'persona'::text, 'expertise'::text, 'conversion'::text]))),
    CONSTRAINT sample_insight_runs_hash_chk CHECK (((request_sha256 ~ '^[0-9a-f]{64}$'::text) AND ((manifest_sha256 IS NULL) OR (manifest_sha256 ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT sample_insight_runs_metric_chk CHECK ((outcome_metric = ANY (ARRAY['likes'::text, 'saves'::text, 'comments'::text, 'shares'::text, 'views'::text, 'likes_per_view'::text, 'saves_per_view'::text, 'comments_per_view'::text, 'shares_per_view'::text]))),
    CONSTRAINT sample_insight_runs_name_chk CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200))),
    CONSTRAINT sample_insight_runs_platform_chk CHECK ((platform = ANY (ARRAY['xiaohongshu'::text, 'douyin'::text, 'manual'::text]))),
    CONSTRAINT sample_insight_runs_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'complete'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT sample_insight_runs_terminal_chk CHECK (((status = ANY (ARRAY['complete'::text, 'failed'::text, 'cancelled'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT sample_insight_runs_trust_chk CHECK ((analysis_trust = ANY (ARRAY['human_confirmed'::text, 'reviewed_or_manual_tag'::text, 'all_effective'::text])))
);


--
-- Name: sample_insight_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_insight_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_insight_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_insight_runs_id_seq OWNED BY public.sample_insight_runs.id;


--
-- Name: sample_insight_statistics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_insight_statistics (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    feature_key text NOT NULL,
    feature_type text NOT NULL,
    dimension_key text,
    frozen_label text NOT NULL,
    reliability text NOT NULL,
    n_eligible integer NOT NULL,
    n_outcome_observed integer NOT NULL,
    n_feature_observed integer NOT NULL,
    n_observed integer NOT NULL,
    n_present integer NOT NULL,
    n_absent integer NOT NULL,
    unique_accounts integer NOT NULL,
    outcome_coverage numeric(8,7) NOT NULL,
    feature_coverage numeric(8,7) NOT NULL,
    present_median numeric,
    present_q1 numeric,
    present_q3 numeric,
    absent_median numeric,
    absent_q1 numeric,
    absent_q3 numeric,
    median_difference numeric,
    cliffs_delta numeric,
    median_difference_ci_low numeric,
    median_difference_ci_high numeric,
    cliffs_delta_ci_low numeric,
    cliffs_delta_ci_high numeric,
    direction text,
    limitation text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_insight_statistics_counts_chk CHECK (((n_eligible >= 0) AND (n_outcome_observed >= 0) AND (n_feature_observed >= 0) AND (n_observed >= 0) AND (n_present >= 0) AND (n_absent >= 0) AND ((n_present + n_absent) = n_observed))),
    CONSTRAINT sample_insight_statistics_coverage_chk CHECK ((((outcome_coverage >= (0)::numeric) AND (outcome_coverage <= (1)::numeric)) AND ((feature_coverage >= (0)::numeric) AND (feature_coverage <= (1)::numeric)))),
    CONSTRAINT sample_insight_statistics_reliability_chk CHECK ((reliability = ANY (ARRAY['insufficient'::text, 'exploratory'::text, 'directional'::text, 'stronger_descriptive'::text]))),
    CONSTRAINT sample_insight_statistics_small_n_chk CHECK (((reliability <> 'insufficient'::text) OR ((present_median IS NULL) AND (present_q1 IS NULL) AND (present_q3 IS NULL) AND (absent_median IS NULL) AND (absent_q1 IS NULL) AND (absent_q3 IS NULL) AND (median_difference IS NULL) AND (cliffs_delta IS NULL) AND (median_difference_ci_low IS NULL) AND (median_difference_ci_high IS NULL) AND (cliffs_delta_ci_low IS NULL) AND (cliffs_delta_ci_high IS NULL) AND (direction IS NULL)))),
    CONSTRAINT sample_insight_statistics_type_chk CHECK ((feature_type = ANY (ARRAY['single'::text, 'combination'::text])))
);


--
-- Name: sample_insight_statistics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_insight_statistics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_insight_statistics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_insight_statistics_id_seq OWNED BY public.sample_insight_statistics.id;


--
-- Name: sample_metric_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_metric_snapshots (
    id bigint NOT NULL,
    sample_id bigint NOT NULL,
    capture_id bigint,
    snapshot_key text,
    observed_at timestamp with time zone NOT NULL,
    likes bigint,
    saves bigint,
    comments bigint,
    shares bigint,
    views bigint,
    raw_metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    parse_warnings text[] DEFAULT '{}'::text[] NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_metric_snapshots_identity_chk CHECK (((capture_id IS NOT NULL) OR (snapshot_key IS NOT NULL))),
    CONSTRAINT sample_metric_snapshots_key_chk CHECK (((snapshot_key IS NULL) OR ((char_length(snapshot_key) >= 1) AND (char_length(snapshot_key) <= 160)))),
    CONSTRAINT sample_metric_snapshots_raw_chk CHECK ((jsonb_typeof(raw_metrics) = 'object'::text)),
    CONSTRAINT sample_metric_snapshots_values_chk CHECK ((((likes IS NULL) OR (likes >= 0)) AND ((saves IS NULL) OR (saves >= 0)) AND ((comments IS NULL) OR (comments >= 0)) AND ((shares IS NULL) OR (shares >= 0)) AND ((views IS NULL) OR (views >= 0))))
);


--
-- Name: sample_metric_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_metric_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_metric_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_metric_snapshots_id_seq OWNED BY public.sample_metric_snapshots.id;


--
-- Name: sample_relation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_relation_events (
    id bigint NOT NULL,
    relation_id bigint NOT NULL,
    event_type text NOT NULL,
    reason text,
    actor_id bigint,
    actor_role text NOT NULL,
    superseded_by_relation_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_relation_events_reason_chk CHECK (((reason IS NULL) OR (char_length(reason) <= 4000))),
    CONSTRAINT sample_relation_events_role_chk CHECK ((actor_role = ANY (ARRAY['member'::text, 'reviewer'::text, 'admin'::text, 'system'::text]))),
    CONSTRAINT sample_relation_events_supersede_chk CHECK ((((event_type = 'superseded'::text) AND (superseded_by_relation_id IS NOT NULL) AND (superseded_by_relation_id <> relation_id)) OR ((event_type <> 'superseded'::text) AND (superseded_by_relation_id IS NULL)))),
    CONSTRAINT sample_relation_events_type_chk CHECK ((event_type = ANY (ARRAY['proposed'::text, 'confirmed'::text, 'rejected'::text, 'withdrawn'::text, 'superseded'::text])))
);


--
-- Name: sample_relation_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_relation_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_relation_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_relation_events_id_seq OWNED BY public.sample_relation_events.id;


--
-- Name: sample_relation_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_relation_evidence (
    id bigint NOT NULL,
    relation_id bigint NOT NULL,
    subject_sample_id bigint NOT NULL,
    subject_analysis_version_id bigint NOT NULL,
    object_sample_id bigint NOT NULL,
    object_analysis_version_id bigint NOT NULL,
    endpoint_sample_id bigint NOT NULL,
    endpoint_analysis_version_id bigint NOT NULL,
    element_evidence_id bigint NOT NULL,
    note text,
    added_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_relation_evidence_note_chk CHECK (((note IS NULL) OR (char_length(note) <= 4000)))
);


--
-- Name: sample_relation_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_relation_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_relation_evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_relation_evidence_id_seq OWNED BY public.sample_relation_evidence.id;


--
-- Name: sample_relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_relations (
    id bigint NOT NULL,
    relation_type text NOT NULL,
    subject_sample_id bigint NOT NULL,
    subject_analysis_version_id bigint NOT NULL,
    object_sample_id bigint NOT NULL,
    object_analysis_version_id bigint NOT NULL,
    origin text NOT NULL,
    current_state text DEFAULT 'proposed'::text NOT NULL,
    rationale text,
    proposed_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_relations_origin_chk CHECK ((origin = ANY (ARRAY['manual'::text, 'ai'::text]))),
    CONSTRAINT sample_relations_rationale_chk CHECK (((rationale IS NULL) OR (char_length(rationale) <= 12000))),
    CONSTRAINT sample_relations_self_chk CHECK ((subject_sample_id <> object_sample_id)),
    CONSTRAINT sample_relations_state_chk CHECK ((current_state = ANY (ARRAY['proposed'::text, 'confirmed'::text, 'rejected'::text, 'withdrawn'::text, 'superseded'::text]))),
    CONSTRAINT sample_relations_type_chk CHECK ((relation_type = ANY (ARRAY['citation'::text, 'imitation'::text, 'evolution'::text, 'variant'::text]))),
    CONSTRAINT sample_relations_variant_canonical_chk CHECK (((relation_type <> 'variant'::text) OR (subject_sample_id < object_sample_id)))
);


--
-- Name: sample_relations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_relations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_relations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_relations_id_seq OWNED BY public.sample_relations.id;


--
-- Name: sample_retrieval_algorithm_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_retrieval_algorithm_selections (
    id bigint NOT NULL,
    algorithm_id bigint NOT NULL,
    build_id bigint NOT NULL,
    reason text NOT NULL,
    selected_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_retrieval_algorithm_selections_reason_chk CHECK ((reason = ANY (ARRAY['build_success'::text, 'explicit'::text, 'rollback'::text])))
);


--
-- Name: sample_retrieval_algorithm_selections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_retrieval_algorithm_selections_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_retrieval_algorithm_selections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_retrieval_algorithm_selections_id_seq OWNED BY public.sample_retrieval_algorithm_selections.id;


--
-- Name: sample_retrieval_algorithms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_retrieval_algorithms (
    id bigint NOT NULL,
    algorithm_version text NOT NULL,
    tokenizer_version text NOT NULL,
    mapping_version text NOT NULL,
    vector_size smallint DEFAULT 256 NOT NULL,
    config jsonb NOT NULL,
    config_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_retrieval_algorithms_hash_chk CHECK ((config_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_retrieval_algorithms_size_chk CHECK ((vector_size = 256))
);


--
-- Name: sample_retrieval_algorithms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_retrieval_algorithms_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_retrieval_algorithms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_retrieval_algorithms_id_seq OWNED BY public.sample_retrieval_algorithms.id;


--
-- Name: sample_retrieval_build_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_retrieval_build_items (
    id bigint NOT NULL,
    build_id bigint NOT NULL,
    subject_kind text NOT NULL,
    sample_id bigint,
    component_id bigint,
    status text NOT NULL,
    profile_id bigint,
    exclusion_code text,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT sample_retrieval_build_items_kind_chk CHECK ((subject_kind = ANY (ARRAY['sample'::text, 'component'::text]))),
    CONSTRAINT sample_retrieval_build_items_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'succeeded'::text, 'excluded'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT sample_retrieval_build_items_subject_chk CHECK ((((subject_kind = 'sample'::text) AND (sample_id IS NOT NULL) AND (component_id IS NULL)) OR ((subject_kind = 'component'::text) AND (component_id IS NOT NULL) AND (sample_id IS NULL))))
);


--
-- Name: sample_retrieval_build_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_retrieval_build_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_retrieval_build_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_retrieval_build_items_id_seq OWNED BY public.sample_retrieval_build_items.id;


--
-- Name: sample_retrieval_builds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_retrieval_builds (
    id bigint NOT NULL,
    algorithm_id bigint NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    idempotency_key text NOT NULL,
    request_sha256 text NOT NULL,
    requested_by bigint,
    attempts smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 3 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    eligible_count integer,
    succeeded_count integer DEFAULT 0 NOT NULL,
    excluded_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT sample_retrieval_builds_attempts_chk CHECK ((((attempts >= 0) AND (attempts <= max_attempts)) AND (max_attempts = 3))),
    CONSTRAINT sample_retrieval_builds_counts_chk CHECK (((succeeded_count >= 0) AND (excluded_count >= 0) AND (failed_count >= 0))),
    CONSTRAINT sample_retrieval_builds_hash_chk CHECK ((request_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_retrieval_builds_idempotency_chk CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 160))),
    CONSTRAINT sample_retrieval_builds_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT sample_retrieval_builds_terminal_chk CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) = (finished_at IS NOT NULL)))
);


--
-- Name: sample_retrieval_builds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_retrieval_builds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_retrieval_builds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_retrieval_builds_id_seq OWNED BY public.sample_retrieval_builds.id;


--
-- Name: sample_retrieval_dimension_vectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_retrieval_dimension_vectors (
    id bigint NOT NULL,
    profile_id bigint NOT NULL,
    sample_id bigint NOT NULL,
    analysis_version_id bigint NOT NULL,
    element_id bigint NOT NULL,
    dimension_key text NOT NULL,
    decision_id bigint,
    vector smallint[] NOT NULL,
    norm_sq bigint NOT NULL,
    nonzero_count smallint NOT NULL,
    simhash bit(64) NOT NULL,
    band_0 smallint NOT NULL,
    band_1 smallint NOT NULL,
    band_2 smallint NOT NULL,
    band_3 smallint NOT NULL,
    band_4 smallint NOT NULL,
    band_5 smallint NOT NULL,
    band_6 smallint NOT NULL,
    band_7 smallint NOT NULL,
    source text NOT NULL,
    decision_state text,
    confidence numeric(4,3),
    evidence_strength text NOT NULL,
    effective_summary text,
    applicability text,
    limitations text,
    frozen_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_retrieval_vectors_bands_chk CHECK ((((band_0 >= 0) AND (band_0 <= 255)) AND ((band_1 >= 0) AND (band_1 <= 255)) AND ((band_2 >= 0) AND (band_2 <= 255)) AND ((band_3 >= 0) AND (band_3 <= 255)) AND ((band_4 >= 0) AND (band_4 <= 255)) AND ((band_5 >= 0) AND (band_5 <= 255)) AND ((band_6 >= 0) AND (band_6 <= 255)) AND ((band_7 >= 0) AND (band_7 <= 255)))),
    CONSTRAINT sample_retrieval_vectors_decision_state_chk CHECK ((((decision_id IS NULL) AND (decision_state IS NULL)) OR ((decision_id IS NOT NULL) AND (decision_state = ANY (ARRAY['confirmed'::text, 'edited'::text, 'rejected'::text]))))),
    CONSTRAINT sample_retrieval_vectors_evidence_chk CHECK ((evidence_strength = ANY (ARRAY['none'::text, 'weak'::text, 'medium'::text, 'strong'::text]))),
    CONSTRAINT sample_retrieval_vectors_norm_chk CHECK (((norm_sq >= 0) AND ((nonzero_count >= 0) AND (nonzero_count <= 256)))),
    CONSTRAINT sample_retrieval_vectors_shape_chk CHECK (((array_ndims(vector) = 1) AND (array_lower(vector, 1) = 1) AND (array_length(vector, 1) = 256))),
    CONSTRAINT sample_retrieval_vectors_source_chk CHECK ((source = ANY (ARRAY['ai'::text, 'manual'::text, 'legacy'::text]))),
    CONSTRAINT sample_retrieval_vectors_tags_chk CHECK ((jsonb_typeof(frozen_tags) = 'array'::text))
);


--
-- Name: sample_retrieval_dimension_vectors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_retrieval_dimension_vectors_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_retrieval_dimension_vectors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_retrieval_dimension_vectors_id_seq OWNED BY public.sample_retrieval_dimension_vectors.id;


--
-- Name: sample_retrieval_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_retrieval_profiles (
    id bigint NOT NULL,
    build_id bigint NOT NULL,
    algorithm_id bigint NOT NULL,
    sample_id bigint NOT NULL,
    analysis_version_id bigint NOT NULL,
    status text DEFAULT 'building'::text NOT NULL,
    input_sha256 text NOT NULL,
    frozen_title text NOT NULL,
    frozen_platform text NOT NULL,
    frozen_account_name text,
    frozen_account_handle text,
    frozen_archive_status text NOT NULL,
    frozen_content_type text,
    frozen_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT sample_retrieval_profiles_completion_chk CHECK (((status = 'complete'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT sample_retrieval_profiles_hash_chk CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_retrieval_profiles_status_chk CHECK ((status = ANY (ARRAY['building'::text, 'complete'::text]))),
    CONSTRAINT sample_retrieval_profiles_tags_chk CHECK ((jsonb_typeof(frozen_tags) = 'array'::text))
);


--
-- Name: sample_retrieval_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_retrieval_profiles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_retrieval_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_retrieval_profiles_id_seq OWNED BY public.sample_retrieval_profiles.id;


--
-- Name: sample_retrieval_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_retrieval_states (
    sample_id bigint NOT NULL,
    dirty boolean DEFAULT true NOT NULL,
    dirty_generation bigint DEFAULT 1 NOT NULL,
    current_fingerprint text,
    last_profile_id bigint,
    last_build_id bigint,
    last_error_code text,
    last_error_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_retrieval_states_generation_chk CHECK ((dirty_generation >= 1)),
    CONSTRAINT sample_retrieval_states_hash_chk CHECK (((current_fingerprint IS NULL) OR (current_fingerprint ~ '^[0-9a-f]{64}$'::text)))
);


--
-- Name: sample_stage3_idempotency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_stage3_idempotency (
    id bigint NOT NULL,
    aggregate_key text NOT NULL,
    action text NOT NULL,
    idempotency_key text NOT NULL,
    request_sha256 text NOT NULL,
    response_kind text,
    response_id bigint,
    response_status smallint,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sample_stage3_idempotency_action_chk CHECK (((char_length(action) >= 1) AND (char_length(action) <= 80))),
    CONSTRAINT sample_stage3_idempotency_aggregate_chk CHECK (((char_length(aggregate_key) >= 1) AND (char_length(aggregate_key) <= 160))),
    CONSTRAINT sample_stage3_idempotency_hash_chk CHECK ((request_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT sample_stage3_idempotency_key_chk CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 160))),
    CONSTRAINT sample_stage3_idempotency_status_chk CHECK (((response_status IS NULL) OR ((response_status >= 200) AND (response_status <= 299))))
);


--
-- Name: sample_stage3_idempotency_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sample_stage3_idempotency_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sample_stage3_idempotency_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sample_stage3_idempotency_id_seq OWNED BY public.sample_stage3_idempotency.id;


--
-- Name: samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.samples (
    id bigint NOT NULL,
    canonical_key text NOT NULL,
    platform text DEFAULT 'manual'::text NOT NULL,
    platform_content_id text,
    source_url text,
    title text,
    body_text text,
    content_type text,
    account_name text,
    account_handle text,
    published_at timestamp with time zone,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    first_ingest_method text DEFAULT 'manual'::text NOT NULL,
    last_ingest_method text DEFAULT 'manual'::text NOT NULL,
    completeness_score smallint DEFAULT 0 NOT NULL,
    missing_fields text[] DEFAULT '{}'::text[] NOT NULL,
    archive_status text DEFAULT 'partial'::text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    current_analysis_version_id bigint,
    CONSTRAINT samples_archive_status_chk CHECK ((archive_status = ANY (ARRAY['partial'::text, 'usable'::text, 'complete'::text]))),
    CONSTRAINT samples_completeness_score_chk CHECK (((completeness_score >= 0) AND (completeness_score <= 100))),
    CONSTRAINT samples_ingest_method_chk CHECK (((first_ingest_method = ANY (ARRAY['manual'::text, 'link'::text, 'upload'::text, 'collector'::text, 'legacy'::text])) AND (last_ingest_method = ANY (ARRAY['manual'::text, 'link'::text, 'upload'::text, 'collector'::text, 'legacy'::text]))))
);


--
-- Name: samples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.samples_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: samples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.samples_id_seq OWNED BY public.samples.id;


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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tags_kind_length_chk CHECK (((char_length(kind) >= 1) AND (char_length(kind) <= 64))),
    CONSTRAINT tags_name_length_chk CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80)))
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
    deleted_at timestamp with time zone,
    sample_id bigint
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
-- Name: component_retrieval_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_profiles ALTER COLUMN id SET DEFAULT nextval('public.component_retrieval_profiles_id_seq'::regclass);


--
-- Name: component_retrieval_vectors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_vectors ALTER COLUMN id SET DEFAULT nextval('public.component_retrieval_vectors_id_seq'::regclass);


--
-- Name: content_component_lifecycle_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_lifecycle_events ALTER COLUMN id SET DEFAULT nextval('public.content_component_lifecycle_events_id_seq'::regclass);


--
-- Name: content_component_revision_decisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_decisions ALTER COLUMN id SET DEFAULT nextval('public.content_component_revision_decisions_id_seq'::regclass);


--
-- Name: content_component_revision_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_sources ALTER COLUMN id SET DEFAULT nextval('public.content_component_revision_sources_id_seq'::regclass);


--
-- Name: content_component_revision_tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_tags ALTER COLUMN id SET DEFAULT nextval('public.content_component_revision_tags_id_seq'::regclass);


--
-- Name: content_component_revisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revisions ALTER COLUMN id SET DEFAULT nextval('public.content_component_revisions_id_seq'::regclass);


--
-- Name: content_component_selections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_selections ALTER COLUMN id SET DEFAULT nextval('public.content_component_selections_id_seq'::regclass);


--
-- Name: content_components id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_components ALTER COLUMN id SET DEFAULT nextval('public.content_components_id_seq'::regclass);


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
-- Name: sample_analysis_elements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_elements ALTER COLUMN id SET DEFAULT nextval('public.sample_analysis_elements_id_seq'::regclass);


--
-- Name: sample_analysis_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_jobs ALTER COLUMN id SET DEFAULT nextval('public.sample_analysis_jobs_id_seq'::regclass);


--
-- Name: sample_analysis_selections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_selections ALTER COLUMN id SET DEFAULT nextval('public.sample_analysis_selections_id_seq'::regclass);


--
-- Name: sample_analysis_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_versions ALTER COLUMN id SET DEFAULT nextval('public.sample_analysis_versions_id_seq'::regclass);


--
-- Name: sample_assets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_assets ALTER COLUMN id SET DEFAULT nextval('public.sample_assets_id_seq'::regclass);


--
-- Name: sample_captures id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_captures ALTER COLUMN id SET DEFAULT nextval('public.sample_captures_id_seq'::regclass);


--
-- Name: sample_cluster_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_jobs ALTER COLUMN id SET DEFAULT nextval('public.sample_cluster_jobs_id_seq'::regclass);


--
-- Name: sample_cluster_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_runs ALTER COLUMN id SET DEFAULT nextval('public.sample_cluster_runs_id_seq'::regclass);


--
-- Name: sample_cluster_selections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_selections ALTER COLUMN id SET DEFAULT nextval('public.sample_cluster_selections_id_seq'::regclass);


--
-- Name: sample_clusters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_clusters ALTER COLUMN id SET DEFAULT nextval('public.sample_clusters_id_seq'::regclass);


--
-- Name: sample_comparison_assessment_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessment_jobs ALTER COLUMN id SET DEFAULT nextval('public.sample_comparison_assessment_jobs_id_seq'::regclass);


--
-- Name: sample_comparison_assessment_selections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessment_selections ALTER COLUMN id SET DEFAULT nextval('public.sample_comparison_assessment_selections_id_seq'::regclass);


--
-- Name: sample_comparison_assessments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessments ALTER COLUMN id SET DEFAULT nextval('public.sample_comparison_assessments_id_seq'::regclass);


--
-- Name: sample_comparison_finding_evidence id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_finding_evidence ALTER COLUMN id SET DEFAULT nextval('public.sample_comparison_finding_evidence_id_seq'::regclass);


--
-- Name: sample_comparison_findings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_findings ALTER COLUMN id SET DEFAULT nextval('public.sample_comparison_findings_id_seq'::regclass);


--
-- Name: sample_comparison_scope_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scope_members ALTER COLUMN id SET DEFAULT nextval('public.sample_comparison_scope_members_id_seq'::regclass);


--
-- Name: sample_comparison_scopes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scopes ALTER COLUMN id SET DEFAULT nextval('public.sample_comparison_scopes_id_seq'::regclass);


--
-- Name: sample_comparison_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_snapshots ALTER COLUMN id SET DEFAULT nextval('public.sample_comparison_snapshots_id_seq'::regclass);


--
-- Name: sample_comparisons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparisons ALTER COLUMN id SET DEFAULT nextval('public.sample_comparisons_id_seq'::regclass);


--
-- Name: sample_element_decisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_decisions ALTER COLUMN id SET DEFAULT nextval('public.sample_element_decisions_id_seq'::regclass);


--
-- Name: sample_element_evidence id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_evidence ALTER COLUMN id SET DEFAULT nextval('public.sample_element_evidence_id_seq'::regclass);


--
-- Name: sample_element_extraction_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extraction_sources ALTER COLUMN id SET DEFAULT nextval('public.sample_element_extraction_sources_id_seq'::regclass);


--
-- Name: sample_element_extractions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extractions ALTER COLUMN id SET DEFAULT nextval('public.sample_element_extractions_id_seq'::regclass);


--
-- Name: sample_element_tag_observations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tag_observations ALTER COLUMN id SET DEFAULT nextval('public.sample_element_tag_observations_id_seq'::regclass);


--
-- Name: sample_element_tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tags ALTER COLUMN id SET DEFAULT nextval('public.sample_element_tags_id_seq'::regclass);


--
-- Name: sample_evaluations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evaluations ALTER COLUMN id SET DEFAULT nextval('public.sample_evaluations_id_seq'::regclass);


--
-- Name: sample_evidence_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evidence_sources ALTER COLUMN id SET DEFAULT nextval('public.sample_evidence_sources_id_seq'::regclass);


--
-- Name: sample_insight_run_features id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_features ALTER COLUMN id SET DEFAULT nextval('public.sample_insight_run_features_id_seq'::regclass);


--
-- Name: sample_insight_run_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_members ALTER COLUMN id SET DEFAULT nextval('public.sample_insight_run_members_id_seq'::regclass);


--
-- Name: sample_insight_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_runs ALTER COLUMN id SET DEFAULT nextval('public.sample_insight_runs_id_seq'::regclass);


--
-- Name: sample_insight_statistics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_statistics ALTER COLUMN id SET DEFAULT nextval('public.sample_insight_statistics_id_seq'::regclass);


--
-- Name: sample_metric_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_metric_snapshots ALTER COLUMN id SET DEFAULT nextval('public.sample_metric_snapshots_id_seq'::regclass);


--
-- Name: sample_relation_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_events ALTER COLUMN id SET DEFAULT nextval('public.sample_relation_events_id_seq'::regclass);


--
-- Name: sample_relation_evidence id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_evidence ALTER COLUMN id SET DEFAULT nextval('public.sample_relation_evidence_id_seq'::regclass);


--
-- Name: sample_relations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relations ALTER COLUMN id SET DEFAULT nextval('public.sample_relations_id_seq'::regclass);


--
-- Name: sample_retrieval_algorithm_selections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_algorithm_selections ALTER COLUMN id SET DEFAULT nextval('public.sample_retrieval_algorithm_selections_id_seq'::regclass);


--
-- Name: sample_retrieval_algorithms id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_algorithms ALTER COLUMN id SET DEFAULT nextval('public.sample_retrieval_algorithms_id_seq'::regclass);


--
-- Name: sample_retrieval_build_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_build_items ALTER COLUMN id SET DEFAULT nextval('public.sample_retrieval_build_items_id_seq'::regclass);


--
-- Name: sample_retrieval_builds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_builds ALTER COLUMN id SET DEFAULT nextval('public.sample_retrieval_builds_id_seq'::regclass);


--
-- Name: sample_retrieval_dimension_vectors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_dimension_vectors ALTER COLUMN id SET DEFAULT nextval('public.sample_retrieval_dimension_vectors_id_seq'::regclass);


--
-- Name: sample_retrieval_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_profiles ALTER COLUMN id SET DEFAULT nextval('public.sample_retrieval_profiles_id_seq'::regclass);


--
-- Name: sample_stage3_idempotency id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_stage3_idempotency ALTER COLUMN id SET DEFAULT nextval('public.sample_stage3_idempotency_id_seq'::regclass);


--
-- Name: samples id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.samples ALTER COLUMN id SET DEFAULT nextval('public.samples_id_seq'::regclass);


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
17	技术1	bfab7b9a2329555e84c55e151346ec8909ccf646ce8c08fa209f50990d624cfa	{tech1}	1	2026-08-25 07:12:31.252352+00	2026-08-26 08:56:23.367093+00	\N
19	技术1（图文自测 08-25，用完即停）	a195301f9497295cfda59e7162e5f18d8b018598c8c9cd9b056f498652a7627b	{tech1}	\N	2026-08-25 08:33:54.131209+00	2026-08-25 08:33:54.260188+00	2026-08-25 08:36:53.709694+00
20	技术1（翻页自测 08-25，用完即停）	b38b185c79dbb1972fb4e54be4371342d1815f8132f497888f09cb52eecc4c23	{tech1}	\N	2026-08-25 08:50:22.821166+00	2026-08-25 08:50:22.935007+00	2026-08-25 08:52:04.660016+00
22	技术1	c7389f12c7608b2d9022ee7b7d08e6b8db563a6d7a8ec215401f145a397ca7fe	{tech1}	1	2026-08-28 14:32:31.506534+00	2026-08-29 03:25:20.136701+00	\N
14	技术2	e394cef8a28b0a4c3fb023cd4e0c7cccb327c18de3641bef1b7615aec80b4dc5	{tech2}	1	2026-08-25 02:35:22.902497+00	2026-08-25 03:00:55.343314+00	\N
15	技术1（联调自测，用完就停）	7423c9c623ae4b21f5cc76d7cdd8160384853d765eb87216ee18a3d63aaaaf45	{tech1}	\N	2026-08-25 06:34:47.612673+00	2026-08-25 06:41:31.323016+00	2026-08-25 06:48:08.67567+00
21	技术1（压测 08-25，用完即停）	bcf81180c79265c0a625e9089adf173422a640cbbd0a104322fd19dd1b0d5e6d	{tech1}	\N	2026-08-25 14:59:49.693824+00	2026-08-25 15:01:29.436105+00	2026-08-25 15:03:45.882503+00
\.


--
-- Data for Name: attachments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.attachments (id, scope, ref_id, side, orig_name, stored_name, mime, size, note, uploaded_by, created_at, source_url) FROM stdin;
1	client	1	submit	小华_微信聊天记录综合分析报告.html	158cd2cd1a74ebd355d4193a7314f338.html	text/html; charset=utf-8	40070	\N	1	2026-08-21 06:42:08.98788+00	\N
9	report	3	submit	output_真诚关系咨询Mini_武志红心理学_已填写.xlsx	c135dae2629df541fd8dc72f8d78377a.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	49783	\N	7	2026-08-21 07:40:07.222272+00	\N
11	report	4	submit	小华_微信聊天记录综合分析报告.html	8274b1380be7b56cfe108dbfaefab81e.html	text/html; charset=utf-8	40070	\N	1	2026-08-21 07:52:18.911739+00	\N
12	report	5	submit	情感赛道_业务观察工作簿第一周_已填写.xlsx	d3f518b28208eef64642b18b0e5efaf3.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	45356	\N	11	2026-08-21 07:59:20.577476+00	\N
14	chat	10	submit	小华_微信聊天记录综合分析报告.html	80b691977158e31d8d05cbc26c6c49a1.html	text/html; charset=utf-8	40070	\N	1	2026-08-21 08:04:27.662142+00	\N
15	chat	11	submit	canvas-image-image-1785226933218-dsjrx.png	d41f2aadc86a985cd9f056628539f07c.png	image/png	2338930	\N	1	2026-08-21 08:04:51.195144+00	\N
16	chat	12	submit	Receipt-2354-9635-2195.pdf	70769236673a3ecb688c0fc32e073056.pdf	application/pdf	38193	\N	1	2026-08-21 08:04:55.906133+00	\N
17	chat	13	submit	已生成图像 1 (1).png	f1e57fdaa3dcc42d9e7489ad72ddb193.png	image/png	2106028	\N	1	2026-08-21 08:05:00.044862+00	\N
38	client	6	submit	E2E-附件.html	cdc283c1226c2142735459e02c24b588.html	text/html; charset=utf-8	93	\N	1	2026-08-21 14:18:16.40685+00	\N
39	client	6	submit	E2E-附件.html	13e2ddea331695c1967d2b81c9b6422f.html	text/html; charset=utf-8	93	\N	1	2026-08-21 14:19:37.492237+00	\N
42	report	15	submit	情感赛道_业务观察工作簿第一周.xlsx	d18a67671927aec00d701e8a54d03a59.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	44128	\N	7	2026-08-24 07:53:08.477187+00	\N
43	report	16	submit	情感赛道_业务观察工作簿第一周.xlsx	9ce157f69703a4a57393cbd06ce3f925.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	44851	\N	10	2026-08-24 09:31:15.215755+00	\N
44	report	17	submit	情感赛道_业务观察工作簿第一周.xlsx	24b04263188e73e73caba3cbc09e6f27.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	45281	\N	7	2026-08-25 06:32:16.469056+00	\N
53	report	19	submit	01_封面.png	85eeb1fa525bcdf38480198db7b69925.png	image/png	1060637	\N	7	2026-08-25 08:27:27.60622+00	\N
54	report	19	submit	02_护手霜接触.png	2d7414f4f244025684303693beb58bc6.png	image/png	1140078	\N	7	2026-08-25 08:27:32.679636+00	\N
55	report	19	submit	03_明天找你.png	00a9b6787ca71ea366a567afef7877c4.png	image/png	963239	\N	7	2026-08-25 08:27:39.291926+00	\N
56	report	19	submit	04_整理衣领眼神.png	2edb9513d1f4b078348114f3dc1ec5b8.png	image/png	1152525	\N	7	2026-08-25 08:27:46.148907+00	\N
57	report	19	submit	05_节奏总结.png	dd516bf18e3d1077adf375b0505c1a33.png	image/png	1059979	\N	7	2026-08-25 08:28:16.51547+00	\N
58	report	20	submit	海绵宝宝工位壁纸_6_紫皮茄_来自小红书网页版.jpg	7f635556ae82336fa9fced534103d8b9.jpg	image/jpeg	557660	\N	1	2026-08-25 08:51:09.36666+00	\N
59	report	20	submit	海绵宝宝工位壁纸_5_紫皮茄_来自小红书网页版.jpg	92a73a9c5567dc4e64db0eaad8305519.jpg	image/jpeg	639704	\N	1	2026-08-25 08:51:09.795388+00	\N
60	report	20	submit	海绵宝宝工位壁纸_4_紫皮茄_来自小红书网页版.jpg	d7b89f51a6835b68f0c7a5a5dabceb6f.jpg	image/jpeg	570281	\N	1	2026-08-25 08:51:10.186114+00	\N
61	report	20	submit	海绵宝宝工位壁纸_3_紫皮茄_来自小红书网页版.jpg	52f3fd0f69aac46c31393541f377b2fe.jpg	image/jpeg	486472	\N	1	2026-08-25 08:51:10.427019+00	\N
63	report	22	submit	微信图片_20260825172425_140_20.png	c5a0694061b23a50df728f3478bbb559.png	image/png	859046	\N	10	2026-08-25 09:27:42.535778+00	\N
64	report	22	submit	微信图片_20260825172425_139_20.png	1dd1a29accf08db80e7f826de59a0210.png	image/png	826602	\N	10	2026-08-25 09:27:42.78213+00	\N
65	report	22	submit	微信图片_20260825172345_138_20.png	e93faddbd568bb5f6fdaa4f3b0d4c846.png	image/png	859072	\N	10	2026-08-25 09:27:43.04405+00	\N
66	report	23	submit	情感赛道_业务观察工作簿第一周.xlsx	1d974b81056bbd283a69b50c1c573336.xlsx	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	47268	\N	10	2026-08-25 09:28:32.138235+00	\N
67	report	24	submit	01_封面.png	88e677e9406eda4173cddcc04ab868ee.png	image/png	728070	\N	7	2026-08-25 10:01:44.117998+00	\N
68	report	24	submit	02_护手霜接触.png	47a33718dbbe2869326801c9145cfb09.png	image/png	775453	\N	7	2026-08-25 10:01:45.708245+00	\N
69	report	24	submit	03_明天找你.png	7c4d56a322979bd8b4f3afb6bf3d9946.png	image/png	811343	\N	7	2026-08-25 10:01:46.581652+00	\N
70	report	24	submit	04_整理衣领眼神.png	521f321c8149489ac8ef446981a5f922.png	image/png	819917	\N	7	2026-08-25 10:01:47.402623+00	\N
71	chat	120	submit	个人语言形成与人生经历反推系统_AI算法规范_V1.0.md	9ba0c63d06df53f029455c9a770ae35b.md	text/plain; charset=utf-8	59449	\N	4	2026-08-26 03:00:09.256741+00	\N
72	report	26	submit	已生成图像 1 (2).png	2cad8883879107799709cd966e8cbde2.png	image/png	3302452	\N	1	2026-08-26 15:02:02.91601+00	\N
73	report	26	submit	1be2de78-faf2-4033-87b0-6167fd474317.png	5a27ee2346e4b88e7279794f761fad53.png	image/png	2610809	\N	1	2026-08-26 15:02:03.640922+00	\N
74	report	26	submit	b097f4de-ea5d-4ef7-bcb7-358bbe6ebe73.png	ddf8f4ed45c4ab71eaf752c692344828.png	image/png	4423993	\N	1	2026-08-26 15:02:04.923151+00	\N
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
22	persona	benchmark	小红书	元元子	https://www.xiaohongshu.com/user/profile/5592cc0f484fb665b39f939f	2410	用星星术法和佛道哲学拆解人生\n前大厂产品/前央企HR/中心协心理咨询师\n🇬🇧warwick物理本·心理硕·浙大东哲mba在研·\n地图研究@一个冻儿元 视频版（夸我美就行了	\N	2026-08-26 02:41:04.712529+00	2026-08-26 02:41:04.712529+00	\N
13	matrix	benchmark	小红书	恰芒芒不恰	https://www.xiaohongshu.com/user/profile/69133fb50000000037032e19	1340	🎥 影视爱好者  | 🎙️ 采访观察者\n💡 输出有温度、有深度的观点\n🟢🫧zyq_coinouo	\N	2026-08-25 08:22:43.976607+00	2026-08-25 08:37:53.693897+00	\N
16	matrix	benchmark	小红书	治愈果（kakki在说啥）	https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266	162886	🐳百万粉丝心理创作者｜心理师\n🐳累计500+小时个案\n🐳Queen Mary 法学硕士🇬🇧 \n🐳亲密关系｜终身成长：zhiyuguo820\n@愈果 YU GUO	\N	2026-08-25 09:20:49.338864+00	2026-08-25 09:20:49.338864+00	\N
9	persona	benchmark	小红书	可可拆爆款	https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1	122838	👩全网100W➕粉丝\n🎉你却的不是方法，而是一个带你的人\n🌲账号定位｜流量卡点｜爆款模板\n🔗下方进👗	\N	2026-08-25 06:36:40.164413+00	2026-08-25 09:20:56.490278+00	\N
10	matrix	benchmark	小红书	可可拆爆款	https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1	122838	👩全网100W➕粉丝\n🎉你却的不是方法，而是一个带你的人\n🌲账号定位｜流量卡点｜爆款模板\n🔗下方进👗	\N	2026-08-25 06:36:49.417507+00	2026-08-25 09:21:00.094163+00	\N
20	persona	benchmark	小红书	北电超然	https://www.xiaohongshu.com/user/profile/63460969000000001901ee24	2982	北京电影学院| 于超然（百度百科）\n🎓14年表演教学与镜头训练经验\n🎬第33届金鸡电影节最佳影片奖表演指导\n帮老板用“微剧情”把内容做出差异化\n让观众愿意看完，也愿意买单！	\N	2026-08-26 01:41:17.904798+00	2026-08-26 02:41:06.946254+00	\N
17	persona	benchmark	小红书	治愈果（kakki在说啥）	https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266	162886	🐳百万粉丝心理创作者｜心理师\n🐳累计500+小时个案\n🐳Queen Mary 法学硕士🇬🇧 \n🐳亲密关系｜终身成长：zhiyuguo820\n@愈果 YU GUO	\N	2026-08-25 09:20:51.915968+00	2026-08-25 10:01:50.273723+00	\N
21	matrix	benchmark	小红书	元元子	https://www.xiaohongshu.com/user/profile/5592cc0f484fb665b39f939f	2410	用星星术法和佛道哲学拆解人生\n前大厂产品/前央企HR/中心协心理咨询师\n🇬🇧warwick物理本·心理硕·浙大东哲mba在研·\n地图研究@一个冻儿元 视频版（夸我美就行了	\N	2026-08-26 01:42:13.927659+00	2026-08-26 02:41:56.335911+00	\N
23	matrix	benchmark	小红书	北电超然	https://www.xiaohongshu.com/user/profile/63460969000000001901ee24	2982	北京电影学院| 于超然（百度百科）\n🎓14年表演教学与镜头训练经验\n🎬第33届金鸡电影节最佳影片奖表演指导\n帮老板用“微剧情”把内容做出差异化\n让观众愿意看完，也愿意买单！	\N	2026-08-26 02:41:58.496671+00	2026-08-26 02:41:58.496671+00	\N
11	persona	benchmark	小红书	野生老板商业思维	https://www.xiaohongshu.com/user/profile/5dd7f2730000000001007929	27558	2020福布斯U30，地产资管公司创始人\n强势文化｜国学智慧｜关系运作｜商业思维\n@野生老板 官方授权	\N	2026-08-25 07:15:31.122084+00	2026-08-25 10:00:28.105418+00	\N
14	matrix	benchmark	小红书	枕书凉.	https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01	230	8️⃣年心理研究专家\n擅长分析情感困惑，带你理性恋爱\n🉑  1v1文字or语音☎️ （非公益）咨-询\n亲密关系/自我提升/关系修复	\N	2026-08-25 08:23:40.916423+00	2026-08-26 02:42:03.263463+00	\N
18	persona	benchmark	小红书	枕书凉.	https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01	230	8️⃣年心理研究专家\n擅长分析情感困惑，带你理性恋爱\n🉑  1v1文字or语音☎️ （非公益）咨-询\n亲密关系/自我提升/关系修复	\N	2026-08-25 09:21:42.313642+00	2026-08-26 02:41:01.794109+00	\N
12	matrix	benchmark	小红书	野生老板商业思维	https://www.xiaohongshu.com/user/profile/5dd7f2730000000001007929	27558	2020福布斯U30，地产资管公司创始人\n强势文化｜国学智慧｜关系运作｜商业思维\n@野生老板 官方授权	\N	2026-08-25 07:15:31.145945+00	2026-08-26 02:42:00.352867+00	\N
24	persona	benchmark	小红书	谢小树	https://www.xiaohongshu.com/user/profile/5db778250000000001008987	183814	👑  12年心理咨询师｜ 17年深耕易学\n👑  直播切片 ：@谢小树🌲宝藏树 \n     ✉️✉️找到我✉️✉️\n【直播、连麦】：每月第一个周日12-15点	\N	2026-08-26 08:56:23.851615+00	2026-08-26 08:56:23.851615+00	\N
25	matrix	benchmark	小红书	糯米爱养生	https://www.xiaohongshu.com/user/profile/64ca2f03000000000e02495f	1000	🌱 养生亦养心\n🌻 悦享健康，自在成长\n🌸 我是糯米，与你一同奔赴更好	\N	2026-08-28 14:50:57.681479+00	2026-08-28 14:50:57.681479+00	\N
26	matrix	benchmark	小红书	小野茶茶	https://www.xiaohongshu.com/user/profile/5fcde30f0000000001008df1	10	\N	\N	2026-08-29 03:25:22.062488+00	2026-08-29 03:25:22.062488+00	\N
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
4	4	97
4	7	97
4	1	97
4	8	97
4	10	97
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
109	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:39:21.49546+00	\N	\N	\N	\N
110	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:39:31.813044+00	\N	\N	\N	\N
108	3	7	1	2026-08-26 03:43:13.908272+00	2026-08-25 08:39:01.346171+00	\N	\N	\N	\N
111	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:39:51.895218+00	\N	\N	\N	\N
112	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:39:55.638037+00	\N	\N	\N	\N
113	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:16.270027+00	\N	\N	\N	\N
114	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:19.973355+00	\N	\N	\N	\N
115	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:20.687157+00	\N	\N	\N	\N
116	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:21.261643+00	\N	\N	\N	\N
117	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:21.725158+00	\N	\N	\N	\N
118	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:22.21327+00	\N	\N	\N	\N
119	1	8	1	2026-08-25 08:43:59.001124+00	2026-08-25 08:43:22.677063+00	\N	\N	\N	\N
120	4	8	\N	2026-08-26 03:00:22.47987+00	2026-08-26 03:00:09.054294+00	\N	\N	\N	\N
121	4	8	先测试一下	2026-08-26 03:00:25.437348+00	2026-08-26 03:00:24.392913+00	\N	\N	\N	\N
122	8	4	ok	2026-08-26 03:00:31.560024+00	2026-08-26 03:00:30.388688+00	\N	\N	\N	\N
124	1	7	测试	2026-08-26 06:18:32.78953+00	2026-08-26 03:58:07.15798+00	\N	\N	\N	\N
123	8	4	就是根据聊天记录等这些信息结合这个去推是吧	2026-08-28 06:33:39.174929+00	2026-08-26 03:01:38.464986+00	\N	\N	\N	\N
125	8	4	有聊天记录吗我测试一下	2026-08-28 06:33:39.174929+00	2026-08-26 06:18:25.967084+00	\N	\N	\N	\N
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
-- Data for Name: component_retrieval_profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.component_retrieval_profiles (id, build_id, algorithm_id, component_id, selection_id, revision_id, approving_decision_id, dimension_key, status, input_sha256, frozen_name, frozen_summary, frozen_applicability, frozen_limitations, frozen_source_count, frozen_tags, created_at, completed_at) FROM stdin;
\.


--
-- Data for Name: component_retrieval_states; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.component_retrieval_states (component_id, dirty, dirty_generation, current_fingerprint, last_profile_id, last_build_id, last_error_code, last_error_message, updated_at) FROM stdin;
\.


--
-- Data for Name: component_retrieval_vectors; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.component_retrieval_vectors (id, profile_id, component_id, selection_id, revision_id, approving_decision_id, dimension_key, vector, norm_sq, nonzero_count, simhash, band_0, band_1, band_2, band_3, band_4, band_5, band_6, band_7, created_at) FROM stdin;
\.


--
-- Data for Name: content_component_lifecycle_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.content_component_lifecycle_events (id, component_id, event_type, reason, actor_id, actor_role, created_at) FROM stdin;
\.


--
-- Data for Name: content_component_revision_decisions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.content_component_revision_decisions (id, component_id, revision_id, decision, note, actor_id, actor_role, created_at) FROM stdin;
\.


--
-- Data for Name: content_component_revision_sources; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.content_component_revision_sources (id, component_id, revision_id, revision_dimension_key, extraction_id, extraction_dimension_key, source_role, created_at) FROM stdin;
\.


--
-- Data for Name: content_component_revision_tags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.content_component_revision_tags (id, component_id, revision_id, tag_id, origin, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: content_component_revisions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.content_component_revisions (id, component_id, revision, dimension_key, origin, state, name, pattern_text, function_text, applicability, limitations, do_not_copy, content_sha256, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: content_component_selections; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.content_component_selections (id, component_id, revision_id, decision_id, selected_by, created_at) FROM stdin;
\.


--
-- Data for Name: content_components; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.content_components (id, name, lifecycle_state, created_by, created_at) FROM stdin;
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
13	30	1	\N	支持	2026-08-26 16:03:05.056618+00	f
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
30	1	2026-08-26 16:02:54.06161+00
\.


--
-- Data for Name: ideas; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ideas (id, code, title, content, category, tags, status, author_id, is_anonymous, vote_count, comment_count, view_count, hot_score, owner_id, adopted_at, adopted_by, progress, doc_url, created_at, updated_at, source_type, source_url, source_ref, deleted_at, promoted_at) FROM stdin;
2	IDEA-2026-0033	测试	测试士大夫地方萨芬啊	其他	{测试}	adopted	1	f	1	1	5	1.4038849	1	2026-08-20 16:44:09.933077+00	1	0	\N	2026-08-20 16:43:48.094505+00	2026-08-20 16:44:23.365851+00	manual	\N	\N	2026-08-24 06:14:44.691725+00	2026-08-20 16:44:09.933077+00
11	IDEA-2026-0035	茶水间换一台好点的咖啡机	现在这台每天要坏一次，排队的时间比喝的时间长。	其他	{福利}	adopted	1	f	2	0	6	1.3445208	1	2026-08-20 17:13:03.236155+00	1	35	\N	2026-08-20 17:10:31.233387+00	2026-08-21 02:47:00.787142+00	manual	\N	\N	\N	2026-08-20 17:13:03.236155+00
21	IDEA-2026-0039	厕所	厕所	产品	{}	adopted	7	f	0	0	163	0.35355338	7	2026-08-21 06:11:26.233451+00	7	0	\N	2026-08-21 06:11:11.527978+00	2026-08-21 14:22:55.070242+00	manual	\N	\N	\N	2026-08-21 06:11:26.233451+00
19	IDEA-2026-0038	分割成	法国很多方面	产品	{}	adopted	7	f	0	0	7	0.35355338	7	2026-08-21 05:10:35.270938+00	7	0	\N	2026-08-21 05:10:20.129387+00	2026-08-21 06:26:33.940792+00	manual	\N	\N	\N	2026-08-21 05:10:35.270938+00
13	IDEA-2026-0036	aaaa	a	技术	{}	adopted	3	f	2	3	17	2.739506	3	2026-08-21 01:47:10.83503+00	3	60	\N	2026-08-21 01:10:27.355954+00	2026-08-21 02:41:11.02019+00	manual	\N	\N	\N	2026-08-21 01:47:10.83503+00
16	IDEA-2026-0037	xxxx	x	运营	{}	adopted	3	f	1	3	17	2.1192162	3	2026-08-21 02:49:28.313962+00	3	100	http://127.0.0.1:5000/	2026-08-21 02:47:55.855369+00	2026-08-21 02:50:38.383839+00	manual	\N	\N	\N	2026-08-21 02:49:28.313962+00
10	\N	新人入职清单线上化	现在靠老员工口口相传，每个人漏的东西都不一样。做成一张能勾选的清单，第一天该干什么一目了然。	流程	{入职}	pending	1	f	4	1	10	0.25906444	\N	\N	\N	0	\N	2026-08-20 17:10:31.219804+00	2026-08-21 02:12:34.699823+00	manual	\N	\N	\N	\N
9	\N	客户案例做成短视频	文字案例没人看完。同样的内容剪成 90 秒的短视频，销售拿去发朋友圈的转化会高得多。	运营	{内容}	pending	1	f	5	1	4	0.3108773	\N	\N	\N	0	\N	2026-08-20 17:10:31.205796+00	2026-08-22 02:17:55.378265+00	manual	\N	\N	\N	\N
28	\N	智能导入接口自测（可删除）	验证统一写入与幂等处理。	技术	{自动化}	pending	1	f	0	0	0	0.045574598	\N	\N	\N	0	\N	2026-08-24 07:11:28.935267+00	2026-08-24 07:11:28.935267+00	manual		smart:a31f5c8ddac7f8e1ea83:0	2026-08-24 07:11:28.994108+00	\N
18	\N	1	1	产品	{}	pending	3	t	1	0	2	0.08202994	\N	\N	\N	0	\N	2026-08-21 02:51:52.707932+00	2026-08-21 08:29:28.905559+00	manual	\N	\N	2026-08-24 08:59:34.167813+00	\N
12	\N	搜索支持拼音首字母	找同事和找文档都得打全名，打 zwj 就能出「张伟杰」会快很多。	产品	{搜索,体验}	rejected	1	f	1	0	1	0.058042575	\N	\N	\N	0	\N	2026-08-20 17:10:31.248907+00	2026-08-21 01:46:07.398936+00	manual	\N	\N	\N	\N
30	\N	测试企业微信线索通知	通过企业微信向客服发送直播线索通知，验证能否提升线索跟进及时性。计划下周先进行测试。	产品	{企业微信,通知机制,方案测试}	pending	10	f	1	1	5	0.18609878	\N	\N	\N	0	\N	2026-08-24 09:45:39.775253+00	2026-08-26 16:03:05.056618+00	manual		smart:77b523d91b3a9553dc11:1	\N	\N
14	\N	a	a	产品	{}	rejected	3	t	0	0	5	0.2414722	\N	\N	\N	0	\N	2026-08-21 01:10:34.03293+00	2026-08-21 01:45:17.803511+00	manual	\N	\N	\N	\N
7	\N	把周报改成自动生成	从任务系统里抓本周动态，自动拼一份初稿，人只需要改两句就能发。现在每周五下午全公司都在写周报，这段时间加起来不少。	产品	{效率,自动化}	pending	1	f	11	6	52	0.75128675	\N	\N	\N	0	\N	2026-08-20 17:10:31.139742+00	2026-08-24 08:59:20.530318+00	manual	\N	\N	\N	\N
29	\N	智能导入全路径自测-1787555517124-灵感	测试	技术	{}	pending	1	f	0	0	0	0.045577448	\N	\N	\N	0	\N	2026-08-24 07:11:57.1553+00	2026-08-24 07:11:57.1553+00	manual		smart:615027849b8c2336e311:0	2026-08-24 07:11:57.231381+00	\N
17	\N	xx	xx	其他	{}	pending	3	f	1	0	7	0.08200292	\N	\N	\N	0	\N	2026-08-21 02:48:23.667519+00	2026-08-21 08:29:27.240106+00	manual	\N	\N	2026-08-24 08:59:31.341837+00	\N
20	\N	重返香港v范德萨	第三方	产品	{}	rejected	7	f	0	0	2	0.3203421	\N	\N	\N	0	\N	2026-08-21 05:12:10.583512+00	2026-08-21 08:29:43.932296+00	manual	\N	\N	\N	\N
8	\N	给构建加个缓存层	CI 每次都从零装依赖，一次要六分多钟。加一层缓存能压到一分半以内，改一行代码的验证成本会低很多。	技术	{CI,构建}	pending	1	f	6	5	9	0.46631595	\N	\N	\N	0	\N	2026-08-20 17:10:31.191758+00	2026-08-24 02:28:26.910113+00	manual	\N	\N	\N	\N
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
25	10	4	report_feedback	朱涛 反馈了你的「表格」	1	reports	23	\N	2026-08-28 06:39:12.429015+00
16	1	7	report_assigned	李年 提交了「情感赛道」等你审核	\N	reports	19	2026-08-25 08:28:05.711786+00	2026-08-25 08:27:16.803369+00
13	10	4	report_feedback	朱涛 反馈了你的「表格」	多找作品高收藏 500+，小于3000粉丝量的作品	reports	16	2026-08-25 08:41:14.559615+00	2026-08-25 07:37:28.203036+00
15	1	\N	report_assigned	上传自测（用完即删） 提交了「上传自测（用完即删）」等你审核	\N	reports	18	2026-08-25 08:48:10.417847+00	2026-08-25 08:14:21.505019+00
17	7	1	report_assigned	华俊杰 提交了「测试」等你审核	\N	reports	20	2026-08-25 08:51:26.223862+00	2026-08-25 08:51:08.366498+00
26	10	4	report_feedback	朱涛 反馈了你的「作品」	1	reports	22	\N	2026-08-28 06:39:22.505643+00
18	1	\N	report_assigned	翻页自测（用完即删） 提交了「翻页自测·单图（用完即删）」等你审核	\N	reports	21	2026-08-25 09:09:23.55237+00	2026-08-25 08:51:33.960174+00
21	4	7	report_assigned	李年 提交了「图文」等你审核	\N	reports	24	2026-08-26 03:01:30.057428+00	2026-08-25 10:01:38.483562+00
20	4	10	report_assigned	杨池 提交了「表格」等你审核	\N	reports	23	2026-08-26 03:03:38.751046+00	2026-08-25 09:28:31.954217+00
19	4	10	report_assigned	杨池 提交了「作品」等你审核	\N	reports	22	2026-08-26 03:35:27.71743+00	2026-08-25 09:27:41.490462+00
24	7	4	report_feedback	朱涛 反馈了你的「图文」	依托答辩	reports	24	2026-08-26 03:39:22.292035+00	2026-08-26 03:03:23.312628+00
14	7	4	report_feedback	朱涛 反馈了你的「表格」	1	reports	15	2026-08-26 03:39:37.612083+00	2026-08-25 07:37:36.966146+00
12	7	4	report_feedback	朱涛 反馈了你的「表格」	1	reports	17	2026-08-26 03:39:42.434036+00	2026-08-25 07:34:13.505636+00
9	4	7	report_assigned	李年 提交了「表格」等你审核	\N	reports	15	2026-08-27 05:44:31.656825+00	2026-08-24 07:53:08.124762+00
11	4	7	report_assigned	李年 提交了「表格」等你审核	\N	reports	17	2026-08-27 05:44:35.703209+00	2026-08-25 06:32:15.964824+00
10	4	10	report_assigned	杨池 提交了「表格」等你审核	\N	reports	16	2026-08-27 05:44:35.703209+00	2026-08-24 09:31:14.873002+00
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
-- Data for Name: sample_analysis_dimensions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_analysis_dimensions (dimension_key, ordinal, label, description) FROM stdin;
audience	1	用户对象	作品主要面向的用户群体与所处情境
user_need	2	用户需求	用户希望被解决的显性或隐性需求
topic	3	选题	作品讨论的核心议题与内容边界
core_viewpoint	4	核心观点	作者希望受众接受的核心判断
breakout_point	5	爆点	最容易引发停留、传播或讨论的机制
title_mechanism	6	标题机制	标题吸引点击所使用的结构与承诺
opening_method	7	开头方式	内容建立注意力和进入主题的方式
content_structure	8	内容结构	信息与段落的组织顺序
argumentation_method	9	论证方式	支撑观点所使用的证据和推理方式
language_style	10	语言风格	措辞、语气、节奏与表达姿态
length	11	篇幅	内容长度及信息密度特征
layout	12	排版	文字、段落、字幕和版面组织
visual_style	13	视觉风格	画面、人物、色彩、构图和视觉模板
bgm	14	BGM	背景音乐的存在、类型与功能
cta	15	CTA	引导评论、关注、私信或转化的动作
\.


--
-- Data for Name: sample_analysis_elements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_analysis_elements (id, version_id, dimension_key, state, value_json, function_text, confidence, evidence_strength, applicability, limitations, created_at) FROM stdin;
1	1	audience	value	"针对需要拍摄口播视频、担心念稿感影响流量和观众感受的内容创作者。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.675338+00
2	1	user_need	value	"用户主要问题是视频表达有念稿感，导致不自然、缺乏吸引力，可能影响流量。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.675338+00
3	1	topic	value	"这条视频主要讲如何通过两个训练方法去除视频拍摄中的念稿感，提升表达的自然度。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.675338+00
4	1	core_viewpoint	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.675338+00
5	1	breakout_point	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.675338+00
6	1	title_mechanism	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.675338+00
7	1	opening_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.675338+00
8	1	content_structure	value	"内容先提出问题（念稿感影响流量），再展示自身双视角作为例子，然后介绍两个训练方法，最后具体说明方法要点。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.675338+00
9	1	argumentation_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.675338+00
10	1	language_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.675338+00
11	1	length	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.675338+00
12	1	layout	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.675338+00
13	1	visual_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.675338+00
14	1	bgm	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.675338+00
15	1	cta	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.675338+00
16	2	audience	value	"针对在职场或人际关系中感到焦虑、想提升个人吸引力或情绪管理能力的人群。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.756054+00
17	2	user_need	value	"用户可能希望解决在关系或职场中过度用力、患得患失，导致失去主动权或吸引力的问题。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.756054+00
18	2	topic	value	"这条内容主要讲‘顶级吸引力’来自淡定、克制和无为，而非刻意展示或用力抓取。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.756054+00
19	2	core_viewpoint	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.756054+00
20	2	breakout_point	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.756054+00
21	2	title_mechanism	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.756054+00
22	2	opening_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.756054+00
23	2	content_structure	value	"内容先提出核心观点，引用道德经解释，然后分两个要点展开：淡定的本质是不在乎，淡定是内在状态而非伪装，最后总结魅力是做减法。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.756054+00
24	2	argumentation_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.756054+00
25	2	language_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.756054+00
26	2	length	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.756054+00
27	2	layout	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.756054+00
28	2	visual_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.756054+00
29	2	bgm	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.756054+00
30	2	cta	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.756054+00
31	3	audience	value	"针对对心理学、亲密关系议题感兴趣的人群，以及恐怖电影爱好者或关注情感关系问题的观众。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.794932+00
32	3	user_need	value	"用户可能希望了解电影《痴迷》的看点，同时理解“脆弱型自恋者”这一隐蔽人格类型，以及如何在亲密关系中识别和应对类似行为。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.794932+00
33	3	topic	value	"这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.794932+00
34	3	core_viewpoint	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.794932+00
35	3	breakout_point	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.794932+00
36	3	title_mechanism	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.794932+00
37	3	opening_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.794932+00
38	3	content_structure	value	"内容先以个人观影体验引入，接着介绍电影剧情，然后通过影评和心理学概念分析角色行为，最后总结电影主题并给出观影建议。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.794932+00
39	3	argumentation_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.794932+00
40	3	language_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.794932+00
41	3	length	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.794932+00
42	3	layout	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.794932+00
43	3	visual_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.794932+00
44	3	bgm	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.794932+00
45	3	cta	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.794932+00
46	4	audience	value	"针对那些习惯独自完成所有事情、追求全流程掌控、对'自学'和'自我完整'有偏执的人群，尤其是高认知但可能陷入单一路径成功经验的人。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.825506+00
47	4	user_need	value	"用户可能面临因过度依赖自身努力而导致的效率低下、精力消耗和人际孤立，需要学会借助外部资源和人脉来提升生命效率。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.825506+00
48	4	topic	value	"内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.825506+00
49	4	core_viewpoint	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.825506+00
50	4	breakout_point	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.825506+00
51	4	title_mechanism	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.825506+00
52	4	opening_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.825506+00
53	4	content_structure	value	"内容先定义问题（不会借力是自恋和懒惰），再分析心理根源（自我边界偏差、我执、工具性思维差），最后提出借力的高维心法（视角转变和利他共赢）。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.825506+00
54	4	argumentation_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.825506+00
55	4	language_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.825506+00
56	4	length	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.825506+00
57	4	layout	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.825506+00
58	4	visual_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.825506+00
59	4	bgm	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.825506+00
60	4	cta	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.825506+00
61	5	audience	value	"针对在感情关系中遇到沟通困扰、怀疑对方有NPD倾向的人群，尤其是经历过分手或冲突的个体。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.859307+00
62	5	user_need	value	"用户需要识别伴侣是否具有NPD特征，理解其行为背后的原因，并寻求关系修复或应对方法。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.859307+00
63	5	topic	value	"这条内容主要讲如何通过语言习惯识别自恋型人格障碍（NPD），并对比正常人与NPD在提问方式上的差异。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.859307+00
64	5	core_viewpoint	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.859307+00
65	5	breakout_point	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.859307+00
66	5	title_mechanism	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.859307+00
67	5	opening_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.859307+00
68	5	content_structure	value	"内容先提出识别NPD的绝招，然后举例对比正常人与NPD的提问方式，分析NPD的思维模式，最后介绍咨询师身份并引导互动。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.859307+00
69	5	argumentation_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.859307+00
70	5	language_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.859307+00
71	5	length	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.859307+00
72	5	layout	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.859307+00
73	5	visual_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.859307+00
74	5	bgm	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.859307+00
75	5	cta	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.859307+00
76	6	audience	value	"针对在亲密关系中缺乏安全感、容易患得患失的人群。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.885244+00
77	6	user_need	value	"用户需要了解如何在亲密关系中建立不依赖对方、不惧失去的底层安全感。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.885244+00
78	6	topic	value	"内容围绕亲密关系中'不怕失去的底层安全感'这一主题展开，探讨其来源。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.885244+00
79	6	core_viewpoint	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.885244+00
80	6	breakout_point	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.885244+00
81	6	title_mechanism	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.885244+00
82	6	opening_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.885244+00
83	6	content_structure	value	"以提问式标题引入，正文未提供具体展开结构，可能以论述或案例形式说明。"	\N	\N	none	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	2026-08-29 15:30:14.885244+00
84	6	argumentation_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.885244+00
85	6	language_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.885244+00
86	6	length	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.885244+00
87	6	layout	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.885244+00
88	6	visual_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.885244+00
89	6	bgm	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.885244+00
90	6	cta	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.885244+00
91	7	audience	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
92	7	user_need	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
93	7	topic	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
94	7	core_viewpoint	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
95	7	breakout_point	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
96	7	title_mechanism	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
97	7	opening_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
98	7	content_structure	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
99	7	argumentation_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
100	7	language_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
101	7	length	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
102	7	layout	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
103	7	visual_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
104	7	bgm	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
105	7	cta	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 15:30:14.909842+00
106	8	audience	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
107	8	user_need	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
108	8	topic	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
109	8	core_viewpoint	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
110	8	breakout_point	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
111	8	title_mechanism	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
112	8	opening_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
113	8	content_structure	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
114	8	argumentation_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
115	8	language_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
116	8	length	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
117	8	layout	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
118	8	visual_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
119	8	bgm	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
120	8	cta	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 16:50:46.292842+00
121	9	audience	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
122	9	user_need	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
123	9	topic	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
124	9	core_viewpoint	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
125	9	breakout_point	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
126	9	title_mechanism	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
127	9	opening_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
128	9	content_structure	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
129	9	argumentation_method	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
130	9	language_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
131	9	length	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
132	9	layout	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
133	9	visual_style	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
134	9	bgm	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
135	9	cta	insufficient	\N	\N	\N	none	\N	\N	2026-08-29 17:45:50.511712+00
\.


--
-- Data for Name: sample_analysis_jobs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_analysis_jobs (id, sample_id, source_capture_id, idempotency_key, input_sha256, status, attempts, max_attempts, select_on_success, provider, model_name, requested_by, started_at, finished_at, error_code, error_message, created_at, updated_at) FROM stdin;
1	5	5	sample-5-1788022229778	c7b74fb947de1f75e18c152e905bac0117ec2b09aede85d7be0d0a956f413f80	failed	1	3	t	saved	gpt-5.6-sol	1	2026-08-29 16:51:11.934431+00	2026-08-29 16:51:56.952012+00	AI_TIMEOUT	AI 分析超时，请重试	2026-08-29 16:51:11.922141+00	2026-08-29 16:51:56.952012+00
2	10	10	sample-10-1788024999288	1b6e1407c704b4d4ca893462bd37f39b93e3e96170d12f69b7be03bf397a0180	failed	1	3	t	saved	gpt-5.6-sol	1	2026-08-29 17:37:21.595014+00	2026-08-29 17:38:06.612697+00	AI_TIMEOUT	AI 分析超时，请重试	2026-08-29 17:37:21.587366+00	2026-08-29 17:38:06.612697+00
\.


--
-- Data for Name: sample_analysis_selections; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_analysis_selections (id, sample_id, version_id, reason, selected_by, created_at) FROM stdin;
1	3	1	migration	\N	2026-08-29 15:30:14.675338+00
2	1	2	migration	\N	2026-08-29 15:30:14.756054+00
3	2	3	migration	\N	2026-08-29 15:30:14.794932+00
4	4	4	migration	\N	2026-08-29 15:30:14.825506+00
5	5	5	migration	\N	2026-08-29 15:30:14.859307+00
6	9	6	migration	\N	2026-08-29 15:30:14.885244+00
7	10	7	migration	\N	2026-08-29 15:30:14.909842+00
8	5	8	explicit	1	2026-08-29 16:50:46.292842+00
9	10	9	explicit	1	2026-08-29 17:45:50.511712+00
\.


--
-- Data for Name: sample_analysis_versions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_analysis_versions (id, sample_id, job_id, source_capture_id, revision, source, status, input_sha256, schema_version, prompt_version, model_provider, model_name, model_version, manifest_sha256, created_by, created_at, completed_at) FROM stdin;
1	3	\N	3	1	legacy	complete	bf6dd9b586f5e9b9f7342fd81de4e0aeb9873d6e2c2f485d826c9c745e72fac5	sample-research/2.0	legacy-ai-analysis-map/2026-08-29	\N	\N	\N	4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945	\N	2026-08-29 15:30:14.675338+00	2026-08-29 15:30:14.675338+00
2	1	\N	1	1	legacy	complete	f0ead35fc97a2eea51cb5bf9ab522b3cd2534e3d1c0befe8a53045bbda60ccc5	sample-research/2.0	legacy-ai-analysis-map/2026-08-29	\N	\N	\N	4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945	\N	2026-08-29 15:30:14.756054+00	2026-08-29 15:30:14.756054+00
3	2	\N	2	1	legacy	complete	3cf4e211515c4c84fc96254955e9186c8fbc132299f98f241a41f5baa6a27502	sample-research/2.0	legacy-ai-analysis-map/2026-08-29	\N	\N	\N	4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945	\N	2026-08-29 15:30:14.794932+00	2026-08-29 15:30:14.794932+00
4	4	\N	4	1	legacy	complete	980f6b57f9e5696e9de5815be3155e8cdfead6d119747eb1653e8a96c24ba419	sample-research/2.0	legacy-ai-analysis-map/2026-08-29	\N	\N	\N	4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945	\N	2026-08-29 15:30:14.825506+00	2026-08-29 15:30:14.825506+00
5	5	\N	5	1	legacy	complete	ec3bad9e1bef84f3afa5d2bcde5a96377e9627a41b27a2186f36675fd24bdf4c	sample-research/2.0	legacy-ai-analysis-map/2026-08-29	\N	\N	\N	4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945	\N	2026-08-29 15:30:14.859307+00	2026-08-29 15:30:14.859307+00
6	9	\N	9	1	legacy	complete	390ff5fda5239312ea28bb07b2edf183d4fd685de7d4a239fdae293785378e78	sample-research/2.0	legacy-ai-analysis-map/2026-08-29	\N	\N	\N	4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945	\N	2026-08-29 15:30:14.885244+00	2026-08-29 15:30:14.885244+00
7	10	\N	10	1	legacy	complete	534dcf7ccddc82dcc853440667ab805d93ee4f0654441c8cb94b2981758def94	sample-research/2.0	legacy-ai-analysis-map/2026-08-29	\N	\N	\N	4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945	\N	2026-08-29 15:30:14.909842+00	2026-08-29 15:30:14.909842+00
8	5	\N	5	2	manual	complete	5a5bd34a0c1ced803d6fc73b708ed8d645fe9b37d1759429a4f2cf51f5a46172	sample-research/2.0	\N	\N	\N	\N	c027cc27bacbb2ea0a6a04acf3d1ecdbfd4690a908b3e3ad89ed006190178d19	1	2026-08-29 16:50:46.292842+00	2026-08-29 16:50:46.292842+00
9	10	\N	10	2	manual	complete	087a3b418cc2a880fbcd6bbc5d328da0289a2dcc1d4b9b5f855f708c14213719	sample-research/2.0	\N	\N	\N	\N	81e0ffe69cb4fcc45e01104c03866a36618696d9cc3b3faae522ee5b1b7f3e9c	1	2026-08-29 17:45:50.511712+00	2026-08-29 17:45:50.511712+00
\.


--
-- Data for Name: sample_assets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_assets (id, sample_id, capture_id, kind, storage_key, original_name, mime_type, byte_size, sha256, width, height, duration_ms, source_url, archive_quality, uploaded_by, created_at, deleted_at) FROM stdin;
1	1	1	cover	2db7fd2053eab5647b52ffd43d5335866b135d89c247d686	8beb7209ed7cae9a3653b0e8142e5f39da032b5d.jpg	image/jpeg	61308	f62c2edef3a3ba29cc5b3b53f2a455dfe19a84d16e7798827f44fd249a1a1c5e	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.809234+00	\N
2	2	2	cover	f59dadd8752e46df5c286e4691821bc0ade7a0363d97e878	3f7398d2856a44b21729dbcffadf30be359df71d.webp	image/webp	134336	cf03dd39e4e19e7ad6f6e0b3dce8865c0b0352f429eeb2bd00723fd08c95fe69	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.842904+00	\N
3	3	3	cover	8b089c2733bb1bbed68c4f0f0d81a26705fe6256de8b6008	a27f19766718954942e5ff022d80bd9ccbc63af7.webp	image/webp	141868	5ef81a13af79bdf36f8ec5685b54754543d11991d144d64aecaab06e986e624f	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.866448+00	\N
4	4	4	cover	8eb551126c17bfb5d4d44d2926367f7a14617f6ed6346ffa	e8205929cdcfcd84f7ca139d71c5c9bd2193391c.webp	image/webp	119878	7fce36bd63c94b6edec12c2adf8b866445622d3f5df798eb17c083fb437d1809	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.88646+00	\N
5	4	4	image	2e1d49df75a6f9e31676523b20aced618a92eb7543c50ab6	15bbb73277e4c83d74ab4195d4798149cfbbb965.webp	image/webp	119878	7fce36bd63c94b6edec12c2adf8b866445622d3f5df798eb17c083fb437d1809	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.893053+00	\N
6	5	5	cover	c2c527d0ba67d6136b1e767038fa2a01e3c718bf9f3c851b	8add005afcbcf26408d1fb1a19cd14c4aeae9edb.webp	image/webp	104984	6048a620a8317c5c6b017d4c0f8ef9f3d6b393ddcc45c440d65543eb46384b75	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.913052+00	\N
7	5	5	image	06006fd7ec49b2a9bd2eaf526c27f7d9e7b44a86d907e5f1	bbbee04b8f2d3bdadb1a7749edb0859e81d49e22.webp	image/webp	104984	6048a620a8317c5c6b017d4c0f8ef9f3d6b393ddcc45c440d65543eb46384b75	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.917968+00	\N
8	5	5	image	cf9c64845125e966fbf8ad69d57f7aa7591b267c68618149	65110c242feabdc1d46d43f63712f00e395da43f.webp	image/webp	82466	1d5defd3fafe396165ed90b663075c22128cf36921b38a7bc53a9392aec39740	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.922823+00	\N
9	5	5	image	244a55321f850715b893c7b5d06abea993a163563dfe64e4	838e309c8ea8810fb56383c14949d9303f800095.webp	image/webp	113990	d3f7919ae7bc273726ca326a473ed66b58846de52163568969e2d677dee3952e	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.928927+00	\N
10	5	5	image	b2fc6f8c9ad2cfb424cbffceaba13020ee7421477869fdae	a148a7a80e66378faf39493b36783848b416292a.webp	image/webp	109634	6c8fdf6af2f3018921ed6c2342c1ab59a4ce611372997a97f30f185e8b4fcce2	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.933909+00	\N
11	5	5	image	4f526ded06af2ef23b703416d74537d790504ba77b693141	bb0fc38d275363cbae1326e13f27b8d36d6d4547.webp	image/webp	107596	edf070065ba6889251e697ab009b27ec1f4687e4c10c67a3e6824eed74aa93d9	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.941074+00	\N
12	5	5	image	238a3c341c805e433b476a7db8bbf1e963e06993add40dc0	2f6852dbd393cd9c71b038f73064d88c33c9b5bf.webp	image/webp	121262	7895e459f9b0ba19c0aefcba37f32ab62e4289ac144755732cf09c077d81c103	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.946247+00	\N
13	5	5	image	26dd6af391988917fd6a06dc4aca8c38c2f8c2605a0810b7	c3752e4795150b80bf78227ef328e98ee64d9301.webp	image/webp	153898	5e3f5cd5a000c735d82df7f5f1ee64ae3f36248e2f98fc9b55a253da728f80eb	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.951946+00	\N
14	5	5	image	c3f528158ff2936637dff2556124a244ef95a1acccef609f	395cdddc6a607b3e6fceef478089ef72b77304b1.webp	image/webp	129020	890c5cca9acff4ab72f23bbb7616392a7b64b6a99976f9df44a88bd4d86ed28f	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.956962+00	\N
15	5	6	cover	b3d99a3f449425c5a6c0e23f0de99ae8abd1e617043ba122	38cd574cf4fc6389a8c45a96f433667e026e2d15.webp	image/webp	104984	6048a620a8317c5c6b017d4c0f8ef9f3d6b393ddcc45c440d65543eb46384b75	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.980809+00	\N
16	5	6	image	800813fa6cb1fad51e7e67aa7d9c8418a614cd381e769584	d92e8141603262b8778c8f0b9b3bda6883c7c2d4.webp	image/webp	104984	6048a620a8317c5c6b017d4c0f8ef9f3d6b393ddcc45c440d65543eb46384b75	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.98718+00	\N
17	5	6	image	f262842b3a787f903a4de9e52c6e8de1f626f24aa28a1f91	58a46ef15367beec07e34d2a2351440ed9c9baa1.webp	image/webp	82466	1d5defd3fafe396165ed90b663075c22128cf36921b38a7bc53a9392aec39740	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.99181+00	\N
18	5	6	image	abdb7fa216576c32504a7cd6cbfa27e47b51f352f93f3877	031e178584762378d4c1d9582f2ba3df6857ec3b.webp	image/webp	113990	d3f7919ae7bc273726ca326a473ed66b58846de52163568969e2d677dee3952e	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:57.996363+00	\N
19	5	6	image	e10e80239d4e4dadeff03de189f2e695769ebbd228778891	2b96ce972e1476028b64d4badda5cde5a2f44002.webp	image/webp	109634	6c8fdf6af2f3018921ed6c2342c1ab59a4ce611372997a97f30f185e8b4fcce2	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.021769+00	\N
20	5	6	image	ab3532c78d2d4f282d7866857b36d7b31425c0fe2443d0f2	f51a123da845c89ccad01196b3519aeae2a9a149.webp	image/webp	107596	edf070065ba6889251e697ab009b27ec1f4687e4c10c67a3e6824eed74aa93d9	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.048907+00	\N
21	5	6	image	e3dfff4b31312eb2110e83d4532caea674e2a91f79c5a604	896d8e835e679af0f981c6dce971f2988cf68101.webp	image/webp	121262	7895e459f9b0ba19c0aefcba37f32ab62e4289ac144755732cf09c077d81c103	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.05861+00	\N
22	5	6	image	27f652c33598aa128b7c799c2663a2f5c554b1227859f312	ed274e69c1fbac9e8112f71a8bc27f1f7a8ba34b.webp	image/webp	153898	5e3f5cd5a000c735d82df7f5f1ee64ae3f36248e2f98fc9b55a253da728f80eb	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.067716+00	\N
23	5	6	image	00bce8e1ced3d431273dbfd0c0f1022e82b41e13f92dedb9	96a98cf40e638579ba42617050d7804771319ee9.webp	image/webp	129020	890c5cca9acff4ab72f23bbb7616392a7b64b6a99976f9df44a88bd4d86ed28f	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.073608+00	\N
24	4	7	cover	34eb64dae27f44b6719847c0c884b8b0a87736eb21b85f8c	fe793b5791781d68da8c7c22cd2d4dffb33b68a9.webp	image/webp	119878	7fce36bd63c94b6edec12c2adf8b866445622d3f5df798eb17c083fb437d1809	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.094196+00	\N
25	4	7	image	c26cca1278e47f72914294ba9362962fb2f6b30ae3f4d0e6	1cc742feaedf4e60d8d9f06ced4868199b93115d.webp	image/webp	119878	7fce36bd63c94b6edec12c2adf8b866445622d3f5df798eb17c083fb437d1809	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.100567+00	\N
26	3	8	cover	ada4954856d8eefec46356bc92f6d1e9c427f864dc921335	2f67699a56d9b573c926a324fb29700a6fe17ba1.webp	image/webp	141868	5ef81a13af79bdf36f8ec5685b54754543d11991d144d64aecaab06e986e624f	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.121126+00	\N
27	9	9	cover	90fb5f90bab87d141a61e9e0f9fe4caea2bcd788673ffa78	8e3fb5e014fedcda1c8f92409596094ebe6f8d54.webp	image/webp	192158	b3e78da08532712ad47a435ad5805d4b126a64bab7fb9a448826c1eee85c473e	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.139656+00	\N
28	9	9	image	2250126b0983c6bd9b840621e677fb52bebf4d4cabec4e6c	cd8e355bc92bf26e3af4efeee6a4808f0dc67f35.webp	image/webp	192158	b3e78da08532712ad47a435ad5805d4b126a64bab7fb9a448826c1eee85c473e	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.145531+00	\N
29	10	10	cover	8888ae94ae1d0b87097ada54d3cc1007b89dcbd8d06fc45b	eb649e7f10e6ad0a0a97eda238f958ca5eaa4015.webp	image/webp	650648	726d07de031f813c3be3ca51ca988ccbc6901a790094d7bf3ed5869e9e631e21	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.170772+00	\N
30	10	10	image	840e8b55f3b386b55de02f4d446dc3a27dd4ba7b7089d518	a3f71f267cca352776f396dc05e7bc2e73ef5a39.webp	image/webp	650648	726d07de031f813c3be3ca51ca988ccbc6901a790094d7bf3ed5869e9e631e21	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.179873+00	\N
31	10	10	image	3e180a4ce7fd8c87b5d966a64492b790656bde7675e9426b	5aff3d8871ec338cbe6075df1fa2c70997f0ec03.webp	image/webp	579232	ebda40d606bee7779b8ae83c23d5630ada06c6fbb3d7aa14e882d4fd1782b4d2	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.18975+00	\N
32	10	10	image	f79031e01f9fba01fadf548fc27dc05818e81ecfbd65d38c	70838a5b3ec9646768f9d23df1aa1d5511434b03.webp	image/webp	515780	bcb5e065445bf65a50239cdb33371c3acf2dfdc2a1f8a02e511951d8b4af3954	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.197452+00	\N
33	10	10	image	fe3829b11930577757cff21950bab231d2cafaf97f2dd0f7	2e5adf4393b67f7ba527c4ef31a7f09de99d151f.webp	image/webp	487050	bac57484a3c86495c83cad1ca9b52216083e6153973576a8c5059d3a94eda84b	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.205173+00	\N
34	10	10	image	32e10b0b6e5e01f23930debbda4654cf2db7736eb0574556	08b389d0b26a067851e5300bdea36ead7d3c3fd4.webp	image/webp	572802	b7dd2da6f0229cfd57998a45f41c3aa45e81b2dcfa76e6651230bdcdfa97958b	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.21451+00	\N
35	10	10	image	2bd79ec0b560fcbcfa1905d7924de44044dcc6566892a4a1	e052d221e3e7c46ceaf6eeefe4f9df384c4cc170.webp	image/webp	376992	183b6e72674b6dce39cdae708acfeb65c872ed3798bfa0b616ee25e36475e650	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.221857+00	\N
36	10	10	image	7fd5b85d88f457da39b802b0250737e9c4cebffdf78935e4	72090aef66845a7ffa27dc3f7e449f7563ce5ac0.webp	image/webp	453060	08adc8cddb715cd3ad634dbde9d0e96489db156fcc9d6bb9841d37f0339dc090	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.228708+00	\N
37	10	10	image	4c807db2e9c60324d5f6f963b911e8a100fb5ae961397fb4	27a5001d0e0d48c50a4ddaaa29557060744fa930.png	image/png	4569	c48b23733ef36f5eadfb6b026f70b92b48a00c61062c2169cf72f1f2ded79bbd	\N	\N	\N	\N	platform_archive	\N	2026-08-29 15:29:58.232384+00	\N
\.


--
-- Data for Name: sample_captures; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_captures (id, sample_id, capture_key, capture_type, captured_at, source_url, raw_payload, normalized_payload, payload_sha256, completeness_score, missing_fields, created_by, created_at) FROM stdin;
1	1	legacy-work-analysis:184:2026-08-26T02:42:00.352Z	legacy	2026-08-26 02:42:00+00	https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?xhsshare=pc_web	{"schema_version":15,"task_id":"45ecbd25bd1f","source_url":"https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?source=webshare&xhsshare=pc_web&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?source=webshare&xhsshare=pc_web&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&xsec_source=pc_share","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251724/a2ac49d2b5327b4603abe7cdc07e0f50/1040g2sg323t3k20m0ae05nenu9pg8u99tt3aqdo!nd_dft_wlteh_jpg_3","duration_seconds":156.4,"width":480,"height":854,"size_bytes":10330816,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_b64":"（已落地为本地封面文件，原始 81767 字符）"}},"title":"顶级吸引力就是无所谓","description":"情绪管理 职场 野生老板","cover_title":"","cover_title_meta":{},"post_title":"顶级吸引力就是无所谓","post_description":"情绪管理 职场 野生老板","display_title":"顶级吸引力就是无所谓","author":"野生老板商业思维","account":{"name":"野生老板商业思维","profile_url":"https://www.xiaohongshu.com/user/profile/5dd7f2730000000001007929","bio":"2020福布斯U30，地产资管公司创始人\\n强势文化｜国学智慧｜关系运作｜商业思维\\n@野生老板 官方授权","following_count":"204","follower_count":"27558","likes_and_collections_count":"218920"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"1399","collects":"922","comments":"37"},"topics":["人格魅力","吸引力","顶级思维","情绪管理","自我提升","职场","人性弱点","野生老板"],"video_text":"[00:00] 一个人的终极吸引力其实\\n[00:01] 就\\n[00:01] 淡定\\n[00:02] 这个是道德经里非常\\n[00:03] 反常识的一个真相\\n[00:05] 在道德经第29章\\n[00:06] 他说天下神器不可为也\\n[00:08] 不可执也\\n[00:08] 为者败之\\n[00:09] 执者失之\\n[00:10] 他说的就是\\n[00:11] 你越想用力抓住的东西\\n[00:12] 往往就是你失去的越快\\n[00:14] 而当你彻底放下执念\\n[00:15] 表现的云淡风轻\\n[00:16] 无欲则刚的时候\\n[00:17] 全世界的资源反而会主动的\\n[00:19] 向你靠拢\\n[00:20] 所有那些刻意展示出来的\\n[00:21] 啊\\n[00:22] 其实不够高级\\n[00:23] 精致的妆容\\n[00:24] 各种好听的话术\\n[00:25] 你越是主动\\n[00:26] 越是用力的去输出\\n[00:28] 在真正高手的眼里\\n[00:29] 你就显得越低级和匮乏\\n[00:31] 真正的\\n[00:31] 顶级吸引力来自于\\n[00:33] 克制\\n[00:33] 而在这个背后的本质\\n[00:35] 它其实是一种无为和不\\n[00:36] 执着的智慧\\n[00:37] 第一个\\n[00:38] 淡定的本质是不在乎\\n[00:39] 你不在意身边人的去留\\n[00:41] 不在乎别人的眼光和评价\\n[00:42] 不在意一段关系里的得\\n[00:44] 与失\\n[00:44] 你可以去留意一下\\n[00:45] 在关系里面最让人着迷\\n[00:47] 的那个人\\n[00:47] 从来不是那个患得患失\\n[00:48] 随时消息秒回\\n[00:49] 很在乎你的人\\n[00:50] 而是那个\\n[00:51] 无论你走也好留也好\\n[00:52] 回他消息也好\\n[00:53] 不理他也好\\n[00:54] 他都稳定的像石头一样\\n[00:56] 稳定的可怕的那个人\\n[00:57] 这种人的无所谓\\n[00:58] 他不是装出来的\\n[00:59] 他是真的\\n[01:00] 他是真的无所谓\\n[01:00] 本质是我的人生\\n[01:01] 能做到绝对的自给自足\\n[01:03] 绝对的自我圆满\\n[01:04] 这种淡定感\\n[01:06] 他是会给对方带来\\n[01:07] 巨大的心理压迫感的\\n[01:08] 因为他会突然发现\\n[01:09] 在你这里我没有任何筹码\\n[01:11] 可以谈判\\n[01:11] 他不能用离开来威胁你\\n[01:13] 因为你不需要他\\n[01:14] 他也不能用冷暴力来\\n[01:15] 控制你\\n[01:16] 因为你一个人也活得很好\\n[01:17] 他更加不能用这种\\n[01:18] 夸奖赞美来去收买你\\n[01:19] 因为你的自我价值是\\n[01:20] 不需要他来确认的\\n[01:21] 而当一个人在关系里面\\n[01:22] 找不到任何一个可以拿捏你的点\\n[01:24] 那他只剩两条路可以走\\n[01:25] 要么主动靠近你去适应你\\n[01:27] 要么自觉退出离场\\n[01:29] 而你呢这两种结果其实\\n[01:31] 都能接受\\n[01:32] 这个才是真正关系里\\n[01:34] 的主动权并\\n[01:35] 不是你控制了他\\n[01:36] 而是你控制了自己\\n[01:36] 你让自己绝对的冷静克制\\n[01:38] 而他这个时候就不得不\\n[01:40] 跟着你的节奏去走了\\n[01:41] 第二个淡定\\n[01:42] 它是一种内在的状态\\n[01:43] 而不是装出来的冷漠\\n[01:44] 道德经里有一句话形容淡定\\n[01:46] 我觉得非常合适\\n[01:47] 说清静为天下正\\n[01:48] 清静啊才是这个天下万事\\n[01:50] 万物的标准\\n[01:51] 什么叫清静\\n[01:52] 说实话我是不认同现在那些\\n[01:53] 所谓的修行就要打坐冥想\\n[01:55] 与世隔绝的\\n[01:56] 在我看来真正的清静是在这个世俗\\n[01:56] 真正的清净是在这个世俗\\n[01:58] 你的内心依旧是满的\\n[02:01] 依旧是不需要外界来去填补\\n[02:02] 你不需要别人的认可来确认自己的价值\\n[02:04] 也不需要一段关系来证明自己值得被爱\\n[02:06] 不需要任何人来评价定义你\\n[02:09] 当你能够自给自足的时候\\n[02:11] 其实你的状态自然而然就会\\n[02:12] 这个不是自我压抑出来的伪装\\n[02:14] 是外界根本他没有什么东西是可以撼动你的\\n[02:17] 一个内在圆满的人\\n[02:19] 他的淡定一定是\\n[02:20] 由内而外散发出来的状态\\n[02:21] 而不是装出来的外在的\\n[02:23] 所以顶级的魅力啊\\n[02:24] 他从来不是往自己身上做\\n[02:25] 去学什么话术\\n[02:26] 去打扮自己\\n[02:27] 在我看来\\n[02:28] 他是做减法\\n[02:30] 减掉你对外界的需要\\n[02:31] 减掉那些你拼命向外抓取的所有动作\\n[02:32] 你以为的魅力是你展示\\n[02:34] 但真正的魅力其实是你\\n[02:35] 不展示什么","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":3,"chunks_succeeded":3,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":26,"replies_scanned":6,"primary_pages":2,"reply_pages":2,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.214,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T09:27:31.674988+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要讲‘顶级吸引力’来自淡定、克制和无为，而非刻意展示或用力抓取。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对在职场或人际关系中感到焦虑、想提升个人吸引力或情绪管理能力的人群。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能希望解决在关系或职场中过度用力、患得患失，导致失去主动权或吸引力的问题。"},"content_structure":{"label":"内容怎么展开","summary":"内容先提出核心观点，引用道德经解释，然后分两个要点展开：淡定的本质是不在乎，淡定是内在状态而非伪装，最后总结魅力是做减法。"},"solution":{"label":"给了什么解决办法","summary":"给出的解决办法是：放下执念，做到内在自给自足，不依赖外界认可，从而自然散发淡定感，获得关系主动权。"},"references":{"label":"值得参考什么","summary":"值得参考的是道德经第29章和‘清静为天下正’的哲学观点，以及‘无为’‘不执着’的智慧。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸内容：具体如何在职场中应用‘无所谓’心态、如何区分真正的淡定与伪装冷漠、关系中的心理博弈案例等。"}},"source_labels":["文字标题","作品描述","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"title": "顶级吸引力就是无所谓", "metrics": {"likes": "1399", "收藏": 922, "点赞": 1399, "评论": 37, "collects": "922", "comments": "37"}, "bodyText": "情绪管理 职场 野生老板\\n\\n[00:00] 一个人的终极吸引力其实\\n[00:01] 就\\n[00:01] 淡定\\n[00:02] 这个是道德经里非常\\n[00:03] 反常识的一个真相\\n[00:05] 在道德经第29章\\n[00:06] 他说天下神器不可为也\\n[00:08] 不可执也\\n[00:08] 为者败之\\n[00:09] 执者失之\\n[00:10] 他说的就是\\n[00:11] 你越想用力抓住的东西\\n[00:12] 往往就是你失去的越快\\n[00:14] 而当你彻底放下执念\\n[00:15] 表现的云淡风轻\\n[00:16] 无欲则刚的时候\\n[00:17] 全世界的资源反而会主动的\\n[00:19] 向你靠拢\\n[00:20] 所有那些刻意展示出来的\\n[00:21] 啊\\n[00:22] 其实不够高级\\n[00:23] 精致的妆容\\n[00:24] 各种好听的话术\\n[00:25] 你越是主动\\n[00:26] 越是用力的去输出\\n[00:28] 在真正高手的眼里\\n[00:29] 你就显得越低级和匮乏\\n[00:31] 真正的\\n[00:31] 顶级吸引力来自于\\n[00:33] 克制\\n[00:33] 而在这个背后的本质\\n[00:35] 它其实是一种无为和不\\n[00:36] 执着的智慧\\n[00:37] 第一个\\n[00:38] 淡定的本质是不在乎\\n[00:39] 你不在意身边人的去留\\n[00:41] 不在乎别人的眼光和评价\\n[00:42] 不在意一段关系里的得\\n[00:44] 与失\\n[00:44] 你可以去留意一下\\n[00:45] 在关系里面最让人着迷\\n[00:47] 的那个人\\n[00:47] 从来不是那个患得患失\\n[00:48] 随时消息秒回\\n[00:49] 很在乎你的人\\n[00:50] 而是那个\\n[00:51] 无论你走也好留也好\\n[00:52] 回他消息也好\\n[00:53] 不理他也好\\n[00:54] 他都稳定的像石头一样\\n[00:56] 稳定的可怕的那个人\\n[00:57] 这种人的无所谓\\n[00:58] 他不是装出来的\\n[00:59] 他是真的\\n[01:00] 他是真的无所谓\\n[01:00] 本质是我的人生\\n[01:01] 能做到绝对的自给自足\\n[01:03] 绝对的自我圆满\\n[01:04] 这种淡定感\\n[01:06] 他是会给对方带来\\n[01:07] 巨大的心理压迫感的\\n[01:08] 因为他会突然发现\\n[01:09] 在你这里我没有任何筹码\\n[01:11] 可以谈判\\n[01:11] 他不能用离开来威胁你\\n[01:13] 因为你不需要他\\n[01:14] 他也不能用冷暴力来\\n[01:15] 控制你\\n[01:16] 因为你一个人也活得很好\\n[01:17] 他更加不能用这种\\n[01:18] 夸奖赞美来去收买你\\n[01:19] 因为你的自我价值是\\n[01:20] 不需要他来确认的\\n[01:21] 而当一个人在关系里面\\n[01:22] 找不到任何一个可以拿捏你的点\\n[01:24] 那他只剩两条路可以走\\n[01:25] 要么主动靠近你去适应你\\n[01:27] 要么自觉退出离场\\n[01:29] 而你呢这两种结果其实\\n[01:31] 都能接受\\n[01:32] 这个才是真正关系里\\n[01:34] 的主动权并\\n[01:35] 不是你控制了他\\n[01:36] 而是你控制了自己\\n[01:36] 你让自己绝对的冷静克制\\n[01:38] 而他这个时候就不得不\\n[01:40] 跟着你的节奏去走了\\n[01:41] 第二个淡定\\n[01:42] 它是一种内在的状态\\n[01:43] 而不是装出来的冷漠\\n[01:44] 道德经里有一句话形容淡定\\n[01:46] 我觉得非常合适\\n[01:47] 说清静为天下正\\n[01:48] 清静啊才是这个天下万事\\n[01:50] 万物的标准\\n[01:51] 什么叫清静\\n[01:52] 说实话我是不认同现在那些\\n[01:53] 所谓的修行就要打坐冥想\\n[01:55] 与世隔绝的\\n[01:56] 在我看来真正的清静是在这个世俗\\n[01:56] 真正的清净是在这个世俗\\n[01:58] 你的内心依旧是满的\\n[02:01] 依旧是不需要外界来去填补\\n[02:02] 你不需要别人的认可来确认自己的价值\\n[02:04] 也不需要一段关系来证明自己值得被爱\\n[02:06] 不需要任何人来评价定义你\\n[02:09] 当你能够自给自足的时候\\n[02:11] 其实你的状态自然而然就会\\n[02:12] 这个不是自我压抑出来的伪装\\n[02:14] 是外界根本他没有什么东西是可以撼动你的\\n[02:17] 一个内在圆满的人\\n[02:19] 他的淡定一定是\\n[02:20] 由内而外散发出来的状态\\n[02:21] 而不是装出来的外在的\\n[02:23] 所以顶级的魅力啊\\n[02:24] 他从来不是往自己身上做\\n[02:25] 去学什么话术\\n[02:26] 去打扮自己\\n[02:27] 在我看来\\n[02:28] 他是做减法\\n[02:30] 减掉你对外界的需要\\n[02:31] 减掉那些你拼命向外抓取的所有动作\\n[02:32] 你以为的魅力是你展示\\n[02:34] 但真正的魅力其实是你\\n[02:35] 不展示什么", "platform": "xiaohongshu", "sourceUrl": "https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?xhsshare=pc_web", "accountName": "野生老板商业思维", "contentType": "video", "publishedAt": null, "accountHandle": "野生老板商业思维", "platformContentId": "6a806dfa000000002501477a"}	1fccad29d581a847e877960938f9594bab121923c62519515095a2bc7bf2ffa1	75	{published_at,media}	\N	2026-08-29 15:29:57.747+00
2	2	legacy-work-analysis:196:2026-08-25T10:01:50.273Z	legacy	2026-08-25 10:01:50+00	https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&apptime=1787556009&author_share=1&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&xhsshare=CopyLink	{"schema_version":16,"task_id":"b36f1b924b66","source_url":"https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251704/c5f783a389998530e7b56ff71b1626ac/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_prv_wlteh_jpg_3","duration_seconds":458.306,"width":1080,"height":1920,"size_bytes":61079166,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_b64":"（已落地为本地封面文件，原始 179139 字符）","cover_image_source":"platform_video_cover","cover_image_url":"http://sns-webpic-qc.xhscdn.com/202608251739/808b4a3a343eee15ed8f07049ca7d3e7/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_dft_wlteh_webp_3","cover_image_width":1080,"cover_image_height":1440,"cover_image_size_bytes":134336}},"title":"看完痴迷，发现最恐怖的是无色无味老实人？","description":"心理学的脆弱型自恋者，望周知～","cover_title":"脆弱型自恋患者","cover_title_meta":{"text":"脆弱型自恋患者","confidence":0.994,"font_ratio":1.66,"line_count":1,"lines":[{"text":"脆弱型自恋患者","confidence":0.994}],"source_image_index":1,"source":"platform_video_cover"},"post_title":"看完痴迷，发现最恐怖的是无色无味老实人？","post_description":"心理学的脆弱型自恋者，望周知～","display_title":"脆弱型自恋患者","author":"治愈果（kakki在说啥）","account":{"name":"治愈果（kakki在说啥）","profile_url":"https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266","bio":"🐳百万粉丝心理创作者｜心理师\\n🐳累计500+小时个案\\n🐳Queen Mary 法学硕士🇬🇧 \\n🐳亲密关系｜终身成长：zhiyuguo820\\n@愈果 YU GUO","following_count":"104","follower_count":"162886","likes_and_collections_count":"1232628"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"784","collects":"349","comments":"75"},"topics":["痴迷","治愈果","心理学","惊悚片","自恋"],"video_text":"[00:00] 本人是一个恐怖电影爱好者\\n[00:02] 豆瓣的高分恐怖片清单\\n[00:04] 我基本上都刷了一个遍\\n[00:06] 最近\\n[00:07] 在海外有一部爆火的电影叫做《痴迷》\\n[00:09] 刚刚也在内地院线上映了\\n[00:10] 本人已经看完了\\n[00:12] 看完以后真的表示非常的兴奋\\n[00:14] 因为我觉得它不仅吓到我了\\n[00:16] 它也笑到我了\\n[00:17] 甚至有点惊艳到我了\\n[00:19] 我已经准备去电影院再二刷一次了\\n[00:21] 但我想要专门出一期视频\\n[00:23] 不只是因为它好看\\n[00:24] 而是因为\\n[00:25] 我觉得这个题材实在是太特别了\\n[00:27] 它不是那种传统意义上的鬼怪恐怖\\n[00:30] 而是把亲密关系\\n[00:31] 拍成了心理恐怖片的电影\\n[00:34] 可以说是刚好切到了我的内容赛道\\n[00:36] 所以想要先给大家推荐介绍一下剧情\\n[00:39] 男主贝尔是一个非常平凡\\n[00:41] 自卑又对爱情充满执念的一个男青年\\n[00:45] 他呢偶然听说了\\n[00:46] 小镇上有一个关于心愿柳的一个传说\\n[00:49] 是那种把柳条柳枝折断了\\n[00:52] 许个愿然后愿望就能实现\\n[00:54] 他有一天就去商店里面买了买了这个柳条\\n[00:55] 许愿\\n[00:56] 自己暗恋的女孩Nikki能够爱上自己\\n[00:59] OK 愿望成真了\\n[01:00] 两个人真的走到一起了\\n[01:03] 但是很快就发现 被召唤来的真的不是纯粹的爱情\\n[01:06] 而是纯纯的恐怖\\n[01:08] 女主被夺舍了 然后发了疯一样的爱上了男主贝尔\\n[01:12] 占有 控制 几乎惊恐到了变态的程度\\n[01:16] 而这部电影 我觉得它最讽刺的地方就是\\n[01:18] 它在用一种非常之极端的方式 拍出了很多人在亲密关系里面\\n[01:24] 既要 又要 还要\\n[01:25] 我看到一个非常有意思的影评\\n[01:27] 当然有点尖锐\\n[01:27] 男主属于是既要0元购又想免费退 占完便宜还想跑\\n[01:33] 就发现自己又跑不掉了 就开始害怕了\\n[01:35] 可是正当他要付出代价的时候 他又舍不得了”\\n[01:38] 这个就很像是感情里的某一部分人\\n[01:42] 喜欢漂亮的姑娘 但是又要对方只爱自己\\n[01:45] 喜欢独立的人 但又希望对方能够粘着自己\\n[01:48] 那对方太粘了 又嫌他不给自己空间\\n[01:51] 那对方开始真的有自我了 自信放光芒了 又觉得没有安全感了\\n[01:55] 不少不管男女\\n[01:56] 不少不管是男女\\n[01:57] 这个世界上哪里有这么好的事情\\n[01:59] 你想得到到底是伴侣\\n[02:00] 还是一个既能满足你所有需求\\n[02:02] 又不需要你承担任何代价的\\n[02:04] 人型许愿机？\\n[02:07] 我觉得这部电影它更厉害的地方在于\\n[02:09] 它拍出了一种\\n[02:10] 非常容易被大家忽略的人物类型\\n[02:13] 叫做脆弱型自恋者\\n[02:15] 从人格心理学和临床研究的角度来说\\n[02:18] 自恋存在两种稳定的维度\\n[02:21] 大家都很熟悉\\n[02:23] 也是网上最常看到的那种NPD的类型\\n[02:26] 脆弱型自恋\\n[02:28] 这是一种非常之隐蔽的自恋\\n[02:30] 大家都不太了解\\n[02:32] 像男主贝尔\\n[02:33] 他表面上很害羞\\n[02:34] 很自卑很老实\\n[02:35] 甚至还有一点点可怜\\n[02:36] 你是不是就很容易觉得\\n[02:38] 他是一个不太喜欢表达\\n[02:40] 但是挺善良的一个普通人\\n[02:42] 但如果你仔细看电影\\n[02:44] 你们会发现\\n[02:44] 其实这个不是单纯的内向\\n[02:46] 更不是什么温柔\\n[02:47] 他是那种“无色无味的剧毒老实人”\\n[02:50] 他的自恋不是那种高高在上\\n[02:52] 夸夸其谈的自恋\\n[02:54] 而是一种隐藏在不行动不付出\\n[02:54] 而是一种藏在不行动不付出\\n[02:56] 不表态和退缩背后的自恋\\n[02:59] 你就看他向心愿柳留许的愿望是什么嘛\\n[03:02] 不是那种请给我勇气去表白吧\\n[03:05] 也不是请让我有机会了解我的女神吧\\n[03:08] 而是直接要求让Nikki爱上我\\n[03:11] 胜过爱世界上任何一个人\\n[03:13] 你们细品\\n[03:14] 就这个愿望\\n[03:16] 它的背后就说明了\\n[03:16] 他其实想要的\\n[03:17] 根本就不是一段真实的关系\\n[03:19] 或者说这个人他对关系就是有一种错误的理解\\n[03:21] 他要的是一种究极的排他\\n[03:23] 是一种绝对的优先\\n[03:25] 是一种无条件围绕他运转\\n[03:27] 但又不提要求的爱\\n[03:29] 但真正的爱是这样吗\\n[03:30] 不是的\\n[03:32] 真正的爱应该是是我走向你\\n[03:33] 我了解你\\n[03:35] 我知道你的喜好\\n[03:36] 我付出一些爱的行为\\n[03:38] 然后我尊重你的选择\\n[03:39] 而这个男主的爱是跳过了了解\\n[03:41] 追求甚至是对方的意愿\\n[03:43] 直接让对方变成了自己的所有物\\n[03:45] 而且是独一无二的\\n[03:46] 这就根本就不是爱\\n[03:47] 这个是恐怖片\\n[03:49] 因为他关注的始终是她为什么不爱我\\n[03:51] 我怎么样才能得到她\\n[03:52] 而不是她真正需要什么\\n[03:54] 她的梦想是什么\\n[03:55] 她喜欢什么\\n[03:56] 以及她愿不愿意\\n[03:57] 而且这个电影\\n[03:58] 还有很多细节都在说明这一点\\n[04:00] 他对他死去的猫是非常冷漠的\\n[04:03] 那个猫咪刚刚离世\\n[04:04] 他就可以出去跟别人吃喝玩乐\\n[04:06] 心里就想着\\n[04:07] 是要不要表白这一类的事情\\n[04:08] 又比如说这个男主\\n[04:09] 他对一直都暗恋他\\n[04:11] 关心他的朋友同事\\n[04:13] 也是那种非常习惯性的\\n[04:15] 接受对方的好意\\n[04:16] 但是却从来没有想过\\n[04:17] 真正付出一点相对等的回应\\n[04:19] 就这种人\\n[04:20] 他真的可能不一定会在现实生活中\\n[04:23] 主动的去伤害你\\n[04:24] 但是这样的人\\n[04:25] 你一旦跟他进入关系\\n[04:27] 他一定一定会索取很多\\n[04:29] 他会索取关注照顾\\n[04:30] 索取情绪价值\\n[04:31] 但他却会很少真正看见别人\\n[04:35] 就是他用不行动来保护自己\\n[04:37] 很多人会觉得\\n[04:38] 脆弱型自恋者是因为自尊太低\\n[04:40] 所以不太敢行动\\n[04:42] 但其实恰恰相反哦\\n[04:44] 他们内心往往有一种非常强烈的自尊\\n[04:46] 但这种自尊\\n[04:47] 他不是强大\\n[04:48] 而是强烈\\n[04:49] 甚至可以说这种自尊他太脆弱了\\n[04:50] 这种自尊\\n[04:51] 他太脆弱了\\n[04:52] 因为他们这种人\\n[04:53] 他们就很害怕被拒绝\\n[04:54] 很害怕失败\\n[04:55] 很害怕现实证明自己没有那么特别\\n[04:57] 所以就干脆不表白了\\n[04:58] 就不努力了\\n[04:59] 因为这样就不承担风险\\n[05:00] 毕竟只要不行动\\n[05:02] 就永远不会被现实检验出所谓的结果\\n[05:05] 当然啊这我一定要强调\\n[05:07] 不要因为一个人内向害羞或者社恐\\n[05:10] 就随随便便给人家贴上一个什么\\n[05:12] 剧毒老好人的标签和NPD的标签\\n[05:15] 没有这回事儿\\n[05:16] 内向和自恋\\n[05:17] 是完完全全的独立存在的两种事情\\n[05:20] 两回事\\n[05:21] 而真正害羞但是又同时善良的人\\n[05:24] 他们一定会\\n[05:25] 看到对方的\\n[05:26] 一定会记得对方说过的话\\n[05:27] 一定会付出关心的行为\\n[05:28] 也会在被拒绝之后\\n[05:30] 下一次想着\\n[05:31] 我应该尊重别人的边界\\n[05:33] 他不会把自己的喜欢\\n[05:35] 当成对方必须回应的义务\\n[05:36] 但是脆弱型自恋者可不一样哦\\n[05:38] 他们不一定是张牙舞爪的\\n[05:40] 甚至他们是内向的\\n[05:42] 害羞的甚至是无害的\\n[05:43] 但是他在关系里\\n[05:45] 一定会持续的表现出\\n[05:46] 那种以自我为中心的情感\\n[05:47] 索取和逃避责任\\n[05:49] 以及躲避后果\\n[05:51] 他想要的不是你\\n[05:52] 而是你证明我值得被爱\\n[05:54] 而这个电影真正恐怖的地方也在这儿\\n[05:56] 当Nikki因为贝尔的许愿被夺舍之后\\n[05:59] 失去自我\\n[06:00] 折磨到已经几乎不成人形的时候\\n[06:03] 她在半夜的时候\\n[06:04] 短暂恢复意识的那几分钟\\n[06:06] 她非常痛苦的哀求着男主贝尔\\n[06:09] 她说你杀了我吧\\n[06:11] 我求求你了\\n[06:12] 你让我解脱吧\\n[06:13] 结果你们知道男主说了句什么吗\\n[06:14] 男主说：和我在一起到底有什么不好\\n[06:18] 我靠就这句话出来\\n[06:20] 我相信电影院一定是一片哗然的\\n[06:23] 因为在那一刻\\n[06:24] 经历了那么多恐怖的事情之后\\n[06:26] 他看到的还是仍然不是对方的痛苦\\n[06:29] 而是自己的委屈\\n[06:30] 她不成人形了\\n[06:32] 她在求救了\\n[06:33] 但这个男生还在想\\n[06:34] 我都给你我的爱了\\n[06:35] 你到底有什么不满意呀\\n[06:36] 你们看\\n[06:37] 这个就是极端自我的人最可怕的地方\\n[06:40] 因为在他们的世界里\\n[06:41] 伴侣不是一个有感受有想法\\n[06:44] 有喜怒哀乐有意志的人\\n[06:45] 而是一个应该满足自己配合自己\\n[06:48] 证明自己的工具角色\\n[06:51] 所以我真的觉得《痴迷》\\n[06:52] 表面上它讲的是一个什么禁忌\\n[06:54] 许愿的一个恐怖故事\\n[06:56] 但其实\\n[06:56] 他讲的是亲密关系里的恐怖故事\\n[06:59] 强制爱别人不会有什么好下场的\\n[07:01] 以及爱一旦只想着满足自己的话\\n[07:04] 就一定伴随着抹杀对方\\n[07:06] 真正健康的爱\\n[07:07] 不是对方完全符合你的期待\\n[07:09] 而是你能看到ta是一个独立的人\\n[07:11] ta有自己的痛苦边界和选择\\n[07:14] 也有不围着你转的权利\\n[07:16] 讲真的这部电影\\n[07:18] 把恐怖喜剧和情感的议题结合的非常好\\n[07:21] 它吓人但又不只是吓人\\n[07:23] 它荒诞但又特别现实\\n[07:25] 我真的希望这样的作品\\n[07:27] 被更多的人看到\\n[07:29] 但是这个人一定是大胆的人\\n[07:30] 如果大家很胆小\\n[07:31] 就不要去看了\\n[07:32] 因为这个电影真的是蛮恐怖的\\n[07:34] 好了今天的分享就到这了\\n[07:35] 我们下期再见啦拜拜","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":8,"chunks_succeeded":8,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T09:09:47.270396+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对对心理学、亲密关系议题感兴趣的人群，以及恐怖电影爱好者或关注情感关系问题的观众。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能希望了解电影《痴迷》的看点，同时理解“脆弱型自恋者”这一隐蔽人格类型，以及如何在亲密关系中识别和应对类似行为。"},"content_structure":{"label":"内容怎么展开","summary":"内容先以个人观影体验引入，接着介绍电影剧情，然后通过影评和心理学概念分析角色行为，最后总结电影主题并给出观影建议。"},"solution":{"label":"给了什么解决办法","summary":"内容未给出明确解决办法，但通过分析脆弱型自恋者的行为模式，提醒观众在亲密关系中注意识别类似特征，并强调健康爱的关系应尊重对方独立性。"},"references":{"label":"值得参考什么","summary":"值得参考电影《痴迷》的剧情设定和影评观点，以及心理学中关于自恋两种维度（显性自恋和脆弱型自恋）的区分。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸制作关于脆弱型自恋者与内向性格的区别、亲密关系中的边界设定、或电影中其他心理学元素的解读等内容。"}},"source_labels":["封面标题","文字标题","作品描述","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"title": "看完痴迷，发现最恐怖的是无色无味老实人？", "metrics": {"likes": "784", "收藏": 349, "点赞": 784, "评论": 75, "collects": "349", "comments": "75"}, "bodyText": "心理学的脆弱型自恋者，望周知～\\n\\n[00:00] 本人是一个恐怖电影爱好者\\n[00:02] 豆瓣的高分恐怖片清单\\n[00:04] 我基本上都刷了一个遍\\n[00:06] 最近\\n[00:07] 在海外有一部爆火的电影叫做《痴迷》\\n[00:09] 刚刚也在内地院线上映了\\n[00:10] 本人已经看完了\\n[00:12] 看完以后真的表示非常的兴奋\\n[00:14] 因为我觉得它不仅吓到我了\\n[00:16] 它也笑到我了\\n[00:17] 甚至有点惊艳到我了\\n[00:19] 我已经准备去电影院再二刷一次了\\n[00:21] 但我想要专门出一期视频\\n[00:23] 不只是因为它好看\\n[00:24] 而是因为\\n[00:25] 我觉得这个题材实在是太特别了\\n[00:27] 它不是那种传统意义上的鬼怪恐怖\\n[00:30] 而是把亲密关系\\n[00:31] 拍成了心理恐怖片的电影\\n[00:34] 可以说是刚好切到了我的内容赛道\\n[00:36] 所以想要先给大家推荐介绍一下剧情\\n[00:39] 男主贝尔是一个非常平凡\\n[00:41] 自卑又对爱情充满执念的一个男青年\\n[00:45] 他呢偶然听说了\\n[00:46] 小镇上有一个关于心愿柳的一个传说\\n[00:49] 是那种把柳条柳枝折断了\\n[00:52] 许个愿然后愿望就能实现\\n[00:54] 他有一天就去商店里面买了买了这个柳条\\n[00:55] 许愿\\n[00:56] 自己暗恋的女孩Nikki能够爱上自己\\n[00:59] OK 愿望成真了\\n[01:00] 两个人真的走到一起了\\n[01:03] 但是很快就发现 被召唤来的真的不是纯粹的爱情\\n[01:06] 而是纯纯的恐怖\\n[01:08] 女主被夺舍了 然后发了疯一样的爱上了男主贝尔\\n[01:12] 占有 控制 几乎惊恐到了变态的程度\\n[01:16] 而这部电影 我觉得它最讽刺的地方就是\\n[01:18] 它在用一种非常之极端的方式 拍出了很多人在亲密关系里面\\n[01:24] 既要 又要 还要\\n[01:25] 我看到一个非常有意思的影评\\n[01:27] 当然有点尖锐\\n[01:27] 男主属于是既要0元购又想免费退 占完便宜还想跑\\n[01:33] 就发现自己又跑不掉了 就开始害怕了\\n[01:35] 可是正当他要付出代价的时候 他又舍不得了”\\n[01:38] 这个就很像是感情里的某一部分人\\n[01:42] 喜欢漂亮的姑娘 但是又要对方只爱自己\\n[01:45] 喜欢独立的人 但又希望对方能够粘着自己\\n[01:48] 那对方太粘了 又嫌他不给自己空间\\n[01:51] 那对方开始真的有自我了 自信放光芒了 又觉得没有安全感了\\n[01:55] 不少不管男女\\n[01:56] 不少不管是男女\\n[01:57] 这个世界上哪里有这么好的事情\\n[01:59] 你想得到到底是伴侣\\n[02:00] 还是一个既能满足你所有需求\\n[02:02] 又不需要你承担任何代价的\\n[02:04] 人型许愿机？\\n[02:07] 我觉得这部电影它更厉害的地方在于\\n[02:09] 它拍出了一种\\n[02:10] 非常容易被大家忽略的人物类型\\n[02:13] 叫做脆弱型自恋者\\n[02:15] 从人格心理学和临床研究的角度来说\\n[02:18] 自恋存在两种稳定的维度\\n[02:21] 大家都很熟悉\\n[02:23] 也是网上最常看到的那种NPD的类型\\n[02:26] 脆弱型自恋\\n[02:28] 这是一种非常之隐蔽的自恋\\n[02:30] 大家都不太了解\\n[02:32] 像男主贝尔\\n[02:33] 他表面上很害羞\\n[02:34] 很自卑很老实\\n[02:35] 甚至还有一点点可怜\\n[02:36] 你是不是就很容易觉得\\n[02:38] 他是一个不太喜欢表达\\n[02:40] 但是挺善良的一个普通人\\n[02:42] 但如果你仔细看电影\\n[02:44] 你们会发现\\n[02:44] 其实这个不是单纯的内向\\n[02:46] 更不是什么温柔\\n[02:47] 他是那种“无色无味的剧毒老实人”\\n[02:50] 他的自恋不是那种高高在上\\n[02:52] 夸夸其谈的自恋\\n[02:54] 而是一种隐藏在不行动不付出\\n[02:54] 而是一种藏在不行动不付出\\n[02:56] 不表态和退缩背后的自恋\\n[02:59] 你就看他向心愿柳留许的愿望是什么嘛\\n[03:02] 不是那种请给我勇气去表白吧\\n[03:05] 也不是请让我有机会了解我的女神吧\\n[03:08] 而是直接要求让Nikki爱上我\\n[03:11] 胜过爱世界上任何一个人\\n[03:13] 你们细品\\n[03:14] 就这个愿望\\n[03:16] 它的背后就说明了\\n[03:16] 他其实想要的\\n[03:17] 根本就不是一段真实的关系\\n[03:19] 或者说这个人他对关系就是有一种错误的理解\\n[03:21] 他要的是一种究极的排他\\n[03:23] 是一种绝对的优先\\n[03:25] 是一种无条件围绕他运转\\n[03:27] 但又不提要求的爱\\n[03:29] 但真正的爱是这样吗\\n[03:30] 不是的\\n[03:32] 真正的爱应该是是我走向你\\n[03:33] 我了解你\\n[03:35] 我知道你的喜好\\n[03:36] 我付出一些爱的行为\\n[03:38] 然后我尊重你的选择\\n[03:39] 而这个男主的爱是跳过了了解\\n[03:41] 追求甚至是对方的意愿\\n[03:43] 直接让对方变成了自己的所有物\\n[03:45] 而且是独一无二的\\n[03:46] 这就根本就不是爱\\n[03:47] 这个是恐怖片\\n[03:49] 因为他关注的始终是她为什么不爱我\\n[03:51] 我怎么样才能得到她\\n[03:52] 而不是她真正需要什么\\n[03:54] 她的梦想是什么\\n[03:55] 她喜欢什么\\n[03:56] 以及她愿不愿意\\n[03:57] 而且这个电影\\n[03:58] 还有很多细节都在说明这一点\\n[04:00] 他对他死去的猫是非常冷漠的\\n[04:03] 那个猫咪刚刚离世\\n[04:04] 他就可以出去跟别人吃喝玩乐\\n[04:06] 心里就想着\\n[04:07] 是要不要表白这一类的事情\\n[04:08] 又比如说这个男主\\n[04:09] 他对一直都暗恋他\\n[04:11] 关心他的朋友同事\\n[04:13] 也是那种非常习惯性的\\n[04:15] 接受对方的好意\\n[04:16] 但是却从来没有想过\\n[04:17] 真正付出一点相对等的回应\\n[04:19] 就这种人\\n[04:20] 他真的可能不一定会在现实生活中\\n[04:23] 主动的去伤害你\\n[04:24] 但是这样的人\\n[04:25] 你一旦跟他进入关系\\n[04:27] 他一定一定会索取很多\\n[04:29] 他会索取关注照顾\\n[04:30] 索取情绪价值\\n[04:31] 但他却会很少真正看见别人\\n[04:35] 就是他用不行动来保护自己\\n[04:37] 很多人会觉得\\n[04:38] 脆弱型自恋者是因为自尊太低\\n[04:40] 所以不太敢行动\\n[04:42] 但其实恰恰相反哦\\n[04:44] 他们内心往往有一种非常强烈的自尊\\n[04:46] 但这种自尊\\n[04:47] 他不是强大\\n[04:48] 而是强烈\\n[04:49] 甚至可以说这种自尊他太脆弱了\\n[04:50] 这种自尊\\n[04:51] 他太脆弱了\\n[04:52] 因为他们这种人\\n[04:53] 他们就很害怕被拒绝\\n[04:54] 很害怕失败\\n[04:55] 很害怕现实证明自己没有那么特别\\n[04:57] 所以就干脆不表白了\\n[04:58] 就不努力了\\n[04:59] 因为这样就不承担风险\\n[05:00] 毕竟只要不行动\\n[05:02] 就永远不会被现实检验出所谓的结果\\n[05:05] 当然啊这我一定要强调\\n[05:07] 不要因为一个人内向害羞或者社恐\\n[05:10] 就随随便便给人家贴上一个什么\\n[05:12] 剧毒老好人的标签和NPD的标签\\n[05:15] 没有这回事儿\\n[05:16] 内向和自恋\\n[05:17] 是完完全全的独立存在的两种事情\\n[05:20] 两回事\\n[05:21] 而真正害羞但是又同时善良的人\\n[05:24] 他们一定会\\n[05:25] 看到对方的\\n[05:26] 一定会记得对方说过的话\\n[05:27] 一定会付出关心的行为\\n[05:28] 也会在被拒绝之后\\n[05:30] 下一次想着\\n[05:31] 我应该尊重别人的边界\\n[05:33] 他不会把自己的喜欢\\n[05:35] 当成对方必须回应的义务\\n[05:36] 但是脆弱型自恋者可不一样哦\\n[05:38] 他们不一定是张牙舞爪的\\n[05:40] 甚至他们是内向的\\n[05:42] 害羞的甚至是无害的\\n[05:43] 但是他在关系里\\n[05:45] 一定会持续的表现出\\n[05:46] 那种以自我为中心的情感\\n[05:47] 索取和逃避责任\\n[05:49] 以及躲避后果\\n[05:51] 他想要的不是你\\n[05:52] 而是你证明我值得被爱\\n[05:54] 而这个电影真正恐怖的地方也在这儿\\n[05:56] 当Nikki因为贝尔的许愿被夺舍之后\\n[05:59] 失去自我\\n[06:00] 折磨到已经几乎不成人形的时候\\n[06:03] 她在半夜的时候\\n[06:04] 短暂恢复意识的那几分钟\\n[06:06] 她非常痛苦的哀求着男主贝尔\\n[06:09] 她说你杀了我吧\\n[06:11] 我求求你了\\n[06:12] 你让我解脱吧\\n[06:13] 结果你们知道男主说了句什么吗\\n[06:14] 男主说：和我在一起到底有什么不好\\n[06:18] 我靠就这句话出来\\n[06:20] 我相信电影院一定是一片哗然的\\n[06:23] 因为在那一刻\\n[06:24] 经历了那么多恐怖的事情之后\\n[06:26] 他看到的还是仍然不是对方的痛苦\\n[06:29] 而是自己的委屈\\n[06:30] 她不成人形了\\n[06:32] 她在求救了\\n[06:33] 但这个男生还在想\\n[06:34] 我都给你我的爱了\\n[06:35] 你到底有什么不满意呀\\n[06:36] 你们看\\n[06:37] 这个就是极端自我的人最可怕的地方\\n[06:40] 因为在他们的世界里\\n[06:41] 伴侣不是一个有感受有想法\\n[06:44] 有喜怒哀乐有意志的人\\n[06:45] 而是一个应该满足自己配合自己\\n[06:48] 证明自己的工具角色\\n[06:51] 所以我真的觉得《痴迷》\\n[06:52] 表面上它讲的是一个什么禁忌\\n[06:54] 许愿的一个恐怖故事\\n[06:56] 但其实\\n[06:56] 他讲的是亲密关系里的恐怖故事\\n[06:59] 强制爱别人不会有什么好下场的\\n[07:01] 以及爱一旦只想着满足自己的话\\n[07:04] 就一定伴随着抹杀对方\\n[07:06] 真正健康的爱\\n[07:07] 不是对方完全符合你的期待\\n[07:09] 而是你能看到ta是一个独立的人\\n[07:11] ta有自己的痛苦边界和选择\\n[07:14] 也有不围着你转的权利\\n[07:16] 讲真的这部电影\\n[07:18] 把恐怖喜剧和情感的议题结合的非常好\\n[07:21] 它吓人但又不只是吓人\\n[07:23] 它荒诞但又特别现实\\n[07:25] 我真的希望这样的作品\\n[07:27] 被更多的人看到\\n[07:29] 但是这个人一定是大胆的人\\n[07:30] 如果大家很胆小\\n[07:31] 就不要去看了\\n[07:32] 因为这个电影真的是蛮恐怖的\\n[07:34] 好了今天的分享就到这了\\n[07:35] 我们下期再见啦拜拜", "platform": "xiaohongshu", "sourceUrl": "https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&apptime=1787556009&author_share=1&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&xhsshare=CopyLink", "accountName": "治愈果（kakki在说啥）", "contentType": "video", "publishedAt": null, "accountHandle": "治愈果（kakki在说啥）", "platformContentId": "6a6f4013000000000502a398"}	249beac33a2b4bbedd24fb1010fbc12125f75d973fcb9182889b895855ab4411	75	{published_at,media}	\N	2026-08-29 15:29:57.822288+00
3	3	legacy-work-analysis:210:2026-08-26T02:41:06.946Z	legacy	2026-08-26 02:41:06+00	https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?xhsshare=pc_web	{"schema_version":16,"task_id":"d2f5523e8cea","source_url":"https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608260939/c36fab8c27ae14e7af0222b3bf998101/spectrum/1040g0k03249p4lb30m005oq615kmbrh48v6a3ng!nd_dft_wlteh_jpg_3","duration_seconds":114.15,"width":2160,"height":3840,"size_bytes":14422477,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_source":"platform_video_cover","cover_image_url":"http://sns-webpic-qc.xhscdn.com/202608260939/0878ef20126e158d0afc06c554fbbd9d/spectrum/1040g0k03249p4lb30m005oq615kmbrh48v6a3ng!nd_dft_wlteh_webp_3","cover_image_b64":"（已落地为本地封面文件，原始 189183 字符）","cover_image_width":1080,"cover_image_height":1441,"cover_image_size_bytes":141868}},"title":"双视角曝光，大家看看我有念稿感吗","description":"","cover_title":"两招去掉念稿感","cover_title_meta":{"text":"两招去掉念稿感","confidence":0.994,"font_ratio":1.3,"line_count":2,"lines":[{"text":"两招去掉","confidence":0.999},{"text":"念稿感","confidence":0.989}],"source_image_index":1,"source":"platform_video_cover"},"post_title":"双视角曝光，大家看看我有念稿感吗","post_description":"","display_title":"两招去掉念稿感","author":"北电超然","account":{"name":"北电超然","profile_url":"https://www.xiaohongshu.com/user/profile/63460969000000001901ee24","bio":"北京电影学院| 于超然（百度百科）\\n🎓14年表演教学与镜头训练经验\\n🎬第33届金鸡电影节最佳影片奖表演指导\\n帮老板用“微剧情”把内容做出差异化\\n让观众愿意看完，也愿意买单！","following_count":"1","follower_count":"2982","likes_and_collections_count":"11998"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"161","collects":"205","comments":"7"},"topics":["表现力","口播","念稿感","老板拍短视频","创始人ip"],"video_text":"[00:00] 脚本写的再好\\n[00:01] 你念稿感这个事你不解决\\n[00:03] 你的视频就是没流量\\n[00:05] OK这个是我的第二视角\\n[00:07] 右边是提词器\\n[00:08] 左边是摄影机\\n[00:09] 那我问你\\n[00:10] 现在你会觉得我有念稿感吗\\n[00:12] ok 那今天\\n[00:13] 我给大家分享\\n[00:14] 两个北电训练的方法\\n[00:16] 教你们如何去\\n[00:17] 去掉这该死的念稿感\\n[00:19] 说话的语速\\n[00:20] 你不能太均匀了\\n[00:22] 如果你每一句话\\n[00:23] 都用一样的语气\\n[00:24] 一样的节奏力度\\n[00:26] 那观众听你讲话\\n[00:27] 就好比是机器人一样\\n[00:29] 真正自然的表达\\n[00:31] 绝对不是每一句话都是一个调\\n[00:33] 它一定是有的地方是重的\\n[00:35] 有的地方是轻的\\n[00:36] 「哎说到这」\\n[00:38] 「我突然想起了一件事」\\n[00:40] 你看我刚刚的表达\\n[00:41] 是不是卡一下子\\n[00:42] 结巴一下都是没有问题的\\n[00:44] 这个就会显得很自然\\n[00:45] 很有活人感\\n[00:46] 节奏上你不能乱停顿\\n[00:48] 有的人说话习惯性的很快\\n[00:50] 有的人会刻意的又说的很慢\\n[00:53] 但是停顿的意义\\n[00:54] 是为了让重点被听进去啊\\n[00:57] 你不能为了停而停啊","video_text_meta":{"status":"partial","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":2,"chunks_succeeded":1,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":"第 2 段：Moxus 请求失败（HTTP 503）：The requested model is temporarily unavailable."},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"message":"BrowserType.launch: Executable doesn't exist at C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\ms-playwright\\\\chromium_headless_shell-1234\\\\chrome-headless-shell-win64\\\\chrome-headless-shell.ex"},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-26T01:40:33.390844+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条视频主要讲如何通过两个训练方法去除视频拍摄中的念稿感，提升表达的自然度。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对需要拍摄口播视频、担心念稿感影响流量和观众感受的内容创作者。"},"user_need":{"label":"用户主要问题或需求","summary":"用户主要问题是视频表达有念稿感，导致不自然、缺乏吸引力，可能影响流量。"},"content_structure":{"label":"内容怎么展开","summary":"内容先提出问题（念稿感影响流量），再展示自身双视角作为例子，然后介绍两个训练方法，最后具体说明方法要点。"},"solution":{"label":"给了什么解决办法","summary":"提供了两个方法：一是控制语速，避免每句话语气、节奏、力度均匀；二是合理停顿，停顿是为了让重点被听进去，而不是为了停而停。"},"references":{"label":"值得参考什么","summary":"值得参考的是双视角展示（提词器与摄影机同时呈现）以及北电训练方法的实际演示。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做更多关于口播表达技巧的内容，如不同场景下的语速控制、停顿练习示范，或对比有念稿感和无念稿感的案例。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"title": "双视角曝光，大家看看我有念稿感吗", "metrics": {"likes": "161", "收藏": 205, "点赞": 161, "评论": 7, "collects": "205", "comments": "7"}, "bodyText": "[00:00] 脚本写的再好\\n[00:01] 你念稿感这个事你不解决\\n[00:03] 你的视频就是没流量\\n[00:05] OK这个是我的第二视角\\n[00:07] 右边是提词器\\n[00:08] 左边是摄影机\\n[00:09] 那我问你\\n[00:10] 现在你会觉得我有念稿感吗\\n[00:12] ok 那今天\\n[00:13] 我给大家分享\\n[00:14] 两个北电训练的方法\\n[00:16] 教你们如何去\\n[00:17] 去掉这该死的念稿感\\n[00:19] 说话的语速\\n[00:20] 你不能太均匀了\\n[00:22] 如果你每一句话\\n[00:23] 都用一样的语气\\n[00:24] 一样的节奏力度\\n[00:26] 那观众听你讲话\\n[00:27] 就好比是机器人一样\\n[00:29] 真正自然的表达\\n[00:31] 绝对不是每一句话都是一个调\\n[00:33] 它一定是有的地方是重的\\n[00:35] 有的地方是轻的\\n[00:36] 「哎说到这」\\n[00:38] 「我突然想起了一件事」\\n[00:40] 你看我刚刚的表达\\n[00:41] 是不是卡一下子\\n[00:42] 结巴一下都是没有问题的\\n[00:44] 这个就会显得很自然\\n[00:45] 很有活人感\\n[00:46] 节奏上你不能乱停顿\\n[00:48] 有的人说话习惯性的很快\\n[00:50] 有的人会刻意的又说的很慢\\n[00:53] 但是停顿的意义\\n[00:54] 是为了让重点被听进去啊\\n[00:57] 你不能为了停而停啊", "platform": "xiaohongshu", "sourceUrl": "https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?xhsshare=pc_web", "accountName": "北电超然", "contentType": "video", "publishedAt": null, "accountHandle": "北电超然", "platformContentId": "6a8d06aa000000000f01f94b"}	8c374d3b2740b6c8b028cc602bf4d078acea508779e51123ffc71db72e1b2f7c	75	{published_at,media}	\N	2026-08-29 15:29:57.849008+00
4	4	legacy-work-analysis:212:2026-08-26T02:41:56.335Z	legacy	2026-08-26 02:41:56+00	https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?xhsshare=pc_web	{"schema_version":16,"task_id":"3cd91f3b313c","source_url":"https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?source=webshare&xhsshare=pc_web&xsec_token=CBscI7y1gpeKhCHBWx4bfUg27s_Z2SodspTbBoMYTNOmc=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"借力高级心法","description":"不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种\\"全流程掌控\\"的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是\\"学\\"。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信\\"速成\\"可以等同于\\"掌握\\"，觉得知识必须经过自己漫长的消化才算是自己的，这是对\\"自我完整性\\"的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对\\"自我边界\\"的认知出了偏差。叫\\"我执\\"。 你把\\"我\\"画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把\\"我\\"看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲\\"君子生非异也，善假于物也\\"，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是\\"谁能比我更快更好地做成这件事\\"。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲\\"真空生妙有\\"，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的\\"空\\"就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个\\"妙有\\"——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从\\"我需要帮助\\"这个角度去看，开口就是示弱就是亏欠，你从\\"我在调动资源\\"这个角度去看。 这是借力的最高级心法 你以为的借力还是\\"我缺什么，我去拿\\"，但实际上而\\"让更有价值的人做更有价值的事，\\"利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜\\"我不欠任何人\\"，其实就是和任何人都没有关系。","cover_title":"不会借力是一种隐蔽的自恋","cover_title_meta":{"text":"不会借力是一种隐蔽的自恋","confidence":0.999,"font_ratio":1.45,"line_count":2,"lines":[{"text":"不会借力是一种","confidence":0.999},{"text":"隐蔽的自恋","confidence":0.999}],"source_image_index":1},"post_title":"借力高级心法","post_description":"不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种\\"全流程掌控\\"的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是\\"学\\"。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信\\"速成\\"可以等同于\\"掌握\\"，觉得知识必须经过自己漫长的消化才算是自己的，这是对\\"自我完整性\\"的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对\\"自我边界\\"的认知出了偏差。叫\\"我执\\"。 你把\\"我\\"画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把\\"我\\"看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲\\"君子生非异也，善假于物也\\"，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是\\"谁能比我更快更好地做成这件事\\"。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲\\"真空生妙有\\"，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的\\"空\\"就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个\\"妙有\\"——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从\\"我需要帮助\\"这个角度去看，开口就是示弱就是亏欠，你从\\"我在调动资源\\"这个角度去看。 这是借力的最高级心法 你以为的借力还是\\"我缺什么，我去拿\\"，但实际上而\\"让更有价值的人做更有价值的事，\\"利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜\\"我不欠任何人\\"，其实就是和任何人都没有关系。","display_title":"不会借力是一种隐蔽的自恋","author":"元元子","account":{"name":"元元子","profile_url":"https://www.xiaohongshu.com/user/profile/5592cc0f484fb665b39f939f","bio":"用星星术法和佛道哲学拆解人生\\n前大厂产品/前央企HR/中心协心理咨询师\\n🇬🇧warwick物理本·心理硕·浙大东哲mba在研·\\n地图研究@一个冻儿元 视频版（夸我美就行了","following_count":"3982","follower_count":"2410","likes_and_collections_count":"42845"},"collection_status":{"media":{"status":"not_video","method":"page","message":"未发现视频信号，按图文处理"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 元元子 关注 元元子 关注 借力高级心法 不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种&quot;全流程掌控&quot;的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是&quot;学&quot;。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信&quot;速成&quot;可以等同于&quot;掌握&quot;，觉得知识必须经过自己漫长的消化才算是自己的，这是对&quot;自我完整性&quot;的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对&quot;自我边界&quot;的认知出了偏差。叫&quot;我执&quot;。 你把&quot;我&quot;画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把&quot;我&quot;看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲&quot;君子生非异也，善假于物也&quot;，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是&quot;谁能比我更快更好地做成这件事&quot;。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲&quot;真空生妙有&quot;，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的&quot;空&quot;就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个&quot;妙有&quot;——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从&quot;我需要帮助&quot;这个角度去看，开口就是示弱就是亏欠，你从&quot;我在调动资源&quot;这个角度去看。 这是借力的最高级心法 你以为的借力还是&quot;我缺什么，我去拿&quot;，但实际上而&quot;让更有价值的人做更有价值的事，&quot;利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜&quot;我不欠任何人&quot;，其实就是和任何人都没有关系。 #修行 #女性力量 #心理 #借力 #女性智慧 #高能量 编辑于 07-27 加载中","text_same_as_description":true,"engagement":{"likes":"3814","collects":"2204","comments":"111"},"topics":["修行","女性力量","心理","借力","女性智慧","高能量"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"message":"BrowserType.launch: Executable doesn't exist at C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\ms-playwright\\\\chromium_headless_shell-1234\\\\chrome-headless-shell-win64\\\\chrome-headless-shell.ex"},"images":[{"index":1,"filename":"image_01.webp","text":"(Sun.) 七月二十六日 不会借力是一种 隐蔽的自恋","width":1080,"height":1440,"size_bytes":119878,"source_url":"http://sns-webpic-qc.xhscdn.com/202608260942/6434c7fe51ffe7b9b053841a0de9a7aa/1040g00832333r333721040t7t360v4sv2qr4pp8!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-26T01:42:56.032673+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对那些习惯独自完成所有事情、追求全流程掌控、对'自学'和'自我完整'有偏执的人群，尤其是高认知但可能陷入单一路径成功经验的人。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能面临因过度依赖自身努力而导致的效率低下、精力消耗和人际孤立，需要学会借助外部资源和人脉来提升生命效率。"},"content_structure":{"label":"内容怎么展开","summary":"内容先定义问题（不会借力是自恋和懒惰），再分析心理根源（自我边界偏差、我执、工具性思维差），最后提出借力的高维心法（视角转变和利他共赢）。"},"solution":{"label":"给了什么解决办法","summary":"给出的解决办法是转变借力视角：从'我需要帮助'转为'我在调动资源'，并强调借力是让更有价值的人做更有价值的事，形成利他共赢的结构。"},"references":{"label":"值得参考什么","summary":"值得参考的是内容中引用的古语'君子生非异也，善假于物也'和禅宗'真空生妙有'，以及诸葛亮借东风的比喻，这些用于支撑借力的智慧。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸的内容包括：具体如何识别可借力的资源、如何克服'自我完整'偏执的实操方法、借力在职场或创业中的案例，以及如何建立互惠的人际网络。"}},"source_labels":["封面标题","文字标题","作品描述","图片 OCR","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"title": "借力高级心法", "metrics": {"likes": "3814", "收藏": 2204, "点赞": 3814, "评论": 111, "collects": "2204", "comments": "111"}, "bodyText": "不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种\\"全流程掌控\\"的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是\\"学\\"。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信\\"速成\\"可以等同于\\"掌握\\"，觉得知识必须经过自己漫长的消化才算是自己的，这是对\\"自我完整性\\"的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对\\"自我边界\\"的认知出了偏差。叫\\"我执\\"。 你把\\"我\\"画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把\\"我\\"看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲\\"君子生非异也，善假于物也\\"，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是\\"谁能比我更快更好地做成这件事\\"。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲\\"真空生妙有\\"，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的\\"空\\"就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个\\"妙有\\"——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从\\"我需要帮助\\"这个角度去看，开口就是示弱就是亏欠，你从\\"我在调动资源\\"这个角度去看。 这是借力的最高级心法 你以为的借力还是\\"我缺什么，我去拿\\"，但实际上而\\"让更有价值的人做更有价值的事，\\"利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜\\"我不欠任何人\\"，其实就是和任何人都没有关系。\\n\\n发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 元元子 关注 元元子 关注 借力高级心法 不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种&quot;全流程掌控&quot;的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是&quot;学&quot;。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信&quot;速成&quot;可以等同于&quot;掌握&quot;，觉得知识必须经过自己漫长的消化才算是自己的，这是对&quot;自我完整性&quot;的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对&quot;自我边界&quot;的认知出了偏差。叫&quot;我执&quot;。 你把&quot;我&quot;画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把&quot;我&quot;看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲&quot;君子生非异也，善假于物也&quot;，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是&quot;谁能比我更快更好地做成这件事&quot;。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲&quot;真空生妙有&quot;，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的&quot;空&quot;就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个&quot;妙有&quot;——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从&quot;我需要帮助&quot;这个角度去看，开口就是示弱就是亏欠，你从&quot;我在调动资源&quot;这个角度去看。 这是借力的最高级心法 你以为的借力还是&quot;我缺什么，我去拿&quot;，但实际上而&quot;让更有价值的人做更有价值的事，&quot;利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜&quot;我不欠任何人&quot;，其实就是和任何人都没有关系。 #修行 #女性力量 #心理 #借力 #女性智慧 #高能量 编辑于 07-27 加载中\\n\\n(Sun.) 七月二十六日 不会借力是一种 隐蔽的自恋", "platform": "xiaohongshu", "sourceUrl": "https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?xhsshare=pc_web", "accountName": "元元子", "contentType": "image_post", "publishedAt": null, "accountHandle": "元元子", "platformContentId": "6a65d3eb0000000011016998"}	65b55987dd5e9c08e453a9847a727fd9a226b9b26b7c97789bfb28693026a60e	90	{published_at}	\N	2026-08-29 15:29:57.870931+00
5	5	legacy-work-analysis:213:2026-08-26T02:42:03.263Z	legacy	2026-08-26 02:42:03+00	https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?xhsshare=pc_web	{"schema_version":16,"task_id":"9268a700b2c3","source_url":"https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"NPD有一个藏不住的语言习惯","description":"","cover_title":"NPD有一个藏不住的语言习惯","cover_title_meta":{"text":"NPD有一个藏不住的语言习惯","confidence":0.995,"font_ratio":2.76,"line_count":3,"lines":[{"text":"NPD有一个","confidence":0.999},{"text":"藏不住","confidence":0.997},{"text":"的语言习惯","confidence":0.989}],"source_image_index":1},"post_title":"NPD有一个藏不住的语言习惯","post_description":"","display_title":"NPD有一个藏不住的语言习惯","author":"枕书凉.","account":{"name":"枕书凉.","profile_url":"https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01","bio":"8️⃣年心理研究专家\\n擅长分析情感困惑，带你理性恋爱\\n🉑  1v1文字or语音☎️ （非公益）咨-询\\n亲密关系/自我提升/关系修复","following_count":"0","follower_count":"229","likes_and_collections_count":"9877"},"collection_status":{"media":{"status":"not_video","method":"page","message":"未发现视频信号，按图文处理"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 枕书凉. 关注 1/8 枕书凉. 关注 NPD有一个藏不住的语言习惯 #我重新相信相亲角了 #贵族 #npd #光子嫩肤 #股票 #高尔夫 #留学生 #这个夏天造点啥 08-01 湖北 加载中","text_same_as_description":false,"engagement":{"likes":"1295","collects":"951","comments":"286"},"topics":["我重新相信相亲角了","贵族","npd","光子嫩肤","股票","高尔夫","留学生","这个夏天造点啥"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[{"id":"6a72cbc6000000002901b106","type":"reply","author":"momo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/645b7f257b3e7e60e53504de.jpg?imageView2/2/w/120/format/jpg","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"created_at":1785908166000,"reply_count":0,"parent_comment_id":"6a721851000000002a02fe66","reply_to_author":"Momooo","parent_excerpt":"Npd绝对不会轻易夸人"},{"id":"6a6f0f5800000000150176b2","type":"comment","author":"水枪装尿呲谁谁叫","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31gureq033s005n0nfs3hap3732d8ot8?imageView2/2/w/120/format/jpg","text":"正常人：你这个不会？\\nnpd：你连这个都不会？","like_count":120,"created_at":1785663321000,"reply_count":16,"parent_comment_id":"","reply_to_author":""},{"id":"6a721851000000002a02fe66","type":"comment","author":"Momooo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31spc96te5s6g5q955grsl8jntuvp62o?imageView2/2/w/120/format/jpg","text":"Npd绝对不会轻易夸人","like_count":68,"created_at":1785862226000,"reply_count":29,"parent_comment_id":"","reply_to_author":""},{"id":"6a70d570000000000403afdf","type":"comment","author":"夏熙cc惜夏","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/635fa744a38044a4446559d9.jpg?imageView2/2/w/120/format/jpg","text":"你说：今天天气好热啊！\\n对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"created_at":1785779568000,"reply_count":10,"parent_comment_id":"","reply_to_author":""},{"id":"6a6eb60c0000000015015722","type":"comment","author":"Leo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/5fd23174f18f4f0001f720d1.jpg?imageView2/2/w/120/format/jpg","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"created_at":1785640460000,"reply_count":1,"parent_comment_id":"","reply_to_author":""}],"comment_summary":{"threshold":20,"limit":5,"returned":5,"scanned":112,"replies_scanned":82,"primary_pages":3,"reply_pages":19,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.92,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":true,"stable_pages":6},"images":[{"index":1,"filename":"image_01.webp","text":"NAME You are everything tome,and Iwas so blessed whenGodsentyouhereforme. --枕书凉-- NPD有一个 藏不住 的语言习惯 今天教你们一个识破NPD的绝招：不用看 他对你多好，不用听他表白的多甜，就看 他怎么说话。 我研究了上千个NPD案例，发现他们有一 个藏不住的语言习惯，就是他们永远不会 用关心的方式开启对话，只会用审判的方 式质问。","width":1080,"height":1440,"size_bytes":104984,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/6a7aeea1b7740c5c1abd2a78eb83996d/1040g0083239t0slnna5g5qhfo5o4030119ucv38!nd_dft_wlteh_webp_3"},{"index":2,"filename":"image_02.webp","text":"001@枕书凉 我给你举个例子，你就懂了。 正常人想知道你起床了没，会问：“你起床 了吗？”你吃饭了吗？” 这是开放式的关心，答案可以是yes，也可 以是n0 。 但NPD会怎么问？“你已经起来了？”“你已 经吃完了？” 发现没有？他们的提问里，根本没有“no” 这个选项。","width":1080,"height":1440,"size_bytes":82466,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/6d0d5a2877f8486ccb098f90060dcc95/1040g0083239t0slnna3g5qhfo5o40301um8viv0!nd_dft_wlteh_webp_3"},{"index":3,"filename":"image_03.webp","text":"002@枕书凉 他们问的不是你的状态，而是在确认一个 预设：“你必须已经起来了。你必须已经吃 完了。你必须满足我的期待。” 02这背后藏着一个可怕的思维模式： 正常人提问，是想了解对方；NPD提问, 是想控制结果。 他们接受不了拒绝，接受不了不符合预 期。因为在他们的世界里，“你不顺从\\"=“你 攻击我”。 那当你说“没有，我还没起”的时候，会发生 什么？","width":1080,"height":1440,"size_bytes":113990,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/e78e6af7243631fec57f023e89e6efdf/1040g0083239t0slnna4g5qhfo5o40301cs5j4so!nd_dft_wlteh_webp_3"},{"index":4,"filename":"image_04.webp","text":"003@枕书凉 低阶NPD当场破防：甩脸色、冷暴力、直 接骂你，“你什么毛病？都几点了还不起？” 高阶NPD更阴： 嘴上说着“没事没事，你睡吧”，但你明显能 感觉到气氛不对了。然后接下来，他会想 方设法解决你这个“拒绝”： 你没起床？他就在旁边制造噪音，让你睡 不着。 你拒绝他的观点？他就疯狂给你发视频、 发文章，直到你认可为止。","width":1080,"height":1440,"size_bytes":109634,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/cc37823e20c95fc11e8d80f31061cc66/1040g0083239t0slnna205qhfo5o40301940r130!nd_dft_wlteh_webp_3"},{"index":5,"filename":"image_05.webp","text":"004@枕书凉 你不想做的事？他会用各种方式让你觉得 “不做就是你的错”。 为什么？ 因为他们无法接受身边有任何人和自己不 一样。承认你的不同，意味着他的世界观 被挑战了；允许你拒绝，意味着他的自恋 受损了。 这就是为什么，正常人会内耗、会反思， NPD完全不会。 03正常人遇到不同意见，会想：是不是我 错了？是不是可以求同存异？","width":1080,"height":1440,"size_bytes":107596,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/bb275155b69af9d7285f35f5fa079c6c/1040g0083239t0slnna105qhfo5o40301lr6vm5o!nd_dft_wlteh_webp_3"},{"index":6,"filename":"image_06.webp","text":"005@枕书凉 但NPD的脑子里只有一种程序：“你不听我 的，就是攻击我；你攻击我，我就必须消 灭你。” 他们的世界里，没有容纳，没有理解。承 认别人，等于否定自己。所以他们只能不 停地赢、不停地控制、不停地消灭所有“不 一样”。 这也是为什么，你会觉得NPD目的性特别 强，执行力特别强。 为了让你顺从他，他可以无所不用其极; 为了让你认错，他可以跟你耗三天三夜。 但你发现没有？","width":1080,"height":1440,"size_bytes":121262,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/62f32ceae6a2262fc8899b6147c57d38/1040g0083239t0slnna2g5qhfo5o403019knafm0!nd_dft_wlteh_webp_3"},{"index":7,"filename":"image_07.webp","text":"006@枕书凉 他们的目的，从来不是为了真正解决问 题，也不是为了让自己变得更好，只是为 了满足那个“我赢了”的感觉。 所以你会看到一种奇观：NPD十年如一日 地愚蠢，十年如一日地原地踏步。他们用 尽所有力气去控制别人，却没有一分力气 用来成长自己。 为什么？因为他们的能量，全部用来维持 自恋了，没有余力，去拓展世界观。 我是枕书凉，一个从回避型成长为安全型 的心理咨询师，从事回避型依恋，婚姻关 系，感情修复等咨询已有8年。让你们更懂 回避型，如果你们遇到感情问题，希望能 帮到你们","width":1080,"height":1440,"size_bytes":153898,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/0ffa45d6dca3f06d8e97f372e1e2b415/1040g0083239t0slnna405qhfo5o403016pfpukg!nd_dft_wlteh_webp_3"},{"index":8,"filename":"image_08.webp","text":"007@枕书凉 如果你们的感情出现了以下几种情况，都 还有机会可以重归于好; 第一种：分开之后没有删除拉黑你，但 是态度很冷漠；写A 第二种：分开之后正常跟你聊天，但是 不愿意提及复合；写B 第三种：分开之后删除拉黑你，不愿沟 通态度决绝；写C 第四种：在一起经常吵架，或者对方经 常断联消失，消息电话不回。写D 有以上情况可以找我给你看看，我来帮你 从根本上解决你们的相处问题。","width":1080,"height":1440,"size_bytes":129020,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/ce2d8173e2de32ba1af6c0189c73b7b1/1040g0083239t0slnna505qhfo5o40301nse5ft8!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"ok","model":"deepseek-v4-flash","generated_at":"2026-08-26T02:39:59.564042+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要讲如何通过语言习惯识别自恋型人格障碍（NPD），并对比正常人与NPD在提问方式上的差异。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对在感情关系中遇到沟通困扰、怀疑对方有NPD倾向的人群，尤其是经历过分手或冲突的个体。"},"user_need":{"label":"用户主要问题或需求","summary":"用户需要识别伴侣是否具有NPD特征，理解其行为背后的原因，并寻求关系修复或应对方法。"},"content_structure":{"label":"内容怎么展开","summary":"内容先提出识别NPD的绝招，然后举例对比正常人与NPD的提问方式，分析NPD的思维模式，最后介绍咨询师身份并引导互动。"},"solution":{"label":"给了什么解决办法","summary":"内容给出的解决办法是观察对方的提问方式，识别NPD特征，并建议在感情出现特定问题时寻求作者咨询。"},"references":{"label":"值得参考什么","summary":"值得参考的是对NPD语言习惯的具体描述和例子，以及作者自称心理咨询师的专业背景。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做NPD其他行为特征的分析、如何与NPD沟通的实操技巧、或针对不同感情状况的应对策略。"}},"source_labels":["封面标题","文字标题","图片 OCR","公开互动数据"]},"comments":{"status":"ok","message":"","sample_size":5,"items":{"main_questions":{"label":"大家主要在问什么","summary":"大家主要在讨论NPD（自恋型人格障碍）的典型言行模式，包括其夸赞方式、否定倾向和对话控制行为。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},"high_frequency_needs":{"label":"高频需求","summary":"高频需求是识别NPD的言行特征，尤其是其否定性回应和隐性贬低模式。","evidence_comments":[{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]},"worries":{"label":"最担心什么","summary":"最担心NPD的隐性攻击性，如表面夸奖实则贬低，以及对话中的否定和操控。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]},"unclear_points":{"label":"博主没讲清什么","summary":"现有样本未形成明确结论。","evidence_comments":[]},"key_comments":{"label":"哪些评论值得重点看","entries":[{"comment":{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},"reason":"高赞评论，直接点出NPD夸赞中的隐性贬低，是用户关注的核心痛点"},{"comment":{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},"reason":"用对比方式生动概括NPD的否定性回应，获得高赞，反映普遍共鸣"},{"comment":{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},"reason":"具体生活化例子，展示NPD如何否定他人感受，便于理解"},{"comment":{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"},"reason":"补充NPD对话中的控制策略，提供行为模式洞察"}]},"topic_extensions":{"label":"可以延伸什么选题","entries":[{"idea":"NPD的隐性贬低：如何识别夸赞中的攻击性","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"}]},{"idea":"NPD与正常人的回应方式对比：日常对话中的警示信号","evidence_comments":[{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"}]},{"idea":"NPD如何否定你的感受：典型场景拆解","evidence_comments":[{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},{"idea":"NPD的对话控制术：如何绕回自己的预期","evidence_comments":[{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]}]}}}}}	{"title": "NPD有一个藏不住的语言习惯", "metrics": {"likes": "1295", "收藏": 951, "点赞": 1295, "评论": 286, "collects": "951", "comments": "286"}, "bodyText": "发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 枕书凉. 关注 1/8 枕书凉. 关注 NPD有一个藏不住的语言习惯 #我重新相信相亲角了 #贵族 #npd #光子嫩肤 #股票 #高尔夫 #留学生 #这个夏天造点啥 08-01 湖北 加载中\\n\\nNAME You are everything tome,and Iwas so blessed whenGodsentyouhereforme. --枕书凉-- NPD有一个 藏不住 的语言习惯 今天教你们一个识破NPD的绝招：不用看 他对你多好，不用听他表白的多甜，就看 他怎么说话。 我研究了上千个NPD案例，发现他们有一 个藏不住的语言习惯，就是他们永远不会 用关心的方式开启对话，只会用审判的方 式质问。\\n\\n001@枕书凉 我给你举个例子，你就懂了。 正常人想知道你起床了没，会问：“你起床 了吗？”你吃饭了吗？” 这是开放式的关心，答案可以是yes，也可 以是n0 。 但NPD会怎么问？“你已经起来了？”“你已 经吃完了？” 发现没有？他们的提问里，根本没有“no” 这个选项。\\n\\n002@枕书凉 他们问的不是你的状态，而是在确认一个 预设：“你必须已经起来了。你必须已经吃 完了。你必须满足我的期待。” 02这背后藏着一个可怕的思维模式： 正常人提问，是想了解对方；NPD提问, 是想控制结果。 他们接受不了拒绝，接受不了不符合预 期。因为在他们的世界里，“你不顺从\\"=“你 攻击我”。 那当你说“没有，我还没起”的时候，会发生 什么？\\n\\n003@枕书凉 低阶NPD当场破防：甩脸色、冷暴力、直 接骂你，“你什么毛病？都几点了还不起？” 高阶NPD更阴： 嘴上说着“没事没事，你睡吧”，但你明显能 感觉到气氛不对了。然后接下来，他会想 方设法解决你这个“拒绝”： 你没起床？他就在旁边制造噪音，让你睡 不着。 你拒绝他的观点？他就疯狂给你发视频、 发文章，直到你认可为止。\\n\\n004@枕书凉 你不想做的事？他会用各种方式让你觉得 “不做就是你的错”。 为什么？ 因为他们无法接受身边有任何人和自己不 一样。承认你的不同，意味着他的世界观 被挑战了；允许你拒绝，意味着他的自恋 受损了。 这就是为什么，正常人会内耗、会反思， NPD完全不会。 03正常人遇到不同意见，会想：是不是我 错了？是不是可以求同存异？\\n\\n005@枕书凉 但NPD的脑子里只有一种程序：“你不听我 的，就是攻击我；你攻击我，我就必须消 灭你。” 他们的世界里，没有容纳，没有理解。承 认别人，等于否定自己。所以他们只能不 停地赢、不停地控制、不停地消灭所有“不 一样”。 这也是为什么，你会觉得NPD目的性特别 强，执行力特别强。 为了让你顺从他，他可以无所不用其极; 为了让你认错，他可以跟你耗三天三夜。 但你发现没有？\\n\\n006@枕书凉 他们的目的，从来不是为了真正解决问 题，也不是为了让自己变得更好，只是为 了满足那个“我赢了”的感觉。 所以你会看到一种奇观：NPD十年如一日 地愚蠢，十年如一日地原地踏步。他们用 尽所有力气去控制别人，却没有一分力气 用来成长自己。 为什么？因为他们的能量，全部用来维持 自恋了，没有余力，去拓展世界观。 我是枕书凉，一个从回避型成长为安全型 的心理咨询师，从事回避型依恋，婚姻关 系，感情修复等咨询已有8年。让你们更懂 回避型，如果你们遇到感情问题，希望能 帮到你们\\n\\n007@枕书凉 如果你们的感情出现了以下几种情况，都 还有机会可以重归于好; 第一种：分开之后没有删除拉黑你，但 是态度很冷漠；写A 第二种：分开之后正常跟你聊天，但是 不愿意提及复合；写B 第三种：分开之后删除拉黑你，不愿沟 通态度决绝；写C 第四种：在一起经常吵架，或者对方经 常断联消失，消息电话不回。写D 有以上情况可以找我给你看看，我来帮你 从根本上解决你们的相处问题。", "platform": "xiaohongshu", "sourceUrl": "https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?xhsshare=pc_web", "accountName": "枕书凉.", "contentType": "image_post", "publishedAt": null, "accountHandle": "枕书凉.", "platformContentId": "6a6e0eb80000000005031f6f"}	7df080a5ab3016313d0ea09e1a3cda24f04304a69e61a39c9dec309e9515214b	90	{published_at}	\N	2026-08-29 15:29:57.89849+00
6	5	legacy-work-analysis:214:2026-08-26T02:41:01.794Z	legacy	2026-08-26 02:41:01+00	https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?xhsshare=pc_web	{"schema_version":16,"task_id":"9268a700b2c3","source_url":"https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"NPD有一个藏不住的语言习惯","description":"","cover_title":"NPD有一个藏不住的语言习惯","cover_title_meta":{"text":"NPD有一个藏不住的语言习惯","confidence":0.995,"font_ratio":2.76,"line_count":3,"lines":[{"text":"NPD有一个","confidence":0.999},{"text":"藏不住","confidence":0.997},{"text":"的语言习惯","confidence":0.989}],"source_image_index":1},"post_title":"NPD有一个藏不住的语言习惯","post_description":"","display_title":"NPD有一个藏不住的语言习惯","author":"枕书凉.","account":{"name":"枕书凉.","profile_url":"https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01","bio":"8️⃣年心理研究专家\\n擅长分析情感困惑，带你理性恋爱\\n🉑  1v1文字or语音☎️ （非公益）咨-询\\n亲密关系/自我提升/关系修复","following_count":"0","follower_count":"229","likes_and_collections_count":"9877"},"collection_status":{"media":{"status":"not_video","method":"page","message":"未发现视频信号，按图文处理"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 枕书凉. 关注 1/8 枕书凉. 关注 NPD有一个藏不住的语言习惯 #我重新相信相亲角了 #贵族 #npd #光子嫩肤 #股票 #高尔夫 #留学生 #这个夏天造点啥 08-01 湖北 加载中","text_same_as_description":false,"engagement":{"likes":"1295","collects":"951","comments":"286"},"topics":["我重新相信相亲角了","贵族","npd","光子嫩肤","股票","高尔夫","留学生","这个夏天造点啥"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[{"id":"6a72cbc6000000002901b106","type":"reply","author":"momo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/645b7f257b3e7e60e53504de.jpg?imageView2/2/w/120/format/jpg","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"created_at":1785908166000,"reply_count":0,"parent_comment_id":"6a721851000000002a02fe66","reply_to_author":"Momooo","parent_excerpt":"Npd绝对不会轻易夸人"},{"id":"6a6f0f5800000000150176b2","type":"comment","author":"水枪装尿呲谁谁叫","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31gureq033s005n0nfs3hap3732d8ot8?imageView2/2/w/120/format/jpg","text":"正常人：你这个不会？\\nnpd：你连这个都不会？","like_count":120,"created_at":1785663321000,"reply_count":16,"parent_comment_id":"","reply_to_author":""},{"id":"6a721851000000002a02fe66","type":"comment","author":"Momooo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31spc96te5s6g5q955grsl8jntuvp62o?imageView2/2/w/120/format/jpg","text":"Npd绝对不会轻易夸人","like_count":68,"created_at":1785862226000,"reply_count":29,"parent_comment_id":"","reply_to_author":""},{"id":"6a70d570000000000403afdf","type":"comment","author":"夏熙cc惜夏","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/635fa744a38044a4446559d9.jpg?imageView2/2/w/120/format/jpg","text":"你说：今天天气好热啊！\\n对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"created_at":1785779568000,"reply_count":10,"parent_comment_id":"","reply_to_author":""},{"id":"6a6eb60c0000000015015722","type":"comment","author":"Leo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/5fd23174f18f4f0001f720d1.jpg?imageView2/2/w/120/format/jpg","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"created_at":1785640460000,"reply_count":1,"parent_comment_id":"","reply_to_author":""}],"comment_summary":{"threshold":20,"limit":5,"returned":5,"scanned":112,"replies_scanned":82,"primary_pages":3,"reply_pages":19,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.92,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":true,"stable_pages":6},"images":[{"index":1,"filename":"image_01.webp","text":"NAME You are everything tome,and Iwas so blessed whenGodsentyouhereforme. --枕书凉-- NPD有一个 藏不住 的语言习惯 今天教你们一个识破NPD的绝招：不用看 他对你多好，不用听他表白的多甜，就看 他怎么说话。 我研究了上千个NPD案例，发现他们有一 个藏不住的语言习惯，就是他们永远不会 用关心的方式开启对话，只会用审判的方 式质问。","width":1080,"height":1440,"size_bytes":104984,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/6a7aeea1b7740c5c1abd2a78eb83996d/1040g0083239t0slnna5g5qhfo5o4030119ucv38!nd_dft_wlteh_webp_3"},{"index":2,"filename":"image_02.webp","text":"001@枕书凉 我给你举个例子，你就懂了。 正常人想知道你起床了没，会问：“你起床 了吗？”你吃饭了吗？” 这是开放式的关心，答案可以是yes，也可 以是n0 。 但NPD会怎么问？“你已经起来了？”“你已 经吃完了？” 发现没有？他们的提问里，根本没有“no” 这个选项。","width":1080,"height":1440,"size_bytes":82466,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/6d0d5a2877f8486ccb098f90060dcc95/1040g0083239t0slnna3g5qhfo5o40301um8viv0!nd_dft_wlteh_webp_3"},{"index":3,"filename":"image_03.webp","text":"002@枕书凉 他们问的不是你的状态，而是在确认一个 预设：“你必须已经起来了。你必须已经吃 完了。你必须满足我的期待。” 02这背后藏着一个可怕的思维模式： 正常人提问，是想了解对方；NPD提问, 是想控制结果。 他们接受不了拒绝，接受不了不符合预 期。因为在他们的世界里，“你不顺从\\"=“你 攻击我”。 那当你说“没有，我还没起”的时候，会发生 什么？","width":1080,"height":1440,"size_bytes":113990,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/e78e6af7243631fec57f023e89e6efdf/1040g0083239t0slnna4g5qhfo5o40301cs5j4so!nd_dft_wlteh_webp_3"},{"index":4,"filename":"image_04.webp","text":"003@枕书凉 低阶NPD当场破防：甩脸色、冷暴力、直 接骂你，“你什么毛病？都几点了还不起？” 高阶NPD更阴： 嘴上说着“没事没事，你睡吧”，但你明显能 感觉到气氛不对了。然后接下来，他会想 方设法解决你这个“拒绝”： 你没起床？他就在旁边制造噪音，让你睡 不着。 你拒绝他的观点？他就疯狂给你发视频、 发文章，直到你认可为止。","width":1080,"height":1440,"size_bytes":109634,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/cc37823e20c95fc11e8d80f31061cc66/1040g0083239t0slnna205qhfo5o40301940r130!nd_dft_wlteh_webp_3"},{"index":5,"filename":"image_05.webp","text":"004@枕书凉 你不想做的事？他会用各种方式让你觉得 “不做就是你的错”。 为什么？ 因为他们无法接受身边有任何人和自己不 一样。承认你的不同，意味着他的世界观 被挑战了；允许你拒绝，意味着他的自恋 受损了。 这就是为什么，正常人会内耗、会反思， NPD完全不会。 03正常人遇到不同意见，会想：是不是我 错了？是不是可以求同存异？","width":1080,"height":1440,"size_bytes":107596,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/bb275155b69af9d7285f35f5fa079c6c/1040g0083239t0slnna105qhfo5o40301lr6vm5o!nd_dft_wlteh_webp_3"},{"index":6,"filename":"image_06.webp","text":"005@枕书凉 但NPD的脑子里只有一种程序：“你不听我 的，就是攻击我；你攻击我，我就必须消 灭你。” 他们的世界里，没有容纳，没有理解。承 认别人，等于否定自己。所以他们只能不 停地赢、不停地控制、不停地消灭所有“不 一样”。 这也是为什么，你会觉得NPD目的性特别 强，执行力特别强。 为了让你顺从他，他可以无所不用其极; 为了让你认错，他可以跟你耗三天三夜。 但你发现没有？","width":1080,"height":1440,"size_bytes":121262,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/62f32ceae6a2262fc8899b6147c57d38/1040g0083239t0slnna2g5qhfo5o403019knafm0!nd_dft_wlteh_webp_3"},{"index":7,"filename":"image_07.webp","text":"006@枕书凉 他们的目的，从来不是为了真正解决问 题，也不是为了让自己变得更好，只是为 了满足那个“我赢了”的感觉。 所以你会看到一种奇观：NPD十年如一日 地愚蠢，十年如一日地原地踏步。他们用 尽所有力气去控制别人，却没有一分力气 用来成长自己。 为什么？因为他们的能量，全部用来维持 自恋了，没有余力，去拓展世界观。 我是枕书凉，一个从回避型成长为安全型 的心理咨询师，从事回避型依恋，婚姻关 系，感情修复等咨询已有8年。让你们更懂 回避型，如果你们遇到感情问题，希望能 帮到你们","width":1080,"height":1440,"size_bytes":153898,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/0ffa45d6dca3f06d8e97f372e1e2b415/1040g0083239t0slnna405qhfo5o403016pfpukg!nd_dft_wlteh_webp_3"},{"index":8,"filename":"image_08.webp","text":"007@枕书凉 如果你们的感情出现了以下几种情况，都 还有机会可以重归于好; 第一种：分开之后没有删除拉黑你，但 是态度很冷漠；写A 第二种：分开之后正常跟你聊天，但是 不愿意提及复合；写B 第三种：分开之后删除拉黑你，不愿沟 通态度决绝；写C 第四种：在一起经常吵架，或者对方经 常断联消失，消息电话不回。写D 有以上情况可以找我给你看看，我来帮你 从根本上解决你们的相处问题。","width":1080,"height":1440,"size_bytes":129020,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/ce2d8173e2de32ba1af6c0189c73b7b1/1040g0083239t0slnna505qhfo5o40301nse5ft8!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"ok","model":"deepseek-v4-flash","generated_at":"2026-08-26T02:39:59.564042+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要讲如何通过语言习惯识别自恋型人格障碍（NPD），并对比正常人与NPD在提问方式上的差异。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对在感情关系中遇到沟通困扰、怀疑对方有NPD倾向的人群，尤其是经历过分手或冲突的个体。"},"user_need":{"label":"用户主要问题或需求","summary":"用户需要识别伴侣是否具有NPD特征，理解其行为背后的原因，并寻求关系修复或应对方法。"},"content_structure":{"label":"内容怎么展开","summary":"内容先提出识别NPD的绝招，然后举例对比正常人与NPD的提问方式，分析NPD的思维模式，最后介绍咨询师身份并引导互动。"},"solution":{"label":"给了什么解决办法","summary":"内容给出的解决办法是观察对方的提问方式，识别NPD特征，并建议在感情出现特定问题时寻求作者咨询。"},"references":{"label":"值得参考什么","summary":"值得参考的是对NPD语言习惯的具体描述和例子，以及作者自称心理咨询师的专业背景。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做NPD其他行为特征的分析、如何与NPD沟通的实操技巧、或针对不同感情状况的应对策略。"}},"source_labels":["封面标题","文字标题","图片 OCR","公开互动数据"]},"comments":{"status":"ok","message":"","sample_size":5,"items":{"main_questions":{"label":"大家主要在问什么","summary":"大家主要在讨论NPD（自恋型人格障碍）的典型言行模式，包括其夸赞方式、否定倾向和对话控制行为。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},"high_frequency_needs":{"label":"高频需求","summary":"高频需求是识别NPD的言行特征，尤其是其否定性回应和隐性贬低模式。","evidence_comments":[{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]},"worries":{"label":"最担心什么","summary":"最担心NPD的隐性攻击性，如表面夸奖实则贬低，以及对话中的否定和操控。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]},"unclear_points":{"label":"博主没讲清什么","summary":"现有样本未形成明确结论。","evidence_comments":[]},"key_comments":{"label":"哪些评论值得重点看","entries":[{"comment":{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},"reason":"高赞评论，直接点出NPD夸赞中的隐性贬低，是用户关注的核心痛点"},{"comment":{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},"reason":"用对比方式生动概括NPD的否定性回应，获得高赞，反映普遍共鸣"},{"comment":{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},"reason":"具体生活化例子，展示NPD如何否定他人感受，便于理解"},{"comment":{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"},"reason":"补充NPD对话中的控制策略，提供行为模式洞察"}]},"topic_extensions":{"label":"可以延伸什么选题","entries":[{"idea":"NPD的隐性贬低：如何识别夸赞中的攻击性","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"}]},{"idea":"NPD与正常人的回应方式对比：日常对话中的警示信号","evidence_comments":[{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"}]},{"idea":"NPD如何否定你的感受：典型场景拆解","evidence_comments":[{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},{"idea":"NPD的对话控制术：如何绕回自己的预期","evidence_comments":[{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]}]}}}}}	{"title": "NPD有一个藏不住的语言习惯", "metrics": {"likes": "1295", "收藏": 951, "点赞": 1295, "评论": 286, "collects": "951", "comments": "286"}, "bodyText": "发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 枕书凉. 关注 1/8 枕书凉. 关注 NPD有一个藏不住的语言习惯 #我重新相信相亲角了 #贵族 #npd #光子嫩肤 #股票 #高尔夫 #留学生 #这个夏天造点啥 08-01 湖北 加载中\\n\\nNAME You are everything tome,and Iwas so blessed whenGodsentyouhereforme. --枕书凉-- NPD有一个 藏不住 的语言习惯 今天教你们一个识破NPD的绝招：不用看 他对你多好，不用听他表白的多甜，就看 他怎么说话。 我研究了上千个NPD案例，发现他们有一 个藏不住的语言习惯，就是他们永远不会 用关心的方式开启对话，只会用审判的方 式质问。\\n\\n001@枕书凉 我给你举个例子，你就懂了。 正常人想知道你起床了没，会问：“你起床 了吗？”你吃饭了吗？” 这是开放式的关心，答案可以是yes，也可 以是n0 。 但NPD会怎么问？“你已经起来了？”“你已 经吃完了？” 发现没有？他们的提问里，根本没有“no” 这个选项。\\n\\n002@枕书凉 他们问的不是你的状态，而是在确认一个 预设：“你必须已经起来了。你必须已经吃 完了。你必须满足我的期待。” 02这背后藏着一个可怕的思维模式： 正常人提问，是想了解对方；NPD提问, 是想控制结果。 他们接受不了拒绝，接受不了不符合预 期。因为在他们的世界里，“你不顺从\\"=“你 攻击我”。 那当你说“没有，我还没起”的时候，会发生 什么？\\n\\n003@枕书凉 低阶NPD当场破防：甩脸色、冷暴力、直 接骂你，“你什么毛病？都几点了还不起？” 高阶NPD更阴： 嘴上说着“没事没事，你睡吧”，但你明显能 感觉到气氛不对了。然后接下来，他会想 方设法解决你这个“拒绝”： 你没起床？他就在旁边制造噪音，让你睡 不着。 你拒绝他的观点？他就疯狂给你发视频、 发文章，直到你认可为止。\\n\\n004@枕书凉 你不想做的事？他会用各种方式让你觉得 “不做就是你的错”。 为什么？ 因为他们无法接受身边有任何人和自己不 一样。承认你的不同，意味着他的世界观 被挑战了；允许你拒绝，意味着他的自恋 受损了。 这就是为什么，正常人会内耗、会反思， NPD完全不会。 03正常人遇到不同意见，会想：是不是我 错了？是不是可以求同存异？\\n\\n005@枕书凉 但NPD的脑子里只有一种程序：“你不听我 的，就是攻击我；你攻击我，我就必须消 灭你。” 他们的世界里，没有容纳，没有理解。承 认别人，等于否定自己。所以他们只能不 停地赢、不停地控制、不停地消灭所有“不 一样”。 这也是为什么，你会觉得NPD目的性特别 强，执行力特别强。 为了让你顺从他，他可以无所不用其极; 为了让你认错，他可以跟你耗三天三夜。 但你发现没有？\\n\\n006@枕书凉 他们的目的，从来不是为了真正解决问 题，也不是为了让自己变得更好，只是为 了满足那个“我赢了”的感觉。 所以你会看到一种奇观：NPD十年如一日 地愚蠢，十年如一日地原地踏步。他们用 尽所有力气去控制别人，却没有一分力气 用来成长自己。 为什么？因为他们的能量，全部用来维持 自恋了，没有余力，去拓展世界观。 我是枕书凉，一个从回避型成长为安全型 的心理咨询师，从事回避型依恋，婚姻关 系，感情修复等咨询已有8年。让你们更懂 回避型，如果你们遇到感情问题，希望能 帮到你们\\n\\n007@枕书凉 如果你们的感情出现了以下几种情况，都 还有机会可以重归于好; 第一种：分开之后没有删除拉黑你，但 是态度很冷漠；写A 第二种：分开之后正常跟你聊天，但是 不愿意提及复合；写B 第三种：分开之后删除拉黑你，不愿沟 通态度决绝；写C 第四种：在一起经常吵架，或者对方经 常断联消失，消息电话不回。写D 有以上情况可以找我给你看看，我来帮你 从根本上解决你们的相处问题。", "platform": "xiaohongshu", "sourceUrl": "https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?xhsshare=pc_web", "accountName": "枕书凉.", "contentType": "image_post", "publishedAt": null, "accountHandle": "枕书凉.", "platformContentId": "6a6e0eb80000000005031f6f"}	7df080a5ab3016313d0ea09e1a3cda24f04304a69e61a39c9dec309e9515214b	90	{published_at}	\N	2026-08-29 15:29:57.961543+00
7	4	legacy-work-analysis:215:2026-08-26T02:41:04.712Z	legacy	2026-08-26 02:41:04+00	https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?xhsshare=pc_web	{"schema_version":16,"task_id":"3cd91f3b313c","source_url":"https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?source=webshare&xhsshare=pc_web&xsec_token=CBscI7y1gpeKhCHBWx4bfUg27s_Z2SodspTbBoMYTNOmc=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"借力高级心法","description":"不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种\\"全流程掌控\\"的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是\\"学\\"。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信\\"速成\\"可以等同于\\"掌握\\"，觉得知识必须经过自己漫长的消化才算是自己的，这是对\\"自我完整性\\"的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对\\"自我边界\\"的认知出了偏差。叫\\"我执\\"。 你把\\"我\\"画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把\\"我\\"看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲\\"君子生非异也，善假于物也\\"，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是\\"谁能比我更快更好地做成这件事\\"。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲\\"真空生妙有\\"，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的\\"空\\"就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个\\"妙有\\"——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从\\"我需要帮助\\"这个角度去看，开口就是示弱就是亏欠，你从\\"我在调动资源\\"这个角度去看。 这是借力的最高级心法 你以为的借力还是\\"我缺什么，我去拿\\"，但实际上而\\"让更有价值的人做更有价值的事，\\"利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜\\"我不欠任何人\\"，其实就是和任何人都没有关系。","cover_title":"不会借力是一种隐蔽的自恋","cover_title_meta":{"text":"不会借力是一种隐蔽的自恋","confidence":0.999,"font_ratio":1.45,"line_count":2,"lines":[{"text":"不会借力是一种","confidence":0.999},{"text":"隐蔽的自恋","confidence":0.999}],"source_image_index":1},"post_title":"借力高级心法","post_description":"不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种\\"全流程掌控\\"的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是\\"学\\"。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信\\"速成\\"可以等同于\\"掌握\\"，觉得知识必须经过自己漫长的消化才算是自己的，这是对\\"自我完整性\\"的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对\\"自我边界\\"的认知出了偏差。叫\\"我执\\"。 你把\\"我\\"画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把\\"我\\"看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲\\"君子生非异也，善假于物也\\"，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是\\"谁能比我更快更好地做成这件事\\"。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲\\"真空生妙有\\"，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的\\"空\\"就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个\\"妙有\\"——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从\\"我需要帮助\\"这个角度去看，开口就是示弱就是亏欠，你从\\"我在调动资源\\"这个角度去看。 这是借力的最高级心法 你以为的借力还是\\"我缺什么，我去拿\\"，但实际上而\\"让更有价值的人做更有价值的事，\\"利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜\\"我不欠任何人\\"，其实就是和任何人都没有关系。","display_title":"不会借力是一种隐蔽的自恋","author":"元元子","account":{"name":"元元子","profile_url":"https://www.xiaohongshu.com/user/profile/5592cc0f484fb665b39f939f","bio":"用星星术法和佛道哲学拆解人生\\n前大厂产品/前央企HR/中心协心理咨询师\\n🇬🇧warwick物理本·心理硕·浙大东哲mba在研·\\n地图研究@一个冻儿元 视频版（夸我美就行了","following_count":"3982","follower_count":"2410","likes_and_collections_count":"42845"},"collection_status":{"media":{"status":"not_video","method":"page","message":"未发现视频信号，按图文处理"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 元元子 关注 元元子 关注 借力高级心法 不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种&quot;全流程掌控&quot;的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是&quot;学&quot;。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信&quot;速成&quot;可以等同于&quot;掌握&quot;，觉得知识必须经过自己漫长的消化才算是自己的，这是对&quot;自我完整性&quot;的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对&quot;自我边界&quot;的认知出了偏差。叫&quot;我执&quot;。 你把&quot;我&quot;画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把&quot;我&quot;看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲&quot;君子生非异也，善假于物也&quot;，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是&quot;谁能比我更快更好地做成这件事&quot;。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲&quot;真空生妙有&quot;，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的&quot;空&quot;就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个&quot;妙有&quot;——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从&quot;我需要帮助&quot;这个角度去看，开口就是示弱就是亏欠，你从&quot;我在调动资源&quot;这个角度去看。 这是借力的最高级心法 你以为的借力还是&quot;我缺什么，我去拿&quot;，但实际上而&quot;让更有价值的人做更有价值的事，&quot;利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜&quot;我不欠任何人&quot;，其实就是和任何人都没有关系。 #修行 #女性力量 #心理 #借力 #女性智慧 #高能量 编辑于 07-27 加载中","text_same_as_description":true,"engagement":{"likes":"3814","collects":"2204","comments":"111"},"topics":["修行","女性力量","心理","借力","女性智慧","高能量"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"message":"BrowserType.launch: Executable doesn't exist at C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\ms-playwright\\\\chromium_headless_shell-1234\\\\chrome-headless-shell-win64\\\\chrome-headless-shell.ex"},"images":[{"index":1,"filename":"image_01.webp","text":"(Sun.) 七月二十六日 不会借力是一种 隐蔽的自恋","width":1080,"height":1440,"size_bytes":119878,"source_url":"http://sns-webpic-qc.xhscdn.com/202608260942/6434c7fe51ffe7b9b053841a0de9a7aa/1040g00832333r333721040t7t360v4sv2qr4pp8!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-26T01:42:56.032673+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对那些习惯独自完成所有事情、追求全流程掌控、对'自学'和'自我完整'有偏执的人群，尤其是高认知但可能陷入单一路径成功经验的人。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能面临因过度依赖自身努力而导致的效率低下、精力消耗和人际孤立，需要学会借助外部资源和人脉来提升生命效率。"},"content_structure":{"label":"内容怎么展开","summary":"内容先定义问题（不会借力是自恋和懒惰），再分析心理根源（自我边界偏差、我执、工具性思维差），最后提出借力的高维心法（视角转变和利他共赢）。"},"solution":{"label":"给了什么解决办法","summary":"给出的解决办法是转变借力视角：从'我需要帮助'转为'我在调动资源'，并强调借力是让更有价值的人做更有价值的事，形成利他共赢的结构。"},"references":{"label":"值得参考什么","summary":"值得参考的是内容中引用的古语'君子生非异也，善假于物也'和禅宗'真空生妙有'，以及诸葛亮借东风的比喻，这些用于支撑借力的智慧。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸的内容包括：具体如何识别可借力的资源、如何克服'自我完整'偏执的实操方法、借力在职场或创业中的案例，以及如何建立互惠的人际网络。"}},"source_labels":["封面标题","文字标题","作品描述","图片 OCR","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"title": "借力高级心法", "metrics": {"likes": "3814", "收藏": 2204, "点赞": 3814, "评论": 111, "collects": "2204", "comments": "111"}, "bodyText": "不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种\\"全流程掌控\\"的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是\\"学\\"。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信\\"速成\\"可以等同于\\"掌握\\"，觉得知识必须经过自己漫长的消化才算是自己的，这是对\\"自我完整性\\"的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对\\"自我边界\\"的认知出了偏差。叫\\"我执\\"。 你把\\"我\\"画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把\\"我\\"看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲\\"君子生非异也，善假于物也\\"，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是\\"谁能比我更快更好地做成这件事\\"。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲\\"真空生妙有\\"，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的\\"空\\"就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个\\"妙有\\"——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从\\"我需要帮助\\"这个角度去看，开口就是示弱就是亏欠，你从\\"我在调动资源\\"这个角度去看。 这是借力的最高级心法 你以为的借力还是\\"我缺什么，我去拿\\"，但实际上而\\"让更有价值的人做更有价值的事，\\"利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜\\"我不欠任何人\\"，其实就是和任何人都没有关系。\\n\\n发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 元元子 关注 元元子 关注 借力高级心法 不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种&quot;全流程掌控&quot;的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是&quot;学&quot;。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信&quot;速成&quot;可以等同于&quot;掌握&quot;，觉得知识必须经过自己漫长的消化才算是自己的，这是对&quot;自我完整性&quot;的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对&quot;自我边界&quot;的认知出了偏差。叫&quot;我执&quot;。 你把&quot;我&quot;画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把&quot;我&quot;看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲&quot;君子生非异也，善假于物也&quot;，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是&quot;谁能比我更快更好地做成这件事&quot;。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲&quot;真空生妙有&quot;，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的&quot;空&quot;就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个&quot;妙有&quot;——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从&quot;我需要帮助&quot;这个角度去看，开口就是示弱就是亏欠，你从&quot;我在调动资源&quot;这个角度去看。 这是借力的最高级心法 你以为的借力还是&quot;我缺什么，我去拿&quot;，但实际上而&quot;让更有价值的人做更有价值的事，&quot;利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜&quot;我不欠任何人&quot;，其实就是和任何人都没有关系。 #修行 #女性力量 #心理 #借力 #女性智慧 #高能量 编辑于 07-27 加载中\\n\\n(Sun.) 七月二十六日 不会借力是一种 隐蔽的自恋", "platform": "xiaohongshu", "sourceUrl": "https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?xhsshare=pc_web", "accountName": "元元子", "contentType": "image_post", "publishedAt": null, "accountHandle": "元元子", "platformContentId": "6a65d3eb0000000011016998"}	65b55987dd5e9c08e453a9847a727fd9a226b9b26b7c97789bfb28693026a60e	90	{published_at}	\N	2026-08-29 15:29:58.079364+00
8	3	legacy-work-analysis:218:2026-08-26T02:41:58.496Z	legacy	2026-08-26 02:41:58+00	https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?xhsshare=pc_web	{"schema_version":16,"task_id":"d2f5523e8cea","source_url":"https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608260939/c36fab8c27ae14e7af0222b3bf998101/spectrum/1040g0k03249p4lb30m005oq615kmbrh48v6a3ng!nd_dft_wlteh_jpg_3","duration_seconds":114.15,"width":2160,"height":3840,"size_bytes":14422477,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_source":"platform_video_cover","cover_image_url":"http://sns-webpic-qc.xhscdn.com/202608260939/0878ef20126e158d0afc06c554fbbd9d/spectrum/1040g0k03249p4lb30m005oq615kmbrh48v6a3ng!nd_dft_wlteh_webp_3","cover_image_b64":"（已落地为本地封面文件，原始 189183 字符）","cover_image_width":1080,"cover_image_height":1441,"cover_image_size_bytes":141868}},"title":"双视角曝光，大家看看我有念稿感吗","description":"","cover_title":"两招去掉念稿感","cover_title_meta":{"text":"两招去掉念稿感","confidence":0.994,"font_ratio":1.3,"line_count":2,"lines":[{"text":"两招去掉","confidence":0.999},{"text":"念稿感","confidence":0.989}],"source_image_index":1,"source":"platform_video_cover"},"post_title":"双视角曝光，大家看看我有念稿感吗","post_description":"","display_title":"两招去掉念稿感","author":"北电超然","account":{"name":"北电超然","profile_url":"https://www.xiaohongshu.com/user/profile/63460969000000001901ee24","bio":"北京电影学院| 于超然（百度百科）\\n🎓14年表演教学与镜头训练经验\\n🎬第33届金鸡电影节最佳影片奖表演指导\\n帮老板用“微剧情”把内容做出差异化\\n让观众愿意看完，也愿意买单！","following_count":"1","follower_count":"2982","likes_and_collections_count":"11998"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"161","collects":"205","comments":"7"},"topics":["表现力","口播","念稿感","老板拍短视频","创始人ip"],"video_text":"[00:00] 脚本写的再好\\n[00:01] 你念稿感这个事你不解决\\n[00:03] 你的视频就是没流量\\n[00:05] OK这个是我的第二视角\\n[00:07] 右边是提词器\\n[00:08] 左边是摄影机\\n[00:09] 那我问你\\n[00:10] 现在你会觉得我有念稿感吗\\n[00:12] ok 那今天\\n[00:13] 我给大家分享\\n[00:14] 两个北电训练的方法\\n[00:16] 教你们如何去\\n[00:17] 去掉这该死的念稿感\\n[00:19] 说话的语速\\n[00:20] 你不能太均匀了\\n[00:22] 如果你每一句话\\n[00:23] 都用一样的语气\\n[00:24] 一样的节奏力度\\n[00:26] 那观众听你讲话\\n[00:27] 就好比是机器人一样\\n[00:29] 真正自然的表达\\n[00:31] 绝对不是每一句话都是一个调\\n[00:33] 它一定是有的地方是重的\\n[00:35] 有的地方是轻的\\n[00:36] 「哎说到这」\\n[00:38] 「我突然想起了一件事」\\n[00:40] 你看我刚刚的表达\\n[00:41] 是不是卡一下子\\n[00:42] 结巴一下都是没有问题的\\n[00:44] 这个就会显得很自然\\n[00:45] 很有活人感\\n[00:46] 节奏上你不能乱停顿\\n[00:48] 有的人说话习惯性的很快\\n[00:50] 有的人会刻意的又说的很慢\\n[00:53] 但是停顿的意义\\n[00:54] 是为了让重点被听进去啊\\n[00:57] 你不能为了停而停啊","video_text_meta":{"status":"partial","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":2,"chunks_succeeded":1,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":"第 2 段：Moxus 请求失败（HTTP 503）：The requested model is temporarily unavailable."},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"message":"BrowserType.launch: Executable doesn't exist at C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\ms-playwright\\\\chromium_headless_shell-1234\\\\chrome-headless-shell-win64\\\\chrome-headless-shell.ex"},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-26T01:40:33.390844+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条视频主要讲如何通过两个训练方法去除视频拍摄中的念稿感，提升表达的自然度。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对需要拍摄口播视频、担心念稿感影响流量和观众感受的内容创作者。"},"user_need":{"label":"用户主要问题或需求","summary":"用户主要问题是视频表达有念稿感，导致不自然、缺乏吸引力，可能影响流量。"},"content_structure":{"label":"内容怎么展开","summary":"内容先提出问题（念稿感影响流量），再展示自身双视角作为例子，然后介绍两个训练方法，最后具体说明方法要点。"},"solution":{"label":"给了什么解决办法","summary":"提供了两个方法：一是控制语速，避免每句话语气、节奏、力度均匀；二是合理停顿，停顿是为了让重点被听进去，而不是为了停而停。"},"references":{"label":"值得参考什么","summary":"值得参考的是双视角展示（提词器与摄影机同时呈现）以及北电训练方法的实际演示。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做更多关于口播表达技巧的内容，如不同场景下的语速控制、停顿练习示范，或对比有念稿感和无念稿感的案例。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"title": "双视角曝光，大家看看我有念稿感吗", "metrics": {"likes": "161", "收藏": 205, "点赞": 161, "评论": 7, "collects": "205", "comments": "7"}, "bodyText": "[00:00] 脚本写的再好\\n[00:01] 你念稿感这个事你不解决\\n[00:03] 你的视频就是没流量\\n[00:05] OK这个是我的第二视角\\n[00:07] 右边是提词器\\n[00:08] 左边是摄影机\\n[00:09] 那我问你\\n[00:10] 现在你会觉得我有念稿感吗\\n[00:12] ok 那今天\\n[00:13] 我给大家分享\\n[00:14] 两个北电训练的方法\\n[00:16] 教你们如何去\\n[00:17] 去掉这该死的念稿感\\n[00:19] 说话的语速\\n[00:20] 你不能太均匀了\\n[00:22] 如果你每一句话\\n[00:23] 都用一样的语气\\n[00:24] 一样的节奏力度\\n[00:26] 那观众听你讲话\\n[00:27] 就好比是机器人一样\\n[00:29] 真正自然的表达\\n[00:31] 绝对不是每一句话都是一个调\\n[00:33] 它一定是有的地方是重的\\n[00:35] 有的地方是轻的\\n[00:36] 「哎说到这」\\n[00:38] 「我突然想起了一件事」\\n[00:40] 你看我刚刚的表达\\n[00:41] 是不是卡一下子\\n[00:42] 结巴一下都是没有问题的\\n[00:44] 这个就会显得很自然\\n[00:45] 很有活人感\\n[00:46] 节奏上你不能乱停顿\\n[00:48] 有的人说话习惯性的很快\\n[00:50] 有的人会刻意的又说的很慢\\n[00:53] 但是停顿的意义\\n[00:54] 是为了让重点被听进去啊\\n[00:57] 你不能为了停而停啊", "platform": "xiaohongshu", "sourceUrl": "https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?xhsshare=pc_web", "accountName": "北电超然", "contentType": "video", "publishedAt": null, "accountHandle": "北电超然", "platformContentId": "6a8d06aa000000000f01f94b"}	8c374d3b2740b6c8b028cc602bf4d078acea508779e51123ffc71db72e1b2f7c	75	{published_at,media}	\N	2026-08-29 15:29:58.10674+00
9	9	legacy-work-analysis:221:2026-08-26T08:56:23.851Z	legacy	2026-08-26 08:56:23+00	https://www.xiaohongshu.com/discovery/item/6a69c47400000000050380df?xhsshare=pc_web	{"schema_version":16,"task_id":"da567dacc677","collected_at":"2026-08-26T16:55:27+08:00","manual_refresh":false,"source_url":"https://www.xiaohongshu.com/discovery/item/6a69c47400000000050380df?source=webshare&xhsshare=pc_web&xsec_token=ABKHtbzSs3-U4KMlmja0MixJhn5Yfq0tyD9E1GvM0NLB0=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"不怕失去的底层安全感，怎么来的？","description":"亲密关系中，不怕失去的底层安全感，怎么来的？","cover_title":"亲密关系中","cover_title_meta":{"text":"亲密关系中","confidence":0.968,"font_ratio":1.23,"line_count":1,"lines":[{"text":"亲密关系中","confidence":0.968}],"source_image_index":1},"post_title":"不怕失去的底层安全感，怎么来的？","post_description":"亲密关系中，不怕失去的底层安全感，怎么来的？","display_title":"亲密关系中","author":"谢小树","account":{"name":"谢小树","profile_url":"https://www.xiaohongshu.com/user/profile/5db778250000000001008987","bio":"👑  12年心理咨询师｜ 17年深耕易学\\n👑  直播切片 ：@谢小树🌲宝藏树 \\n     ✉️✉️找到我✉️✉️\\n【直播、连麦】：每月第一个周日12-15点","following_count":"16","follower_count":"183814","likes_and_collections_count":"916719"},"collection_status":{"media":{"status":"not_video","method":"page","message":"未发现视频信号，按图文处理"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 谢小树 关注 谢小树 关注 不怕失去的底层安全感，怎么来的？ 亲密关系中，不怕失去的底层安全感，怎么来的？ #女性智慧 #女性成长 #心理学 #情感 07-31 重庆 加载中","text_same_as_description":false,"engagement":{"likes":"624","collects":"470","comments":"15"},"topics":["女性智慧","女性成长","心理学","情感"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":15,"replies_scanned":7,"primary_pages":1,"reply_pages":2,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.166,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[{"index":1,"filename":"image_01.webp","text":"亲密关系中 不怕失去的底层安全感 怎么来的","width":1080,"height":1440,"size_bytes":192158,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261654/85fe15cd6c0563e7c982e8a4665b3194/1040g0083236v77hfnk4g5ndnf0ig92c7o7vtp7g!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-26T08:55:27.607439+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"内容围绕亲密关系中'不怕失去的底层安全感'这一主题展开，探讨其来源。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对在亲密关系中缺乏安全感、容易患得患失的人群。"},"user_need":{"label":"用户主要问题或需求","summary":"用户需要了解如何在亲密关系中建立不依赖对方、不惧失去的底层安全感。"},"content_structure":{"label":"内容怎么展开","summary":"以提问式标题引入，正文未提供具体展开结构，可能以论述或案例形式说明。"},"solution":{"label":"给了什么解决办法","summary":"内容未给出明确解决办法。"},"references":{"label":"值得参考什么","summary":"可参考亲密关系心理学、依恋理论等相关内容。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸制作关于安全感来源的心理学解释、实际案例或练习方法等内容。"}},"source_labels":["封面标题","文字标题","作品描述","图片 OCR","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"title": "不怕失去的底层安全感，怎么来的？", "metrics": {"likes": "624", "收藏": 470, "点赞": 624, "评论": 15, "collects": "470", "comments": "15"}, "bodyText": "亲密关系中，不怕失去的底层安全感，怎么来的？\\n\\n发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 谢小树 关注 谢小树 关注 不怕失去的底层安全感，怎么来的？ 亲密关系中，不怕失去的底层安全感，怎么来的？ #女性智慧 #女性成长 #心理学 #情感 07-31 重庆 加载中\\n\\n亲密关系中 不怕失去的底层安全感 怎么来的", "platform": "xiaohongshu", "sourceUrl": "https://www.xiaohongshu.com/discovery/item/6a69c47400000000050380df?xhsshare=pc_web", "accountName": "谢小树", "contentType": "image_post", "publishedAt": null, "accountHandle": "谢小树", "platformContentId": "6a69c47400000000050380df"}	10a41cdec782f6a3b9ede24855d7a04db5fc37954c1e05f11a6a4be98576642e	90	{published_at}	\N	2026-08-29 15:29:58.125928+00
10	10	legacy-work-analysis:225:2026-08-29T03:25:22.062Z	legacy	2026-08-29 03:25:22+00	https://www.xiaohongshu.com/discovery/item/6a86ad460000000025007d54?xhsshare=pc_web	{"schema_version":16,"task_id":"e03b0ba25d3d","collected_at":"2026-08-29T03:23:21+00:00","manual_refresh":false,"source_url":"https://www.xiaohongshu.com/discovery/item/6a86ad460000000025007d54?source=webshare&xhsshare=pc_web&xsec_token=ABZMGYc6rcbXT7BMFRuYRhqdgPgB1W4BJJexKYHFt3_hQ=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","session_mode":"public","session_mode_label":"公开无登录","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"本J人被自己画的重庆地图满意到睡不着了","description":"熬夜整理出来的重庆4天3晚游玩地图，J人属性彻底爆发！直接把重庆划分为4大区域，不走回头路，拿着这份攻略就能轻松玩转山城！ 📍Part 1 渝中经典线 解放碑 ➡️ 山城步道 ➡️ 十八梯 ➡️ 湖广会馆 ➡️ 白象居 ➡️ 洪崖洞 ➡️ 千厮门大桥 一条线打卡完渝中半岛的核心地标，感受老重庆的爬坡上坎与璀璨夜景。 📍Part 2 南岸江景线 两江小渡 ➡️ 弹子石老街 ➡️ 下浩里 ➡️ 龙门浩 ➡️ 开埠遗址公园 ➡️ 长江索道 ➡️ 南滨路 沿着长江一路漫步，看绝美日落与两江交汇，夜景氛围感直接拉满。 📍Part 3 潮流人文线 鹅岭二厂 ➡️ 鹅岭公园 ➡️ 李子坝 ➡️ 人民大礼堂 ➡️ 三峡博物馆 ➡️ 北仓文创园 ➡️ 观音桥 文创园区与魔幻轻轨结合，感受山城的文艺与潮流繁华。 📍Part 4 沙坪坝文化线 重庆动物园 ➡️ 磁器口 ➡️ 马房湾七彩巷 ➡️ 渣滓洞 ➡️ 白公馆 ➡️ 罗中立美术馆 ➡️ 工业博物馆 看大熊猫四喜丸子，逛千年古镇与红色旧址，艺术感与历史感兼具。 🍲 美食打卡必吃清单 1️⃣ 洞洞隐火锅地下防空洞店：防空洞里吃火锅，必吃重庆地标解放碑洪崖洞慕斯蛋糕和所有甜品免费吃！ 2️⃣ 零贰山江景自助老火锅：看两江夜景吃火锅，性价比绝了。 3️⃣ 地道壹号防空洞火锅：地道牛油浓香，重庆老味道。 4️⃣ 食济良重庆特产店：重庆特产知名品牌，都是批发价，带伴手礼去这一个地方就够了。 5️⃣ 花市碗杂面：豌豆软糯，杂酱香浓，本地人从小吃到大。","cover_title":"","cover_title_meta":{},"post_title":"本J人被自己画的重庆地图满意到睡不着了","post_description":"熬夜整理出来的重庆4天3晚游玩地图，J人属性彻底爆发！直接把重庆划分为4大区域，不走回头路，拿着这份攻略就能轻松玩转山城！ 📍Part 1 渝中经典线 解放碑 ➡️ 山城步道 ➡️ 十八梯 ➡️ 湖广会馆 ➡️ 白象居 ➡️ 洪崖洞 ➡️ 千厮门大桥 一条线打卡完渝中半岛的核心地标，感受老重庆的爬坡上坎与璀璨夜景。 📍Part 2 南岸江景线 两江小渡 ➡️ 弹子石老街 ➡️ 下浩里 ➡️ 龙门浩 ➡️ 开埠遗址公园 ➡️ 长江索道 ➡️ 南滨路 沿着长江一路漫步，看绝美日落与两江交汇，夜景氛围感直接拉满。 📍Part 3 潮流人文线 鹅岭二厂 ➡️ 鹅岭公园 ➡️ 李子坝 ➡️ 人民大礼堂 ➡️ 三峡博物馆 ➡️ 北仓文创园 ➡️ 观音桥 文创园区与魔幻轻轨结合，感受山城的文艺与潮流繁华。 📍Part 4 沙坪坝文化线 重庆动物园 ➡️ 磁器口 ➡️ 马房湾七彩巷 ➡️ 渣滓洞 ➡️ 白公馆 ➡️ 罗中立美术馆 ➡️ 工业博物馆 看大熊猫四喜丸子，逛千年古镇与红色旧址，艺术感与历史感兼具。 🍲 美食打卡必吃清单 1️⃣ 洞洞隐火锅地下防空洞店：防空洞里吃火锅，必吃重庆地标解放碑洪崖洞慕斯蛋糕和所有甜品免费吃！ 2️⃣ 零贰山江景自助老火锅：看两江夜景吃火锅，性价比绝了。 3️⃣ 地道壹号防空洞火锅：地道牛油浓香，重庆老味道。 4️⃣ 食济良重庆特产店：重庆特产知名品牌，都是批发价，带伴手礼去这一个地方就够了。 5️⃣ 花市碗杂面：豌豆软糯，杂酱香浓，本地人从小吃到大。","display_title":"本J人被自己画的重庆地图满意到睡不着了","author":"小野茶茶","account":{"name":"小野茶茶","profile_url":"https://www.xiaohongshu.com/user/profile/5fcde30f0000000001008df1","bio":"","following_count":"10+","follower_count":"10+","likes_and_collections_count":"1千+"},"collection_status":{"media":{"status":"ok","method":"page_image_download","message":"已保存 8 张正文图片","discovered":9,"downloaded":8,"failed":0,"rejected_payload":0,"rejected_dimensions":1},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 小野茶茶 关注 可能含AI生成内容 1/7 小野茶茶 关注 本J人被自己画的重庆地图满意到睡不着了 熬夜整理出来的重庆4天3晚游玩地图，J人属性彻底爆发！直接把重庆划分为4大区域，不走回头路，拿着这份攻略就能轻松玩转山城！ 📍Part 1 渝中经典线 解放碑 ➡️ 山城步道 ➡️ 十八梯 ➡️ 湖广会馆 ➡️ 白象居 ➡️ 洪崖洞 ➡️ 千厮门大桥 一条线打卡完渝中半岛的核心地标，感受老重庆的爬坡上坎与璀璨夜景。 📍Part 2 南岸江景线 两江小渡 ➡️ 弹子石老街 ➡️ 下浩里 ➡️ 龙门浩 ➡️ 开埠遗址公园 ➡️ 长江索道 ➡️ 南滨路 沿着长江一路漫步，看绝美日落与两江交汇，夜景氛围感直接拉满。 📍Part 3 潮流人文线 鹅岭二厂 ➡️ 鹅岭公园 ➡️ 李子坝 ➡️ 人民大礼堂 ➡️ 三峡博物馆 ➡️ 北仓文创园 ➡️ 观音桥 文创园区与魔幻轻轨结合，感受山城的文艺与潮流繁华。 📍Part 4 沙坪坝文化线 重庆动物园 ➡️ 磁器口 ➡️ 马房湾七彩巷 ➡️ 渣滓洞 ➡️ 白公馆 ➡️ 罗中立美术馆 ➡️ 工业博物馆 看大熊猫四喜丸子，逛千年古镇与红色旧址，艺术感与历史感兼具。 🍲 美食打卡必吃清单 1️⃣ 洞洞隐火锅地下防空洞店：防空洞里吃火锅，必吃重庆地标解放碑洪崖洞慕斯蛋糕和所有甜品免费吃！ 2️⃣ 零贰山江景自助老火锅：看两江夜景吃火锅，性价比绝了。 3️⃣ 地道壹号防空洞火锅：地道牛油浓香，重庆老味道。 4️⃣ 食济良重庆特产店：重庆特产知名品牌，都是批发价，带伴手礼去这一个地方就够了。 5️⃣ 花市碗杂面：豌豆软糯，杂酱香浓，本地人从小吃到大。 #美食SOP指南 #这才是重庆 #重庆 #重庆旅游 #重庆打卡 #重庆美食 #重庆攻略 #重庆火锅 #重庆特产 #本地人做的攻略 08-20 重庆 加载中","text_same_as_description":true,"engagement":{"likes":"611","collects":"703","comments":"37"},"topics":["美食SOP指南","这才是重庆","重庆","重庆旅游","重庆打卡","重庆美食","重庆攻略","重庆火锅","重庆特产","本地人做的攻略"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":14,"replies_scanned":4,"primary_pages":1,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"limited","likes_obscured":true,"obscured_count":1,"confidence":0.161,"confidence_target":0.8,"strategy":"adaptive_hot_stream","session_evidence":"public_mode","confidence_reached":false,"stable_pages":0},"images":[{"index":1,"filename":"image_01.webp","text":"重庆可以分为四个板块 嘉陵江 Part2 观音桥 Part3 两江小渡 北仓文创园 弹子石老街 Part1 “小天坛 千厮门大桥 重庆人民大礼堂 下浩里 洪崖洞 三峡博物馆 龙门浩 解放碑 李子坝 湖广会馆 山城步道 老重庆风貌 长江索道 十八梯 鹅岭二厂 南滨路 Part4 磁器口 马房湾七彩巷 重庆动物园 注意：此地图 渣洞 只为路线标注， 白公馆 与实际地图 有差异","width":1080,"height":1440,"size_bytes":650648,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/b041374e7409a06ed406353dd4b76dd6/notes_pre_post/1040g3k032436qbr0gs0g5nudsc7g93fhd7h5t8o!nd_dft_wlteh_webp_3"},{"index":2,"filename":"image_02.webp","text":"重庆旅游Day1 千厮门大桥 山城记 拍摄洪崖洞全景 最佳机位， 山城重庆 解放碑 8D魔幻之旅 轻松拍出夜景大片。 步行6分钟 就从这一天开始! 重庆城市图腾与地标， 抗战历史纪念， 富有打卡意义。 洪崖洞 梦幻吊脚楼， 步行15分钟 夜晚亮灯极其惊艳， 如同千与千寻。 山城步道 临崖建造的步道， 车程10分钟 浓缩山城精髓， 体验爬坡上坎。 白象居 渝中半岛 二十四层无电梯老楼 步行10分钟 展现魔幻建筑与江景 十八梯 老重庆建筑风格 车程10分钟 台阶漫步非常意， 步行20分钟 拍照出片。 湖广会馆 康熙年间古建筑， 小贴士 明清活化石， 历史氛围浓厚。 ·步行为主，穿舒适鞋子 ·夜景更美，记得带相机 ·美食推荐：火锅，小面、酸辣粉","width":1080,"height":1440,"size_bytes":579232,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/5cd4b0c921813744569e3d9d57b22c16/notes_pre_post/1040g3k032436qbr0gs105nudsc7g93fhfm3stv0!nd_dft_wlteh_webp_3"},{"index":3,"filename":"image_03.webp","text":"重庆旅游Day2 1.两江小渡 2.弹子石老街 性价比高的小渡轮， 日落时分极具氛围感 百年开埠遗址， 建筑中西合壁， 轮渡15分钟 夜市热闹 轻轨26分钟 3.下浩里 嘉陵江 巴渝吊脚楼风格， 长江 烟火气十足， 适合citywalk 步行10分钟 5.重庆开埠遗址公园 4.龙门浩老街 立体的山城公园 百年老街区， 俯瞰两江交汇 民国建筑风貌 壮丽景色 拍大桥绝佳 轻轨18分钟 打车8分钟 6.长江索道 7.南滨路 老式飞车交通 沿江漫步观赏江景 飞跃长江， 将渝中半岛夜景 步行15分钟 建议南站乘坐 尽收眼底","width":1080,"height":1440,"size_bytes":515780,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/0e284c9cb6350e3a6674ad132d2e204a/notes_pre_post/1040g3k032436qbr0gs1g5nudsc7g93fh0afcr60!nd_dft_wlteh_webp_3"},{"index":4,"filename":"image_04.webp","text":"江北区 重庆旅游Day3 7.观音桥：潮流商圈, 标志性大屏与好吃街， 7.观音桥 夜生活丰富。 步行10分钟 6.北仓文创园：文艺青年 6.北仓文创园 聚集地，咖啡手作店云集， 渝中区 适合i人。 步行17分钟 嘉陵江 5.三峡博物馆：国家 5.三峡博物馆 一级博物馆，馆藏丰富 且可免费盖章。 步行3分钟 九龙坡区 4.人民大礼堂：中式 4.人民大礼堂 琉璃瓦复古地标，经典 3.李子坝：轻轨穿楼 城市名片。 地铁25分钟 名场面，体验口吞轻轨 奇观。 南岸区 3.李子坝 步行16分钟 1.鹅岭二厂 2. 鹅岭公园：渝中半岛 1.鹅岭二厂： 制高点，揽胜楼俯瞰 工业风文创园, 全城夜景。 拍照非常有杂感 大片范。 大渡口区 巴南区","width":1080,"height":1440,"size_bytes":487050,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/2e18b1e94deb031260f2cfff01d42393/notes_pre_post/1040g3k032436qbr0gs205nudsc7g93fhuec1v1o!nd_dft_wlteh_webp_3"},{"index":5,"filename":"image_05.webp","text":"重庆旅游Day4 歌乐山 5.白公馆 军阀别墅改编， 红岩历史， 4.渣洞 山城重庆 小萝卜头关押处; 魅力无限! 渣洞 歌乐山红色旧址， 还原牢房， 打车10分钟 缅怀革命先烈; 3.马房湾七彩巷 6.罗中立美术馆 彩色涂鸦街区， 打车14分钟 拍照出片， 炫彩涂鸦外墙 追星女孩必去; 艺术氛围浓厚， 打卡圣地; 渝中区 沙坪坝 2.磁器口 南岸区 打车18分钟 千年古镇， 青石板路与 7.重庆工业博物馆 古镇火锅， 烟火气拉满； 工业遗产基地， 轻轨25分钟 钢铁蒸汽朋克 风格大片； 打车20分钟 1.重庆动物园 打车16分钟 门票超值， 熊猫数量多， ·小贴士 看四喜丸子 重庆动物园 带好身份证 重庆的美， 在山城的每一步! 打麻将； ·穿舒适鞋子 ·注意防晒补水 巴南区","width":1080,"height":1440,"size_bytes":572802,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/9e493f07014e76957245289fd0399f01/notes_pre_post/1040g3k032436qbr0gs2g5nudsc7g93fh54l1kfo!nd_dft_wlteh_webp_3"},{"index":6,"filename":"image_06.webp","text":"备忘录 重庆交通与住宿指南 、重庆交通指南 二、重庆住宿选择 解放碑附近：出行方便 飞机抵达 ①飞机抵达：江北国际机场 位于重庆市中心，小白选这里准没错， ②地铁：T3航站楼乘10号线 附近景点多而密集，去哪里都方便， 重庆北站 转6号线直达解放碑 美食种类也丰富 ③机场快线：K01直达解放碑 （15元／人，24小时运营） 沙坪坝附近：性价比高 观音桥 高铁/火车 临近大学城，所以夜市、小吃不用担心， ①重庆北站：在市区，去解放碑 性价比高，适合学生党/穷游党， 坐10号线转2号线 就是离景点有点远 解放碑 ②重庆西站：离市区较远，去 沙坪坝 解放碑坐5号线转1号线 观音桥附近：夜生活丰富 ③沙坪坝站：离市区较远，距 重庆著名的商圈，年轻人聚集地， 离市中心14km，去解放碑坐1 附近有九街、北仓文创街等，所以夜 号线到小什字站下 重庆西站 生活丰富，吃喝玩乐一应俱全，就是 睡眠浅的宝子住的楼层太低会觉得晚 地铁：首选！不堵车 上有点吵 主城热门景点基本覆盖，单程2-9R， 不堵车不绕路 南滨路附近：顶级江景 网约车/出租车 住在这边的主打就是一个风景好， 赶时间，人多可选，市区起步价9R左右， 这边有很多江景房，喜欢拍照的姐妹 避开解放碑/洪崖洞/南滨路早晚高峰 们可以冲，就是价格稍微有点高 公交：线路密 单程2R，适合体验老重庆，但报站不清晰 选酒店小TIPS：避坑避雷！ +部分线路绕路，新手慎选 别选解放碑核心区低价民宿，大多嘈杂、 共享电动车：慎骑！ 设施老旧，无电梯，订前多看真实住客评 重庆多弯多梯坎多，部分区域禁行， 价+实拍图 容易骑出运营区扣调度费，平少的 订江景房别只看宣传，避开“侧面江景”“伪 地方别试 江景” 交步行：核心区可步行 优先选地铁口5分钟内的住宿，山城爬坡 累，交通方便真的太重要了！ 更能感受山城烟火气","width":1080,"height":1440,"size_bytes":376992,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/ffc7308cdb9ddb22e298873e43c61b7e/notes_pre_post/1040g3k032436qbr0gs305nudsc7g93fhbhcdbm8!nd_dft_wlteh_webp_3"},{"index":7,"filename":"image_07.webp","text":"<备忘录 重庆美食打卡 洞洞隐火锅地下防空洞店 防空洞特色，必吃重庆地标解放碑洪崖洞慕斯蛋糕 和所有甜品免费吃☆ 零贰山江景自助老火锅 解放碑 看两江夜景吃火锅，性价比绝了！ 地道壹号防空洞火锅· 地道牛油浓香，重庆老味道！ 食济良重庆特产店· 洪崖洞 重庆特产知名品牌，都是批发价！ 花市碗杂面· 老字号小面，豌豆沙糯，杂酱鲜香！☆ 零贰山江景 洞洞隐火锅 自助老火锅 地下防空洞店 裤为吃货青年 3地道壹号 防空洞火锅 4食济良 重庆特产店 来重庆，吃得辣，玩得爽，才算不虚此行！","width":1080,"height":1440,"size_bytes":453060,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/c0d1b2cf297bdc8801ab3bb4308584d5/notes_pre_post/1040g3k032436qbr0gs3g5nudsc7g93fh9dc7lc0!nd_dft_wlteh_webp_3"},{"index":8,"filename":"image_08.png","text":"小红书","width":600,"height":315,"size_bytes":4569,"source_url":"https://picasso-static.xiaohongshu.com/fe-platform/e6214e4fbfae2cf14d634d4296916e8a5eaefdf4.png"}],"ai_analysis":{"schema_version":1,"status":"unavailable","model":"gemini-3.6-flash","generated_at":"2026-08-29T03:23:21.909973+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"unavailable","message":"AI 视频分析暂时不可用，请稍后重试","items":{},"source_labels":[]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"title": "本J人被自己画的重庆地图满意到睡不着了", "metrics": {"likes": "611", "收藏": 703, "点赞": 611, "评论": 37, "collects": "703", "comments": "37"}, "bodyText": "熬夜整理出来的重庆4天3晚游玩地图，J人属性彻底爆发！直接把重庆划分为4大区域，不走回头路，拿着这份攻略就能轻松玩转山城！ 📍Part 1 渝中经典线 解放碑 ➡️ 山城步道 ➡️ 十八梯 ➡️ 湖广会馆 ➡️ 白象居 ➡️ 洪崖洞 ➡️ 千厮门大桥 一条线打卡完渝中半岛的核心地标，感受老重庆的爬坡上坎与璀璨夜景。 📍Part 2 南岸江景线 两江小渡 ➡️ 弹子石老街 ➡️ 下浩里 ➡️ 龙门浩 ➡️ 开埠遗址公园 ➡️ 长江索道 ➡️ 南滨路 沿着长江一路漫步，看绝美日落与两江交汇，夜景氛围感直接拉满。 📍Part 3 潮流人文线 鹅岭二厂 ➡️ 鹅岭公园 ➡️ 李子坝 ➡️ 人民大礼堂 ➡️ 三峡博物馆 ➡️ 北仓文创园 ➡️ 观音桥 文创园区与魔幻轻轨结合，感受山城的文艺与潮流繁华。 📍Part 4 沙坪坝文化线 重庆动物园 ➡️ 磁器口 ➡️ 马房湾七彩巷 ➡️ 渣滓洞 ➡️ 白公馆 ➡️ 罗中立美术馆 ➡️ 工业博物馆 看大熊猫四喜丸子，逛千年古镇与红色旧址，艺术感与历史感兼具。 🍲 美食打卡必吃清单 1️⃣ 洞洞隐火锅地下防空洞店：防空洞里吃火锅，必吃重庆地标解放碑洪崖洞慕斯蛋糕和所有甜品免费吃！ 2️⃣ 零贰山江景自助老火锅：看两江夜景吃火锅，性价比绝了。 3️⃣ 地道壹号防空洞火锅：地道牛油浓香，重庆老味道。 4️⃣ 食济良重庆特产店：重庆特产知名品牌，都是批发价，带伴手礼去这一个地方就够了。 5️⃣ 花市碗杂面：豌豆软糯，杂酱香浓，本地人从小吃到大。\\n\\n发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 小野茶茶 关注 可能含AI生成内容 1/7 小野茶茶 关注 本J人被自己画的重庆地图满意到睡不着了 熬夜整理出来的重庆4天3晚游玩地图，J人属性彻底爆发！直接把重庆划分为4大区域，不走回头路，拿着这份攻略就能轻松玩转山城！ 📍Part 1 渝中经典线 解放碑 ➡️ 山城步道 ➡️ 十八梯 ➡️ 湖广会馆 ➡️ 白象居 ➡️ 洪崖洞 ➡️ 千厮门大桥 一条线打卡完渝中半岛的核心地标，感受老重庆的爬坡上坎与璀璨夜景。 📍Part 2 南岸江景线 两江小渡 ➡️ 弹子石老街 ➡️ 下浩里 ➡️ 龙门浩 ➡️ 开埠遗址公园 ➡️ 长江索道 ➡️ 南滨路 沿着长江一路漫步，看绝美日落与两江交汇，夜景氛围感直接拉满。 📍Part 3 潮流人文线 鹅岭二厂 ➡️ 鹅岭公园 ➡️ 李子坝 ➡️ 人民大礼堂 ➡️ 三峡博物馆 ➡️ 北仓文创园 ➡️ 观音桥 文创园区与魔幻轻轨结合，感受山城的文艺与潮流繁华。 📍Part 4 沙坪坝文化线 重庆动物园 ➡️ 磁器口 ➡️ 马房湾七彩巷 ➡️ 渣滓洞 ➡️ 白公馆 ➡️ 罗中立美术馆 ➡️ 工业博物馆 看大熊猫四喜丸子，逛千年古镇与红色旧址，艺术感与历史感兼具。 🍲 美食打卡必吃清单 1️⃣ 洞洞隐火锅地下防空洞店：防空洞里吃火锅，必吃重庆地标解放碑洪崖洞慕斯蛋糕和所有甜品免费吃！ 2️⃣ 零贰山江景自助老火锅：看两江夜景吃火锅，性价比绝了。 3️⃣ 地道壹号防空洞火锅：地道牛油浓香，重庆老味道。 4️⃣ 食济良重庆特产店：重庆特产知名品牌，都是批发价，带伴手礼去这一个地方就够了。 5️⃣ 花市碗杂面：豌豆软糯，杂酱香浓，本地人从小吃到大。 #美食SOP指南 #这才是重庆 #重庆 #重庆旅游 #重庆打卡 #重庆美食 #重庆攻略 #重庆火锅 #重庆特产 #本地人做的攻略 08-20 重庆 加载中\\n\\n重庆可以分为四个板块 嘉陵江 Part2 观音桥 Part3 两江小渡 北仓文创园 弹子石老街 Part1 “小天坛 千厮门大桥 重庆人民大礼堂 下浩里 洪崖洞 三峡博物馆 龙门浩 解放碑 李子坝 湖广会馆 山城步道 老重庆风貌 长江索道 十八梯 鹅岭二厂 南滨路 Part4 磁器口 马房湾七彩巷 重庆动物园 注意：此地图 渣洞 只为路线标注， 白公馆 与实际地图 有差异\\n\\n重庆旅游Day1 千厮门大桥 山城记 拍摄洪崖洞全景 最佳机位， 山城重庆 解放碑 8D魔幻之旅 轻松拍出夜景大片。 步行6分钟 就从这一天开始! 重庆城市图腾与地标， 抗战历史纪念， 富有打卡意义。 洪崖洞 梦幻吊脚楼， 步行15分钟 夜晚亮灯极其惊艳， 如同千与千寻。 山城步道 临崖建造的步道， 车程10分钟 浓缩山城精髓， 体验爬坡上坎。 白象居 渝中半岛 二十四层无电梯老楼 步行10分钟 展现魔幻建筑与江景 十八梯 老重庆建筑风格 车程10分钟 台阶漫步非常意， 步行20分钟 拍照出片。 湖广会馆 康熙年间古建筑， 小贴士 明清活化石， 历史氛围浓厚。 ·步行为主，穿舒适鞋子 ·夜景更美，记得带相机 ·美食推荐：火锅，小面、酸辣粉\\n\\n重庆旅游Day2 1.两江小渡 2.弹子石老街 性价比高的小渡轮， 日落时分极具氛围感 百年开埠遗址， 建筑中西合壁， 轮渡15分钟 夜市热闹 轻轨26分钟 3.下浩里 嘉陵江 巴渝吊脚楼风格， 长江 烟火气十足， 适合citywalk 步行10分钟 5.重庆开埠遗址公园 4.龙门浩老街 立体的山城公园 百年老街区， 俯瞰两江交汇 民国建筑风貌 壮丽景色 拍大桥绝佳 轻轨18分钟 打车8分钟 6.长江索道 7.南滨路 老式飞车交通 沿江漫步观赏江景 飞跃长江， 将渝中半岛夜景 步行15分钟 建议南站乘坐 尽收眼底\\n\\n江北区 重庆旅游Day3 7.观音桥：潮流商圈, 标志性大屏与好吃街， 7.观音桥 夜生活丰富。 步行10分钟 6.北仓文创园：文艺青年 6.北仓文创园 聚集地，咖啡手作店云集， 渝中区 适合i人。 步行17分钟 嘉陵江 5.三峡博物馆：国家 5.三峡博物馆 一级博物馆，馆藏丰富 且可免费盖章。 步行3分钟 九龙坡区 4.人民大礼堂：中式 4.人民大礼堂 琉璃瓦复古地标，经典 3.李子坝：轻轨穿楼 城市名片。 地铁25分钟 名场面，体验口吞轻轨 奇观。 南岸区 3.李子坝 步行16分钟 1.鹅岭二厂 2. 鹅岭公园：渝中半岛 1.鹅岭二厂： 制高点，揽胜楼俯瞰 工业风文创园, 全城夜景。 拍照非常有杂感 大片范。 大渡口区 巴南区\\n\\n重庆旅游Day4 歌乐山 5.白公馆 军阀别墅改编， 红岩历史， 4.渣洞 山城重庆 小萝卜头关押处; 魅力无限! 渣洞 歌乐山红色旧址， 还原牢房， 打车10分钟 缅怀革命先烈; 3.马房湾七彩巷 6.罗中立美术馆 彩色涂鸦街区， 打车14分钟 拍照出片， 炫彩涂鸦外墙 追星女孩必去; 艺术氛围浓厚， 打卡圣地; 渝中区 沙坪坝 2.磁器口 南岸区 打车18分钟 千年古镇， 青石板路与 7.重庆工业博物馆 古镇火锅， 烟火气拉满； 工业遗产基地， 轻轨25分钟 钢铁蒸汽朋克 风格大片； 打车20分钟 1.重庆动物园 打车16分钟 门票超值， 熊猫数量多， ·小贴士 看四喜丸子 重庆动物园 带好身份证 重庆的美， 在山城的每一步! 打麻将； ·穿舒适鞋子 ·注意防晒补水 巴南区\\n\\n备忘录 重庆交通与住宿指南 、重庆交通指南 二、重庆住宿选择 解放碑附近：出行方便 飞机抵达 ①飞机抵达：江北国际机场 位于重庆市中心，小白选这里准没错， ②地铁：T3航站楼乘10号线 附近景点多而密集，去哪里都方便， 重庆北站 转6号线直达解放碑 美食种类也丰富 ③机场快线：K01直达解放碑 （15元／人，24小时运营） 沙坪坝附近：性价比高 观音桥 高铁/火车 临近大学城，所以夜市、小吃不用担心， ①重庆北站：在市区，去解放碑 性价比高，适合学生党/穷游党， 坐10号线转2号线 就是离景点有点远 解放碑 ②重庆西站：离市区较远，去 沙坪坝 解放碑坐5号线转1号线 观音桥附近：夜生活丰富 ③沙坪坝站：离市区较远，距 重庆著名的商圈，年轻人聚集地， 离市中心14km，去解放碑坐1 附近有九街、北仓文创街等，所以夜 号线到小什字站下 重庆西站 生活丰富，吃喝玩乐一应俱全，就是 睡眠浅的宝子住的楼层太低会觉得晚 地铁：首选！不堵车 上有点吵 主城热门景点基本覆盖，单程2-9R， 不堵车不绕路 南滨路附近：顶级江景 网约车/出租车 住在这边的主打就是一个风景好， 赶时间，人多可选，市区起步价9R左右， 这边有很多江景房，喜欢拍照的姐妹 避开解放碑/洪崖洞/南滨路早晚高峰 们可以冲，就是价格稍微有点高 公交：线路密 单程2R，适合体验老重庆，但报站不清晰 选酒店小TIPS：避坑避雷！ +部分线路绕路，新手慎选 别选解放碑核心区低价民宿，大多嘈杂、 共享电动车：慎骑！ 设施老旧，无电梯，订前多看真实住客评 重庆多弯多梯坎多，部分区域禁行， 价+实拍图 容易骑出运营区扣调度费，平少的 订江景房别只看宣传，避开“侧面江景”“伪 地方别试 江景” 交步行：核心区可步行 优先选地铁口5分钟内的住宿，山城爬坡 累，交通方便真的太重要了！ 更能感受山城烟火气\\n\\n<备忘录 重庆美食打卡 洞洞隐火锅地下防空洞店 防空洞特色，必吃重庆地标解放碑洪崖洞慕斯蛋糕 和所有甜品免费吃☆ 零贰山江景自助老火锅 解放碑 看两江夜景吃火锅，性价比绝了！ 地道壹号防空洞火锅· 地道牛油浓香，重庆老味道！ 食济良重庆特产店· 洪崖洞 重庆特产知名品牌，都是批发价！ 花市碗杂面· 老字号小面，豌豆沙糯，杂酱鲜香！☆ 零贰山江景 洞洞隐火锅 自助老火锅 地下防空洞店 裤为吃货青年 3地道壹号 防空洞火锅 4食济良 重庆特产店 来重庆，吃得辣，玩得爽，才算不虚此行！\\n\\n小红书", "platform": "xiaohongshu", "sourceUrl": "https://www.xiaohongshu.com/discovery/item/6a86ad460000000025007d54?xhsshare=pc_web", "accountName": "小野茶茶", "contentType": "image_post", "publishedAt": null, "accountHandle": "小野茶茶", "platformContentId": "6a86ad460000000025007d54"}	7170d66a170f40da0c8a9a3a65b000f40f30dacc33c948d1b336b14aa9e5fa0e	90	{published_at}	\N	2026-08-29 15:29:58.150313+00
\.


--
-- Data for Name: sample_cluster_jobs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_cluster_jobs (id, algorithm_selection_id, status, idempotency_key, request_sha256, requested_by, attempts, max_attempts, lease_owner, lease_expires_at, heartbeat_at, error_code, error_message, created_at, started_at, finished_at) FROM stdin;
1	1	succeeded	initial-cluster-stage4-857bb94	cfd72ba0066d0a321e67c8b46384b424cba5da91cb2009ecb78ac1e0a4e6f244	1	1	3	\N	\N	2026-08-29 15:47:09.528714+00	\N	\N	2026-08-29 15:47:09.518919+00	2026-08-29 15:47:09.528714+00	2026-08-29 15:47:09.533213+00
\.


--
-- Data for Name: sample_cluster_members; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_cluster_members (run_id, sample_id, profile_id, cluster_id, is_outlier, representative, pair_mean) FROM stdin;
1	1	1	\N	t	f	\N
1	2	2	\N	t	f	\N
1	3	3	\N	t	f	\N
1	4	4	\N	t	f	\N
1	5	5	\N	t	f	\N
1	9	6	\N	t	f	\N
1	10	7	\N	t	f	\N
\.


--
-- Data for Name: sample_cluster_run_profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_cluster_run_profiles (run_id, algorithm_selection_id, sample_id, profile_id, ordinal) FROM stdin;
1	1	1	1	1
1	1	2	2	2
1	1	3	3	3
1	1	4	4	4
1	1	5	5	5
1	1	9	6	6
1	1	10	7	7
\.


--
-- Data for Name: sample_cluster_runs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_cluster_runs (id, job_id, algorithm_selection_id, status, algorithm_version, input_sha256, profile_count, limitation, created_at, completed_at) FROM stdin;
1	1	1	complete	mutual-knn/1	0d598fbd776ce96fa6efeefb7cad294071342c015f61264e97a01bddfb103280	7	聚类仅描述结构相似性，不代表内容价值或表现因果。	2026-08-29 15:47:09.533213+00	2026-08-29 15:47:09.533213+00
\.


--
-- Data for Name: sample_cluster_selections; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_cluster_selections (id, run_id, algorithm_selection_id, selected_by, reason, created_at) FROM stdin;
1	1	1	1	job_success	2026-08-29 15:47:09.533213+00
\.


--
-- Data for Name: sample_clusters; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_clusters (id, run_id, ordinal, cluster_key, representative_sample_id, label, summary, cohesion, common_tags, distinguishing_tags, dimension_contributions, limitation) FROM stdin;
\.


--
-- Data for Name: sample_comparison_assessment_jobs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_comparison_assessment_jobs (id, comparison_id, scope_id, target, status, request_sha256, attempts, max_attempts, provider, model_name, lease_owner, lease_expires_at, heartbeat_at, error_code, error_message, requested_by, created_at, started_at, finished_at) FROM stdin;
\.


--
-- Data for Name: sample_comparison_assessment_selections; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_comparison_assessment_selections (id, comparison_id, target, assessment_id, reason, selected_by, created_at) FROM stdin;
\.


--
-- Data for Name: sample_comparison_assessments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_comparison_assessments (id, comparison_id, scope_id, job_id, target, source, revision, common_points, key_differences, strengths, limitations, worth_learning, do_not_copy, hypotheses, open_questions, method_limitations, input_sha256, schema_version, prompt_version, model_provider, model_name, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: sample_comparison_finding_evidence; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_comparison_finding_evidence (id, assessment_id, finding_id, member_sample_id, scope_id, snapshot_id, dimension_key, evidence_token, created_at) FROM stdin;
\.


--
-- Data for Name: sample_comparison_findings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_comparison_findings (id, comparison_id, scope_id, assessment_id, target, member_sample_id, kind, claim_text, limitations, evidence_state, ordinal, created_at) FROM stdin;
\.


--
-- Data for Name: sample_comparison_scope_members; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_comparison_scope_members (id, comparison_id, scope_id, sample_id, analysis_version_id, ordinal, frozen_title, frozen_account_name, frozen_account_handle, frozen_platform, frozen_published_at, metric_snapshot_id, frozen_metric_observed_at, observation_window_seconds, frozen_metrics, created_at) FROM stdin;
1	1	1	5	5	1	NPD有一个藏不住的语言习惯	枕书凉.	枕书凉.	xiaohongshu	\N	5	2026-08-26 02:42:03+00	\N	{"likes": 1295, "saves": 951, "views": null, "shares": null, "comments": 286}	2026-08-29 16:10:00.559637+00
2	1	1	10	7	2	本J人被自己画的重庆地图满意到睡不着了	小野茶茶	小野茶茶	xiaohongshu	\N	10	2026-08-29 03:25:22+00	\N	{"likes": 611, "saves": 703, "views": null, "shares": null, "comments": 37}	2026-08-29 16:10:00.559637+00
3	1	1	4	4	3	借力高级心法	元元子	元元子	xiaohongshu	\N	4	2026-08-26 02:41:56+00	\N	{"likes": 3814, "saves": 2204, "views": null, "shares": null, "comments": 111}	2026-08-29 16:10:00.559637+00
4	2	2	5	5	1	NPD有一个藏不住的语言习惯	枕书凉.	枕书凉.	xiaohongshu	\N	5	2026-08-26 02:42:03+00	\N	{"likes": 1295, "saves": 951, "views": null, "shares": null, "comments": 286}	2026-08-29 16:44:35.221891+00
5	2	2	4	4	2	借力高级心法	元元子	元元子	xiaohongshu	\N	4	2026-08-26 02:41:56+00	\N	{"likes": 3814, "saves": 2204, "views": null, "shares": null, "comments": 111}	2026-08-29 16:44:35.221891+00
6	2	2	10	7	3	本J人被自己画的重庆地图满意到睡不着了	小野茶茶	小野茶茶	xiaohongshu	\N	10	2026-08-29 03:25:22+00	\N	{"likes": 611, "saves": 703, "views": null, "shares": null, "comments": 37}	2026-08-29 16:44:35.221891+00
7	2	2	9	6	4	不怕失去的底层安全感，怎么来的？	谢小树	谢小树	xiaohongshu	\N	9	2026-08-26 08:56:23+00	\N	{"likes": 624, "saves": 470, "views": null, "shares": null, "comments": 15}	2026-08-29 16:44:35.221891+00
\.


--
-- Data for Name: sample_comparison_scopes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_comparison_scopes (id, comparison_id, revision, status, topic_basis, purpose, input_sha256, created_by, created_at, completed_at) FROM stdin;
1	1	1	complete	测试	测试	ce2c5ee567dcebdf5e44df2cf1856521362e023eff5483569f796d644375aab0	1	2026-08-29 16:10:00.559637+00	2026-08-29 16:10:00.559637+00
2	2	1	complete	比较四篇作品在用户需求、标题机制、开头方式、核心观点、内容结构、视觉表达和行动引导上的差异，提取各自值得复用的局部元素，并观察点赞、收藏和评论数据的差别。不预设哪篇最好，不把互动差异解释为因果。	比较四篇作品在用户需求、标题机制、开头方式、核心观点、内容结构、视觉表达和行动引导上的差异，提取各自值得复用的局部元素，并观察点赞、收藏和评论数据的差别。不预设哪篇最好，不把互动差异解释为因果。	5a152698103459dd843a797ee0ea320590e93484bf146ce47927e7be6d98faea	1	2026-08-29 16:44:35.221891+00	2026-08-29 16:44:35.221891+00
\.


--
-- Data for Name: sample_comparison_snapshots; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_comparison_snapshots (id, comparison_id, scope_id, sample_id, analysis_version_id, element_id, dimension_key, latest_decision_id, effective_state, effective_value, function_text, applicability, limitations, evidence_state, evidence_tokens, value_sha256, created_at) FROM stdin;
1	1	1	5	5	69	argumentation_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
2	1	1	5	5	61	audience	\N	value	"针对在感情关系中遇到沟通困扰、怀疑对方有NPD倾向的人群，尤其是经历过分手或冲突的个体。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	9880fd51bbdf48d85bd696902c924aa936e8f2b48491be0725caaf8f309c51b7	2026-08-29 16:10:00.559637+00
3	1	1	5	5	74	bgm	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
4	1	1	5	5	65	breakout_point	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
5	1	1	5	5	68	content_structure	\N	value	"内容先提出识别NPD的绝招，然后举例对比正常人与NPD的提问方式，分析NPD的思维模式，最后介绍咨询师身份并引导互动。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	285625246850f30100d34527c5ca60ddb9c5760e372d378c38fcbb59fc8f6a30	2026-08-29 16:10:00.559637+00
6	1	1	5	5	64	core_viewpoint	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
7	1	1	5	5	75	cta	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
8	1	1	5	5	70	language_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
9	1	1	5	5	72	layout	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
10	1	1	5	5	71	length	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
11	1	1	5	5	67	opening_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
12	1	1	5	5	66	title_mechanism	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
13	1	1	5	5	63	topic	\N	value	"这条内容主要讲如何通过语言习惯识别自恋型人格障碍（NPD），并对比正常人与NPD在提问方式上的差异。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	17c9b8e06163dd745af6ad176647b6b57c30be4f9628e67a170c0f6bf931ab26	2026-08-29 16:10:00.559637+00
14	1	1	5	5	62	user_need	\N	value	"用户需要识别伴侣是否具有NPD特征，理解其行为背后的原因，并寻求关系修复或应对方法。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	754e98de03146311ad397a135a453a09e45dd8d42e8bcdb48052085450674935	2026-08-29 16:10:00.559637+00
15	1	1	5	5	73	visual_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
16	1	1	10	7	99	argumentation_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
17	1	1	10	7	91	audience	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
18	1	1	10	7	104	bgm	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
19	1	1	10	7	95	breakout_point	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
20	1	1	10	7	98	content_structure	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
21	1	1	10	7	94	core_viewpoint	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
22	1	1	10	7	105	cta	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
23	1	1	10	7	100	language_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
24	1	1	10	7	102	layout	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
25	1	1	10	7	101	length	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
26	1	1	10	7	97	opening_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
27	1	1	10	7	96	title_mechanism	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
28	1	1	10	7	93	topic	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
29	1	1	10	7	92	user_need	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
30	1	1	10	7	103	visual_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
31	1	1	4	4	54	argumentation_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
32	1	1	4	4	46	audience	\N	value	"针对那些习惯独自完成所有事情、追求全流程掌控、对'自学'和'自我完整'有偏执的人群，尤其是高认知但可能陷入单一路径成功经验的人。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	c6967997cca7c2e4dc24126481bc9fb7f28dc6ed270282a18c33cea1b56a36ff	2026-08-29 16:10:00.559637+00
33	1	1	4	4	59	bgm	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
34	1	1	4	4	50	breakout_point	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
35	1	1	4	4	53	content_structure	\N	value	"内容先定义问题（不会借力是自恋和懒惰），再分析心理根源（自我边界偏差、我执、工具性思维差），最后提出借力的高维心法（视角转变和利他共赢）。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	28d56ce21ad7167f94474a2cdc90200475ae2e40a105abf88b576efd544c84e5	2026-08-29 16:10:00.559637+00
36	1	1	4	4	49	core_viewpoint	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
37	1	1	4	4	60	cta	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
38	1	1	4	4	55	language_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
39	1	1	4	4	57	layout	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
40	1	1	4	4	56	length	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
41	1	1	4	4	52	opening_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
42	1	1	4	4	51	title_mechanism	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
43	1	1	4	4	48	topic	\N	value	"内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	c7ae3944d91c904e5d4619c4bcda1e290b08991443c647ecbe53f8057635fd8a	2026-08-29 16:10:00.559637+00
44	1	1	4	4	47	user_need	\N	value	"用户可能面临因过度依赖自身努力而导致的效率低下、精力消耗和人际孤立，需要学会借助外部资源和人脉来提升生命效率。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	fe740e09bfd749c5c8686bb3ee1dd9e9b128c9fe8190d6b079552aa76f474040	2026-08-29 16:10:00.559637+00
45	1	1	4	4	58	visual_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:10:00.559637+00
46	2	2	5	5	69	argumentation_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
47	2	2	5	5	61	audience	\N	value	"针对在感情关系中遇到沟通困扰、怀疑对方有NPD倾向的人群，尤其是经历过分手或冲突的个体。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	9880fd51bbdf48d85bd696902c924aa936e8f2b48491be0725caaf8f309c51b7	2026-08-29 16:44:35.221891+00
48	2	2	5	5	74	bgm	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
49	2	2	5	5	65	breakout_point	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
50	2	2	5	5	68	content_structure	\N	value	"内容先提出识别NPD的绝招，然后举例对比正常人与NPD的提问方式，分析NPD的思维模式，最后介绍咨询师身份并引导互动。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	285625246850f30100d34527c5ca60ddb9c5760e372d378c38fcbb59fc8f6a30	2026-08-29 16:44:35.221891+00
51	2	2	5	5	64	core_viewpoint	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
52	2	2	5	5	75	cta	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
53	2	2	5	5	70	language_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
54	2	2	5	5	72	layout	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
55	2	2	5	5	71	length	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
56	2	2	5	5	67	opening_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
57	2	2	5	5	66	title_mechanism	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
58	2	2	5	5	63	topic	\N	value	"这条内容主要讲如何通过语言习惯识别自恋型人格障碍（NPD），并对比正常人与NPD在提问方式上的差异。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	17c9b8e06163dd745af6ad176647b6b57c30be4f9628e67a170c0f6bf931ab26	2026-08-29 16:44:35.221891+00
59	2	2	5	5	62	user_need	\N	value	"用户需要识别伴侣是否具有NPD特征，理解其行为背后的原因，并寻求关系修复或应对方法。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	754e98de03146311ad397a135a453a09e45dd8d42e8bcdb48052085450674935	2026-08-29 16:44:35.221891+00
60	2	2	5	5	73	visual_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
61	2	2	4	4	54	argumentation_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
62	2	2	4	4	46	audience	\N	value	"针对那些习惯独自完成所有事情、追求全流程掌控、对'自学'和'自我完整'有偏执的人群，尤其是高认知但可能陷入单一路径成功经验的人。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	c6967997cca7c2e4dc24126481bc9fb7f28dc6ed270282a18c33cea1b56a36ff	2026-08-29 16:44:35.221891+00
63	2	2	4	4	59	bgm	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
64	2	2	4	4	50	breakout_point	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
65	2	2	4	4	53	content_structure	\N	value	"内容先定义问题（不会借力是自恋和懒惰），再分析心理根源（自我边界偏差、我执、工具性思维差），最后提出借力的高维心法（视角转变和利他共赢）。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	28d56ce21ad7167f94474a2cdc90200475ae2e40a105abf88b576efd544c84e5	2026-08-29 16:44:35.221891+00
66	2	2	4	4	49	core_viewpoint	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
67	2	2	4	4	60	cta	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
68	2	2	4	4	55	language_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
69	2	2	4	4	57	layout	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
70	2	2	4	4	56	length	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
71	2	2	4	4	52	opening_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
72	2	2	4	4	51	title_mechanism	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
73	2	2	4	4	48	topic	\N	value	"内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	c7ae3944d91c904e5d4619c4bcda1e290b08991443c647ecbe53f8057635fd8a	2026-08-29 16:44:35.221891+00
74	2	2	4	4	47	user_need	\N	value	"用户可能面临因过度依赖自身努力而导致的效率低下、精力消耗和人际孤立，需要学会借助外部资源和人脉来提升生命效率。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	fe740e09bfd749c5c8686bb3ee1dd9e9b128c9fe8190d6b079552aa76f474040	2026-08-29 16:44:35.221891+00
75	2	2	4	4	58	visual_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
76	2	2	10	7	99	argumentation_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
77	2	2	10	7	91	audience	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
78	2	2	10	7	104	bgm	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
79	2	2	10	7	95	breakout_point	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
80	2	2	10	7	98	content_structure	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
81	2	2	10	7	94	core_viewpoint	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
82	2	2	10	7	105	cta	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
83	2	2	10	7	100	language_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
84	2	2	10	7	102	layout	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
85	2	2	10	7	101	length	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
86	2	2	10	7	97	opening_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
87	2	2	10	7	96	title_mechanism	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
88	2	2	10	7	93	topic	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
89	2	2	10	7	92	user_need	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
90	2	2	10	7	103	visual_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
91	2	2	9	6	84	argumentation_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
92	2	2	9	6	76	audience	\N	value	"针对在亲密关系中缺乏安全感、容易患得患失的人群。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	97d0e641ab97d62afdd761642ac04cf2d067b04ab9318d093c39091e2a5fe714	2026-08-29 16:44:35.221891+00
93	2	2	9	6	89	bgm	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
94	2	2	9	6	80	breakout_point	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
95	2	2	9	6	83	content_structure	\N	value	"以提问式标题引入，正文未提供具体展开结构，可能以论述或案例形式说明。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	0bc75ba1b5b00180137b4ae1945875ffcaa777c1f44c3d57c2f7a7aa39f65572	2026-08-29 16:44:35.221891+00
96	2	2	9	6	79	core_viewpoint	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
97	2	2	9	6	90	cta	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
98	2	2	9	6	85	language_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
99	2	2	9	6	87	layout	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
100	2	2	9	6	86	length	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
101	2	2	9	6	82	opening_method	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
102	2	2	9	6	81	title_mechanism	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
103	2	2	9	6	78	topic	\N	value	"内容围绕亲密关系中'不怕失去的底层安全感'这一主题展开，探讨其来源。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	b0237fd223e66caaf0623f784b10873fed20c50294cc5cbaf65f8f190bcbb5c8	2026-08-29 16:44:35.221891+00
104	2	2	9	6	77	user_need	\N	value	"用户需要了解如何在亲密关系中建立不依赖对方、不惧失去的底层安全感。"	\N	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	insufficient	[]	8f54bc32b8f32d632c0e54efba5ef2a101f60ebd6c22569909b464650b00c556	2026-08-29 16:44:35.221891+00
105	2	2	9	6	88	visual_style	\N	insufficient	\N	\N	\N	\N	insufficient	[]	888c4e6226a2d39e29d3b7d2b048c94ca2c2580347bd5504043cb32d915cc4b0	2026-08-29 16:44:35.221891+00
\.


--
-- Data for Name: sample_comparisons; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_comparisons (id, title, purpose, created_by, created_at) FROM stdin;
1	cs	测试	1	2026-08-29 16:10:00.559637+00
2	四类知识型内容的标题与结构比较	比较四篇作品在用户需求、标题机制、开头方式、核心观点、内容结构、视觉表达和行动引导上的差异，提取各自值得复用的局部元素，并观察点赞、收藏和评论数据的差别。不预设哪篇最好，不把互动差异解释为因果。	1	2026-08-29 16:44:35.221891+00
\.


--
-- Data for Name: sample_element_decisions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_element_decisions (id, element_id, decision, value_json, function_text, applicability, limitations, note, idempotency_key, decided_by, created_at) FROM stdin;
\.


--
-- Data for Name: sample_element_evidence; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_element_evidence (id, version_id, element_id, source_id, verification_status, quote_text, quote_sha256, start_offset, end_offset, time_start_ms, time_end_ms, json_path, comment_ref, created_at) FROM stdin;
\.


--
-- Data for Name: sample_element_extraction_sources; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_element_extraction_sources (id, extraction_id, extraction_dimension_key, comparison_id, scope_id, sample_id, snapshot_id, snapshot_dimension_key, source_role, note, created_at) FROM stdin;
\.


--
-- Data for Name: sample_element_extractions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_element_extractions (id, comparison_id, scope_id, assessment_id, dimension_key, origin, status, pattern_text, function_text, rationale, applicability, limitations, do_not_copy, created_by, created_at, completed_at) FROM stdin;
\.


--
-- Data for Name: sample_element_tag_observations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_element_tag_observations (id, sample_id, analysis_version_id, element_id, dimension_key, tag_id, state, note, idempotency_key, request_sha256, observed_by, observer_role, created_at) FROM stdin;
\.


--
-- Data for Name: sample_element_tags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_element_tags (id, version_id, element_id, dimension_key, tag_id, origin, confidence, idempotency_key, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: sample_evaluations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_evaluations (id, sample_id, analysis_version_id, target, source, revision, summary, strengths, weaknesses, worth_learning, avoid_copying, effect_hypotheses, evidence_source_ids, confidence, input_sha256, prompt_version, model_provider, model_name, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: sample_evidence_sources; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_evidence_sources (id, version_id, sample_id, source_capture_id, asset_id, source_id, source_kind, locator, content_sha256, content_length, display_label, created_at) FROM stdin;
1	8	5	5	\N	metadata:de44b50248d1472e41f0	metadata	{"pointer": "capture.normalized_payload.title", "semanticKind": "metadata"}	9220495f476488ec4f83a98a2f377cfaa085ee5cc53e94f2e36fe0a1d6fdaaad	14	标题	2026-08-29 16:50:46.292842+00
2	8	5	5	\N	metadata:912aeaa06755016bef44	metadata	{"pointer": "sample.account", "semanticKind": "metadata"}	bb27fe9690e467d3f6dc359dcf4fe38896f823b5e2a876a9d34b6811485d849e	11	账号	2026-08-29 16:50:46.292842+00
3	8	5	5	\N	metadata:d488db50059d1cbc1a9a	metadata	{"pointer": "sample.metrics", "semanticKind": "metadata"}	5eddb8ce0c06e42cecbe3ee56900b49695d3135e21fb43fcdc17c84f227e93c5	78	互动数据	2026-08-29 16:50:46.292842+00
4	8	5	5	\N	body:08877672bc2b445605eb	body	{"pointer": "capture.normalized_payload.bodyText#char=0-241", "semanticKind": "body"}	bfc9f07edd2994e07f15a8379df022a9a26b390860e74ea1888cbb650a976e8f	241	正文段落	2026-08-29 16:50:46.292842+00
5	8	5	5	\N	body:dff63029c64df3fbb196	body	{"pointer": "capture.normalized_payload.bodyText#char=243-450", "semanticKind": "body"}	eba6b74517054c92320fb4d6ccc1e827a17fa19a5cea04f07d2c17ac926e4652	207	正文段落	2026-08-29 16:50:46.292842+00
6	8	5	5	\N	body:e3d0979d8445836f5726	body	{"pointer": "capture.normalized_payload.bodyText#char=452-589", "semanticKind": "body"}	830df1419c5cf56801138547cf7a4218056060fe0316c72649acf1a1057111c7	137	正文段落	2026-08-29 16:50:46.292842+00
7	8	5	5	\N	body:a93eaf8d025cbda3254b	body	{"pointer": "capture.normalized_payload.bodyText#char=591-769", "semanticKind": "body"}	998f10c5fcf3b50c832c07cac5f6de7362b90d68b82b66a4245607d92c0b92b4	178	正文段落	2026-08-29 16:50:46.292842+00
8	8	5	5	\N	body:f48f643144acd0953abc	body	{"pointer": "capture.normalized_payload.bodyText#char=771-937", "semanticKind": "body"}	5c6a6e911ce909bc171e34e12c6b30a1c386cd347a71e95529fd256efa3bf992	166	正文段落	2026-08-29 16:50:46.292842+00
9	8	5	5	\N	body:dc98f42cdb037179cb8a	body	{"pointer": "capture.normalized_payload.bodyText#char=939-1105", "semanticKind": "body"}	ca15dd0f9932ec7e11d1307bacf2ea866e647b4935a4fc1eeb49e9e91189af84	166	正文段落	2026-08-29 16:50:46.292842+00
10	8	5	5	\N	body:5e08a955832123cfd7f6	body	{"pointer": "capture.normalized_payload.bodyText#char=1107-1298", "semanticKind": "body"}	f2e3c060178e708c75516752e4b3617b8f1c5619577c219143eabed121c351ee	191	正文段落	2026-08-29 16:50:46.292842+00
11	8	5	5	\N	body:fc8f3666e440108fd99b	body	{"pointer": "capture.normalized_payload.bodyText#char=1300-1543", "semanticKind": "body"}	8e28877a57b4761938a54f98be106db4f1cf071742f795c8fc9e203f4b5bb1dd	243	正文段落	2026-08-29 16:50:46.292842+00
12	8	5	5	\N	body:9ec899b28f011bf95c61	body	{"pointer": "capture.normalized_payload.bodyText#char=1545-1735", "semanticKind": "body"}	ee8bbae69998a1b33591eac4e8800a648a098c2d195da44e032cadd68028e23e	190	正文段落	2026-08-29 16:50:46.292842+00
13	8	5	5	\N	ocr:734e6f709464142c98af	ocr	{"pointer": "capture.raw_payload.images[0].text", "jsonPath": "$.images[0].text", "semanticKind": "ocr"}	eba6b74517054c92320fb4d6ccc1e827a17fa19a5cea04f07d2c17ac926e4652	207	第 1 张图 OCR	2026-08-29 16:50:46.292842+00
14	8	5	5	\N	ocr:47782bea8083cdc3de0a	ocr	{"pointer": "capture.raw_payload.images[1].text", "jsonPath": "$.images[1].text", "semanticKind": "ocr"}	830df1419c5cf56801138547cf7a4218056060fe0316c72649acf1a1057111c7	137	第 2 张图 OCR	2026-08-29 16:50:46.292842+00
15	8	5	5	\N	ocr:839aa5b6aed65ecae882	ocr	{"pointer": "capture.raw_payload.images[2].text", "jsonPath": "$.images[2].text", "semanticKind": "ocr"}	998f10c5fcf3b50c832c07cac5f6de7362b90d68b82b66a4245607d92c0b92b4	178	第 3 张图 OCR	2026-08-29 16:50:46.292842+00
16	8	5	5	\N	ocr:9370a0ce4dd75ff54c11	ocr	{"pointer": "capture.raw_payload.images[3].text", "jsonPath": "$.images[3].text", "semanticKind": "ocr"}	5c6a6e911ce909bc171e34e12c6b30a1c386cd347a71e95529fd256efa3bf992	166	第 4 张图 OCR	2026-08-29 16:50:46.292842+00
17	8	5	5	\N	ocr:fb3de3dce1f270bbe99c	ocr	{"pointer": "capture.raw_payload.images[4].text", "jsonPath": "$.images[4].text", "semanticKind": "ocr"}	ca15dd0f9932ec7e11d1307bacf2ea866e647b4935a4fc1eeb49e9e91189af84	166	第 5 张图 OCR	2026-08-29 16:50:46.292842+00
18	8	5	5	\N	ocr:8af547daa50e7a991919	ocr	{"pointer": "capture.raw_payload.images[5].text", "jsonPath": "$.images[5].text", "semanticKind": "ocr"}	f2e3c060178e708c75516752e4b3617b8f1c5619577c219143eabed121c351ee	191	第 6 张图 OCR	2026-08-29 16:50:46.292842+00
19	8	5	5	\N	ocr:98a3f6b6f99e07beca75	ocr	{"pointer": "capture.raw_payload.images[6].text", "jsonPath": "$.images[6].text", "semanticKind": "ocr"}	8e28877a57b4761938a54f98be106db4f1cf071742f795c8fc9e203f4b5bb1dd	243	第 7 张图 OCR	2026-08-29 16:50:46.292842+00
20	8	5	5	\N	ocr:54981406c8d5fe6ce380	ocr	{"pointer": "capture.raw_payload.images[7].text", "jsonPath": "$.images[7].text", "semanticKind": "ocr"}	ee8bbae69998a1b33591eac4e8800a648a098c2d195da44e032cadd68028e23e	190	第 8 张图 OCR	2026-08-29 16:50:46.292842+00
21	8	5	5	\N	comment:74a5411e454f726d9566	comment	{"pointer": "capture.raw_payload.comments[0].text", "jsonPath": "$.comments[0].text", "commentRef": "6a72cbc6000000002901b106", "semanticKind": "comment"}	97012cc027297bac3bf59515d288e72b89c59bcef79dd91df46df308823ac891	17	评论 1	2026-08-29 16:50:46.292842+00
22	8	5	5	\N	comment:8ef5e7f4df2236e35198	comment	{"pointer": "capture.raw_payload.comments[1].text", "jsonPath": "$.comments[1].text", "commentRef": "6a6f0f5800000000150176b2", "semanticKind": "comment"}	91602e7e178e6f9b54e136959dc5806bafcaf93700598135488f27a9320a6d21	23	评论 2	2026-08-29 16:50:46.292842+00
23	8	5	5	\N	comment:a78a8396836e5598d9a4	comment	{"pointer": "capture.raw_payload.comments[2].text", "jsonPath": "$.comments[2].text", "commentRef": "6a721851000000002a02fe66", "semanticKind": "comment"}	1b31a34e322c467702b3ae1aa490eaacef9a1addd1c97831aef602179947e804	11	评论 3	2026-08-29 16:50:46.292842+00
24	8	5	5	\N	comment:3b49f140a247be1114dd	comment	{"pointer": "capture.raw_payload.comments[3].text", "jsonPath": "$.comments[3].text", "commentRef": "6a70d570000000000403afdf", "semanticKind": "comment"}	4745d831d8b74b016b722cd9b87fc0eb1ae02b668b1a86070e65ec0aec1d5db7	37	评论 4	2026-08-29 16:50:46.292842+00
25	8	5	5	\N	comment:9069fe7e8fce6c68b44a	comment	{"pointer": "capture.raw_payload.comments[4].text", "jsonPath": "$.comments[4].text", "commentRef": "6a6eb60c0000000015015722", "semanticKind": "comment"}	97bb77474407946fab2f630099473145327b6eb2203e8454660290a59b7070c0	31	评论 5	2026-08-29 16:50:46.292842+00
26	8	5	5	6	asset_metadata:6c526c869038ebace80e	asset	{"pointer": "sample_assets[id=6]", "semanticKind": "asset_metadata"}	efe3c43047acd87cfeb19a16deb9232afc796528a6de0a48c8b1ec5f9f285129	18	cover资产元数据	2026-08-29 16:50:46.292842+00
27	8	5	5	7	asset_metadata:205b9acd6785d03f6438	asset	{"pointer": "sample_assets[id=7]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 16:50:46.292842+00
28	8	5	5	8	asset_metadata:f4345072695c9871c642	asset	{"pointer": "sample_assets[id=8]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 16:50:46.292842+00
29	8	5	5	9	asset_metadata:b4d1dfaaf3821a3e2df4	asset	{"pointer": "sample_assets[id=9]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 16:50:46.292842+00
30	8	5	5	10	asset_metadata:510ee9acede6029cd7b2	asset	{"pointer": "sample_assets[id=10]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 16:50:46.292842+00
31	8	5	5	11	asset_metadata:b28c4ed0529db7e0a853	asset	{"pointer": "sample_assets[id=11]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 16:50:46.292842+00
32	8	5	5	12	asset_metadata:0c0b407810217a6bdbfa	asset	{"pointer": "sample_assets[id=12]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 16:50:46.292842+00
33	8	5	5	13	asset_metadata:2a6eeb815e7cb78706e1	asset	{"pointer": "sample_assets[id=13]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 16:50:46.292842+00
34	8	5	5	14	asset_metadata:cbdee23e504f697f9bfd	asset	{"pointer": "sample_assets[id=14]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 16:50:46.292842+00
35	9	10	10	\N	metadata:ee6aea01fba92b9ce45d	metadata	{"pointer": "capture.normalized_payload.title", "semanticKind": "metadata"}	5aac43af81a935aa76f502c2f93fd976cd5ad5d8d9e35cbbd93c24b131894bc3	19	标题	2026-08-29 17:45:50.511712+00
36	9	10	10	\N	metadata:06a57daa287c8dd4155c	metadata	{"pointer": "sample.account", "semanticKind": "metadata"}	2dd9f0f11effdb6606c0bee7b1d78ecdd19e946c06b372ef67b9ff394d474d1b	11	账号	2026-08-29 17:45:50.511712+00
37	9	10	10	\N	metadata:5964f466686023389436	metadata	{"pointer": "sample.metrics", "semanticKind": "metadata"}	efcf8ad61e83ddb76d13fd5635998e6c36454510421439995b35f3f6e6debd90	74	互动数据	2026-08-29 17:45:50.511712+00
38	9	10	10	\N	body:5bbb2af7ef0bb274883f	body	{"pointer": "capture.normalized_payload.bodyText#char=0-650", "semanticKind": "body"}	a57ddda67c0237dfd7a75242e3baf2f30f75e1f963f8c6e494d55bd007c2f157	650	正文段落	2026-08-29 17:45:50.511712+00
39	9	10	10	\N	body:02a5508d85746fa0a527	body	{"pointer": "capture.normalized_payload.bodyText#char=652-1575", "semanticKind": "body"}	be608ed7acf37bff431e93e211395974d5754068b5cd4378953ddccc0eb54a69	923	正文段落	2026-08-29 17:45:50.511712+00
40	9	10	10	\N	body:396e94a669c535e2d7e5	body	{"pointer": "capture.normalized_payload.bodyText#char=1577-1764", "semanticKind": "body"}	6ebfbd8a6fa2710d3a481874f358773999cc1626292dd9ee421fb31aa068719b	187	正文段落	2026-08-29 17:45:50.511712+00
41	9	10	10	\N	body:6cfe21a42d072098f6be	body	{"pointer": "capture.normalized_payload.bodyText#char=1766-2089", "semanticKind": "body"}	0985f74cd4f3bc826d4849af0cf1280a235721189c5fc50b98b87c83253da456	323	正文段落	2026-08-29 17:45:50.511712+00
42	9	10	10	\N	body:22da7ed97d3406d758b4	body	{"pointer": "capture.normalized_payload.bodyText#char=2091-2350", "semanticKind": "body"}	933bc526f6a9e366f073b473d3139917c08afc39f316e0c7b4ecf7d8f73ea3da	259	正文段落	2026-08-29 17:45:50.511712+00
43	9	10	10	\N	body:6d37a232c880674e46fb	body	{"pointer": "capture.normalized_payload.bodyText#char=2352-2671", "semanticKind": "body"}	2ba19c7a4fc843e57d4fb20a520e374b833a8f6063b5486eed15a2d8a2ac9d8a	319	正文段落	2026-08-29 17:45:50.511712+00
44	9	10	10	\N	body:535723ba7fea5afde2ba	body	{"pointer": "capture.normalized_payload.bodyText#char=2673-3016", "semanticKind": "body"}	91e5b7349163a902751c462408d9be8feaa71dc956d1dbcb4c3eb70829103d73	343	正文段落	2026-08-29 17:45:50.511712+00
45	9	10	10	\N	body:f533b433b6b819278ddd	body	{"pointer": "capture.normalized_payload.bodyText#char=3018-3799", "semanticKind": "body"}	830cde16b9d788985caad6f239d51b55f61fce1e69bbb2926b3c0b006da51eee	781	正文段落	2026-08-29 17:45:50.511712+00
46	9	10	10	\N	body:1b7c42e9872994a647a5	body	{"pointer": "capture.normalized_payload.bodyText#char=3801-4043", "semanticKind": "body"}	da59bc1f68c66726eac72b664d5b2813c68ca5809329f7cc6006cfa0ff9d142a	242	正文段落	2026-08-29 17:45:50.511712+00
47	9	10	10	\N	body:f8273b5c42c4fcb09731	body	{"pointer": "capture.normalized_payload.bodyText#char=4045-4048", "semanticKind": "body"}	d26c6a08a591011a3bf644f19678e44e102f8303afe1c15447109b24dc70d58f	3	正文段落	2026-08-29 17:45:50.511712+00
48	9	10	10	\N	ocr:e533bbed8211829b8502	ocr	{"pointer": "capture.raw_payload.images[0].text", "jsonPath": "$.images[0].text", "semanticKind": "ocr"}	6ebfbd8a6fa2710d3a481874f358773999cc1626292dd9ee421fb31aa068719b	187	第 1 张图 OCR	2026-08-29 17:45:50.511712+00
49	9	10	10	\N	ocr:e43a59cb897d740408d2	ocr	{"pointer": "capture.raw_payload.images[1].text", "jsonPath": "$.images[1].text", "semanticKind": "ocr"}	0985f74cd4f3bc826d4849af0cf1280a235721189c5fc50b98b87c83253da456	323	第 2 张图 OCR	2026-08-29 17:45:50.511712+00
50	9	10	10	\N	ocr:16b3993d4f619f0022d7	ocr	{"pointer": "capture.raw_payload.images[2].text", "jsonPath": "$.images[2].text", "semanticKind": "ocr"}	933bc526f6a9e366f073b473d3139917c08afc39f316e0c7b4ecf7d8f73ea3da	259	第 3 张图 OCR	2026-08-29 17:45:50.511712+00
51	9	10	10	\N	ocr:a9d92e427f3648505230	ocr	{"pointer": "capture.raw_payload.images[3].text", "jsonPath": "$.images[3].text", "semanticKind": "ocr"}	2ba19c7a4fc843e57d4fb20a520e374b833a8f6063b5486eed15a2d8a2ac9d8a	319	第 4 张图 OCR	2026-08-29 17:45:50.511712+00
52	9	10	10	\N	ocr:4fb8b7e993d27802a9ff	ocr	{"pointer": "capture.raw_payload.images[4].text", "jsonPath": "$.images[4].text", "semanticKind": "ocr"}	91e5b7349163a902751c462408d9be8feaa71dc956d1dbcb4c3eb70829103d73	343	第 5 张图 OCR	2026-08-29 17:45:50.511712+00
53	9	10	10	\N	ocr:0387ae23a2ef5469f9c7	ocr	{"pointer": "capture.raw_payload.images[5].text", "jsonPath": "$.images[5].text", "semanticKind": "ocr"}	830cde16b9d788985caad6f239d51b55f61fce1e69bbb2926b3c0b006da51eee	781	第 6 张图 OCR	2026-08-29 17:45:50.511712+00
54	9	10	10	\N	ocr:d4564a41090887233c47	ocr	{"pointer": "capture.raw_payload.images[6].text", "jsonPath": "$.images[6].text", "semanticKind": "ocr"}	da59bc1f68c66726eac72b664d5b2813c68ca5809329f7cc6006cfa0ff9d142a	242	第 7 张图 OCR	2026-08-29 17:45:50.511712+00
55	9	10	10	\N	ocr:5165a6fceed15f0a4417	ocr	{"pointer": "capture.raw_payload.images[7].text", "jsonPath": "$.images[7].text", "semanticKind": "ocr"}	d26c6a08a591011a3bf644f19678e44e102f8303afe1c15447109b24dc70d58f	3	第 8 张图 OCR	2026-08-29 17:45:50.511712+00
56	9	10	10	29	asset_metadata:4ca73015bf3fef088639	asset	{"pointer": "sample_assets[id=29]", "semanticKind": "asset_metadata"}	efe3c43047acd87cfeb19a16deb9232afc796528a6de0a48c8b1ec5f9f285129	18	cover资产元数据	2026-08-29 17:45:50.511712+00
57	9	10	10	30	asset_metadata:d85f1fe3a8d3a99da939	asset	{"pointer": "sample_assets[id=30]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 17:45:50.511712+00
58	9	10	10	31	asset_metadata:5a354bea7c18c3fa0378	asset	{"pointer": "sample_assets[id=31]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 17:45:50.511712+00
59	9	10	10	32	asset_metadata:490dd86777e1d5d59e86	asset	{"pointer": "sample_assets[id=32]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 17:45:50.511712+00
60	9	10	10	33	asset_metadata:19dc7944c66896254694	asset	{"pointer": "sample_assets[id=33]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 17:45:50.511712+00
61	9	10	10	34	asset_metadata:05d5b087fe454f00bbc5	asset	{"pointer": "sample_assets[id=34]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 17:45:50.511712+00
62	9	10	10	35	asset_metadata:985e7f025800f3a3e853	asset	{"pointer": "sample_assets[id=35]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 17:45:50.511712+00
63	9	10	10	36	asset_metadata:207ae28ecdfa64d9bc3b	asset	{"pointer": "sample_assets[id=36]", "semanticKind": "asset_metadata"}	8f5c531046bc6173b259204d87905b17d6a9ff44bd2f0cd9b317e6d962009253	18	image资产元数据	2026-08-29 17:45:50.511712+00
64	9	10	10	37	asset_metadata:9cf8a684d88e056840c3	asset	{"pointer": "sample_assets[id=37]", "semanticKind": "asset_metadata"}	ba2aa35325128b8d4cfedf5670d74a9c2d78ebe3540a1d15b75c5887729ebe71	17	image资产元数据	2026-08-29 17:45:50.511712+00
\.


--
-- Data for Name: sample_insight_run_features; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_insight_run_features (id, run_id, member_id, sample_id, analysis_version_id, feature_key, feature_type, dimension_key, tag_ids, tag_id, state, element_id, observation_id, element_tag_id, source, frozen_label, created_at) FROM stdin;
\.


--
-- Data for Name: sample_insight_run_members; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_insight_run_members (id, run_id, sample_id, analysis_version_id, metric_snapshot_id, account_key, account_key_quality, frozen_title, frozen_platform, frozen_published_at, frozen_metric_observed_at, observation_seconds, outcome_state, outcome_value, exclusion_reason, created_at) FROM stdin;
\.


--
-- Data for Name: sample_insight_runs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_insight_runs (id, name, status, idempotency_key, request_sha256, manifest_sha256, normalized_request, platform, goal, outcome_metric, outcome_transform, analysis_trust, cutoff_at, requested_by, attempts, max_attempts, lease_owner, lease_expires_at, heartbeat_at, eligible_count, outcome_observed_count, feature_observed_count, warnings, exclusion_counts, error_code, error_message, created_at, started_at, completed_at) FROM stdin;
\.


--
-- Data for Name: sample_insight_statistics; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_insight_statistics (id, run_id, feature_key, feature_type, dimension_key, frozen_label, reliability, n_eligible, n_outcome_observed, n_feature_observed, n_observed, n_present, n_absent, unique_accounts, outcome_coverage, feature_coverage, present_median, present_q1, present_q3, absent_median, absent_q1, absent_q3, median_difference, cliffs_delta, median_difference_ci_low, median_difference_ci_high, cliffs_delta_ci_low, cliffs_delta_ci_high, direction, limitation, created_at) FROM stdin;
\.


--
-- Data for Name: sample_metric_snapshots; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_metric_snapshots (id, sample_id, capture_id, snapshot_key, observed_at, likes, saves, comments, shares, views, raw_metrics, parse_warnings, created_by, created_at) FROM stdin;
1	1	1	capture:1	2026-08-26 02:42:00+00	1399	922	37	\N	\N	{"likes": "1399", "collects": "922", "comments": "37"}	{}	\N	2026-08-29 15:30:14.62148+00
2	2	2	capture:2	2026-08-25 10:01:50+00	784	349	75	\N	\N	{"likes": "784", "collects": "349", "comments": "75"}	{}	\N	2026-08-29 15:30:14.64262+00
3	3	3	capture:3	2026-08-26 02:41:06+00	161	205	7	\N	\N	{"likes": "161", "collects": "205", "comments": "7"}	{}	\N	2026-08-29 15:30:14.646311+00
4	4	4	capture:4	2026-08-26 02:41:56+00	3814	2204	111	\N	\N	{"likes": "3814", "collects": "2204", "comments": "111"}	{}	\N	2026-08-29 15:30:14.649313+00
5	5	5	capture:5	2026-08-26 02:42:03+00	1295	951	286	\N	\N	{"likes": "1295", "collects": "951", "comments": "286"}	{}	\N	2026-08-29 15:30:14.652098+00
6	5	6	capture:6	2026-08-26 02:41:01+00	1295	951	286	\N	\N	{"likes": "1295", "collects": "951", "comments": "286"}	{}	\N	2026-08-29 15:30:14.655376+00
7	4	7	capture:7	2026-08-26 02:41:04+00	3814	2204	111	\N	\N	{"likes": "3814", "collects": "2204", "comments": "111"}	{}	\N	2026-08-29 15:30:14.658455+00
8	3	8	capture:8	2026-08-26 02:41:58+00	161	205	7	\N	\N	{"likes": "161", "collects": "205", "comments": "7"}	{}	\N	2026-08-29 15:30:14.661613+00
9	9	9	capture:9	2026-08-26 08:56:23+00	624	470	15	\N	\N	{"likes": "624", "collects": "470", "comments": "15"}	{}	\N	2026-08-29 15:30:14.664394+00
10	10	10	capture:10	2026-08-29 03:25:22+00	611	703	37	\N	\N	{"likes": "611", "collects": "703", "comments": "37"}	{}	\N	2026-08-29 15:30:14.668023+00
\.


--
-- Data for Name: sample_relation_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_relation_events (id, relation_id, event_type, reason, actor_id, actor_role, superseded_by_relation_id, created_at) FROM stdin;
\.


--
-- Data for Name: sample_relation_evidence; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_relation_evidence (id, relation_id, subject_sample_id, subject_analysis_version_id, object_sample_id, object_analysis_version_id, endpoint_sample_id, endpoint_analysis_version_id, element_evidence_id, note, added_by, created_at) FROM stdin;
\.


--
-- Data for Name: sample_relations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_relations (id, relation_type, subject_sample_id, subject_analysis_version_id, object_sample_id, object_analysis_version_id, origin, current_state, rationale, proposed_by, created_at) FROM stdin;
\.


--
-- Data for Name: sample_retrieval_algorithm_selections; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_retrieval_algorithm_selections (id, algorithm_id, build_id, reason, selected_by, created_at) FROM stdin;
1	1	1	build_success	1	2026-08-29 15:47:02.274886+00
\.


--
-- Data for Name: sample_retrieval_algorithms; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_retrieval_algorithms (id, algorithm_version, tokenizer_version, mapping_version, vector_size, config, config_sha256, created_at) FROM stdin;
1	fh15-q15/1	zhmix/1	retrieve-map/1	256	{"dimensions": ["audience", "user_need", "topic", "core_viewpoint", "breakout_point", "title_mechanism", "opening_method", "content_structure", "argumentation_method", "language_style", "length", "layout", "visual_style", "bgm", "cta"], "vectorSize": 256}	447a3af3ee0be58107bbcf0eec5ec48dbb9edb11d01f79f77ffbbbb7848e1d11	2026-08-29 15:47:02.215708+00
\.


--
-- Data for Name: sample_retrieval_build_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_retrieval_build_items (id, build_id, subject_kind, sample_id, component_id, status, profile_id, exclusion_code, error_code, error_message, created_at, finished_at) FROM stdin;
1	1	sample	1	\N	succeeded	1	\N	\N	\N	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
2	1	sample	2	\N	succeeded	2	\N	\N	\N	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
3	1	sample	3	\N	succeeded	3	\N	\N	\N	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
4	1	sample	4	\N	succeeded	4	\N	\N	\N	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
5	1	sample	5	\N	succeeded	5	\N	\N	\N	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
6	1	sample	9	\N	succeeded	6	\N	\N	\N	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
7	1	sample	10	\N	succeeded	7	\N	\N	\N	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
\.


--
-- Data for Name: sample_retrieval_builds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_retrieval_builds (id, algorithm_id, status, idempotency_key, request_sha256, requested_by, attempts, max_attempts, lease_owner, lease_expires_at, heartbeat_at, eligible_count, succeeded_count, excluded_count, failed_count, error_code, error_message, created_at, started_at, finished_at) FROM stdin;
1	1	succeeded	initial-reindex-stage4-857bb94	44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a	1	1	3	\N	\N	2026-08-29 15:47:02.244117+00	7	7	0	0	\N	\N	2026-08-29 15:47:02.215708+00	2026-08-29 15:47:02.244117+00	2026-08-29 15:47:02.274886+00
\.


--
-- Data for Name: sample_retrieval_dimension_vectors; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_retrieval_dimension_vectors (id, profile_id, sample_id, analysis_version_id, element_id, dimension_key, decision_id, vector, norm_sq, nonzero_count, simhash, band_0, band_1, band_2, band_3, band_4, band_5, band_6, band_7, source, decision_state, confidence, evidence_strength, effective_summary, applicability, limitations, frozen_tags, created_at) FROM stdin;
1	1	1	2	24	argumentation_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
2	1	1	2	16	audience	\N	{0,0,0,4221,0,0,0,0,0,0,0,0,0,0,0,-4221,0,0,0,0,0,-4221,0,-4221,0,0,0,0,0,0,0,0,4221,0,4221,0,0,0,0,0,-4221,0,0,-4221,0,4221,0,0,0,0,0,0,4221,0,0,0,0,-4221,0,4221,0,0,0,0,0,0,0,0,-8441,0,0,0,0,0,0,0,0,0,-4221,0,-4221,0,4221,0,0,0,0,0,0,0,0,0,0,4221,0,0,0,0,0,4221,0,0,0,0,0,0,4221,0,0,0,0,0,-8441,4221,0,0,0,0,0,0,0,0,0,0,0,0,0,-4221,0,0,0,-4221,0,0,0,0,4221,4221,4221,0,4221,0,0,0,-4221,0,0,0,4221,0,0,0,0,4221,0,0,0,-4221,0,0,-4221,0,0,0,0,0,0,0,0,0,0,0,-4221,4221,0,0,0,0,0,0,4221,0,0,0,-4221,0,0,0,0,0,-4221,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-4221,0,0,0,0,0,-8858,0,0,0,0,0,0,0,0,-4221,0,0,0,0,-7146,0,0,0,0,-4221,0,0,-4221,0,0,0,0,0,0,0,-4221,0,0,0,-4221,0,-4221,0,-4221,4221,0,-4221,0}	1073788287	49	0111110111000111100000110010001001111110100010000000011110101111	125	199	131	34	126	136	7	175	legacy	\N	\N	none	针对在职场或人际关系中感到焦虑、想提升个人吸引力或情绪管理能力的人群。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
3	1	1	2	29	bgm	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
4	1	1	2	20	breakout_point	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
5	1	1	2	23	content_structure	\N	{0,0,0,0,0,0,-6655,0,-3327,3327,0,0,0,0,-3327,0,-2306,0,0,0,0,-3327,0,0,0,0,0,0,0,0,-3327,0,-3327,0,0,0,0,3327,0,0,3327,-3327,0,0,0,0,0,-3327,3327,0,3327,0,0,-3327,-3327,-3327,0,0,0,3327,-3327,0,0,0,0,0,3327,0,0,0,0,0,0,0,-8961,0,0,0,3327,0,0,0,0,-3327,-5634,-3327,3327,0,0,-8961,3327,0,0,0,0,0,0,0,0,-3327,0,-3327,0,0,-3327,0,0,3327,0,-3327,0,0,0,0,0,0,0,0,-3327,0,-5634,0,0,0,-3327,0,0,3327,0,-3327,0,-3327,0,0,0,0,0,0,3327,0,3327,0,0,-3327,0,0,0,0,0,0,0,3327,3327,3327,0,0,0,0,-3327,0,0,0,3327,0,0,0,0,0,-3327,-3327,0,0,0,0,0,0,0,3327,0,0,0,0,0,0,0,0,0,0,0,0,3327,3327,-3327,0,0,-3327,0,0,0,-3327,0,0,0,-3327,0,3327,0,0,0,3327,3327,0,0,-3327,3327,3327,0,3327,0,0,0,0,0,0,0,0,0,0,0,0,3327,0,0,0,0,6655,0,0,-8961,0,0,0,0,0,0,0,0,0,0,-3327,3327,0,0,0,0,-3327}	1073482830	69	1001011010000000011110110011001110010000100100001001110101001001	150	128	123	51	144	144	157	73	legacy	\N	\N	none	内容先提出核心观点，引用道德经解释，然后分两个要点展开：淡定的本质是不在乎，淡定是内在状态而非伪装，最后总结魅力是做减法。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
6	1	1	2	19	core_viewpoint	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
7	1	1	2	30	cta	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
8	1	1	2	25	language_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
9	1	1	2	27	layout	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
10	1	1	2	26	length	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
11	1	1	2	22	opening_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
12	1	1	2	21	title_mechanism	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
13	1	1	2	18	topic	\N	{0,4360,4360,0,0,-4360,-4360,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4360,0,4360,0,0,0,4360,0,4360,0,0,0,0,0,0,-4360,0,0,0,0,0,0,0,4360,0,-4360,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4360,0,0,4360,0,0,0,-4360,0,0,0,0,4360,0,0,0,0,0,4360,0,-4360,-4360,0,0,0,0,0,4360,0,0,0,-4360,-8720,0,4360,0,0,-4360,0,0,4360,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-4360,0,0,0,0,0,0,0,0,0,0,0,0,4360,-4360,4360,-4360,-4360,0,0,0,0,0,0,0,0,0,0,0,8720,0,0,0,0,0,0,0,0,0,0,0,-4360,0,0,0,0,0,0,0,0,-4360,0,0,0,4360,0,0,0,0,0,0,0,3022,0,4360,0,0,0,0,4360,0,0,0,0,0,0,0,0,0,-4360,0,0,0,0,0,0,0,0,0,-4360,-4360,0,0,0,-4360,-4360,4360,-4360,4360,0,0,0,0,4360,0,0,4360,0,4360,0,0,0,0,0,0,0,0,-4360,0,0,0,0,4360,4360,0,0}	1073670084	51	0010010001100000100100101101111100101110010100011010101011011000	36	96	146	223	46	81	170	216	legacy	\N	\N	none	这条内容主要讲‘顶级吸引力’来自淡定、克制和无为，而非刻意展示或用力抓取。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
14	1	1	2	17	user_need	\N	{0,0,-4069,0,0,-4069,0,0,0,0,0,0,0,0,-4069,0,0,0,4069,0,0,0,0,0,0,4069,0,0,0,0,0,0,0,0,0,0,0,0,0,-4069,0,0,4069,0,0,0,0,4069,0,-8138,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4069,0,0,0,0,0,4069,0,0,0,0,0,-8138,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4069,0,0,4069,0,0,0,0,0,0,-4069,0,0,0,4069,0,0,0,0,0,0,0,0,0,0,4069,0,-4069,-4069,0,0,0,0,0,0,0,-4069,0,4069,4069,0,0,0,0,-4069,0,0,0,0,0,-4069,0,0,0,4069,0,0,0,-6889,4069,0,0,-4069,0,0,0,0,0,0,0,0,-4069,-4069,-4069,-4069,0,0,0,0,0,0,0,4069,0,0,0,0,0,0,0,0,0,0,4069,0,0,4069,0,0,0,0,0,0,-4069,0,0,0,0,0,0,0,0,0,0,0,-4069,0,0,0,0,0,0,0,0,4069,0,0,0,-6889,0,0,0,0,0,4069,0,0,4069,4069,0,0,-4069,0,-6889,0,0,4069,-4069,0,0,0,0,10958,0,0,0,0,0,0,0}	1073734016	47	0111110001111111010000110000110000011100011011010110111101011010	124	127	67	12	28	109	111	90	legacy	\N	\N	none	用户可能希望解决在关系或职场中过度用力、患得患失，导致失去主动权或吸引力的问题。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
15	1	1	2	28	visual_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
16	2	2	3	39	argumentation_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
17	2	2	3	31	audience	\N	{0,0,0,0,-3807,3807,0,0,0,0,0,0,0,0,-3807,-3807,0,0,3807,0,7615,0,0,0,0,0,0,0,0,0,0,0,0,0,-3807,0,0,0,0,0,0,0,0,7615,0,0,0,3807,0,3807,0,0,0,0,0,0,0,0,0,0,0,0,3807,-3807,-3807,6446,0,0,-6446,3807,0,0,0,0,0,0,0,3807,-3807,0,0,-3807,3807,0,0,0,0,0,0,0,0,3807,0,0,0,0,0,0,3807,0,0,0,3807,0,0,0,0,-3807,0,0,-3807,3807,-11797,0,0,0,0,0,0,-3807,0,0,-3807,0,3807,0,0,0,0,0,0,-3807,0,0,0,0,0,0,0,0,-3807,0,0,0,-3807,0,0,0,0,0,0,0,0,6446,-3807,0,0,0,0,0,0,0,-3807,0,0,0,0,3807,0,0,-3807,0,3807,0,0,-3807,0,0,0,0,0,0,3807,0,0,0,0,-3807,-3807,0,3807,3807,0,0,0,0,0,0,0,0,0,0,-3807,0,0,0,0,-3807,0,0,0,0,0,-3807,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3807,0,0,-6446,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3807,3807,0,0,0}	1073545528	52	1010001100000010001111000010111100111100101010111000111110111101	163	2	60	47	60	171	143	189	legacy	\N	\N	none	针对对心理学、亲密关系议题感兴趣的人群，以及恐怖电影爱好者或关注情感关系问题的观众。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
18	2	2	3	44	bgm	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
19	2	2	3	35	breakout_point	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
20	2	2	3	38	content_structure	\N	{0,0,0,0,0,0,0,0,0,3092,0,0,0,0,-3092,3092,-3092,0,0,0,-3092,0,0,0,0,5235,-3092,3092,0,0,3092,0,3092,-3092,-3092,0,0,-3092,0,0,0,-3092,0,0,0,-3092,0,0,4976,-3092,3092,0,0,-3092,0,0,-3092,0,0,0,0,-3092,0,6184,3092,3092,3092,0,0,0,0,0,0,0,-6184,0,0,-3092,0,-3092,-3092,3092,0,-6184,0,0,-5235,-3092,0,-5235,-6184,0,0,0,0,0,3092,0,3092,0,0,0,0,-3092,0,0,3092,0,-3092,0,3092,3092,3092,0,0,5235,0,-3092,0,0,0,0,0,-3092,0,0,0,0,0,0,0,0,0,0,0,0,0,3092,3092,0,0,6184,0,-3092,0,3092,0,0,0,3092,0,0,0,0,0,0,3092,0,0,0,0,0,3092,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3092,-3092,0,0,0,0,3092,3092,0,3092,0,0,-3092,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3092,0,3092,9276,0,0,0,0,0,0,0,0,0,0,0,0,-3092,0,0,3092,0,-3092,0,0,0,0,3092,-8327,0,0,0,0,0,0,6184,0,0,0,0,3092,-3092,0,0,0,0}	1073722629	71	1110100010011100000000110111001011100101000101001000100100000000	232	156	3	114	229	20	137	0	legacy	\N	\N	none	内容先以个人观影体验引入，接着介绍电影剧情，然后通过影评和心理学概念分析角色行为，最后总结电影主题并给出观影建议。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
21	2	2	3	34	core_viewpoint	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
22	2	2	3	45	cta	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
23	2	2	3	40	language_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
24	2	2	3	42	layout	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
25	2	2	3	41	length	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
26	2	2	3	37	opening_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
27	2	2	3	36	title_mechanism	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
28	2	2	3	33	topic	\N	{0,2804,0,0,0,0,0,0,0,0,0,0,0,-2804,0,0,0,0,0,0,0,0,2804,0,0,2804,0,2804,0,5608,0,2804,0,0,0,0,0,0,2804,0,0,2804,0,0,0,0,0,0,2804,2804,-2804,0,2804,0,2804,0,0,-2804,4747,0,-2804,0,0,0,0,2804,2804,0,0,0,2804,0,0,0,0,-2804,-2804,0,0,-2804,-2804,0,0,2804,0,0,0,0,0,0,0,0,0,0,2804,-2804,-2804,-2804,-2804,0,2804,0,0,0,0,0,0,0,0,0,2804,2804,0,0,0,-2804,0,2804,0,0,0,0,0,2804,0,0,2804,0,-5608,-2804,-2804,-2804,4747,0,-2804,0,0,0,0,0,-2804,0,0,2804,0,5608,2804,0,0,-2804,-2804,5608,5608,-4747,0,5608,0,-2804,-2804,12298,0,0,-2804,0,0,0,0,2804,0,0,-2804,0,0,0,0,0,0,0,0,0,-2804,0,0,0,2804,2804,0,0,-2804,0,0,0,0,-2804,0,2804,0,0,0,0,-2804,-2804,0,0,0,0,0,0,0,0,0,0,0,0,-2804,0,0,0,-4747,0,0,0,2804,0,-2804,-4747,0,0,0,0,-2804,0,0,2804,0,-2804,0,-5608,0,2804,2804,0,0,0,2804,0,0,-2804,5608,0,0,5608,0,0,0,0}	1073739697	82	0110010100011100111010110101010100111000110001010001110111101000	101	28	235	85	56	197	29	232	legacy	\N	\N	none	这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
29	2	2	3	32	user_need	\N	{0,0,0,0,0,0,-3424,0,-3424,0,0,0,0,3424,-3424,0,0,-3424,3424,3424,3424,0,0,0,0,0,0,0,-3424,0,0,0,3424,-5797,-3424,0,0,0,0,0,-3424,0,0,0,0,-3424,3424,0,3424,3424,0,3424,-3424,0,0,0,0,0,0,0,0,3424,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3424,0,0,0,-3424,-3424,-3424,0,0,0,0,0,0,0,-3424,3424,0,0,0,0,0,0,0,0,-3424,0,0,0,0,0,-3424,5797,0,0,0,0,3424,3424,0,-3424,0,0,0,-3424,0,0,0,-3424,0,3424,-3424,3424,0,3424,0,0,3424,0,3424,3424,0,0,0,0,-3424,-3424,-3424,0,-3424,0,-3424,0,0,0,3424,3424,-3424,3424,-3424,5797,0,0,-3424,0,-3424,-3424,0,-6847,0,0,0,0,-6847,-6847,0,0,0,0,6847,0,0,0,0,0,0,0,0,-3424,0,0,3424,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-3424,3424,0,0,-3424,0,0,0,-3424,3424,0,0,0,0,0,0,0,0,0,0,0,3424,0,3424,0,0,3424,3424,0,0,0,0,3424,0,0,3424,0,0,-3424,0,0,3424,0,0,0,0,0,0,0}	1073834255	74	1111101100110010001111001000010000011110010100010111101010001000	251	50	60	132	30	81	122	136	legacy	\N	\N	none	用户可能希望了解电影《痴迷》的看点，同时理解“脆弱型自恋者”这一隐蔽人格类型，以及如何在亲密关系中识别和应对类似行为。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
30	2	2	3	43	visual_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
31	3	3	1	9	argumentation_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
32	3	3	1	1	audience	\N	{0,0,0,0,4166,0,0,-4166,0,-4166,8332,0,0,0,0,0,0,0,-4166,0,4166,0,0,0,0,0,0,4166,0,0,0,-4166,0,0,4166,0,0,0,0,0,0,0,0,0,0,8332,0,0,0,4166,0,0,0,0,0,0,4166,0,0,0,0,0,4166,0,0,4166,4166,0,4166,0,0,-4166,0,0,0,0,-4166,0,4166,0,0,0,4166,0,0,0,4166,0,0,4166,-4166,4166,0,0,0,0,0,0,0,0,0,0,4166,0,0,0,0,0,0,-4166,0,4166,0,0,0,0,0,0,0,0,0,0,0,4166,0,0,0,0,-4166,0,0,0,0,-4166,0,-4166,0,0,0,8332,0,0,-4166,0,0,0,0,0,-4166,0,0,0,0,7053,0,0,0,0,0,-4166,0,0,4166,0,-4166,0,0,0,0,-4166,0,0,0,0,0,0,0,0,-4166,0,0,0,0,0,0,0,0,0,4166,0,0,0,0,4166,0,0,0,0,0,0,0,0,0,0,-4166,0,0,4166,0,0,0,0,0,0,0,0,0,-4166,0,0,4166,0,0,0,0,0,0,0,4166,0,0,0,0,0,0,0,0,0,0,0,0,-8332,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	1073722613	48	1011010100010100111110110100011000010001101011101010101010010101	181	20	251	70	17	174	170	149	legacy	\N	\N	none	针对需要拍摄口播视频、担心念稿感影响流量和观众感受的内容创作者。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
33	3	3	1	14	bgm	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
34	3	3	1	5	breakout_point	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
35	3	3	1	8	content_structure	\N	{0,0,0,0,0,0,-3676,0,0,3676,0,-6224,0,0,0,0,0,-3676,0,0,0,0,0,3676,0,3676,0,0,0,7351,0,0,0,0,3676,0,0,0,-3676,0,0,-3676,-3676,0,0,0,0,0,3676,0,3676,0,0,-3676,0,3676,0,-3676,0,0,-3676,0,0,0,0,0,0,0,0,0,0,-3676,0,0,-3676,0,0,0,0,-3676,0,0,0,-3676,-3676,-3676,0,0,0,0,0,0,0,0,0,0,0,0,3676,0,0,-3676,0,0,0,3676,0,0,0,0,0,0,0,0,3676,0,3676,0,0,0,-3676,0,0,0,-3676,-3676,0,-3676,0,0,0,-3676,3676,0,0,0,3676,0,0,0,3676,0,0,-3676,0,0,0,0,-3676,0,0,3676,0,0,0,0,0,0,0,0,0,0,0,3676,0,0,0,0,0,0,0,0,0,0,0,3676,0,3676,3676,0,0,-3676,0,0,3676,-3676,0,0,0,0,0,0,-3676,3676,0,0,0,3676,0,0,0,0,3676,0,0,3676,-3676,0,0,0,0,0,0,3676,3676,3676,3676,0,3676,0,0,0,0,0,0,0,3676,0,0,0,3676,0,-3676,0,0,0,0,0,-6224,0,0,0,0,0,0,3676,3676,-3676,6224,-6224,3676,3676,0,-3676,0,0}	1073820369	69	0001100010011110010101111001100110110000010001001001000100000001	24	158	87	153	176	68	145	1	legacy	\N	\N	none	内容先提出问题（念稿感影响流量），再展示自身双视角作为例子，然后介绍两个训练方法，最后具体说明方法要点。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
36	3	3	1	4	core_viewpoint	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
37	3	3	1	15	cta	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
38	3	3	1	10	language_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
39	3	3	1	12	layout	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
40	3	3	1	11	length	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
41	3	3	1	7	opening_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
42	3	3	1	6	title_mechanism	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
43	3	3	1	3	topic	\N	{0,0,-3872,0,0,0,0,0,0,0,0,0,0,0,0,0,-3872,0,0,0,0,0,3872,0,0,6557,0,0,0,3872,0,0,0,3872,0,0,0,-3872,0,0,0,3872,0,0,0,3872,0,0,0,0,-3872,0,3872,0,0,0,0,0,0,0,0,0,0,0,0,3872,0,0,0,0,-3872,3872,0,0,0,0,0,0,-3872,0,0,0,0,3872,0,0,0,0,0,0,0,-3872,0,-3872,3872,0,0,0,0,0,0,0,0,-3872,0,0,0,0,3872,0,0,0,3872,0,0,0,0,0,0,0,3872,0,0,0,0,0,0,-3872,0,0,0,-6557,0,-3872,0,0,0,0,3872,0,0,3872,0,3872,0,6557,0,0,0,0,0,-3872,0,0,0,0,0,0,0,3872,-3872,0,0,0,0,0,0,0,0,-3872,0,0,0,0,3872,0,7745,0,0,0,0,0,0,0,7745,0,0,0,0,0,0,0,0,0,0,0,0,-3872,0,0,0,0,0,-3872,0,3872,0,0,0,0,3872,7745,0,3872,0,3872,0,3872,0,-3872,0,0,0,0,0,-3872,0,-7745,0,0,0,0,0,-3872,0,-3872,3872,3872,0,0,0,-3872,0,0,0,0,0,-3872,0,0,0,0,0,0,0,0}	1073564895	54	0101101010001001010011111101110110010101001010101100000001111100	90	137	79	221	149	42	192	124	legacy	\N	\N	none	这条视频主要讲如何通过两个训练方法去除视频拍摄中的念稿感，提升表达的自然度。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
44	3	3	1	2	user_need	\N	{0,-4544,-4544,0,0,0,4544,0,0,0,4544,0,0,4544,-4544,0,0,0,4544,4544,0,0,0,0,-4544,0,0,0,0,-4544,-4544,0,0,4544,0,0,0,4544,0,-4544,0,0,4544,0,0,0,0,0,0,0,0,0,0,0,0,0,4544,0,0,0,0,0,0,0,0,-4544,0,0,4544,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4544,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4544,0,0,0,0,0,0,0,4544,4544,4544,0,4544,0,0,0,0,0,0,4544,0,-9088,0,0,0,0,0,-4544,0,0,0,0,0,0,0,0,-4544,-4544,0,0,4544,0,0,0,-4544,0,-4544,0,0,0,0,0,-4544,0,0,0,0,4544,0,0,0,0,0,0,-4544,0,0,0,-4544,0,4544,0,0,0,0,0,0,0,0,-4544,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4544,0,0,0,0,4544,0,0,0,0,0,-4544,4544,0,0,0,0,0,0,0,-4544,-4544,0,0,0,0,4544,0,0,0,0,0,0,0,0,0,0,-4544,-4544,0,0,0,0,0,0,0,0,0,0,4544,0,-4544}	1073692672	49	0110011111101111101010001110100010101101100101010111110111001001	103	239	168	232	173	149	125	201	legacy	\N	\N	none	用户主要问题是视频表达有念稿感，导致不自然、缺乏吸引力，可能影响流量。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
45	3	3	1	13	visual_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
46	4	4	4	54	argumentation_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
47	4	4	4	46	audience	\N	{-3544,0,0,0,0,0,3544,0,0,0,0,-3544,0,0,0,-3544,0,-3544,0,3544,0,-3544,0,0,0,-3544,0,-3544,0,-3544,-3544,3544,3544,-3544,0,0,0,-3544,3544,0,0,-3544,3544,3544,0,-7437,0,0,0,-3544,0,0,-3544,0,0,0,0,0,0,0,0,-3544,0,0,0,-3544,3544,0,-2457,0,0,-3544,0,0,3544,3544,0,0,0,0,0,0,-3544,0,-3544,0,3544,0,0,0,-3544,-3544,0,0,3544,0,0,0,3544,0,0,0,3544,0,0,0,0,3544,-3544,0,0,0,-3544,0,0,0,0,0,0,0,0,0,0,3544,0,0,0,3544,0,0,0,-3544,0,0,3544,0,0,0,0,0,0,0,0,0,-6000,0,0,3544,0,0,-3544,0,-3544,0,0,3544,-3544,0,-3544,0,0,3544,0,3544,0,0,0,-3544,0,0,0,0,0,3544,0,0,0,0,0,3544,0,0,0,0,0,0,3544,-3544,0,3544,3544,0,0,0,-3544,0,0,0,0,0,0,3544,0,3544,3544,0,0,0,0,0,0,0,0,-6000,-3544,-3544,0,0,0,-3544,0,0,0,0,0,0,0,0,0,0,3544,0,0,3544,0,0,0,-3544,0,0,3544,0,0,0,0,0,3544,-6000,0,0,0,-3544,0,3544,0,-3544}	1073661210	77	0110111000011011000101001111100111001110010011001001101010110010	110	27	20	249	206	76	154	178	legacy	\N	\N	none	针对那些习惯独自完成所有事情、追求全流程掌控、对'自学'和'自我完整'有偏执的人群，尤其是高认知但可能陷入单一路径成功经验的人。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
48	4	4	4	59	bgm	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
49	4	4	4	50	breakout_point	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
50	4	4	4	53	content_structure	\N	{0,0,0,0,0,0,3030,-3030,0,6060,0,0,0,-3030,-5131,-3030,0,0,0,3030,-3030,0,-3030,0,3030,3030,0,-3030,0,0,0,0,0,-3030,-3030,0,0,0,0,0,0,0,0,0,0,0,0,0,0,5131,0,-3030,0,0,0,-3030,0,0,0,0,0,0,0,6060,0,0,6060,0,0,0,3030,0,3030,0,-3030,5131,0,0,3030,0,0,0,0,-3030,-6060,-3030,3030,0,3030,-3030,0,-3030,0,-3030,0,0,0,0,0,0,0,0,0,-3030,-3030,6060,0,0,0,0,-3030,0,0,0,3030,0,0,-5131,0,0,0,-5131,-3030,0,0,0,0,-3030,0,0,0,3030,0,0,0,0,0,0,0,0,3030,0,0,0,3030,6060,0,5131,0,0,0,0,0,0,3030,0,0,0,0,0,-3030,3030,0,0,0,0,0,0,0,0,0,0,0,-3030,0,0,0,3030,5131,-3030,0,0,-3030,0,0,0,0,0,0,0,0,0,0,0,0,0,3030,0,0,0,0,0,0,3030,0,0,0,0,3030,0,0,3030,0,-5131,3030,3030,0,3030,3030,0,0,0,3030,0,0,-3030,0,3030,0,0,0,0,0,0,-3030,0,0,0,-9090,0,0,0,3030,0,-6060,0,0,0,3030,-3030,3030,0,0,0,0,0}	1073621888	73	1101111011011000111000010011010110100110000001101000011001010001	222	216	225	53	166	6	134	81	legacy	\N	\N	none	内容先定义问题（不会借力是自恋和懒惰），再分析心理根源（自我边界偏差、我执、工具性思维差），最后提出借力的高维心法（视角转变和利他共赢）。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
51	4	4	4	49	core_viewpoint	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
52	4	4	4	60	cta	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
53	4	4	4	55	language_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
54	4	4	4	57	layout	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
55	4	4	4	56	length	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
56	4	4	4	52	opening_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
57	4	4	4	51	title_mechanism	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
58	4	4	4	48	topic	\N	{0,3261,0,0,0,0,0,3261,-3261,0,0,0,0,0,0,0,0,0,0,0,0,-6523,-3261,-3261,0,3261,0,0,0,0,0,0,0,3261,0,0,3261,0,0,0,0,0,0,-3261,0,0,-3261,0,0,-3261,0,0,5522,0,0,0,-3261,0,3261,0,-6523,3261,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-3261,0,3261,0,3261,0,0,0,0,0,0,0,0,-3261,-3261,0,3261,0,0,3261,0,0,0,0,3261,0,0,-3261,0,0,0,0,3261,0,0,-3261,0,3261,-3261,-3261,0,0,0,0,0,0,0,0,-3261,-3261,0,0,0,0,0,-3261,0,0,0,0,0,0,-3261,3261,0,0,6523,0,0,0,3261,5522,0,0,0,0,0,3261,0,-3261,6523,0,0,0,0,-3261,0,3261,0,0,-3261,0,0,-3261,0,0,0,3261,0,0,0,0,6844,0,0,0,3261,0,0,-3261,0,0,3261,6844,3261,0,0,0,0,-3261,0,-3261,-6844,0,0,0,0,-3261,0,0,0,3261,0,0,0,-3261,0,0,3261,3261,3261,0,0,0,0,-3261,-3261,0,3261,0,3261,0,0,0,0,3261,0,0,6523,-3261,0,3261,0,0,0,3261,0,0,0,0,0,0,0,0,3261,0,0}	1073569123	72	0111001001111101010101110111110010001111010101100001100010000000	114	125	87	124	143	86	24	128	legacy	\N	\N	none	内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
59	4	4	4	47	user_need	\N	{0,3092,0,0,0,-3092,3092,0,0,-3092,0,0,0,0,-3092,3092,3092,0,3092,3092,0,0,-3092,3092,-3092,0,3092,0,0,0,0,-6184,0,0,0,0,-3092,-3092,0,0,0,-3092,3092,3092,0,0,0,0,0,-3092,0,-3092,0,0,0,-3092,0,0,0,0,-3092,5235,0,3092,0,0,0,0,-6184,0,3092,0,0,0,0,3092,0,0,0,3092,0,5235,0,-3092,0,0,-3092,0,0,0,-10470,3092,-3092,0,-3092,-3092,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3092,0,3092,0,0,0,0,0,-3092,3092,0,-3092,0,0,0,0,-3092,0,0,0,0,0,3092,0,0,0,3092,0,0,0,0,0,0,0,3092,0,0,0,0,0,0,0,3092,0,0,0,-3092,-3092,0,0,0,0,3092,0,-3092,0,0,0,0,0,3092,-3092,5235,-3092,0,0,-3092,0,0,0,0,0,-3092,0,0,-3092,0,0,0,0,0,3092,0,0,6184,0,0,0,0,3092,0,0,0,0,0,3092,0,3092,3092,0,0,0,0,3092,0,0,0,0,0,0,0,0,-8327,0,-3092,0,0,0,0,0,0,3092,0,0,0,0,0,0,0,-9275,3092,0,0,0,0,0,0,0,-3092,0,0,3092,-3092,0}	1073796393	73	0110111010110111111011001010100101100001110011100101111111000001	110	183	236	169	97	206	95	193	legacy	\N	\N	none	用户可能面临因过度依赖自身努力而导致的效率低下、精力消耗和人际孤立，需要学会借助外部资源和人脉来提升生命效率。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
60	4	4	4	58	visual_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
61	5	5	5	69	argumentation_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
62	5	5	5	61	audience	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-4303,0,0,0,-4303,0,0,0,0,0,0,0,0,-4303,0,0,0,4303,0,4303,0,0,8605,4303,0,0,-4303,-4303,-4303,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-4303,0,0,0,0,0,0,-4303,0,0,0,0,0,0,0,0,0,0,0,-4303,-4303,4303,0,0,0,4303,0,0,0,-4303,0,0,-4303,0,0,0,4303,0,0,0,4303,4303,0,0,0,0,0,0,0,0,0,-8605,0,-4303,0,-4303,0,0,0,0,0,0,-4303,0,4303,0,4303,0,0,0,0,0,0,-4303,0,0,0,0,0,4303,-4303,0,0,0,4303,0,-4303,0,0,0,0,0,0,-4303,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4303,0,0,0,0,0,0,0,0,0,0,0,0,0,-8605,-4303,0,0,0,0,0,0,0,-4303,0,0,0,0,0,0,0,0,4303,4303,0,0,-4303,0,0,0,0,-4303,0,0,0,0,0,0,-4303,-4303,0,-8605,0,0,0,-4303,0,0,0,0,0,0,0,-4303,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	1073848078	46	0011111001000001101011001101101101111000010010110011101110001111	62	65	172	219	120	75	59	143	legacy	\N	\N	none	针对在感情关系中遇到沟通困扰、怀疑对方有NPD倾向的人群，尤其是经历过分手或冲突的个体。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
63	5	5	5	74	bgm	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
64	5	5	5	65	breakout_point	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
65	5	5	5	68	content_structure	\N	{0,0,0,0,0,0,0,3567,0,3567,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3567,3567,3567,0,0,0,0,0,0,0,3567,0,0,0,0,7134,0,0,-3567,0,0,0,-3567,3567,0,-3567,-3567,0,0,0,0,0,0,0,-3567,-3567,3567,0,0,0,0,0,0,0,0,0,0,-3567,0,0,0,3567,0,0,0,0,-3567,-3567,-6039,0,3567,0,0,0,0,0,0,0,0,3567,0,3567,0,3567,-3567,0,-3567,0,0,0,0,0,0,3567,3567,0,0,-3567,0,0,0,0,0,-3567,0,3567,0,0,0,0,3567,0,0,0,3567,0,0,0,3567,0,0,0,0,3567,0,0,-3567,0,0,0,0,3567,0,0,0,0,0,-3567,0,0,0,0,-3567,0,0,0,0,-3567,0,6039,0,0,0,0,0,0,3567,0,0,0,3567,-3567,0,0,0,-3567,0,0,-3567,0,0,3567,0,0,0,0,-3567,-7486,0,0,3567,0,-3567,0,0,0,0,0,0,0,0,0,0,3567,0,0,0,3567,0,0,0,0,0,0,0,0,0,0,0,-3567,7134,0,0,3567,0,3567,0,0,0,-3567,0,-9606,0,0,0,0,0,0,0,0,0,3567,0,3567,0,0,0,7134,0}	1073728237	62	1101011000000000111010101011001111000010110100101010110100000011	214	0	234	179	194	210	173	3	legacy	\N	\N	none	内容先提出识别NPD的绝招，然后举例对比正常人与NPD的提问方式，分析NPD的思维模式，最后介绍咨询师身份并引导互动。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
66	5	5	5	64	core_viewpoint	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
67	5	5	5	75	cta	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
68	5	5	5	70	language_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
69	5	5	5	72	layout	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
70	5	5	5	71	length	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
71	5	5	5	67	opening_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
72	5	5	5	66	title_mechanism	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
73	5	5	5	63	topic	\N	{0,3765,0,0,0,0,0,0,0,0,0,0,0,3765,0,0,-3765,0,-3765,3765,0,0,0,-3765,0,0,0,0,-3765,3765,3765,0,0,0,0,0,0,0,3765,0,0,-7530,0,0,0,3765,0,0,0,0,0,0,3765,0,0,-3765,0,0,0,0,0,0,0,0,-3765,3765,0,3765,0,0,0,0,0,0,0,0,3765,0,3765,0,7530,0,0,3765,0,0,0,0,0,0,0,-3765,0,0,0,0,-3765,0,0,0,0,0,0,-3765,0,0,0,0,-3765,0,-3765,3765,0,0,0,0,3765,0,0,0,0,0,0,0,0,0,0,-3765,0,3765,-7530,0,0,0,0,0,0,0,0,0,0,0,-3765,3765,3765,3765,0,0,0,0,3765,7530,0,0,0,0,0,3765,0,3765,0,0,3765,0,0,0,0,0,0,-3765,0,3765,0,0,0,0,0,0,0,0,0,0,0,3765,3765,0,0,-3765,0,0,0,3765,3765,0,0,0,0,0,0,0,-3765,0,0,0,0,0,0,0,0,-3765,0,-6375,0,0,0,0,0,3765,0,0,0,3765,0,0,0,-3765,3765,-3765,6375,0,0,0,0,0,0,0,0,0,0,0,3765,-3765,0,0,0,0,0,-3765,0,0,0,0,0,3765,0,0}	1073547000	60	0101111110111111100001110110110101001111010101111100100010010101	95	191	135	109	79	87	200	149	legacy	\N	\N	none	这条内容主要讲如何通过语言习惯识别自恋型人格障碍（NPD），并对比正常人与NPD在提问方式上的差异。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
74	5	5	5	62	user_need	\N	{0,0,4195,-4195,0,0,4195,0,0,0,0,0,0,4195,0,0,0,0,4195,0,0,0,-4195,0,0,4195,0,0,0,0,0,0,0,-4195,0,0,0,0,0,0,0,0,0,0,0,-4195,0,0,0,4195,0,0,4195,0,0,0,0,0,0,0,0,4195,0,0,0,0,0,0,0,0,0,4195,0,0,0,0,4195,0,0,-4195,0,0,0,0,0,4195,-4195,-4195,0,0,-4195,4195,0,-4195,4195,0,0,0,0,0,0,0,0,0,0,0,-4195,0,0,0,0,-4195,4195,0,-4195,0,4195,0,4195,0,0,0,0,0,0,0,0,0,0,0,0,-4195,0,0,4195,0,0,-4195,-4195,0,-4195,0,0,0,-4195,-4195,-4195,0,0,0,0,0,0,0,-4195,4195,0,0,-4195,0,0,0,0,0,0,0,0,0,-4195,0,0,0,0,0,0,0,0,0,0,0,0,-4195,-4195,0,0,-4195,0,0,4195,4195,0,0,0,4195,0,0,0,0,0,0,0,0,0,4195,0,0,0,-4195,4195,0,0,-4195,0,0,0,0,4195,0,-4195,0,0,0,0,0,0,0,0,0,0,0,4195,0,0,0,8391,0,0,0,0,0,0,0,0,4195,4195,0,0,0,0,0,-4195,0,0,4195,0,0}	1073496306	58	0101111101101100001110110101110001011101110111001111100011010101	95	108	59	92	93	220	248	213	legacy	\N	\N	none	用户需要识别伴侣是否具有NPD特征，理解其行为背后的原因，并寻求关系修复或应对方法。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
75	5	5	5	73	visual_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
76	6	9	6	84	argumentation_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
77	6	9	6	76	audience	\N	{0,0,0,0,-5898,0,0,-5898,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,5898,0,0,0,0,0,0,-5898,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-5898,0,0,0,0,0,0,0,0,0,0,0,0,0,5898,0,0,0,0,0,0,0,0,0,-5898,0,0,0,0,0,5898,0,0,0,5898,0,0,0,0,0,-5898,5898,0,0,-5898,0,0,0,0,0,5898,0,0,0,-5898,0,0,0,0,0,-5898,0,0,0,0,0,0,0,0,0,5898,0,0,0,0,0,-5898,0,0,5898,0,0,0,0,0,5898,0,0,-5898,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,5898,0,0,0,5898,-5898,0,0,0,0,0,0,-5898,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-5898,0,0,0,0,0,0,0,9986,0,0,0,0,0,0,0,0,0,0,0,0,0,-5898,0,0,0,0,0,-5898,0,0,0,0,0,0,0,0,0,0,0,0,0,-5898}	1073739508	29	1111101100110011000101111110101110111100110010000001111101110100	251	51	23	235	188	200	31	116	legacy	\N	\N	none	针对在亲密关系中缺乏安全感、容易患得患失的人群。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
78	6	9	6	89	bgm	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
79	6	9	6	80	breakout_point	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
80	6	9	6	83	content_structure	\N	{0,0,4096,0,0,0,-4096,0,0,0,0,0,0,0,0,0,-4096,-4096,-4096,0,-11032,0,0,0,0,-4096,0,0,0,4096,0,4096,0,0,0,0,-4096,0,0,0,0,0,4096,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-4096,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4096,0,0,0,-4096,0,-4096,-6936,0,0,4096,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-4096,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4096,0,0,0,0,0,-4096,4096,0,-4096,0,0,0,0,0,0,0,0,4096,0,0,0,0,-4096,0,-8193,0,0,0,0,4096,0,0,0,0,0,0,0,0,0,0,8193,0,0,0,6936,0,0,0,0,-4096,0,0,0,-4096,0,0,0,0,0,0,0,0,0,0,-4096,4096,4096,0,0,0,-4096,4096,0,0,0,0,0,0,4096,0,4096,0,0,0,0,-4096,0,0,0,0,0,0,4096,4096,0,0,0,0,-4096,0,0,0,-4096,0,0,0,0,0,0,0,0,0,0,0,0,0,4096,0,4096,-4096,0,0,0,0,0,-4096,4096,0,0,0,0,-4096,0,0}	1073592002	48	1110111000110101000010010011101011000000000101010010110000100100	238	53	9	58	192	21	44	36	legacy	\N	\N	none	以提问式标题引入，正文未提供具体展开结构，可能以论述或案例形式说明。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
81	6	9	6	79	core_viewpoint	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
82	6	9	6	90	cta	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
83	6	9	6	85	language_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
84	6	9	6	87	layout	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
85	6	9	6	86	length	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
86	6	9	6	82	opening_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
87	6	9	6	81	title_mechanism	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
88	6	9	6	78	topic	\N	{0,0,0,0,0,0,0,0,-4831,0,0,0,0,0,0,0,0,0,-4831,-4831,0,0,0,0,0,0,0,0,0,0,0,4831,0,0,0,0,0,0,4831,0,-4831,0,0,-4831,0,0,-4831,-4831,0,0,0,0,4831,0,0,0,0,0,0,0,-4831,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4831,-4831,0,4831,0,4831,0,0,0,0,-4831,0,0,0,0,0,0,0,0,-4831,0,0,0,0,0,0,4831,0,0,0,0,0,0,4831,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-4831,0,0,0,0,0,0,0,0,0,0,9662,0,0,0,0,0,-4831,4831,0,0,4831,0,0,-4831,4831,0,0,0,0,0,0,0,0,0,0,-4831,0,0,0,0,0,4831,0,0,0,0,0,0,0,0,4831,0,0,4831,0,0,0,0,0,0,4831,4831,0,0,0,0,0,0,0,0,0,0,0,-4831,0,0,0,0,0,-4831,0,0,0,0,0,-4831,0,0,0,-4831,-4831,0,4831,0,4831,0,4831,0,0,-4831,-4831,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4831,0,0,0,0}	1073573806	43	0111100101110100110010001011100100111101010111100111110111100001	121	116	200	185	61	94	125	225	legacy	\N	\N	none	内容围绕亲密关系中'不怕失去的底层安全感'这一主题展开，探讨其来源。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
89	6	9	6	77	user_need	\N	{0,8615,0,-4307,-4307,0,4307,0,0,0,0,0,0,0,0,0,0,0,0,0,4307,0,0,0,-4307,0,0,0,0,0,0,0,0,-4307,0,0,0,0,0,0,0,-4307,0,4307,0,0,4307,0,0,0,0,0,-4307,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4307,0,0,0,0,0,-4307,0,0,0,0,-4307,0,0,0,-8615,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-8615,0,-7293,0,0,0,4307,0,0,0,0,0,4307,-4307,0,0,0,0,0,0,0,4307,0,0,0,0,0,0,4307,0,0,0,0,0,-4307,0,0,0,0,-4307,0,0,0,0,0,0,-4307,0,0,4307,0,0,-4307,0,0,0,0,-4307,0,0,0,0,0,-4307,0,0,4307,0,0,0,0,0,0,0,-4307,0,0,-4307,0,0,0,0,-4307,4307,-8615,0,0,0,0,0,4307,0,0,0,0,0,0,0,4307,0,0,0,0,0,4307,0,0,0,-4307,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4307,0,0,0,0,0,0,0,0,0,4307,0,0,0,4307,4307,0,0,0,4307,0,0}	1073520460	44	0111111100110100010111101100100000000111010001101110100111001000	127	52	94	200	7	70	233	200	legacy	\N	\N	none	用户需要了解如何在亲密关系中建立不依赖对方、不惧失去的底层安全感。	\N	由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。	[]	2026-08-29 15:47:02.274886+00
90	6	9	6	88	visual_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
91	7	10	7	99	argumentation_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
92	7	10	7	91	audience	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
93	7	10	7	104	bgm	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
94	7	10	7	95	breakout_point	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
95	7	10	7	98	content_structure	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
96	7	10	7	94	core_viewpoint	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
97	7	10	7	105	cta	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
98	7	10	7	100	language_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
99	7	10	7	102	layout	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
100	7	10	7	101	length	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
101	7	10	7	97	opening_method	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
102	7	10	7	96	title_mechanism	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
103	7	10	7	93	topic	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
104	7	10	7	92	user_need	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
105	7	10	7	103	visual_style	\N	{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}	0	0	1111111111111111111111111111111111111111111111111111111111111111	255	255	255	255	255	255	255	255	legacy	\N	\N	none		\N	\N	[]	2026-08-29 15:47:02.274886+00
\.


--
-- Data for Name: sample_retrieval_profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_retrieval_profiles (id, build_id, algorithm_id, sample_id, analysis_version_id, status, input_sha256, frozen_title, frozen_platform, frozen_account_name, frozen_account_handle, frozen_archive_status, frozen_content_type, frozen_tags, created_at, completed_at) FROM stdin;
1	1	1	1	2	complete	e8e27e519b85df3c43cc408260085f519196b08b31fc80597e85af51519e3b0c	顶级吸引力就是无所谓	xiaohongshu	野生老板商业思维	野生老板商业思维	usable	video	[]	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
2	1	1	2	3	complete	494d0ff07874d7f178375b2ae64a082f1ec4e88975e2c6bcb6b0b1518680e58f	看完痴迷，发现最恐怖的是无色无味老实人？	xiaohongshu	治愈果（kakki在说啥）	治愈果（kakki在说啥）	usable	video	[]	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
3	1	1	3	1	complete	e64f22197dfda2dd99488fdb16dd8f5cd5b9f624523684c100ebf81c5195714d	双视角曝光，大家看看我有念稿感吗	xiaohongshu	北电超然	北电超然	usable	video	[]	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
4	1	1	4	4	complete	5b9666352cb74b7cd65316dd1698f67536a349b37d1d39290be056de98f59488	借力高级心法	xiaohongshu	元元子	元元子	usable	image_post	[]	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
5	1	1	5	5	complete	55e1bea876a5c1352c303d9bb03ba542daeddf91822d0d67c5458808e60520d5	NPD有一个藏不住的语言习惯	xiaohongshu	枕书凉.	枕书凉.	usable	image_post	[]	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
6	1	1	9	6	complete	673c6faca7e2026449dbfa34ca0fe5a6c6ee0c69b3e395d9e0309a450a8b1d60	不怕失去的底层安全感，怎么来的？	xiaohongshu	谢小树	谢小树	usable	image_post	[]	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
7	1	1	10	7	complete	e066d64d21ff9cbb5b079ef1c6e7211e1886507a3e8211742ade9d062de732cf	本J人被自己画的重庆地图满意到睡不着了	xiaohongshu	小野茶茶	小野茶茶	usable	image_post	[]	2026-08-29 15:47:02.274886+00	2026-08-29 15:47:02.274886+00
\.


--
-- Data for Name: sample_retrieval_states; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_retrieval_states (sample_id, dirty, dirty_generation, current_fingerprint, last_profile_id, last_build_id, last_error_code, last_error_message, updated_at) FROM stdin;
1	f	2	e8e27e519b85df3c43cc408260085f519196b08b31fc80597e85af51519e3b0c	1	1	\N	\N	2026-08-29 15:47:02.274886+00
2	f	2	494d0ff07874d7f178375b2ae64a082f1ec4e88975e2c6bcb6b0b1518680e58f	2	1	\N	\N	2026-08-29 15:47:02.274886+00
3	f	2	e64f22197dfda2dd99488fdb16dd8f5cd5b9f624523684c100ebf81c5195714d	3	1	\N	\N	2026-08-29 15:47:02.274886+00
4	f	2	5b9666352cb74b7cd65316dd1698f67536a349b37d1d39290be056de98f59488	4	1	\N	\N	2026-08-29 15:47:02.274886+00
9	f	2	673c6faca7e2026449dbfa34ca0fe5a6c6ee0c69b3e395d9e0309a450a8b1d60	6	1	\N	\N	2026-08-29 15:47:02.274886+00
5	t	4	55e1bea876a5c1352c303d9bb03ba542daeddf91822d0d67c5458808e60520d5	5	1	\N	\N	2026-08-29 16:50:46.292842+00
10	t	4	e066d64d21ff9cbb5b079ef1c6e7211e1886507a3e8211742ade9d062de732cf	7	1	\N	\N	2026-08-29 17:45:50.511712+00
\.


--
-- Data for Name: sample_stage3_idempotency; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sample_stage3_idempotency (id, aggregate_key, action, idempotency_key, request_sha256, response_kind, response_id, response_status, created_by, created_at) FROM stdin;
1	sample-retrieval	reindex	initial-reindex-stage4-857bb94	a07d511a3187a04e86f1c0478b74546f8f85329483e0e0e186c1292bb15a30a9	retrieval_build	1	202	1	2026-08-29 15:47:02.215708+00
2	sample-clusters	create	initial-cluster-stage4-857bb94	2fb474835dfd5fb4e44ddde6da8419330cb5e3ba169e6a056b14b4ea1855f5b2	cluster_job	1	202	1	2026-08-29 15:47:09.518919+00
3	sample-comparisons	create	comparison-1788019758567-evqddjs	becd4606ff5ed37125c57d1a8a0f374743e8e35c2f2aa58b91420b44f37fb403	comparison	1	201	1	2026-08-29 16:10:00.559637+00
4	sample-comparisons	create	comparison-1788021833112-bsqwmiw	0b30dc5ddea3c1e3882ad3f1ab3876e8b57374d7041ac857919347853369ea6e	comparison	2	201	1	2026-08-29 16:44:35.221891+00
\.


--
-- Data for Name: samples; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.samples (id, canonical_key, platform, platform_content_id, source_url, title, body_text, content_type, account_name, account_handle, published_at, metrics, first_ingest_method, last_ingest_method, completeness_score, missing_fields, archive_status, created_by, created_at, updated_at, deleted_at, current_analysis_version_id) FROM stdin;
1	xiaohongshu:id:6a806dfa000000002501477a	xiaohongshu	6a806dfa000000002501477a	https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?xhsshare=pc_web	顶级吸引力就是无所谓	情绪管理 职场 野生老板\n\n[00:00] 一个人的终极吸引力其实\n[00:01] 就\n[00:01] 淡定\n[00:02] 这个是道德经里非常\n[00:03] 反常识的一个真相\n[00:05] 在道德经第29章\n[00:06] 他说天下神器不可为也\n[00:08] 不可执也\n[00:08] 为者败之\n[00:09] 执者失之\n[00:10] 他说的就是\n[00:11] 你越想用力抓住的东西\n[00:12] 往往就是你失去的越快\n[00:14] 而当你彻底放下执念\n[00:15] 表现的云淡风轻\n[00:16] 无欲则刚的时候\n[00:17] 全世界的资源反而会主动的\n[00:19] 向你靠拢\n[00:20] 所有那些刻意展示出来的\n[00:21] 啊\n[00:22] 其实不够高级\n[00:23] 精致的妆容\n[00:24] 各种好听的话术\n[00:25] 你越是主动\n[00:26] 越是用力的去输出\n[00:28] 在真正高手的眼里\n[00:29] 你就显得越低级和匮乏\n[00:31] 真正的\n[00:31] 顶级吸引力来自于\n[00:33] 克制\n[00:33] 而在这个背后的本质\n[00:35] 它其实是一种无为和不\n[00:36] 执着的智慧\n[00:37] 第一个\n[00:38] 淡定的本质是不在乎\n[00:39] 你不在意身边人的去留\n[00:41] 不在乎别人的眼光和评价\n[00:42] 不在意一段关系里的得\n[00:44] 与失\n[00:44] 你可以去留意一下\n[00:45] 在关系里面最让人着迷\n[00:47] 的那个人\n[00:47] 从来不是那个患得患失\n[00:48] 随时消息秒回\n[00:49] 很在乎你的人\n[00:50] 而是那个\n[00:51] 无论你走也好留也好\n[00:52] 回他消息也好\n[00:53] 不理他也好\n[00:54] 他都稳定的像石头一样\n[00:56] 稳定的可怕的那个人\n[00:57] 这种人的无所谓\n[00:58] 他不是装出来的\n[00:59] 他是真的\n[01:00] 他是真的无所谓\n[01:00] 本质是我的人生\n[01:01] 能做到绝对的自给自足\n[01:03] 绝对的自我圆满\n[01:04] 这种淡定感\n[01:06] 他是会给对方带来\n[01:07] 巨大的心理压迫感的\n[01:08] 因为他会突然发现\n[01:09] 在你这里我没有任何筹码\n[01:11] 可以谈判\n[01:11] 他不能用离开来威胁你\n[01:13] 因为你不需要他\n[01:14] 他也不能用冷暴力来\n[01:15] 控制你\n[01:16] 因为你一个人也活得很好\n[01:17] 他更加不能用这种\n[01:18] 夸奖赞美来去收买你\n[01:19] 因为你的自我价值是\n[01:20] 不需要他来确认的\n[01:21] 而当一个人在关系里面\n[01:22] 找不到任何一个可以拿捏你的点\n[01:24] 那他只剩两条路可以走\n[01:25] 要么主动靠近你去适应你\n[01:27] 要么自觉退出离场\n[01:29] 而你呢这两种结果其实\n[01:31] 都能接受\n[01:32] 这个才是真正关系里\n[01:34] 的主动权并\n[01:35] 不是你控制了他\n[01:36] 而是你控制了自己\n[01:36] 你让自己绝对的冷静克制\n[01:38] 而他这个时候就不得不\n[01:40] 跟着你的节奏去走了\n[01:41] 第二个淡定\n[01:42] 它是一种内在的状态\n[01:43] 而不是装出来的冷漠\n[01:44] 道德经里有一句话形容淡定\n[01:46] 我觉得非常合适\n[01:47] 说清静为天下正\n[01:48] 清静啊才是这个天下万事\n[01:50] 万物的标准\n[01:51] 什么叫清静\n[01:52] 说实话我是不认同现在那些\n[01:53] 所谓的修行就要打坐冥想\n[01:55] 与世隔绝的\n[01:56] 在我看来真正的清静是在这个世俗\n[01:56] 真正的清净是在这个世俗\n[01:58] 你的内心依旧是满的\n[02:01] 依旧是不需要外界来去填补\n[02:02] 你不需要别人的认可来确认自己的价值\n[02:04] 也不需要一段关系来证明自己值得被爱\n[02:06] 不需要任何人来评价定义你\n[02:09] 当你能够自给自足的时候\n[02:11] 其实你的状态自然而然就会\n[02:12] 这个不是自我压抑出来的伪装\n[02:14] 是外界根本他没有什么东西是可以撼动你的\n[02:17] 一个内在圆满的人\n[02:19] 他的淡定一定是\n[02:20] 由内而外散发出来的状态\n[02:21] 而不是装出来的外在的\n[02:23] 所以顶级的魅力啊\n[02:24] 他从来不是往自己身上做\n[02:25] 去学什么话术\n[02:26] 去打扮自己\n[02:27] 在我看来\n[02:28] 他是做减法\n[02:30] 减掉你对外界的需要\n[02:31] 减掉那些你拼命向外抓取的所有动作\n[02:32] 你以为的魅力是你展示\n[02:34] 但真正的魅力其实是你\n[02:35] 不展示什么	video	野生老板商业思维	野生老板商业思维	\N	{"likes": "1399", "收藏": 922, "点赞": 1399, "评论": 37, "collects": "922", "comments": "37"}	legacy	legacy	75	{published_at,media}	usable	\N	2026-08-29 15:29:57.747+00	2026-08-29 15:30:14.756054+00	\N	2
9	xiaohongshu:id:6a69c47400000000050380df	xiaohongshu	6a69c47400000000050380df	https://www.xiaohongshu.com/discovery/item/6a69c47400000000050380df?xhsshare=pc_web	不怕失去的底层安全感，怎么来的？	亲密关系中，不怕失去的底层安全感，怎么来的？\n\n发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 谢小树 关注 谢小树 关注 不怕失去的底层安全感，怎么来的？ 亲密关系中，不怕失去的底层安全感，怎么来的？ #女性智慧 #女性成长 #心理学 #情感 07-31 重庆 加载中\n\n亲密关系中 不怕失去的底层安全感 怎么来的	image_post	谢小树	谢小树	\N	{"likes": "624", "收藏": 470, "点赞": 624, "评论": 15, "collects": "470", "comments": "15"}	legacy	legacy	90	{published_at}	usable	\N	2026-08-29 15:29:58.125928+00	2026-08-29 15:30:14.885244+00	\N	6
2	xiaohongshu:id:6a6f4013000000000502a398	xiaohongshu	6a6f4013000000000502a398	https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&apptime=1787556009&author_share=1&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&xhsshare=CopyLink	看完痴迷，发现最恐怖的是无色无味老实人？	心理学的脆弱型自恋者，望周知～\n\n[00:00] 本人是一个恐怖电影爱好者\n[00:02] 豆瓣的高分恐怖片清单\n[00:04] 我基本上都刷了一个遍\n[00:06] 最近\n[00:07] 在海外有一部爆火的电影叫做《痴迷》\n[00:09] 刚刚也在内地院线上映了\n[00:10] 本人已经看完了\n[00:12] 看完以后真的表示非常的兴奋\n[00:14] 因为我觉得它不仅吓到我了\n[00:16] 它也笑到我了\n[00:17] 甚至有点惊艳到我了\n[00:19] 我已经准备去电影院再二刷一次了\n[00:21] 但我想要专门出一期视频\n[00:23] 不只是因为它好看\n[00:24] 而是因为\n[00:25] 我觉得这个题材实在是太特别了\n[00:27] 它不是那种传统意义上的鬼怪恐怖\n[00:30] 而是把亲密关系\n[00:31] 拍成了心理恐怖片的电影\n[00:34] 可以说是刚好切到了我的内容赛道\n[00:36] 所以想要先给大家推荐介绍一下剧情\n[00:39] 男主贝尔是一个非常平凡\n[00:41] 自卑又对爱情充满执念的一个男青年\n[00:45] 他呢偶然听说了\n[00:46] 小镇上有一个关于心愿柳的一个传说\n[00:49] 是那种把柳条柳枝折断了\n[00:52] 许个愿然后愿望就能实现\n[00:54] 他有一天就去商店里面买了买了这个柳条\n[00:55] 许愿\n[00:56] 自己暗恋的女孩Nikki能够爱上自己\n[00:59] OK 愿望成真了\n[01:00] 两个人真的走到一起了\n[01:03] 但是很快就发现 被召唤来的真的不是纯粹的爱情\n[01:06] 而是纯纯的恐怖\n[01:08] 女主被夺舍了 然后发了疯一样的爱上了男主贝尔\n[01:12] 占有 控制 几乎惊恐到了变态的程度\n[01:16] 而这部电影 我觉得它最讽刺的地方就是\n[01:18] 它在用一种非常之极端的方式 拍出了很多人在亲密关系里面\n[01:24] 既要 又要 还要\n[01:25] 我看到一个非常有意思的影评\n[01:27] 当然有点尖锐\n[01:27] 男主属于是既要0元购又想免费退 占完便宜还想跑\n[01:33] 就发现自己又跑不掉了 就开始害怕了\n[01:35] 可是正当他要付出代价的时候 他又舍不得了”\n[01:38] 这个就很像是感情里的某一部分人\n[01:42] 喜欢漂亮的姑娘 但是又要对方只爱自己\n[01:45] 喜欢独立的人 但又希望对方能够粘着自己\n[01:48] 那对方太粘了 又嫌他不给自己空间\n[01:51] 那对方开始真的有自我了 自信放光芒了 又觉得没有安全感了\n[01:55] 不少不管男女\n[01:56] 不少不管是男女\n[01:57] 这个世界上哪里有这么好的事情\n[01:59] 你想得到到底是伴侣\n[02:00] 还是一个既能满足你所有需求\n[02:02] 又不需要你承担任何代价的\n[02:04] 人型许愿机？\n[02:07] 我觉得这部电影它更厉害的地方在于\n[02:09] 它拍出了一种\n[02:10] 非常容易被大家忽略的人物类型\n[02:13] 叫做脆弱型自恋者\n[02:15] 从人格心理学和临床研究的角度来说\n[02:18] 自恋存在两种稳定的维度\n[02:21] 大家都很熟悉\n[02:23] 也是网上最常看到的那种NPD的类型\n[02:26] 脆弱型自恋\n[02:28] 这是一种非常之隐蔽的自恋\n[02:30] 大家都不太了解\n[02:32] 像男主贝尔\n[02:33] 他表面上很害羞\n[02:34] 很自卑很老实\n[02:35] 甚至还有一点点可怜\n[02:36] 你是不是就很容易觉得\n[02:38] 他是一个不太喜欢表达\n[02:40] 但是挺善良的一个普通人\n[02:42] 但如果你仔细看电影\n[02:44] 你们会发现\n[02:44] 其实这个不是单纯的内向\n[02:46] 更不是什么温柔\n[02:47] 他是那种“无色无味的剧毒老实人”\n[02:50] 他的自恋不是那种高高在上\n[02:52] 夸夸其谈的自恋\n[02:54] 而是一种隐藏在不行动不付出\n[02:54] 而是一种藏在不行动不付出\n[02:56] 不表态和退缩背后的自恋\n[02:59] 你就看他向心愿柳留许的愿望是什么嘛\n[03:02] 不是那种请给我勇气去表白吧\n[03:05] 也不是请让我有机会了解我的女神吧\n[03:08] 而是直接要求让Nikki爱上我\n[03:11] 胜过爱世界上任何一个人\n[03:13] 你们细品\n[03:14] 就这个愿望\n[03:16] 它的背后就说明了\n[03:16] 他其实想要的\n[03:17] 根本就不是一段真实的关系\n[03:19] 或者说这个人他对关系就是有一种错误的理解\n[03:21] 他要的是一种究极的排他\n[03:23] 是一种绝对的优先\n[03:25] 是一种无条件围绕他运转\n[03:27] 但又不提要求的爱\n[03:29] 但真正的爱是这样吗\n[03:30] 不是的\n[03:32] 真正的爱应该是是我走向你\n[03:33] 我了解你\n[03:35] 我知道你的喜好\n[03:36] 我付出一些爱的行为\n[03:38] 然后我尊重你的选择\n[03:39] 而这个男主的爱是跳过了了解\n[03:41] 追求甚至是对方的意愿\n[03:43] 直接让对方变成了自己的所有物\n[03:45] 而且是独一无二的\n[03:46] 这就根本就不是爱\n[03:47] 这个是恐怖片\n[03:49] 因为他关注的始终是她为什么不爱我\n[03:51] 我怎么样才能得到她\n[03:52] 而不是她真正需要什么\n[03:54] 她的梦想是什么\n[03:55] 她喜欢什么\n[03:56] 以及她愿不愿意\n[03:57] 而且这个电影\n[03:58] 还有很多细节都在说明这一点\n[04:00] 他对他死去的猫是非常冷漠的\n[04:03] 那个猫咪刚刚离世\n[04:04] 他就可以出去跟别人吃喝玩乐\n[04:06] 心里就想着\n[04:07] 是要不要表白这一类的事情\n[04:08] 又比如说这个男主\n[04:09] 他对一直都暗恋他\n[04:11] 关心他的朋友同事\n[04:13] 也是那种非常习惯性的\n[04:15] 接受对方的好意\n[04:16] 但是却从来没有想过\n[04:17] 真正付出一点相对等的回应\n[04:19] 就这种人\n[04:20] 他真的可能不一定会在现实生活中\n[04:23] 主动的去伤害你\n[04:24] 但是这样的人\n[04:25] 你一旦跟他进入关系\n[04:27] 他一定一定会索取很多\n[04:29] 他会索取关注照顾\n[04:30] 索取情绪价值\n[04:31] 但他却会很少真正看见别人\n[04:35] 就是他用不行动来保护自己\n[04:37] 很多人会觉得\n[04:38] 脆弱型自恋者是因为自尊太低\n[04:40] 所以不太敢行动\n[04:42] 但其实恰恰相反哦\n[04:44] 他们内心往往有一种非常强烈的自尊\n[04:46] 但这种自尊\n[04:47] 他不是强大\n[04:48] 而是强烈\n[04:49] 甚至可以说这种自尊他太脆弱了\n[04:50] 这种自尊\n[04:51] 他太脆弱了\n[04:52] 因为他们这种人\n[04:53] 他们就很害怕被拒绝\n[04:54] 很害怕失败\n[04:55] 很害怕现实证明自己没有那么特别\n[04:57] 所以就干脆不表白了\n[04:58] 就不努力了\n[04:59] 因为这样就不承担风险\n[05:00] 毕竟只要不行动\n[05:02] 就永远不会被现实检验出所谓的结果\n[05:05] 当然啊这我一定要强调\n[05:07] 不要因为一个人内向害羞或者社恐\n[05:10] 就随随便便给人家贴上一个什么\n[05:12] 剧毒老好人的标签和NPD的标签\n[05:15] 没有这回事儿\n[05:16] 内向和自恋\n[05:17] 是完完全全的独立存在的两种事情\n[05:20] 两回事\n[05:21] 而真正害羞但是又同时善良的人\n[05:24] 他们一定会\n[05:25] 看到对方的\n[05:26] 一定会记得对方说过的话\n[05:27] 一定会付出关心的行为\n[05:28] 也会在被拒绝之后\n[05:30] 下一次想着\n[05:31] 我应该尊重别人的边界\n[05:33] 他不会把自己的喜欢\n[05:35] 当成对方必须回应的义务\n[05:36] 但是脆弱型自恋者可不一样哦\n[05:38] 他们不一定是张牙舞爪的\n[05:40] 甚至他们是内向的\n[05:42] 害羞的甚至是无害的\n[05:43] 但是他在关系里\n[05:45] 一定会持续的表现出\n[05:46] 那种以自我为中心的情感\n[05:47] 索取和逃避责任\n[05:49] 以及躲避后果\n[05:51] 他想要的不是你\n[05:52] 而是你证明我值得被爱\n[05:54] 而这个电影真正恐怖的地方也在这儿\n[05:56] 当Nikki因为贝尔的许愿被夺舍之后\n[05:59] 失去自我\n[06:00] 折磨到已经几乎不成人形的时候\n[06:03] 她在半夜的时候\n[06:04] 短暂恢复意识的那几分钟\n[06:06] 她非常痛苦的哀求着男主贝尔\n[06:09] 她说你杀了我吧\n[06:11] 我求求你了\n[06:12] 你让我解脱吧\n[06:13] 结果你们知道男主说了句什么吗\n[06:14] 男主说：和我在一起到底有什么不好\n[06:18] 我靠就这句话出来\n[06:20] 我相信电影院一定是一片哗然的\n[06:23] 因为在那一刻\n[06:24] 经历了那么多恐怖的事情之后\n[06:26] 他看到的还是仍然不是对方的痛苦\n[06:29] 而是自己的委屈\n[06:30] 她不成人形了\n[06:32] 她在求救了\n[06:33] 但这个男生还在想\n[06:34] 我都给你我的爱了\n[06:35] 你到底有什么不满意呀\n[06:36] 你们看\n[06:37] 这个就是极端自我的人最可怕的地方\n[06:40] 因为在他们的世界里\n[06:41] 伴侣不是一个有感受有想法\n[06:44] 有喜怒哀乐有意志的人\n[06:45] 而是一个应该满足自己配合自己\n[06:48] 证明自己的工具角色\n[06:51] 所以我真的觉得《痴迷》\n[06:52] 表面上它讲的是一个什么禁忌\n[06:54] 许愿的一个恐怖故事\n[06:56] 但其实\n[06:56] 他讲的是亲密关系里的恐怖故事\n[06:59] 强制爱别人不会有什么好下场的\n[07:01] 以及爱一旦只想着满足自己的话\n[07:04] 就一定伴随着抹杀对方\n[07:06] 真正健康的爱\n[07:07] 不是对方完全符合你的期待\n[07:09] 而是你能看到ta是一个独立的人\n[07:11] ta有自己的痛苦边界和选择\n[07:14] 也有不围着你转的权利\n[07:16] 讲真的这部电影\n[07:18] 把恐怖喜剧和情感的议题结合的非常好\n[07:21] 它吓人但又不只是吓人\n[07:23] 它荒诞但又特别现实\n[07:25] 我真的希望这样的作品\n[07:27] 被更多的人看到\n[07:29] 但是这个人一定是大胆的人\n[07:30] 如果大家很胆小\n[07:31] 就不要去看了\n[07:32] 因为这个电影真的是蛮恐怖的\n[07:34] 好了今天的分享就到这了\n[07:35] 我们下期再见啦拜拜	video	治愈果（kakki在说啥）	治愈果（kakki在说啥）	\N	{"likes": "784", "收藏": 349, "点赞": 784, "评论": 75, "collects": "349", "comments": "75"}	legacy	legacy	75	{published_at,media}	usable	\N	2026-08-29 15:29:57.822288+00	2026-08-29 15:30:14.794932+00	\N	3
4	xiaohongshu:id:6a65d3eb0000000011016998	xiaohongshu	6a65d3eb0000000011016998	https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?xhsshare=pc_web	借力高级心法	不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种"全流程掌控"的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是"学"。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信"速成"可以等同于"掌握"，觉得知识必须经过自己漫长的消化才算是自己的，这是对"自我完整性"的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对"自我边界"的认知出了偏差。叫"我执"。 你把"我"画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把"我"看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲"君子生非异也，善假于物也"，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是"谁能比我更快更好地做成这件事"。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲"真空生妙有"，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的"空"就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个"妙有"——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从"我需要帮助"这个角度去看，开口就是示弱就是亏欠，你从"我在调动资源"这个角度去看。 这是借力的最高级心法 你以为的借力还是"我缺什么，我去拿"，但实际上而"让更有价值的人做更有价值的事，"利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜"我不欠任何人"，其实就是和任何人都没有关系。\n\n发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 元元子 关注 元元子 关注 借力高级心法 不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种&quot;全流程掌控&quot;的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是&quot;学&quot;。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信&quot;速成&quot;可以等同于&quot;掌握&quot;，觉得知识必须经过自己漫长的消化才算是自己的，这是对&quot;自我完整性&quot;的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对&quot;自我边界&quot;的认知出了偏差。叫&quot;我执&quot;。 你把&quot;我&quot;画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把&quot;我&quot;看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲&quot;君子生非异也，善假于物也&quot;，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是&quot;谁能比我更快更好地做成这件事&quot;。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲&quot;真空生妙有&quot;，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的&quot;空&quot;就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个&quot;妙有&quot;——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从&quot;我需要帮助&quot;这个角度去看，开口就是示弱就是亏欠，你从&quot;我在调动资源&quot;这个角度去看。 这是借力的最高级心法 你以为的借力还是&quot;我缺什么，我去拿&quot;，但实际上而&quot;让更有价值的人做更有价值的事，&quot;利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜&quot;我不欠任何人&quot;，其实就是和任何人都没有关系。 #修行 #女性力量 #心理 #借力 #女性智慧 #高能量 编辑于 07-27 加载中\n\n(Sun.) 七月二十六日 不会借力是一种 隐蔽的自恋	image_post	元元子	元元子	\N	{"likes": "3814", "收藏": 2204, "点赞": 3814, "评论": 111, "collects": "2204", "comments": "111"}	legacy	legacy	90	{published_at}	usable	\N	2026-08-29 15:29:57.870931+00	2026-08-29 15:30:14.825506+00	\N	4
5	xiaohongshu:id:6a6e0eb80000000005031f6f	xiaohongshu	6a6e0eb80000000005031f6f	https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?xhsshare=pc_web	NPD有一个藏不住的语言习惯	发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 枕书凉. 关注 1/8 枕书凉. 关注 NPD有一个藏不住的语言习惯 #我重新相信相亲角了 #贵族 #npd #光子嫩肤 #股票 #高尔夫 #留学生 #这个夏天造点啥 08-01 湖北 加载中\n\nNAME You are everything tome,and Iwas so blessed whenGodsentyouhereforme. --枕书凉-- NPD有一个 藏不住 的语言习惯 今天教你们一个识破NPD的绝招：不用看 他对你多好，不用听他表白的多甜，就看 他怎么说话。 我研究了上千个NPD案例，发现他们有一 个藏不住的语言习惯，就是他们永远不会 用关心的方式开启对话，只会用审判的方 式质问。\n\n001@枕书凉 我给你举个例子，你就懂了。 正常人想知道你起床了没，会问：“你起床 了吗？”你吃饭了吗？” 这是开放式的关心，答案可以是yes，也可 以是n0 。 但NPD会怎么问？“你已经起来了？”“你已 经吃完了？” 发现没有？他们的提问里，根本没有“no” 这个选项。\n\n002@枕书凉 他们问的不是你的状态，而是在确认一个 预设：“你必须已经起来了。你必须已经吃 完了。你必须满足我的期待。” 02这背后藏着一个可怕的思维模式： 正常人提问，是想了解对方；NPD提问, 是想控制结果。 他们接受不了拒绝，接受不了不符合预 期。因为在他们的世界里，“你不顺从"=“你 攻击我”。 那当你说“没有，我还没起”的时候，会发生 什么？\n\n003@枕书凉 低阶NPD当场破防：甩脸色、冷暴力、直 接骂你，“你什么毛病？都几点了还不起？” 高阶NPD更阴： 嘴上说着“没事没事，你睡吧”，但你明显能 感觉到气氛不对了。然后接下来，他会想 方设法解决你这个“拒绝”： 你没起床？他就在旁边制造噪音，让你睡 不着。 你拒绝他的观点？他就疯狂给你发视频、 发文章，直到你认可为止。\n\n004@枕书凉 你不想做的事？他会用各种方式让你觉得 “不做就是你的错”。 为什么？ 因为他们无法接受身边有任何人和自己不 一样。承认你的不同，意味着他的世界观 被挑战了；允许你拒绝，意味着他的自恋 受损了。 这就是为什么，正常人会内耗、会反思， NPD完全不会。 03正常人遇到不同意见，会想：是不是我 错了？是不是可以求同存异？\n\n005@枕书凉 但NPD的脑子里只有一种程序：“你不听我 的，就是攻击我；你攻击我，我就必须消 灭你。” 他们的世界里，没有容纳，没有理解。承 认别人，等于否定自己。所以他们只能不 停地赢、不停地控制、不停地消灭所有“不 一样”。 这也是为什么，你会觉得NPD目的性特别 强，执行力特别强。 为了让你顺从他，他可以无所不用其极; 为了让你认错，他可以跟你耗三天三夜。 但你发现没有？\n\n006@枕书凉 他们的目的，从来不是为了真正解决问 题，也不是为了让自己变得更好，只是为 了满足那个“我赢了”的感觉。 所以你会看到一种奇观：NPD十年如一日 地愚蠢，十年如一日地原地踏步。他们用 尽所有力气去控制别人，却没有一分力气 用来成长自己。 为什么？因为他们的能量，全部用来维持 自恋了，没有余力，去拓展世界观。 我是枕书凉，一个从回避型成长为安全型 的心理咨询师，从事回避型依恋，婚姻关 系，感情修复等咨询已有8年。让你们更懂 回避型，如果你们遇到感情问题，希望能 帮到你们\n\n007@枕书凉 如果你们的感情出现了以下几种情况，都 还有机会可以重归于好; 第一种：分开之后没有删除拉黑你，但 是态度很冷漠；写A 第二种：分开之后正常跟你聊天，但是 不愿意提及复合；写B 第三种：分开之后删除拉黑你，不愿沟 通态度决绝；写C 第四种：在一起经常吵架，或者对方经 常断联消失，消息电话不回。写D 有以上情况可以找我给你看看，我来帮你 从根本上解决你们的相处问题。	image_post	枕书凉.	枕书凉.	\N	{"likes": "1295", "收藏": 951, "点赞": 1295, "评论": 286, "collects": "951", "comments": "286"}	legacy	legacy	90	{published_at}	usable	\N	2026-08-29 15:29:57.89849+00	2026-08-29 16:50:46.292842+00	\N	8
10	xiaohongshu:id:6a86ad460000000025007d54	xiaohongshu	6a86ad460000000025007d54	https://www.xiaohongshu.com/discovery/item/6a86ad460000000025007d54?xhsshare=pc_web	本J人被自己画的重庆地图满意到睡不着了	熬夜整理出来的重庆4天3晚游玩地图，J人属性彻底爆发！直接把重庆划分为4大区域，不走回头路，拿着这份攻略就能轻松玩转山城！ 📍Part 1 渝中经典线 解放碑 ➡️ 山城步道 ➡️ 十八梯 ➡️ 湖广会馆 ➡️ 白象居 ➡️ 洪崖洞 ➡️ 千厮门大桥 一条线打卡完渝中半岛的核心地标，感受老重庆的爬坡上坎与璀璨夜景。 📍Part 2 南岸江景线 两江小渡 ➡️ 弹子石老街 ➡️ 下浩里 ➡️ 龙门浩 ➡️ 开埠遗址公园 ➡️ 长江索道 ➡️ 南滨路 沿着长江一路漫步，看绝美日落与两江交汇，夜景氛围感直接拉满。 📍Part 3 潮流人文线 鹅岭二厂 ➡️ 鹅岭公园 ➡️ 李子坝 ➡️ 人民大礼堂 ➡️ 三峡博物馆 ➡️ 北仓文创园 ➡️ 观音桥 文创园区与魔幻轻轨结合，感受山城的文艺与潮流繁华。 📍Part 4 沙坪坝文化线 重庆动物园 ➡️ 磁器口 ➡️ 马房湾七彩巷 ➡️ 渣滓洞 ➡️ 白公馆 ➡️ 罗中立美术馆 ➡️ 工业博物馆 看大熊猫四喜丸子，逛千年古镇与红色旧址，艺术感与历史感兼具。 🍲 美食打卡必吃清单 1️⃣ 洞洞隐火锅地下防空洞店：防空洞里吃火锅，必吃重庆地标解放碑洪崖洞慕斯蛋糕和所有甜品免费吃！ 2️⃣ 零贰山江景自助老火锅：看两江夜景吃火锅，性价比绝了。 3️⃣ 地道壹号防空洞火锅：地道牛油浓香，重庆老味道。 4️⃣ 食济良重庆特产店：重庆特产知名品牌，都是批发价，带伴手礼去这一个地方就够了。 5️⃣ 花市碗杂面：豌豆软糯，杂酱香浓，本地人从小吃到大。\n\n发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 小野茶茶 关注 可能含AI生成内容 1/7 小野茶茶 关注 本J人被自己画的重庆地图满意到睡不着了 熬夜整理出来的重庆4天3晚游玩地图，J人属性彻底爆发！直接把重庆划分为4大区域，不走回头路，拿着这份攻略就能轻松玩转山城！ 📍Part 1 渝中经典线 解放碑 ➡️ 山城步道 ➡️ 十八梯 ➡️ 湖广会馆 ➡️ 白象居 ➡️ 洪崖洞 ➡️ 千厮门大桥 一条线打卡完渝中半岛的核心地标，感受老重庆的爬坡上坎与璀璨夜景。 📍Part 2 南岸江景线 两江小渡 ➡️ 弹子石老街 ➡️ 下浩里 ➡️ 龙门浩 ➡️ 开埠遗址公园 ➡️ 长江索道 ➡️ 南滨路 沿着长江一路漫步，看绝美日落与两江交汇，夜景氛围感直接拉满。 📍Part 3 潮流人文线 鹅岭二厂 ➡️ 鹅岭公园 ➡️ 李子坝 ➡️ 人民大礼堂 ➡️ 三峡博物馆 ➡️ 北仓文创园 ➡️ 观音桥 文创园区与魔幻轻轨结合，感受山城的文艺与潮流繁华。 📍Part 4 沙坪坝文化线 重庆动物园 ➡️ 磁器口 ➡️ 马房湾七彩巷 ➡️ 渣滓洞 ➡️ 白公馆 ➡️ 罗中立美术馆 ➡️ 工业博物馆 看大熊猫四喜丸子，逛千年古镇与红色旧址，艺术感与历史感兼具。 🍲 美食打卡必吃清单 1️⃣ 洞洞隐火锅地下防空洞店：防空洞里吃火锅，必吃重庆地标解放碑洪崖洞慕斯蛋糕和所有甜品免费吃！ 2️⃣ 零贰山江景自助老火锅：看两江夜景吃火锅，性价比绝了。 3️⃣ 地道壹号防空洞火锅：地道牛油浓香，重庆老味道。 4️⃣ 食济良重庆特产店：重庆特产知名品牌，都是批发价，带伴手礼去这一个地方就够了。 5️⃣ 花市碗杂面：豌豆软糯，杂酱香浓，本地人从小吃到大。 #美食SOP指南 #这才是重庆 #重庆 #重庆旅游 #重庆打卡 #重庆美食 #重庆攻略 #重庆火锅 #重庆特产 #本地人做的攻略 08-20 重庆 加载中\n\n重庆可以分为四个板块 嘉陵江 Part2 观音桥 Part3 两江小渡 北仓文创园 弹子石老街 Part1 “小天坛 千厮门大桥 重庆人民大礼堂 下浩里 洪崖洞 三峡博物馆 龙门浩 解放碑 李子坝 湖广会馆 山城步道 老重庆风貌 长江索道 十八梯 鹅岭二厂 南滨路 Part4 磁器口 马房湾七彩巷 重庆动物园 注意：此地图 渣洞 只为路线标注， 白公馆 与实际地图 有差异\n\n重庆旅游Day1 千厮门大桥 山城记 拍摄洪崖洞全景 最佳机位， 山城重庆 解放碑 8D魔幻之旅 轻松拍出夜景大片。 步行6分钟 就从这一天开始! 重庆城市图腾与地标， 抗战历史纪念， 富有打卡意义。 洪崖洞 梦幻吊脚楼， 步行15分钟 夜晚亮灯极其惊艳， 如同千与千寻。 山城步道 临崖建造的步道， 车程10分钟 浓缩山城精髓， 体验爬坡上坎。 白象居 渝中半岛 二十四层无电梯老楼 步行10分钟 展现魔幻建筑与江景 十八梯 老重庆建筑风格 车程10分钟 台阶漫步非常意， 步行20分钟 拍照出片。 湖广会馆 康熙年间古建筑， 小贴士 明清活化石， 历史氛围浓厚。 ·步行为主，穿舒适鞋子 ·夜景更美，记得带相机 ·美食推荐：火锅，小面、酸辣粉\n\n重庆旅游Day2 1.两江小渡 2.弹子石老街 性价比高的小渡轮， 日落时分极具氛围感 百年开埠遗址， 建筑中西合壁， 轮渡15分钟 夜市热闹 轻轨26分钟 3.下浩里 嘉陵江 巴渝吊脚楼风格， 长江 烟火气十足， 适合citywalk 步行10分钟 5.重庆开埠遗址公园 4.龙门浩老街 立体的山城公园 百年老街区， 俯瞰两江交汇 民国建筑风貌 壮丽景色 拍大桥绝佳 轻轨18分钟 打车8分钟 6.长江索道 7.南滨路 老式飞车交通 沿江漫步观赏江景 飞跃长江， 将渝中半岛夜景 步行15分钟 建议南站乘坐 尽收眼底\n\n江北区 重庆旅游Day3 7.观音桥：潮流商圈, 标志性大屏与好吃街， 7.观音桥 夜生活丰富。 步行10分钟 6.北仓文创园：文艺青年 6.北仓文创园 聚集地，咖啡手作店云集， 渝中区 适合i人。 步行17分钟 嘉陵江 5.三峡博物馆：国家 5.三峡博物馆 一级博物馆，馆藏丰富 且可免费盖章。 步行3分钟 九龙坡区 4.人民大礼堂：中式 4.人民大礼堂 琉璃瓦复古地标，经典 3.李子坝：轻轨穿楼 城市名片。 地铁25分钟 名场面，体验口吞轻轨 奇观。 南岸区 3.李子坝 步行16分钟 1.鹅岭二厂 2. 鹅岭公园：渝中半岛 1.鹅岭二厂： 制高点，揽胜楼俯瞰 工业风文创园, 全城夜景。 拍照非常有杂感 大片范。 大渡口区 巴南区\n\n重庆旅游Day4 歌乐山 5.白公馆 军阀别墅改编， 红岩历史， 4.渣洞 山城重庆 小萝卜头关押处; 魅力无限! 渣洞 歌乐山红色旧址， 还原牢房， 打车10分钟 缅怀革命先烈; 3.马房湾七彩巷 6.罗中立美术馆 彩色涂鸦街区， 打车14分钟 拍照出片， 炫彩涂鸦外墙 追星女孩必去; 艺术氛围浓厚， 打卡圣地; 渝中区 沙坪坝 2.磁器口 南岸区 打车18分钟 千年古镇， 青石板路与 7.重庆工业博物馆 古镇火锅， 烟火气拉满； 工业遗产基地， 轻轨25分钟 钢铁蒸汽朋克 风格大片； 打车20分钟 1.重庆动物园 打车16分钟 门票超值， 熊猫数量多， ·小贴士 看四喜丸子 重庆动物园 带好身份证 重庆的美， 在山城的每一步! 打麻将； ·穿舒适鞋子 ·注意防晒补水 巴南区\n\n备忘录 重庆交通与住宿指南 、重庆交通指南 二、重庆住宿选择 解放碑附近：出行方便 飞机抵达 ①飞机抵达：江北国际机场 位于重庆市中心，小白选这里准没错， ②地铁：T3航站楼乘10号线 附近景点多而密集，去哪里都方便， 重庆北站 转6号线直达解放碑 美食种类也丰富 ③机场快线：K01直达解放碑 （15元／人，24小时运营） 沙坪坝附近：性价比高 观音桥 高铁/火车 临近大学城，所以夜市、小吃不用担心， ①重庆北站：在市区，去解放碑 性价比高，适合学生党/穷游党， 坐10号线转2号线 就是离景点有点远 解放碑 ②重庆西站：离市区较远，去 沙坪坝 解放碑坐5号线转1号线 观音桥附近：夜生活丰富 ③沙坪坝站：离市区较远，距 重庆著名的商圈，年轻人聚集地， 离市中心14km，去解放碑坐1 附近有九街、北仓文创街等，所以夜 号线到小什字站下 重庆西站 生活丰富，吃喝玩乐一应俱全，就是 睡眠浅的宝子住的楼层太低会觉得晚 地铁：首选！不堵车 上有点吵 主城热门景点基本覆盖，单程2-9R， 不堵车不绕路 南滨路附近：顶级江景 网约车/出租车 住在这边的主打就是一个风景好， 赶时间，人多可选，市区起步价9R左右， 这边有很多江景房，喜欢拍照的姐妹 避开解放碑/洪崖洞/南滨路早晚高峰 们可以冲，就是价格稍微有点高 公交：线路密 单程2R，适合体验老重庆，但报站不清晰 选酒店小TIPS：避坑避雷！ +部分线路绕路，新手慎选 别选解放碑核心区低价民宿，大多嘈杂、 共享电动车：慎骑！ 设施老旧，无电梯，订前多看真实住客评 重庆多弯多梯坎多，部分区域禁行， 价+实拍图 容易骑出运营区扣调度费，平少的 订江景房别只看宣传，避开“侧面江景”“伪 地方别试 江景” 交步行：核心区可步行 优先选地铁口5分钟内的住宿，山城爬坡 累，交通方便真的太重要了！ 更能感受山城烟火气\n\n<备忘录 重庆美食打卡 洞洞隐火锅地下防空洞店 防空洞特色，必吃重庆地标解放碑洪崖洞慕斯蛋糕 和所有甜品免费吃☆ 零贰山江景自助老火锅 解放碑 看两江夜景吃火锅，性价比绝了！ 地道壹号防空洞火锅· 地道牛油浓香，重庆老味道！ 食济良重庆特产店· 洪崖洞 重庆特产知名品牌，都是批发价！ 花市碗杂面· 老字号小面，豌豆沙糯，杂酱鲜香！☆ 零贰山江景 洞洞隐火锅 自助老火锅 地下防空洞店 裤为吃货青年 3地道壹号 防空洞火锅 4食济良 重庆特产店 来重庆，吃得辣，玩得爽，才算不虚此行！\n\n小红书	image_post	小野茶茶	小野茶茶	\N	{"likes": "611", "收藏": 703, "点赞": 611, "评论": 37, "collects": "703", "comments": "37"}	legacy	legacy	90	{published_at}	usable	\N	2026-08-29 15:29:58.150313+00	2026-08-29 17:45:50.511712+00	\N	9
3	xiaohongshu:id:6a8d06aa000000000f01f94b	xiaohongshu	6a8d06aa000000000f01f94b	https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?xhsshare=pc_web	双视角曝光，大家看看我有念稿感吗	[00:00] 脚本写的再好\n[00:01] 你念稿感这个事你不解决\n[00:03] 你的视频就是没流量\n[00:05] OK这个是我的第二视角\n[00:07] 右边是提词器\n[00:08] 左边是摄影机\n[00:09] 那我问你\n[00:10] 现在你会觉得我有念稿感吗\n[00:12] ok 那今天\n[00:13] 我给大家分享\n[00:14] 两个北电训练的方法\n[00:16] 教你们如何去\n[00:17] 去掉这该死的念稿感\n[00:19] 说话的语速\n[00:20] 你不能太均匀了\n[00:22] 如果你每一句话\n[00:23] 都用一样的语气\n[00:24] 一样的节奏力度\n[00:26] 那观众听你讲话\n[00:27] 就好比是机器人一样\n[00:29] 真正自然的表达\n[00:31] 绝对不是每一句话都是一个调\n[00:33] 它一定是有的地方是重的\n[00:35] 有的地方是轻的\n[00:36] 「哎说到这」\n[00:38] 「我突然想起了一件事」\n[00:40] 你看我刚刚的表达\n[00:41] 是不是卡一下子\n[00:42] 结巴一下都是没有问题的\n[00:44] 这个就会显得很自然\n[00:45] 很有活人感\n[00:46] 节奏上你不能乱停顿\n[00:48] 有的人说话习惯性的很快\n[00:50] 有的人会刻意的又说的很慢\n[00:53] 但是停顿的意义\n[00:54] 是为了让重点被听进去啊\n[00:57] 你不能为了停而停啊	video	北电超然	北电超然	\N	{"likes": "161", "收藏": 205, "点赞": 161, "评论": 7, "collects": "205", "comments": "7"}	legacy	legacy	75	{published_at,media}	usable	\N	2026-08-29 15:29:57.849008+00	2026-08-29 15:30:14.675338+00	\N	1
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sessions (id, user_id, created_at, expires_at, user_agent) FROM stdin;
25f58c9e91760056fbe7b119edcbd6784ccf62a0b928c091613265cc7cc28fda	3	2026-08-21 01:09:55.492798+00	2026-09-20 01:09:55.492798+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
5817952f843fe7a151a837e1f93ff8d86b7773034a3bc2ba16d1ed5b1ea64908	1	2026-08-22 01:57:29.848889+00	2026-09-21 01:57:29.848889+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
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
096cbdb57940320b506c98a0ac6de18703d7450b3fe25637e10e55076ecccd86	10	2026-08-26 03:26:51.207066+00	2026-09-25 03:26:51.207066+00	Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.69(0x18004539) NetType/WIFI Language/zh_CN
0aa74116bc33e74098a7efd77fd2a2de70a1df917feeefa974271c999668b5f7	1	2026-08-26 03:39:29.196865+00	2026-09-25 03:39:29.196865+00	Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.75(0x18004b62) NetType/WIFI Language/zh_CN
a56a0ffe9a859925df9a342d97a1bc11e225a40121d0ae8b98f20916755e1535	1	2026-08-26 04:59:55.257048+00	2026-09-25 04:59:55.257048+00	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0
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
85	audience	女性用户	10	t	2026-08-29 15:26:44.257904+00
86	audience	关系困惑用户	20	t	2026-08-29 15:26:44.257904+00
87	user_need	关系判断需求	10	t	2026-08-29 15:26:44.257904+00
88	user_need	情绪共鸣需求	20	t	2026-08-29 15:26:44.257904+00
89	user_need	行动方案需求	30	t	2026-08-29 15:26:44.257904+00
90	topic	女性情感赛道	10	t	2026-08-29 15:26:44.257904+00
91	topic	亲密关系	20	t	2026-08-29 15:26:44.257904+00
92	topic	个人成长	30	t	2026-08-29 15:26:44.257904+00
93	core_viewpoint	强结论	10	t	2026-08-29 15:26:44.257904+00
94	core_viewpoint	反常识	20	t	2026-08-29 15:26:44.257904+00
95	core_viewpoint	方法论	30	t	2026-08-29 15:26:44.257904+00
96	breakout_point	痛点命中	10	t	2026-08-29 15:26:44.257904+00
97	breakout_point	身份认同	20	t	2026-08-29 15:26:44.257904+00
98	breakout_point	结果承诺	30	t	2026-08-29 15:26:44.257904+00
99	title_mechanism	强结论标题	10	t	2026-08-29 15:26:44.257904+00
100	title_mechanism	反差标题	20	t	2026-08-29 15:26:44.257904+00
101	title_mechanism	数字清单标题	30	t	2026-08-29 15:26:44.257904+00
102	opening_method	直接结论	10	t	2026-08-29 15:26:44.257904+00
103	opening_method	问题切入	20	t	2026-08-29 15:26:44.257904+00
104	opening_method	案例切入	30	t	2026-08-29 15:26:44.257904+00
105	content_structure	案例拆解结构	10	t	2026-08-29 15:26:44.257904+00
106	content_structure	总分总结构	20	t	2026-08-29 15:26:44.257904+00
107	content_structure	步骤清单结构	30	t	2026-08-29 15:26:44.257904+00
108	argumentation_method	案例论证	10	t	2026-08-29 15:26:44.257904+00
109	argumentation_method	对比论证	20	t	2026-08-29 15:26:44.257904+00
110	argumentation_method	因果论证	30	t	2026-08-29 15:26:44.257904+00
111	language_style	口语化	10	t	2026-08-29 15:26:44.257904+00
112	language_style	专业解释	20	t	2026-08-29 15:26:44.257904+00
113	language_style	情绪共鸣	30	t	2026-08-29 15:26:44.257904+00
114	length	短内容	10	t	2026-08-29 15:26:44.257904+00
115	length	中等篇幅	20	t	2026-08-29 15:26:44.257904+00
116	length	长内容	30	t	2026-08-29 15:26:44.257904+00
117	layout	短句分段	10	t	2026-08-29 15:26:44.257904+00
118	layout	清单排版	20	t	2026-08-29 15:26:44.257904+00
119	layout	小标题排版	30	t	2026-08-29 15:26:44.257904+00
120	visual_style	真人口播	10	t	2026-08-29 15:26:44.257904+00
121	visual_style	图文卡片	20	t	2026-08-29 15:26:44.257904+00
122	visual_style	知识板书	30	t	2026-08-29 15:26:44.257904+00
123	bgm	无BGM	10	t	2026-08-29 15:26:44.257904+00
124	bgm	情绪氛围	20	t	2026-08-29 15:26:44.257904+00
125	bgm	节奏型	30	t	2026-08-29 15:26:44.257904+00
126	cta	互动提问	10	t	2026-08-29 15:26:44.257904+00
127	cta	关注引导	20	t	2026-08-29 15:26:44.257904+00
128	cta	私信转化	30	t	2026-08-29 15:26:44.257904+00
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, name, dept, role, avatar_hue, created_at, username, password_hash, last_login_at) FROM stdin;
4	朱涛	\N	reviewer	\N	2026-08-21 02:53:08.628673+00	ZT123	scrypt$16384$8$1$729731c5d25da09a91af09928a28247e$490d0f6c15ada13e58714dd30bd6ba412ac6c224669c33ae80f72f7e1f1b558e	2026-08-25 07:24:42.140389+00
11	李敏	\N	reviewer	\N	2026-08-21 07:50:55.686453+00	李敏	scrypt$16384$8$1$1a350d58d171ea3d76993b4d1e275955$3de4db9da0985e94c5e85970f5c036b5810d819e8b73c7d5a9723225d8905cce	2026-08-24 02:21:10.667228+00
9	杨俊杰	运营	reviewer	\N	2026-08-21 07:21:38.171351+00	杨俊杰	scrypt$16384$8$1$742d62188e40a936f6cda838ef4d31c6$ef71a9d1f96f8b5e688fbcabc839b417c57683d9f5e7ef7348d79db52297cef7	2026-08-24 02:30:51.146294+00
3	李鑫	\N	reviewer	\N	2026-08-21 01:09:55.486818+00	lixin	scrypt$16384$8$1$c70b42bdb7afb7f63c05e30a5fa1d102$623f0903627b08318dcbfd32893d49c4580700e518f81a31924f5a449a024941	2026-08-25 08:05:07.154927+00
13	技术1-测试（系统）	外部系统	member	\N	2026-08-24 02:46:14.568649+00	\N	\N	\N
7	李年	\N	reviewer	\N	2026-08-21 04:53:28.87073+00	李年	scrypt$16384$8$1$9f8324b02c8ac334c48622997806efc9$22fd1f1f1e46cde4dd6f2578ca0d6844a6593ec203c2db5f457b2c2cbad639fc	2026-08-24 07:51:43.68546+00
12	测试	\N	reviewer	\N	2026-08-22 01:58:20.620055+00	测试	scrypt$16384$8$1$cd9981c8fb86140dd475fced8b2f2e6f$591db77d097dd0da6a0adf03f20667649294527b3ecd844314d1ae57e9e4e789	\N
8	刘大增	\N	reviewer	\N	2026-08-21 06:02:11.821697+00	刘大增	scrypt$16384$8$1$cd958f1c038dbd9a1297e9cf97e107a5$4a13803a1a1827108e2995d4651dc77be5f18e8410a14dcf1ce736f682d1ae55	2026-08-25 08:42:01.629454+00
10	杨池	\N	reviewer	\N	2026-08-21 07:22:15.994905+00	杨池	scrypt$16384$8$1$ac914aad522fa20dc071cdc501f90146$7e9a997c2b2daf056de0775af3fde591d18027379dd05ed72bb1d9b807acc7aa	2026-08-26 03:26:51.201646+00
1	华俊杰	技术部	admin	\N	2026-08-20 16:20:58.388805+00	fafa	scrypt$16384$8$1$b29352dac5f39aa4f878bb80304d4b18$8aa290fb2b067c09c463d7e39d4c98bdf48c21c6479ce572b74f3c7b0f0b4d03	2026-08-26 04:59:55.252613+00
\.


--
-- Data for Name: work_analyses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.work_analyses (work_id, task_id, platform, schema_ver, payload, digest, received_at, cover_file) FROM stdin;
174	f90d29b0a27b	xiaohongshu	15	{"schema_version":15,"task_id":"f90d29b0a27b","source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251704/e311ac2f0961f3522764bd2742b83c75/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_dft_wlteh_jpg_3","duration_seconds":296.077,"width":1080,"height":1920,"size_bytes":35337961,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_b64":"（已落地为本地封面文件，原始 200271 字符）"}},"title":"女孩子无聊的本质是生命力的匮乏","description":"","cover_title":"女孩子无趣的本质是生命力的匮乏","cover_title_meta":{"text":"女孩子无趣的本质是生命力的匮乏","confidence":0.939,"font_ratio":1.31,"line_count":2,"lines":[{"text":"女孩子无趣的本质","confidence":0.998},{"text":"生命力的贵乏","confidence":0.88}],"source_image_index":1,"reference_corrected":true,"source":"video_cover"},"post_title":"女孩子无聊的本质是生命力的匮乏","post_description":"","display_title":"女孩子无趣的本质是生命力的匮乏","author":"可可拆爆款","account":{"name":"可可拆爆款","profile_url":"https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1","bio":"👩全网100W➕粉丝\\n🎉你却的不是方法，而是一个带你的人\\n🌲账号定位｜流量卡点｜爆款模板\\n🔗下方进👗","following_count":"1010","follower_count":"122838","likes_and_collections_count":"1149588"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"4万","collects":"3.2万","comments":"648"},"topics":["女孩子","女性智慧","女性成长","生命力","少女心事","girlstalk","本质","人生智慧"],"video_text":"[00:00] 女孩子无趣的本质\\n[00:01] 是生命力的匮乏\\n[00:03] 自己觉得越来越没有意思\\n[00:04] 请把这篇文章仔细看完\\n[00:06] 都适合看这篇文章的\\n[00:07] 如果你只是想要几个\\n[00:09] 让显得有趣的技巧\\n[00:10] 比如怎么接话\\n[00:11] 怎么聊天不冷场OK\\n[00:13] 那你可以划掉我了\\n[00:14] 但如果你有一种隐隐的感觉\\n[00:15] 好像活着活着\\n[00:16] 我自己变得越来越平\\n[00:18] 和人说话也没有什么好说的\\n[00:20] 独处时也找不到什么\\n[00:21] 真正让自己发光的东西\\n[00:23] 那这篇文章就是写给你的\\n[00:24] 我们来说一个很多人\\n[00:25] 都不敢承认的事实\\n[00:26] 叫做无趣\\n[00:27] 不是性格问题\\n[00:29] 那些\\n[00:30] 真正让人觉得无聊的女孩\\n[00:32] 往往不是因为她们沉默\\n[00:33] 而是她们内部空掉了\\n[00:35] 你坐在那里\\n[00:36] 笑得很得体\\n[00:37] 说话也没有失礼\\n[00:38] 但是就给人一种感觉\\n[00:39] 她好像没有在活着\\n[00:41] 眼神是漂浮的\\n[00:42] 热情是借来的\\n[00:43] 兴趣是假装的\\n[00:45] 这不是性格内向\\n[00:46] 这是生命力在悄悄流失\\n[00:48] 是从什么时候开始流失的呢\\n[00:50] 有一个概念叫做习得性无助\\n[00:53] 是斯坦福大学的心理学家\\n[00:54] 马丁格力塞尔\\n[00:56] 是斯坦心理学里心理学\\n[00:58] 心理学研究有个概念\\n[00:58] 是斯坦福心理学里心理学\\n[01:00] 叫做习得性无助\\n[01:01] 是斯坦福大学的心理学家\\n[01:03] 马丁塞利格曼\\n[01:05] 在长期研究中提出的\\n[01:06] 她说\\n[01:07] 当一个人在一个领域里\\n[01:08] 反复受挫\\n[01:09] 反复被否定\\n[01:10] 就会形成一种内在的信念\\n[01:12] 不管我做什么都没有用\\n[01:14] 最可怕的东西就在于\\n[01:16] 这种信念会蔓延\\n[01:17] 从一件事蔓延到整个\\n[01:18] 生活\\n[01:18] 从我不擅长这个\\n[01:19] 变成我不擅长任何事\\n[01:21] 从这件事情我失败了\\n[01:23] 变成我这个人本身就是失败的\\n[01:25] 然后就会出现一种症状\\n[01:26] 什么都提不起劲\\n[01:27] 没有特别想去做的事\\n[01:28] 没有特别想去的地方\\n[01:29] 没有特别喜欢的人\\n[01:30] 也没有特别在意的梦想\\n[01:31] 活着\\n[01:32] 就好像是在待机\\n[01:34] 那关键点来了啊\\n[01:36] 无趣的本质\\n[01:37] 是一个人和自己内在欲望的断联\\n[01:39] 你不是真的没有欲望\\n[01:41] 你只是慢慢学会不去感受它\\n[01:42] 因为感受之后会失望\\n[01:43] 会被否定\\n[01:44] 会被现实打脸\\n[01:46] 所以更安全的方式\\n[01:47] 是提前关掉那个开关\\n[01:49] 期待 不渴望 不热爱\\n[01:50] 不期待 不渴望 不热爱\\n[01:51] 看起来很平静\\n[01:52] 实则是生命力\\n[01:53] 在一点一点的露出去\\n[01:55] 而一个内部空掉的人\\n[01:56] 无论外表多精致\\n[01:58] 无论说话多礼貌\\n[01:59] 都很难真正的吸引人\\n[02:01] 也很难真正的被吸引\\n[02:02] 因为吸引的本质是能量\\n[02:04] 是那种活着在燃烧\\n[02:06] 对世界还有好奇心的能量\\n[02:08] 我见过很多这样的女孩啊\\n[02:10] 二0多岁大家上着还不错的班\\n[02:13] 长得很好看\\n[02:14] 说话也很得体\\n[02:15] 但是你跟她相处完之后\\n[02:16] 记不住她说了什么\\n[02:17] 她对什么真正的热情\\n[02:19] 她想说都行\\n[02:20] 你问她想做什么\\n[02:21] 她说随便\\n[02:22] 有没有什么想实现的事\\n[02:23] 她想了很久\\n[02:24] 说呃\\n[02:24] 其实也没有什么特别想的\\n[02:26] 那刻我突然很难过\\n[02:28] 我不是替她可怜\\n[02:29] 是替那个曾经也有过\\n[02:30] 欲望\\n[02:31] 和热情的小女孩\\n[02:33] 感到心疼\\n[02:34] 那些欲望没有消失\\n[02:35] 只是他们被压的太久了\\n[02:37] 慢慢的变得看不见了\\n[02:39] 那相反的人是什么呀\\n[02:41] 那种让人觉得哇\\n[02:42] 她好有趣\\n[02:43] 的女性\\n[02:44] 你有没有认真观察过\\n[02:45] 她们有什么共同点\\n[02:46] 不是因为她们更好笑\\n[02:47] 不是因为他们见识更广\\n[02:48] 不是因为他们天生外向\\n[02:49] 而是因为她们都有某种特质\\n[02:50] 叫做他们对某种事物\\n[02:51] 有着真实的\\n[02:53] 自己的感受\\n[02:54] 可能是某种食物\\n[02:55] 可能是某一个地方\\n[02:56] 可能是某一类书\\n[02:57] 也可能是某种手艺\\n[02:58] 不需要很多\\n[02:59] 甚至只需要一件\\n[03:00] 但那种热情是真实的\\n[03:01] 是从内往外涌的\\n[03:03] 而不是为了让别人觉得有趣\\n[03:05] 而表演出来的\\n[03:06] 而这就是生命力\\n[03:07] 那生命力是可以被找回来的吗\\n[03:09] 当然而且是有办法的\\n[03:11] 神经科学的研究已经证实\\n[03:12] 我们的大脑\\n[03:13] 其实具备很强的可塑性\\n[03:15] 即使是长期\\n[03:16] 处于低活跃状态的\\n[03:18] 也可以通过新的体验\\n[03:19] 和重复的行为\\n[03:20] 被重新激活\\n[03:21] 换句话说\\n[03:22] 那个曾经\\n[03:23] 对什么都有好奇心的自己\\n[03:24] 没有消失\\n[03:25] 只是睡着了\\n[03:26] 我们可以把它唤醒\\n[03:27] 那具体怎么做\\n[03:28] 去做一件没有用的事情\\n[03:30] 注意是没有用的\\n[03:31] 不是为了提高竞争力\\n[03:32] 不是为了填简历\\n[03:33] 不是为了让别人觉得哇\\n[03:34] 你好厉害\\n[03:36] 就是因为单纯的\\n[03:37] 觉得有点意思\\n[03:38] 可以是一种做饭的方法\\n[03:39] 你一直想学的东西\\n[03:40] 也可以是\\n[03:41] 某个从来没有去过的地方\\n[03:42] 可以是一本你之前翻了两页\\n[03:44] 哎就放下了书\\n[03:45] 不要去想它有没有意义\\n[03:46] 生命力的重启\\n[03:47] 往往从无用之事开始\\n[03:49] 第二步每天花五分钟\\n[03:50] 写今天\\n[03:51] 什么东西让我有新的感觉\\n[03:54] 就一句话\\n[03:55] 可以是情绪\\n[03:56] 可以是一个场景\\n[03:56] 可以是一种味道\\n[03:57] 可以是一段话\\n[03:58] 就是重新训练你的感受力\\n[04:00] 帮你重新学会感受\\n[04:02] 而不是麻木的过日子\\n[04:04] 第三步\\n[04:04] 给自己制造一点点陌生感\\n[04:06] 心理学研究发现\\n[04:07] 大脑在接触新奇事物时\\n[04:09] 会分泌多巴胺\\n[04:10] 而多巴胺正是驱使我们好奇\\n[04:11] 探索感受活着的关键物质\\n[04:14] 每周做一件从来没做过的小事\\n[04:16] 走一条没有走过的路\\n[04:17] 点一道从来没有吃过的菜\\n[04:18] 听一首完全不熟悉的音乐\\n[04:19] 不用太大\\n[04:20] 但要真实的去感受\\n[04:22] 生命力不是天赋\\n[04:23] 也不是性格\\n[04:24] 也不是某种你要么有\\n[04:25] 要么没有的东西\\n[04:27] 它是一个需要被滋养的东西\\n[04:28] 我们中的很多人\\n[04:30] 其实在成长的过程中\\n[04:31] 被告诉说不要太有想法\\n[04:34] 不要太敏感\\n[04:35] 不要表现的太渴望\\n[04:36] 要懂事\\n[04:37] 要乖平稳要稳定\\n[04:39] 于是我们慢慢就变成了一个\\n[04:41] 不太有想法\\n[04:42] 不太敏感\\n[04:43] 不太渴望什么的人\\n[04:44] 看起来成熟了\\n[04:45] 实则呢\\n[04:46] 是把生命力给训练掉了\\n[04:48] 但今天你看到了这一点\\n[04:49] 说明那个有生命力的你还在\\n[04:51] 她只是在等一个人\\n[04:53] 可以重新活的有热情一点吗","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":6,"chunks_succeeded":6,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T09:09:45.154752+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要讨论‘女孩子无趣的本质是生命力的匮乏’，将无趣归因于内在生命力流失，而非性格问题。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对感到自己越来越无趣、生活平淡、缺乏热情和内在动力的女性，尤其是那些在社交或独处中感到空虚的年轻女性。"},"user_need":{"label":"用户主要问题或需求","summary":"用户的核心需求是理解自己为何变得无趣，并希望找回内在的热情和生命力，而非仅仅学习表面社交技巧。"},"content_structure":{"label":"内容怎么展开","summary":"内容从提出问题（无趣是生命力匮乏）开始，引入心理学概念（习得性无助）解释原因，再对比有趣女性的特质，最后给出具体方法。"},"solution":{"label":"给了什么解决办法","summary":"给出了三步具体方法：做一件‘无用’的事、每天花五分钟记录新感受、每周制造一点陌生感（如走新路、尝新菜）。"},"references":{"label":"值得参考什么","summary":"值得参考的是内容中引用的心理学概念（习得性无助）和神经科学观点（大脑可塑性、多巴胺与新奇感），以及其对比分析（无趣vs有趣女性的特质）。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做‘如何具体执行三步方法’的实操指南、‘习得性无助’的科普解读、‘女性成长与生命力’的系列内容，或‘真实案例分享’等。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251704/e311ac2f0961f3522764bd2742b83c75/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_dft_wlteh_jpg_3", "taskId": "f90d29b0a27b", "topics": ["女孩子", "女性智慧", "女性成长", "生命力", "少女心事", "girlstalk"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1", "name": "可可拆爆款", "followers": 122838}, "aiModel": "deepseek-v4-flash", "duration": "4分56秒", "platform": "xiaohongshu", "coverFrom": "inline", "mainTopic": "这条内容主要讨论‘女孩子无趣的本质是生命力的匮乏’，将无趣归因于内在生命力流失，而非性格问题。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "4万", "collects": "3.2万", "comments": "648", "likesNum": 40000, "collectsNum": 32000, "commentsNum": 648}, "imageCount": 0, "imageFiles": [], "topicCount": 8, "generatedAt": "2026-08-25T09:09:45.154752+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 3707}	2026-08-25 09:20:56.490278+00	\N
184	45ecbd25bd1f	xiaohongshu	15	{"schema_version":15,"task_id":"45ecbd25bd1f","source_url":"https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?source=webshare&xhsshare=pc_web&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?source=webshare&xhsshare=pc_web&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&xsec_source=pc_share","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251724/a2ac49d2b5327b4603abe7cdc07e0f50/1040g2sg323t3k20m0ae05nenu9pg8u99tt3aqdo!nd_dft_wlteh_jpg_3","duration_seconds":156.4,"width":480,"height":854,"size_bytes":10330816,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_b64":"（已落地为本地封面文件，原始 81767 字符）"}},"title":"顶级吸引力就是无所谓","description":"情绪管理 职场 野生老板","cover_title":"","cover_title_meta":{},"post_title":"顶级吸引力就是无所谓","post_description":"情绪管理 职场 野生老板","display_title":"顶级吸引力就是无所谓","author":"野生老板商业思维","account":{"name":"野生老板商业思维","profile_url":"https://www.xiaohongshu.com/user/profile/5dd7f2730000000001007929","bio":"2020福布斯U30，地产资管公司创始人\\n强势文化｜国学智慧｜关系运作｜商业思维\\n@野生老板 官方授权","following_count":"204","follower_count":"27558","likes_and_collections_count":"218920"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"1399","collects":"922","comments":"37"},"topics":["人格魅力","吸引力","顶级思维","情绪管理","自我提升","职场","人性弱点","野生老板"],"video_text":"[00:00] 一个人的终极吸引力其实\\n[00:01] 就\\n[00:01] 淡定\\n[00:02] 这个是道德经里非常\\n[00:03] 反常识的一个真相\\n[00:05] 在道德经第29章\\n[00:06] 他说天下神器不可为也\\n[00:08] 不可执也\\n[00:08] 为者败之\\n[00:09] 执者失之\\n[00:10] 他说的就是\\n[00:11] 你越想用力抓住的东西\\n[00:12] 往往就是你失去的越快\\n[00:14] 而当你彻底放下执念\\n[00:15] 表现的云淡风轻\\n[00:16] 无欲则刚的时候\\n[00:17] 全世界的资源反而会主动的\\n[00:19] 向你靠拢\\n[00:20] 所有那些刻意展示出来的\\n[00:21] 啊\\n[00:22] 其实不够高级\\n[00:23] 精致的妆容\\n[00:24] 各种好听的话术\\n[00:25] 你越是主动\\n[00:26] 越是用力的去输出\\n[00:28] 在真正高手的眼里\\n[00:29] 你就显得越低级和匮乏\\n[00:31] 真正的\\n[00:31] 顶级吸引力来自于\\n[00:33] 克制\\n[00:33] 而在这个背后的本质\\n[00:35] 它其实是一种无为和不\\n[00:36] 执着的智慧\\n[00:37] 第一个\\n[00:38] 淡定的本质是不在乎\\n[00:39] 你不在意身边人的去留\\n[00:41] 不在乎别人的眼光和评价\\n[00:42] 不在意一段关系里的得\\n[00:44] 与失\\n[00:44] 你可以去留意一下\\n[00:45] 在关系里面最让人着迷\\n[00:47] 的那个人\\n[00:47] 从来不是那个患得患失\\n[00:48] 随时消息秒回\\n[00:49] 很在乎你的人\\n[00:50] 而是那个\\n[00:51] 无论你走也好留也好\\n[00:52] 回他消息也好\\n[00:53] 不理他也好\\n[00:54] 他都稳定的像石头一样\\n[00:56] 稳定的可怕的那个人\\n[00:57] 这种人的无所谓\\n[00:58] 他不是装出来的\\n[00:59] 他是真的\\n[01:00] 他是真的无所谓\\n[01:00] 本质是我的人生\\n[01:01] 能做到绝对的自给自足\\n[01:03] 绝对的自我圆满\\n[01:04] 这种淡定感\\n[01:06] 他是会给对方带来\\n[01:07] 巨大的心理压迫感的\\n[01:08] 因为他会突然发现\\n[01:09] 在你这里我没有任何筹码\\n[01:11] 可以谈判\\n[01:11] 他不能用离开来威胁你\\n[01:13] 因为你不需要他\\n[01:14] 他也不能用冷暴力来\\n[01:15] 控制你\\n[01:16] 因为你一个人也活得很好\\n[01:17] 他更加不能用这种\\n[01:18] 夸奖赞美来去收买你\\n[01:19] 因为你的自我价值是\\n[01:20] 不需要他来确认的\\n[01:21] 而当一个人在关系里面\\n[01:22] 找不到任何一个可以拿捏你的点\\n[01:24] 那他只剩两条路可以走\\n[01:25] 要么主动靠近你去适应你\\n[01:27] 要么自觉退出离场\\n[01:29] 而你呢这两种结果其实\\n[01:31] 都能接受\\n[01:32] 这个才是真正关系里\\n[01:34] 的主动权并\\n[01:35] 不是你控制了他\\n[01:36] 而是你控制了自己\\n[01:36] 你让自己绝对的冷静克制\\n[01:38] 而他这个时候就不得不\\n[01:40] 跟着你的节奏去走了\\n[01:41] 第二个淡定\\n[01:42] 它是一种内在的状态\\n[01:43] 而不是装出来的冷漠\\n[01:44] 道德经里有一句话形容淡定\\n[01:46] 我觉得非常合适\\n[01:47] 说清静为天下正\\n[01:48] 清静啊才是这个天下万事\\n[01:50] 万物的标准\\n[01:51] 什么叫清静\\n[01:52] 说实话我是不认同现在那些\\n[01:53] 所谓的修行就要打坐冥想\\n[01:55] 与世隔绝的\\n[01:56] 在我看来真正的清静是在这个世俗\\n[01:56] 真正的清净是在这个世俗\\n[01:58] 你的内心依旧是满的\\n[02:01] 依旧是不需要外界来去填补\\n[02:02] 你不需要别人的认可来确认自己的价值\\n[02:04] 也不需要一段关系来证明自己值得被爱\\n[02:06] 不需要任何人来评价定义你\\n[02:09] 当你能够自给自足的时候\\n[02:11] 其实你的状态自然而然就会\\n[02:12] 这个不是自我压抑出来的伪装\\n[02:14] 是外界根本他没有什么东西是可以撼动你的\\n[02:17] 一个内在圆满的人\\n[02:19] 他的淡定一定是\\n[02:20] 由内而外散发出来的状态\\n[02:21] 而不是装出来的外在的\\n[02:23] 所以顶级的魅力啊\\n[02:24] 他从来不是往自己身上做\\n[02:25] 去学什么话术\\n[02:26] 去打扮自己\\n[02:27] 在我看来\\n[02:28] 他是做减法\\n[02:30] 减掉你对外界的需要\\n[02:31] 减掉那些你拼命向外抓取的所有动作\\n[02:32] 你以为的魅力是你展示\\n[02:34] 但真正的魅力其实是你\\n[02:35] 不展示什么","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":3,"chunks_succeeded":3,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":26,"replies_scanned":6,"primary_pages":2,"reply_pages":2,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.214,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T09:27:31.674988+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要讲‘顶级吸引力’来自淡定、克制和无为，而非刻意展示或用力抓取。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对在职场或人际关系中感到焦虑、想提升个人吸引力或情绪管理能力的人群。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能希望解决在关系或职场中过度用力、患得患失，导致失去主动权或吸引力的问题。"},"content_structure":{"label":"内容怎么展开","summary":"内容先提出核心观点，引用道德经解释，然后分两个要点展开：淡定的本质是不在乎，淡定是内在状态而非伪装，最后总结魅力是做减法。"},"solution":{"label":"给了什么解决办法","summary":"给出的解决办法是：放下执念，做到内在自给自足，不依赖外界认可，从而自然散发淡定感，获得关系主动权。"},"references":{"label":"值得参考什么","summary":"值得参考的是道德经第29章和‘清静为天下正’的哲学观点，以及‘无为’‘不执着’的智慧。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸内容：具体如何在职场中应用‘无所谓’心态、如何区分真正的淡定与伪装冷漠、关系中的心理博弈案例等。"}},"source_labels":["文字标题","作品描述","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "480×854", "cover": "http://sns-webpic-qc.xhscdn.com/202608251724/a2ac49d2b5327b4603abe7cdc07e0f50/1040g2sg323t3k20m0ae05nenu9pg8u99tt3aqdo!nd_dft_wlteh_jpg_3", "taskId": "45ecbd25bd1f", "topics": ["人格魅力", "吸引力", "顶级思维", "情绪管理", "自我提升", "职场"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5dd7f2730000000001007929", "name": "野生老板商业思维", "followers": 27558}, "aiModel": "deepseek-v4-flash", "duration": "2分36秒", "platform": "xiaohongshu", "coverFrom": "inline", "mainTopic": "这条内容主要讲‘顶级吸引力’来自淡定、克制和无为，而非刻意展示或用力抓取。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "1399", "collects": "922", "comments": "37", "likesNum": 1399, "collectsNum": 922, "commentsNum": 37}, "imageCount": 0, "imageFiles": [], "topicCount": 8, "generatedAt": "2026-08-25T09:27:31.674988+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": 26, "transcriptChars": 2144}	2026-08-26 02:42:00.352867+00	8beb7209ed7cae9a3653b0e8142e5f39da032b5d.jpg
181	ZZTEST0825	xiaohongshu	13	{"schema_version":13,"task_id":"ZZTEST0825","source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251136/9d938faac4ad47ede74adf800260ccdc/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_prv_wlteh_jpg_3","duration_seconds":296.077,"width":1080,"height":1920,"size_bytes":49044082,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true}},"title":"女孩子无聊的本质是生命力的匮乏","description":"","cover_title":"女孩子无趣的本质是生命力的匮乏","cover_title_meta":{"text":"女孩子无趣的本质是生命力的匮乏","confidence":0.954,"font_ratio":1.32,"line_count":2,"lines":[{"text":"女孩子无趣的本质","confidence":0.998},{"text":"生命力的匮乏","confidence":0.909}],"source_image_index":1,"reference_corrected":true,"source":"video_cover"},"post_title":"女孩子无聊的本质是生命力的匮乏","post_description":"","display_title":"女孩子无趣的本质是生命力的匮乏","author":"可可拆爆款","account":{"name":"可可拆爆款","profile_url":"https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1","bio":"👩全网100W➕粉丝\\n🎉你却的不是方法，而是一个带你的人\\n🌲账号定位｜流量卡点｜爆款模板\\n🔗下方进👗","following_count":"1010","follower_count":"122814","likes_and_collections_count":"1148511"},"page_text":"","text_same_as_description":false,"engagement":{"likes":"4万","collects":"3.2万","comments":"647"},"topics":["女孩子","女性智慧","女性成长","生命力","少女心事","girlstalk","本质","人生智慧"],"video_text":"[00:00] 女孩子无趣的本质\\n[00:00] 是生命力的匮乏\\n[00:02] 自己觉得越来越没有意思\\n[00:04] 请把这篇文章仔细看完\\n[00:05] 不是所有人都适合看这篇文章的\\n[00:07] 如果你只是想要几个\\n[00:08] 让显得有趣的技巧\\n[00:10] 比如怎么接话\\n[00:10] 怎么聊天不冷场OK\\n[00:12] 那你可以划掉我了\\n[00:13] 但如果你有一种隐隐的感觉\\n[00:15] 好像活着活着\\n[00:16] 我自己变得越来越平\\n[00:17] 和人说话也没有什么好说的\\n[00:19] 独处时也找不到什么\\n[00:21] 真正让自己发光的东西\\n[00:22] 那这篇文章就是写给你的\\n[00:24] 我们来说一个很多人\\n[00:25] 都不敢承认的事实\\n[00:26] 叫做无趣\\n[00:27] 不是性格问题\\n[00:28] 也不是不会说话\\n[00:29] 那些\\n[00:30] 真正让人觉得无聊的女孩\\n[00:32] 往往不是因为她们沉默\\n[00:33] 而是她们内部空掉了\\n[00:34] 你坐在那里\\n[00:35] 笑得很得体\\n[00:36] 说话也没有失礼\\n[00:37] 但是就给人一种感觉\\n[00:38] 她好像没有在活着\\n[00:40] 眼神是漂浮的\\n[00:42] 聊天是应付的\\n[00:43] 热情是借来的\\n[00:44] 兴趣是假装的\\n[00:45] 这不是性格内向\\n[00:46] 这是生命力在悄悄流失\\n[00:48] 是什么时候开始流失的呢\\n[00:50] 有一个概念叫做习得性无助\\n[00:52] 是斯坦福大学的心理学家\\n[00:54] 马丁格力塞尔\\n[00:56] 是斯坦心理学里心理学\\n[00:58] 心理学\\n[00:58] 心理学研究有个概念\\n[01:00] 叫做习得性无助\\n[01:02] 是斯坦福大学的心理学家\\n[01:03] 马丁塞利格曼\\n[01:05] 在长期研究中提出的\\n[01:06] 她说\\n[01:07] 当一个人在一个领域里\\n[01:08] 反复受挫\\n[01:09] 反复被否定\\n[01:11] 就会形成一种内在的信念\\n[01:12] 不管我做什么都没有用\\n[01:14] 最可怕的东西就在于\\n[01:16] 这种信念会蔓延\\n[01:17] 从一件事蔓延到整个\\n[01:18] 生活从我不擅长这个\\n[01:19] 变成我不擅长任何事\\n[01:21] 从这件事情我失败了\\n[01:23] 我个人本身就是失败的\\n[01:25] 然后就会出现一种症状\\n[01:26] 什么都提不起劲\\n[01:27] 没有特别想去做的事\\n[01:28] 没有特别想去的地方\\n[01:29] 没有特别喜欢的人\\n[01:31] 也没有特别在意的梦想\\n[01:32] 活着就好像是在待机\\n[01:35] 那关键点来了啊\\n[01:36] 无趣的本质\\n[01:37] 是一个人和自己内在欲望的断联\\n[01:39] 你不是真的没有欲望\\n[01:41] 你只是慢慢学会不去感受它\\n[01:42] 因为感受之后会失望\\n[01:44] 会被否定\\n[01:45] 会被现实打脸\\n[01:46] 所以更安全的方式\\n[01:48] 是提前关掉那个开关\\n[01:49] 期待\\n[01:50] 不渴望\\n[01:51] 看起来很平静\\n[01:52] 实质是生命力\\n[01:53] 在一点点的露出出去\\n[01:55] 而一个内部空掉的人\\n[01:56] 无论外表多精致\\n[01:57] 无论说话多礼貌\\n[01:58] 都很难真正的吸引人\\n[02:00] 也很难真正的被吸引\\n[02:01] 因为吸引的本质是能量\\n[02:04] 是那种活着在燃烧\\n[02:05] 对世界还有好奇心的能量\\n[02:07] 我见过很多这样的女孩啊\\n[02:09] 二0多岁大家上着还不错的班\\n[02:12] 长得也很好看\\n[02:13] 说话也很得体\\n[02:14] 但是你跟她相处完之后\\n[02:15] 记不住她说了什么\\n[02:16] 也感受不到她对什么真正的热情\\n[02:18] 她说都行\\n[02:19] 你问她想做什么\\n[02:20] 她说随便\\n[02:21] 有没有什么想实现的事\\n[02:22] 她想很久\\n[02:23] 说呃\\n[02:24] 其实也没有什么特别想的\\n[02:25] 那刻我突然很难过\\n[02:27] 我不是替她可怜\\n[02:28] 是替那个\\n[02:29] 曾经也有过欲望\\n[02:30] 和热情的小女孩\\n[02:32] 感到心疼\\n[02:33] 那些欲望没有消失\\n[02:35] 只是他们被压的太久了\\n[02:36] 慢慢的\\n[02:37] 变得看不见了\\n[02:38] 那相反的人是什么呀\\n[02:40] 那种让人觉得哇\\n[02:41] 她好有趣的女性\\n[02:43] 你有没有认真观察过\\n[02:44] 她们有什么共同点\\n[02:45] 不是因为他们更好笑\\n[02:46] 不是因为他们见识更广\\n[02:47] 不是因为他们天生外向\\n[02:48] 而是因为她们都有某种特质\\n[02:49] 叫做他们对某种事物\\n[02:51] 有着真实的\\n[02:52] 自己的感受\\n[02:53] 可能是某一种食物\\n[02:54] 可能是某种食物\\n[02:54] 可能是某一个地方\\n[02:55] 可能是某一类书\\n[02:56] 也可能是某种手艺\\n[02:58] 不需要很多\\n[02:59] 甚至只需要一件\\n[03:00] 但那种热情是真实的\\n[03:01] 是从内往外涌的\\n[03:03] 而不是为了让别人觉得有趣\\n[03:05] 而表演出来的\\n[03:06] 而这就是生命力\\n[03:07] 那生命力是可以被找回来的吗\\n[03:09] 当然而且是有办法的\\n[03:11] 神经科学的研究已经证实\\n[03:13] 我们的大脑\\n[03:14] 其实具备很强的可塑性\\n[03:15] 即使是长期\\n[03:16] 处于低活跃状态的\\n[03:18] 也可以通过新的体验\\n[03:19] 和重复的行为\\n[03:20] 被重新激活\\n[03:21] 换句话说\\n[03:22] 那个曾经\\n[03:23] 对什么都有好奇心的自己\\n[03:25] 没有消失\\n[03:25] 只是睡着了\\n[03:26] 我们可以把她唤醒\\n[03:27] 那具体怎么做\\n[03:28] 去做一件没有用的事情\\n[03:30] 注意是没有用的\\n[03:31] 不是为了提高竞争力\\n[03:32] 不是为了填简历\\n[03:33] 不是为了让别人觉得哇\\n[03:35] 你好厉害\\n[03:36] 就是因为单纯的\\n[03:37] 觉得有点意思\\n[03:38] 可以是一种做饭的方法\\n[03:39] 你一直想学的东西\\n[03:41] 也可以是\\n[03:41] 某个从来没有去过的地方\\n[03:42] 可以是一本你之前翻了两页\\n[03:44] 哎就放下了书\\n[03:45] 不要去想它有没有意义\\n[03:46] 生命力的重启\\n[03:47] 往往从无用之事开始\\n[03:49] 第二步每天花五分钟\\n[03:50] 写今天\\n[03:51] 什么东西让我有新的感觉\\n[03:54] 就一句话\\n[03:55] 可以是情绪\\n[03:56] 可以是一种味\\n[03:57] 道可以是一段话\\n[03:58] 就是重新训练你的感受力\\n[04:00] 帮你重新学会感受\\n[04:02] 而不是麻木的过日子\\n[04:03] 第三步\\n[04:04] 给自己制造一点点陌生感\\n[04:06] 心理学研究就发现\\n[04:07] 大脑在接触新奇事物时\\n[04:08] 会分泌多巴胺\\n[04:09] 而多巴胺正是驱使我们好奇\\n[04:11] 探索感受活着的关键物质\\n[04:14] 做一件从来没做过的小事\\n[04:16] 哎走一条没有走过的路\\n[04:17] 点一道从来没有吃过的菜\\n[04:18] 听一首完全不熟悉的音乐\\n[04:20] 不求大\\n[04:21] 但要真实的去感受\\n[04:22] 生命力不是天赋\\n[04:24] 也不是某种你要么有\\n[04:25] 要么没有的东西\\n[04:26] 它是一个需要被滋养的东西\\n[04:28] 我们中的很多人\\n[04:29] 其实在成长的过程中\\n[04:31] 被告诉说不要太有想法\\n[04:34] 不要太敏感\\n[04:35] 不要表现的太渴望\\n[04:36] 要懂事\\n[04:37] 要乖平稳要稳定\\n[04:39] 于是\\n[04:40] 我们慢慢就变成了\\n[04:41] 不太有想法\\n[04:42] 不太敏感\\n[04:43] 不太渴望什么的人\\n[04:44] 看起来成熟了\\n[04:45] 实则呢\\n[04:46] 是把生命力给训练掉了\\n[04:48] 但今天你看到了这一点\\n[04:49] 说明那个有生命力的你还在\\n[04:51] 她只在等一个人\\n[04:53] 可以重新活的有热情一点吗","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":6,"chunks_succeeded":6,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[{"id":"6a796d3400000000070176e5","type":"comment","author":"橙几","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo30r5v4e87185g5nkk1lcg8n1c6e8gdb8?imageView2/2/w/120/format/jpg","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"created_at":1786342709000,"reply_count":10,"parent_comment_id":"","reply_to_author":""},{"id":"6a79b4ee0000000029036fff","type":"comment","author":"睡个好觉","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31j07eoorhg605o2ojsbgbv0si122gug?imageView2/2/w/120/format/jpg","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"created_at":1786361070000,"reply_count":11,"parent_comment_id":"","reply_to_author":""},{"id":"6a7a0398000000002901a909","type":"comment","author":"小捻","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo317f355ec4a605o98nvc0898k9qmgosg?imageView2/2/w/120/format/jpg","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"created_at":1786381209000,"reply_count":6,"parent_comment_id":"","reply_to_author":""},{"id":"6a796dfb00000000140140c3","type":"comment","author":"momo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo316fdh7p7he705o7ru3lg81ouq63m18o?imageView2/2/w/120/format/jpg","text":"男女无趣都是生命力的匮乏","like_count":288,"created_at":1786342907000,"reply_count":0,"parent_comment_id":"","reply_to_author":""},{"id":"6a7f15d80000000014016763","type":"comment","author":"路飞","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/650c37d238e68b556633e3eb.jpg?imageView2/2/w/120/format/jpg","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"created_at":1786713561000,"reply_count":9,"parent_comment_id":"","reply_to_author":""}],"comment_summary":{"threshold":20,"limit":5,"returned":5,"scanned":107,"replies_scanned":77,"primary_pages":3,"reply_pages":15,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.89,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":true,"stable_pages":12},"images":[],"ai_analysis":{"schema_version":1,"status":"ok","model":"deepseek-v4-flash","generated_at":"2026-08-25T03:41:10.606536+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对感到自己生活无趣、缺乏热情、与人交流平淡，且不满足于表面社交技巧的女性。"},"user_need":{"label":"用户主要问题或需求","summary":"用户需要理解自己为何变得无趣、内心空洞，并希望找到重新点燃热情和生命力的具体方法。"},"content_structure":{"label":"内容怎么展开","summary":"先以封面标题引出主题，区分两类读者，然后提出核心观点（无趣是生命力匮乏），用心理学概念（习得性无助）解释成因，对比无趣与有趣女性的差异，最后给出三步具体做法（做无用之事、写感受日记、制造陌生感）并总结鼓励。"},"solution":{"label":"给了什么解决办法","summary":"内容给出了三步具体方法：1. 做一件没有用但觉得有意思的事；2. 每天花五分钟记录让自己有感觉的事物；3. 给自己制造小陌生感（如走新路、尝新菜）。"},"references":{"label":"值得参考什么","summary":"引用了斯坦福大学心理学家马丁·塞利格曼的习得性无助概念，以及神经科学关于大脑可塑性和多巴胺与新奇事物关系的发现。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸做：如何识别并克服习得性无助的日常案例；不同领域（如职场、亲密关系）中生命力匮乏的表现与恢复；从心理学角度深入解析多巴胺与兴趣培养的关系；观众实践三步法后的反馈与故事。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"ok","message":"","sample_size":5,"items":{"main_questions":{"label":"大家主要在问什么","summary":"现有样本未形成明确结论。","evidence_comments":[]},"high_frequency_needs":{"label":"高频需求","summary":"现有样本未形成明确结论。评论中提及通过跳舞、散步、尝试新事物等方式恢复生命力，但样本量小，不足以判断高频需求。","evidence_comments":[{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"},{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},"worries":{"label":"最担心什么","summary":"现有样本未形成明确结论。评论提到拖延症导致的习得性无助和低谷期，但未明确表达担忧。","evidence_comments":[{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},"unclear_points":{"label":"博主没讲清什么","summary":"有评论指出博主内容缺乏有效方法，但未具体说明哪些点未讲清。","evidence_comments":[{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"}]},"key_comments":{"label":"哪些评论值得重点看","entries":[{"comment":{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"},"reason":"详细描述了从低谷到恢复生命力的个人经历，提供了具体行动（跳舞）和效果，具有参考价值。"},{"comment":{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"},"reason":"分享了多种恢复生命力的方法（如无用之事、尝试新事物、写幸福小事），并提及习得性无助，内容充实。"},{"comment":{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"},"reason":"直接指出视频缺乏有效方法，是重要的负面反馈，可能代表部分观众需求。"},{"comment":{"id":"6a79b4ee0000000029036fff","author":"睡个好觉","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"type":"comment"},"reason":"以幽默方式提出“抠”作为无趣原因，简短但引发共鸣。"},{"comment":{"id":"6a796dfb00000000140140c3","author":"momo","text":"男女无趣都是生命力的匮乏","like_count":288,"type":"comment"},"reason":"概括性观点，将无趣与生命力匮乏关联，简洁有力。"}]},"topic_extensions":{"label":"可以延伸什么选题","entries":[{"idea":"如何通过兴趣爱好（如跳舞）恢复自信和生命力","evidence_comments":[{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"}]},{"idea":"拖延症与习得性无助的关系及应对方法","evidence_comments":[{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},{"idea":"低成本或无成本的方式提升生活趣味（如抠门与无趣）","evidence_comments":[{"id":"6a79b4ee0000000029036fff","author":"睡个好觉","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"type":"comment"}]},{"idea":"男女无趣的共性原因分析","evidence_comments":[{"id":"6a796dfb00000000140140c3","author":"momo","text":"男女无趣都是生命力的匮乏","like_count":288,"type":"comment"}]},{"idea":"针对“无有效方法”的反馈，提供具体可操作的建议","evidence_comments":[{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"}]}]}}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251136/9d938faac4ad47ede74adf800260ccdc/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_prv_wlteh_jpg_3", "taskId": "ZZTEST0825", "topics": ["女孩子", "女性智慧", "女性成长", "生命力", "少女心事", "girlstalk"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1", "name": "可可拆爆款", "followers": 122814}, "aiModel": "deepseek-v4-flash", "duration": "4分56秒", "platform": "xiaohongshu", "mainTopic": "分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "4万", "collects": "3.2万", "comments": "647", "likesNum": 40000, "collectsNum": 32000, "commentsNum": 647}, "topicCount": 8, "generatedAt": "2026-08-25T03:41:10.606536+00:00", "aiVideoCount": 7, "commentsShown": 5, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 6, "commentsScanned": 107, "transcriptChars": 3693}	2026-08-25 07:04:07.118378+00	\N
182	ZZTEST0825	xiaohongshu	13	{"schema_version":13,"task_id":"ZZTEST0825","source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251136/9d938faac4ad47ede74adf800260ccdc/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_prv_wlteh_jpg_3","duration_seconds":296.077,"width":1080,"height":1920,"size_bytes":49044082,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true}},"title":"女孩子无聊的本质是生命力的匮乏","description":"","cover_title":"女孩子无趣的本质是生命力的匮乏","cover_title_meta":{"text":"女孩子无趣的本质是生命力的匮乏","confidence":0.954,"font_ratio":1.32,"line_count":2,"lines":[{"text":"女孩子无趣的本质","confidence":0.998},{"text":"生命力的匮乏","confidence":0.909}],"source_image_index":1,"reference_corrected":true,"source":"video_cover"},"post_title":"女孩子无聊的本质是生命力的匮乏","post_description":"","display_title":"女孩子无趣的本质是生命力的匮乏","author":"可可拆爆款","account":{"name":"可可拆爆款","profile_url":"https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1","bio":"👩全网100W➕粉丝\\n🎉你却的不是方法，而是一个带你的人\\n🌲账号定位｜流量卡点｜爆款模板\\n🔗下方进👗","following_count":"1010","follower_count":"122814","likes_and_collections_count":"1148511"},"page_text":"","text_same_as_description":false,"engagement":{"likes":"4万","collects":"3.2万","comments":"647"},"topics":["女孩子","女性智慧","女性成长","生命力","少女心事","girlstalk","本质","人生智慧"],"video_text":"[00:00] 女孩子无趣的本质\\n[00:00] 是生命力的匮乏\\n[00:02] 自己觉得越来越没有意思\\n[00:04] 请把这篇文章仔细看完\\n[00:05] 不是所有人都适合看这篇文章的\\n[00:07] 如果你只是想要几个\\n[00:08] 让显得有趣的技巧\\n[00:10] 比如怎么接话\\n[00:10] 怎么聊天不冷场OK\\n[00:12] 那你可以划掉我了\\n[00:13] 但如果你有一种隐隐的感觉\\n[00:15] 好像活着活着\\n[00:16] 我自己变得越来越平\\n[00:17] 和人说话也没有什么好说的\\n[00:19] 独处时也找不到什么\\n[00:21] 真正让自己发光的东西\\n[00:22] 那这篇文章就是写给你的\\n[00:24] 我们来说一个很多人\\n[00:25] 都不敢承认的事实\\n[00:26] 叫做无趣\\n[00:27] 不是性格问题\\n[00:28] 也不是不会说话\\n[00:29] 那些\\n[00:30] 真正让人觉得无聊的女孩\\n[00:32] 往往不是因为她们沉默\\n[00:33] 而是她们内部空掉了\\n[00:34] 你坐在那里\\n[00:35] 笑得很得体\\n[00:36] 说话也没有失礼\\n[00:37] 但是就给人一种感觉\\n[00:38] 她好像没有在活着\\n[00:40] 眼神是漂浮的\\n[00:42] 聊天是应付的\\n[00:43] 热情是借来的\\n[00:44] 兴趣是假装的\\n[00:45] 这不是性格内向\\n[00:46] 这是生命力在悄悄流失\\n[00:48] 是什么时候开始流失的呢\\n[00:50] 有一个概念叫做习得性无助\\n[00:52] 是斯坦福大学的心理学家\\n[00:54] 马丁格力塞尔\\n[00:56] 是斯坦心理学里心理学\\n[00:58] 心理学\\n[00:58] 心理学研究有个概念\\n[01:00] 叫做习得性无助\\n[01:02] 是斯坦福大学的心理学家\\n[01:03] 马丁塞利格曼\\n[01:05] 在长期研究中提出的\\n[01:06] 她说\\n[01:07] 当一个人在一个领域里\\n[01:08] 反复受挫\\n[01:09] 反复被否定\\n[01:11] 就会形成一种内在的信念\\n[01:12] 不管我做什么都没有用\\n[01:14] 最可怕的东西就在于\\n[01:16] 这种信念会蔓延\\n[01:17] 从一件事蔓延到整个\\n[01:18] 生活从我不擅长这个\\n[01:19] 变成我不擅长任何事\\n[01:21] 从这件事情我失败了\\n[01:23] 我个人本身就是失败的\\n[01:25] 然后就会出现一种症状\\n[01:26] 什么都提不起劲\\n[01:27] 没有特别想去做的事\\n[01:28] 没有特别想去的地方\\n[01:29] 没有特别喜欢的人\\n[01:31] 也没有特别在意的梦想\\n[01:32] 活着就好像是在待机\\n[01:35] 那关键点来了啊\\n[01:36] 无趣的本质\\n[01:37] 是一个人和自己内在欲望的断联\\n[01:39] 你不是真的没有欲望\\n[01:41] 你只是慢慢学会不去感受它\\n[01:42] 因为感受之后会失望\\n[01:44] 会被否定\\n[01:45] 会被现实打脸\\n[01:46] 所以更安全的方式\\n[01:48] 是提前关掉那个开关\\n[01:49] 期待\\n[01:50] 不渴望\\n[01:51] 看起来很平静\\n[01:52] 实质是生命力\\n[01:53] 在一点点的露出出去\\n[01:55] 而一个内部空掉的人\\n[01:56] 无论外表多精致\\n[01:57] 无论说话多礼貌\\n[01:58] 都很难真正的吸引人\\n[02:00] 也很难真正的被吸引\\n[02:01] 因为吸引的本质是能量\\n[02:04] 是那种活着在燃烧\\n[02:05] 对世界还有好奇心的能量\\n[02:07] 我见过很多这样的女孩啊\\n[02:09] 二0多岁大家上着还不错的班\\n[02:12] 长得也很好看\\n[02:13] 说话也很得体\\n[02:14] 但是你跟她相处完之后\\n[02:15] 记不住她说了什么\\n[02:16] 也感受不到她对什么真正的热情\\n[02:18] 她说都行\\n[02:19] 你问她想做什么\\n[02:20] 她说随便\\n[02:21] 有没有什么想实现的事\\n[02:22] 她想很久\\n[02:23] 说呃\\n[02:24] 其实也没有什么特别想的\\n[02:25] 那刻我突然很难过\\n[02:27] 我不是替她可怜\\n[02:28] 是替那个\\n[02:29] 曾经也有过欲望\\n[02:30] 和热情的小女孩\\n[02:32] 感到心疼\\n[02:33] 那些欲望没有消失\\n[02:35] 只是他们被压的太久了\\n[02:36] 慢慢的\\n[02:37] 变得看不见了\\n[02:38] 那相反的人是什么呀\\n[02:40] 那种让人觉得哇\\n[02:41] 她好有趣的女性\\n[02:43] 你有没有认真观察过\\n[02:44] 她们有什么共同点\\n[02:45] 不是因为他们更好笑\\n[02:46] 不是因为他们见识更广\\n[02:47] 不是因为他们天生外向\\n[02:48] 而是因为她们都有某种特质\\n[02:49] 叫做他们对某种事物\\n[02:51] 有着真实的\\n[02:52] 自己的感受\\n[02:53] 可能是某一种食物\\n[02:54] 可能是某种食物\\n[02:54] 可能是某一个地方\\n[02:55] 可能是某一类书\\n[02:56] 也可能是某种手艺\\n[02:58] 不需要很多\\n[02:59] 甚至只需要一件\\n[03:00] 但那种热情是真实的\\n[03:01] 是从内往外涌的\\n[03:03] 而不是为了让别人觉得有趣\\n[03:05] 而表演出来的\\n[03:06] 而这就是生命力\\n[03:07] 那生命力是可以被找回来的吗\\n[03:09] 当然而且是有办法的\\n[03:11] 神经科学的研究已经证实\\n[03:13] 我们的大脑\\n[03:14] 其实具备很强的可塑性\\n[03:15] 即使是长期\\n[03:16] 处于低活跃状态的\\n[03:18] 也可以通过新的体验\\n[03:19] 和重复的行为\\n[03:20] 被重新激活\\n[03:21] 换句话说\\n[03:22] 那个曾经\\n[03:23] 对什么都有好奇心的自己\\n[03:25] 没有消失\\n[03:25] 只是睡着了\\n[03:26] 我们可以把她唤醒\\n[03:27] 那具体怎么做\\n[03:28] 去做一件没有用的事情\\n[03:30] 注意是没有用的\\n[03:31] 不是为了提高竞争力\\n[03:32] 不是为了填简历\\n[03:33] 不是为了让别人觉得哇\\n[03:35] 你好厉害\\n[03:36] 就是因为单纯的\\n[03:37] 觉得有点意思\\n[03:38] 可以是一种做饭的方法\\n[03:39] 你一直想学的东西\\n[03:41] 也可以是\\n[03:41] 某个从来没有去过的地方\\n[03:42] 可以是一本你之前翻了两页\\n[03:44] 哎就放下了书\\n[03:45] 不要去想它有没有意义\\n[03:46] 生命力的重启\\n[03:47] 往往从无用之事开始\\n[03:49] 第二步每天花五分钟\\n[03:50] 写今天\\n[03:51] 什么东西让我有新的感觉\\n[03:54] 就一句话\\n[03:55] 可以是情绪\\n[03:56] 可以是一种味\\n[03:57] 道可以是一段话\\n[03:58] 就是重新训练你的感受力\\n[04:00] 帮你重新学会感受\\n[04:02] 而不是麻木的过日子\\n[04:03] 第三步\\n[04:04] 给自己制造一点点陌生感\\n[04:06] 心理学研究就发现\\n[04:07] 大脑在接触新奇事物时\\n[04:08] 会分泌多巴胺\\n[04:09] 而多巴胺正是驱使我们好奇\\n[04:11] 探索感受活着的关键物质\\n[04:14] 做一件从来没做过的小事\\n[04:16] 哎走一条没有走过的路\\n[04:17] 点一道从来没有吃过的菜\\n[04:18] 听一首完全不熟悉的音乐\\n[04:20] 不求大\\n[04:21] 但要真实的去感受\\n[04:22] 生命力不是天赋\\n[04:24] 也不是某种你要么有\\n[04:25] 要么没有的东西\\n[04:26] 它是一个需要被滋养的东西\\n[04:28] 我们中的很多人\\n[04:29] 其实在成长的过程中\\n[04:31] 被告诉说不要太有想法\\n[04:34] 不要太敏感\\n[04:35] 不要表现的太渴望\\n[04:36] 要懂事\\n[04:37] 要乖平稳要稳定\\n[04:39] 于是\\n[04:40] 我们慢慢就变成了\\n[04:41] 不太有想法\\n[04:42] 不太敏感\\n[04:43] 不太渴望什么的人\\n[04:44] 看起来成熟了\\n[04:45] 实则呢\\n[04:46] 是把生命力给训练掉了\\n[04:48] 但今天你看到了这一点\\n[04:49] 说明那个有生命力的你还在\\n[04:51] 她只在等一个人\\n[04:53] 可以重新活的有热情一点吗","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":6,"chunks_succeeded":6,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[{"id":"6a796d3400000000070176e5","type":"comment","author":"橙几","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo30r5v4e87185g5nkk1lcg8n1c6e8gdb8?imageView2/2/w/120/format/jpg","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"created_at":1786342709000,"reply_count":10,"parent_comment_id":"","reply_to_author":""},{"id":"6a79b4ee0000000029036fff","type":"comment","author":"睡个好觉","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31j07eoorhg605o2ojsbgbv0si122gug?imageView2/2/w/120/format/jpg","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"created_at":1786361070000,"reply_count":11,"parent_comment_id":"","reply_to_author":""},{"id":"6a7a0398000000002901a909","type":"comment","author":"小捻","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo317f355ec4a605o98nvc0898k9qmgosg?imageView2/2/w/120/format/jpg","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"created_at":1786381209000,"reply_count":6,"parent_comment_id":"","reply_to_author":""},{"id":"6a796dfb00000000140140c3","type":"comment","author":"momo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo316fdh7p7he705o7ru3lg81ouq63m18o?imageView2/2/w/120/format/jpg","text":"男女无趣都是生命力的匮乏","like_count":288,"created_at":1786342907000,"reply_count":0,"parent_comment_id":"","reply_to_author":""},{"id":"6a7f15d80000000014016763","type":"comment","author":"路飞","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/650c37d238e68b556633e3eb.jpg?imageView2/2/w/120/format/jpg","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"created_at":1786713561000,"reply_count":9,"parent_comment_id":"","reply_to_author":""}],"comment_summary":{"threshold":20,"limit":5,"returned":5,"scanned":107,"replies_scanned":77,"primary_pages":3,"reply_pages":15,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.89,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":true,"stable_pages":12},"images":[],"ai_analysis":{"schema_version":1,"status":"ok","model":"deepseek-v4-flash","generated_at":"2026-08-25T03:41:10.606536+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对感到自己生活无趣、缺乏热情、与人交流平淡，且不满足于表面社交技巧的女性。"},"user_need":{"label":"用户主要问题或需求","summary":"用户需要理解自己为何变得无趣、内心空洞，并希望找到重新点燃热情和生命力的具体方法。"},"content_structure":{"label":"内容怎么展开","summary":"先以封面标题引出主题，区分两类读者，然后提出核心观点（无趣是生命力匮乏），用心理学概念（习得性无助）解释成因，对比无趣与有趣女性的差异，最后给出三步具体做法（做无用之事、写感受日记、制造陌生感）并总结鼓励。"},"solution":{"label":"给了什么解决办法","summary":"内容给出了三步具体方法：1. 做一件没有用但觉得有意思的事；2. 每天花五分钟记录让自己有感觉的事物；3. 给自己制造小陌生感（如走新路、尝新菜）。"},"references":{"label":"值得参考什么","summary":"引用了斯坦福大学心理学家马丁·塞利格曼的习得性无助概念，以及神经科学关于大脑可塑性和多巴胺与新奇事物关系的发现。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸做：如何识别并克服习得性无助的日常案例；不同领域（如职场、亲密关系）中生命力匮乏的表现与恢复；从心理学角度深入解析多巴胺与兴趣培养的关系；观众实践三步法后的反馈与故事。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"ok","message":"","sample_size":5,"items":{"main_questions":{"label":"大家主要在问什么","summary":"现有样本未形成明确结论。","evidence_comments":[]},"high_frequency_needs":{"label":"高频需求","summary":"现有样本未形成明确结论。评论中提及通过跳舞、散步、尝试新事物等方式恢复生命力，但样本量小，不足以判断高频需求。","evidence_comments":[{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"},{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},"worries":{"label":"最担心什么","summary":"现有样本未形成明确结论。评论提到拖延症导致的习得性无助和低谷期，但未明确表达担忧。","evidence_comments":[{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},"unclear_points":{"label":"博主没讲清什么","summary":"有评论指出博主内容缺乏有效方法，但未具体说明哪些点未讲清。","evidence_comments":[{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"}]},"key_comments":{"label":"哪些评论值得重点看","entries":[{"comment":{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"},"reason":"详细描述了从低谷到恢复生命力的个人经历，提供了具体行动（跳舞）和效果，具有参考价值。"},{"comment":{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"},"reason":"分享了多种恢复生命力的方法（如无用之事、尝试新事物、写幸福小事），并提及习得性无助，内容充实。"},{"comment":{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"},"reason":"直接指出视频缺乏有效方法，是重要的负面反馈，可能代表部分观众需求。"},{"comment":{"id":"6a79b4ee0000000029036fff","author":"睡个好觉","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"type":"comment"},"reason":"以幽默方式提出“抠”作为无趣原因，简短但引发共鸣。"},{"comment":{"id":"6a796dfb00000000140140c3","author":"momo","text":"男女无趣都是生命力的匮乏","like_count":288,"type":"comment"},"reason":"概括性观点，将无趣与生命力匮乏关联，简洁有力。"}]},"topic_extensions":{"label":"可以延伸什么选题","entries":[{"idea":"如何通过兴趣爱好（如跳舞）恢复自信和生命力","evidence_comments":[{"id":"6a796d3400000000070176e5","author":"橙几","text":"确实是这样的，我刚到北京的前半年吧，做着不熟悉也不喜欢的科研，不想看文章，不想学习，觉得自己很没用，也不想去北京的景点看看，觉得很无趣，整个人很没精神，但是后来我去跳舞，我很喜欢跳舞的，而且也跳得还行，慢慢的看着自己跳舞的样子越来越自信，也真的开始对实验和课题有了钻研的动力，也被老师偶尔夸奖摸到了门道，所以真的是，喜欢自己才能有生命力","like_count":1122,"type":"comment"}]},{"idea":"拖延症与习得性无助的关系及应对方法","evidence_comments":[{"id":"6a7a0398000000002901a909","author":"小捻","text":"说的好棒，我每隔一段时间就会出现生命力匮乏的低谷期，因为我有很强的拖延症，低谷期的感觉就好像是我被拖延打败了的习得性无助…然后我就尝试去做一些无用之事，比如下雨天出去散步，很神奇的是做完这些事我感觉生命力复苏了一些，然后我还会有时间就尝试一下新事物，这让我感觉是一种对世界充满好奇心的一种方式，比如我去尝试没有尝试过的运动，或者从来没有听说过的食物。让自己有一些陌生感这件事我还没有尝试过，听起来似乎很有趣，感觉像在对外保持一些神秘感。日记写一些幸福小事我也做过，怎么说呢，确实会让我的注意力集中在幸福上面。我听博客说让我们寻找那些能增加自己能量的事，我想幸福小事就是这些增加我们能量的事","like_count":379,"type":"comment"}]},{"idea":"低成本或无成本的方式提升生活趣味（如抠门与无趣）","evidence_comments":[{"id":"6a79b4ee0000000029036fff","author":"睡个好觉","text":"我无趣的本质是抠，哈哈哈哈哈[笑哭R]","like_count":904,"type":"comment"}]},{"idea":"男女无趣的共性原因分析","evidence_comments":[{"id":"6a796dfb00000000140140c3","author":"momo","text":"男女无趣都是生命力的匮乏","like_count":288,"type":"comment"}]},{"idea":"针对“无有效方法”的反馈，提供具体可操作的建议","evidence_comments":[{"id":"6a7f15d80000000014016763","author":"路飞","text":"看似说了很多，实则没有任何有效的对应方法。","like_count":230,"type":"comment"}]}]}}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251136/9d938faac4ad47ede74adf800260ccdc/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_prv_wlteh_jpg_3", "taskId": "ZZTEST0825", "topics": ["女孩子", "女性智慧", "女性成长", "生命力", "少女心事", "girlstalk"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1", "name": "可可拆爆款", "followers": 122814}, "aiModel": "deepseek-v4-flash", "duration": "4分56秒", "platform": "xiaohongshu", "mainTopic": "分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "4万", "collects": "3.2万", "comments": "647", "likesNum": 40000, "collectsNum": 32000, "commentsNum": 647}, "topicCount": 8, "generatedAt": "2026-08-25T03:41:10.606536+00:00", "aiVideoCount": 7, "commentsShown": 5, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 6, "commentsScanned": 107, "transcriptChars": 3693}	2026-08-25 07:04:07.182037+00	\N
176	f90d29b0a27b	xiaohongshu	15	{"schema_version":15,"task_id":"f90d29b0a27b","source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251704/e311ac2f0961f3522764bd2742b83c75/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_dft_wlteh_jpg_3","duration_seconds":296.077,"width":1080,"height":1920,"size_bytes":35337961,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_b64":"（已落地为本地封面文件，原始 200271 字符）"}},"title":"女孩子无聊的本质是生命力的匮乏","description":"","cover_title":"女孩子无趣的本质是生命力的匮乏","cover_title_meta":{"text":"女孩子无趣的本质是生命力的匮乏","confidence":0.939,"font_ratio":1.31,"line_count":2,"lines":[{"text":"女孩子无趣的本质","confidence":0.998},{"text":"生命力的贵乏","confidence":0.88}],"source_image_index":1,"reference_corrected":true,"source":"video_cover"},"post_title":"女孩子无聊的本质是生命力的匮乏","post_description":"","display_title":"女孩子无趣的本质是生命力的匮乏","author":"可可拆爆款","account":{"name":"可可拆爆款","profile_url":"https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1","bio":"👩全网100W➕粉丝\\n🎉你却的不是方法，而是一个带你的人\\n🌲账号定位｜流量卡点｜爆款模板\\n🔗下方进👗","following_count":"1010","follower_count":"122838","likes_and_collections_count":"1149588"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"4万","collects":"3.2万","comments":"648"},"topics":["女孩子","女性智慧","女性成长","生命力","少女心事","girlstalk","本质","人生智慧"],"video_text":"[00:00] 女孩子无趣的本质\\n[00:01] 是生命力的匮乏\\n[00:03] 自己觉得越来越没有意思\\n[00:04] 请把这篇文章仔细看完\\n[00:06] 都适合看这篇文章的\\n[00:07] 如果你只是想要几个\\n[00:09] 让显得有趣的技巧\\n[00:10] 比如怎么接话\\n[00:11] 怎么聊天不冷场OK\\n[00:13] 那你可以划掉我了\\n[00:14] 但如果你有一种隐隐的感觉\\n[00:15] 好像活着活着\\n[00:16] 我自己变得越来越平\\n[00:18] 和人说话也没有什么好说的\\n[00:20] 独处时也找不到什么\\n[00:21] 真正让自己发光的东西\\n[00:23] 那这篇文章就是写给你的\\n[00:24] 我们来说一个很多人\\n[00:25] 都不敢承认的事实\\n[00:26] 叫做无趣\\n[00:27] 不是性格问题\\n[00:29] 那些\\n[00:30] 真正让人觉得无聊的女孩\\n[00:32] 往往不是因为她们沉默\\n[00:33] 而是她们内部空掉了\\n[00:35] 你坐在那里\\n[00:36] 笑得很得体\\n[00:37] 说话也没有失礼\\n[00:38] 但是就给人一种感觉\\n[00:39] 她好像没有在活着\\n[00:41] 眼神是漂浮的\\n[00:42] 热情是借来的\\n[00:43] 兴趣是假装的\\n[00:45] 这不是性格内向\\n[00:46] 这是生命力在悄悄流失\\n[00:48] 是从什么时候开始流失的呢\\n[00:50] 有一个概念叫做习得性无助\\n[00:53] 是斯坦福大学的心理学家\\n[00:54] 马丁格力塞尔\\n[00:56] 是斯坦心理学里心理学\\n[00:58] 心理学研究有个概念\\n[00:58] 是斯坦福心理学里心理学\\n[01:00] 叫做习得性无助\\n[01:01] 是斯坦福大学的心理学家\\n[01:03] 马丁塞利格曼\\n[01:05] 在长期研究中提出的\\n[01:06] 她说\\n[01:07] 当一个人在一个领域里\\n[01:08] 反复受挫\\n[01:09] 反复被否定\\n[01:10] 就会形成一种内在的信念\\n[01:12] 不管我做什么都没有用\\n[01:14] 最可怕的东西就在于\\n[01:16] 这种信念会蔓延\\n[01:17] 从一件事蔓延到整个\\n[01:18] 生活\\n[01:18] 从我不擅长这个\\n[01:19] 变成我不擅长任何事\\n[01:21] 从这件事情我失败了\\n[01:23] 变成我这个人本身就是失败的\\n[01:25] 然后就会出现一种症状\\n[01:26] 什么都提不起劲\\n[01:27] 没有特别想去做的事\\n[01:28] 没有特别想去的地方\\n[01:29] 没有特别喜欢的人\\n[01:30] 也没有特别在意的梦想\\n[01:31] 活着\\n[01:32] 就好像是在待机\\n[01:34] 那关键点来了啊\\n[01:36] 无趣的本质\\n[01:37] 是一个人和自己内在欲望的断联\\n[01:39] 你不是真的没有欲望\\n[01:41] 你只是慢慢学会不去感受它\\n[01:42] 因为感受之后会失望\\n[01:43] 会被否定\\n[01:44] 会被现实打脸\\n[01:46] 所以更安全的方式\\n[01:47] 是提前关掉那个开关\\n[01:49] 期待 不渴望 不热爱\\n[01:50] 不期待 不渴望 不热爱\\n[01:51] 看起来很平静\\n[01:52] 实则是生命力\\n[01:53] 在一点一点的露出去\\n[01:55] 而一个内部空掉的人\\n[01:56] 无论外表多精致\\n[01:58] 无论说话多礼貌\\n[01:59] 都很难真正的吸引人\\n[02:01] 也很难真正的被吸引\\n[02:02] 因为吸引的本质是能量\\n[02:04] 是那种活着在燃烧\\n[02:06] 对世界还有好奇心的能量\\n[02:08] 我见过很多这样的女孩啊\\n[02:10] 二0多岁大家上着还不错的班\\n[02:13] 长得很好看\\n[02:14] 说话也很得体\\n[02:15] 但是你跟她相处完之后\\n[02:16] 记不住她说了什么\\n[02:17] 她对什么真正的热情\\n[02:19] 她想说都行\\n[02:20] 你问她想做什么\\n[02:21] 她说随便\\n[02:22] 有没有什么想实现的事\\n[02:23] 她想了很久\\n[02:24] 说呃\\n[02:24] 其实也没有什么特别想的\\n[02:26] 那刻我突然很难过\\n[02:28] 我不是替她可怜\\n[02:29] 是替那个曾经也有过\\n[02:30] 欲望\\n[02:31] 和热情的小女孩\\n[02:33] 感到心疼\\n[02:34] 那些欲望没有消失\\n[02:35] 只是他们被压的太久了\\n[02:37] 慢慢的变得看不见了\\n[02:39] 那相反的人是什么呀\\n[02:41] 那种让人觉得哇\\n[02:42] 她好有趣\\n[02:43] 的女性\\n[02:44] 你有没有认真观察过\\n[02:45] 她们有什么共同点\\n[02:46] 不是因为她们更好笑\\n[02:47] 不是因为他们见识更广\\n[02:48] 不是因为他们天生外向\\n[02:49] 而是因为她们都有某种特质\\n[02:50] 叫做他们对某种事物\\n[02:51] 有着真实的\\n[02:53] 自己的感受\\n[02:54] 可能是某种食物\\n[02:55] 可能是某一个地方\\n[02:56] 可能是某一类书\\n[02:57] 也可能是某种手艺\\n[02:58] 不需要很多\\n[02:59] 甚至只需要一件\\n[03:00] 但那种热情是真实的\\n[03:01] 是从内往外涌的\\n[03:03] 而不是为了让别人觉得有趣\\n[03:05] 而表演出来的\\n[03:06] 而这就是生命力\\n[03:07] 那生命力是可以被找回来的吗\\n[03:09] 当然而且是有办法的\\n[03:11] 神经科学的研究已经证实\\n[03:12] 我们的大脑\\n[03:13] 其实具备很强的可塑性\\n[03:15] 即使是长期\\n[03:16] 处于低活跃状态的\\n[03:18] 也可以通过新的体验\\n[03:19] 和重复的行为\\n[03:20] 被重新激活\\n[03:21] 换句话说\\n[03:22] 那个曾经\\n[03:23] 对什么都有好奇心的自己\\n[03:24] 没有消失\\n[03:25] 只是睡着了\\n[03:26] 我们可以把它唤醒\\n[03:27] 那具体怎么做\\n[03:28] 去做一件没有用的事情\\n[03:30] 注意是没有用的\\n[03:31] 不是为了提高竞争力\\n[03:32] 不是为了填简历\\n[03:33] 不是为了让别人觉得哇\\n[03:34] 你好厉害\\n[03:36] 就是因为单纯的\\n[03:37] 觉得有点意思\\n[03:38] 可以是一种做饭的方法\\n[03:39] 你一直想学的东西\\n[03:40] 也可以是\\n[03:41] 某个从来没有去过的地方\\n[03:42] 可以是一本你之前翻了两页\\n[03:44] 哎就放下了书\\n[03:45] 不要去想它有没有意义\\n[03:46] 生命力的重启\\n[03:47] 往往从无用之事开始\\n[03:49] 第二步每天花五分钟\\n[03:50] 写今天\\n[03:51] 什么东西让我有新的感觉\\n[03:54] 就一句话\\n[03:55] 可以是情绪\\n[03:56] 可以是一个场景\\n[03:56] 可以是一种味道\\n[03:57] 可以是一段话\\n[03:58] 就是重新训练你的感受力\\n[04:00] 帮你重新学会感受\\n[04:02] 而不是麻木的过日子\\n[04:04] 第三步\\n[04:04] 给自己制造一点点陌生感\\n[04:06] 心理学研究发现\\n[04:07] 大脑在接触新奇事物时\\n[04:09] 会分泌多巴胺\\n[04:10] 而多巴胺正是驱使我们好奇\\n[04:11] 探索感受活着的关键物质\\n[04:14] 每周做一件从来没做过的小事\\n[04:16] 走一条没有走过的路\\n[04:17] 点一道从来没有吃过的菜\\n[04:18] 听一首完全不熟悉的音乐\\n[04:19] 不用太大\\n[04:20] 但要真实的去感受\\n[04:22] 生命力不是天赋\\n[04:23] 也不是性格\\n[04:24] 也不是某种你要么有\\n[04:25] 要么没有的东西\\n[04:27] 它是一个需要被滋养的东西\\n[04:28] 我们中的很多人\\n[04:30] 其实在成长的过程中\\n[04:31] 被告诉说不要太有想法\\n[04:34] 不要太敏感\\n[04:35] 不要表现的太渴望\\n[04:36] 要懂事\\n[04:37] 要乖平稳要稳定\\n[04:39] 于是我们慢慢就变成了一个\\n[04:41] 不太有想法\\n[04:42] 不太敏感\\n[04:43] 不太渴望什么的人\\n[04:44] 看起来成熟了\\n[04:45] 实则呢\\n[04:46] 是把生命力给训练掉了\\n[04:48] 但今天你看到了这一点\\n[04:49] 说明那个有生命力的你还在\\n[04:51] 她只是在等一个人\\n[04:53] 可以重新活的有热情一点吗","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":6,"chunks_succeeded":6,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T09:09:45.154752+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要讨论‘女孩子无趣的本质是生命力的匮乏’，将无趣归因于内在生命力流失，而非性格问题。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对感到自己越来越无趣、生活平淡、缺乏热情和内在动力的女性，尤其是那些在社交或独处中感到空虚的年轻女性。"},"user_need":{"label":"用户主要问题或需求","summary":"用户的核心需求是理解自己为何变得无趣，并希望找回内在的热情和生命力，而非仅仅学习表面社交技巧。"},"content_structure":{"label":"内容怎么展开","summary":"内容从提出问题（无趣是生命力匮乏）开始，引入心理学概念（习得性无助）解释原因，再对比有趣女性的特质，最后给出具体方法。"},"solution":{"label":"给了什么解决办法","summary":"给出了三步具体方法：做一件‘无用’的事、每天花五分钟记录新感受、每周制造一点陌生感（如走新路、尝新菜）。"},"references":{"label":"值得参考什么","summary":"值得参考的是内容中引用的心理学概念（习得性无助）和神经科学观点（大脑可塑性、多巴胺与新奇感），以及其对比分析（无趣vs有趣女性的特质）。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做‘如何具体执行三步方法’的实操指南、‘习得性无助’的科普解读、‘女性成长与生命力’的系列内容，或‘真实案例分享’等。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251704/e311ac2f0961f3522764bd2742b83c75/spectrum/1040g34o323i8mj5tn0104b2q29aqf5d1cv3nhs8!nd_dft_wlteh_jpg_3", "taskId": "f90d29b0a27b", "topics": ["女孩子", "女性智慧", "女性成长", "生命力", "少女心事", "girlstalk"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5ba315a7080aa000011195a1", "name": "可可拆爆款", "followers": 122838}, "aiModel": "deepseek-v4-flash", "duration": "4分56秒", "platform": "xiaohongshu", "coverFrom": "inline", "mainTopic": "这条内容主要讨论‘女孩子无趣的本质是生命力的匮乏’，将无趣归因于内在生命力流失，而非性格问题。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "4万", "collects": "3.2万", "comments": "648", "likesNum": 40000, "collectsNum": 32000, "commentsNum": 648}, "imageCount": 0, "imageFiles": [], "topicCount": 8, "generatedAt": "2026-08-25T09:09:45.154752+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 3707}	2026-08-25 09:21:00.094163+00	\N
195	b36f1b924b66	xiaohongshu	15	{"schema_version":15,"task_id":"b36f1b924b66","source_url":"https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251704/c5f783a389998530e7b56ff71b1626ac/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_prv_wlteh_jpg_3","duration_seconds":458.306,"width":1080,"height":1920,"size_bytes":61079166,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_b64":"（已落地为本地封面文件，原始 150335 字符）"}},"title":"看完痴迷，发现最恐怖的是无色无味老实人？","description":"心理学的脆弱型自恋者，望周知～","cover_title":"脆弱型自恋患者","cover_title_meta":{"text":"脆弱型自恋患者","confidence":0.996,"font_ratio":1.57,"line_count":1,"lines":[{"text":"脆弱型自恋患者","confidence":0.996}],"source_image_index":1,"source":"video_cover"},"post_title":"看完痴迷，发现最恐怖的是无色无味老实人？","post_description":"心理学的脆弱型自恋者，望周知～","display_title":"脆弱型自恋患者","author":"治愈果（kakki在说啥）","account":{"name":"治愈果（kakki在说啥）","profile_url":"https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266","bio":"🐳百万粉丝心理创作者｜心理师\\n🐳累计500+小时个案\\n🐳Queen Mary 法学硕士🇬🇧 \\n🐳亲密关系｜终身成长：zhiyuguo820\\n@愈果 YU GUO","following_count":"104","follower_count":"162886","likes_and_collections_count":"1232628"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"784","collects":"349","comments":"75"},"topics":["痴迷","治愈果","心理学","惊悚片","自恋"],"video_text":"[00:00] 本人是一个恐怖电影爱好者\\n[00:02] 豆瓣的高分恐怖片清单\\n[00:04] 我基本上都刷了一个遍\\n[00:06] 最近\\n[00:07] 在海外有一部爆火的电影叫做《痴迷》\\n[00:09] 刚刚也在内地院线上映了\\n[00:10] 本人已经看完了\\n[00:12] 看完以后真的表示非常的兴奋\\n[00:14] 因为我觉得它不仅吓到我了\\n[00:16] 它也笑到我了\\n[00:17] 甚至有点惊艳到我了\\n[00:19] 我已经准备去电影院再二刷一次了\\n[00:21] 但我想要专门出一期视频\\n[00:23] 不只是因为它好看\\n[00:24] 而是因为\\n[00:25] 我觉得这个题材实在是太特别了\\n[00:27] 它不是那种传统意义上的鬼怪恐怖\\n[00:30] 而是把亲密关系\\n[00:31] 拍成了心理恐怖片的电影\\n[00:34] 可以说是刚好切到了我的内容赛道\\n[00:36] 所以想要先给大家推荐介绍一下剧情\\n[00:39] 男主贝尔是一个非常平凡\\n[00:41] 自卑又对爱情充满执念的一个男青年\\n[00:45] 他呢偶然听说了\\n[00:46] 小镇上有一个关于心愿柳的一个传说\\n[00:49] 是那种把柳条柳枝折断了\\n[00:52] 许个愿然后愿望就能实现\\n[00:54] 他有一天就去商店里面买了买了这个柳条\\n[00:55] 许愿\\n[00:56] 自己暗恋的女孩Nikki能够爱上自己\\n[00:59] OK 愿望成真了\\n[01:00] 两个人真的走到一起了\\n[01:03] 但是很快就发现 被召唤来的真的不是纯粹的爱情\\n[01:06] 而是纯纯的恐怖\\n[01:08] 女主被夺舍了 然后发了疯一样的爱上了男主贝尔\\n[01:12] 占有 控制 几乎惊恐到了变态的程度\\n[01:16] 而这部电影 我觉得它最讽刺的地方就是\\n[01:18] 它在用一种非常之极端的方式 拍出了很多人在亲密关系里面\\n[01:24] 既要 又要 还要\\n[01:25] 我看到一个非常有意思的影评\\n[01:27] 当然有点尖锐\\n[01:27] 男主属于是既要0元购又想免费退 占完便宜还想跑\\n[01:33] 就发现自己又跑不掉了 就开始害怕了\\n[01:35] 可是正当他要付出代价的时候 他又舍不得了”\\n[01:38] 这个就很像是感情里的某一部分人\\n[01:42] 喜欢漂亮的姑娘 但是又要对方只爱自己\\n[01:45] 喜欢独立的人 但又希望对方能够粘着自己\\n[01:48] 那对方太粘了 又嫌他不给自己空间\\n[01:51] 那对方开始真的有自我了 自信放光芒了 又觉得没有安全感了\\n[01:55] 不少不管男女\\n[01:56] 不少不管是男女\\n[01:57] 这个世界上哪里有这么好的事情\\n[01:59] 你想得到到底是伴侣\\n[02:00] 还是一个既能满足你所有需求\\n[02:02] 又不需要你承担任何代价的\\n[02:04] 人型许愿机？\\n[02:07] 我觉得这部电影它更厉害的地方在于\\n[02:09] 它拍出了一种\\n[02:10] 非常容易被大家忽略的人物类型\\n[02:13] 叫做脆弱型自恋者\\n[02:15] 从人格心理学和临床研究的角度来说\\n[02:18] 自恋存在两种稳定的维度\\n[02:21] 大家都很熟悉\\n[02:23] 也是网上最常看到的那种NPD的类型\\n[02:26] 脆弱型自恋\\n[02:28] 这是一种非常之隐蔽的自恋\\n[02:30] 大家都不太了解\\n[02:32] 像男主贝尔\\n[02:33] 他表面上很害羞\\n[02:34] 很自卑很老实\\n[02:35] 甚至还有一点点可怜\\n[02:36] 你是不是就很容易觉得\\n[02:38] 他是一个不太喜欢表达\\n[02:40] 但是挺善良的一个普通人\\n[02:42] 但如果你仔细看电影\\n[02:44] 你们会发现\\n[02:44] 其实这个不是单纯的内向\\n[02:46] 更不是什么温柔\\n[02:47] 他是那种“无色无味的剧毒老实人”\\n[02:50] 他的自恋不是那种高高在上\\n[02:52] 夸夸其谈的自恋\\n[02:54] 而是一种隐藏在不行动不付出\\n[02:54] 而是一种藏在不行动不付出\\n[02:56] 不表态和退缩背后的自恋\\n[02:59] 你就看他向心愿柳留许的愿望是什么嘛\\n[03:02] 不是那种请给我勇气去表白吧\\n[03:05] 也不是请让我有机会了解我的女神吧\\n[03:08] 而是直接要求让Nikki爱上我\\n[03:11] 胜过爱世界上任何一个人\\n[03:13] 你们细品\\n[03:14] 就这个愿望\\n[03:16] 它的背后就说明了\\n[03:16] 他其实想要的\\n[03:17] 根本就不是一段真实的关系\\n[03:19] 或者说这个人他对关系就是有一种错误的理解\\n[03:21] 他要的是一种究极的排他\\n[03:23] 是一种绝对的优先\\n[03:25] 是一种无条件围绕他运转\\n[03:27] 但又不提要求的爱\\n[03:29] 但真正的爱是这样吗\\n[03:30] 不是的\\n[03:32] 真正的爱应该是是我走向你\\n[03:33] 我了解你\\n[03:35] 我知道你的喜好\\n[03:36] 我付出一些爱的行为\\n[03:38] 然后我尊重你的选择\\n[03:39] 而这个男主的爱是跳过了了解\\n[03:41] 追求甚至是对方的意愿\\n[03:43] 直接让对方变成了自己的所有物\\n[03:45] 而且是独一无二的\\n[03:46] 这就根本就不是爱\\n[03:47] 这个是恐怖片\\n[03:49] 因为他关注的始终是她为什么不爱我\\n[03:51] 我怎么样才能得到她\\n[03:52] 而不是她真正需要什么\\n[03:54] 她的梦想是什么\\n[03:55] 她喜欢什么\\n[03:56] 以及她愿不愿意\\n[03:57] 而且这个电影\\n[03:58] 还有很多细节都在说明这一点\\n[04:00] 他对他死去的猫是非常冷漠的\\n[04:03] 那个猫咪刚刚离世\\n[04:04] 他就可以出去跟别人吃喝玩乐\\n[04:06] 心里就想着\\n[04:07] 是要不要表白这一类的事情\\n[04:08] 又比如说这个男主\\n[04:09] 他对一直都暗恋他\\n[04:11] 关心他的朋友同事\\n[04:13] 也是那种非常习惯性的\\n[04:15] 接受对方的好意\\n[04:16] 但是却从来没有想过\\n[04:17] 真正付出一点相对等的回应\\n[04:19] 就这种人\\n[04:20] 他真的可能不一定会在现实生活中\\n[04:23] 主动的去伤害你\\n[04:24] 但是这样的人\\n[04:25] 你一旦跟他进入关系\\n[04:27] 他一定一定会索取很多\\n[04:29] 他会索取关注照顾\\n[04:30] 索取情绪价值\\n[04:31] 但他却会很少真正看见别人\\n[04:35] 就是他用不行动来保护自己\\n[04:37] 很多人会觉得\\n[04:38] 脆弱型自恋者是因为自尊太低\\n[04:40] 所以不太敢行动\\n[04:42] 但其实恰恰相反哦\\n[04:44] 他们内心往往有一种非常强烈的自尊\\n[04:46] 但这种自尊\\n[04:47] 他不是强大\\n[04:48] 而是强烈\\n[04:49] 甚至可以说这种自尊他太脆弱了\\n[04:50] 这种自尊\\n[04:51] 他太脆弱了\\n[04:52] 因为他们这种人\\n[04:53] 他们就很害怕被拒绝\\n[04:54] 很害怕失败\\n[04:55] 很害怕现实证明自己没有那么特别\\n[04:57] 所以就干脆不表白了\\n[04:58] 就不努力了\\n[04:59] 因为这样就不承担风险\\n[05:00] 毕竟只要不行动\\n[05:02] 就永远不会被现实检验出所谓的结果\\n[05:05] 当然啊这我一定要强调\\n[05:07] 不要因为一个人内向害羞或者社恐\\n[05:10] 就随随便便给人家贴上一个什么\\n[05:12] 剧毒老好人的标签和NPD的标签\\n[05:15] 没有这回事儿\\n[05:16] 内向和自恋\\n[05:17] 是完完全全的独立存在的两种事情\\n[05:20] 两回事\\n[05:21] 而真正害羞但是又同时善良的人\\n[05:24] 他们一定会\\n[05:25] 看到对方的\\n[05:26] 一定会记得对方说过的话\\n[05:27] 一定会付出关心的行为\\n[05:28] 也会在被拒绝之后\\n[05:30] 下一次想着\\n[05:31] 我应该尊重别人的边界\\n[05:33] 他不会把自己的喜欢\\n[05:35] 当成对方必须回应的义务\\n[05:36] 但是脆弱型自恋者可不一样哦\\n[05:38] 他们不一定是张牙舞爪的\\n[05:40] 甚至他们是内向的\\n[05:42] 害羞的甚至是无害的\\n[05:43] 但是他在关系里\\n[05:45] 一定会持续的表现出\\n[05:46] 那种以自我为中心的情感\\n[05:47] 索取和逃避责任\\n[05:49] 以及躲避后果\\n[05:51] 他想要的不是你\\n[05:52] 而是你证明我值得被爱\\n[05:54] 而这个电影真正恐怖的地方也在这儿\\n[05:56] 当Nikki因为贝尔的许愿被夺舍之后\\n[05:59] 失去自我\\n[06:00] 折磨到已经几乎不成人形的时候\\n[06:03] 她在半夜的时候\\n[06:04] 短暂恢复意识的那几分钟\\n[06:06] 她非常痛苦的哀求着男主贝尔\\n[06:09] 她说你杀了我吧\\n[06:11] 我求求你了\\n[06:12] 你让我解脱吧\\n[06:13] 结果你们知道男主说了句什么吗\\n[06:14] 男主说：和我在一起到底有什么不好\\n[06:18] 我靠就这句话出来\\n[06:20] 我相信电影院一定是一片哗然的\\n[06:23] 因为在那一刻\\n[06:24] 经历了那么多恐怖的事情之后\\n[06:26] 他看到的还是仍然不是对方的痛苦\\n[06:29] 而是自己的委屈\\n[06:30] 她不成人形了\\n[06:32] 她在求救了\\n[06:33] 但这个男生还在想\\n[06:34] 我都给你我的爱了\\n[06:35] 你到底有什么不满意呀\\n[06:36] 你们看\\n[06:37] 这个就是极端自我的人最可怕的地方\\n[06:40] 因为在他们的世界里\\n[06:41] 伴侣不是一个有感受有想法\\n[06:44] 有喜怒哀乐有意志的人\\n[06:45] 而是一个应该满足自己配合自己\\n[06:48] 证明自己的工具角色\\n[06:51] 所以我真的觉得《痴迷》\\n[06:52] 表面上它讲的是一个什么禁忌\\n[06:54] 许愿的一个恐怖故事\\n[06:56] 但其实\\n[06:56] 他讲的是亲密关系里的恐怖故事\\n[06:59] 强制爱别人不会有什么好下场的\\n[07:01] 以及爱一旦只想着满足自己的话\\n[07:04] 就一定伴随着抹杀对方\\n[07:06] 真正健康的爱\\n[07:07] 不是对方完全符合你的期待\\n[07:09] 而是你能看到ta是一个独立的人\\n[07:11] ta有自己的痛苦边界和选择\\n[07:14] 也有不围着你转的权利\\n[07:16] 讲真的这部电影\\n[07:18] 把恐怖喜剧和情感的议题结合的非常好\\n[07:21] 它吓人但又不只是吓人\\n[07:23] 它荒诞但又特别现实\\n[07:25] 我真的希望这样的作品\\n[07:27] 被更多的人看到\\n[07:29] 但是这个人一定是大胆的人\\n[07:30] 如果大家很胆小\\n[07:31] 就不要去看了\\n[07:32] 因为这个电影真的是蛮恐怖的\\n[07:34] 好了今天的分享就到这了\\n[07:35] 我们下期再见啦拜拜","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":8,"chunks_succeeded":8,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T09:09:47.270396+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对对心理学、亲密关系议题感兴趣的人群，以及恐怖电影爱好者或关注情感关系问题的观众。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能希望了解电影《痴迷》的看点，同时理解“脆弱型自恋者”这一隐蔽人格类型，以及如何在亲密关系中识别和应对类似行为。"},"content_structure":{"label":"内容怎么展开","summary":"内容先以个人观影体验引入，接着介绍电影剧情，然后通过影评和心理学概念分析角色行为，最后总结电影主题并给出观影建议。"},"solution":{"label":"给了什么解决办法","summary":"内容未给出明确解决办法，但通过分析脆弱型自恋者的行为模式，提醒观众在亲密关系中注意识别类似特征，并强调健康爱的关系应尊重对方独立性。"},"references":{"label":"值得参考什么","summary":"值得参考电影《痴迷》的剧情设定和影评观点，以及心理学中关于自恋两种维度（显性自恋和脆弱型自恋）的区分。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸制作关于脆弱型自恋者与内向性格的区别、亲密关系中的边界设定、或电影中其他心理学元素的解读等内容。"}},"source_labels":["封面标题","文字标题","作品描述","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251704/c5f783a389998530e7b56ff71b1626ac/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_prv_wlteh_jpg_3", "taskId": "b36f1b924b66", "topics": ["痴迷", "治愈果", "心理学", "惊悚片", "自恋"], "account": {"url": "https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266", "name": "治愈果（kakki在说啥）", "followers": 162886}, "aiModel": "deepseek-v4-flash", "duration": "7分38秒", "platform": "xiaohongshu", "coverFrom": "inline", "mainTopic": "这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "784", "collects": "349", "comments": "75", "likesNum": 784, "collectsNum": 349, "commentsNum": 75}, "imageCount": 0, "imageFiles": [], "topicCount": 5, "generatedAt": "2026-08-25T09:09:47.270396+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 4766}	2026-08-25 09:20:49.338864+00	\N
196	b36f1b924b66	xiaohongshu	16	{"schema_version":16,"task_id":"b36f1b924b66","source_url":"https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608251704/c5f783a389998530e7b56ff71b1626ac/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_prv_wlteh_jpg_3","duration_seconds":458.306,"width":1080,"height":1920,"size_bytes":61079166,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_b64":"（已落地为本地封面文件，原始 179139 字符）","cover_image_source":"platform_video_cover","cover_image_url":"http://sns-webpic-qc.xhscdn.com/202608251739/808b4a3a343eee15ed8f07049ca7d3e7/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_dft_wlteh_webp_3","cover_image_width":1080,"cover_image_height":1440,"cover_image_size_bytes":134336}},"title":"看完痴迷，发现最恐怖的是无色无味老实人？","description":"心理学的脆弱型自恋者，望周知～","cover_title":"脆弱型自恋患者","cover_title_meta":{"text":"脆弱型自恋患者","confidence":0.994,"font_ratio":1.66,"line_count":1,"lines":[{"text":"脆弱型自恋患者","confidence":0.994}],"source_image_index":1,"source":"platform_video_cover"},"post_title":"看完痴迷，发现最恐怖的是无色无味老实人？","post_description":"心理学的脆弱型自恋者，望周知～","display_title":"脆弱型自恋患者","author":"治愈果（kakki在说啥）","account":{"name":"治愈果（kakki在说啥）","profile_url":"https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266","bio":"🐳百万粉丝心理创作者｜心理师\\n🐳累计500+小时个案\\n🐳Queen Mary 法学硕士🇬🇧 \\n🐳亲密关系｜终身成长：zhiyuguo820\\n@愈果 YU GUO","following_count":"104","follower_count":"162886","likes_and_collections_count":"1232628"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"784","collects":"349","comments":"75"},"topics":["痴迷","治愈果","心理学","惊悚片","自恋"],"video_text":"[00:00] 本人是一个恐怖电影爱好者\\n[00:02] 豆瓣的高分恐怖片清单\\n[00:04] 我基本上都刷了一个遍\\n[00:06] 最近\\n[00:07] 在海外有一部爆火的电影叫做《痴迷》\\n[00:09] 刚刚也在内地院线上映了\\n[00:10] 本人已经看完了\\n[00:12] 看完以后真的表示非常的兴奋\\n[00:14] 因为我觉得它不仅吓到我了\\n[00:16] 它也笑到我了\\n[00:17] 甚至有点惊艳到我了\\n[00:19] 我已经准备去电影院再二刷一次了\\n[00:21] 但我想要专门出一期视频\\n[00:23] 不只是因为它好看\\n[00:24] 而是因为\\n[00:25] 我觉得这个题材实在是太特别了\\n[00:27] 它不是那种传统意义上的鬼怪恐怖\\n[00:30] 而是把亲密关系\\n[00:31] 拍成了心理恐怖片的电影\\n[00:34] 可以说是刚好切到了我的内容赛道\\n[00:36] 所以想要先给大家推荐介绍一下剧情\\n[00:39] 男主贝尔是一个非常平凡\\n[00:41] 自卑又对爱情充满执念的一个男青年\\n[00:45] 他呢偶然听说了\\n[00:46] 小镇上有一个关于心愿柳的一个传说\\n[00:49] 是那种把柳条柳枝折断了\\n[00:52] 许个愿然后愿望就能实现\\n[00:54] 他有一天就去商店里面买了买了这个柳条\\n[00:55] 许愿\\n[00:56] 自己暗恋的女孩Nikki能够爱上自己\\n[00:59] OK 愿望成真了\\n[01:00] 两个人真的走到一起了\\n[01:03] 但是很快就发现 被召唤来的真的不是纯粹的爱情\\n[01:06] 而是纯纯的恐怖\\n[01:08] 女主被夺舍了 然后发了疯一样的爱上了男主贝尔\\n[01:12] 占有 控制 几乎惊恐到了变态的程度\\n[01:16] 而这部电影 我觉得它最讽刺的地方就是\\n[01:18] 它在用一种非常之极端的方式 拍出了很多人在亲密关系里面\\n[01:24] 既要 又要 还要\\n[01:25] 我看到一个非常有意思的影评\\n[01:27] 当然有点尖锐\\n[01:27] 男主属于是既要0元购又想免费退 占完便宜还想跑\\n[01:33] 就发现自己又跑不掉了 就开始害怕了\\n[01:35] 可是正当他要付出代价的时候 他又舍不得了”\\n[01:38] 这个就很像是感情里的某一部分人\\n[01:42] 喜欢漂亮的姑娘 但是又要对方只爱自己\\n[01:45] 喜欢独立的人 但又希望对方能够粘着自己\\n[01:48] 那对方太粘了 又嫌他不给自己空间\\n[01:51] 那对方开始真的有自我了 自信放光芒了 又觉得没有安全感了\\n[01:55] 不少不管男女\\n[01:56] 不少不管是男女\\n[01:57] 这个世界上哪里有这么好的事情\\n[01:59] 你想得到到底是伴侣\\n[02:00] 还是一个既能满足你所有需求\\n[02:02] 又不需要你承担任何代价的\\n[02:04] 人型许愿机？\\n[02:07] 我觉得这部电影它更厉害的地方在于\\n[02:09] 它拍出了一种\\n[02:10] 非常容易被大家忽略的人物类型\\n[02:13] 叫做脆弱型自恋者\\n[02:15] 从人格心理学和临床研究的角度来说\\n[02:18] 自恋存在两种稳定的维度\\n[02:21] 大家都很熟悉\\n[02:23] 也是网上最常看到的那种NPD的类型\\n[02:26] 脆弱型自恋\\n[02:28] 这是一种非常之隐蔽的自恋\\n[02:30] 大家都不太了解\\n[02:32] 像男主贝尔\\n[02:33] 他表面上很害羞\\n[02:34] 很自卑很老实\\n[02:35] 甚至还有一点点可怜\\n[02:36] 你是不是就很容易觉得\\n[02:38] 他是一个不太喜欢表达\\n[02:40] 但是挺善良的一个普通人\\n[02:42] 但如果你仔细看电影\\n[02:44] 你们会发现\\n[02:44] 其实这个不是单纯的内向\\n[02:46] 更不是什么温柔\\n[02:47] 他是那种“无色无味的剧毒老实人”\\n[02:50] 他的自恋不是那种高高在上\\n[02:52] 夸夸其谈的自恋\\n[02:54] 而是一种隐藏在不行动不付出\\n[02:54] 而是一种藏在不行动不付出\\n[02:56] 不表态和退缩背后的自恋\\n[02:59] 你就看他向心愿柳留许的愿望是什么嘛\\n[03:02] 不是那种请给我勇气去表白吧\\n[03:05] 也不是请让我有机会了解我的女神吧\\n[03:08] 而是直接要求让Nikki爱上我\\n[03:11] 胜过爱世界上任何一个人\\n[03:13] 你们细品\\n[03:14] 就这个愿望\\n[03:16] 它的背后就说明了\\n[03:16] 他其实想要的\\n[03:17] 根本就不是一段真实的关系\\n[03:19] 或者说这个人他对关系就是有一种错误的理解\\n[03:21] 他要的是一种究极的排他\\n[03:23] 是一种绝对的优先\\n[03:25] 是一种无条件围绕他运转\\n[03:27] 但又不提要求的爱\\n[03:29] 但真正的爱是这样吗\\n[03:30] 不是的\\n[03:32] 真正的爱应该是是我走向你\\n[03:33] 我了解你\\n[03:35] 我知道你的喜好\\n[03:36] 我付出一些爱的行为\\n[03:38] 然后我尊重你的选择\\n[03:39] 而这个男主的爱是跳过了了解\\n[03:41] 追求甚至是对方的意愿\\n[03:43] 直接让对方变成了自己的所有物\\n[03:45] 而且是独一无二的\\n[03:46] 这就根本就不是爱\\n[03:47] 这个是恐怖片\\n[03:49] 因为他关注的始终是她为什么不爱我\\n[03:51] 我怎么样才能得到她\\n[03:52] 而不是她真正需要什么\\n[03:54] 她的梦想是什么\\n[03:55] 她喜欢什么\\n[03:56] 以及她愿不愿意\\n[03:57] 而且这个电影\\n[03:58] 还有很多细节都在说明这一点\\n[04:00] 他对他死去的猫是非常冷漠的\\n[04:03] 那个猫咪刚刚离世\\n[04:04] 他就可以出去跟别人吃喝玩乐\\n[04:06] 心里就想着\\n[04:07] 是要不要表白这一类的事情\\n[04:08] 又比如说这个男主\\n[04:09] 他对一直都暗恋他\\n[04:11] 关心他的朋友同事\\n[04:13] 也是那种非常习惯性的\\n[04:15] 接受对方的好意\\n[04:16] 但是却从来没有想过\\n[04:17] 真正付出一点相对等的回应\\n[04:19] 就这种人\\n[04:20] 他真的可能不一定会在现实生活中\\n[04:23] 主动的去伤害你\\n[04:24] 但是这样的人\\n[04:25] 你一旦跟他进入关系\\n[04:27] 他一定一定会索取很多\\n[04:29] 他会索取关注照顾\\n[04:30] 索取情绪价值\\n[04:31] 但他却会很少真正看见别人\\n[04:35] 就是他用不行动来保护自己\\n[04:37] 很多人会觉得\\n[04:38] 脆弱型自恋者是因为自尊太低\\n[04:40] 所以不太敢行动\\n[04:42] 但其实恰恰相反哦\\n[04:44] 他们内心往往有一种非常强烈的自尊\\n[04:46] 但这种自尊\\n[04:47] 他不是强大\\n[04:48] 而是强烈\\n[04:49] 甚至可以说这种自尊他太脆弱了\\n[04:50] 这种自尊\\n[04:51] 他太脆弱了\\n[04:52] 因为他们这种人\\n[04:53] 他们就很害怕被拒绝\\n[04:54] 很害怕失败\\n[04:55] 很害怕现实证明自己没有那么特别\\n[04:57] 所以就干脆不表白了\\n[04:58] 就不努力了\\n[04:59] 因为这样就不承担风险\\n[05:00] 毕竟只要不行动\\n[05:02] 就永远不会被现实检验出所谓的结果\\n[05:05] 当然啊这我一定要强调\\n[05:07] 不要因为一个人内向害羞或者社恐\\n[05:10] 就随随便便给人家贴上一个什么\\n[05:12] 剧毒老好人的标签和NPD的标签\\n[05:15] 没有这回事儿\\n[05:16] 内向和自恋\\n[05:17] 是完完全全的独立存在的两种事情\\n[05:20] 两回事\\n[05:21] 而真正害羞但是又同时善良的人\\n[05:24] 他们一定会\\n[05:25] 看到对方的\\n[05:26] 一定会记得对方说过的话\\n[05:27] 一定会付出关心的行为\\n[05:28] 也会在被拒绝之后\\n[05:30] 下一次想着\\n[05:31] 我应该尊重别人的边界\\n[05:33] 他不会把自己的喜欢\\n[05:35] 当成对方必须回应的义务\\n[05:36] 但是脆弱型自恋者可不一样哦\\n[05:38] 他们不一定是张牙舞爪的\\n[05:40] 甚至他们是内向的\\n[05:42] 害羞的甚至是无害的\\n[05:43] 但是他在关系里\\n[05:45] 一定会持续的表现出\\n[05:46] 那种以自我为中心的情感\\n[05:47] 索取和逃避责任\\n[05:49] 以及躲避后果\\n[05:51] 他想要的不是你\\n[05:52] 而是你证明我值得被爱\\n[05:54] 而这个电影真正恐怖的地方也在这儿\\n[05:56] 当Nikki因为贝尔的许愿被夺舍之后\\n[05:59] 失去自我\\n[06:00] 折磨到已经几乎不成人形的时候\\n[06:03] 她在半夜的时候\\n[06:04] 短暂恢复意识的那几分钟\\n[06:06] 她非常痛苦的哀求着男主贝尔\\n[06:09] 她说你杀了我吧\\n[06:11] 我求求你了\\n[06:12] 你让我解脱吧\\n[06:13] 结果你们知道男主说了句什么吗\\n[06:14] 男主说：和我在一起到底有什么不好\\n[06:18] 我靠就这句话出来\\n[06:20] 我相信电影院一定是一片哗然的\\n[06:23] 因为在那一刻\\n[06:24] 经历了那么多恐怖的事情之后\\n[06:26] 他看到的还是仍然不是对方的痛苦\\n[06:29] 而是自己的委屈\\n[06:30] 她不成人形了\\n[06:32] 她在求救了\\n[06:33] 但这个男生还在想\\n[06:34] 我都给你我的爱了\\n[06:35] 你到底有什么不满意呀\\n[06:36] 你们看\\n[06:37] 这个就是极端自我的人最可怕的地方\\n[06:40] 因为在他们的世界里\\n[06:41] 伴侣不是一个有感受有想法\\n[06:44] 有喜怒哀乐有意志的人\\n[06:45] 而是一个应该满足自己配合自己\\n[06:48] 证明自己的工具角色\\n[06:51] 所以我真的觉得《痴迷》\\n[06:52] 表面上它讲的是一个什么禁忌\\n[06:54] 许愿的一个恐怖故事\\n[06:56] 但其实\\n[06:56] 他讲的是亲密关系里的恐怖故事\\n[06:59] 强制爱别人不会有什么好下场的\\n[07:01] 以及爱一旦只想着满足自己的话\\n[07:04] 就一定伴随着抹杀对方\\n[07:06] 真正健康的爱\\n[07:07] 不是对方完全符合你的期待\\n[07:09] 而是你能看到ta是一个独立的人\\n[07:11] ta有自己的痛苦边界和选择\\n[07:14] 也有不围着你转的权利\\n[07:16] 讲真的这部电影\\n[07:18] 把恐怖喜剧和情感的议题结合的非常好\\n[07:21] 它吓人但又不只是吓人\\n[07:23] 它荒诞但又特别现实\\n[07:25] 我真的希望这样的作品\\n[07:27] 被更多的人看到\\n[07:29] 但是这个人一定是大胆的人\\n[07:30] 如果大家很胆小\\n[07:31] 就不要去看了\\n[07:32] 因为这个电影真的是蛮恐怖的\\n[07:34] 好了今天的分享就到这了\\n[07:35] 我们下期再见啦拜拜","video_text_meta":{"status":"ok","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":8,"chunks_succeeded":8,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":""},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-25T09:09:47.270396+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对对心理学、亲密关系议题感兴趣的人群，以及恐怖电影爱好者或关注情感关系问题的观众。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能希望了解电影《痴迷》的看点，同时理解“脆弱型自恋者”这一隐蔽人格类型，以及如何在亲密关系中识别和应对类似行为。"},"content_structure":{"label":"内容怎么展开","summary":"内容先以个人观影体验引入，接着介绍电影剧情，然后通过影评和心理学概念分析角色行为，最后总结电影主题并给出观影建议。"},"solution":{"label":"给了什么解决办法","summary":"内容未给出明确解决办法，但通过分析脆弱型自恋者的行为模式，提醒观众在亲密关系中注意识别类似特征，并强调健康爱的关系应尊重对方独立性。"},"references":{"label":"值得参考什么","summary":"值得参考电影《痴迷》的剧情设定和影评观点，以及心理学中关于自恋两种维度（显性自恋和脆弱型自恋）的区分。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸制作关于脆弱型自恋者与内向性格的区别、亲密关系中的边界设定、或电影中其他心理学元素的解读等内容。"}},"source_labels":["封面标题","文字标题","作品描述","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1920", "cover": "http://sns-webpic-qc.xhscdn.com/202608251739/808b4a3a343eee15ed8f07049ca7d3e7/spectrum/1040g0k0323caaq687000401g2gsc7oj6kdls6m0!nd_dft_wlteh_webp_3", "taskId": "b36f1b924b66", "topics": ["痴迷", "治愈果", "心理学", "惊悚片", "自恋"], "account": {"url": "https://www.xiaohongshu.com/user/profile/54e6b8c3d39ea20e6b58e266", "name": "治愈果（kakki在说啥）", "followers": 162886}, "aiModel": "deepseek-v4-flash", "duration": "7分38秒", "platform": "xiaohongshu", "coverFrom": "inline", "mainTopic": "这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "784", "collects": "349", "comments": "75", "likesNum": 784, "collectsNum": 349, "commentsNum": 75}, "imageCount": 0, "imageFiles": [], "topicCount": 5, "generatedAt": "2026-08-25T09:09:47.270396+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 4766}	2026-08-25 10:01:50.273723+00	3f7398d2856a44b21729dbcffadf30be359df71d.webp
212	3cd91f3b313c	xiaohongshu	16	{"schema_version":16,"task_id":"3cd91f3b313c","source_url":"https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?source=webshare&xhsshare=pc_web&xsec_token=CBscI7y1gpeKhCHBWx4bfUg27s_Z2SodspTbBoMYTNOmc=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"借力高级心法","description":"不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种\\"全流程掌控\\"的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是\\"学\\"。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信\\"速成\\"可以等同于\\"掌握\\"，觉得知识必须经过自己漫长的消化才算是自己的，这是对\\"自我完整性\\"的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对\\"自我边界\\"的认知出了偏差。叫\\"我执\\"。 你把\\"我\\"画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把\\"我\\"看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲\\"君子生非异也，善假于物也\\"，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是\\"谁能比我更快更好地做成这件事\\"。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲\\"真空生妙有\\"，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的\\"空\\"就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个\\"妙有\\"——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从\\"我需要帮助\\"这个角度去看，开口就是示弱就是亏欠，你从\\"我在调动资源\\"这个角度去看。 这是借力的最高级心法 你以为的借力还是\\"我缺什么，我去拿\\"，但实际上而\\"让更有价值的人做更有价值的事，\\"利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜\\"我不欠任何人\\"，其实就是和任何人都没有关系。","cover_title":"不会借力是一种隐蔽的自恋","cover_title_meta":{"text":"不会借力是一种隐蔽的自恋","confidence":0.999,"font_ratio":1.45,"line_count":2,"lines":[{"text":"不会借力是一种","confidence":0.999},{"text":"隐蔽的自恋","confidence":0.999}],"source_image_index":1},"post_title":"借力高级心法","post_description":"不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种\\"全流程掌控\\"的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是\\"学\\"。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信\\"速成\\"可以等同于\\"掌握\\"，觉得知识必须经过自己漫长的消化才算是自己的，这是对\\"自我完整性\\"的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对\\"自我边界\\"的认知出了偏差。叫\\"我执\\"。 你把\\"我\\"画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把\\"我\\"看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲\\"君子生非异也，善假于物也\\"，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是\\"谁能比我更快更好地做成这件事\\"。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲\\"真空生妙有\\"，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的\\"空\\"就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个\\"妙有\\"——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从\\"我需要帮助\\"这个角度去看，开口就是示弱就是亏欠，你从\\"我在调动资源\\"这个角度去看。 这是借力的最高级心法 你以为的借力还是\\"我缺什么，我去拿\\"，但实际上而\\"让更有价值的人做更有价值的事，\\"利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜\\"我不欠任何人\\"，其实就是和任何人都没有关系。","display_title":"不会借力是一种隐蔽的自恋","author":"元元子","account":{"name":"元元子","profile_url":"https://www.xiaohongshu.com/user/profile/5592cc0f484fb665b39f939f","bio":"用星星术法和佛道哲学拆解人生\\n前大厂产品/前央企HR/中心协心理咨询师\\n🇬🇧warwick物理本·心理硕·浙大东哲mba在研·\\n地图研究@一个冻儿元 视频版（夸我美就行了","following_count":"3982","follower_count":"2410","likes_and_collections_count":"42845"},"collection_status":{"media":{"status":"not_video","method":"page","message":"未发现视频信号，按图文处理"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 元元子 关注 元元子 关注 借力高级心法 不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种&quot;全流程掌控&quot;的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是&quot;学&quot;。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信&quot;速成&quot;可以等同于&quot;掌握&quot;，觉得知识必须经过自己漫长的消化才算是自己的，这是对&quot;自我完整性&quot;的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对&quot;自我边界&quot;的认知出了偏差。叫&quot;我执&quot;。 你把&quot;我&quot;画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把&quot;我&quot;看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲&quot;君子生非异也，善假于物也&quot;，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是&quot;谁能比我更快更好地做成这件事&quot;。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲&quot;真空生妙有&quot;，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的&quot;空&quot;就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个&quot;妙有&quot;——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从&quot;我需要帮助&quot;这个角度去看，开口就是示弱就是亏欠，你从&quot;我在调动资源&quot;这个角度去看。 这是借力的最高级心法 你以为的借力还是&quot;我缺什么，我去拿&quot;，但实际上而&quot;让更有价值的人做更有价值的事，&quot;利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜&quot;我不欠任何人&quot;，其实就是和任何人都没有关系。 #修行 #女性力量 #心理 #借力 #女性智慧 #高能量 编辑于 07-27 加载中","text_same_as_description":true,"engagement":{"likes":"3814","collects":"2204","comments":"111"},"topics":["修行","女性力量","心理","借力","女性智慧","高能量"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"message":"BrowserType.launch: Executable doesn't exist at C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\ms-playwright\\\\chromium_headless_shell-1234\\\\chrome-headless-shell-win64\\\\chrome-headless-shell.ex"},"images":[{"index":1,"filename":"image_01.webp","text":"(Sun.) 七月二十六日 不会借力是一种 隐蔽的自恋","width":1080,"height":1440,"size_bytes":119878,"source_url":"http://sns-webpic-qc.xhscdn.com/202608260942/6434c7fe51ffe7b9b053841a0de9a7aa/1040g00832333r333721040t7t360v4sv2qr4pp8!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-26T01:42:56.032673+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对那些习惯独自完成所有事情、追求全流程掌控、对'自学'和'自我完整'有偏执的人群，尤其是高认知但可能陷入单一路径成功经验的人。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能面临因过度依赖自身努力而导致的效率低下、精力消耗和人际孤立，需要学会借助外部资源和人脉来提升生命效率。"},"content_structure":{"label":"内容怎么展开","summary":"内容先定义问题（不会借力是自恋和懒惰），再分析心理根源（自我边界偏差、我执、工具性思维差），最后提出借力的高维心法（视角转变和利他共赢）。"},"solution":{"label":"给了什么解决办法","summary":"给出的解决办法是转变借力视角：从'我需要帮助'转为'我在调动资源'，并强调借力是让更有价值的人做更有价值的事，形成利他共赢的结构。"},"references":{"label":"值得参考什么","summary":"值得参考的是内容中引用的古语'君子生非异也，善假于物也'和禅宗'真空生妙有'，以及诸葛亮借东风的比喻，这些用于支撑借力的智慧。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸的内容包括：具体如何识别可借力的资源、如何克服'自我完整'偏执的实操方法、借力在职场或创业中的案例，以及如何建立互惠的人际网络。"}},"source_labels":["封面标题","文字标题","作品描述","图片 OCR","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1440", "cover": "http://sns-webpic-qc.xhscdn.com/202608260942/6434c7fe51ffe7b9b053841a0de9a7aa/1040g00832333r333721040t7t360v4sv2qr4pp8!nd_dft_wlteh_webp_3", "taskId": "3cd91f3b313c", "topics": ["修行", "女性力量", "心理", "借力", "女性智慧", "高能量"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5592cc0f484fb665b39f939f", "name": "元元子", "followers": 2410}, "aiModel": "deepseek-v4-flash", "duration": null, "platform": "xiaohongshu", "coverFrom": "url", "mainTopic": "内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。", "mediaType": "image_post", "coverLocal": true, "engagement": {"likes": "3814", "collects": "2204", "comments": "111", "likesNum": 3814, "collectsNum": 2204, "commentsNum": 111}, "imageCount": 1, "imageFiles": [{"i": 0, "file": "15bbb73277e4c83d74ab4195d4798149cfbbb965.webp", "from": "url"}], "topicCount": 6, "generatedAt": "2026-08-26T01:42:56.032673+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": false, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 0}	2026-08-26 02:41:56.335911+00	e8205929cdcfcd84f7ca139d71c5c9bd2193391c.webp
213	9268a700b2c3	xiaohongshu	16	{"schema_version":16,"task_id":"9268a700b2c3","source_url":"https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"NPD有一个藏不住的语言习惯","description":"","cover_title":"NPD有一个藏不住的语言习惯","cover_title_meta":{"text":"NPD有一个藏不住的语言习惯","confidence":0.995,"font_ratio":2.76,"line_count":3,"lines":[{"text":"NPD有一个","confidence":0.999},{"text":"藏不住","confidence":0.997},{"text":"的语言习惯","confidence":0.989}],"source_image_index":1},"post_title":"NPD有一个藏不住的语言习惯","post_description":"","display_title":"NPD有一个藏不住的语言习惯","author":"枕书凉.","account":{"name":"枕书凉.","profile_url":"https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01","bio":"8️⃣年心理研究专家\\n擅长分析情感困惑，带你理性恋爱\\n🉑  1v1文字or语音☎️ （非公益）咨-询\\n亲密关系/自我提升/关系修复","following_count":"0","follower_count":"229","likes_and_collections_count":"9877"},"collection_status":{"media":{"status":"not_video","method":"page","message":"未发现视频信号，按图文处理"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 枕书凉. 关注 1/8 枕书凉. 关注 NPD有一个藏不住的语言习惯 #我重新相信相亲角了 #贵族 #npd #光子嫩肤 #股票 #高尔夫 #留学生 #这个夏天造点啥 08-01 湖北 加载中","text_same_as_description":false,"engagement":{"likes":"1295","collects":"951","comments":"286"},"topics":["我重新相信相亲角了","贵族","npd","光子嫩肤","股票","高尔夫","留学生","这个夏天造点啥"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[{"id":"6a72cbc6000000002901b106","type":"reply","author":"momo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/645b7f257b3e7e60e53504de.jpg?imageView2/2/w/120/format/jpg","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"created_at":1785908166000,"reply_count":0,"parent_comment_id":"6a721851000000002a02fe66","reply_to_author":"Momooo","parent_excerpt":"Npd绝对不会轻易夸人"},{"id":"6a6f0f5800000000150176b2","type":"comment","author":"水枪装尿呲谁谁叫","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31gureq033s005n0nfs3hap3732d8ot8?imageView2/2/w/120/format/jpg","text":"正常人：你这个不会？\\nnpd：你连这个都不会？","like_count":120,"created_at":1785663321000,"reply_count":16,"parent_comment_id":"","reply_to_author":""},{"id":"6a721851000000002a02fe66","type":"comment","author":"Momooo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31spc96te5s6g5q955grsl8jntuvp62o?imageView2/2/w/120/format/jpg","text":"Npd绝对不会轻易夸人","like_count":68,"created_at":1785862226000,"reply_count":29,"parent_comment_id":"","reply_to_author":""},{"id":"6a70d570000000000403afdf","type":"comment","author":"夏熙cc惜夏","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/635fa744a38044a4446559d9.jpg?imageView2/2/w/120/format/jpg","text":"你说：今天天气好热啊！\\n对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"created_at":1785779568000,"reply_count":10,"parent_comment_id":"","reply_to_author":""},{"id":"6a6eb60c0000000015015722","type":"comment","author":"Leo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/5fd23174f18f4f0001f720d1.jpg?imageView2/2/w/120/format/jpg","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"created_at":1785640460000,"reply_count":1,"parent_comment_id":"","reply_to_author":""}],"comment_summary":{"threshold":20,"limit":5,"returned":5,"scanned":112,"replies_scanned":82,"primary_pages":3,"reply_pages":19,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.92,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":true,"stable_pages":6},"images":[{"index":1,"filename":"image_01.webp","text":"NAME You are everything tome,and Iwas so blessed whenGodsentyouhereforme. --枕书凉-- NPD有一个 藏不住 的语言习惯 今天教你们一个识破NPD的绝招：不用看 他对你多好，不用听他表白的多甜，就看 他怎么说话。 我研究了上千个NPD案例，发现他们有一 个藏不住的语言习惯，就是他们永远不会 用关心的方式开启对话，只会用审判的方 式质问。","width":1080,"height":1440,"size_bytes":104984,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/6a7aeea1b7740c5c1abd2a78eb83996d/1040g0083239t0slnna5g5qhfo5o4030119ucv38!nd_dft_wlteh_webp_3"},{"index":2,"filename":"image_02.webp","text":"001@枕书凉 我给你举个例子，你就懂了。 正常人想知道你起床了没，会问：“你起床 了吗？”你吃饭了吗？” 这是开放式的关心，答案可以是yes，也可 以是n0 。 但NPD会怎么问？“你已经起来了？”“你已 经吃完了？” 发现没有？他们的提问里，根本没有“no” 这个选项。","width":1080,"height":1440,"size_bytes":82466,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/6d0d5a2877f8486ccb098f90060dcc95/1040g0083239t0slnna3g5qhfo5o40301um8viv0!nd_dft_wlteh_webp_3"},{"index":3,"filename":"image_03.webp","text":"002@枕书凉 他们问的不是你的状态，而是在确认一个 预设：“你必须已经起来了。你必须已经吃 完了。你必须满足我的期待。” 02这背后藏着一个可怕的思维模式： 正常人提问，是想了解对方；NPD提问, 是想控制结果。 他们接受不了拒绝，接受不了不符合预 期。因为在他们的世界里，“你不顺从\\"=“你 攻击我”。 那当你说“没有，我还没起”的时候，会发生 什么？","width":1080,"height":1440,"size_bytes":113990,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/e78e6af7243631fec57f023e89e6efdf/1040g0083239t0slnna4g5qhfo5o40301cs5j4so!nd_dft_wlteh_webp_3"},{"index":4,"filename":"image_04.webp","text":"003@枕书凉 低阶NPD当场破防：甩脸色、冷暴力、直 接骂你，“你什么毛病？都几点了还不起？” 高阶NPD更阴： 嘴上说着“没事没事，你睡吧”，但你明显能 感觉到气氛不对了。然后接下来，他会想 方设法解决你这个“拒绝”： 你没起床？他就在旁边制造噪音，让你睡 不着。 你拒绝他的观点？他就疯狂给你发视频、 发文章，直到你认可为止。","width":1080,"height":1440,"size_bytes":109634,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/cc37823e20c95fc11e8d80f31061cc66/1040g0083239t0slnna205qhfo5o40301940r130!nd_dft_wlteh_webp_3"},{"index":5,"filename":"image_05.webp","text":"004@枕书凉 你不想做的事？他会用各种方式让你觉得 “不做就是你的错”。 为什么？ 因为他们无法接受身边有任何人和自己不 一样。承认你的不同，意味着他的世界观 被挑战了；允许你拒绝，意味着他的自恋 受损了。 这就是为什么，正常人会内耗、会反思， NPD完全不会。 03正常人遇到不同意见，会想：是不是我 错了？是不是可以求同存异？","width":1080,"height":1440,"size_bytes":107596,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/bb275155b69af9d7285f35f5fa079c6c/1040g0083239t0slnna105qhfo5o40301lr6vm5o!nd_dft_wlteh_webp_3"},{"index":6,"filename":"image_06.webp","text":"005@枕书凉 但NPD的脑子里只有一种程序：“你不听我 的，就是攻击我；你攻击我，我就必须消 灭你。” 他们的世界里，没有容纳，没有理解。承 认别人，等于否定自己。所以他们只能不 停地赢、不停地控制、不停地消灭所有“不 一样”。 这也是为什么，你会觉得NPD目的性特别 强，执行力特别强。 为了让你顺从他，他可以无所不用其极; 为了让你认错，他可以跟你耗三天三夜。 但你发现没有？","width":1080,"height":1440,"size_bytes":121262,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/62f32ceae6a2262fc8899b6147c57d38/1040g0083239t0slnna2g5qhfo5o403019knafm0!nd_dft_wlteh_webp_3"},{"index":7,"filename":"image_07.webp","text":"006@枕书凉 他们的目的，从来不是为了真正解决问 题，也不是为了让自己变得更好，只是为 了满足那个“我赢了”的感觉。 所以你会看到一种奇观：NPD十年如一日 地愚蠢，十年如一日地原地踏步。他们用 尽所有力气去控制别人，却没有一分力气 用来成长自己。 为什么？因为他们的能量，全部用来维持 自恋了，没有余力，去拓展世界观。 我是枕书凉，一个从回避型成长为安全型 的心理咨询师，从事回避型依恋，婚姻关 系，感情修复等咨询已有8年。让你们更懂 回避型，如果你们遇到感情问题，希望能 帮到你们","width":1080,"height":1440,"size_bytes":153898,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/0ffa45d6dca3f06d8e97f372e1e2b415/1040g0083239t0slnna405qhfo5o403016pfpukg!nd_dft_wlteh_webp_3"},{"index":8,"filename":"image_08.webp","text":"007@枕书凉 如果你们的感情出现了以下几种情况，都 还有机会可以重归于好; 第一种：分开之后没有删除拉黑你，但 是态度很冷漠；写A 第二种：分开之后正常跟你聊天，但是 不愿意提及复合；写B 第三种：分开之后删除拉黑你，不愿沟 通态度决绝；写C 第四种：在一起经常吵架，或者对方经 常断联消失，消息电话不回。写D 有以上情况可以找我给你看看，我来帮你 从根本上解决你们的相处问题。","width":1080,"height":1440,"size_bytes":129020,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/ce2d8173e2de32ba1af6c0189c73b7b1/1040g0083239t0slnna505qhfo5o40301nse5ft8!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"ok","model":"deepseek-v4-flash","generated_at":"2026-08-26T02:39:59.564042+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要讲如何通过语言习惯识别自恋型人格障碍（NPD），并对比正常人与NPD在提问方式上的差异。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对在感情关系中遇到沟通困扰、怀疑对方有NPD倾向的人群，尤其是经历过分手或冲突的个体。"},"user_need":{"label":"用户主要问题或需求","summary":"用户需要识别伴侣是否具有NPD特征，理解其行为背后的原因，并寻求关系修复或应对方法。"},"content_structure":{"label":"内容怎么展开","summary":"内容先提出识别NPD的绝招，然后举例对比正常人与NPD的提问方式，分析NPD的思维模式，最后介绍咨询师身份并引导互动。"},"solution":{"label":"给了什么解决办法","summary":"内容给出的解决办法是观察对方的提问方式，识别NPD特征，并建议在感情出现特定问题时寻求作者咨询。"},"references":{"label":"值得参考什么","summary":"值得参考的是对NPD语言习惯的具体描述和例子，以及作者自称心理咨询师的专业背景。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做NPD其他行为特征的分析、如何与NPD沟通的实操技巧、或针对不同感情状况的应对策略。"}},"source_labels":["封面标题","文字标题","图片 OCR","公开互动数据"]},"comments":{"status":"ok","message":"","sample_size":5,"items":{"main_questions":{"label":"大家主要在问什么","summary":"大家主要在讨论NPD（自恋型人格障碍）的典型言行模式，包括其夸赞方式、否定倾向和对话控制行为。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},"high_frequency_needs":{"label":"高频需求","summary":"高频需求是识别NPD的言行特征，尤其是其否定性回应和隐性贬低模式。","evidence_comments":[{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]},"worries":{"label":"最担心什么","summary":"最担心NPD的隐性攻击性，如表面夸奖实则贬低，以及对话中的否定和操控。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]},"unclear_points":{"label":"博主没讲清什么","summary":"现有样本未形成明确结论。","evidence_comments":[]},"key_comments":{"label":"哪些评论值得重点看","entries":[{"comment":{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},"reason":"高赞评论，直接点出NPD夸赞中的隐性贬低，是用户关注的核心痛点"},{"comment":{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},"reason":"用对比方式生动概括NPD的否定性回应，获得高赞，反映普遍共鸣"},{"comment":{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},"reason":"具体生活化例子，展示NPD如何否定他人感受，便于理解"},{"comment":{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"},"reason":"补充NPD对话中的控制策略，提供行为模式洞察"}]},"topic_extensions":{"label":"可以延伸什么选题","entries":[{"idea":"NPD的隐性贬低：如何识别夸赞中的攻击性","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"}]},{"idea":"NPD与正常人的回应方式对比：日常对话中的警示信号","evidence_comments":[{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"}]},{"idea":"NPD如何否定你的感受：典型场景拆解","evidence_comments":[{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},{"idea":"NPD的对话控制术：如何绕回自己的预期","evidence_comments":[{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]}]}}}}}	{"size": "1080×1440", "cover": "http://sns-webpic-qc.xhscdn.com/202608261037/6a7aeea1b7740c5c1abd2a78eb83996d/1040g0083239t0slnna5g5qhfo5o4030119ucv38!nd_dft_wlteh_webp_3", "taskId": "9268a700b2c3", "topics": ["我重新相信相亲角了", "贵族", "npd", "光子嫩肤", "股票", "高尔夫"], "account": {"url": "https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01", "name": "枕书凉.", "followers": 229}, "aiModel": "deepseek-v4-flash", "duration": null, "platform": "xiaohongshu", "coverFrom": "url", "mainTopic": "这条内容主要讲如何通过语言习惯识别自恋型人格障碍（NPD），并对比正常人与NPD在提问方式上的差异。", "mediaType": "image_post", "coverLocal": true, "engagement": {"likes": "1295", "collects": "951", "comments": "286", "likesNum": 1295, "collectsNum": 951, "commentsNum": 286}, "imageCount": 8, "imageFiles": [{"i": 0, "file": "bbbee04b8f2d3bdadb1a7749edb0859e81d49e22.webp", "from": "url"}, {"i": 1, "file": "65110c242feabdc1d46d43f63712f00e395da43f.webp", "from": "url"}, {"i": 2, "file": "838e309c8ea8810fb56383c14949d9303f800095.webp", "from": "url"}, {"i": 3, "file": "a148a7a80e66378faf39493b36783848b416292a.webp", "from": "url"}, {"i": 4, "file": "bb0fc38d275363cbae1326e13f27b8d36d6d4547.webp", "from": "url"}, {"i": 5, "file": "2f6852dbd393cd9c71b038f73064d88c33c9b5bf.webp", "from": "url"}, {"i": 6, "file": "c3752e4795150b80bf78227ef328e98ee64d9301.webp", "from": "url"}, {"i": 7, "file": "395cdddc6a607b3e6fceef478089ef72b77304b1.webp", "from": "url"}], "topicCount": 8, "generatedAt": "2026-08-26T02:39:59.564042+00:00", "aiVideoCount": 7, "commentsShown": 5, "hasTranscript": false, "platformLabel": "小红书", "aiCommentCount": 6, "commentsScanned": 112, "transcriptChars": 0}	2026-08-26 02:42:03.263463+00	8add005afcbcf26408d1fb1a19cd14c4aeae9edb.webp
214	9268a700b2c3	xiaohongshu	16	{"schema_version":16,"task_id":"9268a700b2c3","source_url":"https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"NPD有一个藏不住的语言习惯","description":"","cover_title":"NPD有一个藏不住的语言习惯","cover_title_meta":{"text":"NPD有一个藏不住的语言习惯","confidence":0.995,"font_ratio":2.76,"line_count":3,"lines":[{"text":"NPD有一个","confidence":0.999},{"text":"藏不住","confidence":0.997},{"text":"的语言习惯","confidence":0.989}],"source_image_index":1},"post_title":"NPD有一个藏不住的语言习惯","post_description":"","display_title":"NPD有一个藏不住的语言习惯","author":"枕书凉.","account":{"name":"枕书凉.","profile_url":"https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01","bio":"8️⃣年心理研究专家\\n擅长分析情感困惑，带你理性恋爱\\n🉑  1v1文字or语音☎️ （非公益）咨-询\\n亲密关系/自我提升/关系修复","following_count":"0","follower_count":"229","likes_and_collections_count":"9877"},"collection_status":{"media":{"status":"not_video","method":"page","message":"未发现视频信号，按图文处理"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 枕书凉. 关注 1/8 枕书凉. 关注 NPD有一个藏不住的语言习惯 #我重新相信相亲角了 #贵族 #npd #光子嫩肤 #股票 #高尔夫 #留学生 #这个夏天造点啥 08-01 湖北 加载中","text_same_as_description":false,"engagement":{"likes":"1295","collects":"951","comments":"286"},"topics":["我重新相信相亲角了","贵族","npd","光子嫩肤","股票","高尔夫","留学生","这个夏天造点啥"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[{"id":"6a72cbc6000000002901b106","type":"reply","author":"momo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/645b7f257b3e7e60e53504de.jpg?imageView2/2/w/120/format/jpg","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"created_at":1785908166000,"reply_count":0,"parent_comment_id":"6a721851000000002a02fe66","reply_to_author":"Momooo","parent_excerpt":"Npd绝对不会轻易夸人"},{"id":"6a6f0f5800000000150176b2","type":"comment","author":"水枪装尿呲谁谁叫","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31gureq033s005n0nfs3hap3732d8ot8?imageView2/2/w/120/format/jpg","text":"正常人：你这个不会？\\nnpd：你连这个都不会？","like_count":120,"created_at":1785663321000,"reply_count":16,"parent_comment_id":"","reply_to_author":""},{"id":"6a721851000000002a02fe66","type":"comment","author":"Momooo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31spc96te5s6g5q955grsl8jntuvp62o?imageView2/2/w/120/format/jpg","text":"Npd绝对不会轻易夸人","like_count":68,"created_at":1785862226000,"reply_count":29,"parent_comment_id":"","reply_to_author":""},{"id":"6a70d570000000000403afdf","type":"comment","author":"夏熙cc惜夏","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/635fa744a38044a4446559d9.jpg?imageView2/2/w/120/format/jpg","text":"你说：今天天气好热啊！\\n对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"created_at":1785779568000,"reply_count":10,"parent_comment_id":"","reply_to_author":""},{"id":"6a6eb60c0000000015015722","type":"comment","author":"Leo","avatar_url":"https://sns-avatar-qc.xhscdn.com/avatar/5fd23174f18f4f0001f720d1.jpg?imageView2/2/w/120/format/jpg","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"created_at":1785640460000,"reply_count":1,"parent_comment_id":"","reply_to_author":""}],"comment_summary":{"threshold":20,"limit":5,"returned":5,"scanned":112,"replies_scanned":82,"primary_pages":3,"reply_pages":19,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.92,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":true,"stable_pages":6},"images":[{"index":1,"filename":"image_01.webp","text":"NAME You are everything tome,and Iwas so blessed whenGodsentyouhereforme. --枕书凉-- NPD有一个 藏不住 的语言习惯 今天教你们一个识破NPD的绝招：不用看 他对你多好，不用听他表白的多甜，就看 他怎么说话。 我研究了上千个NPD案例，发现他们有一 个藏不住的语言习惯，就是他们永远不会 用关心的方式开启对话，只会用审判的方 式质问。","width":1080,"height":1440,"size_bytes":104984,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/6a7aeea1b7740c5c1abd2a78eb83996d/1040g0083239t0slnna5g5qhfo5o4030119ucv38!nd_dft_wlteh_webp_3"},{"index":2,"filename":"image_02.webp","text":"001@枕书凉 我给你举个例子，你就懂了。 正常人想知道你起床了没，会问：“你起床 了吗？”你吃饭了吗？” 这是开放式的关心，答案可以是yes，也可 以是n0 。 但NPD会怎么问？“你已经起来了？”“你已 经吃完了？” 发现没有？他们的提问里，根本没有“no” 这个选项。","width":1080,"height":1440,"size_bytes":82466,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/6d0d5a2877f8486ccb098f90060dcc95/1040g0083239t0slnna3g5qhfo5o40301um8viv0!nd_dft_wlteh_webp_3"},{"index":3,"filename":"image_03.webp","text":"002@枕书凉 他们问的不是你的状态，而是在确认一个 预设：“你必须已经起来了。你必须已经吃 完了。你必须满足我的期待。” 02这背后藏着一个可怕的思维模式： 正常人提问，是想了解对方；NPD提问, 是想控制结果。 他们接受不了拒绝，接受不了不符合预 期。因为在他们的世界里，“你不顺从\\"=“你 攻击我”。 那当你说“没有，我还没起”的时候，会发生 什么？","width":1080,"height":1440,"size_bytes":113990,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/e78e6af7243631fec57f023e89e6efdf/1040g0083239t0slnna4g5qhfo5o40301cs5j4so!nd_dft_wlteh_webp_3"},{"index":4,"filename":"image_04.webp","text":"003@枕书凉 低阶NPD当场破防：甩脸色、冷暴力、直 接骂你，“你什么毛病？都几点了还不起？” 高阶NPD更阴： 嘴上说着“没事没事，你睡吧”，但你明显能 感觉到气氛不对了。然后接下来，他会想 方设法解决你这个“拒绝”： 你没起床？他就在旁边制造噪音，让你睡 不着。 你拒绝他的观点？他就疯狂给你发视频、 发文章，直到你认可为止。","width":1080,"height":1440,"size_bytes":109634,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/cc37823e20c95fc11e8d80f31061cc66/1040g0083239t0slnna205qhfo5o40301940r130!nd_dft_wlteh_webp_3"},{"index":5,"filename":"image_05.webp","text":"004@枕书凉 你不想做的事？他会用各种方式让你觉得 “不做就是你的错”。 为什么？ 因为他们无法接受身边有任何人和自己不 一样。承认你的不同，意味着他的世界观 被挑战了；允许你拒绝，意味着他的自恋 受损了。 这就是为什么，正常人会内耗、会反思， NPD完全不会。 03正常人遇到不同意见，会想：是不是我 错了？是不是可以求同存异？","width":1080,"height":1440,"size_bytes":107596,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/bb275155b69af9d7285f35f5fa079c6c/1040g0083239t0slnna105qhfo5o40301lr6vm5o!nd_dft_wlteh_webp_3"},{"index":6,"filename":"image_06.webp","text":"005@枕书凉 但NPD的脑子里只有一种程序：“你不听我 的，就是攻击我；你攻击我，我就必须消 灭你。” 他们的世界里，没有容纳，没有理解。承 认别人，等于否定自己。所以他们只能不 停地赢、不停地控制、不停地消灭所有“不 一样”。 这也是为什么，你会觉得NPD目的性特别 强，执行力特别强。 为了让你顺从他，他可以无所不用其极; 为了让你认错，他可以跟你耗三天三夜。 但你发现没有？","width":1080,"height":1440,"size_bytes":121262,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/62f32ceae6a2262fc8899b6147c57d38/1040g0083239t0slnna2g5qhfo5o403019knafm0!nd_dft_wlteh_webp_3"},{"index":7,"filename":"image_07.webp","text":"006@枕书凉 他们的目的，从来不是为了真正解决问 题，也不是为了让自己变得更好，只是为 了满足那个“我赢了”的感觉。 所以你会看到一种奇观：NPD十年如一日 地愚蠢，十年如一日地原地踏步。他们用 尽所有力气去控制别人，却没有一分力气 用来成长自己。 为什么？因为他们的能量，全部用来维持 自恋了，没有余力，去拓展世界观。 我是枕书凉，一个从回避型成长为安全型 的心理咨询师，从事回避型依恋，婚姻关 系，感情修复等咨询已有8年。让你们更懂 回避型，如果你们遇到感情问题，希望能 帮到你们","width":1080,"height":1440,"size_bytes":153898,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/0ffa45d6dca3f06d8e97f372e1e2b415/1040g0083239t0slnna405qhfo5o403016pfpukg!nd_dft_wlteh_webp_3"},{"index":8,"filename":"image_08.webp","text":"007@枕书凉 如果你们的感情出现了以下几种情况，都 还有机会可以重归于好; 第一种：分开之后没有删除拉黑你，但 是态度很冷漠；写A 第二种：分开之后正常跟你聊天，但是 不愿意提及复合；写B 第三种：分开之后删除拉黑你，不愿沟 通态度决绝；写C 第四种：在一起经常吵架，或者对方经 常断联消失，消息电话不回。写D 有以上情况可以找我给你看看，我来帮你 从根本上解决你们的相处问题。","width":1080,"height":1440,"size_bytes":129020,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261037/ce2d8173e2de32ba1af6c0189c73b7b1/1040g0083239t0slnna505qhfo5o40301nse5ft8!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"ok","model":"deepseek-v4-flash","generated_at":"2026-08-26T02:39:59.564042+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条内容主要讲如何通过语言习惯识别自恋型人格障碍（NPD），并对比正常人与NPD在提问方式上的差异。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对在感情关系中遇到沟通困扰、怀疑对方有NPD倾向的人群，尤其是经历过分手或冲突的个体。"},"user_need":{"label":"用户主要问题或需求","summary":"用户需要识别伴侣是否具有NPD特征，理解其行为背后的原因，并寻求关系修复或应对方法。"},"content_structure":{"label":"内容怎么展开","summary":"内容先提出识别NPD的绝招，然后举例对比正常人与NPD的提问方式，分析NPD的思维模式，最后介绍咨询师身份并引导互动。"},"solution":{"label":"给了什么解决办法","summary":"内容给出的解决办法是观察对方的提问方式，识别NPD特征，并建议在感情出现特定问题时寻求作者咨询。"},"references":{"label":"值得参考什么","summary":"值得参考的是对NPD语言习惯的具体描述和例子，以及作者自称心理咨询师的专业背景。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做NPD其他行为特征的分析、如何与NPD沟通的实操技巧、或针对不同感情状况的应对策略。"}},"source_labels":["封面标题","文字标题","图片 OCR","公开互动数据"]},"comments":{"status":"ok","message":"","sample_size":5,"items":{"main_questions":{"label":"大家主要在问什么","summary":"大家主要在讨论NPD（自恋型人格障碍）的典型言行模式，包括其夸赞方式、否定倾向和对话控制行为。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},"high_frequency_needs":{"label":"高频需求","summary":"高频需求是识别NPD的言行特征，尤其是其否定性回应和隐性贬低模式。","evidence_comments":[{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]},"worries":{"label":"最担心什么","summary":"最担心NPD的隐性攻击性，如表面夸奖实则贬低，以及对话中的否定和操控。","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]},"unclear_points":{"label":"博主没讲清什么","summary":"现有样本未形成明确结论。","evidence_comments":[]},"key_comments":{"label":"哪些评论值得重点看","entries":[{"comment":{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"},"reason":"高赞评论，直接点出NPD夸赞中的隐性贬低，是用户关注的核心痛点"},{"comment":{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"},"reason":"用对比方式生动概括NPD的否定性回应，获得高赞，反映普遍共鸣"},{"comment":{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"},"reason":"具体生活化例子，展示NPD如何否定他人感受，便于理解"},{"comment":{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"},"reason":"补充NPD对话中的控制策略，提供行为模式洞察"}]},"topic_extensions":{"label":"可以延伸什么选题","entries":[{"idea":"NPD的隐性贬低：如何识别夸赞中的攻击性","evidence_comments":[{"id":"6a72cbc6000000002901b106","author":"momo","text":"会夸，但是后面立马带着贬[微笑R]","like_count":130,"type":"reply"}]},{"idea":"NPD与正常人的回应方式对比：日常对话中的警示信号","evidence_comments":[{"id":"6a6f0f5800000000150176b2","author":"水枪装尿呲谁谁叫","text":"正常人：你这个不会？ npd：你连这个都不会？","like_count":120,"type":"comment"}]},{"idea":"NPD如何否定你的感受：典型场景拆解","evidence_comments":[{"id":"6a70d570000000000403afdf","author":"夏熙cc惜夏","text":"你说：今天天气好热啊！ 对方说：不是，今天天气还好的，等下中午/下午才会热","like_count":42,"type":"comment"}]},{"idea":"NPD的对话控制术：如何绕回自己的预期","evidence_comments":[{"id":"6a6eb60c0000000015015722","author":"Leo","text":"的确，问题中全带着答案。如果你给的不符合预期，他会想办法绕回来","like_count":41,"type":"comment"}]}]}}}}}	{"size": "1080×1440", "cover": "http://sns-webpic-qc.xhscdn.com/202608261037/6a7aeea1b7740c5c1abd2a78eb83996d/1040g0083239t0slnna5g5qhfo5o4030119ucv38!nd_dft_wlteh_webp_3", "taskId": "9268a700b2c3", "topics": ["我重新相信相亲角了", "贵族", "npd", "光子嫩肤", "股票", "高尔夫"], "account": {"url": "https://www.xiaohongshu.com/user/profile/6a2fc1700000000010000c01", "name": "枕书凉.", "followers": 229}, "aiModel": "deepseek-v4-flash", "duration": null, "platform": "xiaohongshu", "coverFrom": "url", "mainTopic": "这条内容主要讲如何通过语言习惯识别自恋型人格障碍（NPD），并对比正常人与NPD在提问方式上的差异。", "mediaType": "image_post", "coverLocal": true, "engagement": {"likes": "1295", "collects": "951", "comments": "286", "likesNum": 1295, "collectsNum": 951, "commentsNum": 286}, "imageCount": 8, "imageFiles": [{"i": 0, "file": "d92e8141603262b8778c8f0b9b3bda6883c7c2d4.webp", "from": "url"}, {"i": 1, "file": "58a46ef15367beec07e34d2a2351440ed9c9baa1.webp", "from": "url"}, {"i": 2, "file": "031e178584762378d4c1d9582f2ba3df6857ec3b.webp", "from": "url"}, {"i": 3, "file": "2b96ce972e1476028b64d4badda5cde5a2f44002.webp", "from": "url"}, {"i": 4, "file": "f51a123da845c89ccad01196b3519aeae2a9a149.webp", "from": "url"}, {"i": 5, "file": "896d8e835e679af0f981c6dce971f2988cf68101.webp", "from": "url"}, {"i": 6, "file": "ed274e69c1fbac9e8112f71a8bc27f1f7a8ba34b.webp", "from": "url"}, {"i": 7, "file": "96a98cf40e638579ba42617050d7804771319ee9.webp", "from": "url"}], "topicCount": 8, "generatedAt": "2026-08-26T02:39:59.564042+00:00", "aiVideoCount": 7, "commentsShown": 5, "hasTranscript": false, "platformLabel": "小红书", "aiCommentCount": 6, "commentsScanned": 112, "transcriptChars": 0}	2026-08-26 02:41:01.794109+00	38cd574cf4fc6389a8c45a96f433667e026e2d15.webp
215	3cd91f3b313c	xiaohongshu	16	{"schema_version":16,"task_id":"3cd91f3b313c","source_url":"https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?source=webshare&xhsshare=pc_web&xsec_token=CBscI7y1gpeKhCHBWx4bfUg27s_Z2SodspTbBoMYTNOmc=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"借力高级心法","description":"不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种\\"全流程掌控\\"的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是\\"学\\"。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信\\"速成\\"可以等同于\\"掌握\\"，觉得知识必须经过自己漫长的消化才算是自己的，这是对\\"自我完整性\\"的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对\\"自我边界\\"的认知出了偏差。叫\\"我执\\"。 你把\\"我\\"画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把\\"我\\"看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲\\"君子生非异也，善假于物也\\"，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是\\"谁能比我更快更好地做成这件事\\"。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲\\"真空生妙有\\"，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的\\"空\\"就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个\\"妙有\\"——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从\\"我需要帮助\\"这个角度去看，开口就是示弱就是亏欠，你从\\"我在调动资源\\"这个角度去看。 这是借力的最高级心法 你以为的借力还是\\"我缺什么，我去拿\\"，但实际上而\\"让更有价值的人做更有价值的事，\\"利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜\\"我不欠任何人\\"，其实就是和任何人都没有关系。","cover_title":"不会借力是一种隐蔽的自恋","cover_title_meta":{"text":"不会借力是一种隐蔽的自恋","confidence":0.999,"font_ratio":1.45,"line_count":2,"lines":[{"text":"不会借力是一种","confidence":0.999},{"text":"隐蔽的自恋","confidence":0.999}],"source_image_index":1},"post_title":"借力高级心法","post_description":"不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种\\"全流程掌控\\"的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是\\"学\\"。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信\\"速成\\"可以等同于\\"掌握\\"，觉得知识必须经过自己漫长的消化才算是自己的，这是对\\"自我完整性\\"的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对\\"自我边界\\"的认知出了偏差。叫\\"我执\\"。 你把\\"我\\"画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把\\"我\\"看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲\\"君子生非异也，善假于物也\\"，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是\\"谁能比我更快更好地做成这件事\\"。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲\\"真空生妙有\\"，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的\\"空\\"就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个\\"妙有\\"——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从\\"我需要帮助\\"这个角度去看，开口就是示弱就是亏欠，你从\\"我在调动资源\\"这个角度去看。 这是借力的最高级心法 你以为的借力还是\\"我缺什么，我去拿\\"，但实际上而\\"让更有价值的人做更有价值的事，\\"利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜\\"我不欠任何人\\"，其实就是和任何人都没有关系。","display_title":"不会借力是一种隐蔽的自恋","author":"元元子","account":{"name":"元元子","profile_url":"https://www.xiaohongshu.com/user/profile/5592cc0f484fb665b39f939f","bio":"用星星术法和佛道哲学拆解人生\\n前大厂产品/前央企HR/中心协心理咨询师\\n🇬🇧warwick物理本·心理硕·浙大东哲mba在研·\\n地图研究@一个冻儿元 视频版（夸我美就行了","following_count":"3982","follower_count":"2410","likes_and_collections_count":"42845"},"collection_status":{"media":{"status":"not_video","method":"page","message":"未发现视频信号，按图文处理"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 元元子 关注 元元子 关注 借力高级心法 不会借力的人，本质上是被一种极其隐蔽的自恋和懒惰 我说的借力不只是借人脉，是一切可用的资源和人脉。 把自己笨拙的努力，修饰成一个苦哈哈的角色。不张扬，挺体面——但其实就是太把自己当回事了。 就是懒，懒得换一种方式活着。 享受那种&quot;全流程掌控&quot;的感觉，每一颗螺丝都是自己亲手拧上去的，有一种畸形的完成感。 但是我相信很多高认知的人是信任自己的成功过的单一路径的，想做一件事，第一反应永远是&quot;学&quot;。自学，从零开始，把整个体系啃一遍，然后自己动手。这类人有一个很深的潜意识——不相信&quot;速成&quot;可以等同于&quot;掌握&quot;，觉得知识必须经过自己漫长的消化才算是自己的，这是对&quot;自我完整性&quot;的偏执 你有没有想过用三秒改变的代价，换三小时生命的增量。那三个小时，我可以做多少事？ 不会借力的人，本质上是对&quot;自我边界&quot;的认知出了偏差。叫&quot;我执&quot;。 你把&quot;我&quot;画得太小，小到只够塞进我所坚持的自己，才叫精进；你又把&quot;我&quot;看得太大，大到觉得整个世界都必须经由你自己操心才能安全 这也是一种工具性思维差，你在你的世界里，看不到杠杆，看不到系统，看不到流程，看不到人脉 古人讲&quot;君子生非异也，善假于物也&quot;，说白了就是聪明人没什么特别的，就是会借东西。 会用东西就是聪明。 做事情遇到困难，第一反应是&quot;谁能比我更快更好地做成这件事&quot;。这是对时间的敬畏。你的生命是有限的，精力是有限的 禅宗讲&quot;真空生妙有&quot;，你把自己掏空一点，把那些不属于你的、不需要你亲自做的、别人做也一样甚至更好的事情交出去，你的&quot;空&quot;就出来了。 不要那么相信自己，也不要那么不相信别人。 然后那个&quot;妙有&quot;——那些只属于你的洞察、方向、判断——就从空里冒出来了。 但我要说一个借力的高维心法。 在于你的视角。你从&quot;我需要帮助&quot;这个角度去看，开口就是示弱就是亏欠，你从&quot;我在调动资源&quot;这个角度去看。 这是借力的最高级心法 你以为的借力还是&quot;我缺什么，我去拿&quot;，但实际上而&quot;让更有价值的人做更有价值的事，&quot;利他共赢的结构 你会觉得诸葛亮借东风是示弱吗？ 我告诉你，人际关系里最危险的不是互相亏欠，而是毫无交集。你从来不开口，从来不走进别人的世界，别人也走不进你的世界， 标榜&quot;我不欠任何人&quot;，其实就是和任何人都没有关系。 #修行 #女性力量 #心理 #借力 #女性智慧 #高能量 编辑于 07-27 加载中","text_same_as_description":true,"engagement":{"likes":"3814","collects":"2204","comments":"111"},"topics":["修行","女性力量","心理","借力","女性智慧","高能量"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"message":"BrowserType.launch: Executable doesn't exist at C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\ms-playwright\\\\chromium_headless_shell-1234\\\\chrome-headless-shell-win64\\\\chrome-headless-shell.ex"},"images":[{"index":1,"filename":"image_01.webp","text":"(Sun.) 七月二十六日 不会借力是一种 隐蔽的自恋","width":1080,"height":1440,"size_bytes":119878,"source_url":"http://sns-webpic-qc.xhscdn.com/202608260942/6434c7fe51ffe7b9b053841a0de9a7aa/1040g00832333r333721040t7t360v4sv2qr4pp8!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-26T01:42:56.032673+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对那些习惯独自完成所有事情、追求全流程掌控、对'自学'和'自我完整'有偏执的人群，尤其是高认知但可能陷入单一路径成功经验的人。"},"user_need":{"label":"用户主要问题或需求","summary":"用户可能面临因过度依赖自身努力而导致的效率低下、精力消耗和人际孤立，需要学会借助外部资源和人脉来提升生命效率。"},"content_structure":{"label":"内容怎么展开","summary":"内容先定义问题（不会借力是自恋和懒惰），再分析心理根源（自我边界偏差、我执、工具性思维差），最后提出借力的高维心法（视角转变和利他共赢）。"},"solution":{"label":"给了什么解决办法","summary":"给出的解决办法是转变借力视角：从'我需要帮助'转为'我在调动资源'，并强调借力是让更有价值的人做更有价值的事，形成利他共赢的结构。"},"references":{"label":"值得参考什么","summary":"值得参考的是内容中引用的古语'君子生非异也，善假于物也'和禅宗'真空生妙有'，以及诸葛亮借东风的比喻，这些用于支撑借力的智慧。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸的内容包括：具体如何识别可借力的资源、如何克服'自我完整'偏执的实操方法、借力在职场或创业中的案例，以及如何建立互惠的人际网络。"}},"source_labels":["封面标题","文字标题","作品描述","图片 OCR","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1440", "cover": "http://sns-webpic-qc.xhscdn.com/202608260942/6434c7fe51ffe7b9b053841a0de9a7aa/1040g00832333r333721040t7t360v4sv2qr4pp8!nd_dft_wlteh_webp_3", "taskId": "3cd91f3b313c", "topics": ["修行", "女性力量", "心理", "借力", "女性智慧", "高能量"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5592cc0f484fb665b39f939f", "name": "元元子", "followers": 2410}, "aiModel": "deepseek-v4-flash", "duration": null, "platform": "xiaohongshu", "coverFrom": "url", "mainTopic": "内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。", "mediaType": "image_post", "coverLocal": true, "engagement": {"likes": "3814", "collects": "2204", "comments": "111", "likesNum": 3814, "collectsNum": 2204, "commentsNum": 111}, "imageCount": 1, "imageFiles": [{"i": 0, "file": "1cc742feaedf4e60d8d9f06ced4868199b93115d.webp", "from": "url"}], "topicCount": 6, "generatedAt": "2026-08-26T01:42:56.032673+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": false, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 0}	2026-08-26 02:41:04.712529+00	fe793b5791781d68da8c7c22cd2d4dffb33b68a9.webp
210	d2f5523e8cea	xiaohongshu	16	{"schema_version":16,"task_id":"d2f5523e8cea","source_url":"https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608260939/c36fab8c27ae14e7af0222b3bf998101/spectrum/1040g0k03249p4lb30m005oq615kmbrh48v6a3ng!nd_dft_wlteh_jpg_3","duration_seconds":114.15,"width":2160,"height":3840,"size_bytes":14422477,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_source":"platform_video_cover","cover_image_url":"http://sns-webpic-qc.xhscdn.com/202608260939/0878ef20126e158d0afc06c554fbbd9d/spectrum/1040g0k03249p4lb30m005oq615kmbrh48v6a3ng!nd_dft_wlteh_webp_3","cover_image_b64":"（已落地为本地封面文件，原始 189183 字符）","cover_image_width":1080,"cover_image_height":1441,"cover_image_size_bytes":141868}},"title":"双视角曝光，大家看看我有念稿感吗","description":"","cover_title":"两招去掉念稿感","cover_title_meta":{"text":"两招去掉念稿感","confidence":0.994,"font_ratio":1.3,"line_count":2,"lines":[{"text":"两招去掉","confidence":0.999},{"text":"念稿感","confidence":0.989}],"source_image_index":1,"source":"platform_video_cover"},"post_title":"双视角曝光，大家看看我有念稿感吗","post_description":"","display_title":"两招去掉念稿感","author":"北电超然","account":{"name":"北电超然","profile_url":"https://www.xiaohongshu.com/user/profile/63460969000000001901ee24","bio":"北京电影学院| 于超然（百度百科）\\n🎓14年表演教学与镜头训练经验\\n🎬第33届金鸡电影节最佳影片奖表演指导\\n帮老板用“微剧情”把内容做出差异化\\n让观众愿意看完，也愿意买单！","following_count":"1","follower_count":"2982","likes_and_collections_count":"11998"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"161","collects":"205","comments":"7"},"topics":["表现力","口播","念稿感","老板拍短视频","创始人ip"],"video_text":"[00:00] 脚本写的再好\\n[00:01] 你念稿感这个事你不解决\\n[00:03] 你的视频就是没流量\\n[00:05] OK这个是我的第二视角\\n[00:07] 右边是提词器\\n[00:08] 左边是摄影机\\n[00:09] 那我问你\\n[00:10] 现在你会觉得我有念稿感吗\\n[00:12] ok 那今天\\n[00:13] 我给大家分享\\n[00:14] 两个北电训练的方法\\n[00:16] 教你们如何去\\n[00:17] 去掉这该死的念稿感\\n[00:19] 说话的语速\\n[00:20] 你不能太均匀了\\n[00:22] 如果你每一句话\\n[00:23] 都用一样的语气\\n[00:24] 一样的节奏力度\\n[00:26] 那观众听你讲话\\n[00:27] 就好比是机器人一样\\n[00:29] 真正自然的表达\\n[00:31] 绝对不是每一句话都是一个调\\n[00:33] 它一定是有的地方是重的\\n[00:35] 有的地方是轻的\\n[00:36] 「哎说到这」\\n[00:38] 「我突然想起了一件事」\\n[00:40] 你看我刚刚的表达\\n[00:41] 是不是卡一下子\\n[00:42] 结巴一下都是没有问题的\\n[00:44] 这个就会显得很自然\\n[00:45] 很有活人感\\n[00:46] 节奏上你不能乱停顿\\n[00:48] 有的人说话习惯性的很快\\n[00:50] 有的人会刻意的又说的很慢\\n[00:53] 但是停顿的意义\\n[00:54] 是为了让重点被听进去啊\\n[00:57] 你不能为了停而停啊","video_text_meta":{"status":"partial","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":2,"chunks_succeeded":1,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":"第 2 段：Moxus 请求失败（HTTP 503）：The requested model is temporarily unavailable."},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"message":"BrowserType.launch: Executable doesn't exist at C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\ms-playwright\\\\chromium_headless_shell-1234\\\\chrome-headless-shell-win64\\\\chrome-headless-shell.ex"},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-26T01:40:33.390844+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条视频主要讲如何通过两个训练方法去除视频拍摄中的念稿感，提升表达的自然度。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对需要拍摄口播视频、担心念稿感影响流量和观众感受的内容创作者。"},"user_need":{"label":"用户主要问题或需求","summary":"用户主要问题是视频表达有念稿感，导致不自然、缺乏吸引力，可能影响流量。"},"content_structure":{"label":"内容怎么展开","summary":"内容先提出问题（念稿感影响流量），再展示自身双视角作为例子，然后介绍两个训练方法，最后具体说明方法要点。"},"solution":{"label":"给了什么解决办法","summary":"提供了两个方法：一是控制语速，避免每句话语气、节奏、力度均匀；二是合理停顿，停顿是为了让重点被听进去，而不是为了停而停。"},"references":{"label":"值得参考什么","summary":"值得参考的是双视角展示（提词器与摄影机同时呈现）以及北电训练方法的实际演示。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做更多关于口播表达技巧的内容，如不同场景下的语速控制、停顿练习示范，或对比有念稿感和无念稿感的案例。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "2160×3840", "cover": "http://sns-webpic-qc.xhscdn.com/202608260939/0878ef20126e158d0afc06c554fbbd9d/spectrum/1040g0k03249p4lb30m005oq615kmbrh48v6a3ng!nd_dft_wlteh_webp_3", "taskId": "d2f5523e8cea", "topics": ["表现力", "口播", "念稿感", "老板拍短视频", "创始人ip"], "account": {"url": "https://www.xiaohongshu.com/user/profile/63460969000000001901ee24", "name": "北电超然", "followers": 2982}, "aiModel": "deepseek-v4-flash", "duration": "1分54秒", "platform": "xiaohongshu", "coverFrom": "inline", "mainTopic": "这条视频主要讲如何通过两个训练方法去除视频拍摄中的念稿感，提升表达的自然度。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "161", "collects": "205", "comments": "7", "likesNum": 161, "collectsNum": 205, "commentsNum": 7}, "imageCount": 0, "imageFiles": [], "topicCount": 5, "generatedAt": "2026-08-26T01:40:33.390844+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 636}	2026-08-26 02:41:06.946254+00	a27f19766718954942e5ff022d80bd9ccbc63af7.webp
218	d2f5523e8cea	xiaohongshu	16	{"schema_version":16,"task_id":"d2f5523e8cea","source_url":"https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":false,"temporary_media_deleted":true},"media_type":"video","media_assets":{"video":{"source_url":"https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share","thumbnail_url":"http://sns-webpic-qc.xhscdn.com/202608260939/c36fab8c27ae14e7af0222b3bf998101/spectrum/1040g0k03249p4lb30m005oq615kmbrh48v6a3ng!nd_dft_wlteh_jpg_3","duration_seconds":114.15,"width":2160,"height":3840,"size_bytes":14422477,"format":"HD","video_codec":"hevc","processed_from_temporary_download":true,"cover_image_source":"platform_video_cover","cover_image_url":"http://sns-webpic-qc.xhscdn.com/202608260939/0878ef20126e158d0afc06c554fbbd9d/spectrum/1040g0k03249p4lb30m005oq615kmbrh48v6a3ng!nd_dft_wlteh_webp_3","cover_image_b64":"（已落地为本地封面文件，原始 189183 字符）","cover_image_width":1080,"cover_image_height":1441,"cover_image_size_bytes":141868}},"title":"双视角曝光，大家看看我有念稿感吗","description":"","cover_title":"两招去掉念稿感","cover_title_meta":{"text":"两招去掉念稿感","confidence":0.994,"font_ratio":1.3,"line_count":2,"lines":[{"text":"两招去掉","confidence":0.999},{"text":"念稿感","confidence":0.989}],"source_image_index":1,"source":"platform_video_cover"},"post_title":"双视角曝光，大家看看我有念稿感吗","post_description":"","display_title":"两招去掉念稿感","author":"北电超然","account":{"name":"北电超然","profile_url":"https://www.xiaohongshu.com/user/profile/63460969000000001901ee24","bio":"北京电影学院| 于超然（百度百科）\\n🎓14年表演教学与镜头训练经验\\n🎬第33届金鸡电影节最佳影片奖表演指导\\n帮老板用“微剧情”把内容做出差异化\\n让观众愿意看完，也愿意买单！","following_count":"1","follower_count":"2982","likes_and_collections_count":"11998"},"collection_status":{"media":{"status":"ok","method":"video_download","message":"视频素材读取成功"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"","text_same_as_description":false,"engagement":{"likes":"161","collects":"205","comments":"7"},"topics":["表现力","口播","念稿感","老板拍短视频","创始人ip"],"video_text":"[00:00] 脚本写的再好\\n[00:01] 你念稿感这个事你不解决\\n[00:03] 你的视频就是没流量\\n[00:05] OK这个是我的第二视角\\n[00:07] 右边是提词器\\n[00:08] 左边是摄影机\\n[00:09] 那我问你\\n[00:10] 现在你会觉得我有念稿感吗\\n[00:12] ok 那今天\\n[00:13] 我给大家分享\\n[00:14] 两个北电训练的方法\\n[00:16] 教你们如何去\\n[00:17] 去掉这该死的念稿感\\n[00:19] 说话的语速\\n[00:20] 你不能太均匀了\\n[00:22] 如果你每一句话\\n[00:23] 都用一样的语气\\n[00:24] 一样的节奏力度\\n[00:26] 那观众听你讲话\\n[00:27] 就好比是机器人一样\\n[00:29] 真正自然的表达\\n[00:31] 绝对不是每一句话都是一个调\\n[00:33] 它一定是有的地方是重的\\n[00:35] 有的地方是轻的\\n[00:36] 「哎说到这」\\n[00:38] 「我突然想起了一件事」\\n[00:40] 你看我刚刚的表达\\n[00:41] 是不是卡一下子\\n[00:42] 结巴一下都是没有问题的\\n[00:44] 这个就会显得很自然\\n[00:45] 很有活人感\\n[00:46] 节奏上你不能乱停顿\\n[00:48] 有的人说话习惯性的很快\\n[00:50] 有的人会刻意的又说的很慢\\n[00:53] 但是停顿的意义\\n[00:54] 是为了让重点被听进去啊\\n[00:57] 你不能为了停而停啊","video_text_meta":{"status":"partial","method":"moxus_video","provider":"moxus","model":"gemini-3.6-flash","chunks_total":2,"chunks_succeeded":1,"chunk_seconds":60,"overlap_seconds":2,"fps":4,"message":"第 2 段：Moxus 请求失败（HTTP 503）：The requested model is temporarily unavailable."},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":0,"replies_scanned":0,"primary_pages":0,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"unavailable","likes_obscured":false,"obscured_count":0,"confidence":0.1,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"message":"BrowserType.launch: Executable doesn't exist at C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\ms-playwright\\\\chromium_headless_shell-1234\\\\chrome-headless-shell-win64\\\\chrome-headless-shell.ex"},"images":[],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-26T01:40:33.390844+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"这条视频主要讲如何通过两个训练方法去除视频拍摄中的念稿感，提升表达的自然度。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对需要拍摄口播视频、担心念稿感影响流量和观众感受的内容创作者。"},"user_need":{"label":"用户主要问题或需求","summary":"用户主要问题是视频表达有念稿感，导致不自然、缺乏吸引力，可能影响流量。"},"content_structure":{"label":"内容怎么展开","summary":"内容先提出问题（念稿感影响流量），再展示自身双视角作为例子，然后介绍两个训练方法，最后具体说明方法要点。"},"solution":{"label":"给了什么解决办法","summary":"提供了两个方法：一是控制语速，避免每句话语气、节奏、力度均匀；二是合理停顿，停顿是为了让重点被听进去，而不是为了停而停。"},"references":{"label":"值得参考什么","summary":"值得参考的是双视角展示（提词器与摄影机同时呈现）以及北电训练方法的实际演示。"},"extensions":{"label":"还能延伸做什么内容","summary":"可以延伸做更多关于口播表达技巧的内容，如不同场景下的语速控制、停顿练习示范，或对比有念稿感和无念稿感的案例。"}},"source_labels":["封面标题","文字标题","视频模型逐段识别","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "2160×3840", "cover": "http://sns-webpic-qc.xhscdn.com/202608260939/0878ef20126e158d0afc06c554fbbd9d/spectrum/1040g0k03249p4lb30m005oq615kmbrh48v6a3ng!nd_dft_wlteh_webp_3", "taskId": "d2f5523e8cea", "topics": ["表现力", "口播", "念稿感", "老板拍短视频", "创始人ip"], "account": {"url": "https://www.xiaohongshu.com/user/profile/63460969000000001901ee24", "name": "北电超然", "followers": 2982}, "aiModel": "deepseek-v4-flash", "duration": "1分54秒", "platform": "xiaohongshu", "coverFrom": "inline", "mainTopic": "这条视频主要讲如何通过两个训练方法去除视频拍摄中的念稿感，提升表达的自然度。", "mediaType": "video", "coverLocal": true, "engagement": {"likes": "161", "collects": "205", "comments": "7", "likesNum": 161, "collectsNum": 205, "commentsNum": 7}, "imageCount": 0, "imageFiles": [], "topicCount": 5, "generatedAt": "2026-08-26T01:40:33.390844+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": true, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": null, "transcriptChars": 636}	2026-08-26 02:41:58.496671+00	2f67699a56d9b573c926a324fb29700a6fe17ba1.webp
221	da567dacc677	xiaohongshu	16	{"schema_version":16,"task_id":"da567dacc677","collected_at":"2026-08-26T16:55:27+08:00","manual_refresh":false,"source_url":"https://www.xiaohongshu.com/discovery/item/6a69c47400000000050380df?source=webshare&xhsshare=pc_web&xsec_token=ABKHtbzSs3-U4KMlmja0MixJhn5Yfq0tyD9E1GvM0NLB0=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"不怕失去的底层安全感，怎么来的？","description":"亲密关系中，不怕失去的底层安全感，怎么来的？","cover_title":"亲密关系中","cover_title_meta":{"text":"亲密关系中","confidence":0.968,"font_ratio":1.23,"line_count":1,"lines":[{"text":"亲密关系中","confidence":0.968}],"source_image_index":1},"post_title":"不怕失去的底层安全感，怎么来的？","post_description":"亲密关系中，不怕失去的底层安全感，怎么来的？","display_title":"亲密关系中","author":"谢小树","account":{"name":"谢小树","profile_url":"https://www.xiaohongshu.com/user/profile/5db778250000000001008987","bio":"👑  12年心理咨询师｜ 17年深耕易学\\n👑  直播切片 ：@谢小树🌲宝藏树 \\n     ✉️✉️找到我✉️✉️\\n【直播、连麦】：每月第一个周日12-15点","following_count":"16","follower_count":"183814","likes_and_collections_count":"916719"},"collection_status":{"media":{"status":"not_video","method":"page","message":"未发现视频信号，按图文处理"},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 谢小树 关注 谢小树 关注 不怕失去的底层安全感，怎么来的？ 亲密关系中，不怕失去的底层安全感，怎么来的？ #女性智慧 #女性成长 #心理学 #情感 07-31 重庆 加载中","text_same_as_description":false,"engagement":{"likes":"624","collects":"470","comments":"15"},"topics":["女性智慧","女性成长","心理学","情感"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":15,"replies_scanned":7,"primary_pages":1,"reply_pages":2,"scope":"bounded_platform_hot_stream","truncated":true,"status":"ok","likes_obscured":false,"obscured_count":0,"confidence":0.166,"confidence_target":0.8,"strategy":"adaptive_hot_stream","confidence_reached":false,"stable_pages":0},"images":[{"index":1,"filename":"image_01.webp","text":"亲密关系中 不怕失去的底层安全感 怎么来的","width":1080,"height":1440,"size_bytes":192158,"source_url":"http://sns-webpic-qc.xhscdn.com/202608261654/85fe15cd6c0563e7c982e8a4665b3194/1040g0083236v77hfnk4g5ndnf0ig92c7o7vtp7g!nd_dft_wlteh_webp_3"}],"ai_analysis":{"schema_version":1,"status":"partial","model":"deepseek-v4-flash","generated_at":"2026-08-26T08:55:27.607439+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"ok","message":"","items":{"main_topic":{"label":"这条主要讲什么","summary":"内容围绕亲密关系中'不怕失去的底层安全感'这一主题展开，探讨其来源。"},"target_audience":{"label":"针对什么人 / 场景","summary":"针对在亲密关系中缺乏安全感、容易患得患失的人群。"},"user_need":{"label":"用户主要问题或需求","summary":"用户需要了解如何在亲密关系中建立不依赖对方、不惧失去的底层安全感。"},"content_structure":{"label":"内容怎么展开","summary":"以提问式标题引入，正文未提供具体展开结构，可能以论述或案例形式说明。"},"solution":{"label":"给了什么解决办法","summary":"内容未给出明确解决办法。"},"references":{"label":"值得参考什么","summary":"可参考亲密关系心理学、依恋理论等相关内容。"},"extensions":{"label":"还能延伸做什么内容","summary":"可延伸制作关于安全感来源的心理学解释、实际案例或练习方法等内容。"}},"source_labels":["封面标题","文字标题","作品描述","图片 OCR","公开互动数据"]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1440", "cover": "http://sns-webpic-qc.xhscdn.com/202608261654/85fe15cd6c0563e7c982e8a4665b3194/1040g0083236v77hfnk4g5ndnf0ig92c7o7vtp7g!nd_dft_wlteh_webp_3", "taskId": "da567dacc677", "topics": ["女性智慧", "女性成长", "心理学", "情感"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5db778250000000001008987", "name": "谢小树", "followers": 183814}, "aiModel": "deepseek-v4-flash", "duration": null, "platform": "xiaohongshu", "coverFrom": "url", "mainTopic": "内容围绕亲密关系中'不怕失去的底层安全感'这一主题展开，探讨其来源。", "mediaType": "image_post", "coverLocal": true, "engagement": {"likes": "624", "collects": "470", "comments": "15", "likesNum": 624, "collectsNum": 470, "commentsNum": 15}, "imageCount": 1, "imageFiles": [{"i": 0, "file": "cd8e355bc92bf26e3af4efeee6a4808f0dc67f35.webp", "from": "url"}], "topicCount": 4, "generatedAt": "2026-08-26T08:55:27.607439+00:00", "aiVideoCount": 7, "commentsShown": 0, "hasTranscript": false, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": 15, "transcriptChars": 0}	2026-08-26 08:56:23.851615+00	8e3fb5e014fedcda1c8f92409596094ebe6f8d54.webp
225	e03b0ba25d3d	xiaohongshu	16	{"schema_version":16,"task_id":"e03b0ba25d3d","collected_at":"2026-08-29T03:23:21+00:00","manual_refresh":false,"source_url":"https://www.xiaohongshu.com/discovery/item/6a86ad460000000025007d54?source=webshare&xhsshare=pc_web&xsec_token=ABZMGYc6rcbXT7BMFRuYRhqdgPgB1W4BJJexKYHFt3_hQ=&xsec_source=pc_share","platform":"xiaohongshu","collection_mode":"analyze","collection_mode_label":"采集分析","session_mode":"public","session_mode_label":"公开无登录","storage":{"policy":"source_linked","local_media_retained":true,"temporary_media_deleted":false},"media_type":"image_post","media_assets":{"video":{}},"title":"本J人被自己画的重庆地图满意到睡不着了","description":"熬夜整理出来的重庆4天3晚游玩地图，J人属性彻底爆发！直接把重庆划分为4大区域，不走回头路，拿着这份攻略就能轻松玩转山城！ 📍Part 1 渝中经典线 解放碑 ➡️ 山城步道 ➡️ 十八梯 ➡️ 湖广会馆 ➡️ 白象居 ➡️ 洪崖洞 ➡️ 千厮门大桥 一条线打卡完渝中半岛的核心地标，感受老重庆的爬坡上坎与璀璨夜景。 📍Part 2 南岸江景线 两江小渡 ➡️ 弹子石老街 ➡️ 下浩里 ➡️ 龙门浩 ➡️ 开埠遗址公园 ➡️ 长江索道 ➡️ 南滨路 沿着长江一路漫步，看绝美日落与两江交汇，夜景氛围感直接拉满。 📍Part 3 潮流人文线 鹅岭二厂 ➡️ 鹅岭公园 ➡️ 李子坝 ➡️ 人民大礼堂 ➡️ 三峡博物馆 ➡️ 北仓文创园 ➡️ 观音桥 文创园区与魔幻轻轨结合，感受山城的文艺与潮流繁华。 📍Part 4 沙坪坝文化线 重庆动物园 ➡️ 磁器口 ➡️ 马房湾七彩巷 ➡️ 渣滓洞 ➡️ 白公馆 ➡️ 罗中立美术馆 ➡️ 工业博物馆 看大熊猫四喜丸子，逛千年古镇与红色旧址，艺术感与历史感兼具。 🍲 美食打卡必吃清单 1️⃣ 洞洞隐火锅地下防空洞店：防空洞里吃火锅，必吃重庆地标解放碑洪崖洞慕斯蛋糕和所有甜品免费吃！ 2️⃣ 零贰山江景自助老火锅：看两江夜景吃火锅，性价比绝了。 3️⃣ 地道壹号防空洞火锅：地道牛油浓香，重庆老味道。 4️⃣ 食济良重庆特产店：重庆特产知名品牌，都是批发价，带伴手礼去这一个地方就够了。 5️⃣ 花市碗杂面：豌豆软糯，杂酱香浓，本地人从小吃到大。","cover_title":"","cover_title_meta":{},"post_title":"本J人被自己画的重庆地图满意到睡不着了","post_description":"熬夜整理出来的重庆4天3晚游玩地图，J人属性彻底爆发！直接把重庆划分为4大区域，不走回头路，拿着这份攻略就能轻松玩转山城！ 📍Part 1 渝中经典线 解放碑 ➡️ 山城步道 ➡️ 十八梯 ➡️ 湖广会馆 ➡️ 白象居 ➡️ 洪崖洞 ➡️ 千厮门大桥 一条线打卡完渝中半岛的核心地标，感受老重庆的爬坡上坎与璀璨夜景。 📍Part 2 南岸江景线 两江小渡 ➡️ 弹子石老街 ➡️ 下浩里 ➡️ 龙门浩 ➡️ 开埠遗址公园 ➡️ 长江索道 ➡️ 南滨路 沿着长江一路漫步，看绝美日落与两江交汇，夜景氛围感直接拉满。 📍Part 3 潮流人文线 鹅岭二厂 ➡️ 鹅岭公园 ➡️ 李子坝 ➡️ 人民大礼堂 ➡️ 三峡博物馆 ➡️ 北仓文创园 ➡️ 观音桥 文创园区与魔幻轻轨结合，感受山城的文艺与潮流繁华。 📍Part 4 沙坪坝文化线 重庆动物园 ➡️ 磁器口 ➡️ 马房湾七彩巷 ➡️ 渣滓洞 ➡️ 白公馆 ➡️ 罗中立美术馆 ➡️ 工业博物馆 看大熊猫四喜丸子，逛千年古镇与红色旧址，艺术感与历史感兼具。 🍲 美食打卡必吃清单 1️⃣ 洞洞隐火锅地下防空洞店：防空洞里吃火锅，必吃重庆地标解放碑洪崖洞慕斯蛋糕和所有甜品免费吃！ 2️⃣ 零贰山江景自助老火锅：看两江夜景吃火锅，性价比绝了。 3️⃣ 地道壹号防空洞火锅：地道牛油浓香，重庆老味道。 4️⃣ 食济良重庆特产店：重庆特产知名品牌，都是批发价，带伴手礼去这一个地方就够了。 5️⃣ 花市碗杂面：豌豆软糯，杂酱香浓，本地人从小吃到大。","display_title":"本J人被自己画的重庆地图满意到睡不着了","author":"小野茶茶","account":{"name":"小野茶茶","profile_url":"https://www.xiaohongshu.com/user/profile/5fcde30f0000000001008df1","bio":"","following_count":"10+","follower_count":"10+","likes_and_collections_count":"1千+"},"collection_status":{"media":{"status":"ok","method":"page_image_download","message":"已保存 8 张正文图片","discovered":9,"downloaded":8,"failed":0,"rejected_payload":0,"rejected_dimensions":1},"account":{"status":"ok","missing_fields":[],"message":"账号数据已同步"}},"page_text":"发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 更多 关于我们 © 2014-2026 行吟信息科技（上海）有限公司 地址：上海市黄浦区马当路388号C座 电话：9501-3888 小野茶茶 关注 可能含AI生成内容 1/7 小野茶茶 关注 本J人被自己画的重庆地图满意到睡不着了 熬夜整理出来的重庆4天3晚游玩地图，J人属性彻底爆发！直接把重庆划分为4大区域，不走回头路，拿着这份攻略就能轻松玩转山城！ 📍Part 1 渝中经典线 解放碑 ➡️ 山城步道 ➡️ 十八梯 ➡️ 湖广会馆 ➡️ 白象居 ➡️ 洪崖洞 ➡️ 千厮门大桥 一条线打卡完渝中半岛的核心地标，感受老重庆的爬坡上坎与璀璨夜景。 📍Part 2 南岸江景线 两江小渡 ➡️ 弹子石老街 ➡️ 下浩里 ➡️ 龙门浩 ➡️ 开埠遗址公园 ➡️ 长江索道 ➡️ 南滨路 沿着长江一路漫步，看绝美日落与两江交汇，夜景氛围感直接拉满。 📍Part 3 潮流人文线 鹅岭二厂 ➡️ 鹅岭公园 ➡️ 李子坝 ➡️ 人民大礼堂 ➡️ 三峡博物馆 ➡️ 北仓文创园 ➡️ 观音桥 文创园区与魔幻轻轨结合，感受山城的文艺与潮流繁华。 📍Part 4 沙坪坝文化线 重庆动物园 ➡️ 磁器口 ➡️ 马房湾七彩巷 ➡️ 渣滓洞 ➡️ 白公馆 ➡️ 罗中立美术馆 ➡️ 工业博物馆 看大熊猫四喜丸子，逛千年古镇与红色旧址，艺术感与历史感兼具。 🍲 美食打卡必吃清单 1️⃣ 洞洞隐火锅地下防空洞店：防空洞里吃火锅，必吃重庆地标解放碑洪崖洞慕斯蛋糕和所有甜品免费吃！ 2️⃣ 零贰山江景自助老火锅：看两江夜景吃火锅，性价比绝了。 3️⃣ 地道壹号防空洞火锅：地道牛油浓香，重庆老味道。 4️⃣ 食济良重庆特产店：重庆特产知名品牌，都是批发价，带伴手礼去这一个地方就够了。 5️⃣ 花市碗杂面：豌豆软糯，杂酱香浓，本地人从小吃到大。 #美食SOP指南 #这才是重庆 #重庆 #重庆旅游 #重庆打卡 #重庆美食 #重庆攻略 #重庆火锅 #重庆特产 #本地人做的攻略 08-20 重庆 加载中","text_same_as_description":true,"engagement":{"likes":"611","collects":"703","comments":"37"},"topics":["美食SOP指南","这才是重庆","重庆","重庆旅游","重庆打卡","重庆美食","重庆攻略","重庆火锅","重庆特产","本地人做的攻略"],"video_text":"","video_text_meta":{},"audio_text":"","comments":[],"comment_summary":{"threshold":20,"limit":5,"returned":0,"scanned":14,"replies_scanned":4,"primary_pages":1,"reply_pages":0,"scope":"bounded_platform_hot_stream","truncated":true,"status":"limited","likes_obscured":true,"obscured_count":1,"confidence":0.161,"confidence_target":0.8,"strategy":"adaptive_hot_stream","session_evidence":"public_mode","confidence_reached":false,"stable_pages":0},"images":[{"index":1,"filename":"image_01.webp","text":"重庆可以分为四个板块 嘉陵江 Part2 观音桥 Part3 两江小渡 北仓文创园 弹子石老街 Part1 “小天坛 千厮门大桥 重庆人民大礼堂 下浩里 洪崖洞 三峡博物馆 龙门浩 解放碑 李子坝 湖广会馆 山城步道 老重庆风貌 长江索道 十八梯 鹅岭二厂 南滨路 Part4 磁器口 马房湾七彩巷 重庆动物园 注意：此地图 渣洞 只为路线标注， 白公馆 与实际地图 有差异","width":1080,"height":1440,"size_bytes":650648,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/b041374e7409a06ed406353dd4b76dd6/notes_pre_post/1040g3k032436qbr0gs0g5nudsc7g93fhd7h5t8o!nd_dft_wlteh_webp_3"},{"index":2,"filename":"image_02.webp","text":"重庆旅游Day1 千厮门大桥 山城记 拍摄洪崖洞全景 最佳机位， 山城重庆 解放碑 8D魔幻之旅 轻松拍出夜景大片。 步行6分钟 就从这一天开始! 重庆城市图腾与地标， 抗战历史纪念， 富有打卡意义。 洪崖洞 梦幻吊脚楼， 步行15分钟 夜晚亮灯极其惊艳， 如同千与千寻。 山城步道 临崖建造的步道， 车程10分钟 浓缩山城精髓， 体验爬坡上坎。 白象居 渝中半岛 二十四层无电梯老楼 步行10分钟 展现魔幻建筑与江景 十八梯 老重庆建筑风格 车程10分钟 台阶漫步非常意， 步行20分钟 拍照出片。 湖广会馆 康熙年间古建筑， 小贴士 明清活化石， 历史氛围浓厚。 ·步行为主，穿舒适鞋子 ·夜景更美，记得带相机 ·美食推荐：火锅，小面、酸辣粉","width":1080,"height":1440,"size_bytes":579232,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/5cd4b0c921813744569e3d9d57b22c16/notes_pre_post/1040g3k032436qbr0gs105nudsc7g93fhfm3stv0!nd_dft_wlteh_webp_3"},{"index":3,"filename":"image_03.webp","text":"重庆旅游Day2 1.两江小渡 2.弹子石老街 性价比高的小渡轮， 日落时分极具氛围感 百年开埠遗址， 建筑中西合壁， 轮渡15分钟 夜市热闹 轻轨26分钟 3.下浩里 嘉陵江 巴渝吊脚楼风格， 长江 烟火气十足， 适合citywalk 步行10分钟 5.重庆开埠遗址公园 4.龙门浩老街 立体的山城公园 百年老街区， 俯瞰两江交汇 民国建筑风貌 壮丽景色 拍大桥绝佳 轻轨18分钟 打车8分钟 6.长江索道 7.南滨路 老式飞车交通 沿江漫步观赏江景 飞跃长江， 将渝中半岛夜景 步行15分钟 建议南站乘坐 尽收眼底","width":1080,"height":1440,"size_bytes":515780,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/0e284c9cb6350e3a6674ad132d2e204a/notes_pre_post/1040g3k032436qbr0gs1g5nudsc7g93fh0afcr60!nd_dft_wlteh_webp_3"},{"index":4,"filename":"image_04.webp","text":"江北区 重庆旅游Day3 7.观音桥：潮流商圈, 标志性大屏与好吃街， 7.观音桥 夜生活丰富。 步行10分钟 6.北仓文创园：文艺青年 6.北仓文创园 聚集地，咖啡手作店云集， 渝中区 适合i人。 步行17分钟 嘉陵江 5.三峡博物馆：国家 5.三峡博物馆 一级博物馆，馆藏丰富 且可免费盖章。 步行3分钟 九龙坡区 4.人民大礼堂：中式 4.人民大礼堂 琉璃瓦复古地标，经典 3.李子坝：轻轨穿楼 城市名片。 地铁25分钟 名场面，体验口吞轻轨 奇观。 南岸区 3.李子坝 步行16分钟 1.鹅岭二厂 2. 鹅岭公园：渝中半岛 1.鹅岭二厂： 制高点，揽胜楼俯瞰 工业风文创园, 全城夜景。 拍照非常有杂感 大片范。 大渡口区 巴南区","width":1080,"height":1440,"size_bytes":487050,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/2e18b1e94deb031260f2cfff01d42393/notes_pre_post/1040g3k032436qbr0gs205nudsc7g93fhuec1v1o!nd_dft_wlteh_webp_3"},{"index":5,"filename":"image_05.webp","text":"重庆旅游Day4 歌乐山 5.白公馆 军阀别墅改编， 红岩历史， 4.渣洞 山城重庆 小萝卜头关押处; 魅力无限! 渣洞 歌乐山红色旧址， 还原牢房， 打车10分钟 缅怀革命先烈; 3.马房湾七彩巷 6.罗中立美术馆 彩色涂鸦街区， 打车14分钟 拍照出片， 炫彩涂鸦外墙 追星女孩必去; 艺术氛围浓厚， 打卡圣地; 渝中区 沙坪坝 2.磁器口 南岸区 打车18分钟 千年古镇， 青石板路与 7.重庆工业博物馆 古镇火锅， 烟火气拉满； 工业遗产基地， 轻轨25分钟 钢铁蒸汽朋克 风格大片； 打车20分钟 1.重庆动物园 打车16分钟 门票超值， 熊猫数量多， ·小贴士 看四喜丸子 重庆动物园 带好身份证 重庆的美， 在山城的每一步! 打麻将； ·穿舒适鞋子 ·注意防晒补水 巴南区","width":1080,"height":1440,"size_bytes":572802,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/9e493f07014e76957245289fd0399f01/notes_pre_post/1040g3k032436qbr0gs2g5nudsc7g93fh54l1kfo!nd_dft_wlteh_webp_3"},{"index":6,"filename":"image_06.webp","text":"备忘录 重庆交通与住宿指南 、重庆交通指南 二、重庆住宿选择 解放碑附近：出行方便 飞机抵达 ①飞机抵达：江北国际机场 位于重庆市中心，小白选这里准没错， ②地铁：T3航站楼乘10号线 附近景点多而密集，去哪里都方便， 重庆北站 转6号线直达解放碑 美食种类也丰富 ③机场快线：K01直达解放碑 （15元／人，24小时运营） 沙坪坝附近：性价比高 观音桥 高铁/火车 临近大学城，所以夜市、小吃不用担心， ①重庆北站：在市区，去解放碑 性价比高，适合学生党/穷游党， 坐10号线转2号线 就是离景点有点远 解放碑 ②重庆西站：离市区较远，去 沙坪坝 解放碑坐5号线转1号线 观音桥附近：夜生活丰富 ③沙坪坝站：离市区较远，距 重庆著名的商圈，年轻人聚集地， 离市中心14km，去解放碑坐1 附近有九街、北仓文创街等，所以夜 号线到小什字站下 重庆西站 生活丰富，吃喝玩乐一应俱全，就是 睡眠浅的宝子住的楼层太低会觉得晚 地铁：首选！不堵车 上有点吵 主城热门景点基本覆盖，单程2-9R， 不堵车不绕路 南滨路附近：顶级江景 网约车/出租车 住在这边的主打就是一个风景好， 赶时间，人多可选，市区起步价9R左右， 这边有很多江景房，喜欢拍照的姐妹 避开解放碑/洪崖洞/南滨路早晚高峰 们可以冲，就是价格稍微有点高 公交：线路密 单程2R，适合体验老重庆，但报站不清晰 选酒店小TIPS：避坑避雷！ +部分线路绕路，新手慎选 别选解放碑核心区低价民宿，大多嘈杂、 共享电动车：慎骑！ 设施老旧，无电梯，订前多看真实住客评 重庆多弯多梯坎多，部分区域禁行， 价+实拍图 容易骑出运营区扣调度费，平少的 订江景房别只看宣传，避开“侧面江景”“伪 地方别试 江景” 交步行：核心区可步行 优先选地铁口5分钟内的住宿，山城爬坡 累，交通方便真的太重要了！ 更能感受山城烟火气","width":1080,"height":1440,"size_bytes":376992,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/ffc7308cdb9ddb22e298873e43c61b7e/notes_pre_post/1040g3k032436qbr0gs305nudsc7g93fhbhcdbm8!nd_dft_wlteh_webp_3"},{"index":7,"filename":"image_07.webp","text":"<备忘录 重庆美食打卡 洞洞隐火锅地下防空洞店 防空洞特色，必吃重庆地标解放碑洪崖洞慕斯蛋糕 和所有甜品免费吃☆ 零贰山江景自助老火锅 解放碑 看两江夜景吃火锅，性价比绝了！ 地道壹号防空洞火锅· 地道牛油浓香，重庆老味道！ 食济良重庆特产店· 洪崖洞 重庆特产知名品牌，都是批发价！ 花市碗杂面· 老字号小面，豌豆沙糯，杂酱鲜香！☆ 零贰山江景 洞洞隐火锅 自助老火锅 地下防空洞店 裤为吃货青年 3地道壹号 防空洞火锅 4食济良 重庆特产店 来重庆，吃得辣，玩得爽，才算不虚此行！","width":1080,"height":1440,"size_bytes":453060,"source_url":"https://sns-webpic-qc.xhscdn.com/202608291121/c0d1b2cf297bdc8801ab3bb4308584d5/notes_pre_post/1040g3k032436qbr0gs3g5nudsc7g93fh9dc7lc0!nd_dft_wlteh_webp_3"},{"index":8,"filename":"image_08.png","text":"小红书","width":600,"height":315,"size_bytes":4569,"source_url":"https://picasso-static.xiaohongshu.com/fe-platform/e6214e4fbfae2cf14d634d4296916e8a5eaefdf4.png"}],"ai_analysis":{"schema_version":1,"status":"unavailable","model":"gemini-3.6-flash","generated_at":"2026-08-29T03:23:21.909973+00:00","notice":"AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。","video":{"status":"unavailable","message":"AI 视频分析暂时不可用，请稍后重试","items":{},"source_labels":[]},"comments":{"status":"empty","message":"暂无评论，未生成评论需求分析。","sample_size":0,"items":{}}}}	{"size": "1080×1440", "cover": "https://sns-webpic-qc.xhscdn.com/202608291121/b041374e7409a06ed406353dd4b76dd6/notes_pre_post/1040g3k032436qbr0gs0g5nudsc7g93fhd7h5t8o!nd_dft_wlteh_webp_3", "taskId": "e03b0ba25d3d", "topics": ["美食SOP指南", "这才是重庆", "重庆", "重庆旅游", "重庆打卡", "重庆美食"], "account": {"url": "https://www.xiaohongshu.com/user/profile/5fcde30f0000000001008df1", "name": "小野茶茶", "followers": 10}, "aiModel": "gemini-3.6-flash", "duration": null, "platform": "xiaohongshu", "coverFrom": "url", "mainTopic": null, "mediaType": "image_post", "coverLocal": true, "engagement": {"likes": "611", "collects": "703", "comments": "37", "likesNum": 611, "collectsNum": 703, "commentsNum": 37}, "imageCount": 8, "imageFiles": [{"i": 0, "file": "a3f71f267cca352776f396dc05e7bc2e73ef5a39.webp", "from": "url"}, {"i": 1, "file": "5aff3d8871ec338cbe6075df1fa2c70997f0ec03.webp", "from": "url"}, {"i": 2, "file": "70838a5b3ec9646768f9d23df1aa1d5511434b03.webp", "from": "url"}, {"i": 3, "file": "2e5adf4393b67f7ba527c4ef31a7f09de99d151f.webp", "from": "url"}, {"i": 4, "file": "08b389d0b26a067851e5300bdea36ead7d3c3fd4.webp", "from": "url"}, {"i": 5, "file": "e052d221e3e7c46ceaf6eeefe4f9df384c4cc170.webp", "from": "url"}, {"i": 6, "file": "72090aef66845a7ffa27dc3f7e449f7563ce5ac0.webp", "from": "url"}, {"i": 7, "file": "27a5001d0e0d48c50a4ddaaa29557060744fa930.png", "from": "url"}], "topicCount": 10, "generatedAt": "2026-08-29T03:23:21.909973+00:00", "aiVideoCount": 0, "commentsShown": 0, "hasTranscript": false, "platformLabel": "小红书", "aiCommentCount": 0, "commentsScanned": 14, "transcriptChars": 0}	2026-08-29 03:25:22.062488+00	eb649e7f10e6ad0a0a97eda238f958ca5eaa4015.webp
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
24	7	4	2026-08-25	图文	图文	依托答辩	2026-08-26 03:03:23.30422+00	4	2026-08-25 10:01:38.47731+00	2026-08-26 03:03:23.30422+00	\N	\N	\N
26	1	\N	2026-08-26	测试	\N	\N	\N	\N	2026-08-26 15:02:01.097756+00	2026-08-26 15:02:01.097756+00	\N	\N	\N
23	10	4	2026-08-25	表格	\N	1	2026-08-28 06:39:12.421778+00	4	2026-08-25 09:28:31.947848+00	2026-08-28 06:39:12.421778+00	\N	\N	\N
22	10	4	2026-08-25	作品	标题：0-3岁没有被满足的安全感，会影响90%的亲密关系\n文案：有些女性并不是没有感情，而是不习惯面对和表达自己的恐惧、委屈、孤独、羞耻与愤怒。\n她可能关心伴侣的工作、生活和安排，却很少主动谈论彼此的感受。面对情绪时，她常说：\n“没事。”\n“别想太多。”\n“我自己消化一下就好。”\n“我也不知道自己怎么了。”\n这不一定代表冷漠，更可能是她长期习惯了压低、切断或隐藏情绪。\n常见表现\n- 很难说清自己真实的感受\n- 难过时习惯独自消化，不愿求助\n- 表达需求时感到羞耻，担心给别人添麻烦\n- 能处理现实问题，却不知道如何面对情绪\n- 被关心、安慰或拥抱时，反而僵硬、尴尬或想逃\n- 讲事情很清楚，却很少谈自己的感受\n- 发生冲突后沉默、转移话题或暂时退出关系\n在亲密关系中的复现\n她可能渴望被理解，却不知道怎样直接表达需要；期待伴侣主动看懂自己，但当对方真正靠近时，又会感到不自在。\n她也可能更容易被情绪不可得的人吸引，因为冷淡是熟悉的，而持续、稳定的温柔反而让她无所适从。\n关系中的核心矛盾是：\n渴望被看见，却不知道如何让别人看见；渴望靠近，又害怕靠近后的脆弱。\n如何判断是不是情感回避？\n不要因为一次沉默、冷淡或争吵就下结论，而要观察这种模式是否：\n- 在亲密关系中长期存在\n- 面对情绪和冲突时反复出现\n- 伴随僵硬、逃避、麻木或强颜欢笑等反应\n- 已经影响需求表达、接受安慰和建立亲密连接的能力\n可以试着观察：\n- 她难过时，会不会允许伴侣听她说完？\n- 发生冲突后，她是表达感受，还是立刻关闭自己？\n- 被关心时，她感到安心，还是尴尬、警惕甚至想逃？\n- 她能否直接说出“我需要你陪我”或“这件事让我受伤”？\n情感回避不等于她不爱，也不能仅凭几个表现给一个人贴标签。\n它更可能意味着：她有感受，也渴望连接，只是还没有学会识别、表达和接住自己的情绪。\n看见这种模式，不是为了责怪谁，而是为了让关系有机会从回避走向理解。	1	2026-08-28 06:39:22.497575+00	4	2026-08-25 09:27:41.47813+00	2026-08-28 06:39:22.497575+00	\N	\N	\N
\.


--
-- Data for Name: works; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.works (id, channel, side, account_id, title, url, pillar, published_at, metrics, note, created_by, created_at, updated_at, source_type, source_url, source_ref, deleted_at, sample_id) FROM stdin;
1	persona	own	1	男人有没有责任心，看这 4 个行为	\N	A 强判断内容	2026-08-18	{"完播": 12600, "收藏": 3100, "曝光": 42000, "私信": 210, "主页访问": 1850}	先给结论，再解释机制。目标：建立「判断力」标签。	\N	2026-08-21 04:19:32.273572+00	2026-08-21 04:19:32.273572+00	manual	\N	\N	\N	\N
2	persona	own	1	朋友圈能看出一个人的依附类型吗	\N	B 识人内容	2026-08-15	{"完播": 9200, "收藏": 2400, "曝光": 28000, "私信": 145, "主页访问": 1230}	朋友圈、语言、关系姿态、依附性、攻击性等可观察信息与交叉验证。目标：形成差异化方法论。	\N	2026-08-21 04:19:32.277819+00	2026-08-21 04:19:32.277819+00	manual	\N	\N	\N	\N
3	persona	own	1	暧昧三个月突然变冷，问题出在哪一步	\N	C 案例拆解	2026-08-12	{"完播": 21000, "收藏": 5800, "曝光": 63000, "私信": 380, "主页访问": 2900}	信息 → 假设 → 验证 → 判断，展示推理链而不是只给观点。目标：证明诊断能力。	\N	2026-08-21 04:19:32.279059+00	2026-08-21 04:19:32.279059+00	manual	\N	\N	\N	\N
4	persona	own	1	我们怎么做一次完整的关系诊断	\N	D 方法论内容	2026-08-09	{"完播": 11800, "收藏": 4200, "曝光": 35000, "私信": 265, "主页访问": 2020}	基础信息 → 时间线 → 关键事件 → 行为模式 → 策略。目标：为成交做预教育。	\N	2026-08-21 04:19:32.280112+00	2026-08-21 04:19:32.280112+00	manual	\N	\N	\N	\N
6	matrix	own	4	他为什么总是秒回却从不主动约我	\N	高频问题	2026-08-03	{"完播": 4100, "收藏": 620, "曝光": 8600, "私信": 96, "主页访问": 540}	PDF 02 矩阵内容特征。关键结果：持续获得低成本线索	\N	2026-08-21 04:19:32.282372+00	2026-08-21 04:19:32.282372+00	manual	\N	\N	\N	\N
7	matrix	own	4	等一个不确定的人，最耗人的是什么	\N	情绪痛点	2026-07-31	{"完播": 5900, "收藏": 880, "曝光": 12400, "私信": 132, "主页访问": 710}	PDF 02 矩阵内容特征。关键结果：持续获得低成本线索	\N	2026-08-21 04:19:32.283897+00	2026-08-21 04:19:32.283897+00	manual	\N	\N	\N	\N
8	matrix	own	4	男人说「我最近很忙」的时候在想什么	\N	男女差异	2026-07-28	{"完播": 2800, "收藏": 410, "曝光": 6200, "私信": 68, "主页访问": 380}	PDF 02 矩阵内容特征。关键结果：持续获得低成本线索	\N	2026-08-21 04:19:32.284861+00	2026-08-21 04:19:32.284861+00	manual	\N	\N	\N	\N
9	matrix	own	4	第一次见面就该注意的 3 个信号	\N	识人信号	2026-07-25	{"完播": 4600, "收藏": 730, "曝光": 9800, "私信": 104, "主页访问": 590}	PDF 02 矩阵内容特征。关键结果：持续获得低成本线索	\N	2026-08-21 04:19:32.2859+00	2026-08-21 04:19:32.2859+00	manual	\N	\N	\N	\N
11	live	own	7	长短择、识人、关系推进、优质男筛选（建议 20–30 分钟）	\N	主题干货	2026-07-19	{"私信": 42, "预约": 5, "连麦数": 0, "停留分钟": 6, "在线峰值": 340}	用户感受「有认知差」，转化作用：拉新与停留。	\N	2026-08-21 04:19:32.287888+00	2026-08-21 04:19:32.287888+00	manual	\N	\N	\N	\N
12	live	own	7	用真实或脱敏案例走完整推理链（建议 20–30 分钟）	\N	案例拆解	2026-07-16	{"私信": 88, "预约": 14, "连麦数": 0, "停留分钟": 11, "在线峰值": 520}	用户感受「确实会分析」，转化作用：建立专业信任。	\N	2026-08-21 04:19:32.289356+00	2026-08-21 04:19:32.289356+00	manual	\N	\N	\N	\N
13	live	own	7	信息收集 → 判断 → 验证 → 策略方向（核心时段）	\N	连麦诊断	2026-07-13	{"私信": 156, "预约": 31, "连麦数": 7, "停留分钟": 19, "在线峰值": 610}	连麦四组信息：①基础关系 ②关键事件 ③投入与现实推进 ④男方特征。用户感受「我的问题也能被拆清楚」，强成交。	\N	2026-08-21 04:19:32.290838+00	2026-08-21 04:19:32.290838+00	manual	\N	\N	\N	\N
14	live	benchmark	8	（待填）对标直播间回放	\N	连麦诊断	2026-07-10	{"私信": 0, "预约": 0, "连麦数": 0, "停留分钟": 0, "在线峰值": 0}	重点看：连麦提问顺序、成交话术、怎么引导私信/预约	\N	2026-08-21 04:19:32.292124+00	2026-08-21 04:19:32.292124+00	manual	\N	\N	\N	\N
173	persona	own	\N	智能导入全路径自测-1787555517124-作品			\N	{}	测试	1	2026-08-24 07:11:57.1553+00	2026-08-24 07:11:57.1553+00	manual		smart:615027849b8c2336e311:2	2026-08-24 07:11:57.259162+00	\N
5	persona	benchmark	2	（待填）把对标账号的爆款链接贴进来	\N	A 强判断内容	2026-08-06	{"完播": 0, "收藏": 0, "曝光": 0, "私信": 0, "主页访问": 0}	PDF 00 流量系统：选题库 / 爆款库 / 脚本库 —— 对标作品是爆款库的来源	\N	2026-08-21 04:19:32.281111+00	2026-08-21 04:19:32.281111+00	manual	\N	\N	2026-08-25 09:23:20.301351+00	\N
10	matrix	benchmark	6	（待填）对标矩阵号的高播放作品	\N	高频问题	2026-07-22	{"完播": 0, "收藏": 0, "曝光": 0, "私信": 0, "主页访问": 0}	对标理由：选题密度高，可直接进选题库	\N	2026-08-21 04:19:32.287042+00	2026-08-21 04:19:32.287042+00	manual	\N	\N	2026-08-25 14:46:41.232482+00	\N
222	persona	benchmark	\N	图文	11 【很多人对“主体性”概念的理解其实是错的 - 沈奕斐博士 | 小红书 - 你的生活兴趣社区】 😆 fdfFxj03THR1LOC 😆 https://www.xiaohongshu.com/discovery/item/6a746acf00000000260340a6?source=webshare&xhsshare=pc_web&xsec_token=AB8FHrvix3daUnZRyIEVy_gXL8lmoKTq7kZjK-Aq8xLYw=&xsec_source=pc_share	\N	2026-08-28	{"完播": 0, "收藏": 0, "曝光": 0, "私信": 0, "主页访问": 0}	\N	4	2026-08-28 06:45:02.620364+00	2026-08-28 06:45:02.620364+00	manual	\N	\N	\N	\N
223	persona	benchmark	\N	图文	33 【真正的强者敢于薅头发 - 谢胜子 | 小红书 - 你的生活兴趣社区】 😆 ELGSlc5J4roM0Y1 😆 https://www.xiaohongshu.com/discovery/item/6a8c184500000000160214bd?source=webshare&xhsshare=pc_web&xsec_token=ABg7xcxPcGQA5ZS9viuh5gpfsVFz6oBbhaNYUl0PV7HJI=&xsec_source=pc_share	\N	2026-08-28	{"完播": 0, "收藏": 0, "曝光": 0, "私信": 0, "主页访问": 0}	\N	4	2026-08-28 06:46:58.849495+00	2026-08-28 06:46:58.849495+00	manual	\N	\N	\N	\N
210	persona	benchmark	20	双视角曝光，大家看看我有念稿感吗	https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share	\N	\N	{"收藏": 205, "点赞": 161, "评论": 7}	这条视频主要讲如何通过两个训练方法去除视频拍摄中的念稿感，提升表达的自然度。	\N	2026-08-26 01:41:17.904798+00	2026-08-26 02:41:06.946254+00	tech1	https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share	t1:d2f5523e8cea:persona	\N	3
181	persona	benchmark	9	女孩子无聊的本质是生命力的匮乏	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	\N	\N	{"收藏": 32000, "点赞": 40000, "评论": 647}	分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。	\N	2026-08-25 07:04:07.118378+00	2026-08-25 07:04:07.118378+00	tech1	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	t1:ZZTEST0825:persona	2026-08-25 07:10:02.566912+00	\N
182	matrix	benchmark	10	女孩子无聊的本质是生命力的匮乏	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	\N	\N	{"收藏": 32000, "点赞": 40000, "评论": 647}	分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。	\N	2026-08-25 07:04:07.182037+00	2026-08-25 07:04:07.182037+00	tech1	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	t1:ZZTEST0825:matrix	2026-08-25 07:10:02.607002+00	\N
174	persona	benchmark	9	女孩子无聊的本质是生命力的匮乏	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	\N	\N	{"收藏": 32000, "点赞": 40000, "评论": 648}	分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。	\N	2026-08-25 06:36:40.164413+00	2026-08-25 09:20:56.490278+00	tech1	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	t1:f90d29b0a27b:persona	2026-08-25 09:22:22.085164+00	\N
184	matrix	benchmark	12	顶级吸引力就是无所谓	https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?source=webshare&xhsshare=pc_web&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&xsec_source=pc_share	\N	\N	{"收藏": 922, "点赞": 1399, "评论": 37}	以《道德经》为据，阐述顶级吸引力源于淡定、无为和不执着的智慧，而非刻意展示魅力。	\N	2026-08-25 07:15:31.145945+00	2026-08-26 02:42:00.352867+00	tech1	https://www.xiaohongshu.com/discovery/item/6a806dfa000000002501477a?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB2fjokyIR4i7puOhvUJD0Ih44BttAzGs14MVtSKpkgVg=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787555967&share_id=fab821cb47f44fdc8809fac52b9572c5	t1:45ecbd25bd1f:matrix	\N	1
176	matrix	benchmark	10	女孩子无聊的本质是生命力的匮乏	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	\N	\N	{"收藏": 32000, "点赞": 40000, "评论": 648}	分析女性感到无趣、生活平淡的深层原因，提出是内在生命力匮乏而非性格或社交技巧问题，并给出恢复生命力的方法。	\N	2026-08-25 06:36:49.417507+00	2026-08-25 09:21:00.094163+00	tech1	https://www.xiaohongshu.com/discovery/item/6a755421000000002c0019e4?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CB0RgZFfPxrma9jCLOAVaOdEWXV8QfXUBC8Mt_UBmF9ow=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556025&share_id=138f6272491e47faa5b66b454dfd55d1	t1:f90d29b0a27b:matrix	2026-08-25 15:13:17.268853+00	\N
195	matrix	benchmark	16	看完痴迷，发现最恐怖的是无色无味老实人？	https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13	\N	\N	{"收藏": 349, "点赞": 784, "评论": 75}	这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。	\N	2026-08-25 09:20:49.338864+00	2026-08-25 09:20:49.338864+00	tech1	https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13	t1:b36f1b924b66:matrix	2026-08-26 02:41:42.907479+00	\N
196	persona	benchmark	17	看完痴迷，发现最恐怖的是无色无味老实人？	https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13	\N	\N	{"收藏": 349, "点赞": 784, "评论": 75}	这条内容主要围绕电影《痴迷》展开，从恐怖片爱好者的视角介绍剧情，并重点解读电影中体现的“脆弱型自恋者”这一心理学概念，探讨亲密关系中的极端自我中心。	\N	2026-08-25 09:20:51.915968+00	2026-08-25 10:01:50.273723+00	tech1	https://www.xiaohongshu.com/discovery/item/6a6f4013000000000502a398?app_platform=ios&app_version=9.33.4&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBsegcjH4Dj_qiNZB4uWzhLSfA--q0sRKzNvDNnbBhupI=&author_share=1&xhsshare=CopyLink&shareRedId=OD06MEg5NUA2NzUyOTgwNjY7OThHN0xN&apptime=1787556009&share_id=920668128265437b8468183819baea13	t1:b36f1b924b66:persona	\N	2
212	matrix	benchmark	21	借力高级心法	https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?source=webshare&xhsshare=pc_web&xsec_token=CBscI7y1gpeKhCHBWx4bfUg27s_Z2SodspTbBoMYTNOmc=&xsec_source=pc_share	\N	\N	{"收藏": 2204, "点赞": 3814, "评论": 111}	内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。	\N	2026-08-26 01:43:18.241379+00	2026-08-26 02:41:56.335911+00	tech1	https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?source=webshare&xhsshare=pc_web&xsec_token=CBscI7y1gpeKhCHBWx4bfUg27s_Z2SodspTbBoMYTNOmc=&xsec_source=pc_share	t1:3cd91f3b313c:matrix	\N	4
213	matrix	benchmark	14	NPD有一个藏不住的语言习惯	https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share	\N	\N	{"收藏": 951, "点赞": 1295, "评论": 286}	这条内容主要讲解如何通过语言习惯识别自恋型人格障碍（NPD），指出NPD倾向于使用预设答案的质问方式而非开放式关心。	\N	2026-08-26 01:47:15.274886+00	2026-08-26 02:42:03.263463+00	tech1	https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share	t1:9268a700b2c3:matrix	\N	5
214	persona	benchmark	18	NPD有一个藏不住的语言习惯	https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share	\N	\N	{"收藏": 951, "点赞": 1295, "评论": 286}	这条内容主要讲如何通过语言习惯识别自恋型人格障碍（NPD），并对比正常人与NPD在提问方式上的差异。	\N	2026-08-26 02:41:01.794109+00	2026-08-26 02:41:01.794109+00	tech1	https://www.xiaohongshu.com/discovery/item/6a6e0eb80000000005031f6f?source=webshare&xhsshare=pc_web&xsec_token=CB94dbalNwFR99_6YR4Sl4_GP0DZbavhasHc4q3C3kj4g=&xsec_source=pc_share	t1:9268a700b2c3:persona	\N	5
215	persona	benchmark	22	借力高级心法	https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?source=webshare&xhsshare=pc_web&xsec_token=CBscI7y1gpeKhCHBWx4bfUg27s_Z2SodspTbBoMYTNOmc=&xsec_source=pc_share	\N	\N	{"收藏": 2204, "点赞": 3814, "评论": 111}	内容围绕'不会借力'这一行为展开，将其定义为一种隐蔽的自恋和懒惰，并探讨借力的高级心法，强调借力是调动资源而非示弱。	\N	2026-08-26 02:41:04.712529+00	2026-08-26 02:41:04.712529+00	tech1	https://www.xiaohongshu.com/discovery/item/6a65d3eb0000000011016998?source=webshare&xhsshare=pc_web&xsec_token=CBscI7y1gpeKhCHBWx4bfUg27s_Z2SodspTbBoMYTNOmc=&xsec_source=pc_share	t1:3cd91f3b313c:persona	\N	4
218	matrix	benchmark	23	双视角曝光，大家看看我有念稿感吗	https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share	\N	\N	{"收藏": 205, "点赞": 161, "评论": 7}	这条视频主要讲如何通过两个训练方法去除视频拍摄中的念稿感，提升表达的自然度。	\N	2026-08-26 02:41:58.496671+00	2026-08-26 02:41:58.496671+00	tech1	https://www.xiaohongshu.com/discovery/item/6a8d06aa000000000f01f94b?source=webshare&xhsshare=pc_web&xsec_token=AB4ooOlAU6DVGQdYtgNJSEXoLqm7AAJIhkCkGCxOvNQ1A=&xsec_source=pc_share	t1:d2f5523e8cea:matrix	\N	3
221	persona	benchmark	24	不怕失去的底层安全感，怎么来的？	https://www.xiaohongshu.com/discovery/item/6a69c47400000000050380df?source=webshare&xhsshare=pc_web&xsec_token=ABKHtbzSs3-U4KMlmja0MixJhn5Yfq0tyD9E1GvM0NLB0=&xsec_source=pc_share	\N	\N	{"收藏": 470, "点赞": 624, "评论": 15}	内容围绕亲密关系中'不怕失去的底层安全感'这一主题展开，探讨其来源。	\N	2026-08-26 08:56:23.851615+00	2026-08-26 08:56:23.851615+00	tech1	https://www.xiaohongshu.com/discovery/item/6a69c47400000000050380df?source=webshare&xhsshare=pc_web&xsec_token=ABKHtbzSs3-U4KMlmja0MixJhn5Yfq0tyD9E1GvM0NLB0=&xsec_source=pc_share	t1:da567dacc677:persona	\N	9
225	matrix	benchmark	26	本J人被自己画的重庆地图满意到睡不着了	https://www.xiaohongshu.com/discovery/item/6a86ad460000000025007d54?source=webshare&xhsshare=pc_web&xsec_token=ABZMGYc6rcbXT7BMFRuYRhqdgPgB1W4BJJexKYHFt3_hQ=&xsec_source=pc_share	\N	\N	{"收藏": 703, "点赞": 611, "评论": 37}	\N	\N	2026-08-29 03:25:22.062488+00	2026-08-29 03:25:22.062488+00	tech1	https://www.xiaohongshu.com/discovery/item/6a86ad460000000025007d54?source=webshare&xhsshare=pc_web&xsec_token=ABZMGYc6rcbXT7BMFRuYRhqdgPgB1W4BJJexKYHFt3_hQ=&xsec_source=pc_share	t1:e03b0ba25d3d:matrix	\N	10
\.


--
-- Name: api_keys_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.api_keys_id_seq', 22, true);


--
-- Name: attachments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.attachments_id_seq', 74, true);


--
-- Name: cases_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cases_id_seq', 68, true);


--
-- Name: channel_accounts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.channel_accounts_id_seq', 26, true);


--
-- Name: chat_groups_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.chat_groups_id_seq', 6, true);


--
-- Name: chat_messages_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.chat_messages_id_seq', 125, true);


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
-- Name: component_retrieval_profiles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.component_retrieval_profiles_id_seq', 1, false);


--
-- Name: component_retrieval_vectors_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.component_retrieval_vectors_id_seq', 1, false);


--
-- Name: content_component_lifecycle_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.content_component_lifecycle_events_id_seq', 1, false);


--
-- Name: content_component_revision_decisions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.content_component_revision_decisions_id_seq', 1, false);


--
-- Name: content_component_revision_sources_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.content_component_revision_sources_id_seq', 1, false);


--
-- Name: content_component_revision_tags_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.content_component_revision_tags_id_seq', 1, false);


--
-- Name: content_component_revisions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.content_component_revisions_id_seq', 1, false);


--
-- Name: content_component_selections_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.content_component_selections_id_seq', 1, false);


--
-- Name: content_components_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.content_components_id_seq', 1, false);


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

SELECT pg_catalog.setval('public.idea_comments_id_seq', 13, true);


--
-- Name: ideas_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ideas_id_seq', 30, true);


--
-- Name: links_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.links_id_seq', 24, true);


--
-- Name: notifications_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.notifications_id_seq', 26, true);


--
-- Name: playbook_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.playbook_items_id_seq', 140, true);


--
-- Name: sample_analysis_elements_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_analysis_elements_id_seq', 135, true);


--
-- Name: sample_analysis_jobs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_analysis_jobs_id_seq', 2, true);


--
-- Name: sample_analysis_selections_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_analysis_selections_id_seq', 9, true);


--
-- Name: sample_analysis_versions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_analysis_versions_id_seq', 9, true);


--
-- Name: sample_assets_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_assets_id_seq', 37, true);


--
-- Name: sample_captures_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_captures_id_seq', 20, true);


--
-- Name: sample_cluster_jobs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_cluster_jobs_id_seq', 1, true);


--
-- Name: sample_cluster_runs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_cluster_runs_id_seq', 1, true);


--
-- Name: sample_cluster_selections_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_cluster_selections_id_seq', 1, true);


--
-- Name: sample_clusters_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_clusters_id_seq', 1, false);


--
-- Name: sample_comparison_assessment_jobs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_comparison_assessment_jobs_id_seq', 1, false);


--
-- Name: sample_comparison_assessment_selections_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_comparison_assessment_selections_id_seq', 1, false);


--
-- Name: sample_comparison_assessments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_comparison_assessments_id_seq', 1, false);


--
-- Name: sample_comparison_finding_evidence_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_comparison_finding_evidence_id_seq', 1, false);


--
-- Name: sample_comparison_findings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_comparison_findings_id_seq', 1, false);


--
-- Name: sample_comparison_scope_members_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_comparison_scope_members_id_seq', 7, true);


--
-- Name: sample_comparison_scopes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_comparison_scopes_id_seq', 2, true);


--
-- Name: sample_comparison_snapshots_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_comparison_snapshots_id_seq', 105, true);


--
-- Name: sample_comparisons_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_comparisons_id_seq', 2, true);


--
-- Name: sample_element_decisions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_element_decisions_id_seq', 1, false);


--
-- Name: sample_element_evidence_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_element_evidence_id_seq', 1, false);


--
-- Name: sample_element_extraction_sources_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_element_extraction_sources_id_seq', 1, false);


--
-- Name: sample_element_extractions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_element_extractions_id_seq', 1, false);


--
-- Name: sample_element_tag_observations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_element_tag_observations_id_seq', 1, false);


--
-- Name: sample_element_tags_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_element_tags_id_seq', 1, false);


--
-- Name: sample_evaluations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_evaluations_id_seq', 1, false);


--
-- Name: sample_evidence_sources_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_evidence_sources_id_seq', 64, true);


--
-- Name: sample_insight_run_features_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_insight_run_features_id_seq', 1, false);


--
-- Name: sample_insight_run_members_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_insight_run_members_id_seq', 1, false);


--
-- Name: sample_insight_runs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_insight_runs_id_seq', 1, false);


--
-- Name: sample_insight_statistics_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_insight_statistics_id_seq', 1, false);


--
-- Name: sample_metric_snapshots_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_metric_snapshots_id_seq', 20, true);


--
-- Name: sample_relation_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_relation_events_id_seq', 1, false);


--
-- Name: sample_relation_evidence_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_relation_evidence_id_seq', 1, false);


--
-- Name: sample_relations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_relations_id_seq', 1, false);


--
-- Name: sample_retrieval_algorithm_selections_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_retrieval_algorithm_selections_id_seq', 1, true);


--
-- Name: sample_retrieval_algorithms_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_retrieval_algorithms_id_seq', 1, true);


--
-- Name: sample_retrieval_build_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_retrieval_build_items_id_seq', 7, true);


--
-- Name: sample_retrieval_builds_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_retrieval_builds_id_seq', 1, true);


--
-- Name: sample_retrieval_dimension_vectors_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_retrieval_dimension_vectors_id_seq', 105, true);


--
-- Name: sample_retrieval_profiles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_retrieval_profiles_id_seq', 7, true);


--
-- Name: sample_stage3_idempotency_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sample_stage3_idempotency_id_seq', 4, true);


--
-- Name: samples_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.samples_id_seq', 20, true);


--
-- Name: tags_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.tags_id_seq', 172, true);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.users_id_seq', 27, true);


--
-- Name: work_reports_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.work_reports_id_seq', 26, true);


--
-- Name: works_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.works_id_seq', 225, true);


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
-- Name: component_retrieval_profiles component_retrieval_profiles_build_subject_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_profiles
    ADD CONSTRAINT component_retrieval_profiles_build_subject_uk UNIQUE (build_id, component_id);


--
-- Name: component_retrieval_profiles component_retrieval_profiles_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_profiles
    ADD CONSTRAINT component_retrieval_profiles_identity_uk UNIQUE (id, component_id, selection_id, revision_id, approving_decision_id, dimension_key);


--
-- Name: component_retrieval_profiles component_retrieval_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_profiles
    ADD CONSTRAINT component_retrieval_profiles_pkey PRIMARY KEY (id);


--
-- Name: component_retrieval_states component_retrieval_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_states
    ADD CONSTRAINT component_retrieval_states_pkey PRIMARY KEY (component_id);


--
-- Name: component_retrieval_vectors component_retrieval_vectors_one_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_vectors
    ADD CONSTRAINT component_retrieval_vectors_one_uk UNIQUE (profile_id);


--
-- Name: component_retrieval_vectors component_retrieval_vectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_vectors
    ADD CONSTRAINT component_retrieval_vectors_pkey PRIMARY KEY (id);


--
-- Name: content_component_lifecycle_events content_component_lifecycle_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_lifecycle_events
    ADD CONSTRAINT content_component_lifecycle_events_pkey PRIMARY KEY (id);


--
-- Name: content_component_revision_decisions content_component_revision_decisions_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_decisions
    ADD CONSTRAINT content_component_revision_decisions_identity_uk UNIQUE (component_id, revision_id, id);


--
-- Name: content_component_revision_decisions content_component_revision_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_decisions
    ADD CONSTRAINT content_component_revision_decisions_pkey PRIMARY KEY (id);


--
-- Name: content_component_revision_sources content_component_revision_sources_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_sources
    ADD CONSTRAINT content_component_revision_sources_identity_uk UNIQUE (revision_id, extraction_id);


--
-- Name: content_component_revision_sources content_component_revision_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_sources
    ADD CONSTRAINT content_component_revision_sources_pkey PRIMARY KEY (id);


--
-- Name: content_component_revision_tags content_component_revision_tags_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_tags
    ADD CONSTRAINT content_component_revision_tags_identity_uk UNIQUE (revision_id, tag_id);


--
-- Name: content_component_revision_tags content_component_revision_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_tags
    ADD CONSTRAINT content_component_revision_tags_pkey PRIMARY KEY (id);


--
-- Name: content_component_revisions content_component_revisions_component_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revisions
    ADD CONSTRAINT content_component_revisions_component_id_id_uk UNIQUE (component_id, id);


--
-- Name: content_component_revisions content_component_revisions_component_revision_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revisions
    ADD CONSTRAINT content_component_revisions_component_revision_uk UNIQUE (component_id, revision);


--
-- Name: content_component_revisions content_component_revisions_id_dimension_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revisions
    ADD CONSTRAINT content_component_revisions_id_dimension_uk UNIQUE (id, dimension_key);


--
-- Name: content_component_revisions content_component_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revisions
    ADD CONSTRAINT content_component_revisions_pkey PRIMARY KEY (id);


--
-- Name: content_component_selections content_component_selections_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_selections
    ADD CONSTRAINT content_component_selections_identity_uk UNIQUE (component_id, id, revision_id, decision_id);


--
-- Name: content_component_selections content_component_selections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_selections
    ADD CONSTRAINT content_component_selections_pkey PRIMARY KEY (id);


--
-- Name: content_components content_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_components
    ADD CONSTRAINT content_components_pkey PRIMARY KEY (id);


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
-- Name: sample_analysis_dimensions sample_analysis_dimensions_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_dimensions
    ADD CONSTRAINT sample_analysis_dimensions_ordinal_key UNIQUE (ordinal);


--
-- Name: sample_analysis_dimensions sample_analysis_dimensions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_dimensions
    ADD CONSTRAINT sample_analysis_dimensions_pkey PRIMARY KEY (dimension_key);


--
-- Name: sample_analysis_elements sample_analysis_elements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_elements
    ADD CONSTRAINT sample_analysis_elements_pkey PRIMARY KEY (id);


--
-- Name: sample_analysis_elements sample_analysis_elements_version_dimension_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_elements
    ADD CONSTRAINT sample_analysis_elements_version_dimension_uk UNIQUE (version_id, dimension_key);


--
-- Name: sample_analysis_elements sample_analysis_elements_version_id_id_dimension_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_elements
    ADD CONSTRAINT sample_analysis_elements_version_id_id_dimension_uk UNIQUE (version_id, id, dimension_key);


--
-- Name: sample_analysis_elements sample_analysis_elements_version_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_elements
    ADD CONSTRAINT sample_analysis_elements_version_id_id_uk UNIQUE (version_id, id);


--
-- Name: sample_analysis_jobs sample_analysis_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_jobs
    ADD CONSTRAINT sample_analysis_jobs_pkey PRIMARY KEY (id);


--
-- Name: sample_analysis_jobs sample_analysis_jobs_sample_capture_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_jobs
    ADD CONSTRAINT sample_analysis_jobs_sample_capture_id_uk UNIQUE (sample_id, source_capture_id, id);


--
-- Name: sample_analysis_selections sample_analysis_selections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_selections
    ADD CONSTRAINT sample_analysis_selections_pkey PRIMARY KEY (id);


--
-- Name: sample_analysis_versions sample_analysis_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_versions
    ADD CONSTRAINT sample_analysis_versions_pkey PRIMARY KEY (id);


--
-- Name: sample_analysis_versions sample_analysis_versions_sample_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_versions
    ADD CONSTRAINT sample_analysis_versions_sample_id_id_uk UNIQUE (sample_id, id);


--
-- Name: sample_analysis_versions sample_analysis_versions_sample_revision_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_versions
    ADD CONSTRAINT sample_analysis_versions_sample_revision_uk UNIQUE (sample_id, revision);


--
-- Name: sample_assets sample_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_assets
    ADD CONSTRAINT sample_assets_pkey PRIMARY KEY (id);


--
-- Name: sample_assets sample_assets_sample_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_assets
    ADD CONSTRAINT sample_assets_sample_id_id_uk UNIQUE (sample_id, id);


--
-- Name: sample_captures sample_captures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_captures
    ADD CONSTRAINT sample_captures_pkey PRIMARY KEY (id);


--
-- Name: sample_captures sample_captures_sample_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_captures
    ADD CONSTRAINT sample_captures_sample_id_id_uk UNIQUE (sample_id, id);


--
-- Name: sample_cluster_jobs sample_cluster_jobs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_jobs
    ADD CONSTRAINT sample_cluster_jobs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: sample_cluster_jobs sample_cluster_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_jobs
    ADD CONSTRAINT sample_cluster_jobs_pkey PRIMARY KEY (id);


--
-- Name: sample_cluster_members sample_cluster_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_members
    ADD CONSTRAINT sample_cluster_members_pkey PRIMARY KEY (run_id, sample_id);


--
-- Name: sample_cluster_run_profiles sample_cluster_run_profiles_member_fk_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_run_profiles
    ADD CONSTRAINT sample_cluster_run_profiles_member_fk_uk UNIQUE (run_id, sample_id, profile_id);


--
-- Name: sample_cluster_run_profiles sample_cluster_run_profiles_ordinal_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_run_profiles
    ADD CONSTRAINT sample_cluster_run_profiles_ordinal_uk UNIQUE (run_id, ordinal);


--
-- Name: sample_cluster_run_profiles sample_cluster_run_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_run_profiles
    ADD CONSTRAINT sample_cluster_run_profiles_pkey PRIMARY KEY (run_id, sample_id);


--
-- Name: sample_cluster_run_profiles sample_cluster_run_profiles_profile_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_run_profiles
    ADD CONSTRAINT sample_cluster_run_profiles_profile_uk UNIQUE (run_id, profile_id);


--
-- Name: sample_cluster_runs sample_cluster_runs_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_runs
    ADD CONSTRAINT sample_cluster_runs_identity_uk UNIQUE (id, algorithm_selection_id);


--
-- Name: sample_cluster_runs sample_cluster_runs_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_runs
    ADD CONSTRAINT sample_cluster_runs_job_id_key UNIQUE (job_id);


--
-- Name: sample_cluster_runs sample_cluster_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_runs
    ADD CONSTRAINT sample_cluster_runs_pkey PRIMARY KEY (id);


--
-- Name: sample_cluster_selections sample_cluster_selections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_selections
    ADD CONSTRAINT sample_cluster_selections_pkey PRIMARY KEY (id);


--
-- Name: sample_clusters sample_clusters_key_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_clusters
    ADD CONSTRAINT sample_clusters_key_uk UNIQUE (run_id, cluster_key);


--
-- Name: sample_clusters sample_clusters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_clusters
    ADD CONSTRAINT sample_clusters_pkey PRIMARY KEY (id);


--
-- Name: sample_clusters sample_clusters_run_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_clusters
    ADD CONSTRAINT sample_clusters_run_id_id_uk UNIQUE (run_id, id);


--
-- Name: sample_clusters sample_clusters_run_ordinal_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_clusters
    ADD CONSTRAINT sample_clusters_run_ordinal_uk UNIQUE (run_id, ordinal);


--
-- Name: sample_comparison_assessment_jobs sample_comparison_assessment_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessment_jobs
    ADD CONSTRAINT sample_comparison_assessment_jobs_pkey PRIMARY KEY (id);


--
-- Name: sample_comparison_assessment_selections sample_comparison_assessment_selections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessment_selections
    ADD CONSTRAINT sample_comparison_assessment_selections_pkey PRIMARY KEY (id);


--
-- Name: sample_comparison_assessments sample_comparison_assessments_owner_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessments
    ADD CONSTRAINT sample_comparison_assessments_owner_uk UNIQUE (comparison_id, scope_id, id);


--
-- Name: sample_comparison_assessments sample_comparison_assessments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessments
    ADD CONSTRAINT sample_comparison_assessments_pkey PRIMARY KEY (id);


--
-- Name: sample_comparison_assessments sample_comparison_assessments_project_id_target_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessments
    ADD CONSTRAINT sample_comparison_assessments_project_id_target_uk UNIQUE (comparison_id, id, target);


--
-- Name: sample_comparison_assessments sample_comparison_assessments_project_target_revision_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessments
    ADD CONSTRAINT sample_comparison_assessments_project_target_revision_uk UNIQUE (comparison_id, target, revision);


--
-- Name: sample_comparison_finding_evidence sample_comparison_finding_evidence_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_finding_evidence
    ADD CONSTRAINT sample_comparison_finding_evidence_identity_uk UNIQUE (finding_id, snapshot_id, evidence_token);


--
-- Name: sample_comparison_finding_evidence sample_comparison_finding_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_finding_evidence
    ADD CONSTRAINT sample_comparison_finding_evidence_pkey PRIMARY KEY (id);


--
-- Name: sample_comparison_findings sample_comparison_findings_order_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_findings
    ADD CONSTRAINT sample_comparison_findings_order_uk UNIQUE (assessment_id, ordinal);


--
-- Name: sample_comparison_findings sample_comparison_findings_owner_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_findings
    ADD CONSTRAINT sample_comparison_findings_owner_uk UNIQUE (assessment_id, id, member_sample_id);


--
-- Name: sample_comparison_findings sample_comparison_findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_findings
    ADD CONSTRAINT sample_comparison_findings_pkey PRIMARY KEY (id);


--
-- Name: sample_comparison_scope_members sample_comparison_scope_members_owner_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scope_members
    ADD CONSTRAINT sample_comparison_scope_members_owner_uk UNIQUE (comparison_id, scope_id, sample_id, analysis_version_id);


--
-- Name: sample_comparison_scope_members sample_comparison_scope_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scope_members
    ADD CONSTRAINT sample_comparison_scope_members_pkey PRIMARY KEY (id);


--
-- Name: sample_comparison_scope_members sample_comparison_scope_members_scope_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scope_members
    ADD CONSTRAINT sample_comparison_scope_members_scope_id_id_uk UNIQUE (scope_id, id);


--
-- Name: sample_comparison_scope_members sample_comparison_scope_members_scope_ordinal_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scope_members
    ADD CONSTRAINT sample_comparison_scope_members_scope_ordinal_uk UNIQUE (scope_id, ordinal);


--
-- Name: sample_comparison_scope_members sample_comparison_scope_members_scope_sample_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scope_members
    ADD CONSTRAINT sample_comparison_scope_members_scope_sample_uk UNIQUE (scope_id, sample_id);


--
-- Name: sample_comparison_scopes sample_comparison_scopes_comparison_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scopes
    ADD CONSTRAINT sample_comparison_scopes_comparison_id_id_uk UNIQUE (comparison_id, id);


--
-- Name: sample_comparison_scopes sample_comparison_scopes_comparison_revision_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scopes
    ADD CONSTRAINT sample_comparison_scopes_comparison_revision_uk UNIQUE (comparison_id, revision);


--
-- Name: sample_comparison_scopes sample_comparison_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scopes
    ADD CONSTRAINT sample_comparison_scopes_pkey PRIMARY KEY (id);


--
-- Name: sample_comparison_snapshots sample_comparison_snapshots_owner_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_snapshots
    ADD CONSTRAINT sample_comparison_snapshots_owner_uk UNIQUE (comparison_id, scope_id, id, dimension_key);


--
-- Name: sample_comparison_snapshots sample_comparison_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_snapshots
    ADD CONSTRAINT sample_comparison_snapshots_pkey PRIMARY KEY (id);


--
-- Name: sample_comparison_snapshots sample_comparison_snapshots_scope_dimension_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_snapshots
    ADD CONSTRAINT sample_comparison_snapshots_scope_dimension_uk UNIQUE (scope_id, sample_id, dimension_key);


--
-- Name: sample_comparison_snapshots sample_comparison_snapshots_scope_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_snapshots
    ADD CONSTRAINT sample_comparison_snapshots_scope_id_id_uk UNIQUE (scope_id, id);


--
-- Name: sample_comparison_snapshots sample_comparison_snapshots_scope_row_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_snapshots
    ADD CONSTRAINT sample_comparison_snapshots_scope_row_identity_uk UNIQUE (scope_id, id, sample_id, dimension_key);


--
-- Name: sample_comparisons sample_comparisons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparisons
    ADD CONSTRAINT sample_comparisons_pkey PRIMARY KEY (id);


--
-- Name: sample_element_decisions sample_element_decisions_element_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_decisions
    ADD CONSTRAINT sample_element_decisions_element_id_id_uk UNIQUE (element_id, id);


--
-- Name: sample_element_decisions sample_element_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_decisions
    ADD CONSTRAINT sample_element_decisions_pkey PRIMARY KEY (id);


--
-- Name: sample_element_evidence sample_element_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_evidence
    ADD CONSTRAINT sample_element_evidence_pkey PRIMARY KEY (id);


--
-- Name: sample_element_evidence sample_element_evidence_version_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_evidence
    ADD CONSTRAINT sample_element_evidence_version_id_id_uk UNIQUE (version_id, id);


--
-- Name: sample_element_extraction_sources sample_element_extraction_sources_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extraction_sources
    ADD CONSTRAINT sample_element_extraction_sources_identity_uk UNIQUE (extraction_id, snapshot_id, source_role);


--
-- Name: sample_element_extraction_sources sample_element_extraction_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extraction_sources
    ADD CONSTRAINT sample_element_extraction_sources_pkey PRIMARY KEY (id);


--
-- Name: sample_element_extractions sample_element_extractions_id_dimension_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extractions
    ADD CONSTRAINT sample_element_extractions_id_dimension_uk UNIQUE (id, dimension_key);


--
-- Name: sample_element_extractions sample_element_extractions_owner_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extractions
    ADD CONSTRAINT sample_element_extractions_owner_uk UNIQUE (comparison_id, scope_id, id);


--
-- Name: sample_element_extractions sample_element_extractions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extractions
    ADD CONSTRAINT sample_element_extractions_pkey PRIMARY KEY (id);


--
-- Name: sample_element_tag_observations sample_element_tag_observations_fk_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tag_observations
    ADD CONSTRAINT sample_element_tag_observations_fk_identity_uk UNIQUE (id, sample_id, analysis_version_id, element_id, dimension_key);


--
-- Name: sample_element_tag_observations sample_element_tag_observations_idempotency_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tag_observations
    ADD CONSTRAINT sample_element_tag_observations_idempotency_uk UNIQUE (sample_id, analysis_version_id, element_id, tag_id, idempotency_key);


--
-- Name: sample_element_tag_observations sample_element_tag_observations_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tag_observations
    ADD CONSTRAINT sample_element_tag_observations_identity_uk UNIQUE (id, sample_id, analysis_version_id, element_id, dimension_key, tag_id);


--
-- Name: sample_element_tag_observations sample_element_tag_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tag_observations
    ADD CONSTRAINT sample_element_tag_observations_pkey PRIMARY KEY (id);


--
-- Name: sample_element_tags sample_element_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tags
    ADD CONSTRAINT sample_element_tags_pkey PRIMARY KEY (id);


--
-- Name: sample_element_tags sample_element_tags_stage4_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tags
    ADD CONSTRAINT sample_element_tags_stage4_identity_uk UNIQUE (id, version_id, element_id, dimension_key, tag_id);


--
-- Name: sample_evaluations sample_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evaluations
    ADD CONSTRAINT sample_evaluations_pkey PRIMARY KEY (id);


--
-- Name: sample_evaluations sample_evaluations_sample_target_revision_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evaluations
    ADD CONSTRAINT sample_evaluations_sample_target_revision_uk UNIQUE (sample_id, target, revision);


--
-- Name: sample_evidence_sources sample_evidence_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evidence_sources
    ADD CONSTRAINT sample_evidence_sources_pkey PRIMARY KEY (id);


--
-- Name: sample_evidence_sources sample_evidence_sources_version_source_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evidence_sources
    ADD CONSTRAINT sample_evidence_sources_version_source_uk UNIQUE (version_id, source_id);


--
-- Name: sample_insight_run_features sample_insight_run_features_key_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_features
    ADD CONSTRAINT sample_insight_run_features_key_uk UNIQUE (run_id, member_id, feature_key);


--
-- Name: sample_insight_run_features sample_insight_run_features_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_features
    ADD CONSTRAINT sample_insight_run_features_pkey PRIMARY KEY (id);


--
-- Name: sample_insight_run_members sample_insight_run_members_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_members
    ADD CONSTRAINT sample_insight_run_members_identity_uk UNIQUE (run_id, id, sample_id, analysis_version_id);


--
-- Name: sample_insight_run_members sample_insight_run_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_members
    ADD CONSTRAINT sample_insight_run_members_pkey PRIMARY KEY (id);


--
-- Name: sample_insight_run_members sample_insight_run_members_run_sample_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_members
    ADD CONSTRAINT sample_insight_run_members_run_sample_uk UNIQUE (run_id, sample_id);


--
-- Name: sample_insight_runs sample_insight_runs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_runs
    ADD CONSTRAINT sample_insight_runs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: sample_insight_runs sample_insight_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_runs
    ADD CONSTRAINT sample_insight_runs_pkey PRIMARY KEY (id);


--
-- Name: sample_insight_statistics sample_insight_statistics_key_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_statistics
    ADD CONSTRAINT sample_insight_statistics_key_uk UNIQUE (run_id, feature_key);


--
-- Name: sample_insight_statistics sample_insight_statistics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_statistics
    ADD CONSTRAINT sample_insight_statistics_pkey PRIMARY KEY (id);


--
-- Name: sample_metric_snapshots sample_metric_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_metric_snapshots
    ADD CONSTRAINT sample_metric_snapshots_pkey PRIMARY KEY (id);


--
-- Name: sample_metric_snapshots sample_metric_snapshots_sample_id_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_metric_snapshots
    ADD CONSTRAINT sample_metric_snapshots_sample_id_id_uk UNIQUE (sample_id, id);


--
-- Name: sample_relation_events sample_relation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_events
    ADD CONSTRAINT sample_relation_events_pkey PRIMARY KEY (id);


--
-- Name: sample_relation_evidence sample_relation_evidence_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_evidence
    ADD CONSTRAINT sample_relation_evidence_identity_uk UNIQUE (relation_id, element_evidence_id);


--
-- Name: sample_relation_evidence sample_relation_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_evidence
    ADD CONSTRAINT sample_relation_evidence_pkey PRIMARY KEY (id);


--
-- Name: sample_relations sample_relations_id_endpoints_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relations
    ADD CONSTRAINT sample_relations_id_endpoints_uk UNIQUE (id, subject_sample_id, subject_analysis_version_id, object_sample_id, object_analysis_version_id);


--
-- Name: sample_relations sample_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relations
    ADD CONSTRAINT sample_relations_pkey PRIMARY KEY (id);


--
-- Name: sample_retrieval_algorithm_selections sample_retrieval_algorithm_selections_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_algorithm_selections
    ADD CONSTRAINT sample_retrieval_algorithm_selections_identity_uk UNIQUE (id, algorithm_id);


--
-- Name: sample_retrieval_algorithm_selections sample_retrieval_algorithm_selections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_algorithm_selections
    ADD CONSTRAINT sample_retrieval_algorithm_selections_pkey PRIMARY KEY (id);


--
-- Name: sample_retrieval_algorithms sample_retrieval_algorithms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_algorithms
    ADD CONSTRAINT sample_retrieval_algorithms_pkey PRIMARY KEY (id);


--
-- Name: sample_retrieval_algorithms sample_retrieval_algorithms_versions_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_algorithms
    ADD CONSTRAINT sample_retrieval_algorithms_versions_uk UNIQUE (algorithm_version, tokenizer_version, mapping_version, config_sha256);


--
-- Name: sample_retrieval_build_items sample_retrieval_build_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_build_items
    ADD CONSTRAINT sample_retrieval_build_items_pkey PRIMARY KEY (id);


--
-- Name: sample_retrieval_build_items sample_retrieval_build_items_subject_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_build_items
    ADD CONSTRAINT sample_retrieval_build_items_subject_uk UNIQUE (build_id, subject_kind, sample_id, component_id);


--
-- Name: sample_retrieval_builds sample_retrieval_builds_idempotency_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_builds
    ADD CONSTRAINT sample_retrieval_builds_idempotency_uk UNIQUE (idempotency_key);


--
-- Name: sample_retrieval_builds sample_retrieval_builds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_builds
    ADD CONSTRAINT sample_retrieval_builds_pkey PRIMARY KEY (id);


--
-- Name: sample_retrieval_dimension_vectors sample_retrieval_dimension_vectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_dimension_vectors
    ADD CONSTRAINT sample_retrieval_dimension_vectors_pkey PRIMARY KEY (id);


--
-- Name: sample_retrieval_profiles sample_retrieval_profiles_build_subject_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_profiles
    ADD CONSTRAINT sample_retrieval_profiles_build_subject_uk UNIQUE (build_id, sample_id);


--
-- Name: sample_retrieval_profiles sample_retrieval_profiles_id_sample_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_profiles
    ADD CONSTRAINT sample_retrieval_profiles_id_sample_uk UNIQUE (id, sample_id);


--
-- Name: sample_retrieval_profiles sample_retrieval_profiles_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_profiles
    ADD CONSTRAINT sample_retrieval_profiles_identity_uk UNIQUE (id, sample_id, analysis_version_id);


--
-- Name: sample_retrieval_profiles sample_retrieval_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_profiles
    ADD CONSTRAINT sample_retrieval_profiles_pkey PRIMARY KEY (id);


--
-- Name: sample_retrieval_states sample_retrieval_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_states
    ADD CONSTRAINT sample_retrieval_states_pkey PRIMARY KEY (sample_id);


--
-- Name: sample_retrieval_dimension_vectors sample_retrieval_vectors_dimension_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_dimension_vectors
    ADD CONSTRAINT sample_retrieval_vectors_dimension_uk UNIQUE (profile_id, dimension_key);


--
-- Name: sample_stage3_idempotency sample_stage3_idempotency_identity_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_stage3_idempotency
    ADD CONSTRAINT sample_stage3_idempotency_identity_uk UNIQUE (aggregate_key, action, idempotency_key);


--
-- Name: sample_stage3_idempotency sample_stage3_idempotency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_stage3_idempotency
    ADD CONSTRAINT sample_stage3_idempotency_pkey PRIMARY KEY (id);


--
-- Name: samples samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.samples
    ADD CONSTRAINT samples_pkey PRIMARY KEY (id);


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
-- Name: component_retrieval_vectors_band0_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX component_retrieval_vectors_band0_idx ON public.component_retrieval_vectors USING btree (dimension_key, band_0, profile_id) WHERE (norm_sq > 0);


--
-- Name: component_retrieval_vectors_band1_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX component_retrieval_vectors_band1_idx ON public.component_retrieval_vectors USING btree (dimension_key, band_1, profile_id) WHERE (norm_sq > 0);


--
-- Name: component_retrieval_vectors_band2_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX component_retrieval_vectors_band2_idx ON public.component_retrieval_vectors USING btree (dimension_key, band_2, profile_id) WHERE (norm_sq > 0);


--
-- Name: component_retrieval_vectors_band3_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX component_retrieval_vectors_band3_idx ON public.component_retrieval_vectors USING btree (dimension_key, band_3, profile_id) WHERE (norm_sq > 0);


--
-- Name: component_retrieval_vectors_band4_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX component_retrieval_vectors_band4_idx ON public.component_retrieval_vectors USING btree (dimension_key, band_4, profile_id) WHERE (norm_sq > 0);


--
-- Name: component_retrieval_vectors_band5_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX component_retrieval_vectors_band5_idx ON public.component_retrieval_vectors USING btree (dimension_key, band_5, profile_id) WHERE (norm_sq > 0);


--
-- Name: component_retrieval_vectors_band6_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX component_retrieval_vectors_band6_idx ON public.component_retrieval_vectors USING btree (dimension_key, band_6, profile_id) WHERE (norm_sq > 0);


--
-- Name: component_retrieval_vectors_band7_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX component_retrieval_vectors_band7_idx ON public.component_retrieval_vectors USING btree (dimension_key, band_7, profile_id) WHERE (norm_sq > 0);


--
-- Name: content_component_lifecycle_events_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_component_lifecycle_events_history_idx ON public.content_component_lifecycle_events USING btree (component_id, id);


--
-- Name: content_component_revision_decisions_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_component_revision_decisions_history_idx ON public.content_component_revision_decisions USING btree (revision_id, id);


--
-- Name: content_component_revision_tags_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_component_revision_tags_tag_idx ON public.content_component_revision_tags USING btree (tag_id, revision_id);


--
-- Name: content_component_revisions_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_component_revisions_history_idx ON public.content_component_revisions USING btree (component_id, revision DESC, id DESC);


--
-- Name: content_component_selections_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_component_selections_current_idx ON public.content_component_selections USING btree (component_id, id DESC);


--
-- Name: content_components_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_components_name_idx ON public.content_components USING btree (lower(name), id DESC);


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
-- Name: sample_analysis_elements_dimension_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_analysis_elements_dimension_idx ON public.sample_analysis_elements USING btree (dimension_key, version_id);


--
-- Name: sample_analysis_elements_value_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_analysis_elements_value_gin_idx ON public.sample_analysis_elements USING gin (value_json jsonb_path_ops);


--
-- Name: sample_analysis_jobs_capture_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_analysis_jobs_capture_idx ON public.sample_analysis_jobs USING btree (source_capture_id);


--
-- Name: sample_analysis_jobs_idempotency_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_analysis_jobs_idempotency_uidx ON public.sample_analysis_jobs USING btree (sample_id, idempotency_key);


--
-- Name: sample_analysis_jobs_one_active_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_analysis_jobs_one_active_uidx ON public.sample_analysis_jobs USING btree (sample_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: sample_analysis_jobs_status_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_analysis_jobs_status_time_idx ON public.sample_analysis_jobs USING btree (status, created_at, id);


--
-- Name: sample_analysis_selections_sample_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_analysis_selections_sample_time_idx ON public.sample_analysis_selections USING btree (sample_id, created_at DESC, id DESC);


--
-- Name: sample_analysis_versions_capture_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_analysis_versions_capture_idx ON public.sample_analysis_versions USING btree (source_capture_id);


--
-- Name: sample_analysis_versions_job_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_analysis_versions_job_uidx ON public.sample_analysis_versions USING btree (job_id) WHERE (job_id IS NOT NULL);


--
-- Name: sample_analysis_versions_sample_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_analysis_versions_sample_time_idx ON public.sample_analysis_versions USING btree (sample_id, revision DESC, id DESC);


--
-- Name: sample_assets_capture_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_assets_capture_idx ON public.sample_assets USING btree (capture_id) WHERE ((capture_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: sample_assets_sample_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_assets_sample_kind_idx ON public.sample_assets USING btree (sample_id, kind, created_at, id) WHERE (deleted_at IS NULL);


--
-- Name: sample_assets_sha256_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_assets_sha256_idx ON public.sample_assets USING btree (sha256);


--
-- Name: sample_assets_storage_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_assets_storage_key_uidx ON public.sample_assets USING btree (storage_key);


--
-- Name: sample_captures_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_captures_key_uidx ON public.sample_captures USING btree (sample_id, capture_key) WHERE (capture_key IS NOT NULL);


--
-- Name: sample_captures_sample_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_captures_sample_time_idx ON public.sample_captures USING btree (sample_id, captured_at DESC, id DESC);


--
-- Name: sample_cluster_jobs_one_active_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_cluster_jobs_one_active_uidx ON public.sample_cluster_jobs USING btree ((1)) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: sample_comparison_assessment_jobs_one_running_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_comparison_assessment_jobs_one_running_uidx ON public.sample_comparison_assessment_jobs USING btree ((true)) WHERE (status = 'running'::text);


--
-- Name: sample_comparison_assessment_jobs_one_scope_target_active_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_comparison_assessment_jobs_one_scope_target_active_uidx ON public.sample_comparison_assessment_jobs USING btree (scope_id, target) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: sample_comparison_assessment_jobs_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_comparison_assessment_jobs_queue_idx ON public.sample_comparison_assessment_jobs USING btree (status, created_at, id);


--
-- Name: sample_comparison_assessment_selections_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_comparison_assessment_selections_current_idx ON public.sample_comparison_assessment_selections USING btree (comparison_id, target, id DESC);


--
-- Name: sample_comparison_assessments_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_comparison_assessments_history_idx ON public.sample_comparison_assessments USING btree (comparison_id, target, revision DESC, id DESC);


--
-- Name: sample_comparison_assessments_job_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_comparison_assessments_job_uidx ON public.sample_comparison_assessments USING btree (job_id) WHERE (job_id IS NOT NULL);


--
-- Name: sample_comparison_scope_members_sample_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_comparison_scope_members_sample_idx ON public.sample_comparison_scope_members USING btree (sample_id, scope_id);


--
-- Name: sample_comparison_scopes_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_comparison_scopes_project_idx ON public.sample_comparison_scopes USING btree (comparison_id, revision DESC, id DESC);


--
-- Name: sample_comparison_snapshots_dimension_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_comparison_snapshots_dimension_idx ON public.sample_comparison_snapshots USING btree (scope_id, dimension_key, sample_id);


--
-- Name: sample_comparisons_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_comparisons_created_idx ON public.sample_comparisons USING btree (created_at DESC, id DESC);


--
-- Name: sample_element_decisions_idempotency_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_element_decisions_idempotency_uidx ON public.sample_element_decisions USING btree (element_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: sample_element_decisions_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_element_decisions_latest_idx ON public.sample_element_decisions USING btree (element_id, created_at DESC, id DESC);


--
-- Name: sample_element_evidence_element_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_element_evidence_element_idx ON public.sample_element_evidence USING btree (element_id, verification_status, id);


--
-- Name: sample_element_evidence_identity_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_element_evidence_identity_uidx ON public.sample_element_evidence USING btree (element_id, source_id, COALESCE(start_offset, '-1'::integer), COALESCE(end_offset, '-1'::integer), COALESCE(time_start_ms, ('-1'::integer)::bigint), COALESCE(time_end_ms, ('-1'::integer)::bigint), COALESCE(json_path, ''::text), COALESCE(comment_ref, ''::text));


--
-- Name: sample_element_extractions_list_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_element_extractions_list_idx ON public.sample_element_extractions USING btree (dimension_key, comparison_id, id DESC) WHERE (status = 'complete'::text);


--
-- Name: sample_element_tag_observations_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_element_tag_observations_latest_idx ON public.sample_element_tag_observations USING btree (element_id, tag_id, created_at DESC, id DESC);


--
-- Name: sample_element_tags_element_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_element_tags_element_idx ON public.sample_element_tags USING btree (element_id, id);


--
-- Name: sample_element_tags_idempotency_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_element_tags_idempotency_uidx ON public.sample_element_tags USING btree (version_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: sample_element_tags_identity_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_element_tags_identity_uidx ON public.sample_element_tags USING btree (element_id, tag_id, origin);


--
-- Name: sample_element_tags_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_element_tags_tag_idx ON public.sample_element_tags USING btree (tag_id, dimension_key, version_id);


--
-- Name: sample_evaluations_analysis_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_evaluations_analysis_version_idx ON public.sample_evaluations USING btree (analysis_version_id) WHERE (analysis_version_id IS NOT NULL);


--
-- Name: sample_evaluations_hypotheses_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_evaluations_hypotheses_gin_idx ON public.sample_evaluations USING gin (effect_hypotheses jsonb_path_ops);


--
-- Name: sample_evaluations_sample_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_evaluations_sample_target_idx ON public.sample_evaluations USING btree (sample_id, target, revision DESC, id DESC);


--
-- Name: sample_evidence_sources_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_evidence_sources_asset_idx ON public.sample_evidence_sources USING btree (asset_id) WHERE (asset_id IS NOT NULL);


--
-- Name: sample_evidence_sources_capture_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_evidence_sources_capture_idx ON public.sample_evidence_sources USING btree (source_capture_id, version_id);


--
-- Name: sample_evidence_sources_locator_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_evidence_sources_locator_gin_idx ON public.sample_evidence_sources USING gin (locator jsonb_path_ops);


--
-- Name: sample_insight_runs_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_insight_runs_history_idx ON public.sample_insight_runs USING btree (created_at DESC, id DESC);


--
-- Name: sample_insight_runs_one_active_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_insight_runs_one_active_uidx ON public.sample_insight_runs USING btree ((1)) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: sample_metric_snapshots_capture_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_metric_snapshots_capture_uidx ON public.sample_metric_snapshots USING btree (capture_id) WHERE (capture_id IS NOT NULL);


--
-- Name: sample_metric_snapshots_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_metric_snapshots_key_uidx ON public.sample_metric_snapshots USING btree (sample_id, snapshot_key) WHERE (snapshot_key IS NOT NULL);


--
-- Name: sample_metric_snapshots_raw_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_metric_snapshots_raw_gin_idx ON public.sample_metric_snapshots USING gin (raw_metrics jsonb_path_ops);


--
-- Name: sample_metric_snapshots_sample_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_metric_snapshots_sample_time_idx ON public.sample_metric_snapshots USING btree (sample_id, observed_at, id);


--
-- Name: sample_relation_events_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_relation_events_history_idx ON public.sample_relation_events USING btree (relation_id, id);


--
-- Name: sample_relations_active_identity_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_relations_active_identity_uidx ON public.sample_relations USING btree (relation_type, subject_sample_id, subject_analysis_version_id, object_sample_id, object_analysis_version_id) WHERE (current_state <> ALL (ARRAY['rejected'::text, 'superseded'::text]));


--
-- Name: sample_relations_object_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_relations_object_idx ON public.sample_relations USING btree (object_sample_id, current_state, id DESC);


--
-- Name: sample_relations_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_relations_subject_idx ON public.sample_relations USING btree (subject_sample_id, current_state, id DESC);


--
-- Name: sample_retrieval_builds_one_active_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sample_retrieval_builds_one_active_uidx ON public.sample_retrieval_builds USING btree ((1)) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: sample_retrieval_builds_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_retrieval_builds_status_idx ON public.sample_retrieval_builds USING btree (status, created_at, id);


--
-- Name: sample_retrieval_profiles_algorithm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_retrieval_profiles_algorithm_idx ON public.sample_retrieval_profiles USING btree (algorithm_id, id) WHERE (status = 'complete'::text);


--
-- Name: sample_retrieval_vectors_band0_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_retrieval_vectors_band0_idx ON public.sample_retrieval_dimension_vectors USING btree (dimension_key, band_0, profile_id) WHERE (norm_sq > 0);


--
-- Name: sample_retrieval_vectors_band1_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_retrieval_vectors_band1_idx ON public.sample_retrieval_dimension_vectors USING btree (dimension_key, band_1, profile_id) WHERE (norm_sq > 0);


--
-- Name: sample_retrieval_vectors_band2_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_retrieval_vectors_band2_idx ON public.sample_retrieval_dimension_vectors USING btree (dimension_key, band_2, profile_id) WHERE (norm_sq > 0);


--
-- Name: sample_retrieval_vectors_band3_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_retrieval_vectors_band3_idx ON public.sample_retrieval_dimension_vectors USING btree (dimension_key, band_3, profile_id) WHERE (norm_sq > 0);


--
-- Name: sample_retrieval_vectors_band4_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_retrieval_vectors_band4_idx ON public.sample_retrieval_dimension_vectors USING btree (dimension_key, band_4, profile_id) WHERE (norm_sq > 0);


--
-- Name: sample_retrieval_vectors_band5_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_retrieval_vectors_band5_idx ON public.sample_retrieval_dimension_vectors USING btree (dimension_key, band_5, profile_id) WHERE (norm_sq > 0);


--
-- Name: sample_retrieval_vectors_band6_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_retrieval_vectors_band6_idx ON public.sample_retrieval_dimension_vectors USING btree (dimension_key, band_6, profile_id) WHERE (norm_sq > 0);


--
-- Name: sample_retrieval_vectors_band7_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sample_retrieval_vectors_band7_idx ON public.sample_retrieval_dimension_vectors USING btree (dimension_key, band_7, profile_id) WHERE (norm_sq > 0);


--
-- Name: samples_alive_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX samples_alive_time_idx ON public.samples USING btree (COALESCE(published_at, created_at) DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: samples_archive_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX samples_archive_status_idx ON public.samples USING btree (archive_status, completeness_score DESC) WHERE (deleted_at IS NULL);


--
-- Name: samples_canonical_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX samples_canonical_key_uidx ON public.samples USING btree (canonical_key);


--
-- Name: samples_current_analysis_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX samples_current_analysis_version_idx ON public.samples USING btree (current_analysis_version_id) WHERE (current_analysis_version_id IS NOT NULL);


--
-- Name: samples_platform_alive_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX samples_platform_alive_idx ON public.samples USING btree (platform, COALESCE(published_at, created_at) DESC) WHERE (deleted_at IS NULL);


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
-- Name: works_sample_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX works_sample_id_idx ON public.works USING btree (sample_id) WHERE (sample_id IS NOT NULL);


--
-- Name: component_retrieval_profiles component_retrieval_profiles_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER component_retrieval_profiles_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.component_retrieval_profiles FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_component_profile_guard();


--
-- Name: component_retrieval_vectors component_retrieval_vectors_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER component_retrieval_vectors_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.component_retrieval_vectors FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_component_vector_guard();


--
-- Name: component_retrieval_vectors component_retrieval_vectors_numeric_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER component_retrieval_vectors_numeric_trg BEFORE INSERT OR UPDATE ON public.component_retrieval_vectors FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_vector_numeric_guard();


--
-- Name: content_component_lifecycle_events content_component_lifecycle_events_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_component_lifecycle_events_append_only_trg BEFORE DELETE OR UPDATE ON public.content_component_lifecycle_events FOR EACH ROW EXECUTE FUNCTION public.sample_stage3_append_only_guard();


--
-- Name: content_component_lifecycle_events content_component_lifecycle_events_apply_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_component_lifecycle_events_apply_trg BEFORE INSERT ON public.content_component_lifecycle_events FOR EACH ROW EXECUTE FUNCTION public.content_component_lifecycle_apply();


--
-- Name: content_component_revision_decisions content_component_revision_decisions_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_component_revision_decisions_append_only_trg BEFORE DELETE OR UPDATE ON public.content_component_revision_decisions FOR EACH ROW EXECUTE FUNCTION public.sample_stage3_append_only_guard();


--
-- Name: content_component_revision_decisions content_component_revision_decisions_apply_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_component_revision_decisions_apply_trg BEFORE INSERT ON public.content_component_revision_decisions FOR EACH ROW EXECUTE FUNCTION public.content_component_revision_decision_apply();


--
-- Name: content_component_revision_sources content_component_revision_sources_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_component_revision_sources_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.content_component_revision_sources FOR EACH ROW EXECUTE FUNCTION public.content_component_revision_child_guard();


--
-- Name: content_component_revision_tags content_component_revision_tags_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_component_revision_tags_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.content_component_revision_tags FOR EACH ROW EXECUTE FUNCTION public.content_component_revision_child_guard();


--
-- Name: content_component_revisions content_component_revisions_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_component_revisions_guard_trg BEFORE DELETE OR UPDATE ON public.content_component_revisions FOR EACH ROW EXECUTE FUNCTION public.content_component_revision_row_guard();


--
-- Name: content_component_selections content_component_selections_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_component_selections_append_only_trg BEFORE DELETE OR UPDATE ON public.content_component_selections FOR EACH ROW EXECUTE FUNCTION public.sample_stage3_append_only_guard();


--
-- Name: content_component_selections content_component_selections_validate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_component_selections_validate_trg BEFORE INSERT ON public.content_component_selections FOR EACH ROW EXECUTE FUNCTION public.content_component_selection_validate();


--
-- Name: content_components content_components_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_components_guard_trg BEFORE DELETE OR UPDATE ON public.content_components FOR EACH ROW EXECUTE FUNCTION public.content_component_row_guard();


--
-- Name: sample_analysis_selections sample_analysis_apply_selection_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_analysis_apply_selection_trg AFTER INSERT ON public.sample_analysis_selections FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_apply_selection();


--
-- Name: sample_analysis_dimensions sample_analysis_dimensions_immutable_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_analysis_dimensions_immutable_trg BEFORE DELETE OR UPDATE ON public.sample_analysis_dimensions FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_guard_append_only();


--
-- Name: sample_analysis_elements sample_analysis_elements_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_analysis_elements_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_analysis_elements FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_guard_version_child();


--
-- Name: sample_analysis_selections sample_analysis_selections_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_analysis_selections_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_analysis_selections FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_guard_append_only();


--
-- Name: sample_analysis_versions sample_analysis_versions_completion_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_analysis_versions_completion_trg BEFORE INSERT OR UPDATE ON public.sample_analysis_versions FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_validate_completion();


--
-- Name: sample_analysis_versions sample_analysis_versions_immutable_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_analysis_versions_immutable_trg BEFORE DELETE OR UPDATE ON public.sample_analysis_versions FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_guard_version_immutable();


--
-- Name: sample_cluster_jobs sample_cluster_jobs_state_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_cluster_jobs_state_trg BEFORE DELETE OR UPDATE ON public.sample_cluster_jobs FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_job_state_guard();


--
-- Name: sample_cluster_members sample_cluster_members_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_cluster_members_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_cluster_members FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_parent_child_guard();


--
-- Name: sample_cluster_run_profiles sample_cluster_run_profiles_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_cluster_run_profiles_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_cluster_run_profiles FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_parent_child_guard();


--
-- Name: sample_cluster_runs sample_cluster_runs_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_cluster_runs_guard_trg BEFORE DELETE OR UPDATE ON public.sample_cluster_runs FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_cluster_run_guard();


--
-- Name: sample_cluster_selections sample_cluster_selections_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_cluster_selections_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_cluster_selections FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_append_only_guard();


--
-- Name: sample_cluster_selections sample_cluster_selections_validate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_cluster_selections_validate_trg BEFORE INSERT ON public.sample_cluster_selections FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_selection_guard();


--
-- Name: sample_clusters sample_clusters_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_clusters_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_clusters FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_parent_child_guard();


--
-- Name: sample_comparison_assessment_jobs sample_comparison_assessment_jobs_transition_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_comparison_assessment_jobs_transition_trg BEFORE INSERT OR UPDATE ON public.sample_comparison_assessment_jobs FOR EACH ROW EXECUTE FUNCTION public.sample_comparison_job_transition_guard();


--
-- Name: sample_comparison_assessment_selections sample_comparison_assessment_selections_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_comparison_assessment_selections_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_comparison_assessment_selections FOR EACH ROW EXECUTE FUNCTION public.sample_stage3_append_only_guard();


--
-- Name: sample_comparison_assessment_selections sample_comparison_assessment_selections_validate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_comparison_assessment_selections_validate_trg BEFORE INSERT ON public.sample_comparison_assessment_selections FOR EACH ROW EXECUTE FUNCTION public.sample_comparison_selection_validate();


--
-- Name: sample_comparison_assessments sample_comparison_assessments_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_comparison_assessments_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_comparison_assessments FOR EACH ROW EXECUTE FUNCTION public.sample_stage3_append_only_guard();


--
-- Name: sample_comparison_assessments sample_comparison_assessments_validate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_comparison_assessments_validate_trg BEFORE INSERT ON public.sample_comparison_assessments FOR EACH ROW EXECUTE FUNCTION public.sample_comparison_assessment_validate();


--
-- Name: sample_comparison_finding_evidence sample_comparison_finding_evidence_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_comparison_finding_evidence_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_comparison_finding_evidence FOR EACH ROW EXECUTE FUNCTION public.sample_stage3_append_only_guard();


--
-- Name: sample_comparison_findings sample_comparison_findings_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_comparison_findings_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_comparison_findings FOR EACH ROW EXECUTE FUNCTION public.sample_stage3_append_only_guard();


--
-- Name: sample_comparison_scope_members sample_comparison_scope_members_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_comparison_scope_members_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_comparison_scope_members FOR EACH ROW EXECUTE FUNCTION public.sample_comparison_scope_child_guard();


--
-- Name: sample_comparison_scopes sample_comparison_scopes_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_comparison_scopes_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_comparison_scopes FOR EACH ROW EXECUTE FUNCTION public.sample_comparison_scope_guard();


--
-- Name: sample_comparison_snapshots sample_comparison_snapshots_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_comparison_snapshots_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_comparison_snapshots FOR EACH ROW EXECUTE FUNCTION public.sample_comparison_scope_child_guard();


--
-- Name: sample_element_decisions sample_element_decisions_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_element_decisions_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_element_decisions FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_guard_append_only();


--
-- Name: sample_element_decisions sample_element_decisions_validate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_element_decisions_validate_trg BEFORE INSERT ON public.sample_element_decisions FOR EACH ROW EXECUTE FUNCTION public.sample_element_decisions_validate();


--
-- Name: sample_element_evidence sample_element_evidence_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_element_evidence_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_element_evidence FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_guard_version_child();


--
-- Name: sample_element_extraction_sources sample_element_extraction_sources_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_element_extraction_sources_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_element_extraction_sources FOR EACH ROW EXECUTE FUNCTION public.sample_element_extraction_source_guard();


--
-- Name: sample_element_extractions sample_element_extractions_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_element_extractions_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_element_extractions FOR EACH ROW EXECUTE FUNCTION public.sample_element_extraction_guard();


--
-- Name: sample_element_tag_observations sample_element_tag_observations_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_element_tag_observations_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_element_tag_observations FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_append_only_guard();


--
-- Name: sample_element_tag_observations sample_element_tag_observations_validate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_element_tag_observations_validate_trg BEFORE INSERT ON public.sample_element_tag_observations FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_tag_observation_guard();


--
-- Name: sample_element_tags sample_element_tags_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_element_tags_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_element_tags FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_guard_append_only();


--
-- Name: sample_element_tags sample_element_tags_validate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_element_tags_validate_trg BEFORE INSERT ON public.sample_element_tags FOR EACH ROW EXECUTE FUNCTION public.sample_element_tags_validate();


--
-- Name: sample_evaluations sample_evaluations_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_evaluations_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_evaluations FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_guard_append_only();


--
-- Name: sample_evidence_sources sample_evidence_sources_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_evidence_sources_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_evidence_sources FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_guard_version_child();


--
-- Name: sample_insight_run_features sample_insight_run_features_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_insight_run_features_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_insight_run_features FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_parent_child_guard();


--
-- Name: sample_insight_run_features sample_insight_run_features_validate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_insight_run_features_validate_trg BEFORE INSERT ON public.sample_insight_run_features FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_insight_feature_validate();


--
-- Name: sample_insight_run_members sample_insight_run_members_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_insight_run_members_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_insight_run_members FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_parent_child_guard();


--
-- Name: sample_insight_runs sample_insight_runs_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_insight_runs_guard_trg BEFORE DELETE OR UPDATE ON public.sample_insight_runs FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_insight_run_guard();


--
-- Name: sample_insight_runs sample_insight_runs_state_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_insight_runs_state_trg BEFORE DELETE OR UPDATE ON public.sample_insight_runs FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_job_state_guard();


--
-- Name: sample_insight_statistics sample_insight_statistics_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_insight_statistics_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_insight_statistics FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_parent_child_guard();


--
-- Name: sample_metric_snapshots sample_metric_snapshots_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_metric_snapshots_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_metric_snapshots FOR EACH ROW EXECUTE FUNCTION public.sample_analysis_guard_append_only();


--
-- Name: sample_relation_events sample_relation_events_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_relation_events_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_relation_events FOR EACH ROW EXECUTE FUNCTION public.sample_stage3_append_only_guard();


--
-- Name: sample_relation_events sample_relation_events_apply_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_relation_events_apply_trg BEFORE INSERT ON public.sample_relation_events FOR EACH ROW EXECUTE FUNCTION public.sample_relation_event_apply();


--
-- Name: sample_relation_evidence sample_relation_evidence_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_relation_evidence_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_relation_evidence FOR EACH ROW EXECUTE FUNCTION public.sample_stage3_append_only_guard();


--
-- Name: sample_relation_evidence sample_relation_evidence_validate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_relation_evidence_validate_trg BEFORE INSERT ON public.sample_relation_evidence FOR EACH ROW EXECUTE FUNCTION public.sample_relation_evidence_validate();


--
-- Name: sample_relations sample_relations_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_relations_guard_trg BEFORE DELETE OR UPDATE ON public.sample_relations FOR EACH ROW EXECUTE FUNCTION public.sample_relation_row_guard();


--
-- Name: sample_relations sample_relations_insert_validate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_relations_insert_validate_trg BEFORE INSERT ON public.sample_relations FOR EACH ROW EXECUTE FUNCTION public.sample_relation_insert_validate();


--
-- Name: sample_retrieval_algorithm_selections sample_retrieval_algorithm_selections_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_retrieval_algorithm_selections_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_retrieval_algorithm_selections FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_append_only_guard();


--
-- Name: sample_retrieval_algorithm_selections sample_retrieval_algorithm_selections_validate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_retrieval_algorithm_selections_validate_trg BEFORE INSERT ON public.sample_retrieval_algorithm_selections FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_selection_guard();


--
-- Name: sample_retrieval_algorithms sample_retrieval_algorithms_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_retrieval_algorithms_append_only_trg BEFORE DELETE OR UPDATE ON public.sample_retrieval_algorithms FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_append_only_guard();


--
-- Name: sample_retrieval_build_items sample_retrieval_build_items_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_retrieval_build_items_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_retrieval_build_items FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_build_item_guard();


--
-- Name: sample_retrieval_builds sample_retrieval_builds_state_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_retrieval_builds_state_trg BEFORE DELETE OR UPDATE ON public.sample_retrieval_builds FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_job_state_guard();


--
-- Name: sample_retrieval_profiles sample_retrieval_profiles_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_retrieval_profiles_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_retrieval_profiles FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_profile_guard();


--
-- Name: sample_retrieval_dimension_vectors sample_retrieval_vectors_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_retrieval_vectors_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sample_retrieval_dimension_vectors FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_profile_child_guard();


--
-- Name: sample_retrieval_dimension_vectors sample_retrieval_vectors_numeric_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_retrieval_vectors_numeric_trg BEFORE INSERT OR UPDATE ON public.sample_retrieval_dimension_vectors FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_vector_numeric_guard();


--
-- Name: content_components sample_stage4_component_lifecycle_dirty_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_stage4_component_lifecycle_dirty_trg AFTER UPDATE OF lifecycle_state ON public.content_components FOR EACH ROW WHEN ((old.lifecycle_state IS DISTINCT FROM new.lifecycle_state)) EXECUTE FUNCTION public.sample_stage4_mark_component_dirty();


--
-- Name: content_component_selections sample_stage4_component_selection_dirty_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_stage4_component_selection_dirty_trg AFTER INSERT ON public.content_component_selections FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_mark_component_dirty();


--
-- Name: content_component_revision_tags sample_stage4_component_tag_dirty_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_stage4_component_tag_dirty_trg AFTER INSERT OR DELETE OR UPDATE ON public.content_component_revision_tags FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_mark_component_dirty();


--
-- Name: sample_element_decisions sample_stage4_decision_dirty_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_stage4_decision_dirty_trg AFTER INSERT ON public.sample_element_decisions FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_mark_sample_dirty();


--
-- Name: sample_element_tags sample_stage4_element_tag_dirty_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_stage4_element_tag_dirty_trg AFTER INSERT ON public.sample_element_tags FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_mark_sample_dirty();


--
-- Name: entity_tags sample_stage4_entity_tag_dirty_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_stage4_entity_tag_dirty_trg AFTER INSERT OR DELETE OR UPDATE ON public.entity_tags FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_mark_entity_tag_dirty();


--
-- Name: samples sample_stage4_samples_dirty_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_stage4_samples_dirty_trg AFTER UPDATE OF current_analysis_version_id ON public.samples FOR EACH ROW WHEN ((old.current_analysis_version_id IS DISTINCT FROM new.current_analysis_version_id)) EXECUTE FUNCTION public.sample_stage4_mark_sample_dirty();


--
-- Name: sample_analysis_selections sample_stage4_selection_dirty_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_stage4_selection_dirty_trg AFTER INSERT ON public.sample_analysis_selections FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_mark_sample_dirty();


--
-- Name: tags sample_stage4_tag_dictionary_dirty_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sample_stage4_tag_dictionary_dirty_trg AFTER UPDATE OF name, active, kind ON public.tags FOR EACH ROW EXECUTE FUNCTION public.sample_stage4_mark_tag_dictionary_dirty();


--
-- Name: samples samples_validate_current_analysis_version_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER samples_validate_current_analysis_version_trg BEFORE INSERT OR UPDATE OF current_analysis_version_id ON public.samples FOR EACH ROW EXECUTE FUNCTION public.samples_validate_current_analysis_version();


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
-- Name: component_retrieval_profiles component_retrieval_profiles_algorithm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_profiles
    ADD CONSTRAINT component_retrieval_profiles_algorithm_id_fkey FOREIGN KEY (algorithm_id) REFERENCES public.sample_retrieval_algorithms(id) ON DELETE RESTRICT;


--
-- Name: component_retrieval_profiles component_retrieval_profiles_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_profiles
    ADD CONSTRAINT component_retrieval_profiles_build_id_fkey FOREIGN KEY (build_id) REFERENCES public.sample_retrieval_builds(id) ON DELETE RESTRICT;


--
-- Name: component_retrieval_profiles component_retrieval_profiles_revision_dimension_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_profiles
    ADD CONSTRAINT component_retrieval_profiles_revision_dimension_fk FOREIGN KEY (revision_id, dimension_key) REFERENCES public.content_component_revisions(id, dimension_key) ON DELETE RESTRICT;


--
-- Name: component_retrieval_profiles component_retrieval_profiles_selection_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_profiles
    ADD CONSTRAINT component_retrieval_profiles_selection_fk FOREIGN KEY (component_id, selection_id, revision_id, approving_decision_id) REFERENCES public.content_component_selections(component_id, id, revision_id, decision_id) ON DELETE RESTRICT;


--
-- Name: component_retrieval_states component_retrieval_states_component_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_states
    ADD CONSTRAINT component_retrieval_states_component_id_fkey FOREIGN KEY (component_id) REFERENCES public.content_components(id) ON DELETE RESTRICT;


--
-- Name: component_retrieval_states component_retrieval_states_last_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_states
    ADD CONSTRAINT component_retrieval_states_last_build_id_fkey FOREIGN KEY (last_build_id) REFERENCES public.sample_retrieval_builds(id) ON DELETE RESTRICT;


--
-- Name: component_retrieval_states component_retrieval_states_last_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_states
    ADD CONSTRAINT component_retrieval_states_last_profile_id_fkey FOREIGN KEY (last_profile_id) REFERENCES public.component_retrieval_profiles(id) ON DELETE RESTRICT;


--
-- Name: component_retrieval_vectors component_retrieval_vectors_profile_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_retrieval_vectors
    ADD CONSTRAINT component_retrieval_vectors_profile_fk FOREIGN KEY (profile_id, component_id, selection_id, revision_id, approving_decision_id, dimension_key) REFERENCES public.component_retrieval_profiles(id, component_id, selection_id, revision_id, approving_decision_id, dimension_key) ON DELETE RESTRICT;


--
-- Name: content_component_lifecycle_events content_component_lifecycle_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_lifecycle_events
    ADD CONSTRAINT content_component_lifecycle_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: content_component_lifecycle_events content_component_lifecycle_events_component_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_lifecycle_events
    ADD CONSTRAINT content_component_lifecycle_events_component_id_fkey FOREIGN KEY (component_id) REFERENCES public.content_components(id) ON DELETE RESTRICT;


--
-- Name: content_component_revision_decisions content_component_revision_decisions_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_decisions
    ADD CONSTRAINT content_component_revision_decisions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: content_component_revision_decisions content_component_revision_decisions_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_decisions
    ADD CONSTRAINT content_component_revision_decisions_revision_fk FOREIGN KEY (component_id, revision_id) REFERENCES public.content_component_revisions(component_id, id) ON DELETE RESTRICT;


--
-- Name: content_component_revision_sources content_component_revision_sources_extraction_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_sources
    ADD CONSTRAINT content_component_revision_sources_extraction_fk FOREIGN KEY (extraction_id, extraction_dimension_key) REFERENCES public.sample_element_extractions(id, dimension_key) ON DELETE RESTRICT;


--
-- Name: content_component_revision_sources content_component_revision_sources_revision_dimension_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_sources
    ADD CONSTRAINT content_component_revision_sources_revision_dimension_fk FOREIGN KEY (revision_id, revision_dimension_key) REFERENCES public.content_component_revisions(id, dimension_key) ON DELETE RESTRICT;


--
-- Name: content_component_revision_sources content_component_revision_sources_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_sources
    ADD CONSTRAINT content_component_revision_sources_revision_fk FOREIGN KEY (component_id, revision_id) REFERENCES public.content_component_revisions(component_id, id) ON DELETE RESTRICT;


--
-- Name: content_component_revision_tags content_component_revision_tags_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_tags
    ADD CONSTRAINT content_component_revision_tags_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: content_component_revision_tags content_component_revision_tags_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_tags
    ADD CONSTRAINT content_component_revision_tags_revision_fk FOREIGN KEY (component_id, revision_id) REFERENCES public.content_component_revisions(component_id, id) ON DELETE RESTRICT;


--
-- Name: content_component_revision_tags content_component_revision_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revision_tags
    ADD CONSTRAINT content_component_revision_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE RESTRICT;


--
-- Name: content_component_revisions content_component_revisions_component_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revisions
    ADD CONSTRAINT content_component_revisions_component_id_fkey FOREIGN KEY (component_id) REFERENCES public.content_components(id) ON DELETE RESTRICT;


--
-- Name: content_component_revisions content_component_revisions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revisions
    ADD CONSTRAINT content_component_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: content_component_revisions content_component_revisions_dimension_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_revisions
    ADD CONSTRAINT content_component_revisions_dimension_key_fkey FOREIGN KEY (dimension_key) REFERENCES public.sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT;


--
-- Name: content_component_selections content_component_selections_decision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_selections
    ADD CONSTRAINT content_component_selections_decision_id_fkey FOREIGN KEY (decision_id) REFERENCES public.content_component_revision_decisions(id) ON DELETE RESTRICT;


--
-- Name: content_component_selections content_component_selections_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_selections
    ADD CONSTRAINT content_component_selections_revision_fk FOREIGN KEY (component_id, revision_id) REFERENCES public.content_component_revisions(component_id, id) ON DELETE RESTRICT;


--
-- Name: content_component_selections content_component_selections_selected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_component_selections
    ADD CONSTRAINT content_component_selections_selected_by_fkey FOREIGN KEY (selected_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: content_components content_components_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_components
    ADD CONSTRAINT content_components_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


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
-- Name: sample_analysis_elements sample_analysis_elements_dimension_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_elements
    ADD CONSTRAINT sample_analysis_elements_dimension_key_fkey FOREIGN KEY (dimension_key) REFERENCES public.sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_analysis_elements sample_analysis_elements_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_elements
    ADD CONSTRAINT sample_analysis_elements_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.sample_analysis_versions(id) ON DELETE RESTRICT;


--
-- Name: sample_analysis_jobs sample_analysis_jobs_capture_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_jobs
    ADD CONSTRAINT sample_analysis_jobs_capture_fk FOREIGN KEY (sample_id, source_capture_id) REFERENCES public.sample_captures(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_analysis_jobs sample_analysis_jobs_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_jobs
    ADD CONSTRAINT sample_analysis_jobs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_analysis_jobs sample_analysis_jobs_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_jobs
    ADD CONSTRAINT sample_analysis_jobs_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_analysis_selections sample_analysis_selections_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_selections
    ADD CONSTRAINT sample_analysis_selections_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_analysis_selections sample_analysis_selections_selected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_selections
    ADD CONSTRAINT sample_analysis_selections_selected_by_fkey FOREIGN KEY (selected_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_analysis_selections sample_analysis_selections_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_selections
    ADD CONSTRAINT sample_analysis_selections_version_fk FOREIGN KEY (sample_id, version_id) REFERENCES public.sample_analysis_versions(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_analysis_versions sample_analysis_versions_capture_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_versions
    ADD CONSTRAINT sample_analysis_versions_capture_fk FOREIGN KEY (sample_id, source_capture_id) REFERENCES public.sample_captures(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_analysis_versions sample_analysis_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_versions
    ADD CONSTRAINT sample_analysis_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_analysis_versions sample_analysis_versions_job_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_versions
    ADD CONSTRAINT sample_analysis_versions_job_fk FOREIGN KEY (sample_id, source_capture_id, job_id) REFERENCES public.sample_analysis_jobs(sample_id, source_capture_id, id) ON DELETE RESTRICT;


--
-- Name: sample_analysis_versions sample_analysis_versions_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_versions
    ADD CONSTRAINT sample_analysis_versions_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.sample_analysis_jobs(id) ON DELETE RESTRICT;


--
-- Name: sample_analysis_versions sample_analysis_versions_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_analysis_versions
    ADD CONSTRAINT sample_analysis_versions_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_assets sample_assets_capture_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_assets
    ADD CONSTRAINT sample_assets_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.sample_captures(id) ON DELETE SET NULL;


--
-- Name: sample_assets sample_assets_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_assets
    ADD CONSTRAINT sample_assets_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_assets sample_assets_uploaded_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_assets
    ADD CONSTRAINT sample_assets_uploaded_by_fk FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_captures sample_captures_created_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_captures
    ADD CONSTRAINT sample_captures_created_by_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_captures sample_captures_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_captures
    ADD CONSTRAINT sample_captures_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_cluster_jobs sample_cluster_jobs_algorithm_selection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_jobs
    ADD CONSTRAINT sample_cluster_jobs_algorithm_selection_id_fkey FOREIGN KEY (algorithm_selection_id) REFERENCES public.sample_retrieval_algorithm_selections(id) ON DELETE RESTRICT;


--
-- Name: sample_cluster_jobs sample_cluster_jobs_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_jobs
    ADD CONSTRAINT sample_cluster_jobs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_cluster_members sample_cluster_members_cluster_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_members
    ADD CONSTRAINT sample_cluster_members_cluster_fk FOREIGN KEY (run_id, cluster_id) REFERENCES public.sample_clusters(run_id, id) ON DELETE RESTRICT;


--
-- Name: sample_cluster_members sample_cluster_members_input_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_members
    ADD CONSTRAINT sample_cluster_members_input_fk FOREIGN KEY (run_id, sample_id, profile_id) REFERENCES public.sample_cluster_run_profiles(run_id, sample_id, profile_id) ON DELETE RESTRICT;


--
-- Name: sample_cluster_run_profiles sample_cluster_run_profiles_profile_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_run_profiles
    ADD CONSTRAINT sample_cluster_run_profiles_profile_fk FOREIGN KEY (profile_id, sample_id) REFERENCES public.sample_retrieval_profiles(id, sample_id) ON DELETE RESTRICT;


--
-- Name: sample_cluster_run_profiles sample_cluster_run_profiles_run_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_run_profiles
    ADD CONSTRAINT sample_cluster_run_profiles_run_fk FOREIGN KEY (run_id, algorithm_selection_id) REFERENCES public.sample_cluster_runs(id, algorithm_selection_id) ON DELETE RESTRICT;


--
-- Name: sample_cluster_runs sample_cluster_runs_algorithm_selection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_runs
    ADD CONSTRAINT sample_cluster_runs_algorithm_selection_id_fkey FOREIGN KEY (algorithm_selection_id) REFERENCES public.sample_retrieval_algorithm_selections(id) ON DELETE RESTRICT;


--
-- Name: sample_cluster_runs sample_cluster_runs_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_runs
    ADD CONSTRAINT sample_cluster_runs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.sample_cluster_jobs(id) ON DELETE RESTRICT;


--
-- Name: sample_cluster_selections sample_cluster_selections_run_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_selections
    ADD CONSTRAINT sample_cluster_selections_run_fk FOREIGN KEY (run_id, algorithm_selection_id) REFERENCES public.sample_cluster_runs(id, algorithm_selection_id) ON DELETE RESTRICT;


--
-- Name: sample_cluster_selections sample_cluster_selections_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_selections
    ADD CONSTRAINT sample_cluster_selections_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.sample_cluster_runs(id) ON DELETE RESTRICT;


--
-- Name: sample_cluster_selections sample_cluster_selections_selected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_cluster_selections
    ADD CONSTRAINT sample_cluster_selections_selected_by_fkey FOREIGN KEY (selected_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_clusters sample_clusters_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_clusters
    ADD CONSTRAINT sample_clusters_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.sample_cluster_runs(id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_assessment_jobs sample_comparison_assessment_jobs_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessment_jobs
    ADD CONSTRAINT sample_comparison_assessment_jobs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_comparison_assessment_jobs sample_comparison_assessment_jobs_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessment_jobs
    ADD CONSTRAINT sample_comparison_assessment_jobs_scope_fk FOREIGN KEY (comparison_id, scope_id) REFERENCES public.sample_comparison_scopes(comparison_id, id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_assessment_selections sample_comparison_assessment_selections_assessment_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessment_selections
    ADD CONSTRAINT sample_comparison_assessment_selections_assessment_fk FOREIGN KEY (comparison_id, assessment_id, target) REFERENCES public.sample_comparison_assessments(comparison_id, id, target) ON DELETE RESTRICT;


--
-- Name: sample_comparison_assessment_selections sample_comparison_assessment_selections_comparison_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessment_selections
    ADD CONSTRAINT sample_comparison_assessment_selections_comparison_id_fkey FOREIGN KEY (comparison_id) REFERENCES public.sample_comparisons(id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_assessment_selections sample_comparison_assessment_selections_selected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessment_selections
    ADD CONSTRAINT sample_comparison_assessment_selections_selected_by_fkey FOREIGN KEY (selected_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_comparison_assessments sample_comparison_assessments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessments
    ADD CONSTRAINT sample_comparison_assessments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_comparison_assessments sample_comparison_assessments_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessments
    ADD CONSTRAINT sample_comparison_assessments_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.sample_comparison_assessment_jobs(id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_assessments sample_comparison_assessments_job_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessments
    ADD CONSTRAINT sample_comparison_assessments_job_scope_fk FOREIGN KEY (job_id) REFERENCES public.sample_comparison_assessment_jobs(id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_assessments sample_comparison_assessments_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_assessments
    ADD CONSTRAINT sample_comparison_assessments_scope_fk FOREIGN KEY (comparison_id, scope_id) REFERENCES public.sample_comparison_scopes(comparison_id, id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_finding_evidence sample_comparison_finding_evidence_finding_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_finding_evidence
    ADD CONSTRAINT sample_comparison_finding_evidence_finding_fk FOREIGN KEY (assessment_id, finding_id, member_sample_id) REFERENCES public.sample_comparison_findings(assessment_id, id, member_sample_id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_finding_evidence sample_comparison_finding_evidence_snapshot_dimension_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_finding_evidence
    ADD CONSTRAINT sample_comparison_finding_evidence_snapshot_dimension_fk FOREIGN KEY (scope_id, member_sample_id, dimension_key) REFERENCES public.sample_comparison_snapshots(scope_id, sample_id, dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_comparison_finding_evidence sample_comparison_finding_evidence_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_finding_evidence
    ADD CONSTRAINT sample_comparison_finding_evidence_snapshot_fk FOREIGN KEY (scope_id, snapshot_id) REFERENCES public.sample_comparison_snapshots(scope_id, id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_finding_evidence sample_comparison_finding_evidence_snapshot_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_finding_evidence
    ADD CONSTRAINT sample_comparison_finding_evidence_snapshot_owner_fk FOREIGN KEY (scope_id, snapshot_id, member_sample_id, dimension_key) REFERENCES public.sample_comparison_snapshots(scope_id, id, sample_id, dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_comparison_findings sample_comparison_findings_assessment_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_findings
    ADD CONSTRAINT sample_comparison_findings_assessment_fk FOREIGN KEY (comparison_id, scope_id, assessment_id) REFERENCES public.sample_comparison_assessments(comparison_id, scope_id, id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_findings sample_comparison_findings_assessment_target_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_findings
    ADD CONSTRAINT sample_comparison_findings_assessment_target_fk FOREIGN KEY (comparison_id, assessment_id, target) REFERENCES public.sample_comparison_assessments(comparison_id, id, target) ON DELETE RESTRICT;


--
-- Name: sample_comparison_findings sample_comparison_findings_member_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_findings
    ADD CONSTRAINT sample_comparison_findings_member_fk FOREIGN KEY (scope_id, member_sample_id) REFERENCES public.sample_comparison_scope_members(scope_id, sample_id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_scope_members sample_comparison_scope_members_analysis_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scope_members
    ADD CONSTRAINT sample_comparison_scope_members_analysis_fk FOREIGN KEY (sample_id, analysis_version_id) REFERENCES public.sample_analysis_versions(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_scope_members sample_comparison_scope_members_metric_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scope_members
    ADD CONSTRAINT sample_comparison_scope_members_metric_fk FOREIGN KEY (sample_id, metric_snapshot_id) REFERENCES public.sample_metric_snapshots(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_scope_members sample_comparison_scope_members_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scope_members
    ADD CONSTRAINT sample_comparison_scope_members_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_scope_members sample_comparison_scope_members_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scope_members
    ADD CONSTRAINT sample_comparison_scope_members_scope_fk FOREIGN KEY (comparison_id, scope_id) REFERENCES public.sample_comparison_scopes(comparison_id, id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_scopes sample_comparison_scopes_comparison_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scopes
    ADD CONSTRAINT sample_comparison_scopes_comparison_id_fkey FOREIGN KEY (comparison_id) REFERENCES public.sample_comparisons(id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_scopes sample_comparison_scopes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_scopes
    ADD CONSTRAINT sample_comparison_scopes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_comparison_snapshots sample_comparison_snapshots_decision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_snapshots
    ADD CONSTRAINT sample_comparison_snapshots_decision_fk FOREIGN KEY (element_id, latest_decision_id) REFERENCES public.sample_element_decisions(element_id, id) ON DELETE RESTRICT;


--
-- Name: sample_comparison_snapshots sample_comparison_snapshots_dimension_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_snapshots
    ADD CONSTRAINT sample_comparison_snapshots_dimension_key_fkey FOREIGN KEY (dimension_key) REFERENCES public.sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_comparison_snapshots sample_comparison_snapshots_element_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_snapshots
    ADD CONSTRAINT sample_comparison_snapshots_element_fk FOREIGN KEY (analysis_version_id, element_id, dimension_key) REFERENCES public.sample_analysis_elements(version_id, id, dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_comparison_snapshots sample_comparison_snapshots_member_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparison_snapshots
    ADD CONSTRAINT sample_comparison_snapshots_member_fk FOREIGN KEY (comparison_id, scope_id, sample_id, analysis_version_id) REFERENCES public.sample_comparison_scope_members(comparison_id, scope_id, sample_id, analysis_version_id) ON DELETE RESTRICT;


--
-- Name: sample_comparisons sample_comparisons_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_comparisons
    ADD CONSTRAINT sample_comparisons_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_element_decisions sample_element_decisions_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_decisions
    ADD CONSTRAINT sample_element_decisions_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_element_decisions sample_element_decisions_element_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_decisions
    ADD CONSTRAINT sample_element_decisions_element_id_fkey FOREIGN KEY (element_id) REFERENCES public.sample_analysis_elements(id) ON DELETE RESTRICT;


--
-- Name: sample_element_evidence sample_element_evidence_element_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_evidence
    ADD CONSTRAINT sample_element_evidence_element_fk FOREIGN KEY (version_id, element_id) REFERENCES public.sample_analysis_elements(version_id, id) ON DELETE RESTRICT;


--
-- Name: sample_element_evidence sample_element_evidence_source_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_evidence
    ADD CONSTRAINT sample_element_evidence_source_fk FOREIGN KEY (version_id, source_id) REFERENCES public.sample_evidence_sources(version_id, source_id) ON DELETE RESTRICT;


--
-- Name: sample_element_extraction_sources sample_element_extraction_sources_extraction_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extraction_sources
    ADD CONSTRAINT sample_element_extraction_sources_extraction_fk FOREIGN KEY (extraction_id, extraction_dimension_key) REFERENCES public.sample_element_extractions(id, dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_element_extraction_sources sample_element_extraction_sources_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extraction_sources
    ADD CONSTRAINT sample_element_extraction_sources_scope_fk FOREIGN KEY (comparison_id, scope_id, extraction_id) REFERENCES public.sample_element_extractions(comparison_id, scope_id, id) ON DELETE RESTRICT;


--
-- Name: sample_element_extraction_sources sample_element_extraction_sources_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extraction_sources
    ADD CONSTRAINT sample_element_extraction_sources_snapshot_fk FOREIGN KEY (scope_id, snapshot_id) REFERENCES public.sample_comparison_snapshots(scope_id, id) ON DELETE RESTRICT;


--
-- Name: sample_element_extraction_sources sample_element_extraction_sources_snapshot_identity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extraction_sources
    ADD CONSTRAINT sample_element_extraction_sources_snapshot_identity_fk FOREIGN KEY (scope_id, sample_id, snapshot_dimension_key) REFERENCES public.sample_comparison_snapshots(scope_id, sample_id, dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_element_extraction_sources sample_element_extraction_sources_snapshot_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extraction_sources
    ADD CONSTRAINT sample_element_extraction_sources_snapshot_owner_fk FOREIGN KEY (scope_id, snapshot_id, sample_id, snapshot_dimension_key) REFERENCES public.sample_comparison_snapshots(scope_id, id, sample_id, dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_element_extractions sample_element_extractions_assessment_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extractions
    ADD CONSTRAINT sample_element_extractions_assessment_fk FOREIGN KEY (comparison_id, scope_id, assessment_id) REFERENCES public.sample_comparison_assessments(comparison_id, scope_id, id) ON DELETE RESTRICT;


--
-- Name: sample_element_extractions sample_element_extractions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extractions
    ADD CONSTRAINT sample_element_extractions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_element_extractions sample_element_extractions_dimension_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extractions
    ADD CONSTRAINT sample_element_extractions_dimension_key_fkey FOREIGN KEY (dimension_key) REFERENCES public.sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_element_extractions sample_element_extractions_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_extractions
    ADD CONSTRAINT sample_element_extractions_scope_fk FOREIGN KEY (comparison_id, scope_id) REFERENCES public.sample_comparison_scopes(comparison_id, id) ON DELETE RESTRICT;


--
-- Name: sample_element_tag_observations sample_element_tag_observations_element_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tag_observations
    ADD CONSTRAINT sample_element_tag_observations_element_fk FOREIGN KEY (analysis_version_id, element_id, dimension_key) REFERENCES public.sample_analysis_elements(version_id, id, dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_element_tag_observations sample_element_tag_observations_observed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tag_observations
    ADD CONSTRAINT sample_element_tag_observations_observed_by_fkey FOREIGN KEY (observed_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: sample_element_tag_observations sample_element_tag_observations_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tag_observations
    ADD CONSTRAINT sample_element_tag_observations_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE RESTRICT;


--
-- Name: sample_element_tag_observations sample_element_tag_observations_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tag_observations
    ADD CONSTRAINT sample_element_tag_observations_version_fk FOREIGN KEY (sample_id, analysis_version_id) REFERENCES public.sample_analysis_versions(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_element_tags sample_element_tags_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tags
    ADD CONSTRAINT sample_element_tags_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_element_tags sample_element_tags_element_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tags
    ADD CONSTRAINT sample_element_tags_element_fk FOREIGN KEY (version_id, element_id, dimension_key) REFERENCES public.sample_analysis_elements(version_id, id, dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_element_tags sample_element_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_element_tags
    ADD CONSTRAINT sample_element_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE RESTRICT;


--
-- Name: sample_evaluations sample_evaluations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evaluations
    ADD CONSTRAINT sample_evaluations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_evaluations sample_evaluations_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evaluations
    ADD CONSTRAINT sample_evaluations_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_evaluations sample_evaluations_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evaluations
    ADD CONSTRAINT sample_evaluations_version_fk FOREIGN KEY (sample_id, analysis_version_id) REFERENCES public.sample_analysis_versions(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_evidence_sources sample_evidence_sources_asset_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evidence_sources
    ADD CONSTRAINT sample_evidence_sources_asset_fk FOREIGN KEY (sample_id, asset_id) REFERENCES public.sample_assets(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_evidence_sources sample_evidence_sources_capture_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evidence_sources
    ADD CONSTRAINT sample_evidence_sources_capture_fk FOREIGN KEY (sample_id, source_capture_id) REFERENCES public.sample_captures(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_evidence_sources sample_evidence_sources_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evidence_sources
    ADD CONSTRAINT sample_evidence_sources_version_fk FOREIGN KEY (sample_id, version_id) REFERENCES public.sample_analysis_versions(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_evidence_sources sample_evidence_sources_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_evidence_sources
    ADD CONSTRAINT sample_evidence_sources_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.sample_analysis_versions(id) ON DELETE RESTRICT;


--
-- Name: sample_insight_run_features sample_insight_run_features_element_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_features
    ADD CONSTRAINT sample_insight_run_features_element_fk FOREIGN KEY (analysis_version_id, element_id, dimension_key) REFERENCES public.sample_analysis_elements(version_id, id, dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_insight_run_features sample_insight_run_features_element_tag_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_features
    ADD CONSTRAINT sample_insight_run_features_element_tag_fk FOREIGN KEY (element_tag_id, analysis_version_id, element_id, dimension_key, tag_id) REFERENCES public.sample_element_tags(id, version_id, element_id, dimension_key, tag_id) ON DELETE RESTRICT;


--
-- Name: sample_insight_run_features sample_insight_run_features_member_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_features
    ADD CONSTRAINT sample_insight_run_features_member_fk FOREIGN KEY (run_id, member_id, sample_id, analysis_version_id) REFERENCES public.sample_insight_run_members(run_id, id, sample_id, analysis_version_id) ON DELETE RESTRICT;


--
-- Name: sample_insight_run_features sample_insight_run_features_observation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_features
    ADD CONSTRAINT sample_insight_run_features_observation_fk FOREIGN KEY (observation_id, sample_id, analysis_version_id, element_id, dimension_key, tag_id) REFERENCES public.sample_element_tag_observations(id, sample_id, analysis_version_id, element_id, dimension_key, tag_id) ON DELETE RESTRICT;


--
-- Name: sample_insight_run_features sample_insight_run_features_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_features
    ADD CONSTRAINT sample_insight_run_features_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE RESTRICT;


--
-- Name: sample_insight_run_members sample_insight_run_members_metric_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_members
    ADD CONSTRAINT sample_insight_run_members_metric_fk FOREIGN KEY (sample_id, metric_snapshot_id) REFERENCES public.sample_metric_snapshots(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_insight_run_members sample_insight_run_members_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_members
    ADD CONSTRAINT sample_insight_run_members_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.sample_insight_runs(id) ON DELETE RESTRICT;


--
-- Name: sample_insight_run_members sample_insight_run_members_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_run_members
    ADD CONSTRAINT sample_insight_run_members_version_fk FOREIGN KEY (sample_id, analysis_version_id) REFERENCES public.sample_analysis_versions(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_insight_runs sample_insight_runs_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_runs
    ADD CONSTRAINT sample_insight_runs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_insight_statistics sample_insight_statistics_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_insight_statistics
    ADD CONSTRAINT sample_insight_statistics_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.sample_insight_runs(id) ON DELETE RESTRICT;


--
-- Name: sample_metric_snapshots sample_metric_snapshots_capture_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_metric_snapshots
    ADD CONSTRAINT sample_metric_snapshots_capture_fk FOREIGN KEY (sample_id, capture_id) REFERENCES public.sample_captures(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_metric_snapshots sample_metric_snapshots_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_metric_snapshots
    ADD CONSTRAINT sample_metric_snapshots_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_metric_snapshots sample_metric_snapshots_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_metric_snapshots
    ADD CONSTRAINT sample_metric_snapshots_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_relation_events sample_relation_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_events
    ADD CONSTRAINT sample_relation_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_relation_events sample_relation_events_relation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_events
    ADD CONSTRAINT sample_relation_events_relation_id_fkey FOREIGN KEY (relation_id) REFERENCES public.sample_relations(id) ON DELETE RESTRICT;


--
-- Name: sample_relation_events sample_relation_events_superseded_by_relation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_events
    ADD CONSTRAINT sample_relation_events_superseded_by_relation_id_fkey FOREIGN KEY (superseded_by_relation_id) REFERENCES public.sample_relations(id) ON DELETE RESTRICT;


--
-- Name: sample_relation_evidence sample_relation_evidence_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_evidence
    ADD CONSTRAINT sample_relation_evidence_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_relation_evidence sample_relation_evidence_endpoint_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_evidence
    ADD CONSTRAINT sample_relation_evidence_endpoint_version_fk FOREIGN KEY (endpoint_sample_id, endpoint_analysis_version_id) REFERENCES public.sample_analysis_versions(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_relation_evidence sample_relation_evidence_relation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_evidence
    ADD CONSTRAINT sample_relation_evidence_relation_fk FOREIGN KEY (relation_id, subject_sample_id, subject_analysis_version_id, object_sample_id, object_analysis_version_id) REFERENCES public.sample_relations(id, subject_sample_id, subject_analysis_version_id, object_sample_id, object_analysis_version_id) ON DELETE RESTRICT;


--
-- Name: sample_relation_evidence sample_relation_evidence_verified_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relation_evidence
    ADD CONSTRAINT sample_relation_evidence_verified_fk FOREIGN KEY (endpoint_analysis_version_id, element_evidence_id) REFERENCES public.sample_element_evidence(version_id, id) ON DELETE RESTRICT;


--
-- Name: sample_relations sample_relations_object_analysis_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relations
    ADD CONSTRAINT sample_relations_object_analysis_fk FOREIGN KEY (object_sample_id, object_analysis_version_id) REFERENCES public.sample_analysis_versions(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_relations sample_relations_object_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relations
    ADD CONSTRAINT sample_relations_object_sample_id_fkey FOREIGN KEY (object_sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_relations sample_relations_proposed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relations
    ADD CONSTRAINT sample_relations_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_relations sample_relations_subject_analysis_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relations
    ADD CONSTRAINT sample_relations_subject_analysis_fk FOREIGN KEY (subject_sample_id, subject_analysis_version_id) REFERENCES public.sample_analysis_versions(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_relations sample_relations_subject_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_relations
    ADD CONSTRAINT sample_relations_subject_sample_id_fkey FOREIGN KEY (subject_sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_algorithm_selections sample_retrieval_algorithm_selections_algorithm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_algorithm_selections
    ADD CONSTRAINT sample_retrieval_algorithm_selections_algorithm_id_fkey FOREIGN KEY (algorithm_id) REFERENCES public.sample_retrieval_algorithms(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_algorithm_selections sample_retrieval_algorithm_selections_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_algorithm_selections
    ADD CONSTRAINT sample_retrieval_algorithm_selections_build_id_fkey FOREIGN KEY (build_id) REFERENCES public.sample_retrieval_builds(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_algorithm_selections sample_retrieval_algorithm_selections_selected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_algorithm_selections
    ADD CONSTRAINT sample_retrieval_algorithm_selections_selected_by_fkey FOREIGN KEY (selected_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_retrieval_build_items sample_retrieval_build_items_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_build_items
    ADD CONSTRAINT sample_retrieval_build_items_build_id_fkey FOREIGN KEY (build_id) REFERENCES public.sample_retrieval_builds(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_build_items sample_retrieval_build_items_component_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_build_items
    ADD CONSTRAINT sample_retrieval_build_items_component_id_fkey FOREIGN KEY (component_id) REFERENCES public.content_components(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_build_items sample_retrieval_build_items_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_build_items
    ADD CONSTRAINT sample_retrieval_build_items_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_builds sample_retrieval_builds_algorithm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_builds
    ADD CONSTRAINT sample_retrieval_builds_algorithm_id_fkey FOREIGN KEY (algorithm_id) REFERENCES public.sample_retrieval_algorithms(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_builds sample_retrieval_builds_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_builds
    ADD CONSTRAINT sample_retrieval_builds_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sample_retrieval_profiles sample_retrieval_profiles_algorithm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_profiles
    ADD CONSTRAINT sample_retrieval_profiles_algorithm_id_fkey FOREIGN KEY (algorithm_id) REFERENCES public.sample_retrieval_algorithms(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_profiles sample_retrieval_profiles_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_profiles
    ADD CONSTRAINT sample_retrieval_profiles_build_id_fkey FOREIGN KEY (build_id) REFERENCES public.sample_retrieval_builds(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_profiles sample_retrieval_profiles_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_profiles
    ADD CONSTRAINT sample_retrieval_profiles_version_fk FOREIGN KEY (sample_id, analysis_version_id) REFERENCES public.sample_analysis_versions(sample_id, id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_states sample_retrieval_states_last_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_states
    ADD CONSTRAINT sample_retrieval_states_last_build_id_fkey FOREIGN KEY (last_build_id) REFERENCES public.sample_retrieval_builds(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_states sample_retrieval_states_last_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_states
    ADD CONSTRAINT sample_retrieval_states_last_profile_id_fkey FOREIGN KEY (last_profile_id) REFERENCES public.sample_retrieval_profiles(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_states sample_retrieval_states_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_states
    ADD CONSTRAINT sample_retrieval_states_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.samples(id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_dimension_vectors sample_retrieval_vectors_decision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_dimension_vectors
    ADD CONSTRAINT sample_retrieval_vectors_decision_fk FOREIGN KEY (element_id, decision_id) REFERENCES public.sample_element_decisions(element_id, id) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_dimension_vectors sample_retrieval_vectors_element_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_dimension_vectors
    ADD CONSTRAINT sample_retrieval_vectors_element_fk FOREIGN KEY (analysis_version_id, element_id, dimension_key) REFERENCES public.sample_analysis_elements(version_id, id, dimension_key) ON DELETE RESTRICT;


--
-- Name: sample_retrieval_dimension_vectors sample_retrieval_vectors_profile_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_retrieval_dimension_vectors
    ADD CONSTRAINT sample_retrieval_vectors_profile_fk FOREIGN KEY (profile_id, sample_id, analysis_version_id) REFERENCES public.sample_retrieval_profiles(id, sample_id, analysis_version_id) ON DELETE RESTRICT;


--
-- Name: sample_stage3_idempotency sample_stage3_idempotency_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_stage3_idempotency
    ADD CONSTRAINT sample_stage3_idempotency_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: samples samples_created_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.samples
    ADD CONSTRAINT samples_created_by_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: samples samples_current_analysis_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.samples
    ADD CONSTRAINT samples_current_analysis_version_fk FOREIGN KEY (id, current_analysis_version_id) REFERENCES public.sample_analysis_versions(sample_id, id) ON DELETE RESTRICT;


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
-- Name: works works_sample_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.works
    ADD CONSTRAINT works_sample_id_fk FOREIGN KEY (sample_id) REFERENCES public.samples(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict A5FjEAK8hdAWbaedPCvdPNXSw5SdkGGu0rktNNd6Kg0h4EVlbKIHVcJXBuR8IBz

