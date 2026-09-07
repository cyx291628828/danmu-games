/**
 * ============================================================================
 * games/chengyu/index.js — 成语接龙游戏模块
 * ============================================================================
 * 【玩法】
 *   - 每轮：随机一个起始成语，观众弹幕接龙（首字 = 上层尾字）
 *   - 连接适配度三档（决定积分系数）：
 *       同字连：首字汉字 == 上层尾字汉字            ×1.0
 *       同音连：拼音（含声调）完全相同，字不同      ×0.75
 *       谐韵连：同音异调 或 声/韵母近似（zh/z...）  ×0.5
 *   - 积分 = 基础分 × 连接系数 × (1 + 剩余占比)
 *   - N 秒无有效接龙 → 本轮中断 → 记录→自动随机新词开下一轮
 *   - 排行榜为全局共享（跨游戏累计，见 host ctx.award）
 * ============================================================================
 */
'use strict';

const DICT = loadDict();
const { pinyin } = require('pinyin-pro');
const { createBroadcaster, BC_CFG_DEFAULTS, BC_CFG_KEYS } = require('../../common/broadcast'); // 通用 AI 播报中心
const CHENGYU_SLOTS = require('./slots'); // 播报点定义（开链/里程碑/中断）

/* ═══════════════ 词库加载（内置 + 用户自定义） ═══════════════
 * 用户可放置 custom_chengyu.json 在 games/chengyu/ 下，字段：
 *   word  成语原文（必填）
 *   py    全拼（可选，如 "yī mǎ dāng xiān"；缺省用 pinyin-pro 实时算）
 *   jy    意译/释义（可选，展示在 cy-goal）
 *   cy    出处（可选，展示在 cy-goal）
 * 用户词库与内置词库合并，用户词条优先（用于覆盖释义/出处）。
 */
function loadDict() {
  const fs = require('fs');
  const path = require('path');
  let base = [];
  try { base = require('./chengyu_dict'); } catch (e) { /* 内置缺失时容忍 */ }
  const builtin = Array.isArray(base) ? base : (base.default || []);
  const custom = [];
  const customPath = path.join(__dirname, 'custom_chengyu.json');
  if (fs.existsSync(customPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(customPath, 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.data || raw.words || []);
      arr.forEach(it => {
        if (!it || !it.word) return;
        custom.push({
          w: String(it.word).trim(),
          f: (it.f || firstPy(it.py)),
          l: (it.l || lastPy(it.py)),
          jy: it.jy || it.yi || it.释义 || '',
          cy: it.cy || it.出处 || it.src || '',
        });
      });
    } catch (e) { console.error('[chengyu] custom_chengyu.json 解析失败:', e.message); }
  }
  if (!custom.length) return builtin;
  // 合并：用户词条覆盖同名内置词条
  const map = new Map();
  builtin.forEach(d => map.set(d.w, d));
  custom.forEach(d => map.set(d.w, d));
  return Array.from(map.values());
}
function firstPy(py) { if (!py) return ''; const a = String(py).trim().split(/\s+/)[0]; return a || ''; }
function lastPy(py) { if (!py) return ''; const a = String(py).trim().split(/\s+/); return a[a.length - 1] || ''; }

/* ═══════════════ 注册信息 ═══════════════ */

const MANIFEST = {
  id: 'chengyu',
  name: '成语接龙',
  icon: '🏮',
  desc: '弹幕成语接龙 · 首字接尾字 · 三档适配度计分',
  // 运行中状态（宿主据此点亮主播台导航绿点）
  liveStatuses: ['playing'],
  // 全局排行榜计分字段（宿主动态注册，新增游戏零改宿主）
  score: { wins: 'chengyu_wins', score: 'chengyu_score', floors: 'chengyu_floors' },
};

/* ═══════════════ 配置 ═══════════════ */

