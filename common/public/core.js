/* ══════════════════════════════════════════════════════════════════
   core.js — 弹幕游戏中心公共前端工具（common/public）
   所有游戏页面与主播台框架共用：SSE 订阅、控制指令、HTML 转义、
   toast、头像渲染、烟花、直播间筛选组件
   以全局 DG 命名空间暴露（原生 JS，零依赖）
   ══════════════════════════════════════════════════════════════════ */
window.DG = (() => {
  'use strict';

  const $ = id => document.getElementById(id);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function initialOf(name) {
    const s = String(name || '?').trim();
    return s ? s[0] : '?';
  }

  /** 头像 HTML（无头像回退首字；含加载失败回退） */
  function avatarHTML(name, avatar) {
    if (avatar) {
      return `<span class="avatar"><img src="${esc(avatar)}" referrerpolicy="no-referrer" onerror="this.parentNode.textContent='${esc(initialOf(name))}'"></span>`;
    }
    return `<span class="avatar">${esc(initialOf(name))}</span>`;
  }

  /* ───────────── toast ───────────── */
  function showToast(t) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.display = 'block';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  /* ───────────── 展示屏主题 ─────────────
   * 主题由宿主按游戏托管（host.json 的 themes），随 SSE 的 state.theme 下发。
   * 仅在 body[data-view="stage"] 的展示屏应用；主播台界面不换肤。
   * 新增主题：改这里 + base.css 的 [data-theme="x"] 两块。
   */
  const THEMES = [
    // group 用于主播台下拉框分组；light:true 的会用深色版烟花配色
    { id: 'default', name: '暗金（经典）', group: '深色' },
    { id: 'tech', name: '科技蓝', group: '深色' },
    { id: 'festive', name: '喜庆红', group: '深色' },
    { id: 'cyber', name: '赛博紫', group: '深色' },
    { id: 'aurora', name: '极光绿', group: '深色' },
    { id: 'lava', name: '熔岩橙', group: '深色' },
    { id: 'graphite', name: '石墨灰', group: '深色' },
    { id: 'plain', name: '素雅白', group: '浅色', light: true },
    { id: 'sky', name: '晴空蓝', group: '浅色', light: true },
    { id: 'cream', name: '暖阳米', group: '浅色', light: true },
    { id: 'mint', name: '薄荷青', group: '浅色', light: true },
  ];

  // 烟花调色板（canvas 用）：浅底上必须用降明度的版本，否则亮色粒子看不见
  const FIREWORK_DARK = ['#ffc53d', '#ff5d5d', '#4da3ff', '#5dff9c', '#ff8ae2', '#fff3b0', '#9c7bff', '#ff7b3d'];
  const FIREWORK_LIGHT = ['#d97706', '#dc2626', '#1d4ed8', '#15803d', '#c026d3', '#a16207', '#7c3aed', '#ea580c'];

  /** 当前主题是否为浅色（新增浅色主题时记得标 light: true） */
  function isLightTheme() {
    const id = document.documentElement.dataset.theme || 'default';
    const t = THEMES.find(x => x.id === id);
    return !!(t && t.light);
  }

  function isStage() {
    return !!document.body && document.body.dataset.view === 'stage';
  }

  /** 应用主题到 <html data-theme>（仅展示屏） */
  function applyTheme(name) {
    if (!isStage()) return;
    const root = document.documentElement;
    if (!name || name === 'default') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', name);
  }

  /** 把当前主题同步到主播台的下拉框（若页面存在该选择器） */
  function syncThemePicker(theme) {
    if (!theme) return;
    const sel = document.getElementById('themeSelect');
    if (sel && sel.value !== theme) sel.value = theme;
  }

  /** 主播台主题选择器（各游戏控制台共用）；挂载到指定容器 */
  function mountThemePicker(mountEl, game) {
    if (!mountEl) return null;
    const wrap = document.createElement('label');
    wrap.className = 'theme-picker';
    // 按深色/浅色分组展示（optgroup），主播一眼看出该选哪组
    const optsHtml = ['深色', '浅色'].map(g => {
      const items = THEMES.filter(t => (t.group || '深色') === g);
      if (!items.length) return '';
      return `<optgroup label="${g}系列">${items
        .map(t => `<option value="${t.id}">${t.name}</option>`).join('')}</optgroup>`;
    }).join('');
    wrap.innerHTML = `展示屏主题 <select id="themeSelect">${optsHtml}</select>`;
    mountEl.appendChild(wrap);
    const select = wrap.querySelector('#themeSelect');
    select.addEventListener('change', async () => {
      const r = await control(game, 'setTheme', { theme: select.value });
      if (r && r.ok) showToast('展示屏主题已切换（仅展示屏生效）');
    });
    return { element: wrap, select };
  }

  /** 自动挂载：控制页存在 [data-theme-picker] 容器时自动渲染选择器（游戏零改动） */
  function autoMountThemePicker() {
    if (isStage()) return;                      // 展示屏不需要选择器
    const el = document.querySelector('[data-theme-picker]');
    if (!el) return;
    const game = new URLSearchParams(location.search).get('game') || el.dataset.game || '';
    mountThemePicker(el, game);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMountThemePicker);
  else autoMountThemePicker();

  /* ───────────── 游戏开关（关闭后不再执行） ─────────────
   * [data-power-pin] 容器自动挂载「开启/关闭」按钮（各游戏控制页/主播台共用）：
   * 关闭 = 宿主停止弹幕分派 + 清理该游戏全部定时器；开启 = 恢复。状态取自 /api/games。
   */
  const pwState = new Map(); // gameId → enabled
  async function refreshPowerStates() {
    try {
      const r = await fetch('/api/games');
      const j = await r.json();
      for (const g of (j.games || [])) pwState.set(g.id, g.enabled !== false);
    } catch { /* 服务未就绪时保留旧状态 */ }
  }
  async function renderPowerPin(el, game) {
    if (!el) return;
    const on = pwState.get(game) !== false;
    el.innerHTML = `<span class="power-pin" data-on="${on ? '1' : '0'}">
        <button class="btn tiny ${on ? 'warn' : 'primary'}" data-pw-act>${on ? '关闭游戏' : '开启游戏'}</button>
        <span class="power-pin-tip">${on ? '关闭后该游戏不再执行（弹幕处理与定时器全停）' : '已关闭：弹幕处理与定时器已停止'}</span>
      </span>`;
    const btn = el.querySelector('[data-pw-act]');
    if (btn) btn.onclick = async () => {
      const next = pwState.get(game) === false;
      const r = await control(game, 'setGameEnabled', { enabled: next }, { silent: true });
      if (r && r.ok) { pwState.set(game, next); showToast(r.msg); renderPowerPin(el, game); }
      else if (r) showToast(r.msg || '操作失败');
    };
  }
  function autoMountPowerPin() {
    if (isStage()) return;
    document.querySelectorAll('[data-power-pin]').forEach(el => {
      const game = el.dataset.game || new URLSearchParams(location.search).get('game') || '';
      if (!game) return;
      refreshPowerStates().then(() => renderPowerPin(el, game));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMountPowerPin);
  else autoMountPowerPin();

  /* ───────────── 控制指令 ─────────────
   * POST /api/control body {action, game, ...extra}
   * 返回 {ok, msg, state}；默认 toast 结果（silent=true 关闭）
   */
  async function control(game, action, extra = {}, opts = {}) {
    try {
      const r = await fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, game, ...extra }),
      });
      const j = await r.json();
      if (!opts.silent) showToast(j.msg || (j.ok ? '已执行' : '操作失败'));
      return j;
    } catch (e) {
      showToast('控制请求失败: ' + e.message);
      return { ok: false, msg: e.message };
    }
  }

  /* ───────────── SSE 订阅 ─────────────
   * game 传 '*' 订阅所有游戏的事件（主播台框架用）
   * handlers: { onState(gameId, state), onGuess(gameId, entry), onNotice(gameId, notice), onError }
   * 返回 { close() }
   */
  function connectSSE(game, handlers = {}) {
    const q = game ? `?game=${encodeURIComponent(game)}` : '';
    const es = new EventSource('/api/events' + q);
    es.addEventListener('state', e => {
      const st = JSON.parse(e.data);
      applyTheme(st.theme);        // 展示屏：应用主题
      syncThemePicker(st.theme);   // 主播台：同步下拉框
      if (handlers.onState) handlers.onState(st.__game, st, e);
    });
    es.addEventListener('guess', e => {
      const g = JSON.parse(e.data);
      if (handlers.onGuess) handlers.onGuess(g.__game, g, e);
    });
    es.addEventListener('notice', e => {
      const n = JSON.parse(e.data);
      if (handlers.onNotice) handlers.onNotice(n.__game, n, e);
    });
    es.onerror = () => { if (handlers.onError) handlers.onError(); };
    return { close: () => es.close() };
  }

  /* ───────────── 烟花（获胜庆祝） ─────────────
   * 粒子集中在屏幕四周绽放，中央结算信息区保持干净（持续 5 秒）
   */
  function launchFireworks(boxId) {
    const box = $(boxId);
    if (!box) return;
    // canvas 绘制，CSS 变量管不到，故按主题的明暗分别给一套调色板（浅色需降明度才看得见）
    const colors = isLightTheme() ? FIREWORK_LIGHT : FIREWORK_DARK;
    const rect = box.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const burstPoints = [
      { x: W * 0.18, y: H * 0.14 }, { x: W * 0.5, y: H * 0.10 }, { x: W * 0.82, y: H * 0.14 },
      { x: W * 0.12, y: H * 0.40 }, { x: W * 0.88, y: H * 0.40 },
      { x: W * 0.20, y: H * 0.80 }, { x: W * 0.80, y: H * 0.80 },
      { x: W * 0.5, y: H * 0.86 },
    ];
    for (let b = 0; b < burstPoints.length; b++) {
      const cx = burstPoints[b].x;
      const cy = burstPoints[b].y;
      const perBurst = 26;
      const baseDelay = Math.random() * 0.25;
      for (let i = 0; i < perBurst; i++) {
        const p = document.createElement('div');
        const isSpark = Math.random() < 0.18;
        p.className = 'fw-particle' + (isSpark ? ' fw-spark' : '');
        const angle = (Math.PI * 2 * i) / perBurst + Math.random() * 0.5;
        const dist = 45 + Math.random() * 110;
        const dx = Math.cos(angle) * dist;
        const dy = Math.sin(angle) * dist;
        const size = isSpark ? 7 + Math.random() * 8 : 4 + Math.random() * 6;
        const delay = (baseDelay + Math.random() * 0.18).toFixed(2);
        p.style.cssText = `left:${cx}px;top:${cy}px;width:${size}px;height:${size}px;background:${colors[(Math.random() * colors.length) | 0]};color:${colors[(Math.random() * colors.length) | 0]};--dx:${dx}px;--dy:${dy}px;animation-delay:${delay}s;`;
        box.appendChild(p);
        (function (el) { setTimeout(() => el.remove(), 5500); })(p);
      }
    }
  }

  /* ───────────── 接入与模拟面板（各游戏控制台共用） ─────────────
   * mountFeedTools(mountEl, game, opts)
   *   opts.getRoomId()            回填「接收直播间ID」输入框
   *   opts.sim.chat               模拟弹幕：{ placeholder } 或 false 关闭
   *   opts.sim.like               模拟点赞：{ count }（默认次数）或 false
   *   opts.sim.gift               模拟送礼：true / false
   *   opts.sim.enter              模拟进场：true / false
   *   opts.sim.follow             模拟关注：true / false
   * 模拟事件由宿主统一实现（mockChat/mockLike/mockGift/mockEnter/mockFollow），
   * 走与真实弹幕相同的分发管线 —— 新游戏只要实现 handleDanmu/handleLike 等
   * 标准事件接口即可被模拟，无需写任何 simulate 动作。
   */
  function mountFeedTools(mountEl, game, opts = {}) {
    if (!mountEl) return null;
    const getRoomId = opts.getRoomId || (() => '');
    const sim = Object.assign({ chat: true, like: { count: 10 }, gift: true, enter: true, follow: false }, opts.sim || {});
    const chatOpt = sim.chat === true ? {} : (sim.chat || {});
    const likeOpt = sim.like === true ? { count: 10 } : (sim.like || {});

    mountEl.className = 'ctl-roomid-filter';
    mountEl.innerHTML = `
      <div class="ctl-roomid-inner">
        <label class="ctl-roomid-label">接收直播间ID
          <input id="ctlRoomIdInput" type="text" placeholder="留空=所有房间；多个用逗号分隔"></label>
        <button id="ctlRoomIdApply" class="btn secondary tiny">应用</button>
      </div>
      <div class="feed-sim">
        <span class="feed-sim-tag">模拟观众</span>
        <input id="simName" type="text" placeholder="昵称(默认:模拟观众)" value="模拟观众">
        ${sim.chat ? `
        <input id="simText" type="text" maxlength="40" placeholder="${esc(chatOpt.placeholder || '模拟弹幕文本')}">
        <button id="btnSimChat" class="btn tiny secondary">发弹幕</button>` : ''}
        ${sim.like ? `
        <label class="feed-num">点赞×<input id="simLikeCount" type="number" min="1" value="${likeOpt.count ?? 10}"></label>
        <button id="btnSimLike" class="btn tiny secondary">模拟点赞</button>` : ''}
        ${sim.gift ? `
        <label class="feed-num">礼物<input id="simGiftName" type="text" placeholder="小心心"></label>
        <label class="feed-num">×<input id="simGiftCount" type="number" min="1" value="1"></label>
        <button id="btnSimGift" class="btn tiny secondary">模拟送礼</button>` : ''}
        ${sim.enter ? `<button id="btnSimEnter" class="btn tiny secondary">模拟进场</button>` : ''}
        ${sim.follow ? `<button id="btnSimFollow" class="btn tiny secondary">模拟关注</button>` : ''}
      </div>`;

    const input = mountEl.querySelector('#ctlRoomIdInput');
    const apply = mountEl.querySelector('#ctlRoomIdApply');
    const refresh = () => { const v = getRoomId(); if (v !== undefined && document.activeElement !== input) input.value = v || ''; };
    refresh();
    apply.onclick = () => control(game, 'setRoomFilter', { roomId: input.value.trim() });

    const simName = () => (mountEl.querySelector('#simName') || {}).value?.trim() || '模拟观众';
    const chatText = mountEl.querySelector('#simText');
    const doChat = () => {
      const text = chatText.value.trim();
      if (!text) { showToast('请输入要模拟的弹幕文本'); return; }
      control(game, 'mockChat', { text, name: simName() });
      chatText.value = '';
      chatText.focus();
    };
    if (chatText) {
      mountEl.querySelector('#btnSimChat').onclick = doChat;
      chatText.addEventListener('keydown', e => { if (e.key === 'Enter') doChat(); });
    }
    const bindMock = (btnId, action, extra) => {
      const btn = mountEl.querySelector(btnId);
      if (!btn) return;
      btn.onclick = () => control(game, action, { name: simName(), ...extra() });
    };
    if (sim.like) bindMock('#btnSimLike', 'mockLike', () => ({
      count: Math.max(1, parseInt(mountEl.querySelector('#simLikeCount').value, 10) || 1),
    }));
    if (sim.gift) bindMock('#btnSimGift', 'mockGift', () => {
      const giftName = (mountEl.querySelector('#simGiftName') || {}).value?.trim() || '';
      return {
        giftName,
        giftCount: Math.max(1, parseInt((mountEl.querySelector('#simGiftCount') || {}).value, 10) || 1),
      };
    });
    if (sim.enter) bindMock('#btnSimEnter', 'mockEnter', () => ({}));
    if (sim.follow) bindMock('#btnSimFollow', 'mockFollow', () => ({}));
    return { refresh };
  }

  /* 兼容旧接口：mountRoomFilter(mountEl, game, getRoomId) —— 仅直播间筛选，无模拟行 */
  function mountRoomFilter(mountEl, game, getRoomId) {
    return mountFeedTools(mountEl, game, { getRoomId, sim: false });
  }

  return {
    $, esc, initialOf, avatarHTML, showToast, control, connectSSE, launchFireworks,
    mountRoomFilter, mountFeedTools,
    THEMES, applyTheme, mountThemePicker,
  };
})();
