import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { query, tx } from '../db/index.mjs';
import { currentUser } from '../lib/auth.mjs';
import { requireKey } from '../lib/apikey.mjs';
import {
  RangeNotSatisfiableError,
  canonicalSampleIdentity,
  defaultSampleAssetDir,
  normalizeAssetMime,
  parseByteRange,
  safeAssetStat,
  sampleCompleteness,
  sampleListItem,
  saveAssetWithRecord,
  upsertSampleWithCapture,
} from '../lib/sample-archive.mjs';
import { HttpError, badRequest, notFound, q, qInt, readJson, sendJson } from '../lib/http.mjs';
import { recordMetricSnapshot } from '../lib/sample-research.mjs';

const ASSET_ROOT = defaultSampleAssetDir();
const ASSET_KINDS = new Set(['cover', 'image', 'video', 'audio', 'other']);
const ARCHIVE_QUALITIES = new Set([
  'original', 'original_images', 'platform_available', 'platform_archive',
  'bounded_720p', 'preview', 'user_upload', 'unavailable', 'unknown',
]);
const SAFE_MIME_BY_KIND = {
  cover: new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']),
  image: new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']),
  video: new Set(['video/mp4','video/webm','video/quicktime','video/x-matroska']),
  audio: new Set(['audio/mpeg','audio/mp4','audio/wav','audio/aac','audio/ogg']),
  other: new Set(['application/octet-stream','application/pdf','text/plain']),
};
const COLLECTOR_TASK_RE = /^[A-Za-z0-9_-]{1,128}$/;
const COLLECTOR_FILE_RE = /^(?!\.)(?!.*\.\.)(?!.*[/\\])[\p{L}\p{N}_.()\- ]{1,255}$/u;

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function uniqueText(parts) {
  const seen = new Set();
  return parts.map(text).filter(value => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/** Convert one Collector result into the stable stage-one sample contract. */
export function collectorPayloadToSampleInput(payload = {}) {
  const account = payload.account && typeof payload.account === 'object' ? payload.account : {};
  const engagement = payload.engagement && typeof payload.engagement === 'object' ? payload.engagement : {};
  const video = payload.media_assets?.video && typeof payload.media_assets.video === 'object'
    ? payload.media_assets.video : {};
  const images = Array.isArray(payload.images) ? payload.images : [];
  const bodyParts = uniqueText([
    payload.post_description,
    payload.description,
    payload.page_text,
    ...images.map(image => image?.text),
    payload.video_text,
    payload.audio_text,
  ]);
  const taskId = text(payload.task_id);
  const capturedAt = text(payload.collected_at) || null;
  const hasVideo = Boolean(text(video.filename));
  const hasCover = Boolean(images.length || text(video.cover_filename) || text(video.cover_image_b64));
  return {
    ingestMethod: 'collector',
    platform: text(payload.platform) || null,
    platformContentId: text(payload.platform_content_id) || null,
    sourceUrl: text(payload.source_url || video.source_url) || null,
    manualKey: taskId ? `collector:${taskId}` : null,
    title: text(payload.post_title || payload.title || payload.display_title) || null,
    bodyText: bodyParts.join('\n\n') || null,
    contentType: text(payload.media_type) || null,
    accountName: text(account.name || payload.author) || null,
    accountHandle: text(account.handle || account.user_id || account.id) || null,
    publishedAt: text(payload.published_at) || null,
    metrics: engagement,
    capturedAt,
    captureKey: taskId ? `collector:${taskId}:${capturedAt || payload.schema_version || 'capture'}` : null,
    hasCover,
    hasMedia: Boolean(images.length || hasVideo),
    rawPayload: payload,
  };
}

function collectorConfig() {
  let baseUrl;
  try { baseUrl = new URL(process.env.COLLECTOR_URL || 'http://collector:5000'); }
  catch { baseUrl = new URL('http://collector:5000'); }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) baseUrl = new URL('http://collector:5000');
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
  return {
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    token: String(process.env.COLLECTOR_INTERNAL_TOKEN || ''),
  };
}

function safeCollectorPart(value, pattern, label) {
  const part = text(value);
  if (!pattern.test(part)) throw badRequest(`${label} format is invalid`);
  return part;
}

function assetMimeFromName(name, fallback = 'application/octet-stream') {
  const ext = String(name || '').split('.').pop()?.toLowerCase();
  return ({
    jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif', avif:'image/avif',
    mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', mkv:'video/x-matroska',
    mp3:'audio/mpeg', m4a:'audio/mp4', wav:'audio/wav', aac:'audio/aac', ogg:'audio/ogg',
  })[ext] || fallback;
}

export function safeMimeForKind(kind, value) {
  const mime = normalizeAssetMime(value);
  if (!SAFE_MIME_BY_KIND[kind]?.has(mime)) {
    throw badRequest(`Media MIME ${mime} is not allowed for ${kind}`);
  }
  return mime;
}

async function existingCaptureAsset(captureId, kind, originalName) {
  if (!captureId) return null;
  const { rows } = await query(`
    SELECT * FROM sample_assets
     WHERE capture_id=$1 AND kind=$2 AND original_name=$3 AND deleted_at IS NULL
     ORDER BY id LIMIT 1`, [captureId, kind, originalName]);
  return rows[0] || null;
}

async function saveCollectorAsset({ sampleId, captureId, kind, originalName, readable, contentLength,
  mimeType, width = null, height = null, durationMs = null, sourceUrl = null,
  archiveQuality = 'unknown' }) {
  const duplicate = await existingCaptureAsset(captureId, kind, originalName);
  if (duplicate) return duplicate;
  const saved = await saveAssetWithRecord({
    readable, rootDir: ASSET_ROOT, maxBytes: maxAssetBytes(), expectedBytes: contentLength,
  }, async file => {
    const { rows } = await query(`
      INSERT INTO sample_assets (
        sample_id,capture_id,kind,storage_key,original_name,mime_type,byte_size,sha256,
        width,height,duration_ms,source_url,archive_quality,uploaded_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL)
      RETURNING *`, [sampleId, captureId, kind, file.storageKey, originalName,
      safeMimeForKind(kind, mimeType), file.byteSize, file.sha256, width, height, durationMs,
      sourceUrl, ARCHIVE_QUALITIES.has(archiveQuality) ? archiveQuality : 'unknown']);
    return rows[0];
  });
  return saved.record;
}

async function pullCollectorAsset({ taskId, filename, pathType, ...meta }) {
  const config = collectorConfig();
  if (Buffer.byteLength(config.token, 'utf8') < 32) {
    throw new HttpError(503, 'Collector internal token is not configured');
  }
  const safeTask = safeCollectorPart(taskId, COLLECTOR_TASK_RE, 'task id');
  const safeFile = safeCollectorPart(filename, COLLECTOR_FILE_RE, 'file name');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let response;
  try {
    response = await fetch(`${config.baseUrl}/api/${pathType}/${encodeURIComponent(safeTask)}/${encodeURIComponent(safeFile)}`, {
      headers: { 'x-collector-token': config.token },
      redirect: 'error', signal: controller.signal,
    });
  } catch (error) {
    throw new HttpError(502, `Unable to read archived media from Collector: ${error.name}`);
  } finally { clearTimeout(timer); }
  if (!response.ok || !response.body) throw new HttpError(502, `Collector media returned HTTP ${response.status}`);
  const declaredMime = normalizeAssetMime(response.headers.get('content-type'));
  if (declaredMime === 'text/html' || declaredMime === 'application/json') {
    throw new HttpError(502, 'Collector returned a non-media response');
  }
  const resolvedMime = declaredMime === 'application/octet-stream'
    ? assetMimeFromName(safeFile, declaredMime) : declaredMime;
  safeMimeForKind(meta.kind, resolvedMime);
  return saveCollectorAsset({
    ...meta, originalName: safeFile, readable: response.body,
    contentLength: response.headers.get('content-length'),
    mimeType: resolvedMime,
  });
}

function inlineImage(value) {
  const raw = text(value);
  if (!raw) return null;
  const match = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length) return null;
  return { bytes, mimeType: normalizeAssetMime(match[1]) };
}

