/**
 * ============================================================================
 * host/server.js — 弹幕游戏中心 · 宿主框架（主播台框架）
 * ============================================================================
 * 【职责】只做框架，不含任何游戏的逻辑：
 *   1. 扫描 games/<id>/index.js 注册游戏（插件式，新增游戏零改宿主）
 *   2. HTTP 静态伺服：框架页(host/public)、公共资源(common/public)、
 *      各游戏前端页面(games/<id>/public/**)
 *   3. SSE 状态推送（按 game 过滤，game=* 订阅全部）
 *   4. 控制指令转发 POST /api/control
 *   5. WebSocket 接收 DanmuDesk 弹幕转发，分发给激活游戏
 *
 * 【目录约定】
 *   danmu-games/
 *   ├── host/            本文件 + 框架前端 public/
 *   ├── common/          公共模块（leaderboard/logger/前端 base.css+core.js）
 *   ├── games/<id>/      每个游戏自包含：index.js(后端) + public/(control/stage 页面)
 *   └── data/            全局排行榜 leaderboard.json
 *
 * 【界面】
 *   主播台（框架壳+iframe 嵌各游戏控制台）: http://127.0.0.1:18080/control.html
 *   展示屏:  http://127.0.0.1:18080/games/<id>/public/stage.html?game=<id>
 *   弹幕入口: ws://127.0.0.1:18080/danmu（DanmuDesk「转发」填此地址）
 * ============================================================================
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');            // danmu-games/
const { SharedLeaderboard } = require(path.join(ROOT, 'common', 'leaderboard'));
const { createLogger } = require(path.join(ROOT, 'common', 'logger'));
const { WebSocketServer } = require('ws');

// ───────────────────── 宿主配置 ─────────────────────

const HOST_CFG_PATH = path.join(__dirname, 'host.json');
function loadHostConfig() {
  try { return JSON.parse(fs.readFileSync(HOST_CFG_PATH, 'utf8')); }
  catch { console.warn('[host] host.json 读取失败，使用默认值'); return {}; }
}
const hostCfg = {
  port: 18080,
  host: '0.0.0.0',
  ...loadHostConfig(),
};
if (process.env.PORT) hostCfg.port = parseInt(process.env.PORT, 10) || hostCfg.port;
if (process.env.HOST) hostCfg.host = process.env.HOST;

// ───────────────────── 日志 ─────────────────────

const logger = createLogger(path.join(ROOT, 'log'));
const info = logger.info;
const warn = logger.warn;

// ───────────────────── SSE 客户端（按游戏过滤；game=* 收全部） ─────────────────────

const sseClients = new Set(); // {res, game}

function broadcast(gameId, event, data) {
  // 统一附带该游戏的展示屏主题（前端 core.js 收到后调用 applyTheme）
  const payloadData = (data && typeof data === 'object')
    ? { ...data, __game: gameId, theme: themeOf(gameId) }
    : data;
  const payload = `event: ${event}\ndata: ${JSON.stringify(payloadData)}\n\n`;
  for (const c of sseClients) {
    if (c.game === '*' || !c.game || c.game === gameId) {
      // 已断开/已结束的连接立即摘除：向已 end 的响应写入会以异步 error 事件形式爆进程
      // （ERR_STREAM_WRITE_AFTER_END 不走同步 try/catch，兜底见 /api/events 的 res.on('error')）
      if (c.res.destroyed || c.res.writableEnded) { sseClients.delete(c); continue; }
      // 慢客户端保护：积压超过 1MB 视为浏览器标签被节流/后台，直接断开让其自动重连
      // （EventSource 重连后会收到全量 state，不会漏状态；防止 Node 内存被无声吞噬）
      if (c.res.writableLength > 1 << 20) {
        sseClients.delete(c);   // 先摘除，防止 end() 之后的下一轮广播写到已结束的流
        try { c.res.end(); } catch {}
        continue;
      }
      try { c.res.write(payload); } catch { sseClients.delete(c); }
    }
  }
}

// ───────────────────── 游戏注册表 ─────────────────────

/** 扫描 games/ 目录，加载每个游戏的模块 */
function scanGames() {
  const gamesDir = path.join(ROOT, 'games');
  const found = [];
  if (!fs.existsSync(gamesDir)) return found;
  for (const name of fs.readdirSync(gamesDir)) {
    const modPath = path.join(gamesDir, name, 'index.js');
    if (!fs.existsSync(modPath)) continue;
    try {
      const mod = require(modPath);
      if (!mod.MANIFEST || !mod.MANIFEST.id) continue;
      found.push({
        id: mod.MANIFEST.id,
        name: mod.MANIFEST.name,
        icon: mod.MANIFEST.icon || '🎮',
        desc: mod.MANIFEST.desc || '',
        liveStatuses: mod.MANIFEST.liveStatuses || ['gambling', 'playing'],
        dir: path.join(gamesDir, name),
        mod,
      });
      info(`[registry] 注册游戏: ${mod.MANIFEST.id}（${mod.MANIFEST.name}）`);
    } catch (e) {
      warn(`[registry] 加载 ${name} 失败:`, e.message);
    }
  }
  return found;
}
const games = scanGames();
const gameMap = new Map(games.map(g => [g.id, g]));
if (!games.length) warn('[registry] games/ 下没有可注册的游戏');

