/**
 * 技术1 / 技术2 的接入口（任务 10、11）。
 *
 * 两条铁律，都是任务表里明确写死的：
 *   1. 同一个客户不要重复建档 —— 靠 clients.external_id 上的唯一索引兜底，
 *      不是在应用层「先查后写」（两个请求同时到就还是会建出两条）。
 *   2. 技术1 的分析结果不自动塞进正式库 —— 只能进灵感池、用户需求或对标台账，
 *      正式库仍然只能由业务人员在界面上确认转入。
 *
 * 认证走 API key（Authorization: Bearer），不走登录 cookie。
 */
import { createHash } from 'node:crypto';
import { query, tx } from '../db/index.mjs';
import { readJson, sendJson, q, badRequest, forbidden, notFound } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { requireKey, newKey, keyHash } from '../lib/apikey.mjs';
import { setTags } from '../lib/tags.mjs';
import { str } from '../lib/entity.mjs';
import { publish } from '../lib/bus.mjs';
import { readAnalysis } from '../lib/t1-analysis.mjs';
import { storeCover, mirrorImages } from '../lib/cover.mjs';

const obj = (v) => JSON.stringify(v && typeof v === 'object' ? v : {});

/** 客资等级和阶段的合法值。必须和 boards.js / clients.mjs 保持一致 */
const TIERS = ['S', 'A', 'B', 'C'];
const STAGES = ['lead', 'wechat', 'profiled', 'consulted', 'coaching', 'renewed', 'lost'];

/**
 * 校验枚举取值。
 *
 * 界面上的 /api/clients 一直有这道校验，对外的 ingest 之前漏了 ——
 * 结果技术2 传一个 'X' 等级能直接落库，而客户档案的等级分页只认 S/A/B/C，
 * 那条客户从此在界面上一个 tab 都进不去，没人会发现它存在。
 * 宁可当场 400 让对接方改，也不要静默收下一条谁也看不见的数据。
 */
function oneOf(值, 允许, 字段) {
  if (值 == null) return null;
  if (!允许.includes(值)) {
    throw badRequest(`${字段} 只能是：${允许.join(' / ')}（收到的是「${值}」）`);
  }
  return 值;
}

/** 把上游传来的标签名转成标签 id。名字不在字典里就跳过 ——
    让外部系统随便造标签，等于统一标签这件事白做了。 */
async function resolveTags(names) {
  const list = (names || []).map(String).map(s => s.trim()).filter(Boolean);
  if (!list.length) return [];
  const { rows } = await query(
    'SELECT id FROM tags WHERE active AND name = ANY($1::text[])', [list]);
  return rows.map(r => Number(r.id));
}

