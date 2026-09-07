/**
 * ============================================================================
 * games/quiz/index.js — 弹幕答题竞猜游戏模块
 * ============================================================================
 * 【玩法】
 *   主播出题（题库随机 / 手动出题），观众弹幕发 A/B/C/D（或 1/2/3/4）参与答题。
 *   倒计时内答对的观众得分，越快分越高（复用猜数字的剩余时间系数）。
 *   两种计分模式：
 *     all-correct   全员答对计分（多人同对同赢）
 *     first-correct 抢答模式，仅首位答对者得分并立即揭晓
 *   排行榜为全局共享（跨游戏累计）。
 *
 * 【接口】与猜数字/成语接龙一致的插件契约：
 *   MANIFEST / CFG_DEFAULTS / CONFIG_SCHEMA / createState /
 *   handleDanmu / handleAction / publicState / clearGameTimers
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const BANK = require('./quiz_bank'); // 兜底旧题库（tiku/ 缺失或为空时使用）
const { createBroadcaster, BC_CFG_DEFAULTS, BC_CFG_KEYS } = require('../../common/broadcast'); // 通用 AI 播报中心
const QUIZ_SLOTS = require('./slots'); // 播报点定义（题目口播）

// 实时答题流累计上限（跨局累计，仅保留最近 N 条滚动历史；分界线也计入）
const FEED_CAP = 60;

/* ═══════════════ 本地礼物资源（res/礼物资源） ═══════════════
   文件命名规则：<礼物名>_<所需钻石数>.png（如 小心心_1.png）
   展示屏「赠送礼物排除一个错误答案」提示行据此显示 1 钻礼物图（固定、不依赖真实送礼）。 */
const GIFT_RES_DIR = path.resolve(__dirname, '..', '..', 'res', '礼物资源');
let GIFT_ICONS = [];   // [{name, cost, url}]，按 钻石数→名称 排序
function scanGiftIcons() {
  try {
    if (!fs.existsSync(GIFT_RES_DIR)) return [];
    const out = [];
    for (const f of fs.readdirSync(GIFT_RES_DIR)) {
      const m = f.match(/^(.+?)_(\d+)\.(png|jpe?g|gif|webp)$/i);
      if (!m) continue;
      out.push({
        name: m[1],
        cost: parseInt(m[2], 10),
        url: `/res/礼物资源/${encodeURIComponent(f)}`,
      });
    }
    out.sort((a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name, 'zh'));
    return out;
  } catch (e) { return []; }
}
GIFT_ICONS = scanGiftIcons();

/* ═══════════════ 关注计分冷却（持久化，防重复关注反复拿分） ═══════════════
   同一观众在冷却期内（默认 21 小时）只计一次「关注 = 本题答对」。
   落盘保存，服务重启后依然有效。 */
const FOLLOW_CD_PATH = path.join(__dirname, 'data', 'follow_cooldown.json');
const state_followCd = new Map();  // userId -> 上次「关注计分」时间戳（跨局/跨重启持久）
let followCdLoaded = false;
function loadFollowCd() {
  if (followCdLoaded) return;
  followCdLoaded = true;
  try {
    if (!fs.existsSync(FOLLOW_CD_PATH)) return;
    const obj = JSON.parse(fs.readFileSync(FOLLOW_CD_PATH, 'utf8'));
    for (const [k, v] of Object.entries(obj || {})) if (typeof v === 'number' && v > 0) state_followCd.set(k, v);
  } catch (e) { /* 文件损坏/不存在：忽略，按空冷却处理 */ }
}
function saveFollowCd() {
  try {
    fs.mkdirSync(path.dirname(FOLLOW_CD_PATH), { recursive: true });
    fs.writeFileSync(FOLLOW_CD_PATH, JSON.stringify(Object.fromEntries(state_followCd)), 'utf8');
  } catch (e) { /* 写盘失败不阻断游戏 */ }
}

/**
 * 裁剪实时答题流：普通事件(answer/change/change-denied/streak/fastest)按上限裁剪从最旧开始丢弃，
 * 但「局分界线」(type==='round') 始终保留，确保跨局累计时各局分隔不丢失。
 */
function trimFeed(state) {
  let drop = state.feed.filter(e => e.type !== 'round').length - FEED_CAP;
  if (drop <= 0) return;
  const kept = [];
  for (const e of state.feed) {
    if (e.type === 'round') { kept.push(e); continue; }
    if (drop > 0) { drop--; continue; } // 丢弃最旧的普通事件
    kept.push(e);
  }
  state.feed = kept;
}

/* ═══════════════ 注册信息 ═══════════════ */

const MANIFEST = {
  id: 'quiz',
  name: '答题竞猜',
  icon: '📝',
  desc: '直播答题竞猜 · 弹幕选 ABCD · 多人同对同赢',
  // 运行中状态（宿主据此点亮主播台导航绿点）
  liveStatuses: ['asking'],
  // 全局排行榜计分字段（宿主动态注册，新增游戏零改宿主）
  score: { wins: 'quiz_wins', score: 'quiz_score', floors: null },
};

/* ═══════════════ 配置 ═══════════════ */

const CFG_DEFAULTS = {
  roundIntervalSec: 30,        // 每题竞答时长（秒）
  resultShowSec: 10,           // 揭晓后停留（秒）
  autoNextRound: true,         // 揭晓后自动出下一题
  baseScorePerWin: 100,        // 答对基础分
  timeBonusPct: 100,           // 剩余时间加成(%)：越早答越高，最高额外加 基础分×timeBonusPct%（0=不按时间加分）
  streakBonus: 30,             // 连对加成(分)：连对 n 题额外 +(n-1)×streakBonus
  fastestBonus: 50,            // 最快答对加成(分)：每题最先答对者额外加分
  rateLimitSec: 2,             // 同一观众发送间隔
  allowChangeAnswer: true,     // 是否允许观众改选答案（关闭后换选项将被禁止）
  questionSource: 'bank',      // bank=题库随机 | manual=手动出题
  shuffleOptions: true,        // 选项乱序（避免位置偏置）
  mode: 'all-correct',         // all-correct=全员答对计分 | first-correct=抢答首中计分
  wrongPenalty: 0,             // 答错扣分（默认 0，不扣）
  // 手动题（questionSource='manual' 或 setQuestion 即时出题时使用）
  manualQuestion: '',
  manualOptions: '',
  manualAnswer: 0,
  manualExplain: '',
  allowedRoomId: '',
  // 主播台答题期显示答案：答案只经 peek 动作返回给 /api/control 调用方（主播台），
  // 绝不进 SSE，观众流始终拿不到
  hostShowAnswer: true,
  // 展示屏答题期隐藏逐条作答明细（"XXX 选A ✓对"会提前泄题），只显示结算类加成
  hideAnswerFeed: true,
  // 题库筛选：空数组 = 全部。可选项来自 tiku/ 下「分类_难度.json」的文件名
  tikuCategories: [],
  tikuDifficulties: [],
  // ── AI 口播（已迁移到通用播报中心 common/broadcast，off/local/api + 密钥只存服务端） ──
  ...BC_CFG_DEFAULTS,
  // ── 排除答案（点赞 / 礼物触发，给观众 50/50 提示） ──
  // 点赞：单个观众本局累计点赞达 likeEliminateAt 即排除一个错误项；每再跨过一次倍数再排除一个
  likeEliminateEnabled: true,
  likeEliminateAt: 20,
  // 礼物：每次收到礼物排除一个错误项
  giftEliminateEnabled: true,
  // 关注主播：本题算答对（同一观众按 followCooldownHours 冷却，防重复关注反复计分）
  followAsCorrect: true,
  followCooldownHours: 21,
};

