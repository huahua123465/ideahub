/**
 * dataClean Collector 的固定路径代理。
 *
 * 浏览器永远只访问这里：内部地址和 X-Collector-Token 都只存在于 Node 进程中。
 * 这里不提供“传入任意上游路径”的通用代理，所有方法和路径都在 mount() 中逐条列出。
 */
import { currentUser } from '../lib/auth.mjs';
import { HttpError, badRequest, forbidden, notFound, readJson, sendJson } from '../lib/http.mjs';

const DEFAULT_BASE_URL = 'http://collector:5000';
const DEFAULT_TIMEOUT_MS = 12_000;
const RESULT_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 20_000;
const MAX_JSON_RESPONSE = 12 * 1024 * 1024;
const MAX_QR_BYTES = 2 * 1024 * 1024;
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_FILE_RE = /^(?!\.)(?!.*\.\.)(?!.*[/\\])[\p{L}\p{N}_.()\- ]{1,255}$/u;
const SECRET_KEY_RE = /(?:authorization|api[_-]?key|token|secret|cookie|storage[_-]?state|password)/i;
const INTERNAL_KEY_RE = /(?:traceback|stack|local[_-]?path|file[_-]?path|working[_-]?dir)/i;
const ERROR_KEY_RE = /(?:error|exception|traceback|stack|reason|detail|message)/i;
const EXCEPTION_TEXT_RE = /(?:Traceback \(most recent call last\)|\b(?:Error|Exception):|^\s*at\s+\S+\s*\(|\bFile ["'][^"']+["'], line \d+)/im;
const LONG_EXCEPTION_PLACEHOLDER = '[\u5df2\u9690\u85cf\u8fc7\u957f\u5f02\u5e38\u4fe1\u606f]';

function collectorConfig(env = process.env) {
  let baseUrl;
  try {
    baseUrl = new URL(env.COLLECTOR_URL || DEFAULT_BASE_URL);
  } catch {
    baseUrl = new URL(DEFAULT_BASE_URL);
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) baseUrl = new URL(DEFAULT_BASE_URL);
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
  return {
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    token: String(env.COLLECTOR_INTERNAL_TOKEN || ''),
    timeoutMs: positiveInt(env.COLLECTOR_PROXY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 120_000),
  };
}

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function requireConfigured(config) {
  if (Buffer.byteLength(config.token, 'utf8') < 32) {
    throw new HttpError(503, '内容采集服务尚未配置，请联系管理员');
  }
}

function safeTaskId(value) {
  const id = String(value || '');
  if (!TASK_ID_RE.test(id)) throw badRequest('任务编号格式不正确');
  return id;
}

function safeFilename(value) {
  const name = String(value || '');
  if (!SAFE_FILE_RE.test(name)) throw badRequest('文件名格式不正确');
  return name;
}

/**
 * Clean secrets, absolute paths and URL queries that upstream code placed in ordinary strings.
 * URLs are protected with placeholders before POSIX path matching so their pathnames survive.
 */
function sanitizeString(value, key = '') {
  const original = String(value);
  if (original.length > 300 && (ERROR_KEY_RE.test(key) || EXCEPTION_TEXT_RE.test(original))) {
    return LONG_EXCEPTION_PLACEHOLDER;
  }

  const safeUrls = [];
  let text = original.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, rawValue => {
    let raw = rawValue;
    let suffix = '';
    while (/[),.;!?]$/.test(raw)) {
      suffix = raw.slice(-1) + suffix;
      raw = raw.slice(0, -1);
    }
    try {
      const url = new URL(raw);
      url.username = '';
      url.password = '';
      if (url.search) url.search = '?[REDACTED]';
      if (url.hash) url.hash = '#[REDACTED]';
      safeUrls.push(url.toString() + suffix);
    } catch {
      safeUrls.push(raw.replace(/[?#].*$/, '?[REDACTED]') + suffix);
    }
    return `__COLLECTOR_SAFE_URL_${safeUrls.length - 1}__`;
  });

  text = text
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bAuthorization\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, 'Authorization=[REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bAPI\s+key\s+(?:is\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, 'API key [REDACTED]')
    .replace(/\b(?:set-cookie|cookie)\b["']?\s*[:=]\s*[^\r\n]+/gi, 'Cookie=[REDACTED]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>|]*/g, '[REDACTED_PATH]')
    .replace(/(["'])(\/(?!\/)[^"'\r\n<>]+)\1/g, '$1[REDACTED_PATH]$1')
    .replace(/(^|[\s(=:\[])\/(?!\/)(?:[^\s"'`,;)\]<>]+\/)*[^\s"'`,;)\]<>]*/g, '$1[REDACTED_PATH]');

  return text.replace(/__COLLECTOR_SAFE_URL_(\d+)__/g, (_match, index) => safeUrls[Number(index)] || '[REDACTED_URL]');
}

function safeJson(value, depth = 0, key = '') {
  if (depth > 16) return null;
  if (typeof value === 'string') return sanitizeString(value, key);
  if (Array.isArray(value)) return value.map(item => safeJson(item, depth + 1, key));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key) || INTERNAL_KEY_RE.test(key)) continue;
    out[key] = safeJson(item, depth + 1, key);
  }
  return out;
}

function safeErrorMessage(payload, fallback) {
  const candidate = payload && typeof payload === 'object'
    ? (payload.error || payload.message)
    : null;
  if (typeof candidate !== 'string' || !candidate.trim()) return fallback;
  // 不把上游异常中的绝对路径、密钥片段或超长堆栈带回浏览器。
  const text = sanitizeString(candidate, 'error').replace(/[\r\n\t]+/g, ' ').trim();
  if (text === LONG_EXCEPTION_PLACEHOLDER || text.length > 300) return fallback;
  return text;
}

async function parseUpstreamJson(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_JSON_RESPONSE) throw new HttpError(502, '内容采集服务返回的数据过大');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_JSON_RESPONSE) throw new HttpError(502, '内容采集服务返回的数据过大');
  if (!bytes.length) return {};
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpError(502, '内容采集服务返回了无法识别的数据');
  }
}

function upstreamStatus(response, payload) {
  if (response.ok) return;
  if (response.status === 401) {
    throw new HttpError(503, '内容采集服务鉴权失败，请联系管理员');
  }
  if (response.status === 403) {
    throw forbidden(safeErrorMessage(payload, '你无权操作这条采集任务'));
  }
  if (response.status >= 400 && response.status < 500) {
    throw new HttpError(response.status, safeErrorMessage(payload, '内容采集请求未被接受'));
  }
  throw new HttpError(502, '内容采集服务暂时不可用，请稍后重试');
}

async function upstreamFetch(path, {
  method = 'GET', body, user, config, fetchImpl, timeoutMs, headers: extraHeaders,
} = {}) {
  requireConfigured(config);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs || config.timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'x-collector-token': config.token,
        'x-ideahub-user-id': String(user.id),
        'x-ideahub-user-role': String(user.role || 'member'),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(extraHeaders || {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (timedOut || error?.name === 'AbortError') {
      throw new HttpError(504, '内容采集服务响应超时，请稍后重试');
    }
    throw new HttpError(503, '暂时无法连接内容采集服务');
  } finally {
    clearTimeout(timer);
  }
}

async function jsonCall(path, options) {
  const response = await upstreamFetch(path, options);
  const payload = await parseUpstreamJson(response);
  upstreamStatus(response, payload);
  return safeJson(payload);
}

function assertTaskOwner(user, task) {
  if (user.role === 'admin') return;
  const ownerId = task?.owner_id ?? task?.ownerId;
  if (ownerId === undefined || ownerId === null || String(ownerId) !== String(user.id)) {
    throw forbidden('你只能查看和操作自己创建的采集任务');
  }
}

async function requireTaskOwner(id, context) {
  const task = await jsonCall(`/api/status/${encodeURIComponent(id)}`, context);
  if (task.status === 'unknown') throw notFound('找不到这条采集任务');
  assertTaskOwner(context.user, task);
  return task;
}

async function pipeBinary(response, res, {
  allowedTypes, maxBytes = Infinity, cache = false, download = false,
} = {}) {
  let contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!allowedTypes.has(contentType)) throw new HttpError(502, '内容采集服务返回了不安全的文件类型');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw new HttpError(502, '内容采集服务返回的文件过大');

  const headers = {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'cache-control': cache ? 'private, max-age=300' : 'no-store',
  };
  if (!cache) headers.pragma = 'no-cache';
  if (length > 0) headers['content-length'] = length;
  if (download) headers['content-disposition'] = 'attachment';
  const acceptRanges = response.headers.get('accept-ranges');
  const contentRange = response.headers.get('content-range');
  if (acceptRanges === 'bytes') headers['accept-ranges'] = 'bytes';
  if (contentRange) headers['content-range'] = contentRange;
  res.writeHead(response.status, headers);

  let received = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        res.destroy();
        return;
      }
      res.write(Buffer.from(chunk));
    }
  }
  res.end();
}

/** 可注入依赖，供独立代理测试在没有 PostgreSQL 时运行。 */
export function createCollectorHandlers({
  getUser = currentUser,
  fetchImpl = globalThis.fetch,
  env = process.env,
  timeouts = {},
} = {}) {
  const config = collectorConfig(env);
  const context = async req => ({ user: await getUser(req), config, fetchImpl });
  const json = handler => async (req, res, params, url) => {
    const value = await handler(req, params || {}, url, await context(req));
    sendJson(res, 200, value);
  };
  const admin = handler => json(async (req, params, url, ctx) => {
    if (ctx.user.role !== 'admin') throw forbidden('只有管理员可以管理平台登录或删除采集记录');
    return handler(req, params, url, ctx);
  });

  return {
    health: json(async (_req, _params, _url, ctx) => {
      try {
        const upstream = await jsonCall('/health', { ...ctx, timeoutMs: 3_000 });
        return { ok: upstream.ok === true, collector: upstream.ok === true ? 'up' : 'degraded' };
      } catch (error) {
        return { ok: false, collector: 'down', error: error.message };
      }
    }),

    loginStart: admin(async (req, _params, _url, ctx) =>
      jsonCall('/api/login/xiaohongshu', { ...ctx, method: 'POST', body: await readJson(req, 2 * 1024) })),
    loginStatus: admin(async (_req, _params, _url, ctx) =>
      jsonCall('/api/login/xiaohongshu/status', ctx)),
    loginAccount: admin(async (req, _params, _url, ctx) =>
      jsonCall('/api/login/xiaohongshu/account', { ...ctx, method: 'POST', body: await readJson(req, 2 * 1024) })),
    loginQr: async (req, res) => {
      const ctx = await context(req);
      if (ctx.user.role !== 'admin') throw forbidden('只有管理员可以查看平台登录二维码');
      const upstream = await upstreamFetch('/api/login/xiaohongshu/qr', { ...ctx, timeoutMs: 8_000 });
      if (!upstream.ok) {
        const payload = await parseUpstreamJson(upstream);
        upstreamStatus(upstream, payload);
      }
      await pipeBinary(upstream, res, { allowedTypes: new Set(['image/png']), maxBytes: MAX_QR_BYTES });
    },

    createTask: json(async (req, _params, _url, ctx) =>
      jsonCall('/api/convert', {
        ...ctx, method: 'POST', body: await readJson(req, 8 * 1024), timeoutMs: timeouts.createTask || 15_000,
      })),
    listTasks: json(async (_req, _params, _url, ctx) => {
      const payload = await jsonCall('/api/history', ctx);
      const items = Array.isArray(payload) ? payload : (payload.items || []);
      const visible = ctx.user.role === 'admin'
        ? items
        : items.filter(item => String(item.owner_id ?? item.ownerId ?? '') === String(ctx.user.id));
      return Array.isArray(payload) ? visible : { ...payload, items: visible };
    }),
    taskStatus: json(async (_req, { id }, _url, ctx) => {
      const taskId = safeTaskId(id);
      const task = await jsonCall(`/api/status/${encodeURIComponent(taskId)}`, ctx);
      if (task.status === 'unknown') throw notFound('找不到这条采集任务');
      assertTaskOwner(ctx.user, task);
      return task;
    }),
    refreshTask: json(async (req, { id }, _url, ctx) => {
      const taskId = safeTaskId(id);
      await requireTaskOwner(taskId, ctx);
      return jsonCall(`/api/task/${encodeURIComponent(taskId)}/refresh`, {
        ...ctx, method: 'POST', body: await readJson(req, 2 * 1024), timeoutMs: 15_000,
      });
    }),
    taskResult: json(async (_req, { id }, _url, ctx) => {
      const taskId = safeTaskId(id);
      await requireTaskOwner(taskId, ctx);
      return jsonCall(`/api/result/${encodeURIComponent(taskId)}`, { ...ctx, timeoutMs: RESULT_TIMEOUT_MS });
    }),
    updateAnalysis: json(async (req, { id }, _url, ctx) => {
      const taskId = safeTaskId(id);
      await requireTaskOwner(taskId, ctx);
      return jsonCall(`/api/result/${encodeURIComponent(taskId)}/ai-analysis`, {
        ...ctx, method: 'PATCH', body: await readJson(req, 256 * 1024), timeoutMs: RESULT_TIMEOUT_MS,
      });
    }),
    image: async (req, res, { id, filename }, url) => {
      const ctx = await context(req);
      const taskId = safeTaskId(id), file = safeFilename(filename);
      await requireTaskOwner(taskId, ctx);
      const download = url.searchParams.get('download') === '1';
      const upstream = await upstreamFetch(
        `/api/image/${encodeURIComponent(taskId)}/${encodeURIComponent(file)}${download ? '?download=1' : ''}`,
        { ...ctx, timeoutMs: MEDIA_TIMEOUT_MS },
      );
      if (!upstream.ok) upstreamStatus(upstream, await parseUpstreamJson(upstream));
      await pipeBinary(upstream, res, {
        allowedTypes: new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), cache: true, download,
      });
    },
    media: async (req, res, { id, filename }, url) => {
      const ctx = await context(req);
      const taskId = safeTaskId(id), file = safeFilename(filename);
      await requireTaskOwner(taskId, ctx);
      const download = url.searchParams.get('download') === '1';
      const range = typeof req.headers.range === 'string' ? { range: req.headers.range } : undefined;
      const upstream = await upstreamFetch(
        `/api/media/${encodeURIComponent(taskId)}/${encodeURIComponent(file)}${download ? '?download=1' : ''}`,
        { ...ctx, timeoutMs: MEDIA_TIMEOUT_MS, headers: range },
      );
      if (!upstream.ok && upstream.status !== 206) upstreamStatus(upstream, await parseUpstreamJson(upstream));
      await pipeBinary(upstream, res, {
        allowedTypes: new Set(['video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/mp4', 'audio/wav']),
        cache: true, download,
      });
    },
    exportResult: async (req, res, { id, format }) => {
      const ctx = await context(req);
      const taskId = safeTaskId(id);
      if (!['json', 'md', 'txt'].includes(format)) throw badRequest('不支持这种导出格式');
      await requireTaskOwner(taskId, ctx);
      const upstream = await upstreamFetch(`/api/export/${encodeURIComponent(taskId)}/${format}`, {
        ...ctx, timeoutMs: RESULT_TIMEOUT_MS,
      });
      if (!upstream.ok) upstreamStatus(upstream, await parseUpstreamJson(upstream));
      await pipeBinary(upstream, res, {
        allowedTypes: new Set(['application/json', 'text/markdown', 'text/plain']), download: true,
      });
    },
    pushTask: json(async (req, { id }, _url, ctx) => {
      const taskId = safeTaskId(id);
      await requireTaskOwner(taskId, ctx);
      return jsonCall(`/api/ideahub/push/${encodeURIComponent(taskId)}`, {
        ...ctx, method: 'POST', body: await readJson(req, 4 * 1024), timeoutMs: RESULT_TIMEOUT_MS,
      });
    }),
    pushBatch: json(async (req, _params, _url, ctx) => {
      const body = await readJson(req, 32 * 1024);
      const ids = Array.isArray(body.task_ids) ? [...new Set(body.task_ids.map(safeTaskId))] : [];
      if (!ids.length || ids.length > 50) throw badRequest('请选择 1 到 50 条采集任务');
      for (const id of ids) await requireTaskOwner(id, ctx);
      return jsonCall('/api/ideahub/push-batch', { ...ctx, method: 'POST', body, timeoutMs: 60_000 });
    }),
    deleteTask: admin(async (_req, { id }, _url, ctx) => {
      const taskId = safeTaskId(id);
      return jsonCall(`/api/task/${encodeURIComponent(taskId)}`, { ...ctx, method: 'DELETE', timeoutMs: 20_000 });
    }),
    deleteBatch: admin(async (req, _params, _url, ctx) =>
      jsonCall('/api/tasks/batch-delete', {
        ...ctx, method: 'POST', body: await readJson(req, 32 * 1024), timeoutMs: 30_000,
      })),
  };
}

export function mount(router, options) {
  const h = createCollectorHandlers(options);
  router.get('/api/collector/health', h.health);
  router.post('/api/collector/login/xiaohongshu', h.loginStart);
  router.get('/api/collector/login/xiaohongshu/status', h.loginStatus);
  router.get('/api/collector/login/xiaohongshu/qr', h.loginQr);
  router.post('/api/collector/login/xiaohongshu/account', h.loginAccount);
  router.post('/api/collector/tasks', h.createTask);
  router.get('/api/collector/tasks', h.listTasks);
  router.post('/api/collector/tasks/batch-push', h.pushBatch);
  router.post('/api/collector/tasks/batch-delete', h.deleteBatch);
  router.get('/api/collector/tasks/:id/status', h.taskStatus);
  router.post('/api/collector/tasks/:id/refresh', h.refreshTask);
  router.get('/api/collector/tasks/:id/result', h.taskResult);
  router.patch('/api/collector/tasks/:id/analysis', h.updateAnalysis);
  router.get('/api/collector/tasks/:id/images/:filename', h.image);
  router.get('/api/collector/tasks/:id/media/:filename', h.media);
  router.get('/api/collector/tasks/:id/export/:format', h.exportResult);
  router.post('/api/collector/tasks/:id/push', h.pushTask);
  router.del('/api/collector/tasks/:id', h.deleteTask);
}
