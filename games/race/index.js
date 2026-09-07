/**
 * ============================================================================
 * games/race/index.js — 赛马竞猜（筹码赛马）游戏模块
 * ============================================================================
 * 【玩法循环】下注期(30s) → 比赛期(25s) → 结算(12s) → 自动下一局
 *   下注期：弹幕发 1/2/3/4 下注（每注 baseBet 筹码），赔率 = 彩池 ÷ 该马注额，实时浮动
 *   比赛期：4 匹马竞速 100 格；观众点赞为「自己所押的马」加速；随机冲刺事件；送礼触发骑士冲锋
 *   结算期：头马按最终赔率派彩；无人押中 → 彩池滚存下局（头奖）
 *
 * 【双轨货币】
 *   筹码（games/race/data/race_wallet.json）：下注真扣、派彩真给，只在赛马内流通，有富家榜
 *   荣誉分（data/leaderboard.json，全局共享）：押中得 honorScore，与其余游戏累计互通
 *   两者不可互兑 —— 赌局连败不污染总榜
 *
 * 【插件契约】MANIFEST / CFG_DEFAULTS / CONFIG_SCHEMA / createState /
 *   handleDanmu / handleLike / handleGift / handleEnter / handleFollow /
 *   handleAction / publicState / clearGameTimers
 *   宿主改动：零（只用 chat/like/gift/enter/follow 五个标准事件，钱包自管）
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Wallet } = require('./wallet');
const { createBroadcaster, BC_CFG_DEFAULTS, BC_CFG_KEYS } = require('../../common/broadcast');
const SLOTS = require('./slots');

/* ═══════════════ 常量 ═══════════════ */

const TICK_MS = 200;              // 竞速刷新间隔（毫秒）
const FEED_CAP = 40;              // 战报流累计上限
const FX_CAP = 24;                // 特效事件队列上限

const HORSE_NAMES = ['闪电', '追风', '黑珍珠', '小土豆', '赤兔', '的卢', '旋风', '玉麒麟', '乌骓', '踏雪', '惊雷', '绝影', '大黑', '小白龙', '火焰', '疾电'];
const LANE_COLORS = ['#f87171', '#ffc53d', '#a78bfa', '#34d399', '#4da3ff', '#fb923c'];

/* 本地 1 钻礼物图（res/礼物资源/<礼物名>_<钻石数>.png），供展示屏「送礼」提示行 */
const GIFT_RES_DIR = path.resolve(__dirname, '..', '..', 'res', '礼物资源');
let GIFT_ICONS = [];
function scanGiftIcons() {
  try {
    if (!fs.existsSync(GIFT_RES_DIR)) return [];
    const out = [];
    for (const f of fs.readdirSync(GIFT_RES_DIR)) {
      const m = f.match(/^(.+?)_(\d+)\.(png|jpe?g|gif|webp)$/i);
      if (!m) continue;
      out.push({ name: m[1], cost: parseInt(m[2], 10), url: `/res/礼物资源/${encodeURIComponent(f)}` });
    }
    out.sort((a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name, 'zh'));
    return out;
  } catch (e) { return []; }
}
GIFT_ICONS = scanGiftIcons();

/* ═══════════════ 关注送筹码冷却（持久化，防重复关注反复领） ═══════════════ */
const FOLLOW_CD_PATH = path.join(__dirname, 'data', 'follow_bonus.json');
const followCd = new Map();
let followCdLoaded = false;
function loadFollowCd() {
  if (followCdLoaded) return;
  followCdLoaded = true;
  try {
    if (!fs.existsSync(FOLLOW_CD_PATH)) return;
    const obj = JSON.parse(fs.readFileSync(FOLLOW_CD_PATH, 'utf8'));
    for (const [k, v] of Object.entries(obj || {})) if (typeof v === 'number' && v > 0) followCd.set(k, v);
  } catch (e) { /* 文件损坏按空冷却处理 */ }
}
function saveFollowCd() {
  try {
    fs.mkdirSync(path.dirname(FOLLOW_CD_PATH), { recursive: true });
    fs.writeFileSync(FOLLOW_CD_PATH, JSON.stringify(Object.fromEntries(followCd)), 'utf8');
  } catch (e) { /* 写盘失败不阻断游戏 */ }
}

/* ═══════════════ 注册信息 ═══════════════ */

const MANIFEST = {
  id: 'race',
  name: '赛马竞猜',
  icon: '🐎',
  desc: '筹码下注 · 点赞加速 · 冷门翻倍 · 头奖滚存',
  liveStatuses: ['betting', 'racing', 'result'],
  score: { wins: 'race_wins', score: 'race_score', floors: null },
};

/* ═══════════════ 配置 ═══════════════ */

const CFG_DEFAULTS = {
  // 阶段时长
  betSec: 30,                  // 下注期
  raceSec: 25,                 // 比赛期
  resultSec: 12,               // 结算停留
  autoLoop: true,              // 结算后自动开下一局
  // 下注
  baseBet: 100,                // 每注筹码
  maxBetsPerRound: 5,          // 每人每局最多注数
  rateLimitSec: 2,             // 同一观众下注间隔
  horseCount: 4,               // 参赛马匹数（2~6）
  // 筹码经济
  startChips: 1000,            // 首次开户赠送
  bailoutChips: 500,           // 破产救济金
  // 赔率
  minOdds: 1.2,
  maxOdds: 20,
  // 点赞加速
  likesPerBoost: 3,            // 每 N 赞 = +1 格
  maxBoostCells: 20,           // 单马每局点赞助威上限（格）
  finalSprintSec: 5,           // 最后 N 秒进入冲刺加倍
  finalSprintMult: 2,          // 冲刺期点赞倍率
  // 礼物骑士冲锋
  giftBoostEnabled: true,
  giftBoostCells: 6,           // 每次送礼 +N 格
  giftMaxCellsPerHorse: 24,    // 单马每局礼物加速上限（格）
  // 关注送筹码
  followBonusChips: 500,
  followCooldownHours: 21,
  // 竞速手感
  surgePerRace: 2,             // 每局平均随机冲刺次数
  rubberBand: 0.8,             // 追赶/领先橡皮筋强度（0=关闭，越大越胶着）
  // 头奖滚存
  jackpotEnabled: true,
  // 荣誉分
  honorScore: 30,              // 押中者额外获得的全局荣誉分
  // 特效强度（full=全屏特效 / simple=仅基础动效 / off=关闭特效）
  fxLevel: 'full',
  allowedRoomId: '',
  ...BC_CFG_DEFAULTS,
};

