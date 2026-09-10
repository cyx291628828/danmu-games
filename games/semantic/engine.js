/**
 * ============================================================================
 * engine.js — 语义猜词引擎（games/semantic）
 * ============================================================================
 * 【原理】与 Semantle/Contexto 同源的词向量玩法：
 *   每个词在 200 维空间中是一个向量，语义相近的词方向接近。
 *   开轮时对全词表各算一次「与答案词的余弦相似度」并排序，得到全词表排名；
 *   之后每条弹幕猜测只需 一次点积 + 一次数组下标查询（微秒级）。
 *
 * 【模型文件】由 scripts/gen_semantic_model.cjs 一次性生成（腾讯 AI Lab 中文词向量精简版）：
 *   model/vectors.f32        裸 float32，行优先 N×200（≈110MB，进程内只读加载一份）
 *   model/vocab.json         { words: [...] }，数组下标 = 向量行号（约按词频降序）
 *   model/answer_pool.json   { words: [...] } 答案候选池（高频 2~4 字纯汉字，已打乱）
 *
 * 【分数口径】
 *   percent = (N - rank) / (N - 1) × 100  —— 即「比词表里百分之多少的词更接近答案」
 *   rank = 1 就是答案本身（100 分 / 猜中）；排名越大分数越低，远词趋近 0。
 *
 * 【自测】node engine.js --selftest
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MODEL_DIR = path.join(__dirname, 'model');
const DIM = 200;

/* ───────────── 模型态（进程内单例，加载后只读） ───────────── */

let model = null;        // { N, words, index:Map, vecs:Float32Array, norms:Float32Array, pool:string[] }
let loadingPromise = null;

/** 当轮排名（模型加载并 setAnswer 后可用） */
let ranks = null;        // Int32Array，ranks[词下标] = 名次（1 起）
let sims = null;         // Float32Array，当轮各词与答案的余弦相似度
let orderCache = null;   // Int32Array，orderCache[r] = 名次 r+1 的词下标（wordHints 用）
let curAnswer = '';
let curAnswerIdx = -1;

/** 模型是否就绪（可 setAnswer / judge） */
function ready() { return !!model; }

/** 模型概况（publicState 展示用；未加载时字段为 0） */
function info() {
  return model
    ? { words: model.N, dim: DIM, pool: model.pool.length, answer: curAnswer ? '已设置' : '未设置' }
    : { words: 0, dim: DIM, pool: 0, answer: '未设置' };
}

/** 预热：模块被 require 时后台开始加载，开轮前大概率已就绪；失败不抛出（由 load 报告） */
function warmup() {
  load().catch(() => {});
}

/** 加载模型（幂等；返回 Promise，全部文件校验通过后才置 ready） */
function load() {
  if (model) return Promise.resolve(model);
  if (!loadingPromise) loadingPromise = doLoad();
  return loadingPromise;
}

