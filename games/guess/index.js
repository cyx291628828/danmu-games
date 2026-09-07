/**
 * ============================================================================
 * games/guess/index.js — 猜数字游戏模块
 * ============================================================================
 * 通过统一的「游戏接口」注册进主播台的游戏中心：
 *   - id/name/icon            ：注册信息（manifest）
 *   - configSchema            ：驱动主播台自动生成配置表单
 *   - createState()           ：初始化本游戏状态
 *   - publicState(state,cfg)  ：生成随 SSE 下发的精简状态
 *   - handleAction(...)       ：处理主播台控制指令（start/pause/reveal/...）
 *   - handleDanmu(msg,ctx)    ：处理弹幕（返回 true 表示已消费）
 *   - broadcast 由宿主通过 ctx 提供（emitState/emitGuess/emitNotice）
 *
 * 【玩法】每轮隐藏 N 位不重复数字答案（N = digitCount，默认 4），
 *   公布 N 条线索（谜面数字 + 提示），观众弹幕竞猜，猜中立即结束本轮。
 * ============================================================================
 */
'use strict';

const path = require('path');
const fs = require('fs');
const engine = require('./engine');
const { createBroadcaster, BC_CFG_DEFAULTS, BC_CFG_KEYS } = require('../../common/broadcast'); // 通用 AI 播报中心
const GUESS_SLOTS = require('./slots'); // 播报点定义（出题/猜中/超时）

/* ═══════════════ 注册信息 ═══════════════ */

const MANIFEST = {
  id: 'guess',
  name: '猜数字',
  icon: '🔢',
  desc: '4 位不重复数字推理题 · 3/4 位可选',
  // 运行中状态（宿主据此点亮主播台导航绿点）
  liveStatuses: ['gambling'],
  // 全局排行榜计分字段（宿主动态注册，新增游戏零改宿主）
  score: { wins: 'guess_wins', score: 'guess_score', floors: null },
};

/* ═══════════════ 配置定义（驱动主播台表单） ═══════════════ */

const CFG_DEFAULTS = {
  roundIntervalSec: 120,      // 每轮竞猜时长（秒）
  resultShowSec: 10,          // 揭晓后停留（秒）
  autoNextRound: true,
  guessPattern: 'loose',
  rateLimitSec: 2,
  maxGuessesPerUserPerRound: 20,
  baseScorePerWin: 100,
  digitCount: 4,
  answerRevealSec: [0, 25, 50, 75],   // 答案各位「数字」出现时间（秒），-1=永不出现
  clueCond: [                          // 各条「线索提示」的出现条件（与答案位是两条独立轴）
    { mode: 'time', value: 0 },
    { mode: 'time', value: 20 },
    { mode: 'time', value: 40 },
    { mode: 'time', value: 60 },
  ],
  answerLeadingZero: false,
  allowedRoomId: '',
  // 兼容旧字段（保留仅兼容）
  clueDelaySec: 0,
  clueIntervalSec: 25,
  clueMaxCount: 4,
  clueRevealSec: null,                 // 旧字段（秒数组），首次读到会自动迁移进 clueCond
  // ── AI 播报（通用播报中心 common/broadcast，off/local/api + 密钥只存服务端） ──
  ...BC_CFG_DEFAULTS,
};

/* ═══════════════ 通用 AI 播报中心（common/broadcast） ═══════════════ */
function BC(ctx) {
  if (!ctx._bc) {
    ctx._bc = createBroadcaster({
      gameId: 'guess', gameName: '猜数字', slots: GUESS_SLOTS,
      getCfg: () => ctx.cfg,
      getState: () => ctx.state,
      emit: () => ctx.emit.state(),
      log: ctx.log,
    });
  }
  return ctx._bc;
}

/* ═══════════════ 线索出现条件类型 ═══════════════
   【扩展点】新增一种线索触发方式，只改这一处即可：
   服务端会自动校验并下发给主播台，主播台下拉框自动长出选项（无需改 UI 代码）。
   游戏端需在 checkClueCond() 里补上该 mode 的判定逻辑。 */