const CONFIG_SCHEMA = [
  { key: 'betSec', label: '下注期(秒)', type: 'number', min: 5, def: 30 },
  { key: 'raceSec', label: '比赛期(秒)', type: 'number', min: 5, def: 25 },
  { key: 'resultSec', label: '结算停留(秒)', type: 'number', min: 3, def: 12 },
  { key: 'autoLoop', label: '自动开下一局', type: 'bool', def: true },
  { key: 'baseBet', label: '每注筹码', type: 'number', min: 1, def: 100 },
  { key: 'maxBetsPerRound', label: '每人每局注数上限', type: 'number', min: 1, def: 5 },
  { key: 'rateLimitSec', label: '下注间隔(秒)', type: 'number', min: 0, def: 2 },
  { key: 'horseCount', label: '参赛马匹数', type: 'number', min: 2, max: 6, def: 4 },
  { key: 'startChips', label: '开户赠送筹码', type: 'number', min: 0, def: 1000 },
  { key: 'bailoutChips', label: '破产救济金', type: 'number', min: 0, def: 500 },
  { key: 'minOdds', label: '赔率下限(倍)', type: 'number', min: 1, def: 1.2 },
  { key: 'maxOdds', label: '赔率上限(倍)', type: 'number', min: 1, def: 20 },
  { key: 'likesPerBoost', label: '每N赞加速1格', type: 'number', min: 1, def: 3 },
  { key: 'maxBoostCells', label: '单马助威上限(格)', type: 'number', min: 0, def: 20 },
  { key: 'finalSprintSec', label: '最后冲刺(秒)', type: 'number', min: 0, def: 5 },
  { key: 'finalSprintMult', label: '冲刺期点赞倍率', type: 'number', min: 1, def: 2 },
  { key: 'giftBoostEnabled', label: '礼物骑士冲锋', type: 'bool', def: true },
  { key: 'giftBoostCells', label: '每次礼物加速(格)', type: 'number', min: 0, def: 6 },
  { key: 'giftMaxCellsPerHorse', label: '礼物单马上限(格)', type: 'number', min: 0, def: 24 },
  { key: 'followBonusChips', label: '关注赠送筹码', type: 'number', min: 0, def: 500 },
  { key: 'followCooldownHours', label: '关注冷却(小时)', type: 'number', min: 1, def: 21 },
  { key: 'surgePerRace', label: '每局冲刺次数', type: 'number', min: 0, def: 2 },
  { key: 'rubberBand', label: '胶着程度(0-1.5)', type: 'number', min: 0, def: 0.8 },
  { key: 'jackpotEnabled', label: '头奖滚存', type: 'bool', def: true },
  { key: 'honorScore', label: '押中荣誉分', type: 'number', min: 0, def: 30 },
  { key: 'fxLevel', label: '特效强度', type: 'select', options: [['full', '全屏特效'], ['simple', '基础动效'], ['off', '关闭']], def: 'full' },
];

/* ═══════════════ 状态 ═══════════════ */

function createState() {
  return {
    status: 'idle',          // idle | betting | racing | result | paused
    roundNo: 0,
    phaseDeadline: 0,        // 当前阶段截止时间戳
    pausedRemain: 0,         // 暂停时冻结的剩余毫秒
    pausedStatus: null,      // 暂停前的阶段
    horses: [],              // {no,name,color,emoji,bet,bettors,pos,speed,burstUntil,boostCells,giftCells,likes,finishAt,rank}
    pool: 0,                 // 当前彩池（= 本局注额 + 上局滚存）
    carry: 0,                // 由上局滚存进来的金额
    totalStaked: 0,          // 本局累计注额
    bets: [],                // 本局下注明细 [{userId,name,avatar,horse,amount,ts}]
    betCountByUser: new Map(),
    lastBetAt: new Map(),
    betByUser: new Map(),    // userId -> Map(horseIdx -> amount)（支持一局押多匹）
    cheerByUser: new Map(),  // userId -> {name,avatar,likes,boosted}
    horseLikes: [],          // 各马累计助威赞数
    pendingLike: [],         // 下注期点赞预约的加速格（开赛时注入）
    pendingGift: [],         // 下注期送礼预约的骑士冲锋格（开赛时注入）
    raceStartAt: 0,          // 本局开赛时间戳（冲线先后排序用）
    giftList: [],            // 本局送礼记录
    likeStormAt: 0,          // 上次「点赞风暴」全屏特效时间戳（冷却用）
    boostStamp: [],          // 冲刺期加速事件时间戳窗口（风暴检测用）
    feed: [],                // 战报流
    fx: [],                  // 特效事件队列（供展示屏消费）
    fxSeq: 0,
    leadIdx: -1,             // 当前头马下标（领先易主检测）
    result: null,
    history: [],
    bc: { seq: 0, log: [] }, // 播报中心写入区
  };
}

/* ═══════════════ 工具 ═══════════════ */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/** 钱包单实例（懒加载：需要 ctx 才知道落盘目录与日志器） */
let _wallet = null;
function getWallet(ctx) {
  if (!_wallet) _wallet = new Wallet(path.join(ctx.gameDir, 'data', 'race_wallet.json'), (lv, ...a) => ctx.log(lv, ...a));
  return _wallet;
}

/** 播报中心实例（懒加载：依赖 cfg/state/emit） */
function BC(ctx) {
  if (!ctx._bc) {
    ctx._bc = createBroadcaster({
      gameId: 'race', gameName: '赛马竞猜', slots: SLOTS,
      getCfg: () => ctx.cfg,
      getState: () => ctx.state,
      emit: () => ctx.emit.state(),
      log: ctx.log,
    });
  }
  return ctx._bc;
}

function oddsOf(ctx, idx) {
  const { state, cfg } = ctx;
  const h = state.horses[idx];
  if (!h) return Number(cfg.maxOdds);
  const pool = state.totalStaked + state.carry;
  if (!h.bet || pool <= 0) return Number(cfg.maxOdds);
  return clamp(pool / h.bet, Number(cfg.minOdds), Number(cfg.maxOdds));
}

function pushFeed(ctx, e) {
  ctx.state.feed.push({ ts: Date.now(), ...e });
  if (ctx.state.feed.length > FEED_CAP) ctx.state.feed.shift();
}

function pushFx(ctx, e) {
  const s = ctx.state;
  s.fxSeq++;
  s.fx.push({ id: s.fxSeq, ts: Date.now(), ...e });
  if (s.fx.length > FX_CAP) s.fx.shift();
}

