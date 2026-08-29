-- IdeaHub sample library, stage 3.
-- Additive and safe to run repeatedly. Run after Stage 1 and Stage 2 migrations.
-- Existing Stage 1/2 rows are not rewritten.

BEGIN;

-- Composite identities needed by the Stage 3 ownership graph.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_element_decisions_element_id_id_uk'
    AND conrelid='sample_element_decisions'::regclass) THEN
    ALTER TABLE sample_element_decisions ADD CONSTRAINT sample_element_decisions_element_id_id_uk UNIQUE(element_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_element_evidence_version_id_id_uk'
    AND conrelid='sample_element_evidence'::regclass) THEN
    ALTER TABLE sample_element_evidence ADD CONSTRAINT sample_element_evidence_version_id_id_uk UNIQUE(version_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_metric_snapshots_sample_id_id_uk'
    AND conrelid='sample_metric_snapshots'::regclass) THEN
    ALTER TABLE sample_metric_snapshots ADD CONSTRAINT sample_metric_snapshots_sample_id_id_uk UNIQUE(sample_id,id);
  END IF;
END $$;

-- One retry contract for every Stage 3 mutating HTTP action.
CREATE TABLE IF NOT EXISTS sample_stage3_idempotency (
  id                BIGSERIAL PRIMARY KEY,
  aggregate_key     TEXT NOT NULL,
  action             TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  request_sha256     TEXT NOT NULL,
  response_kind      TEXT,
  response_id        BIGINT,
  response_status    SMALLINT,
  created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_stage3_idempotency_aggregate_chk CHECK (char_length(aggregate_key) BETWEEN 1 AND 160),
  CONSTRAINT sample_stage3_idempotency_action_chk CHECK (char_length(action) BETWEEN 1 AND 80),
  CONSTRAINT sample_stage3_idempotency_key_chk CHECK (char_length(idempotency_key) BETWEEN 1 AND 160),
  CONSTRAINT sample_stage3_idempotency_hash_chk CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_stage3_idempotency_status_chk CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 299),
  CONSTRAINT sample_stage3_idempotency_identity_uk UNIQUE(aggregate_key,action,idempotency_key)
);

