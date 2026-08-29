/**
 * One-way, idempotent bridge from the legacy benchmark archive to stage-one samples.
 *
 * Run inside the API container after the SQL migration so both /data/uploads and
 * SAMPLE_ASSET_DIR are mounted. It never deletes or rewrites legacy records.
 */
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { close, query, tx } from '../server/src/db/index.mjs';
import {
  defaultSampleAssetDir,
  sampleCompleteness,
  saveAssetWithRecord,
  upsertSampleWithCapture,
} from '../server/src/lib/sample-archive.mjs';
import { collectorPayloadToSampleInput } from '../server/src/routes/samples.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const LEGACY_COVER_DIR = join(UPLOAD_DIR, 'bench-covers');
const ASSET_ROOT = defaultSampleAssetDir();
const MAX_BYTES = Number(process.env.SAMPLE_ASSET_MAX_BYTES) || 500 * 1024 * 1024;

function mimeFor(name) {
  return ({
    '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp',
    '.gif':'image/gif', '.avif':'image/avif',
  })[extname(name).toLowerCase()] || 'application/octet-stream';
}

export function legacyInput(row) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const mapped = collectorPayloadToSampleInput(payload);
  return {
    ...mapped,
    ingestMethod: 'legacy',
    platform: row.platform || mapped.platform,
    sourceUrl: row.url || row.source_url || mapped.sourceUrl,
    manualKey: `legacy-work:${row.work_id}`,
    title: row.title || mapped.title,
    publishedAt: row.published_at || mapped.publishedAt,
    accountName: mapped.accountName || row.account_name,
    accountHandle: mapped.accountHandle || row.account_handle,
    metrics: { ...(mapped.metrics || {}), ...(row.metrics || {}) },
    capturedAt: row.received_at,
    captureKey: `legacy-work-analysis:${row.work_id}:${new Date(row.received_at).toISOString()}`,
    rawPayload: payload,
    hasCover: Boolean(row.cover_file || (row.digest?.imageFiles || []).length || mapped.hasCover),
    hasMedia: Boolean((row.digest?.imageFiles || []).length || mapped.hasMedia),
  };
}

async function copyLegacyAsset({ sampleId, captureId, kind, fileName }) {
  const safeName = basename(String(fileName || ''));
  if (!safeName || safeName !== String(fileName || '')) return { status:'invalid' };
  const { rows: existing } = await query(`
    SELECT id FROM sample_assets
     WHERE capture_id=$1 AND kind=$2 AND original_name=$3 AND deleted_at IS NULL
     LIMIT 1`, [captureId, kind, safeName]);
  if (existing[0]) return { status:'exists', id:Number(existing[0].id) };

  const sourcePath = join(LEGACY_COVER_DIR, safeName);
  let info;
  try { info = await lstat(sourcePath); }
  catch (error) { return { status:'missing', error:error.code }; }
  if (!info.isFile() || info.isSymbolicLink()) return { status:'invalid' };
  if (info.size > MAX_BYTES) return { status:'too_large' };

  const saved = await saveAssetWithRecord({
    readable:createReadStream(sourcePath), rootDir:ASSET_ROOT,
    maxBytes:MAX_BYTES, expectedBytes:info.size,
  }, async file => {
    const { rows } = await query(`
      INSERT INTO sample_assets(
        sample_id,capture_id,kind,storage_key,original_name,mime_type,byte_size,sha256,
        archive_quality,uploaded_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'platform_archive',NULL)
      RETURNING id`, [sampleId,captureId,kind,file.storageKey,safeName,mimeFor(safeName),file.byteSize,file.sha256]);
    return rows[0];
  });
  return { status:'copied', id:Number(saved.record.id) };
}

async function refresh(sampleId) {
  const { rows } = await query(`
    SELECT s.*,
           EXISTS(SELECT 1 FROM sample_assets a WHERE a.sample_id=s.id AND a.kind IN ('cover','image') AND a.deleted_at IS NULL) AS has_cover,
           EXISTS(SELECT 1 FROM sample_assets a WHERE a.sample_id=s.id AND a.kind IN ('image','video','audio') AND a.deleted_at IS NULL) AS has_media
      FROM samples s WHERE s.id=$1`, [sampleId]);
  if (!rows[0]) return;
  const completeness = sampleCompleteness(rows[0]);
  await query(`UPDATE samples SET completeness_score=$2,missing_fields=$3::text[],archive_status=$4,updated_at=now() WHERE id=$1`,
    [sampleId,completeness.score,completeness.missingFields,completeness.archiveStatus]);
}

async function main() {
  const { rows: workColumns } = await query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema=current_schema() AND table_name='works'
       AND column_name IN ('source_url','deleted_at')`);
  const workColumnNames = new Set(workColumns.map(row => row.column_name));
  const sourceUrlSelect = workColumnNames.has('source_url')
    ? 'w.source_url' : 'NULL::text AS source_url';
  const aliveClause = workColumnNames.has('deleted_at') ? 'WHERE w.deleted_at IS NULL' : '';
  const { rows } = await query(`
    SELECT w.id AS work_id,w.title,w.url,${sourceUrlSelect},w.published_at,w.metrics,w.sample_id,
           wa.task_id,wa.platform,wa.schema_ver,wa.payload,wa.digest,wa.cover_file,wa.received_at,
           ca.handle AS account_handle
      FROM works w
      JOIN work_analyses wa ON wa.work_id=w.id
      LEFT JOIN channel_accounts ca ON ca.id=w.account_id
     ${aliveClause}
     ORDER BY w.id`);
  if (DRY_RUN) {
    console.log(JSON.stringify({ dryRun:true, candidates:rows.length, alreadyLinked:rows.filter(row => row.sample_id).length }));
    return;
  }

  const report = { candidates:rows.length, linked:0, created:0, assetsCopied:0, assetsExisting:0, assetsMissing:0, errors:[] };
  for (const row of rows) {
    try {
      const result = await tx(async client => {
        const out = await upsertSampleWithCapture(client, legacyInput(row), null);
        await client.query('UPDATE works SET sample_id=$2 WHERE id=$1 AND sample_id IS DISTINCT FROM $2',
          [row.work_id, out.sample.id]);
        return out;
      });
      const sampleId = Number(result.sample.id);
      const captureId = Number(result.capture.id);
      report.linked += 1;
      if (result.inserted) report.created += 1;
      const files = [];
      if (row.cover_file) files.push({ kind:'cover', fileName:row.cover_file });
      for (const item of Array.isArray(row.digest?.imageFiles) ? row.digest.imageFiles : []) {
        if (item?.file) files.push({ kind:'image', fileName:item.file });
      }
      for (const file of files) {
        const copied = await copyLegacyAsset({ sampleId,captureId,...file });
        if (copied.status === 'copied') report.assetsCopied += 1;
        else if (copied.status === 'exists') report.assetsExisting += 1;
        else report.assetsMissing += 1;
      }
      await refresh(sampleId);
    } catch (error) {
      report.errors.push({ workId:Number(row.work_id), error:error.message });
    }
  }
  console.log(JSON.stringify(report));
  if (report.errors.length) process.exitCode = 1;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { await main(); }
  finally { await close(); }
}