/** 观众本局的主押马（押多匹时取注额最大的一匹）；未下注返回 -1 */
function mainHorseOf(ctx, uid) {
  const m = ctx.state.betByUser.get(uid);
  if (!m || !m.size) return -1;
  let best = -1, bestAmt = -1;
  for (const [idx, amt] of m) if (amt > bestAmt) { bestAmt = amt; best = idx; }
  return best;
}

function totalBetOf(ctx, uid) {
  const m = ctx.state.betByUser.get(uid);
  if (!m) return 0;
  let s = 0;
  for (const amt of m.values()) s += amt;
  return s;
}

/** 本局总注数（一条弹幕可押多注，按 count 累加而非按条数） */
function totalBetCount(state) {
  return (state.bets || []).reduce((a, b) => a + (b.count || 1), 0);
}

/** 手动试播 / 主播台手动播报用的兜底数据快照（finish 等字段用当前领跑马假扮） */
function bcSnapshot(ctx) {
  const { state, cfg } = ctx;
  const lead = state.horses.reduce((a, h) => (h.pos > (a ? a.pos : -1) ? h : a), null) || state.horses[0];
  const r10 = v => Math.round(Number(v) * 10) / 10;
  return {
    round: state.roundNo, pool: state.pool, carry: state.carry, baseBet: cfg.baseBet,
    bets: totalBetCount(state), likesPerBoost: cfg.likesPerBoost,
    horses: state.horses.map(h => ({ no: h.no, name: h.name, odds: r10(oddsOf(ctx, h.no - 1)), bettors: h.bettors, pos: Math.round(h.pos) })),
    // finish 播报点兜底字段（试播时以当前领跑马假扮头马）
    winner: lead ? { no: lead.no, name: lead.name } : { no: 1, name: '闪电' },
    odds: lead ? r10(oddsOf(ctx, lead.no - 1)) : 2,
    winnerCount: 0, payout: 0, best: null, wasFavorite: false, margin: 0, jackpot: false,
  };
}

function pickHorses(n) {
  const pool = HORSE_NAMES.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = Math.floor(Math.random() * pool.length);
    const name = pool.splice(k, 1)[0] || `赛马${i + 1}`;
    out.push({
      no: i + 1, name, color: LANE_COLORS[i % LANE_COLORS.length], emoji: '🐎',
      bet: 0, bettors: 0, pos: 0, speed: 0, burstUntil: 0,
      boostCells: 0, giftCells: 0, likes: 0, finishAt: 0, rank: 0,
    });
  }
  return out;
}

/* ═══════════════ 轮次流程 ═══════════════ */

function startRound(ctx) {
  const { state, cfg, emit } = ctx;
  ctx.clearTimers();
  const n = clamp(parseInt(cfg.horseCount, 10) || 4, 2, 6);
  // 首局时把 roundNo 抬到「历史最大救济局号」之上，避免重启后 roundNo 归零
  // 重新踩到已救济过的局号，导致破产救济被误判为「本局已救济过」
  if (!state.roundBase) {
    state.roundBase = getWallet(ctx).maxBailoutRound();
    state.roundNo = Math.max(state.roundNo, state.roundBase);
  }
  state.roundNo++;
  state.horses = pickHorses(n);
  state.bets = [];
  state.betCountByUser = new Map();
  state.lastBetAt = new Map();
  state.betByUser = new Map();
  state.cheerByUser = new Map();
  state.horseLikes = state.horses.map(() => 0);
  state.pendingLike = state.horses.map(() => 0);
  state.pendingGift = state.horses.map(() => 0);
  state.giftList = [];
  state.totalStaked = 0;
  state.pool = state.carry;          // 上局滚存进入本局彩池
  state.result = null;
  state.leadIdx = -1;
  state.status = 'betting';
  state.phaseDeadline = Date.now() + Math.max(3, Number(cfg.betSec)) * 1000;

  pushFeed(ctx, { type: 'round', roundNo: state.roundNo, pool: state.pool });
  pushFx(ctx, { type: 'roundOpen', roundNo: state.roundNo });
  emit.state();
  ctx.setTimer('phase', () => startRace(ctx), Math.max(3, Number(cfg.betSec)) * 1000);

  // 开局口播（异步，不阻塞流程）
  BC(ctx).speak('roundOpen', {
    round: state.roundNo,
    baseBet: cfg.baseBet,
    pool: state.pool,
    carry: state.carry,
    horses: state.horses.map(h => ({ no: h.no, name: h.name, odds: oddsOf(ctx, h.no - 1), bettors: 0 })),
  });
}

function startRace(ctx) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'betting') return;
  ctx.clearTimers('phase');
  state.status = 'racing';
  state.raceStartAt = Date.now();
  state.phaseDeadline = Date.now() + Math.max(5, Number(cfg.raceSec)) * 1000;

  // 基础速度：平均约 raceSec*0.9 秒跑完 100 格，再按随机系数拉开差距
  const base = 100 / (Math.max(5, Number(cfg.raceSec)) * 0.9);
  const mults = state.horses.map(() => 0.86 + Math.random() * 0.30);
  const avg = mults.reduce((a, b) => a + b, 0) / mults.length;
  state.horses.forEach((h, i) => {
    h.pos = 0;
    h.speed = base * (mults[i] / avg);
    h.burstUntil = 0;
    h.boostCells = 0;
    h.giftCells = 0;
    h.likes = 0;
    h.finishAt = 0;
    h.rank = 0;
    // 下注期点赞/送礼预约的加速格：开赛时一次性注入（计入各自上限口径）
    const pg = state.pendingGift[i] || 0;
    const pl = state.pendingLike[i] || 0;
    if (pg > 0) { h.giftCells = pg; h.pos = Math.min(99, h.pos + pg); }
    if (pl > 0) { h.boostCells = pl; h.pos = Math.min(99, h.pos + pl); }
  });
  state.leadIdx = -1;

  pushFeed(ctx, { type: 'raceStart' });
  pushFx(ctx, { type: 'gate' });
  emit.state();

  ctx.setTimer('phase', () => settle(ctx, 'timeout'), Math.max(5, Number(cfg.raceSec)) * 1000);
  scheduleTick(ctx);

  BC(ctx).speak('raceStart', {
    pool: state.pool,
    bets: totalBetCount(state),
    likesPerBoost: cfg.likesPerBoost,
    horses: state.horses.map(h => ({ no: h.no, name: h.name, odds: oddsOf(ctx, h.no - 1), bettors: h.bettors, pos: h.pos })),
  });
}

function scheduleTick(ctx) {
  ctx.setTimer('tick', () => {
    tick(ctx);
    if (ctx.state.status === 'racing') scheduleTick(ctx);
  }, TICK_MS);
}

