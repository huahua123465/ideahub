/**
 * 项目功能树。
 *
 * 这不是另一份重复导航：导航只回答“去哪”，这里回答“整个项目有什么、
 * 每块解决什么问题、AI 在其中承担什么、最终仍需谁确认”。二级节点先打开
 * 紧邻模块右侧的就地介绍卡，用户确认方向后再进入真实业务页面。
 */
import { ICON } from '../icons.js';
import { $ } from '../util.js';

export const events = new EventTarget();

let initialized = false;
let activeKey = '';

const ITEMS = {
  today: {
    label: '今日工作台', target: 'home',
    intro: '汇总当天待审核、评审、客户跟进和需求事项，让成员先处理真正重要的工作。',
    ai: ['汇总跨模块变化并生成今日摘要', '结合紧急度、影响范围和负责人建议优先顺序', '识别缺失信息并给出下一步提醒'],
    human: '确认实际优先级，并决定是否采纳 AI 的排序和提醒。', output: '个人今日行动清单',
  },
  functionTree: {
    label: '项目功能树', target: 'functionTree', current: true,
    intro: '集中展示 IdeaHub 的功能域、页面入口和模块关系，帮助新人快速理解项目全貌。',
    ai: ['读取功能配置并生成通俗的模块说明', '识别重复入口、孤立功能和缺失介绍', '根据项目变化建议更新结构与关联关系'],
    human: '确认功能归属、命名和真实业务边界。', output: '持续更新的项目功能地图',
  },
  globalSearch: {
    label: '全局搜索', action: 'search', meta: '⌘ K',
    intro: '跨灵感、需求、正式库、客户、案例和研究资料进行统一检索。',
    ai: ['理解自然语言查询并扩展同义表达', '按语义相关度匹配跨模块资料', '汇总结果差异并提示原始来源'],
    human: '判断结果是否适用，并回到原始资料核验。', output: '带来源的跨库搜索结果',
  },
  smartImport: {
    label: 'AI 整理', action: 'import', meta: '智能导入',
    intro: '把聊天记录、会议笔记、客户反馈或作品复盘转换成可写入系统的结构化草稿。',
    ai: ['识别内容应该进入哪个业务模块', '提取字段、标签、人物和关键证据', '生成可编辑草稿并提示信息缺口'],
    human: '预览、修改并确认最终写入内容。', output: '经过确认的结构化业务记录',
  },
  pool: {
    label: '灵感池', target: 'pool',
    intro: '收集团队想法并通过讨论、投票和评审推动成熟灵感进入正式库。',
    ai: ['自动归类、打标签并识别相似灵感', '总结讨论观点、分歧和待验证假设', '根据证据完整度提示评审准备情况'],
    human: '补充事实、参与讨论并作出采纳或否决决定。', output: '可评审的灵感方案',
  },
  demands: {
    label: '用户需求', target: 'demands',
    intro: '保存用户原话、发生场景和真实目标，让内容与产品决策有证据可追溯。',
    ai: ['从原话中提取痛点、场景和真实诉求', '检查证据缺口与表述偏差', '聚合同类需求并提示高频主题'],
    human: '核验原话和场景，确定需求优先级。', output: '有证据的用户需求档案',
  },
  formal: {
    label: '正式库', target: 'formal',
    intro: '管理已采纳、已立项的内容或项目，记录负责人、进度和方案文档。',
    ai: ['把评审结论整理成执行要点', '汇总进度、风险和阻塞事项', '提醒缺失方案、负责人或关键里程碑'],
    human: '确定计划、负责人和真实进度。', output: '可执行、可追踪的正式项目',
  },
  persona: {
    label: '真人作品', target: 'persona',
    intro: '沉淀真人 IP 的作品、账号、内容支柱、表现数据和复盘结论。',
    ai: ['识别主题、内容支柱和表达结构', '提取互动数据并生成复盘摘要', '基于历史表现提出选题和结构变体'],
    human: '完成创作、发布，并判断建议是否符合真人表达。', output: '真人 IP 作品资产与复盘',
  },
  matrix: {
    label: '矩阵作品', target: 'matrix',
    intro: '管理矩阵账号内容，形成可批量复用但保持差异化的选题和表达体系。',
    ai: ['聚类高频问题与情绪痛点', '识别可复用结构并生成多版本草稿', '检查账号间内容重复与定位偏差'],
    human: '按账号定位改写、审核并发布。', output: '差异化矩阵内容方案',
  },
  live: {
    label: '真人直播', target: 'live',
    intro: '记录直播主题、过程数据、关键问答和复盘，让直播经验持续积累。',
    ai: ['辅助生成直播流程和话题提纲', '转写直播并提取高价值问答片段', '识别停留、互动和转化关键节点'],
    human: '主持直播、处理现场判断并确认复盘结论。', output: '直播脚本、片段与复盘报告',
  },
  sales: {
    label: '销售转化', target: 'sales',
    intro: '管理从线索到加微、咨询、成交和续费的转化规则与过程。',
    ai: ['总结沟通记录中的意向和风险信号', '对线索进行辅助分层并建议跟进动作', '分析漏斗流失点并生成调查方向'],
    human: '完成真实沟通，确认客户意愿并作出销售判断。', output: '可跟进的销售机会与转化建议',
  },
  clients: {
    label: '客户档案', target: 'clients',
    intro: '集中保存客户资料、阶段、服务记录、AI 分析和关联案例。',
    ai: ['把分散记录整理为客户时间线', '提取标签、阶段变化和待跟进事项', '生成分析草稿与下一次沟通建议'],
    human: '核验敏感信息和判断结论，决定服务策略。', output: '完整、连续的客户档案',
  },
  delivery: {
    label: '后端交付', target: 'delivery',
    intro: '跟踪客户服务、产品交付和执行过程，确保任务、材料与结果有记录。',
    ai: ['整理客户材料并生成交付清单', '识别阻塞、遗漏和风险事项', '辅助生成服务方案与阶段复盘'],
    human: '执行交付、处理关系判断并确认结果。', output: '可追踪的服务交付记录',
  },
  cases: {
    label: '案例库', target: 'cases',
    intro: '把成功、失败和进行中的服务过程沉淀为可复用案例。',
    ai: ['对敏感内容进行脱敏和结构化整理', '提取问题、判断、策略、反馈和结果', '总结可复用方法及不可照搬的边界'],
    human: '确认事实、隐私处理和最终方法结论。', output: '可教学、可复用的案例资产',
  },
  reports: {
    label: '工作提交', target: 'reports',
    intro: '记录团队成员的工作内容、成果、问题和需要协助的事项。',
    ai: ['总结工作产出与关键变化', '检查成果证据、链接和附件是否完整', '为审核人生成反馈关注点'],
    human: '提交真实成果，并由审核人给出最终反馈。', output: '有结果、有反馈的工作记录',
  },
  tagadmin: {
    label: '标签与对接', target: 'tagadmin',
    intro: '维护统一标签字典、外部系统映射和数据接入规范。',
    ai: ['建议同义标签合并与层级关系', '检测重复、冲突和长期未使用标签', '生成接口字段映射与接入说明草稿'],
    human: '管理员确认标签变更、权限和接口安全。', output: '统一标签体系与对接规范',
  },
  funnel: {
    label: '数据漏斗', target: 'funnel',
    intro: '展示内容、客户和交付过程中的关键阶段与转化变化。',
    ai: ['解释阶段变化并标记异常波动', '关联可能影响变化的业务事件', '提出进一步验证问题，不直接下因果结论'],
    human: '核验数据口径和业务背景，决定后续动作。', output: '可解释的业务漏斗观察',
  },
  stats: {
    label: '统计看板', target: 'stats',
    intro: '汇总项目核心数量、趋势和结构分布，为团队复盘提供统一视图。',
    ai: ['自动生成周期数据摘要', '对比历史区间并指出显著变化', '把图表转换成易读的业务说明'],
    human: '确认统计口径并解释变化原因。', output: '周期统计与管理摘要',
  },
  samples: {
    label: '样本库', target: 'samples',
    intro: '归档外部内容样本，完成单篇拆解、横向比较和可复用组件沉淀。',
    ai: ['自动归档正文、媒体和基础信息', '执行十五维拆解并定位对应证据', '比较多个样本并生成可复用组件草稿'],
    human: '核验证据、修订结论并批准可复用组件。', output: '可追溯的内容研究资产',
  },
  collector: {
    label: '内容采集', target: 'collector',
    intro: '从公开链接或授权平台获取内容素材，并转入样本库继续研究。',
    ai: ['识别页面正文、图片、视频和基础数据', '执行 OCR、语音转写和内容结构化', '检查采集完整度并提示失败原因'],
    human: '确认来源授权、归档范围和内容合规性。', output: '可进入研究流程的原始样本',
  },
  framework: {
    label: '框架学习', target: 'learning', section: 'framework',
    intro: '通过判断链路和重点框架，帮助成员快速掌握业务识别方法。',
    ai: ['结合当前章节生成情境化案例', '出题并解释错误选项背后的误区', '根据学习情况推荐需要复习的节点'],
    human: '完成练习，并把框架用于真实判断时保持审慎。', output: '框架理解与练习记录',
  },
  detail: {
    label: '详细学习', target: 'learning', section: 'detail',
    intro: '阅读专业详解资料，支持按主题查找、提问和深入学习。',
    ai: ['概括章节结构和关键概念', '围绕资料回答问题并标注对应位置', '把复杂内容转为学习卡片和复习提纲'],
    human: '阅读原文、核对引用并形成自己的判断。', output: '带出处的学习笔记与提纲',
  },
};

