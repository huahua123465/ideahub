-- Deployment: take a verified PostgreSQL backup, then run this whole file once.
-- Re-running is safe. A failure before COMMIT rolls the transaction back; fix the
-- reported cause and rerun (forward recovery). Do not drop tables or restore an
-- entire production database merely to retry this additive migration.
BEGIN;

-- Account research is deliberately separate from channel_accounts: that table is
-- a business-board projection, while these rows are stable research identities.
CREATE TABLE IF NOT EXISTS research_accounts (
  id                    BIGSERIAL PRIMARY KEY,
  stable_key            TEXT NOT NULL,
  platform              TEXT NOT NULL,
  platform_account_id   TEXT,
  display_name          TEXT,
  handle                TEXT,
  profile_url           TEXT,
  identity_quality      TEXT NOT NULL,
  identity_source       TEXT NOT NULL,
  needs_review          BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT research_accounts_stable_key_chk CHECK (char_length(stable_key) BETWEEN 1 AND 640),
  CONSTRAINT research_accounts_platform_chk CHECK (char_length(platform) BETWEEN 1 AND 80),
  CONSTRAINT research_accounts_identity_quality_chk CHECK (identity_quality IN (
    'platform_id','profile_id','verified_handle','name_candidate','conflict','missing'
  )),
  CONSTRAINT research_accounts_identity_shape_chk CHECK (
    (identity_quality IN ('platform_id','profile_id') AND platform_account_id IS NOT NULL AND NOT needs_review) OR
    (identity_quality='verified_handle' AND handle IS NOT NULL AND NOT needs_review) OR
    (identity_quality IN ('name_candidate','conflict','missing') AND needs_review)
  ),
  CONSTRAINT research_accounts_stable_key_uk UNIQUE(stable_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS research_accounts_platform_id_uidx
  ON research_accounts(platform,platform_account_id) WHERE platform_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS research_accounts_updated_idx ON research_accounts(updated_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS research_account_aliases (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            BIGINT NOT NULL REFERENCES research_accounts(id) ON DELETE RESTRICT,
  platform              TEXT NOT NULL,
  alias_type            TEXT NOT NULL,
  alias_value           TEXT NOT NULL,
  normalized_value      TEXT NOT NULL,
  source_sample_id      BIGINT REFERENCES samples(id) ON DELETE RESTRICT,
  observed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT research_account_aliases_type_chk CHECK (alias_type IN (
    'platform_account_id','profile_id','handle','display_name','profile_url'
  )),
  CONSTRAINT research_account_aliases_value_chk CHECK (
    char_length(alias_value) BETWEEN 1 AND 2000 AND char_length(normalized_value) BETWEEN 1 AND 2000
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS research_account_aliases_identity_uidx
  ON research_account_aliases(account_id,alias_type,normalized_value,COALESCE(source_sample_id,0));
CREATE UNIQUE INDEX IF NOT EXISTS research_account_aliases_stable_uidx
  ON research_account_aliases(platform,alias_type,normalized_value)
  WHERE alias_type IN ('platform_account_id','profile_id');
CREATE INDEX IF NOT EXISTS research_account_aliases_account_time_idx
  ON research_account_aliases(account_id,observed_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS research_account_profile_snapshots (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            BIGINT NOT NULL REFERENCES research_accounts(id) ON DELETE RESTRICT,
  source_sample_id      BIGINT REFERENCES samples(id) ON DELETE RESTRICT,
  source_capture_id     BIGINT,
  snapshot_key          TEXT NOT NULL,
  captured_at           TIMESTAMPTZ NOT NULL,
  display_name          TEXT,
  handle                TEXT,
  profile_url           TEXT,
  profile_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
  snapshot_sha256       TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT research_account_profile_snapshots_key_chk CHECK (char_length(snapshot_key) BETWEEN 1 AND 240),
  CONSTRAINT research_account_profile_snapshots_json_chk CHECK (jsonb_typeof(profile_json)='object'),
  CONSTRAINT research_account_profile_snapshots_sha_chk CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT research_account_profile_snapshots_capture_fk FOREIGN KEY(source_sample_id,source_capture_id)
    REFERENCES sample_captures(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT research_account_profile_snapshots_account_key_uk UNIQUE(account_id,snapshot_key)
);
CREATE INDEX IF NOT EXISTS research_account_profile_snapshots_time_idx
  ON research_account_profile_snapshots(account_id,captured_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS research_account_sample_links (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            BIGINT NOT NULL REFERENCES research_accounts(id) ON DELETE RESTRICT,
  sample_id             BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  identity_quality      TEXT NOT NULL,
  identity_source       TEXT NOT NULL,
  linked_by             BIGINT REFERENCES users(id) ON DELETE SET NULL,
  linked_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT research_account_sample_links_quality_chk CHECK (identity_quality IN (
    'platform_id','profile_id','verified_handle','name_candidate','conflict','missing'
  )),
  CONSTRAINT research_account_sample_links_account_sample_uk UNIQUE(account_id,sample_id),
  CONSTRAINT research_account_sample_links_sample_uk UNIQUE(sample_id)
);
CREATE INDEX IF NOT EXISTS research_account_sample_links_account_idx
  ON research_account_sample_links(account_id,sample_id);

CREATE TABLE IF NOT EXISTS account_research_runs (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            BIGINT NOT NULL REFERENCES research_accounts(id) ON DELETE RESTRICT,
  base_run_id           BIGINT,
  revision              INT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'building',
  source                TEXT NOT NULL,
  observation_start     TIMESTAMPTZ NOT NULL,
  observation_end       TIMESTAMPTZ NOT NULL,
  max_samples           INT NOT NULL,
  include_comments      BOOLEAN NOT NULL DEFAULT true,
  sampling_mode         TEXT,
  eligible_count        INT NOT NULL DEFAULT 0,
  frozen_sample_count   INT NOT NULL DEFAULT 0,
  coverage_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings_json         JSONB NOT NULL DEFAULT '[]'::jsonb,
  normalized_request    JSONB NOT NULL,
  input_sha256          TEXT NOT NULL,
  schema_version        TEXT NOT NULL,
  dto_version           TEXT NOT NULL,
  sampling_rule_version TEXT NOT NULL,
  quality_formula_version TEXT NOT NULL,
  prompt_version        TEXT,
  model_provider        TEXT,
  model_name            TEXT,
  model_version         TEXT,
  requested_by          BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  CONSTRAINT account_research_runs_account_revision_uk UNIQUE(account_id,revision),
  CONSTRAINT account_research_runs_account_id_id_uk UNIQUE(account_id,id),
  CONSTRAINT account_research_runs_id_account_id_uk UNIQUE(id,account_id),
  CONSTRAINT account_research_runs_base_fk FOREIGN KEY(account_id,base_run_id)
    REFERENCES account_research_runs(account_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_runs_status_chk CHECK (status IN ('building','complete','failed')),
  CONSTRAINT account_research_runs_source_chk CHECK (source IN ('ai','manual')),
  CONSTRAINT account_research_runs_window_chk CHECK (observation_end > observation_start),
  CONSTRAINT account_research_runs_counts_chk CHECK (
    revision > 0 AND max_samples BETWEEN 10 AND 500 AND eligible_count >= 0 AND
    frozen_sample_count >= 0 AND frozen_sample_count <= max_samples
  ),
  CONSTRAINT account_research_runs_json_chk CHECK (
    jsonb_typeof(coverage_json)='object' AND jsonb_typeof(warnings_json)='array' AND
    jsonb_typeof(normalized_request)='object'
  ),
  CONSTRAINT account_research_runs_sha_chk CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT account_research_runs_completion_chk CHECK (
    (status='building' AND completed_at IS NULL) OR
    (status='complete' AND completed_at IS NOT NULL) OR status='failed'
  )
);
CREATE INDEX IF NOT EXISTS account_research_runs_account_time_idx
  ON account_research_runs(account_id,revision DESC,id DESC);

ALTER TABLE research_accounts ADD COLUMN IF NOT EXISTS current_run_id BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='research_accounts_current_run_fk' AND conrelid='research_accounts'::regclass) THEN
    ALTER TABLE research_accounts ADD CONSTRAINT research_accounts_current_run_fk
      FOREIGN KEY(id,current_run_id) REFERENCES account_research_runs(account_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS research_accounts_current_run_idx
  ON research_accounts(current_run_id) WHERE current_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_research_run_samples (
  id                    BIGSERIAL PRIMARY KEY,
  run_id                BIGINT NOT NULL,
  account_id            BIGINT NOT NULL,
  sample_id             BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  ordinal               INT NOT NULL,
  title                 TEXT,
  published_at          TIMESTAMPTZ,
  content_type          TEXT,
  inclusion_reasons     TEXT[] NOT NULL,
  time_bucket           TEXT NOT NULL,
  performance_band      TEXT NOT NULL,
  performance_basis     TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_research_run_samples_run_fk FOREIGN KEY(account_id,run_id)
    REFERENCES account_research_runs(account_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_run_samples_link_fk FOREIGN KEY(account_id,sample_id)
    REFERENCES research_account_sample_links(account_id,sample_id) ON DELETE RESTRICT,
  CONSTRAINT account_research_run_samples_ordinal_chk CHECK (ordinal > 0),
  CONSTRAINT account_research_run_samples_reasons_chk CHECK (cardinality(inclusion_reasons) > 0),
  CONSTRAINT account_research_run_samples_run_sample_uk UNIQUE(run_id,sample_id),
  CONSTRAINT account_research_run_samples_run_ordinal_uk UNIQUE(run_id,ordinal),
  CONSTRAINT account_research_run_samples_identity_uk UNIQUE(run_id,account_id,sample_id)
);

CREATE TABLE IF NOT EXISTS account_research_claims (
  id                    BIGSERIAL PRIMARY KEY,
  run_id                BIGINT NOT NULL,
  account_id            BIGINT NOT NULL,
  dimension_key         TEXT NOT NULL,
  ordinal               INT NOT NULL,
  claim_type            TEXT NOT NULL,
  claim_text            TEXT,
  operational_definition TEXT,
  eligible_count        INT NOT NULL,
  present_count         INT NOT NULL,
  prevalence            NUMERIC(8,7),
  time_buckets          TEXT[] NOT NULL DEFAULT '{}',
  limitations           TEXT,
  quality_label         TEXT NOT NULL,
  quality_formula_version TEXT NOT NULL,
  quality_reason_codes  TEXT[] NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_research_claims_run_fk FOREIGN KEY(account_id,run_id)
    REFERENCES account_research_runs(account_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_claims_dimension_chk CHECK (dimension_key IN (
    'identity_positioning','audience_needs','content_supply','expression_mechanism',
    'trust_relationship','community_feedback','conversion_path','temporal_evolution'
  )),
  CONSTRAINT account_research_claims_type_chk CHECK (claim_type IN (
    'observation','interpretation','hypothesis','insufficient'
  )),
  CONSTRAINT account_research_claims_counts_chk CHECK (
    eligible_count >= 0 AND present_count >= 0 AND present_count <= eligible_count AND
    ((eligible_count=0 AND prevalence IS NULL) OR
     (eligible_count>0 AND prevalence IS NOT NULL AND abs(prevalence-(present_count::numeric/eligible_count)) < 0.0000001))
  ),
  CONSTRAINT account_research_claims_text_chk CHECK (
    (claim_type='insufficient' AND claim_text IS NULL) OR
    (claim_type<>'insufficient' AND claim_text IS NOT NULL AND char_length(claim_text) BETWEEN 1 AND 4000)
  ),
  CONSTRAINT account_research_claims_hypothesis_chk CHECK (
    claim_type<>'hypothesis' OR (limitations IS NOT NULL AND char_length(limitations)>0)
  ),
  CONSTRAINT account_research_claims_quality_chk CHECK (quality_label IN (
    'evidence_sufficient','evidence_moderate','hypothesis_only','insufficient'
  )),
  CONSTRAINT account_research_claims_run_ordinal_uk UNIQUE(run_id,ordinal),
  CONSTRAINT account_research_claims_run_id_id_uk UNIQUE(run_id,id),
  CONSTRAINT account_research_claims_identity_uk UNIQUE(account_id,run_id,id)
);
CREATE INDEX IF NOT EXISTS account_research_claims_run_dimension_idx
  ON account_research_claims(run_id,dimension_key,ordinal);

CREATE TABLE IF NOT EXISTS account_research_claim_samples (
  id                    BIGSERIAL PRIMARY KEY,
  run_id                BIGINT NOT NULL,
  claim_id              BIGINT NOT NULL,
  account_id            BIGINT NOT NULL,
  sample_id             BIGINT NOT NULL,
  role                  TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_research_claim_samples_claim_fk FOREIGN KEY(account_id,run_id,claim_id)
    REFERENCES account_research_claims(account_id,run_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_claim_samples_sample_fk FOREIGN KEY(run_id,account_id,sample_id)
    REFERENCES account_research_run_samples(run_id,account_id,sample_id) ON DELETE RESTRICT,
  CONSTRAINT account_research_claim_samples_role_chk CHECK (role IN ('representative','counterexample')),
  CONSTRAINT account_research_claim_samples_identity_uk UNIQUE(claim_id,sample_id,role)
);

-- A canonical evidence row is counted once. Every original body/OCR/image/video/comment
-- location remains in account_research_evidence_locations.
CREATE TABLE IF NOT EXISTS account_research_evidence (
  id                    BIGSERIAL PRIMARY KEY,
  run_id                BIGINT NOT NULL,
  account_id            BIGINT NOT NULL,
  sample_id             BIGINT NOT NULL,
  canonical_text        TEXT NOT NULL,
  content_sha256        TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_research_evidence_run_fk FOREIGN KEY(account_id,run_id)
    REFERENCES account_research_runs(account_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_evidence_sample_fk FOREIGN KEY(run_id,account_id,sample_id)
    REFERENCES account_research_run_samples(run_id,account_id,sample_id) ON DELETE RESTRICT,
  CONSTRAINT account_research_evidence_sha_chk CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT account_research_evidence_text_chk CHECK (char_length(canonical_text) BETWEEN 1 AND 20000),
  CONSTRAINT account_research_evidence_run_content_uk UNIQUE(run_id,sample_id,content_sha256),
  CONSTRAINT account_research_evidence_identity_uk UNIQUE(run_id,id),
  CONSTRAINT account_research_evidence_sample_identity_uk UNIQUE(run_id,id,sample_id)
);

CREATE TABLE IF NOT EXISTS account_research_evidence_locations (
  id                    BIGSERIAL PRIMARY KEY,
  run_id                BIGINT NOT NULL,
  evidence_id           BIGINT NOT NULL,
  sample_id             BIGINT NOT NULL,
  source_capture_id     BIGINT,
  asset_id              BIGINT,
  source_element_evidence_id BIGINT REFERENCES sample_element_evidence(id) ON DELETE RESTRICT,
  profile_snapshot_id   BIGINT,
  source_id             TEXT NOT NULL,
  source_kind           TEXT NOT NULL,
  quote_text            TEXT NOT NULL,
  locator_json          JSONB NOT NULL,
  locator_sha256        TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_research_evidence_locations_evidence_fk FOREIGN KEY(run_id,evidence_id,sample_id)
    REFERENCES account_research_evidence(run_id,id,sample_id) ON DELETE RESTRICT,
  CONSTRAINT account_research_evidence_locations_capture_fk FOREIGN KEY(sample_id,source_capture_id)
    REFERENCES sample_captures(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_evidence_locations_asset_fk FOREIGN KEY(sample_id,asset_id)
    REFERENCES sample_assets(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_evidence_locations_kind_chk CHECK (source_kind IN ('body','image','video','comment','profile')),
  CONSTRAINT account_research_evidence_locations_provenance_chk CHECK (
    (source_kind='profile' AND profile_snapshot_id IS NOT NULL AND source_element_evidence_id IS NULL AND asset_id IS NULL) OR
    (source_kind<>'profile' AND profile_snapshot_id IS NULL AND source_element_evidence_id IS NOT NULL)
  ),
  CONSTRAINT account_research_evidence_locations_quote_chk CHECK (char_length(quote_text) BETWEEN 1 AND 20000),
  CONSTRAINT account_research_evidence_locations_locator_chk CHECK (jsonb_typeof(locator_json)='object'),
  CONSTRAINT account_research_evidence_locations_sha_chk CHECK (locator_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT account_research_evidence_locations_identity_uk UNIQUE(evidence_id,source_id,locator_sha256)
);
ALTER TABLE account_research_evidence_locations ADD COLUMN IF NOT EXISTS profile_snapshot_id BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_research_evidence_locations_profile_fk'
    AND conrelid='account_research_evidence_locations'::regclass) THEN
    ALTER TABLE account_research_evidence_locations ADD CONSTRAINT account_research_evidence_locations_profile_fk
      FOREIGN KEY(profile_snapshot_id) REFERENCES research_account_profile_snapshots(id) ON DELETE RESTRICT;
  END IF;
END $$;
ALTER TABLE account_research_evidence_locations DROP CONSTRAINT IF EXISTS account_research_evidence_locations_kind_chk;
ALTER TABLE account_research_evidence_locations ADD CONSTRAINT account_research_evidence_locations_kind_chk
  CHECK (source_kind IN ('body','image','video','comment','profile'));
ALTER TABLE account_research_evidence_locations DROP CONSTRAINT IF EXISTS account_research_evidence_locations_provenance_chk;
ALTER TABLE account_research_evidence_locations ADD CONSTRAINT account_research_evidence_locations_provenance_chk CHECK (
  (source_kind='profile' AND profile_snapshot_id IS NOT NULL AND source_element_evidence_id IS NULL AND asset_id IS NULL) OR
  (source_kind<>'profile' AND profile_snapshot_id IS NULL AND source_element_evidence_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS account_research_claim_evidence (
  id                    BIGSERIAL PRIMARY KEY,
  run_id                BIGINT NOT NULL,
  claim_id              BIGINT NOT NULL,
  evidence_id           BIGINT NOT NULL,
  direction             TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_research_claim_evidence_claim_fk FOREIGN KEY(run_id,claim_id)
    REFERENCES account_research_claims(run_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_claim_evidence_evidence_fk FOREIGN KEY(run_id,evidence_id)
    REFERENCES account_research_evidence(run_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_claim_evidence_direction_chk CHECK (direction IN ('support','challenge')),
  CONSTRAINT account_research_claim_evidence_identity_uk UNIQUE(claim_id,evidence_id,direction)
);

CREATE TABLE IF NOT EXISTS account_research_decisions (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            BIGINT NOT NULL,
  run_id                BIGINT NOT NULL,
  claim_id              BIGINT NOT NULL,
  decision              TEXT NOT NULL,
  claim_text            TEXT,
  operational_definition TEXT,
  limitations           TEXT,
  note                  TEXT,
  idempotency_key       TEXT NOT NULL,
  request_sha256        TEXT NOT NULL,
  decided_by            BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decided_by_role       TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_research_decisions_claim_fk FOREIGN KEY(account_id,run_id,claim_id)
    REFERENCES account_research_claims(account_id,run_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_decisions_decision_chk CHECK (decision IN ('confirmed','edited','rejected')),
  CONSTRAINT account_research_decisions_role_chk CHECK (decided_by_role IN ('reviewer','admin')),
  CONSTRAINT account_research_decisions_edit_chk CHECK (
    (decision='edited' AND claim_text IS NOT NULL AND char_length(claim_text) BETWEEN 1 AND 4000
      AND limitations IS NOT NULL AND char_length(limitations)>0) OR
    (decision IN ('confirmed','rejected') AND claim_text IS NULL AND operational_definition IS NULL AND limitations IS NULL)
  ),
  CONSTRAINT account_research_decisions_key_chk CHECK (char_length(idempotency_key) BETWEEN 1 AND 160),
  CONSTRAINT account_research_decisions_sha_chk CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT account_research_decisions_claim_key_uk UNIQUE(claim_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS account_research_decisions_latest_idx
  ON account_research_decisions(claim_id,created_at DESC,id DESC);
ALTER TABLE account_research_decisions DROP CONSTRAINT IF EXISTS account_research_decisions_edit_chk;
ALTER TABLE account_research_decisions ADD CONSTRAINT account_research_decisions_edit_chk CHECK (
  (decision='edited' AND claim_text IS NOT NULL AND char_length(claim_text) BETWEEN 1 AND 4000
    AND limitations IS NOT NULL AND char_length(limitations)>0) OR
  (decision IN ('confirmed','rejected') AND claim_text IS NULL AND operational_definition IS NULL AND limitations IS NULL)
);

CREATE TABLE IF NOT EXISTS account_research_quality_reports (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            BIGINT NOT NULL,
  run_id                BIGINT NOT NULL,
  revision              INT NOT NULL,
  formula_version       TEXT NOT NULL,
  report_json           JSONB NOT NULL,
  created_by            BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_research_quality_reports_run_fk FOREIGN KEY(account_id,run_id)
    REFERENCES account_research_runs(account_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_quality_reports_revision_chk CHECK (revision > 0),
  CONSTRAINT account_research_quality_reports_json_chk CHECK (jsonb_typeof(report_json)='object'),
  CONSTRAINT account_research_quality_reports_run_revision_uk UNIQUE(run_id,revision)
);

CREATE TABLE IF NOT EXISTS account_research_selections (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            BIGINT NOT NULL,
  run_id                BIGINT NOT NULL,
  reason                TEXT NOT NULL,
  selected_by           BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_research_selections_run_fk FOREIGN KEY(account_id,run_id)
    REFERENCES account_research_runs(account_id,id) ON DELETE RESTRICT,
  CONSTRAINT account_research_selections_reason_chk CHECK (reason IN ('run_complete','rerun_complete','explicit'))
);

CREATE TABLE IF NOT EXISTS account_research_idempotency (
  id                    BIGSERIAL PRIMARY KEY,
  aggregate_key         TEXT NOT NULL,
  action                TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  request_sha256        TEXT NOT NULL,
  response_kind         TEXT,
  response_id           BIGINT,
  response_status       INT,
  created_by            BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_research_idempotency_lengths_chk CHECK (
    char_length(aggregate_key) BETWEEN 1 AND 700 AND char_length(action) BETWEEN 1 AND 40 AND
    char_length(idempotency_key) BETWEEN 1 AND 160
  ),
  CONSTRAINT account_research_idempotency_sha_chk CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT account_research_idempotency_status_chk CHECK (
    response_status IS NULL OR response_status BETWEEN 200 AND 299
  ),
  CONSTRAINT account_research_idempotency_identity_uk UNIQUE(aggregate_key,action,idempotency_key)
);

CREATE OR REPLACE FUNCTION account_research_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='55000';
END $$;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'research_account_aliases','research_account_profile_snapshots','research_account_sample_links',
    'account_research_decisions','account_research_quality_reports','account_research_selections'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_append_only_trg',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION account_research_append_only_guard()',t||'_append_only_trg',t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION account_research_child_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid BIGINT; parent_status TEXT;
BEGIN
  rid := CASE WHEN TG_OP='DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  -- Serialize child insertion with the parent's building -> complete transition.
  SELECT status INTO parent_status FROM account_research_runs WHERE id=rid FOR UPDATE;
  IF TG_OP IN ('UPDATE','DELETE') OR parent_status IS DISTINCT FROM 'building' THEN
    RAISE EXCEPTION 'account research run children are append-only after creation' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'account_research_run_samples','account_research_claims','account_research_claim_samples',
    'account_research_evidence','account_research_evidence_locations','account_research_claim_evidence'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_guard_trg',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION account_research_child_guard()',t||'_guard_trg',t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION account_research_validate_depth(p_run_id BIGINT,p_matrix JSONB,p_saturation JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  r account_research_runs%ROWTYPE; c RECORD; g RECORD; matrix_row JSONB; matrix_cell JSONB; batch_json JSONB;
  expected_ids BIGINT[]; expected_codes TEXT[]; expected_new TEXT[]; seen_codes TEXT[]:=ARRAY[]::TEXT[];
  match_count INT; row_count INT:=0; membership_total INT:=0; unique_total INT; cell_count INT;
  batch_count INT; batch_no INT; expected_status TEXT; expected_reached BOOLEAN; ratio NUMERIC; current_code TEXT;
BEGIN
  SELECT * INTO r FROM account_research_runs WHERE id=p_run_id;
  IF jsonb_typeof(p_matrix)<>'object' OR p_matrix->'periods'<>to_jsonb(ARRAY['early','middle','recent','unknown']::TEXT[])
     OR jsonb_typeof(p_matrix->'rows')<>'array' OR jsonb_typeof(p_matrix->'limitations')<>'array' THEN RETURN false; END IF;
  FOR c IN SELECT * FROM account_research_claims WHERE run_id=p_run_id AND dimension_key='content_supply' AND claim_type<>'insufficient' ORDER BY pattern_code LOOP
    row_count:=row_count+1;
    SELECT COALESCE(array_agg(DISTINCT cs.sample_id ORDER BY cs.sample_id),ARRAY[]::BIGINT[]) INTO expected_ids
      FROM account_research_claim_samples cs WHERE cs.claim_id=c.id AND cs.role='present';
    membership_total:=membership_total+cardinality(expected_ids);
    SELECT count(*),(array_agg(value))[1] INTO match_count,matrix_row FROM jsonb_array_elements(p_matrix->'rows') x(value)
      WHERE value->>'patternCode'=c.pattern_code;
    IF match_count<>1 OR matrix_row->>'contentGoal' IS DISTINCT FROM c.content_goal OR
       matrix_row->'sampleIds'<>to_jsonb(expected_ids) OR (matrix_row->>'count')::INT<>cardinality(expected_ids) OR
       jsonb_typeof(matrix_row->'cells')<>'array' THEN RETURN false; END IF;
    SELECT count(*) INTO cell_count FROM (
      SELECT COALESCE(NULLIF(s.content_type,''),'unknown') format,
        CASE WHEN s.published_at IS NULL THEN 'unknown'
          WHEN s.published_at<r.observation_start+(r.observation_end-r.observation_start)/3 THEN 'early'
          WHEN s.published_at<r.observation_start+2*(r.observation_end-r.observation_start)/3 THEN 'middle' ELSE 'recent' END period
      FROM account_research_claim_samples cs JOIN account_research_run_samples s ON s.run_id=cs.run_id AND s.sample_id=cs.sample_id
      WHERE cs.claim_id=c.id AND cs.role='present' GROUP BY 1,2) q;
    IF jsonb_array_length(matrix_row->'cells')<>cell_count THEN RETURN false; END IF;
    FOR g IN SELECT COALESCE(NULLIF(s.content_type,''),'unknown') format,
        CASE WHEN s.published_at IS NULL THEN 'unknown'
          WHEN s.published_at<r.observation_start+(r.observation_end-r.observation_start)/3 THEN 'early'
          WHEN s.published_at<r.observation_start+2*(r.observation_end-r.observation_start)/3 THEN 'middle' ELSE 'recent' END period,
        array_agg(DISTINCT s.sample_id ORDER BY s.sample_id) sample_ids
      FROM account_research_claim_samples cs JOIN account_research_run_samples s ON s.run_id=cs.run_id AND s.sample_id=cs.sample_id
      WHERE cs.claim_id=c.id AND cs.role='present' GROUP BY 1,2 LOOP
      SELECT count(*),(array_agg(value))[1] INTO match_count,matrix_cell FROM jsonb_array_elements(matrix_row->'cells') x(value)
        WHERE value->>'format'=g.format AND value->>'period'=g.period;
      IF match_count<>1 OR matrix_cell->'sampleIds'<>to_jsonb(g.sample_ids) OR
         (matrix_cell->>'count')::INT<>cardinality(g.sample_ids) THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  SELECT count(DISTINCT cs.sample_id) INTO unique_total FROM account_research_claim_samples cs
    JOIN account_research_claims cl ON cl.id=cs.claim_id
    WHERE cl.run_id=p_run_id AND cl.dimension_key='content_supply' AND cl.claim_type<>'insufficient' AND cs.role='present';
  IF jsonb_array_length(p_matrix->'rows')<>row_count OR (p_matrix->>'membershipTotal')::INT<>membership_total OR
     (p_matrix->>'uniqueSampleCount')::INT<>unique_total OR
     p_matrix->>'status' IS DISTINCT FROM (CASE WHEN row_count>0 THEN 'measured' ELSE 'insufficient' END) THEN RETURN false; END IF;
  IF jsonb_typeof(p_saturation)<>'object' OR p_saturation->>'ruleVersion'<>'saturation/1.0' OR
     (p_saturation->>'threshold')::NUMERIC<>0.05 OR (p_saturation->>'batchSize')::INT<>5 OR
     jsonb_typeof(p_saturation->'batches')<>'array' OR p_saturation->'observations'<>p_saturation->'batches' OR
     jsonb_typeof(p_saturation->'limitations')<>'array' THEN RETURN false; END IF;
  SELECT CEIL(count(*)/5.0)::INT INTO batch_count FROM account_research_run_samples WHERE run_id=p_run_id;
  IF jsonb_array_length(p_saturation->'batches')<>batch_count THEN RETURN false; END IF;
  IF batch_count>0 THEN FOR batch_no IN 1..batch_count LOOP
    SELECT COALESCE(array_agg(code ORDER BY ordinal),ARRAY[]::TEXT[]) INTO expected_codes FROM (
      SELECT cl.ordinal,cl.dimension_key||'/'||cl.pattern_code code FROM account_research_claims cl
      WHERE cl.run_id=p_run_id AND cl.claim_type<>'insufficient' AND EXISTS(
        SELECT 1 FROM account_research_claim_samples cs JOIN account_research_run_samples s ON s.run_id=cs.run_id AND s.sample_id=cs.sample_id
        WHERE cs.claim_id=cl.id AND cs.role='present' GROUP BY cs.claim_id HAVING min(s.ordinal) BETWEEN (batch_no-1)*5+1 AND batch_no*5)
      ORDER BY cl.ordinal) q;
    expected_new:=ARRAY[]::TEXT[];
    FOREACH current_code IN ARRAY expected_codes LOOP IF NOT current_code=ANY(seen_codes) THEN expected_new:=array_append(expected_new,current_code);seen_codes:=array_append(seen_codes,current_code);END IF;END LOOP;
    batch_json:=(p_saturation->'batches')->(batch_no-1);
    ratio:=cardinality(expected_new)::NUMERIC/GREATEST(1,cardinality(seen_codes));
    IF jsonb_typeof(batch_json)<>'object' OR (batch_json->>'batch')::INT<>batch_no OR batch_json->'codes'<>to_jsonb(expected_codes) OR
       (batch_json->>'codeCount')::INT<>cardinality(expected_codes) OR batch_json->'newCodes'<>to_jsonb(expected_new) OR
       (batch_json->>'newCodeCount')::INT<>cardinality(expected_new) OR
       (batch_json->>'cumulativeCodeCount')::INT<>cardinality(seen_codes) OR
       abs((batch_json->>'newCodeRatio')::NUMERIC-ratio)>0.000000000001 THEN RETURN false; END IF;
  END LOOP; END IF;
  expected_status:=CASE WHEN batch_count>=3 AND cardinality(seen_codes)>0 THEN 'measured' ELSE 'insufficient' END;
  IF expected_status='measured' THEN expected_reached:=
    ((p_saturation->'batches'->(batch_count-1)->>'newCodeRatio')::NUMERIC<=0.05) AND
    ((p_saturation->'batches'->(batch_count-2)->>'newCodeRatio')::NUMERIC<=0.05); ELSE expected_reached:=false; END IF;
  IF (p_saturation->>'totalCodes')::INT<>cardinality(seen_codes) OR p_saturation->>'status'<>expected_status OR
     (p_saturation->>'reached')::BOOLEAN IS DISTINCT FROM expected_reached THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'depth validation error: %',SQLERRM USING ERRCODE='23514';
END $$;

CREATE OR REPLACE FUNCTION account_research_run_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sample_count INT; claim_count INT; dimension_count INT;
BEGIN
  IF TG_OP='DELETE' OR OLD.status IN ('complete','failed') THEN
    RAISE EXCEPTION 'terminal account research runs are immutable' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['status','completed_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','completed_at']) THEN
    RAISE EXCEPTION 'account research run inputs are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.status='complete' THEN
    SELECT count(*) INTO sample_count FROM account_research_run_samples WHERE run_id=NEW.id;
    SELECT count(*),count(DISTINCT dimension_key) INTO claim_count,dimension_count
      FROM account_research_claims WHERE run_id=NEW.id;
    IF sample_count<>NEW.frozen_sample_count OR claim_count<>8 OR dimension_count<>8 THEN
      RAISE EXCEPTION 'complete account research run requires its frozen samples and eight dimensions' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_research_runs_guard_trg ON account_research_runs;
CREATE TRIGGER account_research_runs_guard_trg
  BEFORE UPDATE OR DELETE ON account_research_runs FOR EACH ROW EXECUTE FUNCTION account_research_run_guard();

CREATE OR REPLACE FUNCTION account_research_evidence_location_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_value BIGINT; field_value TEXT;
BEGIN
  SELECT account_id INTO account_value FROM account_research_evidence WHERE run_id=NEW.run_id AND id=NEW.evidence_id;
  IF NEW.source_kind='profile' THEN
    IF NOT (NEW.locator_json ? 'profileField') OR (NEW.locator_json->>'profileField') NOT IN
      ('displayName','handle','profileUrl','bio','qualification','description') THEN
      RAISE EXCEPTION 'profile evidence requires an allowed snapshot field' USING ERRCODE='23514';
    END IF;
    SELECT CASE NEW.locator_json->>'profileField' WHEN 'displayName' THEN display_name WHEN 'handle' THEN handle
      WHEN 'profileUrl' THEN profile_url ELSE profile_json->>(NEW.locator_json->>'profileField') END INTO field_value
      FROM research_account_profile_snapshots WHERE id=NEW.profile_snapshot_id AND account_id=account_value
        AND source_sample_id=NEW.sample_id AND source_capture_id IS NOT DISTINCT FROM NEW.source_capture_id;
    IF field_value IS NULL OR field_value IS DISTINCT FROM NEW.quote_text THEN
      RAISE EXCEPTION 'profile evidence must equal an immutable snapshot field' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM sample_element_evidence ee
    JOIN sample_analysis_elements element ON element.id=ee.element_id AND element.version_id=ee.version_id
    JOIN sample_analysis_versions version ON version.id=ee.version_id AND version.status='complete'
    JOIN sample_evidence_sources source ON source.version_id=ee.version_id AND source.source_id=ee.source_id
    LEFT JOIN sample_assets asset ON asset.id=source.asset_id AND asset.sample_id=version.sample_id AND asset.deleted_at IS NULL
    WHERE ee.id=NEW.source_element_evidence_id AND ee.verification_status='verified'
      AND version.sample_id=NEW.sample_id AND source.source_capture_id=NEW.source_capture_id
      AND source.asset_id IS NOT DISTINCT FROM NEW.asset_id AND ee.quote_text=NEW.quote_text
      AND ((NEW.source_kind='body' AND source.source_kind='body' AND NEW.asset_id IS NULL
            AND ee.start_offset=(NEW.locator_json->>'startOffset')::INT AND ee.end_offset=(NEW.locator_json->>'endOffset')::INT)
        OR (NEW.source_kind='comment' AND source.source_kind='comment' AND NEW.asset_id IS NULL
            AND ee.comment_ref=NEW.locator_json->>'commentRef')
        OR (NEW.source_kind='image' AND asset.kind IN ('cover','image')
            AND (source.locator->>'imageIndex')::INT=(NEW.locator_json->>'imageIndex')::INT
            AND (NEW.locator_json->>'imageIndex')::INT=1+(SELECT count(*) FROM sample_assets preceding
              WHERE preceding.sample_id=NEW.sample_id AND preceding.deleted_at IS NULL AND preceding.kind IN ('cover','image')
                AND (preceding.created_at,preceding.id)<(asset.created_at,asset.id))
            AND (NOT (NEW.locator_json ? 'region') OR (jsonb_typeof(NEW.locator_json->'region')='object'
              AND jsonb_typeof(NEW.locator_json#>'{region,x}')='number' AND jsonb_typeof(NEW.locator_json#>'{region,y}')='number'
              AND jsonb_typeof(NEW.locator_json#>'{region,width}')='number' AND jsonb_typeof(NEW.locator_json#>'{region,height}')='number'
              AND (NEW.locator_json#>>'{region,x}')::numeric BETWEEN 0 AND 1
              AND (NEW.locator_json#>>'{region,y}')::numeric BETWEEN 0 AND 1
              AND (NEW.locator_json#>>'{region,width}')::numeric>0 AND (NEW.locator_json#>>'{region,height}')::numeric>0
              AND (NEW.locator_json#>>'{region,x}')::numeric+(NEW.locator_json#>>'{region,width}')::numeric<=1
              AND (NEW.locator_json#>>'{region,y}')::numeric+(NEW.locator_json#>>'{region,height}')::numeric<=1))
            AND COALESCE(source.locator->'region','null'::jsonb)=COALESCE(NEW.locator_json->'region','null'::jsonb))
        OR (NEW.source_kind='video' AND asset.kind='video' AND asset.duration_ms IS NOT NULL
            AND ee.time_start_ms=(NEW.locator_json->>'timeStartMs')::BIGINT
            AND ee.time_end_ms=(NEW.locator_json->>'timeEndMs')::BIGINT
            AND ee.time_end_ms<=asset.duration_ms))
  ) THEN
    RAISE EXCEPTION 'evidence must match immutable verified source, capture, asset, quote and locator' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_research_evidence_locations_validate_trg ON account_research_evidence_locations;
CREATE TRIGGER account_research_evidence_locations_validate_trg
  BEFORE INSERT ON account_research_evidence_locations FOR EACH ROW
  EXECUTE FUNCTION account_research_evidence_location_validate();

CREATE OR REPLACE FUNCTION account_research_decision_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_role TEXT; run_status TEXT;
BEGIN
  SELECT role::text INTO actual_role FROM users WHERE id=NEW.decided_by;
  SELECT status INTO run_status FROM account_research_runs WHERE id=NEW.run_id AND account_id=NEW.account_id;
  IF actual_role NOT IN ('reviewer','admin') OR actual_role IS DISTINCT FROM NEW.decided_by_role THEN
    RAISE EXCEPTION 'account research decisions require a reviewer or admin' USING ERRCODE='42501';
  END IF;
  IF run_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'only complete account research runs can be reviewed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_research_decisions_validate_trg ON account_research_decisions;
CREATE TRIGGER account_research_decisions_validate_trg
  BEFORE INSERT ON account_research_decisions FOR EACH ROW EXECUTE FUNCTION account_research_decision_validate();

-- account-research/1.1: auditable multi-claim depth, persisted matrix and saturation.
ALTER TABLE account_research_runs ADD COLUMN IF NOT EXISTS content_matrix_json JSONB;
ALTER TABLE account_research_runs ADD COLUMN IF NOT EXISTS saturation_json JSONB;
ALTER TABLE account_research_claims ADD COLUMN IF NOT EXISTS pattern_code TEXT;
ALTER TABLE account_research_claims ADD COLUMN IF NOT EXISTS content_goal TEXT;

DROP TRIGGER IF EXISTS account_research_runs_guard_trg ON account_research_runs;
UPDATE account_research_runs
SET status='failed',
    warnings_json=CASE WHEN warnings_json ? 'legacy_v1_build_aborted' THEN warnings_json
      ELSE warnings_json||'["legacy_v1_build_aborted"]'::jsonb END,
    normalized_request=normalized_request||'{"legacy_v1_build_aborted":true}'::jsonb
WHERE schema_version='account-research/1.0' AND status='building';

ALTER TABLE account_research_claim_samples DROP CONSTRAINT IF EXISTS account_research_claim_samples_role_chk;
ALTER TABLE account_research_claim_samples ADD CONSTRAINT account_research_claim_samples_role_chk
  CHECK(role IN ('eligible','present','representative','counterexample'));
ALTER TABLE account_research_claims DROP CONSTRAINT IF EXISTS account_research_claims_pattern_chk;
ALTER TABLE account_research_claims ADD CONSTRAINT account_research_claims_pattern_chk
  CHECK(pattern_code IS NULL OR pattern_code ~ '^[a-z0-9_]{3,64}$');
ALTER TABLE account_research_claims DROP CONSTRAINT IF EXISTS account_research_claims_content_goal_chk;
ALTER TABLE account_research_claims ADD CONSTRAINT account_research_claims_content_goal_chk CHECK(
  (dimension_key='content_supply' AND claim_type<>'insufficient' AND content_goal IN ('traffic','persona','expertise','relationship','conversion','mixed')) OR
  ((dimension_key<>'content_supply' OR claim_type='insufficient') AND content_goal IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS account_research_claims_run_dimension_pattern_uk
  ON account_research_claims(run_id,dimension_key,pattern_code) WHERE pattern_code IS NOT NULL;

CREATE OR REPLACE FUNCTION account_research_run_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sample_count INT; sample_distinct_ordinals INT; sample_min_ordinal INT; sample_max_ordinal INT; claim_count INT; dimension_count INT; invalid_dimensions INT; invalid_memberships INT; outside_count INT; null_patterns INT;
BEGIN
  IF TG_OP='DELETE' OR OLD.status IN ('complete','failed') THEN
    RAISE EXCEPTION 'terminal account research runs are immutable' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['status','completed_at','content_matrix_json','saturation_json']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','completed_at','content_matrix_json','saturation_json']) THEN
    RAISE EXCEPTION 'account research run inputs are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.status='complete' THEN
    SELECT count(*),count(DISTINCT ordinal),min(ordinal),max(ordinal) INTO sample_count,sample_distinct_ordinals,sample_min_ordinal,sample_max_ordinal FROM account_research_run_samples WHERE run_id=NEW.id;
    SELECT count(*),count(DISTINCT dimension_key) INTO claim_count,dimension_count FROM account_research_claims WHERE run_id=NEW.id;
    IF sample_count<>NEW.frozen_sample_count OR (sample_count>0 AND (sample_distinct_ordinals<>sample_count OR sample_min_ordinal<>1 OR sample_max_ordinal<>sample_count)) THEN RAISE EXCEPTION 'complete account research run requires contiguous frozen sample ordinals' USING ERRCODE='23514'; END IF;
    IF NEW.schema_version='account-research/1.1' THEN
      SELECT count(*) INTO invalid_dimensions FROM (
        SELECT dimension_key FROM account_research_claims WHERE run_id=NEW.id GROUP BY dimension_key HAVING count(*) NOT BETWEEN 1 AND 5
      ) q;
      SELECT count(*) INTO null_patterns FROM account_research_claims WHERE run_id=NEW.id AND pattern_code IS NULL;
      IF claim_count NOT BETWEEN 8 AND 40 OR dimension_count<>8 OR invalid_dimensions<>0 OR null_patterns<>0 THEN
        RAISE EXCEPTION 'complete account research 1.1 run requires 1-5 claims in all eight dimensions (claims %, dimensions %, invalid %, null patterns %)',claim_count,dimension_count,invalid_dimensions,null_patterns USING ERRCODE='23514';
      END IF;
      SELECT count(*) INTO invalid_memberships FROM account_research_claims c WHERE c.run_id=NEW.id AND (
        c.eligible_count<>(SELECT count(*) FROM account_research_claim_samples cs WHERE cs.claim_id=c.id AND cs.role='eligible') OR
        c.present_count<>(SELECT count(*) FROM account_research_claim_samples cs WHERE cs.claim_id=c.id AND cs.role='present') OR
        EXISTS(SELECT 1 FROM account_research_claim_samples cs WHERE cs.claim_id=c.id AND cs.role IN ('present','representative','counterexample')
          AND NOT EXISTS(SELECT 1 FROM account_research_claim_samples e WHERE e.claim_id=c.id AND e.sample_id=cs.sample_id AND e.role='eligible')) OR
        EXISTS(SELECT 1 FROM account_research_claim_samples cs WHERE cs.claim_id=c.id AND cs.role='representative'
          AND NOT EXISTS(SELECT 1 FROM account_research_claim_samples p WHERE p.claim_id=c.id AND p.sample_id=cs.sample_id AND p.role='present')) OR
        EXISTS(SELECT 1 FROM account_research_claim_samples cs WHERE cs.claim_id=c.id AND cs.role='counterexample'
          AND EXISTS(SELECT 1 FROM account_research_claim_samples p WHERE p.claim_id=c.id AND p.sample_id=cs.sample_id AND p.role='present')));
      IF invalid_memberships<>0 THEN RAISE EXCEPTION 'claim sample counts or subset memberships invalid' USING ERRCODE='23514'; END IF;
      SELECT count(*) INTO outside_count FROM account_research_run_samples s WHERE s.run_id=NEW.id AND s.published_at IS NOT NULL
        AND (s.published_at<NEW.observation_start OR s.published_at>NEW.observation_end);
      IF outside_count<>0 THEN RAISE EXCEPTION 'run sample outside observation window' USING ERRCODE='23514'; END IF;
      IF NEW.content_matrix_json IS NULL OR jsonb_typeof(NEW.content_matrix_json)<>'object' OR
         NEW.saturation_json IS NULL OR jsonb_typeof(NEW.saturation_json)<>'object' OR
         NEW.saturation_json->>'ruleVersion'<>'saturation/1.0' THEN
        RAISE EXCEPTION 'complete account research 1.1 run requires matrix and saturation' USING ERRCODE='23514';
      END IF;
      IF NOT account_research_validate_depth(NEW.id,NEW.content_matrix_json,NEW.saturation_json) THEN
        RAISE EXCEPTION 'persisted matrix or saturation does not match frozen research members' USING ERRCODE='23514';
      END IF;
    ELSIF claim_count<>8 OR dimension_count<>8 THEN
      RAISE EXCEPTION 'complete legacy account research run requires eight dimensions' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_research_runs_guard_trg BEFORE UPDATE OR DELETE ON account_research_runs
  FOR EACH ROW EXECUTE FUNCTION account_research_run_guard();

COMMIT;

-- Post-migration smoke query (read-only): should return 15 tables. The isolated
-- migration test performs the authoritative catalog/FK/index/trigger parity checks.
SELECT count(*) AS account_research_table_count
FROM information_schema.tables
WHERE table_schema=current_schema()
  AND (table_name LIKE 'account_research_%' OR table_name LIKE 'research_account%');