/** 当前激活游戏（弹幕分发给它）；持久化到 host.json */
let activeGame = (hostCfg.activeGame && gameMap.has(hostCfg.activeGame))
  ? hostCfg.activeGame
  : (games[0] ? games[0].id : null);

/* ───────────── 展示屏主题（宿主按游戏托管，游戏模块无需关心） ─────────────
   themes: { <gameId>: 'default'|'tech'|'festive'|'cyber'|'aurora'|'plain' }
   主题只作用于该游戏的展示屏；主播台界面不换肤（见 core.js applyTheme）。
   新增主题：必须同步加进 VALID_THEMES，否则 setTheme 会被校验拒绝。 */
const VALID_THEMES = new Set(['default', 'tech', 'festive', 'cyber', 'aurora', 'lava', 'graphite', 'plain', 'sky', 'cream', 'mint']);
const themes = (hostCfg.themes && typeof hostCfg.themes === 'object') ? { ...hostCfg.themes } : {};
for (const g of games) if (!themes[g.id]) themes[g.id] = 'default';
/** 主题对外键名：gameId → theme；缺省返回 'default' */
function themeOf(gameId) { return themes[gameId] || 'default'; }

/* ───────────── 观众时刻演出风格（按游戏托管，主播台「演出风格」选择器切换） ─────────────
   momentSkins: { <gameId>: 'aurora'|'neon'|'meteor'|'scroll' }，缺省 aurora（流光）。
   与 common/public/core.js 的 MOMENT_SKINS 列表保持同步。 */
const VALID_MOMENT_SKINS = new Set(['aurora', 'neon', 'meteor', 'scroll']);
const momentSkins = (hostCfg.momentSkins && typeof hostCfg.momentSkins === 'object') ? { ...hostCfg.momentSkins } : {};
function momentSkinOf(gameId) { return VALID_MOMENT_SKINS.has(momentSkins[gameId]) ? momentSkins[gameId] : 'aurora'; }

/** 游戏启用开关（关闭后不处理弹幕、清理定时器，导航显示已关闭） */
const enabledMap = {};
for (const g of games) enabledMap[g.id] = !(hostCfg.enabled && hostCfg.enabled[g.id] === false);

/** 宿主配置统一落盘（activeGame / themes / enabled / momentSkins 同一文件原子持久化） */
function persistHost() {
  try {
    fs.writeFileSync(HOST_CFG_PATH, JSON.stringify({ ...hostCfg, activeGame, themes, enabled: enabledMap, momentSkins }, null, 2));
  } catch (e) { warn('[host] 配置落盘失败:', e.message); }
}

