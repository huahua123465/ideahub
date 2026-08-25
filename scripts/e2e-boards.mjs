/**
 * 业务板块的端到端测试：真开浏览器，真点按钮。
 *
 * 只测接口是不够的 —— 「进度保存了但表格不刷新」「采纳弹窗在手机上横着溢出 80px」
 * 这类都是纯前端问题，接口全绿也照样漏。这里跑真实 DOM：
 * 切标签、开弹窗、填表、保存、改、删，每一步都断言页面上真的变了。
 *
 * 两个视口各跑一遍：
 *   桌面 1600×1000 —— 表格模式
 *   手机  390×844  —— 卡片模式、导航独占一行、触屏点击区
 * 手机端的问题（导航被挤成 0 宽、弹窗溢出、点击区只有 24px）以前全靠手工截图才发现，
 * 现在这一趟能自动兜住。
 *
 *   node scripts/e2e-boards.mjs                # 两个视口都跑
 *   node scripts/e2e-boards.mjs --only=手机     # 只跑手机
 *   node scripts/e2e-boards.mjs --headed       # 想看着它跑（需要有显示器）
 */
import puppeteer from 'puppeteer';

// 端口从 .env 的 HTTP_PORT 来，别在这里写死 —— 换过一次端口就因为这行全崩了
const BASE = process.env.E2E_BASE || `http://127.0.0.1:${process.env.HTTP_PORT || 18080}`;
const SID = process.env.E2E_SID;
if (!SID) { console.error('需要 E2E_SID（管理员会话 id）'); process.exit(1); }

const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];

const VIEWPORTS = [
  { name: '桌面', w: 1600, h: 1000, mobile: false },
  { name: '手机', w: 390, h: 844, mobile: true },
].filter(v => !only || v.name === only);

/** 触屏点击区下限。44 是苹果人机指南，这里放宽到 40 —— 行内小按钮到 40 就够用了 */
const TAP_MIN = 40;

const pass = [], fail = [];
let vp = '';
const ok = (name, extra = '') => { pass.push(name); console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); };
const bad = (name, why) => { fail.push({ vp, name, why }); console.log(`  ❌ ${name}\n       ${why}`); };

let currentPage = null;

async function check(name, fn) {
  try { ok(name, (await fn()) || ''); }
  catch (e) {
    bad(name, e.message);
    // 失败时可能把弹窗/抽屉留在开着的状态，遮罩会挡住后面所有点击 ——
    // 一条失败连累一大片，真正的失败反而被淹没。这里强制收干净。
    try {
      await currentPage?.evaluate(() => {
        for (const sel of ['#bdModal', '#adoptModal', '#rejectModal', '#modal', '#drawer', '#mask']) {
          document.querySelector(sel)?.classList.remove('on');
        }
      });
    } catch { /* 页面可能已经关了 */ }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 等某个条件成立，超时就抛。比死等固定毫秒稳得多 */
async function until(page, fn, { timeout = 8000, label = '条件', args = [] } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn, ...args)) return;
    if (Date.now() - t0 > timeout) throw new Error(`等 ${label} 超时`);
    await sleep(120);
  }
}

/**
 * 切到某个板块。
 * 一部分 tab 收在导航的分组下拉里，直接 click 点不到（不可见），
 * 得先把所在的组展开。这是导航从 12 个平铺改成分组之后必须处理的。
 */
const goBoard = async (page, key) => {
  await page.evaluate(k => {
    const btn = document.querySelector('#tab-' + k);
    const grp = btn?.closest('.navgrp');
    if (grp) {
      document.querySelectorAll('.navgrp.open').forEach(g => g.classList.remove('open'));
      grp.classList.add('open');
    }
  }, key);
  await sleep(180);
  await page.click(`#tab-${key}`);
  await until(page, k => document.querySelector(`#v-${k}`)?.classList.contains('on'),
    { label: `${key} 视图切换`, args: [key] });
  await sleep(400);
};

const rowCount = (page, key) =>
  page.$$eval(`#v-${key} .bd-body tr[data-id]`, rs => rs.length);