const CFG_DEFAULTS = {
  pendingSec: 20,            // 接龙等待时间（秒），超时中断重开
  autoNext: true,            // 中断后自动随机新词开新轮
  baseScore: 100,            // 基础分
  rateLimitSec: 2,           // 同一观众发送间隔
  dictFilter: true,          // 是否校验"为真成语"（false=仅校验连接关系+4字）
  allowRepeat: false,        // 是否允许同一成语重复使用
  startMode: 'random',       // random=随机起始词 | manual=手动指定
  manualWord: '一马当先',     // startMode=manual 时的起始词
  allowedRoomId: '',
  // ── AI 播报（通用播报中心 common/broadcast，off/local/api + 密钥只存服务端） ──
  ...BC_CFG_DEFAULTS,
};

/* ═══════════════ 通用 AI 播报中心（common/broadcast） ═══════════════ */
function BC(ctx) {
  if (!ctx._bc) {
    ctx._bc = createBroadcaster({
      gameId: 'chengyu', gameName: '成语接龙', slots: CHENGYU_SLOTS,
      getCfg: () => ctx.cfg,
      getState: () => ctx.state,
      emit: () => ctx.emit.state(),
      log: ctx.log,
    });
  }
  return ctx._bc;
}

const CONFIG_SCHEMA = [
  { key: 'pendingSec', label: '接龙等待(秒)', type: 'number', min: 5, def: 20 },
  { key: 'baseScore', label: '接对基础分', type: 'number', min: 1, def: 100 },
  { key: 'autoNext', label: '中断后自动开局', type: 'bool', def: true },
  { key: 'dictFilter', label: '校验真成语', type: 'bool', def: true },
  { key: 'allowRepeat', label: '允许重复成语', type: 'bool', def: false },
  { key: 'rateLimitSec', label: '发送间隔(秒)', type: 'number', min: 1, def: 2 },
  { key: 'startMode', label: '起始词方式', type: 'select', options: [['random', '随机'], ['manual', '手动指定']], def: 'random' },
  { key: 'manualWord', label: '手动起始词', type: 'text', def: '一马当先' },
];

/* ═══════════════ 拼音工具 ═══════════════ */

/** 声调字符 → 无声调（简化转换，支持带调拼音串） */
const TONE_MAP = {
  ā: 'a', á: 'a', ǎ: 'a', à: 'a',
  ē: 'e', é: 'e', ě: 'e', è: 'e',
  ī: 'i', í: 'i', ǐ: 'i', ì: 'i',
  ō: 'o', ó: 'o', ǒ: 'o', ò: 'o',
  ū: 'u', ú: 'u', ǔ: 'u', ù: 'u',
  ǖ: 'ü', ǘ: 'ü', ǚ: 'ü', ǜ: 'ü', ü: 'ü',
  ň: 'n', ń: 'n', ǹ: 'n',
};
function stripTone(py) {
  return String(py || '').split('').map(ch => TONE_MAP[ch] || ch).join('');
}

/** 声母（取拼音首字母序列，近似：zh/ch/sh 双字母） */
function initial(py) {
  const s = stripTone(py);
  if (!s) return '';
  if (s.startsWith('zh')) return 'zh';
  if (s.startsWith('ch')) return 'ch';
  if (s.startsWith('sh')) return 'sh';
  return s[0];
}
/** 韵母（拼音去掉声母） */
function finalPart(py) {
  const s = stripTone(py);
  const ini = initial(s);
  return ini ? s.slice(ini.length) : s;
}

/** 近似组：n/l、f/h、zh/z、ch/c、sh/s、an/ang、en/eng、in/ing、z/zh 等 */
const NEAR_GROUPS = [
  ['n', 'l'], ['f', 'h'], ['zh', 'z'], ['ch', 'c'], ['sh', 's'],
  ['an', 'ang'], ['en', 'eng'], ['in', 'ing'], ['r', 'l'],
  ['un', 'ong'], ['uan', 'uang'], ['ie', 'üe'],
];
function isNear(a, b) {
  if (a === b) return true;
  for (const g of NEAR_GROUPS) {
    if ((a === g[0] && b === g[1]) || (a === g[1] && b === g[0])) return true;
  }
  return false;
}

