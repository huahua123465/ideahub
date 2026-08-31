BEGIN;

ALTER TABLE sample_comparisons
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='sample_comparisons_deleted_by_fk'
      AND conrelid='sample_comparisons'::regclass
  ) THEN
    ALTER TABLE sample_comparisons
      ADD CONSTRAINT sample_comparisons_deleted_by_fk
      FOREIGN KEY(deleted_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sample_comparisons_active_created_idx
  ON sample_comparisons(created_at DESC,id DESC) WHERE deleted_at IS NULL;

COMMIT;