const CLUE_COND_MODES = [
  { id: 'time', label: '按时间', unit: '秒', min: 0, def: 0 },
  { id: 'likes', label: '按点赞数', unit: '次点赞', min: 1, def: 50 },
  { id: 'never', label: '永不出现', unit: '', min: null, def: 0 },
];
const CLUE_COND_IDS = new Set(CLUE_COND_MODES.map(m => m.id));
/** 取某 mode 的定义（未知则回退 time） */
function condModeDef(id) {
  return CLUE_COND_MODES.find(m => m.id === id) || CLUE_COND_MODES[0];
}

/** 配置表单 schema：host 据此自动生成输入控件 */
const CONFIG_SCHEMA = [
  { key: 'roundIntervalSec', label: '每轮时长(秒)', type: 'number', min: 10, def: 120 },
  { key: 'resultShowSec', label: '揭晓停留(秒)', type: 'number', min: 3, def: 10 },
  { key: 'baseScorePerWin', label: '猜中基础分', type: 'number', min: 1, def: 100 },
  { key: 'autoNextRound', label: '自动开下一轮', type: 'bool', def: true },
  { key: 'guessPattern', label: '匹配模式', type: 'select', options: [['loose', '宽松（1234/猜1234）'], ['strict', '严格（仅猜1234）']], def: 'loose' },
  { key: 'digitCount', label: '答案位数', type: 'select', options: [['4', '4 位（标准）'], ['3', '3 位（简单）']], def: 4 },
  { key: 'maxGuessesPerUserPerRound', label: '每人每轮上限', type: 'number', min: 1, def: 20 },
  { key: 'rateLimitSec', label: '发送间隔(秒)', type: 'number', min: 1, def: 2 },
  { key: 'answerRevealSec', label: '各位数字出现时间(秒)', type: 'timing', def: [0, 25, 50, 75] },
  { key: 'clueCond', label: '各条线索出现条件', type: 'clueCond', def: null },
  { key: 'answerLeadingZero', label: '允许首位为 0', type: 'bool', def: false },
];

/* ═══════════════ 状态 ═══════════════ */

function createState() {
  return {
    status: 'idle',            // idle | gambling | revealed | paused
    roundNo: 0,
    puzzle: null,
    cluesVisible: 0,
    revealedMask: 0,
    roundLikes: 0,             // 本轮累计点赞数（每轮重置，供线索「按点赞数」解锁）
    clueShown: [],             // 各条线索是否已出现（服务端权威判定，[bool]）
    deadline: 0,
    pausedRemain: 0,           // 暂停时冻结的剩余毫秒（恢复时按此续时，而非重置满时长）
    revealedAt: 0,
    winner: null,
    guesses: [],               // 本轮猜测列表
    lastAnswers: [],
    stats: { rounds: 0, wins: 0 },
    startedAt: Date.now(),
    roundGuessCount: new Map(), // 每轮每人猜测计数
    lastGuessAt: new Map(),     // 限流时间戳
  };
}

/* ═══════════════ 内部工具 ═══════════════ */

function popcount(n) { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; }

/** 归一化每位出现时间数组：兼容旧字段或新 answerRevealSec */
function normalizeRevealSec(cfg, len) {
  const arr = cfg.answerRevealSec;
  if (Array.isArray(arr)) {
    const out = [];
    for (let i = 0; i < len; i++) out.push(arr[i] === undefined ? -1 : arr[i]);
    return out;
  }
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push(i === 0 ? (cfg.clueDelaySec || 0) : (cfg.clueDelaySec + i * (cfg.clueIntervalSec || 25)));
  }
  return out;
}

/**
 * 归一化每条「线索提示」的出现时间：与答案位揭示（normalizeRevealSec）是两条独立时间轴。
 * 旧配置没有该字段时，全部按 0 处理（开局立即出现，保持原有行为）。
 */
/**
 * 归一化每条「线索提示」的出现条件 → [{mode, value}]。
 * 与答案位揭示（normalizeRevealSec）是两条独立轴。
 * 【旧配置迁移】三种输入都能吃：
 *   1. 新格式 [{mode,value}]        → 校验后原样返回
 *   2. 旧格式 秒数组 [0,20,40,60]   → 转成 [{mode:'time',value:n}]，-1 → {mode:'never'}
 *   3. 完全没有该字段               → 全部 {mode:'time', value:0}（开局立即可见，保持旧行为）
 */
