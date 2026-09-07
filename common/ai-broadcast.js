'use strict';

/**
 * ============================================================================
 * common/ai-broadcast.js — 通用大模型调用（OpenAI 兼容 /chat/completions）
 * ============================================================================
 * 这是「AI 播报类」功能的【唯一公共依赖】。各游戏（quiz / redblue / …）如需
 * AI 口播 / AI 战报，只能 require 本模块；游戏之间不得互相 require，保证互不耦合。
 *
 * 本模块只负责「调用大模型 + 失败安全回退」，【不决定任何播报内容】
 * （prompt 文案、本地兜底模板由各游戏自己写）。
 *
 * 配置字段（存于各游戏自己的 cfg，密钥只存服务端、绝不下发前端）：
 *   aiApiUrl     接口地址，如 https://api.openai.com/v1
 *   aiApiKey     密钥
 *   aiModel      模型名，如 gpt-4o-mini
 *   aiTimeoutSec 超时秒数（默认 8）
 *
 * 对外 API：
 *   aiConfigured(cfg)            -> bool   是否已配置可用的大模型
 *   callChatCompletions(opts)    -> Promise<string|null>   直接调接口，失败返 null
 *   generateText(messages, cfg, fallback)
 *                                  -> Promise<string>   未配置/失败返 fallback()，永不抛错
 *       messages: [{ role:'system'|'user'|'assistant', content:'...' }]
 *       fallback: ()=>string      可选，未配置或调用失败时回退（如本地模板）
 * ============================================================================
 */

/** 是否已配置可用的大模型（密钥只存服务端，前端只拿到“是否已配置”） */
function aiConfigured(cfg) {
  return !!(cfg && cfg.aiApiUrl && cfg.aiApiKey && cfg.aiModel);
}

/**
 * 调用 OpenAI 兼容 /chat/completions。
 * 成功返回清洗后的文本；任何失败（网络/超时/解析/空回复）返回 null，绝不抛错。
 */
async function callChatCompletions({ apiUrl, apiKey, model, timeoutSec = 8, messages }) {
  if (!apiUrl || !apiKey || !model) return null;
  const url = String(apiUrl).replace(/\/+$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(2, timeoutSec) * 1000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 120,
        temperature: 0.9,
      }),
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) return null;
    // 去掉首尾可能的引号/书名号，并限长，避免模型乱加格式
    return String(text).trim().replace(/^["'「『]+|["'」』]+$/g, '').slice(0, 150);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成播报文本：未配置或调用失败 -> fallback()；成功 -> LLM 文本。永不抛错。
 * 由各游戏传入自己的 messages 与 fallback（本地模板），本函数不关心内容。
 */
async function generateText(messages, cfg, fallback) {
  try {
    if (!aiConfigured(cfg)) return fallback ? fallback() : '';
    const text = await callChatCompletions({
      apiUrl: cfg.aiApiUrl,
      apiKey: cfg.aiApiKey,
      model: cfg.aiModel,
      timeoutSec: cfg.aiTimeoutSec || 8,
      messages,
    });
    return text != null ? text : (fallback ? fallback() : '');
  } catch (e) {
    return fallback ? fallback() : '';
  }
}

module.exports = { aiConfigured, callChatCompletions, generateText };
