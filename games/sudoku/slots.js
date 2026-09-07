/**
 * ============================================================================
 * games/sudoku/slots.js — 弹幕数独 · AI 播报点定义（通用播报中心）
 * ============================================================================
 * 三个播报点：开局 / 进度里程碑 / 结算。文案只吃已发生的事实：
 * 进度里程碑仅在填格比例跨过 50% / 80% 时触发；结算播报通关或超时的结果。
 * ============================================================================
 */
'use strict';

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

module.exports = [
  {
    id: 'roundStart',
    label: '开局召集',
    desc: '新一局数独开局：报难度与玩法，号召观众抢填',
    def: true,
    minGapSec: 3,
    system: '你是直播间弹幕数独游戏的主持人口播。根据开局信息写一段60字以内的中文口播，热情简短有号召力，只输出内容本身，不要任何前缀、引号或解释。',
    buildUser: d => `场景：新一局弹幕数独开始\n第 ${d.round} 局，难度「${d.diff}」，共 ${d.holes} 个空格待填，限时 ${d.sec} 秒\n观众弹幕发「行×列×数」抢填（如 A33 = A行3列填3），填对得分，点赞送礼还能触发助攻填格\n请写一段开局召集口播。`,
    local: d => pick([
      `第 ${d.round} 局数独开局！${d.diff}难度 ${d.holes} 个空格，限时 ${d.sec} 秒，弹幕发「A33」这种行列数就能抢填，手快有分！`,
      `新盘已就位！${d.diff}难度挖了 ${d.holes} 个洞，${d.sec} 秒填完全盘通关有 MVP 大奖，弹幕报「行×列×数」开抢！`,
    ]),
  },
  {
    id: 'progress',
    label: '进度里程碑',
    desc: '填格跨过 50% / 80% 时播报战况，刺激冲刺',
    def: true,
    minGapSec: 10,
    system: '你是直播间弹幕数独游戏的解说员。盘面填格进度到达里程碑，写一段60字以内的中文口播渲染战况、催促冲刺，热血带梗，只输出内容本身，不要任何前缀、引号或解释。',
    buildUser: d => `场景：数独盘面进度里程碑\n第 ${d.round} 局，已填 ${d.filled}/${d.total} 格（${d.pct}%），剩余 ${d.remainSec} 秒${d.mvpName ? `，目前最活跃的是「${d.mvpName}」` : ''}\n请写一段里程碑战况口播，号召大家继续抢填。`,
    local: d => pick([
      `进度条到 ${d.pct}% 了！${d.filled}/${d.total} 格被拿下，剩余 ${d.remainSec} 秒，${d.mvpName ? `「${d.mvpName}」杀疯了，` : ''}最后一个数也要抢！`,
      `${d.pct}% 完成度！全盘只剩 ${d.total - d.filled} 个空格，${d.remainSec} 秒内填完就是通关纪录，冲！`,
    ]),
  },
  {
    id: 'finish',
    label: '结算播报',
    desc: '通关报 MVP 用时；超时报进度并预告下一局',
    def: true,
    minGapSec: 0,
    system: '你是直播间弹幕数独游戏的解说员。本局结束，写一段60字以内的中文结算口播：通关则恭喜并报 MVP，超时则安抚并预告下一局，只输出内容本身，不要任何前缀、引号或解释。',
    buildUser: d => d.complete
      ? `第 ${d.round} 局数独通关！用时 ${d.durationSec} 秒${d.mvp ? `，MVP 是「${d.mvp.name}」，填对 ${d.mvp.cnt} 格拿下 ${d.mvp.score} 分` : '（无观众参与填格）'}`
      : `第 ${d.round} 局数独${d.reason === 'skip' ? '被主播结束' : '超时'}，共填出 ${d.filled}/${d.total} 格${d.mvp ? `，最活跃的是「${d.mvp.name}」` : ''}，下一局马上开始`,
    local: d => d.complete
      ? pick([
        `🏁 通关！${d.durationSec} 秒填满全盘${d.mvp ? `，MVP「${d.mvp.name}」狂填 ${d.mvp.cnt} 格拿 ${d.mvp.score} 分` : ''}，这就是团队的力量！`,
        `全盘填满！${d.durationSec} 秒完成挑战${d.mvp ? `，MVP 奖励颁给「${d.mvp.name}」` : ''}，下一局难度不变，再来！`,
      ])
      : pick([
        `本局时间到，填出 ${d.filled}/${d.total} 格，就差临门一脚！马上开新盘，卷土重来！`,
        `这局${d.reason === 'skip' ? '先到这里' : '没赶在上'},${d.filled}/${d.total} 格，下一局换个盘继续冲！`,
      ]),
  },
];
