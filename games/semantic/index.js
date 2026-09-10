/**
 * ============================================================================
 * games/semantic/index.js — 语义猜词游戏模块
 * ============================================================================
 * 通过统一的「游戏接口」注册进主播台的游戏中心（与猜数字/成语接龙同构）：
 *   - MANIFEST / CFG_DEFAULTS / CONFIG_SCHEMA
 *   - createState() / publicState(ctx)
 *   - handleAction(ctx, action, payload)
 *   - handleDanmu(ctx, msg)
 *   - 定时器经 ctx.setTimer/clearTimers 托管（宿主可统一清理）
 *
 * 【玩法】每轮从答案池随机抽一个「神秘词」，对全词表预计算语义排名；
 *   观众弹幕直接发一个词，服务端返回「与答案的相似度百分比 + 排名」，
 *   排名第 1 即猜中。分数曲线为分段折线（见 engine.js rankToPercent）。
 *
 * 【安全】答案词只保存在服务端 state；publicState 输出走白名单，
 *   揭晓前任何字段都不携带答案（含 SSE 负载）。
 * ============================================================================
 */
'use strict';

const engine = require('./engine');
const POS = require('./pos');
const { createBroadcaster, BC_CFG_DEFAULTS, BC_CFG_KEYS } = require('../../common/broadcast');
const SLOTS = require('./slots');

// 模块加载即后台预热模型（约 110MB，秒级），开轮时大概率已就绪；失败静默，开轮时再报
engine.warmup();

/* ═══════════════ 注册信息 ═══════════════ */

const MANIFEST = {
  id: 'semantic',
  name: '语义猜词',
  icon: '🌡️',
  desc: '围绕神秘词弹幕猜词 · 相似度百分比 · 越猜越热',
  liveStatuses: ['gambling'],
  score: { wins: 'semantic_wins', score: 'semantic_score', floors: null },
};

/* ═══════════════ 配置默认值（config.json 持久化，主播台表单可实时调） ═══════════════ */

const CFG_DEFAULTS = {
  roundIntervalSec: 150,       // 每轮竞猜时长（词比数字难，默认给足）
  resultShowSec: 10,           // 揭晓后停留
  autoNextRound: true,
  rateLimitSec: 2,
  maxGuessesPerUserPerRound: 30,
  baseScorePerWin: 100,        // 猜中基础分 n（结算：猜中者得 n+m）
  assocScoreMax: 50,           // 关联度分上限 m（未猜中者按 m×关联度百分比/100 折算）
  answerLen: 0,                // 答案字数：0=不限，2/3/4=指定字数（自定义谜底不受限）
  posHintSec: 30,              // 开题后第 N 秒公布答案词性（启发式判定）；-1 = 不提示
  followUnlockFirst: true,     // 观众关注主播 → 解锁答案首字提示
  wordHintNames: [],           // 提示词礼物（多选；送名单内任一礼物随机出词；空 = 任意礼物）
  wordHintCount: 3,            // 送提示词礼物后随机出的提示词个数 N；0 = 关闭
  wordHintPerLikes: 50,        // 观众每累计 N 个赞随机解锁 1 个提示词；0 = 关闭
  wordHintRankFrom: 2,         // 提示词抽取名次下限（可设 1=含答案，送礼随机用；点赞随机强制 ≥10）
  wordHintRankTo: 30,          // 提示词抽取的名次上限（越小越贴答案=越像近义词）
  allowedRoomId: '',
  ...BC_CFG_DEFAULTS,
};

/** 配置表单 schema：与主播台 control.js 表单一一对应（导出供宿主/文档使用） */
const CONFIG_SCHEMA = [
  { key: 'roundIntervalSec', label: '每轮时长(秒)', type: 'number', min: 30, def: 150 },
  { key: 'resultShowSec', label: '揭晓停留(秒)', type: 'number', min: 3, def: 10 },
  { key: 'baseScorePerWin', label: '猜中基础分', type: 'number', min: 1, def: 100 },
  { key: 'assocScoreMax', label: '关联度分上限', type: 'number', min: 0, def: 50 },
  { key: 'autoNextRound', label: '自动开下一轮', type: 'bool', def: true },
  { key: 'maxGuessesPerUserPerRound', label: '每人每轮上限', type: 'number', min: 1, def: 30 },
  { key: 'rateLimitSec', label: '发送间隔(秒)', type: 'number', min: 1, def: 2 },
  { key: 'answerLen', label: '答案字数', type: 'select', options: [['0', '不限'], ['2', '2 字'], ['3', '3 字'], ['4', '4 字']], def: 0 },
  { key: 'posHintSec', label: '词性提示(秒，-1=不提示)', type: 'number', min: -1, def: 30 },
  { key: 'followUnlockFirst', label: '关注解锁首字', type: 'bool', def: true },
  { key: 'wordHintNames', label: '提示词礼物(多选，空=任意)', type: 'text', def: '' },
  { key: 'wordHintCount', label: '随机提示词个数(0=关闭)', type: 'number', min: 0, def: 3 },
  { key: 'wordHintPerLikes', label: '每N赞解锁提示词(0=关闭)', type: 'number', min: 0, def: 50 },
  { key: 'wordHintRankFrom', label: '提示词名次从(第N名)', type: 'number', min: 1, def: 2 },
  { key: 'wordHintRankTo', label: '提示词名次到(第M名)', type: 'number', min: 3, def: 30 },
];