/**
 * 判定连接类型
 * @returns {object} { ok, type, factor, name }  type: same|tone|rhyme | null
 *   same = 同字连 ×1.0；tone = 同音连 ×0.75；rhyme = 谐韵连 ×0.5
 */
function judgeConnect(prevTailChar, prevTailPy, newHeadChar, newHeadPy) {
  if (newHeadChar === prevTailChar) {
    return { ok: true, type: 'same', factor: 1.0, name: '同字' };
  }
  // 同音连：拼音含声调完全相同
  if (prevTailPy && newHeadPy && prevTailPy === newHeadPy) {
    return { ok: true, type: 'tone', factor: 0.75, name: '同音' };
  }
  // 谐韵连：同音异调（无声调相同）或 声/韵母近似
  if (prevTailPy && newHeadPy) {
    const pSt = stripTone(prevTailPy), nSt = stripTone(newHeadPy);
    const sameToneLess = pSt === nSt && pSt !== '';
    const nearIni = isNear(initial(prevTailPy), initial(newHeadPy));
    const nearFin = isNear(finalPart(prevTailPy), finalPart(newHeadPy));
    if (sameToneLess || (nearIni && nearFin)) {
      return { ok: true, type: 'rhyme', factor: 0.5, name: '谐韵' };
    }
  }
  return { ok: false };
}

/* ═══════════════ 词库工具（含逐字拼音） ═══════════════ */

const wordSet = new Set(DICT.map(d => d.w));
/** 成语 → 逐字拼音数组（带声调），用 pinyin-pro 生成并缓存 */
const WORD_PY = new Map();
function wordPinyin(w) {
  if (WORD_PY.has(w)) return WORD_PY.get(w);
  const py = pinyin(w, { toneType: 'symbol' }).split(' ').map(s => s.trim()).filter(Boolean);
  WORD_PY.set(w, py);
  return py;
}
function findWord(w) {
  const d = DICT.find(x => x.w === w) || null;
  if (d && !d.py) d.py = wordPinyin(d.w);
  return d;
}
function randomWord() {
  const w = DICT[Math.floor(Math.random() * DICT.length)];
  if (!w.py) w.py = wordPinyin(w.w);
  return w;
}

/* ═══════════════ 状态 ═══════════════ */

function createState() {
  return {
    status: 'idle',            // idle | playing | paused
    roundNo: 0,                // 中断次数（轮）
    chain: [],                 // 接龙链 [{word, tailChar, tailPy, user, avatar, score, type, ts}]
    deadline: 0,
    usedWords: new Set(),      // 已用成语（防重复，可配置关闭）
    sentAt: new Map(),         // 限流
    rounds: [],                // 已结束轮次历史 [{roundNo, startWord, floors, topUser, topScore, endedAt}]
  };
}

/* ═══════════════ 内部：开局 / 接龙 / 中断 ═══════════════ */

function startNewChain(ctx, manualWord) {
  const { state, cfg, emit } = ctx;
  ctx.clearTimers();
  let w;
  // 优先级：显式指定词（主播换词，支持词典外真成语）> 配置 manual 词 > 随机
  if (manualWord) {
    w = findWord(manualWord) || { w: manualWord, f: '', l: '' };
  } else if (cfg.startMode === 'manual' && cfg.manualWord) {
    w = findWord(cfg.manualWord) || randomWord();
  } else {
    w = randomWord();
  }
  if (!w.py) w.py = wordPinyin(w.w);
  if (!w.l) w.l = w.py[w.py.length - 1] || '';
  state.roundNo++;
  state.chain = [{
    word: w.w, py: w.py || wordPinyin(w.w),   // 逐字拼音
    tailChar: w.w[w.w.length - 1], tailPy: w.l,
    jy: w.jy || '', cy: w.cy || '',           // 意译 & 出处（自定义词库可选）
    user: '系统', avatar: '', score: 0, type: 'seed', ts: Date.now(),
  }];
  state.usedWords = new Set([w.w]);
  state.status = 'playing';
  state.deadline = Date.now() + cfg.pendingSec * 1000;
  ctx.log('INFO', `[成语接龙 第${state.roundNo}轮] 起始词「${w.w}」需接「${w.w[w.w.length - 1]}」字`);
  BC(ctx).speak('chainStart', { round: state.roundNo, word: w.w, tailChar: w.w[w.w.length - 1], jy: w.jy || '', sec: cfg.pendingSec });
  emit.state();
  scheduleTimeout(ctx);
}