function persistActiveGame() {
  persistHost();
}

function persistThemes() {
  persistHost();
}

// ───────────────────── 全局共享排行榜 ─────────────────────

const leaderboard = new SharedLeaderboard(path.join(ROOT, 'data', 'leaderboard.json'), logger);
for (const g of games) leaderboard.registerGame(g.mod.MANIFEST);
leaderboard.load();

// ───────────────────── 游戏实例 ─────────────────────

function createGameInstance(meta) {
  const { mod } = meta;
  const gameDir = meta.dir;
  const state = mod.createState();
  const cfg = { ...mod.CFG_DEFAULTS };
  // 游戏配置持久化：games/<id>/config.json
  const cfgPath = path.join(gameDir, 'config.json');
  try {
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    Object.assign(cfg, saved);
  } catch {}
  const lb = leaderboard; // 全局共享榜

  const timers = new Map(); // group -> Set<timeoutIds>
  const instance = {
    id: meta.id, meta, mod, state, cfg, lb,
    timers,
    enabled: enabledMap[meta.id] !== false,
    on: { state: [], guess: [], notice: [] },
    engine: mod.engineHooks || (() => { try { return require(path.join(gameDir, 'engine.js')); } catch { return null; } })(),
  };

  // ctx 注入游戏逻辑
  const ctx = {
    meta, game: instance, state, cfg, lb,
    gameDir, engine: instance.engine,
    log: (level, ...a) => logger.log(level, ...a),
    emit: {
      state: () => broadcast(instance.id, 'state', mod.publicState(ctx)),
      guess: (entry) => broadcast(instance.id, 'guess', entry),
      notice: (text) => broadcast(instance.id, 'notice', { text, ts: Date.now() }),
    },
    setTimer: (group, fn, ms) => {
      const id = setTimeout(() => { fn(); instance.timers.get(group)?.delete(id); }, ms);
      if (!instance.timers.has(group)) instance.timers.set(group, new Set());
      instance.timers.get(group).add(id);
      return id;
    },
    clearTimers: (group) => {
      if (group === undefined) {
        for (const set of instance.timers.values()) for (const id of set) clearTimeout(id);
        instance.timers.clear();
      } else {
        const set = instance.timers.get(group);
        if (set) { for (const id of set) clearTimeout(id); instance.timers.delete(group); }
      }
    },
    persistConfig: (newCfg) => {
      try { fs.writeFileSync(cfgPath, JSON.stringify(newCfg, null, 2)); } catch (e) { warn('[config] 写盘失败:', e.message); }
    },
    // 排行榜查询：各游戏拿自己的专属榜（仅含玩过该游戏的玩家，按该游戏自己的字段排序：
    // wins（胜场/MVP 次数）→ score（该玩法积分）→ floors）；award 自动携带当前实例的游戏 id 写入对应玩法字段
    topList: (n) => leaderboard.gameTopList(meta.id, n),
    award: (entry, score, floors) => leaderboard.award(meta.id, entry, score, floors),
    // 只加分不加胜场（弹幕数独按格计分等高频场景；字段未注册时静默忽略）
    awardScore: (entry, score) => leaderboard.awardScore(meta.id, entry, score),
  };
  instance.ctx = ctx;
  return instance;
}

const instances = new Map(); // gameId -> instance（含 .ctx/.mod/.state）
for (const g of games) instances.set(g.id, createGameInstance(g));

function currentInstance() {
  return instances.get(activeGame) || [...instances.values()][0];
}

// ───────────────────── 弹幕事件分发（真实 WebSocket 与模拟共用一条管线） ─────────────────────

