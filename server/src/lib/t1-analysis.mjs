/**
 * 技术1「采集分析」结果的解读器。
 *
 * 技术1 导出的 JSON（schema_version 13）是给人看的完整分析报告，不是给接口设计的
 * 扁平请求体：标题有四个候选字段、互动数是「4万」这样的中文缩写、
 * AI 结论分成视频七问和评论五问两组带证据的条目。
 *
 * 这个文件只干一件事：把那份 JSON 读成 IdeaHub 的台账字段 + 一份卡片摘要，
 * 而且**不改动原文** —— 原样那份进 work_analyses.payload，
 * 技术1 以后往里加字段，这里不改也不会丢东西。
 *
 * 放在 lib 而不是 routes 里：解读规则和「怎么落库」是两件事，
 * 混在一个路由函数里的话，以后技术1 换了字段名要在一堆 SQL 中间找。
 */

/** 平台标识 → IdeaHub 账号台账里的平台名（boards.js 的 PLATFORMS） */
const PLATFORM_LABEL = {
  xiaohongshu: '小红书', xhs: '小红书', redbook: '小红书',
  douyin: '抖音', tiktok: '抖音',
  kuaishou: '快手', weibo: '微博',
  bilibili: 'B站', b站: 'B站',
  wechat: '视频号', channels: '视频号', weixin: '视频号',
};

const str = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** 截断到数据库/编辑弹窗都能接受的长度。
    works.title 在编辑弹窗里限 120 字 —— 推进来一条 200 字的标题，
    业务人员一打开那条记录点保存就会被自己的表单拦住，那种错最难解释。 */
const cut = (v, n) => {
  const s = str(v);
  if (!s) return null;
  return [...s].length <= n ? s : [...s].slice(0, n - 1).join('') + '…';
};

/**
 * 把「4万」「3.2万」「1.2k」「12,814」都读成数字。
 *
 * 平台页面上显示的就是缩写，技术1 抓到的也是缩写字符串。
 * 不解析的话这些数只能当文本显示，排序和「收藏破万的对标」这类筛选全都做不了。
 * 读不出来返回 null（而不是 0）—— 0 会让「没抓到」和「真的是 0」变成同一件事。
 */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = str(v);
  if (!s) return null;
  const m = /^([\d.,]+)\s*([万亿wk千kK]?)/.exec(s.replace(/\s+/g, ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 1e4);
  if (unit === '亿') return Math.round(n * 1e8);
  if (unit === '千' || unit === 'k' || unit === 'K') return Math.round(n * 1e3);
  return Math.round(n);
}

/** 秒 → 「4分56秒」。技术1 给的是 296.077 这种浮点秒，直接显示没人读得出多长 */
export function duration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  const m = Math.floor(n / 60), s = Math.round(n % 60);
  return m ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
}

/**
 * AI 七问 / 五问的**阅读顺序**。
 *
 * 技术1 的 items 是对象不是数组，键的先后就是该显示的先后 ——
 * 「这条主要讲什么」在最前、「还能延伸做什么内容」在最后，中间是一条推理链。
 * 打乱之后每一条还看得懂，但连起来的那个逻辑就没了。
 *
 * 库里那一列已经改成 json（不是 jsonb）来保住原始顺序，这份名单是第二道保险：
 * 万一哪天数据又经过一次会重排键的处理，界面上仍然是对的顺序。
 * 不在名单里的键（技术1 以后新增的问题）按原顺序排在后面，不会被丢掉。
 */
const AI_ORDER = [
  // 视频七问
  'main_topic', 'target_audience', 'user_need', 'content_structure',
  'solution', 'references', 'extensions',
  // 评论五问（外加「哪些评论值得重点看」和「可以延伸什么选题」）
  'main_questions', 'high_frequency_needs', 'worries', 'unclear_points',
  'key_comments', 'topic_extensions',
];
const aiRank = (k) => {
  const i = AI_ORDER.indexOf(k);
  return i < 0 ? AI_ORDER.length : i;   // 认不出来的排最后，但保持它们彼此的先后
};

