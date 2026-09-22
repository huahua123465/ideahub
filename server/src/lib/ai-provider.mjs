/**
 * 智能导入的 AI 供应商配置。
 *
 * 管理员可以在页面里填写兼容 OpenAI 的 Base URL / API Key / 模型。API Key
 * 使用 AES-256-GCM 加密后写入 IdeaHub 自己的持久卷，任何读取接口都不会返回明文。
 */
import {
  createCipheriv, createDecipheriv, createHash, randomBytes,
} from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { badRequest, HttpError } from './http.mjs';

const CONFIG_FILE = process.env.AI_PROVIDER_CONFIG_FILE || '/var/lib/ideahub-ai/provider.json';
// 聊天里的 AI 助手可以单独接一个平台；没单独配置时沿用上面那份。
// 放在同一个持久卷里，重建容器不会丢。
const CHAT_CONFIG_FILE = process.env.AI_CHAT_CONFIG_FILE
  || join(dirname(CONFIG_FILE), 'chat-provider.json');
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5-mini';

const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const cleanKey = value => String(value ?? '')
  // 某些网页复制会夹带零宽字符；它们肉眼不可见，却会让 Bearer Token 校验失败。
  .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
  .trim()
  .slice(0, 1000);

function encryptionKey() {
  // AI_CONFIG_SECRET 可单独轮换；未设置时复用稳定且只存在服务端的数据库连接串。
  const secret = process.env.AI_CONFIG_SECRET || process.env.DATABASE_URL;
  if (!secret) throw new Error('缺少 AI 配置加密密钥');
  return createHash('sha256').update(`ideahub-ai-provider:${secret}`).digest();
}

/** 把用户填写的站点地址规范成实际 OpenAI 兼容 API 根地址。 */
export function normalizeApiBase(value) {
  const raw = clean(value || DEFAULT_BASE_URL, 1000).replace(/\/+$/, '');
  let url;
  try { url = new URL(raw); } catch { throw badRequest('API 地址格式不正确'); }
  if (url.protocol !== 'https:') throw badRequest('API 地址必须使用 HTTPS');
  if (url.username || url.password) throw badRequest('API 地址不能包含账号或密码');
  if (url.search || url.hash) throw badRequest('API 地址不能包含查询参数或锚点');

  let path = url.pathname.replace(/\/+$/, '');
  if (!/\/v\d+(?:beta)?$/i.test(path)) path += '/v1';
  url.pathname = path.replace(/\/{2,}/g, '/');
  return url.toString().replace(/\/$/, '');
}

function normalizeProvider(raw = {}) {
  return {
    baseUrl: normalizeApiBase(raw.baseUrl || DEFAULT_BASE_URL),
    model: clean(raw.model || DEFAULT_MODEL, 160),
    apiKey: cleanKey(raw.apiKey),
  };
}

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function openSealed(payload) {
  if (payload?.version !== 1) throw new Error('不支持的 AI 配置版本');
  const decipher = createDecipheriv(
    'aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return normalizeProvider(JSON.parse(plain));
}

async function storedProvider(file = CONFIG_FILE) {
  try {
    const payload = JSON.parse(await readFile(file, 'utf8'));
    const provider = openSealed(payload);
    if (!provider.apiKey) return null;
    return { ...provider, source: 'saved' };
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('[ai-provider] 已保存的配置无法读取，将使用环境配置：', err.message);
    }
    return null;
  }
}

function environmentProvider() {
  return {
    ...normalizeProvider({
      baseUrl: process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      apiKey: process.env.OPENAI_API_KEY || '',
    }),
    source: 'environment',
  };
}

export async function activeProvider() {
  return await storedProvider() || environmentProvider();
}

export async function saveProvider(raw, file = CONFIG_FILE) {
  const provider = normalizeProvider(raw);
  if (provider.apiKey.length < 8) throw badRequest('请输入完整的 API Key');
  if (!provider.model) throw badRequest('请选择一个模型');

  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(seal(provider)), { mode: 0o600 });
  await rename(temp, file);
  await chmod(file, 0o600);
  return { ...provider, source: 'saved' };
}