/** 把一条 DanmuDesk 格式消息分发给目标游戏（msg.game 指定游戏，缺省给激活游戏） */
function dispatchDanmuEvent(msg) {
  if (!msg || !msg.event) return;
  // 只处理游戏能消费的事件：chat（弹幕）、like（点赞）、gift（礼物）、enter（进场）、follow（关注）
  if (msg.event === 'chat' && !msg.text) return;
  if (!['chat', 'like', 'gift', 'enter', 'follow'].includes(msg.event)) return;

  const targets = msg.game ? [msg.game] : [activeGame];
  for (const gid of targets) {
    const inst = instances.get(gid);
    if (!inst) continue;
    if (inst.enabled === false) continue;   // 已关闭的游戏：不处理任何事件
    try {
      // 各事件走独立接口（可选实现；未实现的游戏直接忽略）
      if (msg.event === 'like') {
        if (typeof inst.mod.handleLike === 'function') inst.mod.handleLike(inst.ctx, msg);
      } else if (msg.event === 'gift') {
        if (typeof inst.mod.handleGift === 'function') inst.mod.handleGift(inst.ctx, msg);
      } else if (msg.event === 'enter') {
        if (typeof inst.mod.handleEnter === 'function') inst.mod.handleEnter(inst.ctx, msg);
      } else if (msg.event === 'follow') {
        if (typeof inst.mod.handleFollow === 'function') inst.mod.handleFollow(inst.ctx, msg);
      } else {
        inst.mod.handleDanmu(inst.ctx, msg);
      }
    } catch (e) { warn(`[danmu] 游戏 ${gid} 处理 ${msg.event} 异常:`, e.message); }

    // 进场/关注/送礼 → 通用 AI 播报（各游戏 slots 自动并入 enter/follow/gift，主播台可逐点开关）
    if (msg.event === 'enter' || msg.event === 'follow' || msg.event === 'gift') {
      try { speakAudience(gid, msg); } catch (e) { warn('[bc] 观众事件播报异常:', e.message); }
    }

    // 进场/关注/送礼 → 广播 moment 演出事件（展示屏侧边如画横幅；展示层独立于游戏是否实现对应接口）
    if (msg.event !== 'chat' && msg.event !== 'like') {
      try { broadcastMoment(gid, msg); } catch (e) { warn('[moment] 广播异常:', e.message); }
    }
  }
}

/** 观众事件 AI 播报：走该游戏的播报中心（开关/限流/模板由 BC 统一处理）
 * follow 整场游戏只播一次（与「关注效果只生效一次」对齐）；enter/gift 仍按 minGapSec 限流。 */
function speakAudience(gameId, msg) {
  const inst = instances.get(gameId);
  if (!inst || !inst.ctx) return;
  const bc = inst.ctx._bc;
  if (!bc || typeof bc.speak !== 'function') return;
  const user = (msg.user && msg.user.name) || '观众';
  if (msg.event === 'enter') {
    bc.speak('enter', { user }).catch(() => {});
  } else if (msg.event === 'follow') {
    if (inst._followSpoken) return;
    inst._followSpoken = true;
    bc.speak('follow', { user }).catch(() => {});
  } else if (msg.event === 'gift') {
    const giftCount = Math.max(1, (Number(msg.giftCount) || 1) * (Number(msg.repeatCount) || 1));
    bc.speak('gift', { user, giftName: msg.giftName || '礼物', giftCount }).catch(() => {});
  }
}

/** 组装 moment 负载：观众昵称/头像 + 礼物信息 + 其在本玩法的排名/得分（排行榜可查时附带） */
function broadcastMoment(gameId, msg) {
  const uid = (msg.user && (msg.user.id || msg.user.displayId)) || (msg.user && msg.user.name) || '';
  let gameInfo = null;
  if (uid) {
    const rec = leaderboard.gameTopList(gameId).find(r => r.key === uid);
    if (rec) gameInfo = { rank: rec.rank, score: rec.totalScore };
  }
  broadcast(gameId, 'moment', {
    type: msg.event,                       // enter | follow | gift
    skin: momentSkinOf(gameId),            // 演出风格：展示屏据此切换卡片外观
    user: {
      name: (msg.user && msg.user.name) || '观众',
      avatar: (msg.user && msg.user.avatar) || '',
    },
    giftName: msg.giftName || '',
    giftCount: (Number(msg.giftCount) || 1) * (Number(msg.repeatCount) || 1),
    giftImage: (typeof msg.giftImage === 'string' && msg.giftImage.startsWith('http')) ? msg.giftImage : '',
    gameInfo,                              // { rank, score } | null —— 观众在本玩法的成绩
    ts: Date.now(),
  });
}

