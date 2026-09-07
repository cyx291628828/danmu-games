/**
 * ============================================================================
 * common/logger.js — 日志（控制台 + 落盘）
 * ============================================================================
 * log/app 风格：按行写入 logDir 下指定文件（追加），时间戳 zh-CN。
 * 供宿主与游戏模块共用（游戏模块经 ctx.log 使用）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function createLogger(logDir, fileName = 'game.log') {
  function log(level, ...args) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = `[${ts}] [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
    console.log(line);
    try {
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, fileName), line + '\n');
    } catch { /* 落盘失败不影响运行 */ }
  }
  return {
    log,
    info: (...a) => log('INFO', ...a),
    warn: (...a) => log('WARN', ...a),
  };
}

module.exports = { createLogger };
