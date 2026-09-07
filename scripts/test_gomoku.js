/* gomoku 模块端到端烟测（直接驱动插件接口，不依赖 HTTP） */
'use strict';
const mod = require('../games/gomoku/index.js');
const engine = require('../games/gomoku/engine.js');

const state = mod.createState();
const cfg = { ...mod.CFG_DEFAULTS, botThinkSec: 0, moveTimeSec: 0, resultShowSec: 3, mode: 'pve', rateLimitSec: 0, readyEnabled: false };
const timers = [];
const ctx = {
  state, cfg, game: {}, meta: { id: 'gomoku' },
  log: () => {},
  emit: { state: () => {}, guess: () => {}, notice: () => {} },
  setTimer: (g, fn) => { const id = { g, fn }; timers.push(id); return id; },
  clearTimers: (g) => {
    if (g === undefined) { timers.length = 0; return; }
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i].g === g) timers.splice(i, 1);
  },
  persistConfig: () => {},
  topList: () => [],
  award: (entry, score) => { ctx.awards.push(['win', entry.user, score]); },
  awards: [],
};
// lb.awardScore 与 common/leaderboard.js 签名一致：(gameId, entry, score)
ctx.lb = {
  awardScore: (gameId, entry, score) => { if (score) ctx.awards.push(['score', entry.user, score]); },
  map: new Map(),
  save: () => {},
};

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.error('  ✗ ' + msg); } };
const u = (name, extra = {}) => ({ event: 'chat', user: { id: 'u_' + name, name, avatar: '' }, roomId: '', ...extra });
const runTimers = (g) => { for (const t of timers.filter(t => !g || t.g === g).slice()) t.fn(); };
const I = (x, y) => y * 15 + x;
/* AI 搜索已移到工作线程（异步）：
   fireWait(group)：触发定时器后轮询，直到 忙位清空且轮次翻转（覆盖 Worker 冷启动
   与上一次异步搜索尚未返回的竞态；幂等重触发，botPlay/autoMove 自带状态守卫）。 */
const fireWait = async (group) => {
  const before = state.turn;
  for (let i = 0; i < 200; i++) {
    runTimers(group);
    await new Promise(r => setTimeout(r, 30));
    if (state.status !== 'playing') return;
    if (ctx._aiBusy) continue;                       // 上一次搜索未返回：重试等待
    if (state.turn !== before) return;               // 已落子换手
    if (!timers.some(t => t.g === group)) return;    // 定时器已被清理（结算/清局）
  }
};

