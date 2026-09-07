# 弹幕互动游戏中心（danmu-games）

接收 **DanmuDesk** 转发的抖音直播间弹幕，运行多款弹幕互动游戏（插件式，新增游戏零改框架）。

主播台 = 框架壳（左侧游戏导航 + 弹幕栏），右侧 iframe 加载各游戏自己的控制台页面。

已内置游戏：

- **猜数字**（`games/guess/`）：每轮隐藏 N 位不重复数字答案（默认 4 位，可切 3 位简单模式），公布 N 条线索（谜面数字 + 提示），观众弹幕竞猜，猜中立即结束本轮并全屏宣布获胜者。规则细节见下方「玩法规则」。
- **成语接龙**（`games/chengyu/`）：观众弹幕接成语，逐字校验 + 拼音提示，链不断则层数累加，全部记录在全局排行榜。
- **谐音梗猜词**（`games/xieyin/`）：每轮出一张双格卡片——上格只报物件名（"这是羊"），下格同一物件＋动作/数量/材质/表情变化（"这是____"），观众看图拼出谐音/画谜/文字谜答案（如 羊+蜜=杨幂、金子作秀=锦绣），弹幕直接发答案，首个答对得分（越早越高），答对立即揭示并自动下一题；类别可选（成语/歇后语/明星/古代人物/物品/词语），谜面为 OpenMoji 素材+代码绘制图层，支持 `custom_xieyin.json` 自定义加题。
- **答题竞猜**（`games/quiz/`）：主播出题（题库/手动），弹幕选 A/B/C/D，全员答对同赢或抢答首中得分。
- **红蓝大作战**（`games/redblue/`）：① **弹幕枪战（默认模式）**：双方观众头像为枪手，弹幕=发射子弹、点赞=子弹加速、送礼=金色强力子弹，子弹按血量互相抵消/命中扣血，先清零者输（HP+子弹全程服务端权威模拟，100ms 节拍）；② **拔河**：弹幕发「红/蓝」入队并推动战线，**点赞为队伍充能**，能量满触发「全军冲锋」；③ **PVE 守城**：怪物攻城，全体任意弹幕输出、点赞充能「全力一击」，守住城墙全员得分；④ **AI 战报**：每轮结算自动生成解说（本地模板 / 可选 OpenAI 兼容接口）；⑤ **赛季战队**：入队即入伍，功勋跨场次累计，支持开启新赛季归档。背水一战自动平衡、枪战 HP 可配，胜方全员计分、贡献 Top3 加 MVP 分。方案与开发档案见 `docs/`。
- **弹幕五子棋**（`games/gomoku/`）：观众发「排队 / 排黑 / 排白」进等候队列，**点赞 1:1 转排序值、送礼按件加分**，当前局结束队首上座获得落子权（弹幕发坐标如 `H8`）；支持**双人对决**（双队列各取第一）/ **人机对决**（机器人 10 级可选，高级为 α-β 搜索 + VCF 杀棋检测）；**连珠禁手可配**；上座观众**送礼悔棋**；双人胜/败得分可配写入全局榜，击败人机解锁**等级徽章**显示在排行榜名字后。详见 `docs/gomoku-方案.md`。

## 玩法规则（猜数字）

- **题目**：每轮生成一个 N 位不重复数字答案（默认首位非 0），N = `digitCount`（`4` 标准 / `3` 简单）
- **线索**：N 条线索同时公布，每条 = 一个 N 位谜面数字 + 提示文案
  - "X 个数字正确" = 谜面中有 X 个数字出现在答案中（位置不论）
  - "Y 个位置正确" = 其中 Y 个不仅数字对、位置也对
  - 例：`1 4 5 6 → 2 个数字正确，1 个位置正确`（数学等价 1A1B）
