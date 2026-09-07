/**
 * ============================================================================
 * games/gomoku/engine.js — 弹幕五子棋 · 规则引擎 + 10 级 AI（零依赖纯 JS）
 * ============================================================================
 * 【坐标约定】字母 = 行（上→下，展示屏左侧标），数字 = 列（左→右，展示屏顶部标）
 *   idx = y * size + x；即 H8 = 第 H 行第 8 列（7,7）= 天元
 * 【棋子】0 空 · 1 黑 · 2 白
 * 【禁手】连珠（Renju）规则，仅约束黑方，可在配置中关闭：
 *   - 长连禁手（overline）：黑方形成六子及以上连线，不算获胜且禁止落子
 *   - 四四禁手（doubleFour）：一步同时形成两个「四」（活四含两个成五点，算两四）
 *   - 三三禁手（doubleThree）：一步同时形成两个「活三」
 *   - 黑方成五须恰好五子；白方无禁手，长连也算胜；禁手关闭时双方 ≥5 即胜
 * 【AI】（经典 minimax + α-β 剪枝 + 棋型评估框架，与主流开源五子棋 AI 同路线）
 *   10 级：1 随机 → 2-4 贪婪（成五/堵五常识 + 逐步降噪）→ 5-10 α-β 迭代加深：
 *   · 估值 = 5 窗口棋型计数（窗口内无对方子时按己方子数指数加权，对方窗口稍加权鼓励防守）
 *   · 着法排序 = 单点攻防速评（进攻窗口 + 0.9×封堵对方窗口）
 *   · Zobrist 双 32 位哈希 + 置换表（跨手复用，同时间预算搜更深）
 *   · VCF（Victory by Continuous Fours）连续冲四杀棋检测：活四/双四直接判胜，
 *     冲四-堵四链递归（深度 12、节点上限 2 万），浅层搜索漏掉的强制胜利也能抓到
 *   · 超时自动退回上一深度结果，单手硬上限 ≤ 1s（宿主单进程，需照顾 SSE/WS 推送）
 * 自测：node games/gomoku/engine.js --selftest
 * ============================================================================
 */
'use strict';

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
const WIN_SCORE = 1e9;
const ABORT = { abort: true };

/* ═══════════════ 基础 ═══════════════ */

function emptyBoard(size) { return new Array(size * size).fill(0); }

function clampLevel(level) {
  const n = parseInt(level, 10) || 5;
  return Math.min(10, Math.max(1, n));
}

function idxToCoord(size, idx) {
  const x = idx % size, y = (idx / size) | 0;
  // 字母 = 行（上→下，展示屏左侧标），数字 = 列（左→右，展示屏顶部标）
  return String.fromCharCode(65 + y) + (x + 1);
}

function coordToIdx(size, letter, rowNum) {
  const y = String(letter).toUpperCase().charCodeAt(0) - 65;   // 字母 → 行
  const x = rowNum - 1;                                        // 数字 → 列
  if (x < 0 || x >= size || y < 0 || y >= size) return -1;
  return y * size + x;
}

/* 螺旋编号：从棋盘正中心 cell 起算 1，顺时针向外螺旋递增到 N*N（N=size）。
   返回 { spiralToIdx: idx[1..N*N], idxToSpiral: idx→螺旋号(1..N*N) }。
   用途：展示屏每格淡显该编号，观众报「中心螺旋编号」即可落子（避免依赖左/上行标找坐标出错）。
   缓存：同一 size 只算一次。 */
const SPIRAL_CACHE = {};
function spiralMap(size) {
  if (SPIRAL_CACHE[size]) return SPIRAL_CACHE[size];
  const total = size * size;
  const c = Math.floor((size - 1) / 2);          // 中心 cell 坐标（偶数路取偏上左的中心格之一）
  const spiralToIdx = new Array(total + 1);
  const idxToSpiral = new Array(total).fill(0);
  let x = c, y = c, sp = 1;
  spiralToIdx[sp] = y * size + x; idxToSpiral[y * size + x] = sp;
  let dx = 1, dy = 0, seg = 1, legs = 0;          // 方向：右→下→左→上 顺时针；每 2 段长度 +1
  while (sp < total) {
    for (let i = 0; i < seg; i++) {
      x += dx; y += dy; sp++;
      if (sp > total) break;
      spiralToIdx[sp] = y * size + x; idxToSpiral[y * size + x] = sp;
    }
    const nx = -dy, ny = dx; dx = nx; dy = ny;    // 顺时针旋转 90°
    legs++;
    if (legs % 2 === 0) seg++;
  }
  const r = { spiralToIdx, idxToSpiral };
  SPIRAL_CACHE[size] = r;
  return r;
}

/** 解析弹幕坐标 → idx（-1=未识别）。约定：字母=行(Y)，数字=列(X)。
 * 支持 H8 / h 8 / H行8列 / 下H8 / 8H / 8列H行 等（字母与数字顺序不限） */
