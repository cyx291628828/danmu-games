/* ══════════════════════════════════════════════════════════════════
   control.js — 主播台框架壳逻辑（host/public）
   只做框架职责：游戏列表导航 / 切换激活游戏 / 投屏地址 / 弹幕接入数。
   各游戏控制台 UI 在 iframe 里的游戏页面（games/<id>/public/control.html）。
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, showToast } = DG;

  let gameList = [];
  let activeId = '';       // 当前 iframe 展示的游戏
  let navItems = {};       // gameId → nav DOM（SSE 实时更新绿点）
  let statusByGame = {};   // gameId → 最新状态（/api/games 初始快照 + SSE 实时覆盖；
                           // renderNav 重绘点必须从这里取，否则切游戏会把别的游戏的状态点回退成加载时的旧值）

  /* ───────────── 游戏列表 ───────────── */
  async function loadGameList() {
    try {
      const r = await fetch('/api/games');
      const j = await r.json();
      gameList = j.games || [];
      for (const g of gameList) statusByGame[g.id] = g.status || 'idle';
      // 首次：iframe 尚未展示任何游戏时，选 URL ?game= 或后端 activeGame
      if (!activeId) {
        const urlGame = new URLSearchParams(location.search).get('game');
        const pick = (urlGame && gameList.some(g => g.id === urlGame)) ? urlGame : (j.activeGame || (gameList[0] && gameList[0].id));
        if (pick) showGame(pick, { silent: true });
        else renderNav(null);
      } else {
        renderNav(activeId);
      }
    } catch {
      showToast('游戏列表加载失败');
    }
  }

  function renderNav(active) {
    const nav = $('gameNav');
    if (!nav) return;
    nav.innerHTML = '';
    navItems = {};
    for (const g of gameList) {
      const item = document.createElement('div');
      const off = g.enabled === false;
      item.className = 'ctl-nav-item' + (g.id === active ? ' ctl-nav-item-active' : '') + (off ? ' ctl-nav-item-off' : '');
      const st = statusByGame[g.id] || 'idle';
      const dot = dotInfo(g, st);
      item.innerHTML = `<span class="ctl-nav-icon">${g.icon || '🎮'}</span><span class="ctl-nav-name">${esc(g.name)}</span>`
        + `<span class="ctl-dot${off ? '' : dot.cls}"></span>`
        + `<button class="ctl-pw" title="${off ? '已关闭（点击开启）' : '关闭：停止处理弹幕并清理定时器'}" data-pw="${g.id}">${off ? '◉' : '⏻'}</button>`;
      item.title = `${g.name} · ${off ? '已关闭' : dot.label}`;
      item.onclick = (e) => {
        if (e.target.closest('.ctl-pw')) return;   // 点电源按钮不切游戏
        showGame(g.id);
      };
      item.querySelector('.ctl-pw').onclick = (e) => {
        e.stopPropagation();
        togglePower(g);
      };
      navItems[g.id] = item;
      nav.appendChild(item);
    }
  }

  /** 开启/关闭游戏：关闭后该游戏不再执行（停止弹幕分发与定时器） */
  async function togglePower(g) {
    const next = g.enabled !== false ? false : true;
    const r = await DG.control(g.id, 'setGameEnabled', { enabled: next }, { silent: true });
    if (r && r.ok) {
      g.enabled = next;
      renderNav(activeId);
      showToast(r.msg);
    } else if (r) {
      showToast(r.msg || '操作失败');
    }
  }

  /* ───────────── 导航状态点：按游戏状态实时分类 ─────────────
   * 进行中（各游戏 MANIFEST.liveStatuses）→ 绿点；
   * 暂停 paused → 蓝点；结算中/已结算（result / revealed）→ 金点；空闲 → 灰点。
   * liveStatuses 由 /api/games 下发（此前缺失导致前端只能硬编码兜底，状态永远对不上）。 */
  function dotInfo(g, status) {
    if (g && Array.isArray(g.liveStatuses) && g.liveStatuses.includes(status)) {
      return { cls: ' ctl-dot-live', label: '进行中' };
    }
    if (status === 'paused') return { cls: ' ctl-dot-paused', label: '已暂停' };
    if (status === 'result') return { cls: ' ctl-dot-revealed', label: '结算中' };
    if (status === 'revealed') return { cls: ' ctl-dot-revealed', label: '已结算' };
    return { cls: '', label: '空闲' };
  }

  /** SSE 实时更新单个游戏的状态点（订阅全部游戏事件） */
  function updateNavDot(gameId, status) {
    const g = gameList.find(x => x.id === gameId);
    const item = navItems[gameId];
    if (!item || !g) return;
    statusByGame[gameId] = status;            // 记住最新状态：切游戏重绘导航时不会被旧快照覆盖
    const dot = item.querySelector('.ctl-dot');
    if (!dot) return;
    const info = dotInfo(g, status);
    dot.className = 'ctl-dot' + info.cls;
    item.title = `${g.name} · ${info.label}`;
  }

  /* ───────────── 切换游戏 ───────────── */
  async function showGame(gid, opts = {}) {
    if (!gid || gid === activeId) return;
    activeId = gid;
    renderNav(activeId);                 // 立即点亮导航（不等网络）
    const g = gameList.find(x => x.id === gid);
    // iframe 加载该游戏控制台页面
    $('gameFrame').src = (g && g.controlPage ? g.controlPage : `/games/${gid}/public/control.html`) + `?game=${encodeURIComponent(gid)}`;
    renderStageLink();
    const url = new URL(location.href);
    url.searchParams.set('game', gid);
    history.replaceState(null, '', url);
    if (!opts.silent) {
      await DG.control(gid, 'switchGame', {}, { silent: true });   // 静默切换激活游戏，不弹 toast
    }
  }

  /** 顶部显示当前游戏的投屏地址（切换游戏跟随变化） */
  function renderStageLink() {
    const el = $('ctlStageLink');
    if (!el) return;
    const g = gameList.find(x => x.id === activeId);
    const path = g && g.stagePage ? g.stagePage : `/games/${activeId}/public/stage.html`;
    const url = `${location.origin}${path}?game=${encodeURIComponent(activeId)}`;
    el.innerHTML = `投屏地址：<a href="${url}" target="_blank">${url}</a>`;
  }

  /* ───────────── 弹幕接入数（轮询 /health） ───────────── */
  async function pollDanmu() {
    try {
      const r = await fetch('/health');
      const j = await r.json();
      $('ctlDanmu').textContent = `弹幕接入 ${j.danmuClients || 0} 路`;
    } catch { /* 服务重启间隙忽略 */ }
  }

  /* ───────────── 启动 ───────────── */
  loadGameList();
  pollDanmu();
  setInterval(pollDanmu, 5000);

  // 订阅全部游戏状态（game=*），实时刷新导航绿点
  DG.connectSSE('*', {
    onState: (gameId, st) => { if (gameId) updateNavDot(gameId, st.status); },
    onNotice: (gameId, n) => { if (n && n.text) showToast(n.text); },
    onError: () => showToast('与游戏服务断连，正在重试…'),
  });
})();
