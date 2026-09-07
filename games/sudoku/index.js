/**
 * ============================================================================
 * games/sudoku/index.js — 弹幕数独游戏模块
 * ============================================================================
 * 通过统一的「游戏接口」注册进主播台的游戏中心（与猜数字同约定）：
 *   - MANIFEST / CFG_DEFAULTS / CONFIG_SCHEMA
 *   - createState() / publicState(ctx) / handleAction(ctx,action,payload)
 *   - handleDanmu(ctx,msg)      弹幕抢填：行×列×数（如 357 = 3行5列填7）
 *   - handleLike(ctx,msg)       单人点赞累计满 N → 随机填 1 个正确数（记在该观众名下）
 *   - handleGift(ctx,msg)       送礼 → 随机连填 m 个正确数（记在送礼观众名下）
 *   - 自动填数                  每隔 autoFillSec 秒系统自动落 1 个正确数（不记分）
 *
 * 【计分】每填对 1 格 +scorePerFill（awardScore，不加胜场）；
 *   通关时 MVP（本局填对最多者）+mvpBonus 并计 1 胜（award）。
 * ============================================================================
 */
'use strict';

const engine = require('./engine');
const { createBroadcaster, BC_CFG_DEFAULTS, BC_CFG_KEYS } = require('../../common/broadcast'); // 通用 AI 播报中心
const SUDOKU_SLOTS = require('./slots'); // 播报点定义（开局/进度里程碑/结算）

/* ═══════════════ 注册信息 ═══════════════ */

const MANIFEST = {
  id: 'sudoku',
  name: '弹幕数独',
  icon: '🧩',
  desc: '弹幕抢填数独 · 点赞/送礼/自动填格助攻',
  liveStatuses: ['playing'],
  // 全局排行榜计分字段（宿主动态注册，新增游戏零改宿主）
  score: { wins: 'sudoku_wins', score: 'sudoku_score', floors: null },
};

/* ═══════════════ 难度与配置 ═══════════════ */

const DIFFICULTIES = {
  easy: { label: '简单', holes: 32 },
  normal: { label: '中等', holes: 45 },
  hard: { label: '困难', holes: 56 },
};

const CFG_DEFAULTS = {
  roundSec: 480,              // 每局时长（秒）
  resultShowSec: 12,          // 结算停留（秒）
  autoNextRound: true,
  difficulty: 'normal',       // easy | normal | hard（决定挖洞空格数）
  scorePerFill: 10,           // 每填对 1 格得分 x
  rateLimitSec: 2,            // 同一观众两次弹幕的最小间隔
  maxFillsPerUserPerRound: 20, // 每人每局弹幕填对上限（0=不限）
  likeThreshold: 30,          // 单人点赞累计 N → 随机填 1 格
  giftFillCount: 3,           // 送礼随机连填 m 格
  autoFillSec: 60,            // 系统自动填数间隔（秒，0=关闭）
  wrongFillPenalty: 0,        // 错填扣分（0=忽略不扣）
  fillPattern: 'loose',       // loose=宽松（357/3行5列7） strict=严格（仅 3行5列7）
  avatarCorner: 'right-top',  // 填对格子头像角标位置：right-top | left-top
  mvpBonus: 50,               // 通关 MVP 加分
  allowedRoomId: '',
  // ── AI 播报（通用播报中心 common/broadcast，off/local/api + 密钥只存服务端） ──
  ...BC_CFG_DEFAULTS,
};

/* ═══════════════ 通用 AI 播报中心（common/broadcast） ═══════════════ */
function BC(ctx) {
  if (!ctx._bc) {
    ctx._bc = createBroadcaster({
      gameId: 'sudoku', gameName: '弹幕数独', slots: SUDOKU_SLOTS,
      getCfg: () => ctx.cfg,
      getState: () => ctx.state,
      emit: () => ctx.emit.state(),
      log: ctx.log,
    });
  }
  return ctx._bc;
}

/** 配置表单 schema（备用，主播台当前按 control.js 手绘表单渲染） */
const CONFIG_SCHEMA = [
  { key: 'roundSec', label: '每局时长(秒)', type: 'number', min: 60, def: 480 },
  { key: 'difficulty', label: '难度', type: 'select', options: [['easy', '简单（32 空格）'], ['normal', '中等（45 空格）'], ['hard', '困难（56 空格）']], def: 'normal' },
  { key: 'scorePerFill', label: '每填对得分', type: 'number', min: 1, def: 10 },
  { key: 'likeThreshold', label: '点赞阈值N', type: 'number', min: 1, def: 30 },
  { key: 'giftFillCount', label: '送礼连填m格', type: 'number', min: 1, max: 9, def: 3 },
  { key: 'autoFillSec', label: '自动填数(秒)', type: 'number', min: 0, def: 60 },
];

