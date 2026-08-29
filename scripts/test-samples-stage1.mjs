import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';

import {
  RangeNotSatisfiableError,
  canonicalSampleIdentity,
  parseByteRange,
  resolveAssetPath,
  sampleCompleteness,
  sampleListItem,
  saveAssetWithRecord,
  upsertSampleWithCapture,
  writeAssetStream,
} from '../server/src/lib/sample-archive.mjs';
import { collectorPayloadToSampleInput, safeMimeForKind } from '../server/src/routes/samples.mjs';
import { legacyInput } from './migrate-work-analyses-to-samples.mjs';

async function tempAssetDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'ideahub-samples-test-'));
  const absolute = resolve(root);
  assert.ok(absolute.startsWith(resolve(tmpdir())), 'temporary directory must stay under the OS temp root');
  t.after(async () => rm(absolute, { recursive: true, force: true }));
  return absolute;
}

class FakeArchiveClient {
  constructor() {
    this.samples = new Map();
    this.captures = [];
  }

  async query(sql, params) {
    if (sql.includes('SELECT canonical_key FROM samples')) {
      const [canonicalKey, platform, platformContentId, sourceUrl] = params;
      const rows = [...this.samples.values()].filter(row =>
        row.deleted_at === null && (
          row.canonical_key === canonicalKey
          || (platformContentId && row.platform === platform && row.platform_content_id === platformContentId)
          || (sourceUrl && row.source_url === sourceUrl)
        ));
      rows.sort((a, b) => Number(b.canonical_key === canonicalKey) - Number(a.canonical_key === canonicalKey));
      return { rows: rows.slice(0, 1).map(row => ({ canonical_key:row.canonical_key })) };
    }
    if (sql.includes('INSERT INTO samples')) {
      const [canonicalKey, platform, platformContentId, sourceUrl, title, bodyText,
        contentType, accountName, accountHandle, publishedAt, metrics, ingestMethod,
        score, missingFields, archiveStatus, createdBy] = params;
      let row = this.samples.get(canonicalKey);
      const inserted = !row;
      if (!row) {
        row = {
          id: this.samples.size + 1,
          canonical_key: canonicalKey,
          platform,
          platform_content_id: platformContentId,
          source_url: sourceUrl,
          title,
          body_text: bodyText,
          content_type: contentType,
          account_name: accountName,
          account_handle: accountHandle,
          published_at: publishedAt,
          metrics,
          first_ingest_method: ingestMethod,
          last_ingest_method: ingestMethod,
          completeness_score: score,
          missing_fields: missingFields,
          archive_status: archiveStatus,
          created_by: createdBy,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
        };
        this.samples.set(canonicalKey, row);
      } else {
        row.last_ingest_method = ingestMethod;
        row.title = title || row.title;
        row.body_text = bodyText || row.body_text;
        row.deleted_at = null;
      }
      return { rows: [{ ...row, inserted }] };
    }
    if (sql.includes('INSERT INTO sample_captures')) {
      const [sampleId, captureKey, captureType, capturedAt, sourceUrl, rawPayload,
        normalizedPayload, payloadSha256, completenessScore, missingFields, createdBy] = params;
      if (captureKey && this.captures.some(row => row.sample_id === sampleId && row.capture_key === captureKey)) {
        return { rows: [] };
      }
      const row = {
        id: this.captures.length + 1,
        sample_id: sampleId,
        capture_key: captureKey,
        capture_type: captureType,
        captured_at: capturedAt || new Date().toISOString(),
        source_url: sourceUrl,
        raw_payload: rawPayload,
        normalized_payload: normalizedPayload,
        payload_sha256: payloadSha256,
        completeness_score: completenessScore,
        missing_fields: missingFields,
        created_by: createdBy,
        created_at: new Date().toISOString(),
      };
      this.captures.push(row);
      return { rows: [row] };
    }
    if (sql.includes('SELECT * FROM sample_captures')) {
      const [sampleId, captureKey] = params;
      return { rows: this.captures.filter(row => row.sample_id === sampleId && row.capture_key === captureKey) };
    }
    throw new Error(`unexpected SQL in fake: ${sql.slice(0, 80)}`);
  }
}

test('canonical identity removes tracking tokens and extracts a stable platform content id', () => {
  const first = canonicalSampleIdentity({
    sourceUrl: 'https://www.xiaohongshu.com/explore/ABC123/?utm_source=chat&xsec_token=secret',
  });
  const second = canonicalSampleIdentity({
    platform: 'xhs',
    sourceUrl: 'https://www.xiaohongshu.com/explore/ABC123?share_source=copy_link',
  });
  assert.equal(first.canonicalKey, 'xiaohongshu:id:abc123');
  assert.equal(first.canonicalKey, second.canonicalKey);
  assert.ok(!first.sourceUrl.includes('secret'));
});