/**
 * 点某个元素前先把它滚到视口正中。
 * puppeteer 默认滚到顶部，而手机端顶栏是 position:sticky 盖在最上面，
 * 点击会落到顶栏上 —— 表现成「弹窗没打开」，但其实是没点中。
 */
async function clickAt(page, sel) {
  await page.$eval(sel, el => el.scrollIntoView({ block: 'center' }));
  await sleep(220);
  await page.click(sel);
}

const TABS = ['pool', 'formal', 'persona', 'matrix', 'live', 'sales', 'delivery',
              'clients', 'cases', 'funnel', 'stats'];

const BOARD_TABS = {
  persona: ['own', 'benchmark'], matrix: ['own', 'benchmark'], live: ['own', 'benchmark'],
  sales: ['tier', 'filter', 'intake', 'script'],
  delivery: ['product', 'flow'],
  clients: ['', 'S', 'A', 'B', 'C'],
  cases: ['', '推进成功', '复合', '长期稳定', '进行中', '退出'],
};

const CRUD = [
  { key: 'persona',  titleField: 'bdf_title', value: 'E2E-真人作品' },
  { key: 'matrix',   titleField: 'bdf_title', value: 'E2E-矩阵作品' },
  { key: 'live',     titleField: 'bdf_title', value: 'E2E-直播场次' },
  { key: 'sales',    titleField: 'bdf_title', value: 'E2E-话术' },
  { key: 'delivery', titleField: 'bdf_title', value: 'E2E-交付项' },
  { key: 'clients',  titleField: 'bdf_alias', value: 'E2E-客户' },
  { key: 'cases',    titleField: 'bdf_title', value: 'E2E-案例' },
];

/* ================= 一个视口跑一整轮 ================= */

