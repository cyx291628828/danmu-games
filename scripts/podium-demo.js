/**
 * podium-demo.js — 数独结算面板联调：自动把当前盘面填完，触发通关结算
 * 用 8 个模拟观众轮流填对（按服务端下发的答案计算），外加 1 个观众错填 2 次制造错误数。
 * 通关后 finishedInfo.top5(6) 携带每人 正确数/错误数/得分，MVP +50，展示屏出领奖台面板。
 */
'use strict';
const http = require('http');
const WebSocket = require('ws');

function getState(game) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:18080/api/events?game=${game}`, res => {
      res.on('error', () => {});   // 提前销毁流时吞掉 premature close
      let buf = '';
      let cur = null;
      res.on('data', chunk => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {      // 按完整行切（状态串很大，会跨 chunk）
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith('event: ')) cur = line.slice(7).trim();
          else if (line.startsWith('data: ') && cur === 'state') {
            const st = JSON.parse(line.slice(6));
            res.destroy();
            resolve(st);
            return;
          }
        }
      });
    }).on('error', reject);
  });
}

(async () => {
  const GAME = 'sudoku';
  // 先结束可能残留的对局再开新局
  const ctl = (action) => new Promise(resolve => {
    const body = JSON.stringify({ game: GAME, action });
    const req = http.request({ host: '127.0.0.1', port: 18080, path: '/api/control', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b || '{}')));
    });
    req.on('error', () => resolve({})); req.end(body);
  });
  await ctl('endRound'); await new Promise(r => setTimeout(r, 400));
  await ctl('start'); await new Promise(r => setTimeout(r, 500));

  const st = await getState(GAME);
  const sol = st.solution, mask = st.mask;
  const filled = new Set((st.cells || []).map(c => c[0]));
  const targets = [];
  for (let i = 0; i < 81; i++) {
    if (mask[i] !== '1' && !filled.has(i)) {
      const row = String.fromCharCode(65 + Math.floor(i / 9));
      const col = (i % 9) + 1;
      targets.push({ text: `${row}${col}${sol[i]}`, idx: i });
    }
  }
  console.log('需填格数:', targets.length);

  const USERS = ['安然ঞ', '羽你逐风', '简单', '一种不能吃的小苦瓜', 'sym', '你喜欢的昵称', '糖糖', '老白'];
  const ws = new WebSocket('ws://127.0.0.1:18080/danmu');
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (m) => ws.send(JSON.stringify({ ...m, roomId: '', ts: Date.now(), game: GAME }));
  const user = (name) => ({ id: 'sim_' + name, displayId: 'sim_' + name, name, avatar: '' });

  // 翻车王先错填 2 次（挑两个空格填错值）
  const wrong1 = targets[0], wrong2 = targets[1];
  const wrongText = (t) => {
    const v = String(Number(t.text.slice(-1)) === 9 ? 1 : 9);
    return t.text.slice(0, -1) + v;
  };
  send({ event: 'chat', text: wrongText(wrong1), user: user('翻车王') });
  send({ event: 'chat', text: wrongText(wrong2), user: user('翻车王') });

  // 轮流填对所有空格（不同用户间隔 700ms 避开限频）
  let i = 0;
  const iv = setInterval(() => {
    const t = targets[i];
    const name = USERS[i % USERS.length];
    send({ event: 'chat', text: t.text, user: user(name) });
    i++;
    if (i >= targets.length) {
      clearInterval(iv);
      setTimeout(() => { ws.close(); process.exit(0); }, 1200);
    }
  }, 700);
})();
