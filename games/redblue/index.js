/**
 * ============================================================================
 * games/redblue/index.js — 红蓝大作战（弹幕拔河 · 阵营对抗）游戏模块
 * ============================================================================
 * 【玩法】（方案：docs/新玩法调研与红蓝大作战方案.md · 进度：docs/redblue-开发进度.md）
 *   组队期：观众弹幕发「红/蓝」（兼容 1/2、红队/蓝队）加入阵营，可换队
 *   对抗期：每条带「红/蓝」的弹幕把战线向对方推 1 格（限频）；已入队观众的
 *           点赞为队伍能量槽充能，充满触发「全军冲锋」一次性推进 surgePush 格
 *   胜负：  战线推到胜负线立即分胜负；倒计时耗尽按战线位置判定（正中=平局）
 *   计分：  胜方全员 winScore + battle_wins 胜场；败方 loseScore 参与奖（不计胜场）；
 *           胜队贡献 Top3 额外 MVP 分（均计入全局共享排行榜）
 *   平衡：  背水一战（落后达阈值一方拉动加成）+ 主播手动双方系数微调
 *
 * 【接口】与 guess/chengyu/quiz 一致的插件契约：
 *   MANIFEST / CFG_DEFAULTS / CONFIG_SCHEMA / createState / handleDanmu /
 *   handleLike / handleGift / handleEnter / handleAction / publicState / clearGameTimers
 * ============================================================================
 */
'use strict';

const path = require('path');
const { createBroadcaster, BC_CFG_DEFAULTS, BC_CFG_KEYS } = require('../../common/broadcast'); // 通用 AI 播报中心
const REDBLUE_SLOTS = require('./slots'); // 播报点定义（结算战报）
const { Season } = require('./season');
const { createLogger } = require(path.join(__dirname, '..', '..', 'common', 'logger'));

// 赛季名册（P4）：data/redblue_season.json，跨场次延续
const seasonStore = new Season(
  path.join(__dirname, '..', '..', 'data', 'redblue_season.json'),
  createLogger(path.join(__dirname, '..', '..', 'log')).log,
);

/* ═══════════════ 注册信息 ═══════════════ */

const MANIFEST = {
  id: 'redblue',
  name: '红蓝大作战',
  icon: '⚔️',
  desc: '弹幕枪战 HP 对决 · 阵营拔河对抗 · 点赞充能全军冲锋 · PVE 守城共斗',
  // 运行中状态（宿主据此点亮主播台导航绿点）
  liveStatuses: ['joining', 'tugging', 'sieging', 'shooting'],
  // 全局排行榜计分字段（跨游戏共享 data/leaderboard.json）
  score: { wins: 'battle_wins', score: 'battle_score', floors: null },
};

/* ═══════════════ 配置 ═══════════════ */

const CFG_DEFAULTS = {
  joinSec: 15,               // 组队期时长（秒）
  tugSec: 120,               // 对抗期时长（秒）
  resultShowSec: 12,         // 结算展示时长（秒）
  autoNextRound: true,       // 结算后自动开新一轮
  rateLimitSec: 2,           // 同一观众拉动/入队最小间隔（秒）
  // ── 战线参数 ──
  winLine: 90,               // 胜负线（pos≥90 红胜；pos≤10 蓝胜）
  backwater: true,           // 背水一战（落后方拉动加成）
  backwaterGap: 12,          // 落后多少格触发背水加成
  backwaterMult: 1.3,        // 背水加成倍率
  redMult: 1.0,              // 红队推力系数（主播救场微调）
  blueMult: 1.0,             // 蓝队推力系数
  // ── 点赞充能 ──
  likesPerEnergy: 3,         // 多少次点赞 = 1 点能量
  surgeThreshold: 50,        // 能量满阈值（触发全军冲锋）
  surgePush: 12,             // 冲锋一次性推进格数
  likeCapPerEvent: 30,       // 单条点赞消息最多计入次数（防批量点赞瞬间充满）
  // ── 礼物召唤（需 DanmuDesk 登录抖音转发 gift；未登录自动无感） ──
  giftEnabled: false,
  giftPush: 3,               // 每件礼物推力（格）
  // ── 弹幕枪战（shooter 模式） ──
  shooterHp: 100,            // 每队初始血量（先清零者负）
  shooterTravelMs: 1400,     // 子弹横穿战场耗时（毫秒，客户端同公式算位置）
  giftBulletStrength: 6,     // 送礼强力子弹的血量/伤害（普通子弹=1）
  shooterBulletCap: 48,      // 场上子弹上限（超出丢最老的）
  shooterTickMs: 100,        // 服务端子弹模拟节拍（毫秒）
  // 自动火力：无人发弹幕时双方默认持续交火（同频同强度→互抵，血量不动，战场始终在打）
  autoFire: true,            // 是否启用自动火力（关掉后回到纯观众驱动）
  autoFireBaseMs: 1100,      // 自动射击基础间隔（毫秒/队）；点赞按加速值缩短间隔并提升弹速
  // ── 枪战打 BOSS（shooterBoss 模式）：双方共同射击中央 Boss，击杀=全员胜利 ──
  shooterBossHp: 300,        // Boss 血量
  bossAtkSec: 8,             // Boss 反击间隔（秒，打基地墙）
  bossAtk: 7,                // Boss 每次反击伤害
  // ── 计分 ──
  winScore: 80,              // 胜方全员得分
  loseScore: 20,             // 败方参与奖（不计胜场）
  mvpScores: '200,150,100',  // 胜队贡献 Top3 额外加分（逗号分隔）
  joinBonus: 0,              // 首次入队奖（默认关闭：0=不发，>0 每轮首次入队加分，不计胜场）
  // ── 阵营 ──
  teamRedName: '猛虎营',
  teamBlueName: '飞鲨营',
  enterHint: true,           // 观众进场播报引导参战（需宿主转发 enter）
  // ── 模式（tug=纯拔河 siege=纯守城 mixed=混合 shooter=弹幕枪战 HP 对决） ──
  mode: 'shooter',
  siegeEveryRounds: 3,       // mixed 模式下每 N 轮拔河插 1 轮守城
  // ── PVE 守城参数 ──
  monsterHp: 300,            // 怪物总血量（按直播间热度调整）
  monsterAtkSec: 8,          // 怪物攻城间隔（秒）
  monsterAtk: 7,             // 怪物每次攻城伤害
  wallHp: 100,               // 城墙总耐久
  siegeSurgeDamage: 20,      // 全力一击伤害（点赞能量满触发）
  siegeWinScore: 60,         // 守城成功：全体参战者得分（+胜场）
  siegeLoseScore: 10,        // 守城失败：全体参战者安慰分
  // ── AI 战报（已迁移到通用播报中心 common/broadcast，off/local/api + 密钥只存服务端） ──
  ...BC_CFG_DEFAULTS,
  allowedRoomId: '',
};

/* ═══════════════ 通用 AI 播报中心（common/broadcast） ═══════════════
   播报点定义在 ./slots.js；旧配置键 aiReport 首次使用时一次性迁移到 aiBroadcast。 */
function BC(ctx) {
  if (!ctx._bc) {
    const cfg = ctx.cfg || {};
    if (cfg.aiReport !== undefined) {            // 旧键迁移（一次性）
      cfg.aiBroadcast = cfg.aiReport;
      delete cfg.aiReport;
      if (typeof ctx.persistConfig === 'function') ctx.persistConfig(cfg);
    }
    ctx._bc = createBroadcaster({
      gameId: 'redblue', gameName: '红蓝大作战', slots: REDBLUE_SLOTS,
      getCfg: () => ctx.cfg,
      getState: () => ctx.state,
      emit: () => ctx.emit.state(),
      log: ctx.log,
    });
  }
  return ctx._bc;
}

const SIEGE_MONSTERS = ['史莱姆王', '暗影狼群', '深渊触手', '暗夜蝠王', '钢铁巨像', '幽冥鬼龙'];
const BOSS_NAMES = ['远古魔像', '深渊领主', '黑夜君王', '混沌巨兽', '星陨之灵'];