/* ───────────── 宿主级模拟观众动作（主播台「接入与模拟」面板共用） ─────────────
   直接构造 DanmuDesk 格式消息走 dispatchDanmuEvent，与真实弹幕完全同一条路径，
   新游戏无需写任何 simulate 动作即可被模拟联调。 */
const MOCK_ACTIONS = {
  mockChat: { event: 'chat', label: '弹幕' },
  mockLike: { event: 'like', label: '点赞' },
  mockGift: { event: 'gift', label: '送礼' },
  mockEnter: { event: 'enter', label: '进场' },
  mockFollow: { event: 'follow', label: '关注' },
};

function handleMockAction(game, cmd) {
  const def = MOCK_ACTIONS[cmd.action];
  const name = String(cmd.name || '').trim() || '模拟观众';
  const text = String(cmd.text || '').trim();
  if (cmd.action === 'mockChat' && !text) return { ok: false, msg: '请输入要模拟的弹幕文本' };

  const msg = {
    event: def.event,
    user: { id: 'sim_' + name, displayId: 'sim_' + name, name, avatar: '' },
    roomId: '',            // 房间号留空：不被各游戏的直播间筛选拦截，模拟一定可达
    ts: Date.now(),
    __mock: true,
    game,                  // 定向发给主播台当前打开的游戏（不依赖激活游戏）
  };
  let detail = '';
  if (def.event === 'chat') { msg.text = text; detail = `「${text}」`; }
  if (def.event === 'like') {
    msg.likeCount = Math.max(1, parseInt(cmd.count, 10) || 1);
    detail = `×${msg.likeCount}`;
  }
  if (def.event === 'gift') {
    msg.giftName = String(cmd.giftName || '').trim() || '小心心';
    msg.giftCount = Math.max(1, parseInt(cmd.giftCount, 10) || 1);
    msg.repeatCount = Math.max(1, parseInt(cmd.repeatCount, 10) || 1);
    detail = `${msg.giftName} ×${msg.giftCount}`;
  }
  dispatchDanmuEvent(msg);
  info(`[mock] 已模拟「${name}」${def.label} ${detail}（→ ${game}）`);
  return { ok: true, msg: `已模拟「${name}」${def.label} ${detail}` };
}

// ───────────────────── HTTP ─────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/** 静态文件伺服（带扩展名白名单） */
function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!MIME[ext]) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