/* ═══════════════ 结算规则 ═══════════════
 * 猜中者：+ 猜中基础分 n + 关联度分上限 m（一口价，不再按时间加成）
 * 未猜中者：揭晓时按实时榜（按关联度百分比降序、同词合并）前 10 行扫描，
 *   最多给 6 个「未拿过分」的不同玩家加分：每人 = round(m × 自己关联度% / 100)。
 *   礼物/点赞解锁词与真实弹幕同样参与结算；仅 OOV 超远猜测行不参与；同一词的多名猜测者只有首个发现者占行。
 *   userId 统一为基础用户 id（不加 gift_/like_ 前缀），同一人弹幕/送礼/点赞只算一个人。
 *   送礼下限可含第 1 名 → 礼物可能直接解锁答案，此时送礼者按「猜中」直接结算并结束本轮。 */
const SETTLE_SCAN_ROWS = 10;   // 结算扫描的榜单行数
const SETTLE_MAX_PLAYERS = 6;  // 结算最多加分的（未猜中）玩家数

/* ═══════════════ 通用 AI 播报中心（common/broadcast） ═══════════════ */
function BC(ctx) {
  if (!ctx._bc) {
    ctx._bc = createBroadcaster({
      gameId: 'semantic', gameName: '语义猜词', slots: SLOTS,
      getCfg: () => ctx.cfg,
      getState: () => ctx.state,
      emit: () => ctx.emit.state(),
      log: ctx.log,
    });
  }
  return ctx._bc;
}

/* ═══════════════ 状态 ═══════════════ */

function createState() {
  return {
    status: 'idle',            // idle | gambling | revealed | paused
    roundNo: 0,
    answer: '',                // 答案词（服务端机密；publicState 白名单输出，揭晓前不下发）
    deadline: 0,
    pausedRemain: 0,
    revealedAt: 0,
    winner: null,
    hintShown: false,          // 首字提示（礼物解锁）
    hintUnlockedBy: null,      // 首字解锁者 { name, avatar }（首字格右上角显示头像）
    followUsed: false,         // 关注解锁首字：整场游戏只生效一次（不随轮次重置）
    likeProgress: { map: new Map(), unlocked: 0, main: null },   // 仿数独：按 uid 累计点赞，满 N 扣 N；main=当前累计最多的观众
    posHintShown: false,       // 词性提示（定时放出）
    answerPos: '',             // 答案词性（启发式，开题时判定）
    guesses: [],               // 本轮猜测流（控制台/展示屏滚动）
    topWords: new Map(),       // 本轮热度榜：word → { word, rank, percent, percentText, user, avatar, ts }（同词首个发现者记账）
    lastAnswers: [],           // 历史揭晓（答案已公开，可下发）
    stats: { rounds: 0, wins: 0 },
    startedAt: Date.now(),
    roundGuessCount: new Map(),
    lastGuessAt: new Map(),
    // 本轮猜测总量统计：与 200 上限的展示数组解耦，逐条累加不受裁剪影响
    guessTally: { total: 0, chat: 0, like: 0, gift: 0, words: new Set() },
    guessBest: new Map(),      // 榜单数据源：按词去重、不裁剪（礼物刷爆也挤不掉高百分比词）
  };
}

/* ═══════════════ 弹幕 → 猜测词提取 ═══════════════ */

