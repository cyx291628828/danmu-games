/**
 * ============================================================================
 * games/gomoku/index.js — 弹幕五子棋游戏模块（排队上座 · 弹幕坐标落子）
 * ============================================================================
 * 【玩法】
 *   1. 观众弹幕发「排队 / 排黑 / 排白」进入等候队列；队列展示头像与名字，
 *      个人点赞 1:1 实时转化为排序值，送礼每件额外 +N 排序值，排序值实时重排。
 *   2. 当前局结束后，队列排名第一的观众上座，获得弹幕落子权（坐标如 H8）。
 *   3. 主播台可配置 双人对决（pvp）/ 人机对决（pve）；机器人 10 级难度可选。
 *      双人对决有两条独立队列，新局开始时分别取各队第一名上座。
 *   4. 只有上座观众的坐标弹幕才会被执行；未上座仅提示引导排队。
 *   5. 五子棋规则可配置有无禁手（连珠：黑方三三 / 四四 / 长连禁手）。
 *   6. 上座观众送礼可悔棋（撤回自己上一手及其后所有落子，轮次回给自己）。
 *   7. 双人对决胜方 / 败方得分均可配置，写入全局共享排行榜。
 *   8. 人机对决中击败指定等级机器人，获得对应等级徽章，排行榜名字后方展示。
 *
 * 【接口】与 guess/chengyu/quiz/redblue/sudoku 一致的插件契约：
 *   MANIFEST / CFG_DEFAULTS / CONFIG_SCHEMA / createState / handleDanmu /
 *   handleLike / handleGift / handleEnter / handleAction / publicState / clearGameTimers
 * ============================================================================
 */
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const engine = require('./engine');
const { createBroadcaster, BC_CFG_DEFAULTS, BC_CFG_KEYS } = require('../../common/broadcast'); // 通用 AI 播报中心
const GOMOKU_SLOTS = require('./slots'); // 播报点定义（上座/开局/悔棋/结算）

/* ───────────── AI 工作线程桥 ─────────────
   棋圣级搜索单手可达 ~1s，丢进常驻 Worker 计算，主线程事件循环不再被阻塞
   （弹幕分发 / SSE / 其他游戏照常跑）。Worker 不可用时自动回退同步搜索。 */
let aiWorker = null;
let aiSeq = 0;
const aiPending = new Map(); // seq → { resolve, reject }

function ensureAiWorker() {
  if (aiWorker) return true;
  try {
    aiWorker = new Worker(path.join(__dirname, 'ai-worker.js'));
    aiWorker.on('message', (m) => {
      const p = m && aiPending.get(m.id);
      if (!p) return;
      aiPending.delete(m.id);
      if (m.err) p.reject(new Error('[gomoku-ai] ' + m.err));
      else p.resolve(m.mv);
    });
    const failAll = (err) => {
      for (const p of aiPending.values()) p.reject(err);
      aiPending.clear();
    };
    aiWorker.on('error', (e) => { failAll(e); aiWorker = null; });
    aiWorker.on('exit', () => { failAll(new Error('AI 工作线程退出')); aiWorker = null; });
    return true;
  } catch (e) {
    console.warn('[gomoku] AI 工作线程启动失败，回退主线程同步搜索:', e.message);
    return false;
  }
}

function bestMoveAsync(board, size, sv, level, forbidden) {
  if (!ensureAiWorker()) return Promise.resolve(engine.bestMove(board, size, sv, level, forbidden));
  return new Promise((resolve, reject) => {
    const id = ++aiSeq;
    aiPending.set(id, { resolve, reject });
    try {
      aiWorker.postMessage({ id, board, size, sv, level, forbidden });
    } catch (e) {
      aiPending.delete(id);
      resolve(engine.bestMove(board, size, sv, level, forbidden)); // postMessage 失败兜底
    }
  });
}

// 进程退出前回收工作线程（避免 Windows libuv 在退出瞬间断言崩溃：UV_HANDLE_CLOSING）
process.on('exit', () => {
  if (aiWorker) { try { aiWorker.terminate(); } catch {} }
});

/* ═══════════════ 注册信息 ═══════════════ */

const MANIFEST = {
  id: 'gomoku',
  name: '弹幕五子棋',
  icon: '⚫',
  desc: '排队上座 · 发「准备」开局 · 弹幕坐标落子 · 双人/人机对决 · 禁手可配 · 送礼悔棋 · 等级徽章',
  // 运行中状态（宿主据此点亮主播台导航绿点）
  liveStatuses: ['playing', 'waiting', 'ready'],
  // 全局排行榜计分字段（跨游戏共享 data/leaderboard.json）
  score: { wins: 'gomoku_wins', score: 'gomoku_score', floors: null },
};

/* ═══════════════ 配置 ═══════════════ */

const CFG_DEFAULTS = {
  // ── 对局模式 ──
  mode: 'pve',             // pve=人机对决（观众执黑）| pvp=双人对决（双队列各取第一）
  botLevel: 5,             // 人机等级 1-10（engine.LEVELS）
  forbidden: true,         // 连珠禁手（黑方 三三/四四/长连；黑五连须恰好五子）
  boardSize: 15,           // 棋盘路数：13 | 15 | 19（新局生效）
  // ── 节奏 ──
  moveTimeSec: 45,         // 观众每手限时（秒，超时托管落子；0=不限）
  autoMoveLevel: 4,        // 超时托管 / 主播台「托管一手」使用的 AI 等级（1-10；不影响机器人正常应手的 botLevel）
  botThinkSec: 3,          // 机器人每手「思考」展示时长（秒，0=秒回）
  resultShowSec: 15,       // 结算停留（秒）
  autoNextRound: true,     // 结算后自动开下一局（队列无人则进入「等待上座」）
  rateLimitSec: 1,         // 同一观众落子最小间隔（秒）
  // ── 准备确认（防观众不在直播间占座） ──
  readyEnabled: true,      // 上座后须发送「准备」才开局；false=沿用旧逻辑自动开局
  readyWaitSec: 40,        // 准备超时（秒，超时未准备的观众让座回队列；0=不限时等待）
  // ── 等候队列 ──
  likePerPoint: 1,         // 点赞→排序值换算（1 = 1:1）
  likeCapPerEvent: 0,      // 单条点赞消息计入上限（0=不限）
  giftSortBonus: 30,       // 每件礼物额外增加的排序值
  giftPieceCap: 10,        // 单次礼物事件计件上限（giftCount×repeatCount）
  queueCap: 100,           // 每条队列人数上限
  // ── 送礼悔棋 ──
  giftUndoEnabled: true,   // 上座观众送礼悔棋开关
  giftUndoPerGift: 1,      // 每次礼物可悔手数（1-3）
  undoMaxPerGame: 0,       // 每人每局悔棋次数上限（0=不限）
  // ── 计分（写入全局共享排行榜） ──
  pvpWinScore: 100,        // 双人对决胜方得分（+1 胜场）
  pvpLoseScore: 20,        // 双人对决败方得分（不计胜场；平局双方均得此项）
  pveWinScore: 100,        // 人机对决观众获胜得分（+1 胜场 + 对应等级徽章）
  pveLoseScore: 0,         // 人机对决观众落败得分（不计胜场）
  // ── 其它 ──
  enterHint: true,         // 观众进场播报引导排队
  allowedRoomId: '',
  // ── AI 播报（通用播报中心 common/broadcast，off/local/api + 密钥只存服务端） ──
  ...BC_CFG_DEFAULTS,
};

const CONFIG_SCHEMA = [
  { key: 'mode', label: '对局模式', type: 'select', options: [['pve', '人机对决'], ['pvp', '双人对决']], def: 'pve' },
  { key: 'botLevel', label: '人机等级', type: 'number', min: 1, max: 10, def: 5 },
  { key: 'forbidden', label: '连珠禁手', type: 'bool', def: true },
  { key: 'boardSize', label: '棋盘路数', type: 'select', options: [['13', '13路'], ['15', '15路'], ['19', '19路']], def: '15' },
  { key: 'moveTimeSec', label: '每手限时(秒)', type: 'number', min: 0, def: 45 },
  { key: 'readyEnabled', label: '上座须发「准备」开局', type: 'bool', def: true },
  { key: 'readyWaitSec', label: '准备超时(秒，0=不限)', type: 'number', min: 0, max: 600, def: 40 },
  { key: 'pvpWinScore', label: '双人胜方分', type: 'number', min: 0, def: 100 },
  { key: 'pvpLoseScore', label: '双人败方分', type: 'number', min: 0, def: 20 },
  { key: 'pveWinScore', label: '人机胜方分', type: 'number', min: 0, def: 100 },
  { key: 'pveLoseScore', label: '人机败方分', type: 'number', min: 0, def: 0 },
];

