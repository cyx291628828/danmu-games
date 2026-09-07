# 红蓝大作战 · 开发计划与进度

> ✅ **全部四个阶段已完成并通过验证**（2026-08-30）。本文档保留作为开发档案；后续迭代请在「当前进度」续写。
> 方案依据：[新玩法调研与红蓝大作战方案.md](./新玩法调研与红蓝大作战方案.md) · 界面草图：[redblue-mockup.html](./redblue-mockup.html)

## 总路线（四次迭代，同一引擎）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1** | 红蓝大作战核心（组队→拔河→点赞充能冲锋→结算计分）+ 展示屏 + 控制台 | ✅ 完成 |
| **P2** | PVE 守城共斗模式（mode=tug/siege/mixed，怪物攻墙，全场合力输出） | ✅ 完成 |
| **P3** | AI 战报（结算解说：local 模板生成 + 可选 OpenAI 兼容 API） | ✅ 完成 |
| **P4** | 赛季战队（跨场次阵营归属 + 赛季功勋榜，data/redblue_season.json） | ✅ 完成 |

**最终验证**：`python scripts/test_redblue.py` 共 **33 项断言全部通过**；展示屏/控制台浏览器实测通过；干净启动注册/赛季初始化验证通过。

图例：⬜ 未开始 · 🚧 进行中 · ✅ 完成 · 🔧 已验证（含浏览器实测）

---

## 当前进度（最终版）

- **更新时间**：2026-08-30（收尾）
- **状态**：✅ P1–P4 全部完成。测试服务器已停止；测试数据已清理（排行榜 battle_* 字段剥离、假名记录删除 116→86 条、赛季存档重置为 S1 全新、config.json 还原默认节奏）。
- **下次开播前**：双击 `一键启动.bat` → 主播台选「红蓝大作战」→ 开始一轮；展示屏地址 `/games/redblue/public/stage.html?game=redblue`
- **AI 战报接 API**（可选）：控制台「AI 战报」区选「AI 接口生成」，填 OpenAI 兼容接口地址 + 密钥 + 模型；不填则用本地模板（默认，离线可用）
- **礼物召唤**（可选）：需 DanmuDesk 登录抖音（收到 gift 消息），并在控制台勾选「礼物召唤」
- **已知边界**：
  - 单条点赞事件计入上限 `likeCapPerEvent`(30)，防批量点赞瞬间充满能量
  - 暂停中点「开始一轮」= 安全重开新局（丢弃暂停簿记）
  - `aiApiKey` 只存服务端（config.json），SSE 状态流不下发
  - 新赛季归档文件 `data/redblue_season_s<N>.json` 保留历史，可人工查阅

### P2 任务清单（完成）

- [x] 守城状态机：monster(hp/atk) + wall(hp)，status='sieging'，monster 攻城定时链
- [x] 任意弹幕=攻击1（无队色自动补进人少一队，守军合力保留队籍）、点赞=全场能量、充满=全力一击
- [x] mixed 模式：每 siegeEveryRounds 轮拔河插 1 轮守城（roundNo % (N+1) == 0，实测 3+1 循环）
- [x] 守城结算（成功=参战分+胜场+MVP；失败=安慰分不计胜场）+ 展示屏守城 UI（怪物血条/城墙耐久告警/全场能量）
- [x] 控制台守城参数表单 + 模式切换 + 自测（斩杀/破墙两路径）

### P3 任务清单（完成）

- [x] `games/redblue/report.js`：local 模板生成器（碾压/险胜/冲锋决胜/平局/守城成功·绝境/破墙/超时 8+ 场景，随机变体）
- [x] 可选 API 生成：aiReport='off'|'local'|'api'，aiApiUrl/aiApiKey/aiModel（OpenAI 兼容 /chat/completions，超时可配，失败自动回退 local，实测端口不通场景）
- [x] 结算后异步生成 → result.report + 展示屏结算横幅解说卡 + 战报流 🎙️ 条目；密钥不下发前端（只回传 aiKeyConfigured 布尔）