/* ═══════════════ 状态 ═══════════════ */

function createState() {
  return {
    status: 'idle',            // idle | playing | result | paused
    roundNo: 0,
    puzzle: null,              // { solution, mask, holes }
    board: null,               // Array(81)：null | {v, src, name, uid, avatar, ts}
    deadline: 0,
    pausedRemain: 0,           // 暂停时冻结的剩余毫秒（恢复时按此续时，而非重置满时长）
    startedAt: 0,
    finishedAt: 0,
    progressMarked: new Set(), // 本局已触发的进度里程碑（50/80），开局清空
    likeMap: new Map(),        // uid → { name, avatar, likes }（单人点赞累计，满 N 触发）
    roundScores: new Map(),    // uid → { name, avatar, score, cnt }（本局计分，MVP 依此评）
    roundWrongs: new Map(),    // uid → { name, avatar, wrong }（本局错填数，结算 Top5 展示用）
    roundStats: { dm: 0, like: 0, gift: 0, auto: 0, hint: 0, wrong: 0 },
    ops: [],                   // 本局操作记录（cap 30，随 SSE 下发供展示屏重连补显）
    history: [],               // 历史对局（cap 20）
    finishedInfo: null,        // { complete, durationSec, mvp }
    stats: { rounds: 0, clears: 0 },
    lastFillAt: new Map(),     // 弹幕限流
    fillCount: new Map(),      // uid → 本局弹幕填对次数
  };
}

/* ═══════════════ 内部工具 ═══════════════ */

function diffOf(cfg) {
  return DIFFICULTIES[cfg.difficulty] || DIFFICULTIES.normal;
}
/** 行号显示为字母（A-I），与展示屏左侧行标记一致；列保持数字 */
function posLabel(idx) {
  const r = Math.floor(idx / 9), c = (idx % 9) + 1;
  return `${String.fromCharCode(65 + r)}${c}`;
}
function emptyIdxs(state) {
  const out = [];
  for (let i = 0; i < 81; i++) if (!state.board[i]) out.push(i);
  return out;
}
function userKey(msg) {
  return (msg && msg.user && (msg.user.id || msg.user.displayId)) || (msg && msg.user && msg.user.name) || '匿名';
}
function userName(msg) {
  return (msg && msg.user && msg.user.name) || '匿名';
}
function userAvatar(msg) {
  return (msg && msg.user && msg.user.avatar) || '';
}

/**
 * 操作记录：写进 state.ops（供重连补显）并经 SSE 'guess' 通道实时推送。
 * entry: { type, name, avatar, pos, idx, val, score, msg, hot }
 */
function pushOp(ctx, entry) {
  const { state, emit } = ctx;
  entry.ts = Date.now();
  state.ops.push(entry);
  if (state.ops.length > 30) state.ops.shift();
  emit.guess(entry);
}

/**
 * 核心：往空格落一个正确的数（服务端权威）。
 * @param {number} idx 0-80
 * @param {{src:string, entry?:{user,userId,avatar}, score:number}} p
 * @returns {boolean} 是否成功落格
 */
function doFill(ctx, idx, p) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'playing' || !state.board || state.board[idx]) return false;
  const val = state.puzzle.solution[idx];
  state.board[idx] = {
    v: val, src: p.src,
    name: p.entry ? p.entry.user : '',
    uid: p.entry ? p.entry.userId : '',
    avatar: p.entry ? p.entry.avatar : '',
    ts: Date.now(),
  };
  // 计分（auto/hint 不记分）：全局榜只加分不加胜场，本局榜累计供 MVP 评定
  if (p.entry && p.score > 0) {
    const rs = state.roundScores.get(p.entry.userId) ||
      { uid: p.entry.userId, name: p.entry.user, avatar: p.entry.avatar, score: 0, cnt: 0 };
    rs.score += p.score; rs.cnt++;
    state.roundScores.set(p.entry.userId, rs);
    ctx.awardScore({ userId: p.entry.userId, user: p.entry.user, avatar: p.entry.avatar }, p.score);
  }
  emit.state();
  // 进度里程碑播报：填格比例跨过 50% / 80% 各播一次（通关结算由 finish 负责）
  if (state.status === 'playing') {
    const holes = state.puzzle.holes;
    const done = holes - emptyIdxs(state).length;
    const pct = Math.round(done / holes * 100);
    for (const mark of [50, 80]) {
      if (pct >= mark && !state.progressMarked.has(mark)) {
        state.progressMarked.add(mark);
        let best = null;
        for (const rs of state.roundScores.values()) {
          if (!best || rs.score > best.score) best = rs;
        }
        BC(ctx).speak('progress', {
          round: state.roundNo, filled: done, total: holes, pct: mark,
          remainSec: Math.max(0, Math.round((state.deadline - Date.now()) / 1000)),
          mvpName: best ? best.name : '',
        });
      }
    }
  }
  // 填满 → 通关结算
  if (emptyIdxs(state).length === 0) finishRound(ctx, 'complete');
  return true;
}