const CONFIG_SCHEMA = [
  { key: 'joinSec', label: '组队时长(秒)', type: 'number', min: 5, def: 15 },
  { key: 'tugSec', label: '对抗时长(秒)', type: 'number', min: 20, def: 120 },
  { key: 'resultShowSec', label: '结算停留(秒)', type: 'number', min: 3, def: 12 },
  { key: 'autoNextRound', label: '自动开新一轮', type: 'bool', def: true },
  { key: 'rateLimitSec', label: '拉动限频(秒)', type: 'number', min: 1, def: 2 },
  { key: 'winLine', label: '胜负线(%)', type: 'number', min: 60, max: 99, def: 90 },
  { key: 'likesPerEnergy', label: 'N 赞=1 能量', type: 'number', min: 1, def: 3 },
  { key: 'surgeThreshold', label: '冲锋阈值(能量)', type: 'number', min: 5, def: 50 },
  { key: 'surgePush', label: '冲锋推力(格)', type: 'number', min: 1, def: 12 },
  { key: 'backwater', label: '背水一战', type: 'bool', def: true },
  { key: 'backwaterGap', label: '背水落后格数', type: 'number', min: 1, def: 12 },
  { key: 'backwaterMult', label: '背水倍率', type: 'number', min: 1, max: 3, def: 1.3 },
  { key: 'giftEnabled', label: '礼物召唤', type: 'bool', def: false },
  { key: 'winScore', label: '胜方分', type: 'number', min: 1, def: 80 },
  { key: 'loseScore', label: '败方分', type: 'number', min: 0, def: 20 },
  { key: 'mvpScores', label: 'MVP 分(1/2/3名)', type: 'text', def: '200,150,100' },
  { key: 'mode', label: '模式', type: 'select', options: [['shooter', '弹幕枪战(HP)'], ['shooterBoss', '枪战打BOSS'], ['tug', '纯拔河'], ['siege', '纯守城'], ['mixed', '混合']], def: 'shooter' },
  { key: 'siegeEveryRounds', label: '每N轮守城', type: 'number', min: 1, def: 3 },
  { key: 'shooterHp', label: '枪战初始血量', type: 'number', min: 20, def: 100 },
  { key: 'shooterTravelMs', label: '子弹飞行(毫秒)', type: 'number', min: 400, max: 4000, def: 1400 },
  { key: 'giftBulletStrength', label: '强力子弹血量', type: 'number', min: 2, def: 6 },
  { key: 'autoFire', label: '自动火力(无人也开火)', type: 'bool', def: true },
  { key: 'autoFireBaseMs', label: '自动射击间隔(毫秒)', type: 'number', min: 400, max: 4000, def: 1100 },
  { key: 'shooterBossHp', label: 'Boss血量', type: 'number', min: 50, def: 300 },
  { key: 'bossAtkSec', label: 'Boss反击间隔(秒)', type: 'number', min: 2, def: 8 },
  { key: 'bossAtk', label: 'Boss反击伤害', type: 'number', min: 1, def: 7 },
  { key: 'monsterHp', label: '怪物血量', type: 'number', min: 20, def: 300 },
  { key: 'monsterAtkSec', label: '怪物攻城间隔(秒)', type: 'number', min: 2, def: 8 },
  { key: 'monsterAtk', label: '怪物攻城伤害', type: 'number', min: 1, def: 7 },
  { key: 'wallHp', label: '城墙耐久', type: 'number', min: 20, def: 100 },
  { key: 'siegeSurgeDamage', label: '全力一击伤害', type: 'number', min: 5, def: 20 },
  { key: 'siegeWinScore', label: '守城成功分', type: 'number', min: 1, def: 60 },
  { key: 'siegeLoseScore', label: '守城失败分', type: 'number', min: 0, def: 10 },
];

/* ═══════════════ 状态 ═══════════════ */

function newTeam(name) {
  return {
    name,
    members: new Map(),   // userId → { name, avatar, pulls, likes, joinedAt }
    energy: 0,            // 能量槽（浮点累计）
    surges: 0,            // 本轮冲锋次数
  };
}

function createState() {
  return {
    status: 'idle',          // idle | joining | tugging | sieging | revealed | paused
    pausedFrom: null,        // 暂停前的状态（joining/tugging/sieging）
    roundNo: 0,
    mode: 'tug',             // 本轮模式：tug | siege
    pos: 50,                 // 战线位置：0=红方底线 100=蓝方底线，红推 +
    deadline: 0,             // 当前阶段截止时间戳
    teams: { red: newTeam('猛虎营'), blue: newTeam('飞鲨营') },
    // ── PVE 守城（sieging 期间有效） ──
    monster: null,           // { name, hp, hpMax }
    wall: null,              // { hp, hpMax }
    siegeEnergy: 0,          // 全场能量槽（点赞充能，满触发全力一击）
    surges: 0,               // 本轮冲锋/全力一击次数（两种模式共用计数展示）
    // ── 弹幕枪战（shooting 期间有效） ──
    shooter: null,           // { redHp, blueHp, bullets:[{id,side,strength,t0,frac}], blitz:{red,blue}, acc, fired, lastTick }
    boss: null,              // shooterBoss 模式：中央 Boss { name, hp, hpMax }（双方共同射击）
    bossAtkAt: 0,            // Boss 下次反击时间戳
    series: { red: 0, blue: 0 },     // 本场红蓝胜局
    streak: { team: null, n: 0 },    // 当前连胜（仅拔河轮）
    feed: [],                // 战报流 [{id,icon,text,hot,ts}]（新在后，最多 FEED_MAX）
    result: null,            // 结算 {mode,...}
    history: [],             // [{roundNo,mode,winner/success,ts}]
    lastActAt: new Map(),    // userId → 上次拉动/攻击/入队时间戳（限频）
    joinAwarded: new Set(),  // 本轮已发入队奖的 userId
  };
}

const FEED_MAX = 14;
let feedSeq = 0;
let bulletSeq = 0;

/* ═══════════════ 工具 ═══════════════ */

function userKey(msg) { return (msg.user && (msg.user.id || msg.user.displayId)) || msg.user?.name || '匿名'; }
function userName(msg) { return (msg.user && msg.user.name) || '匿名'; }
function userAvatar(msg) { return (msg.user && msg.user.avatar) || ''; }

function feed(ctx, icon, text, hot = false, extra = null) {
  const { state, emit } = ctx;
  const f = { id: `${Date.now()}_${++feedSeq}`, icon, text, hot, ts: Date.now(), ...(extra || {}) };
  state.feed.push(f);
  if (state.feed.length > FEED_MAX) state.feed.shift();
  // 增量推给展示屏战报流（stage 的 onGuess 消费；type 字段驱动拉动/冲锋特效）
  try { emit.guess({ kind: 'feed', ...f }); } catch {}
}

/** 高频事件（点赞/拉动）节流推送：最多 600ms 一次全量 state */
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

/** 房间过滤（与 quiz 一致）：配置了 allowedRoomId 时仅接收指定直播间 */
function roomAllowed(ctx, msg) {
  const allow = String(ctx.cfg.allowedRoomId || '').trim();
  if (!allow || !msg.roomId) return true;
  const set = allow.split(/[,，\s]+/).filter(Boolean);
  return set.includes(String(msg.roomId));
}

/** 队伍拉动系数 = 主播微调系数 × 背水加成 */
function pullMult(ctx, team) {
  const { cfg, state } = ctx;
  let m = Number(cfg[team === 'red' ? 'redMult' : 'blueMult']) || 1;
  if (cfg.backwater) {
    const gap = team === 'red' ? (50 - state.pos) : (state.pos - 50);
    if (gap >= cfg.backwaterGap) m *= (Number(cfg.backwaterMult) || 1.3);
  }
  return m;
}

function mvpScoreList(cfg) {
  return String(cfg.mvpScores || '').split(/[,，\s]+/).map(Number).filter(n => n > 0);
}

/** 个人贡献值：拉动 1 格 + 点赞 1 次各计 1 分 */
function contribOf(m) { return (m.pulls || 0) + (m.likes || 0); }

function teamSummary(ctx, team) {
  const t = ctx.state.teams[team];
  const members = [...t.members.values()];
  const pulls = members.reduce((s, m) => s + m.pulls, 0);
  const likes = members.reduce((s, m) => s + m.likes, 0);
  const top = members.slice().sort((a, b) => contribOf(b) - contribOf(a)).slice(0, 5)
    .map(m => ({ name: m.name, avatar: m.avatar, pulls: m.pulls, likes: m.likes }));
  return { name: t.name, count: members.length, pulls, likes, energy: Math.round(t.energy), surges: t.surges, top };
}

/* ═══════════════ 回合流程 ═══════════════ */

/** 本轮模式：mixed 下每 siegeEveryRounds 轮拔河插 1 轮守城（4 局一循环） */
function pickMode(cfg, roundNo) {
  if (cfg.mode === 'siege' || cfg.mode === 'shooter' || cfg.mode === 'shooterBoss') return cfg.mode;
  if (cfg.mode === 'mixed' && roundNo > 0 && (roundNo % (Math.max(1, cfg.siegeEveryRounds) + 1)) === 0) return 'siege';
  return 'tug';
}