/* ═══════════════ 通用 AI 播报中心（common/broadcast） ═══════════════ */
function BC(ctx) {
  if (!ctx._bc) {
    ctx._bc = createBroadcaster({
      gameId: 'gomoku', gameName: '弹幕五子棋', slots: GOMOKU_SLOTS,
      getCfg: () => ctx.cfg,
      getState: () => ctx.state,
      emit: () => ctx.emit.state(),
      log: ctx.log,
    });
  }
  return ctx._bc;
}

/** 主播台「手动播报」兜底数据（模板渲染 undefined 防御） */
function bcSnapshot(ctx) {
  const s = ctx.state;
  return {
    round: s.roundNo, status: s.status, turn: s.turn,
    black: (s.seats.black && s.seats.black.name) || '虚位以待',
    white: (s.seats.white && s.seats.white.name) || '虚位以待',
    moves: s.moves.length, mode: ctx.cfg.mode, forbidden: !!ctx.cfg.forbidden,
  };
}

/* ═══════════════ 状态 ═══════════════ */

function createState() {
  return {
    status: 'idle',            // idle | waiting | playing | result | paused
    roundNo: 0,
    size: 15,
    board: engine.emptyBoard(15),  // idx → 0 空 1 黑 2 白
    moves: [],                 // [{i, side, sv, uid, name, avatar, src, ts}]
    lastMove: -1,
    turn: 'black',             // 当前执子方
    seats: { black: null, white: null },  // {uid,name,avatar,kind:'viewer'|'bot',level,sort,undoCount,gain}
    queues: { black: new Map(), white: new Map() },  // uid → {uid,name,avatar,sort,likes,gifts,joinedAt}
    deadline: 0,               // 观众当前手限时截止（0=不限/机器人回合）
    pausedFrom: null,
    pausedRemain: 0,           // 暂停冻结的落子剩余毫秒
    pausedTurnRemain: 0,
    startedAt: 0,
    finishedAt: 0,
    moveStats: { dm: 0, auto: 0, undo: 0, forbid: 0 },
    stats: { rounds: 0, pveViewerWins: 0, likes: 0, timeoutMoves: 0 },
    feed: [],                  // 战报流（cap FEED_MAX，随 SSE 增量推送）
    result: null,              // 结算对象
    history: [],               // 历史对局（cap 30）
    lastActAt: new Map(),      // uid → 上次落子时间（限频）
    hintAt: new Map(),         // uid → 上次提示时间（提示限频）
    _fp: { key: '', list: [] },// 黑方禁手点缓存（key = roundNo:moves.length）
  };
}

const FEED_MAX = 18;
let feedSeq = 0;

/* ═══════════════ 工具 ═══════════════ */

function userKey(msg) { return (msg.user && (msg.user.id || msg.user.displayId)) || (msg.user && msg.user.name) || '匿名'; }
function userName(msg) { return (msg.user && msg.user.name) || '匿名'; }
function userAvatar(msg) { return (msg.user && msg.user.avatar) || ''; }

function clampSize(n) {
  const v = parseInt(n, 10) || 15;
  return [13, 15, 19].includes(v) ? v : 15;
}

/** 房间过滤（与 quiz/redblue 一致）：配置了 allowedRoomId 时仅接收指定直播间 */
function roomAllowed(ctx, msg) {
  const allow = String(ctx.cfg.allowedRoomId || '').trim();
  if (!allow || !msg.roomId) return true;
  const set = allow.split(/[,，\s]+/).filter(Boolean);
  return set.includes(String(msg.roomId));
}

/** 高频事件（点赞/排队）节流推送：最多 600ms 一次全量 state */
const pendingEmit = new WeakMap();
function emitSoon(ctx) {
  if (pendingEmit.has(ctx)) return;
  const t = setTimeout(() => {
    pendingEmit.delete(ctx);
    ctx.emit.state();
  }, 600);
  pendingEmit.set(ctx, t);
}
function flushEmit(ctx) {
  const t = pendingEmit.get(ctx);
  if (t) { clearTimeout(t); pendingEmit.delete(ctx); }
  ctx.emit.state();
}

/** 战报流：写 state.feed（重连补显）+ SSE 'guess' 通道增量推送（展示屏 FX） */
function feed(ctx, icon, text, hot = false, extra = null) {
  const f = { id: `${Date.now().toString(36)}_${++feedSeq}`, icon, text, hot, ts: Date.now(), ...(extra || {}) };
  ctx.state.feed.push(f);
  if (ctx.state.feed.length > FEED_MAX) ctx.state.feed.shift();
  try { ctx.emit.guess({ kind: 'feed', ...f }); } catch {}
  return f;
}

/** 观众引导提示（每人 8s 一条，防止刷屏） */
function hint(ctx, uid, name, text) {
  const now = Date.now();
  const last = ctx.state.hintAt.get(uid) || 0;
  if (now - last < 8000) return;
  if (ctx.state.hintAt.size > 800) ctx.state.hintAt.clear();
  ctx.state.hintAt.set(uid, now);
  feed(ctx, '💡', `${name}：${text}`, false, { type: 'hint' });
}

function sortedQueue(q) {
  return [...q.values()].sort((a, b) => (b.sort - a.sort) || (a.joinedAt - b.joinedAt));
}

function findQueued(ctx, uid) {
  if (ctx.state.queues.black.has(uid)) return { side: 'black', rec: ctx.state.queues.black.get(uid) };
  if (ctx.state.queues.white.has(uid)) return { side: 'white', rec: ctx.state.queues.white.get(uid) };
  return null;
}

function isSeated(ctx, uid) {
  const s = ctx.state.seats;
  if (s.black && s.black.uid === uid && s.black.kind === 'viewer') return 'black';
  if (s.white && s.white.uid === uid && s.white.kind === 'viewer') return 'white';
  return null;
}

function newSeatViewer(q) {
  return { uid: q.uid, name: q.name, avatar: q.avatar, kind: 'viewer', level: 0, sort: Math.round(q.sort), ready: !!q.ready, undoCount: 0, gain: 0 };
}
/** 机器人座位（仅人机对决的白方使用；双人对决永不补机器人） */
function newSeatBot(level) {
  const lv = engine.clampLevel(level);
  return {
    uid: '__bot__',
    name: '棋灵',   // 段位·难度名由 pubSeat 下发 levelName 显示在卡片标签
    avatar: '', kind: 'bot', level: lv, sort: 0, ready: true, undoCount: 0, gain: 0,  // 机器人恒视为已就绪
  };
}

/** 击败人机 → 等级徽章（全局榜记录 gomoku_badge = 已击败的最高等级） */
function awardBadge(ctx, entry, level) {
  const lb = ctx.lb;
  const lv = engine.clampLevel(level);
  const key = entry.userId || entry.user || '匿名';
  let rec = lb.map.get(key);
  if (!rec) {
    // 人机获胜分可为 0：确保徽章仍有落盘载体（榜单展示以 totalScore>0 过滤，建议获胜分 >0）
    // 带 guess/chengyu 默认字段，避免 migrateRecord 误判丢失 gomoku 数据
    rec = { key, name: entry.user || '匿名', avatar: entry.avatar || '', gomoku_badge: 0, guess_wins: 0, guess_score: 0, chengyu_wins: 0, chengyu_score: 0, chengyu_floors: 0 };
    lb.map.set(key, rec);
  }
  const cur = Number(rec.gomoku_badge) || 0;
  if (lv > cur) {
    rec.gomoku_badge = lv;
    lb.save();
    ctx.log('INFO', `[gomoku] 🏅 ${rec.name} 击败 ${engine.levelName(lv)} 人机，解锁徽章 ${engine.levelDan(lv)}（原 ${cur ? engine.levelDan(cur) : '无'}）`);
    return true;
  }
  return false;
}

/** 观众座位每完成一局 +1 场（用于「胜率 = gomoku_wins / gomoku_games」）
 *  注意：新建记录必须带 guess/chengyu 默认字段，否则 leaderboard.migrateRecord
 *  会把只含 gomoku_* 的记录误判为旧单字段结构、重建时丢失 gomoku 数据。 */
function countGame(ctx, entry) {
  const lb = ctx.lb;
  const key = entry.userId || entry.user || '匿名';
  let rec = lb.map.get(key);
  if (!rec) {
    rec = { key, name: entry.user || '匿名', avatar: entry.avatar || '', guess_wins: 0, guess_score: 0, chengyu_wins: 0, chengyu_score: 0, chengyu_floors: 0 };
    lb.map.set(key, rec);
  }
  rec.gomoku_games = (Number(rec.gomoku_games) || 0) + 1;
  lb.save();
  return rec;
}

