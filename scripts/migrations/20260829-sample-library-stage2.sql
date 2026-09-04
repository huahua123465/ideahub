-- IdeaHub sample library, stage 2.
-- Safe to run repeatedly. This migration only adds dictionaries, append-only research data and references.
-- Run after 20260829-sample-library-stage1.sql and after taking a logical backup.

BEGIN;

-- ============================================================
--  内容样本研究库（阶段二：结构化拆解、标签、评价与趋势）
--
--  分析版本与原始 capture 一样只追加、不覆盖。一个 complete 版本固定包含
--  下面字典中的 15 个维度；AI 原值、证据和人工决定分别保存。
-- ============================================================

-- ---------- 固定的 15 维研究字典 ----------
CREATE TABLE IF NOT EXISTS sample_analysis_dimensions (
  dimension_key TEXT PRIMARY KEY,
  ordinal       SMALLINT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  description   TEXT NOT NULL,
  CONSTRAINT sample_analysis_dimensions_key_chk CHECK (dimension_key IN (
    'audience','user_need','topic','core_viewpoint','breakout_point',
    'title_mechanism','opening_method','content_structure','argumentation_method',
    'language_style','length','layout','visual_style','bgm','cta'
  )),
  CONSTRAINT sample_analysis_dimensions_ordinal_chk CHECK (ordinal BETWEEN 1 AND 15),
  CONSTRAINT sample_analysis_dimensions_label_chk CHECK (char_length(label) BETWEEN 1 AND 40)
);

INSERT INTO sample_analysis_dimensions(dimension_key,ordinal,label,description) VALUES
  ('audience',1,'用户对象','作品主要面向的用户群体与所处情境'),
  ('user_need',2,'用户需求','用户希望被解决的显性或隐性需求'),
  ('topic',3,'选题','作品讨论的核心议题与内容边界'),
  ('core_viewpoint',4,'核心观点','作者希望受众接受的核心判断'),
  ('breakout_point',5,'爆点','最容易引发停留、传播或讨论的机制'),
  ('title_mechanism',6,'标题机制','标题吸引点击所使用的结构与承诺'),
  ('opening_method',7,'开头方式','内容建立注意力和进入主题的方式'),
  ('content_structure',8,'内容结构','信息与段落的组织顺序'),
  ('argumentation_method',9,'论证方式','支撑观点所使用的证据和推理方式'),
  ('language_style',10,'语言风格','措辞、语气、节奏与表达姿态'),
  ('length',11,'篇幅','内容长度及信息密度特征'),
  ('layout',12,'排版','文字、段落、字幕和版面组织'),
  ('visual_style',13,'视觉风格','画面、人物、色彩、构图和视觉模板'),
  ('bgm',14,'BGM','背景音乐的存在、类型与功能'),
  ('cta',15,'CTA','引导评论、关注、私信或转化的动作')
ON CONFLICT (dimension_key) DO NOTHING;

