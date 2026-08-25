/**
 * 智能导入弹窗：原文 -> AI 草稿 -> 可编辑预览 -> 确认写入。
 * AI 永远不从浏览器直连；已保存的 API Key 也永远不会从后端返回。
 */
import { api } from '../api.js';
import { $, esc } from '../util.js';
import { toast } from '../toast.js';
import { ICON } from '../icons.js';

export const events = new EventTarget();

const CANGYUAN_BASE_URL = 'https://ai.cangyuansuanli.cn';

const DESTINATIONS = [
  ['idea', 'pool', '灵感池'],
  ['demand', 'demands', '用户需求'],
  ['work', 'persona', '真人作品'],
  ['work', 'matrix', '矩阵作品'],
  ['work', 'live', '真人直播'],
  ['playbook', 'sales', '销售转化'],
  ['playbook', 'delivery', '后端交付'],
  ['client', 'clients', '客户档案'],
  ['case', 'cases', '案例库'],
  ['report', 'reports', '工作提交'],
];

const TARGET_LABEL = Object.fromEntries(DESTINATIONS.map(([, b, label]) => [b, label]));
const DEFAULT_BOARD = { idea:'pool', demand:'demands', work:'persona', playbook:'sales', client:'clients', case:'cases', report:'reports' };

const FIELDS = {
  idea: [
    ['content', '详细说明', 'textarea'],
    ['category', '灵感分类', 'select', ['产品', '技术', '运营', '流程', '其他']],
  ],
  demand: [
    ['quote', '用户原话 / 证据', 'textarea'],
    ['scene', '发生场景', 'input'],
    ['realGoal', '真正想解决什么', 'textarea'],
    ['note', '补充说明', 'input'],
  ],
  work: [
    ['note', '内容说明', 'textarea'],
    ['pillar', '内容支柱 / 主题', 'input'],
    ['url', '作品链接', 'url'],
    ['side', '作品归属', 'select-value', [['own', '自己的作品'], ['benchmark', '对标作品']]],
  ],
  playbook: [
    ['body', '方法 / 话术正文', 'textarea'],
    ['label', '卡片标签', 'input'],
    ['section', '所属小节', 'input'],
  ],
  client: [
    ['note', '当前判断与备注', 'textarea'],
    ['timeline', '关系时间线', 'textarea'],
    ['tier', '客资等级', 'select-value', [['', '暂不判断'], ['S', 'S'], ['A', 'A'], ['B', 'B'], ['C', 'C']]],
    ['stage', '当前阶段', 'select-value', [['lead', '线索'], ['wechat', '已加微信'], ['profiled', '已建档'], ['consulted', '已咨询'], ['coaching', '陪跑中'], ['renewed', '已续费'], ['lost', '已流失']]],
    ['source', '客户来源', 'input'],
  ],
  case: [
    ['problem', '初始问题', 'textarea'],
    ['judgement', '判断结论', 'textarea'],
    ['strategy', '策略动作', 'textarea'],
    ['outcome', '最终结果', 'input'],
  ],
  report: [
    ['summary', '完成了什么', 'textarea'],
    ['resultUrl', '结果链接 / 产物', 'url'],
    ['blockers', '遇到的问题', 'input'],
    ['needHelp', '需要协助', 'input'],
  ],
};

let result = null;
let phase = 'compose';
let provider = null;
let providerLoaded = false;
let providerModels = [];

const selectedItems = () => (result?.suggestions || []).filter(s => s.selected);

function show(next) {
  phase = next;
  $('#smartImportCompose').hidden = next !== 'compose';
  $('#smartImportAnalyzing').hidden = next !== 'analyzing';
  $('#smartImportPreview').hidden = next !== 'preview';
  $('#smartImportDone').hidden = next !== 'done';
  $('#smartImportBack').hidden = next !== 'preview';
  $('#smartImportAnalyze').hidden = next !== 'compose';
  $('#smartImportCommit').hidden = next !== 'preview';
  $('#smartImportCancel').textContent = next === 'done' ? '关闭' : '取消';
}

