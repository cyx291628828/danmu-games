/* ══════════════════════════════════════════════════════════════════
   control.js — 红蓝大作战 · 主播台控制台逻辑（games/redblue/public）
   页面可独立打开，也可嵌在主播台框架 iframe 中（/control.html?game=redblue）
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, showToast, control } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'redblue';
  let state = null;
  let cfgFormBuilt = false;
  let roomFilter = null;

  /* ───────────── SSE（只订阅本游戏） ───────────── */
  DG.connectSSE(GAME, {
    onState: (_gid, st) => { state = st; render(); },
    onNotice: (_gid, n) => { if (n && n.text) showToast(n.text); },
    onError: () => showToast('与游戏服务断连，正在重试…'),
  });

  // 本地心跳：状态条/倒计时/战线/怪物血量每秒自动刷新，不依赖 SSE 推送
  setInterval(() => { if (state) renderStatus(); }, 1000);

  function render() {
    if (!state) return;
    if (roomFilter) roomFilter.refresh();
    DGBroadcast.watch(state);   // 通用播报：bc.seq 自增 → 自动朗读 + 渲染播报记录
    renderStatus();
    renderTeams();
    renderSeason();
    ensureCfgForm();
    backfillCfg();
    renderHistory();
  }

  /* ───────────── 赛季战队 ───────────── */
  function renderSeason() {
    const s = state.season;
    if (!s) return;
    $('chipSeason').textContent = `第 ${s.seasonNo} 赛季`;
    $('chipSeasonRed').textContent = `${s.totals.red.score} 分 / ${s.totals.red.wins} 胜`;
    $('chipSeasonBlue').textContent = `${s.totals.blue.score} 分 / ${s.totals.blue.wins} 胜`;
    $('chipSeasonMembers').textContent = `${s.members} 人`;
  }

  /* ───────────── 实时状态 ───────────── */
  function renderStatus() {
    const stMap = {
      idle: '空闲',
      joining: `组队中（剩余 ${remainSec()}s）`,
      tugging: `对抗中（剩余 ${remainSec()}s）`,
      sieging: `守城战（剩余 ${remainSec()}s）`,
      revealed: '已结算',
      paused: '已暂停',
    };
    const c = state.cfg || {};
    $('chipPhase').textContent = `阶段: ${stMap[state.status] || state.status}`;
    $('chipPhase').classList.toggle('rb-live', state.status === 'tugging' || state.status === 'sieging');
    $('chipRemain').textContent = `剩余 ${['joining', 'tugging', 'sieging'].includes(state.status) ? remainSec() + 's' : '--'}`;
    $('chipRed').textContent = `${state.red.count} 人`;
    $('chipBlue').textContent = `${state.blue.count} 人`;
    if (state.mode === 'siege' && state.monster) {
      $('chipPos').textContent = `${state.monster.name} ${state.monster.hp}血`;
    } else {
      $('chipPos').textContent = `${Math.round(state.pos)}%`;
    }
    $('chipSeries').textContent = `${state.series.red} : ${state.series.blue}`;
    let extra = '';
    if (state.mode === 'siege' && state.monster) {
      extra = ` · 城墙 ${Math.round(state.wall.hp / state.wall.hpMax * 100)}%`;
    } else if (state.streak && state.streak.team && state.streak.n > 1) {
      extra = ` · ${(state.streak.team === 'red' ? state.red.name : state.blue.name)} 连胜 ×${state.streak.n}`;
    }
    $('ctlStatus').textContent = `状态: ${stMap[state.status] || state.status} · 第 ${state.roundNo} 局 · 模式 ${modeLabel(state.mode)}${extra}`;
  }

  function remainSec() { return Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000)); }
  function modeLabel(m) { return { tug: '纯拔河', siege: '守城', mixed: '混合' }[m] || m || '拔河'; }

  function renderTeams() {
    // 阵营名回填（非聚焦时）
    const setV = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v || ''; };
    setV('cfgRedName', state.cfg.teamRedName);
    setV('cfgBlueName', state.cfg.teamBlueName);
    // 滑杆回填（拖动中不覆盖：activeElement 判断对 range 同样生效）
    setV('cfgRedMult', state.cfg.redMult ?? 1);
    setV('cfgBlueMult', state.cfg.blueMult ?? 1);
    $('lblRedMult').textContent = Number($('cfgRedMult').value).toFixed(1);
    $('lblBlueMult').textContent = Number($('cfgBlueMult').value).toFixed(1);
  }

  /* ───────────── 配置表单（一次性生成 + 回填，按功能分组） ───────────── */
  function ensureCfgForm() {
    const box = $('cfgForm');
    if (!box || cfgFormBuilt) return;
    cfgFormBuilt = true;
    box.innerHTML = `
      <div class="cc-title">局面与节奏</div>
      <label>组队时长(秒) <input id="cfgJoin" type="number" min="5"></label>
      <label>对抗时长(秒) <input id="cfgTug" type="number" min="20"></label>
      <label>结算停留(秒) <input id="cfgResult" type="number" min="3"></label>
      <label>拉动限频(秒) <input id="cfgRate" type="number" min="1"></label>
      <label><input id="cfgAuto" type="checkbox"> 自动开新一轮</label>
      <div class="cfg-break"></div>
      <div class="cc-title">能量与冲锋</div>
      <label>N 赞=1 能量 <input id="cfgLPE" type="number" min="1"></label>
      <label>冲锋阈值 <input id="cfgST" type="number" min="5"></label>
      <label>冲锋推力(格) <input id="cfgSP" type="number" min="1"></label>
      <label>胜负线(%) <input id="cfgWL" type="number" min="60" max="99"></label>
      <div class="cfg-break"></div>
      <div class="cc-title">背水一战与计分</div>
      <label><input id="cfgBW" type="checkbox"> 背水一战</label>
      <label>落后(格) <input id="cfgBWG" type="number" min="1"></label>
      <label>倍率 <input id="cfgBWM" type="number" min="1" max="3" step="0.1"></label>
      <label>胜方分 <input id="cfgWin" type="number" min="1"></label>
      <label>败方分 <input id="cfgLose" type="number" min="0"></label>
      <label>MVP分 <input id="cfgMvp" type="text" placeholder="200,150,100"></label>
      <div class="cfg-break"></div>
      <div class="cc-title">礼物 / 进场 / 模式</div>
      <label><input id="cfgGift" type="checkbox"> 礼物召唤</label>
      <label>礼物推力(格) <input id="cfgGP" type="number" min="1"></label>
      <label><input id="cfgEnter" type="checkbox"> 进场播报</label>
      <label>模式
        <select id="cfgMode">
          <option value="tug">纯拔河</option>
          <option value="siege">纯守城</option>
          <option value="mixed">混合（每N轮守城）</option>
        </select>
      </label>
      <label>每N轮守城 <input id="cfgSER" type="number" min="1"></label>
      <div class="cfg-break"></div>
      <div class="cc-title">守城战（PVE）参数</div>
      <label>怪物血量 <input id="cfgMHp" type="number" min="20"></label>
      <label>攻城间隔(秒) <input id="cfgMAS" type="number" min="2"></label>
      <label>攻城伤害 <input id="cfgMA" type="number" min="1"></label>
      <label>城墙耐久 <input id="cfgWHp" type="number" min="20"></label>
      <label>全力一击伤害 <input id="cfgSSD" type="number" min="5"></label>
      <label>守城成功分 <input id="cfgSWS" type="number" min="1"></label>
      <label>守城失败分 <input id="cfgSLS" type="number" min="0"></label>
      <div class="cfg-break"></div>
      <div class="cfg-hint">守城轮：任意弹幕=攻击（带队色自动入该队，无队色补进人少一队），点赞充能「全力一击」，怪物周期攻城。参考：百人直播间怪物血量 800~1500，几十人 300 左右。</div>
      <div class="cfg-break"></div>
      <div class="cfg-hint">AI 战报配置已移到下方「🤖 AI 语音播报」面板（通用播报中心：生成方式 / 接口 / 逐点开关 / TTS 设置）。</div>
      <button id="btnApplyCfg" class="btn secondary">应用配置</button>`;
    $('btnApplyCfg').onclick = applyCfg;
  }

  /** 回填动态配置值（仅非聚焦输入框，避免打断主播编辑） */
  function backfillCfg() {
    if (!state.cfg) return;
    const c = state.cfg;
    const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
    const setChk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
    set('cfgJoin', c.joinSec); set('cfgTug', c.tugSec); set('cfgResult', c.resultShowSec);
    set('cfgRate', c.rateLimitSec); set('cfgLPE', c.likesPerEnergy);
    set('cfgST', c.surgeThreshold); set('cfgSP', c.surgePush); set('cfgWL', c.winLine);
    setChk('cfgBW', c.backwater); set('cfgBWG', c.backwaterGap); set('cfgBWM', c.backwaterMult);
    set('cfgWin', c.winScore); set('cfgLose', c.loseScore); set('cfgMvp', c.mvpScores);
    setChk('cfgGift', c.giftEnabled); set('cfgGP', c.giftPush);
    setChk('cfgEnter', c.enterHint); setChk('cfgAuto', c.autoNextRound);
    set('cfgMode', c.mode || 'tug'); set('cfgSER', c.siegeEveryRounds);
    set('cfgMHp', c.monsterHp); set('cfgMAS', c.monsterAtkSec); set('cfgMA', c.monsterAtk);
    set('cfgWHp', c.wallHp); set('cfgSSD', c.siegeSurgeDamage);
    set('cfgSWS', c.siegeWinScore); set('cfgSLS', c.siegeLoseScore);
    // AI 战报配置已迁移到 DGBroadcast 面板（自行回填/提交）
  }

  function applyCfg() {
    const num = (id, def) => { const v = parseFloat($(id).value); return Number.isNaN(v) ? def : v; };
    const payload = {
      joinSec: num('cfgJoin', 15), tugSec: num('cfgTug', 120), resultShowSec: num('cfgResult', 12),
      rateLimitSec: num('cfgRate', 2), likesPerEnergy: num('cfgLPE', 3),
      surgeThreshold: num('cfgST', 50), surgePush: num('cfgSP', 12), winLine: num('cfgWL', 90),
      backwater: $('cfgBW').checked, backwaterGap: num('cfgBWG', 12), backwaterMult: num('cfgBWM', 1.3),
      winScore: num('cfgWin', 80), loseScore: num('cfgLose', 20), mvpScores: $('cfgMvp').value.trim() || '200,150,100',
      giftEnabled: $('cfgGift').checked, giftPush: num('cfgGP', 3),
      enterHint: $('cfgEnter').checked, autoNextRound: $('cfgAuto').checked,
      mode: $('cfgMode').value, siegeEveryRounds: num('cfgSER', 3),
      monsterHp: num('cfgMHp', 300), monsterAtkSec: num('cfgMAS', 8), monsterAtk: num('cfgMA', 7),
      wallHp: num('cfgWHp', 100), siegeSurgeDamage: num('cfgSSD', 20),
      siegeWinScore: num('cfgSWS', 60), siegeLoseScore: num('cfgSLS', 10),
      // AI 战报配置由 DGBroadcast 面板自行提交（config 动作的 bc* / ai* 键）
    };
    control(GAME, 'config', payload);
  }

  function bindControlEvents() {
    $('btnStart').onclick = () => control(GAME, 'start');
    $('btnPause').onclick = () => control(GAME, 'pause');
    $('btnResume').onclick = () => control(GAME, 'resume');
    $('btnReveal').onclick = () => control(GAME, 'reveal');
    $('btnEnd').onclick = () => control(GAME, 'end');
    $('btnTeams').onclick = () => control(GAME, 'setTeams', {
      redName: $('cfgRedName').value.trim(), blueName: $('cfgBlueName').value.trim(),
    });
    $('btnMult').onclick = () => control(GAME, 'setMult', {
      redMult: parseFloat($('cfgRedMult').value) || 1, blueMult: parseFloat($('cfgBlueMult').value) || 1,
    });
    $('cfgRedMult').addEventListener('input', () => { $('lblRedMult').textContent = Number($('cfgRedMult').value).toFixed(1); });
    $('cfgBlueMult').addEventListener('input', () => { $('lblBlueMult').textContent = Number($('cfgBlueMult').value).toFixed(1); });
    $('btnNewSeason').onclick = () => {
      if (confirm('确认开启新赛季？当前赛季功勋将归档清零（旧季数据保留在 data/ 目录）。')) {
        control(GAME, 'newSeason');
      }
    };
  }

  /* ───────────── 战报 / 历史 ───────────── */
  function renderHistory() {
    const hist = $('ctlHistory');
    const list = state.history || [];
    if (!list.length) { hist.innerHTML = '<div>暂无历史</div>'; return; }
    hist.innerHTML = list.slice(0, 20).map(r => {
      if (r.mode === 'siege') {
        return `<div class="half"><span>#${r.roundNo}</span><span>${r.success ? '🎉 <b class="rb-h-red">守城成功</b>' : '💀 守城失败'}</span><span>${esc(r.monster || '')}</span><span>${new Date(r.ts).toLocaleTimeString()}</span></div>`;
      }
      const w = r.winner === 'red' ? `<b class="rb-h-red">${esc((state.cfg.teamRedName) || '红队')}胜</b>`
        : r.winner === 'blue' ? `<b class="rb-h-blue">${esc((state.cfg.teamBlueName) || '蓝队')}胜</b>`
          : '<b>平局</b>';
      return `<div class="half"><span>#${r.roundNo}</span><span>${w}</span><span>战线 ${r.pos}%</span><span>${new Date(r.ts).toLocaleTimeString()}</span></div>`;
    }).join('');
  }

  /* ───────────── 接入与模拟（公共组件：直播间筛选 + 模拟观众套件） ───────────── */
  roomFilter = DG.mountFeedTools($('ctlFeedTools'), GAME, {
    getRoomId: () => (state && state.cfg && state.cfg.allowedRoomId) || '',
    sim: { chat: { placeholder: '红 / 蓝 或守城任意文本' }, like: { count: 10 }, gift: true, enter: true },
  });
  bindControlEvents();

  /* ───────────── 通用 AI 语音播报面板（common broadcast.js） ───────────── */
  DGBroadcast.mountPanel($('bcPanel'), { game: GAME });
})();
