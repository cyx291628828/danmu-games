/* ══════════════════════════════════════════════════════════════════
   control.js — 答题竞猜 · 主播台控制台逻辑（games/quiz/public）
   页面可独立打开，也可嵌在主播台框架 iframe 中（/control.html?game=quiz）
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, showToast, control } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'quiz';
  let state = null;
  let cfgFormBuilt = false;
  let roomFilter = null;
  // 主播台专用答案：经 peek 动作向 /api/control 索取，不进 SSE（观众的展示屏拿不到）
  let peek = null;
  let lastPeekRound = -1;
  let peeking = false;
  let msCat = null, msDiff = null;   // 题库「分类 / 难度」多选下拉实例

  /* ───────────── SSE（只订阅本游戏） ───────────── */
  DG.connectSSE(GAME, {
    onState: (_gid, st) => { state = st; render(); },
    onNotice: (_gid, n) => { if (n && n.text) showToast(n.text); },
    onError: () => showToast('与游戏服务断连，正在重试…'),
  });

  // 倒计时独立 tick：避免只在 SSE 推送时刷新导致「剩余XXs」卡住不动
  setInterval(() => {
    if (state && state.status === 'asking') renderStatus();
  }, 1000);

  function render() {
    if (!state) return;
    if (roomFilter) roomFilter.refresh();
    renderStatus();
    renderQuestionAndAnswer();
    ensurePeek();
    ensureCfgForm();
    backfillCfg();
    renderHistory();
    DGBroadcast.watch(state);   // 通用播报：bc.seq 自增 → 自动朗读 + 渲染播报记录
  }

  /* ───────────── AI 口播：已迁移到通用播报中心（common/broadcast + DGBroadcast 面板） ─────────────
     生成方式/接口配置/逐点开关/试播/TTS 语速音色全部由 DGBroadcast 面板托管（bcPanel）。 */

  function setNarStatus(t) {
    const el = $('narrationStatus');
    if (!el) return;
    el.textContent = t || '';
    if (t) setTimeout(() => { if (el.textContent === t) el.textContent = ''; }, 2600);
  }

  /** 手动「🔊 播报」：重新生成当前题口播并朗读（走通用播报通道） */
  async function doNarrate() {
    if (!state) return;
    const bcMode = (state.bcCfg && state.bcCfg.aiBroadcast) || 'local';
    if (bcMode === 'off') { showToast('AI 口播已关闭（在 AI 播报面板里开启）'); return; }
    setNarStatus('生成中…');
    try {
      const r = await control(GAME, 'narrate', {}, { silent: true });
      if (r && r.ok) setNarStatus('已生成，朗读中…');
      else setNarStatus((r && r.msg) || '生成失败');
    } catch (e) { setNarStatus('生成失败'); }
  }

  /* ───────────── 状态 / 题目 / 答案 ───────────── */
  function renderStatus() {
    const stMap = {
      idle: '空闲',
      asking: `答题中（剩余 ${Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000))}s）`,
      revealed: '已揭晓',
      paused: '已暂停',
    };
    const extra = state.result
      ? ` · 答对 ${state.result.correctCount}/${state.result.answeredCount} 人`
      : (state.status === 'asking' ? ` · 已答 ${state.answeredCount} 人` : '');
    $('ctlStatus').textContent = `状态: ${stMap[state.status] || state.status}${extra} · 第 ${state.roundNo} 题`;
  }

  function renderQuestionAndAnswer() {
    if (state && state.question) {
      const q = state.question;
      let ans = '';
      if (state.status === 'revealed' && q.options[q.answerIndex]) {
        ans = `（正确答案：${q.options[q.answerIndex].label}）`;
      } else if (state.status === 'asking' && peek && peek.round === state.roundNo) {
        // 答题期：答案直接跟在题目后面（仅主播台可见，展示屏不会收到）
        ans = `（答案：${peek.label}）`;
      }
      const tags = [q.category, q.difficulty].filter(Boolean).join('·');
      $('ctlQuestion').textContent = `题目: ${q.q} ${ans}${tags ? ` · ${tags}` : ''}`;
    } else {
      $('ctlQuestion').textContent = '--';
    }
  }

  /** 新题出现时向服务端索取答案（silent：不弹 toast 打扰主播） */
  async function ensurePeek() {
    if (!state || state.status !== 'asking') return;
    const round = state.roundNo;
    if (peeking || round === lastPeekRound) return;
    peeking = true;
    try {
      const r = await control(GAME, 'peek', {}, { silent: true });
      lastPeekRound = round;
      // 宿主只转发 {ok,msg,state}，答案在 r.state 里
      const s = r && r.state;
      peek = (r && r.ok && s)
        ? { round: (s.roundNo != null ? s.roundNo : round), label: s.answerLabel, text: s.answerText }
        : null;
      renderQuestionAndAnswer();
    } catch (e) { /* 取答案失败不阻断主流程 */ } finally { peeking = false; }
  }

  /* ───────────── 题库多选下拉（分类 / 难度） ───────────── */

  let metaCounts = {}, metaCats = [], metaDiffs = [];   // 题库 counts 快照（供草稿态实时算命中数）

  /** 命中题数：优先按「当前勾选」实时算（未点应用配置也能预览），否则用服务端回算值 */
  function refreshTikuHint() {
    const h = $('msHint');
    if (!h) return;
    const total = (state && state.tikuMeta ? state.tikuMeta.total : 0) || 0;
    let matched;
    if (msCat || msDiff) {
      const cs = (msCat && msCat.get().length) ? msCat.get() : metaCats;
      const ds = (msDiff && msDiff.get().length) ? msDiff.get() : metaDiffs;
      matched = 0;
      for (const c of cs) for (const d of ds) matched += (metaCounts[`${c}_${d}`] || 0);
    } else {
      matched = (state && state.tikuMeta ? state.tikuMeta.matched : 0) || 0;
    }
    h.innerHTML = `当前命中 <b>${matched}</b> / ${total} 题`;
  }

  /**
   * 造一个多选下拉：按钮显示汇总文案，面板内是 checkbox，首行为「全部」。
   * 约定：选中数组为空 = 全部（与后端 filterPool 一致）。
   * optionsOf() 动态返回可选项 —— 用于级联（难度项随已选分类变化）。
   */
  function setupMulti(prefix, title, optionsOf, countOf, onChange) {
    const btn = $(prefix + 'Btn'), panel = $(prefix + 'Panel'), label = $(prefix + 'Label');
    if (!btn || !panel || !label) return null;
    let options = optionsOf();
    let sel = [];

    const render = () => {
      const rows = [`<label class="ms-row ms-all"><input type="checkbox" data-v="__all__"${sel.length ? '' : ' checked'}><span class="ms-nm">全部${esc(title)}</span></label>`];
      for (const o of options) {
        rows.push(`<label class="ms-row"><input type="checkbox" data-v="${esc(o)}"${sel.includes(o) ? ' checked' : ''}><span class="ms-nm">${esc(o)}</span><span class="ms-ct">${countOf(o)}</span></label>`);
      }
      panel.innerHTML = rows.join('');
      label.textContent = sel.length ? `${title}：${sel.join('、')}` : `全部${title}`;
      btn.title = label.textContent;   // 按钮较窄，hover 可看完整文案
    };

    panel.addEventListener('change', e => {
      const v = e.target.dataset.v;
      if (v === '__all__') sel = e.target.checked ? [] : options.slice();
      else {
        if (e.target.checked) { if (!sel.includes(v)) sel.push(v); }
        else sel = sel.filter(x => x !== v);
        if (sel.length === options.length) sel = [];   // 全勾即等于「全部」
      }
      render();
      if (onChange) onChange();
    });
    btn.addEventListener('click', ev => { ev.stopPropagation(); panel.classList.toggle('hidden'); });
    document.addEventListener('click', ev => {
      if (!panel.contains(ev.target) && !btn.contains(ev.target)) panel.classList.add('hidden');
    });

    render();
    return {
      get: () => sel.slice(),
      set: arr => {
        let next = (Array.isArray(arr) ? arr : []).filter(x => options.includes(x));
        if (next.length === options.length) next = [];
        sel = next;
        render();   // 总是重渲染：题数会随另一维度的选择变化
      },
      /** 级联刷新：按 optionsOf() 重建选项，丢弃已失效的选中项；返回是否发生变化 */
      rebuild: () => {
        const prev = options;
        options = optionsOf();
        const kept = sel.filter(x => options.includes(x));
        const changed = kept.length !== sel.length
          || options.length !== prev.length
          || options.some((x, i) => x !== prev[i]);
        sel = kept;
        render();   // 题数也会随另一维度变化，故总是重渲染（不只是选项变化时）
        return changed;
      },
    };
  }

  function buildTikuMultis() {
    const meta = (state && state.tikuMeta) || {};
    metaCats = meta.categories || [];
    metaDiffs = meta.difficulties || [];
    metaCounts = meta.counts || {};

    /**
     * 级联计数（faceted search）：
     *  - 某「难度」的题数 = 在已选分类下的题数（未选分类则按全部分类算）
     *  - 某「分类」的题数 = 在已选难度下的题数（未选难度则按全部难度算）
     * 这样难度下拉就是「针对前面所选分类的难度」，而不是全局难度。
     */
    const catCount = c => {
      const picked = msDiff ? msDiff.get() : [];
      const ds = picked.length ? picked : metaDiffs;
      return ds.reduce((n, d) => n + (metaCounts[`${c}_${d}`] || 0), 0);
    };
    const diffCount = d => {
      const picked = msCat ? msCat.get() : [];
      const cs = picked.length ? picked : metaCats;
      return cs.reduce((n, c) => n + (metaCounts[`${c}_${d}`] || 0), 0);
    };
    // 只保留在另一维度当前选择下「有题」的选项，避免选出 0 题的组合
    const catOptions = () => metaCats.filter(c => catCount(c) > 0);
    const diffOptions = () => metaDiffs.filter(d => diffCount(d) > 0);

    // 顺序：msCat 先建（diffCount 依赖它）；改分类后级联刷新难度，反之亦然
    msCat = setupMulti('msCat', '分类', catOptions, catCount, () => {
      if (msDiff) msDiff.rebuild();
      refreshTikuHint();
    });
    msDiff = setupMulti('msDiff', '难度', diffOptions, diffCount, () => {
      if (msCat) msCat.rebuild();
      refreshTikuHint();
    });
    refreshTikuHint();
  }

  /* ───────────── 配置表单（一次性生成 + 回填） ───────────── */
  function ensureCfgForm() {
    const box = $('cfgForm');
    if (!box || cfgFormBuilt) return;
    cfgFormBuilt = true;
    const c = state.cfg || {};
    const html = `
      <label>每题时长(秒) <input id="cfgInterval" type="number" min="5" value="${c.roundIntervalSec ?? 30}"></label>
      <label>揭晓停留(秒) <input id="cfgResult" type="number" min="3" value="${c.resultShowSec ?? 10}"></label>
      <label>答对基础分 <input id="cfgScore" type="number" min="1" value="${c.baseScorePerWin ?? 100}"></label>
      <label>剩余时间加成(%) <input id="cfgTimeBonus" type="number" min="0" step="10" value="${c.timeBonusPct ?? 100}"></label>
      <div class="cfg-break"></div>
      <label>连对加成(分/题) <input id="cfgStreak" type="number" min="0" value="${c.streakBonus ?? 30}"></label>
      <label>最快答对加成(分) <input id="cfgFastest" type="number" min="0" value="${c.fastestBonus ?? 50}"></label>
      <div class="cfg-break"></div>
      <label><input id="cfgAuto" type="checkbox" ${c.autoNextRound === false ? '' : 'checked'}> 自动出下一题</label>
      <label>题目来源
        <select id="cfgSource">
          <option value="bank" ${c.questionSource !== 'manual' ? 'selected' : ''}>题库随机</option>
          <option value="manual" ${c.questionSource === 'manual' ? 'selected' : ''}>手动出题</option>
        </select>
      </label>
      <div class="cfg-break"></div>
      <div class="cc-title">题库范围（不勾选 = 全部）</div>
      <div class="ms" id="msCatWrap">
        <button type="button" class="ms-btn" id="msCatBtn"><span class="ms-label" id="msCatLabel">全部分类</span><span class="ms-caret">▼</span></button>
        <div class="ms-panel hidden" id="msCatPanel"></div>
      </div>
      <div class="ms" id="msDiffWrap">
        <button type="button" class="ms-btn" id="msDiffBtn"><span class="ms-label" id="msDiffLabel">全部难度</span><span class="ms-caret">▼</span></button>
        <div class="ms-panel hidden" id="msDiffPanel"></div>
      </div>
      <div class="ms-hint" id="msHint">当前命中 <b>0</b> 题</div>
      <label>计分模式
        <select id="cfgMode">
          <option value="all-correct" ${c.mode !== 'first-correct' ? 'selected' : ''}>全员答对得分</option>
          <option value="first-correct" ${c.mode === 'first-correct' ? 'selected' : ''}>抢答(首中得分)</option>
        </select>
      </label>
      <label><input id="cfgShuffle" type="checkbox" ${c.shuffleOptions === false ? '' : 'checked'}> 选项乱序</label>
      <label><input id="cfgAllowChange" type="checkbox" ${c.allowChangeAnswer === false ? '' : 'checked'}> 允许改选答案（关闭后观众换选项将被禁止）</label>
      <label>发送间隔(秒) <input id="cfgRate" type="number" min="1" value="${c.rateLimitSec ?? 2}"></label>
      <label>答错扣分 <input id="cfgPenalty" type="number" min="0" value="${c.wrongPenalty ?? 0}"></label>
      <div class="cfg-break"></div>
      <label><input id="cfgHostAns" type="checkbox" ${c.hostShowAnswer === false ? '' : 'checked'}> 主播台显示答案（答题期）</label>
      <label><input id="cfgHideFeed" type="checkbox" ${c.hideAnswerFeed === false ? '' : 'checked'}> 展示屏隐藏作答明细（防提前泄题）</label>
      <div class="cfg-break"></div>
      <div class="cc-title">排除答案（点赞 / 礼物触发，给观众 50/50 提示）</div>
      <label><input id="cfgLikeElim" type="checkbox" ${c.likeEliminateEnabled === false ? '' : 'checked'}> 个人单局点赞达阈值排除一个答案</label>
      <label>个人点赞阈值(赞) <input id="cfgLikeAt" type="number" min="1" value="${c.likeEliminateAt ?? 20}"></label>
      <label><input id="cfgGiftElim" type="checkbox" ${c.giftEliminateEnabled === false ? '' : 'checked'}> 送礼物排除一个答案</label>
      <div class="cfg-break"></div>
      <label><input id="cfgFollowAsCorrect" type="checkbox" ${c.followAsCorrect === false ? '' : 'checked'}> 关注主播本题算答对</label>
      <label>关注计分冷却(小时) <input id="cfgFollowCd" type="number" min="1" value="${c.followCooldownHours ?? 21}"></label>
      <div class="cfg-hint">排除的一定是错误选项（正确答案永不排除）；被排除选项会在展示屏灰显标注「已排除」，观众再选它会被提示改选。单个观众本局点赞每达到阈值（含倍数）排除一个，展示屏实时显示其点赞进度；礼物每收到一次排除一个。</div>
      <div class="cfg-break"></div>
      <div class="cfg-hint">AI 口播配置已移到下方「🤖 AI 语音播报」面板（通用播报中心：生成方式 / 接口 / 逐点开关 / TTS 设置）。</div>
      <div class="cfg-break"></div>
      <div class="cc-title">手动出题（来源选「手动出题」时生效）</div>
      <label class="cfg-block">题干 <input id="cfgMQ" type="text" placeholder="例如：一年中有几个月有31天？"></label>
      <label class="cfg-block">选项（逗号或换行分隔）<input id="cfgMO" type="text" placeholder="6个月,7个月,8个月,9个月"></label>
      <label>正确序号(0起) <input id="cfgMA" type="number" min="0" value="0"></label>
      <div class="cfg-hint">切换「题目来源=手动出题」后点「应用配置」；也可直接点「立即出手动题」用当前填写的内容出题。</div>
      <button id="btnAskManual" class="btn secondary">立即出手动题</button>
      <button id="btnApplyCfg" class="btn secondary">应用配置</button>`;
    box.innerHTML = html;
    buildTikuMultis();
    $('cfgSource').addEventListener('change', () => {
      const manual = $('cfgSource').value === 'manual';
      $('cfgMQ').style.opacity = manual ? '1' : '0.5';
      $('cfgMO').style.opacity = manual ? '1' : '0.5';
    });
    bindControlEvents();
  }

  /** 回填动态配置值（仅非聚焦输入框，避免打断主播编辑） */
  function backfillCfg() {
    if (!state.cfg) return;
    const c = state.cfg;
    const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
    set('cfgInterval', c.roundIntervalSec);
    set('cfgResult', c.resultShowSec);
    set('cfgScore', c.baseScorePerWin);
    set('cfgTimeBonus', c.timeBonusPct);
    set('cfgStreak', c.streakBonus);
    set('cfgFastest', c.fastestBonus);
    setChk('cfgAllowChange', c.allowChangeAnswer !== false);
    set('cfgRate', c.rateLimitSec);
    set('cfgPenalty', c.wrongPenalty);
    set('cfgMA', c.manualAnswer ?? 0);
    const setChk = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.checked = !!v; };
    setChk('cfgHostAns', c.hostShowAnswer !== false);
    setChk('cfgHideFeed', c.hideAnswerFeed !== false);
    if (msCat) msCat.set(c.tikuCategories);
    if (msDiff) msDiff.set(c.tikuDifficulties);
    // 回填后按已保存的组合级联刷新：保证难度项是「所选分类下的难度」，题数也同步
    if (msDiff) msDiff.rebuild();
    if (msCat) msCat.rebuild();
    refreshTikuHint();
    if ($('cfgMQ') && document.activeElement !== $('cfgMQ')) $('cfgMQ').value = c.manualQuestion || '';
    if ($('cfgMO') && document.activeElement !== $('cfgMO')) $('cfgMO').value = c.manualOptions || '';
    // AI 口播配置已迁移到 DGBroadcast 面板（自行回填/提交）
    // 排除答案配置回填（setChk 在此作用域内已定义）
    setChk('cfgLikeElim', c.likeEliminateEnabled !== false);
    set('cfgLikeAt', c.likeEliminateAt);
    setChk('cfgGiftElim', c.giftEliminateEnabled !== false);
    setChk('cfgFollowAsCorrect', c.followAsCorrect !== false);
    set('cfgFollowCd', c.followCooldownHours);
  }

  function bindControlEvents() {
    $('btnNarrate').onclick = () => doNarrate();
    $('btnStart').onclick = () => control(GAME, 'start');
    $('btnPause').onclick = () => control(GAME, 'pause');
    $('btnResume').onclick = () => control(GAME, 'resume');
    $('btnReveal').onclick = () => control(GAME, 'reveal');
    $('btnNext').onclick = async () => {
      if (state && state.status === 'asking') await control(GAME, 'reveal');
      else await control(GAME, 'start');
    };
    $('btnAskManual').onclick = () => {
      control(GAME, 'setQuestion', {
        q: $('cfgMQ').value.trim(),
        options: $('cfgMO').value,
        answer: parseInt($('cfgMA').value, 10) || 0,
      });
    };
    $('btnApplyCfg').onclick = () => {
      const num = (id, def) => { const v = parseInt($(id).value, 10); return Number.isNaN(v) ? def : v; };
      const payload = {};
      payload.roundIntervalSec = num('cfgInterval', 30);
      payload.resultShowSec = num('cfgResult', 10);
      payload.baseScorePerWin = num('cfgScore', 100);
      payload.timeBonusPct = num('cfgTimeBonus', 100);
      payload.streakBonus = num('cfgStreak', 30);
      payload.fastestBonus = num('cfgFastest', 50);
      payload.allowChangeAnswer = $('cfgAllowChange').checked;
      payload.rateLimitSec = num('cfgRate', 2);
      payload.wrongPenalty = num('cfgPenalty', 0);
      payload.autoNextRound = $('cfgAuto').checked;
      payload.shuffleOptions = $('cfgShuffle').checked;
      payload.questionSource = $('cfgSource').value;
      payload.mode = $('cfgMode').value;
      payload.manualQuestion = $('cfgMQ').value.trim();
      payload.manualOptions = $('cfgMO').value;
      payload.manualAnswer = num('cfgMA', 0);
      payload.hostShowAnswer = $('cfgHostAns').checked;
      payload.hideAnswerFeed = $('cfgHideFeed').checked;
      payload.likeEliminateEnabled = $('cfgLikeElim').checked;
      payload.likeEliminateAt = num('cfgLikeAt', 20);
      payload.giftEliminateEnabled = $('cfgGiftElim').checked;
      payload.followAsCorrect = $('cfgFollowAsCorrect').checked;
      payload.followCooldownHours = num('cfgFollowCd', 21);
      payload.tikuCategories = msCat ? msCat.get() : [];
      payload.tikuDifficulties = msDiff ? msDiff.get() : [];
      // AI 口播配置由 DGBroadcast 面板自行提交（config 动作的 bc* / ai* 键）
      control(GAME, 'config', payload);
    };
  }

  /* ───────────── 最近出题 ───────────── */
  function renderHistory() {
    const hist = $('ctlHistory');
    hist.innerHTML = '';
    if (state.history && state.history.length) {
      state.history.slice(0, 20).forEach(r => {
        const row = document.createElement('div');
        row.className = 'half';
        row.innerHTML = `<span>#${r.roundNo}</span><span class="r-ans">${esc(r.q)}</span><span>${r.answeredCount ? r.correctCount + '/' + r.answeredCount + ' 答对' : '未答'}</span><span>${r.answer || ''}</span>`;
        hist.appendChild(row);
      });
    } else {
      hist.innerHTML = '<div>暂无历史</div>';
    }
  }

  /* ───────────── 接入与模拟（公共组件：直播间筛选 + 模拟观众套件） ─────────────
   * 答题竞猜额外支持「模拟关注」（关注主播本题算答对的调试）。 */
  roomFilter = DG.mountFeedTools($('ctlFeedTools'), GAME, {
    getRoomId: () => (state && state.cfg && state.cfg.allowedRoomId) || '',
    sim: { chat: { placeholder: '模拟答题（A/B/C/D 或 1/2/3/4）' }, like: { count: 10 }, gift: true, enter: false, follow: true },
  });

  /* ───────────── 通用 AI 语音播报面板（common broadcast.js） ───────────── */
  DGBroadcast.mountPanel($('bcPanel'), { game: GAME });
})();