const GUESS_PREFIX_RE = /^(?:我猜(?:是|个|一个)?|我来说|我觉得是|答案是|答案|猜(?:一个|个|词)?|词(?:是|汇)?|提示|是)[:：、,，\s]*/;
const TRAIL_PUNCT_RE = /[，。！？!?…、,.~～\-—\s:：'""''《》<>（）()\[\]【】]+$/;
const LEAD_PUNCT_RE = /^[，。！？!?…、,.~～\-—\s:：'""''《》<>（）()\[\]【】]+/;
/** 疑似猜词尝试（用于 oov 时决定是否提示）：纯汉字/字母、长度合理 */
const LOOKS_LIKE_WORD_RE = /^[A-Za-z\u4e00-\u9fa5]{1,8}$/;

/**
 * 清洗弹幕文本 → 猜测词
 * @returns {{ text:string, raw:string, hadPrefix:boolean }}
 *   text  = 判定词：去掉「猜/答案」等指令前缀与首尾标点，用于词库匹配（「猜老师」→「老师」，否则匹配不到词库）
 *   raw   = 展示词：只去首尾空白/标点、保留观众原话（「猜老师」→「猜老师」），上榜与「玩家弹幕词」都显示它
 *   hadPrefix = 是否带明确猜测前缀
 */
function cleanGuess(raw) {
  const trimmed = String(raw || '').trim();
  const shown = trimmed.replace(LEAD_PUNCT_RE, '').replace(TRAIL_PUNCT_RE, '').trim();   // 展示：保留前缀
  let t = shown;
  let hadPrefix = false;
  const p = t.match(GUESS_PREFIX_RE);
  if (p) { hadPrefix = true; t = t.slice(p[0].length); }                                    // 判定：剥离指令前缀
  return { text: t.trim(), raw: shown, hadPrefix };
}

/** 限流（与猜数字同规则） */
function rateCheck(state, cfg, key) {
  const now = Date.now();
  const last = state.lastGuessAt.get(key) || 0;
  if (now - last < cfg.rateLimitSec * 1000) return { ok: false, reason: 'rate' };
  const cnt = state.roundGuessCount.get(key) || 0;
  if (cnt >= cfg.maxGuessesPerUserPerRound) return { ok: false, reason: 'quota' };
  state.lastGuessAt.set(key, now);
  state.roundGuessCount.set(key, cnt + 1);
  return { ok: true };
}

/** 猜中计分：n + m 一口价（结算规则见文件头部「结算规则」注释） */
function winScore(cfg) {
  return Math.max(0, parseInt(cfg.baseScorePerWin, 10) || 0) + Math.max(0, parseInt(cfg.assocScoreMax, 10) || 0);
}

/**
 * 逐条累加本轮猜测统计（与 200 上限的展示数组解耦：即使被裁剪，总量与来源仍准确）。
 * 按 entry.source 归类（缺省按 chat/oov→chat、gift 标记→gift），并累计去重词数。
 */
function tallyGuess(ctx, entry) {
  const t = ctx.state.guessTally;
  const src = entry.source || (entry.gift ? 'gift' : (entry.oov ? 'chat' : 'chat'));
  t.total++;
  if (src === 'like') t.like++;
  else if (src === 'gift') t.gift++;
  else t.chat++;
  t.words.add(entry.guess);
}

/**
 * 结算：猜中者 +n+m；随后按实时榜（百分比降序、同词合并）前 10 行扫描，
 * 最多给 6 个未拿过分的不同玩家各加 round(m × 关联度% / 100)。
 * @returns {Array} 结算行 [{kind:'win'|'top'|'assoc', user, avatar, word, percentText, points}]
 */
function settleRound(ctx, winnerGuess) {
  const { cfg } = ctx;
  const m = Math.max(0, parseInt(cfg.assocScoreMax, 10) || 0);
  const awarded = new Set();
  const list = [];
  if (winnerGuess) {
    const pts = winScore(cfg);
    ctx.award(winnerGuess, pts);
    awarded.add(winnerGuess.userId || winnerGuess.user);
    list.push({ kind: 'win', user: winnerGuess.user, avatar: winnerGuess.avatar || '', word: winnerGuess.guess, percentText: '100.00', points: pts });
  }
  if (m > 0) {
    let assocCount = 0;
    for (const row of boardRows(ctx).slice(0, SETTLE_SCAN_ROWS)) {
      if (assocCount >= SETTLE_MAX_PLAYERS) break;
      if (row.oov || row.isWin) continue;   // 超远猜测/已猜中行不参与；礼物与点赞解锁词正常参与结算
      const key = row.userId || row.user;
      if (awarded.has(key)) continue;
      const pts = Math.round(m * row.percent / 100);
      if (pts <= 0) continue;
      ctx.awardScore({ userId: row.userId, user: row.user, avatar: row.avatar }, pts);
      awarded.add(key);
      assocCount++;
      list.push({
        kind: (!winnerGuess && list.length === 0) ? 'top' : 'assoc',
        user: row.user, avatar: row.avatar, word: row.guess, percentText: row.percentText, points: pts,
      });
    }
  }
  return list;
}

/* ═══════════════ 轮次流程 ═══════════════ */

/** 开一轮。customWord 传空则从答案池随机抽（排除最近用过的词） */
function startRound(ctx, customWord = '') {
  const { state, cfg, emit } = ctx;
  if (!engine.ready()) {
    ctx.log('WARN', '[semantic] 模型尚未就绪，本轮未开始（稍等数秒再开）');
    emit.notice('模型加载中，请稍候几秒再开始');
    return false;
  }
  // 选答案：自定义词需在词表内；随机词排除最近 20 轮用过的
  let answer = String(customWord || '').trim();
  if (answer) {
    if (!engine.hasWord(answer)) {
      emit.notice(`「${answer}」不在词库中，无法作为答案`);
      return false;
    }
  } else {
    const recent = state.lastAnswers.slice(0, 20).map(r => r.answer);
    answer = engine.pickAnswer(recent, Math.max(0, parseInt(cfg.answerLen, 10) || 0));
  }
  const r = engine.setAnswer(answer);
  if (!r.ok) {
    ctx.log('WARN', `[semantic] setAnswer 失败: ${r.msg}`);
    emit.notice(r.msg || '出题失败，请重试');
    return false;
  }

  clearGameTimers(ctx);
  state.answer = answer;
  state.roundNo++;
  state.winner = null;
  state.guesses = [];
  state.topWords = new Map();
  state.settle = [];            // 上轮结算行（揭晓面板用）
  state._boardFp = '';          // 猜测榜指纹重置（榜变化才推 state，见 handleDanmu）
  state.hintShown = false;      // 首字提示（礼物解锁）
  state.hintUnlockedBy = null;
  state.likeProgress = { map: new Map(), unlocked: 0, main: null };   // 点赞解锁进度（每轮清零）
  state.posHintShown = false;   // 词性提示
  state.answerPos = POS.pos(answer);
  state.roundGuessCount.clear();
  state.guessTally = { total: 0, chat: 0, like: 0, gift: 0, words: new Set() };   // 本轮统计清零
  state.guessBest = new Map();   // 榜单去重表清零
  state.status = 'gambling';
  state.deadline = Date.now() + cfg.roundIntervalSec * 1000;
  state.stats.rounds++;
  ctx.log('INFO', `[round #${state.roundNo}] 开题，答案=「${answer}」（对外保密，词性=${state.answerPos}），${cfg.roundIntervalSec}s 竞猜，全表排名已就绪（${r.ms}ms）`);
  emit.state();
  BC(ctx).speak('roundOpen', { round: state.roundNo, sec: cfg.roundIntervalSec });
  scheduleRevealTimer(ctx);
  schedulePosHint(ctx);
  return true;
}

function scheduleRevealTimer(ctx) {
  const { state } = ctx;
  ctx.clearTimers('timeout');
  const remain = Math.max(0, state.deadline - Date.now());
  ctx.setTimer('timeout', () => reveal(ctx, 'timeout'), remain);
}

/** 词性提示定时器（posHintSec < 0 = 不提示） */
function schedulePosHint(ctx) {
  const { state, cfg } = ctx;
  ctx.clearTimers('posHint');
  if (cfg.posHintSec == null || cfg.posHintSec < 0) return;
  ctx.setTimer('posHint', () => {
    if (state.status !== 'gambling') return;
    state.posHintShown = true;
    ctx.log('INFO', `[round #${state.roundNo}] 词性提示已放出：「${state.answerPos}」`);
    ctx.emit.state();
  }, Math.max(0, cfg.posHintSec) * 1000);
}

function reveal(ctx, reason, winnerGuess) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'gambling') return;
  ctx.clearTimers();
  state.status = 'revealed';
  state.revealedAt = Date.now();
  // 结算（含超时轮：榜首及上榜玩家照常拿关联度分）
  const settleList = settleRound(ctx, reason === 'win' ? winnerGuess : null);
  state.settle = settleList;
  // 榜首（超时播报用）
  const rows = boardRows(ctx);
  const top = rows.find(r => !r.oov) || rows[0] || null;
  if (reason === 'win' && winnerGuess) {
    const score = winScore(cfg);
    state.winner = {
      name: winnerGuess.user || '匿名',
      avatar: winnerGuess.avatar || '',
      guess: winnerGuess.guess,
      percentText: '100.00',
      score,
      ts: winnerGuess.ts,
    };
    state.stats.wins++;
    ctx.log('INFO', `[round #${state.roundNo}] 🎉 ${state.winner.name} 猜中「${state.answer}」（+${score} 分）！本轮结束`);
    BC(ctx).speak('win', {
      round: state.roundNo, user: state.winner.name, guess: state.winner.guess,
      answer: state.answer, score,
    });
  } else {
    ctx.log('INFO', `[round #${state.roundNo}] ⏰ 揭晓（超时未猜中），答案=「${state.answer}」，最接近：${top ? `「${top.raw || top.guess}」${top.percentText}%` : '（无有效猜测）'}，结算 ${settleList.length} 人`);
    BC(ctx).speak('timeout', {
      round: state.roundNo, answer: state.answer,
      best: top ? (top.raw || top.guess) : '—', bestPercent: top ? top.percentText : '0.00',
    });
  }
  state.lastAnswers.unshift({
    roundNo: state.roundNo,
    answer: state.answer,
    winner: state.winner ? state.winner.name : null,
    winnerScore: state.winner ? state.winner.score : null,
    ts: Date.now(),
  });
  if (state.lastAnswers.length > 50) state.lastAnswers.pop();
  emit.state();
  if (cfg.autoNextRound) {
    ctx.setTimer('next', () => startRound(ctx), Math.max(0, cfg.resultShowSec) * 1000);
  }
}

