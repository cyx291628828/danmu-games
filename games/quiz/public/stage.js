/* ══════════════════════════════════════════════════════════════════
   stage.js — 答题竞猜 · 展示屏逻辑（games/quiz/public）
   9:16 竖屏投屏 / OBS 浏览器源；订阅本游戏 SSE 状态流
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, initialOf, connectSSE, launchFireworks } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'quiz';
  let state = null;
  let lastQKey = '';
  let lastRevealedAt = 0;
  let bannerTimer = null;

  connectSSE(GAME, {
    onState: (_gid, st) => { state = st; renderAll(); },
    onError: () => { const c = $('cdNum'); if (c) c.textContent = '--'; },
  });

  function renderAll() {
    if (!state) return;
    renderStage();
  }

  /* ══════════════ 展示屏渲染 ══════════════ */
  function renderStage() {
    $('stRound').textContent = `ROUND ${state.roundNo || 0}`;
    const cd = $('cdNum');
    if (state.status === 'asking') tickCountdown();
    else if (state.status === 'revealed') cd.textContent = '0';
    else cd.textContent = '--';

    updateCdFill();
    renderHowto();
    renderLikeProgress();
    renderQuestion();
    renderOptions();
    renderFeed();
    renderBoardIfChanged();
    renderResultBanner();
  }

  /* 计分规则（游戏端 howto 计分区）：只展示「加分」规则，按主播台当前配置动态生成；
     排版：基础分+时间加成 一行，连对 / 最快答对各占一行；配置为 0 的项整行省略。 */
  function renderHowto() {
    const el = $('howtoScore');
    if (!el) return;
    const c = state.cfg || {};
    const base = +c.baseScorePerWin || 100;
    const timePct = +c.timeBonusPct || 0;
    const streak = +c.streakBonus || 0;
    const fastest = +c.fastestBonus || 0;
    const lines = [`计分：答对基础 <b>${base}</b> 分` +
      (timePct > 0 ? ` · 越早答越高（最多额外 +<b>${Math.round(base * timePct / 100)}</b> 分）` : '')];
    if (streak > 0) lines.push(`连对每多 1 题 +<b>${streak}</b> 分`);
    if (fastest > 0) lines.push(`本题最快答对 +<b>${fastest}</b> 分`);
    const sig = lines.join('|');
    if (el.dataset.sig === sig) return; // 防每秒重绘闪烁
    el.dataset.sig = sig;
    el.innerHTML = lines.join('<br>');
  }

  /* 实时答题栏上方固定提示面板（始终显示，带边框卡片）：
     第一排：头像 名字 点赞 进度条 n/m 排除答案（目标=当前最多赞且未用排除机会的观众）
     第二排：赠送 + 本地1钻礼物图×7 + 排除答案
     第三排：关注主播本题直接答对
     仅改显示，逻辑不变（每人每局一次/冷却等规则由后端保证）。 */
  function renderLikeProgress() {
    const el = $('likeProgress');
    if (!el) return;
    const c = state.cfg || {};
    const likesOn = c.likeEliminateEnabled !== false;
    const giftsOn = c.giftEliminateEnabled !== false;
    if (!likesOn && !giftsOn) {
      if (el.dataset.sig) { el.dataset.sig = ''; el.innerHTML = ''; }
      return;
    }
    const threshold = Math.max(1, +c.likeEliminateAt || 20);
    // 目标观众 = 按点赞数降序中第一个「还没用过本局排除机会」的人（done=false）；
    // 有人用掉排除机会后自动切到下一位最高且未使用的，都不满足则回落默认占位（虚位以待 0/m）
    const prog = state.likeProgress || [];
    const top = prog.find(r => r.count > 0 && !r.done);

    let rows = '';
    if (likesOn) {
      const r = top || { name: '虚位以待', avatar: '', count: 0 };
      const pct = Math.min(100, Math.round((r.count / threshold) * 100));
      const reached = r.count >= threshold;
      const av = r.avatar
        ? `<img class="lp-av" src="${esc(r.avatar)}" referrerpolicy="no-referrer" alt="">`
        : `<span class="lp-av lp-av-txt">${esc(initialOf(r.name))}</span>`;
      const num = `<span class="lp-num">${reached ? '🔥' : ''}${r.count}/${threshold}</span>`;
      rows += `<div class="lp-row">
        <span class="lp-item${reached ? ' done' : ''}">${av}<span class="lp-name">${esc(r.name)}</span></span>
        <span class="lp-tag">点赞</span>
        <span class="lp-bar"><i style="width:${pct}%"></i></span>
        ${num}
        <span class="lp-rule">排除答案</span>
      </div>`;
    }
    if (giftsOn) {
      const local = (state.giftIcons || []).slice(0, 7).map(g =>
        `<img class="lp-gift" src="${esc(g.url)}" title="${esc(g.name)}" alt="${esc(g.name)}" onerror="this.style.display='none'">`);
      const icons = local.join('')
        || '<span class="lp-gift lp-gift-ph">🎁</span><span class="lp-gift lp-gift-ph">🎁</span><span class="lp-gift lp-gift-ph">🎁</span>';
      rows += `<div class="lp-row">
        <span class="lp-tag">赠送</span>
        <span class="lp-gifts">${icons}</span>
        <span class="lp-rule">排除答案</span>
      </div>`;
    }
    if (c.followAsCorrect !== false) {
      rows += `<div class="lp-row lp-row-center">
        <span class="lp-rule lp-rule-lead">⭐ 关注主播本题直接答对</span>
      </div>`;
    }
    const sig = rows.length + '|' + (top ? `${top.name}|${top.count}` : '') + `|${threshold}|${likesOn}|${giftsOn}|${(state.giftIcons || []).length}`;
    if (el.dataset.sig === sig) return; // 防重绘闪烁
    el.dataset.sig = sig;
    el.innerHTML = `<h3>说明</h3><div class="lp-card">${rows}</div>`;
  }

  function tickCountdown() {
    if (!state || state.status !== 'asking') return;
    const s = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    $('cdNum').textContent = s;
    updateCdFill(); // 同步刷新进度条（原先只在 SSE 推送时才更新 → 条子冻住不动）
  }
  setInterval(tickCountdown, 1000);

  /* 进度条平滑推进：rAF 逐帧刷新，不依赖后端 SSE 推送 */
  function rafFill() {
    if (state && state.status === 'asking') updateCdFill();
    requestAnimationFrame(rafFill);
  }
  requestAnimationFrame(rafFill);

  function updateCdFill() {
    const fill = $('cdProgFill');
    if (!fill || !state) return;
    // 暂停：冻结在当前位置不重算（此时 deadline 已失效，且 resume 会把倒计时重置为整段）
    if (state.status === 'paused') return;
    const total = (state.cfg && state.cfg.roundIntervalSec) || 30;
    let pct = 0;
    if (state.status === 'asking' && state.deadline) {
      const start = state.deadline - total * 1000;
      pct = Math.min(1, Math.max(0, (Date.now() - start) / (total * 1000)));
    } else if (state.status === 'revealed') {
      pct = 1;
    }
    fill.style.width = (pct * 100).toFixed(1) + '%';
  }

  function qKey() {
    const q = state.question;
    if (!q) return '';
    return state.roundNo + '|' + q.q + '|' + (q.options || []).map(o => o.label + o.text).join(',');
  }

  /** 题卡 + 选项结构（题目变化时整体重建） */
  function renderQuestion() {
    const q = state.question;
    const qText = $('qText');
    const qSrc = $('qSource');
    const list = $('optList');
    const qTags = $('qTags');
    if (!q) {
      qText.textContent = '等待出题…';
      qSrc.textContent = '';
      if (qTags) { qTags.innerHTML = ''; qTags.style.display = 'none'; }
      list.innerHTML = '';
      return;
    }
    qText.textContent = q.q;
    qSrc.textContent = q.source === 'manual' ? '手动题' : '题库题';
    if (qTags) {
      // 分类 / 难度 标签（手动题没有这两个字段，此时不显示）
      const tags = [];
      if (q.category) tags.push(`<span class="q-tag q-tag-cat">${esc(q.category)}</span>`);
      if (q.difficulty) tags.push(`<span class="q-tag q-tag-diff">${esc(q.difficulty)}</span>`);
      qTags.innerHTML = tags.join('');
      qTags.style.display = tags.length ? 'flex' : 'none';
    }

    const key = qKey();
    if (key === lastQKey) return; // 结构未变，仅票数更新交给 renderOptions
    lastQKey = key;

    list.innerHTML = '';
    q.options.forEach((o, i) => {
      const row = document.createElement('div');
      row.className = 'opt';
      row.dataset.idx = i;
      row.innerHTML = `
        <div class="opt-bar" id="optBar${i}"></div>
        <div class="opt-label">${esc(o.label)}</div>
        <div class="opt-text">${esc(o.text)}</div>
        <div class="opt-voters" id="optVoters${i}"></div>
        <div class="opt-pct" id="optPct${i}">0%</div>
        <div class="opt-elim-badge" id="optElim${i}" style="display:none">已排除</div>`;
      list.appendChild(row);
    });
  }

  /** 选项「头像(人数)」：最多显示 5 个头像，随后用 (人数) 标注总数；0 人则留空 */
  function renderOptVoters(i, voters, count) {
    const el = $('optVoters' + i);
    if (!el) return;
    const list = voters || [];
    const MAX = 5;                       // 最多展示 5 个头像
    const shown = list.slice(0, MAX);
    const n = count || 0;
    // 签名：内容未变则跳过重写，避免每秒重建导致头像图片闪烁重载
    const sig = shown.map(v => (v.name || '') + ':' + (v.avatar || '')).join('|') + '#' + n;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    if (n === 0) { el.innerHTML = ''; return; }
    el.innerHTML = shown.map(v => avatarChip(v.name, v.avatar, 26)).join('') + `<span class="ov-count">(${n})</span>`;
  }

  /** 选项票数 / 正确高亮（每秒随 state 刷新） */
  function renderOptions() {
    const q = state.question;
    const list = $('optList');
    if (!q || !list.children.length) return;
    const counts = state.voteCounts || [];
    const total = state.answeredCount || 0;
    const voters = state.optionVoters || [];
    for (let i = 0; i < q.options.length; i++) {
      const c = counts[i] || 0;
      const pct = total > 0 ? Math.round((c / total) * 100) : 0;
      const pctEl = $('optPct' + i), row = list.children[i];
      if (!row) continue;
      // 只更新末尾「百分比」；人数移到头像后的 (人数) 标注，不再增长进度条
      if (pctEl) pctEl.textContent = `${pct}%`;
      renderOptVoters(i, voters[i], c);
      // 被排除的答案：灰显 + 角标「头像 名字 点赞/礼物排除」（绝不显示「正确高亮」）
      const elim = (state.eliminated || []).find(e => e.idx === i);
      const isElim = !!elim;
      row.classList.toggle('eliminated', isElim);
      const eb = $('optElim' + i);
      if (eb) {
        eb.style.display = isElim ? 'flex' : 'none';
        if (isElim) {
          const ebSig = `${elim.source}|${elim.user}|${elim.avatar}`;
          if (eb.dataset.sig !== ebSig) {   // 防每秒重绘导致头像闪烁重载
            eb.dataset.sig = ebSig;
            const av = elim.avatar
              ? `<img class="eb-av" src="${esc(elim.avatar)}" referrerpolicy="no-referrer" alt="">`
              : `<span class="eb-av eb-av-txt">${esc((elim.user || '?').trim().charAt(0) || '?')}</span>`;
            eb.innerHTML = `${av}<span class="eb-name">${esc(elim.user || '')}</span>${elim.source === 'gift' ? '礼物排除' : '点赞排除'}`;
          }
        }
      }
      // 揭晓：标记正确/错误
      if (state.status === 'revealed') {
        const isCorrect = !!(q.options[i] && q.options[i].isCorrect);
        row.classList.toggle('correct', isCorrect);
        row.classList.toggle('wrong', !isCorrect);
      } else {
        row.classList.remove('correct', 'wrong');
      }
    }
  }

  function renderFeed() {
    const box = $('qFeed');
    const list = state.feed || [];
    if (!list.length) {
      box.innerHTML = '<div class="g-feed-item empty">还没有人答题，快来参与～</div>';
      return;
    }
    // 滚动窗口：只渲染最新 25 条，更早的被顶掉（其余由后端 FEED_CAP=60 兜底跨局分界线）
    box.innerHTML = list.slice(-25).reverse().map(e => {
      if (e.type === 'follow') {
        return `<div class="g-feed-item fb-follow">⭐ <b>${esc(e.user)}</b> 关注主播 · 本题算答对<span class="fb-bonus"> +${e.score}</span> 分</div>`;
      }
      if (e.type === 'eliminate') {
        if (e.source === 'like') {
          const who = e.user ? `<b>${esc(e.user)}</b> ` : '';
          return `<div class="g-feed-item fb-elim">🔥 ${who}单局点赞达 ${e.count} · 已排除答案 <b>${esc(e.option)}</b></div>`;
        }
        const g = e.giftName ? `送出 ${esc(e.giftName)}` : '送出礼物';
        return `<div class="g-feed-item fb-elim">🎁 <b>${esc(e.user)}</b> ${g} · 已排除答案 <b>${esc(e.option)}</b></div>`;
      }
      if (e.type === 'round') {
        const stat = e.answered > 0
          ? `答对 ${e.correct} / 共 ${e.answered} · 正确率 ${e.accuracy}%`
          : '无人作答';
        return `<div class="g-feed-item fb-round">第 ${e.roundNo} 局 · ${stat}</div>`;
      }
      if (e.type === 'change') {
        return `<div class="g-feed-item fb-change">🔁 <b>${esc(e.user)}</b> 改选 <b>${esc(e.toLabel)}</b> 成功<span class="fb-from">（原 ${esc(e.fromLabel)}）</span></div>`;
      }
      if (e.type === 'change-denied') {
        return `<div class="g-feed-item fb-change-denied">🔁 <b>${esc(e.user)}</b> 改选 <b>${esc(e.toLabel)}</b> 被禁止<span class="fb-from">（原 ${esc(e.fromLabel)}）</span></div>`;
      }
      if (e.type === 'streak') {
        return `<div class="g-feed-item fb-streak"><b>${esc(e.user)}</b> 连续答对 ${e.streak} 题 额外 <span class="fb-bonus">+${e.bonus}</span> 分</div>`;
      }
      if (e.type === 'fastest') {
        return `<div class="g-feed-item fb-fastest"><b>${esc(e.user)}</b> 最快答对 额外 <span class="fb-bonus">+${e.bonus}</span> 分</div>`;
      }
      const fb = e.correct
        ? '<span class="fb-ok">✓ 对</span>'
        : '<span class="fb-no">✗ 错</span>';
      return `<div class="g-feed-item"><b>${esc(e.user)}</b> 选 ${esc(e.choiceLabel)} ${fb}</div>`;
    }).join('');
  }

  /* 头像芯片：有头像用 img（onerror 回退首字），无头像用首字 */
  function avatarChip(name, avatar, px) {
    const fb = (name || '?').trim().charAt(0) || '?';
    const size = `width:${px}px;height:${px}px`;
    if (avatar) {
      return `<div class="av-chip" style="${size}"><img src="${esc(avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="av-fb" style="display:none">${esc(fb)}</span></div>`;
    }
    return `<div class="av-chip" style="${size}"><span class="av-fb">${esc(fb)}</span></div>`;
  }

  /* ── 排行榜（与 guess/chengyu 共用 .lb-* 分格） ── */
  let lbFingerprint = '';
  function renderBoardIfChanged() {
    const list = state.leaderboard || [];
    const fp = list.map(r => `${r.rank}|${r.name}|${r.totalScore != null ? r.totalScore : 0}`).join(',');
    if (fp !== lbFingerprint) {
      lbFingerprint = fp;
      renderBoard();
    }
  }
  function renderBoard() {
    const box = $('boardBody');
    if (!box) return;
    // 统一排行榜组件：前三名固定 + 第4~50名轮播（common/public/core.js）
    DG.mountLeaderboard(box, state.leaderboard || [], {
      totalScore: r => (r.totalScore != null ? r.totalScore : 0),
    });
  }

  /* ── 揭晓横幅（含答对人头像墙 + 最快答对） ── */
  function renderResultBanner() {
    const banner = $('resultBanner');
    if (state.status === 'revealed' && state.result) {
      const q = state.question;
      const ans = q && q.options[state.result.answerIndex];
      $('resultTitle').textContent = '本 题 揭 晓';
      $('resultAnswer').innerHTML = ans ? `正确答案是 <b>${esc(ans.label)}</b>：${esc(ans.text)}` : '已揭晓';
      $('resultExplain').textContent = state.result.explain || '';
      $('resultStat').textContent = `${state.result.correctCount}/${state.result.answeredCount} 人答对`;

      // 答对人头像墙
      const correctList = state.result.correctList || [];
      const avBox = $('resultAvatars');
      if (avBox) {
        avBox.innerHTML = correctList.map(c => {
          const chip = avatarChip(c.name, c.avatar, 36);
          const nm = esc(c.name);
          return `<div class="ra">${chip}<span class="ra-nm">${nm}</span></div>`;
        }).join('') || '<div class="ra-nm">本题无人答对</div>';
      }

      // 最快答对（头像 + 名字 + 加成）
      const fastest = state.result.fastest;
      const fBox = $('resultFastest');
      if (fBox) {
        if (fastest) {
          fBox.style.display = 'flex';
          fBox.innerHTML = `${avatarChip(fastest.name, fastest.avatar, 32)}<div class="rf-info"><b>${esc(fastest.name)}</b> 最快答对<br>额外 <span class="rf-bonus">+${fastest.score}</span> 分</div>`;
        } else {
          fBox.style.display = 'none';
          fBox.innerHTML = '';
        }
      }

      banner.classList.remove('hidden');
      clearTimeout(bannerTimer);
      const secs = (state.cfg && state.cfg.resultShowSec) || 10;
      bannerTimer = setTimeout(() => banner.classList.add('hidden'), secs * 1000);

      if (state.result.correctCount > 0 && state.revealedAt && state.revealedAt !== lastRevealedAt) {
        lastRevealedAt = state.revealedAt;
        launchFireworks('fireworks');
      }
    } else {
      banner.classList.add('hidden');
    }
  }

  /* 结算弹窗「下一局倒计时」：nextRoundAt 由后端揭晓时给出，本地刷新（不依赖 SSE 推送） */
  function tickNextRound() {
    if (!state) return;
    const nx = $('resultNext');
    if (!nx) return;
    if (state.status === 'revealed' && state.nextRoundAt) {
      const s = Math.max(0, Math.ceil((state.nextRoundAt - Date.now()) / 1000));
      nx.style.display = 'block';
      nx.textContent = `下一局 ${s}s 后开始`;
    } else {
      nx.style.display = 'none';
    }
  }
  setInterval(tickNextRound, 250);
})();
