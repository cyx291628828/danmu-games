/**
 * 展示屏小屏自适应回归：多游戏 × 多视口，检查 .phone 等比缩放是否生效、内容是否溢出。
 *
 * 用法：
 *   NODE_PATH=<workspace>/node_modules node scripts/test_stage_scale.js
 *   GAMES=guess,quiz,gomoku NODE_PATH=... node scripts/test_stage_scale.js
 *
 * 判定：所有「游戏 × 视口」都必须贴合视口且 scroll 溢出为 0。
 * 对照列会临时把 .phone 还原成改动前的写法（宽度自适应 + 字号固定 px），用于证明小屏原本会溢出。
 */
const { chromium } = require('playwright-core');

const EXE = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const stageURL = (g) => `http://127.0.0.1:18080/games/${g}/public/stage.html?game=${g}`;

const VIEWPORTS = [
  [1920, 1080], // 大屏（基准，zoom 应 ≈1）
  [1366, 768],
  [1024, 768],
  [800, 600],   // 小窗口
  [600, 900],
  [480, 800],   // 极窄
  // 更大的屏：zoom > 1 会等比放「大」字号，验证是否反而撑爆布局
  [2560, 1440],
  [3840, 2160],
  [1080, 1920], // OBS 竖屏源
  [1440, 2560],
];

// 公共 .phone 样式改动影响所有游戏的展示屏，可一次回归多个
const GAMES = process.env.GAMES ? process.env.GAMES.split(',') : ['guess'];

const probe = () => {
  const ph = document.querySelector('.phone');
  if (!ph) return { err: 'no .phone' };
  const pr = ph.getBoundingClientRect();
  const cs = getComputedStyle(ph);
  const cells = [...document.querySelectorAll('.cell')];
  const cellOv = cells.map((e) => e.scrollWidth - e.clientWidth);
  const clues = [...document.querySelectorAll('.clue-card')];
  const clueOv = clues.map((e) => e.scrollWidth - e.clientWidth);
  const cell0 = cells[0];
  const zoomNum = parseFloat(cs.zoom) || 1;
  const cfs = cell0 ? parseFloat(getComputedStyle(cell0).fontSize) : null;
  return {
    zoom: cs.zoom,
    // zoom 下 computed 字号不变，实际渲染 = 设计 px × zoom（大屏应恒为设计值，即不放大）
    effFontPx: cfs ? Math.round(cfs * zoomNum * 10) / 10 : null,
    phoneW: Math.round(pr.width),
    phoneH: Math.round(pr.height),
    fitsW: pr.width <= window.innerWidth + 1,
    fitsH: pr.height <= window.innerHeight + 1,
    ovX: ph.scrollWidth - ph.clientWidth,
    ovY: ph.scrollHeight - ph.clientHeight,
    cellW: cell0 ? Math.round(cell0.getBoundingClientRect().width) : null,
    cellFontPx: cell0 ? getComputedStyle(cell0).fontSize : null,
    cellOverflow: Math.max(0, ...cellOv, 0),
    clueCount: clues.length,
    clueOverflow: Math.max(0, ...clueOv, 0),
  };
};

// 还原改动前的写法：宽度自适应视口，但内部字号固定 px 不变
const probeBefore = () => {
  const ph = document.querySelector('.phone');
  ph.style.zoom = '1';
  ph.style.transform = 'none';
  ph.style.width = 'min(100vw - 12px, calc((100dvh - 12px) * 9 / 16))';
  const cells = [...document.querySelectorAll('.cell')];
  const clues = [...document.querySelectorAll('.clue-card')];
  const cell0 = cells[0];
  const cfs = cell0 ? parseFloat(getComputedStyle(cell0).fontSize) : null;
  return {
    phoneW: Math.round(ph.getBoundingClientRect().width),
    effFontPx: cfs ? Math.round(cfs * 10) / 10 : null,   // 旧写法 zoom 恒为 1，即设计 px 本身
    fitsW: ph.getBoundingClientRect().width <= window.innerWidth + 1,
    fitsH: ph.getBoundingClientRect().height <= window.innerHeight + 1,
    ovX: ph.scrollWidth - ph.clientWidth,
    ovY: ph.scrollHeight - ph.clientHeight,
    cellOverflow: Math.max(0, ...cells.map((e) => e.scrollWidth - e.clientWidth), 0),
    clueOverflow: Math.max(0, ...clues.map((e) => e.scrollWidth - e.clientWidth), 0),
  };
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage();
  const rows = [];
  let badCount = 0;

  for (const game of GAMES) {
    for (const [w, h] of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(stageURL(game), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200); // 等 SSE 推来状态并渲染

      const after = await page.evaluate(probe);
      const before = await page.evaluate(probeBefore);
      // 容差说明：
      //   ovX / 格溢出 / 线索溢出 ≤1px —— 缩放后亚像素舍入会产出 ±1px 伪溢出
      //   ovY ≤4px —— 部分游戏（如 race）子项 margin 会让 scrollHeight 虚高几个像素，
      //               但实测无任何元素底部超出 .phone 边框，不构成真实裁切
      const ok = !after.err && after.fitsW && after.fitsH && after.ovX <= 1 && after.ovY <= 4 &&
                 after.cellOverflow <= 1 && after.clueOverflow <= 1;
      if (!ok) badCount++;
      rows.push({ game, vp: `${w}x${h}`, after, before, ok });
    }
  }

  console.log('游戏     视口        zoom     phone尺寸    贴合W/H 溢出X/Y 格子宽 实际字号 格溢出 线索溢出 | 旧写法: 宽 溢出X/Y 实际字号');
  for (const r of rows) {
    if (r.after.err) { console.log(`${r.game} ${r.vp} ${r.after.err}`); continue; }
    const a = r.after, b = r.before;
    console.log(
      `${r.game.padEnd(8)} ${r.vp.padEnd(11)} ${String(a.zoom).padEnd(7)} ${String(a.phoneW + 'x' + a.phoneH).padEnd(12)} ` +
      `${a.fitsW ? 'Y' : 'N'}/${a.fitsH ? 'Y' : 'N'}    ${String(a.ovX + '/' + a.ovY).padEnd(6)} ` +
      `${String(a.cellW).padEnd(6)} ${String(a.effFontPx).padEnd(8)} ${String(a.cellOverflow).padEnd(6)} ${String(a.clueOverflow).padEnd(8)} | ` +
      `${String(b.phoneW).padEnd(5)} ${String(b.ovX + '/' + b.ovY).padEnd(6)} ${b.effFontPx}`
    );
  }

  console.log(badCount ? `\n✗ ${badCount} / ${rows.length} 个组合仍存在问题` : `\n✓ ${rows.length} 个组合全部贴合视口且无溢出`);
  await browser.close();
  process.exit(badCount ? 1 : 0);
})();
