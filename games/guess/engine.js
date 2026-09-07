/**
 * ============================================================================
 * engine.js — 猜数字游戏出题引擎
 * ============================================================================
 *
 * 【玩法】
 *   每轮隐藏一个 N 位不重复数字（默认首位非 0，N=3 或 4，见 setDigitCount）作为答案 S，
 *   公布 N 条线索：每条 = 一个 N 位谜面数 G + 提示文案。
 *   提示语义（沿用主播原话，数学上等价标准 A/B 反馈）：
 *     - digitOk = X = 谜面 G 中出现在答案里的数字个数（位置不论）
 *     - posOk  = Y = 其中不仅数字对、位置也对（Y <= X）
 *     - 对外展示用通用 A/B 记谱：A = 数字对且位置对 = posOk = Y，
 *                                B = 数字对但位置错 = digitOk - posOk = X - Y
 *       即：exact(A)=Y, near(B)=X-Y, digitOk=X, posOk=Y
 *
 * 【唯一性保证（核心）】
 *   生成候选答案后，对全部候选空间暴力枚举：
 *   统计"同时满足全部 4 条线索反馈"的候选数，
 *   仅当恰好 = 1（且就是答案本身）时本题才被采纳，否则重新生成。
 *   结论：全部线索（N 条）给出后，观众可推知且只能推知唯一答案。
 *
 * 【质量约束】
 *   - 谜面数互不相同，且不等于答案（避免直接剧透）
 *   - 任何线索反馈不能是 N/0（等于直接写出答案）
 *   - "0A0B"（一个数字都不对）的线索最多允许 1 条（避免整题全是排除法）
 *
 * 【自测】
 *   node engine.js --selftest 1000   # 生成 1000 题并逐一校验唯一性
 * ============================================================================
 */
'use strict';

const POOL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** 当前位数（3 或 4），由 server 通过 setDigitCount 设置 */
let DIGITS = 4;

/** 是否允许答案/谜面首位为 0（默认 false） */
let leadingZero = false;

/** 设置当前位数（3=简单 / 4=标准），同时重建候选缓存 */
function setDigitCount(n) {
  const v = parseInt(n, 10);
  if (v === 3 || v === 4) {
    DIGITS = v;
    CANDIDATES = null; // 候选空间随位数变化，强制重建
  }
  return DIGITS;
}
function getDigitCount() { return DIGITS; }

/**
 * 全部合法候选（4 位不重复数字）
 * @returns {number[][]} 数字数组列表（每个是 4 个 int）
 */
function buildCandidates() {
  const out = [];
  const used = new Array(10).fill(false);
  const rec = (arr, depth) => {
    if (depth === DIGITS) { out.push(arr.slice()); return; }
    for (const d of POOL) {
      if (used[d]) continue;
      if (depth === 0 && d === 0 && !leadingZero) continue; // 首位非 0
      used[d] = true; arr.push(d);
      rec(arr, depth + 1);
      arr.pop(); used[d] = false;
    }
  };
  rec([], 0);
  return out;
}

/** 全量候选缓存（引擎初始化时惰性建立） */
let CANDIDATES = null;
function candidates() {
  if (!CANDIDATES) CANDIDATES = buildCandidates();
  return CANDIDATES;
}

/**
 * 计算反馈
 * @param {number[]|string|number} guess 谜面
 * @param {number[]|string|number} answer 答案
 * @returns {{exact:number, near:number, digitOk:number, posOk:number}}
 *   exact=数字对且位置对(A)；near=数字对位置错(B)；digitOk=A+B=X；posOk=A=Y
 */
function feedback(guess, answer) {
  const g = toArr(guess);
  const a = toArr(answer);
  let exact = 0;
  for (let i = 0; i < DIGITS; i++) if (g[i] === a[i]) exact++;
  let near = 0;
  const ga = g.filter((d, i) => d !== a[i]);
  const aa = a.filter((d, i) => g[i] !== d);
  for (const d of ga) {
    const idx = aa.indexOf(d);
    if (idx >= 0) { near++; aa.splice(idx, 1); }
  }
  return { exact, near, digitOk: exact + near, posOk: exact };
}

/** 数字数组/字符串/数字 → 4 位 int 数组 */
function toArr(v) {
  if (Array.isArray(v)) return v;
  return String(v).split('').map(Number);
}

/** 数字数组/字符串格式化成"1 2 3 4"展示串 */
function fmt(v) {
  if (Array.isArray(v)) return v.join(' ');
  return String(v).split('').join(' ');
}

/**
 * 生成提示文案（通用 A/B 记谱）
 *   A = 数字对且位置也对（exact / posOk）
 *   B = 数字对但位置错  （near  / digitOk - posOk）
 * 例：digitOk=2, posOk=1  →  "1A1B"（1 个全对 + 1 个错位）
 *      digitOk=1, posOk=1  →  "1A0B"（1 个全对，无错位）
 * @param {{digitOk,posOk}} fb 反馈
 */
function hintText(fb) {
  const a = fb.posOk || 0;                       // A：数字对且位置对
  const b = Math.max(0, (fb.digitOk || 0) - a);  // B：数字对但位置错
  return `${a}A${b}B`;
}

/**
 * 统计满足全部线索反馈的候选数
 * @param {Array<{num:number[], fb:object}>} clueFbs
 * @returns {{uniqueCount:number, survivors:number[][]}}
 */
function countCandidates(clueFbs) {
  const survivors = [];
  for (const c of candidates()) {
    let ok = true;
    for (const cf of clueFbs) {
      const f = feedback(c, cf.num);
      if (f.exact !== cf.fb.exact || f.near !== cf.fb.near) { ok = false; break; }
    }
    if (ok) survivors.push(c);
  }
  return { uniqueCount: survivors.length, survivors };
}