function startRound(ctx) {
  const { state, cfg, emit } = ctx;
  ctx.clearTimers('round');
  ctx.clearTimers('shooter');
  state.roundNo++;
  state.mode = pickMode(cfg, state.roundNo);
  state.pos = 50;
  state.teams = { red: newTeam(cfg.teamRedName || '猛虎营'), blue: newTeam(cfg.teamBlueName || '飞鲨营') };
  state.monster = null; state.wall = null; state.siegeEnergy = 0; state.surges = 0;
  state.shooter = null;
  state.lastActAt.clear();
  state.joinAwarded.clear();
  state.result = null;
  state.status = 'joining';
  state.deadline = Date.now() + cfg.joinSec * 1000;
  feed(ctx, '🎬', state.mode === 'siege'
    ? `第 ${state.roundNo} 局【守城战】组队！全体守军集合，发 红 / 蓝 领取队籍`
    : state.mode === 'shooter'
      ? `第 ${state.roundNo} 局【弹幕枪战】组队！发 红 / 蓝 入队，血量先清零者输`
      : `第 ${state.roundNo} 局组队开始！发 红 / 蓝 加入阵营`, true);
  ctx.log('INFO', `[redblue #${state.roundNo}] 组队期开始（${cfg.joinSec}s，模式=${state.mode}）`);
  flushEmit(ctx);
  schedulePhase(ctx);
}

function beginTug(ctx) {
  const { state, cfg } = ctx;
  if (state.status !== 'joining') return;
  if (state.mode === 'siege') return beginSiege(ctx);
  if (state.mode === 'shooter' || state.mode === 'shooterBoss') return beginShoot(ctx);
  state.status = 'tugging';
  state.deadline = Date.now() + cfg.tugSec * 1000;
  const r = state.teams.red.members.size, b = state.teams.blue.members.size;
  feed(ctx, '⚔️', `对抗开始！红 ${r} 人 vs 蓝 ${b} 人 · 发弹幕拉动战线，点赞充能！`, true);
  ctx.log('INFO', `[redblue #${state.roundNo}] 对抗期开始（红${r}/蓝${b}）`);
  flushEmit(ctx);
  schedulePhase(ctx);
}

/* ═══════════════ 弹幕枪战（shooting · HP 对决） ═══════════════ */

function beginShoot(ctx) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'joining') return;
  state.shooter = {
    redHp: Math.max(10, cfg.shooterHp),
    blueHp: Math.max(10, cfg.shooterHp),
    bullets: [],
    blitz: { red: 0, blue: 0 },   // 点赞加速值（缩间隔 + 提弹速；随节拍衰减，需持续点赞维持）
    acc: { red: 0, blue: 0 },     // 自动火力蓄力（毫秒；满 baseMs 自动射一发）
    fired: { red: 0, blue: 0 },   // 自动火力发射计数（调试/测试观察）
    lastTick: Date.now(),
  };
  state.boss = null;
  state.bossAtkAt = 0;
  // 枪战打 BOSS：双方共同射击中央 Boss（击杀=全员胜利；Boss 反击打基地墙）
  if (state.mode === 'shooterBoss') {
    const bhp = Math.max(20, cfg.shooterBossHp);
    state.boss = { name: BOSS_NAMES[(state.roundNo - 1) % BOSS_NAMES.length], hp: bhp, hpMax: bhp };
    const whp = Math.max(20, cfg.wallHp);
    state.wall = { hp: whp, hpMax: whp };
    state.bossAtkAt = Date.now() + Math.max(2, cfg.bossAtkSec) * 1000;
  }
  state.status = 'shooting';
  state.deadline = Date.now() + Math.max(20, cfg.tugSec) * 1000;
  const r = state.teams.red.members.size, b = state.teams.blue.members.size;
  feed(ctx, '🔫', state.mode === 'shooterBoss'
    ? `BOSS 战开始！${state.boss.name} 来袭（HP ${state.boss.hpMax}）——双方红/蓝合力射击，击杀全员胜利！`
    : `枪战开始！红 ${r} 人 vs 蓝 ${b} 人 · 发弹幕=发射子弹，送礼=强力子弹，血量先清零者输！`, true);
  if (cfg.autoFire !== false) {
    feed(ctx, '🤖', '双方自动火力已激活——发弹幕加火、点赞加速、送礼出强力弹！', false);
  }
  ctx.log('INFO', `[redblue #${state.roundNo}] 枪战开始（红${r}/蓝${b}，HP ${state.shooter.redHp} vs ${state.shooter.blueHp}，自动火力=${cfg.autoFire !== false}，Boss=${state.mode === 'shooterBoss' ? state.boss.name + '/' + state.boss.hpMax : '无'}）`);
  flushEmit(ctx);
  schedulePhase(ctx);
  scheduleShooter(ctx);
}

function scheduleShooter(ctx) {
  const { state, cfg } = ctx;
  ctx.clearTimers('shooter');
  if (state.status !== 'shooting') return;
  ctx.setTimer('shooter', () => shooterTick(ctx), Math.max(50, cfg.shooterTickMs));
}

/** 战斗场景小事件（枪口火光/命中/抵消），走 guess 通道即时送达展示屏（不等状态推送） */
function sceneEvent(ctx, type, data = {}) {
  try { ctx.emit.guess({ kind: 'scene', type, ...data, ts: Date.now() }); } catch {}
}

function shooterTick(ctx) {
  const { state, cfg } = ctx;
  if (state.status !== 'shooting' || !state.shooter) return;
  const now = Date.now();
  const T = Math.max(300, cfg.shooterTravelMs);
  const hp = state.shooter;
  const dt = Math.max(1, now - (hp.lastTick || now));
  hp.lastTick = now;
  const isBoss = state.mode === 'shooterBoss';
  let changed = false;

  // ── 自动火力（无人也持续交火；同频同强度 → 完美互抵，血量不动）
  //  ── 点赞加速：本队 blitz 越高 → 发射越勤 + 子弹飞得越快（随节拍衰减，需持续点赞维持）
  const acc = hp.acc;
  for (const side of ['red', 'blue']) {
    const bz = (hp.blitz[side] || 0);
    const fireMult = 1 + Math.min(1.6, bz / 40);     // blitz≥64 → 最多 2.6 倍射速
    acc[side] = (acc[side] || 0) + dt * fireMult;
    if (cfg.autoFire !== false && acc[side] >= Math.max(300, cfg.autoFireBaseMs)) {
      acc[side] -= Math.max(300, cfg.autoFireBaseMs);
      hp.fired[side]++;
      hp.bullets.push({
        id: ++bulletSeq,
        side,
        strength: 1,
        t0: now,
        frac: 0,
        _next: now,
        auto: 1,
      });
      sceneEvent(ctx, 'fire', { side });
      changed = true;
    }
    hp.blitz[side] = Math.round((bz || 0) * 0.94);   // 点赞加速值衰减（半衰 ~1.1s）
  }

  // ── 推进（玩家弹与自动弹同规：本队 blitz 提供飞行加速） ──
  for (const b of hp.bullets) {
    const boost = 1 + Math.min(0.8, (hp.blitz[b.side] || 0) / 100);  // blitz≥80 → 最多 1.8 倍弹速
    b.frac = Math.min(1, b.frac + ((now - (b._next || b.t0)) / T) * boost);
    b._next = now;
    if (b.frac >= 1 && !b.done) b.done = true;
  }

  // 1) 到达：PVP=命中敌侧扣血；Boss=双方子弹打到中央 Boss（合作）
  if (isBoss) {
    for (let i = hp.bullets.length - 1; i >= 0; i--) {
      const b = hp.bullets[i];
      if (b.done || b.frac < 0.5) continue;
      state.boss.hp = Math.max(0, state.boss.hp - b.strength);
      sceneEvent(ctx, 'hit', { side: b.side, strength: b.strength, hp: state.boss.hp });
      b.done = true;
      changed = true;
      if (state.boss.hp <= 0) { revealShootBoss(ctx, true, 'killed'); return; }
    }
  } else {
    for (let i = hp.bullets.length - 1; i >= 0; i--) {
      const b = hp.bullets[i];
      if (b.frac < 1 || b.done) continue;
      const foeHp = b.side === 'red' ? 'blueHp' : 'redHp';
      hp[foeHp] = Math.max(0, hp[foeHp] - b.strength);
      sceneEvent(ctx, 'hit', { side: b.side, strength: b.strength, hp: hp[foeHp] });
      b.done = true;
      changed = true;
      if (hp.redHp <= 0 || hp.blueHp <= 0) { revealShoot(ctx, null, 'hp'); return; }
    }
  }

  // 2) 抵消（仅 PVP 双方对射；Boss 战双方是盟友，子弹对 Boss 不互撞）
  if (!isBoss) {
    for (let i = hp.bullets.length - 1; i >= 0; i--) {
      const a = hp.bullets[i];
      if (a.done || a.frac >= 1) continue;
      for (let j = 0; j < hp.bullets.length; j++) {
        if (j === i) continue;
        const b = hp.bullets[j];
        if (b.side === a.side || b.done || b.frac >= 1) continue;
        if (a.frac + b.frac >= 1) {
          const ia = Math.min(a.strength, b.strength);   // 各自承受对方强度
          const ib = Math.min(b.strength, a.strength);
          a.strength -= ia; b.strength -= ib;
          sceneEvent(ctx, 'collide', { side: a.side, x: (a.frac + b.frac) / 2 });
          if (a.strength <= 0) a.done = true;
          if (b.strength <= 0) b.done = true;
          changed = true;
          break;                                          // 一颗子弹一帧只结算一次
        }
      }
    }
  }

  // 3) Boss 反击：打基地墙
  if (isBoss && state.boss && now >= state.bossAtkAt) {
    state.wall.hp = Math.max(0, state.wall.hp - cfg.bossAtk);
    sceneEvent(ctx, 'bossAtk', { dmg: cfg.bossAtk, hp: state.wall.hp });
    if (state.wall.hp <= state.wall.hpMax * 0.3) {
      feed(ctx, '🧱', `基地墙告急！耐久仅剩 ${Math.round(state.wall.hp / state.wall.hpMax * 100)}%`, true, { type: 'bossAtk', dmg: cfg.bossAtk });
    } else {
      feed(ctx, '👹', `${state.boss.name} 反击！基地墙 -${cfg.bossAtk}`, false, { type: 'bossAtk', dmg: cfg.bossAtk });
    }
    changed = true;
    if (state.wall.hp <= 0) { revealShootBoss(ctx, false, 'wall'); return; }
    state.bossAtkAt = now + Math.max(2, cfg.bossAtkSec) * 1000;
  }

  hp.bullets = hp.bullets.filter(b => !b.done && b.strength > 0);
  if (changed) emitSoon(ctx);
  scheduleShooter(ctx);
}

