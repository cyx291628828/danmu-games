/* ══════════════════════════════════════════════════════════════════
   control.js — 弹幕数独 · 主播台控制台逻辑（games/sudoku/public）
   页面可独立打开，也可嵌在主播台框架 iframe 中（/control.html?game=sudoku）
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, showToast, control } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'sudoku';
  let state = null;
  let cfgFormBuilt = false;
  let roomFilter = null;

  /* ───────────── SSE（只订阅本游戏） ───────────── */
  DG.connectSSE(GAME, {
    onState: (_gid, st) => { state = st; render(); },
    onGuess: (_gid, op) => appendOpLog(op),
    onNotice: (_gid, n) => { if (n && n.text) showToast(n.text); },
    onError: () => showToast('与游戏服务断连，正在重试…'),
  });

  function render() {
    if (!state) return;
    if (roomFilter) roomFilter.refresh();
    DGBroadcast.watch(state);   // 通用播报：bc.seq 自增 → 自动朗读 + 渲染播报记录
    renderStatus();
    renderRefBoard();
    renderOpLog();
    ensureCfgForm();
    renderHistory();
  }

  /* ───────────── 状态与实时统计 ───────────── */
  function renderStatus() {
    const stMap = {
      idle: '空闲',
      playing: `游戏中（剩余 ${Math.max(0, Math.ceil(((state.deadline || 0) - Date.now()) / 1000))}s）`,
      result: '结算中',
      paused: '已暂停',
    };
    const fi = state.finishedInfo;
    const finInfo = (state.status === 'result' && fi)
      ? (fi.complete ? ` · 通关！${fi.mvp ? 'MVP ' + fi.mvp.name : ''}` : ` · ${fi.reason === 'skip' ? '主播结束' : '时间到'}，已填 ${state.filled}/81`)
      : '';
    $('ctlStatus').textContent = `状态: ${stMap[state.status] || state.status}${finInfo} · 第 ${state.roundNo} 局 · 已开 ${state.stats.rounds} 局 / 通关 ${state.stats.clears} 次`;

    const rs = state.roundStats || {};
    const likeTop = state.likeTop;
    $('statChips').innerHTML = `
      <span class="stat-chip">难度 <b>${esc(state.difficulty.label)}</b>（${state.holes} 空格）</span>
      <span class="stat-chip">已填 <b>${state.filled}</b>/81 · 空 <b>${81 - state.filled}</b></span>
      <span class="stat-chip">弹幕填 <b class="gd">${rs.dm || 0}</b> · 点赞填 <b class="gd">${rs.like || 0}</b> · 礼物填 <b class="gd">${rs.gift || 0}</b> · 关注填 <b class="gd">${rs.follow || 0}</b> · 自动填 <b class="gd">${rs.auto || 0}</b> · 提示 <b class="gd">${rs.hint || 0}</b></span>
      <span class="stat-chip">错填 <b>${rs.wrong || 0}</b>（${(state.cfg && state.cfg.wrongFillPenalty > 0) ? '扣 ' + state.cfg.wrongFillPenalty + ' 分/次' : '忽略+记录'}）</span>
      <span class="stat-chip">点赞充能 <b>${likeTop ? esc(likeTop.name) + ' ' + likeTop.likes : '0'}</b>/${state.likeThreshold}</span>`;
  }
  setInterval(() => { if (state && (state.status === 'playing' || state.status === 'paused')) renderStatus(); }, 1000);

  /* ───────────── 主播参考小盘（完整答案，勿投屏） ───────────── */
  let refFp = '';
  function renderRefBoard() {
    const box = $('refBoard');
    const fp = `${state.roundNo}|${state.mask || ''}|${(state.cells || []).length}`;
    if (fp === refFp) return;
    refFp = fp;
    if (!state.mask) { box.innerHTML = '<span style="grid-column:1/-1;padding:20px;color:var(--dim);font-size:12px;text-align:center">开新一局后显示</span>'; return; }
    const sol = state.solution || '';
    const filledMap = {};
    (state.cells || []).forEach(c => { filledMap[c[0]] = c[1]; });
    let html = '';
    for (let i = 0; i < 81; i++) {
      if (state.mask[i] === '1') html += `<span>${esc(sol[i])}</span>`;
      else if (filledMap[i] !== undefined) html += `<span class="hole">${esc(filledMap[i])}</span>`;
      else html += `<span class="hole" style="opacity:.35">${esc(sol[i])}</span>`;
    }
    box.innerHTML = html;
  }

  /* ───────────── 操作日志（完整版） ───────────── */
  const opFps = new Set();
  function opFp(op) { return `${op.ts}|${op.type}|${op.idx ?? '-'}|${op.msg || ''}`; }
  function opRow(op) {
    const d = document.createElement('div');
    const t = op.ts ? new Date(op.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    const icon = { dm: '✍️', like: '👍', gift: '🎁', hint: '💡', auto: '⚙️', wrong: '❌' }[op.type] || '';
    let body = '';
    if (op.type === 'start' || op.type === 'done') body = esc(op.msg || '');
    else if (op.type === 'wrong') body = `${icon} <span class="who">${esc(op.name)}</span> 填 <span class="pos">${esc(op.pos)}=${esc(op.val)}</span> ${esc(op.msg || '填错，已忽略')}`;
    else body = `${icon} <span class="who">${esc(op.name)}</span>${op.msg ? ' ' + esc(op.msg) : ''}${op.pos ? ` <span class="pos">${esc(op.pos)}=${esc(op.val)}</span>` : ''}${op.score ? ` +${op.score}` : ''}`;
    d.className = (op.hot ? 'hot' : '') + (op.type === 'wrong' ? ' err' : '');
    d.innerHTML = `<span class="lt">[${esc(t)}]</span>${body}`;
    return d;
  }
  function renderOpLog() {
    if (!state) return;
    // state.ops 只带最近 14 条：首次渲染 / 新局时整体重建
    if ($('opLog').children.length === 0) {
      [...state.ops].reverse().forEach(op => {
        const fp = opFp(op);
        if (opFps.has(fp)) return;
        opFps.add(fp);
        $('opLog').appendChild(opRow(op));
      });
    }
  }
  function appendOpLog(op) {
    const fp = opFp(op);
    if (opFps.has(fp)) return;
    opFps.add(fp);
    $('opLog').prepend(opRow(op));
    while ($('opLog').children.length > 80) $('opLog').lastChild.remove();
  }

  /* ───────────── 配置表单（一次性生成，按功能分组） ───────────── */
  function ensureCfgForm() {
    const box = $('cfgForm');
    if (!box || cfgFormBuilt) return;
    cfgFormBuilt = true;
    const c = (state && state.cfg) || {};
    box.innerHTML = `
      <div class="cc-title">局面与节奏</div>
      <label>难度
        <select id="cfgDiff">
          <option value="easy" ${c.difficulty === 'easy' ? 'selected' : ''}>简单（32 空格）</option>
          <option value="normal" ${c.difficulty !== 'easy' && c.difficulty !== 'hard' ? 'selected' : ''}>中等（45 空格）</option>
          <option value="hard" ${c.difficulty === 'hard' ? 'selected' : ''}>困难（56 空格）</option>
        </select>
      </label>
      <label>每局时长(秒) <input id="cfgRound" type="number" min="60" value="${c.roundSec ?? 480}"></label>
      <label>结算停留(秒) <input id="cfgResult" type="number" min="3" value="${c.resultShowSec ?? 12}"></label>
      <label><input id="cfgAuto" type="checkbox" ${c.autoNextRound === false ? '' : 'checked'}> 自动开下一局</label>
      <div class="cfg-break"></div>
      <div class="cc-title">计分</div>
      <label>每填对得分 <input id="cfgScore" type="number" min="1" value="${c.scorePerFill ?? 10}"></label>
      <label>MVP加分 <input id="cfgMvp" type="number" min="0" value="${c.mvpBonus ?? 50}"></label>
      <label>错填扣分 <input id="cfgWrong" type="number" min="0" value="${c.wrongFillPenalty ?? 0}"></label>
      <div class="cfg-break"></div>
      <div class="cc-title">互动助攻</div>
      <label>点赞阈值N <input id="cfgLike" type="number" min="1" value="${c.likeThreshold ?? 30}"></label>
      <label>送礼连填m格 <input id="cfgGift" type="number" min="1" max="81" value="${c.giftFillCount ?? 3}"></label>
      <label>关注填n格 <input id="cfgFollow" type="number" min="0" max="81" value="${c.followFillCount ?? 1}"></label>
      <label>自动填数(秒) <input id="cfgAutoFill" type="number" min="-1" value="${c.autoFillSec ?? 60}"></label>
      <div class="cfg-break"></div>
      <div class="cc-title">弹幕规则</div>
      <label>匹配模式
        <select id="cfgPattern">
          <option value="loose" ${c.fillPattern !== 'strict' ? 'selected' : ''}>宽松（A33 / 3行5列7）</option>
          <option value="strict" ${c.fillPattern === 'strict' ? 'selected' : ''}>严格（仅 A33 字母行）</option>
        </select>
      </label>
      <label>弹幕限频(秒) <input id="cfgRate" type="number" min="0" value="${c.rateLimitSec ?? 2}"></label>
      <label>每人填对上限 <input id="cfgQuota" type="number" min="0" value="${c.maxFillsPerUserPerRound ?? 20}"></label>
      <label>头像角标位置
        <select id="cfgCorner">
          <option value="right-top" ${c.avatarCorner !== 'left-top' ? 'selected' : ''}>右上角</option>
          <option value="left-top" ${c.avatarCorner === 'left-top' ? 'selected' : ''}>左上角</option>
        </select>
      </label>
      <div class="cfg-hint">自动填数 = 每隔 N 秒系统自动落 1 个正确数防冷场（不记分；0=关闭，结算仍显示自动数；-1=关闭且结算面板不显示自动数）。错填默认不落格仅红闪记录，扣分填 0 以外的数生效。改动即时生效并写回 config.json；难度在「开新一局」时生效。</div>
      <button id="btnApplyCfg" class="btn secondary">应用配置</button>`;
    $('btnApplyCfg').onclick = () => {
      const num = (id, def) => { const v = parseInt($(id).value, 10); return Number.isNaN(v) ? def : v; };
      control(GAME, 'config', {
        difficulty: $('cfgDiff').value,
        roundSec: num('cfgRound', 480),
        resultShowSec: num('cfgResult', 12),
        autoNextRound: $('cfgAuto').checked,
        scorePerFill: num('cfgScore', 10),
        likeThreshold: num('cfgLike', 30),
        giftFillCount: num('cfgGift', 3),
        followFillCount: num('cfgFollow', 1),
        autoFillSec: num('cfgAutoFill', 60),
        rateLimitSec: num('cfgRate', 2),
        maxFillsPerUserPerRound: num('cfgQuota', 20),
        wrongFillPenalty: num('cfgWrong', 0),
        mvpBonus: num('cfgMvp', 50),
        fillPattern: $('cfgPattern').value,
        avatarCorner: $('cfgCorner').value,
      });
    };
    bindControlEvents();
  }

  function bindControlEvents() {
    $('btnStart').onclick = () => control(GAME, 'start');
    $('btnPause').onclick = () => control(GAME, 'pause');
    $('btnResume').onclick = () => control(GAME, 'resume');
    $('btnHint').onclick = () => control(GAME, 'hint');
    $('btnEnd').onclick = () => control(GAME, 'endRound');
  }

  /* ───────────── 历史对局 ───────────── */
  function renderHistory() {
    const hist = $('ctlHistory');
    hist.innerHTML = '';
    if (state.history && state.history.length) {
      state.history.forEach(r => {
        const row = document.createElement('div');
        row.className = 'half';
        row.innerHTML = `<span>#${r.roundNo}</span>` +
          `<span class="${r.complete ? '' : 'r-ans'}">${r.complete ? `通关 ${fmtDur(r.durationSec)}` : `未完成 ${r.filled}/81`}</span>` +
          `<span>${r.mvpName ? 'MVP ' + esc(r.mvpName) + ' (+' + r.mvpScore + ')' : '无 MVP'}</span>` +
          `<span style="color:var(--dim)">弹${r.dm || 0} 赞${r.like || 0} 礼${r.gift || 0} 关${r.follow || 0} 自${r.auto || 0}</span>`;
        hist.appendChild(row);
      });
    } else {
      hist.innerHTML = '<div>暂无历史</div>';
    }
  }
  function fmtDur(s) {
    return Math.floor(s / 60) + '分' + String(s % 60).padStart(2, '0') + '秒';
  }

  /* ───────────── 接入与模拟（公共组件：直播间筛选 + 模拟观众套件） ───────────── */
  roomFilter = DG.mountFeedTools($('ctlFeedTools'), GAME, {
    getRoomId: () => (state && state.cfg && state.cfg.allowedRoomId) || '',
    sim: { chat: { placeholder: 'A33 或 3行5列7' }, like: { count: 10 }, gift: true, enter: true },
  });

  /* ───────────── 通用 AI 播报面板 ───────────── */
  DGBroadcast.mountPanel($('bcPanel'), { game: GAME });
  renderOpLog();
})();