const GROUPS = [
  { key: 'overview', label: '工作总览', note: '每日入口与全局动作', icon: 'bulb', tone: 'rose', items: ['today', 'functionTree', 'globalSearch', 'smartImport'] },
  { key: 'market', label: '市场与内容', note: '从想法到正式资产', icon: 'search', tone: 'indigo', items: ['pool', 'demands', 'formal'] },
  { key: 'content', label: '内容运营', note: '作品与直播台账', icon: 'layers', tone: 'cyan', items: ['persona', 'matrix', 'live'] },
  { key: 'customer', label: '销售与客户', note: '转化与客户经营', icon: 'users', tone: 'green', items: ['sales', 'clients'], nested: '客户详情 / AI 分析 / 转案例' },
  { key: 'delivery', label: '交付与案例', note: '服务过程与结果沉淀', icon: 'file', tone: 'orange', items: ['delivery', 'cases'] },
  { key: 'team', label: '团队协作', note: '提交、规范与沟通', icon: 'chat', tone: 'yellow', items: ['reports', 'tagadmin'], nested: '消息通知 / 团队聊天' },
  { key: 'research', label: '数据与研究', note: '采集、分析与洞察', icon: 'layers', tone: 'blue', items: ['funnel', 'stats', 'samples', 'collector'], nested: '样本 / 比较记录 / 组件库 / 检索与洞察' },
  { key: 'learning', label: '学习中心', note: '业务判断能力训练', icon: 'book', tone: 'violet', items: ['framework', 'detail'] },
];

