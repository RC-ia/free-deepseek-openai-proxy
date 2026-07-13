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
 * Native XML shapes observed from DeepSeek Web:
 *
 *   (A) singular <tool_call name="x"><parameter name="p">v</parameter></tool_call>
 *   (B) plural   <tool_calls>
 *                  <function name="read_file">
 *                    <parameter name="file_path">C:\...</parameter>
 *                  </function>
 *                  <function name="glob">...</function>
 *                </tool_calls>
 *   (C) namespaced <antml:tool_calls> / <antml:tool_call> (same as A/B)
 *   (D) bare <function name="x">...</function> (no <tool_calls> wrapper)
 *
 * Parameter values are frequently HTML-escaped by DeepSeek Web (&quot; &lt;
 * &gt; &#39; &amp;), so we decode entities before attempting JSON.parse.
 *
 * normalizeToolCall() returns an ARRAY of { name, arguments } (empty if none).
 * `arguments` is always a plain object (stringified later by the caller).
 *
 * ORIGINAL upstream proxy (credits / license):
 *   ForgetMeAI/FreeDeepseekAPI  -  https://github.com/ForgetMeAI/FreeDeepseekAPI
 *   Author: ForgetMeAI (t.me/forgetmeai)  -  MIT licensed.
 *
 * This normalizer is a companion drop-in patch, not a fork replacement.
 */

/** Decode the HTML entities DeepSeek Web commonly emits inside parameter values. */
function decodeHtmlEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")      // &#39; / &#039;
    .replace(/&apos;/g, "'")
    .replace(/&#0*34;/g, '"')      // &#34; / &#034; (numeric double quote)
    .replace(/&amp;/g, '&');       // must run LAST to avoid double-decoding
}

/**
 * Coerce an unknown value into { name, arguments } where arguments is a
 * stringified JSON object. Handles common LLM wrapper shapes.
 */
function coerceToolCallObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  // A tool call may be expressed several ways; normalize all to { name, arguments }.
  // - {"tool_call": {"name": "x", "arguments": {...}}}
  // - {"function_call": {"name": "x", "arguments": "..."}}
  // - {"name": "x", "arguments": {...}}            (OpenAI-style)
  // - {"tool": "x", "arguments": {...}}            (DeepSeek Web line-numbered / compact form)
  // - {"function": {"name": "x", "arguments": {...}}}
  const name =
    (typeof obj.tool === 'string' ? obj.tool : null) ||
    (obj.tool_call && typeof obj.tool_call === 'object' ? obj.tool_call.name : null) ||
    (obj.function_call && typeof obj.function_call === 'object' ? obj.function_call.name : null) ||
    (obj.function && typeof obj.function === 'object' ? obj.function.name : null) ||
    obj.name ||
    null;
  if (!name || typeof name !== 'string') return null;
  const argsSource =
    obj.arguments ??
    obj.input ??
    (obj.tool_call && typeof obj.tool_call === 'object' ? obj.tool_call.arguments ?? obj.tool_call.input : null) ??
    (obj.function_call && typeof obj.function_call === 'object' ? obj.function_call.arguments ?? obj.function_call.input : null) ??
    (obj.function && typeof obj.function === 'object' ? obj.function.arguments ?? obj.function.input : null) ??
    null;
  let args = argsSource ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (e) { args = { raw: args }; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = { value: args };
  return { name, arguments: JSON.stringify(args) };
}

/**
 * Parse a single <parameter name="X">VALUE</parameter> value.
 * VALUE may be JSON (object/array/number/bool, possibly HTML-escaped), a plain
 * string, or a special numeric literal (Infinity/-Infinity/NaN).
 */
function parseParameterValue(raw) {
  const text = decodeHtmlEntities(raw == null ? '' : String(raw)).trim();
  if (text === '') return '';
  try { return JSON.parse(text); } catch (e) { /* not strict JSON */ }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (text === 'Infinity') return Infinity;
  if (text === '-Infinity') return -Infinity;
  if (text === 'NaN') return NaN;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** Match the value of a <parameter>, tolerating extra attributes (type=, etc.). */
const PARAM_NAMED_RE = /<parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
const PARAM_BARE_RE = /<parameter\s*>([\s\S]*?)<\/parameter>/gi;

/**
 * Collect parameters from an XML fragment (function or tool_call body).
 * Named <parameter name="x"> map to x; unnamed <parameter> map to argN.
 */
function collectParameters(fragment) {
  const args = {};
  let found = 0;
  let m;
  PARAM_NAMED_RE.lastIndex = 0;
  while ((m = PARAM_NAMED_RE.exec(fragment)) !== null) {
    found++;
    args[m[1]] = parseParameterValue(m[2]);
  }
  PARAM_BARE_RE.lastIndex = 0;
  while ((m = PARAM_BARE_RE.exec(fragment)) !== null) {
    found++;
    args[`arg${found}`] = parseParameterValue(m[1]);
  }
  return { args, found };
}

/** Parse ONE <function name="X">...</function> (with optional <parameter> children). */
function parseFunctionTag(funcTag) {
  const nameMatch = funcTag.match(/<function\s+name\s*=\s*["']([^"']+)["']/i)
    || funcTag.match(/name\s*=\s*["']([^"']+)["']/i);
  const name = nameMatch ? nameMatch[1] : null;
  if (!name) return null;

  const { args, found } = collectParameters(funcTag);

  // Single generic param whose value is already an object/array -> promote.
  const keys = Object.keys(args);
  if (keys.length === 1) {
    const only = keys[0];
    const generic = /^(input|arguments|argument|value|params|parameters|body|content|arg1)$/i.test(only);
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

  const { args, found } = collectParameters(tag);

  if (!found) {
    // No <parameter> children: the tool-call body may be inline JSON, e.g.
    //   <tool_call name="x">{"todos":[...]}</tool_call>
    const body = tag
      .replace(/^<tool_call[^>]*>/i, '')
      .replace(/<\/tool_call>\s*$/i, '')
      .trim();
    if (body) {
      try {
        const parsed = JSON.parse(decodeHtmlEntities(body));
        if (parsed && typeof parsed === 'object') return { name, arguments: parsed };
      } catch (e) { /* not JSON; fall through below */ }
    }
    return { name, arguments: {} };
  }

  // Single generic param whose value is already an object/array -> promote.
  const keys = Object.keys(args);
  if (keys.length === 1) {
    const only = keys[0];
    const generic = /^(input|arguments|argument|value|params|parameters|body|content|arg1)$/i.test(only);
    if (generic && args[only] && typeof args[only] === 'object') {
      return { name, arguments: args[only] };
    }
  }

  return { name, arguments: args };
}

/** Parse the plural native shape: <tool_calls><function ...>...</function></tool_calls> */
function parseNativeXmlPlural(tag) {
  const calls = [];
  const funcRe = /<([\w:-]+:)?function\s+[^>]*>([\s\S]*?)<\/([\w:-]+:)?function>/gi;
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
  // Strip line-number prefixes some models emit on EACH line, e.g.:
  //   "1 {\n 2   \"tool\": \"write_file\"..."
  // The "N " prefix on every line breaks JSON.parse (error at position 1).
  let stripped = raw.replace(/^\s*\d+\s+/gm, '').trim();
  if (stripped !== raw) raw = stripped;
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

// Matches <tool_calls>, <antml:tool_calls>, etc. (namespaced-aware).
const TOOL_CALLS_OPEN = /<([\w:-]+:)?tool_calls\b[^>]*>/i;
const TOOL_CALLS_CLOSE = /<\/([\w:-]+:)?tool_calls>/i;
// Matches a bare <function name=...>...</function> (no <tool_calls> wrapper).
const BARE_FUNCTION_RE = /<([\w:-]+:)?function\s+[^>]*name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/([\w:-]+:)?function>/gi;

/**
 * Main entry: normalize raw model text into an ARRAY of tool calls.
 * @param {string} text
 * @returns {Array<{name:string, arguments:object}>} (empty if none)
 */
function normalizeToolCall(text) {
  if (!text || typeof text !== 'string') return [];

  // 1) Plural native XML: <tool_calls><function name=...>...</function></tool_calls>
  //    (namespaced variants like <antml:tool_calls> are supported).
  const open = text.match(TOOL_CALLS_OPEN);
  if (open) {
    const close = text.match(TOOL_CALLS_CLOSE);
    const start = open.index + open[0].length;
    const end = close ? close.index : text.length;
    const calls = parseNativeXmlPlural(text.substring(start, end));
    if (calls.length) return calls;
  }

  // 2) Singular native XML: <tool_call name="x"><parameter>...</parameter></tool_call>
  //    (namespaced <antml:tool_call> supported via the name= fallback).
  const xmlMatch = text.match(/<([\w:-]+:)?tool_call\b[^>]*>([\s\S]*?)<\/([\w:-]+:)?tool_call>/i);
  if (xmlMatch) {
    const native = parseNativeXmlSingular(xmlMatch[0]);
    if (native && native.name) return [native];
  }

  // 2b) Bare <function name="x">...</function> with no <tool_calls> wrapper.
  BARE_FUNCTION_RE.lastIndex = 0;
  const bare = [];
  let bm;
  while ((bm = BARE_FUNCTION_RE.exec(text)) !== null) {
    const fn = parseFunctionTag(`<function name="${bm[2]}">${bm[3]}</function>`);
    if (fn && fn.name) bare.push(fn);
  }
  if (bare.length) return bare;

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
  // Strip "N " line-number prefixes models sometimes emit inside the JSON
  // (e.g. "1 {\n 2   \"tool\": ...") before scanning, so the balanced
  // extractor doesn't choke on the embedded digits.
  const scanText = text.replace(/^\s*\d+\s+/gm, '');
  for (let i = 0; i < scanText.length; i++) {
    if (scanText[i] !== '{' && scanText[i] !== '[') continue;
    const found = extractBalancedJsonAt(scanText, i);
    if (!found) continue;
    // extractBalancedJsonAt may return a parsed object OR a raw string depending
    // on branch; handle both.
    const tc = typeof found === 'string'
      ? parseJsonToolCandidate(found)
      : coerceToolCallObject(found);
    // parseJsonToolCandidate returns an ARRAY; coerceToolCallObject returns an OBJECT.
    // normalizeToolCall's contract is always an ARRAY, so wrap the object form.
    const out = (tc && Array.isArray(tc)) ? tc : (tc && tc.name ? [tc] : null);
    if (out && out.length) return out;
  }
  return [];
}

function isToolCall(text) {
  return normalizeToolCall(text).length > 0;
}

module.exports = {
  normalizeToolCall,
  isToolCall,
  parseNativeXmlSingular,
  parseNativeXmlPlural,
  parseFunctionTag,
  parseParameterValue,
  decodeHtmlEntities,
};
