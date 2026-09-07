/**
 * ============================================================================
 * games/race/slots.js — 赛马竞猜 · AI 播报点定义
 * ============================================================================
 * 每个 slot = 一个「什么时候该说话 + 说什么」的播报点：
 *   id         播报点唯一 id（主播台开关、手动试播都用它）
 *   label      主播台显示名
 *   desc       一句话说明（主播台面板展示）
 *   def        默认是否开启（缺省 true）
 *   minGapSec  同一播报点的最小间隔（高频事件防止刷屏）
 *   system     大模型 system prompt（aiBroadcast='api' 时用）
 *   buildUser  把对局数据拼成 prompt（aiBroadcast='api' 时用）
 *   local      本地模板（aiBroadcast='local' 或大模型失败回退时用）
 *
 * 文案只吃「已经发生的事实」，不剧透未开赛的结果 —— 下注期绝不泄露头马。
 * ============================================================================
 */
'use strict';

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const n1 = v => (Math.round(Number(v) * 10) / 10);

/** 统一的解说员人设 */
const RACE_SYSTEM = '你是直播间赛马竞猜的解说员，风格热血、紧凑、带梗，像赛马现场解说。根据给出的对局数据写一段60字以内的中文口播，要有画面感和煽动性，只输出口播内容本身，不要任何前缀、引号或解释。';

/** 把马匹数据压成 prompt 里的一行行文本 */
function horseLines(horses) {
  return (horses || []).map(h => `${h.no}号${h.name}（赔率×${n1(h.odds)}${h.bettors != null ? `，${h.bettors}人押` : ''}${h.pos != null ? `，位置${Math.round(h.pos)}%` : ''}）`).join('；');
}

