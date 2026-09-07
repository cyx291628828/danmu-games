/**
 * simulate_likes.js — 模拟弹幕转发端发送「点赞」事件（本机联调用）
 * 用法：node scripts/simulate_likes.js 10
 * 说明：连 ws://127.0.0.1:18080/danmu 发送 N 条 event:'like' 消息（每次 likeCount=1），
 *       用于验证「线索按点赞数出现」等依赖点赞的玩法（对应 handleLike 接口）。
 */
'use strict';

const PORT = parseInt(process.env.PORT || '18080', 10);
const count = parseInt(process.argv[2] || '1', 10);
const WebSocket = require('ws');

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/danmu`);
ws.on('open', () => {
  for (let i = 0; i < count; i++) {
    ws.send(JSON.stringify({
      event: 'like', likeCount: 1,
      user: { name: '观众' + i, avatar: '' },
      eventContent: '点赞 x1', roomId: '', msgId: 'lk' + Date.now() + i, ts: Date.now(),
    }));
  }
  setTimeout(() => ws.close(), 400);
});
ws.on('error', e => { console.error('WS 错误:', e.message); process.exit(1); });