/** AI 结论里的一组条目 → [{ key, label, summary, evidence[] }] */
function aiItems(items) {
  if (!items || typeof items !== 'object') return [];
  const keys = Object.keys(items);
  return keys
    .map((k, i) => [k, i])
    // 稳定排序：认识的键按 AI_ORDER，其余保持原来的相对位置
    .sort((a, b) => (aiRank(a[0]) - aiRank(b[0])) || (a[1] - b[1]))
    .map(([key]) => [key, items[key]])
    .map(([key, v]) => {
    const it = v && typeof v === 'object' ? v : {};
    // key_comments 那一条的结构不一样：没有 summary，是一串 { comment, reason }
    const entries = Array.isArray(it.entries) ? it.entries : null;
    return {
      key,
      label: str(it.label) || key,
      summary: str(it.summary),
      evidence: (Array.isArray(it.evidence_comments) ? it.evidence_comments : []).map(cmt),
      entries: entries ? entries.map(e => ({
        reason: str(e?.reason),
        comment: cmt(e?.comment || {}),
      })) : [],
    };
  }).filter(i => i.summary || i.evidence.length || i.entries.length);
}

/** 一条评论 → 前端要用的那几项。头像不取：那是站外 CDN 地址，会随时失效 */
const cmt = (c) => ({
  id: str(c?.id),
  author: str(c?.author) || '匿名',
  text: str(c?.text) || '',
  likes: Number(c?.like_count) || 0,
  replies: Number(c?.reply_count) || 0,
  createdAt: Number(c?.created_at) || null,
});

/**
 * 读一份技术1 的分析结果。
 *
 * @param {object} p  技术1 导出的原始 JSON
 * @returns 台账字段 + 卡片摘要 + 详情页要用的结构化内容
 */
