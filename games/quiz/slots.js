/**
 * ============================================================================
 * games/quiz/slots.js — 答题竞猜 · AI 播报点定义（已迁移到通用播报中心）
 * ============================================================================
 * 仅一个播报点 `question`：出题时为主播生成「主持人口播引导语」。
 * 规则：只念题目与选项、号召作答，**绝不剧透正确答案**；
 *       API 模式的请求体只含题干与选项文本，不含答案，绝不泄题。
 *
 * 迁移自旧 games/quiz/narrate.js（common/broadcast 统一调度后删除）。
 * ============================================================================
 */
'use strict';

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

module.exports = [
  {
    id: 'question',
    label: '题目口播',
    desc: '出题时念题干与选项、号召作答（绝不剧透答案）',
    def: true,
    minGapSec: 0,
    system: '你是直播间答题节目的主持人口播。根据一道题写一段 60 字以内的中文引导语，要热情、简短、有号召力。只念题干和选项、号召观众作答，绝对不能说出正确答案，不要任何前缀、引号或解释，只输出口播语本身。',
    buildUser: d => `题目：${d.question}\n选项：\n${(d.options || []).join('\n')}\n\n请写一段主持人口播引导语（不要给出答案）。`,
    local: d => {
      const round = Number(d.round) || 0;
      const opts = (d.options || []).join('，');
      const openers = [
        `第 ${round} 题来啦`,
        `欢迎来到第 ${round} 题`,
        `下一题，第 ${round} 题`,
      ];
      const calls = [
        '把你的答案扣在公屏上，答对得分哦！',
        '大家赶紧把选项打在公屏，越快分越高！',
        '觉得是哪个，马上发出来，别犹豫！',
      ];
      return `${pick(openers)}！${d.question} 选项有：${opts}。${pick(calls)}`;
    },
  },
];
