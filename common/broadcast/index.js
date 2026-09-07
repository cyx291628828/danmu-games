/**
 * ============================================================================
 * common/broadcast/index.js — 通用 AI 语音播报中心（服务端）
 * ============================================================================
 * 【定位】弹幕游戏中心所有「AI 语音播报」的唯一公共后端。任何游戏（现在已接入的
 *   quiz / redblue / race / guess / chengyu / sudoku，以及未来所有新游戏）只要注册几个
 *   「播报点」，就能拥有：本地模板播报、大模型播报、主播台自动朗读、播报记录、逐点开关。
 *
 * 【它不管什么】不决定播报文案。每段播报说什么话，由各游戏在 slot 里自己写
 *   （system prompt + 本地模板），本模块只负责「调度 + 生成 + 下发」。
 *
 * 【数据流】
 *   游戏逻辑 ──speak('slotId', data)──► 播报中心
 *       ├─ 本地模板 slot.local(data)             （aiBroadcast='local'）
 *       ├─ 大模型 generateText(prompt, cfg)      （aiBroadcast='api'，失败自动回退本地）
 *       └─ 结果写入 state.bc → emit() → SSE → 主播台 TTS 朗读 / 展示屏显示
 *
 * 【接入姿势】（各游戏 index.js，约 10 行）
 *   const { createBroadcaster, BC_CFG_DEFAULTS, BC_CFG_KEYS } = require('../../common/broadcast');
 *   const BC = createBroadcaster({
 *     gameId: 'race', gameName: '赛马竞猜',
 *     slots: require('./slots'),
 *     getCfg: () => cfg, getState: () => state, emit: () => emit.state(), log: ctx.log,
 *   });
 *   // 1) CFG_DEFAULTS 里展开：            ...BC_CFG_DEFAULTS
 *   // 2) handleAction 'config' 白名单：   ...BC_CFG_KEYS
 *   // 3) handleAction 里加一行：          case 'broadcast': return BC.control(payload);
 *   // 4) publicState 里展开：             ...BC.publicState()
 *   // 5) 业务点调用：                     BC.speak('finish', { winner: '黑珍珠', ... });
 *
 * 【配置字段】（存各游戏自己的 cfg，密钥只存服务端、绝不下发前端）
 *   aiBroadcast  'off' | 'local' | 'api'
 *   aiApiUrl / aiApiKey / aiModel / aiTimeoutSec
 *   bcAutoSpeak  bool   主播台是否自动朗读（关闭则只显示文字）
 *   bcEnabled    { slotId: bool }  逐播报点开关（缺省取 slot.def）
 * ============================================================================
 */
'use strict';

const { generateText } = require('../ai-broadcast');

/* ═══════════════ 配置默认值 / 白名单键 ═══════════════
   各游戏在 CFG_DEFAULTS 与 handleAction('config') 白名单里直接展开这两个常量，
   新增播报相关配置项时改这里，所有已接入的游戏一起生效。 */

const BC_CFG_DEFAULTS = {
  aiBroadcast: 'local',        // off=关闭 local=本地模板 api=大模型（失败自动回退 local）
  aiApiUrl: '',                // 如 https://api.openai.com/v1（仅根地址）
  aiApiKey: '',                // 服务端保存，绝不下发前端
  aiModel: 'gpt-4o-mini',
  aiTimeoutSec: 8,
  bcAutoSpeak: true,           // 主播台收到播报后是否自动朗读
  bcEnabled: {},               // { slotId: bool }，缺省取 slot.def
};

/** 播报相关配置键（handleAction 'config' 的白名单片段） */
const BC_CFG_KEYS = Object.keys(BC_CFG_DEFAULTS);

const DEFAULT_SYSTEM = '你是直播间弹幕游戏的解说员，风格热血、简短、有梗。根据给出的对局数据写一段60字以内的中文口播，只输出口播内容本身，不要任何前缀、引号或解释。';

/**
 * 创建播报中心实例（每个游戏一个）
 *
 * @param {object} opts
 * @param {string} opts.gameId    游戏 id（日志前缀）
 * @param {string} opts.gameName  游戏名（日志/默认 prompt 用）
 * @param {Array}  opts.slots     播报点定义，每项：
 *        { id, label, desc, def=true, minGapSec=0, system, buildUser(data)->string, local(data)->string }
 * @param {()=>object} opts.getCfg    取当前游戏 cfg
 * @param {()=>object} opts.getState  取当前游戏 state（播报结果写入 state.bc）
 * @param {()=>void}   opts.emit      状态变更推送（通常 emit.state）
 * @param {(level,...a)=>void} opts.log 日志函数
 */
