/* ══════════════════════════════════════════════════════════════════
   stage-scene.js — 红蓝大作战 · Canvas 战场渲染（games/redblue/public）
   ══════════════════════════════════════════════════════════════════
   拔河轮：麻绳/绳结/胜负线/两端拉绳队伍 + 能量条
   守城轮：夜色战场/攻城怪物(血量条)/城墙(耐久条/裂纹) + 能量条
   特效：粒子爆散 / 冲击波 / 飘字 / 方向箭头 / 震屏 / 全屏闪光
        （FxEngine 提供，见 /common/fx.js；DOM 只负责面板与横幅）

   用法：
     const scene = new RBCanvas(document.getElementById('battleCanvas'), {
       onBanner: (text, cls) => showBanner(text, cls),   // 冲锋/全力一击横幅
     });
     scene.setState(st);   // 每次 SSE state 到达调用；内部做状态差分自动触发特效
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const MONSTER_EMOJI = {
    '史莱姆王': '👾', '暗影狼群': '🐺', '深渊触手': '🐙', '暗夜蝠王': '🦇',
    '钢铁巨像': '🤖', '幽冥鬼龙': '🐉',
  };
  const BOSS_EMOJI = {
    '远古魔像': '🗿', '深渊领主': '👹', '黑夜君王': '😈', '混沌巨兽': '🐲', '星陨之灵': '🌠',
  };
  const RED = '#f87171', BLUE = '#4da3ff', GOLD = '#ffd166';

  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeOut(k) { return 1 - (1 - k) * (1 - k); }

  class RBCanvas {
    constructor(canvas, opts = {}) {
      this.fx = new FxEngine(canvas);
      this.onBanner = opts.onBanner || null;
      this.mode = 'tug';                 // tug | siege
      this.pos = 50; this.posDisp = 50;  // 战线目标 / 显示（平滑插值）
      this.winLine = 90; this.surgeThr = 50;
      this.teams = {
        red: { name: '猛虎营', count: 0, energy: 0 },
        blue: { name: '飞鲨营', count: 0, energy: 0 },
      };
      this.siege = null;                 // { monsterName, hp, hpMax, wallHp, wallHpMax, energy, crackN }
      this.knotS = 1; this.knotV = 0;    // 绳结弹跳弹簧
      this.pullDir = 0; this.pullDur = 0; // 队伍拉动倾斜
      this.vel = 0;                      // 战线弹簧速度：丝滑推进 + 轻微过冲，杜绝「跳格」
      this.pullCycle = 0;                // 发力循环相位（队伍持续拉绳的姿态动画）
      this.pullT = 99;                   // 距上次推进时长（刚发力=紧绷，静止久=呼吸摆动/僵持摇晃）
      // ── 阵营对战（shooter）与头像队伍共用 ──
      this.crew = { red: [], blue: [] }; // 双方成员（top5，观众头像即枪手/拉绳队）
      this.bubbles = [];                 // 说话气泡 { side, idx, text, until }
      this._lastBubbleT = 0;
      this.bullets = new Map();          // id → { side, strength, frac, lane }（frac 客户端逐帧推演）
      this.travelMs = 1400;              // 子弹飞行时长（对齐服务端 cfg.shooterTravelMs）
      this.boss = null;                  // shooterBoss 模式：中央 Boss { name, hp, hpMax }
      this.wall = null;                  // Boss 战基地墙 { hp, hpMax }（siege 模式也复用）
      this.shooter = null;               // { redHp, blueHp, blitz, redName, blueName }
      this.shooterPrev = null;           // 上一帧 shooter 快照（HP 差分）
      this._imgCache = new Map();        // 头像图片缓存
      this._prev = null;                 // 上一帧 publicState 快照（差分特效）
      this._atkT = 0;                    // 攻击飘字节流
      this._cracks = [];                 // 城墙裂纹（按损坏程度生成一次）
      this.fx.onDraw = (c, w, h, dt, t) => this._draw(c, w, h, dt, t);
      this.fx.start();
    }

    /* ───────────── 状态接入 + 差分特效 ───────────── */
    setState(s) {
      const p = this._prev;
      this._prev = s;
      if (!s) return;
      const isSiege = s.mode === 'siege';
      const isShoot = s.mode === 'shooter' || s.mode === 'shooterBoss';
      this.mode = isSiege ? 'siege' : (isShoot ? s.mode : 'tug');
      this.boss = s.boss ? { name: s.boss.name, hp: s.boss.hp, hpMax: Math.max(1, s.boss.hpMax) } : null;
      this.wall = s.wall ? { hp: s.wall.hp, hpMax: Math.max(1, s.wall.hpMax) } : null;
      this.winLine = (s.cfg && s.cfg.winLine) || 90;
      this.surgeThr = (s.cfg && s.cfg.surgeThreshold) || 50;
      this.pos = Number(s.pos) || 50;
      const r = s.red || {}, b = s.blue || {};
      this.teams.red = { name: r.name || '猛虎营', count: r.count || 0, energy: Number(r.energy) || 0 };
      this.teams.blue = { name: b.name || '飞鲨营', count: b.count || 0, energy: Number(b.energy) || 0 };
      this.siege = s.monster ? {
        monsterName: s.monster.name, hp: s.monster.hp, hpMax: Math.max(1, s.monster.hpMax),
        wallHp: s.wall ? s.wall.hp : 0, wallHpMax: Math.max(1, (s.wall && s.wall.hpMax) || 1),
        energy: Number(s.siegeEnergy) || 0,
      } : null;

      // ── 队伍头像（观众即枪手/拉绳队） ──
      this.crew.red = ((r.top) || []).map(m => ({ name: m.name, avatar: m.avatar || '' }));
      this.crew.blue = ((b.top) || []).map(m => ({ name: m.name, avatar: m.avatar || '' }));

      // 换轮（roundNo 变化/首帧）：清旧特效与子弹，但快照照常同步（差分特效跳过）
      const isNewRound = !p || p.roundNo !== s.roundNo;
      if (isNewRound) {
        this.fx.clear(); this.knotS = 1;
        this.bullets.clear();
        this.shooterPrev = null;
      }

      // ── 弹幕枪战：血量/子弹快照（首帧/换轮首帧也同步，避免漏掉当前对战状态） ──
      if (isShoot && s.shooter) {
        this.travelMs = (s.cfg && s.cfg.shooterTravelMs) || this.travelMs;
        this.shooter = {
          redHp: s.shooter.redHp, blueHp: s.shooter.blueHp,
          blitz: s.shooter.blitz,
          redName: r.name || '红队', blueName: b.name || '蓝队',
        };
        this._syncBullets(s.shooter.bullets || []);
      }

      if (isNewRound) { this._prev = s; return; }   // 差分特效仅对同轮次的状态触发

      // ── 拔河：战线位移 → 拉动/冲锋 ──
      if (!isSiege && !isShoot && p && (s.status === 'tugging' || s.status === 'revealed')) {
        const d = this.pos - (Number(p.pos) || 50);
        if (Math.abs(d) >= 0.35) {
          const side = d > 0 ? 'red' : 'blue';
          const amt = Math.abs(d) >= 5 ? Math.round(Math.abs(d)) : Math.round(Math.abs(d) * 10) / 10;
          const px = this._posX();
          this.fx.float(px, this._trackY() - 34, `+${amt}`, {
            color: side === 'red' ? RED : BLUE, size: amt >= 5 ? 20 : 15,
          });
          this.fx.chev(px, side, side === 'red' ? RED : BLUE, this._trackY());
          this.knotV += 0.85;                       // 绳结弹跳
          this.pullDir = side === 'red' ? 1 : -1; this.pullDur = 0.8;
          this.pullT = 0;                           // 发力态：队伍立刻切换为奋力拉绳
          const footY = this._trackY() + this._trackH() / 2 + 6;
          const footX = side === 'red' ? 30 : this.fx.w - 30;
          this.fx.burst(footX, footY, { count: 8, colors: ['#cbd5e1', '#94a3b8'], speed: 26, size: 1.8, life: 0.55, grav: -8 }); // 脚下尘烟
          if (Math.random() < 0.5) this.fx.float(footX + (Math.random() - 0.5) * 30, this._trackY() - 50, '💦', { size: 11, life: 0.8, rise: 22 });
          if (amt >= 5) {                          // 全军冲锋
            this.fx.ring(px, this._trackY(), { color: GOLD, r1: 120 });
            this.fx.flash(0.16, '255,214,102');
            this.fx.shakeSec(8, 0.42);
            if (this.onBanner) this.onBanner(`${this.teams[side].name} 全军冲锋！`, side);
          } else {
            this.fx.shakeSec(3, 0.22);
          }
        }
      }

      // ── 守城：怪物掉血 / 城墙掉血 / 全力一击 ──
      if (isSiege && p && s.monster && p.monster) {
        const dh = p.monster.hp - s.monster.hp;
        const now = performance.now();
        if (dh > 0) {
          const px = this._monsterX(this.fx.w);
          const py = this._monsterY(this.fx.h);
          this.fx.burst(px, py, { count: 26, colors: ['#ff9d9d', '#ff5d5d', '#ffd166'], speed: 130, size: 2.6, life: 0.7 });
          if (now - this._atkT > 200) {            // 攻击飘字节流（弹幕高频）
            this._atkT = now;
            this.fx.float(px, py - 38, `-${dh}`, { color: '#ff9d9d', size: 14 });
          }
          this.fx.shakeSec(2.5, 0.18);
        }
        if (s.monster.hp <= 0) {                   // 击杀爆炸
          this.fx.burst(px, py, { count: 120, colors: ['#ffd166', '#ff8ae2', '#5dff9c', '#ff5d5d'], speed: 260, size: 4, life: 1.1 });
          this.fx.ring(px, py, { color: GOLD, r1: 160, width: 10 });
          this.fx.flash(0.3, '255,214,102');
          this.fx.shakeSec(9, 0.5);
        }
        const wd = p.wall ? p.wall.hp - (s.wall ? s.wall.hp : 0) : 0;
        if (wd > 0) {
          const wx = this.fx.w - 22, wy = this._wallTop(this.fx.h);
          this.fx.float(wx, wy - 14, `🧱 -${wd}`, { color: '#cbd5e1', size: 13 });
          this.fx.burst(wx, wy + 30, { count: 16, colors: ['#94a3b8', '#cbd5e1'], speed: 80, size: 2.2, life: 0.6 });
          this.fx.shakeSec(3.5, 0.25);
        }
        if (s.wall && s.wall.hp <= s.wall.hpMax * 0.3 && (!p.wall || p.wall.hp > s.wall.hp)) {
          this.fx.flash(0.12, '255,93,93');
        }
        if (p.surges != null && (s.surges || 0) > (p.surges || 0)) {   // 全力一击
          const px = this._monsterX(this.fx.w), py = this._monsterY(this.fx.h);
          this.fx.ring(px, py, { color: GOLD, r1: 150, width: 9 });
          this.fx.flash(0.28, '255,214,102');
          this.fx.shakeSec(7, 0.4);
          if (this.onBanner) this.onBanner('全 场 全 力 一 击 ！', 'gold');
          this.fx.float(px, py - 44, '⚡ 全力一击', { color: GOLD, size: 18 });
        }
      }
    }

    /* ───────────── 布局坐标工具 ───────────── */
    _pad() { return 10; }
    _trackY() { return this.fx.h * 0.44; }
    _trackH() { return Math.min(44, this.fx.h * 0.3); }
    _posX() { return this._pad() + (this.posDisp / 100) * (this.fx.w - this._pad() * 2); }
    _wallTop(h) { return h * 0.2; }
    _monsterX(w) { return lerp(w * 0.10, w * 0.60, easeOut(1 - (this.siege ? this.siege.hp / this.siege.hpMax : 1))); }
    _monsterScale() {
      const frac = this.siege ? this.siege.hp / this.siege.hpMax : 1;
      return 30 + (1 - frac) * 26;
    }
    _monsterY(h) { return h * 0.74 - this._monsterScale() * 0.5 + Math.sin(performance.now() / 430) * 3.5; }

    /* ───────────── 主绘制（每帧由 FxEngine 回调） ───────────── */
    _draw(c, w, h, dt, t) {
      // 战线弹簧运动：速度积分 + 阻尼，推进不再「跳格」，带轻微过冲的橡皮筋手感
      this.vel += (this.pos - this.posDisp) * 22 * dt;
      this.vel *= Math.max(0, 1 - 7 * dt);
      this.posDisp += this.vel * dt;
      if (this.posDisp < -2) { this.posDisp = -2; this.vel = 0; }
      if (this.posDisp > 102) { this.posDisp = 102; this.vel = 0; }
      this.pullCycle += dt;                       // 发力相位推进（不受状态推送影响，持续在动）
      this.pullT = Math.min(8, this.pullT + dt);  // 距上次推进时长
      const k = this.knotS;
      this.knotV += (1 - k) * 120 * dt - k * 0.6 * dt;   // 绳结弹簧 + 阻尼
      this.knotS += this.knotV * dt;
      if (this.knotS < 0.2) this.knotS = 0.2;
      if (this.knotS > 1.8) this.knotS = 1.8;
      if (this.pullDur > 0) this.pullDur -= dt;

      if (this.mode === 'siege') this._drawSiege(c, w, h, t);
      else if (this.mode === 'shooter') this._drawShoot(c, w, h, t, dt);
      else this._drawTug(c, w, h, t);
    }

    /* ── 拔河场景 ── */
    _drawTug(c, w, h, t) {
      const pad = this._pad();
      const ty = this._trackY(), th = this._trackH();
      const x0 = pad, x1 = w - pad;
      const px = this._posX();
      // 静止越久「呼吸」摆动越明显；刚推进（pullT 小）时绳体紧绷不晃
      const idle = Math.min(1, this.pullT / 2.2);

      // ── 战场氛围底色：两端阵营辉光
      const bg = c.createLinearGradient(0, 0, w, 0);
      bg.addColorStop(0, 'rgba(248,113,113,0.10)');
      bg.addColorStop(0.32, 'rgba(10,14,26,0)');
      bg.addColorStop(0.68, 'rgba(10,14,26,0)');
      bg.addColorStop(1, 'rgba(77,163,255,0.10)');
      c.fillStyle = bg; c.fillRect(0, 0, w, h);

      // 漂浮尘埃（持续缓慢漂移，画面时刻在动）
      c.fillStyle = '#ffd166';
      for (let i = 0; i < 16; i++) {
        const mx = ((i * 137.508 + t * (5 + (i % 3) * 2)) % (w + 40)) - 20;
        const my = ty - 58 + Math.sin(t * 0.7 + i * 2.1) * 12 + (i % 5) * 13;
        c.globalAlpha = 0.18 + 0.14 * Math.sin(t * 1.3 + i);
        c.fillRect(mx, my, 2.2, 2.2);
      }
      c.globalAlpha = 1;

      // ── 轨道底座
      c.fillStyle = 'rgba(10,14,26,0.55)';
      this._rr(c, x0, ty - th / 2, x1 - x0, th, th / 2);
      c.fill();
      c.strokeStyle = 'rgba(148,163,184,0.22)';
      c.lineWidth = 1;
      this._rr(c, x0, ty - th / 2, x1 - x0, th, th / 2);
      c.stroke();

      // ── 胜负线（逼近时高亮 + 线帽）
      for (const [frac, color] of [[this.winLine / 100, 'rgba(248,113,113,0.75)'], [(100 - this.winLine) / 100, 'rgba(77,163,255,0.75)']]) {
        const lx = x0 + frac * (x1 - x0);
        const near = Math.abs(this.posDisp - frac * 100) < 12;
        c.strokeStyle = near ? color.replace('0.75', '1') : 'rgba(148,163,184,0.3)';
        c.setLineDash([4, 4]);
        c.beginPath(); c.moveTo(lx, ty - th / 2 - 6); c.lineTo(lx, ty + th / 2 + 6); c.stroke();
        c.setLineDash([]);
        c.fillStyle = near ? color.replace('0.75', '1') : 'rgba(148,163,184,0.5)';
        c.beginPath(); c.moveTo(lx - 4, ty - th / 2 - 6); c.lineTo(lx + 6, ty - th / 2 - 20); c.lineTo(lx + 4, ty - th / 2 - 6); c.closePath(); c.fill();
      }

      // ── 麻绳：红/蓝两段 + 交叉辫纹 + 张力线 + 高光 + 光扫
      const wob = Math.sin(t * 1.7) * 1.3 * (0.35 + idle * 0.65);   // 绳体轻微起伏
      c.save();
      this._clipRR(c, x0, ty - th / 2, x1 - x0, th, th / 2);
      const gR = c.createLinearGradient(x0, 0, px, 0);
      gR.addColorStop(0, '#7f1d1d'); gR.addColorStop(1, RED);
      c.fillStyle = gR; c.fillRect(x0, ty - th / 2, px - x0, th);
      const gB = c.createLinearGradient(px, 0, x1, 0);
      gB.addColorStop(0, BLUE); gB.addColorStop(1, '#1e3a8a');
      c.fillStyle = gB; c.fillRect(px, ty - th / 2, x1 - px, th);
      // 交叉辫纹（两向斜纹，编织感；随战线滑动）
      c.strokeStyle = 'rgba(0,0,0,0.14)'; c.lineWidth = 2.5;
      for (let xx = x0 - th - (this.posDisp % 14); xx < x1; xx += 14) {
        c.beginPath(); c.moveTo(xx, ty + th / 2); c.lineTo(xx + th * 0.8, ty - th / 2); c.stroke();
      }
      c.strokeStyle = 'rgba(255,255,255,0.06)'; c.lineWidth = 2;
      for (let xx = x0 - th - 7 - (this.posDisp % 14); xx < x1; xx += 14) {
        c.beginPath(); c.moveTo(xx, ty - th / 2); c.lineTo(xx + th * 0.8, ty + th / 2); c.stroke();
      }
      // 绳体张力线（随起伏微摆，拉紧感的连续动画）
      c.strokeStyle = 'rgba(255,255,255,0.13)'; c.lineWidth = 1.6;
      c.beginPath();
      c.moveTo(x0, ty + wob * 0.4);
      const segs = 24;
      for (let i = 1; i <= segs; i++) {
        const qx = x0 + (x1 - x0) * (i / segs);
        c.lineTo(qx, ty + wob * Math.sin(i * 0.9 + t * 1.7) * 0.8);
      }
      c.stroke();
      // 高光条
      c.fillStyle = 'rgba(255,255,255,0.09)';
      c.fillRect(x0, ty - th * 0.22, x1 - x0, th * 0.2);
      // 光扫（沿绳滑过的亮带）
      const sx = x0 + ((t * 26) % (x1 - x0));
      const sheen = c.createLinearGradient(sx - 28, 0, sx + 28, 0);
      sheen.addColorStop(0, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.5, 'rgba(255,255,255,0.18)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = sheen; c.fillRect(sx - 28, ty - th / 2, 56, th);
      c.restore();

      // ── 绳结 + 彩旗（持续飘扬）
      const rk = 9 * this.knotS;
      const glowR = rk * (2.6 + 0.4 * Math.sin(t * 5));
      const glow = c.createRadialGradient(px, ty, 1, px, ty, glowR);
      glow.addColorStop(0, 'rgba(255,215,120,0.6)');
      glow.addColorStop(1, 'rgba(255,215,120,0)');
      c.fillStyle = glow;
      c.beginPath(); c.arc(px, ty, glowR, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fde68a';
      c.beginPath(); c.arc(px, ty, rk, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#b45309';
      c.beginPath(); c.arc(px, ty, rk * 0.55, 0, Math.PI * 2); c.fill();
      // 旗杆 + 波浪旗面
      c.save();
      c.translate(px, ty);
      c.rotate((this.posDisp > 50 ? 0.5 : -0.5) * (this.pullDur > 0 ? 1.8 : 1));
      c.strokeStyle = '#e2e8f0'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(0, -rk); c.lineTo(0, -rk - 16); c.stroke();
      const wv = Math.sin(t * 7) * 2.4;
      c.fillStyle = this.posDisp >= 50 ? RED : BLUE;
      c.beginPath();
      c.moveTo(0, -rk - 15);
      c.lineTo(14, -rk - 12 + wv * 0.4);
      c.lineTo(9, -rk - 9 + wv);
      c.lineTo(0, -rk - 9);
      c.closePath(); c.fill();
      c.restore();

      // ── 两端阵营队伍（双排羊，持续发力：推进=奋力、静止=僵持摇晃）
      this._drawCrew(c, w, 'red', t);
      this._drawCrew(c, w, 'blue', t);

      // 能量条
      this._drawEnergy(c, w, h);
    }

    /** 双排头像队伍：每名观众独立起伏相位 + 整体发力动作（推进后 2s 内奋力前倾，之后缓慢回落僵持） */
    _drawCrew(c, w, side, t) {
      const ty = this._trackY();
      const dir = side === 'red' ? 1 : -1;
      const effort = Math.max(0, Math.min(1, 2 - this.pullT));          // 刚推进发力大
      const pullLean = 0.14 + 0.15 * effort + 0.05 * Math.sin(this.pullCycle * 4.4);
      const rise = Math.max(0, Math.sin(this.pullCycle * 2.6)) * 0.04 * effort; // 发力时小幅上窜
      const crew = this.crew[side];
      for (let i = 0; i < 8; i++) {
        const row = i % 2, idx = (i - row) / 2;
        const m = crew[idx] || null;
        const x = side === 'red'
          ? 24 + idx * 17 + row * 7
          : w - 24 - idx * 17 - row * 7;
        const y = ty - 26 - row * 18 + Math.sin(t * 5 + i * 1.14) * 2.2 + rise * 30;
        this._drawAvatar(c, x, y, (row === 0 ? 11 : 9.5), m, side, dir * (pullLean + Math.sin(t * 2.2 + i) * 0.05));
      }
    }

    /* ───────────── 头像 / 气泡 / 枪战共用工具 ───────────── */

    /** 画观众头像（圆形裁切；加载失败回退首字圆） */
    _drawAvatar(c, x, y, r, member, side, rotate = 0) {
      c.save();
      c.translate(x, y);
      c.rotate(rotate || 0);
      // 队伍描边环
      c.beginPath(); c.arc(0, 0, r + 1.5, 0, Math.PI * 2);
      c.fillStyle = side === 'red' ? 'rgba(248,113,113,0.85)' : 'rgba(77,163,255,0.85)';
      c.fill();
      c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2);
      c.fillStyle = '#0d1220';
      c.fill();
      c.clip();   // 头像裁切
      const im = member && member.avatar ? this._avatarImg(member.avatar) : null;
      if (im && im.complete && im.naturalWidth > 0) {
        c.drawImage(im, -r, -r, r * 2, r * 2);
      } else {
        c.fillStyle = side === 'red' ? '#7f1d1d' : '#1e3a8a';
        c.fillRect(-r, -r, r * 2, r * 2);
        c.fillStyle = '#fff';
        c.font = '700 ' + (r * 1.2) + 'px sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(member && member.name ? member.name[0] : '?', 0, 1);
      }
      c.restore();
    }

    _avatarImg(url) {
      let im = this._imgCache.get(url);
      if (!im) {
        im = new Image();
        im.referrerPolicy = 'no-referrer';
        im.src = url;
        this._imgCache.set(url, im);
      }
      return im;
    }

    /** 说话气泡：周期性随机一名观众开口（双排/枪手通用） */
    _drawBubbles(c, w, h, t) {
      if (t - this._lastBubbleT > 3.4 && this.bubbles.length < 2) {
        this._lastBubbleT = t;
        const side = Math.random() < 0.5 ? 'red' : 'blue';
        const crew = this.crew[side];
        if (crew && crew.length) {
          const idx = (Math.random() * crew.length) | 0;
          const texts = ['加油!!', '冲啊!!', '稳住别浪', '压上去!!', '看我表演', '干他!!', '我子弹多', '顶住!!', '别松手!!', '⚡⚡⚡'];
          this.bubbles.push({
            side, idx,
            text: texts[(Math.random() * texts.length) | 0],
            until: t + 2.4,
          });
          if (this.bubbles.length > 2) this.bubbles.shift();
        }
      }
      this.bubbles = this.bubbles.filter(b => b.until > t);
      for (const bub of this.bubbles) {
        const pos = this.mode === 'shooter' ? this._shootCrewPos(bub.side, bub.idx) : this._tugCrewPos(bub.side, bub.idx % 4);
        if (!pos) continue;
        const text = bub.text;
        const bw = Math.max(30, text.length * 7.5 + 12), bh = 17;
        const bx = Math.max(8, Math.min(w - bw - 8, pos.x - bw / 2));
        const by = pos.y - 34;
        if (by < 4) continue;
        // 气泡（白底圆角 + 小尾巴）
        c.save();
        c.fillStyle = 'rgba(255,255,255,0.94)';
        this._rr(c, bx, by, bw, bh, 8.5);
        c.fill();
        c.beginPath();
        c.moveTo(pos.x - 4, by + bh - 1);
        c.lineTo(pos.x, by + bh + 5);
        c.lineTo(pos.x + 4, by + bh - 1);
        c.closePath(); c.fill();
        c.fillStyle = '#1e293b';
        c.font = '700 11px sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(text, bx + bw / 2, by + bh / 2 + 0.5);
        c.restore();
      }
    }

    _tugCrewPos(side, idx) {
      const w = this.fx.w;
      const x = side === 'red' ? 24 + idx * 17 : w - 24 - idx * 17;
      return { x, y: this._trackY() - 26 };
    }

    _shootCrewPos(side, idx) {
      const w = this.fx.w;
      const x = side === 'red' ? 34 + idx * 27 : w - 34 - idx * 27;
      return { x, y: this.fx.h * 0.5 - 46 };
    }

    /** 子弹快照同步：只做「防漂移软校正 + 兜底移除」，位置由客户端公式逐帧推演（直线飞行不闪现） */
    _syncBullets(snap) {
      const live = new Set();
      for (const sb of snap) {
        live.add(sb.id);
        const e = this.bullets.get(sb.id);
        if (!e) {
          // 快照里出现但我们没收到 fire 事件（断线重连/事件丢失）：从枪口出发，稍落后补位
          this.bullets.set(sb.id, {
            side: sb.side, strength: sb.strength,
            frac: Math.max(0, sb.frac - 0.25),
            lane: (((sb.id * 2.399) % 1) - 0.5) * 12,
          });
        } else {
          // 只慢补、从不回拉（服务端进度只会前进；回拉会造成视觉回跳）
          const diff = sb.frac - e.frac;
          if (diff > 0.02) e.frac += diff * 0.25;
          e.strength = sb.strength;
        }
      }
      for (const [id, e] of this.bullets) {
        if (live.has(id)) continue;
        // 服务端已移除（命中/抵消/超上限）：原地爆点后删除
        this._burstAt(e, 8);
        this.bullets.delete(id);
      }
    }

    /** 在子弹当前位置爆一小团火花 */
    _burstAt(e, count = 8) {
      const x = 14 + Math.max(-0.02, Math.min(1.02, e.frac)) * (this.fx.w - 28);
      const y = this.fx.h * 0.5 - 26 + e.lane;
      this.fx.burst(x, y, {
        count, colors: [e.side === 'red' ? RED : BLUE, '#e2e8f0', e.strength >= 3 ? GOLD : '#e2e8f0'],
        speed: 80, size: 2.4, life: 0.4,
      });
    }

    /** 战斗小事件（服务端 guess 通道推送：fire / hit / collide）
        fire=枪口同步建弹（从 frac 0 出发）；hit=立即删除到达的子弹；collide=双方各删一颗 */
    onSceneEvent(e) {
      if (!e || this.mode !== 'shooter') return;
      const ty = this.fx.h * 0.5;
      if (e.type === 'fire') {
        const p = this._shootCrewPos(e.side, 0);
        const tipX = p.x + (e.side === 'red' ? 26 : -26);
        this.fx.burst(tipX, p.y, {
          count: 10, colors: [e.side === 'red' ? RED : BLUE, '#fff7d6'],
          speed: 130, size: 2.6, life: 0.4,
        });
        // 无本地子弹时按枪口建一颗（正常路径 fire 先于状态推送到达）
        let found = null;
        for (const b of this.bullets.values()) if (b.side === e.side && b.frac < 0.05) { found = b; break; }
        if (!found) {
          const id = 1000000 + Math.floor(Math.random() * 1e6);
          this.bullets.set(id, { side: e.side, strength: 1, frac: 0, lane: (Math.random() - 0.5) * 12 });
        }
      } else if (e.type === 'collide') {
        // 各删一颗「相向且进度和最近 1」的子弹（服务端同规则），爆点在相遇处
        let pair = null, best = 1;
        for (const a of this.bullets.values()) {
          for (const b of this.bullets.values()) {
            if (a.side === b.side) continue;
            const d = Math.abs(a.frac + b.frac - 1);
            if (d < best) { best = d; pair = [a, b]; }
          }
        }
        if (pair) {
          this._burstAt(pair[0], 7);
          this._burstAt(pair[1], 7);
          this.bullets.delete(pair[0].id ?? this._keyOf(pair[0]));
          this.bullets.delete(pair[1].id ?? this._keyOf(pair[1]));
        }
        this.fx.ring(this.fx.w / 2, ty - 24, { color: '#fde68a', r1: 44, width: 4, life: 0.35, alpha0: 0.8 });
        this.fx.burst(this.fx.w / 2, ty - 24, { count: 18, colors: [GOLD, RED, BLUE], speed: 160, size: 3, life: 0.5 });
      } else if (e.type === 'hit') {
        // 删除该方「进度最大」的子弹（= 刚到达的这颗）；PVP 爆在敌侧边线，Boss 战爆在中央 Boss 身上
        let hit = null, maxF = -1;
        for (const b of this.bullets.values()) {
          if (b.side === e.side && b.frac > maxF) { maxF = b.frac; hit = b; }
        }
        const isBoss = this.mode === 'shooterBoss';
        const hx = isBoss ? this.fx.w / 2 : (e.side === 'red' ? 30 : this.fx.w - 30);
        const hy = ty - (isBoss ? 10 : 40);
        if (hit) {
          this._burstAt(hit, isBoss ? 16 : 18);
          this.bullets.delete(hit.id ?? this._keyOf(hit));
        }
        this.fx.burst(hx, hy, {
          count: isBoss ? 20 : 24,
          colors: e.side === 'red' ? ['#ff8a8a', '#ff5d5d', '#ffd166'] : ['#8ab8ff', '#4da3ff', '#ffd166'],
          speed: 120, size: 3.2, life: 0.55,
        });
        this.fx.shakeSec(4, 0.25);
        if (e.strength != null) this.fx.float(this.fx.w / 2, isBoss ? 84 : 34, `-${e.strength}`, { color: GOLD, size: e.strength >= 3 ? 20 : 15 });
        if (e.hp != null && e.hp <= 0) {
          // Boss 被击破 / 一方血量清零：大爆 + 金闪
          this.fx.burst(this.fx.w / 2, ty - 10, { count: 120, colors: [GOLD, '#ff8ae2', '#5dff9c', '#ff5d5d'], speed: 260, size: 4, life: 1.1 });
          this.fx.ring(this.fx.w / 2, ty - 10, { color: GOLD, r1: 150, width: 10 });
          this.fx.flash(0.35, '255,214,102');
          this.fx.shakeSec(10, 0.5);
        }
      } else if (e.type === 'bossAtk') {
        // Boss 反击：基地墙被打 → 墙位红闪 + 震屏
        this.fx.burst(this.fx.w / 2, 46, { count: 14, colors: ['#f87171', '#94a3b8', '#ffd166'], speed: 90, size: 2.6, life: 0.5 });
        this.fx.float(this.fx.w / 2, 30, `🧱 -${e.dmg || 0}`, { color: '#f87171', size: 13 });
        this.fx.shakeSec(5, 0.3);
        if (e.hp != null && e.hp <= 0) { this.fx.flash(0.3, '255,80,80'); this.fx.shakeSec(10, 0.5); }
      }
    }

    _keyOf(target) {
      for (const [id, b] of this.bullets) if (b === target) return id;
      return null;
    }

    /* ── 弹幕枪战场景（PvZ 风格） ── */
    _drawShoot(c, w, h, t, dt) {
      const sh = this.shooter || {
        redHp: 100, blueHp: 100, blitz: { red: 0, blue: 0 },
        redName: '红队', blueName: '蓝队',
      };
      const ty = h * 0.5;
      const bossMode = this.mode === 'shooterBoss';
      const boss = this.boss;

      // 战场底色：夜空 + 中央交锋带
      const sky = c.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#0b1226'); sky.addColorStop(0.6, '#101a33'); sky.addColorStop(1, '#0a0f1e');
      c.fillStyle = sky; c.fillRect(0, 0, w, h);
      const lane = c.createLinearGradient(0, 0, w, 0);
      lane.addColorStop(0, 'rgba(248,113,113,0.10)');
      lane.addColorStop(0.5, 'rgba(148,163,184,0.05)');
      lane.addColorStop(1, 'rgba(77,163,255,0.10)');
      c.fillStyle = lane; c.fillRect(0, ty - 34, w, 68);
      // 中分线
      c.strokeStyle = 'rgba(148,163,184,0.25)';
      c.setLineDash([3, 6]);
      c.beginPath(); c.moveTo(w / 2, ty - 30); c.lineTo(w / 2, ty + 30); c.stroke();
      c.setLineDash([]);

      // ── 双方 HP 条（PVP）／Boss 血条 + 基地墙（Boss 战） ──
      const bw = w * 0.34, bh = 13, hy = 12;
      const hpBar = (x, frac, color, name) => {
        const low = frac < 0.25;
        c.fillStyle = 'rgba(10,14,26,0.7)';
        this._rr(c, x, hy, bw, bh, 6.5); c.fill();
        if (frac > 0) {
          c.save();
          if (low && Math.sin(t * 7) > 0) { c.shadowColor = color; c.shadowBlur = 10; }
          const g = c.createLinearGradient(x, 0, x + bw, 0);
          g.addColorStop(0, low ? '#f87171' : color); g.addColorStop(1, color);
          c.fillStyle = g;
          this._rr(c, x, hy, bw * Math.min(1, frac), bh, 6.5); c.fill();
          c.restore();
        }
        c.fillStyle = 'rgba(226,232,240,0.92)';
        c.font = '800 11px sans-serif';
        c.textAlign = 'left'; c.textBaseline = 'middle';
        c.fillText(`${name} ${Math.round(frac * 100)}`, x + 8, hy + bh / 2 + 0.5);
      };
      if (bossMode && boss) {
        // Boss 血条（中央顶部）
        const bbw = w * 0.44, bx = (w - bbw) / 2;
        const bFrac = Math.max(0, Math.min(1, boss.hp / boss.hpMax));
        c.fillStyle = 'rgba(10,14,26,0.7)';
        this._rr(c, bx, hy, bbw, bh, 6.5); c.fill();
        if (bFrac > 0) {
          c.save();
          if (bFrac < 0.25 && Math.sin(t * 7) > 0) { c.shadowColor = '#f87171'; c.shadowBlur = 12; }
          const g = c.createLinearGradient(bx, 0, bx + bbw, 0);
          g.addColorStop(0, bFrac < 0.25 ? '#f87171' : '#ef4444'); g.addColorStop(1, '#7f1d1d');
          c.fillStyle = g;
          this._rr(c, bx, hy, bbw * bFrac, bh, 6.5); c.fill();
          c.restore();
        }
        c.fillStyle = 'rgba(255,214,102,0.95)';
        c.font = '800 12px sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(`${BOSS_EMOJI[boss.name] || '👹'} ${boss.name} ${boss.hp}/${boss.hpMax}`, w / 2, hy + bh / 2 + 0.5);
        // 基地墙（Boss 战专用，顶部第二行）
        const wall = this.wall;
        if (wall) {
          const wf = Math.max(0, Math.min(1, wall.hp / wall.hpMax));
          const wbw = bbw * 0.6, wx = (w - wbw) / 2, wy = hy + bh + 6;
          c.fillStyle = 'rgba(10,14,26,0.7)';
          this._rr(c, wx, wy, wbw, 9, 4.5); c.fill();
          if (wf > 0) {
            c.save();
            if (wf < 0.3 && Math.sin(t * 6) > 0) { c.shadowColor = '#f87171'; c.shadowBlur = 8; }
            c.fillStyle = wf < 0.3 ? '#f87171' : '#eab308';
            this._rr(c, wx, wy, wbw * wf, 9, 4.5); c.fill();
            c.restore();
          }
          c.fillStyle = 'rgba(226,232,240,0.85)';
          c.font = '700 9px sans-serif';
          c.textAlign = 'center';
          c.fillText(`🧱 基地墙 ${Math.round(wf * 100)}%`, w / 2, wy + 5.5);
        }
        // 中央 Boss（大实体 + 红光脉动）
        const bob = Math.sin(t * 2.2) * 3;
        c.save();
        c.shadowColor = '#ff5d5d'; c.shadowBlur = 22 + 8 * Math.sin(t * 4);
        c.font = '46px sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(BOSS_EMOJI[boss.name] || '👹', w / 2, ty - 8 + bob);
        c.restore();
        c.fillStyle = 'rgba(255,93,93,0.5)';
        c.font = '700 9px sans-serif';
        c.textAlign = 'center';
        c.fillText('◄ 双方火力 ►', w / 2, ty - 40 + bob);
      } else {
        // 常规 PVP：双队 HP 条 + VS
        const rFrac = Math.max(0, Math.min(1, sh.redHp / 100));
        const bFrac = Math.max(0, Math.min(1, sh.blueHp / 100));
        hpBar(12, rFrac, RED, sh.redName);
        hpBar(w - 12 - bw, bFrac, BLUE, sh.blueName);
        c.fillStyle = 'rgba(255,209,102,0.9)';
        c.font = '900 13px sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText('VS', w / 2, hy + bh / 2 + 0.5);
      }

      // ── 加速条（点赞提速，服务端 blitz 值折算） ──
      const blitzFrac = (side) => Math.min(1, (sh.blitz[side] || 0) / 120);
      const blitzBar = (x, frac, color) => {
        const bbw = bw * 0.55, x0 = x + bw - bbw;
        c.fillStyle = 'rgba(10,14,26,0.6)';
        this._rr(c, x0, hy + bh + 5, bbw, 6, 3); c.fill();
        if (frac > 0) {
          c.save();
          if (frac > 0.6) { c.shadowColor = GOLD; c.shadowBlur = 8; }
          c.fillStyle = frac > 0.6 ? GOLD : color;
          this._rr(c, x0, hy + bh + 5, bbw * frac, 6, 3); c.fill();
          c.restore();
        }
        c.font = '700 9px sans-serif'; c.fillStyle = 'rgba(226,232,240,0.8)';
        c.textAlign = 'right'; c.textBaseline = 'middle';
        c.fillText('⚡加速', x0 - 4, hy + bh + 8);
      };
      blitzBar(12, blitzFrac('red'), RED);
      blitzBar(w - 12 - bw, blitzFrac('blue'), BLUE);

      // ── 枪手（观众头像 + 炮管） ──
      const crew = this.crew;
      for (const side of ['red', 'blue']) {
        const dir = side === 'red' ? 1 : -1;
        const list = (crew[side] || []).slice(0, 6);
        for (let i = 0; i < Math.max(1, list.length); i++) {
          const pos = this._shootCrewPos(side, i);
          const bob = Math.sin(t * 4 + i * 1.3) * 2;
          const y = pos.y + bob;
          // 炮管（朝向中心）
          c.save();
          c.translate(pos.x, y);
          c.rotate(0);
          c.fillStyle = side === 'red' ? '#7f1d1d' : '#1e3a8a';
          this._rr(c, dir * 10, -2.5, 16, 5, 2.5); c.fill();
          c.fillStyle = side === 'red' ? RED : BLUE;
          c.beginPath(); c.arc(dir * 26, 0, 2.6, 0, Math.PI * 2); c.fill();
          c.restore();
          this._drawAvatar(c, pos.x, y, 15, list[i] || null, side);
        }
      }

      // ── 子弹（普通=队色彗星 / 强力=金色脉冲）──
      // 位置逐帧按服务端同款公式推演：frac += dt/T × (1+本队加速)，直线飞行、从枪口出发
      const T = Math.max(300, this.travelMs || 1400);
      const blitz = (side) => (this.shooter && this.shooter.blitz[side]) || 0;
      const TRAIL = { red: 'rgba(248,113,113,0.55)', blue: 'rgba(77,163,255,0.55)' };
      const CORE = { red: 'rgba(255,190,190,0.95)', blue: 'rgba(195,222,255,0.95)' };
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.lineCap = 'round';
      for (const e of this.bullets.values()) {
        const boost = 1 + Math.min(0.8, blitz(e.side) / 100);    // 与服务端同式
        e.frac = Math.min(bossMode ? 0.5 : 1.0, e.frac + ((dt || 0.016) * 1000 / T) * boost);   // dt(秒)×1000 / T(毫秒)
        const reach = bossMode ? 0.5 : 1;                        // Boss 战：子弹到中场即命中 Boss
        const x = 14 + Math.max(-0.02, Math.min(reach, e.frac)) * (w - 28);
        const y = ty - 26 + e.lane;                              // 直线飞行（lane 为固定小偏移）
        const dir = e.side === 'red' ? 1 : -1;                   // 拖尾在飞行方向身后
        const strong = e.strength >= 3;
        if (strong) {
          // ── 金色强力弹：双层辉光 + 白核 + 旋转星芒 + 长拖尾 ──
          c.shadowColor = GOLD;
          c.shadowBlur = 18;
          c.strokeStyle = 'rgba(255,214,102,0.65)';
          c.lineWidth = 5;
          c.beginPath(); c.moveTo(x - dir * 30, y); c.lineTo(x - dir * 8, y); c.stroke();
          c.fillStyle = 'rgba(255,214,102,0.30)';
          c.beginPath(); c.arc(x, y, 12, 0, Math.PI * 2); c.fill();
          c.fillStyle = GOLD;
          c.beginPath(); c.arc(x, y, 8, 0, Math.PI * 2); c.fill();
          c.fillStyle = '#fff7d6';
          c.beginPath(); c.arc(x, y, 3.6, 0, Math.PI * 2); c.fill();
          c.strokeStyle = 'rgba(255,247,214,0.9)';
          c.lineWidth = 1.6;
          const rot = t * 9;
          for (let s = 0; s < 4; s++) {
            const a = rot + s * Math.PI / 2;
            c.beginPath();
            c.moveTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9);
            c.lineTo(x + Math.cos(a) * 14, y + Math.sin(a) * 14);
            c.stroke();
          }
        } else {
          // ── 普通弹：队色彗星（渐隐拖尾 + 辉光核） ──
          c.shadowColor = e.side === 'red' ? RED : BLUE;
          c.shadowBlur = 10;
          c.strokeStyle = TRAIL[e.side];
          c.lineWidth = 3.6;
          c.beginPath(); c.moveTo(x - dir * 24, y); c.lineTo(x - dir * 4, y); c.stroke();
          c.fillStyle = e.side === 'red' ? RED : BLUE;
          c.beginPath(); c.arc(x, y, 5.6, 0, Math.PI * 2); c.fill();
          c.fillStyle = CORE[e.side];
          c.beginPath(); c.arc(x, y, 2.5, 0, Math.PI * 2); c.fill();
        }
      }
      c.restore();

      // 漂浮尘埃 + 说话气泡
      c.fillStyle = '#ffd166';
      for (let i = 0; i < 12; i++) {
        const mx = ((i * 137.508 + t * 6) % (w + 40)) - 20;
        const my = ty - 44 + Math.sin(t * 0.8 + i * 2.4) * 10 + (i % 4) * 16;
        c.globalAlpha = 0.16 + 0.13 * Math.sin(t * 1.2 + i);
        c.fillRect(mx, my, 2, 2);
      }
      c.globalAlpha = 1;
      this._drawBubbles(c, w, h, t);
    }

    _drawEnergy(c, w, h) {
      const bw = w * 0.40, bh = 9, y = h - 20;
      const thr = this.surgeThr || 1;
      const draw = (x, frac, color) => {
        const full = frac >= 1;
        c.fillStyle = 'rgba(10,14,26,0.6)';
        this._rr(c, x, y, bw, bh, 4.5); c.fill();
        if (frac > 0) {
          c.save();
          if (full) { c.shadowColor = color; c.shadowBlur = 12; }
          const g = c.createLinearGradient(x, 0, x + bw, 0);
          g.addColorStop(0, full ? '#fbbf24' : color); g.addColorStop(1, color);
          c.fillStyle = g;
          this._rr(c, x, y, bw * Math.min(1, frac), bh, 4.5); c.fill();
          c.restore();
        }
        c.fillStyle = 'rgba(226,232,240,0.85)';
        c.font = '700 10px sans-serif';
        c.textAlign = 'left'; c.textBaseline = 'middle';
        c.fillText(full ? '⚡ 冲锋!' : `⚡ ${Math.round(frac * 100)}%`, x + 8, y + bh / 2);
      };
      draw(10, Math.min(1, this.teams.red.energy / thr), RED);
      draw(w - 10 - bw, Math.min(1, this.teams.blue.energy / thr), BLUE);
    }

    /* ── 守城场景 ── */
    _drawSiege(c, w, h, t) {
      // 夜色天空 + 地面
      const sky = c.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#0d1424'); sky.addColorStop(1, '#1a2440');
      c.fillStyle = sky; c.fillRect(0, 0, w, h);
      const gnd = c.createLinearGradient(0, h * 0.72, 0, h);
      gnd.addColorStop(0, '#141a2c'); gnd.addColorStop(1, '#0b0f1c');
      c.fillStyle = gnd; c.fillRect(0, h * 0.72, w, h - h * 0.72);
      // 余烬升腾（持续氛围：战场火光感）
      for (let i = 0; i < 12; i++) {
        const k = (t * 0.16 + i / 12) % 1;
        const ex = ((i * 61.8) % w) * 0.35 + k * w * 0.65;
        const ey = h * 0.78 - k * h * 0.5;
        c.globalAlpha = 0.55 * (1 - k);
        c.fillStyle = i % 3 ? 'rgba(255,110,60,0.85)' : 'rgba(255,200,110,0.95)';
        c.fillRect(ex, ey, 2.2, 2.2);
      }
      c.globalAlpha = 1;
      // 星点（静态，按坐标伪随机）
      c.fillStyle = 'rgba(226,232,240,0.5)';
      for (let i = 0; i < 22; i++) {
        const sx = ((i * 137.5) % 100) / 100 * w;
        const sy = ((i * 61.7) % 62) / 100 * h * 0.62;
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 0.8 + i));
        c.globalAlpha = tw * 0.5;
        c.fillRect(sx, sy, 1.6, 1.6);
      }
      c.globalAlpha = 1;

      if (!this.siege) {
        c.fillStyle = 'rgba(226,232,240,0.5)';
        c.font = '600 12px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText('守城战准备中…', w / 2, h / 2);
        return;
      }
      const s = this.siege;
      const mFrac = s.hp / s.hpMax;
      const px = this._monsterX(w), py = this._monsterY(h), ps = this._monsterScale();

      // 怪物
      c.save();
      c.font = `${ps}px sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(MONSTER_EMOJI[s.monsterName] || '👹', px, py);
      c.restore();
      // 怪物血量条
      const bw = 76, by = py - ps * 0.55;
      c.fillStyle = 'rgba(10,14,26,0.75)';
      this._rr(c, px - bw / 2, by, bw, 7, 3.5); c.fill();
      const hcol = mFrac > 0.5 ? '#4ade80' : mFrac > 0.25 ? '#fbbf24' : '#f87171';
      if (mFrac > 0) {
        c.fillStyle = hcol;
        this._rr(c, px - bw / 2, by, bw * mFrac, 7, 3.5); c.fill();
      }
      c.fillStyle = 'rgba(226,232,240,0.8)';
      c.font = '600 9px sans-serif'; c.textAlign = 'center';
      c.fillText(`${s.monsterName} ${s.hp}/${s.hpMax}`, px, by - 5);

      // 城墙（砖墙 + 耐久 + 裂纹）
      const wx0 = w - 30, wt = this._wallTop(h), wb = h * 0.72;
      c.save();
      c.fillStyle = '#5b3b26';
      c.fillRect(wx0, wt, 30, wb - wt);
      const brickH = 11;
      let yy = wt;
      let row = 0;
      while (yy < wb) {
        const off = (row % 2) * 8;
        c.fillStyle = row % 2 ? '#6d4a30' : '#7c5235';
        for (let xx = wx0 - off; xx < wx0 + 30; xx += 26) {
          c.fillRect(xx, yy, Math.min(26, wx0 + 30 - xx), brickH);
        }
        c.fillStyle = 'rgba(20,12,6,0.85)';
        c.fillRect(wx0, yy + brickH - 1.5, 30, 1.5);
        yy += brickH; row++;
      }
      // 裂纹（按损坏档位生成一次，避免每帧/每次推送随机重排）
      const crackLvl = Math.floor((1 - s.wallHp / s.wallHpMax) * 7);
      if (crackLvl !== this._crackLvl) {
        this._crackLvl = crackLvl;
        this._cracks = [];
        for (let i = 0; i < crackLvl; i++) {
          const cx0 = wx0 + 5 + Math.random() * 20;
          const cy0 = wt + Math.random() * 40;
          this._cracks.push([[cx0, cy0], [cx0 + (Math.random() - 0.5) * 12, cy0 + 8 + Math.random() * 8], [cx0 + (Math.random() - 0.5) * 16, cy0 + 18 + Math.random() * 10]]);
        }
      }
      c.strokeStyle = 'rgba(0,0,0,0.8)';
      c.lineWidth = 1.4;
      for (const pts of this._cracks) {
        c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
        for (const p of pts.slice(1)) c.lineTo(p[0], p[1]);
        c.stroke();
      }
      c.restore();
      // 城墙耐久条 + 告警
      const wFrac = s.wallHp / s.wallHpMax;
      const low = wFrac <= 0.3 && Math.sin(t * 6) > 0;
      const wbw = 92, wx = w - 14 - wbw;
      c.fillStyle = 'rgba(10,14,26,0.75)';
      this._rr(c, wx, 8, wbw, 9, 4.5); c.fill();
      c.fillStyle = low ? '#f87171' : '#eab308';
      if (wFrac > 0) { this._rr(c, wx, 8, wbw * wFrac, 9, 4.5); c.fill(); }
      c.fillStyle = 'rgba(226,232,240,0.85)';
      c.font = '700 10px sans-serif'; c.textAlign = 'left';
      c.fillText(`🧱 城墙 ${Math.round(wFrac * 100)}%`, wx, 25);

      // 全场能量条
      const eFrac = Math.min(1, s.energy / this.surgeThr);
      const ew = w * 0.5, ex = (w - ew) / 2, ey = h - 22;
      c.fillStyle = 'rgba(10,14,26,0.7)';
      this._rr(c, ex, ey, ew, 11, 5.5); c.fill();
      if (eFrac > 0) {
        c.save();
        if (eFrac >= 1) { c.shadowColor = GOLD; c.shadowBlur = 14; }
        const eg = c.createLinearGradient(ex, 0, ex + ew, 0);
        eg.addColorStop(0, '#f59e0b'); eg.addColorStop(1, GOLD);
        c.fillStyle = eg;
        this._rr(c, ex, ey, ew * eFrac, 11, 5.5); c.fill();
        c.restore();
      }
      c.fillStyle = 'rgba(226,232,240,0.9)';
      c.font = '700 11px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(eFrac >= 1 ? '⚡ 全力一击!（点赞充满）' : `⚡ ${Math.round(eFrac * 100)}%`, w / 2, ey + 5.5);
    }

    /* ───────────── 工具 ───────────── */
    _rr(c, x, y, w, h, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }
    _clipRR(c, x, y, w, h, r) {
      this._rr(c, x, y, w, h, r);
      c.clip();
    }
  }

  window.RBCanvas = RBCanvas;
})();