/** 随机挑一个空格落「正确数」的通用入口（点赞/礼物/自动/提示共用） */
function fillRandom(ctx, src, entry, score) {
  const { state } = ctx;
  const empties = emptyIdxs(state);
  if (!empties.length) return null;
  const idx = empties[Math.floor(Math.random() * empties.length)];
  const ok = doFill(ctx, idx, { src, entry, score });
  return ok ? { idx, pos: posLabel(idx), val: state.board[idx].v } : null;
}

/* ═══════════════ 开局 / 结算 ═══════════════ */

function startRound(ctx) {
  const { state, cfg, emit } = ctx;
  ctx.clearTimers();
  const puzzle = ctx.engine.generatePuzzle({ holes: diffOf(cfg).holes });
  state.puzzle = puzzle;
  state.board = new Array(81).fill(null);
  for (let i = 0; i < 81; i++) {
    if (puzzle.mask[i] === '1') state.board[i] = { v: puzzle.solution[i], src: 'given', name: '', uid: '', avatar: '', ts: 0 };
  }
  state.roundNo++;
  state.deadline = Date.now() + cfg.roundSec * 1000;
  state.startedAt = Date.now();
  state.finishedAt = 0;
  state.finishedInfo = null;
  state.progressMarked.clear();
  state.likeMap.clear();
  state.roundScores.clear();
  state.roundWrongs.clear();
  state.lastFillAt.clear();
  state.fillCount.clear();
  state.roundStats = { dm: 0, like: 0, gift: 0, auto: 0, hint: 0, wrong: 0 };
  state.ops = [];
  state.status = 'playing';
  state.stats.rounds++;
  ctx.log('INFO', `[sudoku #${state.roundNo}] 开局：${diffOf(cfg).label}（${puzzle.holes} 空格），时长 ${cfg.roundSec}s`);
  pushOp(ctx, { type: 'start', msg: `第 ${state.roundNo} 局开始！弹幕发「行×列×数」抢填，如 A33 = A行3列填3`, hot: true });
  BC(ctx).speak('roundStart', { round: state.roundNo, diff: diffOf(cfg).label, holes: puzzle.holes, sec: cfg.roundSec });
  emit.state();
  scheduleTimeout(ctx);
  scheduleAutoFill(ctx);
}

function finishRound(ctx, reason) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'playing') return;
  ctx.clearTimers();
  state.status = 'result';
  state.finishedAt = Date.now();
  const complete = reason === 'complete';
  const durationSec = Math.round((state.finishedAt - state.startedAt) / 1000);
  // 本局 Top5（按得分降序，最多 5 人）：每人填对数 + 错填数，结算面板展示
  const wrongOf = uid => { const w = state.roundWrongs.get(uid); return w ? w.wrong : 0; };
  const top5 = Array.from(state.roundScores.values())
    .map(rs => ({ uid: rs.uid, name: rs.name, avatar: rs.avatar, score: rs.score, cnt: rs.cnt, wrong: wrongOf(rs.uid) }))
    .sort((a, b) => b.score - a.score || b.cnt - a.cnt || a.wrong - b.wrong)
    .slice(0, 5);
  // 通关评 MVP：Top5 第一名 +mvpBonus 并计 1 胜
  let mvp = null;
  if (complete) {
    state.stats.clears++;
    const best = top5[0] || null;
    if (best) {
      ctx.award({ userId: best.uid || best.name, user: best.name, avatar: best.avatar }, cfg.mvpBonus);
      mvp = { name: best.name, avatar: best.avatar, score: best.score, cnt: best.cnt };
      ctx.log('INFO', `[sudoku #${state.roundNo}] 🏁 通关！用时 ${durationSec}s，MVP ${best.name}（本局 +${best.score}，奖励 +${cfg.mvpBonus}）`);
    } else {
      ctx.log('INFO', `[sudoku #${state.roundNo}] 🏁 通关！用时 ${durationSec}s（无观众参与填格）`);
    }
  } else {
    ctx.log('INFO', `[sudoku #${state.roundNo}] ⏰ 本局结束（${reason === 'skip' ? '主播结束' : '超时'}），已填 ${filledCount(state)}/81`);
  }
  state.finishedInfo = { complete, reason, durationSec, mvp, top5 };
  state.history.unshift({
    roundNo: state.roundNo, complete, durationSec,
    filled: filledCount(state),
    mvpName: mvp ? mvp.name : null, mvpScore: mvp ? mvp.score : null,
    ...state.roundStats, ts: state.finishedAt,
  });
  if (state.history.length > 20) state.history.pop();
  pushOp(ctx, {
    type: 'done', hot: true,
    msg: complete
      ? `🏁 数独完成！用时 ${durationSec}s${mvp ? ` · MVP ${mvp.name}` : ''}`
      : `⏰ 本局结束（${reason === 'skip' ? '主播结束' : '时间到'}）· 已填 ${filledCount(state)}/81`,
  });
  BC(ctx).speak('finish', {
    round: state.roundNo, complete, reason,
    durationSec, mvp, top5,
    filled: filledCount(state), total: 81,
  });
  emit.state();
  if (cfg.autoNextRound) {
    ctx.setTimer('next', () => startRound(ctx), Math.max(3, cfg.resultShowSec) * 1000);
  }
}