/* ═══════════════ 通用 AI 播报中心（common/broadcast） ═══════════════
   播报点定义在 ./slots.js；配置键由 BC_CFG_DEFAULTS / BC_CFG_KEYS 提供。
   旧配置键 aiNarrate 在首次使用时一次性迁移到 aiBroadcast 并写回配置文件。 */
function BC(ctx) {
  if (!ctx._bc) {
    const cfg = ctx.cfg || {};
    if (cfg.aiNarrate !== undefined) {           // 旧键迁移（一次性）
      cfg.aiBroadcast = cfg.aiNarrate;
      delete cfg.aiNarrate;
      if (typeof ctx.persistConfig === 'function') ctx.persistConfig(cfg);
    }
    ctx._bc = createBroadcaster({
      gameId: 'quiz', gameName: '答题竞猜', slots: QUIZ_SLOTS,
      getCfg: () => ctx.cfg,
      getState: () => ctx.state,
      emit: () => ctx.emit.state(),
      log: ctx.log,
    });
  }
  return ctx._bc;
}

const CONFIG_SCHEMA = [
  { key: 'roundIntervalSec', label: '每题时长(秒)', type: 'number', min: 5, def: 30 },
  { key: 'resultShowSec', label: '揭晓停留(秒)', type: 'number', min: 3, def: 10 },
  { key: 'baseScorePerWin', label: '答对基础分', type: 'number', min: 1, def: 100 },
  { key: 'timeBonusPct', label: '剩余时间加成(%)', type: 'number', min: 0, def: 100 },
  { key: 'streakBonus', label: '连对加成(分/题)', type: 'number', min: 0, def: 30 },
  { key: 'fastestBonus', label: '最快答对加成(分)', type: 'number', min: 0, def: 50 },
  { key: 'autoNextRound', label: '自动出下一题', type: 'bool', def: true },
  { key: 'questionSource', label: '题目来源', type: 'select', options: [['bank', '题库随机'], ['manual', '手动出题']], def: 'bank' },
  { key: 'mode', label: '计分模式', type: 'select', options: [['all-correct', '全员答对得分'], ['first-correct', '抢答(首中得分)']], def: 'all-correct' },
  { key: 'shuffleOptions', label: '选项乱序', type: 'bool', def: true },
  { key: 'allowChangeAnswer', label: '允许改选答案', type: 'bool', def: true },
  { key: 'rateLimitSec', label: '发送间隔(秒)', type: 'number', min: 1, def: 2 },
  { key: 'wrongPenalty', label: '答错扣分', type: 'number', min: 0, def: 0 },
  { key: 'hostShowAnswer', label: '主播台显示答案', type: 'bool', def: true },
  { key: 'hideAnswerFeed', label: '展示屏隐藏作答明细', type: 'bool', def: true },
  { key: 'likeEliminateEnabled', label: '点赞排除答案', type: 'bool', def: true },
  { key: 'likeEliminateAt', label: '个人点赞阈值(赞)', type: 'number', min: 1, def: 20 },
  { key: 'giftEliminateEnabled', label: '礼物排除答案', type: 'bool', def: true },
  { key: 'followAsCorrect', label: '关注主播算本题答对', type: 'bool', def: true },
  { key: 'followCooldownHours', label: '关注计分冷却(小时)', type: 'number', min: 1, def: 21 },
  { key: 'tikuCategories', label: '题库分类', type: 'multiselect', def: [] },
  { key: 'tikuDifficulties', label: '题库难度', type: 'multiselect', def: [] },
];

/* ═══════════════ 状态 ═══════════════ */

function createState() {
  return {
    status: 'idle',            // idle | asking | revealed | paused
    roundNo: 0,
    question: null,            // { q, options:[{label,text,isCorrect}], answerIndex, explain, source, shuffled }
    answers: [],               // 本轮回答 [{user,userId,avatar,choice,choiceLabel,correct,score,ts}]
    voteCounts: [],            // 各选项累计票数 [n0,n1,...]
    correctSet: new Set(),     // 答对者 userId（去重，全员模式计分/防重复加分）
    winnerLocked: false,       // first-correct 模式：首中是否已锁定
    deadline: 0,
    pausedRemain: 0,           // 暂停时冻结的剩余毫秒（恢复时按此续时，而非重置满时长）
    revealedAt: 0,
    nextRoundAt: 0,            // 揭晓后「下一局」的目标时间戳（0=未安排），供展示屏倒计时
    result: null,              // 揭晓后 {answerIndex,explain,answeredCount,correctCount,winners}
    history: [],               // 最近出题历史
    stats: { rounds: 0, correctTotal: 0 },
    ansCount: new Map(),       // userId -> 本轮答题次数（上限/限流，每题重置）
    lastAnsAt: new Map(),      // userId -> 上次答题时间戳
    userChoice: new Map(),     // userId -> 本轮当前所选选项序号（用于识别「改选」）
    answersByUser: new Map(),  // userId -> 本轮作答记录引用（改选时原地更新，避免重复计数）
    streaks: new Map(),        // userId -> 跨轮连续答对计数（连对加成）
    feed: [],                  // 本轮实时答题流（含答案事件/连对/最快加成/排除答案）
    likeCountThisRound: 0,     // 本局全房间累计点赞数（进度展示用）
    likesByUser: new Map(),    // userId -> {name,avatar,count,elimDone} 个人单局点赞累计（达阈值排除答案）
    recentGifts: [],           // 最近送礼记录（含抖音官方礼物图，跨局保留；供展示屏礼物提示行）
    eliminated: [],            // 已被排除的选项记录 [{idx,source:'like'|'gift',user,avatar}]（绝不排除正确答案；用于展示屏灰显 + 答题守卫）
    narration: '',              // 当前题口播引导语（AI 生成，绝不剧透答案；经 SSE 推给控制台 TTS 朗读）
    narrationId: 0,             // 每次重新生成自增，供控制台判断「是否该朗读这条」
  };
}

/* ═══════════════ 工具 ═══════════════ */

/** 计分：基础分 + 基础分×剩余占比×剩余时间加成%，越快越高（加成比例可在主播台配置） */
function computeScore(state, cfg) {
  const total = Math.max(1, cfg.roundIntervalSec);
  const remain = Math.max(0, (state.deadline - Date.now()) / 1000);
  const ratio = Math.min(1, remain / total);
  const timeBonusPct = Number.isFinite(+cfg.timeBonusPct) ? Math.max(0, +cfg.timeBonusPct) : 100;
  return Math.round(cfg.baseScorePerWin * (1 + ratio * timeBonusPct / 100));
}