function scheduleTimeout(ctx) {
  const { state, cfg } = ctx;
  ctx.clearTimers('timeout');
  const remain = Math.max(0, state.deadline - Date.now());
  ctx.setTimer('timeout', () => onInterrupt(ctx), remain);
}

function onInterrupt(ctx) {
  const { state, cfg, emit } = ctx;
  if (state.status !== 'playing') return;
  const len = state.chain.length;
  // 记录本轮历史（供主播台「最近接龙」展示）
  const floors = state.chain.filter(f => f.type !== 'seed');
  const top = floors.reduce((a, b) => (b.score > (a?.score || 0) ? b : a), null);
  state.rounds.push({
    roundNo: state.roundNo,
    startWord: state.chain[0] ? state.chain[0].word : '',
    floors: len,
    topUser: top ? top.user : '',
    topScore: top ? top.score : 0,
    endedAt: Date.now(),
    // 每层明细（含起始种子层与观众接龙层）：词/玩家/分数/连接/时间
    chain: state.chain.map(f => ({
      word: f.word,
      user: f.user || '',
      userId: f.userId || '',
      avatar: f.avatar || '',
      score: f.score || 0,
      connName: f.connName || '',
      type: f.type || (f.score ? 'normal' : 'seed'),
      ts: f.ts || 0,
    })),
  });
  if (state.rounds.length > 30) state.rounds = state.rounds.slice(-30);
  ctx.log('INFO', `[成语接龙 第${state.roundNo}轮] ⏰ ${cfg.pendingSec}s 无人接，本轮盖到 ${len} 层，中断`);
  emit.notice(`楼塌了！本轮合计 ${len} 层，${cfg.autoNext ? '随机换新词继续' : '等待主播开新局'}`);
  BC(ctx).speak('interrupt', {
    round: state.roundNo,
    lastWord: state.chain[state.chain.length - 1] ? state.chain[state.chain.length - 1].word : '',
    floors: len - 1, // 有效楼层数（去种子层）
    topUser: top ? top.user : '',
    topScore: top ? top.score : 0,
  });
  if (cfg.autoNext) {
    // 到 0 秒无人接即立即开下一轮，不再停留（emit.notice 已发出，下一轮会 clearTimers 重建）
    startNewChain(ctx);
  } else {
    state.status = 'idle';
  }
  emit.state();
}

/** 接龙成功：追加楼层 + 全局计分 */
function appendFloor(ctx, msg, wordEntry, conn) {
  const { state, cfg, emit } = ctx;
  const top = state.chain[state.chain.length - 1];
  const remainRatio = Math.max(0, (state.deadline - Date.now()) / 1000) / cfg.pendingSec;
  const score = Math.round(cfg.baseScore * conn.factor * (1 + remainRatio));
  const floor = {
    word: wordEntry.w,
    py: wordEntry.py || wordPinyin(wordEntry.w),   // 逐字拼音（含声调），供前端注音
    headChar: wordEntry.w[0],
    tailChar: wordEntry.w[wordEntry.w.length - 1],
    headPy: wordEntry.f,
    tailPy: wordEntry.l,
    jy: wordEntry.jy || '', cy: wordEntry.cy || '',   // 意译 & 出处
    user: msg.user?.name || '匿名',
    userId: msg.user?.id || msg.user?.displayId || msg.user?.name || '匿名',
    avatar: msg.user?.avatar || '',
    connType: conn.type,
    connName: conn.name,
    factor: conn.factor,
    score,
    ts: Date.now(),
  };
  state.chain.push(floor);
  if (!cfg.allowRepeat) state.usedWords.add(wordEntry.w);
  // 刷新等待窗口：每次成功接龙后重置倒计时
  state.deadline = Date.now() + cfg.pendingSec * 1000;
  ctx.log('INFO', `[接龙] ${floor.user} 接「${wordEntry.w}」→ ${conn.name} +${score}分（楼高 ${state.chain.length}）`);
  // 全局排行榜：wins+1、score+、floors+1
  ctx.award(floor, score, 1);
  // 里程碑播报：有效楼层（去种子层）每满 5 层播一次
  const nFloors = state.chain.length - 1;
  if (nFloors > 0 && nFloors % 5 === 0) {
    BC(ctx).speak('milestone', { len: nFloors, word: wordEntry.w, user: floor.user, tailChar: floor.tailChar });
  }
  emit.state();
  scheduleTimeout(ctx);
}

