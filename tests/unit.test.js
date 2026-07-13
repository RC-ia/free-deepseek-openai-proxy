const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const serverInternals = require('../server.js').__test;
const { parseToolCall } = require('../server.js');
const { normalizeToolCall } = require('../toolcall_normalizer.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-test-'));
}

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
}

test('auth import copies valid deepseek-auth.json and chmods it to 0600', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'source-auth.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify({
    token: 'tok_123',
    cookie: 'ds_session_id=abc; other=def',
    hif_dliq: 'dliq',
    hif_leim: 'leim',
    wasmUrl: 'https://example.com/sha3.wasm',
  }));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_123');
  assert.match(imported.cookie, /ds_session_id=abc/);
  if (process.platform !== 'win32') {
    assert.equal((fs.statSync(dst).mode & 0o777), 0o600);
  }
});

test('auth import accepts browser cookie export plus token env', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([
    { domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' },
    { domain: 'chat.deepseek.com', name: 'smidV2', value: 'smid' },
    { domain: 'example.com', name: 'ignored', value: 'nope' },
  ]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst], { env: { DEEPSEEK_TOKEN: 'tok_env' } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_env');
  assert.equal(imported.cookie, 'ds_session_id=abc; smidV2=smid');
});

test('auth import rejects token passed as CLI arg before prompting or reading files', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([{ domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' }]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst, '--token', 'tok_cli']);
  assert.equal(res.status, 2);
  assert.match(res.stderr + res.stdout, /Refusing --token/i);
  assert.equal(fs.existsSync(dst), false);

  const noInput = runNode(['scripts/auth_import.js', '--token', 'tok_cli']);
  assert.equal(noInput.status, 2);
  assert.match(noInput.stderr + noInput.stdout, /Refusing --token/i);

  const badInput = runNode(['scripts/auth_import.js', '--input', path.join(dir, 'missing.json'), '--token', 'tok_cli']);
  assert.equal(badInput.status, 2);
  assert.match(badInput.stderr + badInput.stdout, /Refusing --token/i);
});

test('auth import help ignores comma-list DEEPSEEK_AUTH_PATH as default output', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  const res = runNode(['scripts/auth_import.js', '--help'], { env: { DEEPSEEK_AUTH_PATH: `${a},${b}` } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, new RegExp(`${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`));
  assert.match(res.stdout, /deepseek-auth\.json/);
});

test('doctor reports auth problems without requiring Chrome or network', () => {
  const dir = tmpdir();
  const authPath = path.join(dir, 'broken-auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ token: '', cookie: '' }));
  const res = runNode(['scripts/doctor.js', '--offline'], { env: { DEEPSEEK_AUTH_PATH: authPath } });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /token missing/i);
  assert.match(res.stdout + res.stderr, /cookie missing/i);
});

test('chrome auth prints actionable OS instructions when Chrome is missing', () => {
  const dir = tmpdir();
  const fakeChrome = path.join(dir, 'missing-chrome');
  const res = runNode(['scripts/deepseek_chrome_auth.js'], { env: { CHROME_PATH: fakeChrome } });
  assert.notEqual(res.status, 0);
  const out = res.stdout + res.stderr;
  assert.match(out, /Windows/i);
  assert.match(out, /macOS/i);
  assert.match(out, /Linux/i);
  assert.match(out, /CHROME_PATH/i);
});

test('DeepSeek stream parser treats SEARCH fragments as assistant output', () => {
  const rebuilt = serverInternals.rebuildFragmentText([
    { type: 'SEARCH', content: 'The official Reuters website is ' },
    { type: 'SEARCH', content: 'https://www.reuters.com/.' },
  ]);

  assert.equal(rebuilt.responseText, 'The official Reuters website is https://www.reuters.com/.');
  assert.equal(rebuilt.thinkText, '');
});

test('DeepSeek stream parser applies response-level fragment append patches', () => {
  const fragments = [];
  const appendFragments = (value) => {
    const incoming = Array.isArray(value) ? value : [value];
    for (const fragment of incoming) fragments.push({ ...fragment });
  };

  const applied = serverInternals.applyResponsePatchOperations([
    { p: 'fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'The' }] },
    { p: 'has_pending_fragment', o: 'SET', v: false },
  ], appendFragments);

  assert.equal(applied, true);
  assert.deepEqual(fragments, [{ type: 'RESPONSE', content: 'The' }]);
  assert.equal(serverInternals.rebuildFragmentText(fragments).responseText, 'The');
});

test('DeepSeek stream parser does not treat service content chunks as model errors', () => {
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ content: 'Official Reuters website URL' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ finish_reason: 'stop' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ type: 'error', content: 'backend error' }), true);
});

test('parseToolCall handles native DeepSeek Web XML <tool_call name=> with <parameter>', () => {
  const text = `Vou começar.

<tool_call name="todo_write">
    <parameter name="todos">[{"id":"1","content":"Criar HTML base","status":"in_progress"},{"id":"2","content":"CSS","status":"pending"}]</parameter>
</tool_call>`;
  const tc = parseToolCall(text);
  assert.ok(tc, 'should detect tool call');
  assert.equal(tc.name, 'todo_write');
  const args = JSON.parse(tc.arguments);
  assert.ok(Array.isArray(args.todos), 'todos should be an array');
  assert.equal(args.todos.length, 2);
  assert.equal(args.todos[0].status, 'in_progress');
});

test('parseToolCall still returns null for plain text', () => {
  assert.equal(parseToolCall('Just talking, no tool call here.'), null);
});

test('parseToolCall multi-parameter mixed types', () => {
  const text = `<tool_call name="write_file">
    <parameter name="path">/tmp/hi.py</parameter>
    <parameter name="overwrite">true</parameter>
    <parameter name="count">7</parameter>
  </tool_call>`;
  const tc = parseToolCall(text);
  assert.equal(tc.name, 'write_file');
  const args = JSON.parse(tc.arguments);
  assert.equal(args.path, '/tmp/hi.py');
  assert.equal(args.overwrite, true);
  assert.equal(args.count, 7);
});

test('normalizeToolCall parses NEW plural <tool_calls><function> format', () => {
  const text = `<tool_calls>
    <function name="read_file">
      <parameter name="file_path">C:\\Users\\Adoro\\manga-site\\templates\\index.html</parameter>
    </function>
    <function name="glob">
      <parameter name="pattern">**/*</parameter>
      <parameter name="path">C:\\Users\\Adoro\\manga-site\\static\\js</parameter>
    </function>
  </tool_calls>`;
  const calls = normalizeToolCall(text);
  assert.equal(calls.length, 2, 'should parse both function calls');
  assert.equal(calls[0].name, 'read_file');
  assert.equal(calls[0].arguments.file_path, 'C:\\Users\\Adoro\\manga-site\\templates\\index.html');
  assert.equal(calls[1].name, 'glob');
  assert.equal(calls[1].arguments.pattern, '**/*');
  assert.equal(calls[1].arguments.path, 'C:\\Users\\Adoro\\manga-site\\static\\js');
});

test('parseToolCall returns first call from plural <tool_calls> block', () => {
  const text = `<tool_calls>
    <function name="read_file"><parameter name="file_path">/a.txt</parameter></function>
    <function name="glob"><parameter name="pattern">**/*</parameter></function>
  </tool_calls>`;
  const tc = parseToolCall(text);
  assert.equal(tc.name, 'read_file');
  const args = JSON.parse(tc.arguments);
  assert.equal(args.file_path, '/a.txt');
});

// Regression: DeepSeek Web emits <parameter name="todos" type="array"> with an
// extra type attribute — the normalizer must still extract the array (Qwen
// Code's TodoWrite/TodoList requires `todos` to be an array, not empty).
test('normalizeToolCall tolerates extra type attr on <parameter> and yields array', () => {
  const text = `<tool_call name="todo_write">
    <parameter name="todos" type="array">[{"id":"1","content":"Criar HTML base","status":"in_progress"},{"id":"2","content":"CSS","status":"pending"}]</parameter>
  </tool_call>`;
  const calls = normalizeToolCall(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'todo_write');
  const args = calls[0].arguments;
  assert.ok(Array.isArray(args.todos), 'todos must be an array');
  assert.equal(args.todos.length, 2);
  assert.equal(args.todos[0].status, 'in_progress');
});

// Regression: tool-call body as inline JSON (no <parameter> children) must
// also be parsed, not returned as empty args.
test('normalizeToolCall handles inline-JSON tool-call body', () => {
  const text = `<tool_call name="todo_write">{"todos":[{"id":"1","content":"X","status":"in_progress"}]}</tool_call>`;
  const calls = normalizeToolCall(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'todo_write');
  const args = calls[0].arguments;
  assert.ok(Array.isArray(args.todos), 'todos must be an array');
  assert.equal(args.todos.length, 1);
});

// Regression: HTML entities emitted by DeepSeek Web inside parameter values must
// be decoded before JSON.parse, otherwise object args come back as dirty strings.
test('normalizeToolCall decodes HTML entities in parameter values', () => {
  const text = `<tool_call name="write_file">
    <parameter name="path">/tmp/a.txt</parameter>
    <parameter name="content">{"key": "val with &quot;quotes&quot; and &lt;tags&gt;"}</parameter>
  </tool_call>`;
  const calls = normalizeToolCall(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'write_file');
  const args = calls[0].arguments;
  assert.equal(args.path, '/tmp/a.txt');
  assert.equal(args.content, '{"key": "val with "quotes" and <tags>"}');
});

// Regression: <parameter> without a name attribute must still be collected (argN).
test('normalizeToolCall collects unnamed <parameter> as argN', () => {
  const text = `<tool_call name="echo">
    <parameter>just a value</parameter>
  </tool_call>`;
  const calls = normalizeToolCall(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'echo');
  assert.equal(calls[0].arguments.arg1, 'just a value');
});

// Regression: namespaced <antml:tool_calls> wrapper must be parsed like <tool_calls>.
test('normalizeToolCall parses namespaced <antml:tool_calls> plural', () => {
  const text = `<antml:tool_calls>
    <antml:function name="read_file"><parameter name="file_path">/a.txt</parameter></antml:function>
  </antml:tool_calls>`;
  const calls = normalizeToolCall(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.equal(calls[0].arguments.file_path, '/a.txt');
});

// Regression: bare <function name="x"> without a <tool_calls> wrapper must still parse.
test('normalizeToolCall parses bare <function> without wrapper', () => {
  const text = `Here is the call: <function name="glob"><parameter name="pattern">**/*</parameter></function> done.`;
  const calls = normalizeToolCall(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'glob');
  assert.equal(calls[0].arguments.pattern, '**/*');
});

// Regression: special numeric literals (Infinity / -Infinity / NaN) must survive as numbers.
test('normalizeToolCall preserves special numeric literals', () => {
  const text = `<tool_call name="plot">
    <parameter name="max">Infinity</parameter>
    <parameter name="min">-Infinity</parameter>
    <parameter name="gap">NaN</parameter>
  </tool_call>`;
  const args = normalizeToolCall(text)[0].arguments;
  assert.equal(args.max, Infinity);
  assert.equal(args.min, -Infinity);
  assert.ok(Number.isNaN(args.gap));
});


// account (round-robin) to dilute per-account traffic and reduce ban risk, and
// reset the web session when the account changes.
test('selectAccountForSession round-robins across multiple ready accounts', () => {
  const mk = (id) => ({ id, config: { token: 't', cookie: 'c' }, cooldownUntil: 0, failures: 0, lastUsedAt: 0 });
  serverInternals._setAccountsForTest([mk('account_1'), mk('account_2')]);
  serverInternals._resetRoundRobin();
  const session = { id: 'sess-x', parentMessageId: 'p', createdAt: Date.now(), messageCount: 3 };

  const seen = [];
  let allDifferent = true;
  for (let i = 0; i < 4; i++) {
    const acct = serverInternals.selectAccountForSession(session);
    seen.push(acct.id);
    if (i > 0 && seen[i] === seen[i - 1]) allDifferent = false;
  }
  assert.deepEqual(seen, ['account_1', 'account_2', 'account_1', 'account_2']);
  assert.equal(allDifferent, true, 'each request must hit a different account');
  serverInternals._setAccountsForTest([]);
});

// Regression: with a single account, selection stays sticky (no rotation, no reset).
test('selectAccountForSession stays sticky with a single account', () => {
  const mk = (id) => ({ id, config: { token: 't', cookie: 'c' }, cooldownUntil: 0, failures: 0, lastUsedAt: 0 });
  serverInternals._setAccountsForTest([mk('account_1')]);
  serverInternals._resetRoundRobin();
  const session = { id: 'sess-y', parentMessageId: 'p', createdAt: Date.now(), messageCount: 3 };
  const a = serverInternals.selectAccountForSession(session);
  const b = serverInternals.selectAccountForSession(session);
  assert.equal(a.id, 'account_1');
  assert.equal(b.id, 'account_1');
  assert.equal(session.id, 'sess-y', 'session must not be reset with a single account');
  serverInternals._setAccountsForTest([]);
});

// Regression: buildUsage must surface chat context limit + usage ratio so the
// client (e.g. Qwen Code) can compress its own context instead of getting a
// silent empty response from the DeepSeek Web chat.
test('buildUsage reports context char limit and usage ratio', () => {
  const longPrompt = 'x'.repeat(162131); // exactly the measured chat limit
  const usage = serverInternals.buildUsage(longPrompt, 'hello', '');
  assert.equal(usage.context_char_limit, 162131);
  assert.equal(usage.prompt_chars, 162131);
  assert.equal(typeof usage.context_usage_ratio, 'number');
  assert.ok(usage.context_usage_ratio >= 0.99 && usage.context_usage_ratio <= 1.01, 'ratio should be ~1.0 at the limit');
  // prompt_tokens_est is chars/4
  assert.equal(usage.prompt_tokens_est, Math.ceil(162131 / 4));
});

// Regression: CONTEXT limit constants are exported and effective limit applies margin.
test('CONTEXT effective limit applies safety margin', () => {
  const { limit, effectiveLimit } = serverInternals.CONTEXT;
  assert.equal(limit, 162131);
  assert.ok(effectiveLimit < limit, 'effective limit must be below raw limit (safety margin)');
  assert.ok(effectiveLimit >= limit * 0.9, 'margin must not be too aggressive (<10%)');
});