/** 从弹幕文本解析选项序号（0 起始）；支持 A-D / 1-4 / 选A / 答案A 等；非答题弹幕返回 null（不消费） */
function parseChoice(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const up = t.toUpperCase();
  // 1) 显式前缀：选/答案/答/我选/我答/投/按 + 字母
  const pref = up.match(/(?:选|答案|答|我选|我答|投|按)\s*([A-D])/);
  if (pref) return 'ABCD'.indexOf(pref[1]);
  // 2) 独立字母（整条仅一个字母）
  const singleLetter = up.match(/^([A-D])$/);
  if (singleLetter) return 'ABCD'.indexOf(singleLetter[1]);
  // 3) 去除非 A-D 字符后仅剩一个字母
  const letters = up.replace(/[^A-D]/g, '');
  if (letters.length === 1) return 'ABCD'.indexOf(letters);
  // 4) 独立数字 1-4（整条仅一个数字）
  const singleNum = t.match(/^([1-4])$/);
  if (singleNum) return parseInt(singleNum[1], 10) - 1;
  // 5) 去除非 1-4 字符后仅剩一个数字
  const nums = t.replace(/[^1-4]/g, '');
  if (nums.length === 1) return parseInt(nums, 10) - 1;
  return null;
}

/* ═══════════════ 题库加载（games/quiz/tiku/<分类>_<难度>.json） ═══════════════ */

const DIFF_ORDER = ['简单', '中等', '困难']; // 难度在下拉框中的展示顺序
let _tiku = null; // { sig, pool, categories, difficulties, counts }

/**
 * 扫描 tiku/ 目录。指纹 = 文件名+大小+修改时间，
 * 题库文件一有变动（加题/改题）自动重扫 —— 主播无需重启服务。
 */
function loadTiku() {
  const dir = path.join(__dirname, 'tiku');
  if (!fs.existsSync(dir)) return null;
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch (e) { return null; }

  let sig = '';
  for (const f of files) {
    try { const st = fs.statSync(path.join(dir, f)); sig += `${f}:${st.size}:${st.mtimeMs}|`; }
    catch (e) { /* 读不到就跳过该文件 */ }
  }
  if (_tiku && _tiku.sig === sig) return _tiku;

  const pool = [], cats = new Set(), diffs = new Set(), counts = {};
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!Array.isArray(arr)) continue;
      const base = f.replace(/\.json$/, '');
      const i = base.lastIndexOf('_');
      const category = i > 0 ? base.slice(0, i) : base;
      const difficulty = i > 0 ? base.slice(i + 1) : '未分类';
      cats.add(category); diffs.add(difficulty);
      let n = 0;
      for (const q of arr) {
        if (!q || !q.q || !Array.isArray(q.options) || q.options.length < 2) continue;
        const answer = Number.isInteger(q.answer) ? q.answer : 0;
        if (answer < 0 || answer >= q.options.length) continue;
        pool.push({
          q: q.q, options: q.options, answer,
          explain: q.explain || '', category, difficulty, source: 'tiku',
        });
        n++;
      }
      counts[`${category}_${difficulty}`] = n;
    } catch (e) { /* 单个文件损坏不影响整体，跳过 */ }
  }

  const difficulties = [...diffs].sort((a, b) => {
    const ia = DIFF_ORDER.indexOf(a), ib = DIFF_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  _tiku = { sig, pool, categories: [...cats].sort(), difficulties, counts };
  return _tiku;
}

/** 按配置的分类/难度筛选题池。空数组 = 全部 */
function filterPool(pool, categories, difficulties) {
  let out = pool;
  if (Array.isArray(categories) && categories.length) {
    const set = new Set(categories);
    out = out.filter(q => set.has(q.category));
  }
  if (Array.isArray(difficulties) && difficulties.length) {
    const set = new Set(difficulties);
    out = out.filter(q => set.has(q.difficulty));
  }
  return out;
}

function pickBankQuestion(cfg) {
  const t = loadTiku();
  if (t && t.pool.length) {
    let list = filterPool(t.pool, cfg && cfg.tikuCategories, cfg && cfg.tikuDifficulties);
    // 选中组合为空（如题库文件被改名/删空）时回退全部，避免出不了题
    if (!list.length) list = t.pool;
    return list[Math.floor(Math.random() * list.length)];
  }
  // 兜底：tiku 缺失时沿用旧题库
  if (!BANK.length) return null;
  return BANK[Math.floor(Math.random() * BANK.length)];
}

/** 把原始题（{q,options,answer,explain}）处理成展示题（带 label/isCorrect，可选乱序） */
function buildQuestion(ctx, raw) {
  const opts = raw.options.map((txt, i) => ({
    label: String.fromCharCode(65 + i),
    text: txt,
    isCorrect: i === raw.answer,
  }));
  if (ctx.cfg.shuffleOptions && opts.length > 1) {
    // Fisher-Yates 乱序，并重算正确下标 + 重新编号 A/B/C/D
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [opts[i], opts[j]] = [opts[j], opts[i]];
    }
    const ansIdx = opts.findIndex(o => o.isCorrect);
    opts.forEach((o, i) => { o.label = String.fromCharCode(65 + i); });
    return { q: raw.q, options: opts, answerIndex: ansIdx, explain: raw.explain || '', source: raw.source || 'bank', shuffled: true, category: raw.category || '', difficulty: raw.difficulty || '' };
  }
  return { q: raw.q, options: opts, answerIndex: raw.answer, explain: raw.explain || '', source: raw.source || 'bank', shuffled: false, category: raw.category || '', difficulty: raw.difficulty || '' };
}

/** 解析手动题配置 → 原始题；失败返回 null */
function parseManual(cfg) {
  const q = String(cfg.manualQuestion || '').trim();
  if (!q) return null;
  const opts = String(cfg.manualOptions || '').split(/[\n,，;；]+/).map(s => s.trim()).filter(Boolean);
  if (opts.length < 2) return null;
  let ans = cfg.manualAnswer;
  if (typeof ans === 'string') ans = 'ABCD'.indexOf(ans.toUpperCase());
  if (!Number.isInteger(ans) || ans < 0 || ans >= opts.length) ans = 0;
  return { q, options: opts, answer: ans, explain: cfg.manualExplain || '', source: 'manual' };
}

/* ═══════════════ 出题 / 揭晓 ═══════════════ */

