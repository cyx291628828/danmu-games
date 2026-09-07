/* gomoku 主播台前端冒烟：验证「模式下拉即时生效」「代打勾选框已移除」「破坏性按钮二次确认」
   用法：node scripts/test_gomoku_ui.js   （需先启动 host/server.js） */
'use strict';
const path = require('path');
const { chromium } = require(path.join(process.env.USERPROFILE || 'C:/Users/Administrator',
  '.workbuddy/binaries/node/workspace/node_modules/playwright-core'));

const BASE = 'http://127.0.0.1:18080';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.error('  ✗ ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ctl(extra) {
  const body = JSON.stringify({ game: 'gomoku', ...extra });
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(BASE + '/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }  // 频率限制：退避重试
    return r.json();
  }
  throw new Error('control 请求因 429 频率限制重试 6 次仍失败');
}
const readState = async () => (await ctl({ action: '__read__' })).state;

(async () => {
  // 临时现场配置（收尾统一还原为规范值 CANON，不依赖现场快照，避免把脏配置写回磁盘）
  await ctl({ action: 'config', mode: 'pve', botLevel: 5, moveTimeSec: 0, botThinkSec: 0, rateLimitSec: 0, resultShowSec: 15, autoNextRound: false, readyEnabled: false });
  await ctl({ action: 'endRound' }).catch(() => {});
  await ctl({ action: 'clearQueue' });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)));
  // 404 多来自浏览器自动请求 favicon.ico，单独归类不计入 JS 异常
  const failedReqs = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return;   // 资源类错误由 failedReqs 单独断言
    pageErrors.push('console: ' + t);
  });
  page.on('requestfailed', r => failedReqs.push(r.url()));
  page.on('response', r => { if (r.status() >= 400) failedReqs.push(r.status() + ' ' + r.url()); });

  await page.goto(BASE + '/games/gomoku/public/control.html?game=gomoku', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#cfgMode', { timeout: 10000 });
  await sleep(1200);   // 等 SSE 首帧 + 表单渲染

  console.log('── 配置表单：代打选项已移除 ──');
  const formTxt = await page.textContent('#cfgForm');
  ok(!/代打|botStandIn/.test(formTxt), '配置区不再出现「代打」相关选项');
  ok(await page.$('#cfgBotStandIn') === null, '#cfgBotStandIn 元素已不存在');
  ok(/双人对决永远不会有机器人替补/.test(formTxt), '配置说明写明双人对决永不补机器人');
  ok(await page.$('#cfgForbidden') !== null, '禁手勾选框仍在（未误删相邻元素）');
  ok(await page.$('#cfgReadyEnabled') !== null && await page.$('#cfgReadyWait') !== null,
    '「上座须发准备」开关与超时输入框已渲染');
  ok(/上座后须发「准备」才开局/.test(formTxt), '配置表单出现准备确认开关文案');

  console.log('── 模式下拉：change 即提交（无需点应用配置） ──');
  let st = await readState();
  ok(st.mode === 'pve', `前置状态 mode=pve（当前 ${st.mode}）`);
  await page.selectOption('#cfgMode', 'pvp');
  await sleep(400);
  const toastTxt = await page.evaluate(() => {
    const el = document.querySelector('.toast');
    return el ? el.textContent : '(no .toast element)';
  });
  ok(/已切到/.test(toastTxt), `切模式有 toast 提示（${toastTxt}）`);
  await sleep(1200);
  st = await readState();
  ok(st.mode === 'pvp', `下拉切到「双人对决」后服务端立即生效（mode=${st.mode}）`);

  console.log('── 双人对决：只排一侧 → 等待上座，无机器人 ──');
  await ctl({ action: 'mockChat', name: '甲', text: '排黑' });
  await page.click('#btnStart');
  await sleep(1000);
  st = await readState();
  ok(st.status === 'waiting', `仅黑方排队 → status=${st.status}（等待上座）`);
  const seatTxt = await page.textContent('#seatCards');
  ok(/虚位以待/.test(seatTxt) && !/棋灵/.test(seatTxt), `座位卡无机器人（${seatTxt.replace(/\s+/g, ' ').trim()}）`);
  const statTxt = await page.textContent('#statChips');
  ok(/双人对决/.test(statTxt), `状态徽章显示双人对决（${statTxt.replace(/\s+/g, ' ').trim().slice(0, 60)}）`);

  console.log('── 两侧到齐 → 自动开局（两侧均为观众） ──');
  await ctl({ action: 'mockChat', name: '乙', text: '排白' });
  await sleep(2000);
  st = await readState();
  ok(st.status === 'playing', `黑白到齐自动开局（status=${st.status}）`);
  ok(st.seats.black.kind === 'viewer' && st.seats.white.kind === 'viewer',
    `两侧都是观众：黑=${st.seats.black.name}/${st.seats.black.kind} 白=${st.seats.white.name}/${st.seats.white.kind}`);

  console.log('── 落子后不会自动平局 ──');
  st = (await ctl({ action: 'mockChat', name: '甲', text: 'H8' })).state;
  ok(st.moves.length === 1 && st.status === 'playing', `黑方落子后仍在对局（moves=${st.moves.length} status=${st.status}）`);
  st = (await ctl({ action: 'mockChat', name: '乙', text: 'J9' })).state;
  ok(st.moves.length === 2 && st.status === 'playing', `白方应手后仍在对局（moves=${st.moves.length} status=${st.status}）`);
  await sleep(2500);
  st = await readState();
  ok(st.status === 'playing' && st.result === null, `静置 2.5s 无自动平局（status=${st.status} result=${JSON.stringify(st.result)}）`);

  console.log('── 破坏性按钮二次确认 ──');
  let dialogMsg = null;
  page.on('dialog', async d => { dialogMsg = d.message(); await d.dismiss(); });
  await page.click('#btnEndRound');
  await sleep(1200);
  ok(dialogMsg !== null && /平局/.test(dialogMsg), `「平局结束」弹出确认框（${dialogMsg}）`);
  st = await readState();
  ok(st.status === 'playing' && st.result === null, '取消确认后对局未被终结（防误触生效）');

  dialogMsg = null;
  await page.click('#btnForfeit');
  await sleep(1200);
  ok(dialogMsg !== null && /判当前执子方负/.test(dialogMsg), `「当前方判负」弹出确认框（${dialogMsg}）`);
  st = await readState();
  ok(st.status === 'playing', '取消判负后对局仍在进行');

  console.log('── 展示屏：螺旋编号 / 队尾插队提示 / 落子标签贴棋盘侧边框 ──');
  const stage = await browser.newPage();
  const stageErr = [];
  stage.on('pageerror', e => stageErr.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));
  await stage.goto(BASE + '/games/gomoku/public/stage.html?game=gomoku', { waitUntil: 'domcontentloaded' });
  await stage.waitForSelector('#board .cell', { timeout: 10000 });
  await sleep(1000);
  // 螺旋编号：每格一个 .spiral，天元格为 1
  const spInfo = await stage.evaluate(() => {
    const cells = document.querySelectorAll('#board .cell');
    const spirals = document.querySelectorAll('#board .cell .spiral');
    const size = Math.round(Math.sqrt(cells.length));
    const c = Math.floor((size - 1) / 2);
    const center = cells[c * size + c];
    const sp = center && center.querySelector('.spiral');
    return { count: spirals.length, total: cells.length, centerTxt: sp ? sp.textContent : null };
  });
  ok(spInfo.count === spInfo.total && spInfo.total > 0, `每格都有螺旋编号（${spInfo.count}/${spInfo.total}）`);
  ok(spInfo.centerTxt === '1', `天元格螺旋编号=1（实际=${spInfo.centerTxt}）`);

  // 队尾插队提示：waiting 且有人排队时出现
  await ctl({ action: 'endRound' }).catch(() => {});
  await ctl({ action: 'clearQueue' });
  await ctl({ action: 'config', mode: 'pve', moveTimeSec: 0 });
  await ctl({ action: 'mockChat', name: '排队侠', text: '排黑' });
  await sleep(1000);
  const qHint = await stage.evaluate(() => {
    const h = document.querySelector('#qSideLeft .q-hint');
    return h ? h.textContent : null;
  });
  ok(qHint && /插队/.test(qHint), `队列有人时队尾显示「可插队」提示（${qHint}）`);

  // 落子标签贴棋盘侧边框：pvp 双人，黑先手→标签压在卡片右边框；白应手→压在左边框
  await ctl({ action: 'clearQueue' });
  await ctl({ action: 'config', mode: 'pvp', moveTimeSec: 0 });
  await ctl({ action: 'start' });   // 进入 waiting（autoNextRound 已关，需显式 start）
  await ctl({ action: 'mockChat', name: '甲', text: '排黑' });
  await ctl({ action: 'mockChat', name: '乙', text: '排白' });
  await sleep(2000);
  const blackPill = await stage.evaluate(() => {
    const card = document.querySelector('#pBlack');
    const pill = card && card.querySelector('.turn-pill');
    if (!pill) return null;
    const cr = card.getBoundingClientRect(), pr = pill.getBoundingClientRect();
    return { crosses: pr.left < cr.right && pr.right > cr.right, x: Math.round(pr.left), cardRight: Math.round(cr.right) };
  });
  ok(blackPill && blackPill.crosses, `黑方落子标签贴在卡片右边框（pill左${blackPill.x} 卡右${blackPill.cardRight}，跨边框）`);
  // 白方应手后检查
  await ctl({ action: 'mockChat', name: '甲', text: 'H8' });
  await sleep(1500);
  const whitePill = await stage.evaluate(() => {
    const card = document.querySelector('#pWhite');
    const pill = card && card.querySelector('.turn-pill');
    if (!pill) return null;
    const cr = card.getBoundingClientRect(), pr = pill.getBoundingClientRect();
    return { crosses: pr.left < cr.left && pr.right > cr.left };
  });
  ok(whitePill && whitePill.crosses, '白方落子标签贴在卡片左边框（跨边框）');
  ok(stageErr.length === 0, `展示屏无 JS 异常${stageErr.length ? '：' + stageErr.slice(0, 2).join(' | ') : ''}`);
  await stage.close();

  console.log('── 防回归：enterReady 清盘后不得残留 .removed（「落子即消失、刷新才出现」）──');
  // 复现路径：result → autoNext → enterReady（清空棋盘但 roundNo 不变）→ 前端给有过的格打上 .removed，
  // 而 .removed 带 forwards 动画且从未被清除 → 下一局落在该格的棋子被永久淡出。
  await ctl({
    action: 'config', mode: 'pve', botLevel: 5, forbidden: false, botThinkSec: 0,
    moveTimeSec: 45, resultShowSec: 3, autoNextRound: true, readyEnabled: true,
    boardSize: 15, rateLimitSec: 0,
  });
  await ctl({ action: 'endRound' }).catch(() => {});
  await ctl({ action: 'clearQueue' });
  await ctl({ action: 'mockChat', name: '回归A', text: '排队' });
  await sleep(200);
  await ctl({ action: 'mockChat', name: '回归B', text: '排队' });
  await sleep(600);
  await ctl({ action: 'start', force: true });
  let gs = await readState();
  for (let k = 0; k < 8 && gs.status !== 'playing'; k++) { await sleep(300); gs = await readState(); }
  ok(gs.status === 'playing', `回归场景第 1 局已开局（${gs.status}）`);

  const gsPage = await browser.newPage();
  await gsPage.goto(BASE + '/games/gomoku/public/stage.html?game=gomoku', { waitUntil: 'domcontentloaded' });
  await gsPage.waitForSelector('#board .cell', { timeout: 10000 });
  await sleep(1000);
  for (const mv of ['H8', 'I9']) {
    gs = await readState();
    if (gs.status !== 'playing') break;
    if (gs.turn === 'black') await ctl({ action: 'mockChat', name: (gs.seats.black || {}).name, text: mv });
    await sleep(600);
  }
  const usedSp = await gsPage.evaluate(() => [...document.querySelectorAll('#board .cell')]
    .filter(c => c.querySelector('.stone'))
    .map(c => (c.querySelector('.spiral') || {}).textContent).filter(Boolean));
  ok(usedSp.length > 0, `第 1 局已落子并取到螺旋编号（${usedSp.join(',')}）`);

  // 认负 → 等 autoNext → enterReady（下毒点：清盘但 roundNo 不变）
  await ctl({ action: 'forfeit', side: 'white' });
  for (let k = 0; k < 25; k++) { const s = await readState(); if (s.status === 'ready') break; await sleep(300); }
  await sleep(600);
  const rdSt = await readState();
  ok(rdSt.status === 'ready', `已自动进入准备确认态（${rdSt.status}）`);
  const poisoned = await gsPage.evaluate(() => document.querySelectorAll('#board .cell.removed').length);
  ok(poisoned === 0, `enterReady 清盘后无 .removed 残留（实际 ${poisoned} 格）`);

  // 发「准备」→ 开局 → 刻意落在上一局用过的格（修复前必中招）
  await ctl({ action: 'mockChat', name: (rdSt.seats.black || {}).name, text: '准备' });
  for (let k = 0; k < 25; k++) { const s = await readState(); if (s.status === 'playing') break; await sleep(300); }
  await ctl({ action: 'mockChat', name: (rdSt.seats.black || {}).name, text: String(usedSp[0]) });
  await sleep(1000);   // 等 pop(.28s) 与潜在 stoneGone(.5s forwards) 播完再判定
  const vis = await gsPage.evaluate(() => {
    const ss = [...document.querySelectorAll('#board .stone')];
    return { n: ss.length, hidden: ss.filter(s => parseFloat(getComputedStyle(s).opacity) < 0.9).length };
  });
  const srv = await readState();
  const srvPcs = (srv.board || '').split('').filter(c => c === '1' || c === '2').length;
  ok(vis.n === srvPcs, `新局棋子数与服务端一致（DOM ${vis.n} / 服务端 ${srvPcs}）`);
  ok(vis.hidden === 0, `落在上局用过的格（编号 ${usedSp[0]}）后棋子全部可见（不可见 ${vis.hidden} 枚）`);
  await gsPage.close();

  console.log('── 页面无 JS 报错 ──');
  ok(pageErrors.length === 0, `无 JS 异常${pageErrors.length ? '：' + pageErrors.slice(0, 3).join(' ‖ ') : ''}`);
  const real404 = failedReqs.filter(u => !/favicon\.ico/.test(u));
  ok(real404.length === 0, `无失败资源请求${real404.length ? '：' + real404.slice(0, 3).join(' , ') : '（已排除 favicon）'}`);

  await browser.close();

  // 收尾恢复：统一还原为规范对局配置（仅覆盖 9 个对局参数，其余字段由宿主合并保留，绝不污染主播真实配置）
  await ctl({ action: 'endRound' }).catch(() => {});
  await ctl({ action: 'clearQueue' });
  const CANON = { mode: 'pve', botLevel: 5, forbidden: true, boardSize: 15, moveTimeSec: 45, botThinkSec: 3, resultShowSec: 5, autoNextRound: true, rateLimitSec: 0, readyEnabled: true, readyWaitSec: 40 };
  await ctl({ action: 'config', ...CANON });
  const afterCfg = (await readState()).cfg;
  const diff = Object.keys(CANON).filter(k => JSON.stringify(CANON[k]) !== JSON.stringify(afterCfg[k]));
  console.log(diff.length
    ? `⚠ 配置未完全还原：${diff.map(k => `${k}: ${CANON[k]} → ${afterCfg[k]}`).join('; ')}`
    : '✓ 配置已完整还原（规范值）');
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
