'use strict';
/* 独立交叉验证：引擎生成的 3 位题目，线索能否唯一确定答案 */
const engine = require('../engine');

/* —— 独立实现（不调用引擎内部） —— */
const POOL = [0,1,2,3,4,5,6,7,8,9];
function myCandidates(digits) {           // 独立候选枚举（首位非0、不重复）
  const out = [];
  const used = new Array(10).fill(false);
  (function rec(arr, depth) {
    if (depth === digits) { out.push(arr.slice()); return; }
    for (const d of POOL) {
      if (used[d]) continue;
      if (depth === 0 && d === 0) continue;
      used[d] = true; arr.push(d);
      rec(arr, depth + 1);
      arr.pop(); used[d] = false;
    }
  })([], 0);
  return out;
}
function myFeedback(gArr, aArr) {         // 独立反馈：exact=数字对且位对, near=数字对位错
  let exact = 0, near = 0;
  const g = gArr.slice(), a = aArr.slice();
  for (let i = 0; i < g.length; i++) if (g[i] === a[i]) { exact++; g[i] = -1; a[i] = -2; }
  for (const d of g) { if (d < 0) continue; const idx = a.indexOf(d); if (idx >= 0) { near++; a[idx] = -2; } }
  return { exact, near };
}
function myCount(cands, clues, ansArr) {  // 独立统计满足所有线索的候选
  let n = 0, only = null;
  let solved = false;
  for (const c of cands) {
    let ok = true;
    for (const cl of clues) {
      const f = myFeedback(c, cl.guessArr);
      if (f.exact !== cl.fb.exact || f.near !== cl.fb.near) { ok = false; break; }
    }
    if (ok) { n++; only = c; if (c.join('') === ansArr.join('')) solved = true; }
  }
  return { n, isAns: (n === 1 && solved) };
}

/* —— 主验证 —— */
function verify(digits, count) {
  engine.setDigitCount(digits);
  const cands = myCandidates(digits);       // 独立候选空间
  let pass = 0, fail = 0, maxSurvivor = 0;
  const hintDist = {};
  const examples = [];
  for (let i = 0; i < count; i++) {
    let p = null;
    for (let t = 0; t < 50 && !p; t++) { try { p = engine.generatePuzzle(); } catch { p = null; } }
    if (!p) { fail++; continue; }
    // 用独立实现构造线索（guessArr = 谜面数字数组）
    const clues = p.clues.map(c => ({ guessArr: c.num.split('').map(Number), fb: { exact: c.exact, near: c.near } }));
    const ansArr = p.answer.split('').map(Number);
    const r = myCount(cands, clues, ansArr);
    for (const cl of clues) {
      const k = `${cl.fb.exact}/${cl.fb.near}`;
      hintDist[k] = (hintDist[k] || 0) + 1;
    }
    if (r.n === 1 && r.isAns) pass++;
    else {
      fail++;
      maxSurvivor = Math.max(maxSurvivor, r.n);
      if (examples.length < 3) examples.push({ ans: p.answer, n: r.n, isAns: r.isAns, clues: p.clues.map(c => `${c.numFmt}→${c.hint}`) });
    }
  }
  const dist = Object.entries(hintDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${(v / (count * digits / digits) * 100 / 3).toFixed(0)}%`).join(' ');
  console.log(`【${digits} 位】验证 ${count} 题：唯一确定 ${pass}，失败 ${fail}  ${fail ? `(最大幸存候选 ${maxSurvivor})` : ''}`);
  console.log(`   线索反馈分布(数字对/位对): ${dist}`);
  for (const e of examples) console.log('  失败示例:', JSON.stringify(e));
  return fail === 0;
}

const N = parseInt(process.argv[2] || '2000', 10);
const ok3 = verify(3, N);
const ok4 = verify(4, N);
console.log(ok3 && ok4 ? '\n✅ 全部通过：引擎题目在线索给出后唯一确定答案' : '\n❌ 存在失败，需要修复');
process.exit(ok3 && ok4 ? 0 : 1);