function filledCount(state) {
  if (!state.board) return 0;
  let n = 0;
  for (let i = 0; i < 81; i++) if (state.board[i]) n++;
  return n;
}

/* ═══════════════ 定时器：超时 / 自动填数 ═══════════════ */

function scheduleTimeout(ctx) {
  const { state } = ctx;
  ctx.clearTimers('timeout');
  const remain = Math.max(0, state.deadline - Date.now());
  ctx.setTimer('timeout', () => finishRound(ctx, 'timeout'), remain);
}

function scheduleAutoFill(ctx) {
  const { state, cfg } = ctx;
  ctx.clearTimers('autoFill');
  if (cfg.autoFillSec <= 0 || state.status !== 'playing') return;
  ctx.setTimer('autoFill', () => {
    if (state.status !== 'playing') return;
    const r = fillRandom(ctx, 'auto', null, 0);
    if (r) {
      state.roundStats.auto++;
      ctx.log('INFO', `[sudoku #${state.roundNo}] ⚙️ 系统自动填入 ${r.pos}=${r.val}（每 ${cfg.autoFillSec}s）`);
      pushOp(ctx, { type: 'auto', name: '系统', pos: r.pos, idx: r.idx, val: r.val, msg: `系统自动填入（每 ${cfg.autoFillSec}s）` });
    }
    scheduleAutoFill(ctx);   // 循环排程，暂停/结算时由 clearTimers 停掉
  }, cfg.autoFillSec * 1000);
}

/* ═══════════════ 点赞：单人累计满 N → 随机填 1 格 ═══════════════ */

function handleLike(ctx, msg) {
  const { state, cfg } = ctx;
  if (state.status !== 'playing') return false;
  const n0 = Number(msg && msg.likeCount);
  const add = Number.isFinite(n0) && n0 > 0 ? Math.floor(n0) : 1;
  const uid = userKey(msg);
  const rec = state.likeMap.get(uid) || { uid, name: userName(msg), avatar: userAvatar(msg), likes: 0 };
  rec.name = userName(msg) || rec.name;
  if (userAvatar(msg)) rec.avatar = userAvatar(msg);
  rec.likes += add;
  state.likeMap.set(uid, rec);
  // 点赞记录与累计进度进操作日志（触发随机填另有 hot 条目）
  pushOp(ctx, { type: 'like', name: rec.name, avatar: rec.avatar, msg: `点赞 +${add}（累计 ${rec.likes}/${cfg.likeThreshold}）` });
  // 可跨多次点赞累积触发；一次点赞暴击也可能连跳多轮
  let guard = 5;
  while (rec.likes >= cfg.likeThreshold && guard-- > 0) {
    rec.likes -= cfg.likeThreshold;
    triggerLikeFill(ctx, rec);
  }
  ctx.emit.state();   // 前端「👍 x/N」进度实时跟随
  return true;
}

function triggerLikeFill(ctx, rec) {
  const { state, cfg } = ctx;
  const r = fillRandom(ctx, 'like', { user: rec.name, userId: rec.uid, avatar: rec.avatar }, cfg.scorePerFill);
  if (!r) return;
  state.roundStats.like++;
  ctx.log('INFO', `[sudoku #${state.roundNo}] 👍 ${rec.name} 点赞满 ${cfg.likeThreshold}，随机填入 ${r.pos}=${r.val}（+${cfg.scorePerFill}）`);
  pushOp(ctx, { type: 'like', name: rec.name, avatar: rec.avatar, pos: r.pos, idx: r.idx, val: r.val, score: cfg.scorePerFill, hot: true, msg: `点赞满 ${cfg.likeThreshold}，随机填入` });
}