export async function clearSavedProvider(file = CONFIG_FILE) {
  try { await unlink(file); } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return environmentProvider();
}

/* ---------- 聊天 AI 助手的独立配置 ---------- */

/** 单独配过就用单独那份（source=chat），否则沿用智能导入的配置（source=shared）。 */
export async function activeChatProvider() {
  const own = await storedProvider(CHAT_CONFIG_FILE);
  if (own) return { ...own, source: 'chat' };
  return { ...await activeProvider(), source: 'shared' };
}

export async function saveChatProvider(raw) {
  const saved = await saveProvider(raw, CHAT_CONFIG_FILE);
  return { ...saved, source: 'chat' };
}

/** 删掉单独配置，回到沿用智能导入那份。 */
export async function clearChatProvider() {
  await clearSavedProvider(CHAT_CONFIG_FILE);
  return activeChatProvider();
}

export function publicProvider(provider, canManage = false) {
  const hasKey = Boolean(provider?.apiKey);
  return {
    configured: hasKey,
    canManage,
    baseUrl: canManage ? provider?.baseUrl || '' : '',
    model: provider?.model || '',
    source: provider?.source || 'environment',
    hasKey,
  };
}

export function providerError(body, status) {
  const message = clean(body?.error?.message || body?.message, 280).replace(/[\r\n]+/g, ' ');
  if (status === 401) return badRequest(
    `模型接口返回 401：${message || 'API Key 未通过验证，请确认复制的是创建时显示的完整密钥'}`);
  if (status === 403) return badRequest(
    `模型接口返回 403：${message || 'API Key 被权限、分组、额度或 IP 白名单拒绝'}`);
  if (status === 429) return new HttpError(429,
    `模型接口返回 429：${message || '请求过于频繁或账户额度不足'}`);
  return new HttpError(502, `模型接口返回 ${status}：${message || '未知错误'}`);
}

/** 从供应商实时拉取该 Key 真正可用的模型。 */
export async function fetchProviderModels(raw) {
  const provider = normalizeProvider(raw);
  if (provider.apiKey.length < 8) throw badRequest('请输入完整的 API Key');
  if (provider.apiKey.includes('*')) throw badRequest('当前填写的是脱敏密钥，请复制创建弹窗里显示的完整 API Key');

  let response;
  try {
    response = await fetch(`${provider.baseUrl}/models`, {
      headers: { authorization: `Bearer ${provider.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new HttpError(504, '连接模型接口超时，请检查 API 地址');
    throw new HttpError(502, '无法连接模型接口，请检查 API 地址和服务器网络');
  }

  let body = null;
  try { body = await response.json(); } catch { /* 供应商可能返回 HTML 错误页 */ }
  if (!response.ok) {
    const host = new URL(provider.baseUrl).host;
    const upstreamMessage = clean(body?.error?.message || body?.message, 280).replace(/[\r\n]+/g, ' ');
    console.warn(`[ai-provider] ${host}/models 返回 ${response.status}${upstreamMessage ? `：${upstreamMessage}` : ''}`);
    throw providerError(body, response.status);
  }

  const rows = Array.isArray(body?.data) ? body.data
    : Array.isArray(body?.models) ? body.models : [];
  const models = [...new Set(rows.map(item => clean(
    typeof item === 'string' ? item : item?.id || item?.name, 160)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .slice(0, 600);
  if (!models.length) throw new HttpError(502, '接口已连接，但没有返回可用模型');
  return { provider, models };
}

export async function resolveProviderInput(raw = {}, current = null) {
  current ||= await activeProvider();
  const baseUrl = normalizeApiBase(raw.baseUrl || current.baseUrl);
  const suppliedKey = cleanKey(raw.apiKey);
  if (!suppliedKey && baseUrl !== current.baseUrl) {
    throw badRequest('更换 API 地址时，请同时输入这个平台的 API Key');
  }
  return normalizeProvider({
    baseUrl,
    model: raw.model || current.model,
    apiKey: suppliedKey || current.apiKey,
  });
}
