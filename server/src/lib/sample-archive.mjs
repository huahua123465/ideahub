import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { HttpError, badRequest } from './http.mjs';

const TRACKING_PARAMS = new Set([
  'app', 'app_id', 'channel', 'from', 'from_source', 'share_from_user_hidden',
  'share_id', 'share_platform', 'share_source', 'source', 'timestamp', 'type',
  'utm_campaign', 'utm_content', 'utm_medium', 'utm_source', 'utm_term',
  'xsec_source', 'xsec_token',
]);

const PLATFORM_ALIASES = new Map([
  ['xhs', 'xiaohongshu'],
  ['rednote', 'xiaohongshu'],
  ['xiaohongshu.com', 'xiaohongshu'],
  ['douyin.com', 'douyin'],
  ['tiktok', 'douyin'],
  ['bilibili.com', 'bilibili'],
  ['weixin', 'wechat'],
  ['weixin.qq.com', 'wechat'],
  ['wechat', 'wechat'],
  ['manual', 'manual'],
]);

const PLATFORM_HOSTS = [
  [/\.xiaohongshu\.com$/i, 'xiaohongshu'],
  [/(^|\.)douyin\.com$/i, 'douyin'],
  [/(^|\.)bilibili\.com$/i, 'bilibili'],
  [/(^|\.)weixin\.qq\.com$/i, 'wechat'],
  [/(^|\.)youtube\.com$/i, 'youtube'],
  [/(^|\.)youtu\.be$/i, 'youtube'],
];

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const STORAGE_KEY_RE = /^[a-f0-9]{48}$/;
const INGEST_METHODS = new Set(['manual', 'link', 'upload', 'collector', 'legacy']);
const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

function stringOrNull(value, max = 20_000) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  if (!out) return null;
  if (out.length > max) throw badRequest(`字段长度不能超过 ${max} 个字符`);
  return out;
}

function first(obj, ...keys) {
  for (const key of keys) {
    if (obj?.[key] !== undefined) return obj[key];
  }
  return undefined;
}

export function normalizePlatform(value, sourceUrl = null) {
  const raw = stringOrNull(value, 80)?.toLowerCase();
  if (raw) return PLATFORM_ALIASES.get(raw) || raw.replace(/[^a-z0-9_-]+/g, '-');
  if (sourceUrl) {
    try {
      const host = new URL(sourceUrl).hostname.toLowerCase();
      for (const [pattern, platform] of PLATFORM_HOSTS) {
        if (pattern.test(host)) return platform;
      }
    } catch { /* normalizeCanonicalUrl reports a useful error below */ }
  }
  return 'manual';
}

/** Normalize public source URLs without retaining fragments or common share/tracking tokens. */
export function normalizeCanonicalUrl(value) {
  const text = stringOrNull(value, 8_000);
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw badRequest('来源链接不是合法的 HTTP/HTTPS 地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('来源链接只支持 HTTP/HTTPS');
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  return url.toString();
}

function platformContentIdFromUrl(platform, canonicalUrl) {
  if (!canonicalUrl) return null;
  const url = new URL(canonicalUrl);
  const patterns = {
    xiaohongshu: [/\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)/],
    douyin: [/\/video\/(\d+)/],
    bilibili: [/\/video\/(BV[A-Za-z0-9]+)/i],
    youtube: [/\/(?:shorts|embed)\/([A-Za-z0-9_-]+)/],
  };
  for (const pattern of patterns[platform] || []) {
    const match = url.pathname.match(pattern);
    if (match) return match[1];
  }
  if (platform === 'youtube') return url.searchParams.get('v');
  if (platform === 'douyin') return url.searchParams.get('modal_id');
  return null;
}

export function canonicalSampleIdentity(input = {}) {
  const sourceUrl = normalizeCanonicalUrl(first(input, 'sourceUrl', 'source_url'));
  const platform = normalizePlatform(first(input, 'platform'), sourceUrl);
  const explicitId = stringOrNull(first(input, 'platformContentId', 'platform_content_id'), 500);
  const platformContentId = explicitId || platformContentIdFromUrl(platform, sourceUrl);
  if (platformContentId) {
    const id = platformContentId.normalize('NFKC').trim().toLowerCase();
    return { canonicalKey: `${platform}:id:${id}`, platform, platformContentId, sourceUrl };
  }
  if (sourceUrl) {
    const digest = createHash('sha256').update(sourceUrl).digest('hex');
    return { canonicalKey: `${platform}:url:${digest}`, platform, platformContentId: null, sourceUrl };
  }
  const manualKey = stringOrNull(first(input, 'manualKey', 'manual_key'), 500);
  if (manualKey) {
    const digest = createHash('sha256').update(manualKey.normalize('NFKC').toLowerCase()).digest('hex');
    return { canonicalKey: `manual:ref:${digest}`, platform: 'manual', platformContentId: null, sourceUrl: null };
  }
  return { canonicalKey: `manual:new:${randomUUID()}`, platform: 'manual', platformContentId: null, sourceUrl: null };
}