/* ═══════════════ 礼物：随机连填 m 格 ═══════════════ */

function handleGift(ctx, msg) {
  const { state, cfg } = ctx;
  if (state.status !== 'playing') return false;
  const name = userName(msg);
  const avatar = userAvatar(msg);
  const uid = userKey(msg);
  const giftName = (msg && msg.giftName) || '礼物';
  const m = Math.max(1, Math.min(9, parseInt(cfg.giftFillCount, 10) || 3));
  const positions = [];
  for (let i = 0; i < m; i++) {
    ctx.setTimer('gift', () => {
      if (state.status !== 'playing') return;
      const r = fillRandom(ctx, 'gift', { user: name, userId: uid, avatar }, cfg.scorePerFill);
      if (r) {
        state.roundStats.gift++;
        positions.push(`${r.pos}=${r.val}`);
        ctx.emit.state();
      }
      // 最后一格落定后补一条汇总日志（含礼物名）
      if (i === m - 1 && positions.length) {
        const total = cfg.scorePerFill * positions.length;
        ctx.log('INFO', `[sudoku #${state.roundNo}] 🎁 ${name} 送 ${giftName}，随机连填 ${positions.length} 格：${positions.join('、')}（+${total}）`);
        pushOp(ctx, { type: 'gift', name, avatar, msg: `送 ${giftName} 连填 ${positions.length} 格：${positions.join('、')}`, score: total, hot: true });
      }
    }, i * 450);
  }
  return true;
}

/* ═══════════════ 弹幕抢填 ═══════════════ */

/**
 * 解析弹幕 → {r,c,v}（r 为 1 基行号）。
 * 字母行格式（推荐，与盘面左侧 A-I 行标一致）：
 *   A33   = A行3列填3     A3填7 / A3=7 / A3 7 同义
 * 数字格式（宽松模式兼容）：
 *   357 / 3 5 7 / 3行5列7 / 3行5列填7
 * 严格模式：仅认字母行格式。
 */
function parseFill(text, strict) {
  const t = String(text || '').trim();
  if (!t) return null;
  // 字母行：A33 / A3填7 / A3=7 / A3 7（大小写均可，前后不接字母数字避免误触）
  let m = t.match(/(?:^|[^a-zA-Z0-9])([A-Ia-i])\s*([1-9])\s*(?:填|放|是|为|=|:|：)?\s*([1-9])(?![\d])/);
  if (m) return { r: m[1].toUpperCase().charCodeAt(0) - 64, c: +m[2], v: +m[3] };
  if (strict) return null;
  // 数字行列写法：3行5列7 / 3行5列填7 / r3c5=7
  m = t.match(/(?:^|[^\da-z])([1-9])\s*(?:行|r|row)\s*[,，、.]?\s*([1-9])\s*(?:列|c|col)\s*[,，、.]?\s*(?:填|放|是|为|=|:|：)?\s*([1-9])(?![\d])/i);
  if (m) return { r: +m[1], c: +m[2], v: +m[3] };
  // 裸三位：357（前后不接数字，避免「猜357」类别的游戏弹幕误触）
  m = t.match(/(?:^|[^\d])([1-9])([1-9])([1-9])(?![\d])/);
  if (m) return { r: +m[1], c: +m[2], v: +m[3] };
  // 分隔写法：3 5 7 / 3,5,7 / 3.5.7
  m = t.match(/^(?:[^\da-z]*)([1-9])\s*[,，、. ]\s*([1-9])\s*[,，、. ]\s*([1-9])(?![\d])/);
  if (m) return { r: +m[1], c: +m[2], v: +m[3] };
  return null;
}

function rateCheck(ctx, uid) {
  const { state, cfg } = ctx;
  const now = Date.now();
  const last = state.lastFillAt.get(uid) || 0;
  if (cfg.rateLimitSec > 0 && now - last < cfg.rateLimitSec * 1000) return { ok: false, reason: 'rate' };
  const quota = parseInt(cfg.maxFillsPerUserPerRound, 10) || 0;
  if (quota > 0 && (state.fillCount.get(uid) || 0) >= quota) return { ok: false, reason: 'quota' };
  state.lastFillAt.set(uid, now);
  return { ok: true };
}

