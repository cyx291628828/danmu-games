/**
 * ============================================================================
 * common/leaderboard.js — 全局共享排行榜（跨游戏累计）
 * ============================================================================
 * 所有游戏共用同一份排行榜数据（data/leaderboard.json），同一玩家跨游戏累计积分。
 *
 * 每个游戏在 MANIFEST.score 里声明自己的计分字段，启动时通过 registerGame()
 * 注册进来 —— 宿主不再硬编码任何游戏的字段，新增游戏零改动：
 *   MANIFEST.score = { wins: 'guess_wins', score: 'guess_score', floors: null }
 *
 * 兼容旧单字段结构 {wins,score,floors} → 自动迁移为分玩法结构（一次性）。
 */
'use strict';

const fs = require('fs');

class SharedLeaderboard {
  /**
   * @param {string} file 排行榜数据落盘路径（JSON 数组）
   * @param {object} logger 日志对象（须含 .info/.warn），可省略
   */
  constructor(file, logger) {
    this.file = file;
    const lg = logger || {};
    this.log = (level, ...a) => { (lg[level] || console.log)(...a); };
    this.map = new Map();   // key=userId → 记录
    this.fields = new Map(); // gameId → { wins, score, floors }
    this._dirty = false;    // 防抖落盘：高频计分（弹幕输出/守城）不再逐次同步写盘
    this._saveTimer = null;
    this._maxWaitTimer = null;
    this.saveDebounceMs = 800;
    this.saveMaxWaitMs = 5000; // 防抖上限：数据变化超过该时长强制落盘，防长时静默丢失
  }

  /** 注册一个游戏的计分字段（host 扫描 games/ 时对每个 MANIFEST 调用） */
  registerGame(manifest) {
    if (!manifest || !manifest.id || !manifest.score) return;
    this.fields.set(manifest.id, {
      wins: manifest.score.wins,
      score: manifest.score.score,
      floors: manifest.score.floors || null,
    });
  }

  /* ───────────── 落盘 / 加载 ───────────── */