export function open() {
  if (phase === 'done') reset();
  $('#mask').classList.add('on');
  $('#smartImportModal').classList.add('on');
  loadProvider();
  setTimeout(() => $('#smartImportText').focus(), 220);
}

export function close() {
  $('#smartImportModal')?.classList.remove('on');
  $('#smartProviderKey').value = '';
  $('#smartProviderKey').type = 'password';
  $('#smartProviderKeyEye').textContent = '显示';
  toggleProviderPanel(false);
  // 其它弹窗或抽屉仍开着时不能把共用遮罩拿掉
  if (!document.querySelector('.modal.on,.drawer.on')) $('#mask')?.classList.remove('on');
}

function reset() {
  result = null;
  $('#smartImportText').value = '';
  $('#smartImportSource').value = '';
  $('#smartImportChars').textContent = '0';
  show('compose');
}

function providerFeedback(message = '', kind = '') {
  const el = $('#smartProviderFeedback');
  el.textContent = message;
  el.className = `smart-provider-feedback${kind ? ` ${kind}` : ''}`;
}

function toggleProviderPanel(opened) {
  const panel = $('#smartProviderPanel');
  panel.classList.toggle('on', opened);
  panel.setAttribute('aria-hidden', opened ? 'false' : 'true');
  $('#smartProviderToggle').setAttribute('aria-expanded', opened ? 'true' : 'false');
}

function providerHost(baseUrl) {
  try { return new URL(baseUrl).host; } catch { return ''; }
}

function paintProvider(data) {
  provider = data;
  const ready = Boolean(data?.configured);
  $('#smartProviderMark').classList.toggle('ready', ready);
  $('#smartProviderName').textContent = ready
    ? (data.model || '已连接 AI 模型') : '尚未连接 AI';
  $('#smartProviderMeta').textContent = ready
    ? `${providerHost(data.baseUrl) || '兼容接口'} · ${data.source === 'saved' ? '密钥已加密保存' : '服务器环境配置'}`
    : '配置接口后，智能导入会自动识别和归类';

  const toggle = $('#smartProviderToggle');
  toggle.hidden = !data?.canManage;
  const isOldOfficialDefault = data?.source === 'environment'
    && providerHost(data.baseUrl) === 'api.openai.com';
  if (data?.canManage) {
    $('#smartProviderUrl').value = isOldOfficialDefault ? CANGYUAN_BASE_URL : (data.baseUrl || CANGYUAN_BASE_URL);
  }
  $('#smartProviderKeyHint').textContent = isOldOfficialDefault
    ? '请输入苍原算力新建的完整 API Key'
    : data?.hasKey
      ? (data.source === 'saved' ? '已有密钥；不更换时可以留空' : '已有服务器密钥；更换平台时请输入新密钥')
      : '尚未保存密钥，请输入后拉取模型';
  if (isOldOfficialDefault) providerFeedback('苍原算力地址已经填好，输入 Key 后直接拉取模型');

  // 尚未主动拉取时也把当前模型画出来，让管理员知道线上实际在用什么。
  if (!providerModels.length && data?.model) {
    $('#smartProviderModel').innerHTML = `<option value="${esc(data.model)}">${esc(data.model)}（当前）</option>`;
    $('#smartProviderModel').disabled = true;
  }
}

async function loadProvider(force = false) {
  if (providerLoaded && !force) return;
  providerLoaded = true;
  try {
    paintProvider(await api.smartImportProvider());
  } catch (err) {
    providerLoaded = false;
    $('#smartProviderName').textContent = '配置读取失败';
    $('#smartProviderMeta').textContent = err.message;
  }
}

function paintModels(models, selected = '') {
  providerModels = models;
  const select = $('#smartProviderModel');
  select.innerHTML = models.length ? models.map(model =>
    `<option value="${esc(model)}"${model === selected ? ' selected' : ''}>${esc(model)}</option>`).join('')
    : '<option value="">先拉取可用模型</option>';
  select.disabled = models.length === 0;
  $('#smartProviderSave').disabled = models.length === 0;
}