function tick(ctx) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'racing') return;
  const now = Date.now();
  const dt = TICK_MS / 1000;
  const rubber = clamp(Number(cfg.rubberBand) || 0, 0, 1.5);
  const avgPos = state.horses.reduce((a, h) => a + h.pos, 0) / Math.max(1, state.horses.length);

  // 随机冲刺事件（每局期望 surgePerRace 次；同一时刻只允许一匹马在冲刺）
  const surging = state.horses.some(h => h.burstUntil > now);
  const perTick = (Number(cfg.surgePerRace) || 0) / Math.max(1, (Number(cfg.raceSec) * 1000) / TICK_MS);
  if (!surging && Math.random() < perTick && state.horses.length) {
    const h = pick(state.horses);
    h.burstUntil = now + 1200 + Math.random() * 1000;
    pushFeed(ctx, { type: 'surge', horse: h.no, name: h.name });
    pushFx(ctx, { type: 'surge', horse: h.no, name: h.name, color: h.color });
    const lead = leaderIdx(state);
    BC(ctx).speak('surge', {
      horse: { no: h.no, name: h.name, pos: h.pos },
      leadName: state.horses[lead] ? state.horses[lead].name : '',
      leadPos: state.horses[lead] ? state.horses[lead].pos : 0,
    });
  }

  let finished = -1;
  for (const h of state.horses) {
    const burst = h.burstUntil > now ? 2.2 : 1;
    const rb = 1 + clamp((avgPos - h.pos) / 100, -0.12, 0.25) * rubber;
    h.pos += h.speed * dt * burst * rb;
    if (h.pos >= 100 && !h.finishAt) { h.pos = 100; h.finishAt = now; }
    if (h.finishAt && finished < 0) finished = state.horses.indexOf(h);
  }

  // 领先易主检测（跑过 15% 之后才播报，避免开局乱报）
  const lead = leaderIdx(state);
  if (lead >= 0 && lead !== state.leadIdx) {
    const prev = state.leadIdx;
    state.leadIdx = lead;
    if (prev >= 0 && state.horses[lead].pos > 15) {
      pushFx(ctx, { type: 'lead', horse: state.horses[lead].no, name: state.horses[lead].name, color: state.horses[lead].color });
      BC(ctx).speak('leadChange', {
        horse: { no: state.horses[lead].no, name: state.horses[lead].name, pos: state.horses[lead].pos },
        prevName: state.horses[prev].name,
        prevPos: state.horses[prev].pos,
      });
    }
  }

  emit.state();

  if (finished >= 0) settle(ctx, 'finish', finished);
}

/** 当前头马下标：已冲线的按冲线先后排前（先到先得），未冲线的按位置 */
function leaderIdx(state) {
  let best = -1, bp = -Infinity;
  const t0 = state.raceStartAt || Date.now();
  state.horses.forEach((h, i) => {
    const key = h.finishAt ? 1000 - (h.finishAt - t0) / 1000 : h.pos;
    if (key > bp) { bp = key; best = i; }
  });
  return best;
}

async function settle(ctx, reason, forceIdx = -1) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'racing') return;
  ctx.clearTimers('tick');
  ctx.clearTimers('phase');

  const winnerIdx = forceIdx >= 0 ? forceIdx : leaderIdx(state);
  const w = state.horses[winnerIdx];
  if (!w) { state.status = 'idle'; emit.state(); return; }
  if (!w.finishAt) w.finishAt = Date.now();
  w.rank = 1;

  // 按展示赔率（1 位小数）派彩，保证与展示屏/战报显示的赔率完全一致
  const finalOdds = Math.round(oddsOf(ctx, winnerIdx) * 10) / 10;
  const pool = state.totalStaked + state.carry;

  // 汇总每位押中者的注额
  const byUser = new Map(); // userId -> {name, avatar, amount}
  for (const b of state.bets) {
    if (b.horse !== winnerIdx) continue;
    const cur = byUser.get(b.userId) || { name: b.name, avatar: b.avatar, amount: 0 };
    cur.amount += b.amount;
    byUser.set(b.userId, cur);
  }

  const winners = [];
  let payout = 0;
  let jackpot = false;
  if (byUser.size === 0) {
    jackpot = !!cfg.jackpotEnabled;
  } else {
    for (const [uid, v] of byUser) {
      const win = Math.round(v.amount * finalOdds);
      payout += win;
      const rec = getWallet(ctx).ensure(uid, v.name, v.avatar, cfg.startChips);
      getWallet(ctx).add(uid, win);
      rec.payout += win;
      rec.wins += 1;
      winners.push({ userId: uid, name: v.name, avatar: v.avatar, stake: v.amount, payout: win });
      ctx.award({ user: v.name, userId: uid, avatar: v.avatar }, Number(cfg.honorScore) || 0);
    }
    winners.sort((a, b) => b.payout - a.payout);
  }
  getWallet(ctx).save();

  // 输家记录参与（用于「沉没成本」提示，不影响荣誉分）
  for (const [uid, m] of state.betByUser) {
    const rec = getWallet(ctx).get(uid);
    if (rec) rec.rounds += 1;
  }

  const boostSaved = w.boostCells + w.giftCells;
  const favIdx = (() => {
    let bi = 0;
    state.horses.forEach((h, i) => { if (h.bet > state.horses[bi].bet) bi = i; });
    return bi;
  })();
  const secondPos = state.horses.filter((_, i) => i !== winnerIdx).reduce((a, h) => Math.max(a, h.pos), 0);
  const margin = Math.max(1, Math.round(100 - secondPos));

  // 头奖滚存：无人押中 → 整个彩池滚到下一局
  state.carry = jackpot ? pool : 0;

  const reportData = {
    winner: { no: w.no, name: w.name },
    odds: finalOdds,
    pool,
    winnerCount: winners.length,
    payout,
    best: winners[0] ? { name: winners[0].name, payout: winners[0].payout } : null,
    wasFavorite: favIdx === winnerIdx,
    margin,
    boostSaved: boostSaved >= 3 ? Math.round(boostSaved) : 0,
    jackpot,
  };

  // 战报：先生成一次文本（结算卡要显示），再交给播报中心朗读（不重复调大模型）
  const report = await BC(ctx).generate('finish', reportData);
  state.result = {
    roundNo: state.roundNo,
    winnerIdx,
    winner: { no: w.no, name: w.name, color: w.color },
    odds: Math.round(finalOdds * 10) / 10,
    pool,
    payout,
    winners: winners.slice(0, 12),
    winnerCount: winners.length,
    jackpot,
    carry: state.carry,
    boostCells: Math.round(boostSaved),
    margin,
    report,
    reason,
    standings: state.horses.map(h => ({ no: h.no, name: h.name, color: h.color, pos: Math.round(h.pos), bet: h.bet, odds: Math.round(oddsOf(ctx, h.no - 1) * 10) / 10 })),
  };
  state.status = 'result';
  state.phaseDeadline = Date.now() + Math.max(3, Number(cfg.resultSec)) * 1000;

  pushFeed(ctx, { type: 'result', horse: w.no, name: w.name, odds: state.result.odds, jackpot });
  pushFx(ctx, { type: 'finish', horse: w.no, name: w.name, color: w.color, jackpot, pool });
  if (margin <= 3) pushFx(ctx, { type: 'photoFinish', horse: w.no, name: w.name, color: w.color, margin, secondPos });
  if (jackpot) pushFx(ctx, { type: 'jackpot', pool, carry: state.carry });

  state.history.unshift({
    roundNo: state.roundNo,
    winner: `${w.no}号${w.name}`,
    odds: state.result.odds,
    pool,
    winnerCount: winners.length,
    jackpot,
    report,
    ts: Date.now(),
  });
  if (state.history.length > 30) state.history.pop();

  emit.state();
  if (report) BC(ctx).push('finish', report);
  if (jackpot) BC(ctx).speak('jackpot', { round: state.roundNo, pool, carry: state.carry });

  ctx.log('INFO', `[race #${state.roundNo}] ${w.no}号${w.name} 获胜 ×${state.result.odds} · 彩池 ${pool} · 押中 ${winners.length} 人 · 派彩 ${payout}${jackpot ? ' · 头奖滚存' : ''}`);

  if (cfg.autoLoop) ctx.setTimer('next', () => startRound(ctx), Math.max(3, Number(cfg.resultSec)) * 1000);
}

