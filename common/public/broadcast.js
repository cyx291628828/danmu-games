/* ══════════════════════════════════════════════════════════════════
   broadcast.js — 通用 AI 语音播报 · 前端组件（common/public）
   所有游戏主播台共用：
     · 播报配置面板（生成方式 / 接口 / 逐播报点开关 / 播报记录）
     · 浏览器 TTS 朗读队列（语速·音高·音色存本机，一次设置全游戏通用）
     · 自动朗读：监听服务端 state.bc.seq 变化，收到新播报即朗读
   用法（各游戏 control.html）：
     <div id="bcPanel"></div>
     <script src="/common/broadcast.js"></script>
     // control.js 里：
     DGBroadcast.mountPanel(document.getElementById('bcPanel'), { game: GAME });
     DG.connectSSE(GAME, { onState: (_g, st) => { state = st; DGBroadcast.watch(st); } });
   ══════════════════════════════════════════════════════════════════ */
window.DGBroadcast = (() => {
  'use strict';

  const TTS_KEY = 'danmu_broadcast_tts';     // 语音设置：全局共享（一次设置，所有游戏通用）
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ───────────── 样式（自注入，游戏页面无需额外引 CSS） ───────────── */
  const CSS = `
.bc-panel{border:1px solid var(--line2);border-radius:10px;background:var(--panel2);padding:10px 12px;margin-top:10px}
.bc-head{font-size:13px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px;margin-bottom:8px}
.bc-head .bc-sub{font-size:11px;font-weight:400;color:var(--dim)}
.bc-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.bc-row:last-child{margin-bottom:0}
.bc-row label{font-size:12px;color:var(--sub);display:flex;align-items:center;gap:5px}
.bc-row input,.bc-row select{padding:4px 6px;border-radius:6px;font-size:12px;border:1px solid var(--line);background:var(--bg);color:var(--text)}
.bc-row input[type="text"],.bc-row input[type="password"]{min-width:150px}
.bc-row input[type="checkbox"]{width:auto}
.bc-row input[type="range"]{min-width:120px;accent-color:var(--accent)}
.bc-val{min-width:32px;text-align:right;color:var(--gold);font-size:12px;font-variant-numeric:tabular-nums}
.bc-slots{display:flex;flex-direction:column;gap:4px;margin:8px 0}
.bc-slot{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--sub);background:var(--cell-bg);border:1px solid var(--line2);border-radius:7px;padding:5px 8px}
.bc-slot .bc-slot-nm{flex:0 0 108px;color:var(--text);font-weight:600}
.bc-slot .bc-slot-ds{flex:1;min-width:0;color:var(--dim);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bc-log{display:flex;flex-direction:column;gap:3px;max-height:132px;overflow-y:auto;margin-top:6px}
.bc-log-item{font-size:11.5px;color:var(--sub);background:var(--cell-bg);border-radius:6px;padding:4px 8px;line-height:1.5}
.bc-log-item .bc-tag{color:var(--gold);font-weight:600;margin-right:6px}
.bc-log-item .bc-tm{color:var(--dim);font-size:10px;margin-right:6px}
.bc-hint{font-size:11px;color:var(--dim);line-height:1.6}
.bc-live{font-size:11px;color:var(--green);margin-left:auto}
`;
  function ensureCss() {
    if (document.getElementById('bcStyle')) return;
    const st = document.createElement('style');
    st.id = 'bcStyle';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ───────────── 语音设置（本机共享） ───────────── */
  function loadSettings() {
    const s = { rate: 1.05, pitch: 1, volume: 1, voice: '' };
    try {
      const raw = localStorage.getItem(TTS_KEY);
      if (raw) Object.assign(s, JSON.parse(raw));
    } catch (e) { /* 解析失败用默认 */ }
    s.rate = Math.min(2, Math.max(0.5, Number(s.rate) || 1.05));
    s.pitch = Math.min(2, Math.max(0, Number(s.pitch) || 1));
    s.volume = Math.min(1, Math.max(0, Number(s.volume) || 1));
    return s;
  }
  function saveSettings(s) {
    try { localStorage.setItem(TTS_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
  }
  function zhVoices() {
    const all = window.speechSynthesis && window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
    const zh = all.filter(v => /zh|cmn|Chinese/i.test(v.lang) || /Chinese|中文|普通话/i.test(v.name));
    return { all, list: zh.concat(all.filter(v => !zh.includes(v))) };
  }
  function pickVoice(name) {
    const { all } = zhVoices();
    if (!all.length) return null;
    if (name) {
      const hit = all.find(x => x.name === name) || all.find(x => x.voiceURI === name);
      if (hit) return hit;
    }
    return all.find(x => /zh|cmn|Chinese/i.test(x.lang) || /Chinese|中文|普通话/i.test(x.name)) || null;
  }

  /* ───────────── 朗读队列（一条播完再播下一条，绝不叠音） ───────────── */
  const queue = [];
  let speaking = false;
  let onSpeakHook = null;

  function enqueue(text, meta = {}) {
    if (!text) return;
    queue.push({ text, ...meta });
    pump();
  }
  function pump() {
    if (speaking || !queue.length) return;
    if (!('speechSynthesis' in window)) { queue.length = 0; return; }
    const item = queue.shift();
    const s = loadSettings();
    let u;
    try { u = new SpeechSynthesisUtterance(item.text); } catch (e) { return; }
    u.lang = 'zh-CN';
    u.rate = s.rate; u.pitch = s.pitch; u.volume = s.volume;
    const v = pickVoice(s.voice);
    if (v) u.voice = v;
    speaking = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      speaking = false;
      setTimeout(pump, 200);
    };
    u.onend = finish;
    u.onerror = finish;
    // 兜底看门狗：个别浏览器 onend 不触发时会卡死队列
    setTimeout(finish, Math.max(8000, item.text.length * 420));
    try {
      window.speechSynthesis.speak(u);
      if (onSpeakHook) onSpeakHook(item);
    } catch (e) { finish(); }
  }
  function stop() {
    queue.length = 0;
    try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    speaking = false;
  }

  /* ───────────── 面板 ───────────── */
  let panelEl = null, panelGame = '', lastSeq = -1, lastState = null;

  function renderSlots(slots, enabled) {
    const box = $('bcSlotList');
    if (!box) return;
    box.innerHTML = (slots || []).map(s => `
      <div class="bc-slot">
        <input type="checkbox" id="bcS_${esc(s.id)}" ${enabled[s.id] === false ? '' : 'checked'}>
        <span class="bc-slot-nm">${esc(s.label)}</span>
        <span class="bc-slot-ds">${esc(s.desc || '')}</span>
        <button class="btn tiny secondary" type="button" data-slot="${esc(s.id)}">试播</button>
      </div>`).join('');
    box.querySelectorAll('input[type="checkbox"]').forEach(chk => {
      chk.addEventListener('change', () => {
        // 一次提交全部开关，避免只传当前项时与服务端合并/回填不同步，表现为「像单选」
        const payload = { bcEnabled: {} };
        box.querySelectorAll('input[type="checkbox"]').forEach(c2 => {
          payload.bcEnabled[c2.id.slice(4)] = c2.checked;
        });
        sendConfig(panelGame, payload);
      });
    });
    box.querySelectorAll('button[data-slot]').forEach(btn => {
      btn.addEventListener('click', () => {
        fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'broadcast', game: panelGame, slot: btn.dataset.slot, force: true }),
        }).then(r => r.json()).then(j => { if (j && j.msg && window.DG && DG.showToast) DG.showToast(j.msg); })
          .catch(() => {});
      });
    });
  }

  function sendConfig(game, payload) {
    return fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'config', game, ...payload }),
    }).then(r => r.json()).then(j => {
      if (window.DG && DG.showToast && j && j.msg) DG.showToast(j.msg);
      return j;
    }).catch(() => null);
  }

  function renderLog(state) {
    const box = $('bcLogList');
    if (!box || !state || !state.bc) return;
    const log = state.bc.log || [];
    if (!log.length) { box.innerHTML = '<div class="bc-hint">暂无播报记录，点各播报点的「试播」可立即听效果。</div>'; return; }
    box.innerHTML = log.slice(0, 8).map(e => {
      const t = new Date(e.ts || Date.now());
      const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
      return `<div class="bc-log-item"><span class="bc-tm">${hm}</span><span class="bc-tag">${esc(e.slot || '')}</span>${esc(e.text || '')}</div>`;
    }).join('');
  }

  function backfill(state) {
    if (!state || !state.bcCfg) return;
    const c = state.bcCfg;
    const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
    const setChk = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.checked = !!v; };
    set('bcMode', c.aiBroadcast || 'local');
    setChk('bcAuto', c.bcAutoSpeak !== false);
    set('bcUrl', c.aiUrlMasked || '');
    set('bcModel', c.aiModel || '');
    set('bcTO', c.aiTimeoutSec || 8);
    const keyEl = $('bcKey');
    if (keyEl && document.activeElement !== keyEl) keyEl.placeholder = c.aiKeyConfigured ? '已配置（输入可覆盖）' : 'sk-...';
    if (state.bcSlots) {
      for (const s of state.bcSlots) {
        const el = $('bcS_' + s.id);
        if (el && document.activeElement !== el) {
          const v = c.bcEnabled ? c.bcEnabled[s.id] : undefined;
          // publicState 下发的是「计算后的完整开关表」；undefined 时按开处理（兼容旧数据）
          el.checked = v === undefined ? true : !!v;
        }
      }
    }
  }

  function fillVoices() {
    const sel = $('bcVoice');
    if (!sel) return;
    const { list } = zhVoices();
    if (!list.length) return;
    const cur = loadSettings().voice;
    let html = '<option value="">默认（自动选中文）</option>';
    for (const v of list) html += `<option value="${esc(v.name)}"${v.name === cur ? ' selected' : ''}>${esc(v.name)}（${esc(v.lang)}）</option>`;
    sel.innerHTML = html;
  }

  /** 挂载播报面板（各游戏控制台调用一次） */
  function mountPanel(mountEl, opts = {}) {
    if (!mountEl) return null;
    ensureCss();
    panelGame = opts.game || new URLSearchParams(location.search).get('game') || '';
    onSpeakHook = opts.onSpeak || null;
    mountEl.innerHTML = `
      <div class="bc-panel">
        <div class="bc-head">🔊 AI 语音播报
          <span class="bc-sub">通用模块 · 一次配置，所有游戏通用</span>
          <span class="bc-live" id="bcLive"></span>
        </div>
        <div class="bc-row">
          <label>生成方式
            <select id="bcMode">
              <option value="local">本地模板（推荐 · 离线可用）</option>
              <option value="api">AI 接口生成</option>
              <option value="off">关闭</option>
            </select>
          </label>
          <label><input type="checkbox" id="bcAuto"> 收到播报自动朗读</label>
          <button class="btn tiny secondary" type="button" id="bcStop">停止朗读</button>
          <button class="btn tiny" type="button" id="bcApply">应用语音配置</button>
        </div>
        <div class="bc-row">
          <label>接口地址 <input id="bcUrl" type="text" placeholder="https://api.openai.com/v1"></label>
          <label>模型 <input id="bcModel" type="text" placeholder="gpt-4o-mini"></label>
          <label>密钥 <input id="bcKey" type="password" placeholder="sk-..."></label>
          <label>超时(秒) <input id="bcTO" type="number" min="2" max="30"></label>
        </div>
        <div class="bc-row">
          <label>语速 <input id="bcRate" type="range" min="0.5" max="2" step="0.05"></label>
          <span class="bc-val" id="bcRateVal">1.05</span>
          <label>音高 <input id="bcPitch" type="range" min="0" max="2" step="0.05"></label>
          <span class="bc-val" id="bcPitchVal">1.00</span>
          <label>音色 <select id="bcVoice"><option value="">默认（自动选中文）</option></select></label>
          <button class="btn tiny secondary" type="button" id="bcTest">试听音色</button>
        </div>
        <div class="bc-slots" id="bcSlotList"></div>
        <div class="bc-hint">接口兼容 OpenAI /chat/completions（通义、DeepSeek、智谱等均可），失败自动回退本地模板；密钥仅保存在服务端，不出浏览器。语速/音高/音色保存在本机，全部游戏通用。播报点开关立即生效。</div>
        <div class="bc-log" id="bcLogList"></div>
      </div>`;

    const s = loadSettings();
    $('bcRate').value = s.rate; $('bcPitch').value = s.pitch;
    $('bcRateVal').textContent = Number(s.rate).toFixed(2);
    $('bcPitchVal').textContent = Number(s.pitch).toFixed(2);
    const persistVoice = () => {
      const cur = loadSettings();
      cur.rate = parseFloat($('bcRate').value);
      cur.pitch = parseFloat($('bcPitch').value);
      cur.voice = $('bcVoice').value || '';
      saveSettings(cur);
    };
    $('bcRate').addEventListener('input', () => { $('bcRateVal').textContent = Number($('bcRate').value).toFixed(2); persistVoice(); });
    $('bcPitch').addEventListener('input', () => { $('bcPitchVal').textContent = Number($('bcPitch').value).toFixed(2); persistVoice(); });
    $('bcVoice').addEventListener('change', persistVoice);
    fillVoices();
    if (window.speechSynthesis && 'onvoiceschanged' in window.speechSynthesis) window.speechSynthesis.onvoiceschanged = fillVoices;
    $('bcTest').onclick = () => speak('这是一段语音播报测试，主播可以调整语速、音高和音色。', { force: true });
    $('bcStop').onclick = () => { stop(); if (window.DG && DG.showToast) DG.showToast('已停止朗读'); };
    $('bcApply').onclick = () => {
      const p = {
        aiBroadcast: $('bcMode').value,
        aiModel: $('bcModel').value.trim(),
        aiTimeoutSec: parseInt($('bcTO').value, 10) || 8,
        bcAutoSpeak: $('bcAuto').checked,
      };
      const url = $('bcUrl').value.trim();
      if (url) p.aiApiUrl = url;                    // 留空 = 不覆盖
      const key = $('bcKey').value.trim();
      if (key) p.aiApiKey = key;                    // 留空 = 不覆盖（不回传明文）
      sendConfig(panelGame, p);
    };
    return { el: mountEl };
  }

  /**
   * 监听服务端状态：新播报 → 渲染记录 + 自动朗读。
   * 各游戏 onState 里调用一次即可。
   * @param {object} state 服务端 publicState
   * @param {object} opts { onBroadcast(bc) 自定义处理（如展示屏显示战报文案） }
   */
  function watch(state, opts = {}) {
    if (!state) return;
    lastState = state;
    backfill(state);
    if (state.bcSlots && !document.querySelector('.bc-slot')) {
      renderSlots(state.bcSlots, (state.bcCfg && state.bcCfg.bcEnabled) || {});
    }
    const bc = state.bc;
    if (!bc || !bc.seq || bc.seq === lastSeq) { renderLog(state); return; }
    lastSeq = bc.seq;
    renderLog(state);
    if (opts.onBroadcast) opts.onBroadcast(bc);
    const live = $('bcLive');
    if (live) {
      live.textContent = `● ${bc.slotLabel || '播报'} 朗读中`;
      setTimeout(() => { if (live.textContent.indexOf(bc.slotLabel || '') >= 0) live.textContent = ''; }, 4000);
    }
    // 自动朗读：受「自动朗读」总开关与「该播报点」开关双重控制
    const c = state.bcCfg || {};
    if (c.bcAutoSpeak === false) return;
    if (c.bcEnabled && bc.slot && c.bcEnabled[bc.slot] === false) return;
    speak(bc.text, { slot: bc.slot, label: bc.slotLabel });
  }

  /** 手动朗读一段文本（供各游戏「🔊 播报」按钮使用） */
  function speak(text, opts = {}) {
    if (!text) return;
    if (opts.force) {
      // 试听/手动播报：插队且打断当前朗读，避免排队等待
      stop();
      setTimeout(() => enqueue(text, opts), 30);
      return;
    }
    enqueue(text, opts);
  }

  return { mountPanel, watch, speak, stop, loadSettings, saveSettings, get queue() { return queue.slice(); } };
})();