function parseCoord(text, size) {
  const t = String(text || '').toUpperCase().replace(/[，,]/g, ' ');
  if (!t) return -1;
  const L = String.fromCharCode(64 + size);
  // 字母在前：H8 / H 8 / H行8列
  let m = t.match(new RegExp(`([A-${L}])\\s*行?\\s*(\\d{1,2})\\s*列?`));
  if (m) { const idx = coordToIdx(size, m[1], parseInt(m[2], 10)); if (idx >= 0) return idx; }
  // 数字在前：8H / 8 H / 8列H行
  m = t.match(new RegExp(`(\\d{1,2})\\s*列?\\s*([A-${L}])\\s*行?`));
  if (m) { const idx = coordToIdx(size, m[2], parseInt(m[1], 10)); if (idx >= 0) return idx; }
  // 纯数字 → 中心螺旋编号（1..N*N，从天元向外顺时针递增）。
  // 1/2/3… 全部是格子编号；排队口令已收敛为「排队 / 排黑 / 排白 / 黑 / 白」等文字口令，不再占用 1/2。
  if (/^\s*\d{1,3}\s*$/.test(t)) {
    const n = parseInt(t, 10);
    if (n >= 1 && n <= size * size) {
      const sm = spiralMap(size);
      if (sm.spiralToIdx[n] != null) return sm.spiralToIdx[n];
    }
  }
  return -1;
}

/** 沿方向提取以 idx 为中心、前后各 span 格的字符串：b=黑 w=白 .=空 #=墙 */
function lineStr(board, size, idx, d, span) {
  const x0 = idx % size, y0 = (idx / size) | 0;
  let s = '';
  for (let k = -span; k <= span; k++) {
    const x = x0 + d[0] * k, y = y0 + d[1] * k;
    if (x < 0 || y < 0 || x >= size || y >= size) { s += '#'; continue; }
    const v = board[y * size + x];
    s += v === 0 ? '.' : (v === 1 ? 'b' : 'w');
  }
  return s;   // 中心字符位于下标 span
}

/** 字符串中包含位置 c 的连续 ch 游程 */
function runAt(s, c, ch) {
  let i = c, j = c;
  while (s[i - 1] === ch) i--;
  while (s[j + 1] === ch) j++;
  return { len: j - i + 1, start: i, end: j };
}

/* ═══════════════ 胜负 ═══════════════ */

/**
 * 落子后判定（board[idx] 须已置为 side）：
 * 返回获胜连线（棋盘下标数组）或 null。黑方+禁手时须恰好五连。
 */
function winLineAfter(board, size, idx, side, forbidden) {
  const x0 = idx % size, y0 = (idx / size) | 0;
  for (const d of DIRS) {
    const cells = [idx];
    for (let k = 1; k <= 5; k++) {
      const x = x0 + d[0] * k, y = y0 + d[1] * k;
      if (x < 0 || y < 0 || x >= size || y >= size || board[y * size + x] !== side) break;
      cells.push(y * size + x);
    }
    for (let k = 1; k <= 5; k++) {
      const x = x0 - d[0] * k, y = y0 - d[1] * k;
      if (x < 0 || y < 0 || x >= size || y >= size || board[y * size + x] !== side) break;
      cells.unshift(y * size + x);
    }
    if (cells.length === 5) return cells;
    if (cells.length > 5 && !(forbidden && side === 1)) return cells;
  }
  return null;
}

/* ═══════════════ 禁手（黑方） ═══════════════ */

/**
 * 黑方禁手判定（board[idx] 须已置为 1）。
 * 返回 null = 合法；{ type, dirs? } = 禁手：
 *   overline 长连 / doubleFour 四四 / doubleThree 三三
 */
function analyzeBlackPoint(board, size, idx) {
  const SPAN = 5, C = SPAN;
  const lines = DIRS.map(d => lineStr(board, size, idx, d, SPAN));
  const runs = lines.map(s => runAt(s, C, 'b'));
  // 五连优先于一切禁手（成五即胜，合法）；无五连时先查长连
  if (runs.some(r => r.len === 5)) return null;
  if (runs.some(r => r.len >= 6)) return { type: 'overline' };
  // 四四：数「补一手即成恰好五连（且五连含新子）」的空点个数（活四的两个成五点算两四）
  let fours = 0;
  for (const s of lines) {
    for (let p = 0; p < 2 * SPAN; p++) {
      if (p === C || s[p] !== '.') continue;
      const s2 = s.slice(0, p) + 'b' + s.slice(p + 1);
      if (runAt(s2, C, 'b').len === 5) fours++;
    }
  }
  if (fours >= 2) return { type: 'doubleFour' };
  // 三三：某一方向存在空点，补上后形成「恰好四连且两端皆可成恰好五连」的活四
  let threeDirs = 0;
  for (const s of lines) {
    let ok = false;
    for (let p = 0; p < 2 * SPAN && !ok; p++) {
      if (p === C || s[p] !== '.') continue;
      const s2 = s.slice(0, p) + 'b' + s.slice(p + 1);
      const r = runAt(s2, C, 'b');
      if (r.len !== 4) continue;
      // 两端皆空、且端点外侧不能再有黑子（否则成五会变长连，不是真活四）
      const leftOk = s2[r.start - 1] === '.' && s2[r.start - 2] !== 'b';
      const rightOk = s2[r.end + 1] === '.' && s2[r.end + 2] !== 'b';
      if (leftOk && rightOk) ok = true;
    }
    if (ok) threeDirs++;
  }
  if (threeDirs >= 2) return { type: 'doubleThree' };
  return null;
}