/** 处理一次有效的弹幕/模拟填数指令 */
function handleFillAttempt(ctx, msg, parsed) {
  const { state, cfg, emit } = ctx;
  const uid = userKey(msg);
  const name = userName(msg);
  const avatar = userAvatar(msg);
  const idx = (parsed.r - 1) * 9 + (parsed.c - 1);

  if (state.board[idx]) {
    // 填已有数字的格子（被占/重复填）：不扣分、不计错填，仅提示
    ctx.log('INFO', `[sudoku #${state.roundNo}] ⚠️ ${name} 填 ${posLabel(idx)}=${parsed.v} 该格已被占用（忽略）`);
    pushOp(ctx, { type: 'wrong', name, avatar, pos: posLabel(idx), idx, val: parsed.v, msg: '该格已被占用' });
    return;
  }
  if (String(state.puzzle.solution[idx]) !== String(parsed.v)) {
    // 错填不落格：红闪 + 日志（可配置扣分）；按人累计供结算面板展示
    state.roundStats.wrong++;
    const wr = state.roundWrongs.get(uid) || { name, avatar, wrong: 0 };
    wr.wrong++;
    state.roundWrongs.set(uid, wr);
    if (cfg.wrongFillPenalty > 0) {
      ctx.awardScore({ userId: uid, user: name, avatar }, -cfg.wrongFillPenalty);
    }
    ctx.log('INFO', `[sudoku #${state.roundNo}] ❌ ${name} 填 ${posLabel(idx)}=${parsed.v} 不对（忽略${cfg.wrongFillPenalty > 0 ? `，-${cfg.wrongFillPenalty} 分` : ''}）`);
    pushOp(ctx, { type: 'wrong', name, avatar, pos: posLabel(idx), idx, val: parsed.v, msg: cfg.wrongFillPenalty > 0 ? `填错，已扣 ${cfg.wrongFillPenalty} 分` : '填错，已忽略' });
    emit.state();   // 让展示屏立即红闪
    return;
  }

  const rc = rateCheck(ctx, uid);
  if (!rc.ok) {
    ctx.emit.notice(rc.reason === 'rate'
      ? `「${name}」填得太快，${cfg.rateLimitSec}s 后再试`
      : `「${name}」本局已达 ${cfg.maxFillsPerUserPerRound} 次填对上限`);
    return;
  }

  // 填观众指定的那一格（点赞/礼物/自动/提示才是随机选格）
  const ok = doFill(ctx, idx, { src: 'dm', entry: { user: name, userId: uid, avatar }, score: cfg.scorePerFill });
  if (!ok) return;
  state.fillCount.set(uid, (state.fillCount.get(uid) || 0) + 1);
  state.roundStats.dm++;
  ctx.log('INFO', `[sudoku #${state.roundNo}] ✍️ ${name} 弹幕填对 ${posLabel(idx)}=${parsed.v}（+${cfg.scorePerFill}）`);
  pushOp(ctx, { type: 'dm', name, avatar, pos: posLabel(idx), idx, val: parsed.v, score: cfg.scorePerFill });
}

function handleDanmu(ctx, msg) {
  const { state, cfg, emit } = ctx;
  if (!msg || msg.event !== 'chat' || !msg.text) return false;
  // 房间ID过滤：留空=接受所有房间；msg.roomId 为空时不拦
  if (cfg.allowedRoomId && msg.roomId) {
    const allowedSet = String(cfg.allowedRoomId).split(/[,，\s]+/).filter(Boolean);
    if (allowedSet.length && !allowedSet.includes(String(msg.roomId))) return false;
  }
  const parsed = parseFill(msg.text, cfg.fillPattern === 'strict');
  if (!parsed) return false;   // 不是填数指令，交给其它机制（无）

  if (state.status !== 'playing') {
    ctx.log('INFO', `[danmu] ${userName(msg)} 在非游戏期发来「${msg.text}」（忽略）`);
    emit.notice(`本局未开始/已结束，「${userName(msg)}」的填数未计入`);
    return true;
  }
  handleFillAttempt(ctx, msg, parsed);
  return true;
}

/* ═══════════════ 主播台控制 ═══════════════ */