module.exports = [
  /* ───────── 1. 开局·下注播报 ───────── */
  {
    id: 'roundOpen',
    label: '开局下注播报',
    desc: '新一局开闸时：报马名、初始赔率、号召发 1/2/3/4 下注',
    def: true,
    minGapSec: 5,
    system: RACE_SYSTEM,
    buildUser: d => `场景：新一局赛马开始下注\n第 ${d.round} 局，每注 ${d.baseBet} 筹码，彩池已有 ${d.pool} 筹码${d.carry ? `（含上局滚存 ${d.carry}）` : ''}\n参赛马匹：${horseLines(d.horses)}\n请写一段开局口播，号召观众弹幕发 1/2/3/4 下注，并点出赔率最诱人的冷门马。`,
    local: d => {
      const cold = (d.horses || []).slice().sort((a, b) => b.odds - a.odds)[0];
      const hot = (d.horses || []).slice().sort((a, b) => b.bettors - a.bettors)[0];
      const coldTxt = cold ? `目前最冷的是${cold.no}号${cold.name}，赔率${n1(cold.odds)}倍，搏一把直接翻倍！` : '';
      const hotTxt = hot ? `${hot.no}号${hot.name}现在最热门` : '';
      return pick([
        `第 ${d.round} 局开闸下注！${horseLines(d.horses)}。公屏发 1 到 4 下注，每注 ${d.baseBet} 筹码，${coldTxt}${hotTxt}，押中的今晚加鸡腿！`,
        `各位老板，第 ${d.round} 局赛马马上开始！${horseLines(d.horses)}。发数字 1 到 4 就是下注，${d.baseBet} 筹码一注，赔率实时跳动，看准了再下手！${coldTxt}`,
      ]);
    },
  },

  /* ───────── 2. 开赛播报 ───────── */
  {
    id: 'raceStart',
    label: '开赛播报',
    desc: '闸门开启瞬间：报对阵、号召点赞为自己押的马加速',
    def: true,
    minGapSec: 5,
    system: RACE_SYSTEM,
    buildUser: d => `场景：赛马闸门刚打开，比赛开始\n彩池 ${d.pool} 筹码，共 ${d.bets} 注\n马匹：${horseLines(d.horses)}\n点赞规则：每 ${d.likesPerBoost} 个赞为自己押的马加速 1 格\n请写一段开赛口播，鼓动观众点赞为自己押的马加速。`,
    local: d => pick([
      `闸门打开！${(d.horses || []).length} 匹马冲出去了！${horseLines(d.horses)}。押了的朋友现在疯狂点赞，每 ${d.likesPerBoost} 个赞给自己那匹马加一格，最后关头能翻盘！`,
      `开赛！${horseLines(d.horses)}。全场 ${d.bets} 注、彩池 ${d.pool} 筹码，押中的按赔率翻倍拿走！点赞就是马力，${d.likesPerBoost} 赞一格，冲啊！`,
    ]),
  },

  /* ───────── 3. 冲刺事件播报 ───────── */
  {
    id: 'surge',
    label: '冲刺事件播报',
    desc: '某匹马突然发力冲刺时实时解说',
    def: true,
    minGapSec: 8,
    system: RACE_SYSTEM,
    buildUser: d => `场景：比赛中某匹马突然爆发冲刺\n${d.horse.no}号${d.horse.name}突然发力，当前位置 ${Math.round(d.horse.pos)}%，领先马是${d.leadName}（${Math.round(d.leadPos)}%）\n请写一句冲刺解说。`,
    local: d => pick([
      `${d.horse.no}号${d.horse.name}突然发力！四蹄生风往前窜，${d.leadName}危险了！`,
      `看${d.horse.no}号${d.horse.name}！这波冲刺太凶了，直接从后面杀了上来！`,
      `${d.horse.name}爆发了！这是要一口气吃掉前面所有人啊！`,
    ]),
  },

  /* ───────── 4. 领先易主播报 ───────── */
  {
    id: 'leadChange',
    label: '领先易主播报',
    desc: '头马换人时播报（反超名场面）',
    def: true,
    minGapSec: 10,
    system: RACE_SYSTEM,
    buildUser: d => `场景：比赛中领先位置发生反超\n新的领先马：${d.horse.no}号${d.horse.name}（${Math.round(d.horse.pos)}%），被反超的是${d.prevName}（${Math.round(d.prevPos)}%）\n请写一句反超解说。`,
    local: d => pick([
      `反超了！${d.horse.no}号${d.horse.name}硬是从${d.prevName}手里把第一抢了回来！`,
      `领先易主！${d.horse.name}超过${d.prevName}，这就是赛马，不到终点谁都不算赢！`,
      `${d.prevName}被${d.horse.name}咬住了、超过了！押${d.horse.no}号的朋友站起来！`,
    ]),
  },

  /* ───────── 5. 点赞助力播报 ───────── */
  {
    id: 'cheer',
    label: '点赞助力播报',
    desc: '某位观众的点赞把所押的马推到领先时点名感谢',
    def: true,
    minGapSec: 12,
    system: RACE_SYSTEM,
    buildUser: d => `场景：观众点赞为马加速见效\n观众「${d.name}」累计点赞 ${d.likes} 次，把${d.horse.no}号${d.horse.name}推进到 ${Math.round(d.horse.pos)}%\n请写一句带感谢和煽动的解说。`,
    local: d => pick([
      `${d.name}的 ${d.likes} 个赞立功了！${d.horse.no}号${d.horse.name}被一路推到 ${Math.round(d.horse.pos)}%，这就是点赞的力量！`,
      `谢谢${d.name}！${d.likes} 个赞全是马力，${d.horse.name}现在冲到 ${Math.round(d.horse.pos)}%！大家接着点！`,
    ]),
  },

  /* ───────── 6. 点赞风暴播报 ───────── */
  {
    id: 'likeStorm',
    label: '点赞风暴播报',
    desc: '冲刺期多人同时点赞触发全屏风暴时解说（推高点赞欲的核心播报）',
    def: true,
    minGapSec: 20,
    system: RACE_SYSTEM,
    buildUser: d => `场景：比赛最后冲刺，多位观众同时疯狂点赞，触发全屏「点赞风暴」\n引爆者「${d.name}」累计点赞 ${d.likes} 次，其押注的${d.horse.no}号${d.horse.name}被顶到 ${Math.round(d.horse.pos)}%\n请写一段极具煽动性的解说，号召全场观众一起点赞，把点赞气氛推到顶点。`,
    local: d => pick([
      `点赞风暴来了！${d.name}带头狂点 ${d.likes} 个赞，${d.horse.no}号${d.horse.name}被顶到 ${Math.round(d.horse.pos)}%！全场跟我一起点，把你们的马点进终点！`,
      `风暴眼形成！${d.name}的 ${d.likes} 个赞引爆全场，${d.horse.name}直接起飞！别停，继续点，最后五秒人人都有机会改命！`,
    ]),
  },

  /* ───────── 7. 礼物骑士播报 ───────── */
  {
    id: 'gift',
    label: '礼物骑士播报',
    desc: '送礼者为自己押的马召唤「骑士冲锋」时鸣谢',
    def: true,
    minGapSec: 3,
    system: RACE_SYSTEM,
    buildUser: d => `场景：观众送礼触发骑士冲锋\n观众「${d.name}」送出${d.giftName || '礼物'}，其押注的${d.horse.no}号${d.horse.name}获得骑士冲锋 +${d.cells} 格\n请写一句热情致谢并渲染气势的解说。`,
    local: d => pick([
      `${d.name}送出${d.giftName || '礼物'}！骑士冲锋！${d.horse.no}号${d.horse.name}直接前冲 ${d.cells} 格，这波大气！`,
      `感谢${d.name}的${d.giftName || '礼物'}！${d.horse.name}获得骑士冲锋加持 +${d.cells} 格，老板大气！`,
    ]),
  },

  /* ───────── 7. 结算战报 ───────── */
  {
    id: 'finish',
    label: '结算战报',
    desc: '头马出炉：按赔率派彩结果解说（含冷门/险胜/点赞改命等场景）',
    def: true,
    minGapSec: 0,
    system: '你是直播间赛马竞猜的解说员。根据结算数据写一段80字以内的中文战报解说，要点出胜负关键（大热门稳赢 / 冷门爆冷 / 点赞改命 / 险胜一鼻 / 无人押中滚存），风格热血带梗，只输出解说词本身。',
    buildUser: d => `结算数据：\n头马：${d.winner.no}号${d.winner.name}\n最终赔率：×${n1(d.odds)}\n彩池：${d.pool} 筹码\n押中人数：${d.winnerCount} 人，派彩合计：${d.payout} 筹码\n最大单笔赢得：${d.best && d.best.name ? `${d.best.name} +${d.best.payout}` : '无'}\n该马是否为赛前大热门：${d.wasFavorite ? '是' : '否'}\n胜负差距：${d.margin} 格${d.boostSaved ? `\n点赞助力贡献：${d.boostSaved} 格（点赞改命）` : ''}\n是否无人押中（头奖滚存）：${d.jackpot ? '是' : '否'}`,
    local: d => {
      if (d.jackpot) {
        return pick([
          `全场没人押中${d.winner.name}！${d.pool} 筹码全部滚存到下一局，彩池越滚越大，下局直接起飞！`,
          `爆冷无人区！${d.winner.name}一路绝尘，可惜没人押它，${d.pool} 筹码全部滚存，下一局的赔率会疯！`,
        ]);
      }
      if (!d.wasFavorite && d.odds >= 4) {
        return pick([
          `冷门爆冷！${d.winner.no}号${d.winner.name}以 ${n1(d.odds)} 倍赔率杀出重围，${d.winnerCount} 位胆大的朋友直接翻倍，热门党当场沉默！`,
          `这就是赛马！大冷门${d.winner.name}${n1(d.odds)} 倍夺冠，押中的 ${d.winnerCount} 人今晚做梦都能笑醒，追热门的全都傻眼！`,
        ]);
      }
      if (d.boostSaved) {
        return pick([
          `点赞改命！${d.winner.name}靠观众 ${d.boostSaved} 格的点赞助力硬生生冲过终点，这就是人多力量大，押中的 ${d.winnerCount} 人全部按 ${n1(d.odds)} 倍派彩！`,
          `最后关头全场点赞把${d.winner.name}推过线！${d.boostSaved} 格全是赞出来的，${d.winnerCount} 位赢家每人 ${n1(d.odds)} 倍拿走筹码！`,
        ]);
      }
      if (d.margin <= 3) {
        return pick([
          `一鼻之差！${d.winner.name}只赢了 ${d.margin} 格就压线夺冠，心脏骤停的一局！${d.winnerCount} 位赢家按 ${n1(d.odds)} 倍派彩！`,
          `险胜！${d.winner.name}以 ${d.margin} 格的微弱优势绝杀，差点就被反超，押中的 ${d.winnerCount} 人这波心跳拉满！`,
        ]);
      }
      return pick([
        `${d.winner.no}号${d.winner.name}稳稳拿下！大热门不负众望，${d.winnerCount} 位朋友按 ${n1(d.odds)} 倍赔率收米，恭喜恭喜！`,
        `毫无悬念！${d.winner.name}全程领跑夺冠，${d.winnerCount} 人押中、共派彩 ${d.payout} 筹码，下一局换个冷门搏一把？`,
      ]);
    },
  },

  /* ───────── 8. 头奖滚存播报 ───────── */
  {
    id: 'jackpot',
    label: '头奖滚存播报',
    desc: '无人押中头马、彩池滚存到下一局时的炸裂播报',
    def: true,
    minGapSec: 0,
    system: RACE_SYSTEM,
    buildUser: d => `场景：本局无人押中头马，彩池全部滚存到下一局\n第 ${d.round} 局滚存金额：${d.pool} 筹码（累计滚存 ${d.carry}）\n请写一句极具煽动性的播报，鼓动观众下一局一定要下注。`,
    local: d => pick([
      `头奖滚存！${d.pool} 筹码没人拿走，全部滚进下一局，下局的赔率会疯到什么程度？现在不下注更待何时！`,
      `${d.pool} 筹码原地滚存！下一局彩池起步就这个数，朋友们，这一把可能直接封神，赶紧准备下注！`,
    ]),
  },
];
