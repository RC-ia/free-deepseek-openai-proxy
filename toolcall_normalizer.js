'use strict';

/**
 * toolcall_normalizer.js
 * ----------------------
 * Deterministic parser that normalizes DeepSeek Web's NATIVE tool-call formats
 * into clean OpenAI-compatible { name, arguments } tool calls.
 *
 * Vendored into FreeDeepseekAPI to fix a gap: the upstream parseToolCall() only
 * handled strict-JSON / fenced-JSON / <tool_call>{...}</tool_call> (JSON body) /
 * legacy TOOL_CALL:, but DeepSeek Web emits function calls in native XML shapes.
 *
 * Two native XML shapes observed from DeepSeek Web:
 *
 *   (A) singular <tool_call name="x"><parameter name="p">v</parameter></tool_call>
 *
 *   (B) plural   <tool_calls>
 *                  <function name="read_file">
 *                    <parameter name="file_path">C:\...</parameter>
 *                  </function>
 *                  <function name="glob">...</function>
 *                </tool_calls>
 *
 * normalizeToolCall() returns an ARRAY of { name, arguments } (empty if none).
 *
 * ORIGINAL upstream proxy (credits / license):
 *   ForgetMeAI/FreeDeepseekAPI  -  https://github.com/ForgetMeAI/FreeDeepseekAPI
 *   Author: ForgetMeAI (t.me/forgetmeai)  -  MIT licensed.
 *
 * This normalizer is a companion drop-in patch, not a fork replacement.
 */

/**
 * Coerce an unknown value into { name, arguments } where arguments is a
 * stringified JSON object. Handles common LLM wrapper shapes.
 */
function coerceToolCallObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidate = obj.tool_call || obj.tool || obj.function_call || obj;
  if (!candidate || typeof candidate !== 'object') return null;
  const fn = candidate.function && typeof candidate.function === 'object' ? candidate.function : candidate;
  const name = fn.name || candidate.name || obj.name;
  if (!name || typeof name !== 'string') return null;
  let args = fn.arguments ?? candidate.arguments ?? candidate.input ?? obj.arguments ?? obj.input ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (e) { args = { raw: args }; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = { value: args };
  return { name, arguments: JSON.stringify(args) };
}