-- 复合外键用于保证 capture / asset / version 确实属于同一篇 sample。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_captures_sample_id_id_uk' AND conrelid='sample_captures'::regclass) THEN
    ALTER TABLE sample_captures ADD CONSTRAINT sample_captures_sample_id_id_uk UNIQUE(sample_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_assets_sample_id_id_uk' AND conrelid='sample_assets'::regclass) THEN
    ALTER TABLE sample_assets ADD CONSTRAINT sample_assets_sample_id_id_uk UNIQUE(sample_id,id);
  END IF;
END $$;

-- ---------- AI / 人工分析任务 ----------
CREATE TABLE IF NOT EXISTS sample_analysis_jobs (
  id                  BIGSERIAL PRIMARY KEY,
  sample_id           BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  source_capture_id   BIGINT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  input_sha256        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',
  attempts            SMALLINT NOT NULL DEFAULT 0,
  max_attempts        SMALLINT NOT NULL DEFAULT 3,
  select_on_success   BOOLEAN NOT NULL DEFAULT true,
  provider            TEXT,
  model_name          TEXT,
  requested_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  error_code          TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_analysis_jobs_capture_fk FOREIGN KEY(sample_id,source_capture_id)
    REFERENCES sample_captures(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_analysis_jobs_status_chk CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT sample_analysis_jobs_attempts_chk CHECK (
    attempts BETWEEN 0 AND 20 AND max_attempts BETWEEN 1 AND 20 AND attempts <= max_attempts
  ),
  CONSTRAINT sample_analysis_jobs_idempotency_chk CHECK (char_length(idempotency_key) BETWEEN 1 AND 160),
  CONSTRAINT sample_analysis_jobs_input_sha256_chk CHECK (input_sha256 ~ '^[0-9a-f]{64}$')
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_analysis_jobs_sample_capture_id_uk' AND conrelid='sample_analysis_jobs'::regclass) THEN
    ALTER TABLE sample_analysis_jobs ADD CONSTRAINT sample_analysis_jobs_sample_capture_id_uk
      UNIQUE(sample_id,source_capture_id,id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS sample_analysis_jobs_idempotency_uidx
  ON sample_analysis_jobs(sample_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS sample_analysis_jobs_one_active_uidx
  ON sample_analysis_jobs(sample_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS sample_analysis_jobs_status_time_idx
  ON sample_analysis_jobs(status,created_at,id);
CREATE INDEX IF NOT EXISTS sample_analysis_jobs_capture_idx
  ON sample_analysis_jobs(source_capture_id);

-- ---------- 不可变分析版本 ----------
CREATE TABLE IF NOT EXISTS sample_analysis_versions (
  id                  BIGSERIAL PRIMARY KEY,
  sample_id           BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  job_id              BIGINT REFERENCES sample_analysis_jobs(id) ON DELETE RESTRICT,
  source_capture_id   BIGINT NOT NULL,
  revision            INT NOT NULL,
  source              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'building',
  input_sha256        TEXT NOT NULL,
  schema_version      TEXT NOT NULL,
  prompt_version      TEXT,
  model_provider      TEXT,
  model_name          TEXT,
  model_version       TEXT,
  manifest_sha256     TEXT NOT NULL,
  created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  CONSTRAINT sample_analysis_versions_capture_fk FOREIGN KEY(sample_id,source_capture_id)
    REFERENCES sample_captures(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_analysis_versions_job_fk FOREIGN KEY(sample_id,source_capture_id,job_id)
    REFERENCES sample_analysis_jobs(sample_id,source_capture_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_analysis_versions_source_chk CHECK (source IN ('ai','manual','legacy')),
  CONSTRAINT sample_analysis_versions_source_job_chk CHECK (
    (source='ai' AND job_id IS NOT NULL) OR (source IN ('manual','legacy') AND job_id IS NULL)
  ),
  CONSTRAINT sample_analysis_versions_status_chk CHECK (status IN ('building','complete')),
  CONSTRAINT sample_analysis_versions_revision_chk CHECK (revision > 0),
  CONSTRAINT sample_analysis_versions_input_sha256_chk CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_analysis_versions_manifest_sha256_chk CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_analysis_versions_ai_metadata_chk CHECK (
    source <> 'ai' OR (prompt_version IS NOT NULL AND model_provider IS NOT NULL AND model_name IS NOT NULL AND model_version IS NOT NULL)
  ),
  CONSTRAINT sample_analysis_versions_completion_chk CHECK (
    (status='building' AND completed_at IS NULL) OR (status='complete' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT sample_analysis_versions_sample_revision_uk UNIQUE(sample_id,revision),
  CONSTRAINT sample_analysis_versions_sample_id_id_uk UNIQUE(sample_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_analysis_versions_job_uidx
  ON sample_analysis_versions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_analysis_versions_sample_time_idx
  ON sample_analysis_versions(sample_id,revision DESC,id DESC);
CREATE INDEX IF NOT EXISTS sample_analysis_versions_capture_idx
  ON sample_analysis_versions(source_capture_id);

-- ---------- 每版固定 15 行元素 ----------
CREATE TABLE IF NOT EXISTS sample_analysis_elements (
  id                  BIGSERIAL PRIMARY KEY,
  version_id          BIGINT NOT NULL REFERENCES sample_analysis_versions(id) ON DELETE RESTRICT,
  dimension_key       TEXT NOT NULL REFERENCES sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT,
  state               TEXT NOT NULL DEFAULT 'insufficient',
  value_json          JSONB,
  function_text       TEXT,
  confidence          NUMERIC(4,3),
  evidence_strength   TEXT NOT NULL DEFAULT 'none',
  applicability       TEXT,
  limitations         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_analysis_elements_state_chk CHECK (state IN ('value','insufficient','not_applicable')),
  CONSTRAINT sample_analysis_elements_value_chk CHECK (
    (state='value' AND value_json IS NOT NULL AND value_json <> 'null'::jsonb) OR
    (state IN ('insufficient','not_applicable') AND value_json IS NULL)
  ),
  CONSTRAINT sample_analysis_elements_confidence_chk CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT sample_analysis_elements_evidence_strength_chk CHECK (
    evidence_strength IN ('none','weak','medium','strong')
  ),
  CONSTRAINT sample_analysis_elements_version_dimension_uk UNIQUE(version_id,dimension_key),
  CONSTRAINT sample_analysis_elements_version_id_id_dimension_uk UNIQUE(version_id,id,dimension_key),
  CONSTRAINT sample_analysis_elements_version_id_id_uk UNIQUE(version_id,id)
);
CREATE INDEX IF NOT EXISTS sample_analysis_elements_dimension_idx
  ON sample_analysis_elements(dimension_key,version_id);
CREATE INDEX IF NOT EXISTS sample_analysis_elements_value_gin_idx
  ON sample_analysis_elements USING GIN(value_json jsonb_path_ops);

-- ---------- Evidence Manifest ----------
CREATE TABLE IF NOT EXISTS sample_evidence_sources (
  id                  BIGSERIAL PRIMARY KEY,
  version_id          BIGINT NOT NULL REFERENCES sample_analysis_versions(id) ON DELETE RESTRICT,
  sample_id           BIGINT NOT NULL,
  source_capture_id   BIGINT NOT NULL,
  asset_id            BIGINT,
  source_id           TEXT NOT NULL,
  source_kind         TEXT NOT NULL,
  locator             JSONB NOT NULL,
  content_sha256      TEXT NOT NULL,
  content_length      BIGINT,
  display_label       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_evidence_sources_version_fk FOREIGN KEY(sample_id,version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_evidence_sources_capture_fk FOREIGN KEY(sample_id,source_capture_id)
    REFERENCES sample_captures(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_evidence_sources_asset_fk FOREIGN KEY(sample_id,asset_id)
    REFERENCES sample_assets(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_evidence_sources_kind_chk CHECK (
    source_kind IN ('body','ocr','transcript','comment','metadata','asset')
  ),
  CONSTRAINT sample_evidence_sources_source_id_chk CHECK (char_length(source_id) BETWEEN 1 AND 120),
  CONSTRAINT sample_evidence_sources_sha256_chk CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_evidence_sources_length_chk CHECK (content_length IS NULL OR content_length >= 0),
  CONSTRAINT sample_evidence_sources_locator_chk CHECK (jsonb_typeof(locator)='object'),
  CONSTRAINT sample_evidence_sources_version_source_uk UNIQUE(version_id,source_id)
);
CREATE INDEX IF NOT EXISTS sample_evidence_sources_capture_idx
  ON sample_evidence_sources(source_capture_id,version_id);
CREATE INDEX IF NOT EXISTS sample_evidence_sources_asset_idx
  ON sample_evidence_sources(asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_evidence_sources_locator_gin_idx
  ON sample_evidence_sources USING GIN(locator jsonb_path_ops);

CREATE TABLE IF NOT EXISTS sample_element_evidence (
  id                    BIGSERIAL PRIMARY KEY,
  version_id            BIGINT NOT NULL,
  element_id            BIGINT NOT NULL,
  source_id             TEXT NOT NULL,
  verification_status   TEXT NOT NULL DEFAULT 'unresolved',
  quote_text            TEXT,
  quote_sha256          TEXT,
  start_offset          INT,
  end_offset            INT,
  time_start_ms         BIGINT,
  time_end_ms           BIGINT,
  json_path             TEXT,
  comment_ref           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_element_evidence_element_fk FOREIGN KEY(version_id,element_id)
    REFERENCES sample_analysis_elements(version_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_evidence_source_fk FOREIGN KEY(version_id,source_id)
    REFERENCES sample_evidence_sources(version_id,source_id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_evidence_status_chk CHECK (
    verification_status IN ('verified','unresolved','invalid')
  ),
  CONSTRAINT sample_element_evidence_quote_chk CHECK (
    verification_status <> 'verified' OR
    (quote_text IS NOT NULL AND char_length(quote_text) > 0 AND quote_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT sample_element_evidence_quote_sha256_chk CHECK (
    quote_sha256 IS NULL OR quote_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT sample_element_evidence_offsets_chk CHECK (
    (start_offset IS NULL AND end_offset IS NULL) OR
    (start_offset IS NOT NULL AND end_offset IS NOT NULL AND start_offset >= 0 AND end_offset >= start_offset)
  ),
  CONSTRAINT sample_element_evidence_times_chk CHECK (
    (time_start_ms IS NULL AND time_end_ms IS NULL) OR
    (time_start_ms IS NOT NULL AND time_end_ms IS NOT NULL AND time_start_ms >= 0 AND time_end_ms >= time_start_ms)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_element_evidence_identity_uidx
  ON sample_element_evidence(
    element_id,source_id,
    COALESCE(start_offset,-1),COALESCE(end_offset,-1),
    COALESCE(time_start_ms,-1),COALESCE(time_end_ms,-1),
    COALESCE(json_path,''),COALESCE(comment_ref,'')
  );
CREATE INDEX IF NOT EXISTS sample_element_evidence_element_idx
  ON sample_element_evidence(element_id,verification_status,id);

-- ---------- 人工确认 / 修订 / 驳回（只追加） ----------
CREATE TABLE IF NOT EXISTS sample_element_decisions (
  id                  BIGSERIAL PRIMARY KEY,
  element_id          BIGINT NOT NULL REFERENCES sample_analysis_elements(id) ON DELETE RESTRICT,
  decision            TEXT NOT NULL,
  value_json          JSONB,
  function_text       TEXT,
  applicability       TEXT,
  limitations         TEXT,
  note                TEXT,
  idempotency_key     TEXT,
  decided_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_element_decisions_decision_chk CHECK (decision IN ('confirmed','edited','rejected')),
  CONSTRAINT sample_element_decisions_value_chk CHECK (
    (decision='edited' AND value_json IS NOT NULL AND value_json <> 'null'::jsonb) OR
    (decision IN ('confirmed','rejected') AND value_json IS NULL)
  ),
  CONSTRAINT sample_element_decisions_idempotency_chk CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 160
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_element_decisions_idempotency_uidx
  ON sample_element_decisions(element_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_element_decisions_latest_idx
  ON sample_element_decisions(element_id,created_at DESC,id DESC);

-- ---------- 版本化的元素标签 ----------
CREATE TABLE IF NOT EXISTS sample_element_tags (
  id                  BIGSERIAL PRIMARY KEY,
  version_id          BIGINT NOT NULL,
  element_id          BIGINT NOT NULL,
  dimension_key       TEXT NOT NULL,
  tag_id              BIGINT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  origin              TEXT NOT NULL,
  confidence          NUMERIC(4,3),
  idempotency_key     TEXT,
  created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_element_tags_element_fk FOREIGN KEY(version_id,element_id,dimension_key)
    REFERENCES sample_analysis_elements(version_id,id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_element_tags_origin_chk CHECK (origin IN ('ai','manual','legacy')),
  CONSTRAINT sample_element_tags_confidence_chk CHECK (
    confidence IS NULL OR confidence BETWEEN 0 AND 1
  ),
  CONSTRAINT sample_element_tags_manual_confidence_chk CHECK (
    origin <> 'manual' OR confidence IS NULL
  ),
  CONSTRAINT sample_element_tags_ai_confidence_chk CHECK (
    origin <> 'ai' OR confidence IS NOT NULL
  ),
  CONSTRAINT sample_element_tags_idempotency_chk CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 160
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_element_tags_identity_uidx
  ON sample_element_tags(element_id,tag_id,origin);
CREATE UNIQUE INDEX IF NOT EXISTS sample_element_tags_idempotency_uidx
  ON sample_element_tags(version_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_element_tags_tag_idx
  ON sample_element_tags(tag_id,dimension_key,version_id);
CREATE INDEX IF NOT EXISTS sample_element_tags_element_idx
  ON sample_element_tags(element_id,id);

-- ---------- current 版本选择审计 ----------
ALTER TABLE samples ADD COLUMN IF NOT EXISTS current_analysis_version_id BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='samples_current_analysis_version_fk' AND conrelid='samples'::regclass) THEN
    ALTER TABLE samples ADD CONSTRAINT samples_current_analysis_version_fk
      FOREIGN KEY(id,current_analysis_version_id)
      REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS samples_current_analysis_version_idx
  ON samples(current_analysis_version_id) WHERE current_analysis_version_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sample_analysis_selections (
  id                  BIGSERIAL PRIMARY KEY,
  sample_id           BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  version_id          BIGINT NOT NULL,
  reason              TEXT NOT NULL,
  selected_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_analysis_selections_version_fk FOREIGN KEY(sample_id,version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_analysis_selections_reason_chk CHECK (reason IN ('run_success','explicit','migration'))
);
CREATE INDEX IF NOT EXISTS sample_analysis_selections_sample_time_idx
  ON sample_analysis_selections(sample_id,created_at DESC,id DESC);

-- ---------- 按四类目标独立追加的评价 ----------
CREATE TABLE IF NOT EXISTS sample_evaluations (
  id                  BIGSERIAL PRIMARY KEY,
  sample_id           BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  analysis_version_id BIGINT,
  target              TEXT NOT NULL,
  source              TEXT NOT NULL,
  revision            INT NOT NULL,
  summary             TEXT,
  strengths           JSONB NOT NULL DEFAULT '[]'::jsonb,
  weaknesses          JSONB NOT NULL DEFAULT '[]'::jsonb,
  worth_learning      JSONB NOT NULL DEFAULT '[]'::jsonb,
  avoid_copying       JSONB NOT NULL DEFAULT '[]'::jsonb,
  effect_hypotheses   JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_source_ids TEXT[] NOT NULL DEFAULT '{}',
  confidence          NUMERIC(4,3),
  input_sha256        TEXT,
  prompt_version      TEXT,
  model_provider      TEXT,
  model_name          TEXT,
  created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_evaluations_version_fk FOREIGN KEY(sample_id,analysis_version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_evaluations_target_chk CHECK (target IN ('traffic','persona','expertise','conversion')),
  CONSTRAINT sample_evaluations_source_chk CHECK (source IN ('ai','manual')),
  CONSTRAINT sample_evaluations_revision_chk CHECK (revision > 0),
  CONSTRAINT sample_evaluations_arrays_chk CHECK (
    jsonb_typeof(strengths)='array' AND jsonb_typeof(weaknesses)='array' AND
    jsonb_typeof(worth_learning)='array' AND jsonb_typeof(avoid_copying)='array' AND
    jsonb_typeof(effect_hypotheses)='array'
  ),
  CONSTRAINT sample_evaluations_confidence_chk CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT sample_evaluations_input_sha256_chk CHECK (
    input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT sample_evaluations_source_metadata_chk CHECK (
    (source='manual' AND confidence IS NULL AND input_sha256 IS NULL AND prompt_version IS NULL
      AND model_provider IS NULL AND model_name IS NULL) OR
    (source='ai' AND confidence IS NOT NULL AND input_sha256 IS NOT NULL AND prompt_version IS NOT NULL
      AND model_provider IS NOT NULL AND model_name IS NOT NULL)
  ),
  CONSTRAINT sample_evaluations_sample_target_revision_uk UNIQUE(sample_id,target,revision)
);
CREATE INDEX IF NOT EXISTS sample_evaluations_sample_target_idx
  ON sample_evaluations(sample_id,target,revision DESC,id DESC);
CREATE INDEX IF NOT EXISTS sample_evaluations_analysis_version_idx
  ON sample_evaluations(analysis_version_id) WHERE analysis_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_evaluations_hypotheses_gin_idx
  ON sample_evaluations USING GIN(effect_hypotheses jsonb_path_ops);

-- ---------- 每次 capture / 手工补录产生一个可空指标快照 ----------
CREATE TABLE IF NOT EXISTS sample_metric_snapshots (
  id                  BIGSERIAL PRIMARY KEY,
  sample_id           BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  capture_id          BIGINT,
  snapshot_key        TEXT,
  observed_at         TIMESTAMPTZ NOT NULL,
  likes               BIGINT,
  saves               BIGINT,
  comments            BIGINT,
  shares              BIGINT,
  views               BIGINT,
  raw_metrics         JSONB NOT NULL DEFAULT '{}'::jsonb,
  parse_warnings      TEXT[] NOT NULL DEFAULT '{}',
  created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_metric_snapshots_capture_fk FOREIGN KEY(sample_id,capture_id)
    REFERENCES sample_captures(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_metric_snapshots_values_chk CHECK (
    (likes IS NULL OR likes >= 0) AND (saves IS NULL OR saves >= 0) AND
    (comments IS NULL OR comments >= 0) AND (shares IS NULL OR shares >= 0) AND
    (views IS NULL OR views >= 0)
  ),
  CONSTRAINT sample_metric_snapshots_identity_chk CHECK (capture_id IS NOT NULL OR snapshot_key IS NOT NULL),
  CONSTRAINT sample_metric_snapshots_key_chk CHECK (
    snapshot_key IS NULL OR char_length(snapshot_key) BETWEEN 1 AND 160
  ),
  CONSTRAINT sample_metric_snapshots_raw_chk CHECK (jsonb_typeof(raw_metrics)='object')
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_metric_snapshots_capture_uidx
  ON sample_metric_snapshots(capture_id) WHERE capture_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sample_metric_snapshots_key_uidx
  ON sample_metric_snapshots(sample_id,snapshot_key) WHERE snapshot_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_metric_snapshots_sample_time_idx
  ON sample_metric_snapshots(sample_id,observed_at,id);
CREATE INDEX IF NOT EXISTS sample_metric_snapshots_raw_gin_idx
  ON sample_metric_snapshots USING GIN(raw_metrics jsonb_path_ops);

-- ---------- 数据库级不可变性和完整性门槛 ----------
CREATE OR REPLACE FUNCTION sample_analysis_guard_version_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='complete' THEN
    RAISE EXCEPTION 'complete sample analysis versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS sample_analysis_versions_immutable_trg ON sample_analysis_versions;
CREATE TRIGGER sample_analysis_versions_immutable_trg
  BEFORE UPDATE OR DELETE ON sample_analysis_versions
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_version_immutable();

CREATE OR REPLACE FUNCTION sample_analysis_guard_version_child()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_analysis_elements_guard_trg ON sample_analysis_elements;
CREATE TRIGGER sample_analysis_elements_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON sample_analysis_elements
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_version_child();
DROP TRIGGER IF EXISTS sample_evidence_sources_guard_trg ON sample_evidence_sources;
CREATE TRIGGER sample_evidence_sources_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON sample_evidence_sources
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_version_child();
DROP TRIGGER IF EXISTS sample_element_evidence_guard_trg ON sample_element_evidence;
CREATE TRIGGER sample_element_evidence_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON sample_element_evidence
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_version_child();

CREATE OR REPLACE FUNCTION sample_analysis_validate_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_analysis_versions_completion_trg ON sample_analysis_versions;
CREATE TRIGGER sample_analysis_versions_completion_trg
  BEFORE INSERT OR UPDATE ON sample_analysis_versions
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_validate_completion();

CREATE OR REPLACE FUNCTION sample_analysis_guard_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only',TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS sample_analysis_dimensions_immutable_trg ON sample_analysis_dimensions;
CREATE TRIGGER sample_analysis_dimensions_immutable_trg
  BEFORE UPDATE OR DELETE ON sample_analysis_dimensions
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();
DROP TRIGGER IF EXISTS sample_element_decisions_append_only_trg ON sample_element_decisions;
CREATE TRIGGER sample_element_decisions_append_only_trg
  BEFORE UPDATE OR DELETE ON sample_element_decisions
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();
DROP TRIGGER IF EXISTS sample_element_tags_append_only_trg ON sample_element_tags;
CREATE TRIGGER sample_element_tags_append_only_trg
  BEFORE UPDATE OR DELETE ON sample_element_tags
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();
DROP TRIGGER IF EXISTS sample_analysis_selections_append_only_trg ON sample_analysis_selections;
CREATE TRIGGER sample_analysis_selections_append_only_trg
  BEFORE UPDATE OR DELETE ON sample_analysis_selections
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();
DROP TRIGGER IF EXISTS sample_evaluations_append_only_trg ON sample_evaluations;
CREATE TRIGGER sample_evaluations_append_only_trg
  BEFORE UPDATE OR DELETE ON sample_evaluations
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();
DROP TRIGGER IF EXISTS sample_metric_snapshots_append_only_trg ON sample_metric_snapshots;
CREATE TRIGGER sample_metric_snapshots_append_only_trg
  BEFORE UPDATE OR DELETE ON sample_metric_snapshots
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();

CREATE OR REPLACE FUNCTION sample_element_tags_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_element_tags_validate_trg ON sample_element_tags;
CREATE TRIGGER sample_element_tags_validate_trg
  BEFORE INSERT ON sample_element_tags
  FOR EACH ROW EXECUTE FUNCTION sample_element_tags_validate();

CREATE OR REPLACE FUNCTION sample_element_decisions_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_element_decisions_validate_trg ON sample_element_decisions;
CREATE TRIGGER sample_element_decisions_validate_trg
  BEFORE INSERT ON sample_element_decisions
  FOR EACH ROW EXECUTE FUNCTION sample_element_decisions_validate();

CREATE OR REPLACE FUNCTION sample_analysis_apply_selection()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS sample_analysis_apply_selection_trg ON sample_analysis_selections;
CREATE TRIGGER sample_analysis_apply_selection_trg
  AFTER INSERT ON sample_analysis_selections
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_apply_selection();

CREATE OR REPLACE FUNCTION samples_validate_current_analysis_version()
RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS samples_validate_current_analysis_version_trg ON samples;
CREATE TRIGGER samples_validate_current_analysis_version_trg
  BEFORE INSERT OR UPDATE OF current_analysis_version_id ON samples
  FOR EACH ROW EXECUTE FUNCTION samples_validate_current_analysis_version();

-- 标签名扩到 80 字，并为 15 个元素开放与维度同名的标签类型。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tags_kind_length_chk') THEN
    ALTER TABLE tags ADD CONSTRAINT tags_kind_length_chk CHECK (char_length(kind) BETWEEN 1 AND 64) NOT VALID;
    ALTER TABLE tags VALIDATE CONSTRAINT tags_kind_length_chk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tags_name_length_chk') THEN
    ALTER TABLE tags ADD CONSTRAINT tags_name_length_chk CHECK (char_length(name) BETWEEN 1 AND 80) NOT VALID;
    ALTER TABLE tags VALIDATE CONSTRAINT tags_name_length_chk;
  END IF;
END $$;

INSERT INTO tags(kind,name,sort) VALUES
  ('audience','女性用户',10),('audience','关系困惑用户',20),
  ('user_need','关系判断需求',10),('user_need','情绪共鸣需求',20),('user_need','行动方案需求',30),
  ('topic','女性情感赛道',10),('topic','亲密关系',20),('topic','个人成长',30),
  ('core_viewpoint','强结论',10),('core_viewpoint','反常识',20),('core_viewpoint','方法论',30),
  ('breakout_point','痛点命中',10),('breakout_point','身份认同',20),('breakout_point','结果承诺',30),
  ('title_mechanism','强结论标题',10),('title_mechanism','反差标题',20),('title_mechanism','数字清单标题',30),
  ('opening_method','直接结论',10),('opening_method','问题切入',20),('opening_method','案例切入',30),
  ('content_structure','案例拆解结构',10),('content_structure','总分总结构',20),('content_structure','步骤清单结构',30),
  ('argumentation_method','案例论证',10),('argumentation_method','对比论证',20),('argumentation_method','因果论证',30),
  ('language_style','口语化',10),('language_style','专业解释',20),('language_style','情绪共鸣',30),
  ('length','短内容',10),('length','中等篇幅',20),('length','长内容',30),
  ('layout','短句分段',10),('layout','清单排版',20),('layout','小标题排版',30),
  ('visual_style','真人口播',10),('visual_style','图文卡片',20),('visual_style','知识板书',30),
  ('bgm','无BGM',10),('bgm','情绪氛围',20),('bgm','节奏型',30),
  ('cta','互动提问',10),('cta','关注引导',20),('cta','私信转化',30)
ON CONFLICT (kind,name) DO NOTHING;


COMMIT;

-- Read-only verification:
-- SELECT count(*) FROM sample_analysis_dimensions; -- must be 15
-- SELECT conname FROM pg_constraint WHERE conname IN
--   ('samples_current_analysis_version_fk','sample_analysis_versions_sample_id_id_uk',
--    'sample_captures_sample_id_id_uk','sample_assets_sample_id_id_uk') ORDER BY conname;
-- SELECT indexname FROM pg_indexes WHERE tablename LIKE 'sample_%' ORDER BY tablename,indexname;
