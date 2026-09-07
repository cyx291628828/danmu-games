/**
 * ============================================================================
 * games/quiz/quiz_bank.js — 答题竞猜内置题库
 * ============================================================================
 * 每题结构：
 *   q       题干（字符串）
 *   options 选项数组（>=2 项，字符串）
 *   answer  正确选项下标（0 起始）
 *   explain 解析（可选，揭晓时展示）
 *
 * 题目取向：通用百科/生活/科学/文学/体育等中性话题，避免政治敏感内容。
 * 用户可在 games/quiz/ 下放置 custom_quiz.json（数组，结构与内置一致），
 * 程序会自动合并（用户题优先覆盖同题干题）。
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BUILTIN = [
  { q: '一年中有几个月有 31 天？', options: ['6 个月', '7 个月', '8 个月', '9 个月'], answer: 1, explain: '1/3/5/7/8/10/12 月共 7 个月是 31 天。' },
  { q: '水的化学分子式是？', options: ['CO2', 'H2O', 'O2', 'NaCl'], answer: 1 },
  { q: '下列哪种动物属于哺乳动物？', options: ['鲨鱼', '鲸鱼', '鳄鱼', '金鱼'], answer: 1, explain: '鲸鱼是哺乳动物，用肺呼吸；其余为鱼类/爬行类。' },
  { q: '光在真空中的传播速度约为？', options: ['3 万 km/s', '30 万 km/s', '300 万 km/s', '3000 km/s'], answer: 1 },
  { q: '《红楼梦》的作者是？', options: ['罗贯中', '施耐庵', '曹雪芹', '吴承恩'], answer: 2 },
  { q: '人体最大的器官是？', options: ['肝脏', '大脑', '皮肤', '心脏'], answer: 2 },
  { q: '下列哪个不是编程语言？', options: ['Python', 'Java', 'HTML', 'Photoshop'], answer: 3 },
  { q: '太阳系中体积最大的行星是？', options: ['地球', '火星', '木星', '土星'], answer: 2 },
  { q: '“床前明月光”的下一句是？', options: ['疑是地上霜', '低头思故乡', '举头望明月', '玉盘清辉满'], answer: 0 },
  { q: '一个标准足球比赛每队上场几人？', options: ['9 人', '10 人', '11 人', '12 人'], answer: 2 },
  { q: '下列哪种水果富含维生素 C 较多？', options: ['香蕉', '苹果', '猕猴桃', '西瓜'], answer: 2 },
  { q: '圆的周长公式是？', options: ['πd', 'πr', '2πr²', 'πr²'], answer: 0, explain: '周长 = π × 直径 = 2πr。' },
  { q: '我国的“国宝”动物是？', options: ['金丝猴', '大熊猫', '朱鹮', '东北虎'], answer: 1 },
  { q: '声音不能在下列哪种环境中传播？', options: ['空气', '水', '固体', '真空'], answer: 3, explain: '声音需要介质，真空无法传声。' },
  { q: '下列哪个节气在春季？', options: ['白露', '清明', '大雪', '大暑'], answer: 1 },
  { q: 'DNA 的全称是？', options: ['脱氧核糖核酸', '核糖核酸', '氨基酸', '蛋白质'], answer: 0 },
  { q: '国际象棋中“后”能走？', options: ['只能斜走', '只能直走', '直线斜线均可', '只能走日字'], answer: 2 },
  { q: '下列哪个是中国的四大名著之一？', options: ['封神演义', '聊斋志异', '西游记', '隋唐演义'], answer: 2 },
  { q: '彩虹通常有几种主要颜色？', options: ['5 种', '6 种', '7 种', '8 种'], answer: 2 },
  { q: '下列哪种气体能使带火星的木条复燃？', options: ['氮气', '二氧化碳', '氧气', '氢气'], answer: 2 },
  { q: '“愚公移山”出自？', options: ['《论语》', '《列子》', '《孟子》', '《庄子》'], answer: 1 },
  { q: '地球自转一圈大约需要？', options: ['12 小时', '24 小时', '一个月', '一年'], answer: 1 },
  { q: '下列哪种乐器属于弦乐器？', options: ['小号', '钢琴', '长笛', '架子鼓'], answer: 1, explain: '钢琴通过琴槌敲击琴弦发声，属击弦乐器。' },
  { q: '汉字“休”的造字法是？', options: ['象形', '指事', '会意', '形声'], answer: 2, explain: '“人”靠“木”，会意字。' },
  { q: '下列哪种动物会冬眠？', options: ['大象', '熊', '老虎', '斑马'], answer: 1 },
  { q: '“一带一路”的“带”指的是？', options: ['经济带', '地带', '带子', '海带'], answer: 0 },
  { q: '世界上最高的山峰是？', options: ['乔戈里峰', '珠穆朗玛峰', '干城章嘉峰', '勃朗峰'], answer: 1 },
  { q: '下列哪个单位用于衡量电流？', options: ['伏特', '安培', '瓦特', '欧姆'], answer: 1 },
  { q: '蜜蜂采集什么来酿造蜂蜜？', options: ['树叶', '花蜜', '泥土', '露水'], answer: 1 },
  { q: '“春蚕到死丝方尽”的作者是？', options: ['李白', '杜甫', '李商隐', '白居易'], answer: 2 },
  { q: '下列哪种食物富含优质植物蛋白？', options: ['豆腐', '白米饭', '白糖', '食用油'], answer: 0 },
  { q: '地球绕太阳公转一圈约需？', options: ['一天', '一个月', '一年', '一小时'], answer: 2 },
  { q: '下列哪个不是四边形？', options: ['正方形', '长方形', '梯形', '三角形'], answer: 3 },
  { q: '“卧薪尝胆”说的是哪位君主？', options: ['越王勾践', '吴王夫差', '楚庄王', '齐桓公'], answer: 0 },
  { q: '下列哪种能源属于可再生能源？', options: ['煤炭', '石油', '天然气', '太阳能'], answer: 3 },
  { q: '一打（dozen）等于多少个？', options: ['6 个', '10 个', '12 个', '20 个'], answer: 2 },
  { q: '“位卑未敢忘忧国”出自？', options: ['陆游', '辛弃疾', '岳飞', '文天祥'], answer: 0 },
  { q: '下列哪种天气现象由水蒸气凝结成冰晶形成？', options: ['雨', '雪', '雾', '露'], answer: 1 },
  { q: '计算机的“CPU”是指？', options: ['中央处理器', '内存', '硬盘', '显卡'], answer: 0 },
];

function loadCustom() {
  const p = path.join(__dirname, 'custom_quiz.json');
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.data || raw.questions || []);
    return arr.filter(it => it && it.q && Array.isArray(it.options) && it.options.length >= 2)
      .map(it => ({
        q: String(it.q).trim(),
        options: it.options.map(String),
        answer: typeof it.answer === 'string' ? 'ABCD'.indexOf(it.answer.toUpperCase()) : (it.answer | 0),
        explain: it.explain || '',
      }));
  } catch (e) {
    console.error('[quiz] custom_quiz.json 解析失败:', e.message);
    return [];
  }
}

function build() {
  const custom = loadCustom();
  if (!custom.length) return BUILTIN;
  // 用户题库优先：同题干覆盖内置
  const map = new Map();
  BUILTIN.forEach(d => map.set(d.q, d));
  custom.forEach(d => map.set(d.q, d));
  return Array.from(map.values());
}

module.exports = build();
