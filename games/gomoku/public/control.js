/* ══════════════════════════════════════════════════════════════════
   control.js — 弹幕五子棋 · 主播台控制台逻辑（games/gomoku/public）
   页面可独立打开，也可嵌在主播台框架 iframe 中（/control.html?game=gomoku）
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, showToast, control } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'gomoku';
  let state = null;
  let cfgFormBuilt = false;
  let roomFilter = null;

  /* ───────────── SSE（只订阅本游戏） ───────────── */
  DG.connectSSE(GAME, {
    onState: (_gid, st) => { state = st; render(); },
    onGuess: (_gid, op) => { if (op && op.kind === 'feed') appendFeed(op); },
    onNotice: (_gid, n) => { if (n && n.text) showToast(n.text); },
    onError: () => showToast('与游戏服务断连，正在重试…'),
  });

  function render() {
    if (!state) return;
    if (roomFilter) roomFilter.refresh();
    DGBroadcast.watch(state);
    renderStatus();
    renderBoard();
    renderQueues();
    renderFeed();
    ensureCfgForm();
    renderHistory();
  }

  /* ───────────── 状态与实时统计 ───────────── */
  function stLabel() {
    const st = state.status;
    const map = { idle: '空闲', waiting: '等待上座', ready: '准备确认', playing: '对局中', result: '结算中', paused: '已暂停' };
    return map[st] || st;
  }
  function turnName() {
    const seat = state.seats && state.seats[state.turn];
    return seat ? seat.name : '--';
  }
  function renderStatus() {
    const ms = state.moveStats || {};
    const st = state.stats || {};
    let turnTxt = '';
    if (state.status === 'playing') {
      const seat = state.seats[state.turn];
      if (state.deadline > 0) {
        turnTxt = `当前执子 ${turnName()} · 剩余 ${Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000))}s 托管`;
      } else {
        turnTxt = seat && seat.kind !== 'viewer' ? `${turnName()} 思考中…` : `当前执子 ${turnName()}`;
      }
    } else if (state.status === 'paused') {
      turnTxt = '已冻结';
    } else if (state.status === 'ready') {
      const pend = ['black', 'white'].filter(sd => state.seats[sd] && state.seats[sd].kind === 'viewer' && !state.seats[sd].ready)
        .map(sd => `${state.seats[sd].name}（${sd === 'black' ? '黑' : '白'}）`);
      const ttl = state.readyDeadline > 0 ? Math.max(0, Math.ceil((state.readyDeadline - Date.now()) / 1000)) : -1;
      turnTxt = pend.length
        ? `待「${pend.join('、')}」发准备` + (ttl >= 0 ? ` · ${ttl}s 后自动让座` : '')
        : '双方已就绪，即将开局…';
    }
    $('ctlStatus').textContent = `状态: ${stLabel()}${turnTxt ? ' · ' + turnTxt : ''} · 第 ${state.roundNo} 局 · 已开 ${st.rounds || 0} 局`;

    const qb = state.queues.black, qw = state.queues.white;
    const mode = state.mode === 'pvp' ? '双人对决' : `人机对决 ${state.botLevelName || ('Lv' + state.botLevel)}`;
    $('statChips').innerHTML = `
      <span class="stat-chip">模式 <b>${esc(mode)}</b> · ${state.size}路</span>
      <span class="stat-chip">禁手 <b class="${state.forbidden ? 'grn' : 'red2'}">${state.forbidden ? '开' : '关'}</b></span>
      <span class="stat-chip">黑队列 <b>${qb.count}</b> · 白队列 <b>${qw.count}</b></span>
      <span class="stat-chip">弹幕落子 <b class="gd">${ms.dm || 0}</b> · 托管 <b class="gd">${ms.auto || 0}</b> · 禁手拒绝 <b>${ms.forbid || 0}</b> · 悔棋 <b class="gd">${ms.undo || 0}</b>手</span>
      <span class="stat-chip">观众胜人机 <b class="gd">${st.pveViewerWins || 0}</b> 次 · 点赞累计 <b>${st.likes || 0}</b></span>`;

    // 座位卡
    const cards = ['black', 'white'].map(side => {
      const seat = state.seats[side];
      const active = state.status === 'playing' && state.turn === side;
      const icon = side === 'black' ? '⚫' : '⚪';
      if (!seat) {
        return `<div class="seat-card ${active ? 'active' : ''}"><span class="scv">${icon}</span><span class="sc-empty">虚位以待</span></div>`;
      }
      const kindTag = seat.kind === 'viewer'
        ? `<span class="badge-tag">观众 · 排序值 ${seat.sort || 0}</span>`
        : `<span class="badge-tag bot">🤖 人机 ${seat.levelName || ('Lv' + seat.level) || ''}</span>`;
      const undoN = seat.undoCount ? ` · 悔棋 ${seat.undoCount} 次` : '';
      const readyTag = state.status === 'ready' && seat.kind === 'viewer'
        ? (seat.ready ? ' <span class="badge-tag gd">✅ 已就绪</span>' : ' <span class="badge-tag warn">⏳ 待准备</span>')
        : '';
      return `<div class="seat-card ${active ? 'active' : ''}">
        <span class="scv">${icon}</span>
        ${DG.avatarHTML(seat.name, seat.avatar)}
        <div style="flex:1;min-width:0">
          <div class="sc-name">${esc(seat.name)}</div>
          <div class="sc-meta">${kindTag}${readyTag}${undoN}</div>
        </div>
      </div>`;
    }).join('');
    $('seatCards').innerHTML = cards;
    $('qLikePer').textContent = state.cfg.likePerPoint ?? 1;
    $('qGiftSort').textContent = state.cfg.giftSortBonus ?? 30;
    // 「开始」按钮随状态切换语义：ready 态 = 强制跳过准备确认
    const startBtn = $('btnStart');
    if (startBtn) startBtn.textContent = state.status === 'ready' ? '跳过准备 · 立即开局' : '开新一局（立即上座）';
  }
  setInterval(() => { if (state && (state.status === 'playing' || state.status === 'paused' || state.status === 'ready')) renderStatus(); }, 1000);

  /* ───────────── 对局棋盘（主播小盘） ───────────── */
  const ctlCells = [];
  function renderBoard() {
    const wrap = $('ctlBoardWrap');
    const size = state.size || 15;
    if (ctlCells.length !== size * size) {
      ctlCells.length = 0;
      const g = document.createElement('div');
      g.className = 'ctl-board';
      g.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
      for (let i = 0; i < size * size; i++) {
        const c = document.createElement('div');
        c.className = 'c';
        g.appendChild(c);
        ctlCells.push(c);
      }
      wrap.innerHTML = '';
      wrap.appendChild(g);
    }
    const board = state.board || '';
    const fpBase = `${state.roundNo}|${state.board ? state.board.length : 0}|`;
    for (let i = 0; i < ctlCells.length; i++) {
      const c = ctlCells[i];
      const v = board[i] || '0';
      // 指纹：棋子 + 最后一手 + 获胜连线
      const key = `${fpBase}${v}|${i === state.lastMove ? 1 : 0}|${(state.result && state.result.winCells || []).includes(i) ? 1 : 0}`;
      if (c.dataset.fp === key) continue;
      c.dataset.fp = key;
      c.className = 'c';
      if (v === '1') c.classList.add('st1');
      else if (v === '2') c.classList.add('st2');
      if (i === state.lastMove) c.classList.add('last');
      if ((state.result && state.result.winCells || []).includes(i)) c.classList.add('win');
    }
  }

  /* ───────────── 等候队列 ───────────── */
  const queueCols = $('queueCols');
  function renderQueues() {
    const pve = state.mode !== 'pvp';
    const sides = pve ? [['black', '等候队列']] : [['black', '⚫ 黑方队列'], ['white', '⚪ 白方队列']];
    queueCols.innerHTML = sides.map(([side, title]) => {
      const q = state.queues[side];
      const rows = (q.list || []).map((r, i) => `
        <div class="q-row ${i === 0 && q.count ? 'top' : ''}">
          <span class="q-rank">#${i + 1}</span>
          ${DG.avatarHTML(r.name, r.avatar)}
          <span class="q-name">${esc(r.name)}</span>
          <span class="q-sort" title="排序值">${r.sort}</span>
          <span class="q-like">👍${r.likes} 🎁${r.gifts}</span>
          <button class="q-x" title="移出队列" data-uid="${esc(r.uid)}" data-side="${side}">✕</button>
        </div>`).join('');
      return `<div class="queue-col">
        <div class="queue-col-title">${title} <span class="q-count">（${q.count} 人）</span>
          <button class="btn tiny secondary q-clear" data-side="${side}">清空</button></div>
        <div class="q-list">${rows || '<div class="lb-empty">暂无排队，发「排队」加入</div>'}</div>
      </div>`;
    }).join('');
    renderQueueWarn();
  }
  function renderQueueWarn() {
    // 无人在队时给出排队口令提示（顶部状态区已展示排序规则）
    const any = state.queues.black.count + state.queues.white.count;
    if (!any && state.status !== 'playing') {
      // 保持空白，不刷屏
    }
    queueCols.querySelectorAll('.q-x').forEach(btn => {
      btn.onclick = () => control(GAME, 'removeQueued', { uid: btn.dataset.uid, side: btn.dataset.side });
    });
    queueCols.querySelectorAll('.q-clear').forEach(btn => {
      btn.onclick = () => control(GAME, 'clearQueue', { side: btn.dataset.side });
    });
  }

  /* ───────────── 战报日志（完整版；SSE 增量 + state.feed 补显） ───────────── */
  const feedFps = new Set();
  function feedFp(f) { return `${f.ts}|${f.id}`; }
  function feedRow(f) {
    const d = document.createElement('div');
    const t = f.ts ? new Date(f.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    d.className = (f.hot ? 'hot' : '');
    d.innerHTML = `<span class="lt">[${esc(t)}]</span>${f.icon} ${esc(f.text)}`;
    return d;
  }
  function renderFeed() {
    if (!state) return;   // SSE 首帧到达前页面尾部会预调一次，此时 state 仍为 null
    const box = $('feedLog');
    if (box.children.length === 0) {
      [...state.feed].reverse().forEach(f => { if (!feedFps.has(feedFp(f))) { feedFps.add(feedFp(f)); box.appendChild(feedRow(f)); } });
    }
  }
  function appendFeed(f) {
    if (feedFps.has(feedFp(f))) return;
    feedFps.add(feedFp(f));
    $('feedLog').prepend(feedRow(f));
    while ($('feedLog').children.length > 80) $('feedLog').lastChild.remove();
  }

  /* ───────────── 配置表单（一次性生成，按功能分组） ───────────── */
  const DAN_CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const BOT_LEVELS = ['入门', '新手', '初级', '中级', '高级', '专家', '大师', '宗师', '传奇', '棋圣'];
  // 配置提交：只读取表单 DOM，故提到模块级——供「应用配置」按钮与「模式下拉即时提交」共用
  // （注意：不可定义在 ensureCfgForm 内部，否则 bindControlEvents 里的引用会 ReferenceError）
  const num = (id, def) => { const v = parseInt($(id).value, 10); return Number.isNaN(v) ? def : v; };
  const send = () => control(GAME, 'config', {
    mode: $('cfgMode').value,
    botLevel: parseInt($('cfgBotLevel').value, 10),
    forbidden: $('cfgForbidden').checked,
    boardSize: parseInt($('cfgBoardSize').value, 10),
    moveTimeSec: num('cfgMoveTime', 45),
    autoMoveLevel: parseInt($('cfgAutoMove').value, 10),
    botThinkSec: num('cfgBotThink', 3),
    resultShowSec: num('cfgResult', 15),
    autoNextRound: $('cfgAutoNext').checked,
    rateLimitSec: num('cfgRate', 1),
    likePerPoint: num('cfgLikePer', 1),
    likeCapPerEvent: num('cfgLikeCap', 0),
    giftSortBonus: num('cfgGiftSort', 30),
    giftPieceCap: num('cfgGiftPiece', 10),
    queueCap: num('cfgQueueCap', 100),
    giftUndoEnabled: $('cfgUndoEnabled').checked,
    giftUndoPerGift: num('cfgUndoPer', 1),
    undoMaxPerGame: num('cfgUndoMax', 0),
    pvpWinScore: num('cfgPvpWin', 100),
    pvpLoseScore: num('cfgPvpLose', 20),
    pveWinScore: num('cfgPveWin', 100),
    pveLoseScore: num('cfgPveLose', 0),
    enterHint: $('cfgEnterHint').checked,
  });

  function ensureCfgForm() {
    const box = $('cfgForm');
    if (!box || cfgFormBuilt) return;
    cfgFormBuilt = true;
    const c = (state && state.cfg) || {};

    // 分组渲染
    const groups = [
      ['对局模式', `
        <label>模式
          <select id="cfgMode">
            <option value="pve" ${c.mode !== 'pvp' ? 'selected' : ''}>人机对决（观众执黑）</option>
            <option value="pvp" ${c.mode === 'pvp' ? 'selected' : ''}>双人对决（双队列各取第一）</option>
          </select></label>
        <label>人机等级
          <select id="cfgBotLevel">${BOT_LEVELS.map((n, i) => `<option value="${i + 1}" ${c.botLevel === i + 1 ? 'selected' : ''}>${DAN_CN[i + 1]}段·${n}</option>`).join('')}</select></label>
        <label>托管等级
          <select id="cfgAutoMove">${BOT_LEVELS.map((n, i) => `<option value="${i + 1}" ${(c.autoMoveLevel || 4) === i + 1 ? 'selected' : ''}>${DAN_CN[i + 1]}段·${n}</option>`).join('')}</select></label>
        <label>棋盘 <select id="cfgBoardSize">
          <option value="13" ${c.boardSize === 13 ? 'selected' : ''}>13 路</option>
          <option value="15" ${(c.boardSize || 15) === 15 ? 'selected' : ''}>15 路</option>
          <option value="19" ${c.boardSize === 19 ? 'selected' : ''}>19 路</option>
        </select></label>
        <label><input id="cfgForbidden" type="checkbox" ${c.forbidden === false ? '' : 'checked'}> 连珠禁手（黑方三三/四四/长连）</label>`],
      ['节奏', `
        <label>每手限时(秒) <input id="cfgMoveTime" type="number" min="0" value="${c.moveTimeSec ?? 45}"></label>
        <label>人机思考(秒) <input id="cfgBotThink" type="number" min="0" value="${c.botThinkSec ?? 3}"></label>
        <label>结算停留(秒) <input id="cfgResult" type="number" min="3" value="${c.resultShowSec ?? 15}"></label>
        <label>落子限频(秒) <input id="cfgRate" type="number" min="0" value="${c.rateLimitSec ?? 1}"></label>
        <label><input id="cfgAutoNext" type="checkbox" ${c.autoNextRound === false ? '' : 'checked'}> 结算后自动开下一局</label>
        <label><input id="cfgReadyEnabled" type="checkbox" ${c.readyEnabled === false ? '' : 'checked'}> 上座后须发「准备」才开局（防挂机占座）</label>
        <label>准备超时(秒) <input id="cfgReadyWait" type="number" min="0" max="600" value="${c.readyWaitSec ?? 40}"><span class="cfg-note">0=不限时</span></label>`],
      ['等候队列', `
        <label>点赞→排序值 <input id="cfgLikePer" type="number" min="0" value="${c.likePerPoint ?? 1}"></label>
        <label>礼物+排序值/件 <input id="cfgGiftSort" type="number" min="0" value="${c.giftSortBonus ?? 30}"></label>
        <label>礼物计件上限 <input id="cfgGiftPiece" type="number" min="1" max="50" value="${c.giftPieceCap ?? 10}"></label>
        <label>单条点赞上限 <input id="cfgLikeCap" type="number" min="0" value="${c.likeCapPerEvent ?? 0}"></label>
        <label>队列人数上限 <input id="cfgQueueCap" type="number" min="2" value="${c.queueCap ?? 100}"></label>`],
      ['送礼悔棋', `
        <label><input id="cfgUndoEnabled" type="checkbox" ${c.giftUndoEnabled === false ? '' : 'checked'}> 上座观众送礼悔棋</label>
        <label>每礼悔棋手数 <input id="cfgUndoPer" type="number" min="1" max="3" value="${c.giftUndoPerGift ?? 1}"></label>
        <label>每人每局上限 <input id="cfgUndoMax" type="number" min="0" value="${c.undoMaxPerGame ?? 0}"></label>`],
      ['计分（排行榜）', `
        <label>双人胜方分 <input id="cfgPvpWin" type="number" min="0" value="${c.pvpWinScore ?? 100}"></label>
        <label>双人败方分 <input id="cfgPvpLose" type="number" min="0" value="${c.pvpLoseScore ?? 20}"></label>
        <label>人机获胜分 <input id="cfgPveWin" type="number" min="0" value="${c.pveWinScore ?? 100}"></label>
        <label>人机落败分 <input id="cfgPveLose" type="number" min="0" value="${c.pveLoseScore ?? 0}"></label>`],
      ['其它', `
        <label><input id="cfgEnterHint" type="checkbox" ${c.enterHint === false ? '' : 'checked'}> 进场引导排队</label>`],
    ];
    box.innerHTML = `<div class="cfg-grid">${groups.map(([t, html]) =>
      `<div class="cc-title">${t}</div><div class="cfg-row">${html}</div><div class="cfg-break"></div>`
    ).join('')}
      <div class="cfg-hint">改动即时生效并写回 config.json；模式 / 禁手 / 棋盘路数在下一局开局时生效（切换「对局模式」会自动即时保存，无需点应用配置）。双人对决必须黑 / 白各一位观众排队才开局：只排了一侧时进入「等待上座」，展示屏会提示还差哪一侧，两侧到齐后自动开局——<b>双人对决永远不会有机器人替补</b>。人机对决为观众执黑、机器人执白。托管等级 = 观众每手超时与「托管一手」按钮使用的 AI 等级；人机等级 = 机器人正常应手难度（1-4 常识级快棋，5-10 α-β 搜索级，棋圣单手约 0.9s）。</div>
      <button id="btnApplyCfg" class="btn secondary">应用配置</button></div>`;
    $('btnApplyCfg').onclick = send;
    bindControlEvents();
  }

  function bindControlEvents() {
    // 对局模式：change 即提交（不必等「应用配置」，避免选了双人对决却还在跑人机）
    // 先 await send() 再提示：control() 内部会把服务端 msg 弹成 toast，
    // 若同步先弹会被它覆盖掉，等请求回来再弹才能把「切到哪个模式」留在最后。
    $('cfgMode').onchange = async () => {
      await send();
      showToast($('cfgMode').value === 'pvp'
        ? '已切到「双人对决」：需黑/白各一位观众排队，下一局生效'
        : '已切到「人机对决」：观众执黑 vs 机器人，下一局生效');
    };
    $('btnStart').onclick = () => control(GAME, 'start');
    $('btnPause').onclick = () => control(GAME, 'pause');
    $('btnResume').onclick = () => control(GAME, 'resume');
    $('btnAutoMove').onclick = () => control(GAME, 'autoMove');
    $('btnHostUndo').onclick = () => control(GAME, 'hostUndo');
    // 破坏性操作：二次确认（误点会直接终结对局并记入历史）
    $('btnForfeit').onclick = () => {
      if (!confirm('确定判当前执子方负吗？本局将立即结束并计分。')) return;
      control(GAME, 'forfeit');
    };
    $('btnEndRound').onclick = () => {
      if (!confirm('确定按「平局」结束本局吗？这会立即终结对局并记入历史战绩。')) return;
      control(GAME, 'endRound');
    };
  }

  /* ───────────── 历史对局 ───────────── */
  function renderHistory() {
    const hist = $('ctlHistory');
    hist.innerHTML = '';
    if (state.history && state.history.length) {
      state.history.forEach(r => {
        const row = document.createElement('div');
        row.className = 'half';
        const winnerTxt = r.winner ? `<span class="r-win">${esc(r.winner === 'black' ? '⚫' : '⚪')} ${esc(r.winner === 'black' ? r.black : r.white)} 胜</span>`
          : '<span>平局</span>';
        row.innerHTML = `<span class="r-dim">#${r.roundNo}</span>` +
          `<span>${r.mode === 'pvp' ? '双人' : '人机'}</span>` +
          `<span class="r-ans">${esc(r.black)} vs ${esc(r.white)}</span>` +
          winnerTxt +
          `<span class="r-dim">${r.moves} 手 · ${fmtDur(r.durationSec)} · ${esc(r.reasonLabel || '')}</span>`;
        hist.appendChild(row);
      });
    } else {
      hist.innerHTML = '<div>暂无历史</div>';
    }
  }
  function fmtDur(s) {
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + '分' + String(s % 60).padStart(2, '0') + '秒';
  }

  /* ───────────── 接入与模拟 + AI 播报 ───────────── */
  roomFilter = DG.mountFeedTools($('ctlFeedTools'), GAME, {
    getRoomId: () => (state && state.cfg && state.cfg.allowedRoomId) || '',
    sim: { chat: { placeholder: '模拟弹幕：H8 / 排队 / 准备' }, like: { count: 10 }, gift: true, enter: true },
  });
  DGBroadcast.mountPanel($('bcPanel'), { game: GAME });
  renderFeed();
})();