/* ═══════════════ 上座 / 开局 ═══════════════ */

/** 预演本局座位：不改动队列；返回 null = 尚不可开局 */
function planSeats(ctx) {
  const { state, cfg } = ctx;
  const top = (side, excludeUid) => sortedQueue(state.queues[side]).find(q => q.uid !== excludeUid) || null;
  if (cfg.mode === 'pve') {
    const q = top('black');
    if (!q) return null;   // 人机对决必须有观众上座
    return { black: { q, seat: newSeatViewer(q) }, white: { q: null, seat: newSeatBot(cfg.botLevel) } };
  }
  const qb = top('black');
  const qw = top('white', qb && qb.uid);
  // 双人对决：必须黑/白各一位观众到位才开局，缺任一侧继续等待（永不补机器人）
  if (!qb || !qw) return null;
  return { black: { q: qb, seat: newSeatViewer(qb) }, white: { q: qw, seat: newSeatViewer(qw) } };
}

/** 进入「等待上座」：盘面清空，攒队列，来人即自动开局 */
function enterWaiting(ctx, why) {
  const { state, cfg, emit } = ctx;
  ctx.clearTimers();
  state.status = 'waiting';
  state.deadline = 0;
  state.pausedFrom = null;
  state.pausedRemain = 0;
  state.seats = { black: null, white: null };
  state.size = clampSize(cfg.boardSize);
  state.board = engine.emptyBoard(state.size);
  state.moves = [];
  state.lastMove = -1;
  state.result = null;
  state._fp.key = '';
  feed(ctx, '🪑', why || (cfg.mode === 'pvp'
    ? '双人对决虚位以待！发「排黑 / 排白」各占一队，两队到齐自动开局'
    : '虚位以待！发「排队」或「排黑 / 排白」抢占棋席'), true, { type: 'system' });
  emit.state();
}

/** 已在等待中则静默（避免重复入队刷屏）；否则进入等待上座 */
function ensureWaiting(ctx) {
  if (ctx.state.status === 'waiting') return;
  enterWaiting(ctx);
}

/** 状态提示语（展示屏浮层）：waiting 引导排队 / ready 提示谁还没发「准备」 */
function waitHint(ctx) {
  const { state, cfg } = ctx;
  if (state.status === 'ready') {
    const pend = pendingSeatNames(ctx);
    if (!pend) return '双方已就绪，即将开局…';
    const waitSec = Math.max(0, parseInt(cfg.readyWaitSec, 10) || 0);
    const ttl = waitSec > 0 && state.readyDeadline > 0 ? Math.max(0, Math.ceil((state.readyDeadline - Date.now()) / 1000)) : waitSec;
    return `请「${pend}」发送「准备」开始对局${ttl > 0 ? ` · ${ttl}s 内未准备将自动让座` : ''}`;
  }
  const b = state.queues.black.size, w = state.queues.white.size;
  if (cfg.mode === 'pvp') {
    if (b && w) return '双方已就位，即将开局…';
    if (b) return `黑方已就位（${b}人），等待白方发「排白」…`;
    if (w) return `白方已就位（${w}人），等待黑方发「排黑」…`;
    return '双人对决：发「排黑」「排白」各占一队，两队到齐自动开局';
  }
  return b ? '即将开局…' : '虚位以待：发「排队」抢座';
}

/** ready 态尚未发送「准备」的上座观众显示串（空串 = 全员就绪）；内部也用于开局判定 */
function pendingSeatNames(ctx) {
  const s = ctx.state;
  const pend = ['black', 'white'].filter(sd => s.seats[sd] && s.seats[sd].kind === 'viewer' && !s.seats[sd].ready);
  if (!pend.length) return '';
  return pend.map(sd => `${s.seats[sd].name}（${sd === 'black' ? '黑' : '白'}）`).join('、');
}

/** 播报上座（seat feed + AI 播报）：enterReady 与 startRound(新上座) 共用；ready 转正时 plan=null 不重复播 */
function announceSeats(ctx) {
  const { state } = ctx;
  for (const side of ['black', 'white']) {
    const seat = state.seats[side];
    if (seat && seat.kind === 'viewer') {
      feed(ctx, side === 'black' ? '⬛' : '⬜', `${seat.name} 上座！执${side === 'black' ? '黑' : '白'}（排序值 ${seat.sort}）`, true, { type: 'seat', side });
      BC(ctx).speak('seat', { name: seat.name, side, sort: seat.sort });
    }
  }
}

/** 开局：plan 提供新座位（直接开 / force 跳过确认）；ready 全员就绪转正时 plan=null（座位已在位、上座已播报） */
function startRound(ctx, plan) {
  const { state, cfg, emit } = ctx;
  ctx.clearTimers();
  // 占座 = 离开等候队列（仅 plan 路径需要；ready 转正沿用现有座位）
  if (plan) {
    if (plan.black.q) state.queues.black.delete(plan.black.q.uid);
    if (plan.white.q) state.queues.white.delete(plan.white.q.uid);
    state.seats = { black: plan.black.seat, white: plan.white.seat };
    announceSeats(ctx);
  }
  if (!state.seats.black || !state.seats.white) return;   // 防御：缺座不开局
  state.status = 'playing';
  state.size = clampSize(cfg.boardSize);
  state.board = engine.emptyBoard(state.size);
  state.moves = [];
  state.lastMove = -1;
  state.turn = 'black';
  state.moveStats = { dm: 0, auto: 0, undo: 0, forbid: 0 };
  state.result = null;
  state.roundNo++;
  state.startedAt = Date.now();
  state.finishedAt = 0;
  state.readyAt = 0;
  state.readyDeadline = 0;
  state.stats.rounds++;
  state._fp.key = '';
  const bName = state.seats.black.name, wName = state.seats.white.name;
  feed(ctx, '🎬', `第 ${state.roundNo} 局开始：⚫${bName} vs ⚪${wName} · ${cfg.forbidden ? '禁手规则' : '无禁手'} · 弹幕发坐标落子（如 H8）`, true, { type: 'start' });
  ctx.log('INFO', `[gomoku #${state.roundNo}] 开局：${cfg.mode === 'pve' ? '人机' : '双人'}对决 黑=${bName} 白=${wName}（${state.size}路，禁手=${cfg.forbidden}）`);
  BC(ctx).speak('roundStart', {
    round: state.roundNo, mode: cfg.mode, blackName: bName, whiteName: wName,
    botLevel: cfg.mode === 'pve' ? engine.clampLevel(cfg.botLevel) : 0,
    forbidden: !!cfg.forbidden, size: state.size,
  });
  scheduleTurn(ctx);
  emit.state();
}

/** 进入「准备确认」：座位已占但未开局，等待上座观众发送「准备」（readyEnabled 时 tryStart 的落点） */
function enterReady(ctx, plan) {
  const { state, cfg, emit } = ctx;
  ctx.clearTimers();
  state.status = 'ready';
  state.size = clampSize(cfg.boardSize);
  state.board = engine.emptyBoard(state.size);
  state.moves = [];
  state.lastMove = -1;
  state.turn = 'black';
  state.moveStats = { dm: 0, auto: 0, undo: 0, forbid: 0 };
  state.result = null;
  state.deadline = 0;
  state.pausedFrom = null;
  state.pausedRemain = 0;
  state.pausedTurnRemain = 0;
  state._fp.key = '';
  state.readyAt = Date.now();
  // 上座 = 离开等候队列
  if (plan.black.q) state.queues.black.delete(plan.black.q.uid);
  if (plan.white.q) state.queues.white.delete(plan.white.q.uid);
  state.seats = { black: plan.black.seat, white: plan.white.seat };
  announceSeats(ctx);
  const waitSec = Math.max(0, parseInt(cfg.readyWaitSec, 10) || 0);
  state.readyDeadline = waitSec > 0 ? state.readyAt + waitSec * 1000 : 0;
  if (waitSec > 0) ctx.setTimer('ready', () => { flushEmit(ctx); readyTimeout(ctx); }, waitSec * 1000);
  const pend = pendingSeatNames(ctx);
  feed(ctx, '📣', `座位已定！请「${pend}」发送「准备」开局${waitSec > 0 ? `（${waitSec}s 内未准备将自动让座）` : ''}`, true, { type: 'readyHint' });
  ctx.log('INFO', `[gomoku] 🪑 准备确认：黑=${state.seats.black.name} 白=${state.seats.white.name}（超时 ${waitSec || '不限'}s）`);
  emit.state();
}

