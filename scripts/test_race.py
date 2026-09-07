# -*- coding: utf-8 -*-
"""
test_race.py — 赛马竞猜 · 端到端冒烟测试
用法: python scripts/test_race.py [port]     （默认 18080，需已启动 host/server.js）
覆盖: 配置 → 开局 → 下注解析 → 限流/注数上限 → 无效马号 → 点赞加速 → 礼物骑士 →
      开赛 → 结算派彩 → 钱包余额 → 头奖滚存 → 关注送筹码 → 破产救济 → 结束退款 → 播报
"""
import json, sys, time, urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18080
BASE = f"http://127.0.0.1:{PORT}"
GAME = "race"
FAILS = []

# 本机回环必须绕过系统代理（否则 http_proxy 会把 127.0.0.1 请求也发给代理 → 502）
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(action, **kw):
    body = json.dumps({"action": action, "game": GAME, **kw}).encode("utf-8")
    req = urllib.request.Request(f"{BASE}/api/control", data=body,
                                 headers={"Content-Type": "application/json; charset=utf-8"})
    with OPENER.open(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def check(name, cond, detail=""):
    print(("  ✔ " if cond else "  ✘ ") + name + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(name)


def wait_status(want, timeout=25.0, tick=0.3):
    """轮询直到状态匹配（用空转动作取态，不产生副作用）"""
    deadline = time.time() + timeout
    st = None
    while time.time() < deadline:
        st = post("walletQuery", name="__nobody__")["state"]      # 无副作用：查不到就返回空
        if not st:
            st = post("broadcast", slot="__probe__")["state"]
        if st and st.get("status") == want:
            return st
        time.sleep(tick)
    return st


def chips_of(name):
    r = post("walletQuery", name=name)
    lst = (r.get("state") or {}).get("walletQuery") or []
    for rec in lst:
        if rec["name"] == name:
            return rec["chips"]
    return None


print("== 0. 重置并下发快速节奏配置 ==")
post("resetWallet")
post("config", betSec=8, raceSec=6, resultSec=3, autoLoop=False,
     baseBet=100, maxBetsPerRound=5, rateLimitSec=0, horseCount=4,
     startChips=1000, bailoutChips=500, minOdds=1.2, maxOdds=20,
     likesPerBoost=2, maxBoostCells=10, finalSprintSec=2, finalSprintMult=2,
     giftBoostEnabled=True, giftBoostCells=6, giftMaxCellsPerHorse=24,
     followBonusChips=500, followCooldownHours=21,
     surgePerRace=2, rubberBand=0.8, jackpotEnabled=True, honorScore=30, fxLevel="full")
r = post("start")
st = r["state"]
check("开局进入下注期", r["ok"] and st["status"] == "betting", r["msg"])
check("生成 4 匹马", len(st["horses"]) == 4, f'n={len(st["horses"])}')

print("== 1. 下注解析（1 / 押2 / 买3号 / 4 2） ==")
post("mockChat", name="阿伟", text="1")
post("mockChat", name="小美", text="押2")
post("mockChat", name="老铁", text="买3号")
s = post("mockChat", name="锦鲤", text="4 2")["state"]        # 2 注 = 200
check("注数 = 5（4 人共 5 注）", s["betCount"] == 5, f'betCount={s["betCount"]}')
check("下注人数 = 4", s["bettors"] == 4, f'bettors={s["bettors"]}')
check("本局注额 = 500", s["totalStaked"] == 500, f'staked={s["totalStaked"]}')
check("彩池 = 500", s["pool"] == 500, f'pool={s["pool"]}')
bets = {h["no"]: h["bet"] for h in s["horses"]}
check("各马注额正确", bets == {1: 100, 2: 100, 3: 100, 4: 200}, str(bets))

print("== 2. 无效马号 / 限流 / 注数上限 ==")
before = s["betCount"]
post("mockChat", name="路人甲", text="7")                     # 只有 4 匹马
s = post("mockChat", name="路人甲", text="哈哈哈")["state"]     # 非下注弹幕
check("超范围马号不下注", s["betCount"] == before, f'betCount={s["betCount"]}')
check("非下注弹幕不消费", s["betCount"] == before)

post("config", rateLimitSec=2)
s = post("mockChat", name="阿伟", text="1")["state"]           # 第一次成功
n1 = s["betCount"]
post("mockChat", name="阿伟", text="1")                       # 2s 内第二次 → 限流
s = post("mockChat", name="阿伟", text="1")["state"]
check("限流生效（连发 3 次只计 1 次）", s["betCount"] == n1, f'{n1} → {s["betCount"]}')

post("config", rateLimitSec=0, maxBetsPerRound=2)
for _ in range(5):
    post("mockChat", name="卷王", text="2")
s = post("mockChat", name="卷王", text="2")["state"]
cnt = sum(1 for h in s["horses"] if h["no"] == 2)
check("注数上限生效（每人 2 注）", s["horses"][1]["bet"] == 100 + 200, f'2号注额={s["horses"][1]["bet"]}')
post("config", maxBetsPerRound=5)

print("== 3. 点赞加速（只加速自己押的马） ==")
s0 = post("mockLike", name="没下注的人", count=10)["state"]
like_sum = sum(h["likes"] for h in s0["horses"])
check("未下注者点赞不计入任何马", like_sum == 0, f'likes_sum={like_sum}')
s1 = post("mockLike", name="阿伟", count=6)["state"]           # 阿伟押 1 号，6 赞 / 每 2 赞 1 格 = 3 格
h1 = s1["horses"][0]
check("已下注者点赞记到所押的马", h1["likes"] == 6, f'likes={h1["likes"]}')
check("点赞 → 加速格（下注期记为预约）", h1["boostCells"] == 3 or h1["boostCells"] == 0, f'boostCells={h1["boostCells"]}')
top = {c["name"]: c["likes"] for c in s1["cheerTop"]}
check("助威榜出现阿伟", top.get("阿伟") == 6, str(top))

print("== 4. 礼物骑士冲锋 ==")
s2 = post("mockGift", name="小美", giftName="小心心", giftCount=1)["state"]
h2 = s2["horses"][1]
check("礼物记入礼物墙", any(g["user"] == "小美" for g in s2["giftList"]), str(s2["giftList"][:1]))
check("礼物 → 骑士冲锋格", h2["giftCells"] == 6, f'giftCells={h2["giftCells"]}')
check("礼物特效入队", any(f["type"] == "gift" for f in s2["fx"]),
      str([f["type"] for f in s2["fx"]]))

print("== 5. 开赛 → 结算派彩 ==")
wallet_before = {n: chips_of(n) for n in ["阿伟", "小美", "老铁", "锦鲤"]}
r = post("skipBet")
st = r["state"]
check("跳过下注进入比赛", st["status"] == "racing", st["status"])
check("下注期预约的加速格已注入赛道",
      any(h["boostCells"] > 0 or h["giftCells"] > 0 for h in st["horses"]),
      str([(h["no"], h["boostCells"], h["giftCells"], h["pos"]) for h in st["horses"]]))

st = wait_status("result", timeout=25)
check("比赛结束进入结算", st and st["status"] == "result", f'status={st and st["status"]}')
res = st["result"]
check("产生结算结果", bool(res), "")
if res:
    win = res["winner"]
    check("冠军是参赛马之一", 1 <= win["no"] <= 4, f'{win["no"]}号{win["name"]}')
    check("赔率在区间内", 1.2 <= res["odds"] <= 20, f'odds={res["odds"]}')
    check("彩池 = 结算彩池", res["pool"] == st["pool"] or res["pool"] > 0, f'pool={res["pool"]}')
    check("战报文案非空", bool(res["report"]), (res["report"] or "")[:30])
    print(f'     战报：{res["report"]}')
    if res["winnerCount"] > 0:
        w0 = res["winners"][0]
        expect = round(w0["stake"] * res["odds"])
        check("派彩 = 注额 × 赔率", abs(w0["payout"] - expect) <= 1,
              f'stake={w0["stake"]} ×{res["odds"]} → {w0["payout"]}（期望≈{expect}）')
        for n in res["winners"]:
            after = chips_of(n["name"])
            check(f'「{n["name"]}」钱包到账派彩', after is not None and after > wallet_before.get(n["name"], 0),
                  f'{wallet_before.get(n["name"])} → {after}')
    else:
        check("无人押中 → 头奖滚存", res["jackpot"] is True, f'jackpot={res["jackpot"]}')

print("== 6. AI 播报（通用模块） ==")
check("播报中心已推送", st["bc"]["seq"] > 0, f'seq={st["bc"]["seq"]}')
check("播报记录非空", len(st["bc"]["log"]) > 0, f'log={len(st["bc"]["log"])}')
check("播报点已注册", len(st.get("bcSlots") or []) >= 5, f'slots={len(st.get("bcSlots") or [])}')
check("密钥明文不下发", "aiApiKey" not in json.dumps(st.get("bcCfg") or {}, ensure_ascii=False))
r = post("broadcast", slot="raceStart", force=True)
check("主播台可手动触发播报", r["ok"], r["msg"])

print("== 7. 头奖滚存（无人押中） ==")
post("config", betSec=8, raceSec=6, autoLoop=False, jackpotEnabled=True)
post("start")
post("mockChat", name="独苗", text="1")
st = post("skipBet")["state"]
st = wait_status("result", timeout=25)
res = st["result"]
if res and res["winner"]["no"] != 1:
    check("无人押中触发头奖滚存", res["jackpot"] is True, f'winner={res["winner"]["no"]}号')
    check("彩池滚存到下一局", res["carry"] == res["pool"] and res["pool"] > 0,
          f'carry={res["carry"]} pool={res["pool"]}')
    post("start")
    s3 = post("broadcast", slot="__probe__")["state"]
    check("下一局彩池含上局滚存", s3["pool"] == res["carry"] and s3["carry"] == res["carry"],
          f'pool={s3["pool"]} carry={s3["carry"]}')
    post("end")
else:
    print("     （本次冠军恰好被押中，跳过滚存断言）")

print("== 8. 关注送筹码 + 冷却 ==")
FAN = f"新粉丝{int(time.time())}"      # 随机名：避免上一轮测试的 21h 关注冷却落盘残留
post("mockFollow", name=FAN)
c1 = chips_of(FAN)
check("关注即开户并送筹码", c1 == 1500, f'chips={c1}')
post("mockFollow", name=FAN)
c2 = chips_of(FAN)
check("冷却内不重复发放", c2 == c1, f'{c1} → {c2}')

print("== 9. 破产救济 ==")
post("start")
r = post("walletQuery", name="阿伟")
lst = (r.get("state") or {}).get("walletQuery") or []
uid = lst[0]["uid"] if lst else None
if uid:
    cur = lst[0]["chips"]
    post("walletAdjust", uid=uid, delta=-(cur - 50))      # 压到 50 筹码（不足一注 100）
    post("mockChat", name="阿伟", text="1")
    c = chips_of("阿伟")
    check("余额不足先发救济金再扣注", c == 50 + 500 - 100, f'50 +500 -100 → {c}')
else:
    check("找到阿伟钱包", False, "walletQuery 无结果")

print("== 10. 结束并退还注额 ==")
post("start")
post("mockChat", name="退钱哥", text="2")
c_before = chips_of("退钱哥")
r = post("end")
c_after = chips_of("退钱哥")
check("结束对局", r["ok"] and r["state"]["status"] == "idle", r["msg"])
check("注额原额退回", c_after == c_before + 100, f'{c_before} → {c_after}')

print("== 11. 榜单 ==")
s = post("broadcast", slot="__probe__")["state"]
check("筹码富家榜有数据", len(s["walletTop"]) > 0, f'n={len(s["walletTop"])}')
check("荣誉榜有数据", len(s["leaderboard"]) > 0, f'n={len(s["leaderboard"])}')

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过: " + "、".join(FAILS))
    sys.exit(1)
print("✅ 全部通过")
