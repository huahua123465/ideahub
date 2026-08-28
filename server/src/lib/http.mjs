/** HTTP 小工具集：读请求体、发响应、错误类型 */

/** 业务错误。抛出来会被统一转成对应状态码的 JSON */
export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}
export const badRequest = (m, d) => new HttpError(400, m, d);
export const forbidden  = (m) => new HttpError(403, m || '没有权限做这个操作');
export const notFound   = (m) => new HttpError(404, m || '找不到这条记录');
export const conflict   = (m, d) => new HttpError(409, m, d);

const MAX_BODY = 1024 * 1024; // 1MB，灵感正文用不了这么多

/**
 * 读并解析 JSON 请求体。
 *
 * @param max 单独放宽上限。默认 1MB 对所有表单都绰绰有余，
 *   只有技术1 的采集分析要例外 —— 那份 JSON 现在可以把整张封面
 *   （base64，一张清晰竖图 200~500KB）带进来，1MB 会卡住。
 */
export async function readJson(req, max = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw badRequest('请求体太大了');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('请求体不是合法的 JSON');
  }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, err) {
  const status = err.status || 500;
  const expected = err instanceof HttpError;
  // HttpError 是路由主动映射的可预期失败（例如 Collector 超时 504），不该把
  // 它的本地堆栈和绝对路径打印进生产日志。真正未知的异常也只记类型，详细
  // 诊断应留在受控调试环境，不能让日志成为路径/密钥侧信道。
  if (status >= 500 && !(err instanceof HttpError)) {
    console.error('[api] 未预期的错误:', err?.name || 'Error');
  }
  sendJson(res, status, expected ? {
    error: err.message || '请求处理失败',
    detail: err.detail,
  } : {
    error: '服务器内部错误',
  });
}

/** 取查询参数，带默认值 */
export function q(url, key, dflt = undefined) {
  const v = url.searchParams.get(key);
  return v === null || v === '' ? dflt : v;
}
export function qInt(url, key, dflt) {
  const v = Number(q(url, key));
  return Number.isFinite(v) ? Math.trunc(v) : dflt;
}

/** 必填字段校验 */
export function need(obj, field, { min = 1, max = Infinity, label } = {}) {
  const v = obj[field];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${label || field} 不能为空`);
  const s = v.trim();
  if (s.length < min) throw badRequest(`${label || field} 至少 ${min} 个字`);
  if (s.length > max) throw badRequest(`${label || field} 最多 ${max} 个字`);
  return s;
}
