/**
 * 客户档案（PDF 05）、案例库（PDF 09）、数据漏斗看板（PDF 11）。
 *
 * 漏斗刻意不做成「手工填数的周报表」——那种表没人愿意填，填了也没人信。
 * 这里每一层都是从 works.metrics 和 clients.stage 直接数出来的，
 * 台账录进去漏斗自己就动了。这也是 PDF 11「每一步都要可量化」的落地方式。
 *
 * 脱敏：clients.alias 存化名、evidence 只存「有哪些材料」的清单而不是文件本身，
 * 对应 PDF 09 里助理/运营那条 SOP：「脱敏、标签、录入」。
 */
import { query } from '../db/index.mjs';
import { readJson, sendJson, q, need, badRequest, notFound, forbidden } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { publish } from '../lib/bus.mjs';
import { sourceOf, sourceRow } from '../lib/entity.mjs';
import { loadTags, setTags, clearTags, tagWhere } from '../lib/tags.mjs';

const STAGES = ['lead', 'wechat', 'profiled', 'consulted', 'coaching', 'renewed', 'lost'];
const TIERS = ['S', 'A', 'B', 'C'];

/** 漏斗里「走到过这一层」的判定：后面的阶段都算走过前面的。
    只有 lost 例外 —— 流失的人不该继续算在任何一层的分子里。 */
const REACHED = {
  wechat:    ['wechat', 'profiled', 'consulted', 'coaching', 'renewed'],
  profiled:  ['profiled', 'consulted', 'coaching', 'renewed'],
  consulted: ['consulted', 'coaching', 'renewed'],
  coaching:  ['coaching', 'renewed'],
  renewed:   ['renewed'],
};

const str = (v) => (v == null || v === '' ? null : String(v).trim());
const obj = (v) => JSON.stringify(v && typeof v === 'object' ? v : {});

