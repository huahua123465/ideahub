/** 统计看板 */
import { query } from '../db/index.mjs';
import { sendJson } from '../lib/http.mjs';

export function mount(router) {
  router.get('/api/stats/overview', async (req, res) => {
    const { rows: byStatus } = await query(
      `SELECT status::text AS status, count(*)::int AS n
         FROM ideas WHERE deleted_at IS NULL GROUP BY status`);
    const m = Object.fromEntries(byStatus.map(r => [r.status, r.n]));

    const total    = byStatus.reduce((s, r) => s + r.n, 0);
    const pending  = (m.pending || 0) + (m.reviewing || 0);
    const adopted  = m.adopted || 0;
    const reviewed = adopted + (m.rejected || 0);

    // 固定的五个分类要全部出现，哪怕一条都没有 ——
    // 「没人往这个分类提灵感」本身就是信息，直接从图上消失反而看不出来。
    const { rows: cat } = await query(`
      WITH cats AS (
        SELECT unnest(ARRAY['产品','技术','运营','流程','其他']) AS name
        UNION
        SELECT DISTINCT category FROM ideas
      )
      SELECT c.name AS category, count(i.id)::int AS n
      FROM cats c LEFT JOIN ideas i ON i.category = c.name AND i.deleted_at IS NULL
      GROUP BY c.name ORDER BY n DESC, c.name`);

    const { rows: month } = await query(`
      SELECT
        count(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS new_this_month,
        count(*) FILTER (WHERE adopted_at >= date_trunc('month', now()))::int AS adopted_this_month
      FROM ideas WHERE deleted_at IS NULL`);

    const { rows: oldest } = await query(`
      SELECT EXTRACT(DAY FROM now() - min(created_at))::int AS days
      FROM ideas WHERE status = 'pending' AND deleted_at IS NULL`);

    // 漏斗：进入评审 = 除了还在 pending 的，都算被看过
    const { rows: landed } = await query(
      `SELECT count(*)::int AS n FROM ideas
        WHERE status='adopted' AND progress >= 100 AND deleted_at IS NULL`);

    // 资料库总览（任务 15）：任务表要求「每个数字都能点回或知道是从哪类记录统计出来的」，
    // 所以每一项都带上 board —— 前端把它做成可点的，点了直接跳到对应模块。
    const { rows: lib } = await query(`
      SELECT
        (SELECT count(*) FROM ideas WHERE deleted_at IS NULL AND status IN ('pending','reviewing'))::int AS 灵感,
        (SELECT count(*) FROM ideas WHERE deleted_at IS NULL AND status = 'adopted')::int AS 正式内容,
        (SELECT count(*) FROM demands WHERE deleted_at IS NULL)::int AS 用户需求,
        (SELECT count(*) FROM clients WHERE deleted_at IS NULL)::int AS 客户,
        (SELECT count(*) FROM cases WHERE deleted_at IS NULL)::int AS 案例,
        (SELECT count(*) FROM works WHERE deleted_at IS NULL)::int AS 作品`);

    const library = [
      { name: '灵感池',   value: lib[0].灵感,     board: 'pool',    note: '待评审 + 评审中' },
      { name: '用户需求', value: lib[0].用户需求, board: 'demands', note: '用户需求模块' },
      { name: '正式内容', value: lib[0].正式内容, board: 'formal',  note: '已采纳的灵感' },
      { name: '客户',     value: lib[0].客户,     board: 'clients', note: '客户档案' },
      { name: '案例',     value: lib[0].案例,     board: 'cases',   note: '案例库' },
    ];

    // 基础销售漏斗只使用客户当前阶段，不要求业务人员再维护一份统计表。
    // 后一阶段代表已经走过前面的阶段，所以每层都是累计到达人数。
    const { rows: clientStages } = await query(`
      SELECT stage::text AS stage, count(*)::int AS n
        FROM clients WHERE deleted_at IS NULL GROUP BY stage`);
    const stageCount = Object.fromEntries(clientStages.map(r => [r.stage, r.n]));
    const reached = stages => stages.reduce((sum, stage) => sum + (stageCount[stage] || 0), 0);
    const salesFunnel = [
      {
        name: '有效客资',
        value: reached(['lead','wechat','profiled','consulted','coaching','renewed']),
        stages: ['lead','wechat','profiled','consulted','coaching','renewed'],
        source: '客户档案 · 排除已流失',
      },
      {
        name: '已加微信',
        value: reached(['wechat','profiled','consulted','coaching','renewed']),
        stages: ['wechat','profiled','consulted','coaching','renewed'],
        source: '客户阶段 · 已加微信及以后',
      },
      {
        name: '已咨询',
        value: reached(['consulted','coaching','renewed']),
        stages: ['consulted','coaching','renewed'],
        source: '客户阶段 · 已咨询及以后',
      },
      {
        name: '陪跑成交',
        value: reached(['coaching','renewed']),
        stages: ['coaching','renewed'],
        source: '客户阶段 · 陪跑中及以后',
      },
      {
        name: '续费/转介绍',
        value: reached(['renewed']),
        stages: ['renewed'],
        source: '客户阶段 · 已续费',
      },
    ];
    for (let i = 0; i < salesFunnel.length; i++) {
      salesFunnel[i].conversion = i === 0 ? 100
        : salesFunnel[i - 1].value
          ? Math.round(salesFunnel[i].value / salesFunnel[i - 1].value * 1000) / 10
          : null;
    }

    sendJson(res, 200, {
      library,
      salesFunnel,
      tiles: {
        total,
        pending,
        adopted,
        adoptRate: reviewed ? Math.round(adopted / reviewed * 100) : 0,
        newThisMonth: month[0]?.new_this_month ?? 0,
        adoptedThisMonth: month[0]?.adopted_this_month ?? 0,
        oldestPendingDays: oldest[0]?.days ?? 0,
      },
      byCategory: cat.map(r => ({ name: r.category, value: r.n })),
      funnel: [
        { name: '提交',     value: total },
        { name: '进入评审', value: total - (m.pending || 0) },
        { name: '已采纳',   value: adopted },
        { name: '已落地',   value: landed[0]?.n ?? 0 },
      ],
      byStatus: m,
    });
  });

  /** 热度重算。定时任务每 15 分钟调一次。 */
  router.post('/api/maintenance/recalc-hot', async (req, res) => {
    await query('SELECT recalc_hot_scores()');
    sendJson(res, 200, { ok: true, at: new Date().toISOString() });
  });
}
