#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AUTH_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(ROOT, 'deepseek-auth.json');
const ACCOUNTS_DIR = process.env.DEEPSEEK_AUTH_DIR || path.join(ROOT, 'accounts');
const PROFILE_DIR = process.env.DEEPSEEK_CHROME_PROFILE || path.join(ROOT, '.chrome-for-testing-profile-deepseek');
const WATERMARK = 't.me/forgetmeai';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function divider() { console.log('======================================================'); }
function watermark(prefix = 'ForgetMeAI') { return `${prefix}: ${WATERMARK}`; }
function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); }
  catch { return null; }
}
function listAccounts() {
  let files = [];
  try { files = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json')).sort(); } catch { /* dir may not exist */ }
  if (files.length === 0) { console.log('  (no accounts in accounts/ folder)'); return; }
  for (const f of files) {
    const p = path.join(ACCOUNTS_DIR, f);
    let ok = false;
    try { const a = JSON.parse(fs.readFileSync(p, 'utf8')); ok = !!(a.token && a.cookie); } catch {}
    console.log(`  ${ok ? '✅' : '❌'} ${f}`);
  }
}
function status() {
  console.log('\nDeepSeek account:');
  const auth = loadAuth();
  if (!auth) {
    console.log('  ❌ deepseek-auth.json not found');
  } else {
    console.log(`  ✅ auth file: ${AUTH_PATH}`);
    console.log(`  token: ${auth.token ? 'OK (' + String(auth.token).length + ' chars)' : 'MISSING'}`);
    console.log(`  cookies: ${auth.cookie ? 'OK' : 'MISSING'}`);
    console.log(`  Chrome profile: ${fs.existsSync(PROFILE_DIR) ? PROFILE_DIR : 'not found'}`);
  }
  console.log('\nAccounts in accounts/ (multi-login):');
  listAccounts();
}
function runDirectAuthWithOutput(outPath) {
  const env = { ...process.env };
  if (outPath) env.DEEPSEEK_AUTH_PATH = outPath;
  const script = path.join(__dirname, 'deepseek_chrome_auth.js');
  return spawnSync(process.execPath, [script], { stdio: 'inherit', env }).status === 0;
}
function runImportWithOutput(outPath) {
  const args = ['scripts/auth_import.js'];
  if (outPath) args.push('--output', outPath);
  return spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT, env: process.env }).status === 0;
}
function removeLocalAuth() {
  if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { force: true });
  console.log('Removed deepseek-auth.json. Chrome profile left in place so the browser is not logged out unnecessarily.');
}
async function addNewAccount() {
  const name = (await prompt('New account name (e.g. account2): ')).trim();
  if (!name) { console.log('Aborted: empty name.'); return; }
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  const outPath = path.join(ACCOUNTS_DIR, `${name}.json`);
  if (fs.existsSync(outPath)) {
    const overwrite = (await prompt(`Account "${name}" already exists. Overwrite? (y/N): `)).trim().toLowerCase();
    if (overwrite !== 'y' && overwrite !== 'yes') { console.log('Aborted.'); return; }
  }
  console.log(`\nOpening Chrome for a NEW DeepSeek login. The auth will be saved to:\n  ${outPath}\n`);
  const ok = runDirectAuthWithOutput(outPath);
  if (ok) {
    try { fs.chmodSync(outPath, 0o600); } catch {}
    console.log(`\n✅ Account "${name}" saved. The proxy will pick it up via DEEPSEEK_AUTH_DIR.`);
    console.log('Start the proxy with: DEEPSEEK_AUTH_DIR=./accounts npm start\n');
  } else {
    console.log('\n❌ Login failed or was cancelled. Nothing saved.');
  }
}
function printHelp() {
  divider();
  console.log('FreeDeepseekAPI — DeepSeek Web login management');
  console.log(watermark());
  divider();
  console.log('Options:');
  console.log('  --login     Open Chrome and refresh auth');
  console.log('  --add       Add a NEW account (multi-login) to accounts/');
  console.log('  --import    Import an existing deepseek-auth.json / browser cookies');
  console.log('  --status    Show auth status');
  console.log('  --remove    Remove the local deepseek-auth.json');
  console.log('  --help      This help');
  console.log('With no options, starts the interactive menu.');
  divider();
}
async function menu() {
  while (true) {
    divider();
    console.log(watermark());
    status();
    divider();
    console.log('Menu:');
    console.log('1 - Authorize / refresh DeepSeek login');
    console.log('2 - Import auth file / cookies');
    console.log('3 - Show status');
    console.log('4 - Add a NEW account (multi-login)');
    console.log('5 - Remove local auth file');
    console.log('6 - Exit');
    const choice = (await prompt('Your choice (Enter = 6): ')) || '6';
    if (choice === '1') runDirectAuthWithOutput();
    else if (choice === '2') runImportWithOutput();
    else if (choice === '3') { status(); await prompt('\nPress Enter to return to the menu...'); }
    else if (choice === '4') await addNewAccount();
    else if (choice === '5') removeLocalAuth();
    else if (choice === '6') break;
  }
}
(async () => {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) return printHelp();
  if (args.has('--login') || args.has('--relogin')) return void runDirectAuthWithOutput();
  if (args.has('--add') || args.has('--add-account')) return void addNewAccount();
  if (args.has('--import')) return void runImportWithOutput();
  if (args.has('--status') || args.has('--list')) return status();
  if (args.has('--remove')) return removeLocalAuth();
  await menu();
})();
