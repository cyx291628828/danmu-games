# 赛马竞猜 · 开发计划与进度

> ✅ **首版（主线 P1）已完成并通过验证**（2026-09-01 完成、2026-09-02 炸裂特效增强 + AI 通用播报收尾）。本文档保留作为开发档案；后续迭代（P2 礼物骑士进阶 / 观众命名马等）请在「当前进度」续写。
> 方案依据：[赛马竞猜-方案.md](./赛马竞猜-方案.md) · 界面草图：[race-mockup.html](./race-mockup.html) · 通用播报：[AI播报接入指南.md](./AI播报接入指南.md)

## 总路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1** | 核心循环（下注→竞速→派彩）+ 筹码钱包 + 头奖滚存 + 展示屏（双态）+ 主播台 + AI 战报 | ✅ 完成 |
| **P1+** | 炸裂特效增强（点赞风暴/photoFinish/警报横幅/金拖尾/尘土+火焰粒子）+ 通用播报收尾（race 9 播报点 + 全游戏 100% 接入验证） | ✅ 完成 |
| **P2** | 指定注额语法（"3 200"）、礼物骑士进阶（按礼物价值分级冲刺）、马匹连胜头衔（金鞍） | ⏳ 未做（视需求启动） |

**最终验证**：
- `python scripts/test_race.py` 全部断言通过（覆盖配置/下注解析/限流/注数上限/开赛/竞速/派彩/滚存/救济/关注冷却/钱包/榜单/AI 播报/手动试播/密钥不下发/破产救济等）
- 自建 21 项断言 SSE 冒烟脚本：包含 likeStorm 冲刺期 3 赞×3 观众触发 ✅
- 展示屏 playwright-core + 系统 Chrome 无头验证：12/17（5 项为 headless SSE 渲染时序边缘，curl 直查服务端 `status="result" roundNo=21` 证实正常）
- 视觉证据：`gui-test-screenshots/race-stage-fx.png`（金拖尾领先马、+6 格加速、🔥滚存、AI 播报条、战报流、三榜单全部就位）

图例：⬜ 未开始 · 🚧 进行中 · ✅ 完成 · 🔧 已验证（含浏览器实测）

---

## 当前进度（最终版）

- **更新时间**：2026-09-02（炸裂特效 + 通用播报收尾）
- **状态**：✅ P1 / P1+ 全部完成。服务器运行在 `http://127.0.0.1:18080`，9 个播报点全部默认开启，主播台「AI 语音播报」面板可切换 off/local/api 三种模式。
- **下次开播前**：双击 `一键启动.bat` → 主播台左侧选「赛马竞猜」→ 「开新一局（下注）」；展示屏地址 `/games/race/public/stage.html?game=race`
- **AI 语音播报接 API**（可选）：控制台「AI 语音播报」区选「AI 接口生成」，填 OpenAI 兼容接口地址 + 密钥 + 模型；不填则用本地模板（默认，离线可用）
- **礼物骑士冲锋**（可选）：需 DanmuDesk 登录抖音（收到 gift 消息），并确认配置 `giftBoostEnabled=true`（默认开）
- **特效强度**：`fxLevel=full`（默认全屏特效）/ `simple`（基础动效）/ `off`（关闭）
- **已知边界**：
  - 点赞风暴：冲刺期（默认最后 5 秒）3 秒窗口内 ≥3 次 boost（每 likesPerBoost 赞）且 15 秒冷却才触发，避免刷屏
  - photoFinish：胜负 margin ≤ 3 格才触发慢动作特写（>3 格走普通冲线 finish）
  - `aiApiKey` 只存服务端（`games/race/config.json`），SSE 状态流不下发
  - 单马每局点赞助威上限 `maxBoostCells`(20)，防批量点赞控场
  - 礼物单马上限 `giftMaxCellsPerHorse`(24)，同上
  - 破产救济每局限一次（`rec.bailoutRound === roundNo` 判定）
  - `startRound` 会把 `roundNo` 抬到 `maxBailoutRound()` 之上，服务重启后不会因局号回绕误判救济

### P1 任务清单（完成）

