/**
 * xieyin_poc.cjs — 谐音梗猜词·可行性验证
 * 思路：答案词拆成单字音节 → 从「可画事物字典」里找同音/近音物 → 每个字一张图
 * 结论目标：验证"题目不需要预存图片，靠算法自动生成"是否成立、产量多少
 */
'use strict';
const { pinyin } = require('pinyin-pro');
const chengyuDict = require('../games/chengyu/chengyu_dict.js');

// ---------- 可画事物字典（PoC 版 ~120 项，正式版可扩到 300-500） ----------
// w=事物名 e=emoji（正式版可换成 AI 生成的统一风格图标文件）
const THINGS = [
  // 动物
  ['马','🐎'],['牛','🐂'],['羊','🐑'],['猪','🐖'],['狗','🐕'],['猫','🐈'],
  ['鸡','🐔'],['鸭','🦆'],['鹅','🦢'],['鱼','🐟'],['虾','🦐'],['蟹','🦀'],
  ['龟','🐢'],['蛇','🐍'],['虫','🐛'],['鼠','🐀'],['兔','🐰'],['虎','🐯'],
  ['狼','🐺'],['熊','🐻'],['猴','🐵'],['鹿','🦌'],['象','🐘'],['狮','🦁'],
  ['豹','🐆'],['鹰','🦅'],['燕','🐦'],['鸦','🐦'],['蜂','🐝'],['蝶','🦋'],
  ['蚁','🐜'],['蜗牛','🐌'],['鲸','🐳'],['鲨','🦈'],['章鱼','🐙'],['恐龙','🐲'],
  ['孔雀','🦚'],['骆驼','🐫'],['刺猬','🦔'],['猫头鹰','🦉'],['松鼠','🐿️'],
  ['袋鼠','🦘'],['河马','🦛'],['犀牛','🦏'],['羊驼','🦙'],['海豚','🐬'],
  ['狮子','🦁'],['大象','🐘'],['乌龟','🐢'],['蜘蛛','🕷️'],['蜗牛','🐌'],
  // 植物/食物
  ['花','🌸'],['草','🌿'],['树','🌳'],['叶','🍃'],['果','🍎'],['桃','🍑'],
  ['梨','🍐'],['香蕉','🍌'],['葡萄','🍇'],['瓜','🍉'],['草莓','🍓'],
  ['樱桃','🍒'],['菠萝','🍍'],['芒果','🥭'],['椰子','🥥'],['蘑菇','🍄'],
  ['玉米','🌽'],['茄子','🍆'],['辣椒','🌶️'],['萝卜','🥕'],['米饭','🍚'],
  ['面条','🍜'],['饺子','🥟'],['糖','🍬'],['蛋糕','🍰'],['蛋','🥚'],
  ['奶','🥛'],['酒','🍺'],['茶','🍵'],['咖啡','☕'],['盐','🧂'],['蜂蜜','🍯'],
  ['面包','🍞'],['饼干','🍪'],['冰淇淋','🍦'],['西瓜','🍉'],
  // 自然
  ['山','⛰️'],['水','💧'],['火','🔥'],['冰','🧊'],['雪','❄️'],['雨','🌧️'],
  ['云','☁️'],['雷','⚡'],['彩虹','🌈'],['太阳','☀️'],['月亮','🌙'],
  ['星星','⭐'],['海','🌊'],['石头','🪨'],['金','🥇'],['银','🥈'],['玉','💎'],
  ['沙','🏖️'],['洞','🕳️'],['桥','🌉'],['塔','🗼'],
  // 物品
  ['衣','👕'],['裤','👖'],['鞋','👟'],['帽','🎩'],['袜','🧦'],['伞','☂️'],
  ['书','📖'],['笔','🖊️'],['剪刀','✂️'],['锁','🔒'],['钥匙','🔑'],
  ['锤','🔨'],['斧','🪓'],['针','🪡'],['线','🧵'],['球','⚽'],['鼓','🥁'],
  ['号','🎺'],['琴','🎹'],['钟','🕐'],['表','⌚'],['镜','🪞'],['灯','💡'],
  ['灯笼','🏮'],['蜡烛','🕯️'],['船','⛵'],['车','🚗'],['飞机','✈️'],
  ['火车','🚆'],['自行车','🚲'],['桌','🪑'],['门','🚪'],['窗','🪟'],
  ['床','🛏️'],['电话','📞'],['相机','📷'],['电视','📺'],['电脑','💻'],
  ['钱','💰'],['信','✉️'],['旗','🚩'],['铃','🔔'],['剑','⚔️'],['弓','🏹'],
  // 身体
  ['心','❤️'],['眼','👁️'],['耳','👂'],['鼻','👃'],['嘴','👄'],['手','✋'],
  ['脚','🦶'],['骨','🦴'],['牙','🦷'],['脑','🧠'],
];

