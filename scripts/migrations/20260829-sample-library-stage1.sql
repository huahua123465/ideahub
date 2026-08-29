-- IdeaHub sample library, stage 1.
-- Safe to run repeatedly. This migration never drops/truncates data and never resets the database.
-- Run against the existing production database only after taking a logical backup.

BEGIN;

CREATE TABLE IF NOT EXISTS samples (
  id                    BIGSERIAL PRIMARY KEY,
  canonical_key         TEXT NOT NULL,
  platform              TEXT NOT NULL DEFAULT 'manual',
  platform_content_id   TEXT,
  source_url            TEXT,
  title                 TEXT,
  body_text             TEXT,
  content_type          TEXT,
  account_name          TEXT,
  account_handle        TEXT,
  published_at          TIMESTAMPTZ,
  metrics               JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_ingest_method   TEXT NOT NULL DEFAULT 'manual',
  last_ingest_method    TEXT NOT NULL DEFAULT 'manual',
  completeness_score    SMALLINT NOT NULL DEFAULT 0,
  missing_fields        TEXT[] NOT NULL DEFAULT '{}',
  archive_status        TEXT NOT NULL DEFAULT 'partial',
  created_by            BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  CONSTRAINT samples_completeness_score_chk CHECK (completeness_score BETWEEN 0 AND 100),
  CONSTRAINT samples_archive_status_chk CHECK (archive_status IN ('partial','usable','complete')),
  CONSTRAINT samples_ingest_method_chk CHECK (
    first_ingest_method IN ('manual','link','upload','collector','legacy') AND
    last_ingest_method IN ('manual','link','upload','collector','legacy')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS samples_canonical_key_uidx ON samples(canonical_key);
CREATE INDEX IF NOT EXISTS samples_alive_time_idx
  ON samples(COALESCE(published_at,created_at) DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS samples_platform_alive_idx
  ON samples(platform,COALESCE(published_at,created_at) DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS samples_archive_status_idx
  ON samples(archive_status,completeness_score DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sample_captures (
  id                    BIGSERIAL PRIMARY KEY,
  sample_id             BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  capture_key           TEXT,
  capture_type          TEXT NOT NULL,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_url            TEXT,
  raw_payload           JSON NOT NULL DEFAULT '{}'::json,
  normalized_payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_sha256        TEXT NOT NULL,
  completeness_score    SMALLINT NOT NULL DEFAULT 0,
  missing_fields        TEXT[] NOT NULL DEFAULT '{}',
  created_by            BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_captures_type_chk CHECK (capture_type IN ('manual','link','upload','collector','legacy')),
  CONSTRAINT sample_captures_score_chk CHECK (completeness_score BETWEEN 0 AND 100),
  CONSTRAINT sample_captures_sha256_chk CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_captures_key_uidx
  ON sample_captures(sample_id,capture_key) WHERE capture_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_captures_sample_time_idx
  ON sample_captures(sample_id,captured_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS sample_assets (
  id                BIGSERIAL PRIMARY KEY,
  sample_id         BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  capture_id        BIGINT REFERENCES sample_captures(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL,
  storage_key       TEXT NOT NULL,
  original_name     TEXT,
  mime_type         TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size         BIGINT NOT NULL,
  sha256            TEXT NOT NULL,
  width             INT,
  height            INT,
  duration_ms       BIGINT,
  source_url        TEXT,
  archive_quality   TEXT NOT NULL DEFAULT 'unknown',
  uploaded_by       BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  CONSTRAINT sample_assets_kind_chk CHECK (kind IN ('cover','image','video','audio','other')),
  CONSTRAINT sample_assets_quality_chk CHECK (archive_quality IN (
    'original','original_images','platform_available','platform_archive','bounded_720p',
    'preview','user_upload','unavailable','unknown'
  )),
  CONSTRAINT sample_assets_size_chk CHECK (byte_size >= 0),
  CONSTRAINT sample_assets_dimensions_chk CHECK (
    (width IS NULL OR width >= 0) AND (height IS NULL OR height >= 0) AND
    (duration_ms IS NULL OR duration_ms >= 0)
  ),
  CONSTRAINT sample_assets_sha256_chk CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_assets_storage_key_chk CHECK (storage_key ~ '^[0-9a-f]{48}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_assets_storage_key_uidx ON sample_assets(storage_key);
CREATE INDEX IF NOT EXISTS sample_assets_sample_kind_idx
  ON sample_assets(sample_id,kind,created_at,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS sample_assets_capture_idx
  ON sample_assets(capture_id) WHERE capture_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS sample_assets_sha256_idx ON sample_assets(sha256);

DO $$ BEGIN
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='samples_created_by_fk'
  ) THEN
    ALTER TABLE samples ADD CONSTRAINT samples_created_by_fk
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='sample_captures_created_by_fk'
  ) THEN
    ALTER TABLE sample_captures ADD CONSTRAINT sample_captures_created_by_fk
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='sample_assets_uploaded_by_fk'
  ) THEN
    ALTER TABLE sample_assets ADD CONSTRAINT sample_assets_uploaded_by_fk
      FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.works') IS NOT NULL THEN
    ALTER TABLE works ADD COLUMN IF NOT EXISTS sample_id BIGINT;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='works_sample_id_fk') THEN
      ALTER TABLE works ADD CONSTRAINT works_sample_id_fk
        FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE SET NULL;
    END IF;
    EXECUTE 'CREATE INDEX IF NOT EXISTS works_sample_id_idx ON works(sample_id) WHERE sample_id IS NOT NULL';
  END IF;
END $$;

COMMIT;

-- Verification queries (read-only):
-- SELECT to_regclass('public.samples'), to_regclass('public.sample_captures'), to_regclass('public.sample_assets');
-- SELECT conname FROM pg_constraint WHERE conname IN
--   ('samples_created_by_fk','sample_captures_created_by_fk','sample_assets_uploaded_by_fk','works_sample_id_fk')
-- ORDER BY conname;
-- SELECT indexname FROM pg_indexes WHERE tablename IN ('samples','sample_captures','sample_assets','works') ORDER BY indexname;