function normalizeClueCond(cfg, len) {
  const raw = cfg.clueCond;
  const fallback = () => new Array(len).fill(0).map(() => ({ mode: 'time', value: 0 }));
  const one = (v) => {
    if (v && typeof v === 'object') {
      const mode = CLUE_COND_IDS.has(v.mode) ? v.mode : 'time';
      const def = condModeDef(mode);
      let val = Number(v.value);
      if (!Number.isFinite(val)) val = def.def;
      if (typeof def.min === 'number') val = Math.max(def.min, val);
      return { mode, value: val };
    }
    // 旧格式：裸数字（秒）
    const n = Number(v);
    if (!Number.isFinite(n)) return { mode: 'time', value: 0 };
    if (n < 0) return { mode: 'never', value: 0 };
    return { mode: 'time', value: n };
  };
  // 新格式优先；否则回落到旧字段 clueRevealSec
  const src = Array.isArray(raw) ? raw : (Array.isArray(cfg.clueRevealSec) ? cfg.clueRevealSec : null);
  if (!src) return fallback();
  const out = [];
  for (let i = 0; i < len; i++) out.push(one(src[i]));
  return out;
}

/** 从弹幕文本提取 N 位数字 */
function parseGuess(text, cfg) {
  const t = String(text || '').trim();
  if (!t) return null;
  const re = new RegExp(`\\d{${cfg.digitCount}}`);
  const withPrefix = t.match(new RegExp(`(?:猜|答案|答|#)\\s*(${re.source})`));
  if (withPrefix) return withPrefix[1];
  if (cfg.guessPattern === 'strict') return null;
  const bare = t.match(new RegExp(`(?:^|\\s)(${re.source})(?:\\s|$)`));
  return bare ? bare[1] : null;
}

/** 限流 */
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

/** 猜中计分：base × (1 + 剩余占比) */
function computeScore(state, cfg) {
  const total = Math.max(1, cfg.roundIntervalSec);
  const remain = Math.max(0, (state.deadline - Date.now()) / 1000);
  const ratio = Math.min(1, remain / total);
  return Math.round(cfg.baseScorePerWin * (1 + ratio));
}

/* ═══════════════ 游戏接口实现 ═══════════════ */

function startRound(ctx) {
  const { state, cfg, emit } = ctx;
  clearGameTimers(ctx);
  ctx.engine.setDigitCount(cfg.digitCount);
  state.puzzle = ctx.engine.generatePuzzle({ leadingZero: cfg.answerLeadingZero });
  state.roundNo++;
  state.winner = null;
  state.guesses = [];
  state.cluesVisible = 0;
  state.revealedMask = 0;
  state.roundLikes = 0;                                     // 点赞按轮次重置
  state.clueShown = state.puzzle.clues.map(() => false);     // 线索出现状态重置
  state.roundGuessCount.clear();
  state.status = 'gambling';
  state.deadline = Date.now() + cfg.roundIntervalSec * 1000;
  state.stats.rounds++;
  ctx.log('INFO', `[round #${state.roundNo}] 开题，答案=${state.puzzle.answerFmt}（对外保密），${cfg.roundIntervalSec}s 内竞猜`);
  ctx.log('INFO', `  线索：${state.puzzle.clues.map(c => `${c.numFmt}→${c.hint}`).join(' | ')}`);
  emit.state();
  BC(ctx).speak('roundOpen', {
    round: state.roundNo, digitCount: cfg.digitCount, sec: cfg.roundIntervalSec,
  });
  scheduleRevealTimer(ctx);
  scheduleClueReveal(ctx);
  scheduleClueCond(ctx);
}

/* ═══════════════ 线索出现条件（服务端权威判定） ═══════════════ */

/**
 * 判定第 i 条线索当前是否应满足出现条件。
 * 【扩展点】新增条件类型时在此补一个 case（配合上方 CLUE_COND_MODES）。
 * @param {'time'|'likes'|'never'} mode
 * @param {number} value 阈值
 */
function clueCondMet(ctx, mode, value) {
  const { state } = ctx;
  switch (mode) {
    case 'never':
      return false;                                  // 永不出现，除非整轮揭晓
    case 'likes':
      return state.roundLikes >= value;              // 本轮累计点赞达标
    case 'time':
    default: {
      // 开题后经过的秒数 >= 阈值
      if (!state.deadline) return false;
      const total = Math.max(1, ctx.cfg.roundIntervalSec);
      const elapsed = (total * 1000 - (state.deadline - Date.now())) / 1000;
      return elapsed >= value;
    }
  }
}