const root = () => $('#v-functionTree');

const nodeHtml = key => {
  const item = ITEMS[key];
  return `<button type="button" class="ft-node${item.current ? ' current' : ''}" data-ft-key="${key}">
    <i></i><span>${item.label}</span><b>AI</b>${item.meta ? `<small>${item.meta}</small>` : ''}${item.current ? '<em>当前</em>' : ''}
  </button>`;
};

const domainHtml = group => `<article class="ft-domain tone-${group.tone}" data-ft-domain="${group.key}">
  <button type="button" class="ft-domain-head" aria-expanded="true">
    <span class="ft-domain-icon">${ICON[group.icon]}</span>
    <span><b>${group.label}</b><small>${group.note}</small></span>
    <i>${group.items.length}</i><em aria-hidden="true">⌃</em>
  </button>
  <div class="ft-nodes">${group.items.map(nodeHtml).join('')}${group.nested ? `<p>${group.nested}</p>` : ''}</div>
</article>`;

function scaffold() {
  root().innerHTML = `<section class="ft-page-head">
    <div><div class="page-kicker">总览 · 项目认知</div><h1>项目功能结构</h1><p>集中查看 IdeaHub 当前已有的功能域、页面入口与关键二级能力。</p></div>
    <div class="ft-module-status"><span>${ICON.bulb}</span><div><b>独立功能模块</b><small>从左侧“项目功能树”进入</small></div></div>
  </section>
  <section class="ft-panel">
    <header class="ft-panel-head"><div><span>项目导航 · 当前全貌</span><h2>功能结构树</h2><p>从业务域找到功能入口，点击二级节点查看项目介绍与 AI 协作规划。</p></div><div><b>8 个功能域</b><b>19 个核心页面</b></div><label>${ICON.search}<input id="ftSearch" type="search" placeholder="搜索功能、用途或 AI 能力"></label></header>
    <div class="ft-legend"><span><i></i>当前入口</span><span><b>二级</b>页面内能力</span><span><b class="ai">AI</b>包含 AI 协作介绍</span><span>介绍紧邻当前模块右侧展示</span></div>
    <div class="ft-tree"><div class="ft-root"><b>IdeaHub · 内容与经营研究室</b><span>团队内容、客户与研究资产的统一工作台</span></div><div class="ft-trunk"></div>
      <div class="ft-domains">${GROUPS.map(domainHtml).join('')}
        <article class="ft-intro" id="ftIntro" hidden aria-live="polite">
          <header><div><small>模块项目介绍 · AI 协作规划</small><h2 id="ftIntroTitle"></h2><p id="ftIntroDomain"></p></div><button type="button" id="ftIntroClose" aria-label="关闭项目介绍">×</button></header>
          <div class="ft-intro-body"><section><small>项目介绍</small><p id="ftIntroText"></p></section>
            <section class="ft-ai-section"><header><b>AI</b><span><strong>AI 在这里做什么</strong><small>辅助整理、判断和生成，关键结果由人确认</small></span></header><ol id="ftIntroAi"></ol></section>
            <div class="ft-human"><section><small>人工需要确认</small><p id="ftIntroHuman"></p></section><section><small>核心产出</small><p id="ftIntroOutput"></p></section></div>
          </div>
          <footer><button type="button" id="ftIntroCancel">关闭</button><button type="button" id="ftIntroEnter">进入该模块 →</button></footer>
        </article>
      </div>
    </div>
    <footer class="ft-panel-foot"><span><b>交互方式</b> · 标题栏独立收缩；点击二级节点查看介绍；确认后再进入真实模块。</span><button type="button" id="ftCollapseAll">全部收起 ↑</button></footer>
  </section>`;
  bind();
  initialized = true;
}