function clientRow(r, tags = []) {
  return {
    id: Number(r.id), alias: r.alias, tier: r.tier, stage: r.stage,
    source: r.source,
    ...sourceRow(r),
    externalId: r.external_id || null,
    // 技术2 写进来的两份分析，任务表要求分别显示，所以分两个字段吐出去
    aiSituation: r.ai_situation || null,
    aiUser: r.ai_user || null,
    aiUpdatedAt: r.ai_updated_at || null,
    deal: r.deal || {},
    tags, tagIds: tags.map(t => t.id),
    ownerId: r.owner_id ? Number(r.owner_id) : null,
    ownerName: r.owner_name || null,
    female: r.female || {}, male: r.male || {}, relation: r.relation || {},
    timeline: r.timeline, evidence: r.evidence, note: r.note,
    fileCount: Number(r.file_count) || 0,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function caseRow(r, tags = []) {
  return {
    id: Number(r.id), clientId: r.client_id ? Number(r.client_id) : null,
    ...sourceRow(r),
    tags, tagIds: tags.map(t => t.id),
    clientAlias: r.client_alias || null,
    code: r.code, title: r.title,
    clientTags: r.client_tags, maleTags: r.male_tags,
    problem: r.problem, judgement: r.judgement, strategy: r.strategy,
    feedback: r.feedback, outcome: r.outcome, reusable: !!r.reusable,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * 谁能删：所有登录用户。
 *
 * 原来限管理员，理由是「删掉了别人不知道少了什么」。任务表要求业务人员
 * 自己就能清理无用记录，所以放开了 —— 配套把硬删改成软删，
 * 记录仍在库里，误删可以恢复。两件事必须一起做，只放开权限就是在等事故。
 */
async function assertCanDelete(req) {
  return currentUser(req);
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export function mount(router) {

  /* ==================== 客户档案 ==================== */

  router.get('/api/clients', async (req, res, _p, url) => {
    await currentUser(req);
    const where = ['c.deleted_at IS NULL'], args = [];
    const stageList = (q(url, 'stages') || q(url, 'stage') || '')
      .split(',').map(x => x.trim()).filter(Boolean);
    if (stageList.length) {
      if (stageList.some(stage => !STAGES.includes(stage))) throw badRequest('stage 不合法');
      args.push([...new Set(stageList)]);
      where.push(`c.stage = ANY($${args.length}::client_stage[])`);
    }
    const tier = q(url, 'tier');
    if (tier) { args.push(tier); where.push(`c.tier = $${args.length}`); }

    // 统一标签筛选（任务 6）：和灵感、需求、案例用的是同一套字典
    const tagClause = tagWhere('client', (q(url, 'tagIds') || '').split(',').filter(Boolean),
                               args, 'c.id');
    if (tagClause) where.push(tagClause);

    const kw = q(url, 'q');
    if (kw) {
      args.push('%' + kw + '%');
      const pk = '$' + args.length;
      where.push(`(c.alias ILIKE ${pk} OR c.note ILIKE ${pk} OR c.timeline ILIKE ${pk})`);
    }

    const { rows } = await query(
      `SELECT c.*, u.name AS owner_name,
              (SELECT count(*) FROM attachments f WHERE f.scope = 'client' AND f.ref_id = c.id)::int AS file_count
         FROM clients c LEFT JOIN users u ON u.id = c.owner_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY array_position(ARRAY['S','A','B','C'], c.tier), c.updated_at DESC`, args);
    const tagMap = await loadTags('client', rows.map(r => r.id));
    sendJson(res, 200, { items: rows.map(r => clientRow(r, tagMap.get(Number(r.id)) || [])) });
  });

  router.post('/api/clients', async (req, res) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    if (b.tier && !TIERS.includes(b.tier)) throw badRequest('客资等级只能是 S / A / B / C');
    if (b.stage && !STAGES.includes(b.stage)) throw badRequest('stage 不合法');

    const src = sourceOf(b);
    const { rows } = await query(
      `INSERT INTO clients(alias, tier, stage, source, owner_id, female, male, relation, timeline, evidence, note,
                           source_type, source_url, source_ref)
       VALUES($1,$2,$3::client_stage,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [need(b, 'alias', { max: 40, label: '化名' }), str(b.tier), b.stage || 'lead',
       str(b.source), b.ownerId ? Number(b.ownerId) : me.id,
       obj(b.female), obj(b.male), obj(b.relation),
       str(b.timeline), str(b.evidence), str(b.note),
       src.source_type, src.source_url, src.source_ref]);
    await setTags('client', Number(rows[0].id), b.tagIds);
    sendJson(res, 201, clientRow(rows[0], await tagsFor('client', rows[0].id)));
    publish('board:updated', { board: 'clients' });
  });

  router.patch('/api/clients/:id', async (req, res, params) => {
    await currentUser(req);
    const b = await readJson(req);
    const sets = [], args = [];
    const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
    if (b.alias !== undefined) set('alias', need(b, 'alias', { max: 40, label: '化名' }));
    if (b.tier !== undefined) {
      if (b.tier && !TIERS.includes(b.tier)) throw badRequest('客资等级只能是 S / A / B / C');
      set('tier', str(b.tier));
    }
    // 空字符串当「没选，别改」处理。前端的下拉有个「—」选项，
    // 用户碰了它就会传空串过来，按不合法直接 400 会让整次保存都失败。
    if (b.stage !== undefined && b.stage !== '') {
      if (!STAGES.includes(b.stage)) throw badRequest('stage 不合法');
      args.push(b.stage); sets.push(`stage = $${args.length}::client_stage`);
    }
    if (b.source !== undefined) set('source', str(b.source));
    if (b.ownerId !== undefined) set('owner_id', b.ownerId ? Number(b.ownerId) : null);
    for (const k of ['female', 'male', 'relation']) {
      if (b[k] !== undefined) { args.push(obj(b[k])); sets.push(`${k} = $${args.length}::jsonb`); }
    }
    if (b.timeline !== undefined) set('timeline', str(b.timeline));
    if (b.evidence !== undefined) set('evidence', str(b.evidence));
    if (b.note !== undefined) set('note', str(b.note));
    // AI 两份分析平时由技术2 写，但业务人员也要能补充和更正 ——
    // 技术2 还没接上的时候，这两个区不该是只能干看着的空框
    if (b.aiSituation !== undefined) { set('ai_situation', str(b.aiSituation)); sets.push('ai_updated_at = now()'); }
    if (b.aiUser !== undefined) { set('ai_user', str(b.aiUser)); sets.push('ai_updated_at = now()'); }
    if (b.deal !== undefined) { args.push(obj(b.deal)); sets.push(`deal = $${args.length}::jsonb`); }
    for (const [col, val] of Object.entries(sourceOf(b, { partial: true }))) set(col, val);

    const id = Number(params.id);
    if (!sets.length && b.tagIds === undefined) throw badRequest('没有要修改的字段');

    let row;
    if (sets.length) {
      args.push(id);
      const { rows } = await query(
        `UPDATE clients SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $${args.length} AND deleted_at IS NULL RETURNING *`, args);
      if (!rows[0]) throw notFound('没有这个客户');
      row = rows[0];
    } else {
      const { rows } = await query(
        'SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!rows[0]) throw notFound('没有这个客户');
      row = rows[0];
    }
    await setTags('client', id, b.tagIds);
    sendJson(res, 200, clientRow(row, await tagsFor('client', id)));
    publish('board:updated', { board: 'clients' });
  });

  router.del('/api/clients/:id', async (req, res, params) => {
    await assertCanDelete(req);
    const cid = Number(params.id);
    const { rows } = await query(
      'UPDATE clients SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [cid]);
    if (!rows[0]) throw notFound('没有这个客户');
    await clearTags('client', cid);
    await query(`DELETE FROM links WHERE (from_entity='client' AND from_id=$1)
                                      OR (to_entity='client' AND to_id=$1)`, [cid]);
    sendJson(res, 200, { ok: true });
    publish('board:updated', { board: 'clients' });
  });

  /* ==================== 案例库 ==================== */

  router.get('/api/cases', async (req, res, _p, url) => {
    await currentUser(req);
    const where = ['c.deleted_at IS NULL'], args = [];
    const outcome = q(url, 'outcome');
    if (outcome) { args.push(outcome); where.push(`c.outcome = $${args.length}`); }
    if (q(url, 'reusable') === '1') where.push('c.reusable');
    const clientId = q(url, 'clientId');
    if (clientId) { args.push(Number(clientId)); where.push(`c.client_id = $${args.length}`); }

    const tagClause = tagWhere('case', (q(url, 'tagIds') || '').split(',').filter(Boolean), args, 'c.id');
    if (tagClause) where.push(tagClause);

    const kw = q(url, 'q');
    if (kw) {
      args.push('%' + kw + '%');
      const pk = '$' + args.length;
      where.push(`(c.title ILIKE ${pk} OR c.problem ILIKE ${pk} OR c.judgement ILIKE ${pk}
                   OR c.strategy ILIKE ${pk} OR c.client_tags ILIKE ${pk})`);
    }

    const { rows } = await query(
      `SELECT c.*, cl.alias AS client_alias
         FROM cases c LEFT JOIN clients cl ON cl.id = c.client_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY c.id DESC`, args);
    const tagMap = await loadTags('case', rows.map(r => r.id));
    sendJson(res, 200, { items: rows.map(r => caseRow(r, tagMap.get(Number(r.id)) || [])) });
  });

  router.post('/api/cases', async (req, res) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    const sc = sourceOf(b);
    const { rows } = await query(
      `INSERT INTO cases(client_id, code, title, client_tags, male_tags, problem,
                         judgement, strategy, feedback, outcome, reusable, created_by,
                         source_type, source_url, source_ref)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [b.clientId ? Number(b.clientId) : null, str(b.code),
       need(b, 'title', { max: 120, label: '标题' }),
       str(b.clientTags), str(b.maleTags), str(b.problem), str(b.judgement),
       str(b.strategy), str(b.feedback), str(b.outcome),
       b.reusable === true || b.reusable === '1' || b.reusable === 'true', me.id,
       sc.source_type, sc.source_url, sc.source_ref]);
    await setTags('case', Number(rows[0].id), b.tagIds);
    sendJson(res, 201, caseRow(rows[0], await tagsFor('case', rows[0].id)));
    publish('board:updated', { board: 'cases' });
  });

  router.patch('/api/cases/:id', async (req, res, params) => {
    await currentUser(req);
    const b = await readJson(req);
    const sets = [], args = [];
    const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
    if (b.clientId !== undefined) set('client_id', b.clientId ? Number(b.clientId) : null);
    if (b.code !== undefined) set('code', str(b.code));
    if (b.title !== undefined) set('title', need(b, 'title', { max: 120, label: '标题' }));
    for (const [k, col] of [['clientTags', 'client_tags'], ['maleTags', 'male_tags'],
                            ['problem', 'problem'], ['judgement', 'judgement'],
                            ['strategy', 'strategy'], ['feedback', 'feedback'],
                            ['outcome', 'outcome']]) {
      if (b[k] !== undefined) set(col, str(b[k]));
    }
    if (b.reusable !== undefined) {
      set('reusable', b.reusable === true || b.reusable === '1' || b.reusable === 'true');
    }
    for (const [col, val] of Object.entries(sourceOf(b, { partial: true }))) set(col, val);

    const cid = Number(params.id);
    if (!sets.length && b.tagIds === undefined) throw badRequest('没有要修改的字段');

    let row;
    if (sets.length) {
      args.push(cid);
      const { rows } = await query(
        `UPDATE cases SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $${args.length} AND deleted_at IS NULL RETURNING *`, args);
      if (!rows[0]) throw notFound('没有这个案例');
      row = rows[0];
    } else {
      const { rows } = await query(
        'SELECT * FROM cases WHERE id = $1 AND deleted_at IS NULL', [cid]);
      if (!rows[0]) throw notFound('没有这个案例');
      row = rows[0];
    }
    await setTags('case', cid, b.tagIds);
    sendJson(res, 200, caseRow(row, await tagsFor('case', cid)));
    publish('board:updated', { board: 'cases' });
  });

  router.del('/api/cases/:id', async (req, res, params) => {
    await assertCanDelete(req);
    const kid = Number(params.id);
    const { rows } = await query(
      'UPDATE cases SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [kid]);
    if (!rows[0]) throw notFound('没有这个案例');
    await clearTags('case', kid);
    await query(`DELETE FROM links WHERE (from_entity='case' AND from_id=$1)
                                      OR (to_entity='case' AND to_id=$1)`, [kid]);
    sendJson(res, 200, { ok: true });
    publish('board:updated', { board: 'cases' });
  });

  /* ==================== 数据漏斗看板（PDF 11） ==================== */

  router.get('/api/funnel', async (req, res) => {
    await currentUser(req);

    // 内容侧：只数自己的号，对标账号的数据是拿来研究的，不该算进自己的漏斗
    const { rows: cm } = await query(`
      SELECT
        coalesce(sum((metrics->>'曝光')::numeric), 0)::bigint      AS 曝光,
        coalesce(sum((metrics->>'完播')::numeric), 0)::bigint      AS 完播,
        coalesce(sum((metrics->>'收藏')::numeric), 0)::bigint      AS 收藏,
        coalesce(sum((metrics->>'主页访问')::numeric), 0)::bigint  AS 主页访问,
        coalesce(sum((metrics->>'私信')::numeric), 0)::bigint      AS 私信
      FROM works
      WHERE side = 'own' AND channel IN ('persona','matrix') AND deleted_at IS NULL`);

    const { rows: lm } = await query(`
      SELECT
        coalesce(max((metrics->>'在线峰值')::numeric), 0)::bigint  AS 在线峰值,
        coalesce(sum((metrics->>'停留分钟')::numeric), 0)::bigint  AS 停留分钟,
        coalesce(sum((metrics->>'连麦数')::numeric), 0)::bigint    AS 连麦数,
        coalesce(sum((metrics->>'私信')::numeric), 0)::bigint      AS 直播私信,
        coalesce(sum((metrics->>'预约')::numeric), 0)::bigint      AS 预约
      FROM works WHERE side = 'own' AND channel = 'live' AND deleted_at IS NULL`);

    const { rows: cs } = await query(
      `SELECT stage::text AS stage, count(*)::int AS n FROM clients
        WHERE deleted_at IS NULL GROUP BY stage`);
    const byStage = Object.fromEntries(cs.map(r => [r.stage, r.n]));
    const reached = k => (REACHED[k] || []).reduce((a, s) => a + (byStage[s] || 0), 0);

    const total = cs.reduce((a, r) => a + r.n, 0);
    const 有效客资 = total - (byStage.lost || 0);

    const 曝光 = Number(cm[0].曝光);
    const 主页访问 = Number(cm[0].主页访问);
    const 私信 = Number(cm[0].私信) + Number(lm[0].直播私信);

    // PDF 11 的 8 步漏斗
    const steps = [
      { name: '曝光',        value: 曝光,             source: '作品指标' },
      { name: '主页访问',    value: 主页访问,         source: '作品指标' },
      { name: '私信',        value: 私信,             source: '作品 + 直播指标' },
      { name: '有效客资',    value: 有效客资,         source: '客户档案（除流失）' },
      { name: '加微信',      value: reached('wechat'), source: '客户档案' },
      { name: '付费咨询',    value: reached('consulted'), source: '客户档案' },
      { name: '陪跑成交',    value: reached('coaching'),  source: '客户档案' },
      { name: '续费/转介绍', value: reached('renewed'),   source: '客户档案' },
    ];
    // 每一步相对上一步的转化率
    for (let i = 1; i < steps.length; i++) {
      steps[i].conv = pct(steps[i].value, steps[i - 1].value);
    }

    // PDF 11 的六层指标
    const { rows: sat } = await query(`
      SELECT count(*) FILTER (WHERE outcome IN ('推进成功','复合','长期稳定'))::int AS 好结果,
             count(*)::int AS 总案例
      FROM cases WHERE deleted_at IS NULL`);

    const layers = [
      { name: '内容层', metrics: {
        曝光: 曝光, 完播: Number(cm[0].完播), 收藏: Number(cm[0].收藏),
        '主页访问率(%)': pct(主页访问, 曝光), '私信率(%)': pct(Number(cm[0].私信), 主页访问),
      }, watch: '选题和表达是否吸引精准用户' },
      { name: '直播层', metrics: {
        在线峰值: Number(lm[0].在线峰值), 停留分钟: Number(lm[0].停留分钟),
        连麦数: Number(lm[0].连麦数), 私信: Number(lm[0].直播私信), 预约: Number(lm[0].预约),
      }, watch: '现场信任与成交结构是否有效' },
      { name: '私域层', metrics: {
        有效客资: 有效客资, 加微: reached('wechat'),
        '加微率(%)': pct(reached('wechat'), 有效客资),
        已建档: reached('profiled'),
        '资料完整率(%)': pct(reached('profiled'), reached('wechat')),
      }, watch: '筛选与承接是否顺畅' },
      { name: '咨询层', metrics: {
        付费咨询: reached('consulted'),
        '到访率(%)': pct(reached('consulted'), reached('profiled')),
        '转陪跑率(%)': pct(reached('coaching'), reached('consulted')),
      }, watch: '诊断产品是否有价值与升级空间' },
      { name: '陪跑层', metrics: {
        陪跑成交: reached('coaching'), 续费: reached('renewed'),
        '续费率(%)': pct(reached('renewed'), reached('coaching')),
        '结果率(%)': pct(sat[0].好结果, sat[0].总案例),
      }, watch: '高客单交付是否健康' },
      { name: '产品层', metrics: {
        案例入库: sat[0].总案例,
        可复用案例: null,   // 下面补
      }, watch: '标准化产品是否真正承接需求' },
    ];

    const { rows: reuse } = await query(
      'SELECT count(*)::int AS n FROM cases WHERE reusable AND deleted_at IS NULL');
    layers[5].metrics.可复用案例 = reuse[0].n;
    layers[5].metrics['可复用率(%)'] = pct(reuse[0].n, sat[0].总案例);

    sendJson(res, 200, {
      steps,
      layers,
      clientsByStage: byStage,
      // PDF 11 的数据原则，看板上直接写出来 —— 不然过两周又会有人只盯播放量
      principle: '不要只看播放量。对公司更重要的是「每 100 个精准曝光最终能产生多少有效客资、多少咨询、多少陪跑收入」。',
    });
  });
  /* ---------- 客户详情页（任务 9） ----------
     任务表要求的九个区：基础信息、对象信息、当前需求、客户资料入口、
     AI情况分析、AI用户分析、消费/成交信息、交付记录、案例状态。
     一次请求把这几块一起给前端 —— 详情页分七八个请求去拉，
     打开客户时会看到各区块一块块跳出来。 */
  router.get('/api/clients/:id', async (req, res, params) => {
    await currentUser(req);
    const id = Number(params.id);
    const { rows } = await query(
      `SELECT c.*, u.name AS owner_name,
              (SELECT count(*) FROM attachments f WHERE f.scope='client' AND f.ref_id=c.id)::int AS file_count
         FROM clients c LEFT JOIN users u ON u.id = c.owner_id
        WHERE c.id = $1 AND c.deleted_at IS NULL`, [id]);
    if (!rows[0]) throw notFound('没有这个客户');

    const [{ rows: deliveries }, { rows: cases }, { rows: files }] = await Promise.all([
      query(`SELECT d.*, u.name AS created_by_name FROM client_deliveries d
             LEFT JOIN users u ON u.id = d.created_by
             WHERE d.client_id = $1 ORDER BY d.happened_at DESC, d.id DESC`, [id]),
      query(`SELECT id, code, title, outcome, reusable FROM cases
              WHERE client_id = $1 AND deleted_at IS NULL ORDER BY id DESC`, [id]),
      query(`SELECT id, orig_name, size, created_at FROM attachments
             WHERE scope='client' AND ref_id=$1 ORDER BY created_at DESC`, [id]),
    ]);

    sendJson(res, 200, {
      ...clientRow(rows[0], await tagsFor('client', id)),
      deliveries: deliveries.map(d => ({
        id: Number(d.id), happenedAt: d.happened_at, kind: d.kind,
        summary: d.summary, createdByName: d.created_by_name || null,
      })),
      cases: cases.map(c => ({
        id: Number(c.id), code: c.code, title: c.title,
        outcome: c.outcome, reusable: !!c.reusable,
      })),
      files: files.map(f => ({
        id: Number(f.id), name: f.orig_name, size: Number(f.size), createdAt: f.created_at,
      })),
    });
  });

  /* ---------- 交付记录 ---------- */
  router.post('/api/clients/:id/deliveries', async (req, res, params) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    const { rows } = await query(
      `INSERT INTO client_deliveries(client_id, happened_at, kind, summary, created_by)
       VALUES($1, coalesce($2::date, current_date), $3, $4, $5) RETURNING id`,
      [Number(params.id), str(b.happenedAt), str(b.kind),
       need(b, 'summary', { max: 500, label: '交付说明' }), me.id]);
    sendJson(res, 201, { id: Number(rows[0].id) });
    publish('board:updated', { board: 'clients' });
  });

  router.del('/api/clients/:id/deliveries/:did', async (req, res, params) => {
    await currentUser(req);
    const { rows } = await query(
      'DELETE FROM client_deliveries WHERE id = $1 AND client_id = $2 RETURNING id',
      [Number(params.did), Number(params.id)]);
    if (!rows[0]) throw notFound('没有这条交付记录');
    sendJson(res, 200, { ok: true });
    publish('board:updated', { board: 'clients' });
  });

  /* ---------- 转案例（任务 12） ----------
     任务表原文：「不需要重复录入客户基本信息，案例和客户能互相跳转。」
     所以这里做的是「带着客户信息生成一条案例草稿」，而不是让人在案例库里从零填一遍。
     客户标签、男方标签、时间线都自动带过去，业务人员只补结果和关键过程。 */
  router.post('/api/clients/:id/to-case', async (req, res, params) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    const id = Number(params.id);
    const { rows: c } = await query(
      'SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!c[0]) throw notFound('没有这个客户');

    // 同一个客户已经转过案例就不再建第二条，直接把已有那条返回去让前端跳过去 ——
    // 「转案例」这个按钮很容易被点第二次
    // 连删掉的一起查：source_ref 上有唯一索引，软删的那条仍然占着位置，
    // 不管它直接 INSERT 会撞索引。删过又想再转的，把原来那条复活。
    const { rows: exist } = await query(
      'SELECT * FROM cases WHERE client_id = $1 ORDER BY id LIMIT 1', [id]);
    if (exist[0] && b.force !== true) {
      if (exist[0].deleted_at) {
        const { rows: 复活 } = await query(
          'UPDATE cases SET deleted_at = NULL, updated_at = now() WHERE id = $1 RETURNING *',
          [exist[0].id]);
        return sendJson(res, 200, { ...caseRow(复活[0], await tagsFor('case', exist[0].id)), existed: true });
      }
      return sendJson(res, 200, { ...caseRow(exist[0]), existed: true });
    }

    const cl = c[0];
    const pick = (o, keys) => keys.map(k => (o?.[k] ? `${k}：${o[k]}` : null)).filter(Boolean).join('，');
    const clientTags = pick(cl.female, ['年龄', '城市', '职业', '当前诉求'])
      || (cl.tier ? `客资等级：${cl.tier}` : '');
    const maleTags = pick(cl.male, ['年龄', '职业', '经济状况', '家庭']);

    const { rows } = await query(
      `INSERT INTO cases(client_id, title, client_tags, male_tags, problem, judgement,
                         outcome, created_by, source_type, source_ref)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'client_file',$9) RETURNING *`,
      [id, str(b.title) || `${cl.alias} 的案例`, clientTags, maleTags,
       str(cl.female?.当前诉求) || str(cl.note), str(cl.timeline),
       str(b.outcome) || '进行中', me.id, `client:${id}`]);

    // 客户身上的标签一并带到案例上 —— 案例库要能按「分手 + 想判断对方态度」筛
    const tags = await tagsFor('client', id);
    if (tags.length) await setTags('case', Number(rows[0].id), tags.map(t => t.id));
    // 两条记录互相关联，从任一头都能跳到另一头
    await query(
      `INSERT INTO links(from_entity, from_id, to_entity, to_id, note, created_by)
       VALUES('client',$1,'case',$2,'由客户档案转成案例',$3) ON CONFLICT DO NOTHING`,
      [id, Number(rows[0].id), me.id]);

    sendJson(res, 201, { ...caseRow(rows[0], tags), existed: false });
    publish('board:updated', { board: 'cases' });
  });
}

/** 单条记录的标签。列表页别用它 —— 那里要用 loadTags 一次批量取回 */
async function tagsFor(entity, id) {
  return (await loadTags(entity, [id])).get(Number(id)) || [];
}