function handleAction(ctx, action, payload = {}) {
  const { state, cfg, emit } = ctx;
  switch (action) {
    case 'start':
      if (state.status === 'idle' || state.status === 'result') {
        startRound(ctx);
        return { ok: true, msg: `第 ${state.roundNo} 局已开始（${diffOf(cfg).label} ${state.puzzle.holes} 空格）` };
      }
      return { ok: false, msg: '本局正在进行中，可先「提前结束本局」' };
    case 'hint': {
      if (state.status !== 'playing') return { ok: false, msg: '当前不在游戏中' };
      const r = fillRandom(ctx, 'hint', null, 0);
      if (!r) return { ok: false, msg: '盘面已填满' };
      state.roundStats.hint++;
      ctx.log('INFO', `[sudoku #${state.roundNo}] 💡 主播提示一格 ${r.pos}=${r.val}（不计分）`);
      pushOp(ctx, { type: 'hint', name: '主播', pos: r.pos, idx: r.idx, val: r.val, msg: '主播提示一格（不计分）', hot: true });
      return { ok: true, msg: `已提示 ${r.pos}=${r.val}` };
    }
    case 'pause':
      if (state.status === 'playing') {
        ctx.clearTimers();
        state.pausedRemain = Math.max(0, state.deadline - Date.now());   // 冻结剩余时间
        state.status = 'paused';
        emit.state();
        return { ok: true, msg: `已暂停（剩余 ${Math.ceil(state.pausedRemain / 1000)}s 冻结）` };
      }
      return { ok: false, msg: '无法暂停' };
    case 'resume':
      if (state.status === 'paused') {
        state.status = 'playing';
        // 按暂停时冻结的剩余时间续时；没有记录则退回满时长
        state.deadline = Date.now() + Math.max(1000, state.pausedRemain || cfg.roundSec * 1000);
        state.pausedRemain = 0;
        scheduleTimeout(ctx);
        scheduleAutoFill(ctx);
        emit.state();
        return { ok: true, msg: '已继续' };
      }
      return { ok: false, msg: '当前未暂停' };
    case 'endRound':
      if (state.status === 'playing' || state.status === 'paused') {
        finishRound(ctx, 'skip');
        return { ok: true, msg: '本局已结束' };
      }
      return { ok: false, msg: '当前没有进行中的对局' };
    case 'setRoomFilter': {
      cfg.allowedRoomId = String(payload.roomId || '').trim();
      ctx.persistConfig(cfg);
      emit.state();
      return { ok: true, msg: '直播间筛选已更新' };
    }
    case 'config': {
      const allowed = ['roundSec', 'resultShowSec', 'autoNextRound', 'difficulty', 'scorePerFill', 'rateLimitSec', 'maxFillsPerUserPerRound', 'likeThreshold', 'giftFillCount', 'autoFillSec', 'wrongFillPenalty', 'fillPattern', 'avatarCorner', 'mvpBonus', 'allowedRoomId', ...BC_CFG_KEYS];
      for (const k of allowed) {
        if (payload[k] !== undefined) cfg[k] = payload[k];
      }
      if (!DIFFICULTIES[cfg.difficulty]) cfg.difficulty = 'normal';
      cfg.giftFillCount = Math.max(1, Math.min(9, parseInt(cfg.giftFillCount, 10) || 3));
      cfg.autoFillSec = Math.max(0, parseInt(cfg.autoFillSec, 10) || 0);
      ctx.persistConfig(cfg);
      if (state.status === 'playing') scheduleAutoFill(ctx);   // 自动填数间隔改了立即生效
      ctx.log('INFO', '[config] 已更新:', cfg);
      emit.state();
      return { ok: true, msg: '配置已更新' };
    }
    /* ───────── 模拟观众（联调） ───────── */
    case 'simulateFill': {
      const text = String(payload.text || '').trim();
      if (!text) return { ok: false, msg: '请输入要模拟的弹幕（如 A33 或 3行5列7）' };
      if (state.status !== 'playing') return { ok: false, msg: '本局未在游戏中，无法模拟' };
      const parsed = parseFill(text, false);
      if (!parsed) return { ok: false, msg: '未识别出行列数（如 A33 = A行3列填3，或 3行5列7）' };
      const name = String(payload.name || '模拟观众').trim() || '模拟观众';
      handleFillAttempt(ctx, { user: { id: 'sim_' + name, displayId: 'sim_' + name, name, avatar: '' }, text, roomId: '' }, parsed);
      return { ok: true, msg: `已模拟「${name}」发送 ${text}` };
    }
    case 'simulateLike': {
      if (state.status !== 'playing') return { ok: false, msg: '本局未在游戏中，无法模拟' };
      const n = Math.max(1, parseInt(payload.count, 10) || 1);
      const name = String(payload.name || '模拟观众').trim() || '模拟观众';
      handleLike(ctx, { user: { id: 'sim_' + name, displayId: 'sim_' + name, name, avatar: '' }, likeCount: n });
      const rec = state.likeMap.get('sim_' + name);
      return { ok: true, msg: `「${name}」点赞 +${n}（累计 ${rec ? rec.likes : 0}/${cfg.likeThreshold}）` };
    }
    case 'simulateGift': {
      if (state.status !== 'playing') return { ok: false, msg: '本局未在游戏中，无法模拟' };
      const name = String(payload.name || '模拟观众').trim() || '模拟观众';
      handleGift(ctx, { user: { id: 'sim_' + name, displayId: 'sim_' + name, name, avatar: '' }, giftName: '模拟礼物' });
      return { ok: true, msg: `已模拟「${name}」送礼（连填 ${cfg.giftFillCount} 格）` };
    }
    case 'addLikes': {
      // 主播台「手动加赞」调试：等价于收到一次真实点赞（无观众名，记到点赞池首位）
      if (state.status !== 'playing') return { ok: false, msg: '本局未在游戏中' };
      const n = Math.max(1, parseInt(payload.count, 10) || 1);
      const name = String(payload.name || '').trim();
      const user = name ? { id: 'sim_' + name, displayId: 'sim_' + name, name, avatar: '' } : null;
      handleLike(ctx, user ? { user, likeCount: n } : { likeCount: n });
      return { ok: true, msg: `已加 ${n} 次点赞` };
    }
    default:
      return { ok: false, msg: `未知动作: ${action}` };
  }
}

