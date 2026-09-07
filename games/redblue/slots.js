/**
 * ============================================================================
 * games/redblue/slots.js — 红蓝大作战 · AI 播报点定义（已迁移到通用播报中心）
 * ============================================================================
 * 仅一个播报点 `report`：每轮结算后生成战报解说，写入 result.report 上屏 +
 * 推入通用播报通道（主播台面板朗读/记录）。
 * 数据来源：只吃结算结果（不碰玩家隐私字段），API 请求体仅包含对局统计。
 *
 * 迁移自旧 games/redblue/report.js（common/broadcast 统一调度后删除）。
 * ============================================================================
 */
'use strict';

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/* ───────────── 本地模板：拔河轮（按 战线差距/胜负原因/冲锋次数 分场景） ───────────── */
function localTug(r) {
  const gap = Math.abs((r.pos || 50) - 50);
  const winName = r.winner === 'red' ? r.red.name : r.blue.name;
  const loseName = r.winner === 'red' ? r.blue.name : r.red.name;
  const mvpName = r.mvp && r.mvp.length ? r.mvp[0].name : '';
  const streakTxt = r.streak && r.streak.n > 1 ? `，${winName}已经${r.streak.n}连胜杀疯了` : '';
  const mvpTxt = mvpName ? `。本局最亮的是${mvpName}` : '';
  const surgeTotal = (r.red.surges || 0) + (r.blue.surges || 0);

  if (r.draw) {
    return pick([
      `势均力敌！战线钉在正中央，双方谁也奈何不了谁，各拿${r.loseScore}分下次再战！`,
      `罕见平局！绳子纹丝不动，两边的力气是打到一块去了，这波全靠下一局找回场子！`,
    ]);
  }
  if (r.reason === 'pushed' && gap >= 40) {
    return pick([
      `碾压局！${winName}一波把${loseName}推到了家，战线直接推穿，全员+${r.winScore}分！${streakTxt}`,
      `${winName}今天状态炸裂，一路平推碾压${loseName}，${loseName}兄弟们回来复盘一下！${mvpTxt}`,
    ]);
  }
  if (r.reason === 'pushed' && gap < 12) {
    return pick([
      `刀口险胜！最后关头${winName}硬是把战线多拽了${gap}%，${loseName}就差一口气，太刺激了！${mvpTxt}`,
      `心脏骤停的一局！${winName}以${Math.round(r.pos)}%的战线险胜，这比分放到决赛圈都够看！`,
    ]);
  }
  if (surgeTotal > 0) {
    return pick([
      `冲锋定胜负！全场打出${surgeTotal}次全军冲锋，${winName}踩着冲锋浪头赢下本局，全员+${r.winScore}分！${streakTxt}${mvpTxt}`,
      `${winName}的点赞党立大功！能量条一次次拉满，冲锋一波接一波，${loseName}根本顶不住！`,
    ]);
  }
  return pick([
    `${winName}稳扎稳打拿下本局，战线定格在${Math.round(r.pos)}%，${loseName}虽败犹荣拿${r.loseScore}分参与奖！${streakTxt}`,
    `拉锯战笑到最后的是${winName}！一格一格把${loseName}磨了回去，稳字诀才是王道！${mvpTxt}`,
  ]);
}

/* ───────────── 本地模板：守城轮（按 成败/原因/城墙剩余 分场景） ───────────── */
function localSiege(r) {
  const mName = r.monster.name;
  const mvpName = r.mvp && r.mvp.length ? r.mvp[0].name : '';
  const mvpTxt = mvpName ? `输出王${mvpName}功不可没` : '';
  const wallPct = r.wall ? Math.round(r.wall.hpLeft / r.wall.hpMax * 100) : 0;

  if (r.success) {
    if (r.reason === 'killed' && wallPct <= 30) {
      return `惊天动地！全服守军在城墙只剩${wallPct}%的绝境下斩杀${mName}，这就是背水一战的力量！全员+${r.winScore}分！${mvpTxt}！`;
    }
    return pick([
      `${mName}倒下了！全体守军${r.fighters}人合力输出，城墙还剩${wallPct}%，守住啦！全员+${r.winScore}分！${mvpTxt}！`,
      `捷报！${mName}被全员合力斩于城下，这一波团战打得漂亮，奖品已发，下一只怪更凶，准备好！`,
    ]);
  }
  if (r.reason === 'wall') {
    return pick([
      `城破了…${mName}最后一击压垮了城墙，差一点点！全体守军拿${r.loseScore}分安慰奖，重整旗鼓下一局复仇！`,
      `${mName}攻破了城墙，兄弟们虽败犹荣，输出都看在眼里，休息一下再来！`,
    ]);
  }
  return `时间到！${mName}还剩${r.monster.hpLeft}点血量溜走了，就差一口气的输出，全员+${r.loseScore}分，下次一定斩它！`;
}

module.exports = [
  {
    id: 'report',
    label: '结算战报',
    desc: '每轮结算自动生成解说（拔河/守城分场景），上屏 + 主播台朗读',
    def: true,
    minGapSec: 0,
    system: '你是直播间弹幕游戏的解说员，风格热血、简短、带梗。根据对局结算数据写一段80字以内的中文战报解说，只输出解说词本身，不要任何前缀、引号或解释。',
    buildUser: r => {
      const data = r.mode === 'siege' ? {
        模式: 'PVE守城战', 怪物: r.monster.name, 怪物血量上限: r.monster.hpMax,
        怪物剩余血量: r.monster.hpLeft, 守城结果: r.success ? '成功斩杀' : (r.reason === 'wall' ? '城墙被攻破' : '时间到未斩杀'),
        城墙剩余百分比: r.wall ? Math.round(r.wall.hpLeft / r.wall.hpMax * 100) : 0,
        参战人数: r.fighters, MVP: (r.mvp || []).map(m => m.name),
      } : {
        模式: '红蓝拔河对抗', 胜方: r.winner === 'red' ? r.red.name : r.blue.name,
        负方: r.winner === 'red' ? r.blue.name : r.red.name,
        是否平局: !!r.draw, 战线位置百分比: r.pos, 胜负原因: r.reason === 'pushed' ? '推到胜负线' : '倒计时结束',
        双方冲锋次数: [r.red.surges, r.blue.surges], 双方人数: [r.red.count, r.blue.count],
        MVP: (r.mvp || []).map(m => m.name), 连胜: r.streak ? r.streak.n : 0,
      };
      return '对局数据：\n' + JSON.stringify(data, null, 1);
    },
    local: r => (r.mode === 'siege' ? localSiege(r) : localTug(r)),
  },
];