/** 朝指定阵营发射一颗子弹（普通=1 血；gift 弹=强力） */
function fireBullet(ctx, msg, side, strength) {
  const { state, cfg } = ctx;
  const hp = state.shooter;
  if (!hp || state.status !== 'shooting') return;
  if (hp.bullets.length >= Math.max(4, cfg.shooterBulletCap)) hp.bullets.shift(); // 丢最老
  hp.bullets.push({
    id: ++bulletSeq,
    side,
    strength: Math.max(1, strength),
    t0: Date.now(),
    frac: 0,
  });
  sceneEvent(ctx, 'fire', { side });
  feed(ctx, side === 'red' ? '🔥' : '🌊', `${userName(msg)} 发射${strength > 1 ? '强力' : ''}子弹${strength > 1 ? ` HP${strength}` : ''}！`, strength > 1, { type: 'shoot', side, strength });
  emitSoon(ctx);
}

function revealShoot(ctx, winner, reason) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'shooting' || !state.shooter) return;
  ctx.clearTimers('round');
  ctx.clearTimers('shooter');
  const hp = state.shooter;
  if (!winner) {
    winner = hp.redHp === hp.blueHp ? null : (hp.redHp > hp.blueHp ? 'red' : 'blue');
  }
  const winScore = cfg.winScore, loseScore = cfg.loseScore;
  const fighters = [];
  for (const team of ['red', 'blue']) {
    const isWinner = team === winner;
    for (const [uid, m] of state.teams[team].members) {
      const entry = { userId: uid, user: m.name, avatar: m.avatar };
      if (isWinner) {
        ctx.award(entry, winScore);
        m.score = winScore;
      } else {
        ctx.lb.awardScore(MANIFEST.id, entry, loseScore);
        m.score = loseScore;
      }
      fighters.push({ uid, name: m.name, avatar: m.avatar, team, pulls: m.pulls, likes: m.likes, score: m.score, mvp: false });
    }
  }
  const mvp = [];
  if (winner) {
    const scores = mvpScoreList(cfg);
    const ranked = [...state.teams[winner].members.values()]
      .sort((a, b) => contribOf(b) - contribOf(a)).slice(0, scores.length);
    ranked.forEach((m, i) => {
      if (contribOf(m) <= 0) return;
      ctx.lb.awardScore(MANIFEST.id, { userId: m.uid, user: m.name, avatar: m.avatar }, scores[i]);
      m.score += scores[i];
      const f = fighters.find(x => x.uid === m.uid);
      if (f) { f.score = m.score; f.mvp = true; }
      mvp.push({ rank: i + 1, name: m.name, avatar: m.avatar, contrib: contribOf(m), bonus: scores[i] });
    });
  }
  seasonStore.recordRound(fighters, winner); // P4 赛季功勋

  if (winner) {
    state.series[winner]++;
    if (state.streak.team === winner) state.streak.n++;
    else state.streak = { team: winner, n: 1 };
  }

  state.status = 'revealed';
  state.result = {
    mode: 'shooter',
    winner, reason: reason || 'hp',
    redHp: hp.redHp, blueHp: hp.blueHp,
    red: teamSummary(ctx, 'red'),
    blue: teamSummary(ctx, 'blue'),
    mvp,
    winScore, loseScore,
    streak: { ...state.streak },
    report: '',
    revealedAt: Date.now(),
  };
  state.history.unshift({ roundNo: state.roundNo, mode: 'shooter', winner, redHp: hp.redHp, blueHp: hp.blueHp, ts: Date.now() });
  if (state.history.length > 30) state.history.pop();

  const wName = winner ? state.teams[winner].name : '平局';
  feed(ctx, winner === 'red' ? '🔥' : winner === 'blue' ? '🌊' : '🤝',
    winner ? `${wName} 获胜！${winner === 'red' ? '蓝' : '红'}队参与奖 +${loseScore}` : '平局！双方各得参与奖', true);
  ctx.log('INFO', `[redblue #${state.roundNo}] 枪战结算：${wName}（${reason}，${hp.redHp}:${hp.blueHp}）`);
  emitReport(ctx);
  flushEmit(ctx);

  if (cfg.autoNextRound) {
    ctx.setTimer('round', () => startRound(ctx), Math.max(0, cfg.resultShowSec) * 1000);
  }
}

/* ═══════════════ PVE 守城（sieging） ═══════════════ */

function beginSiege(ctx) {
  const { state, cfg } = ctx;
  const hpMax = Math.max(20, cfg.monsterHp);
  state.monster = {
    name: SIEGE_MONSTERS[(state.roundNo - 1) % SIEGE_MONSTERS.length],
    hp: hpMax, hpMax,
  };
  const wallMax = Math.max(20, cfg.wallHp);
  state.wall = { hp: wallMax, hpMax: wallMax };
  state.siegeEnergy = 0; state.surges = 0;
  state.status = 'sieging';
  state.deadline = Date.now() + cfg.tugSec * 1000;
  const defenders = state.teams.red.members.size + state.teams.blue.members.size;
  feed(ctx, '👹', `【守城战】${state.monster.name} 来袭（HP ${hpMax}）！全体弹幕=攻击，点赞充能「全力一击」！`, true);
  ctx.log('INFO', `[redblue #${state.roundNo}] 守城开始：${state.monster.name} hp=${hpMax} 守军=${defenders}`);
  flushEmit(ctx);
  schedulePhase(ctx);
  scheduleMonsterAttack(ctx);
}

function scheduleMonsterAttack(ctx) {
  const { state, cfg } = ctx;
  ctx.clearTimers('monster');
  if (state.status !== 'sieging') return;
  ctx.setTimer('monster', () => monsterAttack(ctx), Math.max(2, cfg.monsterAtkSec) * 1000);
}

function monsterAttack(ctx) {
  const { state, cfg } = ctx;
  if (state.status !== 'sieging') return;
  state.wall.hp = Math.max(0, state.wall.hp - cfg.monsterAtk);
  if (state.wall.hp <= 0) {
    feed(ctx, '💥', `城墙被 ${state.monster.name} 攻破！守城失败…`, true);
    revealSiege(ctx, false, 'wall');
    return;
  }
  if (state.wall.hp <= state.wall.hpMax * 0.3) feed(ctx, '🧱', `城墙告急！耐久仅剩 ${Math.round(state.wall.hp / state.wall.hpMax * 100)}%`, true, { type: 'wallDanger', dmg: cfg.monsterAtk });
  else feed(ctx, '👹', `${state.monster.name} 攻城！城墙 -${cfg.monsterAtk}`, false, { type: 'monsterAtk', dmg: cfg.monsterAtk });
  emitSoon(ctx);
  scheduleMonsterAttack(ctx);
}