/** 全部猜测按关联度百分比降序（同分先发现的在前） */
function sortedGuesses(ctx) {
  return [...ctx.state.guesses].sort((a, b) => (b.percent - a.percent) || (a.ts - b.ts));
}

/**
 * 榜单/结算的数据源：按「判定词」去重、保留每个词的最优条目，**不随 200 上限数组被裁剪**。
 * 记录在 guessBest（Map），礼物/点赞一次刷几十上百词也不会把之前高百分比的真实弹幕词挤掉。
 * 返回按百分比降序（同分先发现优先）的行。
 */
function boardRows(ctx) {
  return [...ctx.state.guessBest.values()].sort((a, b) => (b.percent - a.percent) || (a.ts - b.ts));
}

/** 记录一条猜测到 guessBest（首见建条目并计数；再次命中同词只累加 count） */
function recordBest(ctx, entry) {
  const map = ctx.state.guessBest;
  const ex = map.get(entry.guess);
  if (ex) {
    ex.count++;
    if (entry.isWin) ex.isWin = true;
    return;
  }
  map.set(entry.guess, {
    userId: entry.userId, user: entry.user, avatar: entry.avatar || '', guess: entry.guess,
    raw: entry.raw || entry.guess,
    percent: entry.percent, percentText: entry.percentText,
    isWin: !!entry.isWin, oov: !!entry.oov,
    gift: !!entry.gift, source: entry.source || (entry.gift ? 'gift' : 'chat'),
    ts: entry.ts, count: 1,
  });
}

/** 展示屏「实时猜测」面板的数据源（下发前 30 行，容器展示多少由 CSS 裁切） */
function guessBoardList(ctx) {
  return boardRows(ctx).slice(0, 30);
}

/** 登记一条猜测进热度榜（同词首个发现者记账；更优排名才刷新） */
function upsertTopWord(ctx, entry) {
  const { state, cfg } = ctx;
  const prev = state.topWords.get(entry.guess);
  if (prev && prev.rank <= entry.rank) return false;   // 已有人先猜出且名次不差于本次
  state.topWords.set(entry.guess, {
    word: entry.guess,
    rank: entry.rank,
    percent: entry.percent,
    percentText: entry.percentText,
    user: entry.user,
    avatar: entry.avatar,
    ts: entry.ts,
  });
  // 榜上只留 30 行，防长轮膨胀（排序后再裁剪）
  if (state.topWords.size > 30) {
    const keep = new Map([...state.topWords.values()]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 30)
      .map(w => [w.word, w]));
    state.topWords = keep;
  }
  return true;
}

/* ═══════════════ 弹幕处理 ═══════════════ */