/** 检查全部未出现的线索，满足条件的置为已出现并广播 */
function checkClueCond(ctx, reason) {
  const { state, cfg } = ctx;
  if (state.status !== 'gambling' || !state.puzzle) return;
  const conds = normalizeClueCond(cfg, state.puzzle.clues.length);
  let changed = false;
  for (let i = 0; i < conds.length; i++) {
    if (state.clueShown[i]) continue;
    if (!clueCondMet(ctx, conds[i].mode, conds[i].value)) continue;
    state.clueShown[i] = true;
    changed = true;
    const label = conds[i].mode === 'likes'
      ? `本轮点赞达 ${conds[i].value} 次`
      : `开题后第 ${conds[i].value} 秒`;
    ctx.log('INFO', `[clue] 第 ${i + 1} 条线索已出现（${label}，触发来源：${reason}）`);
  }
  if (changed) {
    state.cluesVisible = state.clueShown.filter(Boolean).length;
    ctx.emit.state();
  }
}

/** 为「按时间」的线索挂定时器到点自动出现 */
function scheduleClueCond(ctx) {
  const { state, cfg } = ctx;
  ctx.clearTimers('clueCond');
  if (state.status !== 'gambling' || !state.puzzle) return;
  const conds = normalizeClueCond(cfg, state.puzzle.clues.length);
  conds.forEach((c, i) => {
    if (c.mode !== 'time') return;                 // 点赞类由 handleLike 驱动，无需定时
    const delayMs = Math.max(0, c.value) * 1000;
    ctx.setTimer('clueCond', () => checkClueCond(ctx, 'timer'), delayMs);
  });
  checkClueCond(ctx, 'roundStart');                // 开局立即判定（value=0 的线索）
}

/**
 * 点赞事件接口（宿主在收到 event==='like' 时调用，可选实现）。
 * 累计本轮点赞数并重新判定线索条件。
 */
function handleLike(ctx, msg) {
  const { state } = ctx;
  if (state.status !== 'gambling') return false;
  // 支持 likeCount（本次点赞数，上游 DanmuDesk 协议字段），缺省按 1 计
  const n = Number(msg && msg.likeCount);
  const add = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  state.roundLikes += add;
  checkClueCond(ctx, 'like');
  ctx.emit.state();   // 点赞实时累加，立即下发 roundLikes，让前端进度（XX/XX）跟随更新
  return true;
}

function scheduleRevealTimer(ctx) {
  const { state } = ctx;
  clearGameTimers(ctx, 'timeout');
  const remain = Math.max(0, state.deadline - Date.now());
  ctx.setTimer('timeout', () => reveal(ctx, 'timeout'), remain);
}

function scheduleClueReveal(ctx) {
  const { state, cfg } = ctx;
  ctx.clearTimers('clue');
  if (state.status !== 'gambling') return;
  const answer = state.puzzle ? String(state.puzzle.answer) : '';
  const len = answer.length || 4;
  const arr = normalizeRevealSec(cfg, len);
  for (let i = 0; i < len; i++) {
    const sec = arr[i];
    if (sec == null || sec < 0) continue;
    const doReveal = () => {
      if (state.status !== 'gambling') return;
      const bit = 1 << i;
      if (state.revealedMask & bit) return;
      state.revealedMask |= bit;
      state.cluesVisible = popcount(state.revealedMask);
      ctx.log('INFO', `[reveal] 第 ${state.roundNo} 轮，揭晓第 ${i + 1} 位答案数字「${answer[i]}」（当前 ${state.cluesVisible}/${len} 位）`);
      ctx.emit.state();
    };
    if (sec === 0) doReveal();
    else ctx.setTimer('clue', doReveal, sec * 1000);
  }
}