test('same canonical work stays unique while captures remain append-only', async () => {
  const client = new FakeArchiveClient();
  const one = await upsertSampleWithCapture(client, {
    platform: 'xhs',
    sourceUrl: 'https://www.xiaohongshu.com/explore/ABC123?utm_source=one',
    title: '第一次采集',
    rawPayload: { version: 1 },
  }, 7);
  const two = await upsertSampleWithCapture(client, {
    platform: 'xiaohongshu',
    sourceUrl: 'https://www.xiaohongshu.com/explore/ABC123?share_source=two',
    title: '补充采集',
    rawPayload: { version: 2 },
  }, 7);
  assert.equal(one.sample.id, two.sample.id);
  assert.equal(client.samples.size, 1);
  assert.equal(client.captures.length, 2);
  assert.deepEqual(client.captures.map(row => row.raw_payload.version), [1, 2]);
});

test('capture key makes retried capture idempotent without creating a second capture', async () => {
  const client = new FakeArchiveClient();
  const input = { manualKey: 'legacy:42', captureKey: 'legacy-capture:42', title: '旧样本' };
  await upsertSampleWithCapture(client, input, 7);
  await upsertSampleWithCapture(client, input, 7);
  assert.equal(client.samples.size, 1);
  assert.equal(client.captures.length, 1);
});

test('a later platform id reuses the earlier URL-key sample', async () => {
  const client = new FakeArchiveClient();
  const sourceUrl = 'https://example.com/shared/post-one';
  const first = await upsertSampleWithCapture(client, {
    platform:'xiaohongshu', sourceUrl, title:'first capture', rawPayload:{version:1},
  }, 7);
  const second = await upsertSampleWithCapture(client, {
    platform:'xiaohongshu', platformContentId:'post-one', sourceUrl,
    title:'identified capture', rawPayload:{version:2},
  }, 7);
  assert.equal(first.sample.id, second.sample.id);
  assert.equal(client.samples.size, 1);
  assert.equal(client.captures.length, 2);
});

test('list DTO never exposes raw_payload', () => {
  const item = sampleListItem({ id: 1, canonical_key: 'manual:1', raw_payload: { secret: true } });
  assert.equal(Object.hasOwn(item, 'raw_payload'), false);
  assert.equal(Object.hasOwn(item, 'rawPayload'), false);
});

test('stream upload uses a random storage key and calculates byte size and SHA-256', async t => {
  const rootDir = await tempAssetDir(t);
  const bytes = Buffer.from('streamed-media-bytes');
  const saved = await writeAssetStream(Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]), {
    rootDir,
    maxBytes: 100,
    expectedBytes: bytes.length,
  });
  assert.match(saved.storageKey, /^[a-f0-9]{48}$/);
  assert.equal(saved.byteSize, bytes.length);
  assert.equal(saved.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(saved.absolutePath), bytes);
  assert.equal((await stat(saved.absolutePath)).isFile(), true);
});

test('stream upload enforces the limit and leaves neither final nor temporary files', async t => {
  const rootDir = await tempAssetDir(t);
  await assert.rejects(
    writeAssetStream(Readable.from([Buffer.alloc(4), Buffer.alloc(4)]), { rootDir, maxBytes: 7 }),
    error => error.status === 413,
  );
  assert.deepEqual(await readdir(rootDir), []);
});

test('DB insert failure removes the already-written orphan asset', async t => {
  const rootDir = await tempAssetDir(t);
  await assert.rejects(
    saveAssetWithRecord({ readable: Readable.from(['bytes']), rootDir, maxBytes: 100 }, async () => {
      throw new Error('simulated database failure');
    }),
    /simulated database failure/,
  );
  assert.deepEqual(await readdir(rootDir), []);
});

test('asset path resolution rejects traversal and non-random storage names', () => {
  const root = resolve(tmpdir(), 'ideahub-samples-test-root');
  assert.throws(() => resolveAssetPath(root, '../outside'), error => error.status === 400);
  assert.throws(() => resolveAssetPath(root, 'original-video.mp4'), error => error.status === 400);
  const key = 'a'.repeat(48);
  assert.equal(resolveAssetPath(root, key), resolve(root, key));
  assert.throws(() => resolveAssetPath(process.cwd(), key), error => error.status === 500);
});

test('single byte ranges support closed, open and suffix forms', () => {
  assert.deepEqual(parseByteRange('bytes=2-5', 10), {
    status: 206, start: 2, end: 5, length: 4, contentRange: 'bytes 2-5/10',
  });
  assert.equal(parseByteRange('bytes=7-', 10).length, 3);
  assert.deepEqual(parseByteRange('bytes=-4', 10), {
    status: 206, start: 6, end: 9, length: 4, contentRange: 'bytes 6-9/10',
  });
  assert.throws(() => parseByteRange('bytes=20-30', 10), RangeNotSatisfiableError);
  assert.throws(() => parseByteRange('bytes=0-1,4-5', 10), RangeNotSatisfiableError);
});