CREATE TABLE IF NOT EXISTS sample_comparisons (
  id                BIGSERIAL PRIMARY KEY,
  title             TEXT NOT NULL,
  purpose           TEXT,
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparisons_title_chk CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT sample_comparisons_purpose_chk CHECK (purpose IS NULL OR char_length(purpose) <= 4000)
);
CREATE INDEX IF NOT EXISTS sample_comparisons_created_idx ON sample_comparisons(created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS sample_comparison_scopes (
  id                BIGSERIAL PRIMARY KEY,
  comparison_id     BIGINT NOT NULL REFERENCES sample_comparisons(id) ON DELETE RESTRICT,
  revision          INT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'building',
  topic_basis       TEXT NOT NULL,
  purpose           TEXT,
  input_sha256      TEXT NOT NULL,
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  CONSTRAINT sample_comparison_scopes_revision_chk CHECK (revision > 0),
  CONSTRAINT sample_comparison_scopes_status_chk CHECK (status IN ('building','complete')),
  CONSTRAINT sample_comparison_scopes_topic_chk CHECK (char_length(topic_basis) BETWEEN 1 AND 160),
  CONSTRAINT sample_comparison_scopes_purpose_chk CHECK (purpose IS NULL OR char_length(purpose) <= 4000),
  CONSTRAINT sample_comparison_scopes_hash_chk CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_comparison_scopes_completion_chk CHECK (
    (status='building' AND completed_at IS NULL) OR (status='complete' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT sample_comparison_scopes_comparison_revision_uk UNIQUE(comparison_id,revision),
  CONSTRAINT sample_comparison_scopes_comparison_id_id_uk UNIQUE(comparison_id,id)
);
CREATE INDEX IF NOT EXISTS sample_comparison_scopes_project_idx
  ON sample_comparison_scopes(comparison_id,revision DESC,id DESC);

CREATE TABLE IF NOT EXISTS sample_comparison_scope_members (
  id                    BIGSERIAL PRIMARY KEY,
  comparison_id         BIGINT NOT NULL,
  scope_id              BIGINT NOT NULL,
  sample_id             BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  analysis_version_id   BIGINT NOT NULL,
  ordinal               SMALLINT NOT NULL,
  frozen_title          TEXT NOT NULL,
  frozen_account_name   TEXT,
  frozen_account_handle TEXT,
  frozen_platform       TEXT NOT NULL,
  frozen_published_at   TIMESTAMPTZ,
  metric_snapshot_id    BIGINT,
  frozen_metric_observed_at TIMESTAMPTZ,
  observation_window_seconds BIGINT,
  frozen_metrics        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_scope_members_scope_fk FOREIGN KEY(comparison_id,scope_id)
    REFERENCES sample_comparison_scopes(comparison_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_scope_members_analysis_fk FOREIGN KEY(sample_id,analysis_version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_scope_members_metric_fk FOREIGN KEY(sample_id,metric_snapshot_id)
    REFERENCES sample_metric_snapshots(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_scope_members_ordinal_chk CHECK (ordinal BETWEEN 1 AND 6),
  CONSTRAINT sample_comparison_scope_members_title_chk CHECK (char_length(frozen_title) BETWEEN 1 AND 500),
  CONSTRAINT sample_comparison_scope_members_window_chk CHECK (observation_window_seconds IS NULL OR observation_window_seconds >= 0),
  CONSTRAINT sample_comparison_scope_members_metrics_chk CHECK (jsonb_typeof(frozen_metrics)='object'),
  CONSTRAINT sample_comparison_scope_members_scope_ordinal_uk UNIQUE(scope_id,ordinal),
  CONSTRAINT sample_comparison_scope_members_scope_sample_uk UNIQUE(scope_id,sample_id),
  CONSTRAINT sample_comparison_scope_members_owner_uk UNIQUE(comparison_id,scope_id,sample_id,analysis_version_id),
  CONSTRAINT sample_comparison_scope_members_scope_id_id_uk UNIQUE(scope_id,id)
);
CREATE INDEX IF NOT EXISTS sample_comparison_scope_members_sample_idx
  ON sample_comparison_scope_members(sample_id,scope_id);

CREATE TABLE IF NOT EXISTS sample_comparison_snapshots (
  id                    BIGSERIAL PRIMARY KEY,
  comparison_id         BIGINT NOT NULL,
  scope_id              BIGINT NOT NULL,
  sample_id             BIGINT NOT NULL,
  analysis_version_id   BIGINT NOT NULL,
  element_id            BIGINT NOT NULL,
  dimension_key         TEXT NOT NULL REFERENCES sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT,
  latest_decision_id    BIGINT,
  effective_state       TEXT NOT NULL,
  effective_value       JSONB,
  function_text         TEXT,
  applicability         TEXT,
  limitations           TEXT,
  evidence_state        TEXT NOT NULL,
  evidence_tokens       JSONB NOT NULL DEFAULT '[]'::jsonb,
  value_sha256          TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_snapshots_member_fk FOREIGN KEY(comparison_id,scope_id,sample_id,analysis_version_id)
    REFERENCES sample_comparison_scope_members(comparison_id,scope_id,sample_id,analysis_version_id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_snapshots_element_fk FOREIGN KEY(analysis_version_id,element_id,dimension_key)
    REFERENCES sample_analysis_elements(version_id,id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_snapshots_decision_fk FOREIGN KEY(element_id,latest_decision_id)
    REFERENCES sample_element_decisions(element_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_snapshots_state_chk CHECK (effective_state IN ('value','insufficient','not_applicable','rejected')),
  CONSTRAINT sample_comparison_snapshots_value_chk CHECK (
    (effective_state='value' AND effective_value IS NOT NULL AND effective_value <> 'null'::jsonb) OR
    (effective_state<>'value' AND effective_value IS NULL)
  ),
  CONSTRAINT sample_comparison_snapshots_evidence_state_chk CHECK (evidence_state IN ('verified','manual_unverified','insufficient')),
  CONSTRAINT sample_comparison_snapshots_tokens_chk CHECK (jsonb_typeof(evidence_tokens)='array' AND jsonb_array_length(evidence_tokens) <= 20),
  CONSTRAINT sample_comparison_snapshots_hash_chk CHECK (value_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_comparison_snapshots_scope_dimension_uk UNIQUE(scope_id,sample_id,dimension_key),
  CONSTRAINT sample_comparison_snapshots_owner_uk UNIQUE(comparison_id,scope_id,id,dimension_key),
  CONSTRAINT sample_comparison_snapshots_scope_id_id_uk UNIQUE(scope_id,id),
  CONSTRAINT sample_comparison_snapshots_scope_row_identity_uk UNIQUE(scope_id,id,sample_id,dimension_key)
);
CREATE INDEX IF NOT EXISTS sample_comparison_snapshots_dimension_idx
  ON sample_comparison_snapshots(scope_id,dimension_key,sample_id);

-- Four independent comparison targets and their append-only versions.
CREATE TABLE IF NOT EXISTS sample_comparison_assessment_jobs (
  id                BIGSERIAL PRIMARY KEY,
  comparison_id     BIGINT NOT NULL,
  scope_id          BIGINT NOT NULL,
  target            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued',
  request_sha256    TEXT NOT NULL,
  attempts          SMALLINT NOT NULL DEFAULT 0,
  max_attempts      SMALLINT NOT NULL DEFAULT 3,
  provider          TEXT NOT NULL,
  model_name        TEXT NOT NULL,
  lease_owner       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  heartbeat_at      TIMESTAMPTZ,
  error_code        TEXT,
  error_message     TEXT,
  requested_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  CONSTRAINT sample_comparison_assessment_jobs_scope_fk FOREIGN KEY(comparison_id,scope_id)
    REFERENCES sample_comparison_scopes(comparison_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_assessment_jobs_target_chk CHECK (target IN ('traffic','persona','expertise','conversion')),
  CONSTRAINT sample_comparison_assessment_jobs_status_chk CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT sample_comparison_assessment_jobs_hash_chk CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_comparison_assessment_jobs_attempts_chk CHECK (attempts BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 20),
  CONSTRAINT sample_comparison_assessment_jobs_error_chk CHECK (error_message IS NULL OR char_length(error_message) <= 400)
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_comparison_assessment_jobs_one_scope_target_active_uidx
  ON sample_comparison_assessment_jobs(scope_id,target) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS sample_comparison_assessment_jobs_one_running_uidx
  ON sample_comparison_assessment_jobs((true)) WHERE status='running';
CREATE INDEX IF NOT EXISTS sample_comparison_assessment_jobs_queue_idx
  ON sample_comparison_assessment_jobs(status,created_at,id);

CREATE TABLE IF NOT EXISTS sample_comparison_assessments (
  id                  BIGSERIAL PRIMARY KEY,
  comparison_id       BIGINT NOT NULL,
  scope_id            BIGINT NOT NULL,
  job_id              BIGINT REFERENCES sample_comparison_assessment_jobs(id) ON DELETE RESTRICT,
  target              TEXT NOT NULL,
  source              TEXT NOT NULL,
  revision            INT NOT NULL,
  common_points       JSONB NOT NULL DEFAULT '[]'::jsonb,
  key_differences     JSONB NOT NULL DEFAULT '[]'::jsonb,
  strengths           JSONB NOT NULL DEFAULT '[]'::jsonb,
  limitations         JSONB NOT NULL DEFAULT '[]'::jsonb,
  worth_learning      JSONB NOT NULL DEFAULT '[]'::jsonb,
  do_not_copy         JSONB NOT NULL DEFAULT '[]'::jsonb,
  hypotheses          JSONB NOT NULL DEFAULT '[]'::jsonb,
  open_questions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  method_limitations  JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_sha256        TEXT NOT NULL,
  schema_version      TEXT NOT NULL,
  prompt_version      TEXT,
  model_provider      TEXT,
  model_name          TEXT,
  created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_assessments_scope_fk FOREIGN KEY(comparison_id,scope_id)
    REFERENCES sample_comparison_scopes(comparison_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_assessments_job_scope_fk FOREIGN KEY(job_id)
    REFERENCES sample_comparison_assessment_jobs(id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_assessments_target_chk CHECK (target IN ('traffic','persona','expertise','conversion')),
  CONSTRAINT sample_comparison_assessments_source_chk CHECK (source IN ('manual','ai')),
  CONSTRAINT sample_comparison_assessments_revision_chk CHECK (revision > 0),
  CONSTRAINT sample_comparison_assessments_arrays_chk CHECK (
    jsonb_typeof(common_points)='array' AND jsonb_typeof(key_differences)='array' AND
    jsonb_typeof(strengths)='array' AND jsonb_typeof(limitations)='array' AND
    jsonb_typeof(worth_learning)='array' AND jsonb_typeof(do_not_copy)='array' AND
    jsonb_typeof(hypotheses)='array' AND jsonb_typeof(open_questions)='array' AND
    jsonb_typeof(method_limitations)='array'
  ),
  CONSTRAINT sample_comparison_assessments_hash_chk CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_comparison_assessments_ai_metadata_chk CHECK (
    (source='manual' AND job_id IS NULL AND prompt_version IS NULL AND model_provider IS NULL AND model_name IS NULL) OR
    (source='ai' AND job_id IS NOT NULL AND prompt_version IS NOT NULL AND model_provider IS NOT NULL AND model_name IS NOT NULL)
  ),
  CONSTRAINT sample_comparison_assessments_project_target_revision_uk UNIQUE(comparison_id,target,revision),
  CONSTRAINT sample_comparison_assessments_owner_uk UNIQUE(comparison_id,scope_id,id),
  CONSTRAINT sample_comparison_assessments_project_id_target_uk UNIQUE(comparison_id,id,target)
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_comparison_assessments_job_uidx
  ON sample_comparison_assessments(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_comparison_assessments_history_idx
  ON sample_comparison_assessments(comparison_id,target,revision DESC,id DESC);

CREATE TABLE IF NOT EXISTS sample_comparison_findings (
  id                BIGSERIAL PRIMARY KEY,
  comparison_id     BIGINT NOT NULL,
  scope_id          BIGINT NOT NULL,
  assessment_id     BIGINT NOT NULL,
  target            TEXT NOT NULL,
  member_sample_id  BIGINT,
  kind              TEXT NOT NULL,
  claim_text        TEXT NOT NULL,
  limitations       TEXT,
  evidence_state    TEXT NOT NULL,
  ordinal           SMALLINT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_findings_assessment_fk FOREIGN KEY(comparison_id,scope_id,assessment_id)
    REFERENCES sample_comparison_assessments(comparison_id,scope_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_findings_assessment_target_fk FOREIGN KEY(comparison_id,assessment_id,target)
    REFERENCES sample_comparison_assessments(comparison_id,id,target) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_findings_member_fk FOREIGN KEY(scope_id,member_sample_id)
    REFERENCES sample_comparison_scope_members(scope_id,sample_id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_findings_kind_chk CHECK (kind IN ('observation','hypothesis','recommendation')),
  CONSTRAINT sample_comparison_findings_claim_chk CHECK (char_length(claim_text) BETWEEN 1 AND 4000),
  CONSTRAINT sample_comparison_findings_hypothesis_chk CHECK (kind<>'hypothesis' OR char_length(COALESCE(limitations,'')) BETWEEN 1 AND 12000),
  CONSTRAINT sample_comparison_findings_evidence_chk CHECK (evidence_state IN ('verified','manual_unverified','insufficient')),
  CONSTRAINT sample_comparison_findings_ordinal_chk CHECK (ordinal BETWEEN 1 AND 60),
  CONSTRAINT sample_comparison_findings_order_uk UNIQUE(assessment_id,ordinal),
  CONSTRAINT sample_comparison_findings_owner_uk UNIQUE(assessment_id,id,member_sample_id)
);

CREATE TABLE IF NOT EXISTS sample_comparison_finding_evidence (
  id                BIGSERIAL PRIMARY KEY,
  assessment_id     BIGINT NOT NULL,
  finding_id        BIGINT NOT NULL,
  member_sample_id  BIGINT NOT NULL,
  scope_id          BIGINT NOT NULL,
  snapshot_id       BIGINT NOT NULL,
  dimension_key     TEXT NOT NULL,
  evidence_token    TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_finding_evidence_finding_fk FOREIGN KEY(assessment_id,finding_id,member_sample_id)
    REFERENCES sample_comparison_findings(assessment_id,id,member_sample_id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_finding_evidence_snapshot_fk FOREIGN KEY(scope_id,snapshot_id)
    REFERENCES sample_comparison_snapshots(scope_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_finding_evidence_snapshot_dimension_fk FOREIGN KEY(scope_id,member_sample_id,dimension_key)
    REFERENCES sample_comparison_snapshots(scope_id,sample_id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_finding_evidence_snapshot_owner_fk FOREIGN KEY(scope_id,snapshot_id,member_sample_id,dimension_key)
    REFERENCES sample_comparison_snapshots(scope_id,id,sample_id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_finding_evidence_token_chk CHECK (char_length(evidence_token) BETWEEN 1 AND 160),
  CONSTRAINT sample_comparison_finding_evidence_identity_uk UNIQUE(finding_id,snapshot_id,evidence_token)
);

CREATE TABLE IF NOT EXISTS sample_comparison_assessment_selections (
  id                BIGSERIAL PRIMARY KEY,
  comparison_id     BIGINT NOT NULL REFERENCES sample_comparisons(id) ON DELETE RESTRICT,
  target            TEXT NOT NULL,
  assessment_id     BIGINT NOT NULL,
  reason            TEXT,
  selected_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_assessment_selections_assessment_fk FOREIGN KEY(comparison_id,assessment_id,target)
    REFERENCES sample_comparison_assessments(comparison_id,id,target) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_assessment_selections_target_chk CHECK (target IN ('traffic','persona','expertise','conversion')),
  CONSTRAINT sample_comparison_assessment_selections_reason_chk CHECK (reason IS NULL OR char_length(reason) <= 4000)
);
CREATE INDEX IF NOT EXISTS sample_comparison_assessment_selections_current_idx
  ON sample_comparison_assessment_selections(comparison_id,target,id DESC);

-- Pinned, reviewable sample relations.
CREATE TABLE IF NOT EXISTS sample_relations (
  id                    BIGSERIAL PRIMARY KEY,
  relation_type         TEXT NOT NULL,
  subject_sample_id     BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  subject_analysis_version_id BIGINT NOT NULL,
  object_sample_id      BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  object_analysis_version_id BIGINT NOT NULL,
  origin                TEXT NOT NULL,
  current_state         TEXT NOT NULL DEFAULT 'proposed',
  rationale             TEXT,
  proposed_by           BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_relations_subject_analysis_fk FOREIGN KEY(subject_sample_id,subject_analysis_version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_relations_object_analysis_fk FOREIGN KEY(object_sample_id,object_analysis_version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_relations_type_chk CHECK (relation_type IN ('citation','imitation','evolution','variant')),
  CONSTRAINT sample_relations_origin_chk CHECK (origin IN ('manual','ai')),
  CONSTRAINT sample_relations_state_chk CHECK (current_state IN ('proposed','confirmed','rejected','withdrawn','superseded')),
  CONSTRAINT sample_relations_self_chk CHECK (subject_sample_id <> object_sample_id),
  CONSTRAINT sample_relations_variant_canonical_chk CHECK (relation_type<>'variant' OR subject_sample_id<object_sample_id),
  CONSTRAINT sample_relations_rationale_chk CHECK (rationale IS NULL OR char_length(rationale) <= 12000),
  CONSTRAINT sample_relations_id_endpoints_uk UNIQUE(id,subject_sample_id,subject_analysis_version_id,object_sample_id,object_analysis_version_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_relations_active_identity_uidx
  ON sample_relations(relation_type,subject_sample_id,subject_analysis_version_id,object_sample_id,object_analysis_version_id)
  WHERE current_state NOT IN ('rejected','superseded');
CREATE INDEX IF NOT EXISTS sample_relations_subject_idx ON sample_relations(subject_sample_id,current_state,id DESC);
CREATE INDEX IF NOT EXISTS sample_relations_object_idx ON sample_relations(object_sample_id,current_state,id DESC);

CREATE TABLE IF NOT EXISTS sample_relation_evidence (
  id                    BIGSERIAL PRIMARY KEY,
  relation_id           BIGINT NOT NULL,
  subject_sample_id     BIGINT NOT NULL,
  subject_analysis_version_id BIGINT NOT NULL,
  object_sample_id      BIGINT NOT NULL,
  object_analysis_version_id BIGINT NOT NULL,
  endpoint_sample_id    BIGINT NOT NULL,
  endpoint_analysis_version_id BIGINT NOT NULL,
  element_evidence_id   BIGINT NOT NULL,
  note                  TEXT,
  added_by              BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_relation_evidence_relation_fk FOREIGN KEY(
    relation_id,subject_sample_id,subject_analysis_version_id,object_sample_id,object_analysis_version_id)
    REFERENCES sample_relations(id,subject_sample_id,subject_analysis_version_id,object_sample_id,object_analysis_version_id) ON DELETE RESTRICT,
  CONSTRAINT sample_relation_evidence_endpoint_version_fk FOREIGN KEY(endpoint_sample_id,endpoint_analysis_version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_relation_evidence_verified_fk FOREIGN KEY(endpoint_analysis_version_id,element_evidence_id)
    REFERENCES sample_element_evidence(version_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_relation_evidence_note_chk CHECK (note IS NULL OR char_length(note) <= 4000),
  CONSTRAINT sample_relation_evidence_identity_uk UNIQUE(relation_id,element_evidence_id)
);

CREATE TABLE IF NOT EXISTS sample_relation_events (
  id                BIGSERIAL PRIMARY KEY,
  relation_id       BIGINT NOT NULL REFERENCES sample_relations(id) ON DELETE RESTRICT,
  event_type        TEXT NOT NULL,
  reason            TEXT,
  actor_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_role        TEXT NOT NULL,
  superseded_by_relation_id BIGINT REFERENCES sample_relations(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_relation_events_type_chk CHECK (event_type IN ('proposed','confirmed','rejected','withdrawn','superseded')),
  CONSTRAINT sample_relation_events_role_chk CHECK (actor_role IN ('member','reviewer','admin','system')),
  CONSTRAINT sample_relation_events_reason_chk CHECK (reason IS NULL OR char_length(reason) <= 4000),
  CONSTRAINT sample_relation_events_supersede_chk CHECK (
    (event_type='superseded' AND superseded_by_relation_id IS NOT NULL AND superseded_by_relation_id<>relation_id) OR
    (event_type<>'superseded' AND superseded_by_relation_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS sample_relation_events_history_idx ON sample_relation_events(relation_id,id);

-- Local high-value extracts.
CREATE TABLE IF NOT EXISTS sample_element_extractions (
  id                BIGSERIAL PRIMARY KEY,
  comparison_id     BIGINT NOT NULL,
  scope_id          BIGINT NOT NULL,
  assessment_id     BIGINT,
  dimension_key     TEXT NOT NULL REFERENCES sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT,
  origin            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'building',
  pattern_text      TEXT NOT NULL,
  function_text     TEXT NOT NULL,
  rationale         TEXT NOT NULL,
  applicability     TEXT NOT NULL,
  limitations       TEXT NOT NULL,
  do_not_copy       TEXT NOT NULL,
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  CONSTRAINT sample_element_extractions_scope_fk FOREIGN KEY(comparison_id,scope_id)
    REFERENCES sample_comparison_scopes(comparison_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extractions_assessment_fk FOREIGN KEY(comparison_id,scope_id,assessment_id)
    REFERENCES sample_comparison_assessments(comparison_id,scope_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extractions_origin_chk CHECK (origin IN ('manual','ai')),
  CONSTRAINT sample_element_extractions_status_chk CHECK (status IN ('building','complete')),
  CONSTRAINT sample_element_extractions_completion_chk CHECK (
    (status='building' AND completed_at IS NULL) OR (status='complete' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT sample_element_extractions_fields_chk CHECK (
    char_length(pattern_text) BETWEEN 1 AND 12000 AND char_length(function_text) BETWEEN 1 AND 12000 AND
    char_length(rationale) BETWEEN 1 AND 12000 AND char_length(applicability) BETWEEN 1 AND 12000 AND
    char_length(limitations) BETWEEN 1 AND 12000 AND char_length(do_not_copy) BETWEEN 1 AND 12000
  ),
  CONSTRAINT sample_element_extractions_owner_uk UNIQUE(comparison_id,scope_id,id),
  CONSTRAINT sample_element_extractions_id_dimension_uk UNIQUE(id,dimension_key)
);
CREATE INDEX IF NOT EXISTS sample_element_extractions_list_idx
  ON sample_element_extractions(dimension_key,comparison_id,id DESC) WHERE status='complete';

CREATE TABLE IF NOT EXISTS sample_element_extraction_sources (
  id                BIGSERIAL PRIMARY KEY,
  extraction_id     BIGINT NOT NULL,
  extraction_dimension_key TEXT NOT NULL,
  comparison_id     BIGINT NOT NULL,
  scope_id          BIGINT NOT NULL,
  sample_id         BIGINT NOT NULL,
  snapshot_id       BIGINT NOT NULL,
  snapshot_dimension_key TEXT NOT NULL,
  source_role       TEXT NOT NULL,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_element_extraction_sources_extraction_fk FOREIGN KEY(extraction_id,extraction_dimension_key)
    REFERENCES sample_element_extractions(id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extraction_sources_scope_fk FOREIGN KEY(comparison_id,scope_id,extraction_id)
    REFERENCES sample_element_extractions(comparison_id,scope_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extraction_sources_snapshot_fk FOREIGN KEY(scope_id,snapshot_id)
    REFERENCES sample_comparison_snapshots(scope_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extraction_sources_snapshot_identity_fk FOREIGN KEY(scope_id,sample_id,snapshot_dimension_key)
    REFERENCES sample_comparison_snapshots(scope_id,sample_id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extraction_sources_snapshot_owner_fk FOREIGN KEY(scope_id,snapshot_id,sample_id,snapshot_dimension_key)
    REFERENCES sample_comparison_snapshots(scope_id,id,sample_id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extraction_sources_dimension_chk CHECK (extraction_dimension_key=snapshot_dimension_key),
  CONSTRAINT sample_element_extraction_sources_role_chk CHECK (source_role IN ('primary','supporting','counterexample')),
  CONSTRAINT sample_element_extraction_sources_note_chk CHECK (note IS NULL OR char_length(note) <= 4000),
  CONSTRAINT sample_element_extraction_sources_identity_uk UNIQUE(extraction_id,snapshot_id,source_role)
);

-- Stable component identity, immutable revisions and append-only review/current/lifecycle history.
CREATE TABLE IF NOT EXISTS content_components (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  lifecycle_state   TEXT NOT NULL DEFAULT 'active',
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_components_name_chk CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT content_components_lifecycle_chk CHECK (lifecycle_state IN ('active','retired'))
);
CREATE INDEX IF NOT EXISTS content_components_name_idx ON content_components(lower(name),id DESC);

CREATE TABLE IF NOT EXISTS content_component_revisions (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL REFERENCES content_components(id) ON DELETE RESTRICT,
  revision          INT NOT NULL,
  dimension_key     TEXT NOT NULL REFERENCES sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT,
  origin            TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'draft',
  name              TEXT NOT NULL,
  pattern_text      TEXT NOT NULL,
  function_text     TEXT NOT NULL,
  applicability     TEXT NOT NULL,
  limitations       TEXT NOT NULL,
  do_not_copy       TEXT NOT NULL,
  content_sha256    TEXT NOT NULL,
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_revisions_revision_chk CHECK (revision > 0),
  CONSTRAINT content_component_revisions_origin_chk CHECK (origin IN ('manual','ai')),
  CONSTRAINT content_component_revisions_state_chk CHECK (state IN ('draft','submitted','approved','changes_requested')),
  CONSTRAINT content_component_revisions_fields_chk CHECK (
    char_length(name) BETWEEN 1 AND 200 AND char_length(pattern_text) BETWEEN 1 AND 12000 AND
    char_length(function_text) BETWEEN 1 AND 12000 AND char_length(applicability) BETWEEN 1 AND 12000 AND
    char_length(limitations) BETWEEN 1 AND 12000 AND char_length(do_not_copy) BETWEEN 1 AND 12000
  ),
  CONSTRAINT content_component_revisions_hash_chk CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_component_revisions_component_revision_uk UNIQUE(component_id,revision),
  CONSTRAINT content_component_revisions_component_id_id_uk UNIQUE(component_id,id),
  CONSTRAINT content_component_revisions_id_dimension_uk UNIQUE(id,dimension_key)
);
CREATE INDEX IF NOT EXISTS content_component_revisions_history_idx
  ON content_component_revisions(component_id,revision DESC,id DESC);

CREATE TABLE IF NOT EXISTS content_component_revision_sources (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL,
  revision_id       BIGINT NOT NULL,
  revision_dimension_key TEXT NOT NULL,
  extraction_id     BIGINT NOT NULL,
  extraction_dimension_key TEXT NOT NULL,
  source_role       TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_revision_sources_revision_fk FOREIGN KEY(component_id,revision_id)
    REFERENCES content_component_revisions(component_id,id) ON DELETE RESTRICT,
  CONSTRAINT content_component_revision_sources_revision_dimension_fk FOREIGN KEY(revision_id,revision_dimension_key)
    REFERENCES content_component_revisions(id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT content_component_revision_sources_extraction_fk FOREIGN KEY(extraction_id,extraction_dimension_key)
    REFERENCES sample_element_extractions(id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT content_component_revision_sources_dimension_chk CHECK (revision_dimension_key=extraction_dimension_key),
  CONSTRAINT content_component_revision_sources_role_chk CHECK (source_role IN ('primary','supporting')),
  CONSTRAINT content_component_revision_sources_identity_uk UNIQUE(revision_id,extraction_id)
);

CREATE TABLE IF NOT EXISTS content_component_revision_tags (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL,
  revision_id       BIGINT NOT NULL,
  tag_id            BIGINT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  origin            TEXT NOT NULL,
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_revision_tags_revision_fk FOREIGN KEY(component_id,revision_id)
    REFERENCES content_component_revisions(component_id,id) ON DELETE RESTRICT,
  CONSTRAINT content_component_revision_tags_origin_chk CHECK (origin IN ('manual','ai')),
  CONSTRAINT content_component_revision_tags_identity_uk UNIQUE(revision_id,tag_id)
);
CREATE INDEX IF NOT EXISTS content_component_revision_tags_tag_idx ON content_component_revision_tags(tag_id,revision_id);

CREATE TABLE IF NOT EXISTS content_component_revision_decisions (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL,
  revision_id       BIGINT NOT NULL,
  decision          TEXT NOT NULL,
  note              TEXT,
  actor_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_role        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_revision_decisions_revision_fk FOREIGN KEY(component_id,revision_id)
    REFERENCES content_component_revisions(component_id,id) ON DELETE RESTRICT,
  CONSTRAINT content_component_revision_decisions_decision_chk CHECK (decision IN ('submitted','approved','changes_requested')),
  CONSTRAINT content_component_revision_decisions_role_chk CHECK (actor_role IN ('member','reviewer','admin')),
  CONSTRAINT content_component_revision_decisions_note_chk CHECK (note IS NULL OR char_length(note) <= 4000)
);
CREATE INDEX IF NOT EXISTS content_component_revision_decisions_history_idx
  ON content_component_revision_decisions(revision_id,id);

CREATE TABLE IF NOT EXISTS content_component_selections (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL,
  revision_id       BIGINT NOT NULL,
  decision_id       BIGINT NOT NULL REFERENCES content_component_revision_decisions(id) ON DELETE RESTRICT,
  selected_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_selections_revision_fk FOREIGN KEY(component_id,revision_id)
    REFERENCES content_component_revisions(component_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS content_component_selections_current_idx
  ON content_component_selections(component_id,id DESC);

CREATE TABLE IF NOT EXISTS content_component_lifecycle_events (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL REFERENCES content_components(id) ON DELETE RESTRICT,
  event_type        TEXT NOT NULL,
  reason            TEXT,
  actor_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_role        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_lifecycle_events_type_chk CHECK (event_type IN ('retired','reactivated')),
  CONSTRAINT content_component_lifecycle_events_role_chk CHECK (actor_role='admin'),
  CONSTRAINT content_component_lifecycle_events_reason_chk CHECK (reason IS NULL OR char_length(reason) <= 4000)
);
CREATE INDEX IF NOT EXISTS content_component_lifecycle_events_history_idx
  ON content_component_lifecycle_events(component_id,id);

-- ---------- Database guards ----------
CREATE OR REPLACE FUNCTION sample_stage3_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only',TG_TABLE_NAME USING ERRCODE='55000';
END $$;

CREATE OR REPLACE FUNCTION sample_comparison_scope_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_comparison_scopes_guard_trg ON sample_comparison_scopes;
CREATE TRIGGER sample_comparison_scopes_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_comparison_scopes
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_scope_guard();

CREATE OR REPLACE FUNCTION sample_comparison_scope_child_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_comparison_scope_members_guard_trg ON sample_comparison_scope_members;
CREATE TRIGGER sample_comparison_scope_members_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_comparison_scope_members
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_scope_child_guard();
DROP TRIGGER IF EXISTS sample_comparison_snapshots_guard_trg ON sample_comparison_snapshots;
CREATE TRIGGER sample_comparison_snapshots_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_comparison_snapshots
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_scope_child_guard();

CREATE OR REPLACE FUNCTION sample_comparison_job_transition_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_comparison_assessment_jobs_transition_trg ON sample_comparison_assessment_jobs;
CREATE TRIGGER sample_comparison_assessment_jobs_transition_trg BEFORE INSERT OR UPDATE ON sample_comparison_assessment_jobs
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_job_transition_guard();

CREATE OR REPLACE FUNCTION sample_comparison_assessment_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_comparison_assessments_validate_trg ON sample_comparison_assessments;
CREATE TRIGGER sample_comparison_assessments_validate_trg BEFORE INSERT ON sample_comparison_assessments
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_assessment_validate();

CREATE OR REPLACE FUNCTION sample_comparison_selection_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM sample_comparisons WHERE id=NEW.comparison_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'comparison does not exist' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_comparison_assessment_selections_validate_trg ON sample_comparison_assessment_selections;
CREATE TRIGGER sample_comparison_assessment_selections_validate_trg BEFORE INSERT ON sample_comparison_assessment_selections
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_selection_validate();

CREATE OR REPLACE FUNCTION sample_relation_evidence_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_relation_evidence_validate_trg ON sample_relation_evidence;
CREATE TRIGGER sample_relation_evidence_validate_trg BEFORE INSERT ON sample_relation_evidence
  FOR EACH ROW EXECUTE FUNCTION sample_relation_evidence_validate();

CREATE OR REPLACE FUNCTION sample_relation_insert_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sample_analysis_versions WHERE id=NEW.subject_analysis_version_id AND sample_id=NEW.subject_sample_id AND status='complete') OR
     NOT EXISTS(SELECT 1 FROM sample_analysis_versions WHERE id=NEW.object_analysis_version_id AND sample_id=NEW.object_sample_id AND status='complete') THEN
    RAISE EXCEPTION 'relation endpoints require complete pinned analyses' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_relations_insert_validate_trg ON sample_relations;
CREATE TRIGGER sample_relations_insert_validate_trg BEFORE INSERT ON sample_relations
  FOR EACH ROW EXECUTE FUNCTION sample_relation_insert_validate();

CREATE OR REPLACE FUNCTION sample_relation_row_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'sample relations are immutable' USING ERRCODE='55000'; END IF;
  IF pg_trigger_depth()<2 OR to_jsonb(NEW)-'current_state' IS DISTINCT FROM to_jsonb(OLD)-'current_state' THEN
    RAISE EXCEPTION 'sample relation structure is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_relations_guard_trg ON sample_relations;
CREATE TRIGGER sample_relations_guard_trg BEFORE UPDATE OR DELETE ON sample_relations
  FOR EACH ROW EXECUTE FUNCTION sample_relation_row_guard();

CREATE OR REPLACE FUNCTION sample_relation_event_apply()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_relation_events_apply_trg ON sample_relation_events;
CREATE TRIGGER sample_relation_events_apply_trg BEFORE INSERT ON sample_relation_events
  FOR EACH ROW EXECUTE FUNCTION sample_relation_event_apply();

CREATE OR REPLACE FUNCTION sample_element_extraction_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_element_extractions_guard_trg ON sample_element_extractions;
CREATE TRIGGER sample_element_extractions_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_element_extractions
  FOR EACH ROW EXECUTE FUNCTION sample_element_extraction_guard();

CREATE OR REPLACE FUNCTION sample_element_extraction_source_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_element_extraction_sources_guard_trg ON sample_element_extraction_sources;
CREATE TRIGGER sample_element_extraction_sources_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_element_extraction_sources
  FOR EACH ROW EXECUTE FUNCTION sample_element_extraction_source_guard();

CREATE OR REPLACE FUNCTION content_component_revision_row_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'component revisions are immutable' USING ERRCODE='55000'; END IF;
  IF pg_trigger_depth()<2 OR to_jsonb(NEW)-'state' IS DISTINCT FROM to_jsonb(OLD)-'state' THEN
    RAISE EXCEPTION 'component revision content is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_component_revisions_guard_trg ON content_component_revisions;
CREATE TRIGGER content_component_revisions_guard_trg BEFORE UPDATE OR DELETE ON content_component_revisions
  FOR EACH ROW EXECUTE FUNCTION content_component_revision_row_guard();

CREATE OR REPLACE FUNCTION content_component_revision_child_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS content_component_revision_sources_guard_trg ON content_component_revision_sources;
CREATE TRIGGER content_component_revision_sources_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON content_component_revision_sources
  FOR EACH ROW EXECUTE FUNCTION content_component_revision_child_guard();
DROP TRIGGER IF EXISTS content_component_revision_tags_guard_trg ON content_component_revision_tags;
CREATE TRIGGER content_component_revision_tags_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON content_component_revision_tags
  FOR EACH ROW EXECUTE FUNCTION content_component_revision_child_guard();

CREATE OR REPLACE FUNCTION content_component_revision_decision_apply()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS content_component_revision_decisions_apply_trg ON content_component_revision_decisions;
CREATE TRIGGER content_component_revision_decisions_apply_trg BEFORE INSERT ON content_component_revision_decisions
  FOR EACH ROW EXECUTE FUNCTION content_component_revision_decision_apply();

CREATE OR REPLACE FUNCTION content_component_selection_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS content_component_selections_validate_trg ON content_component_selections;
CREATE TRIGGER content_component_selections_validate_trg BEFORE INSERT ON content_component_selections
  FOR EACH ROW EXECUTE FUNCTION content_component_selection_validate();

CREATE OR REPLACE FUNCTION content_component_row_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'content components are immutable' USING ERRCODE='55000'; END IF;
  IF pg_trigger_depth()<2 OR to_jsonb(NEW)-'lifecycle_state' IS DISTINCT FROM to_jsonb(OLD)-'lifecycle_state' THEN
    RAISE EXCEPTION 'stable component identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_components_guard_trg ON content_components;
CREATE TRIGGER content_components_guard_trg BEFORE UPDATE OR DELETE ON content_components
  FOR EACH ROW EXECUTE FUNCTION content_component_row_guard();

CREATE OR REPLACE FUNCTION content_component_lifecycle_apply()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS content_component_lifecycle_events_apply_trg ON content_component_lifecycle_events;
CREATE TRIGGER content_component_lifecycle_events_apply_trg BEFORE INSERT ON content_component_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION content_component_lifecycle_apply();

-- Append-only histories and frozen products.
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sample_comparison_assessments','sample_comparison_findings',
    'sample_comparison_finding_evidence','sample_comparison_assessment_selections',
    'sample_relation_evidence','sample_relation_events','content_component_revision_decisions',
    'content_component_selections','content_component_lifecycle_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_append_only_trg',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sample_stage3_append_only_guard()',t||'_append_only_trg',t);
  END LOOP;
END $$;

COMMIT;

-- Verification examples (read-only):
-- SELECT count(*) FROM sample_analysis_dimensions; -- exactly 15
-- SELECT tablename FROM pg_tables WHERE tablename LIKE 'sample_comparison%' ORDER BY 1;
-- SELECT conname FROM pg_constraint WHERE conname LIKE 'sample_%_fk' ORDER BY 1;