function askQuestion(ctx, raw) {
  const { state, cfg, emit } = ctx;
  clearGameTimers(ctx);
  const q = buildQuestion(ctx, raw);
  state.question = q;
  state.roundNo++;
  state.answers = [];
  state.voteCounts = q.options.map(() => 0);
  state.correctSet = new Set();
  state.winnerLocked = false;
  state.ansCount = new Map();   // 每题重置：避免「每人每题上限」被跨题误限
  state.lastAnsAt = new Map();
  state.userChoice = new Map(); // 每题重置：本轮改选判定（同一人本轮选了哪个）
  state.answersByUser = new Map();
  state.likeCountThisRound = 0;
  state.likesByUser = new Map(); // 每题重置：个人单局点赞累计（含各自已触发排除次数）
  state.eliminated = [];       // 每题重置：上一题排除的答案不带入本题
  // 跨局累计：不清空历史答题流；新局开始时插入一条「上局小结」分界线
  // （此时上一局已揭晓，state.result 仍保留其统计；分界线标注已结束的上一局题号 + 答对人数 + 正确率）
  if (state.roundNo > 1) {
    const prev = state.result;
    const answered = prev ? (prev.answeredCount || 0) : 0;
    const correct = prev ? (prev.correctCount || 0) : 0;
    const accuracy = answered > 0 ? Math.round((correct / answered) * 100) : null;
    state.feed.push({
      type: 'round',
      roundNo: state.roundNo - 1,   // 标注已结束的上一局题号
      answered, correct, accuracy,
      ts: Date.now(),
    });
    trimFeed(state);
  }
  state.result = null;          // 清掉上一轮结算残留（避免主播台残留统计/答案）
  state.status = 'asking';
  state.nextRoundAt = 0;         // 新题开始，清掉上一轮「下一局倒计时」
  state.deadline = Date.now() + cfg.roundIntervalSec * 1000;
  state.stats.rounds++;
  ctx.log('INFO', `[quiz #${state.roundNo}] 出题：${q.q}（正确答案=${q.options[q.answerIndex].label}，来源=${q.source}）`);
  emit.state();
  scheduleTimeout(ctx);
  generateNarration(ctx);   // 异步生成口播引导语（local/api），完成后经 SSE 推给控制台朗读；off 时清空
}

/**
 * 生成当前题口播引导语（走通用播报中心）：
 * BC.generate 生成文案 → 写旧字段 narration/narrationId（保留历史记录兼容）
 * → BC.push 推入通用通道（bc.seq 自增，主播台 DGBroadcast 面板朗读+记录）。
 * off 模式清空旧口播；异步 fire-and-forget，不阻塞出题主流程。
 */
function generateNarration(ctx) {
  const { state, emit } = ctx;
  const bc = BC(ctx);
  if (bc.mode() === 'off') {
    if (state.narration) { state.narration = ''; emit.state(); }
    return;
  }
  const q = state.question;
  if (!q) return;
  const data = {
    round: state.roundNo,
    question: q.q,
    options: (q.options || []).map(o => `${o.label}. ${o.text}`),
  };
  bc.generate('question', data).then(text => {
    if (!text) return;
    state.narration = text;
    state.narrationId = (state.narrationId || 0) + 1;
    bc.push('question', text);
    emit.state();
  }).catch(e => ctx.log('WARN', '[quiz-bc] 口播生成异常:', e.message));
}

function askNext(ctx) {
  const { cfg, emit } = ctx;
  let raw = null;
  if (cfg.questionSource === 'manual') raw = parseManual(cfg);
  if (!raw) raw = pickBankQuestion(cfg);
  if (!raw) {
    ctx.log('WARN', '[quiz] 无可用题目（题库为空且未配置手动题），回到空闲');
    emit.notice('当前无可用题目，请添加题库或配置手动题');
    const st = ctx.state; st.status = 'idle'; emit.state();
    return;
  }
  askQuestion(ctx, raw);
}

function scheduleTimeout(ctx) {
  const { state } = ctx;
  ctx.clearTimers('timeout');
  const remain = Math.max(0, state.deadline - Date.now());
  ctx.setTimer('timeout', () => reveal(ctx, 'timeout'), remain);
}

function awardUser(ctx, entry, score) {
  ctx.award({ user: entry.user, userId: entry.userId, avatar: entry.avatar }, score);
}

function reveal(ctx, reason, firstWinner) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'asking') return;
  clearGameTimers(ctx);
  state.status = 'revealed';
  state.revealedAt = Date.now();
  const q = state.question;

  // 唯一答对者（按 userId 去重，保留首次作答记录）
  const correctUsers = new Map();
  for (const a of state.answers) {
    if (a.correct && !correctUsers.has(a.userId)) correctUsers.set(a.userId, a);
  }
  const correctAnswerers = [...correctUsers.values()];

  const winners = [];
  const bonusEvents = [];

  // 1) 基础分：全员答对 / 抢答首中
  if (reason === 'win' && firstWinner) {
    const score = firstWinner.score || computeScore(state, cfg);
    awardUser(ctx, firstWinner, score);
    winners.push({ name: firstWinner.user, avatar: firstWinner.avatar, score, ts: firstWinner.ts });
    state.stats.correctTotal++;
  } else {
    for (const a of correctAnswerers) {
      const score = a.score || computeScore(state, cfg);
      awardUser(ctx, a, score);
      winners.push({ name: a.user, avatar: a.avatar, score, ts: a.ts });
      state.stats.correctTotal++;
    }
  }

  // 2) 连对加成（跨轮累计；每多连对 1 题额外 +cfg.streakBonus）
  for (const a of correctAnswerers) {
    const prev = state.streaks.get(a.userId) || 0;
    const streak = prev + 1;
    state.streaks.set(a.userId, streak);
    if (streak >= 2) {
      const bonus = (streak - 1) * cfg.streakBonus;
      awardUser(ctx, a, bonus);
      bonusEvents.push({ type: 'streak', user: a.user, avatar: a.avatar, streak, bonus, ts: Date.now() });
    }
  }
  // 本轮答过但答错 → 连对中断归零
  for (const [uid] of state.ansCount) {
    if (!correctUsers.has(uid)) state.streaks.set(uid, 0);
  }

  // 3) 最快答对（本轮 ts 最小者）额外加成；「关注视为答对」不参与竞速（只拿基础分）
  let fastest = null;
  const racers = correctAnswerers.filter(a => !a.viaFollow);
  const racersList = racers.length ? racers : correctAnswerers;   // 全是关注作答时兜底取其一
  if (racersList.length) {
    let f = racersList[0];
    for (const a of racersList) if (a.ts < f.ts) f = a;
    fastest = { name: f.user, avatar: f.avatar, score: cfg.fastestBonus, ts: f.ts };
    awardUser(ctx, f, cfg.fastestBonus);
    bonusEvents.push({ type: 'fastest', user: f.user, avatar: f.avatar, bonus: cfg.fastestBonus, ts: Date.now() });
  }

  // 加成事件追加进本轮实时答题流（供展示屏左侧高亮）
  for (const e of bonusEvents) state.feed.push(e);
  trimFeed(state);

  state.result = {
    answerIndex: q.answerIndex,
    explain: q.explain || '',
    answeredCount: state.answers.length,
    correctCount: correctAnswerers.length,
    winners: winners.slice(0, 20),
    correctList: correctAnswerers.map(a => ({ name: a.user, avatar: a.avatar, choiceLabel: a.choiceLabel })),
    fastest,
    bonusEvents,
  };

  state.history.unshift({
    roundNo: state.roundNo,
    q: q.q,
    answer: q.options[q.answerIndex].label,
    correctCount: correctAnswerers.length,
    answeredCount: state.answers.length,
    ts: Date.now(),
  });
  if (state.history.length > 30) state.history.pop();

  ctx.log('INFO', `[quiz #${state.roundNo}] 揭晓：正确 ${q.options[q.answerIndex].label}（${correctAnswerers.length}/${state.answers.length} 人答对；连对事件 ${bonusEvents.filter(e => e.type === 'streak').length}；最快 ${fastest ? fastest.name : '无'}）`);
  // 必须先算好 nextRoundAt 再 emit：否则本次推送里还是旧值，
  // 前端拿不到倒计时起点（且到下一题前不会再推送）。
  if (cfg.autoNextRound) {
    const delayMs = Math.max(0, cfg.resultShowSec) * 1000;
    state.nextRoundAt = Date.now() + delayMs;   // 供展示屏显示「下一局倒计时」
    ctx.setTimer('next', () => askNext(ctx), delayMs);
  } else {
    state.nextRoundAt = 0;                      // 手动模式下不安排下一局
  }

  emit.state();
}