function siegeAttack(ctx, msg) {
  const { state, cfg } = ctx;
  const uid = userKey(msg);
  const now = Date.now();
  const last = state.lastActAt.get(uid) || 0;
  if (now - last < cfg.rateLimitSec * 1000) return;
  state.lastActAt.set(uid, now);

  // 任意弹幕=攻击；带队色的入本队，无队色的自动补进人少的一队（守军合力但保留队籍）
  const side = parseSide(msg.text) || (state.teams.red.members.size <= state.teams.blue.members.size ? 'red' : 'blue');
  const m = joinTeam(ctx, msg, side);
  m.pulls += 1; // 复用 pulls 记攻击次数
  state.monster.hp = Math.max(0, state.monster.hp - 1);
  if (state.monster.hp <= 0) { revealSiege(ctx, true, 'killed'); return; }
  feed(ctx, side === 'red' ? '🔥' : '🌊', `${m.name} 攻击 ${state.monster.name}（剩余 ${state.monster.hp}）`, false,
    { type: 'attack', side, dmg: 1 });
  emitSoon(ctx);
}

function revealSiege(ctx, success, reason) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'sieging') return;
  ctx.clearTimers('round');
  ctx.clearTimers('monster');

  const winScore = cfg.siegeWinScore, loseScore = cfg.siegeLoseScore;
  // 参战者计分（两种队籍合并；同时收集赛季功勋 fighters）
  const fighters = [];
  for (const team of ['red', 'blue']) {
    for (const [uid, m] of state.teams[team].members) {
      fighters.push({ uid, name: m.name, avatar: m.avatar, team, pulls: m.pulls, likes: m.likes, score: 0, mvp: false });
      const entry = { userId: uid, user: m.name, avatar: m.avatar };
      if (success && contribOf(m) > 0) {
        ctx.award(entry, winScore);
        m.score = winScore;
      } else {
        ctx.lb.awardScore(MANIFEST.id, entry, success ? winScore : loseScore);
        m.score = success ? winScore : loseScore;
      }
      const f = fighters[fighters.length - 1];
      f.score = m.score;
    }
  }
  // MVP：全场贡献 Top3（成功才发）
  const mvp = [];
  if (success) {
    const scores = mvpScoreList(cfg);
    fighters.sort((a, b) => (b.pulls + b.likes) - (a.pulls + a.likes)).slice(0, scores.length).forEach((f, i) => {
      const contrib = f.pulls + f.likes;
      if (contrib <= 0) return;
      ctx.lb.awardScore(MANIFEST.id, { userId: f.uid, user: f.name, avatar: f.avatar }, scores[i]);
      f.score += scores[i];
      f.mvp = true;
      const m = state.teams[f.team].members.get(f.uid);
      if (m) m.score = f.score;
      mvp.push({ rank: i + 1, name: f.name, avatar: f.avatar, contrib, bonus: scores[i] });
    });
  }
  seasonStore.recordRound(fighters, success ? 'both' : null); // P4 赛季功勋

  state.status = 'revealed';
  state.result = {
    mode: 'siege',
    success, reason,
    monster: { name: state.monster.name, hpLeft: state.monster.hp, hpMax: state.monster.hpMax },
    wall: { hpLeft: state.wall.hp, hpMax: state.wall.hpMax },
    fighters: fighters.length,
    mvp,
    winScore, loseScore,
    report: '',
    revealedAt: Date.now(),
  };
  state.history.unshift({ roundNo: state.roundNo, mode: 'siege', success, monster: state.monster.name, ts: Date.now() });
  if (state.history.length > 30) state.history.pop();

  feed(ctx, success ? '🎉' : '💀', success
    ? `守城成功！${state.monster.name} 被击退！全体参战 +${winScore} 分`
    : `守城失败…${state.monster.name} 逃走了，全体参战安慰 +${loseScore} 分`, true);
  ctx.log('INFO', `[redblue #${state.roundNo}] 守城${success ? '成功' : '失败'}（${reason}，参战 ${fighters.length} 人）`);
  emitReport(ctx);
  flushEmit(ctx);

  if (cfg.autoNextRound) {
    ctx.setTimer('round', () => startRound(ctx), Math.max(0, cfg.resultShowSec) * 1000);
  }
}

function schedulePhase(ctx) {
  const { state } = ctx;
  ctx.clearTimers('round');
  const remain = Math.max(0, state.deadline - Date.now());
  if (state.status === 'joining') {
    ctx.setTimer('round', () => beginTug(ctx), remain);
  } else if (state.status === 'tugging') {
    ctx.setTimer('round', () => reveal(ctx), remain);
  } else if (state.status === 'sieging') {
    // 守城倒计时：耗尽时怪物仍活着 → 失败；怪物攻城另有 'monster' 定时链
    ctx.setTimer('round', () => revealSiege(ctx, false, 'timeout'), remain);
  } else if (state.status === 'shooting') {
    // 枪战倒计时：耗尽时按血量判胜负（Boss 战：未击破=失败）
    ctx.setTimer('round', () => {
      if (state.mode === 'shooterBoss') revealShootBoss(ctx, false, 'timeout');
      else revealShoot(ctx, null, 'timeout');
    }, remain);
  }
}

function reveal(ctx, forced = false) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'tugging') return;
  ctx.clearTimers('round');

  // 胜负判定：推到胜负线立即分胜负；超时按战线位置（正中=平局）
  let winner = null, reason = 'timeout';
  if (state.pos >= cfg.winLine) { winner = 'red'; reason = 'pushed'; }
  else if (state.pos <= 100 - cfg.winLine) { winner = 'blue'; reason = 'pushed'; }
  else winner = state.pos > 50 ? 'red' : state.pos < 50 ? 'blue' : null;

  const winScore = cfg.winScore, loseScore = cfg.loseScore;
  const redSum = teamSummary(ctx, 'red'), blueSum = teamSummary(ctx, 'blue');

  // 结算得分（同时收集赛季功勋 fighters）
  const fighters = [];
  for (const team of ['red', 'blue']) {
    const isWinner = team === winner;
    for (const [uid, m] of state.teams[team].members) {
      const entry = { userId: uid, user: m.name, avatar: m.avatar };
      if (isWinner) {
        ctx.award(entry, winScore);                    // 胜方：胜场 + 分
        m.score = winScore;
      } else {
        ctx.lb.awardScore(MANIFEST.id, entry, loseScore); // 败方：仅参与奖
        m.score = loseScore;
      }
      fighters.push({ uid, name: m.name, avatar: m.avatar, team, pulls: m.pulls, likes: m.likes, score: m.score, mvp: false });
    }
  }
  // MVP：胜队贡献 Top3 额外加分（不计胜场）
  const mvp = [];
  if (winner) {
    const scores = mvpScoreList(cfg);
    const ranked = [...state.teams[winner].members.values()]
      .sort((a, b) => contribOf(b) - contribOf(a)).slice(0, scores.length);
    ranked.forEach((m, i) => {
      if (contribOf(m) <= 0) return;
      ctx.lb.awardScore(MANIFEST.id, { userId: m.uid, user: m.name, avatar: m.avatar }, scores[i]);
      m.score += scores[i];
      const f = fighters.find(x => x.uid === m.uid);
      if (f) { f.score = m.score; f.mvp = true; }
      mvp.push({ rank: i + 1, name: m.name, avatar: m.avatar, contrib: contribOf(m), bonus: scores[i] });
    });
  }
  seasonStore.recordRound(fighters, winner); // P4 赛季功勋

  // 连胜 / 战绩
  if (winner) {
    state.series[winner]++;
    if (state.streak.team === winner) state.streak.n++;
    else state.streak = { team: winner, n: 1 };
  }

  state.status = 'revealed';
  state.result = {
    mode: 'tug',
    winner, reason, draw: !winner,
    pos: Math.round(state.pos * 10) / 10,
    red: redSum, blue: blueSum,
    mvp,
    winScore, loseScore,
    streak: { ...state.streak },
    report: '',
    revealedAt: Date.now(),
  };
  state.history.unshift({ roundNo: state.roundNo, mode: 'tug', winner, pos: state.result.pos, ts: Date.now() });
  if (state.history.length > 30) state.history.pop();

  const wName = winner ? state.teams[winner].name : '平局';
  feed(ctx, winner === 'red' ? '🔥' : winner === 'blue' ? '🌊' : '🤝',
    winner ? `${wName} 获胜！${winner === 'red' ? '蓝' : '红'}队参与奖 +${loseScore}` : '平局！双方各得参与奖', true);
  ctx.log('INFO', `[redblue #${state.roundNo}] 结算：${wName}（pos=${state.result.pos}，${reason}）`);
  emitReport(ctx);
  flushEmit(ctx);

  if (cfg.autoNextRound) {
    ctx.setTimer('round', () => startRound(ctx), Math.max(0, cfg.resultShowSec) * 1000);
  }
}