/* ═══════════════ 对外接口 ═══════════════ */

function handleDanmu(ctx, msg) {
  const { state, cfg, emit } = ctx;
  if (!msg || msg.event !== 'chat' || !msg.text) return false;
  // 房间ID过滤：alloweRoomId 支持逗号分隔多个，留空=接受所有房间；msg.roomId 为空时不拦（无法判断）
  if (cfg.allowedRoomId && msg.roomId) {
    const allowedSet = String(cfg.allowedRoomId).split(/[,，\s]+/).filter(Boolean);
    if (allowedSet.length && !allowedSet.includes(String(msg.roomId))) return false;
  }
  if (state.status !== 'playing' && state.status !== 'paused') return false;

  const text = String(msg.text).trim();
  // 去常见前后缀（猜、接龙、接 等）
  const cleaned = text.replace(/^(猜|接|接龙|成语|说)|[，。！？!?…\s]+$/g, '');
  // 严格 4 字（允许 4+ 取前四？——规则要求 4 字成语，非 4 字不算）
  if (!/^[\u4e00-\u9fa5]{4}$/.test(cleaned)) {
    emit.notice(`「${msg.user?.name || '匿名'}」请发 4 字成语`);
    return true;
  }

  // 限流
  const key = msg.user?.id || msg.user?.displayId || msg.user?.name || '匿名';
  const now = Date.now();
  const last = state.sentAt.get(key) || 0;
  if (now - last < cfg.rateLimitSec * 1000) return true;

  const top = state.chain[state.chain.length - 1];
  // 连接判定：首字拼音用 pinyin-pro 实时算（不依赖词库，词典外真成语也能判同音/谐韵）
  const headChar = cleaned[0];
  const headPy = findWord(cleaned)?.f || pinyin(headChar, { toneType: 'symbol' });
  const conn = judgeConnect(top.tailChar, top.tailPy, headChar, headPy);

  if (!conn.ok) {
    state.sentAt.set(key, now);
    emit.notice(`「${msg.user?.name || '匿名'}」的「${cleaned}」接不上，需要「${top.tailChar}」或「${top.tailPy}」开头`);
    return true;
  }

  // 真成语判定：dictFilter=true（默认）要求词库命中才放行（词库 2164 条覆盖高频）；
  // false 则仅按 4 字 + 连接匹配放行（主播可切"宽松"）
  const inDict = !!findWord(cleaned);
  if (cfg.dictFilter && !inDict) {
    state.sentAt.set(key, now);
    emit.notice(`「${msg.user?.name || '匿名'}」的「${cleaned}」不在是成语，请发成语`);
    return true;
  }

  // 重复检查
  if (!cfg.allowRepeat && state.usedWords.has(cleaned)) {
    state.sentAt.set(key, now);
    emit.notice(`「${cleaned}」已用过，换一个`);
    return true;
  }

  const wordEntry = inDict ? findWord(cleaned) : { w: cleaned, f: headPy, l: '' };
  // 自创词也生成逐字拼音（前端注音用）
  if (!wordEntry.py) wordEntry.py = wordPinyin(wordEntry.w);
  state.sentAt.set(key, now);
  if (state.status === 'playing') appendFloor(ctx, msg, wordEntry, conn);
  return true;
}

