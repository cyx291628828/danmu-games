# 配置说明

> 本文档是各配置文件的权威说明。**任何配置项的新增/删除/改名/语义变更，都必须同步修改本文档**，并在文末「变更记录」追加一条。

v2.0 起配置拆为三层：

| 文件 | 作用 |
|------|------|
| `host/host.json` | 宿主框架配置（端口、监听地址、当前激活游戏 activeGame，由框架自动写入） |
| `games/guess/config.json` | 猜数字游戏配置（本文一～五节字段） |
| `games/chengyu/config.json` | 成语接龙游戏配置（本文第六节字段） |
| `games/sudoku/config.json` | 弹幕数独游戏配置（本文第八节字段） |

配置来源优先级：`games/<id>/config.json` → 环境变量（`PORT` / `HOST`）→ 代码默认值（`games/<id>/index.js` 的 `CFG_DEFAULTS`）。
各游戏控制台「应用配置」会实时改运行时配置，并写回对应 `config.json`。

---

## 一、服务与端口（host/host.json）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `port` | number | `18080` | HTTP + WebSocket 服务监听端口。环境变量 `PORT` 可覆盖 |
| `host` | string | `"0.0.0.0"` | 监听地址。`0.0.0.0` 表示局域网设备也能访问（便于投屏/OBS）；仅本机用可改 `127.0.0.1`。环境变量 `HOST` 可覆盖 |
| `activeGame` | string | 自动 | 当前激活游戏 id（弹幕默认分发给它）。由主播台切换时自动写入，勿手动改 |

---

## 二、猜数字 · 轮次节奏（games/guess/config.json）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `roundIntervalSec` | number | `120` | 每轮竞猜时长（秒）。倒计时归零仍无人猜中则自动揭晓。环境变量 `ROUND_SEC` 可覆盖 |
| `resultShowSec` | number | `10` | 揭晓后停留展示时长（秒），停留结束自动开下一轮（若 `autoNextRound` 为 true） |
| `autoNextRound` | boolean | `true` | 揭晓后是否自动开下一轮。`false` 则需主播手动点「开始一轮」 |

---

## 三、猜数字 · 猜测规则

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `guessPattern` | string | `"loose"` | 弹幕匹配模式：`"loose"` 宽松（纯 `1234` 或带前缀 `猜1234`/`#1234` 都算）；`"strict"` 严格（只认带前缀） |
| `rateLimitSec` | number | `2` | 同一玩家两次猜测的最小间隔（秒），防刷屏；主播台「发送间隔(秒)」可实时调 |
| `maxGuessesPerUserPerRound` | number | `20` | 同一玩家每轮猜测次数上限 |
| `baseScorePerWin` | number | `100` | 猜中基础分。实际得分 = 基础分 × (1 + 剩余时间/轮长)，越早猜中越高，开题瞬间满分约 2 倍、压哨约 1 倍 |
| `digitCount` | number | `4` | 答案位数：`4` = 标准难度（4 位不重复数字 + 4 条线索）；`3` = 简单难度（3 位不重复数字 + 3 条线索）。改动后 `answerRevealSec` 数组自动截断/扩展到对应位数 |

---

## 四、猜数字 · 答案数字逐位揭示（核心规则）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `answerRevealSec` | number[] | `[0, 25, 50, 75]` | **答案各位数字各自的出现时间**，数组按第 1～N 位顺序对应（N = `digitCount`）。每个元素的取值：<br>· `0` = 开局立即出现该位<br>· 正整数 `N` = 开题后第 `N` 秒出现该位<br>· `-1` = 该位永不自动出现，直到最终揭晓才显示 |

示例：`[100, 120, 140, -1]` 表示第 1 位 100 秒出现、第 2 位 120 秒、第 3 位 140 秒、第 4 位不出现。3 位玩法时数组只需 3 个元素（超出部分自动忽略）。

其他与「线索」相关说明：

- **线索条数 = 位数**（4 位 → 4 条，3 位 → 3 条），每条线索（谜面数字 + 几对几错提示）固定一次性全部显示，不随时间变化。
- 答案数字逐位「翻牌」展示在展示屏的 N 格方框中：已揭晓位填数字（金色高亮），未揭晓位显示 `?`。

---

## 五、猜数字 · 历史遗留字段（已废弃，保留仅为兼容旧配置）

> 以下字段当前**不参与任何逻辑**，改动无效果。早期版本用「单首延迟 + 固定间隔」渐进揭示线索，后被 `answerRevealSec` 取代。