function reveal(ctx, reason, winnerGuess) {
  const { state, cfg } = ctx;
  if (state.status !== 'gambling') return;
  ctx.clearTimers();
  state.status = 'revealed';
  const rlen = state.puzzle ? String(state.puzzle.answer).length : 4;
  state.revealedMask = (1 << rlen) - 1;
  state.cluesVisible = rlen;
  // 揭晓时全部线索无条件展示（包括 mode='never' 的）
  if (state.puzzle) state.clueShown = state.puzzle.clues.map(() => true);
  state.revealedAt = Date.now();
  if (reason === 'win' && winnerGuess) {
    const score = winnerGuess.score || computeScore(state, cfg);
    state.winner = {
      name: winnerGuess.user || '匿名',
      avatar: winnerGuess.avatar || '',
      guess: winnerGuess.guess,
      guessFmt: winnerGuess.guessFmt,
      score,
      ts: winnerGuess.ts,
    };
    state.stats.wins++;
    awardWinner(ctx, winnerGuess, score);
    ctx.log('INFO', `[round #${state.roundNo}] 🎉 ${state.winner.name} 猜中 ${state.puzzle.answerFmt}（+${score} 分）！本轮结束`);
    BC(ctx).speak('win', {
      round: state.roundNo, user: state.winner.name, answer: state.puzzle.answerFmt, score,
    });
  } else {
    ctx.log('INFO', `[round #${state.roundNo}] ⏰ 揭晓（超时未猜中），答案=${state.puzzle.answerFmt}`);
    BC(ctx).speak('timeout', {
      round: state.roundNo, answer: state.puzzle.answerFmt,
    });
  }
  state.lastAnswers.unshift({
    roundNo: state.roundNo,
    answer: state.puzzle.answerFmt,
    winner: state.winner ? state.winner.name : null,
    winnerScore: state.winner ? state.winner.score : null,
    ts: Date.now(),
  });
  if (state.lastAnswers.length > 50) state.lastAnswers.pop();
  ctx.emit.state();
  if (cfg.autoNextRound) {
    ctx.setTimer('next', () => startRound(ctx), Math.max(0, cfg.resultShowSec) * 1000);
  }
}

function awardWinner(ctx, entry, score) {
  // 全局共享排行榜：猜中计入全局榜（1 胜 + 积分）
  ctx.award(entry, score);
}

/** 处理一条合法猜测 */
function handleGuess(ctx, msg, guessStr) {
  const { state, cfg, emit } = ctx;
  const fb = ctx.engine.judgeGuess(guessStr, state.puzzle.answer);
  if (!fb) return;
  const entry = {
    user: msg.user?.name || '匿名',
    userId: msg.user?.id || msg.user?.displayId || msg.user?.name || '匿名',
    avatar: msg.user?.avatar || '',
    guess: fb.guess,
    guessFmt: fb.guessFmt,
    exact: fb.exact, near: fb.near,
    digitOk: fb.digitOk, posOk: fb.posOk,
    hint: fb.hint,
    isWin: fb.isWin,
    ts: Date.now(),
    roomId: msg.roomId || '',
  };
  if (state.status === 'gambling') {
    state.guesses.push(entry);
    if (state.guesses.length > 200) state.guesses.shift();
  }
  if (fb.isWin && state.status === 'gambling') {
    entry.score = computeScore(state, cfg);
    reveal(ctx, 'win', entry);
  }
  emit.guess(entry);
}

/* ═══════════════ 对外接口（host 调用） ═══════════════ */

function handleDanmu(ctx, msg) {
  const { state, cfg, emit } = ctx;
  if (!msg || msg.event !== 'chat' || !msg.text) return false;
  // 房间ID过滤：alloweRoomId 支持逗号分隔多个，留空=接受所有房间；msg.roomId 为空时不拦
  if (cfg.allowedRoomId && msg.roomId) {
    const allowedSet = String(cfg.allowedRoomId).split(/[,，\s]+/).filter(Boolean);
    if (allowedSet.length && !allowedSet.includes(String(msg.roomId))) return false;
  }

  const guessStr = parseGuess(msg.text, cfg);
  if (!guessStr) return false;

  if (state.status !== 'gambling') {
    ctx.log('INFO', `[danmu] ${msg.user?.name || '匿名'} 在非竞猜期发来「${msg.text}」（忽略）`);
    emit.notice(`本轮未开始/已结束，${msg.user?.name || '匿名'} 的猜测未计入`);
    return true;
  }

  const key = msg.user?.id || msg.user?.displayId || msg.user?.name || '匿名';
  const rc = rateCheck(state, cfg, key);
  if (!rc.ok) {
    if (rc.reason === 'rate') emit.notice(`「${msg.user?.name || '匿名'}」猜得太快，${cfg.rateLimitSec}s 后再试`);
    else emit.notice(`「${msg.user?.name || '匿名'}」本轮已达到 ${cfg.maxGuessesPerUserPerRound} 次上限`);
    return true;
  }

  const fb = ctx.engine.judgeGuess(guessStr, state.puzzle.answer);
  if (!fb) {
    emit.notice(`「${msg.user?.name || '匿名'}」的 ${guessStr} 不是有效猜测（需 ${cfg.digitCount} 位不重复数字）`);
    return true;
  }
  ctx.log('INFO', `[guess] ${msg.user?.name || '匿名'}: ${guessStr} → ${fb.hint}${fb.isWin ? ' 🎉猜中！' : ''}`);
  handleGuess(ctx, msg, guessStr);
  return true;
}