async function fetchModels() {
  const baseUrl = $('#smartProviderUrl').value.trim();
  const apiKey = $('#smartProviderKey').value.trim();
  if (!baseUrl) return providerFeedback('请先填写 API 地址', 'error');
  const changingProvider = providerHost(baseUrl) !== providerHost(provider?.baseUrl);
  if (!apiKey && (!provider?.hasKey || changingProvider)) return providerFeedback('请输入苍原算力 API Key', 'error');

  const btn = $('#smartProviderFetch');
  btn.disabled = true;
  btn.textContent = '正在连接…';
  providerFeedback(`正在连接 ${providerHost(baseUrl) || '模型接口'} 并拉取可用模型…`, 'loading');
  try {
    const data = await api.smartImportModels({ baseUrl, apiKey });
    $('#smartProviderUrl').value = data.baseUrl;
    const selected = data.models.includes(provider?.model) ? provider.model : data.models[0];
    paintModels(data.models, selected);
    providerFeedback(`连接成功，共找到 ${data.models.length} 个可用模型；选择后点击“使用此模型”`, 'success');
  } catch (err) {
    paintModels([], '');
    providerFeedback(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '重新拉取模型';
  }
}

async function saveProviderConfig() {
  const model = $('#smartProviderModel').value;
  if (!model) return providerFeedback('请先拉取并选择一个模型', 'error');
  const btn = $('#smartProviderSave');
  btn.disabled = true;
  btn.textContent = '正在验证…';
  providerFeedback('正在再次验证模型并保存配置…', 'loading');
  let saved = false;
  try {
    const data = await api.smartImportProviderSave({
      baseUrl: $('#smartProviderUrl').value.trim(),
      apiKey: $('#smartProviderKey').value.trim(),
      model,
    });
    $('#smartProviderKey').value = '';
    providerModels = [];
    saved = true;
    paintProvider(data);
    providerFeedback('配置已保存，下一次识别会使用这个模型', 'success');
    setTimeout(() => toggleProviderPanel(false), 650);
    toast('ok', `已切换到 ${data.model}`);
  } catch (err) {
    providerFeedback(err.message, 'error');
  } finally {
    btn.disabled = saved || providerModels.length === 0;
    btn.textContent = '使用此模型';
  }
}

function destinationOptions(s) {
  return DESTINATIONS.map(([target, board, label]) =>
    `<option value="${target}:${board}"${target === s.target && board === s.board ? ' selected' : ''}>${label}</option>`).join('');
}

function fieldControl(s, field) {
  const [key, label, kind, options] = field;
  const value = s.data?.[key] ?? '';
  if (kind === 'textarea') {
    return `<div class="field smart-field smart-field-wide"><label>${label}</label>
      <textarea class="inp" data-data-field="${key}">${esc(value)}</textarea></div>`;
  }
  if (kind === 'select' || kind === 'select-value') {
    const list = kind === 'select' ? options.map(v => [v, v]) : options;
    return `<div class="field smart-field"><label>${label}</label><select class="inp" data-data-field="${key}">
      ${list.map(([v, t]) => `<option value="${esc(v)}"${String(value) === String(v) ? ' selected' : ''}>${esc(t)}</option>`).join('')}
    </select></div>`;
  }
  return `<div class="field smart-field"><label>${label}</label>
    <input class="inp" ${kind === 'url' ? 'type="url"' : ''} data-data-field="${key}" value="${esc(value)}"></div>`;
}

function suggestionHTML(s, index) {
  const pct = Math.round((Number(s.confidence) || 0) * 100);
  const confidence = pct >= 80 ? 'high' : pct >= 65 ? 'mid' : 'low';
  return `<article class="smart-suggestion${s.selected ? ' selected' : ''}" data-index="${index}" style="--accent:${s.color || '#6974d8'}">
    <div class="smart-suggestion-top">
      <button class="smart-pick${s.selected ? ' on' : ''}" type="button" aria-label="${s.selected ? '取消选择' : '选择这条'}">
        <span>${ICON.check}</span>
      </button>
      <div class="smart-order"><small>识别结果</small><b>${String(index + 1).padStart(2, '0')}</b></div>
      <div class="smart-destination"><label>导入到</label><select class="inp" data-destination>${destinationOptions(s)}</select></div>
      <span class="smart-confidence ${confidence}">${pct}% 把握</span>
    </div>
    <div class="smart-reason">${esc(s.reason)}</div>
    <div class="smart-edit-grid">
      <div class="field smart-field smart-field-wide"><label>${s.target === 'client' ? '客户名称 / 化名' : '标题'} <span>*</span></label>
        <input class="inp smart-title-input" data-root-field="title" value="${esc(s.title)}"></div>
      ${(FIELDS[s.target] || FIELDS.idea).map(f => fieldControl(s, f)).join('')}
      <div class="field smart-field smart-field-wide"><label>建议标签 <span class="opt">（逗号分隔）</span></label>
        <input class="inp" data-root-field="tags" value="${esc((s.tags || []).join('，'))}"></div>
    </div>
  </article>`;
}

function paintSuggestions() {
  $('#smartImportSuggestions').innerHTML = result.suggestions.map(suggestionHTML).join('');
  $('#smartImportSelected').textContent = selectedItems().length;
  $('#smartImportCommit').disabled = selectedItems().length === 0;
}

function normalizeResult(data) {
  const suggestions = (data.suggestions || []).map(s => ({
    ...s,
    selected: s.confidence >= .58,
    data: { ...(s.data || {}) },
    tags: Array.isArray(s.tags) ? s.tags : [],
  }));
  return { ...data, suggestions };
}

async function analyze() {
  const text = $('#smartImportText').value.trim();
  if (text.length < 8) {
    toast('info', '至少输入 8 个字，才能判断内容属于哪里');
    $('#smartImportText').focus();
    return;
  }
  const btn = $('#smartImportAnalyze');
  btn.disabled = true;
  show('analyzing');
  try {
    const data = await api.smartImportAnalyze({ text, sourceUrl: $('#smartImportSource').value.trim() });
    result = normalizeResult(data);
    $('#smartImportMode').textContent = data.mode === 'ai' ? 'AI 智能识别' : '基础规则识别';
    $('#smartImportMode').classList.toggle('rules', data.mode !== 'ai');
    $('#smartImportOverview').textContent = data.overview || `生成 ${result.suggestions.length} 条草稿`;
    paintSuggestions();
    show('preview');
    if (data.warning) toast('info', data.warning);
  } catch (e) {
    show('compose');
    toast('info', `识别失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function commit() {
  const items = selectedItems();
  if (!items.length) return toast('info', '请至少选择一条内容');
  if (items.some(s => !String(s.title || '').trim())) return toast('info', '所选内容里还有空标题');
  const btn = $('#smartImportCommit');
  btn.disabled = true;
  btn.textContent = '正在写入…';
  try {
    const saved = await api.smartImportCommit({
      importId: result.importId,
      sourceUrl: $('#smartImportSource').value.trim(),
      items,
    });
    $('#smartImportDoneText').textContent = `已新建 ${saved.created} 条${saved.existed ? `，另有 ${saved.existed} 条已存在、没有重复创建` : ''}。`;
    $('#smartImportDoneList').innerHTML = saved.items.map(x => `
      <button type="button" data-goto="${esc(x.board)}" data-entity="${esc(x.target)}" data-ref="${x.id}">
        <span><i>${esc(TARGET_LABEL[x.board] || x.board)}</i><b>${esc(x.title)}</b></span>
        <em>${x.created ? '查看' : '查看已有'} →</em>
      </button>`).join('');
    show('done');
    events.dispatchEvent(new CustomEvent('committed', { detail: saved }));
    toast('ok', '智能导入完成');
  } catch (e) {
    toast('info', `导入失败：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '确认导入所选内容';
  }
}

function updateFromControl(el) {
  const card = el.closest('.smart-suggestion');
  if (!card) return;
  const s = result.suggestions[Number(card.dataset.index)];
  if (el.dataset.rootField === 'title') {
    s.title = el.value;
    if (s.target === 'client') s.data.alias = el.value;
  } else if (el.dataset.rootField === 'tags') {
    s.tags = el.value.split(/[、,，\n]+/).map(x => x.trim()).filter(Boolean).slice(0, 6);
  } else if (el.dataset.dataField) {
    s.data[el.dataset.dataField] = el.value;
    if (s.target === 'client' && el.dataset.dataField === 'alias') s.title = el.value;
  }
}

export function bind() {
  $('#smartImportBtn').addEventListener('click', open);
  $('#smartProviderToggle').addEventListener('click', e => {
    const opened = e.currentTarget.getAttribute('aria-expanded') !== 'true';
    toggleProviderPanel(opened);
    if (opened) setTimeout(() => $('#smartProviderUrl').focus(), 220);
  });
  $('#smartProviderFetch').addEventListener('click', fetchModels);
  $('#smartProviderSave').addEventListener('click', saveProviderConfig);
  $('#smartProviderModel').addEventListener('change', e => {
    if (providerModels.length) providerFeedback(`已选择 ${e.currentTarget.value}，点击“使用此模型”完成配置`, 'success');
  });
  $('#smartProviderKeyEye').addEventListener('click', e => {
    const input = $('#smartProviderKey');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    e.currentTarget.textContent = visible ? '显示' : '隐藏';
    e.currentTarget.setAttribute('aria-label', visible ? '显示密钥' : '隐藏密钥');
  });
  $('#smartProviderUrl').addEventListener('input', () => {
    paintModels([], '');
    providerFeedback('地址已改变，请重新拉取模型');
  });
  $('#smartProviderKey').addEventListener('input', () => {
    paintModels([], '');
    providerFeedback('密钥已改变，请重新拉取模型');
  });
  $('#smartImportAnalyze').addEventListener('click', analyze);
  $('#smartImportCommit').addEventListener('click', commit);
  $('#smartImportBack').addEventListener('click', () => show('compose'));
  $('#smartImportExample').addEventListener('click', () => {
    const sample = '张总反馈最近直播带来的咨询不少，但客服跟进太慢，经常隔天才回复。他希望增加客户提醒机制。下周先测试企业微信自动通知，并整理一套 30 分钟内首次响应的跟进流程。';
    $('#smartImportText').value = sample;
    $('#smartImportChars').textContent = sample.length;
    $('#smartImportText').focus();
  });
  $('#smartImportText').addEventListener('input', e => {
    $('#smartImportChars').textContent = e.currentTarget.value.length;
  });

  const box = $('#smartImportSuggestions');
  box.addEventListener('click', e => {
    const pick = e.target.closest('.smart-pick');
    if (pick) {
      const i = Number(pick.closest('.smart-suggestion').dataset.index);
      result.suggestions[i].selected = !result.suggestions[i].selected;
      paintSuggestions();
    }
    const goto = e.target.closest('[data-goto]');
    if (goto) events.dispatchEvent(new CustomEvent('goto', { detail: {
      board: goto.dataset.goto, entity: goto.dataset.entity, refId: Number(goto.dataset.ref),
    } }));
  });
  box.addEventListener('input', e => updateFromControl(e.target));
  box.addEventListener('change', e => {
    if (e.target.matches('[data-destination]')) {
      const card = e.target.closest('.smart-suggestion');
      const s = result.suggestions[Number(card.dataset.index)];
      const [target, board] = e.target.value.split(':');
      s.target = target;
      s.board = board || DEFAULT_BOARD[target];
      if (target === 'client' && !s.data.alias) s.data.alias = s.title;
      paintSuggestions();
      return;
    }
    updateFromControl(e.target);
  });

  $('#smartImportDoneList').addEventListener('click', e => {
    const goto = e.target.closest('[data-goto]');
    if (!goto) return;
    close();
    events.dispatchEvent(new CustomEvent('goto', { detail: {
      board: goto.dataset.goto, entity: goto.dataset.entity, refId: Number(goto.dataset.ref),
    } }));
  });
}
