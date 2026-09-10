/* ══════════════════════════════════════════════════════════════════
   control.js — 语义猜词 · 主播台控制台逻辑（games/semantic/public）
   页面可独立打开，也可嵌在主播台框架 iframe 中（/control.html?game=semantic）
   ══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const { $, esc, showToast, control } = DG;

  const GAME = new URLSearchParams(location.search).get('game') || 'semantic';
  let state = null;
  let cfgFormBuilt = false;
  let roomFilter = null;

  /* 礼物选项（多选 chips；与 core.js 模拟送礼的礼物列表保持一致，可按需增删） */
  const GIFT_OPTIONS = ['小心心', '玫瑰', '抖音', '啤酒', '666', '人气票', '你最好看', '同心结', '美味烧鸡'];

  /** 渲染礼物多选 chips（checked = 已选名单） */
  function giftChips(checked = []) {
    const set = new Set(Array.isArray(checked) ? checked : []);
    return GIFT_OPTIONS.map(g =>
      `<label class="ms-chip${set.has(g) ? ' on' : ''}"><input type="checkbox" value="${esc(g)}"${set.has(g) ? ' checked' : ''}>${esc(g)}</label>`
    ).join('');
  }

  /** 读取一个多选 chips 容器的已选礼物 */
  function readGiftChips(id) {
    const box = $(id);
    return box ? [...box.querySelectorAll('input:checked')].map(i => i.value) : [];
  }

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
    renderAnswerAndTop();
    ensureCfgForm();
    backfillCfg();
    renderHistory();
  }

  /* ───────────── 状态/答案/热度 ───────────── */
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
    const model = state.model || {};
    const modelTxt = model.words
      ? ` · 词库 ${(model.words / 10000).toFixed(1)} 万 · 答案池 ${(model.pool / 10000).toFixed(1)} 万`
      : ' · 模型加载中…';
    $('ctlStatus').textContent = `状态: ${stMap[state.status] || state.status}${revealInfo} · 轮次 ${state.roundNo} · 已揭晓 ${state.stats.rounds} 轮 / 猜中 ${state.stats.wins} 次${modelTxt}`;
    // 本轮已猜词数与来源分解（弹幕 / 点赞 / 送礼）
    const gs = state.guessStats || {};
    const el = $('ctlGuessStats');
    if (el) {
      el.textContent = gs.total
        ? `本轮已猜：共 ${gs.total} 条（去重 ${gs.distinct} 词）｜ 弹幕 ${gs.chat || 0} · 点赞 ${gs.like || 0} · 送礼 ${gs.gift || 0}`
        : '本轮还没有人猜词';
    }
  }

  function renderAnswerAndTop() {
    // 答案（主播可见，请勿投屏）；揭晓前显示长度与首字提示
    const ansEl = $('ctlAnswer');
    if (state.answer) {
      const hint = state.answerHint ? `，首字「${state.answerHint}」已提示` : '';
      ansEl.textContent = `答案: ${state.answer}（请勿投屏）${hint}`;
    } else if (state.answerLen) {
      ansEl.textContent = `答案: ${'?'.repeat(state.answerLen)}（本轮竞猜中，请勿投屏）`;
    } else {
      ansEl.textContent = '--';
    }
    // 实时猜测榜（前 5；真实弹幕 / 礼物词🎁 / 点赞词👍 / 超远猜测❄ 同一榜单）
    const box = $('ctlTop');
    box.innerHTML = '';
    const list = state.guessBoard || [];
    if (!list.length) {
      box.innerHTML = '<div style="color:var(--dim);font-size:13px">暂无有效猜测</div>';
      return;
    }
    list.slice(0, 5).forEach((w, i) => {
      const row = document.createElement('div');
      row.className = 'ctl-clue';
      const src = w.source || (w.gift ? 'gift' : 'chat');
      const srcTag = src === 'gift' ? '🎁' : (src === 'like' ? '👍' : (w.oov ? '❄' : ''));
      const tags = srcTag + (w.count > 1 ? ` ×${w.count}` : '');
      row.innerHTML = `<span class="n">${i + 1}</span><span class="h">「${esc(w.raw || w.guess)}」${tags} ${esc(w.percentText)}%（${esc(w.user)}）</span>`;
      box.appendChild(row);
    });
  }

  /* ───────────── 配置表单（一次性生成 + 回填） ───────────── */
  function ensureCfgForm() {
    const box = $('cfgForm');
    if (!box || cfgFormBuilt) return;
    cfgFormBuilt = true;
    const c = state.cfg || {};
    box.innerHTML = `
      <div class="cc-title">局面与节奏</div>
      <label>每轮时长(秒) <input id="cfgInterval" type="number" min="30" value="${c.roundIntervalSec ?? 150}"></label>
      <label>揭晓停留(秒) <input id="cfgResult" type="number" min="3" value="${c.resultShowSec ?? 10}"></label>
      <label>猜中基础分 n <input id="cfgScore" type="number" min="1" value="${c.baseScorePerWin ?? 100}"></label>
      <label>关联度分上限 m <input id="cfgAssoc" type="number" min="0" value="${c.assocScoreMax ?? 50}"></label>
      <label><input id="cfgAuto" type="checkbox" ${c.autoNextRound === false ? '' : 'checked'}> 自动开下一轮</label>
      <div class="cfg-break"></div>
      <div class="cc-title">匹配与限频</div>
      <label>每人每轮上限 <input id="cfgQuota" type="number" min="1" value="${c.maxGuessesPerUserPerRound ?? 30}"></label>
      <label>发送间隔(秒) <input id="cfgRate" type="number" min="1" value="${c.rateLimitSec ?? 2}"></label>
      <div class="cfg-break"></div>
      <div class="cc-title">展示与提示</div>
      <label>答案字数
        <select id="cfgAnsLen">
          <option value="0" ${![2, 3, 4].includes(c.answerLen) ? 'selected' : ''}>不限</option>
          <option value="2" ${c.answerLen === 2 ? 'selected' : ''}>2 字</option>
          <option value="3" ${c.answerLen === 3 ? 'selected' : ''}>3 字</option>
          <option value="4" ${c.answerLen === 4 ? 'selected' : ''}>4 字</option>
        </select>
      </label>
      <label>词性提示(秒) <input id="cfgPosHint" type="number" min="-1" value="${c.posHintSec ?? 30}"></label>
      <div class="cc-title">礼物解锁</div>
      <label><input id="cfgFollow" type="checkbox" ${c.followUnlockFirst !== false ? 'checked' : ''}> 关注解锁首字（关注者头像挂展示屏首字格右上角）</label>
      <div class="ms-row">
        <span class="ms-name">提示词礼物</span>
        <div class="ms-chips" id="msWordHint">${giftChips(c.wordHintNames)}</div>
        <span class="ms-note">送任一勾选礼物随机出 N 个提示词；不选 = 任意礼物</span>
      </div>
      <label>随机提示词个数 <input id="cfgWordN" type="number" min="0" value="${c.wordHintCount ?? 3}"></label>
      <label>每 N 赞解锁 1 词 <input id="cfgLikeN" type="number" min="0" value="${c.wordHintPerLikes ?? 50}"></label>
      <label class="cfg-pair">提示词名次从 <input id="cfgRankFrom" type="number" min="1" value="${c.wordHintRankFrom ?? 2}"> 到 <input id="cfgRankTo" type="number" min="3" value="${c.wordHintRankTo ?? 30}"></label>
      <div class="cfg-hint">提示词名次区间：在第 N 名~第 M 名之间随机抽。送礼随机下限可为 1（含答案本身）；点赞随机下限固定不低于 10（防太贴答案）。名次越小越近义，越大越偏相关词。</div>
      <div class="cfg-hint">答案字数：随机谜底按字数抽取（2/3/4 字，不限=混合）；自定义谜底不受此限制。</div>
      <div class="cfg-hint">词性提示：开题后第 N 秒公布答案词性（名词/动词/形容词，字面规则近似判定，-1 = 不提示）。</div>
      <div class="cfg-hint">首字提示：开启「关注解锁首字」后，竞猜期内任一观众关注主播即公布答案首字，关注者头像会挂在展示屏首字格右上角。</div>
      <div class="cfg-hint">随机提示词：送出任一勾选礼物即随机公布 N 个与答案语义最近的提示词（以送礼者名义上预测榜，30 秒内多次送礼只触发一次；0 = 关闭）。点赞解锁：本轮全直播间每累计 N 个赞随机解锁 1 个提示词（以主贡献者名义上榜），进度显示在展示屏排行榜上方；0 = 关闭。</div>
      <div class="cfg-hint">结算规则：猜中者 + n + m 分；揭晓时按实时榜前 10 行扫描，最多给 6 个未拿分玩家各加 m×关联度%/100 分（同词多人合并为一行，首个发现者占行；词库外超远猜测不参与结算）。</div>
      <div class="cfg-hint">弹幕超过 4 个字不进入游戏（视为普通聊天）。词库内的词按语义相似度计分；词库外的词自动拆词合成（如「卡了」=卡+了），拆不出来的按「超远猜测」上墙（第10000+名 · 随机 1~10%）。</div>
      <button id="btnApplyCfg" class="btn secondary">应用配置</button>`;
    // 礼物多选 chips：点击切换选中态
    box.querySelectorAll('.ms-chip input').forEach(input => {
      input.addEventListener('change', () => input.closest('.ms-chip').classList.toggle('on', input.checked));
    });
    bindControlEvents();
  }

  /** 回填动态配置值（仅非聚焦输入框，避免打断主播编辑） */
  function backfillCfg() {
    if (!state.cfg || !cfgFormBuilt) return;
    const map = [['cfgRate', 'rateLimitSec'], ['cfgPosHint', 'posHintSec'], ['cfgWordN', 'wordHintCount'], ['cfgLikeN', 'wordHintPerLikes'], ['cfgRankFrom', 'wordHintRankFrom'], ['cfgRankTo', 'wordHintRankTo'], ['cfgAssoc', 'assocScoreMax']];
    for (const [id, key] of map) {
      const el = $(id);
      if (el && document.activeElement !== el && state.cfg[key] !== undefined) el.value = state.cfg[key];
    }
    if (state.cfg.answerLen !== undefined) {
      const el = $('cfgAnsLen');
      if (el && document.activeElement !== el) el.value = String(state.cfg.answerLen);
    }
    syncGiftChips('msWordHint', state.cfg.wordHintNames);
  }

  /** 礼物 chips 与服务端名单对齐（不打断正在编辑的控件） */
  function syncGiftChips(id, names) {
    if (names === undefined) return;
    const box = $(id);
    if (!box) return;
    const set = new Set(Array.isArray(names) ? names : []);
    box.querySelectorAll('.ms-chip').forEach(chip => {
      const input = chip.querySelector('input');
      const on = set.has(input.value);
      if (document.activeElement !== input && input.checked !== on) input.checked = on;
      chip.classList.toggle('on', input.checked);
    });
  }

  function bindControlEvents() {
    $('btnStart').onclick = () => control(GAME, 'start');
    $('btnStartWord').onclick = () => {
      const w = $('customWord').value.trim();
      if (!w) { showToast('请先输入自定义谜底词'); return; }
      control(GAME, 'start', { word: w });
    };
    $('btnPause').onclick = () => control(GAME, 'pause');
    $('btnResume').onclick = () => control(GAME, 'resume');
    $('btnReveal').onclick = () => control(GAME, 'reveal');
    $('btnNext').onclick = async () => {
      if (state && state.status === 'gambling') await control(GAME, 'reveal');
      else await control(GAME, 'start');
    };
    $('btnApplyCfg').onclick = () => {
      const num = (id, def) => { const v = parseInt($(id).value, 10); return Number.isNaN(v) ? def : v; };
      control(GAME, 'config', {
        roundIntervalSec: num('cfgInterval', 150),
        resultShowSec: num('cfgResult', 10),
        baseScorePerWin: num('cfgScore', 100),
        assocScoreMax: num('cfgAssoc', 50),
        rateLimitSec: num('cfgRate', 2),
        maxGuessesPerUserPerRound: num('cfgQuota', 30),
        autoNextRound: $('cfgAuto').checked,
        answerLen: parseInt($('cfgAnsLen').value, 10) || 0,
        posHintSec: num('cfgPosHint', 30),
        followUnlockFirst: $('cfgFollow').checked,
        wordHintNames: readGiftChips('msWordHint'),
        wordHintCount: num('cfgWordN', 3),
        wordHintPerLikes: num('cfgLikeN', 50),
        wordHintRankFrom: num('cfgRankFrom', 2),
        wordHintRankTo: num('cfgRankTo', 30),
      });
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
        row.innerHTML = `<span>#${r.roundNo}</span><span class="r-ans">${esc(r.answer)}</span><span>${r.winner ? esc(r.winner) : '无人猜中'}</span><span>${r.winnerScore ? '+' + r.winnerScore + ' 分' : ''}</span>`;
        hist.appendChild(row);
      });
    } else {
      hist.innerHTML = '<div>暂无历史</div>';
    }
  }

  /* ───────────── 接入与模拟（公共组件：直播间筛选 + 模拟观众套件） ───────────── */
  roomFilter = DG.mountFeedTools($('ctlFeedTools'), GAME, {
    getRoomId: () => (state && state.cfg && state.cfg.allowedRoomId) || '',
    sim: { chat: { placeholder: '模拟猜词（如：老师 或 猜老师）' }, like: { count: 10 }, gift: true, enter: true },
  });

  /* ───────────── 通用 AI 语音播报面板（common broadcast.js） ───────────── */
  DGBroadcast.mountPanel($('bcPanel'), { game: GAME });
})();