function randInt(n) { return Math.floor(Math.random() * n); }

function pickDistinctCandidates(excludeSet, n) {
  const pool = candidates().filter(c => !excludeSet.has(c.join('')));
  const picked = [];
  for (let i = 0; i < n && pool.length; i++) {
    const idx = randInt(pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

/**
 * 生成一题（含唯一性校验，失败自动重试）
 * @param {object} [opts] {leadingZero?:boolean, maxAttempts?:number}
 * @returns {object} 题目对象（见下）
 */
function generatePuzzle(opts = {}) {
  if (opts.leadingZero !== undefined) leadingZero = !!opts.leadingZero;
  CANDIDATES = null; // 首位规则可能变化，重建
  const maxAttempts = opts.maxAttempts || 50000;
  const nClue = DIGITS; // 线索数 = 位数（4位4条 / 3位3条）

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const answer = candidates()[randInt(candidates().length)];
    const clues = pickDistinctCandidates(new Set([answer.join('')]), nClue);
    if (clues.length < nClue) continue;

    const clueFbs = clues.map(num => ({ num, fb: feedback(num, answer) }));

    // 质量约束：不允许剧透线索（全部位置正确）；"0A0B" 最多 1 条
    if (clueFbs.some(cf => cf.fb.exact === DIGITS)) continue;
    const zeroOk = clueFbs.filter(cf => cf.fb.digitOk === 0).length;
    if (zeroOk > 1) continue;
    // 线索间避免出现完全相同的反馈文本之外的极端重复（不同谜面允许相同反馈）
    // 若全部反馈完全相同，信息高度冗余，重来
    const sigSet = new Set(clueFbs.map(cf => `${cf.fb.exact}/${cf.fb.near}`));
    if (sigSet.size === 1) continue;

    const { uniqueCount, survivors } = countCandidates(clueFbs);
    if (uniqueCount === 1 && survivors[0].join('') === answer.join('')) {
      return {
        answer: answer.join(''),
        answerFmt: fmt(answer),
        clues: clueFbs.map(cf => ({
          num: cf.num.join(''),
          numFmt: fmt(cf.num),
          exact: cf.fb.exact,
          near: cf.fb.near,
          digitOk: cf.fb.digitOk,
          posOk: cf.fb.posOk,
          hint: hintText(cf.fb),
          hintShort: `${cf.fb.digitOk}✓${cf.fb.posOk}位`,
        })),
        uniqueCount,
        attempts: attempt + 1,
      };
    }
  }
  throw new Error('generatePuzzle: 未能在限定次数内生成唯一题（概率极低，可调大 maxAttempts）');
}

/**
 * 判定一条玩家猜测
 * @param {string|number} guess 玩家弹幕中的 N 位数字字符串
 * @param {string} answer 当前轮答案
 * @returns {object|null} 合法 => 反馈对象；不合法 => null
 */
function judgeGuess(guess, answer) {
  const s = String(guess || '').trim();
  if (!new RegExp(`^\\d{${DIGITS}}$`).test(s)) return null;  // 必须 N 位数字
  if (new Set(s).size !== DIGITS) return null;               // 必须不重复
  const fb = feedback(s, answer);
  return {
    guess: s,
    guessFmt: fmt(s),
    exact: fb.exact,
    near: fb.near,
    digitOk: fb.digitOk,
    posOk: fb.posOk,
    hint: hintText(fb),
    isWin: fb.exact === DIGITS,
  };
}

// ───────────────────────── 自测 ─────────────────────────

/** 自测：生成 N 题，全部必须满足唯一性 */
function selftest(count = 1000) {
  const t0 = Date.now();
  let maxAttempts = 0;
  const stats = { hints: new Map() };
  for (let i = 0; i < count; i++) {
    const p = generatePuzzle({ maxAttempts: 50000 });
    if (p.attempts > maxAttempts) maxAttempts = p.attempts;
    for (const c of p.clues) {
      const key = `${c.digitOk}x${c.posOk}`;
      stats.hints.set(key, (stats.hints.get(key) || 0) + 1);
    }
  }
  const dist = Array.from(stats.hints.entries()).sort((a, b) => b[1] - a[1]);
  console.log(`✅ 自测通过：生成 ${count} 题，全部满足「${DIGITS} 条线索唯一确定答案」（${DIGITS} 位）`);
  console.log(`   耗时 ${Date.now() - t0}ms，单题最大重试 ${maxAttempts} 次`);
  console.log(`   线索反馈分布(数字对x位置对): ${dist.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  // 展示一道示例题
  const sample = generatePuzzle();
  console.log('\n示例题：');
  console.log(`  答案: ${sample.answerFmt}`);
  for (let i = 0; i < sample.clues.length; i++) {
    console.log(`  线索${i + 1}: ${sample.clues[i].numFmt}  →  ${sample.clues[i].hint}`);
  }
  console.log(`  候选解数: ${sample.uniqueCount}\n`);
}

if (require.main === module) {
  const argIdx = process.argv.findIndex(a => a.startsWith('--selftest'));
  let n = 1000;
  if (argIdx >= 0) {
    const eq = process.argv[argIdx].split('=')[1];
    n = eq !== undefined ? parseInt(eq, 10) : parseInt(process.argv[argIdx + 1] || '1000', 10);
    if (!Number.isFinite(n) || n <= 0) n = 1000;
  }
  selftest(n);
}

module.exports = { generatePuzzle, feedback, judgeGuess, hintText, fmt, buildCandidates, countCandidates, selftest, setDigitCount, getDigitCount };