/* ═══════════════ 弹幕解析 ═══════════════ */

/**
 * 解析下注弹幕 → { horse: 0起始下标, count: 注数 }；非下注弹幕返回 null（不消费）
 * 支持：1 / 押2 / 买3号 / 4号 / 压1匹 / "3 2"（后一个数字=注数 或 筹码额）
 */
function parseBet(text, cfg) {
  const t = String(text || '').trim();
  if (!t) return null;
  const maxH = clamp(parseInt(cfg.horseCount, 10) || 4, 2, 6);
  const maxN = Math.max(1, parseInt(cfg.maxBetsPerRound, 10) || 5);
  const base = Math.max(1, parseInt(cfg.baseBet, 10) || 100);

  let m = t.match(/^(?:押|压|买|买定|下注|投|选|赌|压注)\s*([1-8])\s*(?:号|匹|马)?$/);
  if (!m) m = t.match(/^([1-8])\s*(?:号|匹|马)$/);
  if (!m) m = t.match(/^([1-8])$/);
  if (m) {
    const num = parseInt(m[1], 10);
    if (num > maxH) return { horse: -1, count: 1, outOfRange: true, num };  // 提示「只有 N 匹马」
    return { horse: num - 1, count: 1 };
  }
  // "3 2" / "押3 200"：第二个数字为注数（≤上限）或筹码额（baseBet 的整数倍）
  const m2 = t.match(/^(?:押|压|买|下注|投|选)?\s*([1-8])\s+(\d{1,6})$/);
  if (m2) {
    const num = parseInt(m2[1], 10);
    if (num > maxH) return { horse: -1, count: 1, outOfRange: true, num };
    const n2 = parseInt(m2[2], 10);
    let count = 0;
    if (n2 >= 1 && n2 <= maxN) count = n2;
    else if (n2 % base === 0) count = Math.min(maxN, n2 / base);
    if (count < 1) return null;
    return { horse: num - 1, count };
  }
  return null;
}

/* ═══════════════ 下注 ═══════════════ */

function placeBet(ctx, msg, horseIdx, count) {
  const { state, cfg, emit } = ctx;
  const name = (msg.user && msg.user.name) || '匿名';
  const uid = (msg.user && (msg.user.id || msg.user.displayId)) || (msg.user && msg.user.name) || 'anon';
  const avatar = (msg.user && msg.user.avatar) || '';

  if (state.status !== 'betting') {
    emit.notice(state.status === 'racing' ? `比赛进行中，${name} 请点赞为自己押的马加速` : `本局下注未开始，${name} 稍等一下`);
    return;
  }

  // 限流
  const now = Date.now();
  const last = state.lastBetAt.get(uid) || 0;
  if (now - last < Number(cfg.rateLimitSec) * 1000) {
    emit.notice(`「${name}」操作太频繁，${cfg.rateLimitSec}s 后再试`);
    return;
  }
  // 注数上限（注意：不能用 Math.max(1, …) 兜底，否则下满后每次还能再买 1 注）
  const used = state.betCountByUser.get(uid) || 0;
  const room = Number(cfg.maxBetsPerRound) - used;
  if (room <= 0) { emit.notice(`「${name}」本局已下满 ${cfg.maxBetsPerRound} 注`); return; }
  let n = Math.max(1, Math.min(count, room));

  const wallet = getWallet(ctx);
  const rec = wallet.ensure(uid, name, avatar, cfg.startChips);
  let amount = n * Number(cfg.baseBet);

  // 余额不足：先发救济金（每局一次），再按「余额能买几注」下调注数（不强迫 all-in）
  if (rec.chips < amount) {
    const got = Number(cfg.bailoutChips) > 0 ? wallet.grantBailout(uid, state.roundNo, cfg.bailoutChips) : 0;
    if (got > 0) {
      pushFeed(ctx, { type: 'bailout', user: name, avatar, amount: got });
      pushFx(ctx, { type: 'bailout', user: name, avatar, amount: got });
    }
    const afford = Math.floor(rec.chips / Number(cfg.baseBet));
    if (afford < 1) {
      emit.notice(`「${name}」筹码不足（余额 ${rec.chips}），关注主播可领筹码`);
      return;
    }
    n = Math.min(n, afford);
    amount = n * Number(cfg.baseBet);
  }

  wallet.add(uid, -amount);
  rec.staked += amount;
  wallet.saveSoon();

  const h = state.horses[horseIdx];
  h.bet += amount;
  h.bettors += 1;
  state.totalStaked += amount;
  state.pool = state.totalStaked + state.carry;
  state.bets.push({ userId: uid, name, avatar, horse: horseIdx, count: n, amount, ts: now });
  state.lastBetAt.set(uid, now);
  state.betCountByUser.set(uid, used + n);
  let m = state.betByUser.get(uid);
  if (!m) { m = new Map(); state.betByUser.set(uid, m); }
  m.set(horseIdx, (m.get(horseIdx) || 0) + amount);

  pushFeed(ctx, { type: 'bet', user: name, avatar, horse: h.no, name2: h.name, count: n, amount, odds: Math.round(oddsOf(ctx, horseIdx) * 10) / 10 });
  pushFx(ctx, { type: 'bet', horse: h.no, color: h.color, user: name, avatar, amount, odds: Math.round(oddsOf(ctx, horseIdx) * 10) / 10 });
  ctx.log('INFO', `[race #${state.roundNo}] ${name} 押 ${h.no}号${h.name} ${n} 注 / ${amount} 筹码（余额 ${rec.chips}）`);
  emit.state();
}

