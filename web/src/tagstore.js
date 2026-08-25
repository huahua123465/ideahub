/**
 * 标签字典的前端缓存（任务 3）。
 *
 * 每个模块的编辑弹窗都要画同一套下拉，各自去请求一次 /api/tags 的话，
 * 打开一个客户档案就能发出四五个一模一样的请求。这里拉一次全站共用。
 */
import { api } from './api.js';

export const KIND_LABEL = {
  relation_stage: '关系阶段',
  problem_type: '问题类型',
  demand: '用户需求',
  content_type: '内容类型',
};
export const KIND_ORDER = ['relation_stage', 'problem_type', 'demand', 'content_type'];

/** 来源类型。和后端 lib/entity.mjs 的 SOURCE_TYPES 一一对应 */
export const SOURCE_OPTIONS = [
  { value: 'manual', label: '人工录入' },
  { value: 'tech1', label: '技术1（市场分析）' },
  { value: 'tech2', label: '技术2（客户分析）' },
  { value: 'client_file', label: '客户资料' },
  { value: 'video', label: '短视频链接' },
  { value: 'comment', label: '评论' },
];
export const SOURCE_LABEL = Object.fromEntries(SOURCE_OPTIONS.map(o => [o.value, o.label]));

let cache = null;
let inflight = null;

/** 拿标签字典。并发调用只会真正请求一次 */
export async function tagDict() {
  if (cache) return cache;
  if (!inflight) {
    inflight = api.tags().then(d => { cache = d; inflight = null; return d; })
                        .catch(e => { inflight = null; throw e; });
  }
  return inflight;
}

/** 管理员改过标签之后把缓存丢掉，下次用时重新拉 */
export function invalidate() { cache = null; }

/** id → 标签对象，画已选中的标签时用 */
export function tagById(id) {
  return cache?.items?.find(t => t.id === Number(id)) || null;
}
