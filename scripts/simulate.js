/**
 * ============================================================================
 * simulate.js — 模拟 DanmuDesk 弹幕转发客户端（本机联调用）
 * ============================================================================
 * 用法：
 *   node scripts/simulate.js                          # 随机闲聊 + 随机猜测
 *   node scripts/simulate.js --solver                 # 带入真实答案定期猜（演示获胜流程）
 *   node scripts/simulate.js --game chengyu           # 弹幕只发给指定游戏（默认发给当前激活游戏）
 *   node scripts/simulate.js --game chengyu 成语甲成语乙  # 定向发送指定文本（冒烟测试）
 *   PORT=18080 node scripts/simulate.js --solver
 * ============================================================================
 */
'use strict';

const WebSocket = require('ws');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 18080;
const SOLVER = process.argv.includes('--solver');

// --game <id>：弹幕定向到指定游戏；其后若还有位置参数则作为一次性文本发送
const gameIdx = process.argv.indexOf('--game');
const TARGET_GAME = gameIdx >= 0 ? process.argv[gameIdx + 1] : null;
const ONCE_TEXTS = gameIdx >= 0 ? process.argv.slice(gameIdx + 2).filter(a => !a.startsWith('--')) : [];

const PLAYERS = [
  '小红', '阿强', '小明', '糖糖', '老白', '小鱼', '大壮', '桃子',
  '老王', '可乐', '豆豆', 'Lucky', 'Momo', '星辰', '雨点', '糖豆',
];

function randInt(n) { return Math.floor(Math.random() * n); }
function distinct4() {
  const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const out = [];
  for (let i = 0; i < 4; i++) out.push(pool.splice(randInt(pool.length), 1)[0]);
  return out.join('');
}
function pick(arr) { return arr[randInt(arr.length)]; }

const CHATS = [
  '主播唱得好听！', '来了来了', '666', '哈哈哈哈', '这个题目好难',
  '星标支持一下', '今天人好多', '前排围观', '冲鸭！', '主播今天状态不错',
];

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/danmu`);

let sent = 0;

function sendChat(name, text) {
  const msg = {
    event: 'chat',
    text,
    user: { id: `sim_${name}`, displayId: `sim_${name}`, name },
    roomId: '649634491139',
    ts: Date.now(),
  };
  if (TARGET_GAME) msg.game = TARGET_GAME;
  ws.send(JSON.stringify(msg));
  sent++;
  console.log(`  → [${name}]: ${text}${TARGET_GAME ? `（→ ${TARGET_GAME}）` : ''}`);
}

ws.on('open', () => {
  console.log(`✅ 已连接 ws://127.0.0.1:${PORT}/danmu${SOLVER ? '（求解模式：定期发送真实答案）' : ''}\n`);

  // 定向一次性文本（冒烟测试）
  if (ONCE_TEXTS.length) {
    ONCE_TEXTS.forEach((t, i) => setTimeout(() => sendChat(PLAYERS[i % PLAYERS.length], t), 300 * (i + 1)));
    setTimeout(() => { console.log('一次性文本发送完毕'); process.exit(0); }, 300 * ONCE_TEXTS.length + 2000);
    return;
  }

  // 常规弹幕流：一半闲聊一半猜测
  const idleLoop = setInterval(() => {
    const name = pick(PLAYERS);
    if (Math.random() < 0.55) {
      sendChat(name, pick(CHATS));
    } else {
      const g = distinct4();
      const withPrefix = Math.random() < 0.5;
      sendChat(name, withPrefix ? `猜 ${g}` : g);
    }
  }, 1500);

  const http = require('http');

  // 求解模式：从 SSE 读取答案，定期发出真实答案直到猜中
  if (SOLVER) {
    let answer = null;
    let sseReq = null;
    sseReq = http.get(`http://127.0.0.1:${PORT}/api/events?game=guess`, res => {
      res.on('data', chunk => {
        const text = chunk.toString('utf8');
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const s = JSON.parse(line.slice(6));
              if (s.answerFmt) answer = s.answerFmt.replace(/ /g, '');
            } catch {}
          }
        }
      });
    });
    const solverLoop = setInterval(() => {
      if (answer) {
        sendChat(pick(PLAYERS), `答案 ${answer}`);
      }
    }, 6000);
    ws.on('close', () => { clearInterval(idleLoop); clearInterval(solverLoop); if (sseReq) sseReq.destroy(); });
  } else {
    ws.on('close', () => clearInterval(idleLoop));
  }
});

ws.on('close', () => {
  console.log(`\n已断开，共发送 ${sent} 条消息`);
  process.exit(0);
});

ws.on('error', err => {
  console.error('❌ 连接失败:', err.message);
  process.exit(1);
});