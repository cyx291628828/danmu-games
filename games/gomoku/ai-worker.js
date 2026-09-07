/* ══════════════════════════════════════════════════════════════════
   ai-worker.js — 五子棋 AI 搜索工作线程（games/gomoku）
   ══════════════════════════════════════════════════════════════════
   【为什么要有这个线程】棋圣级（level 8-10）α-β 搜索单手可达 ~1s。
   若在主线程同步执行，会阻塞宿主事件循环 —— 弹幕分发、SSE 推送、
   其他所有游戏全部冻结。本线程常驻：
     收到 { id, board, size, sv, level, forbidden } → 计算 → 回 { id, mv }
   engine.js 是纯函数模块（无 IO、无外部依赖），在 Worker 内 require
   与主线程互不干扰（各自的置换表/行缓存独立）。
   ══════════════════════════════════════════════════════════════════ */
'use strict';

const { parentPort } = require('worker_threads');

let engine = null;
try {
  engine = require('./engine.js');
} catch (e) {
  parentPort.postMessage({ id: -1, err: String((e && e.message) || e) });
  throw e;
}

parentPort.on('message', (job) => {
  if (!job || !engine || job.id == null) return;
  try {
    const mv = engine.bestMove(job.board, job.size, job.sv, job.level, job.forbidden);
    parentPort.postMessage({ id: job.id, mv });
  } catch (e) {
    parentPort.postMessage({ id: job.id, err: String((e && e.message) || e) });
  }
});