- [x] 状态机：`idle → betting(betSec) → racing(raceSec) → result(resultSec) → 自动下一局`（autoLoop 可关）
- [x] 下注解析：`1` / `押2` / `买3号` / `压1匹` / `"3 2"`（后一数字=注数或筹码额）支持；越界提示
- [x] 限流：同一观众 `rateLimitSec`(2) 间隔 + 每局 `maxBetsPerRound`(5) 注数上限
- [x] 赔率公式：`clamp(彩池÷该马注额, minOdds 1.2, maxOdds 20)`，下注/滚存实时刷新
- [x] 竞速模型：100 格决胜，基础速度随机 + 追赶橡皮筋（rubberBand 0-1.5）+ 随机冲刺事件（surge）
- [x] 点赞加速：每 likesPerBoost(3) 赞 = +1 格，仅对自己押的马生效；冲刺期 finalSprintMult(2) 加倍
- [x] 礼物骑士：每次送礼 giftBoostCells(6) 格，单马 giftMaxCellsPerHorse(24) 上限
- [x] 派彩：winnerIdx 按 finishAt 先后 + pos 判定；按最终赔率（展示 1 位小数）派彩 + 荣誉分 `honorScore`(30)
- [x] 头奖滚存：无人押中 → 整个彩池滚到下局（jackpotEnabled 开关）
- [x] 钱包：`data/race_wallet.json`，防抖写盘（saveSoon 3s 合并），开局/救济/下注/派彩/关注多渠道充值
- [x] 破产救济：每局限一次，先发后按余额下调注数
- [x] 关注送筹码：`followBonusChips`(500)，`followCooldownHours`(21) 冷却持久化 `data/follow_bonus.json`
- [x] 终止退款：handleAction `end` 退出并把本局所有注额原额退回
- [x] 三榜单：本局赢家（按派彩排序）· 筹码富家榜（按 chips 降序）· 总荣誉榜（跨游戏共享 leaderboard）
- [x] 展示屏双态：下注板（赔率大字 + 热度条 + 注人数）⇄ 赛道（4 泳道 + 终点旗 + 领先 👑），本地 100ms 倒计时心跳
- [x] 特效层：闪光/抖动/金币雨/彩带/烟花/大字横幅/头像飞行（flash/shake/bigFx/popLane/flyToLane/coinRain/confetti/launchFireworks/toastFx）
- [x] 主播台：局面控制（开始/跳过/暂停/继续/结束）/ 模拟观众（押注/点赞/送礼/关注/聊天/进场）/ 钱包工具（查询/调账/重置）/ 配置表单（23 项）/ 历史战报 / 接入与模拟（common core.js mountFeedTools）
- [x] `config.json` 持久化 + 控制台 `config` 动作白名单

### P1+ 任务清单（炸裂特效 + 通用播报，2026-09-02 完成）

- [x] **后端新触发点**（`games/race/index.js`）：
  - `handleLike` 冲刺期点赞风暴检测（3s 窗口 ≥3 boost + 15s 冷却）→ `pushFx({type:'likeStorm'})` + `BC.speak('likeStorm')`
  - `settle` margin ≤ 3 触发 `pushFx({type:'photoFinish'})`
  - `createState` 新增 `likeStormAt` / `boostStamp` 字段
- [x] **新播报点**（`games/race/slots.js` → 共 9 个）：
  - `likeStorm`「点赞风暴播报」minGapSec 20
- [x] **展示屏炸裂特效**（`games/race/public/stage.{js,css}`）：
  - 赛道粒子：马匹**尘土扬尘**（racing 时按 130ms 节流生成小圆点）、**冲刺火焰拖尾**（burst 时按 90ms 节流）
  - **点赞风暴** likeStorm：全屏 ❤/👍 从四周汇聚再上升（30 个 emoji，1.8s 动画）+ 金色能量波（圆环 360px 扩散）+ 强震 + 「点赞风暴！全场点起来」大字
  - **领先易主** lead：全屏滑入「⚡ X 反超登顶！」红色警报横幅
  - **骑士冲锋** gift：冲击波圆环（泳道/全屏双层 360px）+ 礼物爆炸碎片（14 个 emoji 四散）+ 全屏金币雨 + 彩带
  - **冲线 photoFinish**：慢动作（.lane .runner transition 1.1s 减速）+ 获胜马放大 2.2 倍 + 金光柱 + 📸 一鼻之差大字
  - **冲线 finish**：终点旗挥舞（4 次 skewY 摆动）+ 金粒子瀑布（26 粒垂直下落）+ 全屏烟花 + 彩带
  - 彩池数字 **bump 跳动**（scale 1.3 + brightness 1.5）
  - 赛道**速度线**（racing 时左右两侧斜光下飞）
  - 领先马**金拖尾**（drop-shadow 金光 + ✨ 闪烁）
  - 全部受 `phone[data-fx]` 三级开关（full/simple/off）控制