| 字段 | 类型 | 当前值 | 说明 |
|------|------|--------|------|
| `clueDelaySec` | number | `0` | 旧版「首条线索延迟」，已废弃 |
| `clueIntervalSec` | number | `25` | 旧版「线索间隔」，已废弃 |
| `clueMaxCount` | number | `4` | 旧版「最多提示条数」，已被 `digitCount` 接管，实际无影响 |

---

## 六、成语接龙（games/chengyu/config.json）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `pendingSec` | number | `20` | 接龙等待时间（秒），超时无人接上则中断并重开 |
| `autoNext` | boolean | `true` | 中断后是否自动随机新词开新轮 |
| `baseScore` | number | `100` | 接对基础分（每层得分随层数衰减，详见游戏内实现） |
| `rateLimitSec` | number | `2` | 同一观众两次发言的最小间隔（秒） |
| `dictFilter` | boolean | `true` | 是否校验「为真成语」（`false` = 仅校验连接关系 + 4 字长度） |
| `allowRepeat` | boolean | `false` | 是否允许同一成语重复使用 |
| `startMode` | string | `"random"` | 起始词方式：`random` 随机 / `manual` 手动指定 |
| `manualWord` | string | `"一马当先"` | `startMode=manual` 时使用的起始词 |
| `allowedRoomId` | string | `""` | 弹幕房间白名单。空 = 接收所有房间；填了则只接收该 roomId |

---

## 七、其他（猜数字）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `answerLeadingZero` | boolean | `false` | 答案是否允许首位为 0（如 `0 1 2 3`）。`true` 允许 |
| `allowedRoomId` | string | `""` | 弹幕房间白名单。空字符串 = 接收所有房间的弹幕；填了则只接收该 roomId 的消息 |
| `displayMode` | string | `"stage"` | 展示模式。当前固定为 `stage`，暂未实现其他模式 |

---

## 八、弹幕数独（games/sudoku/config.json）

> 数独由「随机终盘 + 随机挖洞（每挖一格校验唯一解）」生成，保证任意时刻观众可推理填空。
> 盘面左侧为字母行号 A-I、顶部为数字列号 1-9，观众弹幕发「行×列×数」抢填（如 `A33` = A行3列填3，
> 宽松模式兼容 `3行5列7` / `357` 等数字写法）；单人点赞累计满 N → 随机填 1 个正确数；
> 送礼 → 随机连填 m 个正确数；系统每隔 autoFillSec 秒自动落 1 个正确数防冷场。
> 填对 1 格 +scorePerFill 分并在格子上留头像角标；结算面板展示本局 Top5（第一名标 MVP，每人显示填对数与错填数）；
> 通关时 MVP 额外 +mvpBonus 并计 1 胜。展示屏右栏为<b>数独专属榜</b>：按 MVP 次数（sudoku_wins，通关 MVP 计 1 次）
> 降序排序，同次数按数独总积分（sudoku_score）排序，两列分别显示 👑MVP 次数与积分。

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `roundSec` | number | `480` | 每局时长（秒）。倒计时归零仍未填满则结算（已填格积分保留） |
| `resultShowSec` | number | `12` | 结算横幅停留时长（秒），停留结束自动开下一局（若 `autoNextRound` 为 true） |
| `autoNextRound` | boolean | `true` | 结算后是否自动开新一局。`false` 则需主播手动点「开新一局」 |
| `difficulty` | string | `"normal"` | 难度（决定挖洞空格数）：`easy` 简单 32 空格 / `normal` 中等 45 / `hard` 困难 56。改动在「开新一局」时生效 |
| `scorePerFill` | number | `10` | 每填对 1 格得分 x（弹幕/点赞/礼物填格均按此计分） |
| `rateLimitSec` | number | `2` | 同一观众两次弹幕填数的最小间隔（秒），防刷屏 |
| `maxFillsPerUserPerRound` | number | `20` | 同一观众每局弹幕填对次数上限（0 = 不限） |
| `likeThreshold` | number | `30` | 单人点赞累计阈值 N：该观众累计点赞满 N 次自动随机填 1 个正确数并记在其名下计分。触发后累计值扣减 N，余量可再次累积触发 |
| `giftFillCount` | number | `3` | 送礼触发的随机连填格数 m（每次礼物事件触发一次，间隔 450ms 逐格落定，全部记在送礼观众名下） |
| `autoFillSec` | number | `60` | 系统自动填数间隔（秒）：每隔 N 秒自动落 1 个正确数，不记分（展示屏日志标记 ⚙️）。`0` = 关闭 |
| `wrongFillPenalty` | number | `0` | 错填惩罚：填错的数不落格仅红闪+日志；此值 > 0 时每次错填额外扣该观众全局积分 |
| `fillPattern` | string | `"loose"` | 弹幕匹配模式：`"loose"` 宽松（`A33` 或 `3行5列7` / `357` 都算）；`"strict"` 严格（仅认 `A33` 字母行写法，与盘面行标一致） |
| `avatarCorner` | string | `"right-top"` | 填对格子上的观众头像角标位置：`right-top` 右上角 / `left-top` 左上角 |
| `mvpBonus` | number | `50` | 通关 MVP（本局填对最多者）额外加分，并计 1 次胜场（全局排行榜） |
| `allowedRoomId` | string | `""` | 弹幕房间白名单。空 = 接收所有房间；填了则只接收该 roomId 的消息 |