/** Boss 战结算：击杀=全员胜利（+胜场）；失败=全员安慰分（合作玩法，双方荣耀一体） */
function revealShootBoss(ctx, success, reason) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'shooting' || !state.shooter || !state.boss) return;
  ctx.clearTimers('round');
  ctx.clearTimers('shooter');

  const winScore = cfg.winScore, loseScore = cfg.loseScore;
  const fighters = [];
  for (const team of ['red', 'blue']) {
    for (const [uid, m] of state.teams[team].members) {
      const entry = { userId: uid, user: m.name, avatar: m.avatar };
      if (success) {
        ctx.award(entry, winScore);                    // 合作胜利：全员得分 + 胜场
        m.score = winScore;
      } else {
        ctx.lb.awardScore(MANIFEST.id, entry, loseScore);
        m.score = loseScore;
      }
      fighters.push({ uid, name: m.name, avatar: m.avatar, team, pulls: m.pulls, likes: m.likes, score: m.score, mvp: false });
    }
  }
  // MVP：全场贡献 Top3（击杀才发）
  const mvp = [];
  if (success) {
    const scores = mvpScoreList(cfg);
    const all = fighters.slice().sort((a, b) => (b.pulls + b.likes) - (a.pulls + a.likes)).slice(0, scores.length);
    all.forEach((f, i) => {
      if (f.pulls + f.likes <= 0) return;
      ctx.lb.awardScore(MANIFEST.id, { userId: f.uid, user: f.name, avatar: f.avatar }, scores[i]);
      f.score += scores[i];
      f.mvp = true;
      mvp.push({ rank: i + 1, name: f.name, avatar: f.avatar, contrib: f.pulls + f.likes, bonus: scores[i] });
    });
  }
  seasonStore.recordRound(fighters, success ? 'both' : null);

  state.status = 'revealed';
  state.result = {
    mode: 'shooterBoss',
    success, reason,
    boss: { name: state.boss.name, hpLeft: state.boss.hp, hpMax: state.boss.hpMax },
    wall: { hpLeft: state.wall.hp, hpMax: state.wall.hpMax },
    fighters: fighters.length,
    mvp,
    winScore, loseScore,
    report: '',
    revealedAt: Date.now(),
  };
  state.history.unshift({ roundNo: state.roundNo, mode: 'shooterBoss', success, ts: Date.now() });
  if (state.history.length > 30) state.history.pop();

  feed(ctx, success ? '🎉' : '💀', success
    ? `Boss「${state.boss.name}」被击破！全体守军 +${winScore} 分！`
    : `Boss「${state.boss.name}」攻破基地墙…全员安慰 +${loseScore} 分`, true);
  ctx.log('INFO', `[redblue #${state.roundNo}] Boss 战${success ? '胜利' : '失败'}（${reason}，参战 ${fighters.length} 人）`);
  emitReport(ctx);
  flushEmit(ctx);

  if (cfg.autoNextRound) {
    ctx.setTimer('round', () => startRound(ctx), Math.max(0, cfg.resultShowSec) * 1000);
  }
}

/** 异步生成结算战报（走通用播报中心）：完成后补进 result.report + 战报流 + 推入播报通道；永不影响结算主流程 */
function emitReport(ctx) {
  const { state } = ctx;
  const res = state.result;
  if (!res) return;
  BC(ctx).generate('report', res).then(text => {
    if (!text || state.result !== res) return; // 已开新轮则丢弃
    res.report = text;
    feed(ctx, '🎙️', text, false);
    BC(ctx).push('report', text);              // 推入通用通道（bc.seq 自增，主播台面板朗读/记录）
    ctx.emit.state();
  }).catch(() => {});
}

/* ═══════════════ 入队 / 拉动 ═══════════════ */

/** 解析阵营关键词：红/蓝（兼容 1/2、红队/蓝队）；双向出现视为无效 */
function parseSide(text) {
  const t = String(text || '');
  const hasRed = /红/.test(t) || /^\s*[12]\s*$/.test(t) && t.trim() === '1';
  const hasBlue = /蓝/.test(t) || (t.trim() === '2');
  if (hasRed && !hasBlue) return 'red';
  if (hasBlue && !hasRed) return 'blue';
  return null;
}

function joinTeam(ctx, msg, side) {
  const { state, cfg } = ctx;
  const uid = userKey(msg), name = userName(msg), avatar = userAvatar(msg);
  const other = side === 'red' ? 'blue' : 'red';
  const t = state.teams[side];
  const switched = state.teams[other].members.has(uid);
  if (switched) state.teams[other].members.delete(uid);
  seasonStore.enroll(uid, name, avatar, side); // 入队即入伍（P4 赛季名册，幂等）
  if (!t.members.has(uid)) {
    t.members.set(uid, { uid, name, avatar, pulls: 0, likes: 0, score: 0, joinedAt: Date.now() });
    // 首次入队奖（默认 0 关闭；awardScore 不加胜场）
    if (cfg.joinBonus > 0 && !state.joinAwarded.has(uid)) {
      state.joinAwarded.add(uid);
      ctx.lb.awardScore(MANIFEST.id, { userId: uid, user: name, avatar }, cfg.joinBonus);
    }
    // 组队期才播报入队战报；对抗期自动入队只播拉动，避免重复刷屏
    if (state.status === 'joining') {
      feed(ctx, side === 'red' ? '🔥' : '🌊',
        `${switched ? '转投' : ''}${t.name}！${name} 加入了${side === 'red' ? '红' : '蓝'}队`);
    }
    ctx.log('INFO', `[redblue] ${name} 加入${side}队（红${state.teams.red.members.size}/蓝${state.teams.blue.members.size}）`);
  }
  return t.members.get(uid);
}

function doPull(ctx, msg, side) {
  const { state, cfg } = ctx;
  const uid = userKey(msg);
  // 限频（拉动/入队共用一条限频线）
  const now = Date.now();
  const last = state.lastActAt.get(uid) || 0;
  if (now - last < cfg.rateLimitSec * 1000) return;
  state.lastActAt.set(uid, now);

  const m = joinTeam(ctx, msg, side); // 对抗期发弹幕 = 自动入队并拉动
  const str = pullMult(ctx, side);
  state.pos += side === 'red' ? str : -str;
  m.pulls += 1;

  if (side === 'red') state.pos = Math.min(100, state.pos);
  else state.pos = Math.max(0, state.pos);
  feed(ctx, '🪢', `${m.name} 拉动战线 ${side === 'red' ? '→' : '←'} 1 格`, false,
    { type: 'pull', side, amount: Math.round(str * 10) / 10 });

  // 推到胜负线立即结算
  if (state.pos >= cfg.winLine || state.pos <= 100 - cfg.winLine) reveal(ctx);
  else emitSoon(ctx);
}

/* ═══════════════ 点赞充能 ═══════════════ */

function findMember(ctx, msg) {
  const uid = userKey(msg);
  for (const side of ['red', 'blue']) {
    const m = ctx.state.teams[side].members.get(uid);
    if (m) return { side, m };
  }
  return null;
}

function handleLike(ctx, msg) {
  const { state, cfg } = ctx;
  if (state.status === 'sieging') return siegeLike(ctx, msg);      // 守城：全场能量
  if (state.status === 'shooting') return shootLike(ctx, msg);     // 枪战：加速
  if (state.status !== 'tugging') return;                          // 仅对抗期充能
  if (!roomAllowed(ctx, msg)) return;
  const found = findMember(ctx, msg);
  if (!found) return;                               // 未入队观众的点赞不计（引导先发 红/蓝）
  const { side, m } = found;
  const n = Math.min(cfg.likeCapPerEvent, Math.max(1, Number(msg.likeCount) || 1));

  m.likes += n;
  const t = state.teams[side];
  t.energy += n / Math.max(1, cfg.likesPerEnergy);

  // 能量满 → 全军冲锋
  while (t.energy >= cfg.surgeThreshold && state.status === 'tugging') {
    t.energy -= cfg.surgeThreshold;
    t.surges++;
    const push = cfg.surgePush;
    state.pos += side === 'red' ? push : -push;
    state.pos = Math.min(100, Math.max(0, state.pos));
    feed(ctx, '⚔️', `${t.name} 全军冲锋！战线推进 ${push} 格！`, true,
      { type: 'surge', side, push });
    ctx.log('INFO', `[redblue] ${t.name} 冲锋（第 ${t.surges} 次），pos=${Math.round(state.pos)}`);
    if (state.pos >= cfg.winLine || state.pos <= 100 - cfg.winLine) { reveal(ctx); return; }
  }
  emitSoon(ctx);
}