/** 黑方在 idx 是否禁手（board 不含该子；内部模拟落子后判定） */
function isForbidden(board, size, idx) {
  if (board[idx] !== 0) return null;
  board[idx] = 1;
  const r = analyzeBlackPoint(board, size, idx);
  board[idx] = 0;
  return r;
}

/** 当前盘面全部黑方禁手点（展示屏标 ✕ 用；仅统计已有棋子邻域 2 格内） */
function forbiddenPoints(board, size) {
  const out = [];
  for (const idx of candidatesNear(board, size, 2)) {
    if (isForbidden(board, size, idx)) out.push(idx);
  }
  return out;
}

const FORBIDDEN_LABEL = {
  overline: '长连禁手',
  doubleFour: '四四禁手',
  doubleThree: '三三禁手',
};

/* ═══════════════ 候选点 / 估值 ═══════════════ */

/** 已有棋子切比雪夫距离 dist 内的空点（空盘返回天元） */
function candidatesNear(board, size, dist) {
  const near = new Uint8Array(size * size);
  let any = false;
  for (let i = 0; i < size * size; i++) {
    if (!board[i]) continue;
    any = true;
    const x = i % size, y = (i / size) | 0;
    for (let dy = -dist; dy <= dist; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= size) continue;
      for (let dx = -dist; dx <= dist; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= size) continue;
        near[ny * size + nx] = 1;
      }
    }
  }
  if (!any) return [((size / 2) | 0) * size + ((size / 2) | 0)];
  const out = [];
  for (let i = 0; i < size * size; i++) if (!board[i] && near[i]) out.push(i);
  return out;
}

/** 5 窗口估值权重：窗口内己方子数 → 分值（对方子存在则该窗口不计） */
const W5 = [0, 4, 32, 300, 3200, 260000];

const lineCache = new Map();
function getLines(size) {
  if (lineCache.has(size)) return lineCache.get(size);
  const lines = [];
  for (let y = 0; y < size; y++) { const l = []; for (let x = 0; x < size; x++) l.push(y * size + x); lines.push(l); }
  for (let x = 0; x < size; x++) { const l = []; for (let y = 0; y < size; y++) l.push(y * size + x); lines.push(l); }
  for (let d = -(size - 1); d < size; d++) {
    const l = [];
    for (let y = 0; y < size; y++) { const x = y + d; if (x >= 0 && x < size) l.push(y * size + x); }
    if (l.length >= 5) lines.push(l);
  }
  for (let d = 0; d <= 2 * (size - 1); d++) {
    const l = [];
    for (let y = 0; y < size; y++) { const x = d - y; if (x >= 0 && x < size) l.push(y * size + x); }
    if (l.length >= 5) lines.push(l);
  }
  lineCache.set(size, lines);
  return lines;
}

/** 全盘估值（相对 side 视角；对手窗口稍加权，鼓励防守） */
function evalBoard(board, size, side) {
  const lines = getLines(size);
  let s1 = 0, s2 = 0;
  for (const line of lines) {
    let c1 = 0, c2 = 0;
    for (let i = 0; i < line.length; i++) {
      const v = board[line[i]];
      if (v === 1) c1++; else if (v === 2) c2++;
      if (i >= 5) { const vo = board[line[i - 5]]; if (vo === 1) c1--; else if (vo === 2) c2--; }
      if (i >= 4) {
        if (c2 === 0) s1 += W5[c1];
        if (c1 === 0) s2 += W5[c2];
      }
    }
  }
  return side === 1 ? s1 - s2 * 1.06 : s2 - s1 * 1.06;
}

/** 单点攻防速评（假设 side 落在 idx；用于着法排序与贪婪级 AI） */
function pointScore(board, size, idx, side) {
  const opp = 3 - side;
  const x0 = idx % size, y0 = (idx / size) | 0;
  let off = 0, def = 0;
  for (const d of DIRS) {
    for (let w = -4; w <= 0; w++) {
      let mine = 0, theirs = 0, ok = true;
      for (let k = 0; k < 5; k++) {
        const x = x0 + d[0] * (w + k), y = y0 + d[1] * (w + k);
        if (x < 0 || y < 0 || x >= size || y >= size) { ok = false; break; }
        const v = board[y * size + x];
        if (w + k === 0) mine++;                    // 中心假设为己方
        else if (v === side) mine++;
        else if (v === opp) theirs++;
      }
      if (!ok) continue;
      if (theirs === 0) off += W5[mine];
      if (mine === 1 && theirs > 0) def += W5[theirs];   // 挡住对方窗口
    }
  }
  return off + def * 0.9;
}

/** 生成着法（黑方+禁手时剔除禁手点），按速评降序，最多 cap 个 */
function genMoves(board, size, side, forbidden, cap, dist) {
  const scored = [];
  for (const idx of candidatesNear(board, size, dist || 2)) {
    if (forbidden && side === 1 && isForbidden(board, size, idx)) continue;
    scored.push({ idx, s: pointScore(board, size, idx, side) });
  }
  scored.sort((a, b) => b.s - a.s);
  return cap ? scored.slice(0, cap) : scored;
}