function createBroadcaster(opts = {}) {
  const {
    gameId = 'game', gameName = '', slots = [],
    getCfg = () => ({}), getState = () => ({}), emit = () => {}, log = () => {},
  } = opts;

  const byId = new Map();
  for (const s of slots) if (s && s.id) byId.set(s.id, s);
  const lastAt = new Map();   // slotId -> 上次实际播报时间戳（minGapSec 限流用）

  /** 当前播报模式（'off' | 'local' | 'api'） */
  function mode() {
    const c = getCfg() || {};
    return c.aiBroadcast || 'local';
  }

  /** 是否已配置大模型（只影响前端提示，不影响可用性：未配置时 local 模式照常工作） */
  function apiReady() {
    const c = getCfg() || {};
    return !!(c.aiApiUrl && c.aiApiKey && c.aiModel);
  }

  /** 某个播报点当前是否开启 */
  function slotEnabled(id) {
    const c = getCfg() || {};
    if ((c.aiBroadcast || 'local') === 'off') return false;
    const s = byId.get(id);
    const def = !s || s.def !== false;
    const v = c.bcEnabled ? c.bcEnabled[id] : undefined;
    return v === undefined ? def : !!v;
  }

  /**
   * 只生成文本，不写入 state、不推送（用于把播报嵌入其它内容，如结算卡文案）。
   * 永不抛错；关闭/无模板时返回空串。
   */
  async function generate(id, data = {}) {
    const s = byId.get(id);
    if (!s) return '';
    const cfg = getCfg() || {};
    const local = () => {
      try { return s.local ? String(s.local(data) || '').trim() : ''; }
      catch (e) { log('WARN', `[bc:${gameId}] ${id} 本地模板异常:`, e.message); return ''; }
    };
    try {
      if (mode() === 'off') return '';
      if (mode() !== 'api') return local();
      const messages = [
        { role: 'system', content: s.system || DEFAULT_SYSTEM },
        { role: 'user', content: String((s.buildUser ? s.buildUser(data) : JSON.stringify(data)) || '') },
      ];
      const text = await generateText(messages, cfg, local);
      return String(text || '').trim();
    } catch (e) {
      log('WARN', `[bc:${gameId}] ${id} 生成异常:`, e.message);
      return local();
    }
  }

  /**
   * 生成并播报：写入 state.bc（seq 自增 → 主播台据此朗读）、追加播报记录、推送状态。
   * @param {string} id 播报点 id
   * @param {object} data 传给模板/prompt 的数据
   * @param {object} opts { force: true 可绕过开关与限流（主播台「试播」用） }
   * @returns {Promise<string>} 实际播报文本（空串=未播报）
   */
  async function speak(id, data = {}, o = {}) {
    const s = byId.get(id);
    if (!s) return '';
    if (!o.force && !slotEnabled(id)) return '';

    // 限流：同一播报点在 minGapSec 内只播一次（高频事件如「冲刺」「点赞助力」用）
    const now = Date.now();
    const gap = Number(s.minGapSec) || 0;
    if (!o.force && gap > 0) {
      const t = lastAt.get(id) || 0;
      if (now - t < gap * 1000) return '';
    }

    const text = await generate(id, data);
    if (!text) return '';
    lastAt.set(id, now);
    push(id, text);
    return text;
  }

  /**
   * 直接把「已生成好的文本」推入播报通道（不重新生成）。
   * 用于「文案要同时显示在界面上（如结算战报卡）又要朗读」的场景 —— 只调一次大模型。
   */
  function push(id, text) {
    const s = byId.get(id);
    const body = String(text || '').trim();
    if (!body) return '';
    const now = Date.now();
    const st = getState() || {};
    if (!st.bc || typeof st.bc !== 'object') st.bc = { seq: 0, log: [] };
    if (!Array.isArray(st.bc.log)) st.bc.log = [];
    st.bc.seq = (st.bc.seq || 0) + 1;
    st.bc.slot = id;
    st.bc.slotLabel = (s && s.label) || id;
    st.bc.text = body;
    st.bc.ts = now;
    st.bc.log.unshift({ id, slot: (s && s.label) || id, text: body, ts: now });
    if (st.bc.log.length > 12) st.bc.log.pop();

    log('INFO', `[bc:${gameId}] ${(s && s.label) || id} → ${body}`);
    emit();
    return body;
  }

  /** 主播台控制指令（handleAction 里转发 'broadcast' 动作即可） */
  async function control(payload = {}) {
    const id = String(payload.slot || '').trim();
    if (!id) return { ok: false, msg: '缺少播报点 slot' };
    if (!byId.has(id)) return { ok: false, msg: `未知播报点: ${id}` };
    const text = await speak(id, payload.data || {}, { force: true });
    if (!text) return { ok: false, msg: mode() === 'off' ? 'AI 播报已关闭' : '未生成播报内容' };
    return { ok: true, msg: `已播报：${text}` };
  }

  /**
   * 收集配置：把 payload 里属于播报中心的键写进 cfg。
   * 各游戏在 handleAction('config') 里调一次即可，返回是否有变更。
   */
  function collectConfig(cfg, payload = {}) {
    let changed = false;
    for (const k of BC_CFG_KEYS) {
      if (payload[k] === undefined) continue;
      if (k === 'bcEnabled') {
        cfg.bcEnabled = { ...(cfg.bcEnabled || {}), ...(payload.bcEnabled || {}) };
      } else {
        cfg[k] = payload[k];
      }
      changed = true;
    }
    return changed;
  }

  /** 对外的播报状态（各游戏 publicState 里展开即可） */
  function publicState() {
    const st = getState() || {};
    const c = getCfg() || {};
    const bc = st.bc || {};
    const enabled = {};
    for (const s of slots) if (s && s.id) enabled[s.id] = slotEnabled(s.id);
    return {
      // 当前/最近一条播报（seq 自增，前端据此判断「该朗读新的一条」）
      bc: {
        seq: bc.seq || 0,
        slot: bc.slot || '',
        slotLabel: bc.slotLabel || '',
        text: bc.text || '',
        ts: bc.ts || 0,
        log: (bc.log || []).slice(0, 8),
      },
      // 播报点清单（主播台据此渲染逐点开关）
      bcSlots: slots.filter(s => s && s.id).map(s => ({ id: s.id, label: s.label || s.id, desc: s.desc || '' })),
      // 播报配置（密钥明文绝不下发，前端只知道「是否已配置」）
      bcCfg: {
        aiBroadcast: c.aiBroadcast || 'local',
        aiUrlMasked: c.aiApiUrl || '',
        aiKeyConfigured: !!c.aiApiKey,
        aiModel: c.aiModel || '',
        aiTimeoutSec: c.aiTimeoutSec || 8,
        bcAutoSpeak: c.bcAutoSpeak !== false,
        bcEnabled: enabled,
      },
    };
  }

  /** 供 CONFIG_SCHEMA 展开的播报配置项（需要纯表单渲染的游戏可用） */
  function configSchema() {
    return [
      { key: 'aiBroadcast', label: 'AI 播报', type: 'select', options: [['local', '本地模板'], ['api', 'AI 接口生成'], ['off', '关闭']], def: 'local' },
      { key: 'bcAutoSpeak', label: '自动朗读播报', type: 'bool', def: true },
      { key: 'aiApiUrl', label: 'AI 接口地址', type: 'text', def: '' },
      { key: 'aiModel', label: 'AI 模型', type: 'text', def: 'gpt-4o-mini' },
      { key: 'aiApiKey', label: 'AI 密钥', type: 'text', def: '' },
      { key: 'aiTimeoutSec', label: 'AI 超时(秒)', type: 'number', min: 2, def: 8 },
    ];
  }

  return {
    slots, mode, apiReady, slotEnabled,
    generate, speak, push, control, collectConfig, publicState, configSchema,
    /** 便捷：一次性关闭全部播报（游戏结束时用） */
    reset() { lastAt.clear(); },
  };
}

module.exports = { createBroadcaster, BC_CFG_DEFAULTS, BC_CFG_KEYS, DEFAULT_SYSTEM };