/* ═══════════════ 状态下发（SSE） ═══════════════ */

function publicState(ctx) {
  const { state, cfg } = ctx;
  const s = {
    status: state.status,
    roundNo: state.roundNo,
    deadline: state.deadline,
    pausedRemain: state.pausedRemain || 0,   // 暂停期展示屏用冻结值定格倒计时
    startedAt: state.startedAt,
    finishedInfo: state.finishedInfo,
    roundStats: state.roundStats,
    stats: state.stats,
    filled: filledCount(state),
    holes: state.puzzle ? state.puzzle.holes : diffOf(cfg).holes,
    difficulty: { key: cfg.difficulty, label: diffOf(cfg).label },
    avatarCorner: cfg.avatarCorner || 'right-top',
    likeThreshold: cfg.likeThreshold,
    ops: state.ops.slice(-14),
    history: state.history.slice(0, 10),
    leaderboard: ctx.topList(),
    // 数独专属榜：ctx.topList() 已按本游戏字段排序（MVP 次数 sudoku_wins 降序 → 数独积分降序，
    // 见 common/leaderboard.js gameTopList），这里只映射成展示屏右栏的两列（👑MVP 次数 + 积分）
    sudokuBoard: ctx.topList(50)
      .map((r, i) => ({ rank: r.rank || i + 1, name: r.name, avatar: r.avatar || '', mvp: r.sudoku_wins || 0, score: r.sudoku_score || 0 })),
    cfg: {
      roundSec: cfg.roundSec, resultShowSec: cfg.resultShowSec, autoNextRound: cfg.autoNextRound,
      difficulty: cfg.difficulty, scorePerFill: cfg.scorePerFill, rateLimitSec: cfg.rateLimitSec,
      maxFillsPerUserPerRound: cfg.maxFillsPerUserPerRound, likeThreshold: cfg.likeThreshold,
      giftFillCount: cfg.giftFillCount, autoFillSec: cfg.autoFillSec, wrongFillPenalty: cfg.wrongFillPenalty,
      fillPattern: cfg.fillPattern, avatarCorner: cfg.avatarCorner, mvpBonus: cfg.mvpBonus,
      allowedRoomId: cfg.allowedRoomId || '',
    },
  };
  // 盘面：提示数串 + 观众已填格（solution 绝不下发展示屏）
  if (state.puzzle) {
    s.mask = state.puzzle.mask;
    s.cells = [];
    for (let i = 0; i < 81; i++) {
      const c = state.board[i];
      if (c && c.src !== 'given') s.cells.push([i, c.v, c.src, c.name, c.avatar]);
    }
  } else {
    s.mask = null;
    s.cells = [];
  }
  // 点赞充能：当前累计最多的观众（展示屏 👍 进度条）
  let top = null;
  for (const rec of state.likeMap.values()) {
    if (!top || rec.likes > top.likes) top = rec;
  }
  s.likeTop = top ? { name: top.name, avatar: top.avatar, likes: Math.min(top.likes, cfg.likeThreshold) } : null;
  // 主播台参考答案（展示屏不渲染，仅控制台「主播参考」小盘用；与猜数字下发答案同先例）
  s.solution = state.puzzle ? state.puzzle.solution : null;
  // 通用 AI 播报：bc/bcSlots/bcCfg 片段必须挂 publicState 顶层（前端面板读 state.bc）
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
  DIFFICULTIES,
  createState,
  handleDanmu,
  handleLike,
  handleGift,
  handleAction,
  publicState,
  clearGameTimers,
};