/** side 当前能一步成五的全部点 */
function fiveSpots(board, size, side, forbidden) {
  const out = [];
  for (const idx of candidatesNear(board, size, 1)) {
    board[idx] = side;
    const w = winLineAfter(board, size, idx, side, forbidden);
    board[idx] = 0;
    if (w) out.push(idx);
  }
  return out;
}

/* ═══════════════ Zobrist 哈希 + 置换表 ═══════════════ */

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

/** 每个交叉点 × 黑/白 的双 32 位随机数（种子固定，跨重启稳定） */
const ZOB = { size: 0, lo: [], hi: [] };
function ensureZobrist(n) {
  if (ZOB.size === n) return;
  const rnd = mulberry32(0x9E3779B9 ^ (n * 2654435761));
  ZOB.size = n; ZOB.lo = []; ZOB.hi = [];
  for (let i = 0; i < n * n * 2; i++) { ZOB.lo.push(rnd() | 0); ZOB.hi.push(rnd() | 0); }
}

/** 全盘哈希（根节点用一次；搜索内增量维护） */
function hashBoard(board, size) {
  ensureZobrist(size);
  let lo = 0, hi = 0;
  for (let i = 0; i < size * size; i++) {
    const v = board[i];
    if (!v) continue;
    const k = i * 2 + (v - 1);
    lo = (lo ^ ZOB.lo[k]) | 0;
    hi = (hi ^ ZOB.hi[k]) | 0;
  }
  return { lo, hi };
}

/** 置换表（进程级共享，同一局跨手复用；超限清空防内存膨胀） */
const TT = new Map();
const TT_CAP = 400000;
function ttGet(st, lo, hi) {
  return st.tt.get(`${lo >>> 0}_${hi >>> 0}`);
}
function ttPut(st, lo, hi, depth, flag, val, move) {
  if (st.tt.size > TT_CAP) st.tt.clear();
  st.tt.set(`${lo >>> 0}_${hi >>> 0}`, { d: depth, f: flag, v: val, m: move });
}

/* ═══════════════ VCF：连续冲四强制胜利检测 ═══════════════ */

/** side 落 idx 是否形成「四」（存在成五点）；board 不含该子 */
function createsFour(board, size, idx, side) {
  const x0 = idx % size, y0 = (idx / size) | 0;
  for (const d of DIRS) {
    for (let w = -4; w <= 0; w++) {
      let mine = 0, empty = 0, ok = true;
      for (let k = 0; k < 5; k++) {
        const x = x0 + d[0] * (w + k), y = y0 + d[1] * (w + k);
        if (x < 0 || y < 0 || x >= size || y >= size) { ok = false; break; }
        const v = board[y * size + x];
        if (w + k === 0) { mine++; continue; }      // 中心假设己方
        if (v === 0) empty++;
        else if (v === side) mine++;
        else { ok = false; break; }                 // 窗口被对方封死
      }
      if (ok && mine === 4 && empty === 1) return true;
    }
  }
  return false;
}

/**
 * VCF 搜索：side 只走冲四/活四，对手被迫堵五点，递归找强制胜利。
 * @returns {number} 制胜第一手 idx（-1 = 无 VCF 胜机）
 */
function vcf(board, size, side, forbidden, depth, st) {
  st.vcfNodes++;
  if (depth <= 0 || st.vcfNodes > 20000) return -1;
  const opp = 3 - side;
  // 冲四候选：邻域空点中能成四的，按速评优先（高价值四先试，剪枝快）
  const cands = candidatesNear(board, size, 1)
    .filter(i => board[i] === 0 && !(forbidden && side === 1 && isForbidden(board, size, i)) && createsFour(board, size, i, side))
    .sort((a, b) => pointScore(board, size, b, side) - pointScore(board, size, a, side));
  for (const m of cands) {
    board[m] = side;
    let win = false;
    if (winLineAfter(board, size, m, side, forbidden)) {
      win = true;                                   // 直接成五
    } else {
      const spots = fiveSpots(board, size, side, forbidden);
      if (spots.length >= 2) {
        win = true;                                 // 活四：两个成五点堵不住
      } else if (spots.length === 1) {
        const p = spots[0];
        if (forbidden && opp === 1 && isForbidden(board, size, p)) {
          win = true;                               // 对手（黑）堵点即禁手，无解
        } else {
          board[p] = opp;                           // 对手被迫唯一堵
          if (!winLineAfter(board, size, p, opp, forbidden)) {
            if (vcf(board, size, side, forbidden, depth - 1, st) >= 0) win = true;
          }
          board[p] = 0;
        }
      }
    }
    board[m] = 0;
    if (win) return m;
  }
  return -1;
}

/* ═══════════════ 10 级 AI ═══════════════ */