- **唯一性保证**：生成题目时暴力枚举全部候选数（4 位 5040 / 3 位 720 个），仅当"同时满足全部线索的候选数恰有 1 个"时采题，否则重新生成 —— 全部线索（N 条）能推出且只能推出唯一答案
- **竞猜**：观众发弹幕 `1234` 或 `猜 1234` / `#1234`（3 位模式为 `123` / `猜 123`；严格模式只认带前缀）
  - 完全猜中 → 立即结束本轮、大横幅宣布获胜者并公布答案
  - 未猜中 → 记录猜测与实时反馈，滚动展示（主播可直接念反馈）
  - 限频：同一玩家默认每 2 秒 1 次、每轮每人最多 20 次
- **计分（线性加成）**：猜中得 `baseScorePerWin × (1 + 剩余时间占比)` 分
  - 开题瞬间猜中 = 2 倍（如 200 分），压哨猜中 = 1 倍（100 分），越早越高
- **排行榜**：全局共享榜跨游戏落盘 `data/leaderboard.json`，各游戏写入自己的计分字段（如 `guess_wins/guess_score`、`chengyu_wins/chengyu_score/chengyu_floors`），总分 = 各游戏得分之和，同分按猜中次数排；前三名金银铜区分固定展示，其余玩家静态平铺（最多 50 人，装不下自动裁剪）

## 快速开始

1. 双击 `一键启动.bat`（或 `node host/server.js`）
2. 打开 DanmuDesk → 底部工具栏「转发」填入
   `ws://127.0.0.1:18080/danmu` → 勾选「启用转发」
3. 浏览器打开 **主播台** `http://127.0.0.1:18080/control.html`
   → 左侧选择游戏 → 点击「开始一轮」
4. 投屏 / OBS 浏览器源使用 **展示屏**（每个游戏独立地址，主播台顶部有直达链接）

> DanmuDesk 多直播间同时转发时，消息按 roomId 直接采用（本服务不区分房间，可在各游戏控制台里按房间过滤）。

## 界面

| 视图 | 地址 | 说明 |
|---|---|---|
| 主播台（框架壳） | `/control.html` | 左侧游戏导航（运行状态绿点）+ 弹幕栏，右侧 iframe 嵌各游戏控制台 |
| 猜数字控制台 | `/games/guess/public/control.html` | 通用操作 / 动态配置表单 / 模拟观众 / 揭晓历史 |
| 成语接龙控制台 | `/games/chengyu/public/control.html` | 接龙链 / 配置 / 换起始词 / 历史记录 |
| 谐音梗猜词控制台 | `/games/xieyin/public/control.html` | 开局/下一题/揭示答案 / 出题类别筛选 / 配置 / 最近答题 |
| 猜数字展示屏 | `/games/guess/public/stage.html` | 9:16 竖屏投屏：倒计时/进度条/待填格/线索/猜测流/排行榜/结算烟花 |
| 成语接龙展示屏 | `/games/chengyu/public/stage.html` | 9:16 竖屏：成语塔/目标字/接龙弹幕流/排行榜 |
| 谐音梗猜词展示屏 | `/games/xieyin/public/stage.html` | 9:16 竖屏：双格谜题卡/倒计时/空格槽/获胜横幅+烟花/双榜单 |
| 答题竞猜控制台/展示屏 | `/games/quiz/public/control.html` · `stage.html` | 题目/选项票数/排行榜/结算 |
| 红蓝大作战控制台 | `/games/redblue/public/control.html` | 运行控制/阵营名/推力系数滑杆/点赞充能与冲锋参数/模拟观众/战报历史 |
| 红蓝大作战展示屏 | `/games/redblue/public/stage.html` | 9:16 竖屏：阵营人数/战线绳/能量槽/战报流/贡献榜/结算烟花 |
| 五子棋控制台 | `/games/gomoku/public/control.html` | 模式与机器人等级/禁手与棋盘/等候队列管理/小盘预览/送礼悔棋开关/模拟观众 |
| 五子棋展示屏 | `/games/gomoku/public/stage.html` | 9:16 竖屏：木质棋盘+坐标/双方座位卡/双列等候队列（排序值）/战报流/排行榜（含人机徽章） |
| 旧入口兼容 | `/stage.html`、`/stage-chengyu.html`、`/?view=stage|control` | 302 重定向到新地址 |

## 项目结构

