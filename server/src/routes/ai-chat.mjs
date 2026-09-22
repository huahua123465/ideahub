/**
 * 聊天面板里的「AI 助手」。
 *
 * 对话记录只存在用户自己的浏览器里，服务端不落库：这里每次收到的是前端带来的
 * 最近若干轮上下文，转发给管理员配置的 OpenAI 兼容接口，把回答原样还回去。
 * API Key 只在服务端解密使用，任何接口都不返回明文。
 *
 * 路径特意不放在 /api/chat/ 下面：那里有 /api/chat/:userId，会把 ai 当成用户 id 吃掉。
 */
import { readJson, sendJson, badRequest, HttpError } from '../lib/http.mjs';
import { assertAdmin, currentUser } from '../lib/auth.mjs';
import {
  activeChatProvider, clearChatProvider, fetchProviderModels, providerError,
  publicProvider, resolveProviderInput, saveChatProvider,
} from '../lib/ai-provider.mjs';

const MAX_TURNS = 40;            // 最多带多少条历史
const MAX_CONTENT = 8000;        // 单条消息字数
const MAX_TOTAL = 60000;         // 整段上下文字数
const TIMEOUT_MS = Number(process.env.AI_CHAT_TIMEOUT_MS || 120_000);

const INSTRUCTIONS = [
  '你是公司内部协作平台 IdeaHub 里的 AI 助手，帮同事解答问题、整理思路、起草文字。',
  '默认用简体中文回答，先给结论再展开，条理清楚，不要空话套话。',
  '你给出的只是参考建议，不能替公司做正式决定；不确定的地方要直说。',
].join('\n');

/** 同一个人同时只能有一个问题在等回答，防止连点把额度烧掉 */
const inFlight = new Set();

function publicChatProvider(provider, canManage) {
  return { ...publicProvider(provider, canManage), source: provider?.source || 'shared' };
}

function cleanMessages(raw) {
  if (!Array.isArray(raw) || !raw.length) throw badRequest('请先输入问题');
  const list = raw.slice(-MAX_TURNS).map(m => ({
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    content: String(m?.content ?? '').trim().slice(0, MAX_CONTENT),
  })).filter(m => m.content);
  if (!list.length || list[list.length - 1].role !== 'user') throw badRequest('请先输入问题');
  // 超出总长就从最早的开始丢，保证最新的问题一定带上
  let total = list.reduce((n, m) => n + m.content.length, 0);
  while (total > MAX_TOTAL && list.length > 1) total -= list.shift().content.length;
  return list;
}

/** 兼容 content 是字符串或分段数组两种返回 */
function replyText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('').trim();
  }
  return '';
}

async function askModel(provider, messages) {
  let response;
  try {
    response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'system', content: INSTRUCTIONS }, ...messages],
        stream: false,
      }),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new HttpError(504, 'AI 回答超时了，换个短一点的问题再试');
    throw new HttpError(502, '连不上 AI 接口，请联系管理员检查接入配置');
  }

  let body = null;
  try { body = await response.json(); } catch { /* 供应商可能返回 HTML 错误页 */ }
  if (!response.ok) {
    console.warn(`[ai-chat] ${new URL(provider.baseUrl).host} 返回 ${response.status}`);
    throw providerError(body, response.status);
  }
  const reply = replyText(body);
  if (!reply) throw new HttpError(502, 'AI 没有返回内容，请重试');
  return reply;
}

export function mount(router) {
  router.get('/api/ai-chat/provider', async (req, res) => {
    const me = await currentUser(req);
    sendJson(res, 200, publicChatProvider(await activeChatProvider(), me.role === 'admin'));
  });

  router.post('/api/ai-chat/provider/models', async (req, res) => {
    assertAdmin(await currentUser(req));
    const body = await readJson(req);
    const provider = await resolveProviderInput(body, await activeChatProvider());
    const { models } = await fetchProviderModels(provider);
    sendJson(res, 200, { baseUrl: provider.baseUrl, models });
  });

  router.post('/api/ai-chat/provider', async (req, res) => {
    assertAdmin(await currentUser(req));
    const body = await readJson(req);
    const provider = await resolveProviderInput(body, await activeChatProvider());
    const { models } = await fetchProviderModels(provider);
    const model = String(body.model ?? '').trim().slice(0, 160);
    if (!models.includes(model)) throw badRequest('所选模型不在当前 API Key 的可用列表中，请重新拉取');
    const saved = await saveChatProvider({ ...provider, model });
    sendJson(res, 200, publicChatProvider(saved, true));
  });

  router.del('/api/ai-chat/provider', async (req, res) => {
    assertAdmin(await currentUser(req));
    sendJson(res, 200, publicChatProvider(await clearChatProvider(), true));
  });

  router.post('/api/ai-chat', async (req, res) => {
    const me = await currentUser(req);
    const body = await readJson(req);
    const messages = cleanMessages(body.messages);
    const provider = await activeChatProvider();
    if (!provider.apiKey) {
      throw new HttpError(503, me.role === 'admin'
        ? '还没有接入 AI，点右上角的设置填写 API 地址和密钥'
        : '管理员还没有接入 AI 接口');
    }
    if (inFlight.has(me.id)) throw new HttpError(429, '上一个问题还在回答，请稍等');
    inFlight.add(me.id);
    try {
      const reply = await askModel(provider, messages);
      sendJson(res, 200, { reply, model: provider.model, createdAt: new Date().toISOString() });
    } finally {
      inFlight.delete(me.id);
    }
  });
}
