/**
 * Idempotent Stage-2 backfill.
 *
 * It turns the four legacy AI fields we can map without guessing into a legacy
 * analysis version, leaves the other eleven dimensions insufficient, and
 * creates one nullable metric snapshot per capture. Legacy rows are never
 * updated or deleted.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { close, query, tx } from '../server/src/db/index.mjs';
import {
  ANALYSIS_DIMENSIONS, RESEARCH_SCHEMA_VERSION, recordMetricSnapshot, sha256,
} from '../server/src/lib/sample-research.mjs';
import { persistAnalysisVersion } from '../server/src/routes/sample-research.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function summary(value) {
  if (typeof value === 'string') return value.trim() || null;
  const source = object(value);
  return String(source.summary ?? source.value ?? '').trim() || null;
}

export function legacyElements(payload) {
  const ai = object(payload?.ai_analysis);
  const videoItems = object(ai.video?.items);
  const directItems = object(ai.items);
  const values = {
    audience:summary(videoItems.target_audience ?? directItems.target_audience ?? ai.target_audience),
    user_need:summary(videoItems.user_need ?? directItems.user_need ?? ai.user_need),
    topic:summary(videoItems.main_topic ?? directItems.main_topic ?? ai.main_topic),
    content_structure:summary(videoItems.content_structure ?? directItems.content_structure ?? ai.content_structure),
  };
  return ANALYSIS_DIMENSIONS.map(dimension => ({
    dimensionKey:dimension.key,
    state:values[dimension.key] ? 'value' : 'insufficient',
    valueJson:values[dimension.key], functionText:null, confidence:null,
    evidenceStrength:'none', applicability:null,
    limitations:values[dimension.key] ? '由旧版 AI 字段映射；缺少可核验 Evidence Manifest，需人工复核。' : null,
    evidence:[],tagIds:[],
  }));
}

function payloadMetrics(payload, normalized = {}) {
  return object(payload?.engagement && Object.keys(payload.engagement).length
    ? payload.engagement : normalized?.metrics);
}

async function loadCandidates() {
  const { rows:workRows } = await query(`
    SELECT w.sample_id,wa.payload,wa.received_at,
           (SELECT id FROM sample_captures c WHERE c.sample_id=w.sample_id
             ORDER BY abs(extract(epoch FROM(c.captured_at-wa.received_at))),c.id LIMIT 1) source_capture_id
      FROM works w JOIN work_analyses wa ON wa.work_id=w.id
     WHERE w.sample_id IS NOT NULL AND json_typeof(wa.payload->'ai_analysis')='object'`);
  const { rows:captureRows } = await query(`
    SELECT sample_id,id source_capture_id,raw_payload payload,captured_at received_at
      FROM sample_captures
     WHERE json_typeof(raw_payload->'ai_analysis')='object'`);
  const unique = new Map();
  for (const row of [...workRows,...captureRows]) {
    const payload = object(row.payload);
    const payloadHash = sha256(payload);
    const key = `${row.sample_id}:${payloadHash}`;
    if (!unique.has(key) && row.source_capture_id) unique.set(key,{ ...row,payload,payloadHash });
  }
  return [...unique.values()];
}

async function migrateMetrics(report) {
  const { rows } = await query(`SELECT c.id,c.sample_id,c.captured_at,c.normalized_payload,c.raw_payload,c.created_by
    FROM sample_captures c ORDER BY c.id`);
  for (const row of rows) {
    const metrics = payloadMetrics(object(row.raw_payload), object(row.normalized_payload));
    const saved = await recordMetricSnapshot({ query }, { sampleId:Number(row.sample_id),captureId:Number(row.id),
      observedAt:row.captured_at,metrics,createdBy:row.created_by == null ? null : Number(row.created_by) });
    if (saved.created) report.metricSnapshotsCreated += 1;
    else report.metricSnapshotsExisting += 1;
  }
}

export async function runMigration() {
  const candidates = await loadCandidates();
  const report = { schemaVersion:RESEARCH_SCHEMA_VERSION,dryRun:DRY_RUN,candidates:candidates.length,
    versionsCreated:0,versionsExisting:0,metricSnapshotsCreated:0,metricSnapshotsExisting:0,errors:[] };
  if (DRY_RUN) return report;
  await migrateMetrics(report);
  for (const candidate of candidates) {
    const sampleId = Number(candidate.sample_id);
    try {
      const { rows:existing } = await query(`SELECT id FROM sample_analysis_versions
        WHERE sample_id=$1 AND source='legacy' AND input_sha256=$2 AND status='complete' LIMIT 1`,
      [sampleId,candidate.payloadHash]);
      if (existing[0]) { report.versionsExisting += 1; continue; }
      const { rows:samples } = await query('SELECT current_analysis_version_id FROM samples WHERE id=$1', [sampleId]);
      if (!samples[0]) continue;
      const manifest = { sources:[],manifestSha256:sha256([]),inputSha256:candidate.payloadHash };
      await tx(client => persistAnalysisVersion(client, {
        sampleId,sourceCaptureId:Number(candidate.source_capture_id),source:'legacy',
        elements:legacyElements(candidate.payload),manifest,inputSha256:candidate.payloadHash,
        createdBy:null,select:samples[0].current_analysis_version_id == null,selectionReason:'migration',
        promptVersion:'legacy-ai-analysis-map/2026-08-29',
      }));
      report.versionsCreated += 1;
    } catch (error) {
      report.errors.push({ sampleId,error:error.message });
    }
  }
  return report;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    const report = await runMigration();
    console.log(JSON.stringify(report));
    if (report.errors.length) process.exitCode=1;
  } finally { await close(); }
}
