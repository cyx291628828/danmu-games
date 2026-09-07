/* ══════════════════════════════════════════════════════════════════
   fx.js — 零依赖 Canvas 特效引擎（common/public，各游戏展示屏共用）
   ══════════════════════════════════════════════════════════════════
   替代纯 DOM/CSS 粒子方案：Canvas 2D 渲染，批量粒子 + 加色混合辉光，
   1080×1920 竖屏下跑上千粒子仍稳定 60fps（OBS 浏览器源友好）。

   用法：
     const fx = new FxEngine(canvasEl);
     fx.onDraw = (ctx, w, h, dt, t) => { 页面自绘场景（粒子层之下） };
     fx.start();
     fx.burst(x, y, { count: 40, colors: [...], speed: 160 });
     fx.ring(x, y, { color: '#ffd166', r1: 120 });
     fx.float(x, y, '+12', { color: '#f87171' });
     fx.chev(x, 'red'); fx.shakeSec(8); fx.flash(0.35, '#fff');

   粒子用加色混合（glow 观感）；飘字/闪光用普通混合保证可读性。
   整帧循环内做：清除 → 场景(页面) → 粒子/波纹/飘字 → 全屏闪光。
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const MAX_PARTICLES = 1500; // 粒子池上限：超出丢最老，防极端刷屏拖垮帧率

  class FxEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 0; this.h = 0; this.dpr = 1;
      this.particles = [];   // {x,y,vx,vy,life,maxLife,size,color,grav,drag}
      this.rings = [];       // {x,y,life,maxLife,r0,r1,color,width,alpha0}
      this.floats = [];      // {x,y,text,life,maxLife,color,size,rise,weight}
      this.chevs = [];       // {x,y,dir,life,maxLife,color}
      this.shakeT = 0; this.shakeDur = 0; this.shakePower = 0;
      this.flashA = 0; this.flashColor = '255,255,255';
      this.onDraw = null;    // 页面场景回调 fn(ctx, w, h, dt, t)
      this._int = null; this._last = 0;
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.imageSmoothingEnabled = true;
    }

    /** 启动帧循环：setInterval 16ms 驱动（约 60fps）。
        不用 requestAnimationFrame：部分采集环境/WebView 会节流或停发 rAF
        （OBS 浏览器源、嵌入容器），间隔驱动在可见页面恒定走帧，行为可预测。 */
    start() {
      if (this._int) return;
      this._int = setInterval(() => this._tick(performance.now()), 16);
    }
    stop() {
      if (this._int) { clearInterval(this._int); this._int = null; }
    }

    /* ── 主循环 ── */
    _tick(now) {
      if (!this._last) this._last = now;
      const dt = Math.min(0.05, (now - this._last) / 1000); // 防切页后大跳帧
      this._last = now;
      const t = (now - (this._t0 || (this._t0 = now))) / 1000;
      this._update(dt);
      this._draw(dt, t);
    }

    _update(dt) {
      const p = this.particles;
      for (let i = p.length - 1; i >= 0; i--) {
        const q = p[i];
        q.life -= dt;
        if (q.life <= 0) { p[i] = p[p.length - 1]; p.pop(); continue; }
        q.vy += q.grav * dt;
        q.vx *= (1 - q.drag * dt);
        q.x += q.vx * dt; q.y += q.vy * dt;
      }
      const r = this.rings;
      for (let i = r.length - 1; i >= 0; i--) {
        r[i].life -= dt;
        if (r[i].life <= 0) { r[i] = r[r.length - 1]; r.pop(); }
      }
      const f = this.floats;
      for (let i = f.length - 1; i >= 0; i--) {
        f[i].life -= dt;
        if (f[i].life <= 0) { f[i] = f[f.length - 1]; f.pop(); continue; }
        f[i].y -= f[i].rise * dt;
      }
      const c = this.chevs;
      for (let i = c.length - 1; i >= 0; i--) {
        c[i].life -= dt;
        if (c[i].life <= 0) { c[i] = c[c.length - 1]; c.pop(); }
      }
      if (this.shakeT > 0) {
        this.shakeT -= dt;
        if (this.shakeT <= 0) this.shakePower = 0;
      }
      if (this.flashA > 0) this.flashA = Math.max(0, this.flashA - dt * 2.4);
    }

    _draw(dt, t) {
      const c = this.ctx, w = this.w, h = this.h;
      c.clearRect(0, 0, w, h);
      c.save();
      // 震屏：把整个场景（含场景回调）平移抖动
      if (this.shakePower > 0) {
        c.translate((Math.random() - 0.5) * this.shakePower, (Math.random() - 0.5) * this.shakePower);
      }
      if (this.onDraw) this.onDraw(c, w, h, dt, t);
      this._drawParticles(c);
      this._drawRings(c);
      this._drawChevs(c);
      this._drawFloats(c);
      c.restore();
      if (this.flashA > 0) {
        c.fillStyle = `rgba(${this.flashColor},${this.flashA.toFixed(3)})`;
        c.fillRect(0, 0, w, h);
      }
    }

    _drawParticles(c) {
      const p = this.particles;
      if (!p.length) return;
      c.save();
      c.globalCompositeOperation = 'lighter';   // 加色混合：粒子叠出辉光
      for (const q of p) {
        const a = Math.max(0, Math.min(1, q.life / q.maxLife));
        c.globalAlpha = a;
        c.fillStyle = q.color;
        const s = q.size * (0.4 + 0.6 * a);
        c.beginPath();
        c.arc(q.x, q.y, s, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
      c.globalAlpha = 1;
    }

    _drawRings(c) {
      if (!this.rings.length) return;
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const r of this.rings) {
        const k = 1 - r.life / r.maxLife;                    // 0→1 扩张进度
        const rad = r.r0 + (r.r1 - r.r0) * (1 - (1 - k) * (1 - k));
        const a = r.alpha0 * (1 - k);
        c.globalAlpha = a;
        c.strokeStyle = r.color;
        c.lineWidth = r.width * (1 - k * 0.6);
        c.beginPath();
        c.arc(r.x, r.y, rad, 0, Math.PI * 2);
        c.stroke();
      }
      c.restore();
      c.globalAlpha = 1;
    }

    _drawChevs(c) {
      if (!this.chevs.length) return;
      c.save();
      c.font = '900 16px sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      for (const q of this.chevs) {
        const a = q.life / q.maxLife;
        c.globalAlpha = Math.min(1, a * 2);
        c.fillStyle = q.color;
        c.fillText(q.dir === 'red' ? '›' : '‹', q.x, q.y);
      }
      c.restore();
      c.globalAlpha = 1;
    }

    _drawFloats(c) {
      if (!this.floats.length) return;
      c.save();
      c.textAlign = 'center'; c.textBaseline = 'middle';
      for (const f of this.floats) {
        const k = 1 - f.life / f.maxLife;
        const a = k < 0.15 ? (k / 0.15) : (1 - Math.max(0, (k - 0.6) / 0.4));
        c.globalAlpha = Math.max(0, a);
        c.font = `900 ${f.size}px sans-serif`;
        c.lineWidth = 4;
        c.strokeStyle = 'rgba(0,0,0,0.55)';   // 描边保证深色/浅色底都清晰
        c.strokeText(f.text, f.x, f.y);
        c.fillStyle = f.color;
        c.fillText(f.text, f.x, f.y);
      }
      c.restore();
      c.globalAlpha = 1;
    }

    /* ── 特效 API ── */

    /** 粒子爆散（默认彩色火花；spark>0 时掺细长曳光） */
    burst(x, y, opts = {}) {
      const {
        count = 30, colors = ['#ffd166', '#ff5d5d', '#4da3ff', '#5dff9c', '#ff8ae2'],
        speed = 150, spread = Math.PI * 2, size = 3.2, life = 0.95, grav = 140,
      } = opts;
      const n = Math.min(180, count);
      for (let i = 0; i < n; i++) {
        if (this.particles.length >= MAX_PARTICLES) break;
        const a = (i / n) * spread + (Math.random() - 0.5) * 0.5 + (Math.PI * 2 - spread) / 2;
        const v = speed * (0.35 + Math.random() * 0.9);
        this.particles.push({
          x, y,
          vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.25,
          life, maxLife: life,
          size: size * (0.6 + Math.random() * 0.9),
          color: colors[(Math.random() * colors.length) | 0],
          grav, drag: 1.6,
        });
      }
    }

    /** 冲击波圆环（冲锋/全力一击/高光时刻） */
    ring(x, y, opts = {}) {
      const { r0 = 8, r1 = 110, color = '#ffd166', life = 0.55, width = 7, alpha0 = 0.85 } = opts;
      this.rings.push({ x, y, r0, r1, color, life, maxLife: life, width, alpha0 });
    }

    /** 飘字（伤害/推进/告警） */
    float(x, y, text, opts = {}) {
      const { color = '#fff', size = 15, life = 1.0, rise = 34 } = opts;
      this.floats.push({ x, y, text, color, size, life, maxLife: life, rise });
    }

    /** 方向箭头（拔河拉动方向） */
    chev(x, dir, color = '#ffd166', y = 0) {
      if (this.chevs.length > 14) return;   // 高频拉动下限制总量
      this.chevs.push({ x, y, dir, color, life: 0.45, maxLife: 0.45 });
    }

    /** 震屏（power≈4 轻 / 8 重） */
    shakeSec(power, dur = 0.35) {
      this.shakePower = Math.max(this.shakePower, power);
      this.shakeT = Math.max(this.shakeT, dur);
    }

    /** 全屏闪光（金色/白色高光时刻） */
    flash(alpha, color = '255,255,255') {
      this.flashA = Math.max(this.flashA, alpha);
      this.flashColor = color;
    }

    clear() {
      this.particles.length = 0; this.rings.length = 0;
      this.floats.length = 0; this.chevs.length = 0;
    }
  }

  window.FxEngine = FxEngine;
})();