const LEVELS = {
  1: { name: '入门', kind: 'random' },
  2: { name: '新手', kind: 'greedy', noise: 0.9, blockFive: false },
  3: { name: '初级', kind: 'greedy', noise: 0.45, blockFive: true },
  4: { name: '中级', kind: 'greedy', noise: 0.12, blockFive: true },
  5: { name: '高级', kind: 'search', depth: 2, cap: 14, timeMs: 250, noise: 0.18, vcf: false },
  6: { name: '专家', kind: 'search', depth: 4, cap: 12, timeMs: 350, noise: 0, vcf: true },
  7: { name: '大师', kind: 'search', depth: 6, cap: 12, timeMs: 450, noise: 0, vcf: true },
  8: { name: '宗师', kind: 'search', depth: 6, cap: 14, timeMs: 600, noise: 0, vcf: true },
  9: { name: '传奇', kind: 'search', depth: 8, cap: 12, timeMs: 700, noise: 0, vcf: true },
  10: { name: '棋圣', kind: 'search', depth: 10, cap: 14, timeMs: 900, noise: 0, vcf: true },
};

/* 中文段位（数字 1-10 → 一…十） */
const DAN_CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function levelDan(level) {
  const n = clampLevel(level);
  return `${DAN_CN[n] || n}段`;
}
function levelName(level) {
  const n = clampLevel(level);
  return `${levelDan(n)}·${(LEVELS[n] || LEVELS[5]).name}`;
}

