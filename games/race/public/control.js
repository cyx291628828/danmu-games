/* ══════════════════════════════════════════════════════════════════
   control.js — 赛马竞猜 · 主播台控制台逻辑（games/race/public）
   页面可独立打开，也可嵌在主播台框架 iframe 中（/control.html?game=race）

   分区：局面控制 / 接入与模拟 / 实时状态 / 模拟观众押注 / 钱包工具 /
        AI 语音播报（通用模块 DGBroadcast） / 游戏配置 / 本局结算 / 榜单 / 历史战报
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, showToast, control, avatarHTML } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'race';
  let state = null;
  let cfgFormBuilt = false;
  let roomFilter = null;
  let lastSimHorseKey = '';

  /* ───────────── 通用 AI 语音播报面板（先挂载，保证首帧 watch 就能渲染记录） ───────────── */
  DGBroadcast.mountPanel($('bcPanel'), { game: GAME });

  /* ───────────── SSE（只订阅本游戏） ───────────── */
  DG.connectSSE(GAME, {
    onState: (_gid, st) => { state = st; render(); },
    onNotice: (_gid, n) => { if (n && n.text) showToast(n.text); },
    onError: () => showToast('与游戏服务断连，正在重试…'),
  });

  // 倒计时独立 tick：SSE 只在状态变化时推送，本地自驱才能保证「剩余 Xs」一直跳动
  setInterval(() => { if (state) renderStatus(); }, 250);

  const fmt = n => (Number(n) || 0).toLocaleString('zh-CN');

  function render() {
    if (!state) return;
    if (roomFilter) roomFilter.refresh();
    renderStatus();
    renderMiniTrack();
    renderSimHorses();
    renderResult();
    renderBoards();
    renderHistory();
    ensureCfgForm();
    backfillCfg();
    // 通用播报中心：收到新播报自动朗读 + 渲染播报记录
    DGBroadcast.watch(state);
  }

  /* ───────────── 实时状态 ───────────── */
  const ST_MAP = {
    idle: '空闲',
    betting: '下注中',
    racing: '比赛中',
    result: '结算停留',
    paused: '已暂停',
  };

  function remainSec() {
    if (!state || !state.phaseDeadline) return 0;
    return Math.max(0, (state.phaseDeadline - Date.now()) / 1000);
  }

  function renderStatus() {
    const st = state.status || 'idle';
    const rs = remainSec();
    let txt = `状态: ${ST_MAP[st] || st} · 第 ${state.roundNo} 局`;
    if (st === 'betting') txt += ` · 剩余 ${Math.ceil(rs)}s（发「1」「押2」「3 200」下注）`;
    else if (st === 'racing') txt += ` · 剩余 ${rs.toFixed(1)}s${state.finalSprint ? ' · ⚡冲刺阶段' : ''}`;
    else if (st === 'result') txt += ` · ${Math.ceil(rs)}s 后自动开下一局`;
    else if (st === 'paused') txt += ' · 已冻结计时';
    $('ctlStatus').textContent = txt;

    $('stPool').textContent = fmt(state.pool);
    $('stCarry').textContent = fmt(state.carry);
    $('stStaked').textContent = fmt(state.totalStaked);
    $('stBets').textContent = state.betCount || 0;
    $('stBettors').textContent = state.bettors || 0;
    $('stRemain').textContent = (st === 'betting' || st === 'racing') ? Math.ceil(rs) + 's' : '--';
    $('stPool').parentNode.classList.toggle('hot', !!state.carry);
  }

  /* ───────────── 迷你赛道（各马进度 / 赔率 / 注额） ───────────── */
  function renderMiniTrack() {
    const horses = state.horses || [];
    const winIdx = state.result ? state.result.winnerIdx : -1;
    $('miniTrack').innerHTML = horses.length ? horses.map((h, i) => `
      <div class="rc-mini${i === winIdx ? ' win' : ''}">
        <span class="mi-no" style="background:${esc(h.color)}">${h.no}</span>
        <span class="mi-nm">${esc(h.name)}</span>
        <span class="mi-bar">
          <i class="mi-fill" style="width:${Math.min(100, h.pos)}%;background:${esc(h.color)}"></i>
          <i class="mi-flag"></i>
        </span>
        <span class="mi-odds">×${h.odds}</span>
        <span class="mi-bet">${fmt(h.bet)} / ${h.bettors}人</span>
      </div>`).join('') : '<div class="ctl-hint">尚未开局，点「开新一局」开始下注。</div>';
  }

  /* ───────────── 本局结算 ───────────── */
  let lastResultKey = '';
  function renderResult() {
    const r = state.result;
    const box = $('ctlResult');
    if (!r) { box.innerHTML = '<div class="ctl-hint">本局尚未结算。</div>'; lastResultKey = ''; return; }
    const key = `${r.roundNo}|${r.winner ? r.winner.no : ''}|${r.jackpot}`;
    if (key === lastResultKey) return;
    lastResultKey = key;
    const winners = (r.winners || []).slice(0, 8);
    box.innerHTML = `<div class="rc-result">
      <div class="rc-result-head">
        <span class="rc-wn">${r.winner ? r.winner.no + '号 ' + esc(r.winner.name) : '—'}</span>
        <span class="rc-odds">×${r.odds}</span>
        ${r.jackpot ? '<span class="rc-jp">🔥 头奖滚存</span>' : ''}
        <span class="ctl-hint" style="margin:0">彩池 ${fmt(r.pool)} · 押中 ${r.winnerCount} 人 · 派彩 ${fmt(r.payout)} · 领先 ${r.margin} 格</span>
      </div>
      ${r.report ? `<div class="rc-result-report">🗣 ${esc(r.report)}</div>` : ''}
      <div class="rc-winners">
        ${winners.length ? winners.map(w => `<div class="rc-winner">
          <span class="w-nm">${esc(w.name)}</span>
          <span class="w-st">押 ${fmt(w.stake)}</span>
          <span class="w-pay">+${fmt(w.payout)}</span>
        </div>`).join('') : `<div class="ctl-hint">无人押中${r.jackpot ? '（彩池已滚存到下一局）' : ''}</div>`}
      </div>
    </div>`;
  }

  /* ───────────── 榜单 ───────────── */
  function renderBoards() {
    const wt = state.walletTop || [];
    $('walletBoard').innerHTML = wt.length ? wt.map(r => `
      <div class="rc-lb-row r${r.rank}">
        <span class="rk">${r.rank}</span>
        <span class="nm">${esc(r.name)}</span>
        <span class="mt">${r.wins}胜/${r.rounds}局</span>
        <span class="sc">${fmt(r.chips)}</span>
      </div>`).join('') : '<div class="ctl-hint">还没有人开户（观众进场或首次下注即自动开户）。</div>';

    const lb = state.leaderboard || [];
    $('honorBoard').innerHTML = lb.length ? lb.map(r => `
      <div class="rc-lb-row r${r.rank}">
        <span class="rk">${r.rank}</span>
        <span class="nm">${esc(r.name)}</span>
        <span class="mt">${(r.race_wins || 0)}胜</span>
        <span class="sc">${fmt(r.totalScore)}</span>
      </div>`).join('') : '<div class="ctl-hint">暂无荣誉分（押中即可获得）。</div>';
  }

  /* ───────────── 历史战报 ───────────── */
  function renderHistory() {
    const hist = $('ctlHistory');
    const h = state.history || [];
    if (!h.length) { hist.innerHTML = '<div class="ctl-hint">暂无历史战报。</div>'; return; }
    hist.innerHTML = h.slice(0, 20).map(r => `
      <div class="half">
        <span class="h-no">#${r.roundNo}</span>
        <span class="h-wn">${esc(r.winner)}</span>
        <span class="h-od">×${r.odds}</span>
        <span class="h-rp" title="${esc(r.report || '')}">${esc(r.report || '')}</span>
        <span class="h-jp">${r.jackpot ? '🔥滚存' : ''}</span>
        <span class="ctl-hint" style="margin:0">池 ${fmt(r.pool)} · ${r.winnerCount}人中</span>
      </div>`).join('');
  }

  /* ───────────── 模拟观众押注（马号下拉随本局马匹动态生成） ───────────── */
  function renderSimHorses() {
    const horses = state.horses || [];
    const key = `${state.roundNo}|${horses.length}`;
    const sel = $('simBetHorse');
    if (!sel) return;
    if (key === lastSimHorseKey && sel.options.length) return;
    lastSimHorseKey = key;
    const cur = sel.value;
    sel.innerHTML = horses.length
      ? horses.map(h => `<option value="${h.no}">${h.no}号 ${esc(h.name)}（×${h.odds}）</option>`).join('')
      : '<option value="1">1号</option>';
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  }

  /* ───────────── 钱包工具（查询 / 调账） ───────────── */
  let walletRows = [];
  async function doWalletQuery() {
    const name = $('walletName').value.trim();
    if (!name) { showToast('请输入要查询的昵称关键字'); return; }
    const r = await control(GAME, 'walletQuery', { name }, { silent: true });
    const list = (r && r.state && r.state.walletQuery) || [];
    if (!list.length) {
      $('walletResult').innerHTML = `<div class="ctl-hint">没有找到包含「${esc(name)}」的观众。</div>`;
      return;
    }
    walletRows = list;
    renderWalletRows();
  }

  function renderWalletRows() {
    $('walletResult').innerHTML = walletRows.map((r, i) => `
      <div class="wallet-row">
        <span class="wr-name">${esc(r.name)}</span>
        <span class="wr-chip" id="wc${i}">${fmt(r.chips)}</span>
        <span class="wr-meta">${r.wins}胜 / ${r.rounds}局 · uid ${esc(String(r.uid).slice(0, 12))}</span>
        <span class="wr-act">
          <input id="wa${i}" type="number" placeholder="+/- 筹码" step="100">
          <button class="btn tiny secondary" data-adj="${i}">调整</button>
        </span>
      </div>`).join('');
    $('walletResult').querySelectorAll('button[data-adj]').forEach(btn => {
      btn.onclick = async () => {
        const i = parseInt(btn.dataset.adj, 10);
        const rec = walletRows[i];
        const delta = parseInt(($('wa' + i) || {}).value, 10);
        if (!rec || !Number.isFinite(delta) || delta === 0) { showToast('请输入非零的调整数额'); return; }
        const r = await control(GAME, 'walletAdjust', { uid: rec.uid, delta });
        if (r && r.ok) {
          const chipsEl = $('wc' + i);
          if (chipsEl) chipsEl.textContent = fmt(r.msg && r.msg.match(/余额\s*(-?\d+)/) ? RegExp.$1 : '—');
          $('wa' + i).value = '';
          doWalletQuery();     // 重新拉一次，保证数字与服务端一致
        }
      };
    });
  }

  /* ───────────── 配置表单（一次性生成 + 回填） ───────────── */
  const CFG_GROUPS = [
    {
      title: '⏱ 阶段节奏', hint: '一局 = 下注期 + 比赛期 + 结算停留；开「自动开下一局」后主播无需守着点。',
      items: [
        { key: 'betSec', label: '下注期(秒)', type: 'number', min: 5, def: 30 },
        { key: 'raceSec', label: '比赛期(秒)', type: 'number', min: 5, def: 25 },
        { key: 'resultSec', label: '结算停留(秒)', type: 'number', min: 3, def: 12 },
        { key: 'autoLoop', label: '自动开下一局', type: 'bool', def: true },
      ],
    },
    {
      title: '🎟 下注规则', hint: '观众发「1」「押2」「买3号」「3 200」下注；一局可押多匹，受注数上限与间隔限制。',
      items: [
        { key: 'baseBet', label: '每注筹码', type: 'number', min: 1, def: 100 },
        { key: 'maxBetsPerRound', label: '每人每局注数上限', type: 'number', min: 1, def: 5 },
        { key: 'rateLimitSec', label: '下注间隔(秒)', type: 'number', min: 0, def: 2 },
        { key: 'horseCount', label: '参赛马匹数', type: 'number', min: 2, max: 6, def: 4 },
      ],
    },
    {
      title: '💎 筹码经济', hint: '观众进场即自动开户送筹码（零门槛下注）；筹码输光后每局可领一次救济金，保证不离场。',
      items: [
        { key: 'startChips', label: '开户赠送筹码', type: 'number', min: 0, def: 1000 },
        { key: 'bailoutChips', label: '破产救济金', type: 'number', min: 0, def: 500 },
        { key: 'honorScore', label: '押中荣誉分', type: 'number', min: 0, def: 30 },
      ],
    },
    {
      title: '📈 赔率', hint: '赔率 = (本局注额 + 上局滚存) ÷ 该马注额，实时浮动并夹在上下限之间。人越多押的马赔率越低，冷门越肥。',
      items: [
        { key: 'minOdds', label: '赔率下限(倍)', type: 'number', min: 1, def: 1.2 },
        { key: 'maxOdds', label: '赔率上限(倍)', type: 'number', min: 1, def: 20 },
        { key: 'jackpotEnabled', label: '头奖滚存（无人押中则彩池滚到下一局）', type: 'bool', def: true },
      ],
    },
    {
      title: '🔥 点赞加速（拉点赞的核心）', hint: '点赞只加速「自己押的那匹马」——未下注的人点赞无效，先引导下注。最后冲刺期效率翻倍，专门制造反超名场面。',
      items: [
        { key: 'likesPerBoost', label: '每N赞加速1格', type: 'number', min: 1, def: 3 },
        { key: 'maxBoostCells', label: '单马助威上限(格)', type: 'number', min: 0, def: 20 },
        { key: 'finalSprintSec', label: '最后冲刺期(秒)', type: 'number', min: 0, def: 5 },
        { key: 'finalSprintMult', label: '冲刺期点赞倍率', type: 'number', min: 1, def: 2 },
      ],
    },
    {
      title: '🎁 礼物骑士冲锋（拉礼物的核心）', hint: '任何人送礼，送礼者所押的马立刻「骑士冲锋」前进若干格，并触发全屏金光 + 金币雨 + 彩带，是全场最强的视觉回报。',
      items: [
        { key: 'giftBoostEnabled', label: '启用礼物骑士冲锋', type: 'bool', def: true },
        { key: 'giftBoostCells', label: '每次礼物加速(格)', type: 'number', min: 0, def: 6 },
        { key: 'giftMaxCellsPerHorse', label: '礼物单马上限(格)', type: 'number', min: 0, def: 24 },
      ],
    },
    {
      title: '⭐ 关注送筹码', hint: '关注主播即时到账筹码，冷却期内不重复发放（防刷）。',
      items: [
        { key: 'followBonusChips', label: '关注赠送筹码', type: 'number', min: 0, def: 500 },
        { key: 'followCooldownHours', label: '关注冷却(小时)', type: 'number', min: 1, def: 21 },
      ],
    },
    {
      title: '🎬 竞速手感与特效', hint: '胶着程度越高越容易互相反超（橡皮筋机制）；特效强度选「全屏特效」才有开赛闪光、冲线烟花金币雨、头奖滚存横扫。',
      items: [
        { key: 'surgePerRace', label: '每局冲刺次数', type: 'number', min: 0, def: 2 },
        { key: 'rubberBand', label: '胶着程度(0-1.5)', type: 'number', min: 0, max: 1.5, step: 0.1, def: 0.8 },
        { key: 'fxLevel', label: '特效强度', type: 'select', def: 'full', options: [['full', '全屏特效（推荐）'], ['simple', '基础动效'], ['off', '关闭特效']] },
      ],
    },
  ];

  function cfgId(key) { return 'cfg_' + key; }

  function ensureCfgForm() {
    const box = $('cfgForm');
    if (!box || cfgFormBuilt) return;
    cfgFormBuilt = true;
    const c = state.cfg || {};
    let html = '';
    for (const g of CFG_GROUPS) {
      html += `<div class="cfg-break"></div><div class="cc-title">${esc(g.title)}</div>`;
      for (const it of g.items) {
        const v = c[it.key] !== undefined ? c[it.key] : it.def;
        if (it.type === 'bool') {
          html += `<label><input id="${cfgId(it.key)}" type="checkbox" ${v ? 'checked' : ''}> ${esc(it.label)}</label>`;
        } else if (it.type === 'select') {
          html += `<label>${esc(it.label)} <select id="${cfgId(it.key)}">${it.options
            .map(([val, nm]) => `<option value="${esc(val)}"${String(v) === String(val) ? ' selected' : ''}>${esc(nm)}</option>`).join('')}</select></label>`;
        } else {
          const step = it.step !== undefined ? ` step="${it.step}"` : '';
          const max = it.max !== undefined ? ` max="${it.max}"` : '';
          html += `<label>${esc(it.label)} <input id="${cfgId(it.key)}" type="number" min="${it.min}"${max}${step} value="${esc(v)}"></label>`;
        }
      }
      html += `<div class="cfg-hint">${esc(g.hint)}</div>`;
    }
    html += `<div class="cfg-break"></div><button id="btnApplyCfg" class="btn secondary">应用配置</button>`;
    box.innerHTML = html;
    $('btnApplyCfg').onclick = applyCfg;
  }

  /** 回填服务端配置值（跳过正在编辑的输入框，避免打断主播） */
  function backfillCfg() {
    if (!state.cfg) return;
    const c = state.cfg;
    for (const g of CFG_GROUPS) {
      for (const it of g.items) {
        const el = $(cfgId(it.key));
        if (!el || document.activeElement === el) continue;
        const v = c[it.key];
        if (v === undefined) continue;
        if (it.type === 'bool') el.checked = !!v;
        else el.value = v;
      }
    }
  }

  function applyCfg() {
    const payload = {};
    for (const g of CFG_GROUPS) {
      for (const it of g.items) {
        const el = $(cfgId(it.key));
        if (!el) continue;
        if (it.type === 'bool') payload[it.key] = el.checked;
        else if (it.type === 'select') payload[it.key] = el.value;
        else {
          const n = Number(el.value);
          if (!Number.isFinite(n)) { showToast(`「${it.label}」填写无效`); return; }
          payload[it.key] = n;
        }
      }
    }
    control(GAME, 'config', payload);
  }

  /* ───────────── 按钮绑定 ───────────── */
  function setNar(t) {
    const el = $('narStatus');
    if (!el) return;
    el.textContent = t || '';
    if (t) setTimeout(() => { if (el.textContent === t) el.textContent = ''; }, 2600);
  }

  $('btnStart').onclick = () => control(GAME, 'start');
  $('btnSkipBet').onclick = () => control(GAME, 'skipBet');
  $('btnPause').onclick = () => control(GAME, 'pause');
  $('btnResume').onclick = () => control(GAME, 'resume');
  $('btnEnd').onclick = () => {
    if (!state || state.status === 'idle') { showToast('当前没有进行中的对局'); return; }
    if (!confirm('结束本局并把所有人的注额原额退回钱包？')) return;
    control(GAME, 'end');
  };
  $('btnReport').onclick = async () => {
    // 手动触发一次「结算战报」播报（试听/补播用），走 finish 播报点
    setNar('生成中…');
    const r = await control(GAME, 'broadcast', { slot: 'finish', force: true }, { silent: true });
    setNar((r && r.ok) ? '已生成，朗读中…' : ((r && r.msg) || '生成失败'));
  };
  $('btnSimBet').onclick = () => {
    const name = $('simBetName').value.trim() || '模拟观众';
    control(GAME, 'simulateBet', {
      horse: parseInt($('simBetHorse').value, 10) || 1,
      count: Math.max(1, parseInt($('simBetCount').value, 10) || 1),
      name,
    });
  };
  $('btnSimBetAll').onclick = async () => {
    const horses = state.horses || [];
    if (!horses.length) { showToast('请先开局'); return; }
    if (state.status !== 'betting') { showToast('当前不在下注期'); return; }
    const names = ['阿伟', '小美', '老铁', '卷王', '锦鲤'];
    for (let i = 0; i < 5; i++) {
      await control(GAME, 'simulateBet', {
        horse: 1 + Math.floor(Math.random() * horses.length),
        count: 1 + Math.floor(Math.random() * 2),
        name: names[i],
      }, { silent: true });
    }
    showToast('已随机撒 5 注（模拟不同观众押不同马）');
  };
  $('btnWalletQuery').onclick = doWalletQuery;
  $('walletName').addEventListener('keydown', e => { if (e.key === 'Enter') doWalletQuery(); });
  $('btnResetWallet').onclick = () => {
    if (!confirm('确定要把所有观众的筹码重置为「开户赠送筹码」吗？此操作不可撤销。')) return;
    control(GAME, 'resetWallet');
  };

  /* ───────────── 接入与模拟（公共组件） ───────────── */
  roomFilter = DG.mountFeedTools($('ctlFeedTools'), GAME, {
    getRoomId: () => (state && state.cfg && state.cfg.allowedRoomId) || '',
    sim: {
      chat: { placeholder: '模拟下注（1 / 押2 / 买3号 / 3 200）' },
      like: { count: 10 },
      gift: true,
      enter: true,
      follow: true,
    },
  });
})();