test('completeness reports a bounded score, archive state and explicit missing fields', () => {
  const partial = sampleCompleteness({ canonicalKey: 'manual:1', title: '只有标题' });
  assert.equal(partial.score, 25);
  assert.equal(partial.archiveStatus, 'partial');
  assert.ok(partial.missingFields.includes('media'));
  const complete = sampleCompleteness({
    canonicalKey: 'x:id:1', title: '标题', bodyText: '正文', accountName: '账号',
    publishedAt: new Date().toISOString(), metrics: { likes: 1 }, hasCover: true, hasMedia: true,
  });
  assert.deepEqual(complete, { score: 100, missingFields: [], archiveStatus: 'complete' });
  const emptyMetrics = sampleCompleteness({ canonicalKey:'manual:2', metrics:{ likes:'', comments:null } });
  assert.ok(emptyMetrics.missingFields.includes('metrics'));
});

test('database-shaped rows retain source identity when completeness is refreshed', () => {
  const complete = sampleCompleteness({
    canonical_key: 'xiaohongshu:id:abc', title: '标题', body_text: '正文', account_name: '账号',
    published_at: new Date().toISOString(), metrics: { likes: 1 }, has_cover: true, has_media: true,
  });
  assert.equal(complete.score, 100);
  assert.equal(complete.archiveStatus, 'complete');
});

test('collector payload maps original identity, text, metrics and append-only capture key', () => {
  const input = collectorPayloadToSampleInput({
    schema_version: 17,
    task_id: 'task-123',
    collected_at: '2026-08-29T12:00:00+08:00',
    source_url: 'https://www.xiaohongshu.com/explore/abc',
    platform: 'xiaohongshu',
    platform_content_id: 'abc',
    post_title: '原始标题',
    post_description: '原始正文',
    page_text: '图片中的完整正文',
    published_at: '2026-08-28T10:00:00+08:00',
    account: { name: '作者', user_id: 'user-1' },
    engagement: { likes: '100', collects: '20', comments: '3' },
    media_type: 'image_post',
    images: [{ filename: '01.webp' }],
  });
  assert.equal(input.ingestMethod, 'collector');
  assert.equal(input.platformContentId, 'abc');
  assert.equal(input.title, '原始标题');
  assert.equal(input.bodyText, '原始正文\n\n图片中的完整正文');
  assert.deepEqual(input.metrics, { likes: '100', collects: '20', comments: '3' });
  assert.equal(input.captureKey, 'collector:task-123:2026-08-29T12:00:00+08:00');
  assert.equal(input.hasCover, true);
  assert.equal(input.hasMedia, true);
  assert.equal(input.rawPayload.task_id, 'task-123');
});

test('media MIME allowlist blocks active same-origin documents and SVG uploads', () => {
  assert.equal(safeMimeForKind('image', 'image/webp'), 'image/webp');
  assert.equal(safeMimeForKind('video', 'video/mp4'), 'video/mp4');
  assert.throws(() => safeMimeForKind('image', 'image/svg+xml'), error => error.status === 400);
  assert.throws(() => safeMimeForKind('other', 'text/html'), error => error.status === 400);
});

test('legacy work analyses converge on one sample while preserving separate captures', async () => {
  const client = new FakeArchiveClient();
  const shared = {
    platform:'xiaohongshu', title:'旧对标作品', url:'https://www.xiaohongshu.com/explore/legacy-1',
    source_url:null, published_at:'2026-08-20', metrics:{ likes:100 }, account_handle:'旧账号',
    payload:{ task_id:'old-task', platform:'xiaohongshu', platform_content_id:'legacy-1',
      source_url:'https://www.xiaohongshu.com/explore/legacy-1', title:'旧对标作品' },
    digest:{ imageFiles:[] }, cover_file:null,
  };
  const first = legacyInput({ ...shared, work_id:10, received_at:'2026-08-28T10:00:00Z' });
  const second = legacyInput({ ...shared, work_id:11, received_at:'2026-08-29T10:00:00Z' });
  const one = await upsertSampleWithCapture(client, first, null);
  const two = await upsertSampleWithCapture(client, second, null);
  assert.equal(one.sample.id, two.sample.id);
  assert.equal(client.samples.size, 1);
  assert.equal(client.captures.length, 2);
  assert.notEqual(first.captureKey, second.captureKey);
  assert.equal(first.ingestMethod, 'legacy');
});