### P4 任务清单（完成）

- [x] `games/redblue/season.js` + `data/redblue_season.json`：seasonNo + members(队籍/功勋) 实时聚合战队总分
- [x] 入队即入伍（幂等，转队跟随）；每轮结算累计 rounds/wins/pulls/likes/score/mvp
- [x] 动作：newSeason（旧季归档 data/redblue_season_s<N>.json，名册清零）
- [x] 展示屏：S 赛季徽章 + 第三列「赛季功勋」榜；控制台：赛季战队卡片（双队功勋/名册人数）+ 开启新赛季按钮

### P1 任务清单（全部完成）

- [x] `games/redblue/index.js` 游戏模块（状态机/弹幕/点赞/计分/控制动作）
- [x] `games/redblue/public/stage.html + stage.css + stage.js`（9:16 展示屏）
- [x] `games/redblue/public/control.html + control.js`（主播控制台）
- [x] `common/leaderboard.js` 增加 `awardScore()`（只加分不加胜场，供败方参与奖/MVP 加成）
- [x] `host/server.js` 放行 `gift`/`enter` 事件给实现了对应 handler 的游戏
- [x] 重启注册验证：`/api/games` 出现 redblue
- [x] 模拟对局冒烟测试（`python scripts/test_redblue.py 18090`，21 项全过）
- [x] 浏览器实测展示屏 + 控制台（战线/能量/冲锋/结算横幅/连胜徽章均正常）
- [x] 更新主 README（已内置游戏列表、接口地址、配置项）

---

## 关键技术事实（续做必读，已核实）

### 宿主插件契约（参照 games/quiz/index.js）

- 扫描 `games/*/index.js`，导出：`MANIFEST / CFG_DEFAULTS / CONFIG_SCHEMA / createState / handleDanmu / handleAction / publicState / clearGameTimers`，可选 `handleLike(ctx,msg)`
- `ctx = { meta, game, state, cfg, lb, gameDir, engine, log(level,...), emit:{state(),guess(entry),notice(text)}, setTimer(group,fn,ms), clearTimers(group?), persistConfig(cfg), topList(n), award(entry,score,floors) }`
- `ctx.award(gameId 由宿主注入)` **每次调用都会 wins+1 并加分**（common/leaderboard.js `award()`）→ 败方参与奖、MVP 加分必须用新增的 `awardScore()`（不加胜场）
- SSE 事件：`state`（publicState 全量）、`guess`（增量条目，如战报流）、`notice`（toast）；前端用 `DG.connectSSE(game,{onState,onGuess,onNotice})`
- 弹幕消息：`{event:'chat',text,user:{id,displayId,name,avatar},roomId,msgId,ts}`；点赞：`{event:'like',user,likeCount,likeTotal,roomId}`（likeCount 为增量条数，缺省按 1 处理）；gift：`{giftName,giftCount,repeatCount}`
- 配置持久化：`games/redblue/config.json`（宿主启动合并 CFG_DEFAULTS，控制台 config 动作写盘）
- MANIFEST.score 注册排行榜字段：计划 `{ wins:'battle_wins', score:'battle_score', floors:null }`
- 静态路由：`/games/redblue/public/*`；主播台 iframe 嵌 control.html；展示屏 `?game=redblue`
- 房间过滤、限流模式照抄 quiz（allowedRoomId / rateLimitSec + Map 时间戳）

### 游戏设计定案（Phase 1 拔河）