async function doLoad() {
  const t0 = Date.now();
  const vecBuf = await fs.promises.readFile(path.join(MODEL_DIR, 'vectors.f32'));
  const vocab = JSON.parse(await fs.promises.readFile(path.join(MODEL_DIR, 'vocab.json'), 'utf8'));
  const poolFile = JSON.parse(await fs.promises.readFile(path.join(MODEL_DIR, 'answer_pool.json'), 'utf8'));
  const words = Array.isArray(vocab.words) ? vocab.words : [];
  const pool = Array.isArray(poolFile.words) ? poolFile.words : [];
  // 按字数分组（2/3/4）；旧版池文件无 by_len 时现场分组兜底
  let poolByLen = (poolFile.by_len && typeof poolFile.by_len === 'object') ? poolFile.by_len : null;
  if (!poolByLen) {
    poolByLen = {};
    for (const w of pool) (poolByLen[w.length] = poolByLen[w.length] || []).push(w);
  }
  const N = words.length;
  if (!N) throw new Error('vocab.json 为空，请先运行 scripts/gen_semantic_model.cjs');
  if (!pool.length) throw new Error('answer_pool.json 为空，请先运行 scripts/gen_semantic_model.cjs');
  if (vecBuf.length !== N * DIM * 4) {
    throw new Error(`vectors.f32 大小 ${vecBuf.length} 与词表 ${N}×${DIM}×4 不符，请重新运行转换脚本`);
  }
  // Float32Array 视图要求 4 字节对齐；大文件走独立 ArrayBuffer 通常天然对齐，兜底再拷一份
  let buffer = vecBuf.buffer, offset = vecBuf.byteOffset;
  if (offset % 4 !== 0) {
    buffer = vecBuf.slice().buffer; offset = 0;
  }
  const vecs = new Float32Array(buffer, offset, N * DIM);
  // 每行向量预先归一化长度，判定时只剩点积
  const norms = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    const off = i * DIM;
    for (let j = 0; j < DIM; j++) { const v = vecs[off + j]; s += v * v; }
    norms[i] = Math.sqrt(s);
  }
  const index = new Map();
  for (let i = 0; i < N; i++) {
    if (!index.has(words[i])) index.set(words[i], i);   // 词表理论上无重复，兜底取首个
  }
  model = { N, words, index, vecs, norms, pool, poolByLen, capacity: N, learned: 0 };
  await mergeCustomWords(model);
  model.capacity = model.N;
  console.log(`[semantic] 模型加载完成：${model.N} 词 × ${DIM} 维，答案池 ${model.pool.length}，耗时 ${Date.now() - t0}ms`);
  return model;
}

/* ───────────── 词库外输入：自动拆词 → 学习入表 → 全表重排 ─────────────
 * 词库只覆盖高频词，观众会输入大量「组合词/口语」（西红柿炒鸡蛋、上课了、卡bug了…）。
 * 处理：贪心最长匹配拆成 ≤4 段词库内已有词，按长度加权平均合成向量，
 *       作为新行正式纳入词表（本进程内有效，重启后首次被猜到会重新学习），
 *       随后全表重排 —— 所有词（原生/自定义/学习）的名次严格唯一，不会出现两个第N名。
 * 完全拆不出来的（生僻字/无关联输入）才走「超远猜测」兜底（index.js 处理）。
 * 学习上限防刷屏膨胀；学习词不进答案池、不落盘。 */
const SYNTH_MAX_PIECES = 4;
const LEARN_MAX = 2000;      // 每次启动最多学习的新词数
const GROW_ROWS = 512;       // 向量缓冲扩容步长（行）

/** 贪心最长匹配拆词；能整词拆成 ≤4 段词库内已有词则返回段列表，否则 null */
function segment(word) {
  const pieces = [];
  let pos = 0;
  while (pos < word.length) {
    let matched = 0;
    for (let L = Math.min(6, word.length - pos); L >= 1; L--) {
      const sub = word.slice(pos, pos + L);
      if (model.index.has(sub)) { matched = L; pieces.push(sub); break; }
    }
    if (!matched) return null;
    pos += matched;
  }
  return (pieces.length && pieces.length <= SYNTH_MAX_PIECES) ? pieces : null;
}

/** 向量/长度缓冲扩容（按 GROW_ROWS 步长） */
function ensureCapacity(rows) {
  if (model.capacity >= rows) return;
  const cap = Math.ceil(rows / GROW_ROWS) * GROW_ROWS;
  const v = new Float32Array(cap * DIM); v.set(model.vecs);
  const n = new Float32Array(cap); n.set(model.norms);
  model.vecs = v; model.norms = n; model.capacity = cap;
}

/**
 * 把词库外的词学习为词表新行（向量 = 拆分段按长度加权平均）。
 * @returns {{row:number, pieces:string[]}|null} null=拆不出来或超过学习上限
 */