/** ready 态准备超时：全部在座观众回队列（已就绪者带 ready 标记、重上座免再发准备），重新规划上座 */
function readyTimeout(ctx) {
  const { state, cfg } = ctx;
  if (state.status !== 'ready') return;
  const waitSec = Math.max(0, parseInt(cfg.readyWaitSec, 10) || 0);
  const seatedViewers = ['black', 'white'].filter(s => state.seats[s] && state.seats[s].kind === 'viewer');
  if (!seatedViewers.length) { enterWaiting(ctx); return; }   // 防御：无真人座位
  for (const side of seatedViewers) {
    const seat = state.seats[side];
    // 回队列（保留排序值；rec.ready 供重上座免再准备）
    state.queues[side].set(seat.uid, {
      uid: seat.uid, name: seat.name, avatar: seat.avatar,
      sort: seat.sort || 0, ready: !!seat.ready, likes: 0, gifts: 0, joinedAt: Date.now(),
    });
    feed(ctx, '⏳', seat.ready
      ? `${seat.name} 因对手未就绪暂回队列（已就绪保留，重上座免再发「准备」）`
      : `${seat.name} ${waitSec}s 未发送「准备」——让座回队列，下一位顶上`, true, { type: 'seatTimeout', side });
    ctx.log('INFO', `[gomoku] ⏳ ${seat.name}（${side}）${seat.ready ? '因对手超时回队' : '准备超时让座回队列'}`);
  }
  state.seats = { black: null, white: null };
  state.readyAt = 0;
  state.readyDeadline = 0;
  tryStart(ctx);   // 重新规划：有候选（含刚释放者）→ 再进 ready / 无人 → 等待上座
}

/** 上座观众发「准备」：全部真人就绪后立即开局 */
function handleReady(ctx, msg) {
  const { state } = ctx;
  const uid = userKey(msg), name = userName(msg);
  const side = isSeated(ctx, uid);
  if (!side) {
    const found = findQueued(ctx, uid);
    hint(ctx, uid, name, found ? '你还在等候队列中——上座后发送「准备」即可开局' : '请先发「排队 / 排黑 / 排白」上座，上座后发「准备」开局');
    return { ok: false };
  }
  const seat = state.seats[side];
  if (seat.ready) { hint(ctx, uid, name, '你已准备就绪，等待开局…'); return { ok: false }; }
  seat.ready = true;
  feed(ctx, '✅', `${name} 已发送「准备」！`, true, { type: 'ready', side });
  ctx.log('INFO', `[gomoku] ✅ ${name} 准备就绪（${side}方）`);
  if (!pendingSeatNames(ctx)) {
    startRound(ctx, null);   // 全员就绪 → 立即开局
    return { ok: true };
  }
  ctx.emit.state();
  return { ok: true };
}

/** 尝试开局；开不了就进等待上座（已在等待中不重复刷提示）
 *  opts.force=true（主播台「开始」）：跳过准备确认直接开局，ready 态也可强制转正 */
function tryStart(ctx, opts) {
  const force = !!(opts && opts.force);
  const { state, cfg } = ctx;
  // ready 态强制开局：直接开当前已占座位（plan=null 走 startRound，不重复播上座）
  if (force && state.status === 'ready' && state.seats.black && state.seats.white) {
    startRound(ctx, null);
    return { ok: true, msg: `第 ${state.roundNo} 局已开始（跳过准备确认）` };
  }
  const plan = planSeats(ctx);
  if (plan) {
    if (force || !cfg.readyEnabled) {
      startRound(ctx, plan);
      return { ok: true, msg: `第 ${state.roundNo} 局已开始` };
    }
    enterReady(ctx, plan);
    return { ok: true, msg: '座位已定，等待上座观众发送「准备」开局' };
  }
  ensureWaiting(ctx);
  let msg;
  if (cfg.mode !== 'pvp') {
    msg = '等候队列无人，已进入「等待上座」状态';
  } else {
    const nb = state.queues.black.size, nw = state.queues.white.size;
    const miss = !nb && !nw ? '黑/白两侧都还没有人排队'
      : !nb ? `还差黑方（白方已 ${nw} 人）`
        : `还差白方（黑方已 ${nb} 人）`;
    msg = `双人对决需要黑、白各一位观众：${miss}，已进入「等待上座」（不会由机器人替补）`;
  }
  return { ok: false, msg };
}

/** 等待上座状态下有人入队 → 稍候自动上座（readyEnabled 时进 ready 待「准备」） */
function scheduleTryStart(ctx) {
  if (ctx.state.status !== 'waiting') return;
  ctx.clearTimers('round');
  ctx.setTimer('round', () => {
    if (ctx.state.status !== 'waiting') return;
    tryStart(ctx);   // 内部按 readyEnabled 分流：enterReady / startRound
  }, 1500);
}

/* ═══════════════ 回合调度 ═══════════════ */

/**
 * 重新排程当前回合：观众手 → 落子限时（超时托管）；机器人手 → 思考延时后落子。
 * @param {number} remainMs 暂停恢复时冻结的剩余毫秒（缺省=全新一手）
 */
function scheduleTurn(ctx, remainMs) {
  const { state, cfg } = ctx;
  ctx.clearTimers('turn');
  ctx.clearTimers('bot');
  if (state.status !== 'playing') return;
  state._fp.key = '';   // 换手重算禁手点
  const seat = state.seats[state.turn];
  if (!seat) return;
  if (seat.kind === 'viewer') {
    if (cfg.moveTimeSec > 0) {
      const ms = Math.max(3000, remainMs != null ? remainMs : cfg.moveTimeSec * 1000);
      state.deadline = Date.now() + ms;
      ctx.setTimer('turn', () => autoMove(ctx), ms);
    } else {
      state.deadline = 0;
    }
  } else {
    state.deadline = 0;
    const think = Math.max(0, Number(cfg.botThinkSec) || 0) * 1000;
    const ms = think + Math.random() * Math.min(800, think * 0.4);
    const side = state.turn;
    // 主定时器：bot 思考延时后落子
    ctx.setTimer('bot', () => botPlay(ctx), ms);
    // 看门狗（'turn' 组）：若 bot 定时器意外丢失（被误清/回调未触发/异常吞噬），
    // guardMs 后强制兜底重试，杜绝「AI 一直思考中」的永久卡死。
    const guardMs = Math.max(ms, think) + 3000;
    ctx.setTimer('turn', () => {
      const st = ctx.state;
      if (st.status !== 'playing') return;      // 局已结束
      if (st.turn !== side) return;             // 已换手 = bot 已落子，无需兜底
      const seat = st.seats[side];
      if (!seat || seat.kind === 'viewer') return; // 座位已变更（被顶替/清局）
      ctx.log('WARN', `[gomoku #${st.roundNo}] [bot-guard] bot 定时器(${Math.round(ms)}ms)未落子，看门狗兜底触发 botPlay`);
      botPlay(ctx);
      // 兜底后仍未换手（doMove 静默失败等）→ 重排整回合，每 guardMs 持续自愈，绝不永久卡死
      if (st.status === 'playing' && st.turn === side) scheduleTurn(ctx);
    }, guardMs);
  }
}

/** 机器人落子（仅人机对决白方）；AI 搜索在工作线程，异步返回 */
async function botPlay(ctx) {
  const { state, cfg } = ctx;
  if (state.status !== 'playing') return;
  const seat = state.seats[state.turn];
  if (!seat || seat.kind === 'viewer') return;
  if (ctx._aiBusy) return;                       // 上一次搜索未返回（看门狗并发）时忽略
  const side = state.turn;
  const sv = side === 'black' ? 1 : 2;
  ctx._aiBusy = true;
  let mv;
  try {
    mv = await bestMoveAsync(state.board, state.size, sv, seat.level || cfg.botLevel, cfg.forbidden);
  } catch (e) {
    ctx.log('WARN', `[gomoku #${state.roundNo}] [bot] AI 线程异常，回退同步:`, e.message);
    mv = engine.bestMove(state.board, state.size, sv, seat.level || cfg.botLevel, cfg.forbidden);
  } finally {
    ctx._aiBusy = false;
  }
  if (state.status !== 'playing' || state.turn !== side) return; // 等待期间局面已变（结算/悔棋/换座）
  if (mv < 0) { finishGame(ctx, state.turn === 'black' ? 'white' : 'black', 'noMove'); return; }
  const r = doMove(ctx, mv, 'bot');
  if (!r.ok) ctx.log('WARN', `[gomoku #${state.roundNo}] [bot] 落子失败 mv=${mv} reason=${r.reason || '?'}`);
}

/** 超时托管：为当前观众代落一手（等级取配置 autoMoveLevel），保证对局不冷场 */
async function autoMove(ctx) {
  const { state } = ctx;
  if (state.status !== 'playing') return;
  const seat = state.seats[state.turn];
  if (!seat || seat.kind !== 'viewer') return;
  if (ctx._aiBusy) return;
  const side = state.turn;
  const sv = side === 'black' ? 1 : 2;
  ctx._aiBusy = true;
  let mv;
  try {
    mv = await bestMoveAsync(state.board, state.size, sv, ctx.cfg.autoMoveLevel || 4, ctx.cfg.forbidden);
  } catch (e) {
    mv = engine.bestMove(state.board, state.size, sv, ctx.cfg.autoMoveLevel || 4, ctx.cfg.forbidden);
  } finally {
    ctx._aiBusy = false;
  }
  if (state.status !== 'playing' || state.turn !== side) return;
  if (mv < 0) { finishGame(ctx, state.turn === 'black' ? 'white' : 'black', 'noMove'); return; }
  state.stats.timeoutMoves++;
  doMove(ctx, mv, 'auto');
}

/* ═══════════════ 落子 ═══════════════ */

function doMove(ctx, idx, src) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'playing') return { ok: false };
  const side = state.turn;
  const sv = side === 'black' ? 1 : 2;
  const seat = state.seats[side];
  if (!seat || state.board[idx] !== 0) return { ok: false };
  // 禁手校验（仅黑方 + 禁手开启）：落子无效，轮次不变
  if (cfg.forbidden && sv === 1) {
    const f = engine.isForbidden(state.board, state.size, idx);
    if (f) {
      state.moveStats.forbid++;
      const coord = engine.idxToCoord(state.size, idx);
      feed(ctx, '⛔', `${seat.name} 落子 ${coord} 触发${engine.FORBIDDEN_LABEL[f.type]}，落子无效`, true, { type: 'forbid', idx, side });
      ctx.log('INFO', `[gomoku #${state.roundNo}] ⛔ ${seat.name} ${coord} ${f.type}禁手（落子无效）`);
      emit.state();
      return { ok: false, reason: f.type };
    }
  }
  state.board[idx] = sv;
  const coord = engine.idxToCoord(state.size, idx);
  state.moves.push({ i: idx, side, sv, uid: seat.uid, name: seat.name, avatar: seat.avatar, src, ts: Date.now() });
  state.lastMove = idx;
  state._fp.key = '';
  if (src === 'dm') state.moveStats.dm++;
  if (src === 'auto') state.moveStats.auto++;
  // 胜负 / 满盘
  const win = engine.winLineAfter(state.board, state.size, idx, sv, cfg.forbidden);
  if (win) {
    feed(ctx, side === 'black' ? '⚫' : '⚪', `${seat.name} 落子 ${coord} · 五连！`, true, { type: 'move', idx, side, src });
    emit.state();
    finishGame(ctx, side, 'five', win);
    return { ok: true, win: true };
  }
  if (state.moves.length >= state.size * state.size) {
    emit.state();
    finishGame(ctx, null, 'board');
    return { ok: true };
  }
  state.turn = side === 'black' ? 'white' : 'black';
  scheduleTurn(ctx);
  feed(ctx, side === 'black' ? '⚫' : '⚪', `${seat.name} 落子 ${coord}${src === 'auto' ? '（超时托管）' : ''}`, src !== 'bot', { type: 'move', idx, side, src });
  ctx.log('INFO', `[gomoku #${state.roundNo}] ${side === 'black' ? '⚫' : '⚪'} ${seat.name} 落子 ${coord}（${src}，共 ${state.moves.length} 手）`);
  emit.state();
  return { ok: true };
}

/* ═══════════════ 结算 ═══════════════ */

const REASON_LABEL = {
  five: '五连获胜',
  forfeit: '对方判负',
  noMove: '黑方无合法落点（禁手困毙）',
  board: '棋盘已满',
  'draw-skip': '主播结束（平局）',
};

function finishGame(ctx, winnerSide, reason, winCells) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'playing') return;
  ctx.clearTimers('turn');
  ctx.clearTimers('bot');
  state.status = 'result';
  state.deadline = 0;
  state.finishedAt = Date.now();
  const durationSec = Math.round((state.finishedAt - state.startedAt) / 1000);
  const reasonLabel = REASON_LABEL[reason] || reason;

  // ── 计分（只有观众座位计分；机器人不计） ──
  const scores = [];
  let badgeUp = null;
  if (cfg.mode === 'pvp') {
    for (const side of ['black', 'white']) {
      const seat = state.seats[side];
      if (!seat || seat.kind !== 'viewer') continue;
      const entry = { userId: seat.uid, user: seat.name, avatar: seat.avatar };
      countGame(ctx, entry);   // 场次 +1（胜率分母）
      if (winnerSide === side) {
        ctx.award(entry, cfg.pvpWinScore);            // 胜方：得分 + 1 胜场
        seat.gain = cfg.pvpWinScore;
      } else {
        ctx.lb.awardScore(MANIFEST.id, entry, cfg.pvpLoseScore);   // 败方/平局：参与奖
        seat.gain = cfg.pvpLoseScore;
      }
      scores.push({ side, name: seat.name, avatar: seat.avatar, gain: seat.gain, win: winnerSide === side });
    }
    if (winnerSide) state.stats.pvpRounds = (state.stats.pvpRounds || 0) + 1;
  } else {
    const seat = state.seats.black;   // 人机对决观众执黑
    if (seat && seat.kind === 'viewer') {
      const entry = { userId: seat.uid, user: seat.name, avatar: seat.avatar };
      countGame(ctx, entry);   // 场次 +1（胜率分母）
      if (winnerSide === 'black') {
        ctx.award(entry, cfg.pveWinScore);
        seat.gain = cfg.pveWinScore;
        state.stats.pveViewerWins++;
        const botLevel = (state.seats.white && state.seats.white.level) || cfg.botLevel;
        if (awardBadge(ctx, entry, botLevel)) badgeUp = { name: seat.name, level: engine.clampLevel(botLevel) };
      } else {
        if (cfg.pveLoseScore > 0) ctx.lb.awardScore(MANIFEST.id, entry, cfg.pveLoseScore);
        seat.gain = cfg.pveLoseScore;
      }
      scores.push({ side: 'black', name: seat.name, avatar: seat.avatar, gain: seat.gain, win: winnerSide === 'black' });
    }
  }

  state.result = {
    mode: cfg.mode,
    winner: winnerSide || null,
    winnerName: winnerSide && state.seats[winnerSide] ? state.seats[winnerSide].name : '',
    reason,
    reasonLabel,
    winCells: winCells || [],
    moves: state.moves.length,
    durationSec,
    scores,
    badgeUp,
    blackName: state.seats.black ? state.seats.black.name : '',
    whiteName: state.seats.white ? state.seats.white.name : '',
    revealedAt: state.finishedAt,
  };
  state.history.unshift({
    roundNo: state.roundNo, mode: cfg.mode,
    black: state.result.blackName, white: state.result.whiteName,
    winner: state.result.winner, reasonLabel,
    moves: state.result.moves, durationSec, ts: state.finishedAt,
  });
  if (state.history.length > 30) state.history.pop();

  const scoreLine = scores.filter(s => s.gain).map(s => `${s.name} +${s.gain}`).join('、');
  feed(ctx, winnerSide ? '🏆' : '🤝', winnerSide
    ? `「${state.result.winnerName}」${reasonLabel}！第 ${state.roundNo} 局结束（${state.result.moves} 手）${scoreLine ? ` · ${scoreLine}` : ''}`
    : `平局！第 ${state.roundNo} 局结束（${state.result.moves} 手）`, true, { type: 'result', winner: winnerSide });
  ctx.log('INFO', `[gomoku #${state.roundNo}] 结算：${winnerSide ? `${state.result.winnerName} 胜（${reasonLabel}）` : '平局'} · ${state.result.moves} 手 · ${durationSec}s`);
  BC(ctx).speak('result', {
    round: state.roundNo, winner: winnerSide, winnerName: state.result.winnerName,
    reasonLabel, moves: state.result.moves, durationSec, scoreLine,
  });
  emit.state();
  if (cfg.autoNextRound) {
    ctx.setTimer('round', () => { flushEmit(ctx); tryStart(ctx); }, Math.max(3, cfg.resultShowSec) * 1000);
  }
}

/* ═══════════════ 悔棋（送礼触发） ═══════════════ */