function validDate(value) {
  const text = stringOrNull(value, 100);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.valueOf())) throw badRequest('发布时间不是合法日期');
  return date.toISOString();
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasMetricValue(value) {
  return Object.values(objectOrEmpty(value)).some(
    item => item !== null && item !== undefined && String(item).trim() !== '',
  );
}

export function normalizeSampleInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('样本内容必须是 JSON 对象');
  const identity = canonicalSampleIdentity(input);
  const ingestMethod = stringOrNull(first(input, 'ingestMethod', 'ingest_method'), 40)
    || (identity.sourceUrl ? 'link' : 'manual');
  if (!INGEST_METHODS.has(ingestMethod)) throw badRequest('不支持的样本录入方式');
  const normalized = {
    ...identity,
    title: stringOrNull(first(input, 'title'), 500),
    bodyText: stringOrNull(first(input, 'bodyText', 'body_text', 'content', 'originalText', 'original_text'), 2_000_000),
    contentType: stringOrNull(first(input, 'contentType', 'content_type'), 80),
    accountName: stringOrNull(first(input, 'accountName', 'account_name', 'authorName', 'author_name'), 500),
    accountHandle: stringOrNull(first(input, 'accountHandle', 'account_handle', 'authorHandle', 'author_handle'), 500),
    publishedAt: validDate(first(input, 'publishedAt', 'published_at')),
    metrics: objectOrEmpty(first(input, 'metrics', 'engagement')),
    ingestMethod,
    captureKey: stringOrNull(first(input, 'captureKey', 'capture_key'), 500),
    capturedAt: validDate(first(input, 'capturedAt', 'captured_at')),
    hasCover: Boolean(first(input, 'hasCover', 'has_cover', 'coverUrl', 'cover_url')),
    hasMedia: Boolean(first(input, 'hasMedia', 'has_media', 'mediaUrl', 'media_url')),
  };
  normalized.rawPayload = first(input, 'rawPayload', 'raw_payload') ?? input;
  return normalized;
}

export function sampleCompleteness(input = {}) {
  const checks = [
    ['source_identity', 15, Boolean(
      input.platformContentId || input.platform_content_id || input.sourceUrl || input.source_url
      || input.canonicalKey || input.canonical_key
    )],
    ['title', 10, Boolean(stringOrNull(input.title, 500))],
    ['body_text', 20, Boolean(stringOrNull(input.bodyText ?? input.body_text, 2_000_000))],
    ['account', 10, Boolean(stringOrNull(input.accountName ?? input.account_name ?? input.accountHandle ?? input.account_handle, 500))],
    ['published_at', 10, Boolean(input.publishedAt ?? input.published_at)],
    ['metrics', 10, hasMetricValue(input.metrics)],
    ['cover', 10, Boolean(input.hasCover ?? input.has_cover)],
    ['media', 15, Boolean(input.hasMedia ?? input.has_media)],
  ];
  const score = checks.reduce((sum, [, weight, present]) => sum + (present ? weight : 0), 0);
  return {
    score,
    missingFields: checks.filter(([, , present]) => !present).map(([name]) => name),
    archiveStatus: score === 100 ? 'complete' : score >= 50 ? 'usable' : 'partial',
  };
}