/** 枪战期点赞：计入该队加速值（客户端按推送差值折算子弹提速） */
function shootLike(ctx, msg) {
  const { state, cfg } = ctx;
  if (!roomAllowed(ctx, msg)) return;
  const n = Math.min(cfg.likeCapPerEvent, Math.max(1, Number(msg.likeCount) || 1));
  const side = parseSide(msg.text) || undefined;
  let found = findMember(ctx, msg);
  if (!found) {
    const s = side || (state.teams.red.members.size <= state.teams.blue.members.size ? 'red' : 'blue');
    found = { side: s, m: joinTeam(ctx, msg, s) };
  }
  found.m.likes += n;
  if (state.shooter) state.shooter.blitz[found.side] = (state.shooter.blitz[found.side] || 0) + n;
  emitSoon(ctx);
}

/** 守城期点赞：充全场能量槽（需已入队），满触发「全力一击」 */
function siegeLike(ctx, msg) {
  const { state, cfg } = ctx;
  if (!roomAllowed(ctx, msg)) return;
  const n = Math.min(cfg.likeCapPerEvent, Math.max(1, Number(msg.likeCount) || 1));
  const side = parseSide(msg.text) || undefined;
  // 已入队记在该队名下；未入队的点赞自动入人少的一队（守城人人可充能）
  let found = findMember(ctx, msg);
  if (!found) {
    const s = side || (state.teams.red.members.size <= state.teams.blue.members.size ? 'red' : 'blue');
    found = { side: s, m: joinTeam(ctx, msg, s) };
  }
  found.m.likes += n;
  state.siegeEnergy += n / Math.max(1, cfg.likesPerEnergy);

  while (state.siegeEnergy >= cfg.surgeThreshold && state.status === 'sieging') {
    state.siegeEnergy -= cfg.surgeThreshold;
    state.surges++;
    const dmg = cfg.siegeSurgeDamage;
    state.monster.hp = Math.max(0, state.monster.hp - dmg);
    feed(ctx, '⚡', `${found.m.name} 点燃「全力一击」！${state.monster.name} -${dmg}（剩余 ${state.monster.hp}）`, true,
      { type: 'siegeSurge', dmg });
    ctx.log('INFO', `[redblue] 全力一击 -${dmg}，怪物剩余 ${state.monster.hp}`);
    if (state.monster.hp <= 0) { revealSiege(ctx, true, 'killed'); return; }
  }
  emitSoon(ctx);
}

/* ═══════════════ 礼物召唤 / 进场引导（需宿主转发对应事件） ═══════════════ */

function handleGift(ctx, msg) {
  const { state, cfg } = ctx;
  if (!cfg.giftEnabled) return;
  // 枪战：送礼 = 强力子弹（高血量、客户端不同颜色显示）
  if (state.status === 'shooting' && state.shooter) {
    const side = parseSide(msg.text) || undefined;
    let found = findMember(ctx, msg);
    if (!found) {
      const s = side || (state.teams.red.members.size <= state.teams.blue.members.size ? 'red' : 'blue');
      found = { side: s, m: joinTeam(ctx, msg, s) };
    }
    const pieces = Math.min(5, (Number(msg.giftCount) || 1) * (Number(msg.repeatCount) || 1));
    const strength = Math.max(1, Number(cfg.giftBulletStrength) || 6) * pieces;
    fireBullet(ctx, msg, found.side, strength);
    return;
  }
  if (state.status !== 'tugging') return;
  const found = findMember(ctx, msg);
  if (!found) return;
  const { side, m } = found;
  const pieces = Math.min(10, (Number(msg.giftCount) || 1) * (Number(msg.repeatCount) || 1));
  const push = pieces * (Number(cfg.giftPush) || 3);
  state.pos += side === 'red' ? push : -push;
  state.pos = Math.min(100, Math.max(0, state.pos));
  m.pulls += push;
  feed(ctx, '🎁', `${m.name} 送 ${msg.giftName || '礼物'}，召唤大军推进 ${push} 格！`, true);
  if (state.pos >= cfg.winLine || state.pos <= 100 - cfg.winLine) reveal(ctx);
  else flushEmit(ctx);
}

function handleEnter(ctx, msg) {
  const { state, cfg } = ctx;
  if (!cfg.enterHint) return;
  if (state.status !== 'joining' && state.status !== 'tugging') return;
  feed(ctx, '👋', `${userName(msg)} 进入了直播间，发 红 / 蓝 参战！`, false);
  emitSoon(ctx);
}

/* ═══════════════ 弹幕处理 ═══════════════ */

function handleDanmu(ctx, msg) {
  const { state, cfg } = ctx;
  if (!msg || msg.event !== 'chat' || !msg.text) return false;
  if (!roomAllowed(ctx, msg)) return false;

  if (state.status === 'joining') {
    const side = parseSide(msg.text);
    if (!side) return false; // 非参战弹幕：不消费
    joinTeam(ctx, msg, side);
    flushEmit(ctx);
    return true;
  }
  if (state.status === 'tugging') {
    const side = parseSide(msg.text);
    if (!side) return false;
    doPull(ctx, msg, side);
    return true;
  }
  if (state.status === 'sieging') {
    siegeAttack(ctx, msg); // 守城：任意弹幕都是攻击
    return true;
  }
  if (state.status === 'shooting') {
    // 枪战：弹幕发射子弹；带 红/蓝 字样=指定阵营开火，否则自动补到人少的一队
    if (!roomAllowed(ctx, msg)) return false;
    const side = parseSide(msg.text) || (state.teams.red.members.size <= state.teams.blue.members.size ? 'red' : 'blue');
    const uid = userKey(msg);
    const now = Date.now();
    const last = state.lastActAt.get(uid) || 0;
    if (now - last < cfg.rateLimitSec * 1000) return false;
    state.lastActAt.set(uid, now);
    const m = joinTeam(ctx, msg, side);
    m.pulls += 1; // 发射次数并入贡献
    fireBullet(ctx, msg, side, 1);
    return true;
  }
  return false;
}

/* ═══════════════ 控制指令 ═══════════════ */