- 状态机：`idle → joining(joinSec) → tugging(tugSec) → revealed(resultShowSec) → 自动下一轮`
- 坐标系：`pos ∈ [0,100]`，0=红方底线，100=蓝方底线；红弹幕 +1、蓝弹幕 -1（均乘阵营系数/背水系数）；`pos ≥ winLine(90)` 红胜，`≤ 100-winLine` 蓝胜，超时按 pos>50/<50 判定（=50 平局全队参与奖）
- 点赞充能：队内成员 likeCount/likesPerEnergy(3)=能量；≥surgeThreshold(50) → 冲锋：pos ± surgePush(12)、能量清零、hot 战报；点赞计入个人贡献
- 计分：胜方全员 winScore(80)+battle_wins；败方 loseScore(20) 不计胜场；胜队贡献 Top3 额外 MVP 分（200/150/100，awardScore）
- 背水一战：落后 ≥ backwaterGap(12) 格一方拉动 ×backwaterMult(1.3)（可关）；主播微调 redMult/blueMult
- 高频事件节流：点赞用脏标记 + 定时 emit（≤800ms 一次），避免 SSE 风暴

### 测试命令（Phase 1 完成后验证）

```bash
node host/server.js                     # 端口 18080
curl http://127.0.0.1:18080/api/games   # 应出现 redblood → 实际 id 为 redblue
# 控制台 http://127.0.0.1:18080/control.html 左侧选「红蓝大作战」→ 开始一轮
# 展示屏 http://127.0.0.1:18080/games/redblue/public/stage.html?game=redblue
curl -X POST http://127.0.0.1:18080/api/control -H "Content-Type: application/json" \
  -d '{"action":"simulateDanmu","game":"redblue","name":"测试观众","text":"红"}'
curl -X POST http://127.0.0.1:18080/api/control -H "Content-Type: application/json" \
  -d '{"action":"simulateLike","game":"redblue","name":"测试观众","count":10}'
```

## 已完成里程碑

| 时间 | 里程碑 |
|---|---|
| 2026-08-30 | 调研 + 方案文档 + 界面草图（见 docs/） |
| 2026-08-30 | P1 完成：核心引擎 + 展示屏 + 控制台，21 项冒烟检查 + 浏览器实测 |
| 2026-08-30 | P2 完成：PVE 守城模式（斩杀/破墙/混合 3+1 调度），守城 UI 实测 |
| 2026-08-30 | P3 完成：AI 战报（local 8+ 场景模板 + OpenAI 兼容 API 回退），密钥不出服务端 |
| 2026-08-30 | P4 完成：赛季战队（跨场次功勋、归档、展示屏第三榜），33 项全量回归通过 |
| 2026-08-30 | 收尾：测试数据清理、赛季重置 S1、README 更新、干净启动验证 |
| 2026-08-30 | **体验修复轮**（用户实测反馈 4 项）：① 倒计时进度条改本地 500ms 心跳刷新（不再依赖 SSE）；② 战报流改为最新置顶（原先最新消息被 overflow 裁掉）；③ 拔河战场视觉重做——麻绳纹理随战线滑动、两端拉绳队员、胜负线画进轨道并告警、拉动/冲锋有飘字+方向箭头+绳结弹跳+画面震动、冲锋/全力一击有全屏横幅（服务端 feed 事件带 type 数据驱动）；④ 控制台状态条本地 1 秒心跳刷新。修复后 33 项回归全过。**注意：拉动/冲锋特效需要重启宿主服务**（feed 事件新增 type 字段），其余修复刷新页面即生效 |
| 2026-08-30 | **特效驱动重构（反馈「没看到全军冲锋」）**：事件 type 字段依赖未重启服务即无特效 → 改为**展示屏状态差分驱动**（对比每次渲染的战线位移/冲锋次数/怪物与城墙血量），**旧后端不重启也生效**；冲锋横幅升级为全屏 1.6s（队色辉光+文字缩放弹出）；新增 `?fxslow` 调试参数（特效放慢 5 倍，便于主播预览与排查）。33 项回归再次全过 |
| 2026-09-01 | 新增两份文档：[弹幕游戏调研报告](./弹幕游戏调研报告.md)（两轮调研整合）与 [后续开发方向分析](./后续开发方向分析.md)（五款游戏组合诊断 + 六大方向路线图） |