/**
 * 撤回 side 最后一手及其之后的所有落子，轮次回给 side。
 * （对手已应对时 = 撤两手；自己刚落 = 撤一手）
 */
function giftUndo(ctx, side) {
  const { state } = ctx;
  let lastIdx = -1;
  for (let i = state.moves.length - 1; i >= 0; i--) {
    if (state.moves[i].side === side) { lastIdx = i; break; }
  }
  if (lastIdx < 0) return { ok: false, reason: 'none' };
  const removed = state.moves.splice(lastIdx);
  const idxs = [];
  for (const m of removed) { state.board[m.i] = 0; idxs.push(m.i); }
  state.lastMove = state.moves.length ? state.moves[state.moves.length - 1].i : -1;
  state.turn = side;
  state.moveStats.undo += removed.length;
  state._fp.key = '';
  scheduleTurn(ctx);
  return { ok: true, count: removed.length, idxs };
}

/* ═══════════════ 事件处理：弹幕 / 点赞 / 礼物 / 进场 ═══════════════ */

/** 排队口令解析：'black' | 'white' | 'auto'（主播台按模式落到对应队列） | null
 *  只认文字口令：黑/白（含排黑/排白/黑方…等自然变体）与「排队/上座/报名」类；
 *  纯数字 1/2/3… 全部让给「格子编号」坐标（parseCoord 优先于本函数解析）。 */
function parseJoinSide(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/排\s*黑/.test(t) || /^(占|上)?黑(方|队|棋|座)?$/.test(t)) return 'black';
  if (/排\s*白/.test(t) || /^(占|上)?白(方|队|棋|座)?$/.test(t)) return 'white';
  if (/排\s*队|上座|报名|我要(玩|上|打|下棋)|参加/.test(t)) return 'auto';
  return null;
}

function handleJoin(ctx, msg, side) {
  const { state, cfg } = ctx;
  const uid = userKey(msg), name = userName(msg), avatar = userAvatar(msg);
  // 仅对局中禁止重复排队；结算期座位已过期，上局观众可立刻为下一局排队
  if (isSeated(ctx, uid) && (state.status === 'playing' || state.status === 'paused')) {
    hint(ctx, uid, name, '你正在对局中，本局结束后再来排队');
    return;
  }
  // pve 只有一条等候队列；pvp 发「排队」自动进人少的一队
  const key = cfg.mode === 'pve' ? 'black'
    : side === 'auto' ? (state.queues.black.size <= state.queues.white.size ? 'black' : 'white')
      : side;
  const q = state.queues[key];
  const other = key === 'black' ? 'white' : 'black';
  const cap = Math.max(1, cfg.queueCap || 100);
  let rec = state.queues[other].has(uid) ? state.queues[other].get(uid) : q.get(uid) || null;
  if (!rec && q.size >= cap) { hint(ctx, uid, name, '等候队列已满，稍后再来'); return; }
  const existed = q.has(uid);
  // 换队保留已攒的排序值
  if (state.queues[other].has(uid)) state.queues[other].delete(uid);
  if (!rec) {
    rec = { uid, name, avatar, sort: 0, likes: 0, gifts: 0, joinedAt: Date.now() };
    q.set(uid, rec);
  } else {
    if (!q.has(uid)) q.set(uid, rec);
    if (name) rec.name = name;
    if (avatar) rec.avatar = avatar;
  }
  if (!existed) {
    const pos = sortedQueue(q).findIndex(r => r.uid === uid) + 1;
    const label = cfg.mode === 'pve' ? '等候' : (key === 'black' ? '黑方' : '白方');
    feed(ctx, key === 'black' ? '⬛' : '⬜', `${name} 加入${label}队列（第 ${pos} 位）`, false, { type: 'join', side: key });
    ctx.log('INFO', `[gomoku] ${name} 排队 → ${key}（第 ${pos} 位）`);
    if (state.status === 'waiting') {
      scheduleTryStart(ctx);
    } else if (state.status === 'idle') {
      // 冷启动兜底：宿主重启后 / 主播未点过「开始」时，观众直接发「排队」
      // 也应自动进入「等待上座」并调度上座，而不是静默无反馈地干等
      ensureWaiting(ctx);
      scheduleTryStart(ctx);
    }
  }
  emitSoon(ctx);
}

function handleCoord(ctx, msg, idx) {
  const { state, cfg } = ctx;
  const uid = userKey(msg), name = userName(msg);
  if (state.status === 'result') { hint(ctx, uid, name, '本局已结束，稍等下一局开棋'); return; }
  if (state.status === 'waiting') {
    const found = findQueued(ctx, uid);
    hint(ctx, uid, name, found ? '你已在等候队列中，排名第一即可上座落子' : '虚位以待！先发「排队 / 排黑 / 排白」上座');
    return;
  }
  if (state.status === 'paused') { hint(ctx, uid, name, '游戏暂停中，稍候再落子'); return; }
  if (state.status !== 'playing') { hint(ctx, uid, name, '等待主播开局，先发「排队」占座'); return; }

  const side = state.turn;
  const seat = state.seats[side];
  const mySeat = isSeated(ctx, uid);
  if (!seat || seat.kind !== 'viewer' || mySeat !== side) {
    if (mySeat) hint(ctx, uid, name, mySeat === side ? '轮到你落子！弹幕发坐标（如 H8）' : '还没轮到你，等待对手落子');
    else if (findQueued(ctx, uid)) hint(ctx, uid, name, '你还在等候队列中，上座后才能落子');
    else hint(ctx, uid, name, '先发「排队 / 排黑 / 排白」加入等候队列，排名第一即可上座落子');
    return;
  }
  // 落子限频
  const now = Date.now();
  const last = state.lastActAt.get(uid) || 0;
  if (cfg.rateLimitSec > 0 && now - last < cfg.rateLimitSec * 1000) return;
  if (state.lastActAt.size > 800) state.lastActAt.clear();
  state.lastActAt.set(uid, now);
  doMove(ctx, idx, 'dm');
}

function handleDanmu(ctx, msg) {
  if (!msg || msg.event !== 'chat' || !msg.text) return false;
  if (!roomAllowed(ctx, msg)) return false;
  const { state, cfg } = ctx;
  const text = String(msg.text);
  // 1) 坐标落子（H8 / 8H / H行8列 …；约定：字母=行、数字=列，与展示屏行列标一致）
  // 解析用当前对局的 state.size（而非待生效的 cfg.boardSize）：主播中途改棋盘路数不影响本局
  const idx = engine.parseCoord(text, ctx.state.size || clampSize(ctx.cfg.boardSize));
  if (idx >= 0) { handleCoord(ctx, msg, idx); return true; }
  // 2) 排队入列
  const joinSide = parseJoinSide(text);
  if (joinSide) { handleJoin(ctx, msg, joinSide); return true; }
  // 3) 「准备 / 就绪」确认开局：ready 态上座观众 → 全部就绪即开局；
  //    waiting 态排队观众发「准备」= 催促自动安排上座（重置 1.5s 定时器）
  if (/准备|就绪|就位|ready|ok/i.test(text)) {
    if (state.status === 'ready') { handleReady(ctx, msg); return true; }
    if (state.status === 'waiting' && findQueued(ctx, userKey(msg))) {
      scheduleTryStart(ctx);
      hint(ctx, userKey(msg), userName(msg), '收到！已在为你安排上座——上座后请再发一次「准备」确认开局');
      return true;
    }
  }
  // 4) 「悔棋」口令 → 引导送礼
  if (/悔棋/.test(text) && isSeated(ctx, userKey(msg))) {
    hint(ctx, userKey(msg), userName(msg), '悔棋需要送礼触发哦～送出任意礼物即可撤回你的上一手');
  }
  return false;
}

/** 点赞：队列内观众 1:1 转化为排序值（未排队不计） */
function handleLike(ctx, msg) {
  const { state, cfg } = ctx;
  if (!roomAllowed(ctx, msg)) return false;
  const uid = userKey(msg);
  const found = findQueued(ctx, uid);
  if (!found) return false;
  const n0 = Number(msg && msg.likeCount);
  let add = Number.isFinite(n0) && n0 > 0 ? Math.floor(n0) : 1;
  if (cfg.likeCapPerEvent > 0) add = Math.min(add, cfg.likeCapPerEvent);
  const per = Number(cfg.likePerPoint);
  const gain = Math.round(add * (Number.isFinite(per) ? per : 1));
  found.rec.likes += add;
  found.rec.sort += gain;
  state.stats.likes += add;
  emitSoon(ctx);
  return true;
}

