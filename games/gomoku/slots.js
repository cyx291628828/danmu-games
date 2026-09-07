/**
 * ============================================================================
 * games/gomoku/slots.js — 弹幕五子棋 · AI 播报点定义（通用播报中心）
 * ============================================================================
 * 四个播报点：上座 / 开局 / 悔棋 / 结算。文案只吃已发生的事实。
 * ============================================================================
 */
'use strict';

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

module.exports = [
  {
    id: 'seat',
    label: '观众上座',
    desc: '等候队列第一名登座，播报催促围观',
    def: true,
    minGapSec: 0,
    system: '你是直播间五子棋游戏的主持人口播。播报观众成功上座，热情简短有梗，60字以内，只输出内容本身，不要任何前缀、引号或解释。',
    buildUser: d => `场景：五子棋观众上座\n「${d.name}」从等候队列杀出，坐上${d.side === 'black' ? '黑方' : '白方'}席位${d.sort > 0 ? `（排序值 ${d.sort}）` : ''}，全直播间围观\n请写一段上座播报。`,
    local: d => pick([
      `欢迎「${d.name}」登上${d.side === 'black' ? '黑' : '白'}方棋席！排队排到手软，这把可得下出点名堂！`,
      `「${d.name}」成功上座！弹幕发坐标就能落子，全场的目光都聚过来了！`,
    ]),
  },
  {
    id: 'roundStart',
    label: '开局召集',
    desc: '新一局开局：报对阵双方与规则，号召排队',
    def: true,
    minGapSec: 0,
    system: '你是直播间五子棋游戏的主持人口播。根据对阵信息写一段60字以内的中文口播，热情简短，只输出内容本身，不要任何前缀、引号或解释。',
    buildUser: d => `场景：新一局五子棋开始\n第 ${d.round} 局：黑方「${d.blackName}」 vs 白方「${d.whiteName}」${d.mode === 'pve' ? `（${d.botLevel}级人机）` : ''}，${d.forbidden ? '连珠禁手规则' : '无禁手'}，${d.size}路棋盘\n请写一段开局口播，顺便提一句发「排队」可以抢座位。`,
    local: d => pick([
      `第 ${d.round} 局开棋！黑方「${d.blackName}」对阵「${d.whiteName}」${d.forbidden ? '，本局启用禁手规则' : ''}。没上座的别急，发「排队」就能抢下一局的座位！`,
      `棋盘就位！「${d.blackName}」执黑先行，对面的「${d.whiteName}」接招！观众发坐标助威，想上座现在就排队！`,
    ]),
  },
  {
    id: 'undo',
    label: '送礼悔棋',
    desc: '上座观众送礼悔棋，播报调侃',
    def: true,
    minGapSec: 5,
    system: '你是直播间五子棋游戏的解说员。上座观众送礼悔棋，写一段60字以内的调侃口播，只输出内容本身，不要任何前缀、引号或解释。',
    buildUser: d => `场景：五子棋送礼悔棋\n「${d.name}」送礼撤回了 ${d.count} 手棋，棋局回到${d.side === 'black' ? '黑' : '白'}方手中\n请写一段调侃播报。`,
    local: d => pick([
      `「${d.name}」豪掷礼物直接悔棋，${d.count} 手棋原地消失！这波操作，对手都看愣了！`,
      `氪金的力量！「${d.name}」送礼悔棋成功，时光倒流 ${d.count} 手，棋盘表示压力很大！`,
    ]),
  },
  {
    id: 'result',
    label: '结算播报',
    desc: '胜负结算：恭喜胜者/安慰败者，预告下一局',
    def: true,
    minGapSec: 0,
    system: '你是直播间五子棋游戏的解说员。本局结束，写一段60字以内的中文结算口播：有胜者则恭喜并报得分，平局则安抚并预告下一局，只输出内容本身，不要任何前缀、引号或解释。',
    buildUser: d => {
      if (d.winner) {
        return `第 ${d.round} 局五子棋结束：${d.winnerName}（${d.winner === 'black' ? '黑' : '白'}方）获胜（${d.reasonLabel}），共 ${d.moves} 手${d.scoreLine ? `，${d.scoreLine}` : ''}，用时 ${d.durationSec} 秒`;
      }
      return `第 ${d.round} 局五子棋平局收场（${d.reasonLabel}），共 ${d.moves} 手，下一局马上开始`;
    },
    local: d => d.winner
      ? pick([
        `五连达成！「${d.winnerName}」赢下第 ${d.round} 局${d.scoreLine ? `，${d.scoreLine}` : ''}！这波操作值得全场掌声！`,
        `棋盘定格！恭喜「${d.winnerName}」${d.reasonLabel}拿下比赛！败者别气馁，重新排队再战！`,
      ])
      : pick([
        `第 ${d.round} 局握手言和！${d.moves} 手鏖战难分高下，下一局马上开棋！`,
        `平局！棋逢对手将遇良才，重新排队，下一局分个高下！`,
      ]),
  },
];