/* ═══════════════ 弹幕处理 ═══════════════ */

function handleDanmu(ctx, msg) {
  const { state, cfg, emit } = ctx;
  if (!msg || msg.event !== 'chat' || !msg.text) return false;

  if (cfg.allowedRoomId && msg.roomId) {
    const allowedSet = String(cfg.allowedRoomId).split(/[,，\s]+/).filter(Boolean);
    if (allowedSet.length && !allowedSet.includes(String(msg.roomId))) return false;
  }

  if (state.status !== 'asking') {
    emit.notice(`本轮未开始/已结束，${msg.user?.name || '匿名'} 的回答未计入`);
    return true;
  }

  const choice = parseChoice(msg.text);
  if (choice == null) return false; // 非答题弹幕，交给其他游戏/忽略

  const name = msg.user?.name || '匿名';
  const key = msg.user?.id || msg.user?.displayId || msg.user?.name || '匿名';
  const q = state.question;

  if (choice < 0 || choice >= q.options.length) {
    emit.notice(`「${name}」的选项超出范围（本题 ${q.options.length} 个选项）`);
    return true;
  }
  // 排除答案：已被排除（已知错误）的选项不接受作答，提示改选其他（让排除成为真正的 50/50 提示）
  if (state.eliminated.some(e => e.idx === choice)) {
    emit.notice(`「${name}」的选择 ${q.options[choice].label} 已被排除，请改选其他`);
    return true;
  }

  // 改选检测：同一用户本轮已选过、且本次选项不同 → 视为「改选」
  const label = q.options[choice].label;
  const prevChoice = state.userChoice.has(key) ? state.userChoice.get(key) : null;
  if (prevChoice === choice) {
    emit.notice(`「${name}」已选择 ${label}，无需重复发送`);
    return true;
  }
  const isChange = prevChoice != null;

  // 限流（改选也受间隔限制，防刷）
  const now = Date.now();
  const last = state.lastAnsAt.get(key) || 0;
  if (now - last < cfg.rateLimitSec * 1000) {
    emit.notice(`「${name}」操作太频繁，${cfg.rateLimitSec}s 后再试`);
    return true;
  }
  state.lastAnsAt.set(key, now);

  const correct = choice === q.answerIndex;
  const fromLabel = prevChoice != null ? q.options[prevChoice].label : '';

  if (isChange) {
    // 改选：依据「是否允许改选」决定通过或拒绝
    if (cfg.allowChangeAnswer) {
      // 允许改选：原地修正既有作答（选项 + 票数分布），并在实时答题流提示「改选成功」
      const ex = state.answersByUser.get(key);
      if (ex) {
        if (state.voteCounts[prevChoice] != null) state.voteCounts[prevChoice] = Math.max(0, state.voteCounts[prevChoice] - 1);
        ex.choice = choice; ex.choiceLabel = label; ex.correct = correct; ex.ts = Date.now();
        if (state.voteCounts[choice] != null) state.voteCounts[choice]++;
      } else {
        // 兜底：找不到旧记录（极端情况）则按首答处理
        const entry = { user: name, userId: key, avatar: msg.user?.avatar || '', choice, choiceLabel: label, correct, score: 0, ts: Date.now() };
        if (state.voteCounts[choice] != null) state.voteCounts[choice]++;
        state.answers.push(entry);
        if (state.answers.length > 300) state.answers.shift();
        state.answersByUser.set(key, entry);
      }
      // change 类型不受 hideAnswerFeed 过滤，实时答题区默认即可见
      state.feed.push({ type: 'change', user: name, avatar: msg.user?.avatar || '', fromLabel, toLabel: label, ts: Date.now() });
      state.userChoice.set(key, choice);   // 改选成功：记录新选择
    } else {
      // 禁止改选：不改票数/作答记录，仅在实时答题流提示「改选被禁止」
      state.feed.push({ type: 'change-denied', user: name, avatar: msg.user?.avatar || '', fromLabel, toLabel: label, ts: Date.now() });
      // 注意：userChoice 保持原选项不变（拒绝本次改选）
    }
  } else {
    // 首次作答
    const entry = {
      user: name,
      userId: key,
      avatar: msg.user?.avatar || '',
      choice,
      choiceLabel: label,
      correct,
      score: 0,
      ts: Date.now(),
    };
    if (state.voteCounts[choice] != null) state.voteCounts[choice]++;
    state.answers.push(entry);
    if (state.answers.length > 300) state.answers.shift();
    state.answersByUser.set(key, entry);
    const cnt = state.ansCount.get(key) || 0;
    state.ansCount.set(key, cnt + 1);   // 仅首答计数，供揭晓时连对中断判定
    state.feed.push({ type: 'answer', user: name, avatar: msg.user?.avatar || '', choiceLabel: label, correct, ts: Date.now() });
    state.userChoice.set(key, choice);
  }
  trimFeed(state);

  if (correct) {
    if (cfg.mode === 'first-correct') {
      if (state.winnerLocked) {
        ctx.log('INFO', `[quiz] ${name} 答对 ${label}，但已被抢先`);
        emit.state();
        return true;
      }
      state.winnerLocked = true;
      const cur = state.answersByUser.get(key);
      cur.score = computeScore(state, cfg);
      ctx.log('INFO', `[quiz] ${name} 抢答命中 ${label} +${cur.score} 分`);
      reveal(ctx, 'win', cur);
      return true;
    } else {
      if (!state.correctSet.has(key)) state.correctSet.add(key);
      const cur = state.answersByUser.get(key);
      cur.score = computeScore(state, cfg); // 预存按答题时刻计算的分数
      ctx.log('INFO', `[quiz] ${name} 答对 ${label} +${cur.score} 分`);
      emit.state();
      return true;
    }
  }

  ctx.log('INFO', `[quiz] ${name} 选 ${label}（错误）`);
  emit.state();
  return true;
}

/* ═══════════════ 点赞 / 礼物 → 排除答案 ═══════════════ */

