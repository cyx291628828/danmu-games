/* ══════════════════════════════════════════════════════════════════
   control.js — 成语接龙 · 主播台控制台逻辑（games/chengyu/public）
   页面可独立打开，也可嵌在主播台框架 iframe 中（/control.html?game=chengyu）
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, showToast, control } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'chengyu';
  let state = null;
  let cfgFormBuilt = false;
  let roomFilter = null;

  /* ───────────── SSE（只订阅本游戏） ───────────── */
  DG.connectSSE(GAME, {
    onState: (_gid, st) => { state = st; render(); },
    onNotice: (_gid, n) => { if (n && n.text) showToast(n.text); },
    onError: () => showToast('与游戏服务断连，正在重试…'),
  });

  function render() {
    if (!state) return;
    if (roomFilter) roomFilter.refresh();
    DGBroadcast.watch(state);   // 通用播报：bc.seq 自增 → 自动朗读 + 渲染播报记录
    renderStatus();
    renderChain();
    ensureCfgForm();
    renderHistory();
  }

  /* ───────────── 状态 ───────────── */
  function renderStatus() {
    $('ctlStatus').textContent = `已盖 ${state.floorCount || 0} 层 · 第 ${state.roundNo || 0} 轮 · ${state.status === 'playing' ? '接龙中' : (state.status === 'paused' ? '已暂停' : '待开局')}`;
  }

  /* ───────────── 当前接龙链 ───────────── */
  function renderChain() {
    if (state.chain && state.chain.length) {
      const top = state.chain[state.chain.length - 1];
      $('ctlAnswer').innerHTML = `起始 ${esc(state.chain[0].word)} · 当前 <b style="color:var(--gold)">${esc(top.word)}</b> · 需接「<b style="color:var(--gold)">${esc(top.tailChar)}</b>」`;
      const box = $('ctlClues');
      box.innerHTML = '';
      state.chain.slice().reverse().forEach((f, i) => {
        const badge = f.connName ? `<span class="cy-tag cy-tag-${f.connType}">${f.connName}</span>` : '';
        const row = document.createElement('div');
        row.className = 'ctl-clue';
        row.innerHTML = `<span class="n">${state.chain.length - i}F</span><span class="h">${esc(f.word)} ${badge} <span style="color:var(--dim)">${esc(f.user)} ${f.score ? '+' + f.score + '分' : '(起始词)'}</span></span>`;
        box.appendChild(row);
      });
    } else {
      $('ctlAnswer').textContent = '--';
      $('ctlClues').innerHTML = '';
    }
  }

  /* ───────────── 配置表单（一次性生成 + 回填） ───────────── */
  function ensureCfgForm() {
    const box = $('cfgForm');
    if (!box || cfgFormBuilt) return;
    cfgFormBuilt = true;
    const c = state.cfg || {};
    const html = `
      <div class="cc-title">局面与规则</div>
      <label>接龙等待(秒) <input id="cfPending" type="number" min="5" value="${c.pendingSec ?? 20}"></label>
      <label>接对基础分 <input id="cfBase" type="number" min="1" value="${c.baseScore ?? 100}"></label>
      <label>发送间隔(秒) <input id="cfRate" type="number" min="1" value="${c.rateLimitSec ?? 2}"></label>
      <label><input id="cfAuto" type="checkbox" ${c.autoNext === false ? '' : 'checked'}> 中断后自动开局</label>
      <label><input id="cfDict" type="checkbox" ${c.dictFilter === false ? '' : 'checked'}> 校验真成语</label>
      <label><input id="cfRepeat" type="checkbox" ${c.allowRepeat ? 'checked' : ''}> 允许重复成语</label>
      <div class="cfg-break"></div>
      <div class="cc-title">起始词</div>
      <label>起始词方式
        <select id="cfMode">
          <option value="random" ${c.startMode !== 'manual' ? 'selected' : ''}>随机</option>
          <option value="manual" ${c.startMode === 'manual' ? 'selected' : ''}>手动指定</option>
        </select>
      </label>
      <label>手动起始词 <input id="cfWord" type="text" value="${esc(c.manualWord || '一马当先')}"></label>
      <button id="btnNewWord" class="btn secondary">换起始词</button>
      <div class="cfg-break"></div>
      <button id="btnApplyCfg" class="btn secondary">应用配置</button>`;
    box.innerHTML = html;
    $('btnNewWord').onclick = () => control(GAME, 'newWord', { word: $('cfWord') ? $('cfWord').value : '' });
    bindControlEvents();
  }

  function bindControlEvents() {
    $('btnStart').onclick = () => control(GAME, 'start');
    $('btnPause').onclick = () => control(GAME, 'pause');
    $('btnResume').onclick = () => control(GAME, 'resume');
    $('btnNext').onclick = () => control(GAME, 'interrupt');
    $('btnApplyCfg').onclick = () => {
      const num = (id, def) => { const v = parseInt($(id).value, 10); return Number.isNaN(v) ? def : v; };
      control(GAME, 'config', {
        pendingSec: num('cfPending', 20),
        baseScore: num('cfBase', 100),
        rateLimitSec: num('cfRate', 2),
        autoNext: $('cfAuto').checked,
        dictFilter: $('cfDict').checked,
        allowRepeat: $('cfRepeat').checked,
        startMode: $('cfMode').value,
        manualWord: $('cfWord').value.trim() || '一马当先',
      });
    };
  }

  /* ───────────── 最近接龙：每轮可展开明细（起始词 + 每层玩家/成语/分数） ───────────── */
  function renderHistory() {
    const hist = $('ctlChengyuHistory');
    if (!hist) return;
    hist.innerHTML = '';
    if (state.lastRounds && state.lastRounds.length) {
      state.lastRounds.slice(0, 20).forEach((r, ri) => {
        const wrap = document.createElement('div');
        wrap.className = 'cround' + (ri === 0 ? ' open' : '');   // 最新一轮默认展开
        const best = r.topUser ? `${esc(r.topUser)}${r.topScore ? ' +' + r.topScore : ''}` : '无人接龙';
        let body = '';
        if (Array.isArray(r.chain) && r.chain.length) {
          // chain[0] 是起始种子层，其余为观众接龙层
          body = r.chain.map(f => {
            const isSeed = f.type === 'seed' || !f.score;
            const tag = isSeed ? '<span class="cf-tag">起始</span>' : (f.connName ? `<span class="cf-tag">${esc(f.connName)}</span>` : '');
            const name = isSeed ? '起始词' : esc(f.user);
            const scoreTxt = isSeed ? '' : (f.score ? `<span class="cf-score">+${f.score}</span>` : '');
            return `<div class="cfloor">${tag}<span class="cf-word">${esc(f.word)}</span><span class="cfloor-user">${name}</span>${scoreTxt}</div>`;
          }).join('');
        } else {
          body = '<div class="cfloor"><span class="cfloor-user">（无明细）</span></div>';
        }
        wrap.innerHTML = `
          <div class="cround-hd">
            <span class="cround-arrow">▶</span>
            <span class="cround-no">#${r.roundNo}</span>
            <span class="cround-word">${esc(r.startWord || '')}</span>
            <span class="cround-meta">${r.floors} 层 · ${best}</span>
          </div>
          <div class="cround-body">${body}</div>`;
        // 点击折叠/展开
        wrap.querySelector('.cround-hd').onclick = () => wrap.classList.toggle('open');
        hist.appendChild(wrap);
      });
    } else {
      hist.innerHTML = '<div>暂无历史</div>';
    }
  }

  /* ───────────── 接入与模拟（公共组件：直播间筛选 + 模拟观众套件） ───────────── */
  roomFilter = DG.mountFeedTools($('ctlFeedTools'), GAME, {
    getRoomId: () => (state && state.cfg && state.cfg.allowedRoomId) || '',
    sim: { chat: { placeholder: '模拟弹幕成语' }, like: false, gift: false, enter: false },
  });

  /* ───────────── 通用 AI 播报面板 ───────────── */
  DGBroadcast.mountPanel($('bcPanel'), { game: GAME });
})();