function learnWord(word) {
  if (!model || model.learned >= LEARN_MAX) return null;
  const pieces = segment(word);
  if (!pieces) return null;
  const vec = new Float32Array(DIM);
  let wsum = 0;
  for (const p of pieces) {
    const off = model.index.get(p) * DIM;
    const w = p.length;                       // 长词权重更大：主导整词语义
    for (let j = 0; j < DIM; j++) vec[j] += model.vecs[off + j] * w;
    wsum += w;
  }
  for (let j = 0; j < DIM; j++) vec[j] /= wsum;
  ensureCapacity(model.N + 1);
  const row = model.N;
  model.vecs.set(vec, row * DIM);
  let s = 0;
  for (let j = 0; j < DIM; j++) s += vec[j] * vec[j];
  model.norms[row] = Math.sqrt(s);
  model.words.push(word);
  model.index.set(word, row);
  model.N = row + 1;
  model.learned++;
  return { row, pieces };
}

/* ───────────── 自定义词并入（custom_words.json，见 README「加词指南」） ─────────────
 * 每个条目：word → { mix: [词库内已有词…], answer: bool } 或 { vec: [DIM 个浮点] }
 *   mix   = 取这些词向量的平均作为新词向量（词向量语义近线性，组合词效果良好）
 *   vec   = 直接指定 200 维向量（进阶：从同一模型空间取得的现成向量）
 *   answer= true 时同时加入答案候选池（当谜底用）
 *   词库里已有的词不会重定义（只可能按 answer 补进答案池）
 *   mix 可引用先定义的其他自定义词（按文件书写顺序单趟合并）
 */
async function mergeCustomWords(model) {
  const file = path.join(MODEL_DIR, 'custom_words.json');
  if (!fs.existsSync(file)) return;
  let doc;
  try { doc = JSON.parse(await fs.promises.readFile(file, 'utf8')); }
  catch (e) { console.warn('[semantic] custom_words.json 解析失败，跳过:', e.message); return; }

  const entries = Object.entries(doc).filter(([k]) => !k.startsWith('_'));
  if (!entries.length) return;
  const { vecs, norms, index, words } = model;
  const oldN = model.N;

  // 一次性扩容（新增行数上限 = 条目数），随后按实际新增量收缩视图
  const grownVecs = new Float32Array((oldN + entries.length) * DIM);
  grownVecs.set(vecs);
  const grownNorms = new Float32Array(oldN + entries.length);
  grownNorms.set(norms);

  let added = 0;
  const toPool = [];
  for (const [word, spec] of entries) {
    const w = String(word || '').trim();
    if (!w) continue;
    if (index.has(w)) {
      if (spec && spec.answer && !model.pool.includes(w)) toPool.push(w);   // 已在词库：只补答案池
      continue;
    }
    let vec = null;
    if (spec && Array.isArray(spec.vec) && spec.vec.length === DIM) {
      vec = Float32Array.from(spec.vec);
    } else if (spec && Array.isArray(spec.mix) && spec.mix.length) {
      const seeds = spec.mix.map(x => index.get(String(x).trim())).filter(v => v !== undefined);
      if (!seeds.length) { console.warn(`[semantic] 自定义词「${w}」mix 词全不在词库，已跳过`); continue; }
      if (seeds.length < spec.mix.length) {
        console.warn(`[semantic] 自定义词「${w}」有 ${spec.mix.length - seeds.length} 个 mix 词不在词库（已忽略）`);
      }
      vec = new Float32Array(DIM);
      for (const si of seeds) {
        const off = si * DIM;
        for (let j = 0; j < DIM; j++) vec[j] += grownVecs[off + j];
      }
      for (let j = 0; j < DIM; j++) vec[j] /= seeds.length;
    } else {
      console.warn(`[semantic] 自定义词「${w}」缺少有效的 mix/vec，已跳过`);
      continue;
    }
    const row = oldN + added;
    grownVecs.set(vec, row * DIM);
    let s = 0;
    for (let j = 0; j < DIM; j++) s += vec[j] * vec[j];
    grownNorms[row] = Math.sqrt(s);
    words.push(w);
    index.set(w, row);
    added++;
    if (spec && spec.answer) toPool.push(w);
  }

  if (!added && !toPool.length) return;
  for (const w of toPool) if (!model.pool.includes(w)) model.pool.push(w);
  if (added) {
    const finalN = oldN + added;
    model.vecs = new Float32Array(grownVecs.buffer, 0, finalN * DIM);
    model.norms = new Float32Array(grownNorms.buffer, 0, finalN);
    model.N = finalN;
  }
  console.log(`[semantic] 自定义词并入：新增 ${added} 个向量${toPool.length ? `，答案池补充 ${toPool.length} 个` : ''} → 词表 ${model.N} 词`);
}