function handleDanmu(ctx, msg) {
  const { state, cfg, emit } = ctx;
  if (!msg || msg.event !== 'chat' || !msg.text) return false;
  // 房间ID过滤：留空=接受所有房间；msg.roomId 为空时不拦
  if (cfg.allowedRoomId && msg.roomId) {
    const allowedSet = String(cfg.allowedRoomId).split(/[,，\s]+/).filter(Boolean);
    if (allowedSet.length && !allowedSet.includes(String(msg.roomId))) return false;
  }

  const { text: word, raw: shownRaw, hadPrefix } = cleanGuess(msg.text);
  // 猜测词上限 4 字：超过 4 个字视为普通聊天，不进入游戏（静默忽略）
  if (!word || word.length > 4) return false;

  if (state.status !== 'gambling') {
    // 带明确猜测前缀的才提醒（≤4 字的普通短聊天在非竞猜期静默忽略）
    if (hadPrefix) {
      ctx.log('INFO', `[danmu] ${msg.user?.name || '匿名'} 在非竞猜期发来「${msg.text}」（忽略）`);
      emit.notice(`本轮未开始/已结束，${msg.user?.name || '匿名'} 的猜测未计入`);
      return true;
    }
    return false;
  }

  // 限流
  const key = msg.user?.id || msg.user?.displayId || msg.user?.name || '匿名';
  const rc = rateCheck(state, cfg, key);
  if (!rc.ok) {
    if (hadPrefix || LOOKS_LIKE_WORD_RE.test(word)) {
      if (rc.reason === 'rate') emit.notice(`「${msg.user?.name || '匿名'}」猜得太快，${cfg.rateLimitSec}s 后再试`);
      else emit.notice(`「${msg.user?.name || '匿名'}」本轮已达到 ${cfg.maxGuessesPerUserPerRound} 次上限`);
    }
    return true;
  }

  // 词表判定 + 语义排名
  const j = engine.judge(word);
  if (!j.ok) {
    if (j.reason === 'oov' && (hadPrefix || LOOKS_LIKE_WORD_RE.test(word))) {
      // 词库外的词：作为「超远猜测」上墙（不报错、不进热度榜、不可能猜中）
      //   名次显示「第10000+名」；关联度随机 1~10%；伪排名排在全部真实词之后，
      //   伪词之间按关联度降序（rank = N + 11 - percent）。
      const percent = +(1 + Math.random() * 9).toFixed(2);
      const N = engine.info().words || 9999999;
      const entry = {
        user: msg.user?.name || '匿名',
        userId: key,
        avatar: msg.user?.avatar || '',
        guess: word,
        raw: shownRaw,          // 展示用：观众原话（「猜老师」不会被删成「老师」）
        source: 'chat', oov: true,
        rank: N + 11 - Math.round(percent),
        percent,
        percentText: percent.toFixed(2),
        isWin: false,
        ts: Date.now(),
        roomId: msg.roomId || '',
      };
      state.guesses.push(entry);
      if (state.guesses.length > 200) state.guesses.shift();
      tallyGuess(ctx, entry);
      recordBest(ctx, entry);
      ctx.log('INFO', `[guess] ${entry.user}: 「${entry.guess}」（词库外）→ 超远猜测 ${percent}%`);
      emit.guess(entry);
      const oovFp = guessBoardList(ctx).map(g => `${g.user}|${g.guess}|${g.ts}|${g.count}`).join(',');
      if (oovFp !== state._boardFp) {
        state._boardFp = oovFp;
        emit.state();
      }
      return true;
    }
    return false;
  }

  const entry = {
    user: msg.user?.name || '匿名',
    userId: key,
    avatar: msg.user?.avatar || '',
    guess: j.word,
    raw: shownRaw,              // 展示用：观众原话（判定词 j.word 可能去掉了「猜」前缀）
    source: 'chat',
    rank: j.rank,
    percent: j.percent,
    percentText: j.percentText,
    isWin: j.isWin,
    ts: Date.now(),
    roomId: msg.roomId || '',
  };

  upsertTopWord(ctx, entry);

  state.guesses.push(entry);
  if (state.guesses.length > 200) state.guesses.shift();
  tallyGuess(ctx, entry);
  recordBest(ctx, entry);
  ctx.log('INFO', `[guess] ${entry.user}: 「${entry.guess}」→ 第 ${j.rank} 名 · ${j.percentText}%${j.learned ? `（学习:${(j.pieces || []).join('+')}）` : ''}${j.isWin ? ' 🎉猜中！' : ''}`);
  if (j.isWin) {
    // 猜中只播 win，不再叠播「有人逼近」
    reveal(ctx, 'win', entry);   // 计分统一在结算（settleRound）里做：猜中者 n+m
  } else {
    // 「有人逼近」：实时猜测榜进前三 且 相似度 > 90%；rank 用榜内名次（1/2/3），不是词库名次
    const boardRank = boardRows(ctx).findIndex(r => r.guess === entry.guess) + 1;
    if (boardRank >= 1 && boardRank <= 3 && j.percent > 90) {
      BC(ctx).speak('hot', { word: entry.guess, rank: boardRank, percent: entry.percentText, user: entry.user });
    }
  }
  emit.guess(entry);
  // 猜测榜（top 30）成员/名次/百分比/×N 计数任一有变化才推整份状态
  const boardFp = guessBoardList(ctx).map(g => `${g.user}|${g.guess}|${g.ts}|${g.percentText}|${g.count}`).join(',');
  if (boardFp !== state._boardFp) {
    state._boardFp = boardFp;
    emit.state();
  }
  return true;
}

/** 礼物名单归一化：数组或逗号分隔字符串 → 去空白字符串数组 */
function normalizeGiftNames(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,，\s]+/);
  return arr.map(s => String(s).trim()).filter(Boolean);
}

/** 礼物是否命中名单（名单为空 = 任意礼物都命中） */
function giftMatches(names, giftName) {
  return !names.length || names.includes(String(giftName || ''));
}

/**
 * 按配置的名次区间抽随机提示词（wordHintCount / wordHintRankFrom~To）。
 * @param {number} minFloor 名次下限的硬地板：送礼传 1（允许含答案），点赞传 10（不允许太贴答案的词）
 */
function pickWordsByRank(ctx, minFloor) {
  const { cfg } = ctx;
  const need = Math.max(0, parseInt(cfg.wordHintCount, 10) || 0);
  if (!need) return [];
  const floor = Math.max(1, minFloor || 1);
  const rf = Math.max(floor, parseInt(cfg.wordHintRankFrom, 10) || 2);
  const rt = Math.max(rf, parseInt(cfg.wordHintRankTo, 10) || 30);
  return engine.wordHints(need, rf, rt);
}

