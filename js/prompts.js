/**
 * prompts.js — GLM Prompt 全文 + 本地文案库
 *
 * 纪律：
 *  - Prompt 与文案库**全部内联**，不留占位（留占位等于永远不补）。
 *  - 传输规则：只传**结构化标签**，绝不传图片二进制/原图（方案硬约束）。
 *  - 文案气质：温柔、克制、高级、不网红、不矫情（品牌定调）。
 */

/** GLM 固定系统提示词（方案定稿，不得改动词气） */
export const SYSTEM_TEXT = `你是极简生活故事文案助手，输出风格温柔、克制、高级、不网红、不矫情。
输出内容包含：封面标题、配图短句、朋友圈正文、互动钩子。
固定输出JSON格式，无多余文字、无解释、无废话。`;

/** 输出 JSON 契约（后端换真模型时，模型输出必须过同一个校验） */
export const STORY_SHAPE = {
  cover: '',
  captions: [],
  body: '',
  hook: '',
};

/** 用户 Prompt 构造：只吃结构化标签 */
export function buildStoryPrompt(tags) {
  const {
    scene = '日常', dateText = '', count = 0,
    keywords = [], mood = '平和', place = '',
  } = tags || {};
  return [
    '请为下面这组生活照片生成一套朋友圈故事文案。',
    `场景：${scene}`,
    `时间：${dateText}`,
    `照片数量：${count}`,
    `地点线索：${place || '未知'}`,
    `画面关键词：${keywords.slice(0, 12).join('、') || '无'}`,
    `情绪基调：${mood}`,
    '',
    '严格输出 JSON，字段：cover(封面标题，≤12字)、captions(配图短句数组，每条≤18字，数量与照片数量一致但最多9条)、body(朋友圈正文，60-120字)、hook(互动钩子，一句提问，≤20字)。',
    '不要输出解释、不要 markdown 代码块、不要多余文字。',
  ].join('\n');
}

/* ==================== 本地文案库（mock-AI / 降级用） ==================== */

const COVER_BY_SCENE = {
  landscape: ['风很轻的那几天', '把日子走成风景', '山与海的间隙', '一路向远处'],
  portrait: ['镜头里的人', '那天的我们', '笑得很轻的一天', '普通的漂亮'],
  food: ['好好吃的一顿', '烟火气正浓', '胃被照顾到了', '一顿值得的饭'],
  other: ['一些细碎的光', '日常的一页', '没什么大事', '慢慢过的一天'],
};

const CAPTION_BY_SCENE = {
  landscape: ['天色刚刚好', '风把云吹散了', '路很长，慢慢走', '光落在远处', '停下来看一眼', '这会儿很安静'],
  portrait: ['笑得刚好', '光打在脸上', '这一刻很真', '你比风景好看', '随意一站', '回头的一下'],
  food: ['热气上来了', '第一口最好', '慢慢吃', '味道很实在', '这顿不赶时间', '吃得挺开心'],
  other: ['随手记一下', '平常的一天', '小事情', '留个纪念', '正好路过', '就这样'],
};

const BODY_BY_SCENE = {
  landscape: ['走了些路，看了些风景。没有特别的计划，天气刚好，就出去了。回来翻照片，觉得那天挺值的。',
    '出门前没想太多，回来时手机里多了几十张照片。风、光、路，都是随手拍的，但看着很舒服。'],
  portrait: ['和熟悉的人待在一起，说话不多，但很松弛。照片里大家都很自然，这样就挺好。',
    '那天没什么安排，就见了个面。笑着笑着一下午就过去了，照片留了下来。'],
  food: ['吃到好吃的会让人心情变好。这顿不赶时间，慢慢吃完了，挺满足的。',
    '找了家小店，味道比预期好。吃到最后有点撑，但很开心。'],
  other: ['没什么大事发生，就是普通的一天。翻到这些照片时，觉得也值得记一下。',
    '日子大多是这样，平平的。但回看的时候，会发现有些瞬间其实挺好的。'],
};