  load() {
    let migratedAny = false;
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(arr)) {
        this.map = new Map();
        for (const r of arr) if (r && r.key) {
          const mr = this.migrateRecord(r);
          if (mr !== r) migratedAny = true;
          this.map.set(r.key, mr);
        }
      }
    } catch { /* 首次运行无文件 */ }
    if (migratedAny) this.save();
    this.log('info', `[leaderboard] 全局排行榜已加载 ${this.map.size} 位玩家`);
  }

  /** 立即落盘；原子写（先 .tmp 再改名）+ 旧版自动备份 .bak。
    Windows 注意：目标文件可能正被其他进程读取（rename 需目标的 DELETE 共享权限，
    测试/编辑器/脚本打开时会被拒 → EPERM）。此时退回拷贝式写入，绝不抛异常拖垮宿主。 */
  save() {
    const tmp = this.file + '.tmp';
    try { if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak'); } catch {}
    let body;
    try {
      body = JSON.stringify(Array.from(this.map.values()));
      fs.writeFileSync(tmp, body);
    } catch (e) {
      this.log('warn', '[leaderboard] 写临时文件失败:', e.message);
      try { fs.writeFileSync(this.file, body || '[]'); } catch (e2) { this.log('warn', '[leaderboard] 兜底直写失败:', e2.message); }
      this._dirty = false;
      return;
    }
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // 目标被占用：直接拷贝覆盖（旧内容由 .bak 保底）
      try {
        fs.copyFileSync(tmp, this.file);
        try { fs.unlinkSync(tmp); } catch {}
        if (e.code === 'EPERM' || e.code === 'EACCES') this.log('warn', '[leaderboard] 文件被占用，已用拷贝方式落盘');
        else this.log('warn', '[leaderboard] 改名失败，已用拷贝方式落盘:', e.message);
      } catch (e2) {
        this.log('warn', '[leaderboard] 落盘失败:', e2.message);
      }
    }
    this._dirty = false;
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this._maxWaitTimer) { clearTimeout(this._maxWaitTimer); this._maxWaitTimer = null; }
  }

  /** 防抖落盘：高频计分合并写入；进程退出前须调 flushSave() 收尾 */
  saveSoon() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.flushSave(), this.saveDebounceMs);
    if (!this._maxWaitTimer) {
      this._maxWaitTimer = setTimeout(() => this.flushSave(), this.saveMaxWaitMs);
    }
  }

  /** 把待写数据立即落盘（SIGINT / beforeExit / 定时兜底调用）；绝不向上抛异常 */
  flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this._maxWaitTimer) { clearTimeout(this._maxWaitTimer); this._maxWaitTimer = null; }
    if (!this._dirty || !this.map.size) return;
    try { this.save(); } catch (e) { this.log('warn', '[leaderboard] 落盘异常:', e.message); }
  }

  /** 旧单字段结构 {wins,score,floors} → 新分玩法结构；已迁移过则原样返回 */
  migrateRecord(r) {
    if (r.guess_score !== undefined || r.chengyu_score !== undefined || r.totalScore !== undefined) return r;
    const rec = {
      key: r.key, name: r.name, avatar: r.avatar || '',
      guess_wins: 0, guess_score: 0,
      chengyu_wins: 0, chengyu_score: 0, chengyu_floors: 0,
    };
    if (r.floors) {
      // 有叠楼数 → 接龙玩家：旧 wins 全归 chengyu_wins，score 归 chengyu_score
      rec.chengyu_floors = Number(r.floors) || 0;
      rec.chengyu_wins = Number(r.wins || 0);
      rec.chengyu_score = Number(r.score || 0);
    } else {
      // 无叠楼数 → 猜数字玩家
      rec.guess_wins = Number(r.wins || 0);
      rec.guess_score = Number(r.score || 0);
    }
    return rec;
  }

  /* ───────────── 查询 ───────────── */

  /** 玩家总积分 = 各玩法积分之和（仅统计已注册玩法的字段） */
  totalScore(r) {
    let sum = 0;
    for (const f of this.fields.values()) sum += Number(r[f.score]) || 0;
    return sum;
  }

  /**
   * 全局榜单（按总积分降序，同分按首个玩法 wins，再按 floors 字段）。
   * 仅保留有积分的玩家；n 传数字时截断前 n 名。
   */
  topList(n = null) {
    const list = Array.from(this.map.values())
      .map(r => ({ ...r, totalScore: this.totalScore(r) }))
      .filter(r => r.totalScore > 0);
    const tie1 = this._firstField('wins');
    const tie2 = this._firstField('floors');
    list.sort((a, b) =>
      (b.totalScore - a.totalScore) ||
      (Number(b[tie1]) || 0) - (Number(a[tie1]) || 0) ||
      (Number(b[tie2]) || 0) - (Number(a[tie2]) || 0));
    const capped = n ? list.slice(0, n) : list;
    return capped.map((r, i) => ({ ...r, rank: i + 1 }));
  }

  _firstField(kind) {
    for (const f of this.fields.values()) if (f[kind]) return f[kind];
    return '';
  }

  /**
   * 单玩法专属榜（各游戏排行榜互不混排）：仅含玩过该游戏的玩家，
   * 按该游戏自己的字段排序 —— wins（胜场/MVP 次数）降序 → score（该玩法积分）降序 → floors 降序。
   * 返回记录中的 totalScore 重写为「该玩法积分」，各游戏展示屏得分列即显示本玩法成绩
   * （各 stage 统一渲染 r.totalScore，无需逐游戏改动）。
   * 数据仍存同一份 data/leaderboard.json（按玩法分字段），但每个游戏的榜单只读写自己的字段，
   * 互相不可见 —— 未注册的 gameId 回退全局榜（topList）。
   */
  gameTopList(gameId, n = null) {
    const f = this.fields.get(gameId);
    if (!f) return this.topList(n);
    const num = v => Number(v) || 0;
    const list = Array.from(this.map.values())
      .filter(r => num(r[f.wins]) > 0 || num(r[f.score]) > 0 || (f.floors && num(r[f.floors]) > 0))
      .sort((a, b) =>
        num(b[f.wins]) - num(a[f.wins]) ||
        num(b[f.score]) - num(a[f.score]) ||
        (f.floors ? num(b[f.floors]) - num(a[f.floors]) : 0));
    const capped = n ? list.slice(0, n) : list;
    return capped.map((r, i) => ({ ...r, totalScore: num(r[f.score]), rank: i + 1 }));
  }

  /* ───────────── 写入 ───────────── */

  /**
   * 玩家各玩法加分（跨游戏累计）
   * @param {string} gameId 玩法 id（决定写哪个玩法的字段）
   * @param {object} entry { userId, user, avatar }
   * @param {number} score 本局得分
   * @param {number} floors 盖楼层数（仅接龙类玩法使用，默认 0）
   */
  award(gameId, entry, score, floors = 0) {
    const key = entry.userId || entry.user || '匿名';
    const rec = this.map.get(key) || {
      key, name: entry.user || '匿名', avatar: '',
      guess_wins: 0, guess_score: 0,
      chengyu_wins: 0, chengyu_score: 0, chengyu_floors: 0,
    };
    rec.name = entry.user || rec.name;
    if (entry.avatar) rec.avatar = entry.avatar;
    const f = this.fields.get(gameId);
    if (f) {
      rec[f.wins] = (rec[f.wins] || 0) + 1;
      rec[f.score] = (rec[f.score] || 0) + Math.round(score || 0);
      if (f.floors && floors) rec[f.floors] = (rec[f.floors] || 0) + floors;
    } else {
      // 兼容未注册玩法的调用：写首个已注册玩法的字段，避免数据丢失
      const first = [...this.fields.values()][0];
      if (first) {
        rec[first.wins] = (rec[first.wins] || 0) + 1;
        rec[first.score] = (rec[first.score] || 0) + Math.round(score || 0);
      }
    }
    this.map.set(key, rec);
    this.saveSoon();
    this.log('info', `[leaderboard] ${rec.name} 累计 ${this.totalScore(rec)} 分`);
    return rec;
  }

  /**
   * 只加分不加胜场（败方参与奖 / MVP 加成 / 入队奖等不计 wins 的场景）
   * 字段未注册时静默忽略（与 award 的兜底策略不同：这里宁可不写也不写错字段）
   */
  awardScore(gameId, entry, score) {
    const s = Math.round(Number(score) || 0);
    if (!s) return null;
    const f = this.fields.get(gameId);
    if (!f) return null;
    const key = entry.userId || entry.user || '匿名';
    const rec = this.map.get(key) || {
      key, name: entry.user || '匿名', avatar: '',
      guess_wins: 0, guess_score: 0,
      chengyu_wins: 0, chengyu_score: 0, chengyu_floors: 0,
    };
    rec.name = entry.user || rec.name;
    if (entry.avatar) rec.avatar = entry.avatar;
    rec[f.score] = (rec[f.score] || 0) + s;
    this.map.set(key, rec);
    this.saveSoon();
    this.log('info', `[leaderboard] ${rec.name} +${s}（不计胜场）→ 累计 ${this.totalScore(rec)} 分`);
    return rec;
  }
}

module.exports = { SharedLeaderboard };