export function mount(router) {

  /* ==================== 技术2：客户资料与分析 ==================== */
  /**
   * POST /api/ingest/client
   * { externalId, alias, tier?, stage?, source?, female?, male?, relation?,
   *   timeline?, note?, aiSituation?, aiUser?, deal?, tags?[] }
   *
   * externalId 是技术2 那边的客户 id，重复推送只会更新同一条。
   * aiSituation 和 aiUser 分两个字段存，任务表要求「分别显示」。
   */
  router.post('/api/ingest/client', async (req, res) => {
    const key = await requireKey(req, 'tech2');
    const b = await readJson(req);
    const externalId = str(b.externalId);
    if (!externalId) throw badRequest('externalId 必填 —— 没有它就没法保证不重复建档');
    const alias = str(b.alias);   // 可空：没传就沿用库里已有的化名（新建时兜底成 externalId）
    const tier = oneOf(str(b.tier), TIERS, '客资等级 tier');
    const stage = oneOf(str(b.stage), STAGES, '阶段 stage');

    // ON CONFLICT 让「新建」和「更新」变成同一条语句，并发也只会有一条记录。
    // COALESCE(EXCLUDED.x, clients.x)：上游这次没带的字段保持原样，
    // 不能因为技术2 只更新了 AI 分析就把业务人员手填的等级冲成空。
    const { rows } = await query(`
      INSERT INTO clients(external_id, alias, tier, stage, source, female, male, relation,
                          timeline, note, ai_situation, ai_user, ai_updated_at, deal,
                          source_type, source_ref)
      VALUES($1,coalesce($2,$1),$3,coalesce($4::client_stage,'lead'),$5,$6::jsonb,$7::jsonb,$8::jsonb,
             $9,$10,$11,$12,
             -- 显式 ::text：这两个参数在这里只出现在 IS NOT NULL 里，
             -- 不加转换 Postgres 推不出类型，会报 could not determine data type
             CASE WHEN $11::text IS NOT NULL OR $12::text IS NOT NULL THEN now() END,
             $13::jsonb,'tech2',$1)
      ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
        -- 这几行必须引用参数而不是 EXCLUDED：INSERT 那一侧给了兜底值
        -- （alias 兜底成 externalId、stage 兜底成 lead），走 EXCLUDED 的话，
        -- 技术2 只推一次 AI 分析就会把业务人员手改过的化名和阶段冲回兜底值。
        alias        = coalesce($2, clients.alias),
        tier         = coalesce($3, clients.tier),
        stage        = coalesce($4::client_stage, clients.stage),
        source       = coalesce($5, clients.source),
        female       = CASE WHEN EXCLUDED.female = '{}'::jsonb THEN clients.female ELSE clients.female || EXCLUDED.female END,
        male         = CASE WHEN EXCLUDED.male   = '{}'::jsonb THEN clients.male   ELSE clients.male   || EXCLUDED.male END,
        relation     = CASE WHEN EXCLUDED.relation='{}'::jsonb THEN clients.relation ELSE clients.relation || EXCLUDED.relation END,
        timeline     = coalesce(EXCLUDED.timeline, clients.timeline),
        note         = coalesce(EXCLUDED.note, clients.note),
        ai_situation = coalesce(EXCLUDED.ai_situation, clients.ai_situation),
        ai_user      = coalesce(EXCLUDED.ai_user, clients.ai_user),
        ai_updated_at= coalesce(EXCLUDED.ai_updated_at, clients.ai_updated_at),
        deal         = CASE WHEN EXCLUDED.deal = '{}'::jsonb THEN clients.deal ELSE clients.deal || EXCLUDED.deal END,
        -- 业务人员删过这条、技术2 又推过来 = 这个客户回来了，复活它。
        -- 不复活的话唯一索引挡着建不了新的，而更新又更新到一条谁也看不见的记录上，
        -- 技术2 收到 200 却什么都没发生 —— 最难查的那种「接通了但没数据」。
        deleted_at   = NULL,
        updated_at   = now()
      RETURNING id, (xmax = 0) AS created`,
      [externalId, alias, tier, stage, str(b.source),
       obj(b.female), obj(b.male), obj(b.relation),
       str(b.timeline), str(b.note), str(b.aiSituation), str(b.aiUser), obj(b.deal)]);

    const id = Number(rows[0].id);
    const tagIds = await resolveTags(b.tags);
    if (tagIds.length) await setTags('client', id, tagIds);

    sendJson(res, 200, { ok: true, id, created: rows[0].created === true, by: key.name });
    publish('board:updated', { board: 'clients' });
  });

  /** 技术2 追加一条交付记录（陪跑/咨询流水） */
  router.post('/api/ingest/client/delivery', async (req, res) => {
    const key = await requireKey(req, 'tech2');
    const b = await readJson(req);
    const externalId = str(b.externalId);
    if (!externalId) throw badRequest('externalId 必填');
    const { rows: c } = await query(
      'SELECT id FROM clients WHERE external_id = $1 AND deleted_at IS NULL', [externalId]);
    if (!c[0]) throw notFound('这个客户还没建档（或已被删除），先调 /api/ingest/client');

    const { rows } = await query(
      `INSERT INTO client_deliveries(client_id, happened_at, kind, summary)
       VALUES($1, coalesce($2::date, current_date), $3, $4) RETURNING id`,
      [c[0].id, str(b.happenedAt), str(b.kind), str(b.summary) || '（无说明）']);
    sendJson(res, 201, { ok: true, id: Number(rows[0].id), by: key.name });
    publish('board:updated', { board: 'clients' });
  });

  /* ==================== 技术1：市场分析结果 ==================== */
  /**
   * POST /api/ingest/save
   * { type: 'demand' | 'idea' | 'reference', sourceRef, sourceUrl, title, ... }
   *
   * type 由业务人员在技术1 的结果页上点哪个按钮决定 —— 后端不猜。
   * 三个去处：
   *   demand    → 用户需求
   *   idea      → 灵感池（不是正式库）
   *   reference → 对标作品台账（技术1 分析的是别人的短视频，存这里最自然，指标能一起带过来）
   *
   * sourceRef 是技术1 那边的分析结果 id，重复保存同一条不会产生第二条记录。
   */
  router.post('/api/ingest/save', async (req, res) => {
    const key = await requireKey(req, 'tech1');
    const b = await readJson(req);
    const type = String(b.type || '');
    if (!['demand', 'idea', 'reference'].includes(type)) {
      throw badRequest("type 只能是 demand（用户需求）/ idea（灵感）/ reference（对标作品）");
    }
    const sourceRef = str(b.sourceRef);
    if (!sourceRef) throw badRequest('sourceRef 必填 —— 它是「同一条不重复保存」的依据');
    const sourceUrl = str(b.sourceUrl);
    const title = str(b.title);
    if (!title) throw badRequest('title 必填');
    const tagIds = await resolveTags(b.tags);

    if (type === 'demand') {
      const { rows } = await query(`
        INSERT INTO demands(title, quote, scene, real_goal, note, source_type, source_url, source_ref)
        VALUES($1,$2,$3,$4,$5,'tech1',$6,$7)
        ON CONFLICT (source_type, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
          title = EXCLUDED.title, quote = coalesce(EXCLUDED.quote, demands.quote),
          scene = coalesce(EXCLUDED.scene, demands.scene),
          real_goal = coalesce(EXCLUDED.real_goal, demands.real_goal),
          source_url = coalesce(EXCLUDED.source_url, demands.source_url),
          deleted_at = NULL, updated_at = now()
        RETURNING id, (xmax = 0) AS created`,
        [title, str(b.quote), str(b.scene), str(b.realGoal), str(b.note), sourceUrl, sourceRef]);
      const id = Number(rows[0].id);
      if (tagIds.length) await setTags('demand', id, tagIds);
      sendJson(res, 200, { ok: true, type, id, created: rows[0].created === true, board: 'demands', by: key.name });
      return publish('board:updated', { board: 'demands' });
    }

    if (type === 'idea') {
      // 作者挂在这把 key 对应的服务账号上，不冒用任何真人的名字。
      // status 固定 pending：任务表明确要求不自动进正式库。
      const author = await serviceUser(key.name);
      const { rows } = await query(`
        INSERT INTO ideas(title, content, category, tags, author_id, status, source_type, source_url, source_ref)
        VALUES($1,$2,$3,'{}',$4,'pending','tech1',$5,$6)
        ON CONFLICT (source_type, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
          title = EXCLUDED.title, content = EXCLUDED.content,
          source_url = coalesce(EXCLUDED.source_url, ideas.source_url),
          deleted_at = NULL, updated_at = now()
        RETURNING id, (xmax = 0) AS created`,
        [title, str(b.content) || title, str(b.category) || '其他', author, sourceUrl, sourceRef]);
      const id = Number(rows[0].id);
      if (tagIds.length) await setTags('idea', id, tagIds);
      sendJson(res, 200, { ok: true, type, id, created: rows[0].created === true, board: 'pool', by: key.name });
      return publish('idea:created', { id, status: 'pending' });
    }

    // reference：对标作品
    const channel = ['persona', 'matrix', 'live'].includes(b.channel) ? b.channel : 'matrix';
    const { rows } = await query(`
      INSERT INTO works(channel, side, title, url, pillar, published_at, metrics, note,
                        source_type, source_url, source_ref)
      VALUES($1::work_channel,'benchmark',$2,$3,$4,$5::date,$6::jsonb,$7,'tech1',$8,$9)
      ON CONFLICT (source_type, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
        title = EXCLUDED.title, url = coalesce(EXCLUDED.url, works.url),
        metrics = works.metrics || EXCLUDED.metrics,
        note = coalesce(EXCLUDED.note, works.note), deleted_at = NULL, updated_at = now()
      RETURNING id, (xmax = 0) AS created`,
      [channel, title, sourceUrl, str(b.pillar), str(b.publishedAt),
       obj(b.metrics), str(b.note), sourceUrl, sourceRef]);
    const id = Number(rows[0].id);
    if (tagIds.length) await setTags('work', id, tagIds);
    sendJson(res, 200, { ok: true, type, id, created: rows[0].created === true, board: channel, by: key.name });
    publish('board:updated', { board: channel });
  });

  /**
   * POST /api/ingest/analysis?channel=persona
   *
   * 技术1 的「采集分析」结果，**原样一整份 JSON 直接 POST 进来** ——
   * 不用改导出格式、不用拆字段、不用先转成 CSV。
   *
   * 为什么不复用上面的 /api/ingest/save：那个口子吃的是
   * title / url / metrics 这几个扁平字段，而这份 JSON 里真正值钱的东西
   * （带时间码的逐字稿、AI 的视频七问和评论五问、高赞评论原文、对标账号的粉丝数）
   * 一个都塞不进去。硬塞的结果是业务人员在 IdeaHub 里只看到一个标题和一个链接，
   * 想看拆解还得回技术1 那边翻 —— 那这趟对接就白做了。
   *
   * 三件事在一次请求里完成：
   *   1. works：对标作品台账多一条（或更新已有那条）
   *   2. channel_accounts：对标账号台账里自动补上这个账号（粉丝数每次刷新）
   *   3. work_analyses：整份 JSON 原样存下，详情页展示用
   *
   * 幂等：靠 source_ref = t1:<task_id>:<channel>。同一份结果推一万次也只有一条记录。
   * channel 进 source_ref 是有意的 —— 同一个视频可能同时是真人号和矩阵号的对标，
   * 而 works 的唯一索引只认 (source_type, source_ref)，不带 channel。
   */
  /**
   * 存进 work_analyses.payload 之前，把那张 base64 封面摘出去。
   *
   * 原则上这一列是「技术1 给什么就存什么」，但整张图是个例外：
   * 它已经落成本地文件了，再在 JSON 里留一份等于同样的几百 KB 存两遍，
   * 而且 GET /api/works/:id/analysis 每次都会把它整个吐出来 ——
   * 详情从 20KB 变成 800KB，只为了一张页面上根本不从这里取的图。
   * 换成一句说明，别让以后翻 payload 的人以为图丢了。
   */
  const slimPayload = (p) => {
    const b64 = p?.media_assets?.video?.cover_image_b64
             || p?.media_assets?.video?.cover_image || p?.cover_image_b64;
    if (!b64 || String(b64).length < 64) return p;
    const out = { ...p, media_assets: { ...p.media_assets } };
    if (out.media_assets.video) {
      out.media_assets.video = { ...out.media_assets.video };
      for (const k of ['cover_image_b64', 'cover_image']) {
        if (out.media_assets.video[k]) {
          out.media_assets.video[k] = `（已落地为本地封面文件，原始 ${String(out.media_assets.video[k]).length} 字符）`;
        }
      }
    }
    if (out.cover_image_b64) {
      out.cover_image_b64 = `（已落地为本地封面文件，原始 ${String(out.cover_image_b64).length} 字符）`;
    }
    return out;
  };

  router.post('/api/ingest/analysis', async (req, res, _p, url) => {
    const key = await requireKey(req, 'tech1');
    // 这个口子单独放宽到 8MB：整份分析约 30KB，但现在允许把一张清晰封面
    // （base64，200~500KB）一起带进来。默认的 1MB 会把带图的推送直接顶回去。
    const payload = await readJson(req, 8 * 1024 * 1024);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw badRequest('请求体要是技术1 导出的那一份 JSON 对象本身，不是数组、不是字符串');
    }

    // 进哪个板块：URL 参数优先（技术1 不用改导出的 JSON），其次 JSON 里的 channel。
    // 一次可以写多个：?channel=persona,matrix —— 同一个视频既是真人对标又是矩阵对标时用。
    const raw = String(q(url, 'channel') || payload.channel || 'matrix');
    const channels = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
    for (const c of channels) {
      if (!['persona', 'matrix', 'live'].includes(c)) {
        throw badRequest(`channel 只能是 persona（真人作品）/ matrix（矩阵作品）/ live（真人直播），收到的是「${c}」`);
      }
    }
    if (!channels.length) throw badRequest('channel 不能为空');

    const a = readAnalysis(payload);
    // task_id 是幂等的依据。技术1 万一没给，退回用原链接算一个稳定指纹 ——
    // 直接拒收会让整条数据卡在对接方那边，而链接本身已经足够标识「同一个作品」。
    const ident = a.taskId || (a.sourceUrl
      ? 'url-' + createHash('sha256').update(a.sourceUrl).digest('hex').slice(0, 16)
      : null);
    if (!ident) {
      throw badRequest('这份 JSON 里既没有 task_id 也没有 source_url，无法判断是不是同一条，拒收');
    }

    const results = [];
    for (const channel of channels) {
      const sourceRef = `t1:${ident}:${channel}`;
      // 封面落到本地再入库：优先用 JSON 里带的整张图，没有才去下平台那个地址。
      // 一定要落本地是因为平台地址带时间签名，几天后就 404 ——
      // 存 URL 的话卡片过两天集体变空白，看上去像是「系统图加载不出来」。
      // 两条路都失败返回 null，照常入库：封面是锦上添花，分析内容才是正事。
      const { file: coverFile, from: coverFrom } = await storeCover(a.coverSource, sourceRef);
      // 图文笔记：整叠图一起落地。它们是这条笔记的正文，不是配图 ——
      // 只存地址的话，过一天平台签名失效，界面上就只剩标题和一堆 403。
      const imageFiles = a.images?.length
        ? await mirrorImages(a.images.map(im => im.url), sourceRef)
        : [];
      const out = await tx(async (c) => {
        // 账号台账：先按「同板块 + 对标 + 同平台 + 同账号名」找，找不到才建。
        // 没有用唯一索引兜底是因为 channel_accounts 上没有这个索引，
        // 而加索引要先确认历史数据里没有重名 —— 那是另一件事。
        // 推送是技术1 顺序发的，这里并发撞车的概率可以忽略；真撞了也只是多一条账号，
        // 不会丢作品数据。
        let accountId = null;
        if (a.account.handle) {
          const { rows: found } = await c.query(
            `SELECT id, positioning FROM channel_accounts
              WHERE channel = $1::work_channel AND side = 'benchmark'
                AND platform = $2 AND handle = $3 AND deleted_at IS NULL
              ORDER BY id LIMIT 1`,
            [channel, a.platformLabel, a.account.handle]);
          if (found[0]) {
            accountId = Number(found[0].id);
            // 粉丝数和主页链接每次都刷新（这是客观事实，会变）；
            // 定位只在空着的时候填 —— 业务人员手写过的那句话不能被账号简介冲掉。
            await c.query(
              `UPDATE channel_accounts
                  SET followers = GREATEST(followers, $2),
                      url = coalesce($3, url),
                      positioning = coalesce(positioning, $4),
                      updated_at = now()
                WHERE id = $1`,
              [accountId, a.account.followers, a.account.url, a.account.bio]);
          } else {
            const { rows: ins } = await c.query(
              `INSERT INTO channel_accounts(channel, side, platform, handle, url, followers, positioning)
               VALUES($1::work_channel,'benchmark',$2,$3,$4,$5,$6) RETURNING id`,
              [channel, a.platformLabel, a.account.handle, a.account.url,
               a.account.followers, a.account.bio]);
            accountId = Number(ins[0].id);
          }
        }

        // 作品台账。note 只在空着时填：这一栏是「为什么值得对标」，
        // 业务人员写过的判断比 AI 的一句话主题值钱。
        const { rows } = await c.query(`
          INSERT INTO works(channel, side, account_id, title, url, metrics, note,
                            source_type, source_url, source_ref)
          VALUES($1::work_channel,'benchmark',$2,$3,$4,$5::jsonb,$6,'tech1',$4,$7)
          ON CONFLICT (source_type, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
            title      = EXCLUDED.title,
            account_id = coalesce(EXCLUDED.account_id, works.account_id),
            url        = coalesce(EXCLUDED.url, works.url),
            metrics    = works.metrics || EXCLUDED.metrics,
            note       = coalesce(works.note, EXCLUDED.note),
            -- 被删过又推过来 = 这条对标回来了，复活它。不复活的话唯一索引挡着
            -- 建不了新的，更新又更新到一条界面上看不见的记录上 —— 技术1 收到 200
            -- 却什么都没出现，最难查的那种「接通了但没数据」。
            deleted_at = NULL,
            updated_at = now()
          RETURNING id, (xmax = 0) AS created`,
          [channel, accountId, a.title, a.sourceUrl, JSON.stringify(a.metrics), a.note, sourceRef]);
        const id = Number(rows[0].id);

        // 整份 JSON 原样存下。payload 覆盖式更新（重推就是以新的为准），
        // digest 一起换掉 —— 两者必须来自同一次推送，不然卡片显示的和详情里的对不上。
        await c.query(`
          INSERT INTO work_analyses(work_id, task_id, platform, schema_ver, payload, digest,
                                    cover_file, received_at)
          VALUES($1,$2,$3,$4,$5::json,$6::jsonb,$7, now())
          ON CONFLICT (work_id) DO UPDATE SET
            task_id = EXCLUDED.task_id, platform = EXCLUDED.platform,
            schema_ver = EXCLUDED.schema_ver, payload = EXCLUDED.payload,
            digest = EXCLUDED.digest,
            -- 这次没下下来（网络抖了一下）就留着上次那张，别把已有的封面清成空
            cover_file = coalesce(EXCLUDED.cover_file, work_analyses.cover_file),
            received_at = now()`,
          [id, a.taskId, a.platform, a.schemaVer,
           JSON.stringify(slimPayload(payload)),
           JSON.stringify({ ...a.digest, coverLocal: !!coverFile, coverFrom,
                            // 逐张的本地文件名。列表接口会把这一项摘掉再下发 ——
                            // 一条九张、二十条就是一百八十个文件名，卡片上一个都用不到。
                            imageFiles }),
           coverFile]);

        return { id, created: rows[0].created === true, accountId };
      });

      // 标签：JSON 里的 topics 当标签名来认，只认标签字典里已有的那些。
      // 让外部系统随手造标签，等于「全站统一标签」这件事白做了。
      const tagIds = await resolveTags([...(a.topics || []), ...(payload.tags || [])]);
      if (tagIds.length) await setTags('work', out.id, tagIds);

      results.push({ channel, board: channel, id: out.id, created: out.created,
                     accountId: out.accountId, tagsApplied: tagIds.length });
      publish('board:updated', { board: channel });
    }

    sendJson(res, 200, {
      ok: true,
      taskId: a.taskId, title: a.title, sourceRef: `t1:${ident}`,
      // 单个 channel 时也给 id / created，让推送脚本和 /api/ingest/save 用同一套打印逻辑
      id: results[0].id, created: results[0].created,
      results, by: key.name,
    });
  });

  /** 对接自测：验证 key 通不通，不写任何数据 */
  router.get('/api/ingest/ping', async (req, res) => {
    const key = await requireKey(req, null);
    sendJson(res, 200, { ok: true, name: key.name, scopes: key.scopes });
  });

  /* ==================== 钥匙管理（管理员，走登录） ==================== */

  router.get('/api/admin/api-keys', async (req, res) => {
    await assertAdmin(req);
    const { rows } = await query(
      `SELECT id, name, scopes, created_at, last_used_at, revoked_at FROM api_keys ORDER BY id`);
    sendJson(res, 200, { items: rows.map(r => ({
      id: Number(r.id), name: r.name, scopes: r.scopes || [],
      createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at,
    })) });
  });

  router.post('/api/admin/api-keys', async (req, res) => {
    const me = await assertAdmin(req);
    const b = await readJson(req);
    const scope = b.scope === 'tech1' ? 'tech1' : b.scope === 'tech2' ? 'tech2' : null;
    if (!scope) throw badRequest('scope 只能是 tech1 或 tech2');
    const plain = newKey(scope);
    const { rows } = await query(
      `INSERT INTO api_keys(name, key_hash, scopes, created_by) VALUES($1,$2,$3,$4) RETURNING id`,
      [str(b.name) || (scope === 'tech1' ? '技术1' : '技术2'), keyHash(plain), [scope], me.id]);
    // 明文只在这里出现这一次，之后库里只有 hash
    sendJson(res, 201, { id: Number(rows[0].id), key: plain,
      note: '这串 key 只显示这一次，请立刻交给对接方并保存好' });
  });

  router.del('/api/admin/api-keys/:id', async (req, res, params) => {
    await assertAdmin(req);
    const { rows } = await query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 RETURNING id', [Number(params.id)]);
    if (!rows[0]) throw notFound('没有这把 key');
    sendJson(res, 200, { ok: true });
  });
}

async function assertAdmin(req) {
  const me = await currentUser(req);
  if (me.role !== 'admin') throw forbidden('只有管理员能管理对接密钥');
  return me;
}

/**
 * 外部系统写进来的灵感挂在一个服务账号名下，而不是随便找个真人。
 * 没有的话就建一个 —— 这个账号没有密码，登不进来。
 */
async function serviceUser(name) {
  const label = `${name}（系统）`;
  const { rows } = await query('SELECT id FROM users WHERE name = $1 LIMIT 1', [label]);
  if (rows[0]) return Number(rows[0].id);
  const { rows: ins } = await query(
    `INSERT INTO users(name, dept, role) VALUES($1,'外部系统','member') RETURNING id`, [label]);
  return Number(ins[0].id);
}