/* ═══════════════ 点赞 → 助威加速 ═══════════════ */

function handleLike(ctx, msg) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'racing' && state.status !== 'betting') return;
  const uid = (msg.user && (msg.user.id || msg.user.displayId)) || (msg.user && msg.user.name) || 'anon';
  const name = (msg.user && msg.user.name) || '匿名';
  const avatar = (msg.user && msg.user.avatar) || '';
  const inc = Math.max(1, parseInt(msg.likeCount, 10) || 1);

  let rec = state.cheerByUser.get(uid);
  if (!rec) { rec = { name, avatar, likes: 0, boosted: 0 }; state.cheerByUser.set(uid, rec); }
  rec.name = name;
  if (avatar) rec.avatar = avatar;
  rec.likes += inc;

  const horseIdx = mainHorseOf(ctx, uid);
  if (horseIdx < 0) return;                      // 未下注：点赞不计（引导下注）
  const h = state.horses[horseIdx];
  if (!h) return;
  h.likes += inc;
  if (state.horseLikes) state.horseLikes[horseIdx] = (state.horseLikes[horseIdx] || 0) + inc;

  // 冲刺期：点赞效率翻倍（最后 N 秒）
  const remain = (state.phaseDeadline - Date.now()) / 1000;
  const sprint = state.status === 'racing' && remain <= Number(cfg.finalSprintSec) && Number(cfg.finalSprintSec) > 0;
  const perBoost = Math.max(1, Math.round(Number(cfg.likesPerBoost) / (sprint ? Math.max(1, Number(cfg.finalSprintMult)) : 1)));
  const want = Math.floor(rec.likes / perBoost);
  let grant = want - rec.boosted;
  if (grant <= 0) { emit.state(); return; }

  // 单马每局助威上限
  const cap = Math.max(0, Number(cfg.maxBoostCells));
  if (h.boostCells + grant > cap) grant = Math.max(0, cap - h.boostCells);
  if (grant <= 0) { emit.state(); return; }

  rec.boosted += grant;
  h.boostCells += grant;
  if (state.status === 'racing') h.pos = Math.min(100, h.pos + grant);
  else state.pendingLike[horseIdx] = (state.pendingLike[horseIdx] || 0) + grant;

  pushFeed(ctx, { type: 'boost', user: name, avatar, horse: h.no, name2: h.name, likes: rec.likes, cells: grant, sprint });
  pushFx(ctx, { type: 'boost', horse: h.no, color: h.color, user: name, avatar, cells: grant, likes: rec.likes, sprint });

  // 助威效果显著（把马顶到领先）时点名播报（播报中心按 minGapSec 限流）
  const lead = leaderIdx(state);
  if (state.status === 'racing' && lead === horseIdx && grant >= 2) {
    BC(ctx).speak('cheer', { name, likes: rec.likes, horse: { no: h.no, name: h.name, pos: h.pos } });
  }

  // ── 点赞风暴（全屏炸裂特效）：冲刺期 3 秒内 ≥3 次点赞加速，且 15 秒冷却 ──
  // 让观众直观看到「别人点赞触发全屏风暴」→ 跟着点，是提升点赞欲的核心视觉钩子
  if (state.status === 'racing' && sprint) {
    const nowMs = Date.now();
    state.boostStamp = state.boostStamp.concat(nowMs).slice(-8);
    const winCnt = state.boostStamp.filter(t => nowMs - t <= 3000).length;
    if (winCnt >= 3 && nowMs - (state.likeStormAt || 0) > 15000) {
      state.likeStormAt = nowMs;
      pushFx(ctx, { type: 'likeStorm', horse: h.no, name2: h.name, user: name, cells: grant, likes: rec.likes });
      BC(ctx).speak('likeStorm', { name, likes: rec.likes, horse: { no: h.no, name: h.name, pos: h.pos } });
    }
  }
  emit.state();
}

/* ═══════════════ 礼物 → 骑士冲锋 ═══════════════ */

function handleGift(ctx, msg) {
  const { state, cfg, emit } = ctx;
  const uid = (msg.user && (msg.user.id || msg.user.displayId)) || (msg.user && msg.user.name) || 'anon';
  const name = (msg.user && msg.user.name) || '匿名';
  const avatar = (msg.user && msg.user.avatar) || '';
  const giftName = msg.giftName || '礼物';

  state.giftList.unshift({ user: name, avatar, giftName, count: msg.giftCount || 1, ts: Date.now() });
  if (state.giftList.length > 8) state.giftList.pop();
  pushFeed(ctx, { type: 'gift', user: name, avatar, giftName });

  if (!cfg.giftBoostEnabled) { emit.state(); return; }
  if (state.status !== 'racing' && state.status !== 'betting') return;
  const horseIdx = mainHorseOf(ctx, uid);
  if (horseIdx < 0) { emit.state(); return; }
  const h = state.horses[horseIdx];
  if (!h) return;
  const cells = Math.max(0, Number(cfg.giftBoostCells));
  if (cells <= 0) return;
  const cap = Math.max(0, Number(cfg.giftMaxCellsPerHorse));
  let grant = cells;
  if (h.giftCells + grant > cap) grant = Math.max(0, cap - h.giftCells);
  if (grant <= 0) { emit.state(); return; }

  h.giftCells += grant;
  if (state.status === 'racing') h.pos = Math.min(100, h.pos + grant);
  else state.pendingGift[horseIdx] = (state.pendingGift[horseIdx] || 0) + grant;

  pushFx(ctx, { type: 'gift', horse: h.no, color: h.color, user: name, avatar, giftName, cells: grant });
  BC(ctx).speak('gift', { name, giftName, cells: grant, horse: { no: h.no, name: h.name, pos: h.pos } });
  emit.state();
}

/* ═══════════════ 进场 / 关注 ═══════════════ */

