/* ══════════════════════════════════════════════════════════════════
   control.js — 猜数字 · 主播台控制台逻辑（games/guess/public）
   页面可独立打开，也可嵌在主播台框架 iframe 中（/control.html?game=guess）
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, showToast, control } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'guess';
  let state = null;
  let cfgFormBuilt = false;
  let roomFilter = null;

  /* ───────────── SSE（只订阅本游戏） ───────────── */
  DG.connectSSE(GAME, {
    onState: (_gid, st) => { state = st; render(); },
    onNotice: (_gid, n) => { if (n && n.text) showToast(n.text); },
    onError: () => showToast('与游戏服务断连，正在重试…'),
  });

  function render() {
    if (!state) return;
    if (roomFilter) roomFilter.refresh();
    DGBroadcast.watch(state);   // 通用播报：bc.seq 自增 → 自动朗读 + 渲染播报记录
    renderStatus();
    renderAnswerAndClues();
    ensureCfgForm();
    backfillCfg();
    renderClueCond();
    renderClueProgress();
    renderHistory();
  }

  /* ───────────── 线索出现条件（按服务端 clueCondModes 动态渲染） ─────────────
     新增条件类型只需改服务端 CLUE_COND_MODES，这里会自动长出下拉选项，无需改 UI。 */
  function condModes() {
    return (state && state.clueCondModes) || [{ id: 'time', label: '按时间', unit: '秒', min: 0 }];
  }

  function buildClueCondRows() {
    const box = $('clueCondBox');
    if (!box) return;
    const modes = condModes();
    const conds = (state && state.clueCond) || [];
    const n = (state.cfg && state.cfg.digitCount) || 4;
    box.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const c = conds[i] || { mode: modes[0].id, value: 0 };
      const row = document.createElement('div');
      row.className = 'cc-row';
      row.innerHTML =
        `<span class="cc-label">第${i + 1}条</span>` +
        `<select id="ccMode${i}">${modes.map(m => `<option value="${m.id}"${m.id === c.mode ? ' selected' : ''}>${m.label}</option>`).join('')}</select>` +
        `<input id="ccVal${i}" type="number" value="${c.value}">` +
        `<span class="cc-unit" id="ccUnit${i}"></span>`;
      box.appendChild(row);
      $('ccMode' + i).addEventListener('change', () => syncClueCondRow(i));
      syncClueCondRow(i);
    }
  }

  /** 按所选模式切换单位与数值框显隐（never 时不需要数值） */
  function syncClueCondRow(i) {
    const modes = condModes();
    const sel = $('ccMode' + i), val = $('ccVal' + i), unit = $('ccUnit' + i);
    if (!sel || !val || !unit) return;
    const def = modes.find(m => m.id === sel.value) || modes[0];
    const hide = def.id === 'never';
    val.style.display = hide ? 'none' : '';
    unit.style.display = hide ? 'none' : '';
    unit.textContent = def.unit || '';
    if (typeof def.min === 'number') val.min = def.min;
  }

  /** 回填服务端下发的最新条件（不打断正在编辑的控件） */
  function renderClueCond() {
    const box = $('clueCondBox');
    if (!box) return;
    const n = (state.cfg && state.cfg.digitCount) || 4;
    // 行数变化（如切换 3/4 位）时整块重建
    if (box.children.length !== n) { buildClueCondRows(); return; }
    const conds = state.clueCond || [];
    conds.forEach((c, i) => {
      const sel = $('ccMode' + i), val = $('ccVal' + i);
      if (sel && document.activeElement !== sel && sel.value !== c.mode) sel.value = c.mode;
      if (val && document.activeElement !== val && String(val.value) !== String(c.value)) val.value = c.value;
      syncClueCondRow(i);
    });
  }

  /** 本轮实时进度：帮助判断阈值定得合不合理 */
  function renderClueProgress() {
    const el = $('clueCondProgress');
    if (!el) return;
    let sec = 0;
    if (state.status === 'gambling' && state.deadline) {
      const total = (state.cfg && state.cfg.roundIntervalSec) || 120;
      sec = Math.max(0, Math.round((total * 1000 - (state.deadline - Date.now())) / 1000));
    }
    const likes = state.roundLikes || 0;
    const shown = (state.clueShown || []).filter(Boolean).length;
    el.textContent = `本轮进度：已开 ${sec} 秒 · 已收到 ${likes} 次点赞 · 已出现 ${shown} 条线索`;
  }
  setInterval(renderClueProgress, 1000);

  /* ───────────── 状态/答案/线索 ───────────── */
  function renderStatus() {
    const stMap = {
      idle: '空闲',
      gambling: `竞猜中（剩余 ${Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000))}s）`,
      revealed: '已揭晓',
      paused: '已暂停',
    };
    const revealInfo = state.winner
      ? ` · 获胜: ${state.winner.name} (+${state.winner.score} 分)`
      : (state.status === 'revealed' ? ' · 无人猜中' : '');
    $('ctlStatus').textContent = `状态: ${stMap[state.status] || state.status}${revealInfo} · 轮次 ${state.roundNo} · 已揭晓 ${state.stats.rounds} 轮 / 猜中 ${state.stats.wins} 次`;
  }

  function renderAnswerAndClues() {
    if (state.puzzle) {
      $('ctlAnswer').textContent = `答案: ${state.answerFmt}（请勿投屏）`;
      const box = $('ctlClues');
      box.innerHTML = '';
      state.puzzle.clues.forEach((c, i) => {
        const row = document.createElement('div');
        row.className = 'ctl-clue';
        row.innerHTML = `<span class="n">${c.numFmt}</span><span class="h">线索${i + 1}: ${c.hint}</span>`;
        box.appendChild(row);
      });
    } else {
      $('ctlAnswer').textContent = '--';
      $('ctlClues').innerHTML = '';
    }
  }

  /* ───────────── 配置表单（一次性生成 + 回填） ───────────── */
  function ensureCfgForm() {
    const box = $('cfgForm');
    if (!box || cfgFormBuilt) return;
    cfgFormBuilt = true;
    const c = state.cfg || {};
    const html = `
      <div class="cc-title">局面与节奏</div>
      <label>每轮时长(秒) <input id="cfgInterval" type="number" min="10" value="${c.roundIntervalSec ?? 120}"></label>
      <label>揭晓停留(秒) <input id="cfgResult" type="number" min="3" value="${c.resultShowSec ?? 10}"></label>
      <label>猜中基础分 <input id="cfgScore" type="number" min="1" value="${c.baseScorePerWin ?? 100}"></label>
      <label><input id="cfgAuto" type="checkbox" ${c.autoNextRound === false ? '' : 'checked'}> 自动开下一轮</label>
      <div class="cfg-break"></div>
      <div class="cc-title">匹配与限频</div>
      <label>匹配模式
        <select id="cfgPattern">
          <option value="loose" ${c.guessPattern !== 'strict' ? 'selected' : ''}>宽松（1234 / 猜1234）</option>
          <option value="strict" ${c.guessPattern === 'strict' ? 'selected' : ''}>严格（仅猜1234）</option>
        </select>
      </label>
      <label>答案位数
        <select id="cfgDigits">
          <option value="4" ${c.digitCount !== 3 ? 'selected' : ''}>4 位（标准）</option>
          <option value="3" ${c.digitCount === 3 ? 'selected' : ''}>3 位（简单）</option>
        </select>
      </label>
      <label>每人每轮上限 <input id="cfgQuota" type="number" min="1" value="${c.maxGuessesPerUserPerRound ?? 20}"></label>
      <label>发送间隔(秒) <input id="cfgRate" type="number" min="1" value="${c.rateLimitSec ?? 2}"></label>
      <label><input id="cfgLeadingZero" type="checkbox" ${c.answerLeadingZero ? 'checked' : ''}> 允许首位为 0</label>
      <div class="cfg-break"></div>
      <div class="cc-title">答案揭示（翻牌时间）</div>
      <label>第1位出现(秒) <input id="cfgR0" type="number" min="-1" value="${(c.answerRevealSec && c.answerRevealSec[0]) ?? 0}"></label>
      <label>第2位出现(秒) <input id="cfgR1" type="number" min="-1" value="${(c.answerRevealSec && c.answerRevealSec[1]) ?? 25}"></label>
      <label>第3位出现(秒) <input id="cfgR2" type="number" min="-1" value="${(c.answerRevealSec && c.answerRevealSec[2]) ?? 50}"></label>
      <label id="cfgR3Wrap">第4位出现(秒) <input id="cfgR3" type="number" min="-1" value="${(c.answerRevealSec && c.answerRevealSec[3]) ?? 75}"></label>
      <div class="cfg-hint">答案数字出现时间：开题后第 N 秒揭晓该位数字；-1 = 永不出现（揭晓才显示）；0 = 开局立即出现</div>
      <div class="cfg-hint">答案数字与线索提示是两条独立轴：上方控制「答案各位数字」的翻牌时间，下方控制「线索卡」的出现条件。</div>
      <div class="cfg-break"></div>
      <div class="cc-title">线索出现条件</div>
      <div class="clue-cond-box" id="clueCondBox"></div>
      <div class="cc-progress" id="clueCondProgress"></div>
      <div class="cfg-hint">每条线索独立设置触发方式。按时间 = 开题后第 N 秒；按点赞数 = 本轮累计点赞达 N 次（每轮重置）；永不出现 = 卡片显示「暂无」。</div>
      <button id="btnApplyCfg" class="btn secondary">应用配置</button>`;
    box.innerHTML = html;
    // 位数联动：3 位隐藏第 4 位出现时间
    $('cfgDigits').addEventListener('change', () => {
      const dg = parseInt($('cfgDigits').value, 10) === 3 ? 3 : 4;
      if ($('cfgR3Wrap')) $('cfgR3Wrap').style.display = dg === 3 ? 'none' : '';
    });
    bindControlEvents();
  }

  /** 回填动态配置值（仅非聚焦输入框，避免打断主播编辑） */
  function backfillCfg() {
    if (!state.cfg) return;
    if (state.cfg.digitCount) {
      const dg = state.cfg.digitCount === 3 ? 3 : 4;
      if ($('cfgDigits').value !== String(dg)) $('cfgDigits').value = String(dg);
      if ($('cfgR3Wrap')) $('cfgR3Wrap').style.display = dg === 3 ? 'none' : '';
    }
    if (Array.isArray(state.cfg.answerRevealSec)) {
      state.cfg.answerRevealSec.forEach((v, i) => {
        const el = $('cfgR' + i);
        if (el && document.activeElement !== el) el.value = (v == null || v < 0) ? -1 : v;
      });
    }
    if (state.cfg.rateLimitSec !== undefined) {
      const el = $('cfgRate');
      if (el && document.activeElement !== el) el.value = state.cfg.rateLimitSec;
    }
  }

  function bindControlEvents() {
    $('btnStart').onclick = () => control(GAME, 'start');
    $('btnPause').onclick = () => control(GAME, 'pause');
    $('btnResume').onclick = () => control(GAME, 'resume');
    $('btnReveal').onclick = () => control(GAME, 'reveal');
    $('btnNext').onclick = async () => {
      if (state && state.status === 'gambling') await control(GAME, 'reveal');
      else await control(GAME, 'start');
    };
    $('btnApplyCfg').onclick = () => {
      const num = (id, def) => { const v = parseInt($(id).value, 10); return Number.isNaN(v) ? def : v; };
      const payload = {};
      payload.roundIntervalSec = num('cfgInterval', 120);
      payload.resultShowSec = num('cfgResult', 10);
      payload.baseScorePerWin = num('cfgScore', 100);
      payload.rateLimitSec = num('cfgRate', 2);
      payload.maxGuessesPerUserPerRound = num('cfgQuota', 20);
      payload.autoNextRound = $('cfgAuto').checked;
      payload.guessPattern = $('cfgPattern').value;
      const dg = parseInt($('cfgDigits').value, 10) === 3 ? 3 : 4;
      payload.digitCount = dg;
      payload.answerRevealSec = [num('cfgR0', 0), num('cfgR1', 25), num('cfgR2', 50), num('cfgR3', 75)].slice(0, dg);
      // 线索出现条件：每条 { mode, value }，由动态生成的选择器读取
      const conds = [];
      for (let i = 0; i < dg; i++) {
        const modeEl = $('ccMode' + i), valEl = $('ccVal' + i);
        const mode = modeEl ? modeEl.value : 'time';
        const v = valEl ? parseInt(valEl.value, 10) : 0;
        conds.push({ mode, value: Number.isNaN(v) ? 0 : v });
      }
      payload.clueCond = conds;
      payload.answerLeadingZero = $('cfgLeadingZero').checked;
      control(GAME, 'config', payload);
    };
  }

  /* ───────────── 最近揭晓 ───────────── */
  function renderHistory() {
    const hist = $('ctlHistory');
    hist.innerHTML = '';
    if (state.lastAnswers && state.lastAnswers.length) {
      state.lastAnswers.slice(0, 20).forEach(r => {
        const row = document.createElement('div');
        row.className = 'half';
        row.innerHTML = `<span>#${r.roundNo}</span><span class="r-ans">${r.answer}</span><span>${r.winner ? esc(r.winner) : '无人猜中'}</span><span>${r.winnerScore ? '+' + r.winnerScore + ' 分' : ''}</span>`;
        hist.appendChild(row);
      });
    } else {
      hist.innerHTML = '<div>暂无历史</div>';
    }
  }

  /* ───────────── 接入与模拟（公共组件：直播间筛选 + 模拟观众套件） ───────────── */
  roomFilter = DG.mountFeedTools($('ctlFeedTools'), GAME, {
    getRoomId: () => (state && state.cfg && state.cfg.allowedRoomId) || '',
    sim: { chat: { placeholder: '模拟猜数（如 1234 或 猜1234）' }, like: { count: 1 }, gift: false, enter: false },
  });

  /* ───────────── 通用 AI 语音播报面板（common broadcast.js） ───────────── */
  DGBroadcast.mountPanel($('bcPanel'), { game: GAME });
})();