// ---------- 拼音工具 ----------
function toneless(ch) {
  const py = pinyin(ch, { toneType: 'none', type: 'array', multiple: true });
  return py; // 多音字返回多个读音
}
// 谐音宽松化：zh/ch/sh→z/c/s，ng→n，n→l，lv→lu
function fuzzy(s) {
  return s.replace(/zh/g, 'z').replace(/ch/g, 'c').replace(/sh/g, 's')
          .replace(/ng/g, 'n').replace(/^n/, 'l').replace(/lv/g, 'lu');
}
function matchLevel(a, b) { // 0=同音 1=近音(谐音) -1=不匹配
  const A = toneless(a), B = toneless(b);
  let best = -1;
  for (const x of A) for (const y of B) {
    if (x === y) best = Math.max(best, 0);
    else if (fuzzy(x) === fuzzy(y)) best = Math.max(best, 1);
  }
  return best;
}

// 事物索引：每个音节 → 事物（多字事物拆每个音节都入索引，标注用第几个字）
const sylIndex = []; // { thing, emoji, sylChar, exact }
const seen = new Set();
for (const [w, e] of THINGS) {
  if (seen.has(w + e)) continue; seen.add(w + e);
  const chars = [...w];
  chars.forEach((c, i) => {
    const pys = toneless(c);
    for (const py of pys) {
      sylIndex.push({ thing: w, emoji: e, sylChar: c, pos: i, len: chars.length, py });
    }
  });
}

function findImagesForChar(ch, limit = 4) {
  const pys = toneless(ch);
  const hits = [];
  for (const entry of sylIndex) {
    for (const py of pys) {
      let lv = -1;
      if (entry.py === py) lv = 0;
      else if (fuzzy(entry.py) === fuzzy(py)) lv = 1;
      if (lv >= 0) {
        hits.push({ ...entry, lv, exactChar: entry.sylChar === ch });
      }
    }
  }
  // 排序：同音 > 谐音；字面相同 > 字面不同；单字物 > 多字物
  hits.sort((a, b) => a.lv - b.lv || (b.exactChar - a.exactChar) || (a.len - b.len));
  return hits.slice(0, limit);
}

// ---------- 数据源 1：候选答案词（2 字 = 2 张图） ----------
const CANDIDATES = ('相遇 理由 蜜月 白鹭 立正 猴急 猪蹄 熊猫 蜂蜜 眼泪 雪人 月光 星光 '
  + '风口 火锅 雨伞 山羊 蛋糕 面包 书包 电话 电脑 电视 银行 金鱼 鲸鱼 海马 恐龙 '
  + '免费 面试 理发 减肥 考试 加班 幸运 恭喜 发财 快乐 幸福 中国 北京 上海 广州 '
  + '楼梯 电梯 窗帘 牙刷 镜子 钥匙 锁门 船长 飞机 火车 司机 老师 学生 医生 护士 '
  + '老板 员工 农民 工人 士兵 警察 小偷 强盗 皇帝 大臣 王子 公主 仙女 魔鬼 天使 '
  + '英雄 美人 情人 恋人 夫妻 父母 儿子 女儿 兄弟 姐妹 朋友 同学 同事 邻居 客人').split(/\s+/);

let ok2 = 0, examples2 = [];
for (const word of CANDIDATES) {
  const chars = [...word];
  if (chars.length !== 2) continue;
  const img0 = findImagesForChar(chars[0], 1);
  const img1 = findImagesForChar(chars[1], 1);
  if (img0.length && img1.length) {
    ok2++;
    if (examples2.length < 12) {
      examples2.push(`${img0[0].emoji}${img1[0].emoji} → ${word}`
        + (img0[0].lv + img1[0].lv > 0 ? '（谐音）' : '（同音）'));
    }
  }
}

// ---------- 数据源 2：成语词典（4 字 = 4 张图，疯狂猜成语式） ----------
let ok4 = 0, examples4 = [];
for (const { w } of chengyuDict) {
  const chars = [...w];
  if (chars.length !== 4) continue;
  const imgs = chars.map(c => findImagesForChar(c, 1));
  if (imgs.every(a => a.length)) {
    ok4++;
    if (examples4.length < 8) {
      examples4.push(`${imgs.map(i => i[0].emoji).join('')} → ${w}（${imgs.map(i => i[0].sylChar).join('')}）`);
    }
  }
}

console.log(`可画事物字典：${sylIndex.length} 个音节索引 / ${THINGS.length} 个事物（去重前）`);
console.log(`\n【2 字词答案】候选 ${CANDIDATES.length} 词，可出题 ${ok2} 词（${(ok2 / CANDIDATES.length * 100).toFixed(0)}%）`);
examples2.forEach(s => console.log('  ' + s));
console.log(`\n【4 字成语答案】成语库共 ${chengyuDict.length} 条，4 图全可配 ${ok4} 条（${(ok4 / chengyuDict.length * 100).toFixed(0)}%）`);
examples4.forEach(s => console.log('  ' + s));
