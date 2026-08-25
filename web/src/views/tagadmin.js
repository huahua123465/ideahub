/**
 * 标签与对接（任务 3 的管理端 + 任务 10/11 的钥匙管理）。
 *
 * 两件事放一页：都是「配置」，都只有管理员用，各开一个页面反而更难找。
 * 普通成员进来只能看，不能改 —— 让他们看得到标签字典本身是有用的
 * （知道系统里有哪些标准说法），能改就乱了。
 */
import { api } from '../api.js';
import { esc, $ } from '../util.js';
import { toast } from '../toast.js';
import { tagDict, invalidate, KIND_ORDER, KIND_LABEL } from '../tagstore.js';
import { confirmAction } from '../confirm.js';

let me = { role: 'member' };
export const setMe = u => { me = u; };

export async function render() {
  const root = $('#v-tagadmin');
  const admin = me.role === 'admin';
  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-kicker">系统配置</div>
        <h1>标签与对接</h1>
        <div class="sub">全站共用一套标签字典，所有模块的下拉都从这里来。${
          admin ? '' : '（只有管理员能修改）'}</div>
      </div>
    </div>
    <div id="taRoot" class="tag-admin-grid"><div class="dim">加载中…</div></div>
    ${admin ? '<div id="keyRoot"></div>' : ''}`;

  await paintTags();
  if (admin) await paintKeys();
}

async function paintTags() {
  const box = $('#taRoot');
  const admin = me.role === 'admin';
  invalidate();
  let d;
  try { d = await api.tagsAll(); }
  catch (e) { box.innerHTML = `<div class="dim">读取失败：${esc(e.message)}</div>`; return; }

  box.innerHTML = KIND_ORDER.map(kind => {
    const list = d.items.filter(t => t.kind === kind);
    return `<section class="cdcard tag-admin-card tag-admin-${esc(kind)}">
      <div class="sec-title">${esc(KIND_LABEL[kind])} <span class="dim">${list.length} 个</span></div>
      <div class="taglist">
        ${list.map(t => `
          <span class="chip tagchip${t.active ? '' : ' off'}" title="${
            t.usedBy ? `已用在 ${t.usedBy} 条资料上` : '还没被使用'}">
            ${esc(t.name)}${t.usedBy ? `<i class="dim">${t.usedBy}</i>` : ''}
            ${admin ? `<button class="tagx" data-del="${t.id}" title="${
              t.usedBy ? '已被使用，只会停用' : '删除'}">×</button>` : ''}
          </span>`).join('') || '<span class="dim">还没有标签</span>'}
      </div>
      ${admin ? `<div class="cdadd">
        <input class="inp ta-new" data-kind="${kind}" placeholder="新增一个${esc(KIND_LABEL[kind])}标签，回车保存">
      </div>` : ''}
    </section>`;
  }).join('');

  if (!admin) return;

  box.querySelectorAll('.ta-new').forEach(inp => {
    inp.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      const name = inp.value.trim();
      if (!name) return;
      try {
        await api.tagCreate({ kind: inp.dataset.kind, name });
        inp.value = '';
        toast('ok', '已新增');
        await paintTags();
      } catch (err) { toast('info', err.message || '新增失败'); }
    });
  });

  box.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await confirmAction({
        eyebrow: '影响全站标签',
        title: '删除这个标签？',
        message: '还没被用过的标签会直接删掉；已经用过的只会停用。',
        note: '历史资料上已经打好的这个标签不受影响，仍然看得到。',
        confirmLabel: '确认删除',
      });
      if (!ok) return;
      try {
        const r = await api.tagDelete(Number(btn.dataset.del));
        toast('ok', r.message || '已删除');
        await paintTags();
      } catch (err) { toast('info', err.message || '删除失败'); }
    });
  });
}

async function paintKeys() {
  const box = $('#keyRoot');
  let d;
  try { d = await api.apiKeys(); }
  catch (e) { box.innerHTML = `<div class="dim">读取对接密钥失败：${esc(e.message)}</div>`; return; }

  box.innerHTML = `
    <section class="cdcard">
      <div class="sec-title">技术1 / 技术2 对接密钥</div>
      <div class="dim" style="margin-bottom:8px">
        技术1 和技术2 用这把钥匙往 IdeaHub 写数据，不占用任何同事的账号。
        钥匙只在生成的那一刻显示一次，丢了就重新生成一把、把旧的停用。
        接口说明见项目里的 <code>docs/接入说明.md</code>。
      </div>
      <div class="keyget">
        <b>要发给对接方的三样东西</b>
        <ol>
          <li>下面生成的密钥（只显示一次，生成后立刻复制发走）</li>
          <li>
            接入说明文档 ——
            <a class="link" href="/接入说明.html" target="_blank" rel="noopener">在线看 ↗</a>
            <span class="dim">·</span>
            <a class="link" href="/接入说明.md" download>下载 Markdown</a>
            <span class="dim">怎么接入、每个字段什么意思、错误码</span>
          </li>
          <li>
            现成的推送脚本 ——
            <a class="link" href="/推送到ideahub.py" download>下载 推送到ideahub.py</a>
            <span class="dim">纯 Python 标准库，对方不用装任何依赖，填好 CSV 就能推</span>
          </li>
        </ol>
      </div>
      <div class="keylist">
        ${d.items.length ? d.items.map(k => `
          <div class="kv">
            <span>${esc(k.name)} <span class="tag">${esc((k.scopes || []).join(','))}</span></span>
            <span class="dim">${k.revokedAt ? '已停用'
              : k.lastUsedAt ? '最近调用 ' + String(k.lastUsedAt).slice(0, 16).replace('T', ' ')
              : '还没被调用过'}</span>
            ${k.revokedAt ? '' : `<button class="btn btn-ghost key-revoke" data-id="${k.id}">停用</button>`}
          </div>`).join('') : '<div class="dim">还没有生成过钥匙</div>'}
      </div>
      <div class="cdadd">
        <button class="btn btn-ghost" data-newkey="tech1">生成技术1 的钥匙</button>
        <button class="btn btn-ghost" data-newkey="tech2">生成技术2 的钥匙</button>
      </div>
      <div id="keyOut"></div>
    </section>`;

  box.querySelectorAll('[data-newkey]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const scope = btn.dataset.newkey;
      try {
        const r = await api.apiKeyCreate({ scope, name: scope === 'tech1' ? '技术1' : '技术2' });
        // 先重画列表再贴钥匙 —— 反过来的话 paintKeys 会把刚贴上去的明文冲掉，
        // 而它这辈子只显示这一次
        await paintKeys();
        $('#keyOut').innerHTML = `<div class="keyshow">
          <b>${esc(scope === 'tech1' ? '技术1' : '技术2')} 的钥匙（只显示这一次）</b>
          <code>${esc(r.key)}</code>
          <div class="dim">复制后交给对接方，让他们放进请求头：Authorization: Bearer &lt;这串&gt;</div>
        </div>`;
      } catch (e) { toast('info', e.message || '生成失败'); }
    });
  });

  box.querySelectorAll('.key-revoke').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await confirmAction({
        eyebrow: '会中断对接',
        title: '停用这把钥匙？',
        message: '对接方（技术1 / 技术2）会立刻写不进来，正在跑的推送会开始报 401。',
        note: '停用不可撤销。要恢复对接只能重新生成一把新钥匙交给对方。',
        confirmLabel: '确认停用',
      });
      if (!ok) return;
      try { await api.apiKeyRevoke(Number(btn.dataset.id)); await paintKeys(); }
      catch (e) { toast('info', e.message || '停用失败'); }
    });
  });
}