```
danmu-games/
├── host/                       # 主播台框架（不含任何游戏逻辑）
│   ├── server.js               # 宿主：游戏注册表扫描 + WS弹幕分发 + SSE + HTTP路由
│   ├── host.json               # 宿主级配置（端口、监听地址、当前激活游戏）
│   └── public/                 # 框架壳前端（control.html + 左导航 + iframe）
├── common/                     # 公共模块（框架与游戏共享）
│   ├── leaderboard.js          # 全局共享排行榜（动态字段注册 + 旧记录迁移）
│   ├── logger.js               # 日志
│   └── public/
│       ├── base.css            # 主题变量/手机框/榜单/胜利横幅/烟花/控制台控件
│       └── core.js             # 前端公共库 window.DG（SSE 连接/头像/toast/烟花等）
├── games/                      # 每个子目录一个游戏，自包含（新增即自动注册）
│   ├── guess/                  # 猜数字
│   │   ├── index.js            # 游戏模块（统一插件接口，见下）
│   │   ├── engine.js           # 出题引擎
│   │   ├── config.json         # 本游戏配置（控制台实时改）
│   │   └── public/             # 本游戏前端（control.html / stage.html）
│   └── chengyu/                # 成语接龙（同构）
│       ├── chengyu_dict.js     # 成语词库
│       ├── custom_chengyu.json # 自定义补充成语
│       └── public/
├── games/redblue/              # 红蓝大作战（拔河 + PVE守城 + AI战报 + 赛季战队）
│   ├── index.js                # 游戏模块（统一插件接口 + handleLike/Gift/Enter）
│   ├── report.js               # AI 战报生成器（local 模板 / OpenAI 兼容 API）
│   ├── season.js               # 赛季战队名册（跨场次功勋，data/redblue_season.json）
│   ├── config.json             # 本游戏配置（控制台实时改）
│   └── public/                 # control.html / stage.html（9:16 战线+守城双视图）
├── games/gomoku/               # 弹幕五子棋（排队上座 + 坐标落子 + 双人/人机 + 禁手）
│   ├── index.js                # 游戏模块（队列/座位/回合/悔棋/计分 + handleLike/Gift/Enter）
│   ├── engine.js               # 规则引擎：坐标/连珠禁手/AI（α-β + VCF + 置换表，10 级）
│   ├── slots.js                # AI 播报点（上座/开局/悔棋/结算）
│   ├── config.json             # 本游戏配置（控制台实时改）
│   └── public/                 # control.html / stage.html（9:16 棋盘 + 双列队列）
├── docs/                       # 方案、调研、开发进度档案、界面草图
├── data/
│   └── leaderboard.json        # 全局排行榜（跨游戏共享）
├── scripts/
│   ├── simulate.js             # 模拟 DanmuDesk 发包（联调/演示）
│   ├── gen_chengyu_dict.cjs    # 成语词库生成器
│   └── verify_uniqueness.cjs    # 猜数字引擎唯一性验证
├── 一键启动.bat
└── log/                         # 运行日志（自动生成）
```

## 新增一个游戏（扩展指南）

1. 新建 `games/<id>/` 目录，拷贝 `games/guess/` 作模板
2. `index.js` 实现统一插件接口：
   - `MANIFEST`：`{ id, name, icon, desc, liveStatuses, score }`
     - `liveStatuses`：哪些 status 视为「运行中」（主播台导航绿点）
     - `score: { wins, score, floors }`：排行榜计分字段注册（值为 data/leaderboard.json 字段名，`null` 表示无该项）
   - `CFG_DEFAULTS` / `CONFIG_SCHEMA`：本游戏配置默认值与表单 schema
   - `createState()`：初始化该游戏状态
   - `handleDanmu(ctx, msg)`：弹幕处理
   - `handleAction(ctx, action, payload)`：控制指令（start/stop/config…）
   - `publicState(ctx)`：随 SSE 下发的精简状态
