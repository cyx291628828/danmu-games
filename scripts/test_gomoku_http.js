/* gomoku HTTP 端到端测试：驱动宿主 /api/control（mockChat/mockLike/mockGift 与真实弹幕同管线）
   用法：node scripts/test_gomoku_http.js  （需先 node host/server.js） */
'use strict';

const BASE = 'http://127.0.0.1:18080';
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.error('  ✗ ' + msg); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ctl(extra) {
  const body = JSON.stringify({ game: 'gomoku', ...extra });
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(BASE + '/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }  // 频率限制：退避重试
    const j = await r.json();
    if (!j.state) throw new Error('control 无 state 返回: ' + JSON.stringify(j));
    return j;
  }
  throw new Error('control 请求因 429 频率限制重试 6 次仍失败');
}
/** 只读探针：任意未知动作都会让宿主回吐当前 publicState */
const readState = () => ctl({ action: '__read__' });

(async () => {
  // 临时现场配置（收尾统一还原为规范值 CANON，不依赖现场快照，避免把脏配置写回磁盘）
  console.log('── 配置：人机对决 · 秒回机器人 · 不限时 · 15 路锁定 ──');
  // 清理现场：关掉自动续局 → 结束可能进行中的遗留对局（非对局中会报错，忽略）→ 清队
  await ctl({ action: 'config', botThinkSec: 0, moveTimeSec: 0, rateLimitSec: 0, mode: 'pve', botLevel: 5, forbidden: true, resultShowSec: 3, autoNextRound: false, boardSize: 15 });
  await ctl({ action: 'endRound' }).catch(() => {});
  await ctl({ action: 'clearQueue' });

  console.log('── 排队 + 点赞 + 送礼（排序值实时重排） ──');
  await ctl({ action: 'mockChat', name: '小明', text: '排队' });
  await ctl({ action: 'mockChat', name: '小红', text: '排队' });
  await ctl({ action: 'mockChat', name: '小李', text: '排队' });
  await ctl({ action: 'mockLike', name: '小红', count: 30 });
  await ctl({ action: 'mockLike', name: '小明', count: 5 });
  await ctl({ action: 'mockGift', name: '小明', giftName: '小心心', giftCount: 1, repeatCount: 1 });
  let st = (await readState()).state;
  const qb = st.queues.black;
  const names = qb.list.map(r => r.name).join(',');
  ok(qb.count === 3 && names === '小明,小红,小李', `排序值重排：${names}（小明 35 > 小红 30 > 小李 0）`);
  ok(qb.list[0].sort === 35 && qb.list[0].gifts === 1, '小明 5 赞 + 1 礼物×30 = 排序值 35');

  console.log('── 开局上座（队列第一执黑 vs 人机） ──');
  st = (await ctl({ action: 'start' })).state;
  ok(st.status === 'playing' && st.seats.black.name === '小明' && st.seats.white.kind === 'bot', '队首「小明」上座执黑，机器人执白 (Lv5)');
  ok(st.queues.black.count === 2, '上座者离开队列（剩 2 人）');

  console.log('── 弹幕落子 + 人机应手 ──');
  st = (await ctl({ action: 'mockChat', name: '小红', text: 'H8' })).state;
  ok(st.moves.length === 0, '未上座观众落子被拒（小红还在队列）');
  st = (await ctl({ action: 'mockChat', name: '小明', text: 'H8' })).state;
  const h8ok = st.moves.length === 1 && st.board[112] === '1' && st.turn === 'white';
  if (!h8ok) console.error('  ↳ 实际: moves=%d board[112]=%s turn=%s last=%s', st.moves.length, st.board[112], st.turn,
    st.moves.length ? `${st.moves[st.moves.length-1].name}@${st.moves[st.moves.length-1].coord}` : '-');
  ok(h8ok, '上座小明 H8 落子成功，轮到白方');
  // 等机器人（botThinkSec=0）应手
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    st = (await readState()).state;
    if (st.moves.length >= 2) break;
  }
  ok(st.moves.length === 2 && st.board[st.moves[1].i] === '2', `机器人应手（${st.moves[1].coord}），轮到黑方`);
  ok(st.moves[1].src === 'bot', '落子来源标记 bot');

  console.log('── 送礼悔棋 ──');
  st = (await ctl({ action: 'mockGift', name: '小明', giftName: '火箭', giftCount: 1, repeatCount: 1 })).state;
  ok(st.moves.length === 0 && st.turn === 'black' && st.board[112] === '0', '上座观众送礼悔棋：撤两手回到自己回合');

  console.log('── 禁手拒绝 ──');
  // 布置：黑沿横一(5,7)(6,7) + 竖(7,5)(7,6) 的先手点由白补强……直接构造：黑三三点盘面
  // 用模拟弹幕把现有布局推进到接近禁手盘面不现实，改走「主播托管」制造禁手盘面成本高——
  // 这里直接断言禁手点接口存在且开局禁手开关生效（详细判定已在 engine selftest 覆盖）
  st = (await readState()).state;
  ok(typeof st.forbiddenPts !== 'undefined' && st.forbidden === true, '禁手开关与禁手点数组下发');

  console.log('── 判负结算：人机获胜 → 得分 + 徽章 ──');
  st = (await ctl({ action: 'mockChat', name: '小明', text: 'H8' })).state;
  ok(st.moves.length === 1, '重新落子 H8');
  // 指定方判负（side 参数据此指定，不受机器人秒回抢回合影响）
  st = (await ctl({ action: 'forfeit', side: 'white' })).state;   // 白(机器人)判负 → 小明胜
  ok(st.status === 'result' && st.result.winner === 'black' && st.result.reason === 'forfeit', '判机器人负 → 小明获胜');
  // 徽章只升不降：重跑时小明已有 Lv5，无新解锁；用首次击败的观众才出 badgeUp
  ok(st.result.badgeUp === null || st.result.badgeUp.level >= 5, `徽章状态（重跑容错：${JSON.stringify(st.result.badgeUp) || '无新解锁'}）`);
  const lbMing = st.leaderboard.find(r => r.name === '小明');
  ok(lbMing && lbMing.gomoku_badge >= 5 && lbMing.gomoku_wins >= 1 && lbMing.gomoku_score >= 100,
    `排行榜：${lbMing ? `${lbMing.name} badge=Lv${lbMing.gomoku_badge} wins=${lbMing.gomoku_wins} score=${lbMing.gomoku_score}` : '未找到'}`);

  console.log('── 徽章确定性验证（全新观众击败 Lv7 人机） ──');
  await ctl({ action: 'config', botLevel: 7, mode: 'pve' });
  await ctl({ action: 'clearQueue' });   // 排掉跨轮次残留，保证队列只有新观众
  const fresh = '徽章客' + (Date.now() % 100000);
  st = (await ctl({ action: 'mockChat', name: fresh, text: '排队' })).state;
  st = (await ctl({ action: 'start' })).state;
  const wl = st.seats.white;
  ok(st.status === 'playing' && st.seats.black.name === fresh && wl.kind === 'bot' && wl.level === 7, `新观众 vs Lv7 人机（${wl.name}）`);
  st = (await ctl({ action: 'forfeit', side: 'white' })).state;
  ok(st.result.badgeUp && st.result.badgeUp.name === fresh && st.result.badgeUp.level === 7,
    `首次击败 Lv7 → 解锁徽章（${JSON.stringify(st.result.badgeUp)}）`);

  console.log('── 双人对决（双队列） ──');
  await ctl({ action: 'config', mode: 'pvp' });
  await ctl({ action: 'clearQueue' });   // 与徽章阶段隔离
  // 结算期允许重新排队
  await ctl({ action: 'mockChat', name: '小红', text: '排黑' });
  await ctl({ action: 'mockChat', name: '小明', text: '排白' });
  st = (await ctl({ action: 'start' })).state;
  ok(st.status === 'playing' && st.seats.black.name === '小红' && st.seats.white.name === '小明', '双人模式：双队列各取第一（黑=小红 白=小明）');
  st = (await ctl({ action: 'mockChat', name: '小明', text: 'H8' })).state;
  ok(st.moves.length === 0, '轮到黑方时白方不能落子');
  st = (await ctl({ action: 'mockChat', name: '小红', text: 'H8' })).state;
  ok(st.moves.length === 1 && st.turn === 'white', '黑方先手 H8');
  st = (await ctl({ action: 'mockChat', name: '小明', text: 'J9' })).state;
  ok(st.moves.length === 2 && st.turn === 'black', '白方应手 J9');
  st = (await ctl({ action: 'mockGift', name: '小明', giftName: '礼物', giftCount: 1, repeatCount: 1 })).state;
  ok(st.moves.length === 1 && st.turn === 'white', '白方送礼悔棋：撤自己一手、轮次回给自己');
  st = (await ctl({ action: 'endRound' })).state;
  ok(st.status === 'result' && st.result.winner === null && st.result.reason === 'draw-skip', '平局结束');
  const gains = st.result.scores.map(s => `${s.name}+${s.gain}`).join(',');
  ok(st.result.scores.every(s => s.gain === 20), `平局双方参与奖（${gains}）`);

  console.log('── 双人缺一侧不代打（等黑白到齐自动开局） ──');
  // 显式传已废弃的 botStandIn=true：宿主应忽略，双人对决永不补机器人
  await ctl({ action: 'config', mode: 'pvp', botStandIn: true });
  await ctl({ action: 'clearQueue' });
  await ctl({ action: 'mockChat', name: '小红', text: '排黑' });
  st = (await ctl({ action: 'start' })).state;
  ok(st.status === 'waiting' && st.seats.black === null && st.seats.white === null, '双人仅黑方排队 → 等待上座（机器人代打已彻底移除）');
  ok(!!st.waitHint && st.waitHint.includes('白方'), `等待提示引导补白方（${st.waitHint}）`);
  await ctl({ action: 'clearQueue' });
  await ctl({ action: 'mockChat', name: '小明', text: '排白' });
  st = (await ctl({ action: 'start' })).state;
  ok(st.status === 'waiting' && (st.waitHint || '').includes('黑方'), `仅白方排队 → 等待黑方（${st.waitHint}）`);
  await ctl({ action: 'mockChat', name: '小红', text: '排黑' });
  await sleep(1800);   // 等待上座 1.5s 自动上座 → readyEnabled 默认开 → 进「准备确认」
  st = (await readState()).state;
  ok(st.status === 'ready' && st.seats.black.name === '小红' && st.seats.white.name === '小明'
    && st.seats.black.kind === 'viewer' && st.seats.white.kind === 'viewer'
    && st.seats.black.ready === false && st.seats.white.ready === false,
    '黑白到齐 → 准备确认（两侧均为观众、均未发「准备」）');
  ok(!!st.readyDeadline && !!st.waitHint && st.waitHint.includes('准备'), `ready 倒计时与点名提示下发（${st.waitHint}）`);
  await ctl({ action: 'mockChat', name: '小红', text: '准备' });
  st = (await readState()).state;
  ok(st.status === 'ready' && st.seats.black.ready === true && st.seats.white.ready === false, '黑方「准备」→ 仍等白方');
  await ctl({ action: 'mockChat', name: '小明', text: '就绪' });
  st = (await readState()).state;
  ok(st.status === 'playing', '双方就绪 → 自动开局');

  console.log('── 准备超时让座（HTTP 真实定时器） ──');
  await ctl({ action: 'config', mode: 'pve', readyEnabled: true, readyWaitSec: 2, autoNextRound: false });
  await ctl({ action: 'endRound' }).catch(() => {});
  await ctl({ action: 'clearQueue' });
  st = (await ctl({ action: 'start' })).state;   // 队列空 → 等待上座
  ok(st.status === 'waiting', '超时 HTTP 前置：等待上座');
  await ctl({ action: 'mockChat', name: '占座侠', text: '排队' });
  await sleep(1800);   // 1.5s 自动上座 → ready
  st = (await readState()).state;
  ok(st.status === 'ready' && st.seats.black.name === '占座侠' && st.seats.black.ready === false,
    '占座侠上座待准备（HTTP ready 态）');
  // 不准备，等 readyWaitSec=2 超时 → 自动让座（无人竞争 → 重新上座再待准备；feed 出现 seatTimeout 即通过）
  const t0t = Date.now();
  let timeoutSeen = false;
  while (Date.now() - t0t < 7000) {
    st = (await readState()).state;
    if (st.feed && st.feed.some(f => f.type === 'seatTimeout')) { timeoutSeen = true; break; }
    await sleep(300);
  }
  ok(timeoutSeen, '2s 未准备 → 自动让座（feed 出现 seatTimeout）');
  ok(st.status === 'ready' && st.seats.black.name === '占座侠' && st.seats.black.ready === false,
    '让座后无竞争 → 重新上座待准备（循环等待，直到发准备/离开）');
  st = (await ctl({ action: 'mockChat', name: '占座侠', text: '准备' })).state;
  ok(st.status === 'playing' && st.seats.black.ready === true, '补发「准备」→ 开局（超时循环终止）');

  console.log('── 页面资源与 SSE ──');
  for (const p of [['/games/gomoku/public/stage.html', '弹幕五子棋'], ['/games/gomoku/public/control.html', '弹幕五子棋'],
    ['/games/gomoku/public/stage.js', 'stage.js'], ['/games/gomoku/public/stage.css', 'stage.css'],
    ['/games/gomoku/public/control.js', 'control.js'], ['/games/gomoku/public/control.css', 'control.css']]) {
    const r = await fetch(BASE + p[0]);
    const t = await r.text();
    ok(r.status === 200 && t.includes(p[1]), `${p[0]} → 200`);
  }
  // SSE 初始状态推送
  const ac = new AbortController();
  const sse = await fetch(BASE + '/api/events?game=gomoku', { signal: ac.signal });
  const reader = sse.body.getReader();
  const { value } = await reader.read();
  ac.abort();
  const chunk = new TextDecoder().decode(value);
  ok(chunk.includes('event: state') && chunk.includes('"mode"') && chunk.includes('"queues"'), 'SSE 初始 state 含 gomoku 字段');

  // 收尾：统一还原为规范对局配置（仅覆盖 9 个对局参数，其余字段由宿主合并保留，绝不污染主播真实配置）
  await ctl({ action: 'endRound' }).catch(() => {});
  await ctl({ action: 'clearQueue' });
  const CANON = { mode: 'pve', botLevel: 5, forbidden: true, boardSize: 15, moveTimeSec: 45, botThinkSec: 3, resultShowSec: 5, autoNextRound: true, rateLimitSec: 0, readyEnabled: true, readyWaitSec: 40 };
  await ctl({ action: 'config', ...CANON });
  const afterCfg = (await readState()).state.cfg;
  const diff = Object.keys(CANON).filter(k => JSON.stringify(CANON[k]) !== JSON.stringify(afterCfg[k]));
  console.log(diff.length
    ? `⚠ 配置未完全还原：${diff.map(k => `${k}: ${CANON[k]} → ${afterCfg[k]}`).join('; ')}`
    : '✓ 配置已完整还原（规范值）');
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });