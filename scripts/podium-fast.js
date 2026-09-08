/** 快速构造结算场景：1 人错填+正确填（错误数上卡），6 人上榜，立即结束结算 */
'use strict';
const http = require('http');
const WebSocket = require('ws');

function getState(game) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:18080/api/events?game=${game}`, res => {
      res.on('error', () => {});
      let buf = '', cur = null;
      res.on('data', chunk => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
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

function ctl(action) {
  return new Promise(resolve => {
    const body = JSON.stringify({ game: 'sudoku', action });
    const req = http.request({ host: '127.0.0.1', port: 18080, path: '/api/control', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b || '{}')));
    });
    req.on('error', () => resolve({})); req.end(body);
  });
}

(async () => {
  const GAME = 'sudoku';
  const st = await getState(GAME);
  if (st.status !== 'playing') { console.log('not playing:', st.status); process.exit(1); }
  const sol = st.solution, mask = st.mask;
  const filled = new Set((st.cells || []).map(c => c[0]));
  const empties = [];
  for (let i = 0; i < 81; i++) {
    if (mask[i] !== '1' && !filled.has(i)) empties.push(i);
  }
  console.log('空格数:', empties.length);
  if (empties.length < 7) { console.log('空格不足'); process.exit(1); }

  const ws = new WebSocket('ws://127.0.0.1:18080/danmu');
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (m) => ws.send(JSON.stringify({ ...m, roomId: '', ts: Date.now(), game: GAME }));
  const user = (name) => ({ id: 'sim_' + name, displayId: 'sim_' + name, name, avatar: '' });
  const cellText = (i, v) => `${String.fromCharCode(65 + Math.floor(i / 9))}${(i % 9) + 1}${v == null ? sol[i] : v}`;

  // 1) 小苦瓜先错填一次（正确值之外的数字）
  const w = String(Number(sol[empties[0]]) === 9 ? 1 : 9);
  send({ event: 'chat', text: cellText(empties[0], w), user: user('一种不能吃的小苦瓜') });
  await new Promise(r => setTimeout(r, 300));
  // 2) 六人各正确填一格（小苦瓜也正确填一格，保证上榜且带错误数）
  const names = ['一种不能吃的小苦瓜', '安然ঞ', '羽你逐风', '简单', 'sym', '你喜欢的昵称'];
  names.forEach((name, i) => send({ event: 'chat', text: cellText(empties[i + 1]), user: user(name) }));
  await new Promise(r => setTimeout(r, 1200));
  // 3) 立即结束结算
  await ctl('endRound');
  console.log('结算已触发');
  setTimeout(() => { ws.close(); process.exit(0); }, 300);
})();
