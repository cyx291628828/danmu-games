/* ══════════════════════════════════════════════════════════════════
   stage.js — 弹幕数独 · 展示屏逻辑（games/sudoku/public）
   9:16 竖屏投屏 / OBS 浏览器源；订阅本游戏 SSE 状态流
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, initialOf, connectSSE, launchFireworks } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'sudoku';
  let state = null;
  let winBannerTimer = null;
  let bannerShownAt = 0;       // 结算弹窗显示时刻（用于下一局倒计时）
  let winBannerShown = false;  // 上升沿检测，避免重复 SSE 推送重置倒计时
  let lastFinishedAt = 0;      // 已放过烟花的结算时间戳（去重）
  let lastRoundNo = -1;
  const cellCache = new Array(81).fill('');   // 每格渲染指纹，变化才重建（并触发弹跳动画）

  const BADGE = { like: '👍', gift: '🎁', follow: '⭐', hint: '💡', auto: '⚙️' };

  connectSSE(GAME, {
    onState: (_gid, st) => { state = st; renderAll(); },
    onGuess: (_gid, op) => { appendOp(op); flashFromOp(op); },
    onError: () => { $('cdTxt').textContent = '--'; },
  });

  /* ══════════════ 盘面 ══════════════ */
  const boardEl = $('board');
  const cellEls = [];
  (function buildBoard() {
    // 行列坐标标记（发「行×列×数」用）
    for (let k = 1; k <= 9; k++) {
      const c = document.createElement('span'); c.textContent = k; $('colLabels').appendChild(c);
      const r = document.createElement('span'); r.textContent = String.fromCharCode(64 + k); $('rowLabels').appendChild(r);
    }
    for (let i = 0; i < 81; i++) {
      const d = document.createElement('div');
      const br = Math.floor(i / 9), bc = i % 9;
      d.className = 'cell' + (((Math.floor(br / 3) + Math.floor(bc / 3)) % 2) ? ' alt' : '');
      d.innerHTML = '<span class="num"></span>';
      boardEl.appendChild(d);
      cellEls.push(d);
    }
  })();

  function renderBoard() {
    if (!state) return;
    boardEl.classList.toggle('corner-left', state.avatarCorner === 'left-top');
    const mask = state.mask || '';
    for (let i = 0; i < 81; i++) {
      const el = cellEls[i];
      const given = mask[i] === '1';
      const filled = (state.cells || []).find(c => c[0] === i) || null;
      // 指纹：given / 填入格的 值+来源+人，任一变化才重建该格
      const fp = given ? 'g' + (filled ? '' : '') : (filled ? `f${filled[1]}|${filled[2]}|${filled[3]}` : '');
      if (fp === cellCache[i]) continue;
      const changedToFill = fp && fp !== cellCache[i] && fp[0] === 'f';
      cellCache[i] = fp;
      const num = el.querySelector('.num');
      // 清掉动态节点（头像/徽章）
      el.querySelectorAll('.cav,.cbadge').forEach(n => n.remove());
      el.classList.remove('filled', 'given');
      if (given) {
        el.classList.add('given');
        num.textContent = (state.solution || '')[i] || '';
      } else if (filled) {
        el.classList.add('filled');
        num.textContent = filled[1];
        const [, , src, name, avatar] = filled;
        if (name) {
          const cav = document.createElement('span');
          cav.className = 'cav';
          if (avatar) {
            const img = document.createElement('img');
            img.src = avatar;
            img.referrerPolicy = 'no-referrer';
            img.onerror = () => { img.remove(); cav.textContent = initialOf(name); };
            cav.appendChild(img);
          } else {
            cav.textContent = initialOf(name);
          }
          el.appendChild(cav);
        }
        if (BADGE[src]) {
          const b = document.createElement('span');
          b.className = 'cbadge';
          b.textContent = BADGE[src];
          el.appendChild(b);
        }
        if (changedToFill) {
          el.classList.remove('pop');
          void el.offsetHeight;
          el.classList.add('pop');
          highlightDup(i);
        }
      } else {
        num.textContent = '';
      }
    }
  }

  /** 同数字联动高亮 1.1s */
  function highlightDup(idx) {
    const v = (state.cells || []).find(c => c[0] === idx);
    if (!v) return;
    const digit = v[1];
    cellEls.forEach((el, i) => {
      const fp = cellCache[i];
      const isGiven = (state.mask || '')[i] === '1';
      const numText = isGiven ? (state.solution || '')[i] : (fp && fp[0] === 'f' ? fp.slice(1, 2) : '');
      if (numText && numText === String(digit)) {
        el.classList.add('dup');
        setTimeout(() => el.classList.remove('dup'), 1100);
      }
    });
  }

  /** 实时操作事件 → 错填红闪 / 点赞充能条闪光 */
  function flashFromOp(op) {
    if (!op) return;
    if (op.type === 'wrong' && typeof op.idx === 'number') {
      const el = cellEls[op.idx];
      el.classList.remove('bad');
      void el.offsetHeight;
      el.classList.add('bad');
    }
    if (op.type === 'like') {
      const st = $('likeStat');
      st.classList.add('flash');
      setTimeout(() => st.classList.remove('flash'), 550);
    }
  }

  /* ══════════════ 顶部状态 ══════════════ */
  function renderTop() {
    $('stRound').textContent = `ROUND ${state.roundNo || 0} · ${(state.difficulty && state.difficulty.label) || '中等'}`;
    const cfg = state.cfg || {};
    $('howtoScore').textContent = '+' + (cfg.scorePerFill ?? 10);
    $('howtoLike').textContent = cfg.likeThreshold ?? 30;
    $('howtoGift').textContent = cfg.giftFillCount ?? 3;
    $('howtoFollow').textContent = cfg.followFillCount ?? 1;
    // 关注填格数配置为 0（关注不填格）时隐藏该段
    $('howtoFollowSeg').style.display = (cfg.followFillCount ?? 0) > 0 ? '' : 'none';
    $('howtoAuto').textContent = cfg.autoFillSec > 0 ? ` · 每 ${cfg.autoFillSec} 秒系统自动落 1 格 ⚙️` : '';
    $('likeN').textContent = cfg.likeThreshold ?? 30;

    // 填格进度 = 观众/系统实际填入格数 ÷ 空格总数（不含开局给定提示数 → 新局从 0% 最左开始）
    const holes = state.holes || 81;
    const doneCells = (state.cells || []).length;
    $('fillTxt').textContent = doneCells;
    $('fillTotal').textContent = holes;
    $('progFill').style.width = (holes ? doneCells / holes * 100 : 0).toFixed(1) + '%';

    // 点赞充能（单人）：当前累计最多的观众
    const top = state.likeTop;
    $('likerName').textContent = top ? top.name : '--';
    $('likeTxt').textContent = top ? top.likes : 0;
    const pct = top ? Math.min(100, top.likes / (cfg.likeThreshold || 30) * 100) : 0;
    $('likeFill').style.width = pct.toFixed(0) + '%';
    $('likeStat').classList.toggle('charged', pct >= 80);

    tickCountdown();
  }

  function tickCountdown() {
    const el = $('cdTxt');
    if (!state) return;
    if (state.status === 'playing' && state.deadline) {
      const s = Math.max(0, Math.floor((state.deadline - Date.now()) / 1000));
      el.textContent = fmtMMSS(s);
    } else if (state.status === 'paused') {
      // 展示服务端冻结的剩余时间，不随 Date.now() 继续走
      const remain = (state.pausedRemain || 0) > 0 ? state.pausedRemain : Math.max(0, (state.deadline || 0) - Date.now());
      el.textContent = fmtMMSS(Math.max(0, Math.ceil(remain / 1000)));
    } else if (state.status === 'result') {
      el.textContent = '0:00';
    } else {
      el.textContent = '--';
    }
  }
  function fmtMMSS(s) {
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  setInterval(tickCountdown, 1000);
  setInterval(tickResultCountdown, 250);

  /* 结算弹窗「下一局倒计时」胶囊：显示距下一局的剩余秒数（取代旧 win-ring 边框进度条） */
  function tickResultCountdown() {
    if (!state) return;
    const nx = $('winNext');
    if (!nx) return;
    if (state.status === 'result' && state.finishedInfo && bannerShownAt) {
      const resultSecs = (state.cfg && state.cfg.resultShowSec) || 12;
      const remain = Math.max(0, Math.ceil((resultSecs * 1000 - (Date.now() - bannerShownAt)) / 1000));
      nx.style.display = 'block';
      nx.textContent = `下一局 ${remain}s 后开始`;
    } else {
      nx.style.display = 'none';
    }
  }

  /* ══════════════ 操作记录流（左栏） ══════════════
     两条来源（SSE 实时 'guess' 事件 + state.ops 全量补显）可能重叠，
     用指纹集合去重，渲染幂等；新局清空。 */
  const opFps = new Set();
  function opFp(op) { return `${op.ts}|${op.type}|${op.idx ?? '-'}|${op.msg || ''}`; }
  function resetOps() { $('opStream').innerHTML = ''; opFps.clear(); }
  function opNode(op, withAnim) {
    const d = document.createElement('div');
    d.className = 'op' + (op.hot ? ' hot' : '') + (op.type === 'wrong' ? ' err' : '') + (withAnim ? ' enter' : '');
    const t = op.ts ? new Date(op.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    let body = '';
    if (op.type === 'start' || op.type === 'done') {
      body = esc(op.msg || '');
    } else if (op.type === 'wrong') {
      body = `❌ <span class="who">${esc(op.name)}</span> 填 <span class="pos">${esc(op.pos)}=${esc(op.val)}</span> ${esc(op.msg || '填错，已忽略')}`;
    } else {
      const icon = { dm: '✍️', like: '👍', gift: '🎁', follow: '⭐', hint: '💡', auto: '⚙️' }[op.type] || '';
      const who = op.name ? `<span class="who">${esc(op.name)}</span>` : '';
      const msg = op.msg ? ` ${esc(op.msg)}` : '';
      const pos = op.pos ? ` <span class="pos">${esc(op.pos)}=${esc(op.val)}</span>` : '';
      const sc = op.score ? ` <b>+${op.score}</b>` : '';
      body = `${icon} ${who}${msg}${pos}${sc}`;
    }
    d.innerHTML = `<span class="t">${esc(t)}</span><span>${body}</span>`;
    return d;
  }
  function renderOps() {
    if (state.roundNo !== lastRoundNo) {
      lastRoundNo = state.roundNo;
      resetOps();
    }
    const box = $('opStream');
    // 新日志在上方：补显时按新→旧渲染
    [...state.ops].reverse().forEach(op => {
      const fp = opFp(op);
      if (opFps.has(fp)) return;
      opFps.add(fp);
      box.appendChild(opNode(op, false));
    });
    while (box.children.length > 40) box.removeChild(box.lastChild);
  }
  function appendOp(op) {
    const fp = opFp(op);
    if (opFps.has(fp)) return;
    opFps.add(fp);
    const box = $('opStream');
    box.prepend(opNode(op, true));
    while (box.children.length > 40) box.removeChild(box.lastChild);
  }

  /* ══════════════ 排行榜（右栏，数独专属：按 MVP 次数排序，仅显示 MVP 次数列；
     积分不展示，但服务端照常记录，并作为同 MVP 次数时的排序依据） ══════════════ */
  let lbFingerprint = '';
  function renderBoardList() {
    const box = $('boardBody');
    const list = state.sudokuBoard || [];
    const fp = list.map(r => `${r.rank}|${r.name}|${r.mvp}|${r.score}`).join(',');
    if (fp === lbFingerprint) return;
    lbFingerprint = fp;
    const head = '<div class="lb-th"><span class="rk">名次</span><span class="nm">玩家</span><span class="mv">MVP</span></div>';
    if (!list.length) {
      box.innerHTML = head + '<div class="lb-empty">暂无榜单数据</div>';
      return;
    }
    box.innerHTML = head + list.map((r, i) =>
      `<div class="lb-row${i < 3 ? ' r' + (i + 1) : ''}">
        <span class="rk">${r.rank || (i + 1)}</span>
        ${DG.avatarHTML(r.name, r.avatar)}
        <span class="nm">${esc(r.name)}</span>
        <span class="mv">${r.mvp > 0 ? '👑' + r.mvp : '—'}</span>
      </div>`).join('');
  }

  /* ══════════════ 结算横幅（本局 Top5：MVP + 每人填对/错填数） ══════════════ */
  function renderWinBanner() {
    const banner = $('winBanner');
    const panel = banner.querySelector('.result-panel');
    if (state.status === 'result' && state.finishedInfo) {
      const fi = state.finishedInfo;
      const st = state.roundStats || {};
      // 「自动 X」是否显示由配置的自动填数秒数驱动：-1 = 不显示；其余（含 0=关闭）都显示，与是否通关无关
      const showAuto = (state.cfg && state.cfg.autoFillSec != null) ? state.cfg.autoFillSec >= 0 : true;
      const autoPart = showAuto ? ` · 自动 ${st.auto || 0}` : '';
      const statLine = `用时 ${fmtMMSS(fi.durationSec)} · 弹幕 ${st.dm || 0} · 点赞 ${st.like || 0} · 礼物 ${st.gift || 0} · 关注 ${st.follow || 0}${autoPart}`;
      // ── 领奖台结算面板：顶缘居中👑头像向上突出 + 第一名行左侧头像，第 2/3 名一排（带名次），第 4/5/6 名一排（仅名字对错分）──
      // 每人展示：正确数 / 错误数 / 总积分；MVP 额外 +mvpBonus（默认 50）
      const board = fi.top5 || [];
      const bonus = (state.cfg && state.cfg.mvpBonus) || 0;
      const mvpActive = fi.complete && !!fi.mvp;

      const mini = (t, rank, withAvatar) => t ? `
        <div class="p-card">
          ${withAvatar ? `<span class="p-av-sm r${rank}">${DG.avatarHTML(t.name, t.avatar)}</span>` : ''}
          <div class="p-col">
            <div class="p-name-sm">${esc(t.name)}</div>
            <div class="p-stats-sm"><b class="ok">对${t.cnt}</b><b class="bad">错${t.wrong || 0}</b><b class="pt">${t.score}分</b></div>
          </div>
        </div>` : '<div class="p-card ghost">虚位以待</div>';

      // 顶缘居中、向上突出的冠军头像（皇冠随通关 MVP 显示，无观众时隐藏）
      const topAv = $('winTopAv');
      if (board.length) {
        const [top1] = board;
        topAv.style.display = '';
        panel.classList.add('has-top-av');
        topAv.innerHTML = `${mvpActive ? '<span class="p-crown">👑</span>' : ''}<span class="p-top-av-in">${
          top1.avatar
            ? `<img src="${esc(top1.avatar)}" referrerpolicy="no-referrer" onerror="this.remove();this.parentNode.textContent='${esc(initialOf(top1.name))}'">`
            : esc(initialOf(top1.name))
        }</span>`;
      } else {
        topAv.style.display = 'none';
        panel.classList.remove('has-top-av');
      }

      let podium;
      if (!board.length) {
        podium = '<div class="wt-empty">本局无观众参与填格</div>';
      } else {
        const [p1, second, third, ...others] = board;
        podium = `
          <div class="p-card p1">
            <span class="p-av-wrap">${DG.avatarHTML(p1.name, p1.avatar)}</span>
            <div class="p-col">
              <div class="p-name"><span class="p-nm">${esc(p1.name)}</span>${mvpActive ? `<span class="p-bonus">MVP +${bonus}</span>` : '<span class="p-tag">本局第一</span>'}</div>
              <div class="p-stats">
                <span class="ok">正确 ${p1.cnt}</span>
                <span class="bad">错误 ${p1.wrong || 0}</span>
                <span class="pt">总分 ${p1.score + (mvpActive ? bonus : 0)}</span>
              </div>
            </div>
          </div>
          <div class="p-row">${mini(second, 2, true)}${mini(third, 3, true)}</div>
          <div class="p-row">${mini(others[0], 4, false)}${mini(others[1], 5, false)}${mini(others[2], 6, false)}</div>`;
      }
      $('winPodium').innerHTML = podium;

      if (fi.complete) {
        $('winTitle').textContent = '数 独 完 成';
        panel.style.borderColor = 'var(--gold)';
        $('winTitle').style.color = 'var(--gold)';
        panel.classList.add('is-win');
        if (state.finishedAt !== lastFinishedAt) {
          lastFinishedAt = state.finishedAt;
          launchFireworks('fireworks');
        }
      } else {
        $('winTitle').textContent = '本 局 结 束';
        panel.style.borderColor = 'var(--accent)';
        $('winTitle').style.color = 'var(--accent)';
        panel.classList.remove('is-win');
      }
      $('winSub').textContent = statLine;
      banner.classList.remove('hidden');
      clearTimeout(winBannerTimer);
      const resultSecs = (state.cfg && state.cfg.resultShowSec) || 12;
      winBannerTimer = setTimeout(() => banner.classList.add('hidden'), resultSecs * 1000);
      if (!winBannerShown) { winBannerShown = true; bannerShownAt = Date.now(); }   // 仅上升沿启动倒计时，避免重复 SSE 推送重置
    } else {
      banner.classList.add('hidden');
      winBannerShown = false;
      bannerShownAt = 0;
      $('winNext') && ($('winNext').style.display = 'none');
    }
  }

  /* ══════════════ 总渲染 ══════════════ */
  function renderAll() {
    if (!state) return;
    // 新局：盘面渲染缓存失效。必须用哨兵值（\0）填充而非空串 —— 空格子的渲染指纹恰为 ''
    // 若清成 ''，新局空格会因 fp === cellCache[i] 被跳过重绘，旧局的数字/徽章原样残留
    if (state.roundNo !== lastRoundNo) cellCache.fill('\0');
    renderTop();
    renderBoard();
    renderOps();
    renderBoardList();
    renderWinBanner();
  }
})();
