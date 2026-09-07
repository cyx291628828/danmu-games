# -*- coding: utf-8 -*-
"""
test_redblue.py — 红蓝大作战 · 端到端冒烟测试（UTF-8 安全，替代 curl 中文乱码问题）
用法: python scripts/test_redblue.py [port]   （默认 18090，需已启动 host/server.js）
流程: 快速配置 → 开局 → 组队(8人) → 点赞冲锋 → 拉动 → 等结算 → 校验计分/榜单
"""
import json, sys, time, urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18090
BASE = f"http://127.0.0.1:{PORT}"
FAILS = []

def post(action, **kw):
    body = json.dumps({"action": action, "game": "redblue", **kw}).encode("utf-8")
    req = urllib.request.Request(f"{BASE}/api/control", data=body,
                                 headers={"Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))

def check(name, cond, detail=""):
    print(("  ✔ " if cond else "  ✘ ") + name + (f"  [{detail}]" if detail else ""))
    if not cond: FAILS.append(name)

print("== 1. 快速配置 + 开局 ==")
# 幂等重置：上一轮异常退出可能残留守城配置，先统一回拔河默认
post("config", mode="tug", joinSec=3, tugSec=10, resultShowSec=3, winScore=80, loseScore=20,
     rateLimitSec=2, monsterHp=300, monsterAtkSec=8, monsterAtk=7, wallHp=100)
r = post("start")
check("开局", r["ok"] and r["state"]["status"] == "joining" and r["state"]["mode"] == "tug", r["msg"])

print("== 2. 组队期入队（5红3蓝 + 1个换队 + 1个无效弹幕） ==")
reds = ["阿红", "大山", "梅子", "小龙", "冲锋手"]
blues = ["小蓝", "汤圆", "老猫"]
for n in reds:  post("simulateDanmu", name=n, text="红")
for n in blues: post("simulateDanmu", name=n, text="蓝")
post("simulateDanmu", name="大山", text="蓝")          # 换队：大山 红→蓝
post("simulateDanmu", name="路人甲", text="哈哈哈哈")   # 无效弹幕不消费
s = post("simulateDanmu", name="峰哥", text="红")["state"]
check("红队 5 人（含换入的大山/峰哥）", s["red"]["count"] == 5, f"red={s['red']['count']}")
check("蓝队 4 人（3 + 换队来的大山）", s["blue"]["count"] == 4, f"blue={s['blue']['count']}")

print("== 3. 等待进入对抗期，点赞充能触发冲锋 ==")
deadline = time.time() + 6
while time.time() < deadline:
    s = post("simulateDanmu", name="__probe__", text="红")["state"]
    if s["status"] == "tugging": break
    time.sleep(0.3)
check("已进入对抗期", s["status"] == "tugging", f"status={s['status']}")
# 单条点赞事件受 likeCapPerEvent=30 上限，需分多次发满 150 赞（50 能量阈值）
for _ in range(2): post("simulateLike", name="阿红", count=30)   # 20 能量
for _ in range(2): post("simulateLike", name="小龙", count=30)   # 20 能量
s = post("simulateLike", name="阿红", count=30)["state"]         # 50 → 冲锋，余 0
check("红队冲锋触发（surges=1）", s["red"]["surges"] == 1, f"surges={s['red']['surges']}")
check("冲锋推进战线（pos>50）", s["pos"] > 50, f"pos={s['pos']}")
check("冲锋后能量清零", s["red"]["energy"] < 50, f"energy={s['red']['energy']}")
s = post("simulateLike", name="未入队的人", count=99)["state"]
check("未入队观众点赞不计（蓝能量不变）", s["blue"]["energy"] == 0, f"blueEnergy={s['blue']['energy']}")

print("== 4. 拉动战线（含限频校验） ==")
before = s["pos"]
for i in range(6):  # 冲锋手连续拉 6 次，限频 2s 内只应计 1 次
    r = post("simulateDanmu", name="冲锋手", text="红")
s = r["state"]
check("限频生效（2s 内 6 次只计 1 次）", s["pos"] > before and s["red"]["pulls"] >= sum(
    1 for t in s["red"]["top"] if t["name"] == "冲锋手"), f"pos {before}→{s['pos']}")

print("== 5. 等待结算，校验计分 ==")
deadline = time.time() + 12
while time.time() < deadline:
    r = post("simulateDanmu", name="__probe__", text="红")
    if r["state"]["status"] == "revealed": break
    time.sleep(0.5)
s = r["state"]
res = s["result"]
check("已结算", s["status"] == "revealed" and res is not None)
check("红队获胜（战线>50）", res and res["winner"] == "red", f"winner={res and res['winner']} pos={res and res['pos']}")
check("MVP 有产出（红队贡献者）", res and len(res["mvp"]) >= 1, f"mvp={[m['name'] for m in (res and res['mvp'] or [])]}")

time.sleep(0.5)
lb = json.load(open("data/leaderboard.json", encoding="utf-8"))
by = {x["name"]: x for x in lb}
check("胜方计分+胜场（阿红 battle_wins≥1）", by.get("阿红", {}).get("battle_wins", 0) >= 1,
      f"阿红: wins={by.get('阿红', {}).get('battle_wins')} score={by.get('阿红', {}).get('battle_score')}")
check("败方只计分不计胜场（小蓝 wins=0）", by.get("小蓝", {}).get("battle_score", 0) >= 20 and by.get("小蓝", {}).get("battle_wins", 0) == 0,
      f"小蓝: wins={by.get('小蓝', {}).get('battle_wins')} score={by.get('小蓝', {}).get('battle_score')}")
mvpName = res["mvp"][0]["name"]
check(f"MVP 加分（{mvpName} 分≥80+150）", by.get(mvpName, {}).get("battle_score", 0) >= 80 + 150,
      f"{mvpName}: score={by.get(mvpName, {}).get('battle_score')}")

print("== 6. 连胜/战绩 + 停止 ==")
s = post("simulateDanmu", name="__probe__", text="红")["state"]
check("战绩累计（红≥1 且领先蓝）", s["series"]["red"] >= 1 and s["series"]["red"] > s["series"]["blue"], f"{s['series']}")
r = post("end")

print("== 7. 暂停/恢复/重开（暂停中开局=安全重开，丢弃暂停簿记） ==")
post("start")
r = post("pause")
check("暂停", r["ok"] and r["state"]["status"] == "paused", r["state"]["status"])
r = post("start")
check("暂停中可安全重开新局", r["ok"] and r["state"]["status"] == "joining" and r["state"]["pausedFrom"] is None,
      f"status={r['state']['status']} pausedFrom={r['state']['pausedFrom']}")
r = post("pause"); r2 = post("resume")
check("暂停后恢复", r["ok"] and r2["ok"] and r2["state"]["status"] in ("joining", "tugging"), r2["state"]["status"])
r = post("reveal"); check("组队期可跳过直接开战", r["ok"] and r["state"]["status"] == "tugging", r["state"]["status"])
r = post("end"); check("结束回空闲", r["state"]["status"] == "idle")

print("== 8. PVE 守城：斩杀成功路径 ==")
UNIQ = str(int(time.time()))[-5:]
甲, 乙, 丙 = f"守军甲{UNIQ}", f"守军乙{UNIQ}", f"守军丙{UNIQ}"
post("config", mode="siege", joinSec=3, tugSec=40, resultShowSec=2, rateLimitSec=1,
     monsterHp=20, monsterAtkSec=3, monsterAtk=5, wallHp=100, siegeSurgeDamage=10,
     siegeWinScore=60, siegeLoseScore=10)
r = post("start")
check("守城轮组队", r["ok"] and r["state"]["mode"] == "siege", r["state"]["mode"])
for n in [甲, 乙, 丙]: post("simulateDanmu", name=n, text="红")
time.sleep(3.2)
s = post("simulateDanmu", name=甲, text="随便打两下")["state"]   # 无队色弹幕也算攻击
check("进入守城期且任意弹幕=攻击", s["status"] == "sieging" and s["monster"]["hp"] == 19,
      f"hp={s['monster']['hp']}/{s['monster']['hpMax']}")
check("无队色弹幕自动入队（守军籍）", s["red"]["count"] + s["blue"]["count"] == 3,
      f"red={s['red']['count']} blue={s['blue']['count']}")
for _ in range(5): post("simulateLike", name=丙, count=30)      # 150 赞 = 50 能量 → 全力一击
s = post("simulateLike", name=丙, count=1)["state"]
check("全力一击触发（surges=1，怪物 -10）", s["surges"] == 1 and s["monster"]["hp"] == 9,
      f"surges={s['surges']} hp={s['monster']['hp']}")
# 轮流攻击斩杀（限频 1s/人：先等甲的限频窗口过去，再多打一轮兜底）
time.sleep(1.1)
for round_ in range(4):
    for n in [甲, 乙, 丙]:
        r = post("simulateDanmu", name=n, text="打")
        if r["state"]["status"] == "revealed": break
        time.sleep(0.4)
    if r["state"]["status"] == "revealed": break
s = r["state"]
res = s["result"]
check("守城结算（已揭晓）", s["status"] == "revealed" and res and res["mode"] == "siege")
check("怪物被斩杀 → 成功", res and res["success"] is True and res["monster"]["hpLeft"] == 0,
      f"success={res and res['success']} hpLeft={res and res['monster']['hpLeft']}")
time.sleep(1.2)                  # 排行榜防抖落盘（800ms 合并写）
lb = json.load(open("data/leaderboard.json", encoding="utf-8"))
by = {x["name"]: x for x in lb}
check("守军甲获得成功分+胜场", by.get(甲, {}).get("battle_wins", 0) >= 1 and by.get(甲, {}).get("battle_score", 0) >= 60,
      f"wins={by.get(甲, {}).get('battle_wins')} score={by.get(甲, {}).get('battle_score')}")
r = post("end")

print("== 9. PVE 守城：城墙被破失败路径 ==")
post("config", monsterHp=9999, monsterAtkSec=1, monsterAtk=9, wallHp=20, tugSec=30)
post("start")
time.sleep(3.2)
post("simulateDanmu", name=甲, text="打不动")
deadline = time.time() + 10
while time.time() < deadline:
    r = post("simulateDanmu", name=甲, text="打不动")
    if r["state"]["status"] == "revealed": break
    time.sleep(0.4)
res = r["state"]["result"]
check("城墙破 → 守城失败", res and res["mode"] == "siege" and res["success"] is False and res["reason"] == "wall",
      f"success={res and res['success']} reason={res and res['reason']}")
time.sleep(1.2)   # 排行榜防抖落盘（800ms 合并写）
lb = json.load(open("data/leaderboard.json", encoding="utf-8"))
by = {x["name"]: x for x in lb}
check("失败方拿安慰分不计胜场（守军甲）", by.get(甲, {}).get("battle_score", 0) >= 10
      and by.get(甲, {}).get("battle_wins", 0) == 1,
      f"wins={by.get(甲, {}).get('battle_wins')} score={by.get(甲, {}).get('battle_score')}")
r = post("end")
# 还原默认（mode 保持新默认 shooter；其余与 CFG_DEFAULTS 一致）
post("config", mode="shooter", joinSec=15, tugSec=120, resultShowSec=12, monsterHp=300,
     monsterAtkSec=8, monsterAtk=7, wallHp=100, siegeSurgeDamage=20, siegeWinScore=60, siegeLoseScore=10)
print("（已还原默认配置）")

print("== 10. AI 战报（local）+ 赛季功勋 ==")
post("end")
seasonNo0 = post("config", mode="tug", joinSec=1, tugSec=2, resultShowSec=3, autoNextRound=False, rateLimitSec=0, aiBroadcast="local", bcEnabled={"report": True})["state"]["season"]["seasonNo"]
post("start")
time.sleep(1.2)                            # 组队到期 → 对抗期
post("simulateDanmu", name="功勋员", text="红")   # 功勋员拉动
time.sleep(2.6)                            # tugSec=2 到时 → 结算（战报异步生成）
resp = post("simulateDanmu", name="功勋员", text="红")   # 结算已定格，取最新 state
res = resp["state"]["result"]
rep = (res or {}).get("report") or ""
check("AI 战报已生成（local 模板）", len(rep) >= 10, rep[:30])
season = resp["state"]["season"]
mem = next((m for m in season["top"] if m["name"] == "功勋员"), None)
check("赛季功勋累计（功勋员入册+得分）", mem is not None and mem["score"] >= 20 and mem["rounds"] >= 1,
      f"score={mem and mem['score']} rounds={mem and mem['rounds']} team={mem and mem['team']}")
r = post("end")
r = post("newSeason")
check("开启新赛季（编号+1，功勋清零）", r["ok"] and r["state"]["season"]["seasonNo"] == seasonNo0 + 1
      and all(m["score"] == 0 for m in r["state"]["season"]["top"]),
      f"S{seasonNo0}→S{r['state']['season']['seasonNo']}")
r = post("end")
# 最终还原：新默认 shooter（第 10 节的临时拔河局不残留）
post("config", mode="shooter", joinSec=15, tugSec=120, resultShowSec=12, autoNextRound=True,
     rateLimitSec=2, autoFire=True, autoFireBaseMs=1100, shooterHp=100,
     shooterTravelMs=1400, giftBulletStrength=6, monsterHp=300, monsterAtkSec=8, monsterAtk=7,
     wallHp=100, siegeSurgeDamage=20, siegeWinScore=60, siegeLoseScore=10)

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过: {FAILS}"); sys.exit(1)
print("✅ 全部通过")