3. `public/` 放本游戏前端：`control.html`（主播控制台，被框架 iframe 嵌入）+ `stage.html`（展示屏），公共样式/工具用 `/common/base.css` 与 `DG`（`/common/core.js`）
4. 重启服务即自动注册（`games/*/index.js` 扫描），主播台导航自动出现新游戏

## 接口说明

- 主播台框架壳：`/control.html`（iframe 嵌 `/games/<id>/public/control.html`）
- 展示屏：`/games/<id>/public/stage.html`
- 状态推送：SSE `/api/events?game=<id>`（`game=*` 订阅全部，广播带 `__game` 字段）
- 控制指令：`POST /api/control` body `{ action, game, ... }`；`action: "switchGame"` 切换激活游戏
- 游戏列表：`GET /api/games`（含各游戏状态/轮次/前端页面地址）
- 弹幕转发：`ws://127.0.0.1:18080/danmu`（默认分发给激活游戏，弹幕带 `game` 字段可定向）

## 配置（games/<id>/config.json，主播台也可实时调整）

> 完整字段说明见 **[CONFIG.md](./CONFIG.md)**，以下为常用项速览。

| 项 | 默认 | 说明 |
|---|---|---|
| `host.port`（host/host.json） | 18080 | 监听端口（环境变量 `PORT` 可覆盖） |
| `roundIntervalSec` | 120 | 每轮竞猜时长（秒） |
| `resultShowSec` | 10 | 揭晓后停留再开下一轮（秒） |
| `autoNextRound` | true | 揭晓后自动开新轮 |
| `guessPattern` | loose | `loose` 宽松（1234/猜1234）`strict` 严格（仅前缀） |
| `rateLimitSec` | 2 | 同一玩家两次猜测最小间隔（秒） |
| `maxGuessesPerUserPerRound` | 20 | 每轮每人猜测上限 |
| `baseScorePerWin` | 100 | 猜中基础分（得分 = 基础分 × (1+剩余占比)，最高 2 倍） |
| `digitCount` | 4 | 答案位数：`4` 标准（4 位 + 4 条线索）/ `3` 简单（3 位 + 3 条线索） |
| `answerRevealSec` | `[0,25,50,75]` | **每位答案数字的出现时间**（秒）：`0`=开局即现，`N`=第 N 秒，`-1`=不出现（数组长度跟随位数） |
| `answerLeadingZero` | false | 允许答案首位为 0 |
| `mode`（redblue） | shooter | **`shooter` 弹幕枪战（默认，双方互射比 HP）** / `shooterBoss` 枪战打 BOSS（双方合力射击中央 Boss，击杀=全员胜利）/ `tug` 纯拔河 / `siege` 纯守城 / `mixed` 混合 |
| `shooterHp` / `shooterTravelMs` / `giftBulletStrength`（redblue） | 100 / 1400 / 6 | 枪战：每队初始血量 / 子弹横穿用时(ms) / 送礼强力子弹血量（普通弹=1，同强相撞互抵） |
| `autoFire` / `autoFireBaseMs`（redblue） | true / 1100 | 枪战自动火力：无人发弹幕双方也持续交火（同频同强→互抵不动血）；**点赞=本队加速**（射速最多 2.6 倍 + 弹速最多 1.8 倍，需持续点赞维持） |
| `shooterBossHp` / `bossAtkSec` / `bossAtk`（redblue） | 300 / 8 / 7 | Boss 战：Boss 血量 / 反击间隔(秒) / 反击伤害（打基地墙，墙破=Boss 胜） |
| `likesPerEnergy` / `surgeThreshold` / `surgePush`（redblue） | 3 / 50 / 12 | 点赞充能速率 / 冲锋阈值 / 冲锋推力（守城轮为「全力一击」伤害 `siegeSurgeDamage`） |
| `monsterHp` / `wallHp` / `monsterAtk`（redblue） | 300 / 100 / 7 | 守城怪物血量 / 城墙耐久 / 怪物攻城伤害（百人直播间建议怪物 800~1500） |
| `aiReport`（redblue） | local | 结算战报：`local` 本地模板 / `api` OpenAI 兼容接口（`aiApiUrl`+`aiApiKey`+`aiModel`，失败自动回退 local）/ `off` |
| `mode`（gomoku） | pve | 对局模式：`pve` 人机对决（观众执黑）/ `pvp` 双人对决（双队列各取第一） |
| `botLevel`（gomoku） | 5 | 人机等级 1-10：1 随机 → 2-4 常识级（成五/堵五）→ 5-10 α-β 搜索级（迭代加深 + Zobrist 置换表 + VCF 杀棋检测，棋圣单手约 0.9s） |
| `autoMoveLevel`（gomoku） | 4 | 超时托管与主播台「托管一手」按钮的 AI 等级（1-10，默认中级；不影响机器人应手的 botLevel） |
| `forbidden`（gomoku） | true | 连珠禁手：黑方 三三/四四/长连 禁手，黑五连须恰好五子；关闭后自由规则（≥5 连即胜） |
| `giftUndoEnabled`（gomoku） | true | 上座观众送礼悔棋（撤回自己上一手及之后落子），`giftUndoPerGift`/`undoMaxPerGame` 可配 |
| `pvpWinScore`/`pvpLoseScore`（gomoku） | 100/20 | 双人对决胜方得分（+1 胜场）/ 败方参与奖；`pveWinScore`/`pveLoseScore` 为人机模式对应值 |