---

## 九、弹幕五子棋（games/gomoku/config.json）

> 观众弹幕发「排队 / 排黑 / 排白」进入等候队列（双人对决为黑/白两条独立队列，人机对决为单队列）；
> 排队观众的点赞按 `likePerPoint` 换算实时累计为排序值（默认 1 赞 = 1 分，即需求要求的 1:1），
> 送礼按件数 × `giftSortBonus` 额外加分，队列随时按排序值重排；
> 当前局结束后各队列排名第一的观众上座，获得弹幕落子权（弹幕发坐标，如 `H8`）；
> 上座观众送礼可悔棋（撤回自己上一手及之后所有落子，轮次回给自己）；
> 双人对决胜/败得分可配写入全局共享排行榜；人机对决击败对应等级机器人可解锁等级徽章（排行榜名后显示）。

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `mode` | string | `"pve"` | 对局模式：`pve` 人机对决（观众执黑 vs 机器人）/ `pvp` 双人对决（黑/白双队列各取第一名上座）。**双人对决必须两侧各有一位观众才开局**，缺任一侧进入「等待上座」（展示屏/主播台提示还差哪一侧），到齐后自动开局，且**永远不会有机器人替补**。改动下一局生效 |
| `botLevel` | number | `5` | 人机等级 1-10：1 随机洗子 → 2-4 常识级（能成五先成五、3 级起必堵对手成五、逐步降噪）→ 5-10 α-β 搜索级（迭代加深 + Zobrist 置换表 + VCF 连续冲四杀棋检测；棋圣单手搜索约 0.9s，全程时限 ≤1s 不阻塞宿主） |
| `forbidden` | boolean | `true` | 连珠禁手规则：黑方 三三 / 四四 / 长连 为禁手（落子被拒且轮次不变），黑五连须恰好五子；白方无禁手长连也算胜。`false` = 自由规则（≥5 连即胜） |
| `boardSize` | number | `15` | 棋盘路数：`13` / `15` / `19`。改动下一局生效（本局坐标始终按当前对局路数解析） |
| `moveTimeSec` | number | `45` | 观众每手限时（秒）。超时系统按「中级」棋力托管落子保证对局不冷场。`0` = 不限时 |
| `autoMoveLevel` | number | `4` | 超时托管与主播台「托管一手」按钮使用的 AI 等级（1-10）。只影响托管落子，不影响机器人正常应手的 `botLevel` |
| `botThinkSec` | number | `3` | 机器人每手「思考」展示时长（秒，带随机抖动）。`0` = 秒回 |
| `resultShowSec` | number | `15` | 结算横幅停留时长（秒），停留结束自动开下一局（若 `autoNextRound` 为 true） |
| `autoNextRound` | boolean | `true` | 结算后自动开局取队列第一；队列无人时进入「等待上座」，有人排队即自动开局。`false` 则需主播手动开局 |
| `rateLimitSec` | number | `1` | 同一观众两次落子弹幕的最小间隔（秒） |
| `likePerPoint` | number | `1` | 点赞→排序值换算：1 次点赞 = N 分（默认 1，即 1:1）。仅排队中的观众计 |
| `likeCapPerEvent` | number | `0` | 单条点赞消息最多计入的次数（防止批量点赞瞬间暴涨）。`0` = 不限制 |
| `giftSortBonus` | number | `30` | 每件礼物为排队观众额外增加的排序值（计件 = giftCount × repeatCount，受 `giftPieceCap` 限制） |
| `giftPieceCap` | number | `10` | 单次礼物事件的计件上限 |
| `queueCap` | number | `100` | 每条等候队列人数上限（满员时新观众提示稍后再排） |
| `giftUndoEnabled` | boolean | `true` | 上座观众送礼悔棋开关 |
| `giftUndoPerGift` | number | `1` | 每次礼物可连续悔棋手数（1-3；1 次悔棋 = 撤回自己上一手及其后落子，通常 1-2 手） |
| `undoMaxPerGame` | number | `0` | 每人每局悔棋次数上限。`0` = 不限 |
| `pvpWinScore` | number | `100` | 双人对决胜方得分（计入排行榜 `gomoku_score` 并 +1 胜场 `gomoku_wins`） |
| `pvpLoseScore` | number | `20` | 双人对决败方参与奖（不计胜场；平局双方均得此项） |
| `pveWinScore` | number | `100` | 人机对决观众获胜得分（+1 胜场；同时解锁本局机器人等级徽章，存排行榜记录 `gomoku_badge`，只升不降） |
| `pveLoseScore` | number | `0` | 人机对决观众落败得分（不计胜场） |
| `enterHint` | boolean | `true` | 观众进场时播报引导排队 |
| `allowedRoomId` | string | `""` | 弹幕房间白名单。空 = 接收所有房间；填了则只接收该 roomId 的消息 |

