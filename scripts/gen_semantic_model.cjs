/**
 * ============================================================================
 * scripts/gen_semantic_model.cjs — 语义猜词模型转换脚本（一次性预处理）
 * ============================================================================
 * 把标准 word2vec 二进制词向量（腾讯 AI Lab 中文词向量精简版）转换成
 * games/semantic/engine.js 运行时使用的三份文件：
 *
 *   model/vectors.f32        裸 float32，行优先 N×D（启动零解析直接 Float32Array 视图）
 *   model/vocab.json         { words: [...] }，数组下标 = 向量行号（按训练词频降序）
 *   model/answer_pool.json   { words, by_len } 答案候选池（虚词清洗后按字数配额的常用实词，已打乱）
 *
 * 源文件格式（word2vec C 二进制）：
 *   首行文本 "N D\n"；之后 N 条记录 = 词字节串(以空格/换行结束) + D 个 float32(小端)
 *
 * 用法：
 *   node scripts/gen_semantic_model.cjs [源文件路径]
 *   缺省源文件：games/semantic/model/source/light_Tencent_AILab_ChineseEmbedding.bin（已随项目存放）
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'games', 'semantic', 'model');
const DIM = 200;

/* ═══════════════ 答案池清洗规则（虚词/碎片剔除，留常用实词）═══════════════
 * 与运行时 custom_words 的 answer 追加互补；改动这里 → 重跑本脚本即可复现干净答案池。 */
// ① 整词黑名单：代词/副词/连词/介词/助词/语气/抽象时空词
const ANSWER_STOP = new Set((
  '我们 你们 他们 她们 它们 咱们 自己 大家 别人 人家 这个 那个 这些 那些 这样 那样 这么 那么 怎么 怎样 什么 哪个 哪些 这里 那里 哪里 ' +
  '就是 不是 没有 不会 不能 不要 可以 可能 应该 必须 需要 也许 或者 已经 正在 将要 曾经 一直 一定 一起 一样 一切 一下 ' +
  '非常 特别 十分 极其 格外 尤其 相当 比较 更 最 太 很 挺 蛮 ' +
  '然后 而且 但是 可是 因为 所以 如果 虽然 于是 并且 不过 只是 尽管 即使 哪怕 无论 不管 既然 ' +
  '以及 关于 通过 根据 按照 由于 对于 除了 例如 比如 仿佛 好像 似乎 类似 同样 相同 不同 另外 此外 别的 其余 全部 整个 整体 ' +
  '目前 此刻 现在 过去 将来 以后 以前 以来 当时 同时 今天 昨天 明天 今年 去年 明年 最近 一般 上面 下面 里面 外面 之中 之间 之上 之下 之内 之外 ' +
  '时候 地方 东西 问题 情况 样子 方面 每个 各个 各种 其他 其它 所有 有些 有点 有人 有的 一点 一些 一边 一切 ' +
  '突然 后来 首先 其次 最后 看来 随后 期间 所在 与会 予以 难以 并未 并非 并无 无法 得以 由此 从中 出来 起来 上去 下去 进来 出去 回来 过来 ' +
  '表示 直接 能够 当然 肯定 是否 如何 更多 一种 哈哈 发生 影响 使用 带来 建议 要求 进入 甚至 结果 原因'
).split(/\s+/).filter(Boolean));
// ② 首字虚词（不/没/只/就/还/又/都/很/当/并/更/将/把/被/让/向/对… 开头一律不当谜底）
const BAD_FIRST = new Set('不没任何某那此甚另其这那哪谁咱您每各只能仅将其被把让使给再越据就还又都也才很太较挺蛮颇甚极超真当要对往朝从向'.split(''));
// ③ 二字词「第二字」为虚字/助词/量词 → 判为碎片
const BAD_2ND = new Set('在之于当并更似要已就都也又还只才很太较挺颇甚极超真当被把让使给向对往朝从过着地得快要能会有的了这那个么样事'.split(''));
// ④ 尾字助词/语气词 → 判为碎片
const BAD_TAIL = new Set('吗呢吧啊呀哦嗯么啦呗哟们了着过地得'.split(''));
const HAN = /^[\u4e00-\u9fa5]+$/;
// ⑤ 含以下口语碎片词根 → 剔
const FRAG = ['什么','时候','东西','事情','这样','那样','这么','那么','有点','有些','有人','怎么','如何','是否','或许','大概','可能','应该','必须','需要','能够','可以','越来越','是不是','回到家','据介绍','昨天','今天','感觉'];
function isFunctionWord(w) {
  if (w.length < 2 || !HAN.test(w)) return true;
  if (ANSWER_STOP.has(w)) return true;
  if (/[他她它哪怎啥]/.test(w)) return true;
  if (BAD_FIRST.has(w[0])) return true;
  if (w.length === 2 && BAD_2ND.has(w[1])) return true;
  if (BAD_TAIL.has(w[w.length - 1])) return true;
  if (w.includes('的')) return true;
  if (FRAG.some(f => w.includes(f))) return true;
  return false;
}
// 答案池规模配额（按字数，取词频最高的实词）
const ANSWER_QUOTA = { 2: 2500, 3: 900, 4: 300 };