function handleAction(ctx, action, payload = {}) {
  const { state, cfg, emit } = ctx;
  switch (action) {
    case 'start':
      if (state.status === 'idle' || state.status === 'revealed') {
        startRound(ctx);
        return { ok: true, msg: `第 ${state.roundNo} 轮已开始（${cfg.roundIntervalSec}s 竞猜）` };
      }
      return { ok: false, msg: '本轮正在进行中' };
    case 'reveal':
      if (state.status === 'gambling') { reveal(ctx, 'timeout'); return { ok: true, msg: '已提前揭晓' }; }
      return { ok: false, msg: '当前不在竞猜期' };
    case 'pause':
      if (state.status === 'gambling') {
        ctx.clearTimers();
        state.pausedRemain = Math.max(0, state.deadline - Date.now());   // 冻结剩余时间
        state.status = 'paused';
        emit.state();
        return { ok: true, msg: `已暂停（剩余 ${Math.ceil(state.pausedRemain / 1000)}s 冻结）` };
      }
      return { ok: false, msg: '无法暂停' };
    case 'resume':
      if (state.status === 'paused') {
        state.status = 'gambling';
        // 按暂停时冻结的剩余时间续时；没有记录则退回满时长
        state.deadline = Date.now() + Math.max(1000, state.pausedRemain || cfg.roundIntervalSec * 1000);
        state.pausedRemain = 0;
        scheduleRevealTimer(ctx);
        scheduleClueReveal(ctx);
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
      const allowed = ['roundIntervalSec', 'resultShowSec', 'autoNextRound', 'guessPattern', 'rateLimitSec', 'maxGuessesPerUserPerRound', 'baseScorePerWin', 'clueDelaySec', 'clueIntervalSec', 'clueMaxCount', 'digitCount', 'answerRevealSec', 'clueCond', 'answerLeadingZero', 'allowedRoomId', ...BC_CFG_KEYS];
      for (const k of allowed) {
        if (payload[k] !== undefined) cfg[k] = payload[k];
      }
      cfg.digitCount = (cfg.digitCount === 3) ? 3 : 4;
      ctx.engine.setDigitCount(cfg.digitCount);
      if (Array.isArray(cfg.answerRevealSec)) {
        cfg.answerRevealSec = normalizeRevealSec(cfg, cfg.digitCount).slice(0, cfg.digitCount);
      }
      // 线索出现条件：归一化后按位数截断（旧字段 clueRevealSec 会被迁移进来）
      if (Array.isArray(cfg.clueCond) || Array.isArray(cfg.clueRevealSec)) {
        cfg.clueCond = normalizeClueCond(cfg, cfg.digitCount).slice(0, cfg.digitCount);
        cfg.clueRevealSec = null;   // 迁移完成，清掉旧字段避免二次迁移歧义
      }
      scheduleClueCond(ctx);        // 配置改了立即重排定时/重判条件
      ctx.persistConfig(cfg);
      ctx.log('INFO', '[config] 已更新:', cfg);
      emit.state();
      return { ok: true, msg: '配置已更新' };
    }
    case 'simulateGuess': {
      const text = String(payload.text || '').trim();
      if (!text) return { ok: false, msg: '请输入要模拟的猜测内容' };
      if (state.status !== 'gambling') return { ok: false, msg: '本轮未在竞猜期，无法模拟猜测' };
      const guessStr = parseGuess(text, cfg);
      if (!guessStr) return { ok: false, msg: `未识别到 ${cfg.digitCount} 位数字（格式如 ${'1'.repeat(cfg.digitCount)} 或 猜${'1'.repeat(cfg.digitCount)}）` };
      const fb = ctx.engine.judgeGuess(guessStr, state.puzzle.answer);
      if (!fb) return { ok: false, msg: `${guessStr} 不是有效猜测（需 ${cfg.digitCount} 位不重复数字）` };
      const name = String(payload.name || '模拟观众').trim() || '模拟观众';
      const simId = 'sim_' + name;
      const rc = rateCheck(state, cfg, simId);
      if (!rc.ok) {
        return { ok: false, msg: rc.reason === 'rate' ? `模拟太频繁，${cfg.rateLimitSec}s 后再试` : '模拟观众本轮已达猜测上限' };
      }
      const msg = { user: { id: simId, displayId: simId, name, avatar: '' }, text, roomId: '' };
      handleGuess(ctx, msg, guessStr);
      return { ok: true, msg: `已模拟「${name}」猜测 ${guessStr}` };
    }
    case 'addLikes': {
      const n = parseInt(payload.count, 10);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, msg: '点赞数需为正整数' };
      const applied = handleLike(ctx, { likeCount: n });
      if (!applied) return { ok: false, msg: '当前不在竞猜期，无法加赞' };
      return { ok: true, msg: `已手动增加 ${n} 次点赞（本轮累计 ${state.roundLikes}）` };
    }
    default:
      return { ok: false, msg: `未知动作: ${action}` };
  }
}