const HOOKS = [
  '你最近一次出门是去哪了？',
  '你们也会这样随手拍一堆吗？',
  '有想再去一次的地方吗？',
  '最近吃到什么好吃的了？',
  '你们相册里是不是也堆满了？',
];

const MOOD_WORDS = ['松弛', '安静', '轻快', '温和', '踏实'];

/**
 * 本地规则引擎生成文案（确定性兜底）。
 * 它**本身就是完整实现**，不是残废保底 —— 无网络/未配 Key 时产品依然可用。
 */
export function localStory(tags = {}) {
  const { scene = 'other', count = 0, dateText = '' } = tags;
  const key = COVER_BY_SCENE[scene] ? scene : 'other';
  const pick = (arr, i) => arr[i % arr.length];
  const seed = hashOf(`${scene}|${count}|${dateText}`);
  const n = Math.max(1, Math.min(9, count || 6));

  const captions = [];
  for (let i = 0; i < n; i++) captions.push(pick(CAPTION_BY_SCENE[key], seed + i));

  return {
    cover: pick(COVER_BY_SCENE[key], seed),
    captions,
    body: pick(BODY_BY_SCENE[key], seed),
    hook: pick(HOOKS, seed),
    mood: pick(MOOD_WORDS, seed),
    source: 'local',
  };
}

function hashOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/* ==================== 品牌文案 ==================== */

export const COPY = {
  slogan: '把一堆零散照片，整理成你的朋友圈生活故事',
  // 首页副标刻意不与 slogan 重复：Slogan 已经挂在顶栏，这里补一句动作引导。
  // 🔴 改这句不会破坏任何断言，但改 slogan 会影响 index.html（那边是静态首屏，
  //    不能等 JS 渲染），两边必须一起改 —— selftest 有「slogan 两处一致」断言兜底。
  homeLead: '先挑照片，剩下的慢慢来',
  trustNote: 'AI辅助筛选，最终选择权在你',
  // 🔴 隐私承诺必须与代码事实一致（方案 §8.2 + §2.1）：
  //    端侧 CV 分析确实全在本地完成，但「AI 生成文案」这一步会把
  //    **结构化标签**（时间/场景/张数，不含任何图像）提交到服务器。
  //    旧文案说"所有分析在本地"属于承诺超出事实 —— 追问一句就穿帮。
  privacyNote: '照片的整理和分析都在你的手机里完成，原图不会上传；只有时间、场景这样的文字信息会用来帮你配文案',
  albumPermission: '帧叙集需要读取照片用于本地整理；照片的分析都在手机里完成，原图不会上传',
  deleteGroupTip: '仅删除 APP 内分组标记，不影响系统相册原图',
  cacheTip: '清理缓存只是清掉 APP 里的小图和整理记录，不会删除你手机相册里的原图',
};

/** 禁止话术：文案不得出现的网红/矫情表达 */
const FORBIDDEN = ['绝绝子', 'yyds', '姐妹们冲', '谁懂啊', '暴风', '美哭了', '破防了', '太上头了', '氛围感拉满'];

export function findForbidden(text) {
  const t = String(text || '');
  return FORBIDDEN.filter((w) => t.includes(w));
}

/** 自动改写：命中禁词则替换为克制的表达 */
export function scrubForbidden(text) {
  let t = String(text || '');
  const map = {
    绝绝子: '很好', yyds: '很好', 姐妹们冲: '推荐', 谁懂啊: '很特别',
    暴风: '', 美哭了: '很好看', 破防了: '被打动', 太上头了: '很喜欢', 氛围感拉满: '氛围很好',
  };
  for (const [k, v] of Object.entries(map)) t = t.split(k).join(v);
  return t.trim();
}

export const FORBIDDEN_LIST = FORBIDDEN;
