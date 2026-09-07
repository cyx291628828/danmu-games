# AI 语音播报 · 通用模块接入指南

> 位置：后端 `common/broadcast/index.js` ＋ 前端 `common/public/broadcast.js`（`window.DGBroadcast`）
> 参考实现：`games/race/`（赛马竞猜，首个接入方）

任何游戏约 **10 行代码**即可接入 AI 播报：服务端自动生成/回退/限流文案，主播台自动获得配置面板 + 浏览器 TTS 朗读（语速/音高/音色全游戏共享）。

---

## 一、核心概念

| 概念 | 说明 |
|---|---|
| **slot（播报点）** | 一个「什么时候该说话 + 说什么」的注册项。每个游戏自己定义，如赛马的 `roundOpen / raceStart / surge / gift / finish / jackpot` 等 |
| **三种生成方式** | `aiBroadcast` 配置：`off`（关）/ `local`（本地模板）/ `api`（OpenAI 兼容大模型，失败自动回退 local） |
| **配置存哪** | 存各游戏自己的 `cfg`（游戏配置文件），**密钥只存服务端，绝不下发前端** |
| **下发通道** | 复用游戏自己的 SSE `state`：`state.bc = {seq, slot, slotLabel, text, ts, log[]}`，前端 `watch` 监听 `seq` 自增触发朗读 |
| **限流** | 每个 slot 可设 `minGapSec`，同点高频事件（如礼物连击）不会刷屏 |

---

## 二、后端接入（5 步）

### 第 1 步：定义播报点（建议单独放 `games/<id>/slots.js`）

```js
module.exports = [
  {
    id: 'finish',              // 播报点唯一 id
    label: '结算战报',          // 主播台显示名
    desc: '头马出炉时解说',     // 主播台说明
    def: true,                 // 默认开关
    minGapSec: 0,              // 同点最小间隔秒（高频点建议 3~12）
    system: '你是XX游戏的解说员…只输出解说词本身。',
    buildUser: d => `结算数据：\n赢家：${d.winner}…`,   // 拼给大模型的 user prompt
    local: d => `恭喜 ${d.winner} 拿下本局！`,           // 本地模板（可返回数组随机挑一条）
  },
  // …更多播报点
];
```

### 第 2 步：引入并展开默认配置

```js
const { createBroadcaster, BC_CFG_DEFAULTS, BC_CFG_KEYS } = require('../../common/broadcast');

const CFG_DEFAULTS = {
  // …你的游戏配置…
  ...BC_CFG_DEFAULTS,        // ← 一行展开：aiBroadcast/aiApiUrl/aiApiKey/aiModel/aiTimeoutSec/bcAutoSpeak/bcEnabled
};
```

### 第 3 步：createState 里创建实例

```js
const SLOTS = require('./slots');
function createState() {
  return {
    // …你的状态…
    bc: null,
  };
}
// 在插件工厂/首次使用时：
const BC = createBroadcaster({ slots: SLOTS });   // 返回 { speak, generate, push, control, collectConfig, publicState, configSchema, … }
```

### 第 4 步：handleAction 加配置白名单 + 播报动作

```js
case 'config': {
  const allowed = [ /* …你的配置键… */, ...BC_CFG_KEYS ];   // ← 展开白名单
  // …
  BC.collectConfig(cfg, payload);    // ← 一行收集播报配置
  return { ok: true };
}
case 'broadcast':                    // 主播台「试播/手动播报」按钮
  return BC.control({ ...payload, data: { ...兜底数据, ...(payload.data || {}) } });
```

### 第 5 步：publicState 下发 + 业务点触发

```js
function publicState(ctx) {
  return {
    // …你的状态…
    ...BC.publicState(),   // ← 一行展开：bc / bcSlots / bcCfg（密钥已过滤）
  };
}

// 业务触发点（生成文案 → 写 state.bc → emit → 主播台朗读）：
BC.speak('finish', { winner: '黑珍珠', odds: 3.5 });   // 异步，受 bcEnabled 开关 + minGapSec 限流
BC.speak('surge', data, { force: true });              // force：无视开关与限流（慎用）
```

**进阶：文案既要上屏又要朗读**（如结算战报要写进 `state.result.report`）：

```js
const report = await BC.generate('finish', data);   // 只生成不推送
state.result.report = report;                        // 先上屏
BC.push('finish', report);                           // 再推入通道朗读（不会二次调大模型）
```

---

## 三、前端接入（主播台，2 行）

```html
<script src="/common/core.js"></script>
<script src="/common/broadcast.js"></script>
<script src="control.js"></script>
```

```js
/* control.js 里： */
DGBroadcast.mountPanel(document.getElementById('bcPanel'), { game: GAME });  // 渲染配置面板

/* SSE onState 回调里： */
DGBroadcast.watch(state);   // 监听 state.bc.seq → 自动朗读 + 渲染播报记录
```

面板自带：生成方式切换（本地/AI/关）、接口地址/模型/密钥/超时、**自动朗读总开关**、**逐播报点开关 + 试播按钮**、播报记录、TTS 语速/音高/音色（存 `localStorage['danmu_broadcast_tts']`，全游戏共享）。

---

## 四、安全与边界

- **密钥不下发**：`publicState()` 返回的 `bcCfg` 永远不含 `aiApiKey` 明文（有专门过滤，测试断言覆盖）。
- **失败回退**：API 模式调用失败/超时（默认 8s）自动回退本地模板，直播不冷场。
- **不开腔的场景**：`aiBroadcast='off'`、该 slot 被主播关掉、`minGapSec` 未到 → 静默跳过。
- **文案纪律**：`buildUser/local` 只吃「已发生的事实」，不要剧透未揭晓的结果（下注期绝不泄露答案）。

---

## 五、已接入清单

| 游戏 | 状态 | 播报点 |
|---|---|---|
| race（赛马竞猜） | ✅ 已接入 | 9 个：roundOpen / raceStart / surge / leadChange / cheer / likeStorm / gift / finish / jackpot |
| quiz（答题竞猜） | ✅ 已接入 | question（题目口播，不剧透答案） |
| redblue（红蓝大作战） | ✅ 已接入 | report（结算战报，拔河/守城分场景） |
| guess（猜数字） | ✅ 已接入 | roundOpen（出题开轮）/ win（猜中祝贺）/ timeout（超时揭晓） |
| chengyu（成语接龙） | ✅ 已接入 | chainStart（开链）/ milestone（楼层里程碑）/ interrupt（中断） |
| sudoku（弹幕数独） | ✅ 已接入 | roundStart（开局）/ progress（进度里程碑）/ finish（结算） |
| gomoku（弹幕五子棋） | ✅ 已接入 | seat（观众上座）/ roundStart（开局召集）/ undo（送礼悔棋）/ result（结算） |

> 全部 7 款游戏共用同一套 `common/broadcast`（后端）+ `common/public/broadcast.js`（前端）：
> 主播台均有统一的「AI 语音播报」面板（生成方式/接口/密钥/逐点开关/试播/TTS 语速音色），
> 密钥只存服务端不下发，API 失败自动回退本地模板。新游戏按本文档 5 步接入即可复用一切。