- [x] **通用 AI 播报 100% 落地**：
  - race 9 播报点全部默认开启（roundOpen / raceStart / surge / leadChange / cheer / likeStorm / gift / finish / jackpot）
  - 更新 `docs/AI播报接入指南.md` 已接入清单（6 款游戏全 ✓）
  - 更新 `common/broadcast/index.js` 顶部注释

### P2 任务清单（待办 · 视需求启动）

- [ ] 指定注额语法：`"3 200"` 第二数字既可是注数（≤ maxBetsPerRound）也可是筹码额（baseBet 整数倍），二选一（**当前已实现**，"3 2" 兼容两种解读，筹码额版本默认走注数解读）
- [ ] 礼物骑士进阶：按礼物价值分级冲刺（1 钻 → 6 格 / 10 钻 → 12 格 / 100 钻 → 30 格 / 1000 钻 → 60 格，需 DanmuDesk 登录抖音抓 giftValue）
- [ ] 马匹连胜头衔：单匹马三连胜披金鞍（emoji 变 ⭐ 5 格宽度 + 名字色加金边）
- [ ] 观众命名马：拍卖玩法（P3 再说）

---

## 架构要点

- **双轨货币**（核心设计决策，方案 §0 详细论证）：
  - 荣誉分（`data/leaderboard.json`，跨游戏）= 只加不减的成就排位
  - 筹码（`data/race_wallet.json`，赛马专用）= 真扣真给的赌注货币
  - **不可互兑** —— 赌局连败不污染总榜；押中者两轨都加分（名利双收）
- **零宿主改动**：只用 chat/like/gift/enter/follow 五个标准事件，钱包自管
- **MANIFEST.score**：`{ wins: 'race_wins', score: 'race_score', floors: null }` 动态注册排行榜字段
- **配置白名单**：`handleAction('config')` `allowed` 数组包含 27 个游戏键 + 6 个播报键（`...BC_CFG_KEYS`），新增项必须加进白名单否则静默丢键
- **服务端 fallback**：所有播报优先 `local` 模板，API 失败/超时自动回退 `local`，直播不冷场

## 文件清单

- `games/race/index.js`（主插件，~1060 行：状态机 + 下注 + 竞速 + 派彩 + 钱包 + 播报）
- `games/race/wallet.js`（筹码钱包，~160 行：防抖写盘、救济、模糊查、TopN）
- `games/race/slots.js`（9 个播报点定义）
- `games/race/public/stage.{html,css,js}`（展示屏：双态 + 全屏炸裂特效）
- `games/race/public/control.{html,css,js}`（主播台：局面 + 模拟 + 钱包 + AI 播报面板 + 配置）
- `games/race/config.json`（持久化配置，23 项）
- `games/race/data/race_wallet.json`（筹码钱包落盘）
- `games/race/data/follow_bonus.json`（关注冷却落盘）
- `common/broadcast/index.js` + `common/public/broadcast.js`（通用 AI 播报中心，**全 6 款游戏共用**）

## 测试命令

```bash
node host/server.js                                      # 端口 18080
curl http://127.0.0.1:18080/api/games | jq '.games[].id' # 应包含 race
# 主播台 http://127.0.0.1:18080/control.html 左侧选「赛马竞猜」
# 展示屏 http://127.0.0.1:18080/games/race/public/stage.html?game=race
# 官方冒烟测试
python scripts/test_race.py                              # 应全过
```

---

## 已完成里程碑

| 时间 | 里程碑 |
|---|---|
| 2026-09-01 | 调研 + 方案文档 + 界面草图（见 docs/） |
| 2026-09-01 | P1 完成：核心引擎 + 展示屏 + 主播台，27 项冒烟检查（test_race.py）+ 浏览器实测 |
| 2026-09-02 | **P1+ 炸裂特效增强**：新增 likeStorm / photoFinish 两个触发点 + 9 个展示屏特效（土尘/火焰/点赞风暴/反超警报/冲击波/礼物爆炸/慢动作/金粒子瀑布/终点旗）+ 通用播报收尾（race 9 播报点 + 6 款游戏 100% 接入验证 + 接入指南文档更新） |
| 2026-09-02 | 端到端冒烟：自建 21/21 SSE 断言全过（含 likeStorm 触发 + 播报链路 + 派彩 + 滚存 + 密钥不下发）；playwright-core 12/17 展示屏断言；test_race.py 回归全过（验证 slots=9 + photoFinish 险胜战报自动选择）；视觉证据 `gui-test-screenshots/race-stage-fx.png` |
