/**
 * ============================================================================
 * games/chengyu/slots.js — 成语接龙 · AI 播报点定义（通用播报中心）
 * ============================================================================
 * 三个播报点：开新链 / 接龙里程碑（每 5 层）/ 中断小结。
 * 文案只吃已发生的事实，高频接龙靠 minGapSec 防刷屏。
 * ============================================================================
 */
'use strict';

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

module.exports = [
  {
    id: 'chainStart',
    label: '开新链',
    desc: '新一条接龙链开出：报起始词、号召接龙',
    def: true,
    minGapSec: 3,
    system: '你是直播间成语接龙游戏的主持人口播。根据起始词写一段60字以内的中文口播，热情、简短、有号召力，只输出内容本身，不要任何前缀、引号或解释。',
    buildUser: d => `新一链条开始，起始词「${d.word}」，观众要用「${d.tailChar}」或同音字开头接下一个成语，限时 ${d.sec} 秒`,
    local: d => pick([
      `新链条开接！从「${d.word}」出发，用「${d.tailChar}」字开头接下一个成语，${d.sec} 秒内接上就有分！`,
      `接龙重启！「${d.word}」，谁来接？${d.tailChar} 字开头，别让链子断在你手里！`,
    ]),
  },
  {
    id: 'milestone',
    label: '接龙里程碑',
    desc: '链长每达 5 层播报一次：报当前链长与最新成语',
    def: true,
    minGapSec: 10,
    system: '你是直播间成语接龙游戏的解说员。接龙链达到里程碑长度，写一段60字以内的中文解说，热血带梗，只输出内容本身，不要任何前缀、引号或解释。',
    buildUser: d => `当前接龙链已达 ${d.len} 层，最新一个成语是「${d.word}」（${d.user} 接的），下一位要接「${d.tailChar}」字开头`,
    local: d => pick([
      `链条已经 ${d.len} 层了！「${d.word}」接得漂亮，${d.tailChar} 字开头，谁能继续续上？`,
      `${d.len} 连接！这条龙越盘越长，「${d.user}」的「${d.word}」是关键一环，下一位顶上！`,
    ]),
  },
  {
    id: 'interrupt',
    label: '中断小结',
    desc: '接龙超时中断：报本轮长度与最佳接龙者',
    def: true,
    minGapSec: 0,
    system: '你是直播间成语接龙游戏的解说员。接龙链超时中断，写一段60字以内的中文小结口播，只输出内容本身，不要任何前缀、引号或解释。',
    buildUser: d => `本轮接龙在「${d.lastWord}」后中断，共接了 ${d.floors} 层${d.topUser ? `，最佳接龙者 ${d.topUser}（单层最高 ${d.topScore} 分）` : ''}`,
    local: d => pick([
      `链子断在「${d.lastWord}」！本轮 ${d.floors} 层，${d.topUser ? `${d.topUser} 砍下最高单层 ${d.topScore} 分` : '可惜没人接上'}，马上开新链再战！`,
      `${d.floors} 层的龙盘完了！${d.topUser ? `MVP 是 ${d.topUser}（+${d.topScore} 分）！` : ''}别走开，新词马上来！`,
    ]),
  },
];