/** 重新加载模型（替换模型文件或修改 custom_words.json 后调用，无需重启宿主进程） */
function reload() {
  model = null; ranks = null; sims = null;
  curAnswer = ''; curAnswerIdx = -1;
  loadingPromise = null;
  return load();
}

/* ───────────── 开轮：对全词表算一次排名 ───────────── */

/**
 * 设置本轮答案（校验 + 记录），随后由 rerank() 完成全表排名。
 * @param {string} word 答案词（必须在词表内）
 * @returns {{ok:boolean, msg?:string, N?:number, ms?:number}}
 */
function setAnswer(word) {
  if (!model) return { ok: false, msg: '模型未加载（开轮前会自动加载，请稍候重试）' };
  const w = String(word || '').trim();
  const idx = model.index.get(w);
  if (idx === undefined) return { ok: false, msg: `「${w}」不在词表内` };
  curAnswer = w;
  curAnswerIdx = idx;
  return { ok: true, N: model.N, ms: rerank() };
}

/** 全表重排：对当前答案重算全部余弦并降序排名（学习新词后调用，保证名次严格唯一） */
function rerank() {
  const t0 = Date.now();
  const { vecs, norms, N } = model;
  sims = new Float32Array(N);
  const aOff = curAnswerIdx * DIM;
  const aNorm = norms[curAnswerIdx];
  for (let i = 0; i < N; i++) {
    const off = i * DIM;
    let s = 0;
    for (let j = 0; j < DIM; j++) s += vecs[off + j] * vecs[aOff + j];
    const d = norms[i] * aNorm;
    sims[i] = d > 0 ? s / d : 0;
  }
  // 降序排名（同分按词表下标先后，保证确定性；每个词的名次互不相同）
  const order = new Int32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  order.sort((a, b) => (sims[b] - sims[a]) || (a - b));
  ranks = new Int32Array(N);
  for (let r = 0; r < N; r++) ranks[order[r]] = r + 1;
  orderCache = order;
  return Date.now() - t0;
}

/**
 * 从答案池随机选一个（排除最近用过的词）
 * @param {string[]} excludeWords 最近用过的词
 * @param {number} len 答案字数筛选：0=不限，2/3/4=指定字数（该字数池为空时回退全池）
 */
function pickAnswer(excludeWords = [], len = 0) {
  if (!model) return '';
  const ex = new Set(excludeWords);
  let list = model.pool;
  const g = len && model.poolByLen ? model.poolByLen[len] : null;
  if (g && g.length) list = g;
  for (let tries = 0; tries < 50; tries++) {
    const w = list[Math.floor(Math.random() * list.length)];
    if (!ex.has(w)) return w;
  }
  const full = model.pool;   // 指定字数池被排除集耗尽时回退全池
  for (let tries = 0; tries < 50; tries++) {
    const w = full[Math.floor(Math.random() * full.length)];
    if (!ex.has(w)) return w;
  }
  return list[Math.floor(Math.random() * list.length)];
}

/* ───────────── 判定一条猜测 ───────────── */

/* ───────────── 分数曲线：排名 → 百分比（分段折线，锚点按直播手感设计） ─────────────
   百分位线性映射会把远词挤到 80~98%、近词全挤成 99.x；
   纯对数映射又把近义段压扁（第 3 名才 91%）。分段折线两头兼顾：
     第 1 名=100（猜中） · 第 3 名≈98（烫手） · 第 100 名≈84 · 第 1 千名≈65
     第 1 万名≈42 · 第 6 万名≈16 —— 全程单调下降、每一步都有拉力。
   锚点在 log(rank) 空间线性插值；末锚点用 log(N) 收尾（换模型自动适配）。 */