/** 礼物：上座观众 → 悔棋；等候队列 → 排序值 +N/件；路人 → 引导排队 */
function handleGift(ctx, msg) {
  const { state, cfg, emit } = ctx;
  if (!roomAllowed(ctx, msg)) return false;
  const uid = userKey(msg), name = userName(msg);
  const giftName = (msg && msg.giftName) || '礼物';
  const pieces = Math.min(Math.max(1, cfg.giftPieceCap || 10), Math.max(1, (Number(msg.giftCount) || 1) * (Number(msg.repeatCount) || 1)));

  // ① 上座观众送礼 → 悔棋
  if (cfg.giftUndoEnabled && state.status === 'playing') {
    const side = (state.seats.black && state.seats.black.uid === uid) ? 'black'
      : (state.seats.white && state.seats.white.uid === uid) ? 'white' : null;
    if (side) {
      const seat = state.seats[side];
      if (cfg.undoMaxPerGame > 0 && seat.undoCount >= cfg.undoMaxPerGame) {
        hint(ctx, uid, name, `本局悔棋次数已达上限（${cfg.undoMaxPerGame} 次）`);
        return true;
      }
      let total = 0; const idxs = [];
      const times = Math.max(1, Math.min(3, parseInt(cfg.giftUndoPerGift, 10) || 1));
      for (let k = 0; k < times; k++) {
        const r = giftUndo(ctx, side);
        if (!r.ok) break;
        total += r.count;
        idxs.push(...r.idxs);
        seat.undoCount++;
      }
      if (!total) { hint(ctx, uid, name, '你本局还没有落子，暂无可悔之棋'); return true; }
      feed(ctx, '🎁', `${name} 送 ${giftName} 悔棋，撤回 ${total} 手`, true, { type: 'giftUndo', idxs, side });
      ctx.log('INFO', `[gomoku #${state.roundNo}] 🎁 ${name} 送礼悔棋：撤回 ${total} 手`);
      BC(ctx).speak('undo', { name, side, count: total });
      emit.state();
      return true;
    }
  }

  // ② 等候队列送礼 → 排序值 +N/件
  const found = findQueued(ctx, uid);
  if (found) {
    found.rec.gifts += pieces;
    const gain = pieces * (Number(cfg.giftSortBonus) || 0);
    found.rec.sort += gain;
    feed(ctx, '🎁', `${name} 送 ${giftName}×${pieces}，排序值 +${gain}`, true, { type: 'giftSort', side: found.side });
    ctx.log('INFO', `[gomoku] 🎁 ${name} 送 ${giftName}×${pieces} → 排序值 +${gain}`);
    emitSoon(ctx);
    return true;
  }

  // ③ 路人送礼 → 引导排队（礼物不浪费提示）
  hint(ctx, uid, name, '送礼可大幅提升排队排序值——先发「排队 / 排黑 / 排白」加入等候队列');
  return true;
}

function handleEnter(ctx, msg) {
  const { cfg, state } = ctx;
  if (!cfg.enterHint) return;
  if (!['playing', 'waiting', 'ready', 'result', 'idle'].includes(state.status)) return;
  feed(ctx, '👋', `${userName(msg)} 进入直播间，发「排队」上座下棋！`, false, { type: 'enter' });
  emitSoon(ctx);
}

/* ═══════════════ 主播台控制 ═══════════════ */

const CFG_KEYS = ['mode', 'botLevel', 'forbidden', 'boardSize',
  'moveTimeSec', 'autoMoveLevel', 'botThinkSec', 'resultShowSec', 'autoNextRound', 'rateLimitSec',
  'likePerPoint', 'likeCapPerEvent', 'giftSortBonus', 'giftPieceCap', 'queueCap',
  'giftUndoEnabled', 'giftUndoPerGift', 'undoMaxPerGame',
  'pvpWinScore', 'pvpLoseScore', 'pveWinScore', 'pveLoseScore',
  'readyEnabled', 'readyWaitSec',
  'enterHint', 'allowedRoomId', ...BC_CFG_KEYS];

function handleAction(ctx, action, payload = {}) {
  const { state, cfg, emit } = ctx;
  switch (action) {
    case 'start':
    case 'seatNow':
      if (state.status === 'playing') return { ok: false, msg: '对局进行中，可先「平局结束」' };
      if (state.status === 'paused') return { ok: false, msg: '已暂停，请先继续' };
      return tryStart(ctx, { force: true });   // 主播台「开始」= 强制跳过准备确认直接开局
    case 'pause':
      if (state.status === 'playing') {
        ctx.clearTimers('turn');
        ctx.clearTimers('bot');
        state.pausedTurnRemain = state.deadline > 0 ? Math.max(0, state.deadline - Date.now()) : 0;
        state.pausedRemain = state.pausedTurnRemain;
        state.status = 'paused';
        emit.state();
        return { ok: true, msg: '已暂停（落子倒计时冻结）' };
      }
      return { ok: false, msg: '当前没有进行中的对局' };
    case 'resume':
      if (state.status === 'paused') {
        state.status = 'playing';
        scheduleTurn(ctx, state.pausedTurnRemain > 0 ? state.pausedTurnRemain : undefined);
        state.pausedRemain = 0;
        state.pausedTurnRemain = 0;
        emit.state();
        return { ok: true, msg: '已继续' };
      }
      return { ok: false, msg: '当前未暂停' };
    case 'autoMove': {   // 托管一手：为当前执子方代落（AI 搜索在工作线程，异步返回）
      if (state.status !== 'playing') return { ok: false, msg: '当前没有进行中的对局' };
      const seat = state.seats[state.turn];
      if (!seat) return { ok: false, msg: '当前无执子方' };
      const side = state.turn;
      const sv = side === 'black' ? 1 : 2;
      return (async () => {
        ctx._aiBusy = true;
        let mv;
        try {
          mv = await bestMoveAsync(state.board, state.size, sv, cfg.autoMoveLevel || 4, cfg.forbidden);
        } catch (e) {
          mv = engine.bestMove(state.board, state.size, sv, cfg.autoMoveLevel || 4, cfg.forbidden);
        } finally {
          ctx._aiBusy = false;
        }
        if (state.status !== 'playing' || state.turn !== side) return { ok: false, msg: '对局已变化，未落子' };
        if (mv < 0) { finishGame(ctx, side === 'black' ? 'white' : 'black', 'noMove'); return { ok: true, msg: '黑方无合法落点，已结算' }; }
        state.stats.timeoutMoves++;
        doMove(ctx, mv, 'auto');
        return { ok: true, msg: `已为 ${seat.name} 托管落子 ${engine.idxToCoord(state.size, mv)}` };
      })();
    }
    case 'hostUndo': {   // 主播悔棋：无条件撤回最后一手
      if (state.status !== 'playing') return { ok: false, msg: '当前没有进行中的对局' };
      if (!state.moves.length) return { ok: false, msg: '盘面没有可悔的棋' };
      const last = state.moves.pop();
      state.board[last.i] = 0;
      state.lastMove = state.moves.length ? state.moves[state.moves.length - 1].i : -1;
      state.turn = last.side;
      state._fp.key = '';
      scheduleTurn(ctx);
      feed(ctx, '↩️', `主播操作：撤回 ${last.name} 的 ${engine.idxToCoord(state.size, last.i)} 一手`, true, { type: 'undo', idxs: [last.i] });
      emit.state();
      return { ok: true, msg: `已撤回 ${last.name} 的最后一手` };
    }
    case 'forfeit': {    // 当前方（或指定方）判负
      if (state.status !== 'playing') return { ok: false, msg: '当前没有进行中的对局' };
      const loser = ['black', 'white'].includes(payload.side) ? payload.side : state.turn;
      const winner = loser === 'black' ? 'white' : 'black';
      const loserName = state.seats[loser] ? state.seats[loser].name : loser;
      finishGame(ctx, winner, 'forfeit');
      return { ok: true, msg: `已判 ${loserName} 负` };
    }
    case 'endRound':
      if (state.status === 'playing') { finishGame(ctx, null, 'draw-skip'); return { ok: true, msg: '本局已按平局结束' }; }
      return { ok: false, msg: '当前没有进行中的对局' };
    case 'clearQueue': {
      const sides = ['black', 'white'].includes(payload.side) ? [payload.side] : ['black', 'white'];
      let n = 0;
      for (const s of sides) { n += state.queues[s].size; state.queues[s].clear(); }
      emit.state();
      return { ok: true, msg: `已清空等候队列（移除 ${n} 人）` };
    }
    case 'removeQueued': {
      const uid = String(payload.uid || '');
      const found = findQueued(ctx, uid);
      if (!found) return { ok: false, msg: '该观众不在等候队列中' };
      found.rec && ctx.state.queues[found.side].delete(uid);
      emit.state();
      return { ok: true, msg: `已将 ${found.rec.name} 移出队列` };
    }
    case 'setRoomFilter':
      cfg.allowedRoomId = String(payload.roomId || '').trim();
      ctx.persistConfig(cfg);
      emit.state();
      return { ok: true, msg: '直播间筛选已更新' };
    case 'broadcast':
      return BC(ctx).control({ ...payload, data: { ...bcSnapshot(ctx), ...(payload.data || {}) } });
    case 'config': {
      for (const k of CFG_KEYS) if (payload[k] !== undefined) cfg[k] = payload[k];
      // 数值约束
      cfg.botLevel = engine.clampLevel(cfg.botLevel);
      cfg.boardSize = clampSize(cfg.boardSize);
      cfg.mode = ['pve', 'pvp'].includes(cfg.mode) ? cfg.mode : 'pve';
      cfg.moveTimeSec = Math.max(0, parseInt(cfg.moveTimeSec, 10) || 0);
      cfg.autoMoveLevel = engine.clampLevel(cfg.autoMoveLevel);
      cfg.botThinkSec = Math.max(0, Math.min(15, parseInt(cfg.botThinkSec, 10) || 0));
      cfg.resultShowSec = Math.max(3, parseInt(cfg.resultShowSec, 10) || 15);
      cfg.rateLimitSec = Math.max(0, parseInt(cfg.rateLimitSec, 10) || 0);
      cfg.readyEnabled = !!cfg.readyEnabled;
      cfg.readyWaitSec = Math.max(0, Math.min(600, parseInt(cfg.readyWaitSec, 10) || 0));
      cfg.likePerPoint = Math.max(0, Number(cfg.likePerPoint) || 0);
      cfg.likeCapPerEvent = Math.max(0, parseInt(cfg.likeCapPerEvent, 10) || 0);
      cfg.giftSortBonus = Math.max(0, parseInt(cfg.giftSortBonus, 10) || 0);
      cfg.giftPieceCap = Math.max(1, Math.min(50, parseInt(cfg.giftPieceCap, 10) || 10));
      cfg.queueCap = Math.max(2, parseInt(cfg.queueCap, 10) || 100);
      cfg.giftUndoPerGift = Math.max(1, Math.min(3, parseInt(cfg.giftUndoPerGift, 10) || 1));
      cfg.undoMaxPerGame = Math.max(0, parseInt(cfg.undoMaxPerGame, 10) || 0);
      for (const k of ['pvpWinScore', 'pvpLoseScore', 'pveWinScore', 'pveLoseScore']) {
        cfg[k] = Math.max(0, parseInt(cfg[k], 10) || 0);
      }
      ctx.persistConfig(cfg);
      ctx.log('INFO', '[gomoku config]', { mode: cfg.mode, botLevel: cfg.botLevel, forbidden: cfg.forbidden, boardSize: cfg.boardSize });
      emit.state();
      return { ok: true, msg: '配置已更新（模式/禁手/棋盘在下一局生效）' };
    }
    default:
      return { ok: false, msg: `未知动作: ${action}` };
  }
}