export function readAnalysis(p) {
  const src = p && typeof p === 'object' ? p : {};
  const video = src.media_assets?.video || {};
  const acc = src.account || {};
  const eng = src.engagement || {};
  const ai = src.ai_analysis || {};

  const platform = str(src.platform);
  const platformLabel = PLATFORM_LABEL[String(platform || '').toLowerCase()] || '其他';

  /**
   * 封面从哪来。
   *
   * `thumbnail_url` 是平台 CDN 的**预览变体**（小红书那份是 `!nd_prv_wlteh_jpg_3`）：
   * 尺寸写着 1080×1441，实际只有 27KB，人脸糊成一片；而且签名只对这一个变体有效，
   * 换清晰度后缀一律 403 —— 拿到这个地址就注定只能得到一张糊图。
   *
   * 所以优先认技术1 直接放进 JSON 的整张图（`cover_image_b64`）。
   * 他那边本来就为了做封面 OCR 截过原始帧，给出来是顺手的事。
   * 都没有才退回 thumbnail_url —— 有张糊的也比空白色块强。
   */
  /**
   * 图文笔记（media_type = image_post）的正文就是那一叠图，放在顶层 images[]，
   * 每张还带一段 OCR 出来的文字。视频笔记这个数组是空的。
   *
   * 一开始只认 media_assets.video.thumbnail_url，于是图文笔记推进来是
   * 一条没有封面、也看不到任何图的空壳 —— 而那些图就是它的全部内容。
   * 按 index 排序，因为「第几张」在图文笔记里是有意义的（一页一个论点）。
   */
  const images = (Array.isArray(src.images) ? src.images : [])
    .map((im, i) => ({
      index: Number(im?.index) || i + 1,
      url: str(im?.source_url) || str(im?.url),
      // 完整归档不能只靠平台临时 URL。技术1 本地已经保留图片时，
      // 用 image_b64 把图片本体一起带来；兼容几个直白别名，减少两边改格式的成本。
      inline: str(im?.image_b64) || str(im?.image_base64)
           || str(im?.content_b64) || str(im?.data_url),
      text: str(im?.text),
      width: Number(im?.width) || null,
      height: Number(im?.height) || null,
      bytes: Number(im?.size_bytes) || null,
    }))
    .filter(im => im.url || im.inline)
    .sort((a, b) => a.index - b.index);

  // 视频封面和图文第一张都接受内嵌图片。图文 URL 过期时，第一张本体仍能当封面。
  const coverInline = str(video.cover_image_b64) || str(video.cover_image)
                   || str(src.cover_image_b64) || images[0]?.inline;

  // 封面候选：视频用它的缩略图，图文笔记退回第一张图
  const coverUrls = [video.cover_url, video.cover_image_url, video.thumbnail_url,
                     images[0]?.url].map(str).filter(Boolean);

  // 标题有四个候选。优先 title（帖子标题），封面 OCR 出来的 cover_title 放最后 ——
  // 它带识别误差（这份样本里「无聊」被认成了「无趣」），能用原标题就不用它。
  const title = cut(src.title || src.post_title || src.display_title || src.cover_title, 120)
             || '（技术1 未给出标题）';

  const sourceUrl = str(src.source_url) || str(video.source_url);
  const topics = (Array.isArray(src.topics) ? src.topics : []).map(str).filter(Boolean);

  const videoAi = aiItems(ai.video?.items);
  const commentAi = aiItems(ai.comments?.items);
  // 「这条主要讲什么」那一条 —— 卡片和台账备注都用它，找不到就退回第一条
  const mainTopic = videoAi.find(i => i.key === 'main_topic')?.summary
                 || videoAi[0]?.summary || null;

  const likes = toNumber(eng.likes);
  const collects = toNumber(eng.collects);
  const comments = toNumber(eng.comments);

  // 写进 works.metrics 的指标。
  // 只写抓得到的：曝光 / 完播 / 私信 / 主页访问 是自己后台才有的数，
  // 对标账号的公开页面上没有 —— 填 0 会让人误以为「这条对标一点曝光都没有」。
  const metrics = {};
  if (collects != null) metrics['收藏'] = collects;
  if (likes != null) metrics['点赞'] = likes;
  if (comments != null) metrics['评论'] = comments;

  return {
    taskId: str(src.task_id),
    schemaVer: Number(src.schema_version) || null,
    platform, platformLabel,
    title, sourceUrl, topics, metrics,
    /** 交给 storeCover：先用整张图，没有再下地址 */
    coverSource: { inline: coverInline, urls: coverUrls },
    /** 图文笔记的整组图，交给 mirrorImages 逐张落地 */
    images,
    /** 台账备注：AI 的一句话主题。这样连不打开详情、只看表格的人也能看出这条讲什么 */
    note: mainTopic,

    /** 账号台账那一条（对标账号本身） */
    account: {
      handle: cut(acc.name || src.author, 60),
      url: str(acc.profile_url),
      followers: toNumber(acc.follower_count) || 0,
      bio: str(acc.bio),
      following: toNumber(acc.following_count),
      likesCollections: toNumber(acc.likes_and_collections_count),
    },

    /** 列表卡片要显示的一小块。刻意只放这些 —— 它会跟着 /api/works 一起下发 */
    digest: {
      taskId: str(src.task_id),
      platform, platformLabel,
      mediaType: str(src.media_type),
      cover: coverUrls[0] || null,
      duration: duration(video.duration_seconds),
      size: video.width || images[0]?.width
        ? `${video.width || images[0]?.width || '?'}×${video.height || images[0]?.height || '?'}`
        : null,
      imageCount: images.length,
      account: {
        name: str(acc.name) || str(src.author),
        url: str(acc.profile_url),
        followers: toNumber(acc.follower_count),
      },
      engagement: {
        likes: str(eng.likes), collects: str(eng.collects), comments: str(eng.comments),
        likesNum: likes, collectsNum: collects, commentsNum: comments,
      },
      topics: topics.slice(0, 6),
      topicCount: topics.length,
      mainTopic,
      // 详情里有没有东西可看 —— 卡片上要据此决定显不显示「查看完整拆解」
      hasTranscript: !!str(src.video_text),
      transcriptChars: str(src.video_text) ? [...String(src.video_text)].length : 0,
      commentsShown: Array.isArray(src.comments) ? src.comments.length : 0,
      commentsScanned: Number(src.comment_summary?.scanned) || null,
      aiVideoCount: videoAi.length,
      aiCommentCount: commentAi.length,
      aiModel: str(ai.model),
      generatedAt: str(ai.generated_at),
    },
  };
}

/**
 * 详情页要用的完整视图。从 payload 里读，不再碰数据库。
 *
 * 单独一个函数是因为它和 readAnalysis 的调用时机不同：
 * readAnalysis 在写入时跑一次，这个在每次打开详情时跑 —— 老数据也能吃到
 * 这里之后的改进，不用回头重刷一遍库。
 */
