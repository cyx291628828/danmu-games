# -*- coding: utf-8 -*-
"""guess/chengyu/sudoku 通用播报接入冒烟：start 后检查 bc.seq / bcSlots / bcCfg 无密钥"""
import json, time, urllib.request

BASE = "http://127.0.0.1:18080"

def ctl(game, action, **extra):
    body = {"game": game, "action": action}
    body.update(extra)
    req = urllib.request.Request(BASE + "/api/control", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())

def check(game, st, expect_slots):
    bc = st.get("bc") or {}
    slots = st.get("bcSlots") or []
    cfg = st.get("bcCfg") or {}
    ok_seq = bc.get("seq", 0) > 0
    ok_slots = len(slots) == expect_slots
    ok_nokey = "aiApiKey" not in json.dumps(cfg)
    log = bc.get("log") or []
    print(f"[{game}] bc.seq={bc.get('seq')} bcSlots={slots} log={len(log)}条")
    for e in log[-3:]:
        print(f"    - slot={e.get('slot')} mode={e.get('mode')} text={str(e.get('text'))[:40]}")
    print(f"    seq>0: {ok_seq} | slots=={expect_slots}: {ok_slots} | 无aiApiKey: {ok_nokey}")
    return ok_seq and ok_slots and ok_nokey

results = {}

# ── guess：3 slots（roundOpen/win/timeout）──
r = ctl("guess", "switchGame"); time.sleep(0.3)
r = ctl("guess", "start")
results["guess"] = check("guess", r.get("state") or {}, 3)

# ── chengyu：3 slots（chainStart/milestone/interrupt）；再模拟 5 楼触发 milestone ──
r = ctl("chengyu", "switchGame"); time.sleep(0.3)
r = ctl("chengyu", "start")
st = r.get("state") or {}
for i in range(5):
    rr = ctl("chengyu", "simulateGuess", name=f"观众{i}", text="测试接龙词")
    time.sleep(0.15)
    # 模拟词可能不在词库被拒，继续即可（milestone 只在连续成功 5 楼触发）
r = ctl("chengyu", "start")  # 重开一局拿最新 state（含播报日志）
results["chengyu"] = check("chengyu", r.get("state") or {}, 3)

# ── sudoku：3 slots（roundStart/progress/finish）──
r = ctl("sudoku", "switchGame"); time.sleep(0.3)
r = ctl("sudoku", "start")
results["sudoku"] = check("sudoku", r.get("state") or {}, 3)

print()
print("SMOKE:", "ALL PASS" if all(results.values()) else f"FAIL {results}")