/* ═══════════════ 状态下发（SSE） ═══════════════ */

function pubSeat(ctx, seat) {
  if (!seat) return null;
  const out = {
    uid: seat.uid, name: seat.name, avatar: seat.avatar, kind: seat.kind,
    level: seat.level || 0, sort: seat.sort || 0, undoCount: seat.undoCount || 0, gain: seat.gain || 0,
    ready: !!seat.ready,
  };
  if (seat.kind === 'viewer') {
    // 段位 = 已击败的最高人机等级；胜率 = gomoku_wins / gomoku_games
    const rec = ctx.lb.map.get(seat.uid);
    const wins = rec ? (Number(rec.gomoku_wins) || 0) : 0;
    let games = rec ? (Number(rec.gomoku_games) || 0) : 0;
    if (!games && wins > 0) games = wins;   // 旧数据仅有胜场：按全胜估
    out.badge = rec ? (Number(rec.gomoku_badge) || 0) : 0;
    out.wins = wins;
    out.games = games;
    out.winRate = games > 0 ? Math.round((wins / games) * 100) : 0;
  } else {
    out.levelName = engine.levelName(seat.level || 0);
  }
  return out;
}
function pubQ(rec) {
  return { uid: rec.uid, name: rec.name, avatar: rec.avatar, sort: Math.round(rec.sort), likes: rec.likes, gifts: rec.gifts };
}

/** 黑方禁手点（带缓存；仅对局中+禁手开启+轮到黑方时下发） */
function forbiddenList(ctx) {
  const { state, cfg } = ctx;
  if (state.status !== 'playing' || !cfg.forbidden || state.turn !== 'black') return [];
  const key = `${state.roundNo}:${state.moves.length}`;
  if (state._fp.key === key) return state._fp.list;
  state._fp.key = key;
  state._fp.list = engine.forbiddenPoints(state.board, state.size);
  return state._fp.list;
}

function publicState(ctx) {
  const { state, cfg } = ctx;
  const size = state.size;
  const qb = sortedQueue(state.queues.black);
  const qw = sortedQueue(state.queues.white);
  const s = {
    status: state.status,
    roundNo: state.roundNo,
    mode: cfg.mode,
    size,
    turn: state.turn,
    board: state.board ? state.board.join('') : '',
    lastMove: state.lastMove,
    moves: state.moves.slice(-14).map(m => ({
      i: m.i, side: m.side, name: m.name, avatar: m.avatar, src: m.src,
      coord: engine.idxToCoord(size, m.i),
    })),
    seats: { black: pubSeat(ctx, state.seats.black), white: pubSeat(ctx, state.seats.white) },
    deadline: state.deadline || 0,
    readyAt: state.readyAt || 0, readyDeadline: state.readyDeadline || 0,
    pausedRemain: state.pausedRemain || 0,
    pausedTurnRemain: state.pausedTurnRemain || 0,
    forbidden: !!cfg.forbidden,
    forbiddenPts: forbiddenList(ctx),
    botLevel: engine.clampLevel(cfg.botLevel),
    botLevelName: engine.levelName(cfg.botLevel),
    moveStats: state.moveStats,
    stats: state.stats,
    queues: {
      black: { count: qb.length, list: qb.slice(0, 10).map(pubQ) },
      white: { count: qw.length, list: qw.slice(0, 10).map(pubQ) },
    },
    feed: state.feed.slice(-FEED_MAX),
    result: state.result,
    history: state.history.slice(0, 12),
    waitHint: (state.status === 'waiting' || state.status === 'ready') ? waitHint(ctx) : '',
    leaderboard: ctx.topList(50),
    cfg: {
      mode: cfg.mode, botLevel: engine.clampLevel(cfg.botLevel),
      forbidden: !!cfg.forbidden, boardSize: clampSize(cfg.boardSize),
      moveTimeSec: cfg.moveTimeSec, autoMoveLevel: engine.clampLevel(cfg.autoMoveLevel), botThinkSec: cfg.botThinkSec,
      resultShowSec: cfg.resultShowSec, autoNextRound: !!cfg.autoNextRound, rateLimitSec: cfg.rateLimitSec,
      readyEnabled: !!cfg.readyEnabled, readyWaitSec: Math.max(0, parseInt(cfg.readyWaitSec, 10) || 0),
      likePerPoint: cfg.likePerPoint, likeCapPerEvent: cfg.likeCapPerEvent,
      giftSortBonus: cfg.giftSortBonus, giftPieceCap: cfg.giftPieceCap, queueCap: cfg.queueCap,
      giftUndoEnabled: !!cfg.giftUndoEnabled, giftUndoPerGift: cfg.giftUndoPerGift, undoMaxPerGame: cfg.undoMaxPerGame,
      pvpWinScore: cfg.pvpWinScore, pvpLoseScore: cfg.pvpLoseScore,
      pveWinScore: cfg.pveWinScore, pveLoseScore: cfg.pveLoseScore,
      enterHint: !!cfg.enterHint, allowedRoomId: cfg.allowedRoomId || '',
    },
  };
  // 通用 AI 播报：bc/bcSlots/bcCfg 片段必须挂 publicState 顶层（前端面板读 state.bc）
  Object.assign(s, BC(ctx).publicState());
  return s;
}

/** 清理游戏内定时器（host 调用） */
function clearGameTimers(ctx, group) {
  flushEmit(ctx);
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
  handleEnter,
  handleAction,
  publicState,
  clearGameTimers,
};