## 性能与运维（2026-09 新增）

- **游戏开关**：主播台左侧导航每个游戏带 ⏻ 电源按钮（控制台页也有「关闭游戏」按钮）。关闭 = 停止弹幕分发 + 清理该游戏全部定时器（不再执行），状态落盘、重启保持；再点开启恢复。
- **五子棋 AI 工作线程**：棋圣级 α-β 搜索（单手最慢 ~1s）已移入 `worker_threads`（`games/gomoku/ai-worker.js`），不再阻塞弹幕分发 / SSE / 其他游戏；Worker 不可用时自动回退同步搜索。
- **排行榜防抖落盘**：高频计分合并写盘（≤800ms 合并 + 5s 兜底 + 进程退出冲刷），原子写（先 .tmp 再改名）+ 每次落盘前备份 `leaderboard.json.bak`；进程崩溃最多丢 800ms 计分。
- **SSE 慢客户端保护**：订阅端积压超 1MB 自动断开让其重连（EventSource 重连自带全量 state），防止被节流的浏览器标签页吞噬内存。
- **红蓝大作战 Canvas 战场**：拔河绳/守城战场景与粒子、冲击波、飘字、震屏特效全部 Canvas 2D 渲染（`common/fx.js` 零依赖特效引擎），帧循环用 setInterval 16ms 驱动（不依赖 requestAnimationFrame，兼容 OBS 采集与嵌入容器）。

## 自测

```bash
node games/guess/engine.js --selftest 1000   # 生成 1000 题验证全部唯一
node games/gomoku/engine.js --selftest       # 五子棋引擎自测（坐标/禁手/Zobrist/VCF/AI 对弈 32 项）
node scripts/test_gomoku.js                  # 五子棋模块端到端（队列/上座/落子/悔棋/计分/徽章 30 项）
node scripts/test_gomoku_http.js             # 五子棋 HTTP 端到端（需服务已启动，30 项）
node scripts/simulate.js                     # 模拟弹幕（闲聊+随机猜测）
node scripts/simulate.js --solver             # 模拟弹幕+定期发真实答案（演示获胜流程）
node scripts/simulate.js --game chengyu 一心一意 意气风发   # 定向发给成语接龙
python scripts/test_redblue.py 18080         # 红蓝大作战端到端冒烟测试（21 项断言）
```

## 说明与风险提示

- **答案保密**：答案通过 SSE 下发给所有页面（主播台需实时查看）。观众可打开控制台页面或调试器看到答案 —— 请只把展示屏投到公开屏幕，并不要在观众可见设备开调试器
- 本工具用于娱乐互动，请遵守抖音平台规则与直播平台互动规范
- 弹幕发送是单向的（DanmuDesk 只收不发），玩家反馈由主播口播或看板展示，本服务不向直播间回发消息
