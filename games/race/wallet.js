/**
 * ============================================================================
 * games/race/wallet.js — 筹码钱包（赛马竞猜专用货币）
 * ============================================================================
 * 【与荣誉分的关系】
 *   荣誉分（data/leaderboard.json）＝ 跨游戏成就，只加不减，赛马押中也加它；
 *   筹码（本文件）＝ 赌注货币，只在本玩法流通，下注真扣、派彩真给，另有「筹码富家榜」。
 *   两者不可互兑 —— 保证赌局连败不会污染其它游戏的成就榜。
 *
 * 【数据落盘】data/race_wallet.json
 *   { "<userId>": { name, avatar, chips, bailoutRound, rounds, wins, staked, payout, likes, gifts } }
 *   写入策略：重要变动立即写盘；高频变动（点赞/小注）走 3 秒防抖合并写，避免刷盘。
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

class Wallet {
  /**
   * @param {string} file 落盘路径
   * @param {(level:string,...a:any[])=>void} log 日志函数
   */
  constructor(file, log) {
    this.file = file;
    this.log = log || (() => {});
    this.map = new Map();
    this._dirty = false;
    this._timer = null;
    this.load();
  }

  load() {
    try {
      const obj = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(obj || {})) {
        if (!v || typeof v !== 'object') continue;
        this.map.set(k, {
          name: v.name || '匿名',
          avatar: v.avatar || '',
          chips: Math.max(0, Math.round(Number(v.chips) || 0)),
          bailoutRound: Number(v.bailoutRound) || 0,
          rounds: Number(v.rounds) || 0,
          wins: Number(v.wins) || 0,
          staked: Number(v.staked) || 0,
          payout: Number(v.payout) || 0,
          likes: Number(v.likes) || 0,
          gifts: Number(v.gifts) || 0,
        });
      }
      this.log('INFO', `[race-wallet] 已加载 ${this.map.size} 个筹码钱包`);
    } catch (e) {
      // 首次运行无文件：从空钱包开始（首次下注时按 startChips 开户）
      this.log('INFO', '[race-wallet] 无历史钱包文件，从空开始');
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const obj = {};
      for (const [k, v] of this.map) obj[k] = v;
      fs.writeFileSync(this.file, JSON.stringify(obj, null, 2), 'utf8');
      this._dirty = false;
    } catch (e) {
      this.log('WARN', '[race-wallet] 落盘失败:', e.message);
    }
  }

  /** 防抖写盘：高频变动（点赞/连续下注）合并成一次写，3 秒内最多写一次 */
  saveSoon() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) this.save();
    }, 3000);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  get(uid) { return this.map.get(uid) || null; }

  /**
   * 开户 / 更新资料。首次开户赠送 startChips。
   * @returns {object} 钱包记录
   */
  ensure(uid, name, avatar, startChips = 1000) {
    let rec = this.map.get(uid);
    if (!rec) {
      rec = {
        name: name || '匿名', avatar: avatar || '',
        chips: Math.round(Number(startChips) || 0),
        bailoutRound: 0, rounds: 0, wins: 0, staked: 0, payout: 0, likes: 0, gifts: 0,
      };
      this.map.set(uid, rec);
      this.save();
      this.log('INFO', `[race-wallet] 「${rec.name}」开户，赠送 ${rec.chips} 筹码`);
      return rec;
    }
    let changed = false;
    if (name && name !== rec.name) { rec.name = name; changed = true; }
    if (avatar && avatar !== rec.avatar) { rec.avatar = avatar; changed = true; }
    if (changed) this.saveSoon();
    return rec;
  }

  /** 余额增减（负数即扣款）。返回变动后的余额；余额不足时返回 -1 且不扣款。 */
  add(uid, delta) {
    const rec = this.map.get(uid);
    if (!rec) return -1;
    const next = rec.chips + delta;
    if (next < 0) return -1;
    rec.chips = next;
    this.saveSoon();
    return rec.chips;
  }

  /** 破产救济：每局限一次（bailoutRound 记录已救济的局号） */
  grantBailout(uid, roundNo, amount) {
    const rec = this.map.get(uid);
    if (!rec) return 0;
    if (rec.bailoutRound === roundNo) return 0;      // 本局已救济过
    rec.bailoutRound = roundNo;
    rec.chips += Math.round(amount);
    this.save();
    this.log('INFO', `[race-wallet] 「${rec.name}」第 ${roundNo} 局破产救济 +${amount} → ${rec.chips}`);
    return amount;
  }

  /** 历史上发过救济金的最大局号（用于服务重启后抬升 roundNo 基准，防止局号回绕误判） */
  maxBailoutRound() {
    let m = 0;
    for (const rec of this.map.values()) {
      const r = Number(rec.bailoutRound) || 0;
      if (r > m) m = r;
    }
    return m;
  }

  /** 筹码富家榜 TopN（只列有筹码的） */
  top(n = 10) {
    return [...this.map.entries()]
      .map(([uid, r]) => ({ uid, name: r.name, avatar: r.avatar, chips: r.chips, wins: r.wins, rounds: r.rounds }))
      .filter(r => r.chips > 0)
      .sort((a, b) => (b.chips - a.chips) || (b.wins - a.wins))
      .slice(0, n)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  /** 按昵称模糊查（主播台钱包工具用） */
  search(kw, n = 8) {
    const k = String(kw || '').trim().toLowerCase();
    if (!k) return [];
    return [...this.map.entries()]
      .filter(([, r]) => String(r.name || '').toLowerCase().includes(k))
      .slice(0, n)
      .map(([uid, r]) => ({ uid, name: r.name, avatar: r.avatar, chips: r.chips, wins: r.wins, rounds: r.rounds }));
  }
}

module.exports = { Wallet };