export function analysisView(p) {
  const src = p && typeof p === 'object' ? p : {};
  const video = src.media_assets?.video || {};
  const acc = src.account || {};
  const eng = src.engagement || {};
  const ai = src.ai_analysis || {};
  const meta = src.video_text_meta || {};
  const cs = src.comment_summary || {};

  return {
    taskId: str(src.task_id),
    schemaVer: Number(src.schema_version) || null,
    platform: str(src.platform),
    platformLabel: PLATFORM_LABEL[String(src.platform || '').toLowerCase()] || '其他',
    collectionMode: str(src.collection_mode_label) || str(src.collection_mode),
    mediaType: str(src.media_type),
    title: str(src.title) || str(src.post_title),
    displayTitle: str(src.display_title),
    description: str(src.description) || str(src.post_description) || str(src.page_text),
    sourceUrl: str(src.source_url) || str(video.source_url),

    cover: {
      url: str(video.thumbnail_url),
      title: str(src.cover_title),
      // 封面标题是 OCR 出来的，置信度低的时候界面上要说清楚「这是识别的，可能有误」
      confidence: Number(src.cover_title_meta?.confidence) || null,
      lines: (src.cover_title_meta?.lines || []).map(l => str(l?.text)).filter(Boolean),
    },
    media: {
      duration: duration(video.duration_seconds),
      seconds: Number(video.duration_seconds) || null,
      size: video.width && video.height ? `${video.width}×${video.height}` : null,
      format: str(video.format),
      codec: str(video.video_codec),
      bytes: Number(video.size_bytes) || null,
    },

    account: {
      name: str(acc.name) || str(src.author),
      url: str(acc.profile_url),
      bio: str(acc.bio),
      followers: str(acc.follower_count),
      followersNum: toNumber(acc.follower_count),
      following: str(acc.following_count),
      likesCollections: str(acc.likes_and_collections_count),
    },
    engagement: {
      likes: str(eng.likes), collects: str(eng.collects), comments: str(eng.comments),
    },
    topics: (Array.isArray(src.topics) ? src.topics : []).map(str).filter(Boolean),

    /**
     * 图文笔记的整组图。对图文笔记来说这就是「逐字稿」——
     * text 是每张图上印的那段话，OCR 出来的，顺序即论述顺序。
     * url 只作兜底：本地镜像存在时前端一律走 /api/works/:id/image/:i。
     */
    images: (Array.isArray(src.images) ? src.images : [])
      .map((im, i) => ({
        index: Number(im?.index) || i + 1,
        url: str(im?.source_url) || str(im?.url),
        text: str(im?.text),
        size: im?.width && im?.height ? `${im.width}×${im.height}` : null,
      }))
      .filter(im => im.url)
      .sort((a, b) => a.index - b.index),

    ai: {
      status: str(ai.status),
      model: str(ai.model),
      generatedAt: str(ai.generated_at),
      // 技术1 自己带的免责声明。原样显示，不改写 ——
      // 「AI 只是辅助整理，结论要回原文核对」这句话必须留在业务人员眼前
      notice: str(ai.notice),
      videoLabels: (ai.video?.source_labels || []).map(str).filter(Boolean),
      video: aiItems(ai.video?.items),
      comments: aiItems(ai.comments?.items),
      commentSample: Number(ai.comments?.sample_size) || null,
    },

    transcript: {
      text: str(src.video_text),
      chars: str(src.video_text) ? [...String(src.video_text)].length : 0,
      model: str(meta.model),
      provider: str(meta.provider),
      chunks: Number(meta.chunks_total) || null,
      chunksOk: Number(meta.chunks_succeeded) || null,
      // 有段没识别出来就要说 —— 逐字稿缺一段而不说，等于让人拿残缺的原文下判断
      partial: Number(meta.chunks_total) > 0
            && Number(meta.chunks_succeeded) < Number(meta.chunks_total),
    },
    audioText: str(src.audio_text),

    comments: (Array.isArray(src.comments) ? src.comments : []).map(cmt),
    commentStats: {
      shown: Number(cs.returned) || (Array.isArray(src.comments) ? src.comments.length : 0),
      scanned: Number(cs.scanned) || null,
      repliesScanned: Number(cs.replies_scanned) || null,
      truncated: cs.truncated === true,
      confidence: Number(cs.confidence) || null,
      // 平台把赞数糊掉了的话，评论排序就不能当真
      likesObscured: cs.likes_obscured === true,
    },
  };
}