const CURVE_ANCHORS = [
  [1, 100], [3, 98], [10, 95], [30, 90], [100, 84], [300, 75],
  [1000, 65], [3000, 54], [10000, 42], [30000, 27], [80000, 14],
];
function rankToPercent(rank, N) {
  if (rank <= 1) return 100;
  const lg = Math.log(rank);
  const endLg = Math.log(N);
  for (let i = 0; i < CURVE_ANCHORS.length; i++) {
    const [r1, s1] = CURVE_ANCHORS[i];
    const next = CURVE_ANCHORS[i + 1];
    const r2 = next ? next[0] : N;
    const s2 = next ? next[1] : 0;
    if (rank < r2 || i === CURVE_ANCHORS.length - 1) {
      const l1 = Math.log(Math.min(r1, N));
      const l2 = Math.log(r2);
      if (l2 <= l1) return s2;
      return s1 + (s2 - s1) * (lg - l1) / (l2 - l1);
    }
  }
  return 0;
}

/**
 * 判定一个猜测词
 * 词库内 → 全表排名直接查；词库外 → 拆词合成并学习为词表新行 + 全表重排（learned=true）；
 * 拆不出来的 → {ok:false, reason:'oov'}（由游戏模块走「超远猜测」兜底）。
 * 学习/重排后所有词的名次严格唯一，不会出现两个「第N名」。
 * @returns {{ok:false, reason:'notready'|'oov'} | {ok:true, word, rank, rankText, percent, percentText, isWin, sim, learned?, pieces?}}
 */
function judge(word) {
  if (!model || ranks === null) return { ok: false, reason: 'notready' };
  const w = String(word || '').trim();
  let idx = model.index.get(w);
  let learned = false;
  let pieces;
  if (idx === undefined) {
    const lr = learnWord(w);
    if (!lr) return { ok: false, reason: 'oov' };
    idx = lr.row;
    pieces = lr.pieces;
    learned = true;
    rerank();   // 新词纳入后全表重排（约 50ms），此后名次含新词且唯一
  }
  const rank = ranks[idx];
  const percent = rankToPercent(rank, model.N);
  const percentText = rank === 1 ? '100.00' : percent.toFixed(2);
  return {
    ok: true, word: w, rank, rankText: String(rank),
    percent, percentText, isWin: rank === 1, sim: sims[idx],
    learned, pieces,
  };
}

/** 词是否在词表内（主播自定义答案/前端校验用） */
function hasWord(word) {
  return !!(model && model.index.has(String(word || '').trim()));
}

/**
 * 随机取 N 个与答案语义最近的词（礼物/点赞提示词用）。
 * @param {number} [n] 需要的词数
 * @param {number} [from] 名次下限（是否含第 1 名=答案由调用方决定；floor 见下）
 * @param {number} [to]   名次上限
 * 全表 14 万词都已按相似度排好序，任何数量都能取，只是越靠后越偏「相关词」而非「近义词」。
 * 允许 from=1（把答案本身纳入抽取范围）——由调用方按玩法设下限。
 */
function wordHints(n = 3, from = 2, to = 30) {
  if (!model || !orderCache || !n) return [];
  const count = Math.max(1, Math.min(parseInt(n, 10) || 3, model.N - 1));
  let a = Math.max(1, parseInt(from, 10) || 2);           // 允许取到第 1 名（答案）
  const b = Math.min(model.N, Math.max(a, parseInt(to, 10) || 30));
  a = Math.min(a, model.N);
  const cands = [];
  for (let r = a; r <= b; r++) cands.push(model.words[orderCache[r - 1]]);  // orderCache[r-1] = 第 r 名的词
  // Fisher-Yates 抽样
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cands[i], cands[j]] = [cands[j], cands[i]];
  }
  return cands.slice(0, count);
}

