/* ══════════════════════════════════════════════════════════════════
   stage.js — 谐音梗猜词 · 展示屏逻辑（games/xieyin/public）
   渲染双格谜题卡（OpenMoji 素材 + 代码绘制图层）、倒计时、获胜横幅、榜单
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, avatarHTML } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'xieyin';
  const ASSET = `/games/${GAME}/public/assets/openmoji`;
  let st = null;
  let lastWinnerKey = '';
  let lastRevealedRound = 0;

  DG.connectSSE(GAME, {
    onState: (_gid, s) => { st = s; render(); },
    onNotice: (_gid, n) => { if (n && n.text) DG.showToast(n.text); },
    onError: () => DG.showToast('与游戏服务断连，正在重试…'),
  });

  function render() {
    if (!st) return;
    $('xyPhone').style.display = '';
    $('xyBadge').textContent = `第 ${st.roundNo || 0} 关`;
    $('xyCat').textContent = st.cat || '--';
    tickCd();
    renderCard();
    renderBoards();
    renderReveal();
  }

  /* ───────────── 倒计时 ───────────── */
  function tickCd() {
    const playing = st.status === 'playing' || st.status === 'paused';
    let remain = 0;
    if (playing && st.deadline) remain = Math.max(0, st.deadline - Date.now());
    const sec = Math.ceil(remain / 1000);
    const isReveal = st.status === 'reveal';
    $('xyCdNum').textContent = isReveal ? '答案' : (st.status === 'playing' || st.status === 'paused' ? sec : '--');
    document.querySelector('.xy-cd-unit').style.visibility = isReveal ? 'hidden' : 'visible';
    const ratio = (st.status === 'playing' || st.status === 'paused') && st.answerSec
      ? Math.max(0, remain / 1000 / st.answerSec) : 0;
    $('xyProgFill').style.width = (ratio * 100).toFixed(1) + '%';
    $('xyProgFill').classList.toggle('urgent', sec <= 10 && sec > 0);
    if (playing) requestAnimationFrame(tickCd);
  }

  /* ───────────── 谜题卡渲染 ───────────── */
  function renderArt(el, panel) {
    el.innerHTML = '';
    el.classList.toggle('dark', !!panel.dark);
    if (!panel || !Array.isArray(panel.art)) return;
    for (const l of panel.art) {
      if (l.t === 'img' && l.img) {
        const img = document.createElement('img');
        img.className = 'xy-thing';
        img.src = `${ASSET}/${l.img}.svg`;
        img.alt = '';
        const stl = [`left:${l.x}px`, `top:${l.y}px`, `width:${l.w}px`];
        if (l.rot) stl.push(`transform:rotate(${l.rot}deg)`);
        if (l.flt === 'iron') stl.push('filter:grayscale(1) brightness(.82) contrast(1.3)');
        if (l.op !== undefined && l.op !== 1) stl.push(`opacity:${l.op}`);
        img.style.cssText = stl.join(';');
        el.appendChild(img);
      } else if (l.t === 'svg' && l.s) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 470 268');
        svg.classList.add('xy-fx');
        svg.innerHTML = l.s;
        el.appendChild(svg);
      }
    }
  }

  function renderCard() {
    const has = st.hasPuzzle && st.top && st.bot;
    $('xyCard').style.display = has ? '' : 'none';
    if (!has) return;
    renderArt($('xyTopArt'), st.top);
    $('xyTopCap').textContent = st.top.cap || '';
    renderArt($('xyBotArt'), st.bot);
    // 下格说明：未揭示 = 这是□□□（空格槽），揭示后 = 这是＋答案
    const botCap = $('xyBotCap');
    if (st.revealed) {
      botCap.textContent = '这是 ' + (st.answer || '');
      botCap.classList.add('revealed');
    } else {
      botCap.innerHTML = '这是 <span class="xy-slots">' +
        Array.from({ length: st.slots || 0 }, () => '<i></i>').join('') + '</span>';
      botCap.classList.remove('revealed');
    }
  }

  /* ───────────── 揭示 / 获胜横幅 ───────────── */
  function renderReveal() {
    const ansBox = $('xyAnswer');
    const winBox = $('xyWinner');
    const explBox = $('xyExpl');
    const show = st.revealed && !!st.answer;
    ansBox.style.display = show ? '' : 'none';
    if (show) {
      $('xyAnswerWord').textContent = st.answer;
      $('xyAnswerPy').textContent = st.py || '';
    }
    explBox.style.display = show && st.expl ? '' : 'none';
    if (show && st.expl) explBox.textContent = st.expl;

    const wk = st.winner ? `${st.roundNo}:${st.winner.name}` : '';
    if (st.winner && show) {
      winBox.style.display = '';
      winBox.innerHTML = `🎉 ${esc(st.winner.name)} 答对了！<b>+${st.winner.score}</b> 分`;
      if (wk !== lastWinnerKey) {
        lastWinnerKey = wk;
        DG.launchFireworks('xyFwBox');
      }
    } else if (show) {
      winBox.style.display = '';
      winBox.innerHTML = '没有人猜到～';
      lastWinnerKey = '';
    } else {
      winBox.style.display = 'none';
      lastWinnerKey = '';
    }
    // 揭示轮标记（防止重复放烟花）
    if (!show) lastRevealedRound = 0;
    else if (st.roundNo !== lastRevealedRound) lastRevealedRound = st.roundNo;
  }

  /* ───────────── 榜单 ───────────── */
  function boardRows(list, emptyText, rankBadge) {
    if (!list || !list.length) return `<div class="xy-empty">${emptyText}</div>`;
    return list.map((r, i) => {
      const medal = rankBadge && i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}`;
      return `<div class="xy-row">
        ${avatarHTML(r.name, r.avatar)}
        <span class="xy-row-name">${esc(r.name)}</span>
        <span class="xy-row-score">${rankBadge ? `${r.wins || 0}次 ` : ''}${r.score || 0}分</span>
        <span class="xy-rank">${medal}</span>
      </div>`;
    }).join('');
  }

  function renderBoards() {
    $('xyHeroes').innerHTML = boardRows(st.heroes, '等待第一位答对的观众', false);
    const lb = (st.leaderboard || []).slice(0, 50).map(r => ({
      name: r.name, avatar: r.avatar, score: r.totalScore ?? r.score ?? 0, wins: r.totalWins ?? r.wins ?? 0,
    }));
    // 总排行榜（统一组件：前三固定 + 第4~50名轮播）
    DG.mountLeaderboard($('xyBoard'), lb, { totalScore: r => r.score ?? r.totalScore ?? 0 });
  }
})();