/**
 * 把提示词以「解锁观众」（送礼人/点赞过阈值者）的名义上"实时猜测"榜。
 * gift 仅送礼源标记 → 展示屏 🎁；点赞源 source='like' → 👍；均与真实弹幕一样参与结算。
 * userId 统一用基础用户 id（不加 gift_/like_ 前缀），同一人弹幕/送礼/点赞只算一个人。
 * @returns {{ count:number, win:object|null }} 上墙词数 + 命中答案的解锁条目
 */
function emitWords(ctx, words, who) {
  const { state, emit } = ctx;
  let n = 0;
  let win = null;
  const source = who.source || 'gift';
  for (const w of words) {
    const j = engine.judge(w);
    if (!j.ok) continue;
    const entry = {
      user: who.name, userId: who.id, avatar: who.avatar || '', guess: w, raw: w,
      rank: j.rank, percent: j.percent, percentText: j.percentText,
      isWin: j.rank === 1, gift: source === 'gift', source, ts: Date.now(), roomId: '',
    };
    state.guesses.push(entry);
    if (state.guesses.length > 200) state.guesses = state.guesses.slice(-200);
    tallyGuess(ctx, entry);
    recordBest(ctx, entry);
    emit.guess(entry);
    n++;
    if (entry.isWin && !win) win = entry;
  }
  return { count: n, win };
}

/* ═══════════════ 礼物事件（宿主在 event==='gift' 时调用，可选实现） ═══════════════
 * 随机提示词：送名单内任一礼物（wordHintNames 为空 = 任意礼物）→ 随机出 wordHintCount 个
 * 与答案语义最近的词，以送礼观众的名义上"实时猜测"榜（gift 标记，不参与结算）。
 * 每个命中名单的礼物都触发（修复原先「每轮一次」导致第二个礼物起不再出词的 bug）。 */
function handleGift(ctx, msg) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'gambling') return false;
  const needWords = Math.max(0, parseInt(cfg.wordHintCount, 10) || 0);
  if (!needWords || !giftMatches(normalizeGiftNames(cfg.wordHintNames), msg?.giftName)) return false;

  const words = pickWordsByRank(ctx, 1);   // 送礼：下限可为 1（含答案）
  if (!words.length) return true;
  const uname = msg?.user?.name || '匿名';
  // 与弹幕同一 userId，避免送礼/弹幕被结算成两个人
  const uid = String(msg?.user?.id || msg?.user?.displayId || uname);
  const { win } = emitWords(ctx, words, { name: uname, id: uid, avatar: msg?.user?.avatar || '', source: 'gift' });
  ctx.log('INFO', `[gift] ${uname} 送「${msg?.giftName || '礼物'}」→ 上预测榜 ${words.length} 个词: ${words.join('、')}`);
  if (win) {
    ctx.log('INFO', `[gift] 🎉 ${uname} 的礼物直接解锁答案「${win.guess}」！`);
    reveal(ctx, 'win', win);   // 直接结算：解锁者按猜中处理（n+m）
    return true;
  }
  emit.state();
  return true;
}

/* ═══════════════ 点赞事件（宿主在 event==='like' 时调用，可选实现） ═══════════════
 * 仿弹幕数独：每个观众各自累计点赞，满 N 即扣 N 重新计数（likeMap[uid].likes -= N 循环），
 * 每达成一次 → 以该观众名义随机解锁 1 个提示词上"实时猜测"榜。
 * 展示屏点赞面板只显示「当前累计最多的观众」的名字与进度（same as sudoku）。 */
function handleLike(ctx, msg) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'gambling') return false;
  const per = Math.max(0, parseInt(cfg.wordHintPerLikes, 10) || 0);
  if (!per) return false;
  const add = Math.max(1, Math.floor(Number(msg?.likeCount) || 1));
  const uid = String(msg?.user?.id || msg?.user?.displayId || msg?.user?.name || '匿名');
  const lp = state.likeProgress;
  const rec = lp.map.get(uid) || { uid, name: msg?.user?.name || '匿名', avatar: msg?.user?.avatar || '', likes: 0 };
  rec.name = msg?.user?.name || rec.name;
  if (msg?.user?.avatar) rec.avatar = msg.user.avatar;
  rec.likes += add;
  lp.map.set(uid, rec);

  let acted = false;
  let guard = 10;                                        // 单次事件最多解锁 10 词，防极端连点
  let win = null;
  // 点赞：名次下限固定 ≥10（防太贴答案），上限用 wordHintRankTo；每次达标只解锁 1 个词
  const rfLike = Math.max(10, parseInt(cfg.wordHintRankFrom, 10) || 10);
  const rtLike = Math.max(rfLike, parseInt(cfg.wordHintRankTo, 10) || 30);
  while (!win && rec.likes >= per && guard-- > 0) {
    rec.likes -= per;                                    // 达标即扣 N，重新开始计数
    const words = engine.wordHints(1, rfLike, rtLike);   // 点赞达标只解锁 1 个词（不受 wordHintCount 影响）
    if (!words.length) break;
    const r = emitWords(ctx, words, { name: rec.name, id: uid, avatar: rec.avatar, source: 'like' });
    lp.unlocked++;
    acted = true;
    win = r.win;
    ctx.log('INFO', `[like] ${rec.name} 点赞达标（${per}）→ 解锁提示词: ${words.join('、')}（剩余 ${rec.likes}）`);
  }

  // 点赞解锁词命中答案（配置下限<10 时理论上可能）→ 直接结算
  if (win) {
    ctx.log('INFO', `[like] 🎉 ${rec.name} 的点赞直接解锁答案「${win.guess}」！`);
    reveal(ctx, 'win', win);
    return true;
  }
  // 点赞王 = 当前未扣部分累计最多者（面板展示对象）
  lp.main = [...lp.map.values()].sort((a, b) => b.likes - a.likes)[0] || null;
  emit.state();
  return acted;
}

