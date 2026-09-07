/**
 * ============================================================================
 * games/xieyin/index.js — 谐音梗猜词游戏模块
 * ============================================================================
 * 【玩法】
 *   - 每轮出一张「双格卡片」：上格只报物件名（提示），下格同一物件+丰富变化，
 *     文字固定"这是____"，观众看图拼出答案（谐音/画谜/文字形谜）
 *   - 弹幕直接发答案，首个答对者得分 = baseScore × (0.5 + 剩余时间占比)
 *     （开题即中 1.5 倍，压哨 0.5 倍），答对立即揭示答案
 *   - 超时无人答对 → 自动揭示答案 + 解读，稍后自动下一题
 *   - 类别：成语 / 歇后语 / 明星 / 古代人物 / 物品 / 词语（主播可筛选出题范围）
 *   - 谜面渲染：OpenMoji 素材 + 代码绘制图层（见 puzzles.js schema），
 *     自定义题放 games/xieyin/custom_xieyin.json（按 id 覆盖内置）
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE_BANK = require('./puzzles');

/* ═══════════════ 题库加载（内置 + 用户自定义 custom_xieyin.json） ═══════════════ */

function loadBank() {
  let list = Array.isArray(BASE_BANK) ? BASE_BANK.slice() : [];
  const customPath = path.join(__dirname, 'custom_xieyin.json');
  if (fs.existsSync(customPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(customPath, 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.data || raw.puzzles || []);
      const map = new Map(list.map(p => [p.id, p]));
      arr.forEach(p => { if (p && p.id && p.answer && p.top && p.bot) map.set(p.id, p); });
      list = Array.from(map.values());
    } catch (e) { console.error('[xieyin] custom_xieyin.json 解析失败:', e.message); }
  }
  return list;
}
const BANK = loadBank();
const CATS = Array.from(new Set(BANK.map(p => p.cat).filter(Boolean)));

/* ═══════════════ 注册信息 ═══════════════ */

const MANIFEST = {
  id: 'xieyin',
  name: '谐音梗猜词',
  icon: '🎯',
  desc: '双格卡片看图猜词 · 谐音/画谜/文字谜 · 首个答对得分',
  liveStatuses: ['playing'],
  score: { wins: 'xieyin_wins', score: 'xieyin_score', floors: 'xieyin_solved' },
};

/* ═══════════════ 配置 ═══════════════ */

const CFG_DEFAULTS = {
  answerSec: 60,          // 每题答题时间（秒）
  revealSec: 8,           // 揭示答案后停留时间（秒），随后自动下一题
  autoNext: true,         // 揭示后自动下一题
  baseScore: 100,         // 答对基础分
  rateLimitSec: 1,        // 同一观众发送间隔
  category: '全部',       // 出题类别筛选：全部 | CATS 之一
  noRepeatWindow: 40,     // 近 N 题内不重复（防连续撞题）
  allowedRoomId: '',
};