/** Parse a single <parameter name="X">VALUE</parameter> value. */
function parseParameterValue(raw) {
  const text = raw.trim();
  if (text === '') return '';
  try { return JSON.parse(text); } catch (e) { /* not JSON */ }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** Parse ONE <function name="X">...</function> (with optional <parameter> children). */
function parseFunctionTag(funcTag) {
  const nameMatch = funcTag.match(/<function\s+name\s*=\s*["']([^"']+)["']/i)
    || funcTag.match(/name\s*=\s*["']([^"']+)["']/i);
  const name = nameMatch ? nameMatch[1] : null;
  if (!name) return null;

  const args = {};
  const paramRe = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
  let m;
  let found = false;
  while ((m = paramRe.exec(funcTag)) !== null) {
    found = true;
    args[m[1]] = parseParameterValue(m[2]);
  }

  // Single generic param whose value is already an object/array -> promote.
  const keys = Object.keys(args);
  if (keys.length === 1) {
    const only = keys[0];
    const generic = /^(input|arguments|argument|value|params|parameters|body|content)$/i.test(only);
    if (generic && args[only] && typeof args[only] === 'object') {
      return { name, arguments: args[only] };
    }
  }

  return { name, arguments: found ? args : {} };
}

/**
 * Parse the singular native DeepSeek Web XML tool-call:
 *   <tool_call name="NAME"><parameter name="P1">V1</parameter>...</tool_call>
 * Returns { name, arguments: <object> } or null.
 */
function parseNativeXmlSingular(tag) {
  const nameMatch = tag.match(/<tool_call\s+name\s*=\s*["']([^"']+)["']/i)
    || tag.match(/name\s*=\s*["']([^"']+)["']/i);
  const name = nameMatch ? nameMatch[1] : null;
  if (!name) return null;

  const args = {};
  const paramRe = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
  let m;
  let found = false;
  while ((m = paramRe.exec(tag)) !== null) {
    found = true;
    args[m[1]] = parseParameterValue(m[2]);
  }

  // Single generic param whose value is already an object/array -> promote.
  const keys = Object.keys(args);
  if (keys.length === 1) {
    const only = keys[0];
    const generic = /^(input|arguments|argument|value|params|parameters|body|content)$/i.test(only);
    if (generic && args[only] && typeof args[only] === 'object') {
      return { name, arguments: args[only] };
    }
  }

  return { name, arguments: found ? args : {} };
}

/** Parse the plural native shape: <tool_calls><function ...>...</function></tool_calls> */
function parseNativeXmlPlural(tag) {
  const calls = [];
  const funcRe = /<function\s+[^>]*>([\s\S]*?)<\/function>/gi;
  let m;
  while ((m = funcRe.exec(tag)) !== null) {
    const fn = parseFunctionTag(m[0]);
    if (fn && fn.name) calls.push(fn);
  }
  return calls;
}

function extractBalancedJsonAt(text, startIndex) {
  let braceDepth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{' || ch === '[') braceDepth++;
      else if (ch === '}' || ch === ']') {
        braceDepth--;
        if (braceDepth === 0) {
          const slice = text.substring(startIndex, i + 1);
          try { return JSON.parse(slice); } catch (e) { return null; }
        }
      }
    }
  }
  return null;
}

function parseJsonToolCandidate(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    const tc = coerceToolCallObject(parsed);
    return tc ? [tc] : null;
  } catch (e) { return null; }
}

function safeParse(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch (e) { return s; }
}

/**
 * Main entry: normalize raw model text into an ARRAY of tool calls.
 * @param {string} text
 * @returns {Array<{name:string, arguments:object}>} (empty if none)
 */
function normalizeToolCall(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];

  // 1) Plural native XML: <tool_calls><function name=...>...</function></tool_calls>
  const pluralMatch = text.match(/<tool_calls\b[^>]*>([\s\S]*?)<\/tool_calls>/i);
  if (pluralMatch) {
    const calls = parseNativeXmlPlural(pluralMatch[0]);
    if (calls.length) return calls;
  }

  // 2) Singular native XML: <tool_call name="x"><parameter>...</parameter></tool_call>
  const xmlMatch = text.match(/<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/i);
  if (xmlMatch) {
    const native = parseNativeXmlSingular(xmlMatch[0]);
    if (native && native.name) return [native];
  }

  // 3) Fenced JSON
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fence;
  while ((fence = fenceRe.exec(text)) !== null) {
    const tc = parseJsonToolCandidate(fence[1].trim());
    if (tc) return tc;
  }

  // 4) Legacy TOOL_CALL: name
  const legacy = text.match(/TOOL_CALL:\s*([\w-]+)\s*/i);
  if (legacy) {
    const name = legacy[1];
    const after = text.substring(legacy.index + legacy[0].length);
    const braceIdx = after.indexOf('{');
    if (braceIdx !== -1) {
      const obj = extractBalancedJsonAt(after, braceIdx);
      if (obj) return [{ name, arguments: obj }];
    }
  }

  // 5) First balanced JSON object
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    const obj = extractBalancedJsonAt(text, i);
    if (!obj || typeof obj !== 'object') continue;
    if (obj.tool_call || obj.tool || obj.function_call || obj.name) {
      const tc = coerceToolCallObject(obj);
      if (tc) return [tc];
    }
  }

  return out;
}

function isToolCall(text) {
  return normalizeToolCall(text).length > 0;
}

module.exports = { normalizeToolCall, isToolCall, parseNativeXmlSingular, parseNativeXmlPlural, parseFunctionTag, parseParameterValue };