function payloadDigest(value) {
  const json = JSON.stringify(value ?? null);
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Upsert the canonical sample and always append a capture unless captureKey was already seen.
 * The caller supplies a transaction client with query(sql, params).
 */
export async function upsertSampleWithCapture(client, input, userId, options = {}) {
  const normalized = normalizeSampleInput(input);
  if (options.canonicalKey) {
    normalized.canonicalKey = String(options.canonicalKey);
  } else if (normalized.platformContentId || normalized.sourceUrl) {
    // A first capture can arrive with only a share URL, while a later capture
    // contains the platform id. Reuse that earlier row instead of splitting one
    // work into url-key and id-key samples.
    const { rows: aliases } = await client.query(`
      SELECT canonical_key FROM samples
       WHERE deleted_at IS NULL AND (
         canonical_key=$1
         OR ($3::text IS NOT NULL AND platform=$2 AND platform_content_id=$3)
         OR ($4::text IS NOT NULL AND source_url=$4)
       )
       ORDER BY CASE WHEN canonical_key=$1 THEN 0 ELSE 1 END,id
       LIMIT 1
       FOR UPDATE`, [normalized.canonicalKey, normalized.platform,
      normalized.platformContentId, normalized.sourceUrl]);
    if (aliases[0]?.canonical_key) normalized.canonicalKey = aliases[0].canonical_key;
  }
  const completeness = sampleCompleteness(normalized);
  const { rows: sampleRows } = await client.query(`
    INSERT INTO samples (
      canonical_key, platform, platform_content_id, source_url, title, body_text,
      content_type, account_name, account_handle, published_at, metrics,
      first_ingest_method, last_ingest_method, completeness_score,
      missing_fields, archive_status, created_by
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$12,$13,$14::text[],$15,$16
    )
    ON CONFLICT (canonical_key) DO UPDATE SET
      deleted_at = NULL,
      platform = CASE WHEN samples.platform='manual' THEN EXCLUDED.platform ELSE samples.platform END,
      platform_content_id = COALESCE(EXCLUDED.platform_content_id, samples.platform_content_id),
      source_url = COALESCE(EXCLUDED.source_url, samples.source_url),
      title = COALESCE(EXCLUDED.title, samples.title),
      body_text = COALESCE(EXCLUDED.body_text, samples.body_text),
      content_type = COALESCE(EXCLUDED.content_type, samples.content_type),
      account_name = COALESCE(EXCLUDED.account_name, samples.account_name),
      account_handle = COALESCE(EXCLUDED.account_handle, samples.account_handle),
      published_at = COALESCE(EXCLUDED.published_at, samples.published_at),
      metrics = samples.metrics || EXCLUDED.metrics,
      last_ingest_method = EXCLUDED.last_ingest_method,
      completeness_score = GREATEST(samples.completeness_score, EXCLUDED.completeness_score),
      missing_fields = CASE
        WHEN EXCLUDED.completeness_score >= samples.completeness_score THEN EXCLUDED.missing_fields
        ELSE samples.missing_fields
      END,
      archive_status = CASE
        WHEN EXCLUDED.completeness_score >= samples.completeness_score THEN EXCLUDED.archive_status
        ELSE samples.archive_status
      END,
      updated_at = now()
    RETURNING *, (xmax = 0) AS inserted`, [
      normalized.canonicalKey,
      normalized.platform,
      normalized.platformContentId,
      normalized.sourceUrl,
      normalized.title,
      normalized.bodyText,
      normalized.contentType,
      normalized.accountName,
      normalized.accountHandle,
      normalized.publishedAt,
      normalized.metrics,
      normalized.ingestMethod,
      completeness.score,
      completeness.missingFields,
      completeness.archiveStatus,
      userId || null,
    ]);
  const sample = sampleRows[0];
  if (!sample) throw new Error('sample upsert returned no row');

  const normalizedPayload = {
    platform: normalized.platform,
    platformContentId: normalized.platformContentId,
    sourceUrl: normalized.sourceUrl,
    title: normalized.title,
    bodyText: normalized.bodyText,
    contentType: normalized.contentType,
    accountName: normalized.accountName,
    accountHandle: normalized.accountHandle,
    publishedAt: normalized.publishedAt,
    metrics: normalized.metrics,
  };
  const { rows: captureRows } = await client.query(`
    INSERT INTO sample_captures (
      sample_id, capture_key, capture_type, captured_at, source_url,
      raw_payload, normalized_payload, payload_sha256, completeness_score,
      missing_fields, created_by
    ) VALUES ($1,$2,$3,COALESCE($4::timestamptz,now()),$5,$6::json,$7::jsonb,$8,$9,$10::text[],$11)
    ON CONFLICT (sample_id, capture_key) WHERE capture_key IS NOT NULL DO NOTHING
    RETURNING *`, [
      sample.id,
      normalized.captureKey,
      normalized.ingestMethod,
      normalized.capturedAt,
      normalized.sourceUrl,
      normalized.rawPayload,
      normalizedPayload,
      payloadDigest(normalized.rawPayload),
      completeness.score,
      completeness.missingFields,
      userId || null,
    ]);
  let capture = captureRows[0];
  if (!capture && normalized.captureKey) {
    const existing = await client.query(
      'SELECT * FROM sample_captures WHERE sample_id=$1 AND capture_key=$2',
      [sample.id, normalized.captureKey]);
    capture = existing.rows[0];
  }
  return { sample, capture, inserted: Boolean(sample.inserted), completeness, normalized };
}

export function defaultSampleAssetDir() {
  return assertAssetRootOutsideRepo(process.env.SAMPLE_ASSET_DIR || resolve(tmpdir(), 'ideahub-sample-assets'));
}

export function assertAssetRootOutsideRepo(rootDir) {
  const root = resolve(rootDir);
  const rel = relative(REPO_ROOT, root);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new HttpError(500, 'SAMPLE_ASSET_DIR 必须位于 IdeaHub 仓库外');
  }
  return root;
}