/* ═══════════════ 工具 ═══════════════ */

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^(猜|答案是?|谜底是?|我觉得是|应该是)/, '')
    .replace(/[\s，。！？!?、.·…～~\-—_'’‘"“”()（）【】\[\]]+/g, '');
}

function judgeAnswer(puzzle, text) {
  const t = normalize(text);
  if (!t) return false;
  if (t === normalize(puzzle.answer)) return true;
  for (const a of (puzzle.alias || [])) if (t === normalize(a)) return true;
  return false;
}

function pickPuzzle(ctx) {
  const { state, cfg } = ctx;
  let pool = BANK;
  if (cfg.category && cfg.category !== '全部') {
    const filtered = BANK.filter(p => p.cat === cfg.category);
    if (filtered.length) pool = filtered;
  }
  // 近 N 题不重复
  const recent = new Set(state.recentIds.slice(-Math.max(1, cfg.noRepeatWindow)));
  let candidates = pool.filter(p => !recent.has(p.id));
  if (!candidates.length) candidates = pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/* ═══════════════ 状态 ═══════════════ */

function createState() {
  return {
    status: 'idle',          // idle | playing | paused | reveal
    roundNo: 0,
    puzzle: null,            // 当前题（对象引用）
    deadline: 0,
    revealed: false,
    winner: null,            // {name, avatar, score}
    recentIds: [],
    sentAt: new Map(),
    history: [],             // [{roundNo, answer, cat, winner, score, ts}]
    solved: new Map(),       // 本场英雄榜 userId -> {name, avatar, wins, score}
  };
}

/* ═══════════════ 开局 / 揭示 / 超时 ═══════════════ */

function startRound(ctx) {
  const { state, cfg, emit } = ctx;
  ctx.clearTimers();
  const p = pickPuzzle(ctx);
  state.roundNo++;
  state.puzzle = p;
  state.recentIds.push(p.id);
  if (state.recentIds.length > 200) state.recentIds = state.recentIds.slice(-200);
  state.revealed = false;
  state.winner = null;
  state.status = 'playing';
  state.deadline = Date.now() + cfg.answerSec * 1000;
  ctx.log('INFO', `[谐音梗 第${state.roundNo}关] 出题「${p.answer}」(${p.cat})，答题 ${cfg.answerSec}s`);
  emit.state();
  scheduleTimeout(ctx);
}

function scheduleTimeout(ctx) {
  const { state, cfg } = ctx;
  ctx.clearTimers('timeout');
  const remain = Math.max(0, state.deadline - Date.now());
  ctx.setTimer('timeout', () => onReveal(ctx, null), remain);
}

function onReveal(ctx, winnerEntry) {
  const { state, cfg, emit } = ctx;
  if (!state.puzzle || state.status !== 'playing') return;
  ctx.clearTimers('timeout');
  state.revealed = true;
  state.status = 'reveal';
  if (winnerEntry) {
    state.winner = winnerEntry;
    ctx.log('INFO', `[谐音梗 第${state.roundNo}关] 🎉 ${winnerEntry.name} 答对「${state.puzzle.answer}」+${winnerEntry.score}分`);
    emit.notice(`🎉 ${winnerEntry.name} 答对了！答案是「${state.puzzle.answer}」 +${winnerEntry.score}分`);
  } else {
    state.winner = null;
    ctx.log('INFO', `[谐音梗 第${state.roundNo}关] ⏰ 无人答对，公布答案「${state.puzzle.answer}」`);
    emit.notice(`没有人猜到～答案是「${state.puzzle.answer}」`);
  }
  state.history.push({
    roundNo: state.roundNo, answer: state.puzzle.answer, cat: state.puzzle.cat,
    winner: state.winner ? state.winner.name : '', score: state.winner ? state.winner.score : 0, ts: Date.now(),
  });
  if (state.history.length > 50) state.history = state.history.slice(-50);
  emit.state();
  if (cfg.autoNext) {
    ctx.setTimer('timeout', () => startRound(ctx), cfg.revealSec * 1000);
  }
}

/* ═══════════════ 弹幕判题 ═══════════════ */

function handleDanmu(ctx, msg) {
  const { state, cfg, emit } = ctx;
  if (!msg || msg.event !== 'chat' || !msg.text) return false;
  if (cfg.allowedRoomId && msg.roomId) {
    const allowedSet = String(cfg.allowedRoomId).split(/[,，\s]+/).filter(Boolean);
    if (allowedSet.length && !allowedSet.includes(String(msg.roomId))) return false;
  }
  if (state.status !== 'playing') return false;

  const text = String(msg.text).trim();
  const key = msg.user?.id || msg.user?.displayId || msg.user?.name || '匿名';
  const now = Date.now();
  const last = state.sentAt.get(key) || 0;
  if (now - last < cfg.rateLimitSec * 1000) return true;

  const name = msg.user?.name || '匿名';
  if (!judgeAnswer(state.puzzle, text)) {
    state.sentAt.set(key, now);
    // 未中不刷屏：不打断节奏，静默忽略（答错提示仅主播台可见的 notice 关闭，避免剧透干扰）
    return true;
  }

  // 答对！
  state.sentAt.set(key, now);
  const remainRatio = Math.max(0, (state.deadline - Date.now()) / 1000) / cfg.answerSec;
  const score = Math.round(cfg.baseScore * (0.5 + remainRatio));
  const entry = {
    name,
    userId: key,
    avatar: msg.user?.avatar || '',
    score,
  };
  ctx.award(entry, score, 1);
  // 本场英雄榜
  const rec = state.solved.get(key) || { name, avatar: entry.avatar, wins: 0, score: 0 };
  rec.wins++; rec.score += score; rec.name = name; rec.avatar = entry.avatar;
  state.solved.set(key, rec);
  onReveal(ctx, entry);
  return true;
}

/* ═══════════════ 动作 ═══════════════ */

function handleAction(ctx, action, payload = {}) {
  const { state, cfg, emit } = ctx;
  switch (action) {
    case 'start':
    case 'next':
      startRound(ctx);
      return { ok: true, msg: state.status === 'playing' ? `第 ${state.roundNo} 关已出题` : '已出题' };
    case 'reveal':
      if (state.status === 'playing') { onReveal(ctx, null); return { ok: true, msg: `已揭示答案「${state.puzzle.answer}」` }; }
      return { ok: false, msg: '当前没有进行中的题目' };
    case 'pause':
      if (state.status === 'playing') {
        ctx.clearTimers();
        state.status = 'paused';
        emit.state();
        return { ok: true, msg: '已暂停' };
      }
      return { ok: false, msg: '当前没有进行中的题目' };
    case 'resume':
      if (state.status === 'paused') {
        state.status = 'playing';
        state.deadline = Date.now() + cfg.answerSec * 1000;
        scheduleTimeout(ctx);
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
      const allowed = ['answerSec', 'revealSec', 'autoNext', 'baseScore', 'rateLimitSec', 'category', 'noRepeatWindow', 'allowedRoomId'];
      for (const k of allowed) if (payload[k] !== undefined) cfg[k] = payload[k];
      if (payload.category && payload.category !== '全部' && !CATS.includes(payload.category)) {
        return { ok: false, msg: `题库中没有类别「${payload.category}」` };
      }
      ctx.persistConfig(cfg);
      ctx.log('INFO', '[xieyin config]', cfg);
      emit.state();
      return { ok: true, msg: '配置已更新' };
    }
    default:
      return { ok: false, msg: `未知动作: ${action}` };
  }
}

/* ═══════════════ 状态输出 ═══════════════ */

function publicPanel(panel) {
  if (!panel) return null;
  return {
    cap: panel.cap || '',
    dark: !!panel.dark,
    art: (panel.art || []).map(l => ({
      t: l.t || 'img',
      img: l.img || '', x: l.x || 0, y: l.y || 0, w: l.w || 120,
      rot: l.rot || 0, flt: l.flt || '', op: l.op ?? 1,
      s: l.s || '',
    })),
  };
}

function publicState(ctx) {
  const { state, cfg } = ctx;
  const p = state.puzzle;
  return {
    status: state.status,
    roundNo: state.roundNo,
    hasPuzzle: !!p,
    // 谜面（渲染数据）：答案只随 revealed 给展示屏看 expl
    top: p ? publicPanel(p.top) : null,
    bot: p ? publicPanel(p.bot) : null,
    cat: p ? p.cat : '',
    slots: p ? Array.from(p.answer).length : 0,
    // 答案/拼音/解读随 state 下发（控制台随时可见；展示屏仅在 revealed 后渲染）
    answer: p ? p.answer : '',
    py: p ? (p.py || '') : '',
    expl: p ? (p.expl || '') : '',
    revealed: state.revealed,
    winner: state.winner,
    deadline: state.deadline,
    answerSec: cfg.answerSec,
    revealSec: cfg.revealSec,
    bankSize: BANK.length,
    catList: CATS,
    category: cfg.category,
    lastRounds: state.history.slice(-20).reverse(),
    // 本场英雄榜（按得分排序前 8）
    heroes: Array.from(state.solved.values()).sort((a, b) => b.score - a.score).slice(0, 8),
    leaderboard: ctx.topList(),
    cfg: {
      answerSec: cfg.answerSec, revealSec: cfg.revealSec, autoNext: cfg.autoNext,
      baseScore: cfg.baseScore, rateLimitSec: cfg.rateLimitSec,
      category: cfg.category, noRepeatWindow: cfg.noRepeatWindow,
      allowedRoomId: cfg.allowedRoomId || '',
    },
  };
}

function clearGameTimers(ctx, group) {
  ctx.clearTimers(group);
}

/* 测试暴露 */
const __test = { normalize, judgeAnswer, pickPuzzle: () => pickPuzzle({ state: { recentIds: [] }, cfg: { category: '全部', noRepeatWindow: 40 } }) };

module.exports = {
  MANIFEST,
  CFG_DEFAULTS,
  createState,
  handleDanmu,
  handleAction,
  publicState,
  clearGameTimers,
  __test,
};