/** 进场即开户（赠送起始筹码，让新观众零门槛参与） */
function handleEnter(ctx, msg) {
  const { cfg } = ctx;
  const uid = (msg.user && (msg.user.id || msg.user.displayId)) || (msg.user && msg.user.name) || 'anon';
  const name = (msg.user && msg.user.name) || '匿名';
  const avatar = (msg.user && msg.user.avatar) || '';
  getWallet(ctx).ensure(uid, name, avatar, cfg.startChips);
}

/** 关注主播 → 赠送筹码（同人按冷却只送一次） */
function handleFollow(ctx, msg) {
  const { state, cfg, emit } = ctx;
  const uid = (msg.user && (msg.user.id || msg.user.displayId)) || (msg.user && msg.user.name) || 'anon';
  const name = (msg.user && msg.user.name) || '匿名';
  const avatar = (msg.user && msg.user.avatar) || '';
  const bonus = Math.max(0, Number(cfg.followBonusChips));
  if (bonus <= 0) return;

  loadFollowCd();
  const hours = Math.max(1, Number(cfg.followCooldownHours) || 21);
  const cdMs = hours * 3600 * 1000;
  const now = Date.now();
  const last = followCd.get(uid) || 0;
  if (now - last < cdMs) {
    ctx.log('INFO', `[race] 「${name}」关注在 ${hours}h 冷却内，不重复赠送`);
    return;
  }
  followCd.set(uid, now);
  saveFollowCd();

  const rec = getWallet(ctx).ensure(uid, name, avatar, cfg.startChips);
  getWallet(ctx).add(uid, bonus);
  getWallet(ctx).save();
  pushFeed(ctx, { type: 'follow', user: name, avatar, amount: bonus });
  pushFx(ctx, { type: 'follow', user: name, avatar, amount: bonus });
  ctx.log('INFO', `[race] 「${name}」关注主播 +${bonus} 筹码（余额 ${rec.chips}）`);
  emit.state();
}

/* ═══════════════ 弹幕入口 ═══════════════ */

function handleDanmu(ctx, msg) {
  if (!msg || msg.event !== 'chat' || !msg.text) return false;
  const { cfg } = ctx;
  if (cfg.allowedRoomId && msg.roomId) {
    const allowed = String(cfg.allowedRoomId).split(/[,，\s]+/).filter(Boolean);
    if (allowed.length && !allowed.includes(String(msg.roomId))) return false;
  }
  const maxH = clamp(parseInt(cfg.horseCount, 10) || 4, 2, 6);
  const raw = String(msg.text).trim();
  const parsed = parseBet(raw, cfg);
  if (!parsed) return false;   // 非下注弹幕 → 不消费（交给其它游戏/忽略）
  if (parsed.outOfRange) {
    ctx.emit.notice(`「${(msg.user && msg.user.name) || '匿名'}」本局只有 ${maxH} 匹马参赛，请发 1-${maxH}`);
    return true;
  }
  placeBet(ctx, msg, parsed.horse, parsed.count);
  return true;
}

/* ═══════════════ 控制指令 ═══════════════ */

function handleAction(ctx, action, payload = {}) {
  const { state, cfg, emit } = ctx;
  switch (action) {
    case 'start':
    case 'next':
      if (state.status === 'betting' || state.status === 'racing') return { ok: false, msg: '本局正在进行中' };
      startRound(ctx);
      return { ok: true, msg: `第 ${state.roundNo} 局开始下注（${cfg.betSec}s）` };

    case 'skipBet':
      if (state.status !== 'betting') return { ok: false, msg: '当前不在下注期' };
      startRace(ctx);
      return { ok: true, msg: '已跳过下注期，立即开赛' };

    case 'pause':
      if (state.status !== 'betting' && state.status !== 'racing') return { ok: false, msg: '当前阶段无法暂停' };
      state.pausedStatus = state.status;
      state.pausedRemain = Math.max(0, state.phaseDeadline - Date.now());
      ctx.clearTimers();
      state.status = 'paused';
      emit.state();
      return { ok: true, msg: `已暂停（剩余 ${Math.ceil(state.pausedRemain / 1000)}s 冻结）` };

    case 'resume':
      if (state.status !== 'paused') return { ok: false, msg: '当前未暂停' };
      state.status = state.pausedStatus || 'betting';
      state.pausedStatus = null;
      const remain = Math.max(1000, state.pausedRemain || 0);
      state.phaseDeadline = Date.now() + remain;
      emit.state();
      if (state.status === 'betting') ctx.setTimer('phase', () => startRace(ctx), remain);
      else {
        ctx.setTimer('phase', () => settle(ctx, 'timeout'), remain);
        scheduleTick(ctx);
      }
      return { ok: true, msg: '已继续' };

    case 'end': {
      // 结束并退还本局全部注额（避免观众筹码凭空消失）
      let refund = 0;
      const wallet = getWallet(ctx);
      for (const b of state.bets) {
        const rec = wallet.get(b.userId);
        if (rec) { rec.chips += b.amount; refund += b.amount; }
      }
      wallet.save();
      ctx.clearTimers();
      state.status = 'idle';
      state.result = null;
      state.pausedStatus = null;
      if (refund > 0) pushFeed(ctx, { type: 'refund', amount: refund });
      emit.state();
      return { ok: true, msg: refund > 0 ? `已结束，退还本局注额 ${refund} 筹码` : '已结束' };
    }

    case 'resetWallet': {
      // 主播台一键重置筹码（谨慎操作）：全部钱包回到起始筹码
      const wallet = getWallet(ctx);
      for (const [, rec] of wallet.map) rec.chips = Math.round(Number(cfg.startChips) || 1000);
      wallet.save();
      emit.state();
      return { ok: true, msg: `已把所有观众筹码重置为 ${cfg.startChips}` };
    }

    case 'walletQuery': {
      const kw = String(payload.name || '').trim();
      if (!kw) return { ok: false, msg: '请输入要查询的昵称' };
      const list = getWallet(ctx).search(kw, 8);
      if (!list.length) return { ok: false, msg: `没有找到包含「${kw}」的观众` };
      return { ok: true, msg: `找到 ${list.length} 位`, state: { walletQuery: list } };
    }

    case 'walletAdjust': {
      const uid = String(payload.uid || '').trim();
      const delta = parseInt(payload.delta, 10);
      if (!uid) return { ok: false, msg: '缺少观众 uid' };
      if (!Number.isFinite(delta) || delta === 0) return { ok: false, msg: '调账数额无效' };
      const wallet = getWallet(ctx);
      let rec = wallet.get(uid);
      if (!rec) return { ok: false, msg: '该观众还没有钱包（先让 TA 下注或进场）' };
      wallet.add(uid, delta);
      wallet.save();
      emit.state();
      return { ok: true, msg: `已为「${rec.name}」${delta > 0 ? '+' : ''}${delta} 筹码（余额 ${rec.chips}）` };
    }

    case 'simulateBet': {
      const horse = parseInt(payload.horse, 10) - 1;
      if (!(horse >= 0 && horse < state.horses.length)) return { ok: false, msg: '马号超出范围' };
      if (state.status !== 'betting') return { ok: false, msg: '当前不在下注期' };
      const name = String(payload.name || '模拟观众').trim() || '模拟观众';
      const sid = 'sim_' + name;
      placeBet(ctx, {
        event: 'chat',
        user: { id: sid, displayId: sid, name, avatar: '' },
        text: String(horse + 1),
        roomId: '',
      }, horse, Math.max(1, parseInt(payload.count, 10) || 1));
      return { ok: true, msg: `已模拟「${name}」押 ${horse + 1} 号` };
    }

    case 'broadcast':
      // 手动触发时若未带数据，用当前局面快照兜底（避免模板渲染出 undefined）
      return BC(ctx).control({ ...payload, data: { ...bcSnapshot(ctx), ...(payload.data || {}) } });

    case 'config': {
      const allowed = [
        'betSec', 'raceSec', 'resultSec', 'autoLoop',
        'baseBet', 'maxBetsPerRound', 'rateLimitSec', 'horseCount',
        'startChips', 'bailoutChips',
        'minOdds', 'maxOdds',
        'likesPerBoost', 'maxBoostCells', 'finalSprintSec', 'finalSprintMult',
        'giftBoostEnabled', 'giftBoostCells', 'giftMaxCellsPerHorse',
        'followBonusChips', 'followCooldownHours',
        'surgePerRace', 'rubberBand', 'jackpotEnabled', 'honorScore', 'fxLevel',
        'allowedRoomId',
        ...BC_CFG_KEYS,
      ];
      for (const k of allowed) if (payload[k] !== undefined) cfg[k] = payload[k];
      BC(ctx).collectConfig(cfg, payload);
      ctx.persistConfig(cfg);
      emit.state();
      return { ok: true, msg: '配置已更新' };
    }

    case 'setRoomFilter': {
      cfg.allowedRoomId = String(payload.roomId || '').trim();
      ctx.persistConfig(cfg);
      emit.state();
      return { ok: true, msg: '直播间筛选已更新' };
    }

    default:
      return { ok: false, msg: `未知动作: ${action}` };
  }
}

