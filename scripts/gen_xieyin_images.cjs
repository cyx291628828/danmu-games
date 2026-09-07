/**
 * gen_xieyin_images.cjs — 谐音梗猜词·图标批量生成（效果验证）
 * 用免费的 Pollinations(Flux) 生成统一风格的扁平图标
 * 产出：res/xieyin_demo/*.png + preview.html（谜题卡片预览，带答案）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'res', 'xieyin_demo');
fs.mkdirSync(OUT, { recursive: true });

// 统一风格后缀：所有图标同一画风
const STYLE = 'cute kawaii cartoon $T$, single object centered, soft rounded shapes, ' +
  'bright cheerful pastel colors, plain solid light warm cream background, ' +
  'children picture book illustration, no text, no watermark, no extra decorations';

// 需要的图标（thing 中文名 → 英文生图描述）
const ICONS = {
  camera:   '相机', fish:   '鱼',   honey:  '蜂蜜罐', moon:  '月亮',
  pearl:    '珍珠', eye:    '眼睛', bolt:   '闪电',
  fire:     '火焰', apple:  '红苹果', mountain: '山', sheep: '绵羊',
  monkey:   '猴子', milk:   '牛奶', car:  '小汽车',
};
const EN = {
  camera: 'a photo camera', fish: 'a cute little fish', honey: 'a glass jar filled with golden honey',
  moon: 'a big smiling yellow crescent moon', pearl: 'a shiny pearl in an open oyster shell',
  eye: 'a big cute cartoon eye', bolt: 'a big yellow lightning bolt, cartoon sticker',
  fire: 'a big single orange flame, cartoon style',
  apple: 'a round red apple with a green leaf', mountain: 'two green mountains with snowy peaks', sheep: 'a fluffy white sheep',
  monkey: 'a cute brown monkey', milk: 'a glass bottle of fresh white milk', car: 'a small red car',
};

// 个别图标的专属提示词（覆盖统一风格模板）——用于必须突出物体标志性形状的图
const OVERRIDE = {
  moon: 'a big yellow crescent moon with three small stars in a dark blue night sky, cute cartoon style',
  bolt: 'a yellow lightning bolt zigzag symbol with thick rounded edges, isolated on plain light background, cartoon sticker',
  fire: 'a single orange teardrop-shaped flame with yellow inner core, isolated on plain light background, cartoon style',
};

async function gen(name, enDesc, seed) {
  const file = path.join(OUT, name + '.png');
  if (fs.existsSync(file) && fs.statSync(file).size > 3000) {
    console.log(`跳过（已存在） ${name}.png`); return true;
  }
  const prompt = encodeURIComponent(OVERRIDE[name] || STYLE.replace('$T$', enDesc));
  const url = `https://image.pollinations.ai/prompt/${prompt}?width=512&height=512&nologo=true&enhance=false&seed=${seed}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 3000) throw new Error('图片过小 ' + buf.length);
      fs.writeFileSync(file, buf);
      console.log(`生成 ✓ ${name}.png (${(buf.length / 1024).toFixed(0)}KB)`);
      return true;
    } catch (e) {
      console.log(`  重试 ${attempt}/4 ${name}: ${e.message}`);
      await new Promise(r => setTimeout(r, 6000 * attempt));
    }
  }
  console.log(`生成 ✗ ${name}.png 放弃`);
  return false;
}

(async () => {
  let i = 0, fail = 0;
  for (const [name, en] of Object.entries(EN)) {
    i++;
    const ok = await gen(name, en, 100 + i * 7);
    if (!ok) fail++;
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(fail ? `\n完成，失败 ${fail} 张` : '\n全部生成成功');
})();
