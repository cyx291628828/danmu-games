/* ══════════════════════════════════════════════════════════════════
   stage.js — 弹幕五子棋 · 展示屏逻辑（games/gomoku/public）
   9:16 竖屏投屏 / OBS 浏览器源；订阅本游戏 SSE 状态流
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, initialOf, connectSSE, launchFireworks } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'gomoku';
  let state = null;
  let lastRoundNo = -1;
  let lastFinishedAt = 0;      // 已放过烟花的结算时间戳（去重）
  let winBannerTimer = null;
  let bannerShownAt = 0;
  let winBannerShown = false;

  /* 中文段位：数字 1-10 → 一…十（用于「N段」徽章/结算展示） */
  const DAN_CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  function danOf(lv) {
    const n = parseInt(lv, 10) || 0;
    return n >= 1 && n <= 10 ? DAN_CN[n] + '段' : (n > 0 ? n + '段' : '无段');
  }

  const boardEl = $('board');
  let cellEls = [];
  let cellCache = [];          // 每格指纹（值|last|win|forbid）
  let prevVal = [];            // 上一帧棋子值（0/1/2，动画检测用）

  /* 棋盘按「手机框内剩余宽/高较小者」锁定为正方形：
     - 版式上 .board-wrap 只占棋盘本身高度（flex:0 1 auto），空余垂直空间全部交给
       下方 .lower（战报/排行榜列表内部滚动），棋盘上下不再留大片空位；
     - 可用高度 = 手机内高 − 固定区块 − 下方面板最小高（其余空间由 lower 吸收），
       宽窄双轴都成立，1080×1920 投屏实测 1002→1020px 且无空隙。 */
  const bwrapEl = document.querySelector('.board-wrap');
  const binnerEl = document.getElementById('bwrapInner');
  const phoneEl = document.querySelector('.phone');
  const BOARD_FIXED_SECS = ['.top', '.turn-bar', '.howto'];
  const LOWER_MIN_H = 128;   // 下方面板最小高度（多出的空间由它滚动吸收）
  function fitBoard() {
    if (!bwrapEl || !binnerEl || !phoneEl) return;
    let others = 40;   // .phone 上下内边距(30) + .mid 上边距(10)
    for (const sel of BOARD_FIXED_SECS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const st = getComputedStyle(el);
      others += el.offsetHeight + (parseFloat(st.marginTop) || 0) + (parseFloat(st.marginBottom) || 0);
    }
    const availH = Math.max(120, phoneEl.clientHeight - others - LOWER_MIN_H);
    const availW = bwrapEl.clientWidth;
    const s = Math.floor(Math.min(availW, availH));
    if (s > 40) { binnerEl.style.width = s + 'px'; binnerEl.style.height = s + 'px'; }
  }
  if (phoneEl) new ResizeObserver(fitBoard).observe(phoneEl);
  window.addEventListener('resize', fitBoard);

  connectSSE(GAME, {
    onState: (_gid, st) => { state = st; renderAll(); },
    onGuess: (_gid, op) => { if (op && op.kind === 'feed') { appendOp(op); fxFromFeed(op); } },
    onError: () => { $('turnCd').textContent = '--'; },
  });

  /* ══════════════ 棋盘构建 ══════════════ */
  const STAR_SETS = { 13: [[3, 3], [9, 3], [6, 6], [3, 9], [9, 9]], 15: [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]] };
  /* 中心螺旋编号（1..N*N，天元=1，顺时针向外递增），与 engine.spiralMap 同算法。
     每格淡显该编号，观众报编号即可落子（避免从左侧/上方行标找坐标出错）。 */
  function spiralOf(size) {
    const total = size * size, c = Math.floor((size - 1) / 2);
    const out = new Array(total);
    let x = c, y = c, sp = 1;
    out[y * size + x] = sp;
    let dx = 1, dy = 0, seg = 1, legs = 0;
    while (sp < total) {
      for (let i = 0; i < seg; i++) { x += dx; y += dy; sp++; if (sp > total) break; out[y * size + x] = sp; }
      const nx = -dy, ny = dx; dx = nx; dy = ny; legs++;
      if (legs % 2 === 0) seg++;
    }
    return out;
  }
  function buildBoard(size) {
    boardEl.innerHTML = '';
    boardEl.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
    boardEl.style.gridTemplateRows = `repeat(${size}, 1fr)`;
    // 列标 1..（顶，X 轴数字）、行标 A..（左，Y 轴字母）——与弹幕坐标「字母=行、数字=列」一致
    const colL = $('colLabels'), rowL = $('rowLabels');
    colL.innerHTML = ''; rowL.innerHTML = '';
    for (let x = 0; x < size; x++) {
      const s = document.createElement('span');
      s.textContent = x + 1;
      colL.appendChild(s);
    }
    for (let y = 0; y < size; y++) {
      const s = document.createElement('span');
      s.textContent = String.fromCharCode(65 + y);
      rowL.appendChild(s);
    }
    const stars = STAR_SETS[size] || null;
    const spiral = spiralOf(size);
    cellEls = [];
    cellCache = [];
    prevVal = [];
    for (let i = 0; i < size * size; i++) {
      const c = document.createElement('div');
      c.className = 'cell';
      if (stars && stars.some(([sx, sy]) => sy * size + sx === i)) c.classList.add('star');
      const sp = document.createElement('span');
      sp.className = 'spiral';
      sp.textContent = spiral[i];
      c.appendChild(sp);
      boardEl.appendChild(c);
      cellEls.push(c);
      cellCache.push('');
      prevVal.push(0);
    }
  }

  function renderBoard() {
    if (!state) return;
    const size = state.size || 15;
    if (cellEls.length !== size * size) buildBoard(size);
    const board = state.board || '';
    const forbidSet = new Set(state.forbiddenPts || []);
    const winSet = new Set((state.result && state.result.winCells) || []);
    const lastMoves = [];
    // 最后一手最近 1 手（仅当对局仍在进行或结算中标记最近一手）
    if (state.lastMove >= 0) lastMoves.push(state.lastMove);
    for (let i = 0; i < cellEls.length; i++) {
      const el = cellEls[i];
      const v = board[i] === '1' ? '1' : board[i] === '2' ? '2' : '0';
      const isLast = lastMoves.includes(i);
      const isWin = winSet.has(i);
      const isForbid = forbidSet.has(i);
      const fp = `${v}${isLast ? 'L' : ''}${isWin ? 'W' : ''}${isForbid ? 'F' : ''}`;
      if (fp === cellCache[i]) continue;
      // 动画检测：新落子弹跳 / 悔棋消失 / 禁手误落红闪
      if (prevVal[i] === 0 && v !== '0') { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
      if (prevVal[i] !== 0 && v === '0') { el.classList.remove('removed'); void el.offsetWidth; el.classList.add('removed'); }
      prevVal[i] = v === '0' ? 0 : (v === '1' ? 1 : 2);
      cellCache[i] = fp;
      // 一次性动画类必须跟着重绘清掉：pop/removed/bad 都是「本次变化」的即时反馈，
      // 残留到下枚棋子上会让 forwards 动画把新棋子永久淡出（表现为「落子后消失、刷新才出现」）
      el.classList.remove('st1', 'st2', 'last', 'win', 'forbid', 'pop', 'removed', 'bad');
      el.querySelectorAll('.stone, .mv-av').forEach(n => n.remove());
      if (v === '1') el.appendChild(stoneNode('b'));
      else if (v === '2') el.appendChild(stoneNode('w'));
      if (isLast) {
        el.classList.add('last');
        const mv = (state.moves || []).slice().reverse().find(m => m.i === i);
        if (mv && mv.name) el.appendChild(mvAvatar(mv));
      }
      if (isWin) el.classList.add('win');
      if (isForbid) el.classList.add('forbid');
    }
  }

  function stoneNode(kind) {
    const s = document.createElement('span');
    s.className = 'stone ' + kind;
    return s;
  }
  function mvAvatar(mv) {
    const w = document.createElement('span');
    w.className = 'mv-av';
    if (mv.avatar) {
      const img = document.createElement('img');
      img.src = mv.avatar;
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.remove(); w.textContent = initialOf(mv.name); };
      w.appendChild(img);
    } else {
      w.textContent = initialOf(mv.name);
    }
    return w;
  }

  /** 战报事件 → 棋面特效 */
  function fxFromFeed(f) {
    if (!f) return;
    if (f.type === 'forbid' && typeof f.idx === 'number' && cellEls[f.idx]) {
      const el = cellEls[f.idx];
      el.classList.remove('bad');
      void el.offsetWidth;
      el.classList.add('bad');
    }
  }

  /* ══════════════ 顶部：模式 / 回合 ══════════════ */
  function renderTop() {
    const mode = state.mode === 'pvp' ? '双人对决' : '人机对决';
    $('modeBadge').textContent = mode + (state.mode === 'pvp' ? '' : ` ${state.botLevelName || ('Lv' + state.botLevel)}`);
    $('stRound').textContent = `ROUND ${state.roundNo || 0}`;
    $('htGift').textContent = '+' + (state.cfg.giftSortBonus ?? 30);

    // 座位卡
    for (const side of ['black', 'white']) {
      const seat = state.seats[side];
      const card = $(side === 'black' ? 'pBlack' : 'pWhite');
      const nameEl = $(side === 'black' ? 'pBlackName' : 'pWhiteName');
      const tagEl = $(side === 'black' ? 'pBlackTag' : 'pWhiteTag');
      const avEl = $(side === 'black' ? 'pBlackAv' : 'pWhiteAv');
      avEl.innerHTML = '';
      if (!seat) {
        card.classList.add('empty');
        nameEl.textContent = '虚位以待';
        tagEl.textContent = '--';
      } else {
        card.classList.remove('empty');
        nameEl.textContent = seat.name;
        // ready 态：tag 显示就绪状态（未开局，暂不展示段位/胜率）
        if (state.status === 'ready' && seat.kind === 'viewer') {
          tagEl.textContent = seat.ready ? '✅ 已就绪' : '⏳ 等待发「准备」';
        } else {
          tagEl.textContent = seat.kind === 'viewer'
            ? `${seat.badge > 0 ? danOf(seat.badge) : '无段'} · 胜率 ${seat.games > 0 ? seat.winRate + '%' : '--%'}`
            : (seat.levelName || `AI Lv${seat.level || 0}`);
        }
        avEl.innerHTML = DG.avatarHTML(seat.name, seat.avatar);
      }
      const active = state.status === 'playing' && state.turn === side;
      card.classList.toggle('active', active);
      // 状态气泡：对局中 = 当前执子提示；ready 态 = 是否已发「准备」（绝对定位浮在卡片上缘，不占布局）
      const prevPill = card.querySelector('.turn-pill');
      if (active) {
        if (prevPill) prevPill.remove();
        const pill = document.createElement('span');
        pill.className = 'turn-pill';
        pill.textContent = seat && seat.kind !== 'viewer'
          ? '🤖 思考中'
          : (side === 'black' ? '▶落子' : '◀落子');
        card.appendChild(pill);
      } else if (state.status === 'ready' && seat && seat.kind === 'viewer') {
        if (prevPill) prevPill.remove();
        const pill = document.createElement('span');
        pill.className = 'turn-pill ready' + (seat.ready ? ' on' : '');
        pill.textContent = seat.ready ? '✅ 已就绪' : '⏳ 请发「准备」';
        card.appendChild(pill);
      } else if (prevPill) {
        prevPill.remove();
      }
    }
    tickTurn();
  }

  /* 回合指示与倒计时（本地自驱；暂停用服务端冻结值定格） */
  function tickTurn() {
    const txt = $('turnTxt'), cd = $('turnCd');
    if (!state) return;
    cd.classList.remove('thinking');
    if (state.status === 'playing') {
      const seat = state.seats && state.seats[state.turn];
      if (!seat) { txt.textContent = '等待上座'; cd.textContent = ''; return; }
      if (state.deadline > 0) {
        const remain = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
        txt.textContent = `${state.turn === 'black' ? '⚫' : '⚪'} ${seat.name} 落子中`;
        cd.textContent = remain + 's';
      } else if (seat.kind === 'viewer') {
        txt.textContent = `${state.turn === 'black' ? '⚫' : '⚪'} ${seat.name} 落子中（不限时）`;
        cd.textContent = '';
      } else {
        txt.textContent = `${seat.name} 思考中`;
        cd.textContent = '🤖';
        cd.classList.add('thinking');
      }
    } else if (state.status === 'paused') {
      txt.textContent = '⏸ 已暂停';
      const remain = (state.pausedTurnRemain || 0) > 0 ? state.pausedTurnRemain : (state.deadline || 0) - Date.now();
      cd.textContent = remain > 0 ? Math.max(0, Math.ceil(remain / 1000)) + 's' : '';
    } else if (state.status === 'ready') {
      // 准备确认：点名等待观众发「准备」；倒计时本地自驱（readyDeadline 由服务端下发）
      const pend = (state.seats && ['black', 'white'].filter(sd => state.seats[sd] && state.seats[sd].kind === 'viewer' && !state.seats[sd].ready)
        .map(sd => state.seats[sd].name)) || [];
      const ttl = state.readyDeadline > 0 ? Math.max(0, Math.ceil((state.readyDeadline - Date.now()) / 1000)) : -1;
      txt.textContent = pend.length
        ? `⏳ 等待「${pend.join('、')}」发送「准备」`
        : '⏳ 双方已就绪，即将开局…';
      cd.textContent = ttl < 0 ? '' : (ttl + 's');
      // 浮层第二行同步跳动（renderWaitTip 只在状态推送时刷新，此处 1s 修正）
      const subEl = document.getElementById('wtSub');
      if (subEl && state.status === 'ready' && !$('waitTip').classList.contains('hidden')) {
        subEl.textContent = ttl < 0 ? '等待观众发送「准备」…' : `⏳ ${ttl}s 内未发「准备」将自动让座 · 下一位顶上`;
      }
    } else if (state.status === 'result') {
      txt.textContent = '本局结束，下一局马上开始';
      cd.textContent = '';
    } else if (state.status === 'waiting') {
      txt.textContent = '等待观众上座…';
      cd.textContent = '';
    } else {
      txt.textContent = '等待开局';
      cd.textContent = '';
    }
  }
  setInterval(tickTurn, 1000);
  setInterval(tickResultCountdown, 250);

  /* 结算弹窗「下一局倒计时」胶囊 */
  function tickResultCountdown() {
    if (!state || !winBannerShown || !bannerShownAt) return;
    const nx = $('winNext');
    const resultSecs = (state.cfg && state.cfg.resultShowSec) || 15;
    const remain = Math.max(0, Math.ceil((resultSecs * 1000 - (Date.now() - bannerShownAt)) / 1000));
    nx.style.display = 'block';
    nx.textContent = `下一局 ${remain}s 后开始`;
  }

  /* ══════════════ 侧栏等候队列（左：队尾→队头在下贴近黑方；右：队头在上→队尾；人机模式右侧无队列） ══════════════ */
  let queueFp = '';
  function sideRow(r, i) {
    // 侧栏窄行：只显示名字 + 排序值（序号/头像不占位，队列在栏内垂直居中）
    return `<div class="q-row side ${i === 0 ? 'first' : ''}">
      <span class="nm">${esc(r.name)}</span>
      <span class="sort">${r.sort}</span>
    </div>`;
  }
  function renderQueues() {
    if (!state) return;
    const fp = `${state.mode}|${JSON.stringify(state.queues)}`;
    if (fp === queueFp) return;
    queueFp = fp;
    const pve = state.mode !== 'pvp';
    const ql = (state.queues.black.list || []);
    const qr = (state.queues.white.list || []);
    // 左侧 column-reverse：队头显示在最下方贴近黑方卡片；队尾提示置列表末尾（视觉在顶部）
    const hintHtml = '<div class="q-hint">👍 点赞<br>🎁 送礼<br>可插队</div>';
    $('qSideLeft').innerHTML = ql.length
      ? ql.map(sideRow).join('') + hintHtml
      : '<div class="q-empty">黑子无人排队</div>';
    $('qSideRight').style.display = pve ? 'none' : '';
    $('qSideRight').innerHTML = qr.length
      ? qr.map(sideRow).join('') + hintHtml
      : '<div class="q-empty">白子无人排队</div>';
  }

  /* 战报流（SSE 增量 + state.feed 补显，指纹去重；新在上，prepend 追加） */
  const opFps = new Set();
  function opFp(op) { return `${op.ts}|${op.id}`; }
  function resetOps() { $('opStream').innerHTML = ''; opFps.clear(); }
  function opNode(op, withAnim) {
    const d = document.createElement('div');
    d.className = 'op' + (op.hot ? ' hot' : '') + (withAnim ? ' enter' : '');
    const t = op.ts ? new Date(op.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    d.innerHTML = `<span class="t">${esc(t)}</span><span>${op.icon} ${esc(op.text)}</span>`;
    return d;
  }
  function renderOps() {
    if (state.roundNo !== lastRoundNo) { lastRoundNo = state.roundNo; resetOps(); }
    const box = $('opStream');
    [...state.feed].reverse().forEach(op => {
      const fp = opFp(op);
      if (opFps.has(fp)) return;
      opFps.add(fp);
      box.appendChild(opNode(op, false));
    });
    while (box.children.length > 30) box.removeChild(box.lastChild);
  }
  function appendOp(op) {
    const fp = opFp(op);
    if (opFps.has(fp)) return;
    opFps.add(fp);
    const box = $('opStream');
    box.prepend(opNode(op, true));
    while (box.children.length > 30) box.removeChild(box.lastChild);
  }

  /* ══════════════ 排行榜（统一组件：前三固定 + 第4~50名轮播） ══════════════ */
  let lbFp = '';
  function renderLeaderboard() {
    const box = $('boardBody');
    if (!box) return;
    const list = state.leaderboard || [];
    const fp = list.map(r => `${r.rank}|${r.name}|${r.totalScore != null ? r.totalScore : 0}`).join(',');
    if (fp === lbFp) return;
    lbFp = fp;
    DG.mountLeaderboard(box, list, { totalScore: r => (r.totalScore != null ? r.totalScore : 0) });
  }

  /* ══════════════ 结算横幅 ══════════════ */
  function renderWinBanner() {
    const banner = $('winBanner');
    const card = banner.querySelector('.win-card');
    if (state.status === 'result' && state.result) {
      const r = state.result;
      const winnerSeat = r.winner ? state.seats[r.winner] : null;
      $('winTitle').textContent = r.winner ? '五 连 获 胜 !' : '平 局 收 场';
      $('winName').textContent = r.winner ? r.winnerName : `${r.blackName} × ${r.whiteName}`;
      const scoreTxt = (r.scores || []).filter(s => s.gain).map(s => `${s.name} +${s.gain}`).join(' · ');
      $('winScore').textContent = `${r.reasonLabel} · ${r.moves} 手 · ${fmtDur(r.durationSec)}${scoreTxt ? '　' + scoreTxt : ''}`;
      $('winSub').textContent = r.badgeUp ? `🏅 ${r.badgeUp.name} 击败 ${danOf(r.badgeUp.level)} 人机，解锁段位徽章！` : '';
      card.style.borderColor = r.winner ? 'var(--gold)' : 'var(--accent)';
      $('winTitle').style.color = r.winner ? 'var(--gold)' : 'var(--accent)';
      card.classList.toggle('is-win', !!r.winner);
      // 胜者头像（机器人不显示头像）
      const avWrap = $('winAvatarWrap');
      if (r.winner && winnerSeat && winnerSeat.kind === 'viewer') {
        avWrap.style.display = '';
        const avImg = $('winAvatar'), avFb = $('winAvatarFallback');
        if (winnerSeat.avatar) {
          avFb.style.display = 'none';
          avImg.style.display = '';
          avImg.src = winnerSeat.avatar;
          avImg.onerror = () => { avImg.style.display = 'none'; avFb.style.display = 'flex'; avFb.textContent = initialOf(winnerSeat.name); };
        } else {
          avImg.style.display = 'none';
          avFb.style.display = 'flex';
          avFb.textContent = initialOf(winnerSeat.name);
        }
      } else {
        avWrap.style.display = 'none';
      }
      // 烟花（每局只放一次；仅观众获胜放，机器人获胜只弹横幅）
      if (r.winner && winnerSeat && winnerSeat.kind === 'viewer' && r.revealedAt !== lastFinishedAt) {
        lastFinishedAt = r.revealedAt;
        launchFireworks('fireworks');
      }
      banner.classList.remove('hidden');
      clearTimeout(winBannerTimer);
      const resultSecs = (state.cfg && state.cfg.resultShowSec) || 15;
      winBannerTimer = setTimeout(() => banner.classList.add('hidden'), resultSecs * 1000);
      if (!winBannerShown) { winBannerShown = true; bannerShownAt = Date.now(); }
    } else {
      banner.classList.add('hidden');
      winBannerShown = false;
      bannerShownAt = 0;
      $('winNext').style.display = 'none';
    }
  }

  /* ══════════════ 等待上座 / 准备确认 浮层 ══════════════ */
  function renderWaitTip() {
    const show = state.status === 'waiting' || state.status === 'ready';
    $('waitTip').classList.toggle('hidden', !show);
    if (show) {
      const ready = state.status === 'ready';
      $('wtTitle').textContent = ready ? '准 备 就 绪' : '虚 位 以 待';
      $('wtLine').textContent = state.waitHint || (ready ? '请发送「准备」开始对局' : '发「排队 / 排黑 / 排白」抢座');
      $('wtSub').textContent = ready
        ? '超时未发送「准备」将自动让座 · 下一位顶上'
        : '点赞可插队 · 送礼快速插队 · 队首即刻上座';
    }
  }

  function fmtDur(s) {
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + '分' + String(s % 60).padStart(2, '0') + '秒';
  }

  /* ══════════════ 总渲染 ══════════════ */
  function renderAll() {
    if (!state) return;
    fitBoard();
    // 新局：格子级指纹缓存全清 —— 必须用哨兵值 \0（空格子指纹恰为 ''，真指纹会被判等跳过重绘）
    if (state.roundNo !== lastRoundNo) {
      cellCache = cellCache.map(() => '\0');
      prevVal = prevVal.map(() => 0);
      // 保险：新局无条件清掉一次性动画类。有些路径会「清空棋盘但 roundNo 不变」
      //（如 enterReady），此时不该残留 .removed 到下一局
      for (const el of cellEls) el.classList.remove('pop', 'removed', 'bad', 'last', 'win', 'forbid');
    }
    renderTop();
    renderBoard();
    renderQueues();
    renderOps();
    renderLeaderboard();
    renderWinBanner();
    renderWaitTip();
  }
  fitBoard();
})();