/* ═══════════════ 对外状态 ═══════════════ */

function publicState(ctx) {
  const { state, cfg } = ctx;
  const wallet = getWallet(ctx);
  const phaseSec = state.status === 'betting' ? cfg.betSec
    : state.status === 'racing' ? cfg.raceSec
      : state.status === 'result' ? cfg.resultSec : 0;
  const now = Date.now();
  const remain = state.phaseDeadline ? Math.max(0, (state.phaseDeadline - now) / 1000) : 0;
  const sprint = state.status === 'racing' && Number(cfg.finalSprintSec) > 0 && remain <= Number(cfg.finalSprintSec);

  return {
    status: state.status,
    roundNo: state.roundNo,
    phaseDeadline: state.phaseDeadline,
    phaseSec: Number(phaseSec),
    remainSec: Math.round(remain * 10) / 10,
    finalSprint: sprint,
    horses: state.horses.map((h, i) => ({
      no: h.no, name: h.name, color: h.color, emoji: h.emoji,
      bet: h.bet, bettors: h.bettors,
      odds: Math.round(oddsOf(ctx, i) * 10) / 10,
      heat: state.totalStaked > 0 ? Math.round((h.bet / state.totalStaked) * 100) : 0,
      pos: Math.round(Math.min(100, h.pos) * 10) / 10,
      burst: h.burstUntil > now,
      boostCells: Math.round(h.boostCells),
      giftCells: Math.round(h.giftCells),
      likes: h.likes,
      finished: !!h.finishAt,
    })),
    pool: state.pool,
    carry: state.carry,
    totalStaked: state.totalStaked,
    betCount: totalBetCount(state),
    bettors: state.betByUser.size,
    // 助威榜：点赞最多的前 5 位（含其所押的马）
    cheerTop: [...state.cheerByUser.entries()]
      .map(([uid, r]) => ({ uid, name: r.name, avatar: r.avatar, likes: r.likes, horse: mainHorseOf(ctx, uid) + 1 }))
      .filter(r => r.horse > 0)
      .sort((a, b) => b.likes - a.likes)
      .slice(0, 5),
    giftList: state.giftList.slice(0, 6),
    feed: state.feed.slice(-12),
    fx: state.fx.slice(-10),
    fxSeq: state.fxSeq,
    result: state.result,
    history: state.history.slice(0, 12),
    walletTop: wallet.top(6),
    leaderboard: ctx.topList(6),
    giftIcons: GIFT_ICONS.filter(g => g.cost <= 1).slice(0, 6),
    cfg: {
      betSec: cfg.betSec, raceSec: cfg.raceSec, resultSec: cfg.resultSec, autoLoop: cfg.autoLoop,
      baseBet: cfg.baseBet, maxBetsPerRound: cfg.maxBetsPerRound, rateLimitSec: cfg.rateLimitSec,
      horseCount: cfg.horseCount, startChips: cfg.startChips, bailoutChips: cfg.bailoutChips,
      minOdds: cfg.minOdds, maxOdds: cfg.maxOdds,
      likesPerBoost: cfg.likesPerBoost, maxBoostCells: cfg.maxBoostCells,
      finalSprintSec: cfg.finalSprintSec, finalSprintMult: cfg.finalSprintMult,
      giftBoostEnabled: cfg.giftBoostEnabled, giftBoostCells: cfg.giftBoostCells,
      giftMaxCellsPerHorse: cfg.giftMaxCellsPerHorse,
      followBonusChips: cfg.followBonusChips, followCooldownHours: cfg.followCooldownHours,
      surgePerRace: cfg.surgePerRace, rubberBand: cfg.rubberBand,
      jackpotEnabled: cfg.jackpotEnabled, honorScore: cfg.honorScore,
      fxLevel: cfg.fxLevel, allowedRoomId: cfg.allowedRoomId || '',
    },
    ...BC(ctx).publicState(),
  };
}

function clearGameTimers(ctx, group) {
  ctx.clearTimers(group);
}

module.exports = {
  MANIFEST, CFG_DEFAULTS, CONFIG_SCHEMA,
  createState, handleDanmu, handleLike, handleGift, handleEnter, handleFollow,
  handleAction, publicState, clearGameTimers,
};