function publicState(ctx) {
  const { state, cfg } = ctx;
  const s = { ...state, cfg: { ...cfg } };
  s.puzzle = state.puzzle ? {
    clues: state.puzzle.clues.map(c => ({ numFmt: c.numFmt, hint: c.hint, digitOk: c.digitOk, posOk: c.posOk })),
    totalClues: state.puzzle.clues.length,
  } : null;
  if (state.puzzle) {
    const digs = String(state.puzzle.answer).split('');
    state.cluesVisible = popcount(state.revealedMask);
    s.answerDigits = digs.map((d, i) => (state.revealedMask & (1 << i)) ? d : null);
    s.revealedMask = state.revealedMask;
    s.answerTotalLen = digs.length;
  }
  if (state.puzzle) s.answerFmt = state.puzzle.answerFmt;
  s.leaderboard = ctx.topList();   // 全局共享榜
  // 线索出现条件：下发条件定义、当前已出现状态与本轮点赞数（供展示屏渲染倒计时/进度）
  const clueCount = state.puzzle ? state.puzzle.clues.length : cfg.digitCount;
  s.clueCond = normalizeClueCond(cfg, clueCount);
  s.clueShown = s.clueCond.map((_, i) => !!(state.clueShown && state.clueShown[i]));
  s.roundLikes = state.roundLikes || 0;
  s.pausedRemain = state.pausedRemain || 0;   // 暂停期展示屏用冻结值定格倒计时
  s.clueCondModes = CLUE_COND_MODES;   // 主播台据此渲染下拉框，新增条件无需改 UI
  s.cfg = {
    roundIntervalSec: cfg.roundIntervalSec, resultShowSec: cfg.resultShowSec, autoNextRound: cfg.autoNextRound,
    guessPattern: cfg.guessPattern, rateLimitSec: cfg.rateLimitSec, maxGuessesPerUserPerRound: cfg.maxGuessesPerUserPerRound,
    baseScorePerWin: cfg.baseScorePerWin, clueDelaySec: cfg.clueDelaySec, clueIntervalSec: cfg.clueIntervalSec,
    clueMaxCount: cfg.clueMaxCount,     digitCount: cfg.digitCount, answerRevealSec: normalizeRevealSec(cfg, cfg.digitCount),
    allowedRoomId: cfg.allowedRoomId || '',
  };
  // AI 播报（通用播报中心）：bc/bcSlots/bcCfg 片段在顶层，密钥明文绝不下发
  Object.assign(s, BC(ctx).publicState());
  return s;
}

/** 清理游戏内定时器（host 调用，游戏退出/重启时使用） */
function clearGameTimers(ctx, group) {
  ctx.clearTimers(group);
}

module.exports = {
  MANIFEST,
  CFG_DEFAULTS,
  CONFIG_SCHEMA,
  CLUE_COND_MODES,
  createState,
  handleDanmu,
  handleLike,        // 点赞事件（宿主在 event==='like' 时调用，可选实现）
  handleAction,
  publicState,
  clearGameTimers,
};