function negamax(board, size, side, depth, alpha, beta, forbidden, st, hLo, hHi) {
  st.nodes++;
  if ((st.nodes & 127) === 0 && Date.now() > st.deadline) throw ABORT;
  if (depth <= 0) return evalBoard(board, size, side);

  // 置换表探测（深度足够才直接用；否则取着法做首着排序）
  const entry = ttGet(st, hLo, hHi);
  let ttMove = -1;
  if (entry) {
    ttMove = entry.m;
    if (entry.d >= depth) {
      if (entry.f === 0) return entry.v;
      if (entry.f === 1 && entry.v >= beta) return entry.v;
      if (entry.f === 2 && entry.v <= alpha) return entry.v;
    }
  }

  let moves = genMoves(board, size, side, forbidden, st.cap, 2);
  if (!moves.length) return (side === 1 && forbidden) ? -WIN_SCORE + 10 : 0;   // 黑方无合法点 = 负
  if (ttMove >= 0) {
    const k = moves.findIndex(m => m.idx === ttMove);
    if (k > 0) moves.unshift(moves.splice(k, 1)[0]);
  }
  const alphaOrig = alpha;
  let best = -Infinity, bestMove = -1;
  for (const m of moves) {
    const zi = m.idx * 2 + (side - 1);
    const nLo = (hLo ^ ZOB.lo[zi]) | 0, nHi = (hHi ^ ZOB.hi[zi]) | 0;
    board[m.idx] = side;
    let sc;
    try {
      // 递归可能抛 ABORT（超时中断）——finally 保证试手必然还原，杜绝棋盘残留污染
      if (winLineAfter(board, size, m.idx, side, forbidden)) sc = WIN_SCORE - (st.maxDepth - depth) * 100;
      else sc = -negamax(board, size, 3 - side, depth - 1, -beta, -alpha, forbidden, st, nLo, nHi);
    } finally {
      board[m.idx] = 0;
    }
    if (sc > best) { best = sc; bestMove = m.idx; }
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  // 写置换表：0 精确 / 1 下界(发生剪枝) / 2 上界(未超原 alpha)
  const flag = best >= beta ? 1 : (best <= alphaOrig ? 2 : 0);
  ttPut(st, hLo, hHi, depth, flag, best, bestMove);
  return best;
}

function searchRoot(board, size, side, lv, forbidden) {
  const st = { nodes: 0, vcfNodes: 0, deadline: Date.now() + (lv.timeMs || 300), cap: lv.cap || 12, tt: TT };
  ensureZobrist(size);
  const h0 = hashBoard(board, size);
  let ordered = genMoves(board, size, side, forbidden, Math.max(20, lv.cap || 12), 2);
  if (!ordered.length) return -1;
  if (ordered.length === 1) return ordered[0].idx;

  // VCF：浅层搜索抓不到的强制胜利（连续冲四）先行判断
  if (lv.vcf) {
    const w = vcf(board, size, side, forbidden, 12, st);
    if (w >= 0) return w;
  }

  let bestIdx = ordered[0].idx;
  for (let depth = 2; depth <= (lv.depth || 4); depth += 2) {
    st.maxDepth = depth;
    const results = [];
    let alpha = -Infinity;
    try {
      for (const m of ordered) {
        if (Date.now() > st.deadline) throw ABORT;
        const zi = m.idx * 2 + (side - 1);
        const nLo = (h0.lo ^ ZOB.lo[zi]) | 0, nHi = (h0.hi ^ ZOB.hi[zi]) | 0;
        board[m.idx] = side;
        let sc;
        try {
          // negamax 超时抛 ABORT——finally 保证试手必然还原，杜绝棋盘残留污染
          if (winLineAfter(board, size, m.idx, side, forbidden)) sc = WIN_SCORE;
          else sc = -negamax(board, size, 3 - side, depth - 1, -Infinity, -alpha, forbidden, st, nLo, nHi);
        } finally {
          board[m.idx] = 0;
        }
        results.push({ idx: m.idx, s: sc });
        if (sc > alpha) alpha = sc;
      }
    } catch (e) {
      if (e !== ABORT) throw e;
      break;   // 超时：沿用上一深度的结果
    }
    results.sort((a, b) => b.s - a.s);
    ordered = results;
    bestIdx = results[0].idx;
    if (results[0].s >= WIN_SCORE - 200) break;   // 已见必胜/必堵，无需更深
  }
  if (lv.noise && ordered.length > 1 && Math.random() < lv.noise) {
    return ordered[Math.min(ordered.length - 1, 1 + ((Math.random() * 2) | 0))].idx;
  }
  return bestIdx;
}

/**
 * AI 主入口：为 side 选一手。
 * @returns {number} idx（-1 = 无合法落点）
 */
function bestMove(board, size, side, level, forbidden) {
  // 防御拷贝：搜索（negamax/vcf）内部有试手写入，异常中断（ABORT 超时）曾导致残留污染调用方棋盘；
  // 这里对入参浅拷贝，保证本函数绝不改动调用方持有的 board 数组。
  board = board.slice();
  const lv = LEVELS[clampLevel(level)] || LEVELS[5];
  const cands = candidatesNear(board, size, 2);
  if (!cands.length) return -1;
  if (lv.kind === 'random') return cands[(Math.random() * cands.length) | 0];

  // 常识快棋：能成五先成五（2 级起）；对手将成五必堵（3 级起）
  const myFive = fiveSpots(board, size, side, forbidden);
  if (myFive.length) return myFive[(Math.random() * myFive.length) | 0];
  if (lv.blockFive) {
    const opFive = fiveSpots(board, size, 3 - side, forbidden);
    if (opFive.length) {
      const legal = opFive.filter(i => !(forbidden && side === 1 && isForbidden(board, size, i)));
      const pool = (legal.length ? legal : opFive).slice()
        .sort((a, b) => pointScore(board, size, b, side) - pointScore(board, size, a, side));
      return pool[0];
    }
  }
  if (lv.kind === 'greedy') {
    const scored = [];
    for (const idx of cands) {
      if (forbidden && side === 1 && isForbidden(board, size, idx)) continue;
      scored.push({ idx, s: pointScore(board, size, idx, side) * (1 + (Math.random() - 0.5) * 2 * (lv.noise || 0)) });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.length ? scored[0].idx : -1;
  }
  return searchRoot(board, size, side, lv, forbidden);
}

/* ═══════════════ 自测 ═══════════════ */

function selftest() {
  const size = 15;
  const I = (x, y) => y * size + x;
  let pass = 0, fail = 0;
  const ok = (cond, msg) => {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.error(`  ✗ ${msg}`); }
  };

  console.log('── 坐标解析（字母=行Y，数字=列X） ──');
  ok(parseCoord('H8', 15) === I(7, 7), 'H8 → 第H行第8列（天元）');
  ok(parseCoord('h 8', 15) === I(7, 7), 'h 8 → 天元');
  ok(parseCoord('下 H8', 15) === I(7, 7), '下 H8 → 天元');
  ok(parseCoord('8H', 15) === I(7, 7), '8H → 天元（数字在前）');
  ok(parseCoord('H行8列', 15) === I(7, 7), 'H行8列 → 天元');
  ok(parseCoord('8列H行', 15) === I(7, 7), '8列H行 → 天元');
  ok(parseCoord('A15', 15) === 14, 'A15 → 第A行第15列（右上角，旧约定会是 210）');
  ok(parseCoord('15A', 15) === 14, '15A → 同上（数字在前）');
  ok(parseCoord('C行2列', 15) === 2 * 15 + 1, 'C行2列 → 第C行第2列');
  ok(idxToCoord(15, 14) === 'A15', 'idx 14 → A15（字母=行、数字=列）');
  ok(idxToCoord(15, 1) === 'A2', 'idx 1 → A2');
  ok(parseCoord('O15', 15) === 224, 'O15 → 第O行第15列（右下角）');
  ok(parseCoord('A1', 15) === 0, 'A1 → 左上角');
  ok(parseCoord('P8', 15) === -1, 'P8（19路字母越界）→ -1');
  ok(parseCoord('H16', 15) === -1, 'H16（列越界）→ -1');
  ok(parseCoord('来个火锅', 15) === -1, '普通聊天不误触');
  console.log('── 螺旋编号（中心向外顺时针，1..N*N，与展示屏淡显数字一致） ──');
  const sm15 = spiralMap(15), T15 = 15 * 15;
  ok(sm15.idxToSpiral[7 * 15 + 7] === 1, '15路：天元(idx 112) = 螺旋 1');
  ok(sm15.spiralToIdx[1] === 7 * 15 + 7, '螺旋 1 → 天元');
  ok(sm15.spiralToIdx[T15] != null, `螺旋编号覆盖全部 ${T15} 格（末号=${T15}）`);
  let uniq = new Set(Object.values(sm15.idxToSpiral)).size === T15;
  ok(uniq, '每格螺旋号唯一（无重复/遗漏）');
  ok(parseCoord('113', 15) === sm15.spiralToIdx[113], '报螺旋编号 113 → 对应 idx（与 H8 体系并存）');
  ok(parseCoord('1', 15) === sm15.spiralToIdx[1], '纯数字 1 → 螺旋 1（天元）');
  ok(parseCoord('2', 15) === sm15.spiralToIdx[2], '纯数字 2 → 螺旋 2');
  ok(parseCoord('3', 15) === sm15.spiralToIdx[3], '纯数字 3 → 螺旋 3');
  ok(parseCoord('225', 15) === sm15.spiralToIdx[225], '纯数字 225（末号）→ 螺旋 225');

  console.log('── 禁手判定 ──');
  {
    // 三三：横向 (5,7)(6,7) + 纵向 (7,5)(7,6)，落 (7,7) 成双活三
    const b = emptyBoard(size);
    [I(5, 7), I(6, 7), I(7, 5), I(7, 6)].forEach(i => b[i] = 1);
    ok((isForbidden(b, size, I(7, 7)) || {}).type === 'doubleThree', '双活三 → 三三禁手');
    ok(isForbidden(b, size, I(8, 8)) === null, '无关点 → 合法');
  }
  {
    // 四四：横向 (4,7)(5,7)(6,7) + 纵向 (7,4)(7,5)(7,6)，落 (7,7) 成双四
    const b = emptyBoard(size);
    [I(4, 7), I(5, 7), I(6, 7), I(7, 4), I(7, 5), I(7, 6)].forEach(i => b[i] = 1);
    ok((isForbidden(b, size, I(7, 7)) || {}).type === 'doubleFour', '双四 → 四四禁手');
  }
  {
    // 长连：横向 (2,7)..(6,7) 五子，落 (7,7) 成六连
    const b = emptyBoard(size);
    for (let x = 2; x <= 6; x++) b[I(x, 7)] = 1;
    ok((isForbidden(b, size, I(7, 7)) || {}).type === 'overline', '六连 → 长连禁手');
    ok(winLineAfter((() => { const c = b.slice(); c[I(7, 7)] = 1; return c; })(), size, I(7, 7), 1, true) === null, '禁手下黑长连不算胜');
    ok(winLineAfter((() => { const c = b.slice(); c[I(7, 7)] = 1; return c; })(), size, I(7, 7), 1, false) !== null, '无禁手时长连算胜');
  }
  {
    // 恰好五连合法且算胜
    const b = emptyBoard(size);
    [I(3, 7), I(4, 7), I(5, 7), I(6, 7)].forEach(i => b[i] = 1);
    ok(isForbidden(b, size, I(7, 7)) === null, '成五点 → 合法（五连优先）');
    ok((winLineAfter((() => { const c = b.slice(); c[I(7, 7)] = 1; return c; })(), size, I(7, 7), 1, true) || []).length === 5, '恰好五连 → 获胜连线 5 格');
  }
  {
    // 白棋无禁手：长连也算胜
    const b = emptyBoard(size);
    for (let x = 3; x <= 7; x++) b[I(x, 7)] = 2;
    b[I(8, 7)] = 0; b[I(9, 7)] = 2;
    ok(winLineAfter((() => { const c = b.slice(); c[I(8, 7)] = 2; return c; })(), size, I(8, 7), 2, true) !== null, '白方长连也算胜');
  }
  {
    // 禁手点列表：双活三盘面应报出 (7,7)
    const b = emptyBoard(size);
    [I(5, 7), I(6, 7), I(7, 5), I(7, 6)].forEach(i => b[i] = 1);
    ok(forbiddenPoints(b, size).includes(I(7, 7)), 'forbiddenPoints 标出三三点');
  }

  console.log('── Zobrist / 置换表 ──');
  {
    const b = emptyBoard(size);
    b[I(7, 7)] = 1; b[I(8, 8)] = 2;
    const h1 = hashBoard(b, size);
    // 乱序放置同一批棋子 → 哈希一致
    const b2 = emptyBoard(size);
    b2[I(8, 8)] = 2; b2[I(7, 7)] = 1;
    const h2 = hashBoard(b2, size);
    ok(h1.lo === h2.lo && h1.hi === h2.hi, 'Zobrist 与落子顺序无关');
    // 增量 = 全量
    b[I(3, 3)] = 1;
    const h3 = hashBoard(b, size);
    const zi = I(3, 3) * 2 + 0;
    ok((((h1.lo ^ ZOB.lo[zi]) | 0) === h3.lo) && (((h1.hi ^ ZOB.hi[zi]) | 0) === h3.hi), '增量哈希与全量一致');
  }

  console.log('── VCF 连续冲四 ──');
  {
    // 白双四点：横向三连 + 纵向三连交叉，落交叉点成双四（活四）→ VCF 应直接判胜
    const b = emptyBoard(size);
    [I(4, 7), I(5, 7), I(6, 7), I(7, 4), I(7, 5), I(7, 6)].forEach(i => b[i] = 2);
    const w = vcf(b, size, 2, true, 12, { vcfNodes: 0 });
    ok(w === I(7, 7), `VCF 找到双四制胜点（${w >= 0 ? idxToCoord(size, w) : '未找到'}）`);
    ok(bestMove(b, size, 2, 6, true) === I(7, 7), '专家 AI 走 VCF 制胜点');
  }
  {
    // 冲四链：黑 (5,7)(6,7)(7,7) 横向，白堵 (8,7)；黑再 (4,7) 成冲四、(3,7) 成五点——
    // 构造两段式 VCF：黑 (5,7)(6,7)(7,7) + 另一三 (9,9)(10,9)(11,9)，
    // 落 (4,7) 冲四逼白堵 (3,7)，随后 (12,9)/(8,9) 双成五点之一成四…
    // 简化验证：无杀棋盘面 VCF 返回 -1（不误报）
    const b = emptyBoard(size);
    b[I(7, 7)] = 1; b[I(8, 8)] = 2; b[I(7, 8)] = 1;
    ok(vcf(b, size, 1, true, 12, { vcfNodes: 0 }) === -1, '无杀棋盘面 VCF 不误报');
  }

  console.log('── AI 常识 ──');
  {
    // 能成五必成五
    const b = emptyBoard(size);
    [I(4, 7), I(5, 7), I(6, 7), I(7, 7)].forEach(i => b[i] = 1);
    const mvWin = bestMove(b, size, 1, 6, true);
    ok(mvWin === I(8, 7) || mvWin === I(3, 7), `AI 抓住成五点（选 ${idxToCoord(size, mvWin)}）`);
    // 对手将成五必堵
    const b2 = emptyBoard(size);
    [I(4, 7), I(5, 7), I(6, 7), I(7, 7)].forEach(i => b2[i] = 2);
    const mv = bestMove(b2, size, 1, 6, true);
    ok(mv === I(8, 7) || mv === I(3, 7), 'AI 必堵对手成五点');
  }
  {
    // 禁手盘面下 AI 不落禁手点
    const b = emptyBoard(size);
    [I(5, 7), I(6, 7), I(7, 5), I(7, 6), I(7, 9), I(7, 10)].forEach(i => b[i] = 1);
    b[I(6, 10)] = 2; b[I(8, 6)] = 2; b[I(9, 6)] = 2;
    const mv = bestMove(b, size, 1, 8, true);
    ok(mv >= 0 && !isForbidden(b, size, mv), `AI（宗师）避开禁手（选 ${mv >= 0 ? idxToCoord(size, mv) : '-'}）`);
  }

  console.log('── AI 对战完整局 ──');
  {
    const b = emptyBoard(size);
    let side = 1, moves = 0, winner = 0, illegal = 0;
    const t0 = Date.now();
    for (; moves < 80; moves++) {
      const mv = bestMove(b, size, side, side === 1 ? 6 : 3, true);
      if (mv < 0 || b[mv] !== 0 || (side === 1 && isForbidden(b, size, mv))) { illegal++; break; }
      b[mv] = side;
      if (winLineAfter(b, size, mv, side, true)) { winner = side; moves++; break; }
      side = 3 - side;
    }
    const dur = Date.now() - t0;
    ok(illegal === 0, `80 手内人机互弈无非法落子（黑=专家 白=初级，${moves} 手，${dur}ms）`);
    ok(winner === 1 || winner === 2 || moves >= 80, '对局正常终局或到达手数上限');
  }
  {
    // 棋力梯度：专家(6) 执黑 vs 新手(2，不堵五) —— 专家应快速获胜
    const b = emptyBoard(size);
    let side = 1, winner = 0, moves = 0, illegal = 0;
    for (; moves < 40; moves++) {
      const mv = bestMove(b, size, side, side === 1 ? 6 : 2, true);
      if (mv < 0 || b[mv] !== 0 || (side === 1 && isForbidden(b, size, mv))) { illegal++; break; }
      b[mv] = side;
      if (winLineAfter(b, size, mv, side, true)) { winner = side; moves++; break; }
      side = 3 - side;
    }
    ok(illegal === 0 && winner === 1, `专家执黑 40 手内击败新手（${moves} 手，胜方=${winner === 1 ? '黑' : winner === 2 ? '白' : '无'}）`);
  }
  {
    // 高级 AI 单手耗时上限（棋圣 ≤ 1.2s，避免阻塞宿主事件循环）
    const b = emptyBoard(size);
    for (let k = 0; k < 24; k++) {
      const x = 4 + (k % 5), y = 5 + ((k / 5) | 0);
      b[I(x, y)] = (k % 2) + 1;
    }
    const t0 = Date.now();
    bestMove(b, size, 1, 10, true);
    const dur = Date.now() - t0;
    ok(dur < 1200, `棋圣单手耗时 ${dur}ms < 1200ms`);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
}

module.exports = {
  emptyBoard,
  clampLevel,
  idxToCoord,
  coordToIdx,
  spiralMap,
  parseCoord,
  winLineAfter,
  analyzeBlackPoint,
  isForbidden,
  forbiddenPoints,
  FORBIDDEN_LABEL,
  candidatesNear,
  fiveSpots,
  createsFour,
  vcf,
  bestMove,
  LEVELS,
  levelDan,
  levelName,
  selftest,
};