(async () => {

console.log('── 队列与上座（人机对决） ──');
mod.handleDanmu(ctx, u('小明', { text: '排队' }));
mod.handleDanmu(ctx, u('小红', { text: '排队' }));
mod.handleLike(ctx, { user: { id: 'u_小明', name: '小明' }, likeCount: 25 });
mod.handleLike(ctx, { user: { id: 'u_小红', name: '小红' }, likeCount: 5 });
mod.handleGift(ctx, { user: { id: 'u_小红', name: '小红' }, giftName: '小心心', giftCount: 2, repeatCount: 1 });
const sorts = [...state.queues.black.values()].map(r => `${r.name}=${r.sort}`).join(' ');
ok(sorts === '小明=25 小红=65', `点赞1:1+送礼+N 排序值（${sorts}）`);
mod.handleAction(ctx, 'start');
ok(state.status === 'playing' && state.seats.black.name === '小红', `队列第一「小红」上座执黑（对手 ${state.seats.white.name}）`);
ok(state.queues.black.size === 1 && state.queues.black.has('u_小明'), '上座者离队，小明留在队列');

console.log('── 落子权 ──');
mod.handleDanmu(ctx, u('路人', { text: 'H8' }));
ok(state.moves.length === 0, '未上座观众坐标弹幕被拒');
mod.handleDanmu(ctx, u('小红', { text: 'H8' }));
ok(state.moves.length === 1 && state.board[I(7, 7)] === 1, '上座观众 H8 落子成功');
await fireWait('bot');               // 人机应手在工作线程异步完成
ok(state.moves.length === 2 && state.turn === 'black', '人机应手后回到观众回合');

console.log('── 送礼悔棋（仅上座观众） ──');
mod.handleGift(ctx, { user: { id: 'u_小明', name: '小明' }, giftName: '火箭', giftCount: 1, repeatCount: 1 });
ok(state.moves.length === 2, '未上座者送礼 = 排序值，不触发悔棋');
const botMoveIdx = state.moves[1].i;
mod.handleGift(ctx, { user: { id: 'u_小红', name: '小红' }, giftName: '火箭', giftCount: 1, repeatCount: 1 });
ok(state.moves.length === 0 && state.turn === 'black' && state.board[botMoveIdx] === 0, '上座观众送礼悔棋：撤回人机一手+自己一手');
mod.handleDanmu(ctx, u('小红', { text: 'H8' }));
ok(state.moves.length === 1 && state.board[I(7, 7)] === 1, '悔棋后可重新落子');

console.log('── 五连结算与计分 ──');
state.board.fill(0); state.moves = [];
[[4, 7], [5, 7], [6, 7], [7, 7]].forEach(([x, y]) => {
  state.board[I(x, y)] = 1;
  state.moves.push({ i: I(x, y), side: 'black', sv: 1, uid: 'u_小红', name: '小红', src: 'dm', ts: Date.now() });
});
state.turn = 'black';
state._fp.key = '';
mod.handleDanmu(ctx, u('小红', { text: 'H9' }));
ok(state.status === 'result' && state.result.winner === 'black', '五连立即结算');
ok(ctx.awards.some(a => a[0] === 'win' && a[1] === '小红' && a[2] === cfg.pveWinScore), `人机胜局得分 +${cfg.pveWinScore}（award 含胜场）`);
ok(state.result.winCells.length === 5, '获胜连线 5 格下发');
runTimers('round');   // resultShowSec 后自动开下一局 → 队列只剩小明？小明被留下：pve 需要 black 队列有人
ok(state.status === 'playing' && state.seats.black.name === '小明', `结算后队列第一「小明」自动上座开新局`);

console.log('── 双人对决（双队列） ──');
mod.handleAction(ctx, 'endRound');
cfg.mode = 'pvp';
mod.handleDanmu(ctx, u('小红', { text: '排黑' }));
mod.handleDanmu(ctx, u('小明', { text: '排白' }));
mod.handleAction(ctx, 'start');
ok(state.seats.black.name === '小红' && state.seats.white.name === '小明', '双人模式分别从两队列取第一');
mod.handleDanmu(ctx, u('小明', { text: 'H8' }));
ok(state.moves.length === 0, '白方观众未轮到不能落子');
mod.handleDanmu(ctx, u('小红', { text: 'H8' }));
ok(state.moves.length === 1, '黑方先手落子');
mod.handleDanmu(ctx, u('小明', { text: 'J9' }));
ok(state.moves.length === 2, '白方应手落子');
// 白方刚落子即送礼 → 只撤自己那一手，轮次仍归白方（人机模式已验证过两手连撤）
mod.handleGift(ctx, { user: { id: 'u_小明', name: '小明' }, giftName: '礼物', giftCount: 1, repeatCount: 1 });
ok(state.moves.length === 1 && state.turn === 'white', '双人模式送礼悔棋：撤回自己上一手、轮次回给自己');
// 主播判负
mod.handleAction(ctx, 'forfeit');
ok(state.status === 'result' && state.result.winner === 'black', '当前方（白）判负 → 黑胜');
ok(ctx.awards.some(a => a[0] === 'win' && a[1] === '小红' && a[2] === cfg.pvpWinScore), '双人胜方得分');
ok(ctx.awards.some(a => a[0] === 'score' && a[1] === '小明' && a[2] === cfg.pvpLoseScore), '双人败方参与奖');

console.log('── 禁手 ──');
runTimers('round');
cfg.forbidden = true;
mod.handleDanmu(ctx, u('小红', { text: '排黑' }));
mod.handleDanmu(ctx, u('小明', { text: '排白' }));
mod.handleAction(ctx, 'start');
state.board.fill(0); state.moves = [];
[[5, 7], [6, 7], [7, 5], [7, 6]].forEach(([x, y]) => state.board[I(x, y)] = 1);
state.turn = 'black'; state._fp.key = '';
const before = state.moves.length;
mod.handleDanmu(ctx, u('小红', { text: 'H8' }));
ok(state.moves.length === before && state.status === 'playing', '三三禁手点落子被拒、轮次不变');
ok(mod.publicState(ctx).forbiddenPts.includes(I(7, 7)), '禁手点列表标出三三点');

console.log('── 等待上座 ──');
cfg.mode = 'pve';   // 该段验证人机模式：队列无人 → 等待，有人排队自动开局
mod.handleAction(ctx, 'endRound');
mod.handleAction(ctx, 'clearQueue');
mod.handleAction(ctx, 'start');
ok(state.status === 'waiting', '队列无人 → 等待上座');
mod.handleDanmu(ctx, u('小明', { text: '排队' }));
runTimers('round');
ok(state.status === 'playing' && state.seats.black.name === '小明', '等待中有人排队 → 自动开局上座');

console.log('── 超时托管 ──');
cfg.moveTimeSec = 3;
cfg.botThinkSec = 0;
const n0 = state.moves.length;
mod.handleAction(ctx, 'pause');
ok(state.status === 'paused', '暂停');
mod.handleAction(ctx, 'resume');
ok(state.status === 'playing', '恢复');
await fireWait('turn');
ok(state.moves.length === n0 + 1 && state.moves[state.moves.length - 1].src === 'auto', '观众手超时托管落 1 手');
cfg.moveTimeSec = 0;

console.log('── 徽章 ──');
// 模拟击败 Lv7 人机（直接驱动 awardBadge 路径：pve 胜局 + 白方 level=7）
cfg.mode = 'pve'; cfg.botLevel = 7; cfg.resultShowSec = 3;
mod.handleAction(ctx, 'endRound');
mod.handleAction(ctx, 'clearQueue');
mod.handleDanmu(ctx, u('小红', { text: '排队' }));
mod.handleAction(ctx, 'start');
state.board.fill(0); state.moves = [];
[[4, 7], [5, 7], [6, 7], [7, 7]].forEach(([x, y]) => {
  state.board[I(x, y)] = 1;
  state.moves.push({ i: I(x, y), side: 'black', sv: 1, uid: 'u_小红', name: '小红', src: 'dm', ts: Date.now() });
});
state.turn = 'black'; state._fp.key = '';
mod.handleDanmu(ctx, u('小红', { text: 'H9' }));
ok(ctx.lb.map.get('u_小红') && ctx.lb.map.get('u_小红').gomoku_badge === 7, '击败 Lv7 人机 → gomoku_badge=7');
cfg.botLevel = 3;
mod.handleDanmu(ctx, u('小明', { text: '排队' }));   // 人机模式开局需要黑队列有人
runTimers('round');
ok(state.status === 'playing' && state.seats.white && state.seats.white.level === 3, '人机等级改为 3 后新局生效');

console.log('── 双人缺一侧不代打（等黑白到齐） ──');
mod.handleAction(ctx, 'endRound');        // 结束当前人机局
cfg.mode = 'pvp';
cfg.botStandIn = true;                    // 已废弃的配置项：即使残留 true 也不得补机器人
mod.handleAction(ctx, 'clearQueue');
mod.handleDanmu(ctx, u('小红', { text: '排黑' }));
const rWait = mod.handleAction(ctx, 'start');
ok(state.status === 'waiting' && rWait.ok === false && state.seats.black === null && state.seats.white === null,
  '双人仅黑方排队 → 等待上座（机器人代打已彻底移除）');
ok(!/棋灵/.test(state.seats.black ? state.seats.black.name : '') && state.seats.white === null,
  '座位未出现任何机器人（botStandIn 残留 true 也无效）');
ok(rWait.msg.includes('白方'), `提示还差白方（${rWait.msg}）`);
// 反侧：只排白方同样等待
mod.handleAction(ctx, 'clearQueue');
mod.handleDanmu(ctx, u('小明', { text: '排白' }));
const rWait2 = mod.handleAction(ctx, 'start');
ok(state.status === 'waiting' && rWait2.msg.includes('黑方'), `仅白方排队 → 等待黑方（${rWait2.msg}）`);
mod.handleAction(ctx, 'clearQueue');
mod.handleDanmu(ctx, u('小红', { text: '排黑' }));
mod.handleDanmu(ctx, u('小明', { text: '排白' }));
runTimers('round');   // 1.5s 自动开局定时器
ok(state.status === 'playing' && state.seats.black.name === '小红' && state.seats.white.name === '小明',
  '黑白到齐自动开局');

console.log('── 准备确认：上座后须发「准备」才开局 ──');
cfg.readyEnabled = true; cfg.readyWaitSec = 40; cfg.mode = 'pve'; cfg.autoNextRound = true;
mod.handleAction(ctx, 'endRound');
mod.handleAction(ctx, 'clearQueue');
mod.handleAction(ctx, 'start');   // 队列空 force → waiting（上局 result 被 enterWaiting 覆盖）
ok(state.status === 'waiting', '准备测试前置：队列无人 → 等待上座');
mod.handleDanmu(ctx, u('小明', { text: '排队' }));
runTimers('round');   // scheduleTryStart 1.5s → readyEnabled → enterReady（非直接开局）
ok(state.status === 'ready' && state.seats.black.name === '小明' && state.seats.black.ready === false
  && state.seats.white.kind === 'bot' && state.seats.white.ready === true, '上座后进 ready：观众待发「准备」、机器人已就绪');
ok(state.readyDeadline > 0, `readyDeadline 下发（${state.readyDeadline}）`);
ok(mod.publicState(ctx).waitHint.includes('小明') && mod.publicState(ctx).waitHint.includes('准备'),
  `waitHint 点名未就绪观众（${mod.publicState(ctx).waitHint}）`);
// 未上座者发「准备」不生效
mod.handleDanmu(ctx, u('小红', { text: '排队' }));
mod.handleDanmu(ctx, u('小红', { text: '准备' }));
ok(state.status === 'ready' && state.seats.black.ready === false, '队列中（未上座）发「准备」不触发开局');
// 上座者发「准备」→ 立即开局
mod.handleDanmu(ctx, u('小明', { text: '准备' }));
ok(state.status === 'playing' && state.seats.black.name === '小明' && state.seats.black.ready === true, '上座观众发「准备」→ 立即开局');

console.log('── 双人准备确认：黑白都发才开局 ──');
mod.handleAction(ctx, 'endRound');
cfg.mode = 'pvp';
mod.handleAction(ctx, 'clearQueue');
mod.handleAction(ctx, 'start');   // force：队列空 → waiting
mod.handleDanmu(ctx, u('小红', { text: '排黑' }));
mod.handleDanmu(ctx, u('小明', { text: '排白' }));
runTimers('round');
ok(state.status === 'ready' && state.seats.black.ready === false && state.seats.white.ready === false, 'pvp 双方上座均未准备');
mod.handleDanmu(ctx, u('小红', { text: '就绪' }));
ok(state.status === 'ready' && state.seats.black.ready === true && state.seats.white.ready === false, '一方「就绪」→ 仍等待另一方');
mod.handleDanmu(ctx, u('小明', { text: '准备好了' }));
ok(state.status === 'playing' && state.seats.black.ready === true && state.seats.white.ready === true, '双方就绪 → 开局');

console.log('── 准备超时让座（readyWaitSec 触发，下一位顶上） ──');
mod.handleAction(ctx, 'endRound');
cfg.mode = 'pve'; cfg.readyWaitSec = 40;
mod.handleAction(ctx, 'clearQueue');
runTimers('round');   // 上局 result → autoNext → 队空 → waiting（清 seats）
ok(state.status === 'waiting', '超时测试前置：回到等待上座');
mod.handleDanmu(ctx, u('小明', { text: '排队' }));   // 先排 → 队首
mod.handleDanmu(ctx, u('小红', { text: '排队' }));   // 后排 → 第二
runTimers('round');   // 1.5s → 小明上座待准备
ok(state.status === 'ready' && state.seats.black.name === '小明' && state.seats.black.ready === false, '超时前置：小明上座待准备');
runTimers('ready');   // 触发 40s 超时定时器 → 小明让座 → 小红（队首）顶上
ok(state.seats.black.name === '小红' && state.status === 'ready' && state.seats.black.ready === false, '小明超时让座，队首「小红」顶上待准备');
ok(state.queues.black.has('u_小明'), '让座者回到队列等待');
ok(state.feed.some(f => f.type === 'seatTimeout'), 'feed 出现 seatTimeout 让座事件');
mod.handleDanmu(ctx, u('小红', { text: '准备' }));
ok(state.status === 'playing', '顶上者发「准备」→ 开局');

console.log('── ready 态边界：强开 / 坐标与送礼只提示不动作 ──');
mod.handleAction(ctx, 'endRound');
cfg.readyWaitSec = 0;   // 0 = 不限时
mod.handleAction(ctx, 'clearQueue');
mod.handleDanmu(ctx, u('小明', { text: '排队' }));
runTimers('round');
ok(state.status === 'ready' && state.readyDeadline === 0, 'readyWaitSec=0 仍进 ready（不限时等待）');
mod.handleDanmu(ctx, u('小明', { text: 'H8' }));   // ready 态坐标 → 只提示
ok(state.status === 'ready' && state.moves.length === 0, 'ready 态坐标弹幕只提示不落子');
mod.handleGift(ctx, { user: { id: 'u_小明', name: '小明' }, giftName: '火箭', giftCount: 1, repeatCount: 1 });
ok(state.status === 'ready' && state.moves.length === 0, 'ready 态上座者送礼不触发悔棋');
mod.handleAction(ctx, 'start');   // 主播「开始」= force → 跳过准备直接开局
ok(state.status === 'playing', '主播「开始」（force）跳过准备确认直接开局');
cfg.readyEnabled = false;

console.log('── 棋盘纯净防回归（engine 不再污染调用方棋盘） ──');
// A. engine 纯函数层：bestMove 不得改动调用方棋盘（旧 bug：搜索超时 ABORT 残留幽灵子）
const pmBoard = engine.emptyBoard(15);
[[7, 7], [6, 6], [8, 8], [7, 8], [8, 7], [9, 9], [6, 7]].forEach(([x, y], pi) => { pmBoard[I(x, y)] = (pi % 2) + 1; });
const pmSnap = pmBoard.slice();
const pmMv = engine.bestMove(pmBoard, 15, 1, 7, false);
let pmMut = false;
for (let pi = 0; pi < pmBoard.length; pi++) if (pmBoard[pi] !== pmSnap[pi]) { pmMut = true; break; }
ok(pmMv >= 0 && !pmMut && pmSnap[pmMv] === 0, `Lv7 bestMove：调用方棋盘零改动、返回落点为空（mv=${pmMv}）`);
// B. 端到端对局层：观众/bot 交替落子多手，每手后 盘面子数 === moves 数
if (state.status === 'playing') mod.handleAction(ctx, 'endRound');   // 收尾上个 ready 测试遗留的对局
mod.handleAction(ctx, 'clearQueue');
cfg.mode = 'pve'; cfg.botLevel = 7; cfg.readyEnabled = false;
mod.handleDanmu(ctx, u('小明', { text: '排队' }));
mod.handleAction(ctx, 'start');   // force：队列有人 → 直接开局
ok(state.status === 'playing' && state.seats.black && state.seats.white.kind === 'bot', '纯净局已开局（观众执黑 vs Lv7 人机）');
const pzCnt = () => state.board.filter(v => v !== 0).length;
const pzSeq = ['H8', 'J10', 'G7', 'K9', 'F8', 'H12', 'E7', 'L10', 'D9', 'M8'];
let pzP = 0, pzHands = 0, pzOk = true, pzWhy = '';
while (state.status === 'playing' && pzHands < 6 && pzP < pzSeq.length && pzOk) {
  if (state.turn === 'black') {   // 观众黑回合：落子成功才计数（坐标被占则试下一个点）
    mod.handleDanmu(ctx, u('小明', { text: pzSeq[pzP++] }));
    if (state.turn !== 'white') continue;
    pzHands++;
    if (pzCnt() !== state.moves.length) { pzOk = false; pzWhy = `黑手${pzHands}后 子数${pzCnt()}≠moves${state.moves.length}`; break; }
    continue;
  }
  await fireWait('bot');               // bot 白应手（异步就绪）
  if (state.status !== 'playing') break;
  pzHands++;
  if (state.turn !== 'black') { pzOk = false; pzWhy = `白手${pzHands}后轮次未回黑`; break; }
  if (pzCnt() !== state.moves.length) { pzOk = false; pzWhy = `白手${pzHands}应手后 子数${pzCnt()}≠moves${state.moves.length}（幽灵子污染！）`; break; }
}
ok(pzOk, pzOk ? `连续 ${pzHands} 手观众/bot 交替落子，每手后 子数 === moves 数（bot 应手零幽灵子）` : pzWhy);

console.log('── bot 看门狗兜底（主定时器丢失也能落子，杜绝「AI 一直思考中」） ──');
if (state.status === 'playing') mod.handleAction(ctx, 'endRound');
mod.handleAction(ctx, 'clearQueue');
cfg.mode = 'pve'; cfg.botLevel = 5; cfg.readyEnabled = false;
mod.handleDanmu(ctx, u('小红', { text: '排队' }));
mod.handleAction(ctx, 'start');
ok(state.status === 'playing' && state.seats.black.name === '小红', '看门狗局：小红 vs Lv5 人机');
mod.handleDanmu(ctx, u('小红', { text: 'H8' }));
ok(state.moves.length === 1 && state.turn === 'white', '小红落子，进入 bot 回合');
const wdBot = timers.some(t => t.g === 'bot'), wdGuard = timers.some(t => t.g === 'turn');
ok(wdBot && wdGuard, 'bot 回合挂双定时器：bot 主定时器 + turn 组看门狗');
ctx.clearTimers('bot');   // 模拟 bot 主定时器被误清 / 回调丢失
const wdM0 = state.moves.length;
await fireWait('turn');        // 只剩看门狗 → 应兜底落子
ok(state.moves.length === wdM0 + 1 && state.turn === 'black', '看门狗兜底：bot 定时器丢失仍成功落子、回合回黑');
ok(state.board[state.moves[state.moves.length - 1].i] === 2, '兜底落子确为白方（bot）子');
mod.handleDanmu(ctx, u('小红', { text: 'J10' }));   // 正常路径防误伤
ok(state.turn === 'white', '再次进入 bot 回合');
await fireWait('bot');
ok(state.turn === 'black' && !timers.some(t => t.g === 'turn'), 'bot 正常应手后看门狗已随换手清理（不残留重复触发）');

console.log('── idle 冷启动兜底（宿主重启后观众排队不再干等） ──');
if (state.status === 'playing') mod.handleAction(ctx, 'endRound');
mod.handleAction(ctx, 'clearQueue');
state.status = 'idle';                      // 模拟宿主重启后初始状态（等价 createState）
state.seats = { black: null, white: null }; // 队列已在 clearQueue 清空
ctx.clearTimers();
mod.handleDanmu(ctx, u('小明', { text: '排队' }));
ok(state.status === 'waiting' && state.queues.black.has('u_小明'), 'idle 态排队 → 自动进入「等待上座」并入队');
runTimers('round');                         // 1.5s 自动上座定时器
ok(state.status === 'playing' && state.seats.black && state.seats.black.name === '小明' && state.seats.white.kind === 'bot',
  '冷启动排队后 1.5s 自动开局（小明上座 vs bot）');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
})();