/**
 * 从当前题的「错误选项」中随机排除一个（绝不排除正确答案）。
 * 已排除过的不再重复排除。无可排除项（错误项已排除完）时返回 null。
 * @returns {string|null} 被排除选项的 label（如 'B'），无可排除项时 null
 */
function eliminateOneWrong(ctx) {
  const { state } = ctx;
  const q = state.question;
  if (!q) return null;
  const wrong = [];
  for (let i = 0; i < q.options.length; i++) {
    if (i === q.answerIndex) continue;                       // 正确答案永不排除
    if (state.eliminated.some(e => e.idx === i)) continue;   // 已排除的不再重复
    wrong.push(i);
  }
  if (!wrong.length) return null;
  const pick = wrong[Math.floor(Math.random() * wrong.length)];
  return { idx: pick, label: q.options[pick].label };
}

/** 通用：排除一个答案并写入实时答题流（feed 类型 eliminate），随后推送状态。
 *  state.eliminated 记录 {idx, source, user, avatar}，供展示屏角标显示「头像 名字 点赞/礼物排除」 */
function doEliminate(ctx, ev) {
  const hit = eliminateOneWrong(ctx);
  if (!hit) return false;            // 已无错误项可排除
  ctx.state.eliminated.push({
    idx: hit.idx,
    source: ev.source === 'gift' ? 'gift' : 'like',
    user: ev.user || '匿名',
    avatar: ev.avatar || '',
  });
  ev.type = 'eliminate';
  ev.option = hit.label;
  ev.ts = Date.now();
  ctx.state.feed.push(ev);
  trimFeed(ctx.state);
  ctx.emit.state();                    // 让展示屏立即灰显选项 + 写记录到答题区
  return true;
}

/** 个人单局点赞达阈值 → 排除一个答案；每位观众每局最多 1 次（host 把 like 事件路由到此） */
function handleLike(ctx, msg) {
  const { state, cfg } = ctx;
  if (!cfg.likeEliminateEnabled) return;
  if (state.status !== 'asking' || !state.question) return;  // 仅答题期生效
  const key = (msg.user && (msg.user.id || msg.user.displayId)) || (msg.user && msg.user.name) || 'anon';
  const name = (msg.user && msg.user.name) || '匿名';
  const inc = Math.max(1, parseInt(msg.likeCount, 10) || 1);
  let rec = state.likesByUser.get(key);
  if (!rec) {
    rec = { name, avatar: (msg.user && msg.user.avatar) || '', count: 0, elimDone: 0 };
    state.likesByUser.set(key, rec);
  }
  rec.name = name;
  if (msg.user && msg.user.avatar) rec.avatar = msg.user.avatar;
  rec.count += inc;
  state.likeCountThisRound += inc; // 房间总赞（进度展示/日志用）

  const threshold = Math.max(1, cfg.likeEliminateAt);
  // 每人每局仅一次：达阈值即排除一个错误项；已触发过的不再重复（剩余错误项不足时自动停）
  if (rec.elimDone < 1 && rec.count >= threshold) {
    const ok = doEliminate(ctx, { source: 'like', user: rec.name, avatar: rec.avatar, count: threshold });
    if (ok) rec.elimDone = 1;
  }
  ctx.emit.state(); // 点赞进度变化 → 展示屏实时刷新进度条
}

/** 记录最近送礼（含抖音官方礼物图），供展示屏「礼物提示行」显示礼物图（跨局保留，最多 8 条） */
function recordGift(ctx, msg) {
  const image = typeof msg.giftImage === 'string' && msg.giftImage.startsWith('http') ? msg.giftImage : '';
  const list = ctx.state.recentGifts;
  list.push({
    user: (msg.user && msg.user.name) || '匿名',
    giftName: msg.giftName || '礼物',
    image,
    ts: Date.now(),
  });
  if (list.length > 8) list.shift();
}

/** 送礼物 → 排除一个答案（host 把 gift 事件路由到此） */
function handleGift(ctx, msg) {
  const { state, cfg } = ctx;
  recordGift(ctx, msg);                     // 无论开关与否都记录（礼物图提示行用）
  if (!cfg.giftEliminateEnabled) return;
  if (state.status !== 'asking' || !state.question) return;  // 仅答题期生效
  doEliminate(ctx, {
    source: 'gift',
    user: (msg.user && msg.user.name) || '匿名',
    avatar: (msg.user && msg.user.avatar) || '',
    giftName: msg.giftName || '',
    giftCount: msg.giftCount || 1,
  });
}

/**
 * 关注主播 → 本题算答对（host 把 follow 事件路由到此）。
 * 防重复：同一观众按 cfg.followCooldownHours（默认 21 小时）冷却，
 * 冷却期内再次收到关注事件只记日志、不重复计分（抖音会重复推送关注消息）。
 */
function handleFollow(ctx, msg) {
  const { state, cfg } = ctx;
  if (!cfg.followAsCorrect) return;
  if (state.status !== 'asking' || !state.question) return;   // 仅答题期生效
  const q = state.question;
  const key = (msg.user && (msg.user.id || msg.user.displayId)) || (msg.user && msg.user.name) || 'anon';
  const name = (msg.user && msg.user.name) || '匿名';
  const now = Date.now();
  const hours = Math.max(1, Number(cfg.followCooldownHours) || 21);
  const cdMs = hours * 3600 * 1000;

  loadFollowCd();
  const last = state_followCd.get(key) || 0;
  if (now - last < cdMs) {
    const leftH = ((cdMs - (now - last)) / 3600000).toFixed(1);
    ctx.log('INFO', `[quiz] 「${name}」关注在 ${hours}h 冷却内（剩 ${leftH}h），不重复计入本题`);
    return;
  }
  state_followCd.set(key, now);
  saveFollowCd();

  // 已答过的观众：关注不再改写其既有作答（避免把错误答案翻成正确）
  if (state.answersByUser.has(key)) {
    ctx.log('INFO', `[quiz] 「${name}」本题已作答，关注不改写（冷却已记录）`);
    return;
  }

  // 记为一次「答对」：直接选正确答案，按基础分计（不参与时间加成，分数可预期）
  const choice = q.answerIndex;
  const score = Math.round(Number(cfg.baseScorePerWin) || 100);
  const entry = {
    user: name,
    userId: key,
    avatar: (msg.user && msg.user.avatar) || '',
    choice,
    choiceLabel: q.options[choice].label,
    correct: true,
    score,
    viaFollow: true,            // 供 reveal 判定：不参与「最快答对」竞速
    ts: now,
  };
  state.answers.push(entry);
  if (state.answers.length > 300) state.answers.shift();
  state.answersByUser.set(key, entry);
  state.userChoice.set(key, choice);
  state.ansCount.set(key, (state.ansCount.get(key) || 0) + 1);
  if (state.voteCounts[choice] != null) state.voteCounts[choice]++;
  state.correctSet.add(key);
  state.feed.push({ type: 'follow', user: name, avatar: entry.avatar, score, ts: now });
  trimFeed(state);
  ctx.log('INFO', `[quiz] 「${name}」关注主播 → 本题算答对 +${score} 分（冷却 ${hours}h）`);
  ctx.emit.state();
}

/* ═══════════════ 控制指令 ═══════════════ */

function handleAction(ctx, action, payload = {}) {
  const { state, cfg, emit } = ctx;
  switch (action) {
    case 'start':
    case 'next':
      if (state.status === 'asking') return { ok: false, msg: '当前正在答题中' };
      askNext(ctx);
      return { ok: true, msg: `第 ${state.roundNo} 题已出（${cfg.roundIntervalSec}s 竞答）` };
    case 'reveal':
      if (state.status === 'asking') { reveal(ctx, 'timeout'); return { ok: true, msg: '已提前揭晓' }; }
      return { ok: false, msg: '当前不在答题期' };
    case 'pause':
      if (state.status === 'asking') {
        ctx.clearTimers();
        state.pausedRemain = Math.max(0, state.deadline - Date.now());   // 冻结剩余时间
        state.status = 'paused';
        emit.state();
        return { ok: true, msg: `已暂停（剩余 ${Math.ceil(state.pausedRemain / 1000)}s 冻结）` };
      }
      return { ok: false, msg: '无法暂停' };
    case 'resume':
      if (state.status === 'paused') {
        state.status = 'asking';
        // 按暂停时冻结的剩余时间续时；没有记录则退回满时长
        state.deadline = Date.now() + Math.max(1000, state.pausedRemain || cfg.roundIntervalSec * 1000);
        state.pausedRemain = 0;
        scheduleTimeout(ctx);
        emit.state();
        return { ok: true, msg: '已继续' };
      }
      return { ok: false, msg: '当前未暂停' };
    case 'setQuestion': {
      // 即时出手动题（不论 source 配置）
      const raw = {
        q: String(payload.q || cfg.manualQuestion || '').trim(),
        options: String(payload.options || cfg.manualOptions || '').split(/[\n,，;；]+/).map(s => s.trim()).filter(Boolean),
        answer: typeof payload.answer === 'number' ? payload.answer : (typeof cfg.manualAnswer === 'string' ? 'ABCD'.indexOf(cfg.manualAnswer.toUpperCase()) : cfg.manualAnswer),
        explain: String(payload.explain || cfg.manualExplain || ''),
      };
      if (!raw.q || raw.options.length < 2) return { ok: false, msg: '手动题不完整（需题干 + 至少 2 个选项）' };
      if (!Number.isInteger(raw.answer) || raw.answer < 0 || raw.answer >= raw.options.length) raw.answer = 0;
      askQuestion(ctx, { ...raw, source: 'manual' });
      return { ok: true, msg: `已出手动题：${raw.q}` };
    }
    case 'setRoomFilter': {
      cfg.allowedRoomId = String(payload.roomId || '').trim();
      ctx.persistConfig(cfg);
      emit.state();
      return { ok: true, msg: '直播间筛选已更新' };
    }
    case 'config': {
      const allowed = ['roundIntervalSec', 'resultShowSec', 'autoNextRound', 'baseScorePerWin',
        'timeBonusPct', 'streakBonus', 'fastestBonus',
        'rateLimitSec', 'allowChangeAnswer', 'questionSource', 'shuffleOptions', 'mode', 'wrongPenalty',
        'manualQuestion', 'manualOptions', 'manualAnswer', 'manualExplain', 'allowedRoomId',
        'hostShowAnswer', 'hideAnswerFeed',
        'likeEliminateEnabled', 'likeEliminateAt', 'giftEliminateEnabled',
        'followAsCorrect', 'followCooldownHours',
        'tikuCategories', 'tikuDifficulties',
        ...BC_CFG_KEYS];                       // aiBroadcast/aiApiUrl/aiApiKey/aiModel/aiTimeoutSec/bcAutoSpeak/bcEnabled
      for (const k of allowed) if (payload[k] !== undefined) cfg[k] = payload[k];
      // 手动答案若为字母归一为下标
      if (typeof cfg.manualAnswer === 'string') {
        const idx = 'ABCD'.indexOf(cfg.manualAnswer.toUpperCase());
        cfg.manualAnswer = idx >= 0 ? idx : 0;
      }
      ctx.persistConfig(cfg);
      ctx.log('INFO', '[quiz config]', cfg);
      emit.state();
      return { ok: true, msg: '配置已更新' };
    }
    case 'simulateAnswer': {
      const text = String(payload.text || '').trim();
      if (!text) return { ok: false, msg: '请输入要模拟的答题内容（如 A 或 1）' };
      if (state.status !== 'asking') return { ok: false, msg: '当前未在答题期，无法模拟' };
      const name = String(payload.name || '模拟观众').trim() || '模拟观众';
      const simId = 'sim_' + name;
      const msg = { event: 'chat', user: { id: simId, displayId: simId, name, avatar: '' }, text, roomId: '' };
      handleDanmu(ctx, msg);
      return { ok: true, msg: `已模拟「${name}」答题 ${text}` };
    }
    case 'simulateLike': {
      if (state.status !== 'asking' || !state.question) return { ok: false, msg: '当前未在答题期，无法模拟点赞' };
      const n = Math.max(1, parseInt(payload.count, 10) || 10);
      const name = String(payload.name || '模拟观众').trim() || '模拟观众';
      handleLike(ctx, { event: 'like', likeCount: n, user: { id: 'sim_' + name, displayId: 'sim_' + name, name, avatar: '' } });
      const rec = state.likesByUser.get('sim_' + name);
      return { ok: true, msg: `「${name}」点赞 +${n}（本局累计 ${rec ? rec.count : 0}/${cfg.likeEliminateAt}）` };
    }
    case 'simulateGift': {
      if (state.status !== 'asking' || !state.question) return { ok: false, msg: '当前未在答题期，无法模拟送礼' };
      const name = String(payload.name || '模拟观众').trim() || '模拟观众';
      handleGift(ctx, { event: 'gift', giftName: '模拟礼物', giftCount: 1, user: { id: 'sim_' + name, displayId: 'sim_' + name, name, avatar: '' } });
      return { ok: true, msg: `已模拟「${name}」送礼（排除一个错误答案）` };
    }
    /**
     * 主播台取当前题答案。
     * 只返回给 /api/control 的调用方（即主播台），绝不进 SSE —— 观众的展示屏
     * 拿不到答案，既不会在画面上提前剧透，抓包/控制台也看不到。
     */
    case 'peek': {
      if (!cfg.hostShowAnswer) return { ok: false, msg: '已关闭「主播台显示答案」' };
      const q = state.question;
      const opt = q && q.options && q.options[q.answerIndex];
      if (!opt) return { ok: false, msg: '当前没有题目' };
      // 宿主 /api/control 只转发 {ok, msg, state}，其余自定义字段会被丢弃；
      // 但它允许用 r.state 覆盖回传内容 —— 借这条通道把答案带回主播台。
      // 该响应只发给 /api/control 的调用方，不进 SSE，观众看不到。
      return {
        ok: true, msg: 'ok',
        state: {
          roundNo: state.roundNo,
          answerIndex: q.answerIndex,
          answerLabel: opt.label,
          answerText: opt.text,
        },
      };
    }
    case 'narrate': {
      // 手动触发口播：重新生成当前题口播，经通用播报通道推给控制台朗读（不剧透答案）
      if (BC(ctx).mode() === 'off') return { ok: false, msg: 'AI 口播已关闭（在 AI 播报面板里开启）' };
      if (!state.question) return { ok: false, msg: '当前没有题目' };
      generateNarration(ctx);
      return { ok: true, msg: '正在生成口播…' };
    }
    default:
      return { ok: false, msg: `未知动作: ${action}` };
  }
}

