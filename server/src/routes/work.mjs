/**
 * 工作提交：同事把当天的成果（Excel 等文件）交给自己选定的审核人。
 *
 * 三条规则贯穿整个文件，改的时候留意：
 *  1. 可见范围 = 提交人 + 审核人 + 管理员。别人连列表都看不到，
 *     附件也拿不到（那道检查在 routes/files.mjs 里）。
 *  2. 审核人由提交人自己选，选完还能改。
 *  3. 附件是双向的：提交人传成果，审核人可以传文件回去（side = submit / review）。
 */
import { unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';

import { query } from '../db/index.mjs';
import { readJson, sendJson, q, need, badRequest, notFound, forbidden } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { publish } from '../lib/bus.mjs';
import { kindOf, saveBody, fileRow, UPLOAD_DIR } from './files.mjs';
import { randomBytes } from 'node:crypto';
import { notifyUser } from './notifications.mjs';

const str = v => (v == null || v === '' ? null : String(v).trim());

function reportRow(r) {
  return {
    id: Number(r.id),
    authorId: Number(r.author_id), authorName: r.author_name,
    reviewerId: r.reviewer_id ? Number(r.reviewer_id) : null,
    reviewerName: r.reviewer_name || null,
    reportDate: r.report_date ? new Date(r.report_date).toISOString().slice(0, 10) : null,
    title: r.title, summary: r.summary,
    // 任务表要求的三项：结果链接/产物、遇到的问题、需要协助什么
    resultUrl: r.result_url || null,
    blockers: r.blockers || null,
    needHelp: r.need_help || null,
    feedback: r.feedback,
    reviewedAt: r.reviewed_at,
    reviewedByName: r.reviewed_by_name || null,
    status: r.feedback ? '已反馈' : '待审核',
    fileCount: Number(r.file_count) || 0,
    // 只随列表带轻量元数据，不带文件本体。打开编辑/审核弹窗时可以立即画附件，
    // 不必为了几个文件名再跨洋等一个请求；图片字节仍由 /api/files/:id 懒加载。
    files: Array.isArray(r.files) ? r.files : [],
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** 工作提交列表顺带聚合附件元数据，避免打开弹窗后再串行等一次附件清单。 */
const reportFilesJoin = alias => `
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS file_count,
           coalesce(jsonb_agg(jsonb_build_object(
             'id', f.id, 'name', f.orig_name, 'mime', f.mime, 'size', f.size,
             'side', f.side, 'uploaderName', u.name,
             'createdAt', f.created_at, 'url', '/api/files/' || f.id
           ) ORDER BY f.created_at), '[]'::jsonb) AS files
      FROM attachments f LEFT JOIN users u ON u.id = f.uploaded_by
     WHERE f.scope='report' AND f.ref_id=${alias}.id
  ) rf ON TRUE`;

/** 能不能看这一条 */
const canSee = (r, me) =>
  me.role === 'admin' || Number(r.author_id) === me.id || Number(r.reviewer_id) === me.id;

async function loadReport(id) {
  const { rows } = await query(`
    SELECT r.*, a.name AS author_name, v.name AS reviewer_name, b.name AS reviewed_by_name,
           rf.file_count, rf.files
      FROM work_reports r
      JOIN users a ON a.id = r.author_id
      LEFT JOIN users v ON v.id = r.reviewer_id
      LEFT JOIN users b ON b.id = r.reviewed_by
      ${reportFilesJoin('r')}
     WHERE r.id = $1`, [id]);
  return rows[0];
}

export function mount(router) {

  /* ---------- 列表 ----------
     scope: mine（我提交的）| review（待我审核）| all（管理员看全部） */
  router.get('/api/reports', async (req, res, _p, url) => {
    const me = await currentUser(req);
    const scope = q(url, 'scope', 'mine');

    const where = [];
    const args = [me.id];
    if (scope === 'mine') where.push('r.author_id = $1');
    else if (scope === 'review') where.push('r.reviewer_id = $1');
    else {
      // all：管理员看全部，其他人只看得到和自己有关的 ——
      // 不加这一层的话，把 scope 改成 all 就能翻别人的提交
      where.push(me.role === 'admin' ? 'TRUE' : '(r.author_id = $1 OR r.reviewer_id = $1)');
    }

    const { rows } = await query(`
      SELECT r.*, a.name AS author_name, v.name AS reviewer_name, b.name AS reviewed_by_name,
             rf.file_count, rf.files
        FROM work_reports r
        JOIN users a ON a.id = r.author_id
        LEFT JOIN users v ON v.id = r.reviewer_id
        LEFT JOIN users b ON b.id = r.reviewed_by
        ${reportFilesJoin('r')}
       WHERE ${where.join(' AND ')}
       ORDER BY r.report_date DESC, r.id DESC`, args);
    sendJson(res, 200, { items: rows.map(reportRow) });
  });

  /* ---------- 新建 ---------- */
  router.post('/api/reports', async (req, res) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    const { rows } = await query(
      `INSERT INTO work_reports(author_id, reviewer_id, report_date, title, summary,
                                result_url, blockers, need_help)
       VALUES($1,$2,coalesce($3::date, current_date),$4,$5,$6,$7,$8) RETURNING id`,
      [me.id, b.reviewerId ? Number(b.reviewerId) : null, str(b.reportDate),
       need(b, 'title', { max: 120, label: '标题' }), str(b.summary),
       str(b.resultUrl), str(b.blockers), str(b.needHelp)]);
    const nid = Number(rows[0].id);
    const created = await loadReport(nid);
    sendJson(res, 201, reportRow(created));
    publish('board:updated', { board: 'reports' });

    if (created.reviewer_id) {
      notifyUser(created.reviewer_id, {
        actorId: me.id, kind: 'report_assigned',
        title: `${me.name} 提交了「${created.title}」等你审核`,
        board: 'reports', refId: nid,
      }).catch(() => {});
    }
  });

  /* ---------- 修改 ----------
     提交人能改自己的内容和审核人；审核人只能写反馈。管理员都能改。 */
  router.patch('/api/reports/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const cur = await loadReport(id);
    if (!cur) throw notFound('没有这条提交');
    if (!canSee(cur, me)) throw forbidden('这是别人的工作提交');

    const isAuthor = Number(cur.author_id) === me.id;
    const isReviewer = Number(cur.reviewer_id) === me.id;
    const isAdmin = me.role === 'admin';

    const b = await readJson(req);
    const sets = [], args = [];
    const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };

    // 判据必须是「值真的变了」，不能是「字段出现在请求里」。
    // 前端表单是整份提交的（title/summary/日期/审核人都会带上），
    // 按「出现即算改」判的话，审核人只想写句反馈也会被整个 403 拒掉 ——
    // 结果就是审核人永远存不了反馈。
    const same = (a, c) => String(a ?? '') === String(c ?? '');
    const curDate = cur.report_date
      ? new Date(cur.report_date).toISOString().slice(0, 10) : '';
    const touchesOwn =
         (b.title !== undefined && !same(b.title, cur.title))
      || (b.summary !== undefined && !same(b.summary, cur.summary))
      || (b.reportDate !== undefined && !same(b.reportDate, curDate))
      || (b.reviewerId !== undefined && !same(b.reviewerId || '', cur.reviewer_id || ''))
      || (b.resultUrl !== undefined && !same(b.resultUrl, cur.result_url))
      || (b.blockers !== undefined && !same(b.blockers, cur.blockers))
      || (b.needHelp !== undefined && !same(b.needHelp, cur.need_help));

    if (touchesOwn && !isAuthor && !isAdmin) {
      throw forbidden('只有提交人本人能改内容和审核人');
    }
    if (b.feedback !== undefined && !isReviewer && !isAdmin) {
      throw forbidden('只有审核人能写反馈');
    }

    if (b.title !== undefined) set('title', need(b, 'title', { max: 120, label: '标题' }));
    if (b.summary !== undefined) set('summary', str(b.summary));
    if (b.reportDate !== undefined) { args.push(str(b.reportDate)); sets.push(`report_date = $${args.length}::date`); }
    if (b.reviewerId !== undefined) set('reviewer_id', b.reviewerId ? Number(b.reviewerId) : null);
    if (b.resultUrl !== undefined) set('result_url', str(b.resultUrl));
    if (b.blockers !== undefined) set('blockers', str(b.blockers));
    if (b.needHelp !== undefined) set('need_help', str(b.needHelp));
    if (b.feedback !== undefined) {
      set('feedback', str(b.feedback));
      sets.push('reviewed_at = now()');
      args.push(me.id); sets.push(`reviewed_by = $${args.length}`);
    }
    if (!sets.length) throw badRequest('没有要修改的字段');

    args.push(id);
    await query(`UPDATE work_reports SET ${sets.join(', ')}, updated_at = now()
                 WHERE id = $${args.length}`, args);
    const fresh = await loadReport(id);
    sendJson(res, 200, reportRow(fresh));
    publish('board:updated', { board: 'reports' });

    // 通知放在响应之后：发消息失败不该让保存跟着失败
    if (b.feedback !== undefined && str(b.feedback)) {
      notifyUser(cur.author_id, {
        actorId: me.id, kind: 'report_feedback',
        title: `${me.name} 反馈了你的「${cur.title}」`,
        body: str(b.feedback).slice(0, 120),
        board: 'reports', refId: id,
      }).catch(() => {});
    }
    // 换了审核人就告诉新的那位，不然他不会知道有东西等着看
    if (b.reviewerId !== undefined && Number(b.reviewerId) !== Number(cur.reviewer_id)) {
      notifyUser(b.reviewerId, {
        actorId: me.id, kind: 'report_assigned',
        title: `${me.name} 把「${cur.title}」交给你审核`,
        board: 'reports', refId: id,
      }).catch(() => {});
    }
  });

  /* ---------- 删除：本人或管理员 ---------- */
  router.del('/api/reports/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const cur = await loadReport(Number(params.id));
    if (!cur) throw notFound('没有这条提交');
    if (me.role !== 'admin' && Number(cur.author_id) !== me.id) {
      throw forbidden('只有提交人本人和管理员能删除');
    }
    // 附件跟着一起清，磁盘上的也要删 —— 只删数据库行会攒出一堆没人认领的文件
    const { rows: fs } = await query(
      `DELETE FROM attachments WHERE scope='report' AND ref_id=$1 RETURNING stored_name`, [cur.id]);
    for (const f of fs) await unlink(join(UPLOAD_DIR, basename(f.stored_name))).catch(() => {});
    await query('DELETE FROM work_reports WHERE id = $1', [cur.id]);
    sendJson(res, 200, { ok: true });
    publish('board:updated', { board: 'reports' });
  });

  /* ---------- 附件：列出 ---------- */
  router.get('/api/reports/:id/files', async (req, res, params) => {
    const me = await currentUser(req);
    const cur = await loadReport(Number(params.id));
    if (!cur) throw notFound('没有这条提交');
    if (!canSee(cur, me)) throw forbidden('这是别人的工作提交');

    const { rows } = await query(`
      SELECT f.*, u.name AS uploader_name
        FROM attachments f LEFT JOIN users u ON u.id = f.uploaded_by
       WHERE f.scope='report' AND f.ref_id=$1 ORDER BY f.created_at`, [cur.id]);
    sendJson(res, 200, { items: rows.map(fileRow) });
  });

  /* ---------- 附件：上传 ----------
     side 自动判定：审核人传的算 review，其他算 submit。不让前端指定，
     免得有人把自己的文件标成对方传的。 */
  router.post('/api/reports/:id/files', async (req, res, params, url) => {
    const me = await currentUser(req);
    const cur = await loadReport(Number(params.id));
    if (!cur) throw notFound('没有这条提交');
    if (!canSee(cur, me)) throw forbidden('这是别人的工作提交');

    const origName = String(q(url, 'name', '') || '').trim();
    if (!origName) throw badRequest('缺少文件名');
    if (origName.length > 200) throw badRequest('文件名太长了');
    const kind = kindOf(origName);

    const side = Number(cur.reviewer_id) === me.id && Number(cur.author_id) !== me.id
      ? 'review' : 'submit';
    const storedName = randomBytes(16).toString('hex') + kind.ext;
    const size = await saveBody(req, join(UPLOAD_DIR, storedName));

    const { rows } = await query(
      `INSERT INTO attachments(scope, ref_id, side, orig_name, stored_name, mime, size, uploaded_by)
       VALUES('report',$1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cur.id, side, basename(origName), storedName, kind.mime, size, me.id]);

    sendJson(res, 201, fileRow({ ...rows[0], uploader_name: me.name }));
    publish('board:updated', { board: 'reports' });
  });
}