export function resolveAssetPath(rootDir, storageKey) {
  const root = assertAssetRootOutsideRepo(rootDir);
  const key = String(storageKey || '');
  if (!STORAGE_KEY_RE.test(key) || isAbsolute(key) || key.includes('/') || key.includes('\\')) {
    throw badRequest('非法的样本资产存储键');
  }
  const target = resolve(root, key);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw badRequest('样本资产路径越界');
  return target;
}

export function normalizeAssetMime(value) {
  const mime = String(value || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
  return MIME_RE.test(mime) ? mime : 'application/octet-stream';
}

export async function writeAssetStream(readable, {
  rootDir = defaultSampleAssetDir(),
  maxBytes = 500 * 1024 * 1024,
  expectedBytes = null,
} = {}) {
  if (typeof expectedBytes === 'string' && !/^\d+$/.test(expectedBytes)) throw badRequest('Content-Length 不合法');
  const declared = expectedBytes === null || expectedBytes === undefined ? null : Number(expectedBytes);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) throw badRequest('Content-Length 不合法');
  if (declared !== null && declared > maxBytes) throw new HttpError(413, '样本媒体超过上传上限');

  await mkdir(rootDir, { recursive: true });
  const storageKey = randomBytes(24).toString('hex');
  const finalPath = resolveAssetPath(rootDir, storageKey);
  const tempKey = randomBytes(24).toString('hex');
  const tempPath = resolve(rootDir, `.${tempKey}.uploading`);
  const hash = createHash('sha256');
  let byteSize = 0;
  const output = createWriteStream(tempPath, { flags: 'wx' });
  const outputDone = finished(output);
  outputDone.catch(() => {}); // handled in the success/catch branches below

  try {
    await once(output, 'open');
    const iterable = typeof readable.iterator === 'function'
      ? readable.iterator({ destroyOnReturn: false })
      : readable;
    for await (const chunk of iterable) {
      byteSize += chunk.length;
      if (byteSize > maxBytes) {
        readable.resume?.(); // drain an HTTP request so the 413 response can still be delivered
        throw new HttpError(413, '样本媒体超过上传上限');
      }
      hash.update(chunk);
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end();
    await outputDone;
    if (declared !== null && declared !== byteSize) throw badRequest('上传内容长度与 Content-Length 不一致');
    await rename(tempPath, finalPath);
    return { storageKey, absolutePath: finalPath, byteSize, sha256: hash.digest('hex') };
  } catch (error) {
    output.destroy();
    await outputDone.catch(() => {});
    readable.resume?.();
    await unlink(tempPath).catch(() => {});
    await unlink(finalPath).catch(() => {});
    throw error;
  }
}

/** Save first, insert its DB row second, and remove the file if the DB insert fails. */
export async function saveAssetWithRecord(options, insertRecord) {
  const saved = await writeAssetStream(options.readable, options);
  try {
    const record = await insertRecord(saved);
    return { ...saved, record };
  } catch (error) {
    await unlink(saved.absolutePath).catch(() => {});
    throw error;
  }
}

export async function safeAssetStat(rootDir, storageKey) {
  const path = resolveAssetPath(rootDir, storageKey);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(404, '样本资产不存在');
  return { path, info };
}

export class RangeNotSatisfiableError extends HttpError {
  constructor(size) {
    super(416, '请求的媒体范围不可用');
    this.size = size;
  }
}

/** Parse one RFC 7233 byte range. Multi-range responses are intentionally unsupported. */
export function parseByteRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size must be a non-negative safe integer');
  if (!header) return { status: 200, start: 0, end: Math.max(0, size - 1), length: size };
  const match = String(header).trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || size === 0) throw new RangeNotSatisfiableError(size);
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeNotSatisfiableError(size);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      throw new RangeNotSatisfiableError(size);
    }
    end = Math.min(end, size - 1);
  }
  return { status: 206, start, end, length: end - start + 1, contentRange: `bytes ${start}-${end}/${size}` };
}

export function sampleListItem(row) {
  return {
    id: Number(row.id),
    canonicalKey: row.canonical_key,
    platform: row.platform,
    platformContentId: row.platform_content_id,
    sourceUrl: row.source_url,
    title: row.title,
    bodyExcerpt: row.body_excerpt ?? (row.body_text ? String(row.body_text).slice(0, 280) : null),
    contentType: row.content_type,
    accountName: row.account_name,
    accountHandle: row.account_handle,
    publishedAt: row.published_at,
    metrics: row.metrics || {},
    archiveStatus: row.archive_status,
    completenessScore: Number(row.completeness_score || 0),
    missingFields: row.missing_fields || [],
    captureCount: Number(row.capture_count || 0),
    assetCount: Number(row.asset_count || 0),
    coverAssetId: row.cover_asset_id == null ? null : Number(row.cover_asset_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