/* ═══════════════ 关注事件（宿主在 event==='follow' 时调用，可选实现） ═══════════════
 * 关注解锁首字：followUnlockFirst 开启时，竞猜期内关注即公布答案首字。
 * 整场游戏只生效一次（followUsed 不随轮次清零），防止反复关注/取关刷提示。 */
function handleFollow(ctx, msg) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'gambling') return false;
  if (!cfg.followUnlockFirst || state.followUsed || state.hintShown) return false;
  state.followUsed = true;
  state.hintShown = true;
  state.hintUnlockedBy = { name: msg?.user?.name || '匿名', avatar: msg?.user?.avatar || '' };
  ctx.log('INFO', `[follow] ${state.hintUnlockedBy.name} 关注主播 → 解锁首字提示（本场仅一次）`);
  emit.state();
  return true;
}

/* ═══════════════ 主播台指令 ═══════════════ */

async function handleAction(ctx, action, payload = {}) {
  const { state, cfg, emit } = ctx;
  switch (action) {
    case 'start': {
      if (state.status === 'gambling') return { ok: false, msg: '本轮正在进行中' };
      if (!engine.ready()) await engine.load();
      const started = startRound(ctx, String(payload.word || '').trim());
      return started
        ? { ok: true, msg: `第 ${state.roundNo} 轮已开始（${cfg.roundIntervalSec}s 竞猜）` }
        : { ok: false, msg: '开轮失败，详见提示' };
    }
    case 'reveal':
      if (state.status === 'gambling') { reveal(ctx, 'timeout'); return { ok: true, msg: '已提前揭晓' }; }
      return { ok: false, msg: '当前不在竞猜期' };
    case 'pause':
      if (state.status === 'gambling') {
        ctx.clearTimers();
        state.pausedRemain = Math.max(0, state.deadline - Date.now());
        state.status = 'paused';
        emit.state();
        return { ok: true, msg: `已暂停（剩余 ${Math.ceil(state.pausedRemain / 1000)}s 冻结）` };
      }
      return { ok: false, msg: '无法暂停' };
    case 'resume':
      if (state.status === 'paused') {
        state.status = 'gambling';
        state.deadline = Date.now() + Math.max(1000, state.pausedRemain || cfg.roundIntervalSec * 1000);
        state.pausedRemain = 0;
        scheduleRevealTimer(ctx);
        schedulePosHint(ctx);
        emit.state();
        return { ok: true, msg: '已继续' };
      }
      return { ok: false, msg: '当前未暂停' };
    case 'setRoomFilter': {
      cfg.allowedRoomId = String(payload.roomId || '').trim();
      ctx.persistConfig(cfg);
      emit.state();
      return { ok: true, msg: '直播间筛选已更新' };
    }
    case 'config': {
      const allowed = ['roundIntervalSec', 'resultShowSec', 'autoNextRound', 'rateLimitSec', 'maxGuessesPerUserPerRound', 'baseScorePerWin', 'assocScoreMax', 'answerLen', 'posHintSec', 'followUnlockFirst', 'wordHintNames', 'wordHintCount', 'wordHintPerLikes', 'wordHintRankFrom', 'wordHintRankTo', 'allowedRoomId', ...BC_CFG_KEYS];
      for (const k of allowed) {
        if (payload[k] !== undefined) cfg[k] = payload[k];
      }
      cfg.answerLen = [0, 2, 3, 4].includes(parseInt(cfg.answerLen, 10)) ? parseInt(cfg.answerLen, 10) : 0;
      cfg.posHintSec = Math.max(-1, parseInt(cfg.posHintSec, 10) || 0);
      cfg.wordHintCount = Math.max(0, parseInt(cfg.wordHintCount, 10) || 0);
      cfg.wordHintRankFrom = Math.max(1, parseInt(cfg.wordHintRankFrom, 10) || 2);
      cfg.wordHintRankTo = Math.max(cfg.wordHintRankFrom, parseInt(cfg.wordHintRankTo, 10) || 30);
      cfg.followUnlockFirst = cfg.followUnlockFirst !== false;
      cfg.wordHintNames = normalizeGiftNames(cfg.wordHintNames);
      if (BC(ctx).collectConfig(cfg, payload)) { /* 播报配置已并入 cfg */ }
      ctx.persistConfig(cfg);
      ctx.log('INFO', '[config] 已更新:', { roundIntervalSec: cfg.roundIntervalSec, answerLen: cfg.answerLen, posHintSec: cfg.posHintSec, followUnlockFirst: cfg.followUnlockFirst, wordHintNames: cfg.wordHintNames, wordHintCount: cfg.wordHintCount });
      emit.state();
      return { ok: true, msg: '配置已更新' };
    }
    case 'simulateGuess': {
      const text = String(payload.text || '').trim();
      if (!text) return { ok: false, msg: '请输入要模拟的猜测内容' };
      if (state.status !== 'gambling') return { ok: false, msg: '本轮未在竞猜期，无法模拟猜测' };
      const name = String(payload.name || '模拟观众').trim() || '模拟观众';
      const msg = { event: 'chat', user: { id: 'sim_' + name, displayId: 'sim_' + name, name, avatar: '' }, text, roomId: '' };
      const consumed = handleDanmu(ctx, msg);
      return consumed
        ? { ok: true, msg: `已模拟「${name}」猜测「${text}」` }
        : { ok: false, msg: `「${text}」不是有效猜测（不超过 4 个字，如：老师 / 猜老师）` };
    }
    case 'reloadModel': {
      const info0 = engine.info();
      await engine.reload();
      const m = engine.info();
      return { ok: true, msg: `模型已重载：词表 ${(m.words / 10000).toFixed(2)} 万（原 ${(info0.words / 10000).toFixed(2)} 万），答案池 ${m.pool}` };
    }
    case 'broadcast':
      return BC(ctx).control(payload);
    default:
      return { ok: false, msg: `未知动作: ${action}` };
  }
}

