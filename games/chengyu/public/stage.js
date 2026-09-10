/* ══════════════════════════════════════════════════════════════════
   stage.js — 成语接龙 · 展示屏逻辑（games/chengyu/public）
   订阅本游戏 SSE 状态流；楼塔 / 排行榜 / 目标层 / 实时反馈
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc } = DG;

  let state = null;
  let feedQueue = [];   // 最近弹幕反馈（展示屏实时区）

  const GAME = new URLSearchParams(location.search).get('game') || 'chengyu';

  DG.connectSSE(GAME, {
    onState: (_gid, st) => {
      state = st;
      if ($('cyPhone')) $('cyPhone').style.display = '';
      render();
    },
    onNotice: (_gid, n) => {
      if (n && n.text) pushFeed({ text: n.text, ok: 0 });
    },
    onError: () => {
      if ($('cyCdNum')) $('cyCdNum').textContent = '--';
    },
  });

  // 每秒刷新倒计时 + 进度条
  setInterval(() => {
    if (!state) return;
    const d = state.deadline || 0;
    const remain = Math.max(0, Math.ceil((d - Date.now()) / 1000));
    const numEl = $('cyCdNum');
    if (numEl) numEl.textContent = (state.status === 'playing' && d) ? remain : '--';
    let pct = 0;
    if (state.status === 'playing' && d && state.pendingSec) {
      pct = Math.min(100, Math.max(0, ((d - Date.now()) / 1000) / state.pendingSec * 100));
    }
    const fill = $('cyProgFill');
    if (fill) fill.style.width = pct.toFixed(1) + '%';
  }, 200);

  function pushFeed({ text, ok }) {
    feedQueue.unshift({ text, ok, ts: Date.now() });
    if (feedQueue.length > 6) feedQueue.length = 6;
    renderFeed();
  }

  function renderFeed() {
    const box = $('cyFeed');
    if (!box) return;
    box.innerHTML = feedQueue.map(f =>
      `<div class="cy-feed-item"><span class="${f.ok ? 'ok' : 'bad'}">${esc(f.text)}</span></div>`).join('');
  }

  function render() {
    renderBadge();
    renderGoal();
    renderTower();
    renderBoardIfChanged();
    renderFoot();
  }

  /* 排行榜指纹防抖：数据真变化才重建（否则每次 SSE 推送都重建，入场动画会反复重播）。
     与猜数字 renderBoardIfChanged 保持一致，两游戏观感同步。 */
  let lbFingerprint = '';
  function renderBoardIfChanged() {
    const list = state.leaderboard || [];
    const fp = list.map(r => `${r.rank}|${r.name}|${r.totalScore != null ? r.totalScore : ((r.guess_score || 0) + (r.chengyu_score || 0))}`).join(',');
    if (fp === lbFingerprint) return;
    lbFingerprint = fp;
    renderBoard(true);
  }

  /* 计分规则：实际配置的基础分 & 三档连接系数 */
  function renderFoot() {
    const el = $('cyFoot');
    if (!el) return;
    const base = state.cfg && state.cfg.baseScore ? state.cfg.baseScore : 100;
    el.innerHTML = `最后得分 = 基础分 <b style="color:var(--gold)">${base}</b> × 连接系数 × (1 + 剩余占比)`;
  }

  function renderBadge() {
    const b = $('cyBadge');
    if (b) b.textContent = `盖楼 ${state.floorCount || 0} 层 · ${state.status === 'playing' ? '接龙中' : (state.status === 'paused' ? '已暂停' : '待开局')}`;
    const f = $('cyFloorCount');
    if (f) f.textContent = String(state.floorCount || 0);
  }

  function renderGoal() {
    const t = $('cyGoalTitle');
    const s = $('cyGoalSub');
    if (!t || !s) return;
    if (state.status === 'playing' && state.chain && state.chain.length) {
      const top = state.chain[state.chain.length - 1];
      const tailPy = (top.py && top.py[top.py.length - 1]) || '';
      // ① 请接「真」+ 拼音
      t.innerHTML = `▼ 盖第 <b>${state.chain.length + 1}</b> 层 · 请接「<b style="color:var(--gold)">${esc(top.tailChar)}</b><span class="cy-py-inline">${tailPy ? esc(tailPy) : ''}</span>」开头 ▼`;
      // ② 始终显示最高楼层（顶层）成语四字全拼音 + 尾字金色标识（突出"要接的字"）
      s.innerHTML = `${wordWithPy(top, { tailCls: 'c-same', big: true })}`;
      // ③ 顶层成语的意译 & 出处
      const jyEl = $('cyGoalJy');
      if (jyEl) {
        const jy = top.jy || '';
        const cy = top.cy || '';
        if (jy || cy) {
          jyEl.style.display = 'block';
          jyEl.innerHTML = `${jy ? `<div class="jy-txt"><span class="jy-lb">释义：</span>${esc(jy)}</div>` : ''}${cy ? `<div class="jy-cy"><span class="jy-lb">出处</span>${esc(cy)}</div>` : ''}`;
        } else {
          jyEl.style.display = 'none';
        }
      }
    } else {
      t.textContent = state.status === 'paused' ? '已暂停' : '等待开局…';
      s.textContent = '主播开局后，弹幕发 4 字成语即可盖楼';
      const jyEl = $('cyGoalJy');
      if (jyEl) jyEl.style.display = 'none';
    }
  }

  /* 生成「字+拼音」HTML。headCls/tailCls 为首/尾字的自定义颜色类（如 c-same） */
  function wordWithPy(f, opts = {}) {
    const arr = (f.word || '').split('');
    const pyArr = f.py && f.py.length === arr.length ? f.py : arr.map(() => '');
    return arr.map((ch, i) => {
      const isTail = i === arr.length - 1;
      const isHead = i === 0;
      const hanCls = [
        opts.headCls && isHead ? opts.headCls : '',
        opts.tailCls && isTail ? opts.tailCls : '',
      ].filter(Boolean).join(' ');
      const cls = [
        'cy-ch',
        opts.big ? 'cy-ch-big' : '',
      ].filter(Boolean).join(' ');
      return `<span class="${cls}" title="${esc(ch)}"><span class="cy-han ${hanCls}">${esc(ch)}</span><i class="cy-py">${pyArr[i] ? esc(pyArr[i]) : ''}</i></span>`;
    }).join('');
  }

  /* 连接类型 → 颜色类 */
  const CONN_COLOR = { same: 'c-same', tone: 'c-tone', rhyme: 'c-rhyme' };

  function renderTower() {
    const box = $('cyTower');
    if (!box) return;
    const chain = (state.chain || []).slice().reverse(); // 新的在上
    box.innerHTML = chain.map((f, idx) => {
      const isTop = idx === 0;
      const isSeed = f.connType === 'seed';
      const connTag = f.connName ? `<span class="cy-tag cy-tag-${f.connType}">${f.connName}</span>` : '';
      const avatar = DG.avatarHTML(isSeed ? '系' : (f.user || '?'), f.avatar);
      // 连接色：本层首字用本层连接色；本层尾字颜色留给"下一层（更新的楼）"决定，顶部未有接则无色
      // nextIdx：在 reversed 数组中 idx-1 是更上层（更新），它若存在则用它连接色标记本层尾字
      const upper = idx > 0 ? chain[idx - 1] : null;   // 更新的一层（已接在本层之上）
      const headCls = (!isSeed && f.connType) ? (CONN_COLOR[f.connType] || '') : '';
      const tailCls = (upper && upper.connType && CONN_COLOR[upper.connType]) || '';
      return `<div class="cy-floor ${isTop ? 'top' : ''} ${isSeed ? 'seed' : ''}">
        <div class="cy-floor-row1">
          <span class="cy-floor-f">${state.chain.length - idx}F</span>
          ${avatar}
          <span class="cy-floor-name">${esc(isSeed ? '起始词' : f.user)}</span>
          ${connTag}
          <span class="cy-floor-score">${isSeed ? '' : '+' + f.score}</span>
        </div>
        <div class="cy-floor-row2">
          ${wordWithPy(f, { headCls, tailCls })}
        </div>
      </div>`;
    }).join('');
  }

  function renderBoard(withAnim = false) {
    const box = $('cyBoard');
    if (!box) return;
    // 统一排行榜组件：前三名固定 + 第4~50名轮播（common/public/core.js）
    DG.mountLeaderboard(box, state.leaderboard || [], {
      totalScore: r => (r.totalScore != null ? r.totalScore : ((r.guess_score || 0) + (r.chengyu_score || 0))),
    });
  }
})();
