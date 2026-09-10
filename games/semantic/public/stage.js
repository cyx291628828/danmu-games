/* ══════════════════════════════════════════════════════════════════
   stage.js — 语义猜词 · 展示屏逻辑（games/semantic/public）
   9:16 竖屏投屏 / OBS 浏览器源；订阅本游戏 SSE 状态流
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, initialOf, connectSSE, launchFireworks } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'semantic';
  let state = null;
  let winBannerTimer = null;
  let bannerShownAt = 0;       // 结算弹窗显示时刻（用于下一局倒计时）
  let winBannerShown = false;  // 上升沿检测，避免重复 SSE 推送重置倒计时
  let lastRevealedAt = 0;      // 已触发过烟花的揭晓时间戳（去重）

  connectSSE(GAME, {
    onState: (_gid, st) => { state = st; renderAll(); },
    onGuess: (_gid, g) => appendGuessToBoard(g),
    onError: () => { if ($('cdNum')) $('cdNum').textContent = '--'; },
  });

  function renderAll() {
    if (!state) return;
    renderStage();
  }

  /* ══════════════ 展示屏渲染 ══════════════ */
  function renderStage() {
    $('stRound').textContent = `ROUND ${state.roundNo || 0}`;

    const cd = $('cdNum');
    if (state.status === 'gambling') {
      tickCountdown();
    } else if (state.status === 'revealed') {
      cd.textContent = '0';
    } else {
      cd.textContent = '--';
    }

    renderCells();
    renderHints();
    renderCdFill();
    renderMarks();
    renderLikes();
    renderRecent();
    renderGuessBoard();
    renderBoardIfChanged();
    renderWinBanner();
  }

  let lbFingerprint = '';   // leaderboard 指纹，变化才重绘（避免每次 SSE 推送整体重建导致跳动）
  function renderBoardIfChanged() {
    const list = state.leaderboard || [];
    const fp = list.map(r => `${r.rank}|${r.name}|${r.totalScore != null ? r.totalScore : ((r.semantic_score || 0) + (r.guess_score || 0))}`).join(',');
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
    renderCdFill();
  }
  setInterval(() => { tickCountdown(); tickResultCountdown(); }, 1000);

  /* 结算弹窗「下一局倒计时」胶囊 */
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

  /* 时间进度条：底色填充本轮已过时间 */
  function renderCdFill() {
    const fill = $('cdProgFill');
    if (!fill) return;
    const total = (state.cfg && state.cfg.roundIntervalSec) || 150;
    let pct = 0;
    if (state.status === 'gambling' && state.deadline) {
      const start = state.deadline - total * 1000;
      pct = Math.min(1, Math.max(0, (Date.now() - start) / (total * 1000)));
    } else if (state.status === 'revealed') {
      pct = 1;
    }
    fill.style.width = (pct * 100).toFixed(1) + '%';
  }

  /* ══════════════ 进度条提示节点：只标「词性」节点（金色未放出 → 绿色已放出） ══════════════ */
  function renderMarks() {
    const box = $('cdProgMarks'), lblBox = $('cdProgLabels');
    if (!box || !lblBox) return;
    const m = state.marks || {};
    const total = (state.cfg && state.cfg.roundIntervalSec) || 150;
    box.innerHTML = ''; lblBox.innerHTML = '';
    if (m.posSec == null || m.posSec < 0) return;
    const pct = Math.min(100, Math.max(0, m.posSec / total * 100));
    const done = !!state.posHintShown;
    const mk = document.createElement('div');
    mk.className = 'cd-progress-mark ' + (done ? 'done' : 'gold');
    mk.style.left = pct.toFixed(1) + '%';
    mk.title = `词性提示：第 ${Math.round(m.posSec)} 秒`;
    box.appendChild(mk);
    const lb = document.createElement('div');
    lb.className = 'cd-progress-label ' + (done ? 'done' : 'gold');
    lb.textContent = '词性';
    lb.style.left = pct.toFixed(1) + '%';
    if (pct <= 8) lb.style.transform = 'translateX(0)';
    else if (pct >= 92) lb.style.transform = 'translateX(-100%)';
    lblBox.appendChild(lb);
  }

  /* ══════════════ 点赞解锁提示词面板（仿数独：只显示当前累计最多的观众，达标扣 N 重新计） ══════════════ */
  let lyFp = '', lyRound = -1, lyMainKey = '__none__';
  function renderLikes() {
    const sec = $('likeSection');
    if (!sec) return;
    const lp = state.likeProgress;
    const per = (lp && lp.per) || 0;
    if (!per || !lp) { sec.style.display = 'none'; return; }
    if (state.roundNo !== lyRound) { lyRound = state.roundNo; lyFp = ''; lyMainKey = '__none__'; }
    const main = lp.main;
    sec.style.display = '';
    // 头像/名字：仅在点赞王换人时重建（避免每次点赞都重设 innerHTML 导致头像 <img> 重载闪烁）
    const mk = main ? main.name : '';
    if (mk !== lyMainKey) {
      lyMainKey = mk;
      $('lyWho').innerHTML = main
        ? `当前：${DG.avatarHTML(main.name, main.avatar)}<b>${esc(main.name)}</b>`
        : '等待点赞…';
    }
    // 进度：只更新宽度与文字（无动画重放）
    const cur = main ? main.likes : 0;
    $('lyFill').style.width = Math.min(100, cur / per * 100).toFixed(0) + '%';
    $('lyCount').textContent = `已解锁 ${lp.unlocked} 词 · ${cur}/${per} 赞`;
  }

  /* ══════════════ 玩家弹幕词（最近 5 条真实弹幕，最新在上、不排序；不含礼物/点赞解锁词） ══════════════ */
  let rcFp = '';
  function renderRecent() {
    const box = $('rcList');
    if (!box) return;
    const list = state.recent || [];
    const fp = list.map(r => `${r.user}|${r.guess}|${r.ts}`).join(',');
    if (fp === rcFp) return;
    rcFp = fp;
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="rc-empty">等待观众弹幕…</div>';
      return;
    }
    list.forEach(r => {
      const d = document.createElement('div');
      d.className = 'rc-row' + (r.isWin ? ' win' : (r.oov ? ' cold' : ''));
      d.innerHTML = `<span class="rc-user">${esc(r.user)}</span><span class="rc-word">${esc(r.raw || r.guess)}</span><span class="rc-pct">${esc(r.percentText)}%</span>`;
      box.appendChild(d);
    });
  }

  /* 神秘词卡片：竞猜中显示 ？（首字提示后亮首字），揭晓后全部亮出 */
  function renderCells() {
    const cells = $('cells');
    const n = Math.max(2, Math.min(6, state.answerLen || 0));
    if (!n) { cells.innerHTML = ''; return; }
    while (cells.children.length < n) {
      const div = document.createElement('div');
      div.className = 'cell';
      div.textContent = '?';
      cells.appendChild(div);
    }
    while (cells.children.length > n) { cells.removeChild(cells.lastChild); }
    const revealed = state.status === 'revealed';
    const answer = revealed ? (state.answer || '') : '';
    const hint = (!revealed && state.answerHint) ? state.answerHint : null;
    const unlocker = state.hintUnlockedBy;   // 首字解锁者：头像显示在首字格右上角
    [...cells.children].forEach((el, i) => {
      if (revealed && answer[i]) {
        el.textContent = answer[i];
        el.style.color = 'var(--gold)';
        el.style.borderColor = 'var(--gold)';
      } else if (i === 0 && hint) {
        const avBadge = unlocker ? `<span class="cell-av">${DG.avatarHTML(unlocker.name, unlocker.avatar)}</span>` : '';
        el.innerHTML = `${esc(hint)}${avBadge}`;
        el.style.color = 'var(--gold)';
        el.style.borderColor = 'var(--gold)';
      } else {
        el.textContent = '?';
        el.style.color = '';
        el.style.borderColor = '';
      }
    });
  }

  /* 提示区：词性（定时）/ 首字（礼物解锁，解锁者头像显示在首字格右上角） */
  // chip 带 key 的 DOM 复用：state 每次推送都重建会让 chipPop 反复播放（点赞/送礼时“跳动一下”）。
  // 复用已存在的 chip 节点，仅新增的 chip 播放入场动画。
  function renderHints() {
    const tip = $('hintTip');
    if (!tip) return;
    const want = [];
    if (state.status === 'gambling' || state.status === 'paused') {
      if (state.posHintShown && state.answerPos) want.push({ key: 'pos', text: `💡 词性：${state.answerPos}` });
      if (!state.answerHint) {
        // 本场已用过关注解锁则不再展示引导（followUsed 不随轮次重置）
        if (state.cfg && state.cfg.followUnlockFirst && !state.followUsed) {
          want.push({ key: 'follow', text: '❤️ 关注主播解锁首字' });
        }
      } else {
        want.push({ key: 'first', text: `💡 首字：${state.answerHint}` });
      }
      const giftN = Math.max(0, parseInt(state.cfg && state.cfg.wordHintCount, 10) || 0);
      if (giftN > 0) want.push({ key: 'gift', text: `🎁 送礼随机${giftN}词` });
    }
    if (!want.length) { tip.style.display = 'none'; tip.innerHTML = ''; return; }
    tip.style.display = 'flex';
    const have = {};
    [...tip.children].forEach(el => { if (el.dataset.k) have[el.dataset.k] = el; });
    want.forEach(item => {
      let el = have[item.key];
      if (el) {
        delete have[item.key];
        if (el.textContent !== item.text) el.textContent = item.text;   // 文本变了才更新（不重建节点/不重放动画）
      } else {
        el = document.createElement('span');
        el.className = 'chip';
        el.dataset.k = item.key;
        el.textContent = item.text;
        tip.appendChild(el);
      }
    });
    Object.values(have).forEach(el => el.remove());   // 移除已不存在的 chip
  }

  /* ══════════════ 实时猜测榜（按相似度排序，进度条背景 + 第N名） ══════════════
     数据源：state.guessBoard（服务端按排名升序取前 N）；
     onGuess 单条事件先本地插入，下一份 state 整体覆盖（服务端权威）。
     行 DOM 按 key 复用：新词 append + enter，旧词原地更新；
     排序走 flex order，不搬节点，避免打断进行中的入场动画。 */
  let boardFp = '';
  let boardRound = -1;
  let boardRowEls = new Map();   // key → 行元素（复用，动画不被重建打断）
  let boardRenderQueued = false;

  function boardTopN() { return 30; }   // 数据侧最多 30 条；容器展示多少由 CSS 裁切（超出部分不显示）
  function boardKey(w) { return `${w.user}|${w.guess}|${w.ts}`; }
  function sortBoard(arr) { return arr.slice().sort((a, b) => (b.percent - a.percent) || (a.ts - b.ts)); }
  function guessSource(w) { return w.source || (w.gift ? 'gift' : 'chat'); }

  /** 同帧合并连发（送礼一次上多词 / guess+state 连推） */
  function scheduleGuessBoardRender() {
    if (boardRenderQueued) return;
    boardRenderQueued = true;
    requestAnimationFrame(() => {
      boardRenderQueued = false;
      renderGuessBoard();
    });
  }

  function ensureBoardHeader(box) {
    if (box.querySelector('.gb-th')) return;
    const head = document.createElement('div');
    head.className = 'gb-th';
    head.style.order = '0';
    head.innerHTML = '<span class="gb-c1">词语及排名</span><span class="gb-c2">观众</span><span class="gb-c3">关联度</span>';
    box.insertBefore(head, box.firstChild);
  }

  function rowHeat(w) {
    return w.percent >= 90 ? 'hot' : (w.percent >= 60 ? 'warm' : (w.percent >= 30 ? 'cool' : 'cold'));
  }

  function renderGuessBoard() {
    const box = $('guessStream');
    if (!box) return;
    let force = false;
    // 新一轮：清空行节点与指纹
    if (state.roundNo !== boardRound) {
      boardRound = state.roundNo;
      boardFp = '';
      for (const el of boardRowEls.values()) el.remove();
      boardRowEls = new Map();
      force = true;
    }
    const list = sortBoard(state.guessBoard || []).slice(0, boardTopN());
    // 指纹含百分比与 ×N 计数：关联度或重复人数变化即刷新
    const fp = list.map(w => `${boardKey(w)}|${w.percentText}|${w.count || 1}`).join(',');
    if (fp === boardFp && !force) return;
    boardFp = fp;

    ensureBoardHeader(box);
    const empty = box.querySelector('.board-empty');
    if (!list.length) {
      if (!empty) {
        const d = document.createElement('div');
        d.className = 'board-empty';
        d.style.order = '1';
        d.textContent = state.status === 'gambling' ? '还没有人猜，弹幕发一个词试试！' : '主播还没开始本轮，稍候…';
        box.appendChild(d);
      }
      return;
    }
    if (empty) empty.remove();

    const keep = new Set();
    list.forEach((w, i) => {
      const key = boardKey(w);
      keep.add(key);
      let el = boardRowEls.get(key);
      if (!el) {
        // 新词：新建并播放入场；已有词绝不动 enter，动画各自跑完
        el = buildBoardRow(w, i, true);
        boardRowEls.set(key, el);
        box.appendChild(el);
      } else {
        updateBoardRow(el, w, i);
      }
      el.style.order = String(i + 1);   // 表头 order=0；只改 order 不搬 DOM
    });
    // 移除掉出榜的行
    for (const [key, el] of boardRowEls) {
      if (!keep.has(key)) {
        el.remove();
        boardRowEls.delete(key);
      }
    }
  }

  function appendGuessToBoard(g) {
    // 本地并入并重排（进不了榜的猜测不显示）；服务端 state 随后覆盖为权威榜单
    if (!state || state.roundNo == null) return;
    if (g.isWin) renderAll();
    const cur = Array.isArray(state.guessBoard) ? state.guessBoard.slice() : [];
    // 同词合并计数（×N），与服务端 boardRows 一致；首次发现者的行与 raw 保留
    const exist = cur.find(w => w.guess === g.guess);
    if (exist) {
      exist.count = (exist.count || 1) + 1;
    } else {
      cur.push(Object.assign({ count: 1 }, g));
    }
    state.guessBoard = sortBoard(cur).slice(0, boardTopN());
    scheduleGuessBoardRender();
    // 真实弹幕（非礼物/点赞解锁词）即时进「玩家弹幕词」（原样 raw，最新在上）
    if (guessSource(g) === 'chat') {
      state.recent = [{ user: g.user, guess: g.guess, raw: g.raw || g.guess, percentText: g.percentText, isWin: g.isWin, oov: !!g.oov, ts: g.ts },
        ...(state.recent || [])].slice(0, 5);
      rcFp = '';   // 强制重绘
      renderRecent();
    }
  }

  function rowBadges(w) {
    const xn = (w.count > 1) ? `<span class="gb-xn">×${w.count}</span>` : '';
    const src = guessSource(w);
    const srcIcon = src === 'gift' ? '🎁' : (src === 'like' ? '👍' : '');
    const srcBadge = srcIcon ? `<span class="gb-xn gb-gift">${srcIcon}</span>` : '';
    return xn + srcBadge;
  }

  function buildBoardRow(w, i, withAnim) {
    const heat = rowHeat(w);
    const rankCls = i < 3 ? ' h-r' + (i + 1) : '';
    const div = document.createElement('div');
    div.className = 'gb-row h-' + heat + rankCls + (w.isWin ? ' win' : '') + (withAnim ? ' enter' : '');
    div.innerHTML = `
      <div class="h-heatbar" style="width:${Math.max(3, Math.min(100, w.percent)).toFixed(0)}%"></div>
      <div class="gb-c1"><span class="gb-idx">${i + 1}</span><span class="gb-term">${esc(w.raw || w.guess)}</span>${rowBadges(w)}</div>
      <span class="gb-c2">${esc(w.user)}</span>
      <span class="gb-c3">${esc(w.percentText)}%</span>`;
    return div;
  }

  /** 原地更新已有行：不碰 enter，不重建子节点，动画不被打断 */
  function updateBoardRow(el, w, i) {
    const heat = rowHeat(w);
    el.classList.remove('h-hot', 'h-warm', 'h-cool', 'h-cold', 'h-r1', 'h-r2', 'h-r3', 'win');
    el.classList.add('h-' + heat);
    if (i < 3) el.classList.add('h-r' + (i + 1));
    if (w.isWin) el.classList.add('win');
    const bar = el.querySelector('.h-heatbar');
    if (bar) bar.style.width = Math.max(3, Math.min(100, w.percent)).toFixed(0) + '%';
    const idx = el.querySelector('.gb-idx');
    if (idx) idx.textContent = String(i + 1);
    const term = el.querySelector('.gb-term');
    if (term) term.textContent = w.raw || w.guess;
    const c1 = el.querySelector('.gb-c1');
    if (c1) {
      const badges = c1.querySelectorAll('.gb-xn');
      badges.forEach(b => b.remove());
      c1.insertAdjacentHTML('beforeend', rowBadges(w));
    }
    const c2 = el.querySelector('.gb-c2');
    if (c2) c2.textContent = w.user;
    const c3 = el.querySelector('.gb-c3');
    if (c3) c3.textContent = w.percentText + '%';
  }

  /* 排行榜：名次 / 头像 / 玩家 / 得分（common/public/base.css 的 .lb-* 分格） */
  function renderBoard(withAnim = false) {
    const box = $('boardBody');
    if (!box) return;
    // 统一排行榜组件：前三名固定 + 第4~50名轮播（common/public/core.js）
    DG.mountLeaderboard(box, state.leaderboard || [], {
      totalScore: r => (r.totalScore != null ? r.totalScore : ((r.semantic_score || 0) + (r.guess_score || 0))),
    });
  }

  /* ══════════════ 结算面板（数独风领奖台） ══════════════
     数据源 state.settle（服务端结算）：榜首=猜中者（win）或最接近者（top），
     其余为关联度上榜玩家（assoc，最多 6 人）。 */
  function renderWinBanner() {
    const banner = $('winBanner');
    const panel = banner.querySelector('.result-panel');
    const topAv = $('winTopAv');
    const settle = state.settle || [];
    if (state.status === 'revealed') {
      const winFirst = !!(settle.length && settle[0].kind === 'win');
      if (!settle.length) {
        // 无人参与：简洁提示
        topAv.style.display = 'none';
        panel.classList.remove('has-top-av');
        $('winTitle').textContent = '本 轮 结 束';
        $('winTitle').style.color = 'var(--accent)';
        panel.style.borderColor = 'var(--accent)';
        panel.classList.remove('is-win');
        $('winPodium').innerHTML = '<div class="wt-empty">本轮无观众上榜</div>';
      } else {
        const [first, ...rest] = settle;
        // 顶缘居中、向上突出的头像（猜中戴皇冠）
        topAv.style.display = '';
        panel.classList.add('has-top-av');
        const avInner = first.avatar
          ? `<img src="${esc(first.avatar)}" referrerpolicy="no-referrer" onerror="this.remove();this.parentNode.textContent='${esc(initialOf(first.user))}'">`
          : esc(initialOf(first.user));
        topAv.innerHTML = `${winFirst ? '<span class="p-crown">👑</span>' : ''}<span class="p-top-av-in">${avInner}</span>`;
        // 榜首大卡：猜中者（+n+m）或最接近者（+m×%）
        const firstTag = winFirst ? `<span class="p-bonus">猜中 +${first.points}</span>` : `<span class="p-tag">最接近</span>`;
        let podium = `
          <div class="p-card p1">
            <span class="p-av-wrap">${DG.avatarHTML(first.user, first.avatar)}</span>
            <div class="p-col">
              <div class="p-name"><span class="p-nm">${esc(first.user)}</span>${firstTag}</div>
              <div class="p-stats"><span class="pt">「${esc(first.word)}」</span><span>${esc(first.percentText)}%</span><span class="pt">+${first.points}分</span></div>
            </div>
          </div>`;
        // 其余上榜玩家：2/3 一排（带头像），4/5/6 一排（仅名字）
        const mini = (t, withAv, rank) => t ? `
          <div class="p-card">
            ${withAv ? `<span class="p-av-sm r${rank}">${DG.avatarHTML(t.user, t.avatar)}</span>` : ''}
            <div class="p-col">
              <div class="p-name-sm">${esc(t.user)}</div>
              <div class="p-stats-sm"><span class="pt">「${esc(t.word)}」</span><span>${esc(t.percentText)}%</span><span class="pt">+${t.points}分</span></div>
            </div>
          </div>` : '<div class="p-card ghost">虚位以待</div>';
        if (rest.length) {
          podium += `<div class="p-row">${mini(rest[0], true, 2)}${mini(rest[1], true, 3)}</div>`;
          for (let i = 2; i < rest.length; i += 3) {
            podium += `<div class="p-row">${mini(rest[i], false, 0)}${mini(rest[i + 1], false, 0)}${mini(rest[i + 2], false, 0)}</div>`;
          }
        }
        $('winPodium').innerHTML = podium;
        $('winTitle').textContent = winFirst ? '猜 中 词 语 !' : '本 轮 结 束';
        $('winTitle').style.color = winFirst ? 'var(--gold)' : 'var(--accent)';
        panel.style.borderColor = winFirst ? 'var(--gold)' : 'var(--accent)';
        panel.classList.toggle('is-win', winFirst);
      }
      $('winSub').textContent = `答案是「${state.answer || '—'}」`;
      banner.classList.remove('hidden');
      clearTimeout(winBannerTimer);
      // 弹窗停留时长与「揭晓停留(秒)」一致：弹窗消失瞬间即开启新一轮
      const resultSecs = (state.cfg && state.cfg.resultShowSec) || 10;
      winBannerTimer = setTimeout(() => banner.classList.add('hidden'), resultSecs * 1000);
      if (!winBannerShown) { winBannerShown = true; bannerShownAt = Date.now(); }

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
