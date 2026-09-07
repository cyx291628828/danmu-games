/* ══════════════════════════════════════════════════════════════════
   stage.js — 红蓝大作战 · 展示屏逻辑（games/redblue/public）
   9:16 竖屏投屏 / OBS 浏览器源；订阅本游戏 SSE 状态流
   战场（拔河绳/守城战/能量条/特效）由 Canvas 渲染（stage-scene.js），
   本文件只负责：面板 DOM / 倒计时 / 战报流 / 榜单 / 结算横幅。
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, connectSSE, launchFireworks } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'redblue';
  // 调试/预览：URL 带 ?fxslow 时全部横幅特效放慢 5 倍（如 stage.html?game=redblue&fxslow）
  const FXSLOW = new URLSearchParams(location.search).has('fxslow');
  if (FXSLOW) document.documentElement.style.setProperty('--fxmul', '5');
  let state = null;
  let lastRevealedAt = 0;
  let bannerTimer = null;
  let bannerShownAt = 0;       // 结算弹窗显示时刻（用于下一局倒计时）
  let bannerShown = false;     // 上升沿检测，避免重复 SSE 推送重置倒计时
  const seenFeed = new Set();   // 已渲染的战报 id（guess 增量 + state 全量去重）

  // ── Canvas 战场（场景差分特效 + 全屏横幅回调都在这里） ──
  const scene = new RBCanvas($('battleCanvas'), {
    onBanner: (text, cls) => showBanner(text, cls),
  });
  window.__rbScene = scene;   // 调试挂载（浏览器控制台可观察战线插值/特效参数）

  connectSSE(GAME, {
    onState: (_gid, st) => { state = st; scene.setState(st); renderAll(); },
    onGuess: (_gid, g) => {
      if (g && g.kind === 'scene') { scene.onSceneEvent(g); return; }   // 枪战小事件：直接交付特效
      if (g && g.kind === 'feed') appendFeed(g);
    },
    onError: () => { const c = $('cdNum'); if (c) c.textContent = '--'; },
  });

  function renderAll() {
    if (!state) return;
    renderHeader();
    renderCountdown();
    renderBattle();
    renderFeedInitial();
    renderBoards();
    renderResultBanner();
  }

  /* 首帧 / 断线重连后整盒重建战报流（最新置顶；增量条目走 onGuess → appendFeed） */
  function renderFeedInitial() {
    const box = $('feed');
    const list = (state && state.feed) || [];
    if (!list.length) { box.innerHTML = '<div class="item empty">战报待发射… 发 红 / 蓝 加入阵营！</div>'; return; }
    const newest = list[list.length - 1].id;
    const firstEl = box.querySelector('.item');
    if (!firstEl || firstEl.dataset.id !== newest) {
      box.innerHTML = list.slice(-FEED_SHOW).reverse().map(feedHTML).join('');
      list.forEach(f => seenFeed.add(f.id));
    }
  }

  /* ── 顶栏：局数 / 总比分 / 连胜 / 赛季 ── */
  function renderHeader() {
    $('stRound').textContent = `ROUND ${state.roundNo || 0}`;
    $('scoreRed').textContent = `红 ${state.series?.red || 0}`;
    $('scoreBlue').textContent = `${state.series?.blue || 0} 蓝`;
    if (state.season) $('seasonBadge').textContent = `S${state.season.seasonNo} 赛季`;
  }

  /* ── 倒计时 / 阶段 ── */
  function renderCountdown() {
    const cd = $('cdNum'), unit = $('cdUnit'), tag = $('phaseTag'), fill = $('cdProgFill');
    const total = state.status === 'joining' ? state.joinSec : state.tugSec;
    const isSiege = state.mode === 'siege';
    if (state.status === 'joining') {
      tag.textContent = isSiege ? '守城集结 · 发 红/蓝 入队' : '组队期 · 发 红/蓝 入队';
      tag.classList.remove('tug');
    } else if (state.status === 'tugging') {
      tag.textContent = '对抗期';
      tag.classList.add('tug');
    } else if (state.status === 'sieging' || state.status === 'shooting') {
      tag.textContent = state.status === 'sieging' ? '守城战 · 全体输出！' : (state.mode === 'shooterBoss' ? 'BOSS 战 · 双方合力射击！' : '枪战 · 血量对决！');
      tag.classList.add('tug');
    } else if (state.status === 'revealed') {
      tag.textContent = '本局结算';
      tag.classList.remove('tug');
    } else if (state.status === 'paused') {
      tag.textContent = '已暂停';
      tag.classList.remove('tug');
    } else {
      tag.textContent = '等待开局';
      tag.classList.remove('tug');
    }
    tickCountdown();
    updateCdProgress();
  }

  /** 倒计时进度条（本地每 500ms 刷新，不依赖 SSE 推送） */
  function updateCdProgress() {
    const fill = $('cdProgFill');
    if (!fill || !state) return;
    const total = state.status === 'joining' ? state.joinSec : state.tugSec;
    let pct = 0;
    if (['joining', 'tugging', 'sieging'].includes(state.status) && state.deadline) {
      const start = state.deadline - total * 1000;
      pct = Math.min(1, Math.max(0, (Date.now() - start) / (total * 1000)));
    } else if (state.status === 'revealed') pct = 1;
    fill.style.width = (pct * 100).toFixed(1) + '%';
  }

  function tickCountdown() {
    if (!state) return;
    const cd = $('cdNum'), unit = $('cdUnit');
    if (state.status === 'joining' || state.status === 'tugging' || state.status === 'sieging') {
      const s = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
      cd.textContent = s; unit.textContent = '秒';
      cd.style.color = s <= 10 && state.status !== 'joining' ? 'var(--red)' : '';
    } else if (state.status === 'revealed') { cd.textContent = '0'; unit.textContent = '秒'; }
    else { cd.textContent = '--'; unit.textContent = ''; }
  }
  // 本地心跳：倒计时数字 + 进度条自动走，无需等 SSE
  setInterval(() => { if (state) { tickCountdown(); updateCdProgress(); } }, 500);

  /* 结算弹窗「下一局倒计时」胶囊：显示距下一局的剩余秒数 */
  function tickResultCountdown() {
    if (!state) return;
    const nx = $('resultNext');
    if (!nx) return;
    if (state.status === 'revealed' && state.result && bannerShownAt) {
      const resultSecs = state.resultShowSec || 12;
      const remain = Math.max(0, Math.ceil((resultSecs * 1000 - (Date.now() - bannerShownAt)) / 1000));
      nx.style.display = 'block';
      nx.textContent = `下一局 ${remain}s 后开始`;
    } else {
      nx.style.display = 'none';
    }
  }
  setInterval(tickResultCountdown, 250);

  /* ── 面板：阵营卡 / 战线读数 / 玩法提示（战场主体在 Canvas） ── */
  function renderBattle() {
    const isSiege = state.mode === 'siege';
    const isShoot = state.mode === 'shooter' || state.mode === 'shooterBoss';
    const isBoss = state.mode === 'shooterBoss';
    const r = state.red || {}, b = state.blue || {};
    $('campNameRed').textContent = `🔥 ${r.name || '红队'}`;
    $('campNameBlue').textContent = `${b.name || '蓝队'} 🌊`;
    $('cntRed').textContent = r.count || 0;
    $('cntBlue').textContent = b.count || 0;
    renderAvatars($('avsRed'), r.top, r.count);
    renderAvatars($('avsBlue'), b.top, b.count);

    // 枪战轮：隐藏战线读数（胜负以血量条表达，在 Canvas 内）
    const meta = document.querySelector('.rope-meta');
    if (meta) meta.style.display = isShoot ? 'none' : '';
    if (!isShoot) {
      $('metaNameRed').textContent = r.name || '红方底线';
      $('metaNameBlue').textContent = b.name || '蓝方底线';
      const pos = Number(state.pos) || 50;
      const lead = pos >= 50 ? '红' : '蓝';
      $('posTxt').textContent = `战线 ${lead} ${Math.round(Math.abs(pos - 50) * 2)}%`;
    }

    $('howto').innerHTML = isShoot
      ? (isBoss
        ? `双方合力射击 <b>BOSS</b> · 发弹幕=开火 · 点赞=<b>加速</b> · 送礼=<b>强力弹</b> · 击破Boss全员胜利！`
        : `发弹幕=<b>发射子弹</b> · 点赞=<b>子弹加速</b> · 送礼=<b>强力子弹</b> · 血量先清零者输`)
      : isSiege
        ? `全体守军任意弹幕<b>攻击</b> ${esc((state.monster && state.monster.name) || '怪物')} · 点赞充能<b>全力一击</b> · 守住城墙！`
        : `弹幕发 <b class="ht-r">红</b> / <b class="ht-b">蓝</b> 加入阵营并推动战线 · 点赞为队伍<b>充能</b> · 能量满触发<b>全军冲锋</b>`;
  }

  function renderAvatars(box, top, count) {
    if (!box) return;
    const avas = (top || []).slice(0, 4);
    box.innerHTML = avas.map(m => DG.avatarHTML(m.name, m.avatar)).join('')
      + (count > 4 ? `<span class="av-more">+${count - 4}</span>` : '');
  }

  /* ── 战报流（最新置顶；state.feed 全量 + guess 增量，按 id 去重） ── */
  const FEED_SHOW = 7; // 可视高度内条数
  function feedHTML(f) {
    const text = String(f.text || '')
      .replace(/红队|红/g, '<span class="t-red">红</span>')
      .replace(/蓝队|蓝/g, '<span class="t-blue">蓝</span>');
    return `<div class="item${f.hot ? ' hot' : ''}" data-id="${esc(f.id)}"><span>${esc(f.icon || '·')}</span><span>${text}</span></div>`;
  }

  function appendFeed(f) {
    if (!f || !f.id || seenFeed.has(f.id)) return;
    seenFeed.add(f.id);
    const box = $('feed');
    const empty = box.querySelector('.empty');
    if (empty) empty.remove();
    box.insertAdjacentHTML('afterbegin', feedHTML(f)); // 新消息插到最上面
    while (box.children.length > FEED_SHOW) box.removeChild(box.lastChild);
  }

  /* ── 全屏横幅（冲锋/全力一击；DOM 样式横幅，特效在 Canvas） ── */
  function showBanner(text, cls) {
    const b = $('surgeBanner');
    if (!b) return;
    b.innerHTML = `<div class="txt">${esc(text)}</div>`;
    b.className = `surge-banner show ${cls}`;
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.className = 'surge-banner'; b.innerHTML = ''; }, 1700 * (FXSLOW ? 5 : 1));
  }

  /* ── 双榜单 ── */
  let contribFp = '', lbFingerprint = '', seasonFingerprint = '';
  function renderBoards() {
    // 本轮贡献 Top5（红蓝合并，按 贡献值 排序）
    const list = [
      ...((state.red && state.red.top) || []).map(t => ({ ...t, team: 'red' })),
      ...((state.blue && state.blue.top) || []).map(t => ({ ...t, team: 'blue' })),
    ].sort((a, b) => (b.pulls + b.likes) - (a.pulls + a.likes)).slice(0, 5);
    const fp = list.map(t => `${t.name}|${t.pulls}|${t.likes}`).join(',');
    if (fp !== contribFp) {
      contribFp = fp;
      const box = $('contribBody');
      box.innerHTML = list.length ? list.map((t, i) => `
        <div class="lb-row${i < 3 ? ' r' + (i + 1) : ''}">
          <span class="rk">${i + 1}</span>
          ${DG.avatarHTML(t.name, t.avatar)}
          <span class="nm">${esc(t.name)}</span>
          <span class="sub">拉${t.pulls}·赞${t.likes}</span>
          <span class="sc">${t.pulls + t.likes}</span>
        </div>`).join('') : '<div class="lb-empty">暂无贡献</div>';
    }
    // 总排行榜
    const lb = state.leaderboard || [];
    const lfp = lb.map(r => `${r.rank}|${r.name}|${r.totalScore || 0}`).join(',');
    if (lfp !== lbFingerprint) {
      lbFingerprint = lfp;
      const box = $('boardBody');
      box.innerHTML = lb.length ? lb.slice(0, 5).map((r, i) => `
        <div class="lb-row${i < 3 ? ' r' + (i + 1) : ''}">
          <span class="rk">${r.rank || i + 1}</span>
          ${DG.avatarHTML(r.name, r.avatar)}
          <span class="nm">${esc(r.name)}</span>
          <span class="sc">${r.totalScore || 0}</span>
        </div>`).join('') : '<div class="lb-empty">暂无榜单数据</div>';
    }
    // 赛季功勋榜（跨场次阵营功勋）
    const season = state.season;
    if (season) {
      const sfp = `${season.seasonNo}|${(season.top || []).map(m => `${m.name}|${m.score}|${m.wins}`).join(',')}`;
      if (sfp !== seasonFingerprint) {
        seasonFingerprint = sfp;
        $('seasonTitle').textContent = `S${season.seasonNo} 赛季功勋`;
        const box = $('seasonBody');
        box.innerHTML = (season.top && season.top.length) ? season.top.slice(0, 5).map((m, i) => `
          <div class="lb-row${i < 3 ? ' r' + (i + 1) : ''}">
            <span class="rk">${i + 1}</span>
            ${DG.avatarHTML(m.name, m.avatar)}
            <span class="nm">${m.team === 'red' ? '🔥' : '🌊'}${esc(m.name)}</span>
            <span class="sub">胜${m.wins}</span>
            <span class="sc">${m.score}</span>
          </div>`).join('') : '<div class="lb-empty">虚位以待，发 红/蓝 入伍！</div>';
      }
    }
  }

  /* ── 结算横幅 + 烟花 ── */
  function renderResultBanner() {
    const banner = $('resultBanner');
    if (state.status === 'revealed' && state.result) {
      const r = state.result;
      const winEl = $('resultWin');
      if (r.mode === 'siege') {
        winEl.textContent = r.success
          ? `🎉 守城成功！${r.monster.name} 被击退！`
          : `💀 守城失败…${r.monster.name} 逃走了`;
        winEl.className = `result-win ${r.success ? 'w-blue' : 'w-draw'}`;
        $('resultMvp').textContent = (r.mvp && r.mvp.length)
          ? `MVP：${r.mvp.map(m => `${m.name}(输出${m.contrib} +${m.bonus})`).join(' · ')}`
          : (r.success ? '本局无 MVP（输出不足）' : '');
        $('resultStat').innerHTML = r.success
          ? `全体参战守军 ${r.fighters} 人 +${r.winScore} 分<br>怪物剩余血量 ${r.monster.hpLeft}/${r.monster.hpMax}`
          : `城墙耐久 ${r.wall.hpLeft}/${r.wall.hpMax} · 怪物剩余 ${r.monster.hpLeft}/${r.monster.hpMax}<br>全体参战安慰 +${r.loseScore} 分`;
      } else if (r.mode === 'shooterBoss') {
        winEl.textContent = r.success
          ? `🎉 BOSS「${r.boss.name}」被击破！全员胜利！`
          : `💀 基地墙被 BOSS 攻破…`;
        winEl.className = `result-win ${r.success ? 'w-blue' : 'w-draw'}`;
        $('resultMvp').textContent = (r.mvp && r.mvp.length)
          ? `MVP：${r.mvp.map(m => `${m.name}(输出${m.contrib} +${m.bonus})`).join(' · ')}`
          : (r.success ? '本局无 MVP（输出不足）' : '');
        $('resultStat').innerHTML = r.success
          ? `全体参战 ${r.fighters} 人 各 +${r.winScore} 分<br>Boss 剩余血量 ${r.boss.hpLeft}/${r.boss.hpMax}`
          : `基地墙耐久 ${r.wall.hpLeft}/${r.wall.hpMax}<br>全员安慰 +${r.loseScore} 分`;
      } else if (r.mode === 'shooter') {
        const winnerTeam = r.winner === 'red' ? state.red : (r.winner === 'blue' ? state.blue : null);
        winEl.textContent = winnerTeam
          ? `${r.winner === 'red' ? '🔥' : '🌊'} ${winnerTeam.name} 获胜！${r.streak && r.streak.n > 1 ? ` 连胜 ×${r.streak.n}` : ''}`
          : '势均力敌 · 平局！';
        winEl.className = `result-win ${r.winner === 'red' ? 'w-red' : r.winner === 'blue' ? 'w-blue' : 'w-draw'}`;
        $('resultMvp').textContent = (r.mvp && r.mvp.length)
          ? `MVP：${r.mvp.map(m => `${m.name}(输出${m.contrib} +${m.bonus})`).join(' · ')}`
          : '本局无 MVP（输出不足）';
        $('resultStat').innerHTML = `红队 HP ${r.redHp} : ${r.blueHp} 蓝队<br>胜方全员 +${r.winScore} 分 · 参与奖 +${r.loseScore} 分`;
      } else if (r.draw) {
        winEl.textContent = '势均力敌 · 平局！';
        winEl.className = 'result-win w-draw';
        $('resultMvp').textContent = '';
        $('resultStat').innerHTML = `双方各得参与奖 +${r.loseScore} 分`;
      } else {
        const t = r.winner === 'red' ? state.red : state.blue;
        winEl.textContent = `${r.winner === 'red' ? '🔥' : '🌊'} ${t.name} 获胜！${r.streak && r.streak.n > 1 ? ` 连胜 ×${r.streak.n}` : ''}`;
        winEl.className = `result-win ${r.winner === 'red' ? 'w-red' : 'w-blue'}`;
        $('resultMvp').textContent = (r.mvp && r.mvp.length)
          ? `MVP：${r.mvp.map(m => `${m.name}(贡献${m.contrib} +${m.bonus})`).join(' · ')}`
          : '本局无 MVP（贡献不足）';
        $('resultStat').innerHTML = `${r.winner === 'red' ? state.blue.name : state.red.name} 全员参与奖 +${r.loseScore} 分<br>胜方全员 +${r.winScore} 分 · 战线 ${r.pos}%`;
      }
      $('resultReport').innerHTML = r.report || '';
      banner.classList.remove('hidden');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => banner.classList.add('hidden'), (state.resultShowSec || 12) * 1000);
      if (!bannerShown) { bannerShown = true; bannerShownAt = Date.now(); }   // 仅上升沿启动倒计时，避免重复 SSE 推送重置

      const celebrate = r.mode === 'siege' ? r.success : !r.draw;
      if (celebrate && r.revealedAt && r.revealedAt !== lastRevealedAt) {
        lastRevealedAt = r.revealedAt;
        launchFireworks('fireworks');
      }
    } else {
      banner.classList.add('hidden');
      bannerShown = false;
      bannerShownAt = 0;
      const nx = $('resultNext');
      if (nx) nx.style.display = 'none';
    }
  }
})();