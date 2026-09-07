/**
 * ============================================================================
 * games/redblue/season.js — 赛季战队（P4 · 跨场次阵营归属与功勋榜）
 * ============================================================================
 * 【作用】阵营归属跨场次/跨天延续：观众入队即"入伍"进入赛季名册，每轮结算
 *   累计功勋（场次/胜场/拉动/点赞/得分/MVP），按赛季汇总战绩并落盘。
 *
 * 【数据】data/redblue_season.json
 *   { seasonNo, startedAt, members: { uid: {name, avatar, team, rounds, wins,
 *     pulls, likes, score, mvp, joinedAt} } }
 *   战队总分/人数等汇总值不落盘，由 summary() 实时聚合（避免双写漂移）。
 *
 * 【接口】enroll / recordRound / summary / newSeason
 * ============================================================================
 */
'use strict';

const fs = require('fs');

const emptyTotals = () => ({ score: 0, wins: 0, rounds: 0, pulls: 0, likes: 0, members: 0 });

class Season {
  constructor(file, log) {
    this.file = file;
    this.log = log || (() => {});
    this.load();
  }

  load() {
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = null; }
    if (!this.data || !Number.isInteger(this.data.seasonNo) || !this.data.members) {
      this.data = { seasonNo: 1, startedAt: Date.now(), members: {} };
      this.save();
      this.log('info', `[season] 初始化第 1 赛季名册`);
    } else {
      this.log('info', `[season] 已加载第 ${this.data.seasonNo} 赛季名册（${Object.keys(this.data.members).length} 人）`);
    }
  }

  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
    catch (e) { this.log('warn', '[season] 落盘失败:', e.message); }
  }

  /**
   * 入队/转队即入伍（幂等：已入伍且队籍未变时不写盘）
   * @returns {object} 名册成员记录
   */
  enroll(uid, name, avatar, team) {
    const m = this.data.members[uid];
    if (m && m.team === team && m.name === name) {
      if (avatar && avatar !== m.avatar) { m.avatar = avatar; this.save(); }
      return m;
    }
    if (m) {
      m.team = team;
      if (name) m.name = name;
      if (avatar) m.avatar = avatar;
      this.save();
      this.log('info', `[season] ${m.name} 转投${team === 'red' ? '红' : '蓝'}队（第 ${this.data.seasonNo} 赛季）`);
      return m;
    }
    this.data.members[uid] = {
      name: name || '匿名', avatar: avatar || '', team,
      rounds: 0, wins: 0, pulls: 0, likes: 0, score: 0, mvp: 0, joinedAt: Date.now(),
    };
    this.save();
    this.log('info', `[season] ${name} 入伍${team === 'red' ? '红' : '蓝'}队（第 ${this.data.seasonNo} 赛季）`);
    return this.data.members[uid];
  }

  /**
   * 每轮结算累计功勋
   * @param {Array} fighters [{uid, name, avatar, team, pulls, likes, score, mvp}]
   * @param {string|null} winSide 'red'|'blue'（拔河胜方）；守城成功传 'both'；失败/平局传 null
   */
  recordRound(fighters, winSide) {
    if (!Array.isArray(fighters) || !fighters.length) return;
    for (const f of fighters) {
      const m = this.data.members[f.uid];
      if (!m) continue; // 未入伍（理论不会发生：入队即入伍）
      m.rounds += 1;
      if (winSide === 'both' || winSide === f.team) m.wins += 1;
      m.pulls += f.pulls || 0;
      m.likes += f.likes || 0;
      m.score += f.score || 0;
      if (f.mvp) m.mvp += 1;
    }
    this.save();
  }

  /** 赛季摘要（实时聚合，供展示屏/控制台/主播台） */
  summary(topN = 10) {
    const list = Object.entries(this.data.members).map(([uid, m]) => ({ uid, ...m }));
    const totals = { red: emptyTotals(), blue: emptyTotals() };
    for (const m of list) {
      const t = totals[m.team === 'blue' ? 'blue' : 'red'];
      t.members += 1;
      t.score += m.score;
      t.wins += m.wins;
      t.rounds += m.rounds;
      t.pulls += m.pulls;
      t.likes += m.likes;
    }
    const top = list.sort((a, b) => (b.score - a.score) || (b.wins - a.wins)).slice(0, topN)
      .map(m => ({ name: m.name, avatar: m.avatar, team: m.team, score: m.score, wins: m.wins, rounds: m.rounds, mvp: m.mvp }));
    return { seasonNo: this.data.seasonNo, startedAt: this.data.startedAt, members: list.length, totals, top };
  }

  /** 开启新赛季：旧季归档到 data/redblue_season_s<N>.json，名册清零 */
  newSeason() {
    const old = this.data.seasonNo;
    try {
      fs.writeFileSync(
        this.file.replace(/\.json$/, `_s${old}.json`),
        JSON.stringify(this.data, null, 2),
      );
    } catch (e) { this.log('warn', '[season] 旧季归档失败:', e.message); }
    this.data = { seasonNo: old + 1, startedAt: Date.now(), members: {} };
    this.save();
    this.log('info', `[season] 第 ${old} 赛季已归档，开启第 ${this.data.seasonNo} 赛季`);
    return this.data.seasonNo;
  }
}

module.exports = { Season };
