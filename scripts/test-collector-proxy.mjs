/**
 * Collector 代理的独立集成测试。
 * 不需要 PostgreSQL、Chromium 或真实平台：本地假 Collector 用来验证权限和代理边界。
 */
import http from 'node:http';
import { createRouter } from '../server/src/router.mjs';
import { mount } from '../server/src/routes/collector.mjs';
import { HttpError, sendError } from '../server/src/lib/http.mjs';

let passed = 0, failed = 0;
const check = (condition, name, detail) => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` → ${JSON.stringify(detail)}` : ''}`); }
};

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const TOKEN = 'collector-proxy-test-token-at-least-32-bytes';
let delayCreate = false;
let lastUpstreamHeaders = {};
let lastUpstreamBody = {};
let resultHits = 0;

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://collector.test');
  lastUpstreamHeaders = req.headers;
  const json = (status, body) => {
    const bytes = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length });
    res.end(bytes);
  };
  if (url.pathname !== '/health' && req.headers['x-collector-token'] !== TOKEN) {
    return json(401, { error: 'token rejected', token: req.headers['x-collector-token'] });
  }
  if (url.pathname === '/health') return json(200, { ok: true, internal_path: '/private/app' });
  if (url.pathname === '/api/login/xiaohongshu/status') {
    return json(200, { status: 'waiting_scan', qr_available: true, cookie: 'must-not-leak' });
  }
  if (url.pathname === '/api/login/xiaohongshu/label' && req.method === 'POST') {
    lastUpstreamBody = await readBody(req);
    return json(200, { saved: true, account_label: lastUpstreamBody.label, identity_verified: false });
  }
  if (url.pathname === '/api/login/xiaohongshu/logout' && req.method === 'POST') {
    return json(200, { saved: false, status: 'idle' });
  }
  if (url.pathname === '/api/login/xiaohongshu/qr') {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    return res.end(png);
  }
  if (url.pathname === '/api/convert') {
    const body = await readBody(req);
    lastUpstreamBody = body;
    if (delayCreate) await new Promise(resolve => setTimeout(resolve, 1_200));
    return json(200, { task_id: 'own-task', status: 'pending', owner_id: req.headers['x-ideahub-user-id'], url: body.url });
  }
  if (url.pathname === '/api/history') {
    return json(200, [
      { id: 'own-task', owner_id: '11', status: 'done' },
      { id: 'other-task', owner_id: '22', status: 'done' },
      { id: 'legacy-no-owner', status: 'done' },
    ]);
  }
  const statusMatch = /^\/api\/status\/([^/]+)$/.exec(url.pathname);
  if (statusMatch) {
    if (statusMatch[1] === 'own-task') return json(200, { status: 'done', owner_id: '11' });
    if (['sensitive-error', 'long-error'].includes(statusMatch[1])) return json(200, { status: 'done', owner_id: '11' });
    if (statusMatch[1] === 'other-task') return json(200, { status: 'done', owner_id: '22' });
    return json(200, { status: 'unknown' });
  }
  const resultMatch = /^\/api\/result\/([^/]+)$/.exec(url.pathname);
  if (resultMatch) {
    resultHits++;
    if (resultMatch[1] === 'sensitive-error') {
      return json(400, {
        error: 'request failed Authorization: Bearer bearer-value api_key=sk-api-value Cookie: session=private-cookie',
      });
    }
    if (resultMatch[1] === 'long-error') {
      return json(400, { error: `Traceback (most recent call last): Error: ${'private-stack-line '.repeat(40)}` });
    }
    return json(200, {
      task_id: resultMatch[1], owner_id: '11', title: '安全结果',
      api_key: 'must-not-leak', storage_state: { cookies: ['must-not-leak'] },
      transcript: '\u6b63\u6587'.repeat(400),
      diagnostics: {
        bearer_text: 'Authorization: Bearer nested-bearer-secret',
        values: [
          'api_key=sk-nested-secret',
          'Cookie: sessionid=cookie-secret; csrftoken=csrf-secret',
          'fetch https://example.test/content?id=private-query&api_key=query-secret#private-fragment',
          String.raw`C:\Users\alice\project\private.py`,
          '/home/alice/project/private.py',
        ],
      },
    });
  }
  const archiveMatch = /^\/api\/ideahub\/archive-sample\/([^/]+)$/.exec(url.pathname);
  if (archiveMatch && req.method === 'POST') {
    lastUpstreamBody = await readBody(req);
    return json(200, { ok: true, status: 'done', sample_id: 91, capture_id: 92 });
  }
  const deleteMatch = /^\/api\/task\/([^/]+)$/.exec(url.pathname);
  if (deleteMatch && req.method === 'DELETE') return json(200, { deleted: true, task_id: deleteMatch[1] });
  return json(404, { error: 'upstream route missing', local_path: '/app/private' });
});

const upstreamBase = await listen(upstream);
const router = createRouter();
mount(router, {
  env: {
    COLLECTOR_URL: upstreamBase,
    COLLECTOR_INTERNAL_TOKEN: TOKEN,
    COLLECTOR_PROXY_TIMEOUT_MS: '1000',
  },
  getUser: async req => {
    const id = req.headers['x-test-user'];
    if (!id) throw new HttpError(401, '请先登录');
    return { id, role: req.headers['x-test-role'] || 'member', name: `用户${id}` };
  },
  timeouts: { createTask: 50 },
});

const proxy = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://proxy.test');
  try {
    const hit = router.match(req.method, url.pathname);
    if (hit?.handler) return await hit.handler(req, res, hit.params, url);
    if (hit?.methodNotAllowed) throw new HttpError(405, '方法不允许');
    throw new HttpError(404, '没有这个接口');
  } catch (error) {
    sendError(res, error);
  }
});
const proxyBase = await listen(proxy);

async function call(method, path, { user = '11', role = 'member', body } = {}) {
  const response = await fetch(proxyBase + path, {
    method,
    headers: {
      ...(user ? { 'x-test-user': user, 'x-test-role': role } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data, headers: response.headers };
}

try {
  console.log('\nCollector 代理权限与边界');
  let response = await call('GET', '/api/collector/health', { user: null });
  check(response.status === 401, '未登录访问代理返回 401', response);

  response = await call('GET', '/api/collector/login/xiaohongshu/status');
  check(response.status === 403, '普通成员不能访问平台登录状态（403）', response);

  response = await call('GET', '/api/collector/login/xiaohongshu/status', { role: 'admin' });
  check(response.status === 200 && response.data.status === 'waiting_scan', '管理员可以访问平台登录状态', response);
  check(!('cookie' in response.data), '平台登录响应会清除 Cookie 字段', response.data);

  response = await call('GET', '/api/collector/login/xiaohongshu/qr', { role: 'admin' });
  check(response.status === 200 && response.headers.get('content-type') === 'image/png', '二维码按 image/png 安全转发', response.status);
  check(response.headers.get('cache-control') === 'no-store' && response.headers.get('x-content-type-options') === 'nosniff', '二维码禁止缓存与 MIME 嗅探');

  response = await call('POST', '/api/collector/login/xiaohongshu/label', { body: { label: '专用采集号' } });
  check(response.status === 403, '普通成员不能修改采集账号备注', response);
  response = await call('POST', '/api/collector/login/xiaohongshu/label', { role: 'admin', body: { label: '专用采集号' } });
  check(response.status === 200 && lastUpstreamBody.label === '专用采集号', '管理员可以保存采集账号备注', response);
  response = await call('POST', '/api/collector/login/xiaohongshu/logout');
  check(response.status === 403, '普通成员不能退出采集账号', response);
  response = await call('POST', '/api/collector/login/xiaohongshu/logout', { role: 'admin', body: {} });
  check(response.status === 200 && response.data.saved === false, '管理员可以退出采集账号', response);

  response = await call('POST', '/api/collector/tasks', { body: { url: 'https://www.xiaohongshu.com/explore/test', session_mode: 'public' } });
  check(response.status === 200 && response.data.owner_id === '11', '创建任务注入当前用户身份', response.data);
  check(lastUpstreamBody.session_mode === 'public', '公开无登录模式会原样传给 Collector', lastUpstreamBody);
  check(lastUpstreamHeaders['x-collector-token'] === TOKEN, '内部请求由 Node 注入 Collector 令牌');
  check(lastUpstreamHeaders['x-ideahub-user-role'] === 'member', '内部请求由 Node 注入角色');
  check(!JSON.stringify(response.data).includes(TOKEN), '浏览器响应不含内部令牌');

  response = await call('POST', '/api/collector/tasks', { body: {
    url: 'https://www.xiaohongshu.com/explore/archive-test', session_mode: 'public', auto_archive: true,
  } });
  check(response.status === 200 && lastUpstreamBody.auto_archive === true,
    'auto_archive 会传给 Collector', { response:response.data, upstream:lastUpstreamBody });

  response = await call('POST', '/api/collector/tasks/own-task/archive', { body: {} });
  check(response.status === 200 && response.data.sample_id === 91,
    '任务所有者可通过固定代理路由重试样本归档', response);
  response = await call('POST', '/api/collector/tasks/other-task/archive', { body: {} });
  check(response.status === 403, '普通成员不能归档别人的采集任务', response);

  response = await call('GET', '/api/collector/tasks');
  check(response.status === 200 && response.data.length === 1 && response.data[0].id === 'own-task', '普通成员历史列表只保留自己的任务', response.data);

  resultHits = 0;
  response = await call('GET', '/api/collector/tasks/other-task/result');
  check(response.status === 403, '普通成员越权读取别人的结果返回 403', response);
  check(resultHits === 0, 'IDOR 在读取结果前已被代理阻断');

  response = await call('GET', '/api/collector/tasks/own-task/result');
  check(response.status === 200 && response.data.title === '安全结果', '普通成员可以读取自己的任务结果', response);
  check(!('api_key' in response.data) && !('storage_state' in response.data), '结果响应清除密钥和登录态字段', response.data);

  const resultText = JSON.stringify(response.data);
  check(
    !['nested-bearer-secret', 'sk-nested-secret', 'cookie-secret', 'csrf-secret'].some(secret => resultText.includes(secret)),
    '\u5d4c\u5957\u5b57\u7b26\u4e32\u4e2d\u7684 Bearer\u3001API key \u548c Cookie \u4f1a\u9012\u5f52\u8131\u654f',
    response.data.diagnostics,
  );
  check(
    !resultText.includes('private-query') && !resultText.includes('query-secret') && !resultText.includes('private-fragment'),
    'URL \u67e5\u8be2\u548c fragment \u4e0d\u4f1a\u8fd4\u56de\u6d4f\u89c8\u5668',
    response.data.diagnostics,
  );
  check(
    !resultText.includes('C:\\\\Users\\\\alice') && !resultText.includes('/home/alice'),
    'Windows \u548c Linux \u7edd\u5bf9\u8def\u5f84\u4f1a\u9012\u5f52\u8131\u654f',
    response.data.diagnostics,
  );
  check(response.data.transcript === '\u6b63\u6587'.repeat(400), '\u6b63\u5e38\u957f\u6b63\u6587\u4e0d\u4f1a\u88ab\u8bef\u5224\u4e3a\u957f\u5f02\u5e38');

  response = await call('GET', '/api/collector/tasks/sensitive-error/result');
  const sensitiveErrorText = JSON.stringify(response.data);
  check(
    response.status === 400 && !['bearer-value', 'sk-api-value', 'private-cookie'].some(secret => sensitiveErrorText.includes(secret)),
    '\u4e0a\u6e38\u9519\u8bef\u5b57\u7b26\u4e32\u4e2d\u7684\u51ed\u636e\u4e0d\u4f1a\u6cc4\u9732',
    response,
  );

  response = await call('GET', '/api/collector/tasks/long-error/result');
  check(
    response.status === 400 && !JSON.stringify(response.data).includes('private-stack-line'),
    '\u8fc7\u957f\u5f02\u5e38\u4f1a\u6536\u53e3\u4e3a\u5b89\u5168\u9519\u8bef',
    response,
  );

  response = await call('DELETE', '/api/collector/tasks/own-task');
  check(response.status === 403, '普通成员不能删除任务（403）', response);
  response = await call('DELETE', '/api/collector/tasks/other-task', { role: 'admin' });
  check(response.status === 200 && response.data.deleted === true, '管理员可以删除任务', response);

  response = await call('GET', '/api/collector/http%3A%2F%2Fevil.example');
  check(response.status === 404, '不存在开放式上游路径代理（404）', response);
  response = await call('PUT', '/api/collector/tasks/own-task/status');
  check(response.status === 405, '固定路径上的错误方法返回 405', response);

  response = await call('POST', '/api/collector/tasks', { body: { url: 'x'.repeat(9 * 1024) } });
  check(response.status === 400 && /请求体太大/.test(response.data.error), '任务请求体超过 8KB 被拒绝', response);

  delayCreate = true;
  response = await call('POST', '/api/collector/tasks', { body: { url: 'https://www.douyin.com/video/test' } });
  check(response.status === 504 && /超时/.test(response.data.error), '上游超时返回清洗后的 504', response);
  delayCreate = false;
} finally {
  await close(proxy);
  await close(upstream);
}

console.log(`\nCollector 代理测试：${passed} 通过，${failed} 失败\n`);
if (failed) process.exitCode = 1;