/* ═══════════════ 对外状态 ═══════════════ */

/** 题库元信息：供主播台动态渲染「分类 / 难度」下拉，含当前筛选命中的题数 */
function tikuMeta(cfg) {
  const t = loadTiku();
  if (!t) return { categories: [], difficulties: [], counts: {}, total: 0, matched: 0 };
  const matched = filterPool(t.pool, cfg && cfg.tikuCategories, cfg && cfg.tikuDifficulties).length;
  return { categories: t.categories, difficulties: t.difficulties, counts: t.counts, total: t.pool.length, matched };
}

function publicState(ctx) {
  const { state, cfg } = ctx;
  const q = state.question;
  let qOut = null;
  if (q) {
    if (state.status === 'revealed') {
      qOut = {
        q: q.q,
        options: q.options.map(o => ({ label: o.label, text: o.text, isCorrect: o.isCorrect })),
        answerIndex: q.answerIndex,
        explain: q.explain || '',
        source: q.source,
        category: q.category || '',
        difficulty: q.difficulty || '',
      };
    } else {
      // asking/paused/idle：不剧透答案
      qOut = {
        q: q.q,
        options: q.options.map(o => ({ label: o.label, text: o.text })),
        answerIndex: -1,
        source: q.source,
        category: q.category || '',
        difficulty: q.difficulty || '',
      };
    }
  }

  // recentAnswers / feed 的 answer 事件都带 correct 字段，答题期会提前泄露答案。
  // hideAnswerFeed=true：recentAnswers 直接不下发（前端本就无人消费），
  // feed 只保留结算类（streak/fastest），过滤掉逐条作答明细。
  const hideDetail = !!cfg.hideAnswerFeed;
  const recentAnswers = hideDetail ? [] : state.answers.slice(-8).map(a => ({
    user: a.user, avatar: a.avatar, choiceLabel: a.choiceLabel, correct: a.correct,
  }));

  const feed = (hideDetail ? state.feed.filter(e => e.type !== 'answer') : state.feed)
    .map(e => ({ ...e }));

  // 每个选项的答题人头像（供展示屏在选项右侧显示；人数过多时前端封顶，绝不覆盖选项文本）。
  // 从 state.answers 派生，与 hideAnswerFeed 无关（它只隐藏「逐条作答明细」，这里只是投票分布的头像化）。
  const optVoters = (state.question && state.question.options)
    ? state.question.options.map((_o, idx) =>
        state.answers
          .filter(a => a.choice === idx)
          .map(a => ({ name: a.user, avatar: a.avatar }))
          .slice(-12)   // 每选项最多带 12 个，控制 SSE  payload 体积
      )
    : [];

  return {
    status: state.status,
    roundNo: state.roundNo,
    narration: state.narration,          // 当前题口播引导语（绝不剧透答案），供控制台 TTS 朗读
    narrationId: state.narrationId,     // 自增 ID，控制台据此判断是否该朗读新的一条
    question: qOut,
    voteCounts: state.voteCounts,
    optionVoters: optVoters,
    answeredCount: state.answers.length,
    correctCount: state.answers.filter(a => a.correct).length,
    recentAnswers,
    feed,
    eliminated: state.eliminated,   // [{idx,source,user,avatar}] 已排除选项记录（展示屏灰显 + 角标显示触发者；绝不排除正确答案）
    likeCountThisRound: state.likeCountThisRound,
    // 个人单局点赞进度（供展示屏进度条）：按点赞数降序取前 5 名；
    // done=是否已用掉本局「点赞排除」机会（每人每局 1 次）
    likeProgress: [...state.likesByUser.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(r => ({ name: r.name, avatar: r.avatar, count: r.count, done: r.elimDone > 0 })),
    // 本地 1 钻礼物图（res/礼物资源，文件名后缀为钻石数；展示屏「赠送礼物排除一个错误答案」提示行固定显示）
    giftIcons: GIFT_ICONS.filter(g => g.cost <= 1).slice(0, 7),
    // 最近礼物的抖音官方图（按最新送礼去重、最多 4 张；供展示屏「赠送礼物排除一个错误答案」提示行）
    giftImages: (() => {
      const seen = new Set();
      const out = [];
      for (let i = state.recentGifts.length - 1; i >= 0 && out.length < 4; i--) {
        const u = state.recentGifts[i].image;
        if (u && !seen.has(u)) { seen.add(u); out.push(u); }
      }
      return out;
    })(),
    deadline: state.deadline,
    nextRoundAt: state.nextRoundAt,
    roundIntervalSec: cfg.roundIntervalSec,
    resultShowSec: cfg.resultShowSec,
    result: state.result,
    history: state.history.slice(0, 20),
    leaderboard: ctx.topList(),
    tikuMeta: tikuMeta(cfg),
    // AI 播报（通用播报中心）：bc/bcSlots/bcCfg 片段在顶层，密钥明文绝不下发
    ...BC(ctx).publicState(),
    cfg: {
      roundIntervalSec: cfg.roundIntervalSec,
      resultShowSec: cfg.resultShowSec,
      baseScorePerWin: cfg.baseScorePerWin,
      timeBonusPct: cfg.timeBonusPct,
      streakBonus: cfg.streakBonus,
      fastestBonus: cfg.fastestBonus,
      autoNextRound: cfg.autoNextRound,
      questionSource: cfg.questionSource,
      mode: cfg.mode,
      shuffleOptions: cfg.shuffleOptions,
      allowChangeAnswer: cfg.allowChangeAnswer,
      rateLimitSec: cfg.rateLimitSec,
      wrongPenalty: cfg.wrongPenalty,
      allowedRoomId: cfg.allowedRoomId || '',
      // 排除答案开关（主播台面板用）
      likeEliminateEnabled: cfg.likeEliminateEnabled,
      likeEliminateAt: cfg.likeEliminateAt,
      giftEliminateEnabled: cfg.giftEliminateEnabled,
      followAsCorrect: cfg.followAsCorrect,
      followCooldownHours: cfg.followCooldownHours,
    },
  };
}

/** 清理游戏内定时器（host 调用） */
function clearGameTimers(ctx, group) {
  ctx.clearTimers(group);
}

module.exports = {
  MANIFEST,
  CFG_DEFAULTS,
  CONFIG_SCHEMA,
  createState,
  handleDanmu,
  handleLike,
  handleGift,
  handleFollow,
  handleAction,
  publicState,
  clearGameTimers,
};
