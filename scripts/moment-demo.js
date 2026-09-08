/**
 * moment-demo.js — 观众时刻演出（进场/关注/送礼侧边横幅）联调工具
 * ============================================================================
 * 直连 ws://127.0.0.1:18080/danmu 发送演示事件，走与真实弹幕相同的分发管线，
 * 展示屏会弹出对应的演出卡片（排行榜里有成绩的观众还会显示「本玩法第 N 名」）。
 *
 * 用法：
 *   node scripts/moment-demo.js            # 单轮：进场 + 关注 + 送礼各一条
 *   node scripts/moment-demo.js --loop     # 循环补发 6 轮（每 2.5s），方便打开页面从容观察
 *
 * 演示用户取自 data/leaderboard.json 里真实观众（有本玩法积分，能演示游戏内信息行）。
 * ============================================================================
 */
'use strict';
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const LOOP = process.argv.includes('--loop');
const GAME = (process.argv.find(a => a.startsWith('--game=')) || '--game=sudoku').split('=')[1] || 'sudoku';

// 从排行榜挑 3 位有成绩的真实观众（无缓存时回退演示名）
function pickUsers() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'leaderboard.json'), 'utf8'));
    const byScore = arr.filter(r => (r.sudoku_score || 0) > 0).sort((a, b) => (b.sudoku_score || 0) - (a.sudoku_score || 0));
    if (byScore.length >= 3) {
      return [
        { id: byScore[0].key, name: byScore[0].name },
        { id: byScore[1].key, name: byScore[1].name },
        { id: byScore[2].key, name: byScore[2].name },
      ];
    }
  } catch {}
  return [{ id: 'demo1', name: '演示观众甲' }, { id: 'demo2', name: '演示观众乙' }, { id: 'demo3', name: '演示观众丙' }];
}

const [uEnter, uFollow, uGift] = pickUsers();
const ws = new WebSocket('ws://127.0.0.1:18080/danmu');

ws.on('open', () => {
  const send = (m) => { ws.send(JSON.stringify({ ...m, roomId: '', ts: Date.now(), game: GAME })); console.log('sent:', m.event, m.user && m.user.name); };
  const round = (n) => {
    send({ event: 'enter', user: { id: uEnter.id, displayId: uEnter.id, name: uEnter.name, avatar: '' } });
    send({ event: 'follow', user: { id: uFollow.id, displayId: uFollow.id, name: uFollow.name, avatar: '' } });
    send({ event: 'gift', user: { id: uGift.id, displayId: uGift.id, name: uGift.name, avatar: '' }, giftName: '火箭', giftCount: 2, repeatCount: 1 });
    if (n > 0) console.log(`--- 第 ${n} 轮补发 ---`);
  };
  round(0);
  if (LOOP) {
    let i = 0;
    const iv = setInterval(() => {
      i++;
      round(i);
      if (i >= 6) { clearInterval(iv); setTimeout(() => { ws.close(); process.exit(0); }, 400); }
    }, 2500);
  } else {
    setTimeout(() => { ws.close(); process.exit(0); }, 600);
  }
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