async function runSuite(browser, v) {
  vp = v.name;
  console.log(`\n╔══════════ ${v.name} ${v.w}×${v.h} ══════════╗`);

  const page = await browser.newPage();
  currentPage = page;
  await page.setViewport({
    width: v.w, height: v.h,
    isMobile: v.mobile, hasTouch: v.mobile,   // 这两项决定 CSS 的 pointer:coarse 生不生效
  });

  // confirm() 一律确认。用常驻 handler 而不是每次 once：
  // 某一轮删除失败时那个 once 不会被消费，留到下一轮就会和新 handler 撞成
  // 「Cannot accept dialog which is already handled」。
  page.on('dialog', d => d.accept().catch(() => {}));

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  await page.setCookie({ name: 'ideahub_sid', value: SID, domain: new URL(BASE).hostname, path: '/' });
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await until(page, () => document.querySelector('#poolGrid')?.children.length > 0,
    { label: '首屏加载', timeout: 15000 });

  console.log('\n──── 1. 导航 ────');
  for (const t of TABS) {
    await check(`导航「${t}」能打开`, async () => {
      await goBoard(page, t);
      await until(page, k => document.querySelector(`#v-${k}`)?.classList.contains('on'),
        { label: t, args: [t] });
      await sleep(250);
      const n = await page.$eval(`#v-${t}`, el => el.innerText.trim().length);
      if (n < 5) throw new Error('视图是空的，没渲染出内容');
      return `内容 ${n} 字`;
    });
  }

  console.log('\n──── 2. 小板块切换 ────');
  for (const [key, subs] of Object.entries(BOARD_TABS)) {
    await goBoard(page, key);
    for (const sub of subs) {
      await check(`${key} · 「${sub || '全部'}」`, async () => {
        await page.click(`#v-${key} .bd-tab[data-tab="${sub}"]`);
        await sleep(500);
        const on = await page.$eval(`#v-${key} .bd-tab[data-tab="${sub}"]`, e => e.classList.contains('on'));
        if (!on) throw new Error('点了之后没变成选中态');
        const n = await rowCount(page, key);
        if (n === 0 && !await page.$(`#v-${key} .empty`)) throw new Error('既没有数据行也没有空态提示');
        return `${n} 行`;
      });
    }
  }

  console.log('\n──── 3. 账号台账 ────');
  for (const key of ['persona', 'matrix', 'live']) {
    await check(`${key} · 账号台账能展开`, async () => {
      await goBoard(page, key);
      await page.click(`#v-${key} .bd-acct-toggle`);
      await sleep(300);
      if (await page.$eval(`#v-${key} .acctbox`, e => e.hidden)) throw new Error('点了没展开');
      const n = await page.$$eval(`#v-${key} .acct`, r => r.length);
      await page.click(`#v-${key} .bd-acct-toggle`);
      return `${n} 个账号`;
    });
  }

  console.log('\n──── 4. 增 / 改 / 删 ────');
  for (const c of CRUD) {
    await goBoard(page, c.key);
    const before = await rowCount(page, c.key);

    await check(`${c.key} · 新增`, async () => {
      await clickAt(page, `#v-${c.key} .bd-add`);
      await until(page, () => document.querySelector('#bdModal')?.classList.contains('on'),
        { label: '弹窗打开' });
      await page.type(`#${c.titleField}`, c.value);
      await page.click('#btnBdSave');
      await until(page, () => !document.querySelector('#bdModal')?.classList.contains('on'),
        { label: '弹窗关闭' });
      await sleep(600);
      const after = await rowCount(page, c.key);
      if (after !== before + 1) throw new Error(`行数没变：新增前 ${before}，新增后 ${after}`);
      const has = await page.$$eval(`#v-${c.key} .bd-body tr`, (rs, x) =>
        rs.some(r => r.innerText.includes(x)), c.value);
      if (!has) throw new Error('新增的内容没出现在列表里');
      return `${before} → ${after} 行`;
    });

    await check(`${c.key} · 编辑`, async () => {
      const id = await page.$$eval(`#v-${c.key} .bd-body tr[data-id]`, (rs, x) => {
        const r = rs.find(y => y.innerText.includes(x));
        return r ? r.dataset.id : null;
      }, c.value);
      if (!id) throw new Error('找不到刚新增的那一行');
      await clickAt(page, `#v-${c.key} .bd-body tr[data-id="${id}"] td`);
      await until(page, () => document.querySelector('#bdModal')?.classList.contains('on'),
        { label: '编辑弹窗打开' });
      const cur = await page.$eval(`#${c.titleField}`, e => e.value);
      if (!cur.includes(c.value)) throw new Error(`弹窗没带出原值，读到「${cur}」`);
      await page.click(`#${c.titleField}`, { clickCount: 3 });
      await page.type(`#${c.titleField}`, c.value + '-已改');
      await page.click('#btnBdSave');
      await until(page, () => !document.querySelector('#bdModal')?.classList.contains('on'),
        { label: '弹窗关闭' });
      await sleep(600);
      const has = await page.$$eval(`#v-${c.key} .bd-body tr`, (rs, x) =>
        rs.some(r => r.innerText.includes(x)), c.value + '-已改');
      if (!has) throw new Error('改完之后列表里还是旧值');
      return '改动已回到列表';
    });

    await check(`${c.key} · 删除`, async () => {
      const id = await page.$$eval(`#v-${c.key} .bd-body tr[data-id]`, (rs, x) => {
        const r = rs.find(y => y.innerText.includes(x));
        return r ? r.dataset.id : null;
      }, c.value + '-已改');
      if (!id) throw new Error('找不到要删的那一行');
      await clickAt(page, `#v-${c.key} .bd-body tr[data-id="${id}"] [data-del]`);
      await sleep(900);
      const after = await rowCount(page, c.key);
      if (after !== before) throw new Error(`删完行数不对：期望 ${before}，实际 ${after}`);
      return `回到 ${before} 行`;
    });
  }

  console.log('\n──── 5. 数据漏斗 ────');
  await check('漏斗 · 八步都渲染出来了', async () => {
    await goBoard(page, 'funnel');
    await sleep(900);
    const rows = await page.$$eval('#v-funnel .fnl-row', rs => rs.map(r => ({
      name: r.querySelector('.fnl-lab').innerText,
      val: r.querySelector('.fnl-val').innerText,
    })));
    if (rows.length !== 8) throw new Error(`应该 8 步，实际 ${rows.length} 步`);
    if (rows.every(r => r.val === '0' || r.val === '')) throw new Error('所有数字都是 0，没取到数据');
    return rows.map(r => `${r.name}=${r.val}`).join(' → ');
  });
  await check('漏斗 · 六层指标表', async () => {
    const n = await page.$$eval('#v-funnel tbody tr', rs => rs.length);
    if (n !== 6) throw new Error(`应该 6 层，实际 ${n} 层`);
    const kv = await page.$$eval('#v-funnel .kv', k => k.length);
    if (kv < 20) throw new Error(`指标格子太少（${kv} 个）`);
    return `6 层 · ${kv} 个指标`;
  });

  console.log('\n──── 6. 立项管理（进度 / 负责人 / 方案文档）────');
  await check('正式库的行能点开，立项管理块可见', async () => {
    await goBoard(page, 'formal');
    const id = await page.$$eval('#formalBody tr[data-id]', rs => rs[0]?.dataset.id);
    if (!id) throw new Error('正式库一行都没有');
    await clickAt(page, `#formalBody tr[data-id="${id}"] td`);
    await until(page, () => document.querySelector('#drawer')?.classList.contains('on'),
      { label: '抽屉打开' });
    await sleep(700);
    const vis = await page.$eval('#dProject', e => !e.hidden);
    if (!vis) throw new Error('立项管理块是隐藏的（作者/负责人/管理员应该都看得到）');
    return '可见';
  });

  await check('负责人下拉能列出所有真人（曾经新注册的成员选不到自己）', async () => {
    const opts = await page.$$eval('#dOwner option', os => os.map(o => o.text));
    if (opts.length < 2) throw new Error(`只有 ${opts.length} 个选项：${opts.join('/')}`);
    if (opts[0] !== '未指派') throw new Error('第一项应该是「未指派」');
    return `${opts.length - 1} 个候选`;
  });

  await check('改进度 + 换负责人 → 表格跟着变、流转记录留痕', async () => {
    const before = await page.$eval('#dOwner', e => e.value);
    // 换成候选里的另一个人，改完再换回去，不留痕迹地污染真实数据
    const other = await page.$$eval('#dOwner option',
      (os, cur) => os.filter(o => o.value && o.value !== cur).map(o => o.value)[0], before);
    if (!other) throw new Error('候选不足两人，测不了换人');

    await page.click('#dStages .stage[data-v="50"]');
    await page.select('#dOwner', other);
    await clickAt(page, '#btnSaveProject');
    await sleep(1600);

    const tl = await page.$$eval('#dTl .tl', es => es.map(e => e.innerText));
    if (!tl.some(t => t.includes('把进度更新到 50%'))) throw new Error('流转记录里没有进度变更');
    if (!tl.some(t => t.includes('把负责人改为'))) throw new Error('流转记录里没有负责人变更');

    // 关掉抽屉，正式库那一行应该已经是新值
    await page.evaluate(() => document.querySelector('#drawer .btn[data-close]')?.click());
    await sleep(900);
    const shown = await page.$$eval('#formalBody tr[data-id]', rs => rs[0]?.innerText || '');
    if (!shown.includes('50%')) throw new Error(`表格没更新，那一行是「${shown.replace(/\n/g, ' ')}」`);

    // 还原
    await clickAt(page, '#formalBody tr[data-id] td');
    await until(page, () => document.querySelector('#drawer')?.classList.contains('on'),
      { label: '抽屉重开' });
    await sleep(700);
    await page.click('#dStages .stage[data-v="0"]');
    await page.select('#dOwner', before);
    await clickAt(page, '#btnSaveProject');
    await sleep(1400);
    await page.evaluate(() => document.querySelector('#drawer .btn[data-close]')?.click());
    await sleep(600);
    return '已改并已还原';
  });

  console.log('\n──── 7. 客户档案附件 ────');
  await check('新建时就能选附件（不用先保存再回来传）', async () => {
    await goBoard(page, 'clients');
    await clickAt(page, '#v-clients .bd-add');
    await until(page, () => document.querySelector('#bdModal')?.classList.contains('on'),
      { label: '弹窗打开' });
    await until(page, () => !!document.querySelector('#bdFileInput'), { label: '附件区就绪' });

    const dateVal = await page.$eval('#bdf_reportDate, input[type=date]', e => e.value).catch(() => '');
    const input = await page.$('#bdFileInput');
    await input.uploadFile(E2E_FILE);
    await until(page, () => document.querySelector('#bdFiles')?.innerText.includes('待上传'),
      { label: '文件进入待上传队列' });
    // 移除按钮要能把它撤下来
    await page.evaluate(() => document.querySelector('#bdFiles [data-pending]')?.click());
    await sleep(300);
    const gone = await page.$eval('#bdFiles', e => !e.innerText.includes('待上传'));
    if (!gone) throw new Error('点了移除但文件还在队列里');

    await page.evaluate(() => document.querySelector('#bdModal .btn[data-close]')?.click());
    await sleep(400);
    return dateVal ? `队列可增可删 · 日期默认 ${dateVal}` : '队列可增可删';
  });

  await check('新建时日期默认今天', async () => {
    await goBoard(page, 'persona');
    await clickAt(page, '#v-persona .bd-add');
    await until(page, () => document.querySelector('#bdModal')?.classList.contains('on'),
      { label: '弹窗打开' });
    await sleep(300);
    const v = await page.$eval('#bdf_publishedAt', e => e.value);
    const today = new Date();
    const want = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 10);
    await page.evaluate(() => document.querySelector('#bdModal .btn[data-close]')?.click());
    await sleep(300);
    if (v !== want) throw new Error(`日期是「${v}」，期望「${want}」`);
    return v;
  });

  await check('上传 → 出现在列表 → 表格计数 +1 → 删除还原', async () => {
    await goBoard(page, 'clients');
    const id = await page.$$eval('#v-clients .bd-body tr[data-id]', rs => rs[0]?.dataset.id);
    if (!id) throw new Error('一条客户都没有');

    // 按列名取「报告」那一格的数字。
    // 原来是用 /📎\s*(\d+)/ 匹配 innerText —— 图标从 emoji 换成 SVG 之后就失配了。
    // 断言不该依赖图标长什么样，那是随时会变的表现层。
    const countOf = () => page.$$eval('#v-clients .bd-body tr[data-id]',
      (rs, i) => {
        const td = rs.find(r => r.dataset.id === i)?.querySelector('td[data-label="报告"]');
        const m = (td?.innerText || '').match(/(\d+)/);
        return m ? m[1] : '0';
      }, id);
    const before = Number(await countOf());

    await clickAt(page, `#v-clients .bd-body tr[data-id="${id}"] td`);
    await until(page, () => document.querySelector('#bdModal')?.classList.contains('on'),
      { label: '编辑弹窗打开' });
    await until(page, () => !!document.querySelector('#bdFileInput'),
      { label: '附件区加载完' });

    const input = await page.$('#bdFileInput');
    await input.uploadFile(E2E_FILE);
    await until(page, () => [...document.querySelectorAll('#bdFiles .fileitem a')]
      .some(a => a.innerText.includes('E2E-附件')), { label: '文件出现在列表里', timeout: 15000 });

    // 关掉弹窗，表格那一行的 📎 计数应该 +1
    await page.evaluate(() => document.querySelector('#bdModal .btn[data-close]')?.click());
    await sleep(1000);
    const mid = Number(await countOf());
    if (mid !== before + 1) throw new Error(`表格计数没变：上传前 ${before}，上传后 ${mid}`);

    // 打开这个文件，确认真能取到（而不是只在数据库里有一行）
    const url = await page.evaluate(async (cid) => {
      const r = await fetch(`/api/clients/${cid}/files`, { credentials: 'include' });
      const d = await r.json();
      return d.items.find(f => f.name.includes('E2E-附件'))?.url;
    }, id);
    if (!url) throw new Error('接口里查不到刚上传的文件');
    const head = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return { status: r.status, csp: r.headers.get('content-security-policy'), len: (await r.text()).length };
    }, url);
    if (head.status !== 200) throw new Error(`打开文件返回 ${head.status}`);
    if (!head.len) throw new Error('文件内容是空的');
    if (!/sandbox/.test(head.csp || '')) throw new Error(`HTML 报告没有 sandbox 隔离，CSP 是「${head.csp}」`);

    // 删掉还原
    await clickAt(page, `#v-clients .bd-body tr[data-id="${id}"] td`);
    await until(page, () => !!document.querySelector('#bdFiles .fdel'), { label: '附件列表加载' });
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('#bdFiles .fileitem')]
        .find(x => x.innerText.includes('E2E-附件'));
      item?.querySelector('.fdel')?.click();
    });
    await sleep(1200);
    await page.evaluate(() => document.querySelector('#bdModal .btn[data-close]')?.click());
    await sleep(1000);
    const after = Number(await countOf());
    if (after !== before) throw new Error(`删完计数不对：期望 ${before}，实际 ${after}`);
    return `${before} → ${mid} → ${after} · CSP 已隔离`;
  });

  console.log('\n──── 8. 实时推送（两个客户端）────');
  await check('别人改了数据，我这边不刷新也能看到', async () => {
    // 这条测的是 SSE 事件分发本身。曾经因为前端的具名事件白名单没跟上后端，
    // board:updated / notify:ping / chat:ping 三种推送静默失效了很久 ——
    // 而单客户端的测试全都是绿的，因为每个客户端在自己操作后会主动重渲染。
    // 所以这里必须开第二个客户端来触发。
    const ctx = await browser.createBrowserContext();   // 独立上下文：cookie 不互相顶掉
    const other = await ctx.newPage();
    try {
      await other.setCookie({ name: 'ideahub_sid', value: SID, domain: new URL(BASE).hostname, path: '/' });
      await other.goto(BASE, { waitUntil: 'domcontentloaded' });
      await sleep(800);

      await goBoard(page, 'clients');
      // 必须切到「全部」：前面的小板块测试会把它停在「C 级」上，
      // 而新建的客户没有等级，在那个筛选下压根不会出现 —— 那是筛选问题，不是推送问题
      await page.click('#v-clients .bd-tab[data-tab=""]');
      await sleep(700);
      const before = await rowCount(page, 'clients');

      // 用另一个客户端建一条，当前这个页面不做任何操作
      const alias = 'E2E-推送' + Date.now().toString().slice(-5);
      await other.evaluate(a => fetch('/api/clients', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: a }), credentials: 'include',
      }), alias);

      const t0 = Date.now();
      let after = before;
      while (Date.now() - t0 < 10000) {
        after = await rowCount(page, 'clients');
        if (after > before) break;
        await sleep(200);
      }
      // 不管推送通不通都要把这条清掉，别留给下一轮
      await other.evaluate(async a => {
        const d = await (await fetch('/api/clients', { credentials: 'include' })).json();
        const hit = d.items.find(x => x.alias === a);
        if (hit) await fetch('/api/clients/' + hit.id, { method: 'DELETE', credentials: 'include' });
      }, alias);

      if (after <= before) throw new Error(`别的客户端建了一条，这边 ${before} 行没变 —— 推送没到`);
      return `${before} → ${after} 行，用时 ${Date.now() - t0}ms`;
    } finally {
      await other.close();
      await ctx.close();
    }
  });

  console.log('\n──── 9. 原有功能 ────');
  await check('灵感池', async () => {
    await goBoard(page, 'pool');
    const n = await page.$$eval('#poolGrid .card[data-id]', c => c.length);
    if (!n) throw new Error('一张卡都没有');
    return `${n} 张卡`;
  });
  await check('正式库', async () => {
    await goBoard(page, 'formal');
    const n = await page.$$eval('#formalBody tr[data-id]', r => r.length);
    if (!n) throw new Error('一行都没有');
    return `${n} 行`;
  });
  await check('统计页', async () => {
    await goBoard(page, 'stats');
    await sleep(600);
    const cards = await page.$$eval('#statKeyGrid .stat-key-card', list =>
      list.map(card => ({ label: card.querySelector('.stat-key-top span')?.textContent,
        value: card.querySelector('.stat-key-value')?.textContent })));
    const steps = await page.$$eval('#salesFlow .sales-step', list => list.length);
    if (cards.length !== 5 || cards.some(card => !card.value)) throw new Error('五个关键数字没有完整显示');
    if (steps !== 5) throw new Error(`销售漏斗应有 5 层（实际 ${steps}）`);
    return `${cards.length} 个关键数字，${steps} 层销售漏斗`;
  });

  /* ---------- 手机专属 ---------- */
  if (v.mobile) {
    console.log('\n──── 10. 手机专属 ────');

    await check('导航没被挤没（曾经是 0 宽，一个板块都点不到）', async () => {
      await goBoard(page, 'pool');
      const w = await page.$eval('.nav', e => Math.round(e.getBoundingClientRect().width));
      if (w < 200) throw new Error(`导航只有 ${w}px 宽`);
      return `${w}px`;
    });

    await check('整页没有横向溢出', async () => {
      const worst = [];
      for (const t of ['pool', 'clients', 'cases', 'delivery', 'funnel']) {
        await goBoard(page, t);
        await sleep(350);
        const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (o > 0) worst.push(`${t} 溢出 ${o}px`);
      }
      if (worst.length) throw new Error(worst.join('；'));
      return '五个板块都不溢出';
    });

    await check('页面能上下滚（曾经两层都不滚，只能看顶部一屏）', async () => {
      await goBoard(page, 'delivery');
      await sleep(400);
      const r = await page.evaluate(() => {
        const m = document.querySelector('#main');
        const canScroll = document.documentElement.scrollHeight > window.innerHeight
                       || m.scrollHeight > m.clientHeight;
        window.scrollBy(0, 400); m.scrollTop += 400;
        return { canScroll, y: Math.round(window.scrollY), my: Math.round(m.scrollTop) };
      });
      if (!r.canScroll) throw new Error('内容没超过一屏，这条测不出来（换个内容更长的板块）');
      if (r.y === 0 && r.my === 0) throw new Error('内容超过一屏但滚不动');
      return `滚动了 ${r.y || r.my}px`;
    });

    await check('卡片墙在手机上是 1 列', async () => {
      await goBoard(page, 'pool');
      const cols = await page.$eval('#poolGrid', e =>
        getComputedStyle(e).gridTemplateColumns.split(' ').length);
      if (cols !== 1) throw new Error(`是 ${cols} 列`);
      return '1 列';
    });

    await check('宽表格进入卡片模式（表头隐藏、每格带字段名）', async () => {
      await goBoard(page, 'clients');
      await sleep(400);
      const r = await page.evaluate(() => {
        const head = document.querySelector('#v-clients thead');
        const td = document.querySelector('#v-clients .bd-body td[data-label]');
        return {
          headHidden: getComputedStyle(head).display === 'none',
          labeled: !!td,
          before: td ? getComputedStyle(td, '::before').content : '',
        };
      });
      if (!r.headHidden) throw new Error('表头还显示着，没进卡片模式');
      if (!r.labeled) throw new Error('单元格没有 data-label，卡片模式下看不出哪个字段是哪个');
      return '表头已隐藏 · 字段名已注入';
    });

    await check(`所有可点元素 ≥ ${TAP_MIN}px（曾经只有 24–34px）`, async () => {
      await goBoard(page, 'clients');
      await page.evaluate(() => document.querySelector('#meAvatar').click());
      await sleep(400);
      const small = await page.evaluate((min) => {
        const out = [], seen = new Set();
        for (const el of document.querySelectorAll('button,.chip,.check,.menuitem,.vote')) {
          // 关闭状态的弹窗只是 opacity:0，并没有脱离布局，而且带着 transform:scale(.94)。
          // 不排掉的话会量到「藏起来的那一份」，40px 的按钮会被算成 38px。
          if (!el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) continue;
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height) continue;
          const k = (el.className || el.tagName) + '';
          if (seen.has(k)) continue; seen.add(k);
          if (b.height < min) out.push(`${k.slice(0, 24)} ${Math.round(b.height)}px`);
        }
        return out;
      }, TAP_MIN);
      await page.evaluate(() => document.querySelector('#userMenu')?.classList.remove('on'));
      if (small.length) throw new Error(small.join('；'));
      return '全部达标';
    });

    await check('弹窗不超出屏幕（采纳弹窗曾经横着溢出 80px）', async () => {
      const bad = [];
      // 板块的通用弹窗
      await goBoard(page, 'clients');
      await page.click('#v-clients .bd-add'); await sleep(700);
      const a = await page.evaluate(() => {
        const r = document.querySelector('#bdModal').getBoundingClientRect();
        return { l: Math.round(r.left), r: Math.round(r.right), w: window.innerWidth };
      });
      if (a.l < 0 || a.r > a.w) bad.push(`板块弹窗 ${a.l}~${a.r} / ${a.w}`);
      await page.evaluate(() => document.querySelector('#bdModal .btn[data-close]')?.click());
      await sleep(500);
      // 采纳弹窗（行内 style="width:470px" 就是在这里溢出的）
      await goBoard(page, 'pool');
      await page.click('#poolGrid .card[data-id]'); await sleep(900);
      await page.evaluate(() => document.querySelector('#btnAdopt')?.click()); await sleep(900);
      const b2 = await page.evaluate(() => {
        const el = document.querySelector('#adoptModal');
        if (!el?.classList.contains('on')) return null;
        const r = el.getBoundingClientRect();
        return { l: Math.round(r.left), r: Math.round(r.right), w: window.innerWidth,
                 owners: document.querySelectorAll('#adoptOwner option').length };
      });
      if (b2 && (b2.l < 0 || b2.r > b2.w)) bad.push(`采纳弹窗 ${b2.l}~${b2.r} / ${b2.w}`);
      await page.evaluate(() => document.querySelector('#mask')?.click());
      await sleep(400);
      if (bad.length) throw new Error(bad.join('；'));
      return b2 ? `都在屏内 · 负责人可选 ${b2.owners} 人` : '都在屏内';
    });

    await check('输入框字号 ≥16px（低于 16px 时 iOS 聚焦会自动放大整页）', async () => {
      await goBoard(page, 'clients');
      await page.click('#v-clients .bd-add'); await sleep(700);
      const fs = await page.$eval('#bdf_alias', e => parseFloat(getComputedStyle(e).fontSize));
      await page.evaluate(() => document.querySelector('#bdModal .btn[data-close]')?.click());
      await sleep(400);
      if (fs < 16) throw new Error(`只有 ${fs}px`);
      return `${fs}px`;
    });
  }

  console.log('\n──── 控制台报错 ────');
  await check('整轮点下来没有 JS 报错', async () => {
    const real = consoleErrors.filter(e => !/favicon/i.test(e));
    if (real.length) throw new Error(real.slice(0, 5).join('\n       '));
    return '干净';
  });

  await page.close();
}

/* ================= 主流程 ================= */

// 上传测试要有个真文件。故意用带 <script> 的 HTML —— 顺便验证沙箱头还在。
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
const E2E_FILE = pjoin(tmpdir(), 'E2E-附件.html');
writeFileSync(E2E_FILE,
  '<!doctype html><meta charset="utf-8"><h1>E2E 测试报告</h1><script>console.log(1)</script>');

const browser = await puppeteer.launch({
  headless: !process.argv.includes('--headed'),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

for (const v of VIEWPORTS) await runSuite(browser, v);
await browser.close();
try { unlinkSync(E2E_FILE); } catch { /* 已经没了 */ }

console.log(`\n════════ 合计：${pass.length} 通过 / ${fail.length} 失败 ════════`);
if (fail.length) {
  for (const f of fail) console.log(`  ❌ [${f.vp}] ${f.name}: ${f.why}`);
  process.exit(1);
}