function main() {
  // 源词向量 bin 已随项目存放于 games/semantic/model/source/（116MB，标准 word2vec 二进制）
  const src = process.argv[2] || path.join(OUT_DIR, 'source', 'light_Tencent_AILab_ChineseEmbedding.bin');
  if (!fs.existsSync(src)) {
    console.error(`[错误] 源文件不存在: ${src}`);
    console.error('用法: node scripts/gen_semantic_model.cjs <word2vec二进制文件>');
    process.exit(1);
  }

  console.log(`[1/4] 读取源文件: ${src}`);
  const t0 = Date.now();
  const buf = fs.readFileSync(src);
  console.log(`      ${buf.length} 字节（${(buf.length / 1024 / 1024).toFixed(1)} MB），读取耗时 ${Date.now() - t0}ms`);

  // ── 解析头行 "N D" ──
  let pos = buf.indexOf(0x0a);
  if (pos < 0) { console.error('[错误] 找不到头行换行符'); process.exit(1); }
  const header = buf.slice(0, pos).toString('utf8').trim();
  const m = header.match(/^(\d+)\s+(\d+)$/);
  if (!m) { console.error(`[错误] 头行格式异常: "${header}"`); process.exit(1); }
  const N = parseInt(m[1], 10), D = parseInt(m[2], 10);
  if (D !== DIM) { console.error(`[错误] 维度 ${D} ≠ 引擎期望的 ${DIM}，请调整 DIM 常量后重试`); process.exit(1); }
  pos++;
  console.log(`[2/4] 解析 ${N} 词 × ${D} 维 …`);

  const words = new Array(N);
  const vectors = Buffer.allocUnsafe(N * D * 4);   // 输出的裸 float32
  let outOff = 0;
  const t1 = Date.now();
  for (let i = 0; i < N; i++) {
    const start = pos;
    while (pos < buf.length && buf[pos] !== 0x20 && buf[pos] !== 0x0a) pos++;
    words[i] = buf.slice(start, pos).toString('utf8');
    pos++;                                          // 跳过词后的空格/换行
    buf.copy(vectors, outOff, pos, pos + D * 4);
    outOff += D * 4;
    pos += D * 4;
  }
  if (outOff !== N * D * 4) { console.error('[错误] 向量数据不完整'); process.exit(1); }
  console.log(`      解析完成，耗时 ${Date.now() - t1}ms，前 5 词: ${words.slice(0, 5).join(' ')}`);

  // ── 生成答案候选池（虚词清洗 + 按字数配额取常用实词，供主播台「答案字数」筛选） ──
  // 词表按词频降序，逐长度从高频往下收，遇 isFunctionWord 跳过，收满配额即止。
  const byLen = { 2: [], 3: [], 4: [] };
  for (let i = 0; i < N; i++) {
    const w = words[i];
    const L = w.length;
    if (L < 2 || L > 4 || !HAN.test(w)) continue;
    if (byLen[L].length >= ANSWER_QUOTA[L]) continue;   // 该字数已收满
    if (isFunctionWord(w)) continue;
    byLen[L].push(w);
  }
  const pool = [...byLen[2], ...byLen[3], ...byLen[4]];
  // 打乱（Fisher-Yates），避免随机答案偏向高频头部
  for (const key of Object.keys(byLen)) {
    const list = byLen[key];
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  console.log(`[3/4] 答案候选池: 共 ${pool.length} 词（2字 ${byLen[2].length} / 3字 ${byLen[3].length} / 4字 ${byLen[4].length}，配额 ${Object.values(ANSWER_QUOTA).join('/')}）`);
  console.log('      2字抽样: ' + byLen[2].slice(0, 20).join('、'));

  // ── 落盘 ──
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'vectors.f32'), vectors);
  fs.writeFileSync(path.join(OUT_DIR, 'vocab.json'), JSON.stringify({ words }));
  fs.writeFileSync(path.join(OUT_DIR, 'answer_pool.json'), JSON.stringify({ words: pool, by_len: byLen }));
  const mb = p => (fs.statSync(p).size / 1024 / 1024).toFixed(1) + ' MB';
  console.log(`[4/4] 已写入 ${OUT_DIR}`);
  console.log(`      vectors.f32      ${mb(path.join(OUT_DIR, 'vectors.f32'))}`);
  console.log(`      vocab.json       ${mb(path.join(OUT_DIR, 'vocab.json'))}`);
  console.log(`      answer_pool.json ${mb(path.join(OUT_DIR, 'answer_pool.json'))}`);
  console.log('完成。');
}

main();