function handleAction(ctx, action, payload = {}) {
  const { state, cfg, emit } = ctx;
  switch (action) {
    case 'start':
      startNewChain(ctx);
      return { ok: true, msg: `成语接龙已开局（等待 ${cfg.pendingSec}s，接「${state.chain[0].tailChar}」字）` };
    case 'newWord':
      // 主播换起始词
      startNewChain(ctx, payload.word);
      return { ok: true, msg: `已换起始词「${state.chain[0].word}」` };
    case 'interrupt':
      if (state.status === 'playing') { onInterrupt(ctx); return { ok: true, msg: '已强制中断本轮' }; }
      return { ok: false, msg: '当前不在接龙中' };
    case 'pause':
      if (state.status === 'playing') {
        ctx.clearTimers();
        state.status = 'paused';
        emit.state();
        return { ok: true, msg: '已暂停' };
      }
      return { ok: false, msg: '无法暂停' };
    case 'resume':
      if (state.status === 'paused') {
        state.status = 'playing';
        state.deadline = Date.now() + cfg.pendingSec * 1000;
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
      const allowed = ['pendingSec', 'autoNext', 'baseScore', 'rateLimitSec', 'dictFilter', 'allowRepeat', 'startMode', 'manualWord', 'allowedRoomId', ...BC_CFG_KEYS];
      for (const k of allowed) if (payload[k] !== undefined) cfg[k] = payload[k];
      // 手动词校验
      if (cfg.startMode === 'manual' && !findWord(cfg.manualWord)) {
        return { ok: false, msg: `词库中未收录起始词「${cfg.manualWord}」` };
      }
      ctx.persistConfig(cfg);
      ctx.log('INFO', '[chengyu config]', cfg);
      emit.state();
      return { ok: true, msg: '配置已更新' };
    }
    case 'simulateGuess': {
      const text = String(payload.text || '').trim();
      if (!text) return { ok: false, msg: '请输入要模拟的成语' };
      const msg = { event: 'chat', user: { id: 'sim_' + (payload.name || '模拟观众'), displayId: 'sim_' + (payload.name || '模拟观众'), name: (payload.name || '模拟观众'), avatar: '' }, text, roomId: '' };
      handleDanmu(ctx, msg);
      return { ok: true, msg: `已模拟「${msg.user.name}」发送 ${text}` };
    }
    default:
      return { ok: false, msg: `未知动作: ${action}` };
  }
}

function publicState(ctx) {
  const { state, cfg } = ctx;
  const s = {
    status: state.status,
    roundNo: state.roundNo,
    chain: state.chain.map(f => ({
      word: f.word, py: f.py || [], headChar: f.headChar, tailChar: f.tailChar,
      jy: f.jy || '', cy: f.cy || '',
      user: f.user, avatar: f.avatar, score: f.score, connName: f.connName, connType: f.connType,
    })),
    usedWords: Array.from(state.usedWords),
    deadline: state.deadline,
    pendingSec: cfg.pendingSec,
    floorCount: state.chain.length,
    lastRounds: state.rounds.slice(-20).reverse(),
    leaderboard: ctx.topList(),
    cfg: {
      pendingSec: cfg.pendingSec, baseScore: cfg.baseScore, autoNext: cfg.autoNext,
      dictFilter: cfg.dictFilter, allowRepeat: cfg.allowRepeat, rateLimitSec: cfg.rateLimitSec,
      startMode: cfg.startMode, manualWord: cfg.manualWord, allowedRoomId: cfg.allowedRoomId || '',
    },
  };
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
  createState,
  handleDanmu,
  handleAction,
  publicState,
  clearGameTimers,
  // 测试暴露
  judgeConnect,
  stripTone,
};