/* ═══════════════ 对外状态（白名单，绝不泄漏答案） ═══════════════ */

function publicState(ctx) {
  const { state, cfg } = ctx;
  const revealed = state.status === 'revealed';
  const s = {
    status: state.status,
    roundNo: state.roundNo,
    deadline: state.deadline,
    pausedRemain: state.pausedRemain || 0,
    revealedAt: state.revealedAt || 0,
    hintShown: !!state.hintShown,
    followUsed: !!state.followUsed,
    posHintShown: !!state.posHintShown,
    // 词性（启发式判定）：仅在词性提示放出后下发
    answerPos: state.posHintShown && state.answerPos ? state.answerPos : null,
    // 首字解锁：解锁者信息（展示屏在首字格右上角显示其头像）；礼物名单（解锁前展示引导）
    hintUnlockedBy: state.hintShown && state.hintUnlockedBy ? state.hintUnlockedBy : null,
    // 点赞解锁进度（仿数独）：面板只显示「当前累计最多的观众」的名字/头像/进度
    likeProgress: {
      per: Math.max(0, parseInt(cfg.wordHintPerLikes, 10) || 0),
      unlocked: state.likeProgress.unlocked || 0,
      main: state.likeProgress.main
        ? { name: state.likeProgress.main.name, avatar: state.likeProgress.main.avatar || '', likes: state.likeProgress.main.likes }
        : null,
    },
    // 玩家真实弹幕（最近 5 条，不排序、最新在前；不含礼物/点赞解锁词；raw 原样展示）
    recent: [...state.guesses].filter(g => (g.source || (g.gift ? 'gift' : 'chat')) === 'chat').slice(-5).reverse().map(g => ({
      user: g.user, guess: g.guess, raw: g.raw || g.guess, percentText: g.percentText, isWin: g.isWin, oov: !!g.oov, ts: g.ts,
    })),
    // 答案卡：长度永远公开；首字提示按 hintShown。
    // 答案词随状态下发（与猜数字同约定）：展示屏不渲染、控制台标注「请勿投屏」，
    // 主播台因此能实时看到答案；观众用开发者工具看 SSE 可见，介意可在 strict 防作弊场景关闭本游戏。
    answerLen: state.answer ? state.answer.length : 0,
    answerHint: state.hintShown && state.answer ? state.answer[0] : null,
    answer: state.answer || null,
    winner: state.winner ? {
      name: state.winner.name, avatar: state.winner.avatar || '',
      guess: state.winner.guess, percent: state.winner.percent, percentText: state.winner.percentText,
      score: state.winner.score, ts: state.winner.ts,
    } : null,
    topWords: [...state.topWords.values()].sort((a, b) => a.rank - b.rank).slice(0, 10),
    guessBoard: guessBoardList(ctx).map(g => ({
      user: g.user, avatar: g.avatar, guess: g.guess, raw: g.raw || g.guess, count: g.count,
      percent: g.percent, percentText: g.percentText, isWin: g.isWin,
      gift: !!g.gift, oov: !!g.oov,
      source: g.source || (g.gift ? 'gift' : (g.oov ? 'chat' : 'chat')),
      ts: g.ts,
    })),
    // 本轮已猜统计（来自独立 tally 累加器，不受展示数组 200 上限裁剪影响）
    guessStats: {
      total: state.guessTally.total,
      distinct: state.guessTally.words.size,
      chat: state.guessTally.chat, like: state.guessTally.like, gift: state.guessTally.gift,
    },
    settle: state.settle || [],
    // 倒计时进度条提示节点：只标「词性」这一个节点（其余提示由礼物/关注即时触发，无固定时间点）
    marks: {
      posSec: (cfg.posHintSec != null && cfg.posHintSec >= 0 && cfg.posHintSec < Math.max(1, cfg.roundIntervalSec || 150))
        ? cfg.posHintSec : null,
    },
    lastAnswers: state.lastAnswers.slice(0, 50),
    stats: state.stats,
    model: engine.info(),
    cfg: {
      roundIntervalSec: cfg.roundIntervalSec, resultShowSec: cfg.resultShowSec,
      autoNextRound: cfg.autoNextRound,
      rateLimitSec: cfg.rateLimitSec, maxGuessesPerUserPerRound: cfg.maxGuessesPerUserPerRound,
      baseScorePerWin: cfg.baseScorePerWin, assocScoreMax: cfg.assocScoreMax,
      answerLen: cfg.answerLen,
      posHintSec: cfg.posHintSec, followUnlockFirst: cfg.followUnlockFirst !== false,
      wordHintNames: normalizeGiftNames(cfg.wordHintNames), wordHintCount: cfg.wordHintCount,
      wordHintPerLikes: cfg.wordHintPerLikes,
      wordHintRankFrom: cfg.wordHintRankFrom, wordHintRankTo: cfg.wordHintRankTo,
      allowedRoomId: cfg.allowedRoomId || '',
    },
    leaderboard: ctx.topList(),   // 全局共享榜（本玩法字段）
  };
  // AI 播报（bc/bcSlots/bcCfg 片段在顶层，密钥明文绝不下发）
  Object.assign(s, BC(ctx).publicState());
  return s;
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
  handleGift,        // 礼物事件（随机提示词触发）
  handleLike,        // 点赞事件（每 N 赞解锁 1 个提示词）
  handleFollow,      // 关注事件（关注解锁首字提示）
  handleAction,
  publicState,
  clearGameTimers,
};
