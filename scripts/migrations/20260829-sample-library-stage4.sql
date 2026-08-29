-- IdeaHub sample library, stage 4 (contract v2).
-- Additive, idempotent, PostgreSQL 16/17. Run after Stage 1-3 migrations.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='content_component_revision_decisions_identity_uk' AND conrelid='content_component_revision_decisions'::regclass) THEN
    ALTER TABLE content_component_revision_decisions ADD CONSTRAINT content_component_revision_decisions_identity_uk UNIQUE(component_id,revision_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='content_component_selections_identity_uk' AND conrelid='content_component_selections'::regclass) THEN
    ALTER TABLE content_component_selections ADD CONSTRAINT content_component_selections_identity_uk UNIQUE(component_id,id,revision_id,decision_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_element_tags_stage4_identity_uk' AND conrelid='sample_element_tags'::regclass) THEN
    ALTER TABLE sample_element_tags ADD CONSTRAINT sample_element_tags_stage4_identity_uk UNIQUE(id,version_id,element_id,dimension_key,tag_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sample_retrieval_algorithms (
  id BIGSERIAL PRIMARY KEY, algorithm_version TEXT NOT NULL, tokenizer_version TEXT NOT NULL,
  mapping_version TEXT NOT NULL, vector_size SMALLINT NOT NULL DEFAULT 256, config JSONB NOT NULL,
  config_sha256 TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_retrieval_algorithms_versions_uk UNIQUE(algorithm_version,tokenizer_version,mapping_version,config_sha256),
  CONSTRAINT sample_retrieval_algorithms_size_chk CHECK(vector_size=256),
  CONSTRAINT sample_retrieval_algorithms_hash_chk CHECK(config_sha256~'^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS sample_retrieval_builds (
  id BIGSERIAL PRIMARY KEY, algorithm_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithms(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued', idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
  requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL, attempts SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 3, lease_owner TEXT, lease_expires_at TIMESTAMPTZ, heartbeat_at TIMESTAMPTZ,
  eligible_count INT, succeeded_count INT NOT NULL DEFAULT 0, excluded_count INT NOT NULL DEFAULT 0, failed_count INT NOT NULL DEFAULT 0,
  error_code TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,
  CONSTRAINT sample_retrieval_builds_status_chk CHECK(status IN('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT sample_retrieval_builds_attempts_chk CHECK(attempts BETWEEN 0 AND max_attempts AND max_attempts=3),
  CONSTRAINT sample_retrieval_builds_idempotency_chk CHECK(char_length(idempotency_key) BETWEEN 1 AND 160),
  CONSTRAINT sample_retrieval_builds_hash_chk CHECK(request_sha256~'^[0-9a-f]{64}$'),
  CONSTRAINT sample_retrieval_builds_counts_chk CHECK(succeeded_count>=0 AND excluded_count>=0 AND failed_count>=0),
  CONSTRAINT sample_retrieval_builds_terminal_chk CHECK((status IN('succeeded','failed','cancelled'))=(finished_at IS NOT NULL)),
  CONSTRAINT sample_retrieval_builds_idempotency_uk UNIQUE(idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_retrieval_builds_one_active_uidx ON sample_retrieval_builds((1)) WHERE status IN('queued','running');
CREATE INDEX IF NOT EXISTS sample_retrieval_builds_status_idx ON sample_retrieval_builds(status,created_at,id);

CREATE TABLE IF NOT EXISTS sample_retrieval_build_items (
  id BIGSERIAL PRIMARY KEY, build_id BIGINT NOT NULL REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL, sample_id BIGINT REFERENCES samples(id) ON DELETE RESTRICT,
  component_id BIGINT REFERENCES content_components(id) ON DELETE RESTRICT, status TEXT NOT NULL,
  profile_id BIGINT, exclusion_code TEXT,error_code TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),finished_at TIMESTAMPTZ,
  CONSTRAINT sample_retrieval_build_items_kind_chk CHECK(subject_kind IN('sample','component')),
  CONSTRAINT sample_retrieval_build_items_subject_chk CHECK((subject_kind='sample' AND sample_id IS NOT NULL AND component_id IS NULL) OR(subject_kind='component' AND component_id IS NOT NULL AND sample_id IS NULL)),
  CONSTRAINT sample_retrieval_build_items_status_chk CHECK(status IN('queued','succeeded','excluded','failed','cancelled')),
  CONSTRAINT sample_retrieval_build_items_subject_uk UNIQUE(build_id,subject_kind,sample_id,component_id)
);

CREATE TABLE IF NOT EXISTS sample_retrieval_profiles (
  id BIGSERIAL PRIMARY KEY, build_id BIGINT NOT NULL REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,
  algorithm_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithms(id) ON DELETE RESTRICT,
  sample_id BIGINT NOT NULL, analysis_version_id BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'building',
  input_sha256 TEXT NOT NULL, frozen_title TEXT NOT NULL, frozen_platform TEXT NOT NULL,
  frozen_account_name TEXT,frozen_account_handle TEXT,frozen_archive_status TEXT NOT NULL,
  frozen_content_type TEXT,frozen_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ,
  CONSTRAINT sample_retrieval_profiles_version_fk FOREIGN KEY(sample_id,analysis_version_id) REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_retrieval_profiles_identity_uk UNIQUE(id,sample_id,analysis_version_id),
  CONSTRAINT sample_retrieval_profiles_id_sample_uk UNIQUE(id,sample_id),
  CONSTRAINT sample_retrieval_profiles_build_subject_uk UNIQUE(build_id,sample_id),
  CONSTRAINT sample_retrieval_profiles_status_chk CHECK(status IN('building','complete')),
  CONSTRAINT sample_retrieval_profiles_hash_chk CHECK(input_sha256~'^[0-9a-f]{64}$'),
  CONSTRAINT sample_retrieval_profiles_completion_chk CHECK((status='complete')=(completed_at IS NOT NULL)),
  CONSTRAINT sample_retrieval_profiles_tags_chk CHECK(jsonb_typeof(frozen_tags)='array')
);
CREATE INDEX IF NOT EXISTS sample_retrieval_profiles_algorithm_idx ON sample_retrieval_profiles(algorithm_id,id) WHERE status='complete';

CREATE TABLE IF NOT EXISTS sample_retrieval_dimension_vectors (
  id BIGSERIAL PRIMARY KEY, profile_id BIGINT NOT NULL,sample_id BIGINT NOT NULL,analysis_version_id BIGINT NOT NULL,
  element_id BIGINT NOT NULL,dimension_key TEXT NOT NULL,decision_id BIGINT,
  vector SMALLINT[] NOT NULL,norm_sq BIGINT NOT NULL,nonzero_count SMALLINT NOT NULL,simhash BIT(64) NOT NULL,
  band_0 SMALLINT NOT NULL,band_1 SMALLINT NOT NULL,band_2 SMALLINT NOT NULL,band_3 SMALLINT NOT NULL,
  band_4 SMALLINT NOT NULL,band_5 SMALLINT NOT NULL,band_6 SMALLINT NOT NULL,band_7 SMALLINT NOT NULL,
  source TEXT NOT NULL,decision_state TEXT,confidence NUMERIC(4,3),evidence_strength TEXT NOT NULL,effective_summary TEXT,
  applicability TEXT,limitations TEXT,frozen_tags JSONB NOT NULL DEFAULT '[]'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_retrieval_vectors_profile_fk FOREIGN KEY(profile_id,sample_id,analysis_version_id) REFERENCES sample_retrieval_profiles(id,sample_id,analysis_version_id) ON DELETE RESTRICT,
  CONSTRAINT sample_retrieval_vectors_element_fk FOREIGN KEY(analysis_version_id,element_id,dimension_key) REFERENCES sample_analysis_elements(version_id,id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_retrieval_vectors_decision_fk FOREIGN KEY(element_id,decision_id) REFERENCES sample_element_decisions(element_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_retrieval_vectors_dimension_uk UNIQUE(profile_id,dimension_key),
  CONSTRAINT sample_retrieval_vectors_shape_chk CHECK(array_ndims(vector)=1 AND array_lower(vector,1)=1 AND array_length(vector,1)=256),
  CONSTRAINT sample_retrieval_vectors_norm_chk CHECK(norm_sq>=0 AND nonzero_count BETWEEN 0 AND 256),
  CONSTRAINT sample_retrieval_vectors_bands_chk CHECK(band_0 BETWEEN 0 AND 255 AND band_1 BETWEEN 0 AND 255 AND band_2 BETWEEN 0 AND 255 AND band_3 BETWEEN 0 AND 255 AND band_4 BETWEEN 0 AND 255 AND band_5 BETWEEN 0 AND 255 AND band_6 BETWEEN 0 AND 255 AND band_7 BETWEEN 0 AND 255),
  CONSTRAINT sample_retrieval_vectors_source_chk CHECK(source IN('ai','manual','legacy')),
  CONSTRAINT sample_retrieval_vectors_decision_state_chk CHECK((decision_id IS NULL AND decision_state IS NULL)OR(decision_id IS NOT NULL AND decision_state IN('confirmed','edited','rejected'))),
  CONSTRAINT sample_retrieval_vectors_evidence_chk CHECK(evidence_strength IN('none','weak','medium','strong')),
  CONSTRAINT sample_retrieval_vectors_tags_chk CHECK(jsonb_typeof(frozen_tags)='array')
);
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band0_idx ON sample_retrieval_dimension_vectors(dimension_key,band_0,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band1_idx ON sample_retrieval_dimension_vectors(dimension_key,band_1,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band2_idx ON sample_retrieval_dimension_vectors(dimension_key,band_2,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band3_idx ON sample_retrieval_dimension_vectors(dimension_key,band_3,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band4_idx ON sample_retrieval_dimension_vectors(dimension_key,band_4,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band5_idx ON sample_retrieval_dimension_vectors(dimension_key,band_5,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band6_idx ON sample_retrieval_dimension_vectors(dimension_key,band_6,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band7_idx ON sample_retrieval_dimension_vectors(dimension_key,band_7,profile_id) WHERE norm_sq>0;

CREATE TABLE IF NOT EXISTS sample_retrieval_states (
  sample_id BIGINT PRIMARY KEY REFERENCES samples(id) ON DELETE RESTRICT,dirty BOOLEAN NOT NULL DEFAULT true,
  dirty_generation BIGINT NOT NULL DEFAULT 1,current_fingerprint TEXT,last_profile_id BIGINT REFERENCES sample_retrieval_profiles(id) ON DELETE RESTRICT,
  last_build_id BIGINT REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,last_error_code TEXT,last_error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),CONSTRAINT sample_retrieval_states_generation_chk CHECK(dirty_generation>=1),
  CONSTRAINT sample_retrieval_states_hash_chk CHECK(current_fingerprint IS NULL OR current_fingerprint~'^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS component_retrieval_profiles (
  id BIGSERIAL PRIMARY KEY,build_id BIGINT NOT NULL REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,
  algorithm_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithms(id) ON DELETE RESTRICT,component_id BIGINT NOT NULL,
  selection_id BIGINT NOT NULL,revision_id BIGINT NOT NULL,approving_decision_id BIGINT NOT NULL,dimension_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'building',input_sha256 TEXT NOT NULL,frozen_name TEXT NOT NULL,frozen_summary TEXT NOT NULL,
  frozen_applicability TEXT,frozen_limitations TEXT,frozen_source_count INT NOT NULL,frozen_tags JSONB NOT NULL DEFAULT'[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ,
  CONSTRAINT component_retrieval_profiles_selection_fk FOREIGN KEY(component_id,selection_id,revision_id,approving_decision_id) REFERENCES content_component_selections(component_id,id,revision_id,decision_id) ON DELETE RESTRICT,
  CONSTRAINT component_retrieval_profiles_revision_dimension_fk FOREIGN KEY(revision_id,dimension_key) REFERENCES content_component_revisions(id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT component_retrieval_profiles_identity_uk UNIQUE(id,component_id,selection_id,revision_id,approving_decision_id,dimension_key),
  CONSTRAINT component_retrieval_profiles_build_subject_uk UNIQUE(build_id,component_id),
  CONSTRAINT component_retrieval_profiles_status_chk CHECK(status IN('building','complete')),
  CONSTRAINT component_retrieval_profiles_hash_chk CHECK(input_sha256~'^[0-9a-f]{64}$'),
  CONSTRAINT component_retrieval_profiles_completion_chk CHECK((status='complete')=(completed_at IS NOT NULL)),
  CONSTRAINT component_retrieval_profiles_source_count_chk CHECK(frozen_source_count>=0)
);

CREATE TABLE IF NOT EXISTS component_retrieval_vectors (
  id BIGSERIAL PRIMARY KEY,profile_id BIGINT NOT NULL,component_id BIGINT NOT NULL,selection_id BIGINT NOT NULL,
  revision_id BIGINT NOT NULL,approving_decision_id BIGINT NOT NULL,dimension_key TEXT NOT NULL,
  vector SMALLINT[] NOT NULL,norm_sq BIGINT NOT NULL,nonzero_count SMALLINT NOT NULL,simhash BIT(64) NOT NULL,
  band_0 SMALLINT NOT NULL,band_1 SMALLINT NOT NULL,band_2 SMALLINT NOT NULL,band_3 SMALLINT NOT NULL,
  band_4 SMALLINT NOT NULL,band_5 SMALLINT NOT NULL,band_6 SMALLINT NOT NULL,band_7 SMALLINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT component_retrieval_vectors_profile_fk FOREIGN KEY(profile_id,component_id,selection_id,revision_id,approving_decision_id,dimension_key) REFERENCES component_retrieval_profiles(id,component_id,selection_id,revision_id,approving_decision_id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT component_retrieval_vectors_one_uk UNIQUE(profile_id),
  CONSTRAINT component_retrieval_vectors_shape_chk CHECK(array_ndims(vector)=1 AND array_lower(vector,1)=1 AND array_length(vector,1)=256),
  CONSTRAINT component_retrieval_vectors_norm_chk CHECK(norm_sq>=0 AND nonzero_count BETWEEN 0 AND 256),
  CONSTRAINT component_retrieval_vectors_bands_chk CHECK(band_0 BETWEEN 0 AND 255 AND band_1 BETWEEN 0 AND 255 AND band_2 BETWEEN 0 AND 255 AND band_3 BETWEEN 0 AND 255 AND band_4 BETWEEN 0 AND 255 AND band_5 BETWEEN 0 AND 255 AND band_6 BETWEEN 0 AND 255 AND band_7 BETWEEN 0 AND 255)
);
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band0_idx ON component_retrieval_vectors(dimension_key,band_0,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band1_idx ON component_retrieval_vectors(dimension_key,band_1,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band2_idx ON component_retrieval_vectors(dimension_key,band_2,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band3_idx ON component_retrieval_vectors(dimension_key,band_3,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band4_idx ON component_retrieval_vectors(dimension_key,band_4,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band5_idx ON component_retrieval_vectors(dimension_key,band_5,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band6_idx ON component_retrieval_vectors(dimension_key,band_6,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band7_idx ON component_retrieval_vectors(dimension_key,band_7,profile_id) WHERE norm_sq>0;

CREATE TABLE IF NOT EXISTS component_retrieval_states (
  component_id BIGINT PRIMARY KEY REFERENCES content_components(id) ON DELETE RESTRICT,dirty BOOLEAN NOT NULL DEFAULT true,
  dirty_generation BIGINT NOT NULL DEFAULT 1,current_fingerprint TEXT,last_profile_id BIGINT REFERENCES component_retrieval_profiles(id) ON DELETE RESTRICT,
  last_build_id BIGINT REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,last_error_code TEXT,last_error_message TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT component_retrieval_states_generation_chk CHECK(dirty_generation>=1)
);

CREATE TABLE IF NOT EXISTS sample_retrieval_algorithm_selections (
  id BIGSERIAL PRIMARY KEY,algorithm_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithms(id) ON DELETE RESTRICT,
  build_id BIGINT NOT NULL REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,reason TEXT NOT NULL,
  selected_by BIGINT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_retrieval_algorithm_selections_reason_chk CHECK(reason IN('build_success','explicit','rollback')),
  CONSTRAINT sample_retrieval_algorithm_selections_identity_uk UNIQUE(id,algorithm_id)
);

CREATE TABLE IF NOT EXISTS sample_cluster_jobs (
 id BIGSERIAL PRIMARY KEY,algorithm_selection_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithm_selections(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT'queued',idempotency_key TEXT NOT NULL UNIQUE,request_sha256 TEXT NOT NULL,requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 attempts SMALLINT NOT NULL DEFAULT 0,max_attempts SMALLINT NOT NULL DEFAULT 3,lease_owner TEXT,lease_expires_at TIMESTAMPTZ,heartbeat_at TIMESTAMPTZ,
 error_code TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,
 CONSTRAINT sample_cluster_jobs_status_chk CHECK(status IN('queued','running','succeeded','failed','cancelled')),
 CONSTRAINT sample_cluster_jobs_hash_chk CHECK(request_sha256~'^[0-9a-f]{64}$'),CONSTRAINT sample_cluster_jobs_attempts_chk CHECK(attempts BETWEEN 0 AND max_attempts AND max_attempts=3),
 CONSTRAINT sample_cluster_jobs_terminal_chk CHECK((status IN('succeeded','failed','cancelled'))=(finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_cluster_jobs_one_active_uidx ON sample_cluster_jobs((1)) WHERE status IN('queued','running');

CREATE TABLE IF NOT EXISTS sample_cluster_runs (
 id BIGSERIAL PRIMARY KEY,job_id BIGINT NOT NULL UNIQUE REFERENCES sample_cluster_jobs(id) ON DELETE RESTRICT,
 algorithm_selection_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithm_selections(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT'building',algorithm_version TEXT NOT NULL,input_sha256 TEXT NOT NULL,profile_count INT NOT NULL DEFAULT 0,
 limitation TEXT NOT NULL DEFAULT'聚类仅描述结构相似性，不代表内容价值或表现因果。',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ,
 CONSTRAINT sample_cluster_runs_status_chk CHECK(status IN('building','complete','failed')),CONSTRAINT sample_cluster_runs_hash_chk CHECK(input_sha256~'^[0-9a-f]{64}$'),
 CONSTRAINT sample_cluster_runs_completion_chk CHECK((status IN('complete','failed'))=(completed_at IS NOT NULL)),CONSTRAINT sample_cluster_runs_identity_uk UNIQUE(id,algorithm_selection_id)
);

CREATE TABLE IF NOT EXISTS sample_cluster_run_profiles (
 run_id BIGINT NOT NULL,algorithm_selection_id BIGINT NOT NULL,sample_id BIGINT NOT NULL,profile_id BIGINT NOT NULL,ordinal INT NOT NULL,
 PRIMARY KEY(run_id,sample_id),CONSTRAINT sample_cluster_run_profiles_run_fk FOREIGN KEY(run_id,algorithm_selection_id) REFERENCES sample_cluster_runs(id,algorithm_selection_id) ON DELETE RESTRICT,
 CONSTRAINT sample_cluster_run_profiles_profile_fk FOREIGN KEY(profile_id,sample_id) REFERENCES sample_retrieval_profiles(id,sample_id) ON DELETE RESTRICT,
 CONSTRAINT sample_cluster_run_profiles_profile_uk UNIQUE(run_id,profile_id),CONSTRAINT sample_cluster_run_profiles_member_fk_uk UNIQUE(run_id,sample_id,profile_id),CONSTRAINT sample_cluster_run_profiles_ordinal_uk UNIQUE(run_id,ordinal),CONSTRAINT sample_cluster_run_profiles_ordinal_chk CHECK(ordinal>0)
);

CREATE TABLE IF NOT EXISTS sample_clusters (
 id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL REFERENCES sample_cluster_runs(id) ON DELETE RESTRICT,ordinal INT NOT NULL,cluster_key TEXT NOT NULL,
 representative_sample_id BIGINT NOT NULL,label TEXT NOT NULL,summary TEXT NOT NULL,cohesion NUMERIC(8,7),common_tags JSONB NOT NULL DEFAULT'[]'::jsonb,
 distinguishing_tags JSONB NOT NULL DEFAULT'[]'::jsonb,dimension_contributions JSONB NOT NULL DEFAULT'[]'::jsonb,limitation TEXT NOT NULL,
 CONSTRAINT sample_clusters_run_ordinal_uk UNIQUE(run_id,ordinal),CONSTRAINT sample_clusters_run_id_id_uk UNIQUE(run_id,id),
 CONSTRAINT sample_clusters_key_uk UNIQUE(run_id,cluster_key),CONSTRAINT sample_clusters_key_chk CHECK(cluster_key~'^[0-9a-f]{64}$'),
 CONSTRAINT sample_clusters_cohesion_chk CHECK(cohesion IS NULL OR cohesion BETWEEN -1 AND 1),CONSTRAINT sample_clusters_ordinal_chk CHECK(ordinal>0)
);

CREATE TABLE IF NOT EXISTS sample_cluster_members (
 run_id BIGINT NOT NULL,sample_id BIGINT NOT NULL,profile_id BIGINT NOT NULL,cluster_id BIGINT,is_outlier BOOLEAN NOT NULL,
 representative BOOLEAN NOT NULL DEFAULT false,pair_mean NUMERIC(8,7),PRIMARY KEY(run_id,sample_id),
 CONSTRAINT sample_cluster_members_input_fk FOREIGN KEY(run_id,sample_id,profile_id) REFERENCES sample_cluster_run_profiles(run_id,sample_id,profile_id) ON DELETE RESTRICT,
 CONSTRAINT sample_cluster_members_cluster_fk FOREIGN KEY(run_id,cluster_id) REFERENCES sample_clusters(run_id,id) ON DELETE RESTRICT,
 CONSTRAINT sample_cluster_members_assignment_chk CHECK((is_outlier AND cluster_id IS NULL AND NOT representative)OR(NOT is_outlier AND cluster_id IS NOT NULL)),
 CONSTRAINT sample_cluster_members_pair_mean_chk CHECK(pair_mean IS NULL OR pair_mean BETWEEN -1 AND 1)
);

CREATE TABLE IF NOT EXISTS sample_cluster_selections (
 id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL REFERENCES sample_cluster_runs(id) ON DELETE RESTRICT,
 algorithm_selection_id BIGINT NOT NULL,selected_by BIGINT REFERENCES users(id) ON DELETE SET NULL,reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),CONSTRAINT sample_cluster_selections_run_fk FOREIGN KEY(run_id,algorithm_selection_id) REFERENCES sample_cluster_runs(id,algorithm_selection_id) ON DELETE RESTRICT,
 CONSTRAINT sample_cluster_selections_reason_chk CHECK(reason IN('job_success','explicit','rollback'))
);

-- Existing Stage1-3 subjects start explicitly dirty; no source row is silently
-- treated as indexed merely because Stage4 was installed.
INSERT INTO sample_retrieval_states(sample_id,dirty,dirty_generation)
SELECT id,true,1 FROM samples WHERE deleted_at IS NULL AND current_analysis_version_id IS NOT NULL
ON CONFLICT(sample_id)DO NOTHING;
INSERT INTO component_retrieval_states(component_id,dirty,dirty_generation)
SELECT id,true,1 FROM content_components
ON CONFLICT(component_id)DO NOTHING;

CREATE TABLE IF NOT EXISTS sample_element_tag_observations (
 id BIGSERIAL PRIMARY KEY,sample_id BIGINT NOT NULL,analysis_version_id BIGINT NOT NULL,element_id BIGINT NOT NULL,dimension_key TEXT NOT NULL,
 tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,state TEXT NOT NULL,note TEXT,idempotency_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,
 observed_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,observer_role TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT sample_element_tag_observations_version_fk FOREIGN KEY(sample_id,analysis_version_id) REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
 CONSTRAINT sample_element_tag_observations_element_fk FOREIGN KEY(analysis_version_id,element_id,dimension_key) REFERENCES sample_analysis_elements(version_id,id,dimension_key) ON DELETE RESTRICT,
 CONSTRAINT sample_element_tag_observations_state_chk CHECK(state IN('present','absent')),CONSTRAINT sample_element_tag_observations_role_chk CHECK(observer_role IN('reviewer','admin')),
 CONSTRAINT sample_element_tag_observations_hash_chk CHECK(request_sha256~'^[0-9a-f]{64}$'),CONSTRAINT sample_element_tag_observations_note_chk CHECK(note IS NULL OR char_length(note)<=2000),
 CONSTRAINT sample_element_tag_observations_idempotency_uk UNIQUE(sample_id,analysis_version_id,element_id,tag_id,idempotency_key),
 CONSTRAINT sample_element_tag_observations_identity_uk UNIQUE(id,sample_id,analysis_version_id,element_id,dimension_key,tag_id),
 CONSTRAINT sample_element_tag_observations_fk_identity_uk UNIQUE(id,sample_id,analysis_version_id,element_id,dimension_key)
);
CREATE INDEX IF NOT EXISTS sample_element_tag_observations_latest_idx ON sample_element_tag_observations(element_id,tag_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS sample_insight_runs (
 id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT'queued',idempotency_key TEXT NOT NULL UNIQUE,request_sha256 TEXT NOT NULL,
 manifest_sha256 TEXT,normalized_request JSONB NOT NULL,platform TEXT NOT NULL,goal TEXT NOT NULL,outcome_metric TEXT NOT NULL,outcome_transform TEXT NOT NULL,
 analysis_trust TEXT NOT NULL,cutoff_at TIMESTAMPTZ NOT NULL,requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 attempts SMALLINT NOT NULL DEFAULT 0,max_attempts SMALLINT NOT NULL DEFAULT 3,lease_owner TEXT,lease_expires_at TIMESTAMPTZ,heartbeat_at TIMESTAMPTZ,
 eligible_count INT,outcome_observed_count INT,feature_observed_count INT,warnings JSONB NOT NULL DEFAULT'[]'::jsonb,exclusion_counts JSONB NOT NULL DEFAULT'{}'::jsonb,
 error_code TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),started_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,
 CONSTRAINT sample_insight_runs_name_chk CHECK(char_length(name) BETWEEN 1 AND 200),CONSTRAINT sample_insight_runs_status_chk CHECK(status IN('queued','running','complete','failed','cancelled')),
 CONSTRAINT sample_insight_runs_platform_chk CHECK(platform IN('xiaohongshu','douyin','manual')),CONSTRAINT sample_insight_runs_goal_chk CHECK(goal IN('traffic','persona','expertise','conversion')),
 CONSTRAINT sample_insight_runs_metric_chk CHECK(outcome_metric IN('likes','saves','comments','shares','views','likes_per_view','saves_per_view','comments_per_view','shares_per_view')),
 CONSTRAINT sample_insight_runs_trust_chk CHECK(analysis_trust IN('human_confirmed','reviewed_or_manual_tag','all_effective')),
 CONSTRAINT sample_insight_runs_hash_chk CHECK(request_sha256~'^[0-9a-f]{64}$' AND(manifest_sha256 IS NULL OR manifest_sha256~'^[0-9a-f]{64}$')),
 CONSTRAINT sample_insight_runs_attempts_chk CHECK(attempts BETWEEN 0 AND max_attempts AND max_attempts=3),
 CONSTRAINT sample_insight_runs_terminal_chk CHECK((status IN('complete','failed','cancelled'))=(completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_insight_runs_one_active_uidx ON sample_insight_runs((1)) WHERE status IN('queued','running');
CREATE INDEX IF NOT EXISTS sample_insight_runs_history_idx ON sample_insight_runs(created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS sample_insight_run_members (
 id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL REFERENCES sample_insight_runs(id) ON DELETE RESTRICT,sample_id BIGINT NOT NULL,
 analysis_version_id BIGINT NOT NULL,metric_snapshot_id BIGINT,account_key TEXT NOT NULL,account_key_quality TEXT NOT NULL,
 frozen_title TEXT NOT NULL,frozen_platform TEXT NOT NULL,frozen_published_at TIMESTAMPTZ,frozen_metric_observed_at TIMESTAMPTZ,
 observation_seconds BIGINT,outcome_state TEXT NOT NULL,outcome_value NUMERIC,exclusion_reason TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT sample_insight_run_members_version_fk FOREIGN KEY(sample_id,analysis_version_id) REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_members_metric_fk FOREIGN KEY(sample_id,metric_snapshot_id) REFERENCES sample_metric_snapshots(sample_id,id) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_members_run_sample_uk UNIQUE(run_id,sample_id),CONSTRAINT sample_insight_run_members_identity_uk UNIQUE(run_id,id,sample_id,analysis_version_id),
 CONSTRAINT sample_insight_run_members_state_chk CHECK(outcome_state IN('observed','missing_metric','parse_warning','missing_published_at','outside_window')),
 CONSTRAINT sample_insight_run_members_quality_chk CHECK(account_key_quality IN('verified_handle','name_fallback','missing_singleton')),
 CONSTRAINT sample_insight_run_members_outcome_chk CHECK((outcome_state='observed' AND metric_snapshot_id IS NOT NULL AND outcome_value IS NOT NULL AND exclusion_reason IS NULL)OR(outcome_state<>'observed' AND outcome_value IS NULL AND exclusion_reason IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS sample_insight_run_features (
 id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL,member_id BIGINT NOT NULL,sample_id BIGINT NOT NULL,analysis_version_id BIGINT NOT NULL,
 feature_key TEXT NOT NULL,feature_type TEXT NOT NULL,dimension_key TEXT,tag_ids BIGINT[] NOT NULL,tag_id BIGINT REFERENCES tags(id) ON DELETE RESTRICT,state TEXT NOT NULL,
 element_id BIGINT,observation_id BIGINT,element_tag_id BIGINT,source TEXT NOT NULL,frozen_label TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT sample_insight_run_features_member_fk FOREIGN KEY(run_id,member_id,sample_id,analysis_version_id) REFERENCES sample_insight_run_members(run_id,id,sample_id,analysis_version_id) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_features_element_fk FOREIGN KEY(analysis_version_id,element_id,dimension_key) REFERENCES sample_analysis_elements(version_id,id,dimension_key) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_features_observation_fk FOREIGN KEY(observation_id,sample_id,analysis_version_id,element_id,dimension_key,tag_id) REFERENCES sample_element_tag_observations(id,sample_id,analysis_version_id,element_id,dimension_key,tag_id) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_features_element_tag_fk FOREIGN KEY(element_tag_id,analysis_version_id,element_id,dimension_key,tag_id) REFERENCES sample_element_tags(id,version_id,element_id,dimension_key,tag_id) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_features_key_uk UNIQUE(run_id,member_id,feature_key),
 CONSTRAINT sample_insight_run_features_type_chk CHECK(feature_type IN('single','combination')),CONSTRAINT sample_insight_run_features_state_chk CHECK(state IN('present','absent','unknown')),
 CONSTRAINT sample_insight_run_features_source_chk CHECK(source IN('explicit_observation','manual_tag','effective_tag','combination','unknown')),
 CONSTRAINT sample_insight_run_features_tags_chk CHECK(array_ndims(tag_ids)=1 AND array_lower(tag_ids,1)=1 AND array_length(tag_ids,1) BETWEEN 1 AND 3 AND(feature_type='single')=(array_length(tag_ids,1)=1)),
 CONSTRAINT sample_insight_run_features_provenance_chk CHECK(
   (feature_type='single' AND tag_id=tag_ids[1] AND dimension_key IS NOT NULL AND(
     (source='explicit_observation' AND state IN('present','absent') AND observation_id IS NOT NULL AND element_id IS NOT NULL AND element_tag_id IS NULL)OR
     (source IN('manual_tag','effective_tag')AND state='present'AND observation_id IS NULL AND element_id IS NOT NULL AND element_tag_id IS NOT NULL)OR
     (source='unknown'AND state='unknown'AND observation_id IS NULL AND element_id IS NULL AND element_tag_id IS NULL)
   ))OR(feature_type='combination'AND source='combination'AND tag_id IS NULL AND dimension_key IS NULL AND observation_id IS NULL AND element_id IS NULL AND element_tag_id IS NULL)
 )
);

CREATE TABLE IF NOT EXISTS sample_insight_statistics (
 id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL REFERENCES sample_insight_runs(id) ON DELETE RESTRICT,feature_key TEXT NOT NULL,
 feature_type TEXT NOT NULL,dimension_key TEXT,frozen_label TEXT NOT NULL,reliability TEXT NOT NULL,
 n_eligible INT NOT NULL,n_outcome_observed INT NOT NULL,n_feature_observed INT NOT NULL,n_observed INT NOT NULL,n_present INT NOT NULL,n_absent INT NOT NULL,
 unique_accounts INT NOT NULL,outcome_coverage NUMERIC(8,7) NOT NULL,feature_coverage NUMERIC(8,7) NOT NULL,
 present_median NUMERIC,present_q1 NUMERIC,present_q3 NUMERIC,absent_median NUMERIC,absent_q1 NUMERIC,absent_q3 NUMERIC,
 median_difference NUMERIC,cliffs_delta NUMERIC,median_difference_ci_low NUMERIC,median_difference_ci_high NUMERIC,cliffs_delta_ci_low NUMERIC,cliffs_delta_ci_high NUMERIC,
 direction TEXT,limitation TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT sample_insight_statistics_key_uk UNIQUE(run_id,feature_key),CONSTRAINT sample_insight_statistics_type_chk CHECK(feature_type IN('single','combination')),
 CONSTRAINT sample_insight_statistics_reliability_chk CHECK(reliability IN('insufficient','exploratory','directional','stronger_descriptive')),
 CONSTRAINT sample_insight_statistics_counts_chk CHECK(n_eligible>=0 AND n_outcome_observed>=0 AND n_feature_observed>=0 AND n_observed>=0 AND n_present>=0 AND n_absent>=0 AND n_present+n_absent=n_observed),
 CONSTRAINT sample_insight_statistics_coverage_chk CHECK(outcome_coverage BETWEEN 0 AND 1 AND feature_coverage BETWEEN 0 AND 1),
 CONSTRAINT sample_insight_statistics_small_n_chk CHECK(reliability<>'insufficient' OR(present_median IS NULL AND present_q1 IS NULL AND present_q3 IS NULL AND absent_median IS NULL AND absent_q1 IS NULL AND absent_q3 IS NULL AND median_difference IS NULL AND cliffs_delta IS NULL AND median_difference_ci_low IS NULL AND median_difference_ci_high IS NULL AND cliffs_delta_ci_low IS NULL AND cliffs_delta_ci_high IS NULL AND direction IS NULL))
);

CREATE OR REPLACE FUNCTION sample_stage4_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION '% rows are append-only',TG_TABLE_NAME USING ERRCODE='55000'; END $$;

CREATE OR REPLACE FUNCTION sample_stage4_job_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final_success TEXT;BEGIN IF TG_OP='DELETE'THEN RAISE EXCEPTION 'job audit rows cannot be deleted' USING ERRCODE='55000';END IF;final_success:=CASE WHEN TG_TABLE_NAME='sample_insight_runs'THEN'complete'ELSE'succeeded'END;
 IF OLD.status IN(final_success,'failed','cancelled')THEN RAISE EXCEPTION 'terminal jobs are immutable' USING ERRCODE='55000';END IF;
 IF NEW.status=OLD.status THEN RETURN NEW;END IF;
 IF OLD.status='queued'AND NEW.status NOT IN('running','cancelled')THEN RAISE EXCEPTION 'invalid queued job transition' USING ERRCODE='23514';END IF;
 IF OLD.status='running'AND NEW.status NOT IN('queued',final_success,'failed','cancelled')THEN RAISE EXCEPTION 'invalid running job transition' USING ERRCODE='23514';END IF;
 IF OLD.status='running'AND NEW.status='queued'AND(OLD.lease_expires_at IS NULL OR OLD.lease_expires_at>=now()OR OLD.attempts>=OLD.max_attempts)THEN RAISE EXCEPTION 'only an expired retryable lease may requeue' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_builds_state_trg ON sample_retrieval_builds;CREATE TRIGGER sample_retrieval_builds_state_trg BEFORE UPDATE OR DELETE ON sample_retrieval_builds FOR EACH ROW EXECUTE FUNCTION sample_stage4_job_state_guard();
DROP TRIGGER IF EXISTS sample_cluster_jobs_state_trg ON sample_cluster_jobs;CREATE TRIGGER sample_cluster_jobs_state_trg BEFORE UPDATE OR DELETE ON sample_cluster_jobs FOR EACH ROW EXECUTE FUNCTION sample_stage4_job_state_guard();
DROP TRIGGER IF EXISTS sample_insight_runs_state_trg ON sample_insight_runs;CREATE TRIGGER sample_insight_runs_state_trg BEFORE UPDATE OR DELETE ON sample_insight_runs FOR EACH ROW EXECUTE FUNCTION sample_stage4_job_state_guard();

CREATE OR REPLACE FUNCTION sample_stage4_selection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF TG_TABLE_NAME='sample_retrieval_algorithm_selections'THEN
  IF NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.algorithm_id=NEW.algorithm_id AND b.status='succeeded'AND b.failed_count=0 AND b.eligible_count=b.succeeded_count+b.excluded_count AND b.succeeded_count=(SELECT count(*)FROM sample_retrieval_build_items i WHERE i.build_id=b.id AND i.status='succeeded')AND b.excluded_count=(SELECT count(*)FROM sample_retrieval_build_items i WHERE i.build_id=b.id AND i.status='excluded')AND NOT EXISTS(SELECT 1 FROM sample_retrieval_build_items i WHERE i.build_id=b.id AND i.status='failed'))THEN RAISE EXCEPTION 'algorithm selection requires complete successful coverage' USING ERRCODE='23514';END IF;
 ELSE IF NOT EXISTS(SELECT 1 FROM sample_cluster_runs r WHERE r.id=NEW.run_id AND r.algorithm_selection_id=NEW.algorithm_selection_id AND r.status='complete')THEN RAISE EXCEPTION 'cluster selection requires a complete matching run' USING ERRCODE='23514';END IF;END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_algorithm_selections_validate_trg ON sample_retrieval_algorithm_selections;CREATE TRIGGER sample_retrieval_algorithm_selections_validate_trg BEFORE INSERT ON sample_retrieval_algorithm_selections FOR EACH ROW EXECUTE FUNCTION sample_stage4_selection_guard();
DROP TRIGGER IF EXISTS sample_cluster_selections_validate_trg ON sample_cluster_selections;CREATE TRIGGER sample_cluster_selections_validate_trg BEFORE INSERT ON sample_cluster_selections FOR EACH ROW EXECUTE FUNCTION sample_stage4_selection_guard();

CREATE OR REPLACE FUNCTION sample_stage4_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n INT;bad INT;BEGIN
 IF TG_OP='DELETE' AND OLD.status='complete' THEN RAISE EXCEPTION 'complete profile is immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='UPDATE' AND OLD.status='complete' THEN RAISE EXCEPTION 'complete profile is immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='INSERT' AND NEW.status<>'building' THEN RAISE EXCEPTION 'profile starts building' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT'AND NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.algorithm_id=NEW.algorithm_id AND b.status='running')THEN RAISE EXCEPTION 'profile requires its running algorithm build' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND NEW.status='complete' THEN SELECT count(*),count(*)FILTER(WHERE v.dimension_key IS NULL) INTO n,bad FROM sample_analysis_dimensions d LEFT JOIN sample_retrieval_dimension_vectors v ON v.profile_id=NEW.id AND v.dimension_key=d.dimension_key;
   IF n<>15 OR bad<>0 THEN RAISE EXCEPTION 'complete sample profile requires exactly 15 canonical vectors' USING ERRCODE='23514';END IF;
   IF NOT EXISTS(SELECT 1 FROM sample_analysis_versions av WHERE av.id=NEW.analysis_version_id AND av.sample_id=NEW.sample_id AND av.status='complete')THEN RAISE EXCEPTION 'profile analysis must be complete' USING ERRCODE='23514';END IF;
 END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_profiles_guard_trg ON sample_retrieval_profiles;
CREATE TRIGGER sample_retrieval_profiles_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_retrieval_profiles FOR EACH ROW EXECUTE FUNCTION sample_stage4_profile_guard();

CREATE OR REPLACE FUNCTION sample_stage4_build_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF TG_OP<>'INSERT'THEN RAISE EXCEPTION 'build items are append-only' USING ERRCODE='55000';END IF;IF NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.status='running')THEN RAISE EXCEPTION 'build items require a running build' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_build_items_guard_trg ON sample_retrieval_build_items;CREATE TRIGGER sample_retrieval_build_items_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_retrieval_build_items FOR EACH ROW EXECUTE FUNCTION sample_stage4_build_item_guard();

CREATE OR REPLACE FUNCTION sample_stage4_profile_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s TEXT;pid BIGINT;BEGIN pid:=CASE WHEN TG_OP='DELETE'THEN OLD.profile_id ELSE NEW.profile_id END;SELECT status INTO s FROM sample_retrieval_profiles WHERE id=pid;
 IF s='complete'THEN RAISE EXCEPTION 'complete profile children are immutable' USING ERRCODE='55000';END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_vectors_guard_trg ON sample_retrieval_dimension_vectors;
CREATE TRIGGER sample_retrieval_vectors_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_retrieval_dimension_vectors FOR EACH ROW EXECUTE FUNCTION sample_stage4_profile_child_guard();

CREATE OR REPLACE FUNCTION sample_stage4_vector_numeric_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE calculated_norm BIGINT;calculated_nonzero INT;BEGIN SELECT COALESCE(sum(x::bigint*x::bigint),0),count(*)FILTER(WHERE x<>0)INTO calculated_norm,calculated_nonzero FROM unnest(NEW.vector)x;
 IF EXISTS(SELECT 1 FROM unnest(NEW.vector)x WHERE x=-32768)THEN RAISE EXCEPTION 'Q15 vectors may not contain -32768' USING ERRCODE='23514';END IF;
 IF calculated_norm<>NEW.norm_sq OR calculated_nonzero<>NEW.nonzero_count THEN RAISE EXCEPTION 'vector norm_sq/nonzero_count must equal its Q15 array' USING ERRCODE='23514';END IF;
 IF NEW.band_0<>(substring(NEW.simhash FROM 1 FOR 8)::bit(8)::int)OR NEW.band_1<>(substring(NEW.simhash FROM 9 FOR 8)::bit(8)::int)OR NEW.band_2<>(substring(NEW.simhash FROM 17 FOR 8)::bit(8)::int)OR NEW.band_3<>(substring(NEW.simhash FROM 25 FOR 8)::bit(8)::int)OR NEW.band_4<>(substring(NEW.simhash FROM 33 FOR 8)::bit(8)::int)OR NEW.band_5<>(substring(NEW.simhash FROM 41 FOR 8)::bit(8)::int)OR NEW.band_6<>(substring(NEW.simhash FROM 49 FOR 8)::bit(8)::int)OR NEW.band_7<>(substring(NEW.simhash FROM 57 FOR 8)::bit(8)::int)THEN RAISE EXCEPTION 'LSH bands must match simhash big-endian bit order' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_vectors_numeric_trg ON sample_retrieval_dimension_vectors;CREATE TRIGGER sample_retrieval_vectors_numeric_trg BEFORE INSERT OR UPDATE ON sample_retrieval_dimension_vectors FOR EACH ROW EXECUTE FUNCTION sample_stage4_vector_numeric_guard();
DROP TRIGGER IF EXISTS component_retrieval_vectors_numeric_trg ON component_retrieval_vectors;CREATE TRIGGER component_retrieval_vectors_numeric_trg BEFORE INSERT OR UPDATE ON component_retrieval_vectors FOR EACH ROW EXECUTE FUNCTION sample_stage4_vector_numeric_guard();

CREATE OR REPLACE FUNCTION sample_stage4_component_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n INT;BEGIN IF TG_OP='DELETE'AND OLD.status='complete'THEN RAISE EXCEPTION 'complete component profile immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='UPDATE'AND OLD.status='complete'THEN RAISE EXCEPTION 'complete component profile immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='INSERT'AND NEW.status<>'building'THEN RAISE EXCEPTION 'profile starts building' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT'AND NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.algorithm_id=NEW.algorithm_id AND b.status='running')THEN RAISE EXCEPTION 'component profile requires its running algorithm build' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE'AND NEW.status='complete'THEN SELECT count(*)INTO n FROM component_retrieval_vectors WHERE profile_id=NEW.id;IF n<>1 THEN RAISE EXCEPTION 'complete component profile requires one vector' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM content_components c JOIN content_component_revisions r ON r.id=NEW.revision_id JOIN content_component_revision_decisions d ON d.id=NEW.approving_decision_id WHERE c.id=NEW.component_id AND c.lifecycle_state='active'AND r.state='approved'AND d.decision='approved')THEN RAISE EXCEPTION 'component profile must pin active approved revision' USING ERRCODE='23514';END IF;END IF;
 RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS component_retrieval_profiles_guard_trg ON component_retrieval_profiles;
CREATE TRIGGER component_retrieval_profiles_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON component_retrieval_profiles FOR EACH ROW EXECUTE FUNCTION sample_stage4_component_profile_guard();

CREATE OR REPLACE FUNCTION sample_stage4_component_vector_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE s TEXT;BEGIN SELECT status INTO s FROM component_retrieval_profiles WHERE id=CASE WHEN TG_OP='DELETE'THEN OLD.profile_id ELSE NEW.profile_id END;IF s='complete'THEN RAISE EXCEPTION 'complete profile children immutable' USING ERRCODE='55000';END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS component_retrieval_vectors_guard_trg ON component_retrieval_vectors;
CREATE TRIGGER component_retrieval_vectors_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON component_retrieval_vectors FOR EACH ROW EXECUTE FUNCTION sample_stage4_component_vector_guard();

CREATE OR REPLACE FUNCTION sample_stage4_tag_observation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k TEXT;active BOOLEAN;BEGIN SELECT kind,t.active INTO k,active FROM tags t WHERE id=NEW.tag_id;IF k IS DISTINCT FROM NEW.dimension_key OR active IS DISTINCT FROM true THEN RAISE EXCEPTION 'observation tag must be active and match dimension' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM sample_analysis_versions v WHERE v.id=NEW.analysis_version_id AND v.sample_id=NEW.sample_id AND v.status='complete')THEN RAISE EXCEPTION 'observation requires complete analysis' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_element_tag_observations_validate_trg ON sample_element_tag_observations;
CREATE TRIGGER sample_element_tag_observations_validate_trg BEFORE INSERT ON sample_element_tag_observations FOR EACH ROW EXECUTE FUNCTION sample_stage4_tag_observation_guard();

CREATE OR REPLACE FUNCTION sample_stage4_insight_feature_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical BIGINT[];tag_kind TEXT;tag_origin TEXT;observed_state TEXT;BEGIN SELECT array_agg(DISTINCT x ORDER BY x)INTO canonical FROM unnest(NEW.tag_ids)x;IF canonical IS DISTINCT FROM NEW.tag_ids THEN RAISE EXCEPTION 'feature tag_ids must be sorted and distinct' USING ERRCODE='23514';END IF;
 IF NEW.feature_type='single'THEN SELECT kind INTO tag_kind FROM tags WHERE id=NEW.tag_id;IF tag_kind IS DISTINCT FROM NEW.dimension_key THEN RAISE EXCEPTION 'single feature tag kind must match dimension' USING ERRCODE='23514';END IF;END IF;
 IF NEW.source='explicit_observation'THEN SELECT state INTO observed_state FROM sample_element_tag_observations WHERE id=NEW.observation_id;IF observed_state IS DISTINCT FROM NEW.state THEN RAISE EXCEPTION 'explicit feature state must equal its observation state' USING ERRCODE='23514';END IF;END IF;
 IF NEW.source IN('manual_tag','effective_tag')THEN SELECT origin INTO tag_origin FROM sample_element_tags WHERE id=NEW.element_tag_id;IF NEW.source='manual_tag'AND tag_origin IS DISTINCT FROM'manual'THEN RAISE EXCEPTION 'manual feature provenance requires a manual element tag' USING ERRCODE='23514';END IF;END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_insight_run_features_validate_trg ON sample_insight_run_features;CREATE TRIGGER sample_insight_run_features_validate_trg BEFORE INSERT ON sample_insight_run_features FOR EACH ROW EXECUTE FUNCTION sample_stage4_insight_feature_validate();

CREATE OR REPLACE FUNCTION sample_stage4_parent_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
DO $$ DECLARE t TEXT;BEGIN FOREACH t IN ARRAY ARRAY['sample_cluster_run_profiles','sample_clusters','sample_cluster_members','sample_insight_run_members','sample_insight_run_features','sample_insight_statistics']LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_guard_trg',t);EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sample_stage4_parent_child_guard()',t||'_guard_trg',t);END LOOP;END $$;

CREATE OR REPLACE FUNCTION sample_stage4_cluster_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inputs INT;assigned INT;bad INT;BEGIN IF TG_OP='DELETE'OR OLD.status IN('complete','failed')THEN RAISE EXCEPTION 'terminal cluster run immutable' USING ERRCODE='55000';END IF;
 IF NEW.status='complete'AND OLD.status='building'THEN SELECT count(*)INTO inputs FROM sample_cluster_run_profiles WHERE run_id=NEW.id;SELECT count(*)INTO assigned FROM sample_cluster_members WHERE run_id=NEW.id;
 SELECT count(*)INTO bad FROM sample_cluster_members m WHERE m.run_id=NEW.id AND((m.is_outlier AND m.cluster_id IS NOT NULL)OR(NOT m.is_outlier AND m.cluster_id IS NULL));
 IF EXISTS(SELECT 1 FROM sample_clusters c WHERE c.run_id=NEW.id AND((SELECT count(*)FROM sample_cluster_members m WHERE m.run_id=c.run_id AND m.cluster_id=c.id)<3 OR(SELECT count(*)FROM sample_cluster_members m WHERE m.run_id=c.run_id AND m.cluster_id=c.id AND m.representative)<>1 OR NOT EXISTS(SELECT 1 FROM sample_cluster_members m WHERE m.run_id=c.run_id AND m.cluster_id=c.id AND m.sample_id=c.representative_sample_id AND m.representative)))THEN bad:=bad+1;END IF;
 IF inputs<>NEW.profile_count OR assigned<>inputs OR bad<>0 THEN RAISE EXCEPTION 'complete cluster run must assign every input exactly once and validate clusters' USING ERRCODE='23514';END IF;END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_cluster_runs_guard_trg ON sample_cluster_runs;CREATE TRIGGER sample_cluster_runs_guard_trg BEFORE UPDATE OR DELETE ON sample_cluster_runs FOR EACH ROW EXECUTE FUNCTION sample_stage4_cluster_run_guard();

CREATE OR REPLACE FUNCTION sample_stage4_insight_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_insight_runs_guard_trg ON sample_insight_runs;CREATE TRIGGER sample_insight_runs_guard_trg BEFORE UPDATE OR DELETE ON sample_insight_runs FOR EACH ROW EXECUTE FUNCTION sample_stage4_insight_run_guard();

DO $$ DECLARE t TEXT;BEGIN FOREACH t IN ARRAY ARRAY['sample_retrieval_algorithms','sample_retrieval_algorithm_selections','sample_cluster_selections','sample_element_tag_observations']LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_append_only_trg',t);EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sample_stage4_append_only_guard()',t||'_append_only_trg',t);END LOOP;END $$;

CREATE OR REPLACE FUNCTION sample_stage4_mark_sample_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid BIGINT;BEGIN
 IF TG_TABLE_NAME='samples'THEN sid:=COALESCE(NEW.id,OLD.id);
 ELSIF TG_TABLE_NAME='sample_analysis_selections'THEN sid:=NEW.sample_id;
 ELSIF TG_TABLE_NAME='sample_element_decisions'THEN SELECT v.sample_id INTO sid FROM sample_analysis_elements e JOIN sample_analysis_versions v ON v.id=e.version_id JOIN samples s ON s.id=v.sample_id AND s.current_analysis_version_id=v.id WHERE e.id=NEW.element_id;
 ELSIF TG_TABLE_NAME='sample_element_tags'THEN SELECT v.sample_id INTO sid FROM sample_analysis_versions v JOIN samples s ON s.id=v.sample_id AND s.current_analysis_version_id=v.id WHERE v.id=NEW.version_id;
 ELSE RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END IF;
 IF sid IS NULL THEN RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END IF;
 INSERT INTO sample_retrieval_states(sample_id,dirty,dirty_generation)VALUES(sid,true,1)ON CONFLICT(sample_id)DO UPDATE SET dirty=true,dirty_generation=sample_retrieval_states.dirty_generation+1,updated_at=now();RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS sample_stage4_samples_dirty_trg ON samples;CREATE TRIGGER sample_stage4_samples_dirty_trg AFTER UPDATE OF current_analysis_version_id ON samples FOR EACH ROW WHEN(OLD.current_analysis_version_id IS DISTINCT FROM NEW.current_analysis_version_id)EXECUTE FUNCTION sample_stage4_mark_sample_dirty();
DROP TRIGGER IF EXISTS sample_stage4_selection_dirty_trg ON sample_analysis_selections;CREATE TRIGGER sample_stage4_selection_dirty_trg AFTER INSERT ON sample_analysis_selections FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_sample_dirty();
DROP TRIGGER IF EXISTS sample_stage4_decision_dirty_trg ON sample_element_decisions;CREATE TRIGGER sample_stage4_decision_dirty_trg AFTER INSERT ON sample_element_decisions FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_sample_dirty();
DROP TRIGGER IF EXISTS sample_stage4_element_tag_dirty_trg ON sample_element_tags;CREATE TRIGGER sample_stage4_element_tag_dirty_trg AFTER INSERT ON sample_element_tags FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_sample_dirty();

CREATE OR REPLACE FUNCTION sample_stage4_mark_entity_tag_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e TEXT;eid BIGINT;BEGIN e:=CASE WHEN TG_OP='DELETE'THEN OLD.entity ELSE NEW.entity END;eid:=CASE WHEN TG_OP='DELETE'THEN OLD.entity_id ELSE NEW.entity_id END;
 IF e='sample'THEN INSERT INTO sample_retrieval_states(sample_id,dirty,dirty_generation)VALUES(eid,true,1)ON CONFLICT(sample_id)DO UPDATE SET dirty=true,dirty_generation=sample_retrieval_states.dirty_generation+1,updated_at=now();END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS sample_stage4_entity_tag_dirty_trg ON entity_tags;CREATE TRIGGER sample_stage4_entity_tag_dirty_trg AFTER INSERT OR UPDATE OR DELETE ON entity_tags FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_entity_tag_dirty();

CREATE OR REPLACE FUNCTION sample_stage4_mark_tag_dictionary_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.name IS NOT DISTINCT FROM NEW.name AND OLD.active IS NOT DISTINCT FROM NEW.active AND OLD.kind IS NOT DISTINCT FROM NEW.kind THEN RETURN NEW;END IF;
 INSERT INTO sample_retrieval_states(sample_id,dirty,dirty_generation)
 SELECT DISTINCT s.id,true,1 FROM samples s LEFT JOIN entity_tags et ON et.entity='sample'AND et.entity_id=s.id LEFT JOIN sample_analysis_elements e ON e.version_id=s.current_analysis_version_id LEFT JOIN sample_element_tags st ON st.element_id=e.id WHERE et.tag_id=NEW.id OR st.tag_id=NEW.id
 ON CONFLICT(sample_id)DO UPDATE SET dirty=true,dirty_generation=sample_retrieval_states.dirty_generation+1,updated_at=now();
 INSERT INTO component_retrieval_states(component_id,dirty,dirty_generation)SELECT DISTINCT rt.component_id,true,1 FROM content_component_revision_tags rt WHERE rt.tag_id=NEW.id ON CONFLICT(component_id)DO UPDATE SET dirty=true,dirty_generation=component_retrieval_states.dirty_generation+1,updated_at=now();RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_stage4_tag_dictionary_dirty_trg ON tags;CREATE TRIGGER sample_stage4_tag_dictionary_dirty_trg AFTER UPDATE OF name,active,kind ON tags FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_tag_dictionary_dirty();

CREATE OR REPLACE FUNCTION sample_stage4_mark_component_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid BIGINT;BEGIN IF TG_TABLE_NAME='content_components'THEN cid:=COALESCE(NEW.id,OLD.id);ELSE cid:=COALESCE(NEW.component_id,OLD.component_id);END IF;
 INSERT INTO component_retrieval_states(component_id,dirty,dirty_generation)VALUES(cid,true,1)ON CONFLICT(component_id)DO UPDATE SET dirty=true,dirty_generation=component_retrieval_states.dirty_generation+1,updated_at=now();RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS sample_stage4_component_selection_dirty_trg ON content_component_selections;CREATE TRIGGER sample_stage4_component_selection_dirty_trg AFTER INSERT ON content_component_selections FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_component_dirty();
DROP TRIGGER IF EXISTS sample_stage4_component_tag_dirty_trg ON content_component_revision_tags;CREATE TRIGGER sample_stage4_component_tag_dirty_trg AFTER INSERT OR UPDATE OR DELETE ON content_component_revision_tags FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_component_dirty();
DROP TRIGGER IF EXISTS sample_stage4_component_lifecycle_dirty_trg ON content_components;CREATE TRIGGER sample_stage4_component_lifecycle_dirty_trg AFTER UPDATE OF lifecycle_state ON content_components FOR EACH ROW WHEN(OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state)EXECUTE FUNCTION sample_stage4_mark_component_dirty();

COMMIT;