function maxAssetBytes() {
  const configured = Number(process.env.SAMPLE_ASSET_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 500 * 1024 * 1024;
}

async function recordCaptureMetrics(result, input, createdBy = null, db = { query }) {
  if (!result?.sample?.id || !result?.capture?.id) return null;
  return recordMetricSnapshot(db, {
    sampleId:Number(result.sample.id), captureId:Number(result.capture.id),
    observedAt:input?.capturedAt || input?.captured_at || result.capture.captured_at,
    metrics:input?.metrics || input?.engagement || {}, createdBy,
  });
}

function strictId(value, label = 'id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest(`${label} 不合法`);
  return id;
}

function optionalPositiveInt(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const out = Number(value);
  if (!Number.isSafeInteger(out) || out < 0) throw badRequest(`${label} 不合法`);
  return out;
}

function captureDto(row) {
  const dto = {
    id: Number(row.id),
    sampleId: Number(row.sample_id),
    captureKey: row.capture_key,
    captureType: row.capture_type,
    capturedAt: row.captured_at,
    sourceUrl: row.source_url,
    normalizedPayload: row.normalized_payload || {},
    payloadSha256: row.payload_sha256,
    completenessScore: Number(row.completeness_score || 0),
    missingFields: row.missing_fields || [],
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdAt: row.created_at,
  };
  if (Object.hasOwn(row, 'raw_payload')) dto.rawPayload = row.raw_payload;
  return dto;
}

function assetDto(row) {
  return {
    id: Number(row.id),
    sampleId: Number(row.sample_id),
    captureId: row.capture_id == null ? null : Number(row.capture_id),
    kind: row.kind,
    originalName: row.original_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    sourceUrl: row.source_url,
    archiveQuality: row.archive_quality,
    createdAt: row.created_at,
    contentUrl: `/api/samples/${Number(row.sample_id)}/assets/${Number(row.id)}`,
  };
}

async function loadSample(id) {
  const { rows } = await query(`
    SELECT s.*,
           (SELECT count(*) FROM sample_captures c WHERE c.sample_id=s.id) AS capture_count,
           (SELECT count(*) FROM sample_assets a WHERE a.sample_id=s.id AND a.deleted_at IS NULL) AS asset_count,
           (SELECT a.id FROM sample_assets a
             WHERE a.sample_id=s.id AND a.kind IN ('cover','image') AND a.deleted_at IS NULL
             ORDER BY CASE WHEN a.kind='cover' THEN 0 ELSE 1 END,a.id LIMIT 1) AS cover_asset_id
      FROM samples s
     WHERE s.id=$1 AND s.deleted_at IS NULL`, [id]);
  return rows[0] || null;
}

async function refreshCompleteness(sampleId) {
  const { rows } = await query(`
    SELECT s.*,
           EXISTS(SELECT 1 FROM sample_assets a
                   WHERE a.sample_id=s.id AND a.kind IN ('cover','image') AND a.deleted_at IS NULL) AS has_cover,
           EXISTS(SELECT 1 FROM sample_assets a
                   WHERE a.sample_id=s.id AND a.kind IN ('image','video','audio') AND a.deleted_at IS NULL) AS has_media
      FROM samples s WHERE s.id=$1 AND s.deleted_at IS NULL`, [sampleId]);
  if (!rows[0]) return null;
  const completeness = sampleCompleteness(rows[0]);
  await query(`UPDATE samples
                  SET completeness_score=$2, missing_fields=$3::text[], archive_status=$4, updated_at=now()
                WHERE id=$1`, [sampleId, completeness.score, completeness.missingFields, completeness.archiveStatus]);
  return completeness;
}

function uploadMetadata(url, req) {
  const mimeType = normalizeAssetMime(req.headers['content-type']);
  let kind = String(q(url, 'kind', '') || '').toLowerCase();
  if (!kind) {
    kind = mimeType.startsWith('image/') ? 'image'
      : mimeType.startsWith('video/') ? 'video'
        : mimeType.startsWith('audio/') ? 'audio' : 'other';
  }
  if (!ASSET_KINDS.has(kind)) throw badRequest('不支持的样本资产类型');
  safeMimeForKind(kind, mimeType);
  const archiveQuality = String(q(url, 'archiveQuality', 'user_upload')).toLowerCase();
  if (!ARCHIVE_QUALITIES.has(archiveQuality)) throw badRequest('不支持的归档质量标记');
  const originalName = String(q(url, 'name', 'media') || 'media').trim().slice(0, 500) || 'media';
  return {
    captureId: q(url, 'captureId') ? strictId(q(url, 'captureId'), 'captureId') : null,
    kind,
    originalName,
    mimeType,
    width: optionalPositiveInt(q(url, 'width'), 'width'),
    height: optionalPositiveInt(q(url, 'height'), 'height'),
    durationMs: optionalPositiveInt(q(url, 'durationMs'), 'durationMs'),
    sourceUrl: q(url, 'sourceUrl') ? String(q(url, 'sourceUrl')).slice(0, 8_000) : null,
    archiveQuality,
  };
}

async function uploadForSample(req, res, sampleId, url, me) {
  const sample = await loadSample(sampleId);
  if (!sample) throw notFound('样本不存在或已删除');
  const meta = uploadMetadata(url, req);
  const contentLength = req.headers['content-length'] === undefined ? null : req.headers['content-length'];
  const saved = await saveAssetWithRecord({
    readable: req,
    rootDir: ASSET_ROOT,
    maxBytes: maxAssetBytes(),
    expectedBytes: contentLength,
  }, async file => {
    const { rows } = await query(`
      INSERT INTO sample_assets (
        sample_id, capture_id, kind, storage_key, original_name, mime_type,
        byte_size, sha256, width, height, duration_ms, source_url,
        archive_quality, uploaded_by
      )
      SELECT s.id, c.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        FROM samples s
        LEFT JOIN sample_captures c ON c.sample_id=s.id AND c.id=$2
       WHERE s.id=$1 AND s.deleted_at IS NULL AND ($2::bigint IS NULL OR c.id IS NOT NULL)
      RETURNING *`, [
        sampleId, meta.captureId, meta.kind, file.storageKey, meta.originalName,
        meta.mimeType, file.byteSize, file.sha256, meta.width, meta.height,
        meta.durationMs, meta.sourceUrl, meta.archiveQuality, me.id,
      ]);
    if (!rows[0]) throw badRequest('captureId 不属于当前样本');
    return rows[0];
  });
  let record=saved.record;
  if(!meta.captureId){
    const [{rows:previousCaptures},{rows:assetRows}]=await Promise.all([
      query('SELECT raw_payload FROM sample_captures WHERE sample_id=$1 ORDER BY captured_at DESC,id DESC LIMIT 1',[sampleId]),
      query('SELECT id FROM sample_assets WHERE sample_id=$1 AND deleted_at IS NULL ORDER BY id',[sampleId]),
    ]);
    const previousRaw=previousCaptures[0]?.raw_payload&&typeof previousCaptures[0].raw_payload==='object'
      ?previousCaptures[0].raw_payload:{};
    const supplement=await tx(client=>upsertSampleWithCapture(client,{
      ingestMethod:'upload',platform:sample.platform,platformContentId:sample.platform_content_id,
      sourceUrl:sample.source_url,title:sample.title,bodyText:sample.body_text,
      contentType:sample.content_type,accountName:sample.account_name,accountHandle:sample.account_handle,
      publishedAt:sample.published_at,metrics:sample.metrics,captureKey:`upload-asset:${record.id}`,
      hasCover:meta.kind==='cover',hasMedia:true,
      rawPayload:{...previousRaw,source:'media_supplement',asset_ids:assetRows.map(row=>Number(row.id)),
        media_supplements:[...(Array.isArray(previousRaw.media_supplements)?previousRaw.media_supplements:[]),
          {assetId:Number(record.id),kind:meta.kind,sha256:record.sha256}]},
    },me.id,{canonicalKey:sample.canonical_key}));
    const {rows}=await query('UPDATE sample_assets SET capture_id=$2 WHERE id=$1 AND capture_id IS NULL RETURNING *',
      [record.id,supplement.capture.id]);
    record=rows[0]||record;
  }
  const completeness = await refreshCompleteness(sampleId);
  sendJson(res, 201, { ...assetDto(record), completeness });
}

async function archiveCollectorAssets(sampleId, captureId, payload) {
  const taskId = safeCollectorPart(payload.task_id, COLLECTOR_TASK_RE, 'task id');
  const archived = [];
  const warnings = [];
  const images = Array.isArray(payload.images) ? payload.images : [];
  for (const [index, image] of images.entries()) {
    const filename = text(image?.filename);
    if (!filename) { warnings.push(`image ${index + 1} has no archived file name`); continue; }
    try {
      const row = await pullCollectorAsset({
        sampleId, captureId, taskId, filename, pathType: 'image', kind: 'image',
        width: optionalPositiveInt(image.width, 'width'),
        height: optionalPositiveInt(image.height, 'height'),
        sourceUrl: text(image.source_url) || null,
        archiveQuality: 'original_images',
      });
      archived.push(row);
    } catch (error) { warnings.push(`image ${index + 1}: ${error.message}`); }
  }

  const video = payload.media_assets?.video && typeof payload.media_assets.video === 'object'
    ? payload.media_assets.video : {};
  if (text(video.filename)) {
    try {
      const row = await pullCollectorAsset({
        sampleId, captureId, taskId, filename: video.filename, pathType: 'media', kind: 'video',
        width: optionalPositiveInt(video.width, 'width'),
        height: optionalPositiveInt(video.height, 'height'),
        durationMs: video.duration_seconds == null || video.duration_seconds === ''
          ? null : optionalPositiveInt(Math.round(Number(video.duration_seconds) * 1000), 'durationMs'),
        sourceUrl: text(video.source_url || payload.source_url) || null,
        archiveQuality: text(video.archive_quality) || 'bounded_720p',
      });
      archived.push(row);
    } catch (error) { warnings.push(`video: ${error.message}`); }
  }

  const cover = inlineImage(video.cover_image_b64);
  if (cover) {
    try {
      const row = await saveCollectorAsset({
        sampleId, captureId, kind: 'cover', originalName: 'cover-from-collector',
        readable: Readable.from([cover.bytes]), contentLength: cover.bytes.length,
        mimeType: cover.mimeType,
        width: optionalPositiveInt(video.cover_image_width, 'cover width'),
        height: optionalPositiveInt(video.cover_image_height, 'cover height'),
        sourceUrl: text(video.cover_image_url) || null,
        archiveQuality: 'platform_available',
      });
      archived.push(row);
    } catch (error) { warnings.push(`cover: ${error.message}`); }
  } else if (text(video.cover_filename)) {
    try {
      const row = await pullCollectorAsset({
        sampleId, captureId, taskId, filename: video.cover_filename, pathType: 'media', kind: 'cover',
        width: optionalPositiveInt(video.cover_image_width, 'cover width'),
        height: optionalPositiveInt(video.cover_image_height, 'cover height'),
        sourceUrl: text(video.cover_image_url) || null,
        archiveQuality: 'platform_available',
      });
      archived.push(row);
    } catch (error) { warnings.push(`cover: ${error.message}`); }
  }
  return { archived, warnings };
}

export function mount(router) {
  router.post('/api/ingest/sample', async (req, res) => {
    const key = await requireKey(req, 'tech1');
    const payload = await readJson(req, 32 * 1024 * 1024);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw badRequest('Collector sample payload must be a JSON object');
    }
    if (Array.isArray(payload.images) && payload.images.length > 50) {
      throw badRequest('A single sample cannot archive more than 50 images');
    }
    const input = collectorPayloadToSampleInput(payload);
    const result = await tx(async client => {
      const saved=await upsertSampleWithCapture(client,input,null);
      await recordCaptureMetrics(saved,input,null,client);
      return saved;
    });
    const sampleId = Number(result.sample.id);
    const captureId = result.capture?.id == null ? null : Number(result.capture.id);
    const media = await archiveCollectorAssets(sampleId, captureId, payload);
    let completeness = await refreshCompleteness(sampleId);
    if (media.warnings.length) {
      const missingFields = [...new Set([...(completeness?.missingFields || []), 'media_archive_failed'])];
      const score = Math.min(85, Number(completeness?.score || 0));
      await query(`UPDATE samples SET completeness_score=$2,missing_fields=$3::text[],archive_status='partial',updated_at=now() WHERE id=$1`,
        [sampleId,score,missingFields]);
      completeness = { score,missingFields,archiveStatus:'partial' };
    }
    const archiveComplete = media.warnings.length === 0;
    sendJson(res, archiveComplete ? 200 : 502, {
      ok: archiveComplete,
      ...(archiveComplete ? {} : {
        error: 'Sample metadata was saved, but one or more media files were not archived. Retry the archive action.',
      }),
      sampleId,
      captureId,
      created: result.inserted,
      assetsArchived: media.archived.length,
      warnings: media.warnings,
      completeness,
      by: key.name,
    });
  });

  router.get('/api/samples', async (req, res, _params, url) => {
    await currentUser(req);
    const page = Math.max(1, qInt(url, 'page', 1));
    const pageSize = Math.min(100, Math.max(1, qInt(url, 'pageSize', 24)));
    const where = ['s.deleted_at IS NULL'];
    const args = [];
    const bind = value => { args.push(value); return `$${args.length}`; };
    const platform = q(url, 'platform');
    const archiveStatus = q(url, 'archiveStatus');
    const search = String(q(url, 'q', '') || '').trim();
    if (platform) where.push(`s.platform=${bind(String(platform).toLowerCase())}`);
    if (archiveStatus) where.push(`s.archive_status=${bind(archiveStatus)}`);
    if (search) {
      const p = bind(`%${search}%`);
      where.push(`(s.title ILIKE ${p} OR s.body_text ILIKE ${p} OR s.account_name ILIKE ${p} OR s.platform_content_id ILIKE ${p})`);
    }
    const clause = where.join(' AND ');
    const countArgs = [...args];
    const [{ rows: countRows }, { rows: summaryRows }] = await Promise.all([
      query(`SELECT count(*) AS count FROM samples s WHERE ${clause}`, countArgs),
      query(`SELECT count(*) AS total,
                    count(*) FILTER (WHERE archive_status='complete') AS complete,
                    count(*) FILTER (WHERE archive_status<>'complete') AS incomplete
               FROM samples WHERE deleted_at IS NULL`),
    ]);
    args.push(pageSize, (page - 1) * pageSize);
    const { rows } = await query(`
      SELECT s.id, s.canonical_key, s.platform, s.platform_content_id, s.source_url,
             s.title, left(s.body_text,280) AS body_excerpt, s.content_type,
             s.account_name, s.account_handle, s.published_at, s.metrics,
             s.archive_status, s.completeness_score, s.missing_fields,
             s.created_at, s.updated_at,
             (SELECT count(*) FROM sample_captures c WHERE c.sample_id=s.id) AS capture_count,
             (SELECT count(*) FROM sample_assets a WHERE a.sample_id=s.id AND a.deleted_at IS NULL) AS asset_count,
             (SELECT a.id FROM sample_assets a
               WHERE a.sample_id=s.id AND a.kind IN ('cover','image') AND a.deleted_at IS NULL
               ORDER BY CASE WHEN a.kind='cover' THEN 0 ELSE 1 END,a.id LIMIT 1) AS cover_asset_id
        FROM samples s
       WHERE ${clause}
       ORDER BY COALESCE(s.published_at,s.created_at) DESC, s.id DESC
       LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    sendJson(res, 200, {
      items: rows.map(sampleListItem),
      total: Number(countRows[0]?.count || 0),
      page,
      pageSize,
      summary: {
        total:Number(summaryRows[0]?.total || 0),
        complete:Number(summaryRows[0]?.complete || 0),
        incomplete:Number(summaryRows[0]?.incomplete || 0),
      },
    });
  });

  router.get('/api/samples/:id', async (req, res, params) => {
    await currentUser(req);
    const sample = await loadSample(strictId(params.id, '样本 id'));
    if (!sample) throw notFound('样本不存在或已删除');
    const [{ rows: captures }, { rows: captureCounts }, { rows: assets }] = await Promise.all([
      query(`SELECT id,sample_id,capture_key,capture_type,captured_at,source_url,
                    normalized_payload,payload_sha256,completeness_score,missing_fields,created_by,created_at
               FROM sample_captures WHERE sample_id=$1 ORDER BY captured_at DESC,id DESC LIMIT 20`, [sample.id]),
      query('SELECT count(*) AS count FROM sample_captures WHERE sample_id=$1', [sample.id]),
      query('SELECT * FROM sample_assets WHERE sample_id=$1 AND deleted_at IS NULL ORDER BY created_at,id', [sample.id]),
    ]);
    sendJson(res, 200, {
      ...sampleListItem(sample),
      bodyText: sample.body_text,
      firstIngestMethod: sample.first_ingest_method,
      lastIngestMethod: sample.last_ingest_method,
      captures: captures.map(captureDto),
      captureTotal:Number(captureCounts[0]?.count || 0),
      assets: assets.map(assetDto),
    });
  });

  router.get('/api/samples/:id/captures', async (req, res, params, url) => {
    await currentUser(req);
    const sampleId = strictId(params.id, '样本 id');
    if (!await loadSample(sampleId)) throw notFound('样本不存在或已删除');
    const page=Math.max(1,qInt(url,'page',1));const pageSize=Math.min(100,Math.max(1,qInt(url,'pageSize',20)));
    const [{ rows }, { rows: counts }] = await Promise.all([
      query(`SELECT id,sample_id,capture_key,capture_type,captured_at,source_url,
                    normalized_payload,payload_sha256,completeness_score,missing_fields,created_by,created_at
               FROM sample_captures WHERE sample_id=$1 ORDER BY captured_at DESC,id DESC LIMIT $2 OFFSET $3`,
      [sampleId,pageSize,(page-1)*pageSize]),
      query('SELECT count(*) AS count FROM sample_captures WHERE sample_id=$1',[sampleId]),
    ]);
    sendJson(res,200,{items:rows.map(captureDto),total:Number(counts[0]?.count||0),page,pageSize});
  });

  router.get('/api/samples/:id/captures/:captureId/raw', async (req, res, params) => {
    await currentUser(req);
    const sampleId=strictId(params.id,'样本 id');const captureId=strictId(params.captureId,'采集版本 id');
    const { rows }=await query(`SELECT raw_payload::text AS raw_text FROM sample_captures c
      JOIN samples s ON s.id=c.sample_id AND s.deleted_at IS NULL
      WHERE c.id=$1 AND c.sample_id=$2`,[captureId,sampleId]);
    if(!rows[0])throw notFound('采集版本不存在');
    const raw=String(rows[0].raw_text||'{}');
    res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(raw),
      'cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(raw);
  });

  router.patch('/api/samples/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const sample = await loadSample(strictId(params.id, '样本 id'));
    if (!sample) throw notFound('样本不存在或已删除');
    const body = await readJson(req, 4 * 1024 * 1024);
    const input = {
      ingestMethod:'manual',
      platform:body.platform ?? sample.platform,
      platformContentId:body.platformContentId ?? sample.platform_content_id,
      sourceUrl:body.sourceUrl ?? sample.source_url,
      manualKey:sample.canonical_key,
      title:body.title ?? sample.title,
      bodyText:body.bodyText ?? sample.body_text,
      contentType:body.contentType ?? sample.content_type,
      accountName:body.accountName ?? sample.account_name,
      accountHandle:body.accountHandle ?? sample.account_handle,
      publishedAt:body.publishedAt ?? sample.published_at,
      metrics:{ ...(sample.metrics || {}), ...(body.metrics || {}) },
      capturedAt:new Date().toISOString(),
      rawPayload:{ source:'manual_sample_update',sampleId:Number(sample.id),changes:body },
    };
    const identity = canonicalSampleIdentity(input);
    const { rows: conflicts } = await query(`
      SELECT id FROM samples
       WHERE id<>$1 AND deleted_at IS NULL AND (
         canonical_key=$2
         OR ($4::text IS NOT NULL AND platform=$3 AND platform_content_id=$4)
         OR ($5::text IS NOT NULL AND source_url=$5)
       ) LIMIT 1`, [sample.id,identity.canonicalKey,identity.platform,
      identity.platformContentId,identity.sourceUrl]);
    if (conflicts[0]) {
      throw new HttpError(409, '该原始链接或作品 ID 已属于另一篇样本，请打开已有样本继续补充');
    }
    const result = await tx(async client => {
      const saved=await upsertSampleWithCapture(client,input,me.id,{ canonicalKey:sample.canonical_key });
      await recordCaptureMetrics(saved,input,me.id,client);
      return saved;
    });
    await refreshCompleteness(Number(sample.id));
    const fresh = await loadSample(Number(sample.id));
    sendJson(res, 200, {
      sample:sampleListItem(fresh || result.sample),
      capture:captureDto(result.capture),
      updated:true,
    });
  });

  router.post('/api/samples', async (req, res) => {
    const me = await currentUser(req);
    const body = await readJson(req, 4 * 1024 * 1024);
    const requested = String(body.ingestMethod ?? body.ingest_method ?? '').toLowerCase();
    if (requested && requested !== 'manual' && requested !== 'link') {
      throw badRequest('此入口只接受手动录入或链接归档');
    }
    const result = await tx(async client => {
      const saved=await upsertSampleWithCapture(client,body,me.id);
      await recordCaptureMetrics(saved,body,me.id,client);
      return saved;
    });
    const fresh = await loadSample(Number(result.sample.id));
    sendJson(res, result.inserted ? 201 : 200, {
      sample: sampleListItem(fresh || result.sample),
      capture: captureDto(result.capture),
      created: result.inserted,
    });
  });

  // Raw media can start a partial sample when no sample id exists yet.
  router.post('/api/samples/assets', async (req, res, _params, url) => {
    const me = await currentUser(req);
    const input = {
      ingestMethod: 'upload',
      title: q(url, 'title'),
      platform: q(url, 'platform'),
      platformContentId: q(url, 'platformContentId'),
      sourceUrl: q(url, 'sourceUrl'),
      manualKey: q(url, 'manualKey'),
      contentType: q(url, 'contentType'),
      rawPayload: { source: 'raw_media_upload' },
    };
    const result = await tx(async client => {
      const saved=await upsertSampleWithCapture(client,input,me.id);
      await recordCaptureMetrics(saved,input,me.id,client);
      return saved;
    });
    if (!url.searchParams.has('captureId') && result.capture?.id) {
      url.searchParams.set('captureId', String(result.capture.id));
    }
    await uploadForSample(req, res, Number(result.sample.id), url, me);
  });

  router.post('/api/samples/:id/assets', async (req, res, params, url) => {
    const me = await currentUser(req);
    await uploadForSample(req, res, strictId(params.id, '样本 id'), url, me);
  });

  router.get('/api/samples/:id/assets/:assetId', async (req, res, params) => {
    await currentUser(req);
    const sampleId = strictId(params.id, '样本 id');
    const assetId = strictId(params.assetId, '资产 id');
    const { rows } = await query(`
      SELECT a.* FROM sample_assets a
      JOIN samples s ON s.id=a.sample_id AND s.deleted_at IS NULL
      WHERE a.id=$1 AND a.sample_id=$2 AND a.deleted_at IS NULL`, [assetId, sampleId]);
    const asset = rows[0];
    if (!asset) throw notFound('样本资产不存在或已删除');

    let file;
    try {
      file = await safeAssetStat(ASSET_ROOT, asset.storage_key);
    } catch (error) {
      if (error.code === 'ENOENT') throw notFound('样本资产文件不存在');
      throw error;
    }
    let range;
    try {
      range = parseByteRange(req.headers.range, file.info.size);
    } catch (error) {
      if (error instanceof RangeNotSatisfiableError) {
        res.writeHead(416, {
          'content-range': `bytes */${error.size}`,
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=300',
        });
        res.end();
        return;
      }
      throw error;
    }
    const headers = {
      'content-type': asset.kind === 'other'
        ? (SAFE_MIME_BY_KIND.other.has(asset.mime_type) ? asset.mime_type : 'application/octet-stream')
        : safeMimeForKind(asset.kind, asset.mime_type),
      'content-length': range.length,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-disposition': `${asset.kind === 'other' ? 'attachment' : 'inline'}; filename="asset"; filename*=UTF-8''${encodeURIComponent(asset.original_name || 'media')}`,
      etag: `"sha256-${asset.sha256}"`,
    };
    if (range.contentRange) headers['content-range'] = range.contentRange;
    res.writeHead(range.status, headers);
    const stream = createReadStream(file.path, { start: range.start, end: range.end });
    stream.on('error', error => res.destroy(error));
    stream.pipe(res);
  });
}