function onHttpRequest(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'x'}`);

  if (u.pathname === '/health') {
    const inst = currentInstance();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      games: games.map(g => ({ id: g.id, name: g.name })),
      activeGame,
      status: inst ? inst.state.status : null,
      roundNo: inst ? inst.state.roundNo : 0,
      danmuClients,
      uptime: Math.floor((Date.now() - process.uptime() * 1000) / 1000),
    }));
    return;
  }

  // 游戏列表（供主播台左侧导航）
  if (u.pathname === '/api/games' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      games: games.map(g => {
        const inst = instances.get(g.id);
        return {
          id: g.id, name: g.name, icon: g.icon, desc: g.desc,
          status: inst ? inst.state.status : 'idle',
          running: inst ? g.liveStatuses.includes(inst.state.status) : false,
          enabled: inst ? inst.enabled !== false : true,   // 关闭状态：导航显示已关闭
          momentSkin: momentSkinOf(g.id),                 // 观众时刻演出风格（主播台选择器回填）
          // 运行中状态集合原样下发：主播台导航点据此分类（进行中/暂停/结算中）
          liveStatuses: g.liveStatuses,
          roundNo: inst ? inst.state.roundNo : 0,
          // 各游戏前端页面（框架 iframe / 展示屏跳转用）
          controlPage: `/games/${g.id}/public/control.html`,
          stagePage: `/games/${g.id}/public/stage.html`,
        };
      }),
      activeGame,
    }));
    return;
  }

  // SSE 事件流（?game=<id> 过滤；game=* 或 all 订阅全部）
  if (u.pathname === '/api/events' && req.method === 'GET') {
    const game = u.searchParams.get('game') || (games[0] && games[0].id) || '*';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 写任何数据前先挂 error 监听：客户端在初始推送瞬间断开时，write 错误走异步事件而非同步 catch
    res.on('error', () => {});   // 正式摘除在下方 client 注册处（sseClients.delete）
    if (game === '*' || game === 'all') {
      for (const inst of instances.values()) {
        try { res.write(`event: state\ndata: ${JSON.stringify({ ...inst.mod.publicState(inst.ctx), __game: inst.id, theme: themeOf(inst.id) })}\n\n`); } catch {}
      }
    } else {
      const inst = instances.get(game);
      if (inst) {
        try {
          const evt = `event: state\ndata: ${JSON.stringify({ ...inst.mod.publicState(inst.ctx), theme: themeOf(inst.id) })}\n\n`;
          res.write(evt);
        } catch (e) { warn('[sse] 初始推送异常:', e.message); }
      } else {
        try { res.write(`event: notice\ndata: ${JSON.stringify({ text: `未知游戏: ${game}`, ts: Date.now() })}\n\n`); } catch {}
      }
    }
    const client = { res, game };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    // 安全兜底：向已断开/已结束的响应写入时，错误以异步 'error' 事件发出（不走同步 catch），
    // 不挂监听会变成未处理异常直接崩掉宿主进程；这里静默摘除即可，EventSource 会自动重连
    res.on('error', () => sseClients.delete(client));
    const keep = setInterval(() => {
      if (res.destroyed || res.writableEnded) { clearInterval(keep); sseClients.delete(client); return; }
      try { res.write(': ping\n\n'); } catch { clearInterval(keep); sseClients.delete(client); }
    }, 15000);
    req.on('close', () => clearInterval(keep));
    return;
  }

  // 控制接口
  if (u.pathname === '/api/control' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    // 异步：允许游戏模块返回 Promise（如 AI 播报这类需要等生成结果的动作）
    req.on('end', async () => {
      let cmd = {};
      try { cmd = JSON.parse(body || '{}'); } catch {}
      const game = cmd.game || activeGame;
      const inst = instances.get(game);
      if (!inst) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: `未知游戏: ${game}` }));
        return;
      }
      let r;
      try {
        // 全局动作：switchGame 切换激活游戏
        if (cmd.action === 'switchGame') {
          if (!instances.has(cmd.game)) r = { ok: false, msg: `未知游戏: ${cmd.game}` };
          else { activeGame = cmd.game; persistActiveGame(); r = { ok: true, msg: `已切换到「${inst.meta.name}」` }; }
        } else if (cmd.action === 'setTheme') {
          // 宿主级动作：按游戏保存展示屏主题（游戏模块无需实现该动作）
          const t = String(cmd.theme || 'default');
          if (!VALID_THEMES.has(t)) r = { ok: false, msg: `未知主题: ${t}` };
          else {
            themes[game] = t;
            persistThemes();
            info(`[theme] 「${inst.meta.name}」展示屏主题 → ${t}`);
            r = { ok: true, msg: `「${inst.meta.name}」展示屏主题已切换` };
          }
        } else if (MOCK_ACTIONS[cmd.action]) {
          // 宿主级动作：模拟观众事件（弹幕/点赞/送礼/进场/关注），走与真实弹幕相同的分发管线，
          // 所有游戏零改动即可被模拟（各游戏按需实现 handleXxx，未实现的自然忽略）
          r = handleMockAction(game, cmd);
        } else if (cmd.action === 'setMomentSkin') {
          // 宿主级动作：按游戏保存观众时刻演出风格（展示屏卡片外观）
          const s = String(cmd.skin || 'aurora');
          if (!VALID_MOMENT_SKINS.has(s)) r = { ok: false, msg: `未知演出风格: ${s}` };
          else {
            momentSkins[game] = s;
            persistHost();
            info(`[moment] 「${inst.meta.name}」演出风格 → ${s}`);
            r = { ok: true, msg: `「${inst.meta.name}」演出风格已切换` };
          }
        } else if (cmd.action === 'setGameEnabled') {
          // 宿主级动作：关闭 = 停止弹幕分派 + 清理该游戏全部定时器；开启 = 恢复分派
          const target = instances.get(String(cmd.game || ''));
          if (!target) r = { ok: false, msg: `未知游戏: ${cmd.game}` };
          else {
            const next = cmd.enabled !== false;
            if (target.enabled === next) {
              r = { ok: true, msg: `「${target.meta.name}」已是${next ? '开启' : '关闭'}状态` };
            } else {
              target.enabled = next;
              enabledMap[target.id] = next;
              persistHost();
              if (!next) {
                try { target.mod.clearGameTimers && target.mod.clearGameTimers(target.ctx); } catch (e) { warn(`[power] 清理 ${target.id} 定时器异常:`, e.message); }
              }
              info(`[power] 「${target.meta.name}」${next ? '开启' : '关闭'}（${next ? '恢复弹幕处理' : '已清理定时器、停止弹幕处理'}）`);
              try { broadcast(target.id, 'state', target.mod.publicState(target.ctx)); } catch {}
              r = { ok: true, msg: `「${target.meta.name}」已${next ? '开启' : '关闭'}${next ? '' : '，不再执行（弹幕/定时器已停）'}` };
            }
          }
        } else {
          r = inst.mod.handleAction(inst.ctx, cmd.action, cmd) || { ok: false, msg: '无返回' };
          // 游戏模块返回 Promise（异步动作）时等它落地，保证 ok/msg 能正确回给主播台
          if (r && typeof r.then === 'function') r = await r;
        }
      } catch (e) {
        warn(`[control] 游戏 ${game} 动作 ${cmd.action} 异常:`, e.message);
        r = { ok: false, msg: `处理异常: ${e.message}` };
      }
      let stateOut;
      try { stateOut = r.state || inst.mod.publicState(inst.ctx); } catch (e) { warn('[control] publicState 异常:', e.message); stateOut = null; }
      // 统一注入当前游戏的展示屏主题（供 SSE/前端 applyTheme 使用）
      try { if (stateOut && typeof stateOut === 'object') stateOut.theme = themeOf(game); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: r.ok, msg: r.msg, state: stateOut }));
    });
    return;
  }

  /* ───────── 静态路由 ───────── */

  // 入口：主播台框架壳
  if (u.pathname === '/') {
    redirect(res, '/control.html');
    return;
  }
  if (u.pathname === '/control.html') {
    serveFile(res, path.join(__dirname, 'public', 'control.html'));
    return;
  }
  // 框架自身资源
  if (u.pathname.startsWith('/host-assets/')) {
    serveFile(res, path.join(__dirname, 'public', u.pathname.slice('/host-assets/'.length)));
    return;
  }
  // 公共资源（base.css / core.js）
  if (u.pathname.startsWith('/common/')) {
    serveFile(res, path.join(ROOT, 'common', 'public', u.pathname.slice('/common/'.length)));
    return;
  }
  // 通用素材资源（如 res/礼物资源/小心心_1.png）：/res/<file...> → res/<file...>
  if (u.pathname.startsWith('/res/')) {
    const resDir = path.join(ROOT, 'res');
    const rest2 = decodeURIComponent(u.pathname.slice('/res/'.length));
    const fp2 = path.normalize(path.join(resDir, rest2));
    if (!fp2.startsWith(resDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    serveFile(res, fp2);
    return;
  }
  // 各游戏前端页面：/games/<id>/public/<file...> → games/<id>/public/<file...>
  const gm = u.pathname.match(/^\/games\/([A-Za-z0-9_-]+)\/public\/(.+)$/);
  if (gm) {
    const gid = gm[1];
    const rest = decodeURIComponent(gm[2]);
    if (!gameMap.has(gid)) { res.writeHead(404); res.end('未知游戏'); return; }
    const baseDir = path.join(gameMap.get(gid).dir, 'public');
    const filePath = path.normalize(path.join(baseDir, rest));
    if (!filePath.startsWith(baseDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    serveFile(res, filePath);
    return;
  }

  /* ───────── 旧入口兼容（301 到新地址） ───────── */
  const view = u.searchParams.get('view');
  if (u.pathname === '/index.html' || u.pathname === '/') {
    redirect(res, view === 'stage' ? `/games/${activeGame}/public/stage.html?game=${activeGame}` : '/control.html');
    return;
  }
  if (u.pathname === '/stage.html') {
    const g = u.searchParams.get('game');
    const gid = (g && gameMap.has(g)) ? g : 'guess';
    redirect(res, `/games/${gid}/public/stage.html${g ? `?game=${g}` : ''}`);
    return;
  }
  if (u.pathname === '/stage-chengyu.html') {
    redirect(res, '/games/chengyu/public/stage.html?game=chengyu');
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
}

// ───────────────────── WebSocket（DanmuDesk 弹幕转发） ─────────────────────

const httpServer = http.createServer(onHttpRequest);
const danmuWss = new WebSocketServer({ noServer: true });
let danmuClients = 0;

httpServer.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host || 'x'}`);
  if (u.pathname === '/danmu') {
    danmuWss.handleUpgrade(req, socket, head, ws => danmuWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

danmuWss.on('connection', (ws, req) => {
  danmuClients++;
  const ip = req.socket.remoteAddress;
  info(`[danmu] 弹幕转发已连接：${ip}（当前 ${danmuClients} 路）`);
  // 连接时推送所有已注册游戏的当前状态
  for (const inst of instances.values()) {
    try { broadcast(inst.id, 'state', inst.mod.publicState(inst.ctx)); }
    catch (e) { warn(`[danmu] 推送 ${inst.id} 初始状态异常:`, e.message); }
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (err) { warn('[danmu] 消息解析失败:', err.message); return; }
    dispatchDanmuEvent(msg);
  });

  ws.on('close', () => { danmuClients--; info(`[danmu] 弹幕转发断开（剩余 ${danmuClients} 路）`); });
  ws.on('error', (err) => warn('[danmu] 连接错误:', err.message));
});

// ───────────────────── 启动 ─────────────────────

httpServer.listen(hostCfg.port, hostCfg.host, () => {
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  弹幕互动游戏中心 已启动  port=${hostCfg.port}`);
  console.log('  已注册游戏: ' + (games.map(g => `${g.id}(${g.name})`).join(', ') || '无'));
  console.log(`  弹幕 WebSocket:   ws://${hostCfg.host === '0.0.0.0' ? '127.0.0.1' : hostCfg.host}:${hostCfg.port}/danmu`);
  console.log(`  主播台:  http://127.0.0.1:${hostCfg.port}/control.html`);
  console.log(`  展示屏:  http://127.0.0.1:${hostCfg.port}/games/${activeGame || '<id>'}/public/stage.html?game=${activeGame || '<id>'}`);
  console.log(`  健康检查: http://127.0.0.1:${hostCfg.port}/health`);
  console.log('══════════════════════════════════════════════════════════');
});

process.on('SIGINT', () => {
  console.log('\n正在关闭...');
  for (const inst of instances.values()) inst.mod.clearGameTimers && inst.mod.clearGameTimers(inst.ctx);
  leaderboard.flushSave();   // 排行榜防抖收尾：退出前把最后一批计分落盘
  process.exit(0);
});

// 防抖落盘的兜底：进程自然退出前（如被「一键启动.bat」关闭窗口）也落盘
process.on('beforeExit', () => leaderboard.flushSave());
