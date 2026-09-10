/* ══════════════════════════════════════════════════════════════════
   stage.js — 猜数字 · 展示屏逻辑（games/guess/public）
   9:16 竖屏投屏 / OBS 浏览器源；订阅本游戏 SSE 状态流
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, initialOf, connectSSE, launchFireworks } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'guess';
  let state = null;
  let winBannerTimer = null;
  let bannerShownAt = 0;       // 结算弹窗显示时刻（用于下一局倒计时）
  let winBannerShown = false;  // 上升沿检测，避免重复 SSE 推送重置倒计时
  let lastRevealedAt = 0;     // 已触发过烟花的揭晓时间戳（去重）

  connectSSE(GAME, {
    onState: (_gid, st) => { state = st; renderAll(); },
    onGuess: (_gid, g) => appendStageGuess(g),
    onError: () => { if ($('cdNum')) $('cdNum').textContent = '--'; },
  });

  function renderAll() {
    if (!state) return;
    renderStage();
  }

  /* ══════════════ 展示屏渲染 ══════════════ */
  function renderStage() {
    $('stRound').textContent = `ROUND ${state.roundNo || 0}`;

    // 玩法说明的位数与示例数字跟随 cfg.digitCount
    const dg = (state.cfg && state.cfg.digitCount === 3) ? 3 : 4;
    const digitEl = $('howtoDigits');
    if (digitEl) digitEl.textContent = String(dg);
    const example = '1234'.slice(0, dg);
    const bEls = document.querySelectorAll('.howto-line .howto-b');
    if (bEls.length >= 2) {
      bEls[0].textContent = example;
      bEls[1].textContent = '猜' + example;
    }

    const cd = $('cdNum');
    if (state.status === 'gambling') {
      tickCountdown();
    } else if (state.status === 'revealed') {
      cd.textContent = '0';
    } else {
      cd.textContent = '--';
    }

    renderCells();
    renderClues();
    renderCdProgress();
    renderGuessStream();
    renderBoardIfChanged();
    renderWinBanner();
  }

  let lbFingerprint = '';   // leaderboard 指纹，变化才重绘（避免每次 SSE 推送整体重建导致跳动）
  function renderBoardIfChanged() {
    const list = state.leaderboard || [];
    // 指纹只取实际展示的列（名次/玩家/得分），避免隐藏列变动触发无意义重绘
    const fp = list.map(r => `${r.rank}|${r.name}|${r.totalScore != null ? r.totalScore : ((r.guess_score || 0) + (r.chengyu_score || 0))}`).join(',');
    const changed = fp !== lbFingerprint;
    if (changed) {
      lbFingerprint = fp;
      renderBoard(true);   // 数据真变化 → 带动画
    }
  }

  function tickCountdown() {
    if (!state || state.status !== 'gambling') return;
    const s = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    $('cdNum').textContent = s;
    updateCdFill();
  }
  setInterval(() => { tickCountdown(); tickClueCountdowns(); tickResultCountdown(); }, 1000);

  /* 结算弹窗「下一局倒计时」胶囊：显示距下一局的剩余秒数（取代旧 win-ring 边框进度条） */
  function tickResultCountdown() {
    if (!state) return;
    const nx = $('winNext');
    if (!nx) return;
    if (state.status === 'revealed' && bannerShownAt) {
      const resultSecs = (state.cfg && state.cfg.resultShowSec) || 10;
      const remain = Math.max(0, Math.ceil((resultSecs * 1000 - (Date.now() - bannerShownAt)) / 1000));
      nx.style.display = 'block';
      nx.textContent = `下一局 ${remain}s 后开始`;
    } else {
      nx.style.display = 'none';
    }
  }

  /* 时间进度条：底色填充本轮已过时间；分段标记 = 每位数字出现时间 */
  function renderCdProgress() {
    updateCdFill();
    renderCdMarks();
  }
  function updateCdFill() {
    const fill = $('cdProgFill');
    if (!fill) return;
    const total = (state.cfg && state.cfg.roundIntervalSec) || 120;
    let pct = 0;
    if (state.status === 'gambling' && state.deadline) {
      const start = state.deadline - total * 1000;
      pct = Math.min(1, Math.max(0, (Date.now() - start) / (total * 1000)));
    } else if (state.status === 'revealed') {
      pct = 1;
    }
    fill.style.width = (pct * 100).toFixed(1) + '%';
  }
  function renderCdMarks() {
    const box = $('cdProgMarks');
    const lblBox = $('cdProgLabels');
    if (!box || !lblBox) return;
    box.innerHTML = '';
    lblBox.innerHTML = '';
    const total = (state.cfg && state.cfg.roundIntervalSec) || 120;
    const secs = (state.cfg && state.cfg.answerRevealSec) || [];
    secs.forEach((sec, i) => {
      if (sec == null || sec < 0) return; // -1/缺失：该位永不自动出现，不画分段
      const pct = Math.min(100, Math.max(0, sec / total * 100));
      const done = state.status === 'revealed' || (state.revealedMask & (1 << i));
      const gold = state.status === 'gambling' && !done;
      // 轨道内竖刻度
      const mark = document.createElement('div');
      mark.className = 'cd-progress-mark' + (done ? ' done' : (gold ? ' gold' : ''));
      mark.style.left = pct.toFixed(1) + '%';
      mark.title = `第 ${i + 1} 位数字：第 ${sec} 秒出现`;
      box.appendChild(mark);
      // 刻度上方「第 N 位」标签
      const label = document.createElement('div');
      label.className = 'cd-progress-label' + (done ? ' done' : (gold ? ' gold' : ''));
      label.textContent = `第${i + 1}位`;
      label.title = `第 ${i + 1} 位数字：第 ${sec} 秒出现`;
      label.style.left = pct.toFixed(1) + '%';
      // 边缘刻度避免标签溢出：首/末位向内侧修位置
      if (pct <= 8) label.style.transform = 'translateX(0)';
      else if (pct >= 92) label.style.transform = 'translateX(-100%)';
      lblBox.appendChild(label);
    });
  }

  /** 待填答案格：数量跟随位数（3 或 4），竞猜中按位图逐位翻牌（null=未揭晓），揭晓后全部填入答案 */
  function renderCells() {
    const cells = $('cells');
    let n = 4;
    if (state.answerTotalLen) n = state.answerTotalLen;
    else if (state.cfg && state.cfg.digitCount) n = state.cfg.digitCount;
    // 动态补齐/裁剪格子数（用 live 的 children 计数，避免静态 NodeList 死循环）
    while (cells.children.length < n) {
      const div = document.createElement('div');
      div.className = 'cell';
      div.textContent = '?';
      cells.appendChild(div);
    }
    while (cells.children.length > n) { cells.removeChild(cells.lastChild); }
    const elList = cells.querySelectorAll('.cell');
    // 已揭晓的答案各位数字（数组：已揭位=数字字符，未揭位=null）
    const digits = (state.answerDigits && state.answerDigits.length) ? state.answerDigits : [];
    const revealed = state.status === 'revealed';
    elList.forEach((el, i) => {
      if (revealed && state.answerFmt) {
        const full = state.answerFmt.split(' ');
        el.textContent = full[i] || '?';
        el.style.color = 'var(--gold)';
        el.style.borderColor = 'var(--gold)';
      } else if (i < digits.length && digits[i] != null && digits[i] !== '') {
        // 该位已揭晓：填入数字并高亮
        el.textContent = digits[i];
        el.style.color = 'var(--gold)';
        el.style.borderColor = 'var(--gold)';
      } else {
        el.textContent = '?';
        el.style.color = '';
        el.style.borderColor = '';
      }
    });
  }

  /**
   * 第 i 条「线索提示」的出现条件（服务端已归一化下发）。
   * 支持三种 mode：time（秒）/ likes（本轮累计点赞数）/ never（永不出现）。
   * 与答案位揭示（answerRevealSec）是两条独立轴。
   */
  function clueCondAt(i) {
    const arr = (state && state.clueCond) || [];
    return arr[i] || { mode: 'time', value: 0 };
  }

  /** 本轮已过秒数（用于「按时间」条件的倒计时） */
  function roundElapsedSec() {
    if (!state || !state.deadline) return 0;
    const total = (state.cfg && state.cfg.roundIntervalSec) || 120;
    // 暂停期用服务端冻结的剩余毫秒换算：倒计时/线索时间在暂停时定格
    if (state.status === 'paused' && (state.pausedRemain || 0) > 0) {
      return Math.max(0, total - state.pausedRemain / 1000);
    }
    const start = state.deadline - total * 1000;
    return Math.max(0, (Date.now() - start) / 1000);
  }

  /**
   * 反馈文案：通用 A/B 记谱（与服务端 engine.js hintText 保持一致）
   *   A = 数字对且位置也对 = posOk
   *   B = 数字对但位置错   = digitOk - posOk
   * 例：digitOk=2,posOk=1 → "1A1B"；digitOk=1,posOk=1 → "1A0B"
   */
  function fbAB(digitOk, posOk) {
    const a = posOk || 0;
    const b = Math.max(0, (digitOk || 0) - a);
    return `${a}A${b}B`;
  }

  function renderClues() {
    const grid = $('clueGrid');
    if (!grid) return;
    const clues = state.puzzle ? state.puzzle.clues : [];
    // 列数按位数切换：4 条线索 → 2 列（两行，卡片更宽）；3 条 → 3 列（单行，保持原样）
    grid.className = 'clues ' + (clues.length >= 4 ? 'n4' : 'n3');
    if (!state.puzzle || !['gambling', 'revealed', 'paused'].includes(state.status) || clues.length === 0) {
      grid.innerHTML = '<div class="clue-empty" style="grid-column:1/-1;color:var(--dim);font-size:13px;text-align:center;padding:12px 0;border:1px dashed var(--line);border-radius:12px;">主播还没开始本轮，稍候…</div>';
      return;
    }
    // 已揭晓：全部线索直接展示（不再倒计时）
    if (state.status === 'revealed') {
      grid.innerHTML = '';
      clues.forEach((c) => {
        const card = document.createElement('div');
        card.className = 'clue-card';
        card.innerHTML = `<span class="clue-num">${esc(c.numFmt || '')}</span><span class="clue-hint">${fbAB(c.digitOk, c.posOk)}</span>`;
        grid.appendChild(card);
      });
      return;
    }
    // 进行中（gambling/paused）：维护卡片节点，内容（倒计时/线索）由 tick 每秒刷新
    while (grid.children.length < clues.length) {
      const card = document.createElement('div');
      card.className = 'clue-card';
      grid.appendChild(card);
    }
    while (grid.children.length > clues.length) grid.removeChild(grid.lastChild);
    tickClueCountdowns();
  }

  /**
   * 每秒刷新各线索卡。可见性以服务端 clueShown 为准（服务端权威判定）：
   *   已出现        → 显示线索（A/B 反馈）
   *   按时间未到点  → 显示倒计时 Ns
   *   按点赞数未达标 → 显示进度 已赞数/阈值
   *   never         → 显示「暂无」
   */
  function tickClueCountdowns() {
    const grid = $('clueGrid');
    if (!grid || !state) return;
    if (state.status !== 'gambling' && state.status !== 'paused') return;
    const elapsed = roundElapsedSec();
    const likes = state.roundLikes || 0;
    for (let i = 0; i < grid.children.length; i++) {
      const card = grid.children[i];
      if (!card.classList || !card.classList.contains('clue-card')) continue;
      const clue = (state.puzzle && state.puzzle.clues[i]) || {};
      const numHtml = `<span class="clue-num">${esc(clue.numFmt || '')}</span>`;

      if (state.clueShown && state.clueShown[i]) {
        card.className = 'clue-card';
        card.innerHTML = `${numHtml}<span class="clue-hint">${fbAB(clue.digitOk, clue.posOk)}</span>`;
        continue;
      }
      // 未达条件：顶部用 ？？？？ 占位（与已出现线索同高两行），下方显示出现条件，不剧透数字
      const cond = clueCondAt(i);
      const digitN = (state.puzzle && state.puzzle.digits) ? state.puzzle.digits : 4;
      const maskHtml = `<span class="clue-num clue-mask">${'?'.repeat(digitN)}</span>`;
      if (cond.mode === 'never') {
        card.className = 'clue-card clue-none';
        card.innerHTML = `${maskHtml}<span class="clue-hint">暂无</span>`;
      } else if (cond.mode === 'likes') {
        card.className = 'clue-card clue-pending';
        card.innerHTML = `${maskHtml}<span class="clue-count">${likes}/${cond.value}次点赞出现</span>`;
      } else {
        const remaining = Math.max(0, Math.ceil(cond.value - elapsed));
        card.className = 'clue-card clue-pending';
        card.innerHTML = `${maskHtml}<span class="clue-count">${remaining}秒后出现</span>`;
      }
    }
  }

  let streamCache = [];
  let lastRoundNo = -1;   // 用于检测新一轮开始，清空猜测流
  function renderGuessStream() {
    const box = $('guessStream');
    // 新一轮开始：清空猜测流（roundNo 变化即清屏）
    if (state.roundNo !== lastRoundNo) {
      lastRoundNo = state.roundNo;
      streamCache = [];
    }
    if (state.guesses && state.guesses.length) {
      streamCache = state.guesses.slice(-10).reverse();
    }
    box.innerHTML = '';
    // 全量重建不带动画（避免 SSE state 推送时整体跳动）
    streamCache.slice(0, 10).forEach(g => box.appendChild(buildGuessNode(g, false)));
    if (streamCache.length > 0) {
      const more = document.createElement('div');
      more.className = 'g-scroll-hint';
      more.textContent = '▼';
      box.appendChild(more);
    }
  }
  function appendStageGuess(g) {
    streamCache.unshift(g);
    if (streamCache.length > 14) streamCache.length = 14;
    const box = $('guessStream');
    const hint = box.querySelector('.g-scroll-hint');
    if (hint) hint.remove();
    // 旧记录整体下移：移除 shift 类强制回流后再加回，确保动画每次重放
    const olds = [...box.querySelectorAll('.g-item')];
    olds.forEach(el => el.classList.remove('shift'));
    void box.offsetHeight;
    olds.forEach(el => el.classList.add('shift'));
    // 新记录：从左往右移入 + 渐入
    box.insertBefore(buildGuessNode(g, true), box.firstChild);
    while (box.querySelectorAll('.g-item').length > 9) box.lastChild.remove();
    const more = document.createElement('div');
    more.className = 'g-scroll-hint';
    more.textContent = '▼';
    box.appendChild(more);
    if (g.isWin) renderAll();
  }
  function buildGuessNode(g, withAnim = false) {
    const div = document.createElement('div');
    div.className = 'g-item' + (g.isWin ? ' win' : '') + (withAnim ? ' enter' : '');
    // A/B 记谱：A（数字对且位置对）沿用原「位置」金色，B（数字对但位置错）沿用原「数字」绿色
    const fb = g.isWin
      ? '全对 · 猜中！'
      : `<b class="g-ps">${g.posOk || 0}</b>A<b class="g-dg">${Math.max(0, (g.digitOk || 0) - (g.posOk || 0))}</b>B`;
    const digits = String(g.guess || '').split('');
    const cells = digits.map(d => `<span class="g-cell">${esc(d)}</span>`).join('');
    div.innerHTML = `<div class="g-top"><span class="g-name">${esc(g.user)}</span><span class="g-fb">${fb}</span></div><div class="g-digits">${cells}</div>`;
    return div;
  }

  /* 排行榜：名次 / 头像 / 玩家 / 得分（与成语接龙等游戏共用 common/public/base.css 的 .lb-* 分格） */
  function renderBoard(withAnim = false) {
    const box = $('boardBody');
    if (!box) return;
    // 统一排行榜组件：前三名固定 + 第4~50名轮播（common/public/core.js）
    DG.mountLeaderboard(box, state.leaderboard || [], {
      totalScore: r => (r.totalScore != null ? r.totalScore : ((r.guess_score || 0) + (r.chengyu_score || 0))),
    });
  }

  function renderWinBanner() {
    const banner = $('winBanner');
    const card = banner.querySelector('.win-card');
    const avWrap = $('winAvatarWrap');
    const avImg = $('winAvatar');
    const avFb = $('winAvatarFallback');
    if (state.status === 'revealed') {
      if (state.winner) {
        // 猜中：金色结算弹窗 + 头像 + 烟花
        $('winTitle').textContent = '猜 中 答 案 !';
        $('winName').textContent = state.winner.name;
        $('winScore').textContent = `+${state.winner.score || ''} 分，越早猜中分越高`;
        $('winAnswer').textContent = state.answerFmt;
        card.style.borderColor = 'var(--gold)';
        $('winTitle').style.color = 'var(--gold)';
        card.classList.add('is-win');

        // 头像渲染（无头像则回退首字）
        const avatar = state.winner.avatar || '';
        if (avatar) {
          avWrap.style.display = '';
          avFb.style.display = 'none';
          avImg.src = avatar;
          avImg.onerror = () => { avImg.style.display = 'none'; avFb.style.display = 'flex'; avFb.textContent = initialOf(state.winner.name); };
        } else {
          avWrap.style.display = '';
          avImg.style.display = 'none';
          avFb.style.display = 'flex';
          avFb.textContent = initialOf(state.winner.name);
        }
      } else {
        // 无人猜中：结算弹窗（答案揭晓，无人获胜），不显示头像
        $('winTitle').textContent = '本 轮 结 束';
        $('winName').textContent = '无人猜中';
        $('winScore').textContent = '正确答案已揭晓';
        $('winAnswer').textContent = state.answerFmt;
        card.style.borderColor = 'var(--accent)';
        $('winTitle').style.color = 'var(--accent)';
        card.classList.remove('is-win');
        avWrap.style.display = 'none';
      }
      banner.classList.remove('hidden');
      clearTimeout(winBannerTimer);
      // 弹窗停留时长与“揭晓停留(秒)”一致：弹窗消失瞬间即开启新一轮
      const resultSecs = (state.cfg && state.cfg.resultShowSec) || 10;
      winBannerTimer = setTimeout(() => banner.classList.add('hidden'), resultSecs * 1000);
      if (!winBannerShown) { winBannerShown = true; bannerShownAt = Date.now(); }   // 仅上升沿启动倒计时，避免重复 SSE 推送重置

      // 烟花：仅猜中时，且每轮揭晓只触发一次
      if (state.winner && state.revealedAt && state.revealedAt !== lastRevealedAt) {
        lastRevealedAt = state.revealedAt;
        launchFireworks('fireworks');
      }
    } else {
      banner.classList.add('hidden');
      winBannerShown = false;
      bannerShownAt = 0;
      $('winNext') && ($('winNext').style.display = 'none');
    }
  }
})();