function handleAction(ctx, action, payload = {}) {
  const { state, cfg, emit } = ctx;
  switch (action) {
    case 'start':
    case 'next':
      if (state.status === 'joining' || state.status === 'tugging') return { ok: false, msg: '本轮进行中' };
      state.pausedFrom = null; // 暂停中直接开局：丢弃暂停簿记，从全新一轮开始
      startRound(ctx);
      return { ok: true, msg: `第 ${state.roundNo} 局开始（组队 ${cfg.joinSec}s + 对抗 ${cfg.tugSec}s）` };
    case 'pause':
      if (['joining', 'tugging', 'sieging', 'shooting'].includes(state.status)) {
        ctx.clearTimers('round');
        ctx.clearTimers('monster');
        ctx.clearTimers('shooter');
        state.pausedFrom = state.status;
        state.pausedRemain = Math.max(0, state.deadline - Date.now());
        state.status = 'paused';
        emit.state();
        return { ok: true, msg: '已暂停（倒计时冻结）' };
      }
      return { ok: false, msg: '当前无进行中的对局' };
    case 'resume':
      if (state.status !== 'paused') return { ok: false, msg: '当前未暂停' };
      state.status = state.pausedFrom || 'tugging';
      state.deadline = Date.now() + (state.pausedRemain || 0);
      schedulePhase(ctx);
      if (state.status === 'sieging') scheduleMonsterAttack(ctx);
      if (state.status === 'shooting') scheduleShooter(ctx);
      emit.state();
      return { ok: true, msg: '已继续' };
    case 'reveal':
      if (state.status === 'tugging') { reveal(ctx, true); return { ok: true, msg: '已提前结算' }; }
      if (state.status === 'sieging') { revealSiege(ctx, state.monster.hp <= 0, 'forced'); return { ok: true, msg: '已提前结算守城战' }; }
      if (state.status === 'shooting') {
        revealShoot(ctx, state.shooter.redHp === state.shooter.blueHp ? null : (state.shooter.redHp > state.shooter.blueHp ? 'red' : 'blue'), 'forced');
        return { ok: true, msg: '已提前结算枪战' };
      }
      if (state.status === 'joining') { beginTug(ctx); return { ok: true, msg: '已跳过组队，直接开战' }; }
      return { ok: false, msg: '当前无可结算的对局' };
    case 'end':
      ctx.clearTimers('round');
      ctx.clearTimers('monster');
      ctx.clearTimers('shooter');
      state.status = 'idle';
      state.result = null;
      emit.state();
      return { ok: true, msg: '已结束，回到空闲' };
    case 'setTeams': {
      if (payload.redName) { cfg.teamRedName = String(payload.redName).slice(0, 12); state.teams.red.name = cfg.teamRedName; }
      if (payload.blueName) { cfg.teamBlueName = String(payload.blueName).slice(0, 12); state.teams.blue.name = cfg.teamBlueName; }
      ctx.persistConfig(cfg);
      emit.state();
      return { ok: true, msg: '阵营名已更新' };
    }
    case 'setMult': {
      const clamp = v => Math.min(3, Math.max(0.2, Number(v) || 1));
      cfg.redMult = clamp(payload.redMult ?? cfg.redMult);
      cfg.blueMult = clamp(payload.blueMult ?? cfg.blueMult);
      ctx.persistConfig(cfg);
      emit.state();
      return { ok: true, msg: `推力系数已更新（红 ×${cfg.redMult} / 蓝 ×${cfg.blueMult}）` };
    }
    case 'simulateDanmu': {
      const text = String(payload.text || '').trim();
      if (!text) return { ok: false, msg: '请输入要模拟的弹幕（如 红 / 蓝）' };
      const name = String(payload.name || '模拟观众').trim() || '模拟观众';
      handleDanmu(ctx, { event: 'chat', user: { id: 'sim_' + name, displayId: name, name, avatar: '' }, text, roomId: '' });
      flushEmit(ctx);
      return { ok: true, msg: `已模拟「${name}」发送：${text}` };
    }
    case 'simulateLike': {
      const count = Math.max(1, parseInt(payload.count, 10) || 10);
      const name = String(payload.name || '模拟观众').trim() || '模拟观众';
      handleLike(ctx, { event: 'like', user: { id: 'sim_' + name, displayId: name, name, avatar: '' }, likeCount: count, roomId: '' });
      flushEmit(ctx);
      return { ok: true, msg: `已模拟「${name}」点赞 ×${count}` };
    }
    case 'setRoomFilter': {
      cfg.allowedRoomId = String(payload.roomId || '').trim();
      ctx.persistConfig(cfg);
      emit.state();
      return { ok: true, msg: '直播间筛选已更新' };
    }
    case 'newSeason': {
      const prev = seasonStore.summary(1);
      const no = seasonStore.newSeason();
      feed(ctx, '🏆', `第 ${prev.seasonNo} 赛季收官！功勋榜已归档，第 ${no} 赛季开启，重新出征！`, true);
      ctx.emit.notice(`已开启第 ${no} 赛季（旧季功勋已归档）`);
      flushEmit(ctx);
      return { ok: true, msg: `已开启第 ${no} 赛季（第 ${prev.seasonNo} 赛季已归档）` };
    }
    case 'config': {
      const allowed = ['joinSec', 'tugSec', 'resultShowSec', 'autoNextRound', 'rateLimitSec', 'winLine',
        'backwater', 'backwaterGap', 'backwaterMult', 'likesPerEnergy', 'surgeThreshold', 'surgePush',
        'likeCapPerEvent', 'giftEnabled', 'giftPush', 'winScore', 'loseScore', 'mvpScores', 'joinBonus',
        'teamRedName', 'teamBlueName', 'enterHint', 'mode', 'siegeEveryRounds',
        'shooterHp', 'shooterTravelMs', 'giftBulletStrength', 'shooterBulletCap', 'shooterTickMs',
        'autoFire', 'autoFireBaseMs', 'shooterBossHp', 'bossAtkSec', 'bossAtk',
        'monsterHp', 'monsterAtkSec', 'monsterAtk', 'wallHp', 'siegeSurgeDamage', 'siegeWinScore', 'siegeLoseScore',
        ...BC_CFG_KEYS,                            // aiBroadcast/aiApiUrl/aiApiKey/aiModel/aiTimeoutSec/bcAutoSpeak/bcEnabled
        'allowedRoomId'];
      for (const k of allowed) if (payload[k] !== undefined) cfg[k] = payload[k];
      if (cfg.teamRedName) state.teams.red.name = cfg.teamRedName;
      if (cfg.teamBlueName) state.teams.blue.name = cfg.teamBlueName;
      ctx.persistConfig(cfg);
      ctx.log('INFO', '[redblue config]', cfg);
      emit.state();
      return { ok: true, msg: '配置已更新' };
    }
    default:
      return { ok: false, msg: `未知动作: ${action}` };
  }
}

/* ═══════════════ 对外状态 ═══════════════ */

function publicState(ctx) {
  const { state, cfg } = ctx;
  return {
    status: state.status,
    pausedFrom: state.pausedFrom,
    roundNo: state.roundNo,
    mode: state.mode,
    pos: Math.round(state.pos * 10) / 10,
    red: teamSummary(ctx, 'red'),
    blue: teamSummary(ctx, 'blue'),
    // ── PVE 守城 ──
    monster: state.monster ? { name: state.monster.name, hp: state.monster.hp, hpMax: state.monster.hpMax } : null,
    wall: state.wall ? { hp: state.wall.hp, hpMax: state.wall.hpMax } : null,
    boss: state.boss ? { name: state.boss.name, hp: state.boss.hp, hpMax: state.boss.hpMax } : null,
    siegeEnergy: Math.round(state.siegeEnergy),
    surges: state.surges,
    // ── 弹幕枪战 ──
    shooter: state.shooter ? {
      redHp: state.shooter.redHp, blueHp: state.shooter.blueHp,
      blitz: { red: state.shooter.blitz.red, blue: state.shooter.blitz.blue },
      fired: { red: state.shooter.fired.red, blue: state.shooter.fired.blue },
      bullets: state.shooter.bullets.map(b => ({
        id: b.id, side: b.side, strength: b.strength,
        frac: Math.min(1, b.frac),   // 服务端累计进度（含加速），客户端跟随
      })),
    } : null,
    series: state.series,
    streak: state.streak,
    feed: state.feed.slice(-FEED_MAX),
    result: state.result,
    history: state.history.slice(0, 20),
    deadline: state.deadline,
    joinSec: cfg.joinSec,
    tugSec: cfg.tugSec,
    resultShowSec: cfg.resultShowSec,
    leaderboard: ctx.topList(50),
    season: seasonStore.summary(10),
    cfg: {
      joinSec: cfg.joinSec, tugSec: cfg.tugSec, resultShowSec: cfg.resultShowSec,
      autoNextRound: cfg.autoNextRound, rateLimitSec: cfg.rateLimitSec,
      winLine: cfg.winLine, backwater: cfg.backwater, backwaterGap: cfg.backwaterGap,
      backwaterMult: cfg.backwaterMult, redMult: cfg.redMult, blueMult: cfg.blueMult,
      likesPerEnergy: cfg.likesPerEnergy, surgeThreshold: cfg.surgeThreshold, surgePush: cfg.surgePush,
      giftEnabled: cfg.giftEnabled, giftPush: cfg.giftPush,
      winScore: cfg.winScore, loseScore: cfg.loseScore, mvpScores: cfg.mvpScores, joinBonus: cfg.joinBonus,
      teamRedName: cfg.teamRedName, teamBlueName: cfg.teamBlueName, enterHint: cfg.enterHint,
      mode: cfg.mode, siegeEveryRounds: cfg.siegeEveryRounds,
      shooterHp: cfg.shooterHp, shooterTravelMs: cfg.shooterTravelMs, giftBulletStrength: cfg.giftBulletStrength,
      autoFire: cfg.autoFire !== false, autoFireBaseMs: cfg.autoFireBaseMs,
      shooterBossHp: cfg.shooterBossHp, bossAtkSec: cfg.bossAtkSec, bossAtk: cfg.bossAtk,
      monsterHp: cfg.monsterHp, monsterAtkSec: cfg.monsterAtkSec, monsterAtk: cfg.monsterAtk,
      wallHp: cfg.wallHp, siegeSurgeDamage: cfg.siegeSurgeDamage,
      siegeWinScore: cfg.siegeWinScore, siegeLoseScore: cfg.siegeLoseScore,
      allowedRoomId: cfg.allowedRoomId || '',
    },
    // AI 播报（通用播报中心）：bc/bcSlots/bcCfg 片段在顶层，密钥明文绝不下发
    ...BC(ctx).publicState(),
  };
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