/* ───────────── 自测 ───────────── */

async function selftest() {
  await load();
  if (!model) { console.error('❌ 模型加载失败（检查 model/ 三个文件）'); process.exit(1); }
  console.log(`✅ 模型加载：${model.N} 词 × ${DIM} 维，答案池 ${model.pool.length}`);

  const t0 = Date.now();
  const r = setAnswer('教师');
  console.log(`✅ setAnswer(教师)：全表排名计算 ${r.ms}ms（${r.N} 词）`);

  const cases = [['学生', '强相关'], ['老师', '近义'], ['教授', '近义'], ['学校', '相关'],
                 ['西瓜', '无关'], ['宪法', '无关'], ['篮球', '无关']];
  console.log('\n教师 vs 各词（名次 / 百分比）：');
  const shown = {};
  for (const [w] of cases) {
    const j = judge(w);
    shown[w] = j;
    console.log(`  ${w.padEnd(4, '　')} → 第 ${String(j.rank).padStart(6)} 名 · ${j.percentText}%`);
  }
  const rankOf = w => judge(w).rank;
  if (!(rankOf('学生') < rankOf('学校') && rankOf('学校') < rankOf('篮球'))) {
    console.error('❌ 排名顺序异常：学生 应优于 学校 应优于 篮球');
    process.exit(1);
  }
  // 分数曲线手感：近词高、远词低，且近词段要拉得开
  if (!(shown['学生'].percent >= 90 && shown['篮球'].percent <= 35 && shown['西瓜'].percent <= 20)) {
    console.error('❌ 分数曲线手感异常：学生 应≥90，篮球 应≤35，西瓜 应≤20');
    process.exit(1);
  }

  // 学习新词：拆分入表 + 全表重排，名次必须全局唯一（不会出现两个「第N名」）
  setAnswer('教师');
  const beforeN = model.N;
  const lj = judge('教师们');
  // 「教师们」≈「教师」的复数，语义上应紧贴答案：学习成功、第 2 名
  if (!(lj.ok && lj.learned && lj.rank === 2 && lj.percent >= 95)) {
    console.error(`❌ 学习新词异常：教师们 应学习成功且紧贴答案（got 第${lj.rank}名 · ${lj.percentText}%）`);
    process.exit(1);
  }
  if (model.N !== beforeN + 1 || new Set(ranks).size !== ranks.length) {
    console.error('❌ 学习后词表数量或名次唯一性异常');
    process.exit(1);
  }
  console.log(`✅ 学习新词「教师们」（=${lj.pieces.join('+')}）→ 第 ${lj.rank} 名 · ${lj.percentText}%；全表 ${model.N} 词名次唯一`);
  // 重复学习同一词：第二次直接命中词表，不再新增
  const lj2 = judge('教师们');
  if (!lj2.ok || lj2.learned || lj2.rank !== lj.rank || model.N !== beforeN + 1) {
    console.error('❌ 重复判定已学习词异常');
    process.exit(1);
  }

  // 再验一轮：换答案后排名必须整体重算
  setAnswer('西瓜');
  const j2 = judge('西瓜');
  if (j2.rank !== 1) { console.error('❌ 换答案后自排名应为第 1 名'); process.exit(1); }
  const j3 = judge('苹果');
  console.log(`✅ 换答案（西瓜）：自排名 1；苹果 → 第 ${j3.rank} 名 · ${j3.percentText}%`);
  console.log(`✅ 答案池抽样：${pickAnswer([])}、${pickAnswer([])}、${pickAnswer([])}`);
  console.log(`\n✅ 自测全部通过（总耗时 ${Date.now() - t0}ms）`);
}

if (require.main === module) {
  selftest().catch(e => { console.error('自测异常:', e); process.exit(1); });
}

module.exports = { load, warmup, ready, info, setAnswer, pickAnswer, judge, hasWord, wordHints, reload, selftest };
