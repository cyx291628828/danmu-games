/* ══════════════════════════════════════════════════════════════════
   control.js — 谐音梗猜词 · 主播台控制台逻辑（games/xieyin/public）
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, showToast, control } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'xieyin';
  let state = null;
  let cfgFormBuilt = false;
  let roomFilter = null;

  DG.connectSSE(GAME, {
    onState: (_gid, s) => { state = s; render(); },
    onNotice: (_gid, n) => { if (n && n.text) showToast(n.text); },
    onError: () => showToast('与游戏服务断连，正在重试…'),
  });

  function render() {
    if (!state) return;
    if (roomFilter) roomFilter.refresh();
    renderStatus();
    ensureCfgForm();
    renderHistory();
  }

  function renderStatus() {
    if (state.hasPuzzle) {
      $('ctlAnswer').textContent = `第 ${state.roundNo} 关 · ${state.cat} · 答案「${state.answer}」`;
      const stMap = { playing: '答题中', paused: '已暂停', reveal: '已揭示答案', idle: '待开局' };
      $('ctlStatus').textContent = `${stMap[state.status] || state.status} · 题库 ${state.bankSize} 题 · 当前类别「${state.category}」`;
      $('ctlWinner').textContent = state.winner
        ? `🎉 ${state.winner.name} 答对 +${state.winner.score} 分`
        : (state.revealed ? '无人答对' : '');
    } else {
      $('ctlAnswer').textContent = '--';
      $('ctlStatus').textContent = `待开局 · 题库 ${state.bankSize} 题 · 当前类别「${state.category}」`;
      $('ctlWinner').textContent = '';
    }
  }

  /* ───────────── 配置表单 ───────────── */
  function ensureCfgForm() {
    const box = $('cfgForm');
    if (!box || cfgFormBuilt) return;
    cfgFormBuilt = true;
    const c = state.cfg || {};
    const cats = ['全部'].concat(state.catList || []);
    box.innerHTML = `
      <div class="cc-title">节奏</div>
      <label>答题时间(秒) <input id="cfAnswer" type="number" min="10" value="${c.answerSec ?? 60}"></label>
      <label>揭示停留(秒) <input id="cfReveal" type="number" min="3" value="${c.revealSec ?? 8}"></label>
      <label>发送间隔(秒) <input id="cfRate" type="number" min="1" value="${c.rateLimitSec ?? 1}"></label>
      <label><input id="cfAuto" type="checkbox" ${c.autoNext === false ? '' : 'checked'}> 揭示后自动下一题</label>
      <div class="cfg-break"></div>
      <div class="cc-title">计分</div>
      <label>答对基础分 <input id="cfBase" type="number" min="1" value="${c.baseScore ?? 100}"></label>
      <div class="cfg-break"></div>
      <div class="cc-title">出题范围</div>
      <label>类别
        <select id="cfCat">${cats.map(x => `<option value="${esc(x)}" ${x === c.category ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
      </label>
      <label>近 N 题不重复 <input id="cfNoRep" type="number" min="1" value="${c.noRepeatWindow ?? 40}"></label>
      <div class="cfg-break"></div>
      <button id="btnApplyCfg" class="btn secondary">应用配置</button>`;
    bindControlEvents();
  }

  function bindControlEvents() {
    $('btnStart').onclick = () => control(GAME, 'start');
    $('btnNext').onclick = () => control(GAME, 'next');
    $('btnReveal').onclick = () => control(GAME, 'reveal');
    $('btnPause').onclick = () => control(GAME, 'pause');
    $('btnResume').onclick = () => control(GAME, 'resume');
    $('btnApplyCfg').onclick = () => {
      const num = (id, def) => { const v = parseInt($(id).value, 10); return Number.isNaN(v) ? def : v; };
      control(GAME, 'config', {
        answerSec: num('cfAnswer', 60),
        revealSec: num('cfReveal', 8),
        rateLimitSec: num('cfRate', 1),
        autoNext: $('cfAuto').checked,
        baseScore: num('cfBase', 100),
        category: $('cfCat').value,
        noRepeatWindow: num('cfNoRep', 40),
      });
    };
  }

  /* ───────────── 最近答题 ───────────── */
  function renderHistory() {
    const hist = $('ctlHistory');
    if (!hist) return;
    hist.innerHTML = '';
    const list = state.lastRounds || [];
    if (!list.length) { hist.innerHTML = '<div>暂无历史</div>'; return; }
    list.slice(0, 20).forEach(r => {
      const row = document.createElement('div');
      row.className = 'ctl-clue';
      row.innerHTML = `<span class="n">#${r.roundNo}</span>
        <span class="h"><b>${esc(r.answer)}</b>（${esc(r.cat)}）
        <span style="color:var(--dim)">${r.winner ? `${esc(r.winner)} +${r.score}分` : '无人答对'}</span></span>`;
      hist.appendChild(row);
    });
  }

  /* ───────────── 接入与模拟 ───────────── */
  roomFilter = DG.mountFeedTools($('ctlFeedTools'), GAME, {
    getRoomId: () => (state && state.cfg && state.cfg.allowedRoomId) || '',
    sim: { chat: { placeholder: '模拟答案，如：杨幂' }, like: false, gift: false, enter: false },
  });
})();