---

## 变更记录

| 日期 | 变更 | 说明 |
|------|------|------|
| 2026-09-06 | **排行榜改为各游戏专属榜（互不混排）** | `ctx.topList()` 改为返回本游戏榜（`SharedLeaderboard.gameTopList`）：仅含玩过该游戏的玩家，按该游戏自己的字段排序（wins 胜场/MVP 次数 → 该玩法积分 → floors），得分列显示该玩法积分；数据仍存 `data/leaderboard.json`（按玩法分字段），但各游戏榜单只读写自己的字段、互相不可见。全部 8 个游戏自动生效，展示屏外观零改动 |
| 2026-09-06 | 数独行号改字母 A-I，弹幕支持 `A33`（A行3列填3）；结算面板改 Top5 榜单；排行榜改按 MVP 次数排序 | 盘面左侧行标 A-I / 列标 1-9；`fillPattern=strict` 仅认字母行写法，宽松兼容数字写法；结算展示最多 5 人（第一名 👑 MVP），每人显示填对数与错填数（服务端新增按人错填累计）；展示屏右栏改为数独专属榜：按 MVP 次数（sudoku_wins）排序、显示 MVP 次数 + 数独总积分（sudoku_score） |
| 2026-09-02 | **新增第九节：弹幕五子棋（games/gomoku）** | 第七个游戏上线：排队上座（点赞 1:1 + 送礼加分排序号）+ 坐标弹幕落子 + 双人/人机模式（机器人 10 级，α-β + VCF + 置换表）+ 连珠禁手可配 + 送礼悔棋 + 双人胜/败可配计分 + 人机等级徽章；自测 `node games/gomoku/engine.js --selftest` / `node scripts/test_gomoku.js` / `node scripts/test_gomoku_http.js` |
| 2026-08-28 | **v2.0 结构重组**：配置拆分为 `host/host.json`（port/host/activeGame）+ `games/<id>/config.json` | 原 `config.json` 的猜数字字段整体迁至 `games/guess/config.json`；新增成语接龙配置节（第六节）；排行榜迁至 `data/leaderboard.json` |
| 2026-08-26 | 新增 `digitCount`（3/4），答案位数可配置 | 3 = 简单（3 位数字 + 3 条线索），4 = 标准（4 位数字 + 4 条线索，默认）。确认采用「3 位配 3 条线索」方案（实测 2/3/4 条线索唯一性生成成功率均 100%，取与位数对称的 N 条）。主播台新增「答案位数」下拉，`answerRevealSec` 自动截断 |
| 2026-08-25 | 新增 `answerRevealSec` | 4 位答案数字各自独立出现时间（0/正整数/-1），取代旧 `clueDelaySec`/`clueIntervalSec` 的「首延迟+固定间隔」机制 |
| 2026-08-25 | 废弃 `clueDelaySec` / `clueIntervalSec` / `clueMaxCount` | 迁移到 `answerRevealSec`，旧字段仅保留兼容 |
| 2026-08-25 | `rateLimitSec` 默认值 10 → 2，并在主播台新增「发送间隔(秒)」输入框 | 直播间竞猜节奏快，间隔 10s 过慢，改为默认 2s 且主播台可实时调 |
