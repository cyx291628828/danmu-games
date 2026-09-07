/* ══════════════════════════════════════════════════════════════════
   stage.js — 赛马竞猜 · 展示屏逻辑（games/race/public）
   状态全部来自服务端 SSE；本地只做三件事：
     1) 倒计时/进度条本地自驱心跳（服务端不每秒推送，避免卡顿与漂移）
     2) 消费服务端 fx 特效事件队列（闪光/金币雨/彩带/骑士冲锋/头奖滚存）
     3) DOM 增量渲染（下注板与赛道结构只在「局号/阶段/马匹数」变化时重建）
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, avatarHTML, connectSSE, launchFireworks } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'race';
  const fmt = n => Number(n || 0).toLocaleString('en-US');

  let state = null;
  let lastFxId = 0;         // 已消费的特效事件 id
  let lastFeedKey = '';     // 战报流去重（最新一条的指纹）
  let boardKey = '';        // 下注板结构指纹（局号+马匹数）
  let laneKey = '';         // 赛道结构指纹
  let resultKey = '';       // 结算卡指纹（避免重复放烟花）
  let lastBcSeq = 0;
  let deadlineLocal = 0;    // 用服务端 remainSec 换算的本地截止时刻（避免时钟漂移）
  let lastRemain = -1;

  /* ───────────── SSE ───────────── */
  connectSSE(GAME, {
    onState: (_gid, st) => { state = st; render(); },
    onError: () => { /* EventSource 自动重连 */ },
  });

  /* 本地心跳：倒计时数字 + 进度条自驱（100ms） */
  setInterval(tickClock, 100);

  function tickClock() {
    if (!state) return;
    const live = state.status === 'betting' || state.status === 'racing' || state.status === 'result';
    if (!live || !deadlineLocal) { $('cdNum').textContent = '--'; $('cdFill').style.width = '0%'; return; }
    const total = Math.max(1, Number(state.phaseSec) || 1) * 1000;
    const leftMs = Math.max(0, deadlineLocal - Date.now());
    const sec = Math.ceil(leftMs / 1000);
    if (sec !== lastRemain) { $('cdNum').textContent = sec; lastRemain = sec; }
    $('cdFill').style.width = Math.min(100, ((total - leftMs) / total) * 100).toFixed(1) + '%';
  }

  /* ═══════════════ 主渲染 ═══════════════ */
  function render() {
    if (!state) return;
    const racing = state.status === 'racing';
    const betting = state.status === 'betting';
    const result = state.status === 'result';

    // 特效强度（主播台配置）
    $('phone').dataset.fx = (state.cfg && state.cfg.fxLevel) || 'full';

    // 顶栏
    $('stRound').textContent = 'ROUND ' + state.roundNo;
    const potTxt = fmt(state.pool);
    const potEl = $('potNum');
    if (potEl.textContent !== potTxt) { potEl.textContent = potTxt; bumpEl(potEl); }
    const miniEl = $('potMini');
    const miniTxt = '💰 ' + fmt(state.pool);
    if (miniEl.textContent !== miniTxt) { miniEl.textContent = miniTxt; bumpEl(miniEl); }
    const carry = Number(state.carry) || 0;
    $('chipCarry').classList.toggle('hidden', carry <= 0);
    $('carryNum').textContent = fmt(carry);

    // 倒计时基准：每次状态推送用服务端剩余时间校正本地截止时刻
    if (state.remainSec != null && (betting || racing || result)) {
      const drift = Math.abs((deadlineLocal - Date.now()) / 1000 - state.remainSec);
      if (drift > 0.6 || deadlineLocal === 0) deadlineLocal = Date.now() + state.remainSec * 1000;
    }

    // 阶段标签
    const tag = $('phaseTag');
    tag.classList.toggle('race', racing);
    tag.classList.toggle('sprint', !!state.finalSprint);
    tag.textContent = betting ? '下注期 · 发 1/2/3/4'
      : racing ? (state.finalSprint ? '最后冲刺！点赞加倍' : '比赛期 · 冲刺')
        : result ? '本局结算' : state.status === 'paused' ? '已暂停' : '等待开始';
    $('cdFill').classList.toggle('sprint', !!state.finalSprint);

    // 核心区双态切换
    $('betBoard').classList.toggle('hidden', !betting);
    $('raceTrack').classList.toggle('hidden', !(racing || result));
    if (betting) renderBoard();
    if (racing || result) { renderLanes(); updateRunners(); }

    renderCheer();
    renderHowto();
    renderFeed();
    renderBoards();
    consumeFx();
    renderResult();
    renderBcBar();
  }

  /* ═══════════════ 下注板 ═══════════════ */
  function renderBoard() {
    const horses = state.horses || [];
    const key = `${state.roundNo}|${horses.length}`;
    if (key !== boardKey) {
      boardKey = key;
      $('horseRows').innerHTML = horses.map((h, i) => `
        <div class="horse-row" id="hr${i}">
          <div class="hr-flash"></div>
          <div class="horse-no" style="background:${esc(h.color)}">${h.no}</div>
          <div class="horse-info">
            <div class="horse-name" style="color:${esc(h.color)}">🐎 ${esc(h.name)}</div>
            <div class="horse-meta" id="hm${i}"></div>
          </div>
          <div class="heat-wrap"><div class="heat-bar"><div class="heat-fill" id="hf${i}" style="background:${esc(h.color)}"></div></div></div>
          <div class="odds"><div class="x" id="od${i}" style="color:${esc(h.color)}">--</div><div class="lbl">赔率</div></div>
        </div>`).join('');
    }
    let maxBet = 0;
    for (const h of horses) maxBet = Math.max(maxBet, h.bet);
    horses.forEach((h, i) => {
      const row = $('hr' + i);
      if (row) row.classList.toggle('fav', maxBet > 0 && h.bet === maxBet);
      const meta = $('hm' + i);
      if (meta) meta.textContent = `${h.heat}% 注 · ${h.bettors} 人 · ${fmt(h.bet)} 筹码`;
      const hf = $('hf' + i);
      if (hf) hf.style.width = Math.min(100, h.heat) + '%';
      const od = $('od' + i);
      if (od && od.textContent !== '×' + h.odds) od.textContent = '×' + h.odds;
    });
  }

  /* ═══════════════ 赛道 ═══════════════ */
  function renderLanes() {
    const horses = state.horses || [];
    const key = `${state.roundNo}|${horses.length}`;
    if (key !== laneKey) {
      laneKey = key;
      $('lanes').innerHTML = horses.map((h, i) => `
        <div class="lane" id="lane${i}">
          <div class="ground"></div>
          <div class="runner" id="run${i}">
            <span class="em">🐎</span>
            <span class="nm" style="background:${esc(h.color)}">${h.no} ${esc(h.name)}</span>
          </div>
          <div class="boost-tag" id="btag${i}"></div>
          <div class="lead-crown" id="crown${i}"></div>
          <div class="finish-line"></div>
        </div>`).join('');
    }
  }

  function updateRunners() {
    const horses = state.horses || [];
    let leadIdx = -1, leadPos = -1;
    horses.forEach((h, i) => {
      if (h.finished) { if (h.pos >= leadPos) { leadPos = h.pos; leadIdx = i; } }
      else if (h.pos > leadPos) { leadPos = h.pos; leadIdx = i; }
    });
    const racing = state.status === 'racing';
    horses.forEach((h, i) => {
      const lane = $('lane' + i);
      const run = $('run' + i);
      if (!lane || !run) return;
      lane.classList.toggle('racing', racing && !h.finished);
      lane.classList.toggle('burst', !!h.burst);
      lane.classList.toggle('winner-lane', !!(state.result && state.result.winnerIdx === i));
      lane.classList.toggle('lead-lane', racing && i === leadIdx && h.pos > 8);
      run.style.setProperty('--p', Math.min(100, Math.max(0, h.pos)) / 100);
      run.classList.toggle('run', racing && !h.finished);
      run.classList.toggle('burst', !!h.burst);
      run.classList.toggle('leader', racing && i === leadIdx && h.pos > 8 && !h.finished);
      const crown = $('crown' + i);
      if (crown) crown.textContent = (i === leadIdx && h.pos > 8) ? '👑' : '';
      const btag = $('btag' + i);
      if (btag) btag.textContent = (h.boostCells + h.giftCells) > 0 ? `+${h.boostCells + h.giftCells}格` : '';
      // 比赛期粒子系统：移动中的马扬尘土；冲刺中的马喷火焰
      if (racing && !h.finished && state.cfg && state.cfg.fxLevel !== 'off') {
        spawnDust(i, h);
        if (h.burst) spawnFlame(i);
      }
    });
    // 冲线瞬间整场进入慢动作（photoFinish 特效触发时由本地 slowmoOn 接管）
    $('lanes').classList.toggle('slowmo', !!slowmoOn);
  }

  /* 慢动作标记（photoFinish 冲线特写用，本地状态；1.8s 后自动恢复） */
  let slowmoOn = false;
  function slowmo() {
    slowmoOn = true;
    $('lanes').classList.add('slowmo');
    clearTimeout(slowmo._t);
    slowmo._t = setTimeout(() => { slowmoOn = false; $('lanes').classList.remove('slowmo'); }, 1800);
  }

  /* ═══════════════ 助威 / 礼物面板 ═══════════════ */
  function renderCheer() {
    const cfg = state.cfg || {};
    const rule = $('cheerRule');
    if (rule) {
      const per = Number(cfg.likesPerBoost) || 3;
      rule.textContent = state.finalSprint
        ? `冲刺期每 ${Math.max(1, Math.round(per / Math.max(1, cfg.finalSprintMult || 1)))} 赞 = +1 格`
        : `每 ${per} 赞 = +1 格`;
      rule.classList.toggle('sprint', !!state.finalSprint);
    }
    const cells = $('giftCells'); if (cells) cells.textContent = '+' + (Number(cfg.giftBoostCells) || 0);
    const fc = $('followChips'); if (fc) fc.textContent = fmt(cfg.followBonusChips);

    const list = (state.cheerTop || []).slice(0, 3);
    const box = $('cheerRows');
    if (!list.length) {
      box.innerHTML = '<div class="cheer-empty">虚位以待 · 点赞为你押的马加速</div>';
    } else {
      const max = Math.max(1, ...list.map(c => c.likes));
      box.innerHTML = list.map(c => {
        const col = (state.horses[c.horse - 1] || {}).color || 'var(--gold)';
        return `<div class="cheer-row">
          ${avatarHTML(c.name, c.avatar)}
          <span class="cn">${esc(c.name)}</span>
          <span class="ch" style="background:${esc(col)}">${c.horse}号</span>
          <span class="cheer-bar"><i style="width:${Math.round((c.likes / max) * 100)}%"></i></span>
          <span class="cl">${c.likes}赞</span>
        </div>`;
      }).join('');
    }
    // 礼物行：本地 1 钻礼物图 + 最近送礼者
    const gico = $('giftIco');
    if (gico) {
      const icons = (state.giftIcons || []).slice(0, 3);
      const gifters = (state.giftList || []).slice(0, 2);
      gico.innerHTML = (icons.length ? icons.map(g => `<img src="${esc(g.url)}" alt="${esc(g.name)}">`).join('') : '🎁')
        + (gifters.length ? `<span style="font-size:10px;color:var(--gold)">${gifters.map(g => esc(g.user)).join('、')} 送出</span>` : '');
    }
  }

  function renderHowto() {
    const cfg = state.cfg || {};
    const el = $('howto');
    if (state.status === 'betting') {
      el.innerHTML = `弹幕发 <b>1 / 2 / 3 / 4</b> 下注（每注 <b>${fmt(cfg.baseBet)}</b> 筹码）· 赔率随彩池实时浮动`;
    } else if (state.status === 'racing') {
      el.innerHTML = state.finalSprint
        ? `<b style="color:var(--red)">最后冲刺！</b>点赞为你押的马加速 · 点赞效率 <b>×${cfg.finalSprintMult || 2}</b>`
        : `点赞为你押的马加速 · 送礼触发 <b>骑士冲锋</b> +${cfg.giftBoostCells || 0} 格`;
    } else if (state.status === 'result') {
      el.innerHTML = `押中按 <b>最终赔率</b> 派彩 · 押中者另加 <b>${cfg.honorScore || 0}</b> 荣誉分`;
    } else {
      el.innerHTML = `弹幕发 <b>1 / 2 / 3 / 4</b> 下注 · 点赞加速 · 冷门翻倍 · 头奖滚存`;
    }
  }

  /* ═══════════════ 战报流（增量渲染，避免每次推送重播动画） ═══════════════ */
  const ICON = { bet: '💸', boost: '👍', gift: '🎁', surge: '💨', lead: '🔥', round: '🎬', raceStart: '🏁', result: '🏆', bailout: '🆘', follow: '⭐', refund: '↩️' };
  function feedText(e) {
    switch (e.type) {
      case 'bet': return `<span class="who">${esc(e.user)}</span> 押 ${e.horse} 号 ${esc(e.name2)} ×${e.count} 注（×${e.odds}）`;
      case 'boost': return `<span class="who">${esc(e.user)}</span> 点赞 ×${e.likes} → ${e.horse} 号 <b style="color:var(--gold)">+${e.cells} 格</b>${e.sprint ? ' 🔥冲刺期' : ''}`;
      case 'gift': return `<span class="who">${esc(e.user)}</span> 送出 ${esc(e.giftName || '礼物')} 🎁`;
      case 'surge': return `${e.horse} 号 <span class="who">${esc(e.name)}</span> 突然发力冲刺！`;
      case 'round': return `第 ${e.roundNo} 局开始下注${e.pool ? ` · 彩池 ${fmt(e.pool)}` : ''}`;
      case 'raceStart': return '闸门开启，开赛！';
      case 'result': return `🏆 ${e.horse} 号 <span class="who">${esc(e.name)}</span> 获胜 ×${e.odds}${e.jackpot ? ' · 头奖滚存！' : ''}`;
      case 'bailout': return `<span class="who">${esc(e.user)}</span> 筹码见底，救济 +${fmt(e.amount)}`;
      case 'follow': return `<span class="who">${esc(e.user)}</span> 关注主播，赠送 ${fmt(e.amount)} 筹码`;
      case 'refund': return `本局结束，退还注额 ${fmt(e.amount)} 筹码`;
      default: return '';
    }
  }
  function renderFeed() {
    const list = state.feed || [];
    if (!list.length) return;
    const box = $('feed');
    const key = list[list.length - 1].ts + '|' + list[list.length - 1].type;
    if (key === lastFeedKey) return;
    // 增量：只追加本次新增的条目
    const known = new Set([...box.children].map(c => c.dataset.k));
    let added = 0;
    for (const e of list) {
      const k = `${e.ts}|${e.type}|${e.user || ''}|${e.horse || ''}`;
      if (known.has(k)) continue;
      const txt = feedText(e);
      if (!txt) continue;
      const d = document.createElement('div');
      d.className = 'item' + (e.type === 'surge' || e.type === 'result' || e.type === 'gift' ? ' hot' : '')
        + (e.jackpot ? ' big' : '');
      d.dataset.k = k;
      d.innerHTML = `${ICON[e.type] || '•'} ${txt}`;
      box.insertBefore(d, box.firstChild);
      added++;
    }
    while (box.children.length > 7) box.removeChild(box.lastChild);
    if (added) lastFeedKey = key;
  }

  /* ═══════════════ 三榜单 ═══════════════ */
  function rowHTML(rank, name, avatar, score) {
    const cls = rank <= 3 ? ' r' + rank : '';
    return `<div class="row${cls}"><span class="rk">${rank}</span>${avatarHTML(name, avatar)}<span class="nm">${esc(name)}</span><span class="sc">${fmt(score)}</span></div>`;
  }
  function renderBoards() {
    // 本局赢家
    const winBox = $('winRows');
    const res = state.result;
    if (res && res.winners && res.winners.length) {
      winBox.innerHTML = res.winners.slice(0, 4).map((w, i) => rowHTML(i + 1, w.name, w.avatar, w.payout)).join('');
    } else if (res && res.jackpot) {
      winBox.innerHTML = `<div class="row r1"><span class="rk">!</span><span class="nm">无人押中</span><span class="sc">滚存</span></div>`;
    } else if (state.history && state.history.length) {
      const h = state.history[0];
      winBox.innerHTML = `<div class="row r1"><span class="rk">🏆</span><span class="nm">${esc(h.winner)}</span><span class="sc">×${h.odds}</span></div>`;
    } else {
      winBox.innerHTML = '<div class="row empty">等待首局</div>';
    }
    // 筹码富家榜
    const rich = (state.walletTop || []).slice(0, 4);
    $('richRows').innerHTML = rich.length
      ? rich.map((r, i) => rowHTML(i + 1, (i === 0 ? '💰 ' : '') + r.name, r.avatar, r.chips)).join('')
      : '<div class="row empty">暂无数据</div>';
    // 总荣誉榜
    const lb = (state.leaderboard || []).slice(0, 4);
    $('honorRows').innerHTML = lb.length
      ? lb.map((r, i) => rowHTML(i + 1, r.name, r.avatar, r.totalScore)).join('')
      : '<div class="row empty">暂无数据</div>';
  }

  /* ═══════════════ 特效 ═══════════════ */
  function consumeFx() {
    const list = state.fx || [];
    const level = (state.cfg && state.cfg.fxLevel) || 'full';
    for (const fx of list) {
      if (fx.id <= lastFxId) continue;
      lastFxId = fx.id;
      if (level !== 'off') playFx(fx, level);
    }
  }

  function playFx(fx, level) {
    switch (fx.type) {
      case 'gate':
        flash('white'); shake(600); bigFx('🏁 开 赛 !', false);
        break;
      case 'bet': {
        const row = $('hr' + (fx.horse - 1));
        if (row) { row.classList.remove('hit'); void row.offsetWidth; row.classList.add('hit'); }
        const od = $('od' + (fx.horse - 1));
        if (od) { od.classList.remove('bump'); void od.offsetWidth; od.classList.add('bump'); }
        break;
      }
      case 'boost':
        if (level === 'full') {
          popLane(fx.horse - 1, `+${fx.cells}格`);
          flyToLane(fx.horse - 1, fx.user, fx.avatar, `+${fx.cells}`);
        } else popLane(fx.horse - 1, `+${fx.cells}格`);
        break;
      case 'gift':
        flash('gold'); shake(720); bigFx(`🎁 骑士冲锋 +${fx.cells} 格`, true);
        popLane(fx.horse - 1, `+${fx.cells}格`);
        flyToLane(fx.horse - 1, fx.user, fx.avatar, '⚔️');
        if (level === 'full') {
          shockwave(fx.horse - 1, fx.color);
          giftBurst(fx.user, fx.avatar);
          coinRain(16); confetti(20);
        }
        break;
      case 'surge':
        popLane(fx.horse - 1, '💨 冲刺!');
        if (level === 'full') shake(500);
        break;
      case 'lead':
        // 领先易主：警报横幅 + 金闪（反超名场面）
        flash('gold');
        if (level === 'full') { shake(600); alertBanner(`⚡ ${fx.name} 反超登顶！`, fx.color); }
        break;
      case 'likeStorm':
        // 点赞风暴：全屏大拇指雨 + 强震（点赞欲的核心钩子）
        flash('white'); shake(800);
        bigFx('👍 点赞风暴！全场点起来', false);
        if (level === 'full') { stormLikes(30); shockwave(-1, 'var(--gold)'); }
        break;
      case 'photoFinish':
        // 鼻尖冲线：慢动作 + 白闪 + 获胜马放大金光
        slowmo();
        flash('white');
        if (level === 'full') {
          winnerZoom(fx.horse - 1, fx.color);
          confetti(30); coinRain(18);
        }
        bigFx(`📸 一鼻之差！${fx.name} 冲线`, false);
        break;
      case 'finish':
        flash('white'); shake(700);
        waveFlag();
        if (level === 'full') {
          launchFireworks('fireworks');
          confetti(50); coinRain(28);
          goldFall(26);
        }
        bigFx(`🏆 ${fx.name} 冲线！`, false);
        break;
      case 'jackpot':
        flash('gold'); shake(850);
        bigFx(`🔥 头奖滚存 ${fmt(fx.pool)}`, true);
        if (level === 'full') { confetti(64); coinRain(44); launchFireworks('fireworks'); shockwave(-1, 'var(--gold)'); }
        break;
      case 'bailout':
      case 'follow':
        if (level === 'full') toastFx(fx.user, fx.type === 'follow' ? `⭐ 关注 +${fmt(fx.amount)} 筹码` : `🆘 救济 +${fmt(fx.amount)}`);
        break;
      default: break;
    }
  }

  function flash(kind) {
    const el = $('flash');
    el.className = 'flash ' + kind;
    void el.offsetWidth;
    el.classList.add('on');
  }
  function shake(ms = 500) {
    const p = $('phone');
    p.classList.remove('shake');
    void p.offsetWidth;
    p.classList.add('shake');
    clearTimeout(shake._t);
    shake._t = setTimeout(() => p.classList.remove('shake'), ms);
  }
  /** 数字跳动（彩池金额变化时） */
  function bumpEl(el) {
    if (!el) return;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
  function bigFx(text, dark) {
    const box = $('bigFx');
    $('bigFxInner').textContent = text;
    box.classList.toggle('dark', !!dark);
    box.classList.remove('show');
    void box.offsetWidth;
    box.classList.add('show');
    setTimeout(() => box.classList.remove('show'), 2100);
  }
  function popLane(idx, text) {
    const lane = $('lane' + idx);
    if (!lane) return;
    const el = document.createElement('div');
    el.className = 'pop';
    el.textContent = text;
    el.style.left = '72%';
    el.style.top = '50%';
    lane.appendChild(el);
    setTimeout(() => el.remove(), 1000);
  }
  /** 头像从助威面板飞向目标泳道 */
  function flyToLane(idx, name, avatar, tag) {
    const layer = $('fxLayer');
    const lane = $('lane' + idx);
    const src = $('cheerPanel');
    if (!layer || !lane || !src) return;
    const pr = layer.getBoundingClientRect();
    const lr = lane.getBoundingClientRect();
    const sr = src.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'fx-fly';
    el.innerHTML = `${avatarHTML(name, avatar)}<span>${esc(tag || '')}</span>`;
    const sx = sr.left + 34 - pr.left;
    const sy = sr.top + 12 - pr.top;
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    el.style.setProperty('--tx', (lr.left + lr.width * 0.6 - pr.left - sx) + 'px');
    el.style.setProperty('--ty', (lr.top + lr.height / 2 - pr.top - sy) + 'px');
    layer.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }
  function coinRain(n) {
    const layer = $('fxLayer');
    if (!layer) return;
    const W = layer.clientWidth, H = layer.clientHeight;
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'fx-coin';
      el.textContent = ['🪙', '💰', '✨'][i % 3];
      el.style.left = (Math.random() * W) + 'px';
      el.style.fontSize = (14 + Math.random() * 14) + 'px';
      el.style.animationDuration = (1.3 + Math.random() * 1.1) + 's';
      el.style.animationDelay = (Math.random() * 0.6) + 's';
      el.style.setProperty('--h', H + 'px');
      layer.appendChild(el);
      setTimeout(() => el.remove(), 2800);
    }
  }
  function confetti(n) {
    const layer = $('fxLayer');
    if (!layer) return;
    const W = layer.clientWidth;
    const colors = DG.THEMES && document.documentElement.dataset.theme
      ? ['#ffc53d', '#ff5d5d', '#4da3ff', '#5dff9c', '#ff8ae2', '#fff3b0']
      : ['#ffc53d', '#ff5d5d', '#4da3ff', '#5dff9c', '#ff8ae2', '#fff3b0'];
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'fx-confetti';
      el.style.left = (Math.random() * W) + 'px';
      el.style.background = colors[(Math.random() * colors.length) | 0];
      el.style.animationDuration = (1.6 + Math.random() * 1.4) + 's';
      el.style.animationDelay = (Math.random() * 0.8) + 's';
      layer.appendChild(el);
      setTimeout(() => el.remove(), 3600);
    }
  }
  function toastFx(name, text) {
    const layer = $('fxLayer');
    if (!layer) return;
    const el = document.createElement('div');
    el.className = 'fx-fly';
    el.style.left = '14px';
    el.style.top = (layer.clientHeight * 0.42) + 'px';
    el.style.setProperty('--tx', '0px');
    el.style.setProperty('--ty', '-40px');
    el.innerHTML = `<span>${esc(name)} ${esc(text)}</span>`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  /* ═══════════════ 炸裂特效增强（点赞欲 · 送礼欲核心视觉钩子） ═══════════════ */

  /* 尘土粒子：奔跑中的马脚下扬起尘土（节流：每泳道 130ms 一粒） */
  const dustLast = [];
  function spawnDust(i, h) {
    const lane = $('lane' + i);
    if (!lane) return;
    const now = Date.now();
    if (now - (dustLast[i] || 0) < 130) return;
    dustLast[i] = now;
    const layer = $('fxLayer');
    if (!layer) return;
    const lr = lane.getBoundingClientRect();
    const pr = layer.getBoundingClientRect();
    const x = lr.left + (lr.width * (0.5 + 0.35 * (h.pos / 100))) - pr.left;
    const y = lr.top + lr.height * 0.78 - pr.top;
    const el = document.createElement('div');
    el.className = 'fx-dust';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    const s = 5 + Math.random() * 6;
    el.style.width = s + 'px';
    el.style.height = s + 'px';
    el.style.setProperty('--dx', (-18 - Math.random() * 14) + 'px');
    layer.appendChild(el);
    setTimeout(() => el.remove(), 650);
  }

  /* 火焰拖尾：冲刺中的马喷出火焰粒子 */
  const flameLast = [];
  function spawnFlame(i) {
    const lane = $('lane' + i);
    if (!lane) return;
    const now = Date.now();
    if (now - (flameLast[i] || 0) < 90) return;
    flameLast[i] = now;
    const layer = $('fxLayer');
    if (!layer) return;
    const lr = lane.getBoundingClientRect();
    const pr = layer.getBoundingClientRect();
    const run = $('run' + i);
    if (!run) return;
    const rr = run.getBoundingClientRect();
    const x = rr.right - 4 - pr.left + (Math.random() * 6 - 3);
    const y = lr.top + lr.height * 0.6 - pr.top;
    const el = document.createElement('div');
    el.className = 'fx-flame';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    const s = 8 + Math.random() * 10;
    el.style.width = s + 'px';
    el.style.height = s + 'px';
    el.style.background = ['#ff9f1a', '#ffd166', '#ff5d5d', '#ffb347'][(Math.random() * 4) | 0];
    layer.appendChild(el);
    setTimeout(() => el.remove(), 600);
  }

  /* 点赞风暴：全屏 ❤/👍 从四周汇聚 + 上升（多人点赞时触发） */
  function stormLikes(n) {
    const layer = $('fxLayer');
    if (!layer) return;
    const W = layer.clientWidth, H = layer.clientHeight;
    const emojis = ['👍', '❤️', '👍', '❤️', '🔥', '💪'];
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'fx-storm-like';
      el.textContent = emojis[(Math.random() * emojis.length) | 0];
      el.style.fontSize = (18 + Math.random() * 20) + 'px';
      const from = (Math.random() * 4) | 0; // 0上 1右 2下 3左
      const sx = from === 1 ? W + 20 : from === 3 ? -20 : Math.random() * W;
      const sy = from === 0 ? -20 : from === 2 ? H + 20 : Math.random() * H;
      const cx = W * (0.3 + Math.random() * 0.4);
      const cy = H * (0.2 + Math.random() * 0.3);
      el.style.left = sx + 'px';
      el.style.top = sy + 'px';
      el.style.setProperty('--cx', (cx - sx) + 'px');
      el.style.setProperty('--cy', (cy - sy) + 'px');
      el.style.setProperty('--rise', (-H * (0.25 + Math.random() * 0.4)) + 'px');
      el.style.animationDelay = (Math.random() * 0.25) + 's';
      layer.appendChild(el);
      setTimeout(() => el.remove(), 1900);
    }
  }

  /* 骑士冲锋冲击波：泳道中心扩散的金色圆环（idx=-1 时全屏） */
  function shockwave(idx, color) {
    const layer = $('fxLayer');
    if (!layer) return;
    const pr = layer.getBoundingClientRect();
    let x = pr.width / 2, y = pr.height / 2;
    if (idx >= 0) {
      const lane = $('lane' + idx);
      if (lane) {
        const lr = lane.getBoundingClientRect();
        x = lr.left + lr.width * 0.62 - pr.left;
        y = lr.top + lr.height / 2 - pr.top;
      }
    }
    for (let k = 0; k < 2; k++) {
      const el = document.createElement('div');
      el.className = 'fx-shockwave';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      if (color) el.style.borderColor = color;
      el.style.animationDelay = (k * 0.14) + 's';
      layer.appendChild(el);
      setTimeout(() => el.remove(), 900);
    }
  }

  /* 礼物爆炸：送礼者头像 + 礼物碎片四散 */
  function giftBurst(user, avatar) {
    const layer = $('fxLayer');
    if (!layer) return;
    const W = layer.clientWidth;
    const cx = W * 0.5, cy = layer.clientHeight * 0.3;
    const icons = ['🎁', '💎', '✨', '👑', '💰', '🎉'];
    for (let i = 0; i < 14; i++) {
      const el = document.createElement('div');
      el.className = 'fx-gift-burst';
      el.textContent = icons[(Math.random() * icons.length) | 0];
      el.style.left = cx + 'px';
      el.style.top = cy + 'px';
      el.style.fontSize = (14 + Math.random() * 14) + 'px';
      const a = Math.random() * Math.PI * 2;
      const d = 60 + Math.random() * 130;
      el.style.setProperty('--gx', Math.cos(a) * d + 'px');
      el.style.setProperty('--gy', Math.sin(a) * d + 'px');
      el.style.animationDelay = (Math.random() * 0.18) + 's';
      layer.appendChild(el);
      setTimeout(() => el.remove(), 1100);
    }
    if (user) toastFx(user, '🎁 骑士冲锋!');
  }

  /* 领先易主警报横幅：顶部滑入，反超名场面 */
  function alertBanner(text, color) {
    const layer = $('fxLayer');
    if (!layer) return;
    const el = document.createElement('div');
    el.className = 'fx-alert';
    el.innerHTML = `<i style="background:${esc(color || 'var(--gold)')}"></i>${esc(text)}<i style="background:${esc(color || 'var(--gold)')}"></i>`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  /* 获胜马放大金光（photoFinish 特写） */
  function winnerZoom(idx, color) {
    const run = $('run' + idx);
    if (!run) return;
    run.classList.remove('zoom');
    void run.offsetWidth;
    run.classList.add('zoom');
    run.style.setProperty('--wcolor', color || 'var(--gold)');
    setTimeout(() => run.classList.remove('zoom'), 2200);
  }

  /* 金色粒子瀑布（冲线/头奖时的奢华感） */
  function goldFall(n) {
    const layer = $('fxLayer');
    if (!layer) return;
    const W = layer.clientWidth, H = layer.clientHeight;
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'fx-gold';
      el.style.left = (Math.random() * W) + 'px';
      el.style.setProperty('--fh', H + 'px');
      el.style.animationDelay = (Math.random() * 0.8) + 's';
      el.style.animationDuration = (1.6 + Math.random() * 1.4) + 's';
      layer.appendChild(el);
      setTimeout(() => el.remove(), 3400);
    }
  }

  /* 终点旗挥舞（冲线后） */
  function waveFlag() {
    const track = $('raceTrack');
    if (!track) return;
    track.classList.remove('waving');
    void track.offsetWidth;
    track.classList.add('waving');
    clearTimeout(waveFlag._t);
    waveFlag._t = setTimeout(() => track.classList.remove('waving'), 2600);
  }

  /* ═══════════════ 结算横幅 ═══════════════ */
  function renderResult() {
    const res = state.result;
    const show = state.status === 'result' && res;
    $('resultBanner').classList.toggle('hidden', !show);
    if (!show) { resultKey = ''; return; }
    const key = `${res.roundNo}|${res.winnerIdx}`;
    if (key !== resultKey) {
      resultKey = key;
      $('resHorse').innerHTML = `${res.winner.no} 号 <span style="color:${esc(res.winner.color)}">${esc(res.winner.name)}</span> 获胜！`;
      $('resOdds').textContent = `最终赔率 ×${res.odds} · 彩池 ${fmt(res.pool)} 筹码`;
      const stat = [];
      if (res.jackpot) stat.push(`<b style="color:var(--gold)">无人押中 → 头奖滚存 ${fmt(res.carry)} 筹码</b>`);
      else stat.push(`押中 <b>${res.winnerCount}</b> 人 · 派彩 <b>${fmt(res.payout)}</b> 筹码`);
      if (res.boostCells > 0) stat.push(`点赞/礼物助力 <b>+${res.boostCells}</b> 格`);
      stat.push(`押中者 +${(state.cfg && state.cfg.honorScore) || 0} 荣誉分`);
      $('resStat').innerHTML = stat.join('<br>');
      $('resWinners').innerHTML = (res.winners || []).slice(0, 6).map(w => `
        <div class="wr">${avatarHTML(w.name, w.avatar)}<span class="wn">${esc(w.name)}</span><span class="wp">+${fmt(w.payout)}</span></div>`).join('')
        || (res.jackpot ? '<div class="wr"><span class="wn">全场无人押中</span></div>' : '');
      $('resReport').innerHTML = res.report ? `<span class="rp-tag">🎙️</span> ${esc(res.report)}` : '';
    }
    const next = $('resNext');
    if (state.cfg && state.cfg.autoLoop) {
      const sec = Math.max(0, Math.ceil((deadlineLocal - Date.now()) / 1000));
      next.textContent = `下一局 ${sec}s`;
    } else next.textContent = '等待主播开始';
  }

  /* ═══════════════ AI 播报条 ═══════════════ */
  function renderBcBar() {
    const bc = state.bc;
    if (!bc || !bc.seq || bc.seq === lastBcSeq) return;
    lastBcSeq = bc.seq;
    const bar = $('bcBar');
    $('bcText').textContent = bc.text || '';
    bar.classList.add('show');
    clearTimeout(bar._t);
    bar._t = setTimeout(() => bar.classList.remove('show'), 7000);
  }
})();
