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
   * handlers: { onState(gameId, state), onGuess(gameId, entry), onNotice(gameId, notice),
   *             onMoment(gameId, moment), onError }
   * moment = 观众时刻（进场/关注/送礼，宿主在弹幕转发到达时统一广播，含观众本玩法排名）
   * 同一 game 键复用一条 EventSource（多订阅者扇出）：浏览器同源 HTTP/1.1 并发约 6 条，
   * 展示屏若「游戏状态 + 观众时刻」各开一条，再开第三个页面就会堵死静态资源一直转圈。
   * 返回 { close() }：只退订本 handlers；最后一个订阅者离开时才真正关闭连接。
   */
  const _sseByGame = new Map(); // key → { es, subs:Set, likeProgress }

  function connectSSE(game, handlers = {}) {
    const key = String(game || '');
    let rec = _sseByGame.get(key);
    if (!rec) {
      const q = key ? `?game=${encodeURIComponent(key)}` : '';
      const es = new EventSource('/api/events' + q);
      // 本连接收到的点赞数（跨游戏统一计数，供「每 N 赞解锁提示词」这类玩法做本地进度显示；
      // 服务端权威进度随 state.likeProgress 下发，二者取大值兜底）
      const likeProgress = { total: 0 };
      const subs = new Set();
      const fanout = (name, a, b, c) => {
        for (const h of subs) {
          try { if (h[name]) h[name](a, b, c); } catch (err) { console.error('[sse]', name, err); }
        }
      };
      es.addEventListener('state', e => {
        const st = JSON.parse(e.data);
        applyTheme(st.theme);        // 展示屏：应用主题
        syncThemePicker(st.theme);   // 主播台：同步下拉框
        fanout('onState', st.__game, st, e);
      });
      es.addEventListener('like', e => {
        const g = JSON.parse(e.data);
        likeProgress.total += (Number(g.count) || 1);
        fanout('onLike', g.__game, g, e);
      });
      es.addEventListener('guess', e => {
        const g = JSON.parse(e.data);
        fanout('onGuess', g.__game, g, e);
      });
      es.addEventListener('notice', e => {
        const n = JSON.parse(e.data);
        fanout('onNotice', n.__game, n, e);
      });
      es.addEventListener('moment', e => {
        const m = JSON.parse(e.data);
        fanout('onMoment', m.__game, m, e);
      });
      es.onerror = () => { fanout('onError'); };
      rec = { es, subs, likeProgress };
      _sseByGame.set(key, rec);
    }
    rec.subs.add(handlers);
    return {
      close: () => {
        rec.subs.delete(handlers);
        if (!rec.subs.size) {
          try { rec.es.close(); } catch {}
          _sseByGame.delete(key);
        }
      },
      likeProgress: rec.likeProgress,
    };
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
   * 布局分行：名字一行 / 弹幕一行 / 点赞一行 / 送礼一行 / 进场+关注同行。
   * 模拟事件由宿主统一实现（mockChat/mockLike/mockGift/mockEnter/mockFollow），
   * 走与真实弹幕相同的分发管线 —— 新游戏只要实现 handleDanmu/handleLike 等
   * 标准事件接口即可被模拟，无需写任何 simulate 动作。
   */
  /* 礼物下拉选项（对应 res/礼物资源/ 下的素材名；新增礼物素材后在此追加） */
  const FEED_GIFTS = ['小心心', '玫瑰', '抖音', '啤酒', '666', '人气票', '你最好看', '同心结', '美味烧鸡'];

  function mountFeedTools(mountEl, game, opts = {}) {
    if (!mountEl) return null;
    const getRoomId = opts.getRoomId || (() => '');
    const sim = Object.assign({ chat: true, like: { count: 10 }, gift: true, enter: true, follow: true }, opts.sim || {});
    const chatOpt = sim.chat === true ? {} : (sim.chat || {});
    const likeOpt = sim.like === true ? { count: 10 } : (sim.like || {});

    mountEl.className = 'ctl-roomid-filter';
    mountEl.innerHTML = `
      <div class="feed-rows">
        <div class="feed-row">
          <label class="feed-field">模拟观众名字：
            <input id="simName" type="text" placeholder="观众名字七个字"></label>
        </div>
        ${sim.chat ? `
        <div class="feed-row">
          <label class="feed-field">模拟弹幕：
            <input id="simText" class="feed-chat" type="text" maxlength="40" placeholder="${esc(chatOpt.placeholder || '弹幕文本')}"></label>
          <button id="btnSimChat" class="btn tiny secondary">发送弹幕</button>
        </div>` : ''}
        ${sim.like ? `
        <div class="feed-row">
          <label class="feed-field">点赞×<input id="simLikeCount" type="number" min="1" value="${likeOpt.count ?? 10}"></label>
          <button id="btnSimLike" class="btn tiny secondary">发送点赞</button>
        </div>` : ''}
        ${sim.gift ? `
        <div class="feed-row">
          <label class="feed-field">礼物名：
            <select id="simGiftName">${FEED_GIFTS.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}</select></label>
          <label class="feed-field">×<input id="simGiftCount" type="number" min="1" value="1"></label>
          <button id="btnSimGift" class="btn tiny secondary">模拟送礼</button>
        </div>` : ''}
        <div class="feed-row">
          ${sim.enter ? `<button id="btnSimEnter" class="btn tiny secondary">模拟进场</button>` : ''}
          ${sim.follow ? `<button id="btnSimFollow" class="btn tiny secondary">模拟关注</button>` : ''}
        </div>
      </div>`;

    // 接收直播间ID：独立一行，渲染在挂载容器（#ctlFeedTools 模拟面板）上方
    const roomRow = document.createElement('div');
    roomRow.className = 'feed-roomrow';
    roomRow.innerHTML = `
      <label class="feed-field">接收直播间ID：
        <input id="ctlRoomIdInput" type="text" placeholder="留空=所有房间；多个用逗号分隔"></label>
      <button id="ctlRoomIdApply" class="btn secondary tiny">应用</button>`;
    mountEl.parentNode.insertBefore(roomRow, mountEl);

    const input = roomRow.querySelector('#ctlRoomIdInput');
    const apply = roomRow.querySelector('#ctlRoomIdApply');
    const refresh = () => { const v = getRoomId(); if (v !== undefined && document.activeElement !== input) input.value = v || ''; };
    refresh();
    apply.onclick = () => control(game, 'setRoomFilter', { roomId: input.value.trim() });

    const simName = () => (mountEl.querySelector('#simName') || {}).value?.trim() || '观众名字七个字';
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
      const sel = mountEl.querySelector('#simGiftName');
      return {
        giftName: sel ? sel.value : '',
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

  /* ───────────── 排行榜统一组件：前三名固定 + 第 4~50 名从下到上无缝轮播 ─────────────
   * 所有游戏的总排行榜统一走这里渲染：.lb-th 表头 + 前三名固定不动，
   * 第 4~50 名进 .lb-rot-track 无缝向上滚动循环（CSS 动画，不占 JS 定时器）。
   * list 项须含 rank/name/avatar；分数列用 opts.totalScore(r)，默认 r.totalScore ?? r.score ?? 0。
   * speed = 滚动速度（px/s，默认 26）。指纹守卫：榜单未变化时保留现有 DOM（不打断滚动）。 */
  function mountLeaderboard(box, list, opts = {}) {
    if (!box) return null;
    const totalScore = opts.totalScore || (r => r.totalScore ?? r.score ?? 0);
    const scoreLabel = opts.scoreLabel || '得分';   // 第三列表头（如数独用「MVP」）
    const speed = Math.max(8, opts.speed || 26);   // 滚动速度 px/s

    const rows = (Array.isArray(list) ? list : []).slice(0, 50);
    const fp = rows.map(r => `${r.rank}|${r.name}|${totalScore(r) ?? 0}`).join(',');
    if (box._lbFp === fp) return (box._lbHandle || null);
    box._lbFp = fp;
    const head = `<div class="lb-th"><span class="rk">名次</span><span class="nm">玩家</span><span class="sc">${esc(scoreLabel)}</span></div>`;
    const rowHTML = (r, extra = '') =>
      `<div class="lb-row${extra}">
        <span class="rk">${r.rank || ''}</span>
        ${DG.avatarHTML(r.name, r.avatar)}
        <span class="nm">${esc(r.name)}</span>
        <span class="sc">${esc(String(totalScore(r) ?? 0))}</span>
      </div>`;

    if (!rows.length) {
      box.innerHTML = head + '<div class="lb-empty">暂无榜单数据</div>';
      return null;
    }

    box.classList.add('lb-flex-col');               // 纵向弹性布局：轮播视口吃满剩余高度
    const top3 = rows.slice(0, 3);
    const rest = rows.slice(3);                     // 第 4~50 名

    if (!rest.length) {
      box.innerHTML = head + top3.map((r, i) => rowHTML(r, ' r' + (i + 1))).join('');
      return null;
    }

    // 先按单份内容渲染，再测量：内容超出视口才启用「第4名↔第50名首尾相连」的无缝循环，
    // 没超出就静态平铺（不滚）。测量在下一帧布局完成后进行。
    box.innerHTML = head
      + top3.map((r, i) => rowHTML(r, ' r' + (i + 1))).join('')
      + `<div class="lb-rot-viewport"><div class="lb-rot-track">${rest.map(r => rowHTML(r)).join('')}</div></div>`;

    const viewport = box.querySelector('.lb-rot-viewport');
    const track = box.querySelector('.lb-rot-track');
    requestAnimationFrame(() => {
      if (!track || !viewport || track.dataset.rolled) return;
      const contentH = track.scrollHeight;          // 单份内容高度
      const viewH = viewport.clientHeight;
      if (contentH > viewH + 1) {
        // 超出显示区域 → 复制一份内容，translateY(-50%) 恰好滚过一份 → 第4名与第50名首尾相连循环
        const dur = Math.min(150, Math.max(12, Math.round(contentH / speed)));
        track.innerHTML = track.innerHTML + track.innerHTML;
        track.style.animationDuration = dur + 's';
        track.classList.add('lb-rot-anim');
        track.dataset.rolled = '1';
      }
    });
    return null;
  }

  /* ───────────── 观众时刻演出（展示屏侧边如画横幅） ─────────────
   * 展示屏自动挂载（游戏零改动）：进场/关注/送礼事件从右侧滑入卡片，
   * 带观众头像 + 事件文案 + 其在本玩法的排名/得分；不遮挡游戏画面主体。
   * 防刷屏策略：同屏最多 3 张；连发时按 送礼＞关注＞进场 排队，队列超限先丢进场；
   * 2.5s 内连续进场合并为「A、B 等 N 人」；同用户同礼物连击只涨计数 + 补粒子。
   * 演出风格（data-skin）由宿主按游戏托管，随 moment 事件下发，主播台可切换。
   */
  /* 风格列表（与 host/server.js 的 VALID_MOMENT_SKINS 保持同步；样式见 base.css） */
  const MOMENT_SKINS = [
    { id: 'aurora', name: '流光（默认）' },
    { id: 'neon', name: '霓虹电波' },
    { id: 'meteor', name: '星雨' },
    { id: 'scroll', name: '鎏金画卷' },
  ];
  const MOMENT_PRIORITY = { gift: 3, follow: 2, enter: 1 };
  const MOMENT_STAY = { gift: 4200, follow: 3000, enter: 2200 };   // 停留时长也递进：送礼最久
  const MOMENT_MAX_VISIBLE = 3;

  function initMomentStage(game) {
    const host = document.querySelector('.phone') || document.body;
    const stack = document.createElement('div');
    stack.className = 'moment-stack';
    stack.dataset.skin = 'aurora';
    host.appendChild(stack);

    const queue = [];
    let visible = 0;
    let lastEnter = null;          // 进行中的进场合并卡 { card, names, total }
    const giftCards = new Map();   // `${name}|${giftName}` → { card, countEl, count, onGone }

    function enqueue(m) {
      if (m.type === 'enter' && lastEnter && document.contains(lastEnter.card)) {
        // 合并进场：刷新已有卡文案
        lastEnter.total++;
        lastEnter.names.push(m.user.name);
        if (lastEnter.names.length > 3) lastEnter.names = lastEnter.names.slice(-3);
        renderEnterTitle(lastEnter);
        return;
      }
      if (m.type === 'gift') {
        const key = m.user.name + '|' + (m.giftName || '礼物');
        const ex = giftCards.get(key);
        if (ex && document.contains(ex.card)) {
          // 连击：计数 ×N + 弹跳 + 补粒子 + 延长停留（\u00D7 = ×，纯 ASCII 源码防编码剥离）
          ex.count += (m.giftCount || 1);
          ex.countEl.textContent = '\u00D7' + ex.count;
          ex.countEl.classList.remove('moment-count-bump');
          void ex.countEl.offsetWidth;
          ex.countEl.classList.add('moment-count-bump');
          spawnSparks(ex.card);
          armOut(ex.card, MOMENT_STAY.gift, ex.onGone);
          return;
        }
      }
      queue.push(m);
      while (queue.length > 8) {
        let idx = queue.findIndex(x => x.type === 'enter');
        if (idx < 0) idx = queue.findIndex(x => x.type === 'follow');
        if (idx < 0) idx = 0;
        queue.splice(idx, 1);
      }
      pump();
    }

    function pump() {
      if (visible >= MOMENT_MAX_VISIBLE || !queue.length) return;
      queue.sort((a, b) => (MOMENT_PRIORITY[b.type] || 0) - (MOMENT_PRIORITY[a.type] || 0));
      show(queue.shift());
    }

    function show(m) {
      visible++;
      const card = buildCard(m);
      stack.appendChild(card);
      if (m.type === 'gift') {
        const key = m.user.name + '|' + (m.giftName || '礼物');
        const onGone = () => giftCards.delete(key);
        giftCards.set(key, {
          card,
          countEl: card.querySelector('.moment-count'),
          count: m.giftCount || 1,
          onGone,
        });
        spawnSparks(card);
        armOut(card, MOMENT_STAY.gift, onGone);
      } else {
        if (m.type === 'enter') {
          lastEnter = { card, names: [m.user.name], total: 1 };
          renderEnterTitle(lastEnter);
        }
        armOut(card, MOMENT_STAY[m.type] || 2600, () => {
          if (lastEnter && lastEnter.card === card) lastEnter = null;
        });
      }
    }

    /** 到点滑出并回收；可重复调用以延长停留（内部先清旧定时器） */
    function armOut(card, stay, onGone) {
      card._cleanup && card._cleanup();
      card.classList.remove('moment-out');
      const t1 = setTimeout(() => card.classList.add('moment-out'), Math.max(200, stay - 380));
      const t2 = setTimeout(() => {
        card.remove();
        visible--;
        onGone && onGone();
        pump();
      }, stay);
      card._cleanup = () => { clearTimeout(t1); clearTimeout(t2); };
    }

    function renderEnterTitle(rec) {
      const el = rec.card.querySelector('.moment-title');
      if (!el) return;
      const shown = rec.names.join('、');
      const more = rec.total > rec.names.length ? ` 等 ${rec.total} 人` : '';
      el.innerHTML = `<b>${esc(shown)}</b>${more} 进入直播间`;
    }

    function buildCard(m) {
      const card = document.createElement('div');
      card.className = 'moment-card moment-' + (m.type || 'enter');
      const shine = '<span class="moment-shine"></span>';
      const speed = m.type === 'gift' ? '<span class="moment-speed"></span>' : '';
      let title;
      let giftLine = '';
      let countCol = '';
      if (m.type === 'gift') {
        const img = m.giftImage ? `<img src="${esc(m.giftImage)}" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
        // 两行布局：第一行「名字(限宽省略) 送出」，第二行整行给礼物图标/礼物名；
        // ×N 数量单独放卡片最右侧，竖排大字占约三行（见 base.css .moment-count）
        title = `<b>${esc(m.user.name)}</b> 送出`;
        giftLine = `<div class="moment-giftline"><span class="moment-giftchip">${img}<span class="moment-gname">${esc(m.giftName || '礼物')}</span></span></div>`;
        countCol = `<span class="moment-count">&times;${m.giftCount || 1}</span>`;
      } else if (m.type === 'follow') {
        title = `<b>${esc(m.user.name)}</b> 关注了主播 ❤`;
      } else {
        title = `<b>${esc(m.user.name)}</b> 进入直播间`;
      }
      const sub = m.gameInfo
        ? `🎮 本玩法第 ${m.gameInfo.rank} 名 · ${m.gameInfo.score} 分`
        : (m.type === 'gift' ? '🎁 感谢礼物' : '');
      card.innerHTML = `${shine}${speed}
        <span class="moment-avatar">${avatarHTML(m.user.name, m.user.avatar)}</span>
        <div class="moment-body">
          <div class="moment-title">${title}</div>
          ${giftLine}
          ${sub ? `<div class="moment-sub">${sub}</div>` : ''}
        </div>${countCol}`;
      return card;
    }

    function spawnSparks(card, count = 18) {
      const colors = isLightTheme() ? FIREWORK_LIGHT : FIREWORK_DARK;
      for (let i = 0; i < count; i++) {
        const p = document.createElement('span');
        p.className = 'moment-spark';
        const ang = Math.random() * Math.PI * 2;
        const dist = 26 + Math.random() * 44;
        p.style.cssText = `--dx:${(Math.cos(ang) * dist).toFixed(0)}px;--dy:${(Math.sin(ang) * dist).toFixed(0)}px;`
          + `left:${(28 + Math.random() * 34).toFixed(0)}%;top:${(26 + Math.random() * 48).toFixed(0)}%;`
          + `background:${colors[(Math.random() * colors.length) | 0]};`;
        card.appendChild(p);
        setTimeout(() => p.remove(), 900);
      }
    }

    connectSSE(game, {
      onMoment: (_gid, m) => {
        // 风格由宿主随事件下发：切换「演出风格」后下一条观众时刻即换装
        if (m.skin && stack.dataset.skin !== m.skin) stack.dataset.skin = m.skin;
        enqueue(m);
      },
    });
  }

  function autoMountMomentStage() {
    if (!isStage()) return;
    // 与 stage.js 同一 game 键（优先 ?game=，否则从路径 /games/<id>/ 推断），
    // 这样能复用页面里已有的那条 SSE，而不是再占一条浏览器连接
    const qGame = new URLSearchParams(location.search).get('game');
    const pathMatch = location.pathname.match(/\/games\/([^/]+)\//);
    const game = qGame || (pathMatch && pathMatch[1]) || '';
    initMomentStage(game);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMountMomentStage);
  else autoMountMomentStage();

  /** 主播台「演出风格」选择器：自动插在 [data-theme-picker]（展示屏主题行）后面，游戏零改动 */
  function autoMountMomentSkinPicker() {
    if (isStage()) return;
    document.querySelectorAll('[data-theme-picker]').forEach(el => {
      const game = new URLSearchParams(location.search).get('game') || el.dataset.game || '';
      if (!game) return;
      const row = document.createElement('div');
      row.className = 'theme-row';
      row.innerHTML = `演出风格 <select class="moment-skin-select">${
        MOMENT_SKINS.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>`;
      el.after(row);
      const select = row.querySelector('select');
      fetch('/api/games').then(r => r.json()).then(j => {
        const g = (j.games || []).find(x => x.id === game);
        if (g && g.momentSkin) select.value = g.momentSkin;
      }).catch(() => { /* 服务未就绪时保留默认项 */ });
      select.addEventListener('change', async () => {
        const r = await control(game, 'setMomentSkin', { skin: select.value });
        if (r && r.ok) showToast('演出风格已切换（展示屏收到下一条观众时刻时生效）');
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMountMomentSkinPicker);
  else autoMountMomentSkinPicker();

  /* ═══════════ 展示屏小屏自适应（只缩不放） ═══════════
     大屏（视口 ≥ 设计基准）：保持原行为——.phone 宽度自适应、内部固定 px 字号不变。
       框变大而字不变，信息密度更高；若此时也等比放大会导致「同高度装不下同样多内容」。
     小屏（视口 < 设计基准）：.phone 固定为基准宽并整体 zoom 缩小，字号随之等比缩小，
       解决「容器缩小、字号不变导致文字溢出/截断」。
     s = 1 处两种算法连续（渲染尺寸仅差亚像素），切换无跳变。 */
  const STAGE_BASE_W = 600;
  const STAGE_BASE_H = (600 * 16) / 9;   // 1066.67（9:16）
  const SUPPORT_ZOOM = 'zoom' in document.documentElement.style;

  function fitStage() {
    const phone = document.querySelector('.phone');
    if (!phone) return;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    // 与 #view-stage 的 padding(6px × 2) 对齐，四周留 12px
    const s = Math.min((vw - 12) / STAGE_BASE_W, (vh - 12) / STAGE_BASE_H);

    if (s >= 1) {
      // 大屏：清掉内联覆盖，回到 base.css 的自适应宽度；不放大
      phone.style.width = '';
      phone.style.zoom = '1';
      phone.style.transform = 'none';
      return;
    }

    // 小屏：固定基准宽 + 整体等比缩小
    phone.style.width = STAGE_BASE_W + 'px';
    const scale = Math.max(0.2, s);        // 下限 0.2，避免极端窄窗缩到不可见
    if (SUPPORT_ZOOM) {
      phone.style.transform = 'none';
      phone.style.zoom = String(scale);
    } else {
      // 不支持 zoom 的旧浏览器：退回 transform（同样以中心等比缩放，视觉一致）
      phone.style.transformOrigin = 'center';
      phone.style.transform = `scale(${scale})`;
    }
  }

  function autoFitStage() {
    if (!isStage()) return;                // 仅展示屏生效，主播台不受影响
    fitStage();
    window.addEventListener('resize', fitStage);
    window.addEventListener('orientationchange', fitStage);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoFitStage);
  else autoFitStage();

  return {
    $, esc, initialOf, avatarHTML, showToast, control, connectSSE, launchFireworks,
    mountRoomFilter, mountFeedTools, mountLeaderboard,
    THEMES, applyTheme, mountThemePicker, fitStage,
  };
})();