export function render() {
  if (!initialized) scaffold();
}

export function leave() {
  closeIntro(false);
}

function bind() {
  const view = root();
  view.addEventListener('click', event => {
    const domainHead = event.target.closest('.ft-domain-head');
    if (domainHead) {
      const domain = domainHead.closest('.ft-domain');
      const collapsed = domain.classList.toggle('collapsed');
      domainHead.setAttribute('aria-expanded', String(!collapsed));
      paintCollapseAll();
      return;
    }
    const node = event.target.closest('[data-ft-key]');
    if (node) { openIntro(node.dataset.ftKey, node); return; }
    if (event.target.closest('#ftIntroClose,#ftIntroCancel')) { closeIntro(); return; }
    if (event.target.closest('#ftIntroEnter')) { enterActive(); return; }
    if (event.target.closest('#ftCollapseAll')) { toggleAll(); }
  });
  $('#ftSearch').addEventListener('input', filterTree);
}

function openIntro(key, trigger) {
  const item = ITEMS[key];
  if (!item) return;
  activeKey = key;
  root().querySelectorAll('.ft-node.active').forEach(node => node.classList.remove('active'));
  trigger.classList.add('active');
  $('#ftIntroTitle').textContent = item.label;
  $('#ftIntroDomain').textContent = `${trigger.closest('.ft-domain').querySelector('.ft-domain-head b').textContent} · AI 参与设计`;
  $('#ftIntroText').textContent = item.intro;
  $('#ftIntroAi').innerHTML = item.ai.map(text => `<li>${text}</li>`).join('');
  $('#ftIntroHuman').textContent = item.human;
  $('#ftIntroOutput').textContent = item.output;
  const enter = $('#ftIntroEnter');
  enter.disabled = !!item.current;
  enter.textContent = item.current ? '当前模块' : item.action === 'search' ? '打开全局搜索 →' : item.action === 'import' ? '打开 AI 整理 →' : '进入该模块 →';
  const intro = $('#ftIntro');
  trigger.closest('.ft-domain').insertAdjacentElement('afterend', intro);
  intro.hidden = false;
}

function closeIntro(restoreFocus = true) {
  if (!initialized) return;
  const trigger = activeKey ? root().querySelector(`[data-ft-key="${activeKey}"]`) : null;
  $('#ftIntro').hidden = true;
  root().querySelectorAll('.ft-node.active').forEach(node => node.classList.remove('active'));
  activeKey = '';
  if (restoreFocus) trigger?.focus();
}

function enterActive() {
  const item = ITEMS[activeKey];
  if (!item || item.current) return;
  events.dispatchEvent(new CustomEvent('navigate', { detail: {
    key: activeKey, target: item.target, section: item.section, action: item.action,
  }}));
}

function toggleAll() {
  const domains = [...root().querySelectorAll('.ft-domain:not([hidden])')];
  const collapse = domains.some(domain => !domain.classList.contains('collapsed'));
  for (const domain of domains) {
    domain.classList.toggle('collapsed', collapse);
    domain.querySelector('.ft-domain-head').setAttribute('aria-expanded', String(!collapse));
  }
  paintCollapseAll();
}

function paintCollapseAll() {
  const domains = [...root().querySelectorAll('.ft-domain:not([hidden])')];
  const allCollapsed = domains.length && domains.every(domain => domain.classList.contains('collapsed'));
  $('#ftCollapseAll').textContent = allCollapsed ? '全部展开 ↓' : '全部收起 ↑';
}

function filterTree(event) {
  const query = event.target.value.trim().toLowerCase();
  closeIntro(false);
  for (const group of GROUPS) {
    const domain = root().querySelector(`[data-ft-domain="${group.key}"]`);
    let matches = 0;
    for (const key of group.items) {
      const item = ITEMS[key];
      const haystack = [item.label, item.intro, item.human, item.output, ...item.ai].join(' ').toLowerCase();
      const node = domain.querySelector(`[data-ft-key="${key}"]`);
      node.hidden = !!query && !haystack.includes(query);
      if (!node.hidden) matches++;
    }
    domain.hidden = matches === 0;
    if (query && matches) {
      domain.classList.remove('collapsed');
      domain.querySelector('.ft-domain-head').setAttribute('aria-expanded', 'true');
    }
  }
  paintCollapseAll();
}
