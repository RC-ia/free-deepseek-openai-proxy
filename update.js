#!/usr/bin/env node
/**
 * update.js — update FreeDeepseekAPI from the Git remote without losing local auth/config.
 *
 * Commands:
 *   node update.js            interactive menu
 *   node update.js --check    check if updates are available (exit code 0=up-to-date, 1=updates)
 *   node update.js --pull     non-interactive pull (snapshot auth → stash dirty → pull → restore)
 *   node update.js --status   show current commit + remote status
 *
 * No npm dependencies — pure Node.js 18+.
 * Cross-platform (Windows / WSL / Linux): never shells out to `ls` or bash redirects.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// ─── helpers ─────────────────────────────────────────────────────────

const repo = process.cwd();

/** Auth / local config that must survive a pull (often gitignored). */
const PROTECTED_FILES = [
  '.env',
  'auth.json',
  'deepseek-auth.json',
  'package-lock.json',
];

function log(...args) { console.log(args.join(' ')); }

/** Run git with args, return {stdout, stderr, status} */
function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf-8',
    // Avoid Windows cmd.exe path issues; never go through a shell.
    shell: false,
    ...opts,
  });
  return {
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    status: r.status === null ? 1 : r.status,
  };
}

function defaultBranch() {
  // Prefer origin/HEAD → origin/main → origin/master → main
  const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (sym.status === 0 && sym.stdout) {
    const m = sym.stdout.match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  }
  for (const b of ['main', 'master']) {
    const r = git(['rev-parse', '--verify', `origin/${b}`]);
    if (r.status === 0) return b;
  }
  return 'main';
}

// ─── protected file snapshot (works for gitignored auth on Windows) ──

function listProtected() {
  const out = [];
  for (const rel of PROTECTED_FILES) {
    if (fs.existsSync(path.join(repo, rel))) out.push(rel);
  }
  const accDir = path.join(repo, 'accounts');
  if (fs.existsSync(accDir) && fs.statSync(accDir).isDirectory()) {
    for (const f of fs.readdirSync(accDir)) {
      if (f.endsWith('.json')) out.push(path.join('accounts', f));
    }
  }
  return out;
}

function snapshotProtected() {
  const files = listProtected();
  if (files.length === 0) return { snapDir: null, saved: [] };

  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fda-update-'));
  const saved = [];
  for (const rel of files) {
    const src = path.join(repo, rel);
    const dest = path.join(snapDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    saved.push(rel);
  }
  log('[update] Snapshotted protected files:', saved.join(', '));
  return { snapDir, saved };
}

function restoreSnapshot(snap) {
  if (!snap || !snap.snapDir) return false;
  for (const rel of snap.saved) {
    const src = path.join(snap.snapDir, rel);
    const dest = path.join(repo, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  try {
    fs.rmSync(snap.snapDir, { recursive: true, force: true });
  } catch { /* ignore cleanup errors */ }
  log('[update] Restored protected files from snapshot.');
  return true;
}

// ─── working-tree stash (unstaged changes that block rebase) ─────────

function isDirty() {
  const r = git(['status', '--porcelain']);
  return r.status === 0 && r.stdout.length > 0;
}

/**
 * Stash ALL non-ignored dirty files (tracked mods + untracked).
 * Ignored auth is handled by snapshotProtected, not stash.
 * Returns true if a stash entry was created.
 */
function stashWorkingTree() {
  if (!isDirty()) {
    log('[update] Working tree clean — nothing to stash.');
    return false;
  }
  // Show what would block the pull (helps debug)
  const dirty = git(['status', '--porcelain']).stdout;
  log('[update] Dirty working tree:\n' + dirty);

  const r = git(['stash', 'push', '--include-untracked', '-m', 'update-auto']);
  if (r.status !== 0) {
    // "No local changes to save" is fine
    if (/No local changes/i.test(r.stdout + r.stderr)) {
      log('[update] Nothing stashed.');
      return false;
    }
    console.error(`[update] stash failed:\n${r.stderr || r.stdout}`);
    return false;
  }
  log('[update] Stashed local changes (update-auto).');
  return true;
}

function popWorkingTreeStash(didStash) {
  if (!didStash) return true;
  // Prefer the stash we just made (message update-auto)
  const list = git(['stash', 'list']).stdout.split('\n').filter(Boolean);
  let ref = 'stash@{0}';
  for (let i = 0; i < list.length; i++) {
    if (list[i].includes('update-auto')) {
      ref = `stash@{${i}}`;
      break;
    }
  }
  const r = git(['stash', 'pop', ref]);
  if (r.status === 0) {
    log('[update] Restored stashed local changes.');
    return true;
  }
  // Conflicts on pop are common when the same files were updated remotely
  console.warn(`[update] stash pop had issues (often expected if remote touched the same files):\n${r.stderr || r.stdout}`);
  console.warn('[update] Your pre-update local edits may still be in `git stash list`. Resolve manually if needed.');
  return false;
}

// ─── commands ────────────────────────────────────────────────────────

async function interactive(rl) {
  const head = git(['rev-parse', '--short', 'HEAD']).stdout;
  const branch = defaultBranch();
  log(`\n=== FreeDeepseekAPI Update ===`);
  log(`Current commit: ${head}`);
  log(`Remote: ${git(['remote', 'get-url', 'origin']).stdout}`);
  log(`Branch: ${branch}\n`);

  log('Fetching remote...');
  const fetch = git(['fetch', 'origin']);
  if (fetch.status !== 0) {
    console.error(`[update] git fetch failed:\n${fetch.stderr || fetch.stdout}`);
    process.exit(1);
  }

  const behind = git(['rev-list', '--count', `HEAD..origin/${branch}`]).stdout || '0';
  const ahead = git(['rev-list', '--count', `origin/${branch}..HEAD`]).stdout || '0';

  if (behind === '0' && ahead === '0') {
    log('✅ Up to date. Nothing to update.');
    return;
  }

  log(`Remote: ${behind} commit(s) ahead, ${ahead} local-only commit(s)`);

  if (ahead !== '0') {
    log('⚠️  You have local commits not on the remote. Update will rebase them on top.');
  }
  if (isDirty()) {
    log('⚠️  You have unstaged/untracked local changes. They will be stashed during pull and restored after.');
  }

  const answer = await ask(rl, 'Pull update? [y/N] ');
  if (!answer.toLowerCase().startsWith('y')) {
    log('Cancelled.');
    return;
  }
  doPull();
}

function doPull() {
  const branch = defaultBranch();

  // 1) Snapshot protected (auth etc.) — survives even if stash fails / ignored files
  const snap = snapshotProtected();

  // 2) Stash remaining dirty tree so rebase can run
  const didStash = stashWorkingTree();

  // 3) Still dirty? Refuse rather than clobber.
  if (isDirty()) {
    console.error('[update] Working tree still dirty after stash — cannot pull safely.');
    console.error(git(['status', '--porcelain']).stdout);
    restoreSnapshot(snap);
    if (didStash) popWorkingTreeStash(true);
    process.exit(1);
  }

  // 4) Pull with rebase
  log(`[update] git pull --rebase origin ${branch} ...`);
  const r = git(['pull', '--rebase', 'origin', branch]);
  if (r.status !== 0) {
    console.error(`[update] git pull --rebase failed:\n${r.stderr || r.stdout}`);
    log('[update] Aborting rebase and restoring...');
    git(['rebase', '--abort']);
    restoreSnapshot(snap);
    popWorkingTreeStash(didStash);
    process.exit(1);
  }
  if (r.stdout) log(r.stdout);

  // 5) Restore auth first (overwrite whatever the pull put there)
  restoreSnapshot(snap);

  // 6) Restore pre-update local edits (may conflict — warned above)
  popWorkingTreeStash(didStash);

  // 7) Syntax check
  log('\n[update] Running syntax check...');
  const check = spawnSync(process.execPath, ['--check', 'server.js'], {
    cwd: repo,
    encoding: 'utf-8',
    shell: false,
  });
  if (check.status !== 0) {
    console.error(`[update] Syntax check failed:\n${check.stderr}`);
    console.warn('[update] The pulled code may have syntax errors. Check manually.');
  } else {
    log('[update] Syntax check passed.');
  }

  const newHead = git(['rev-parse', '--short', 'HEAD']).stdout;
  log(`\n✅ Updated to ${newHead}.`);
  log('If the proxy was running, restart it: npm start');
}

function checkOnly() {
  const branch = defaultBranch();
  const fetch = git(['fetch', 'origin']);
  if (fetch.status !== 0) {
    console.error(fetch.stderr || fetch.stdout);
    process.exit(2);
  }
  const behind = git(['rev-list', '--count', `HEAD..origin/${branch}`]).stdout || '0';
  if (behind === '0') {
    console.log('up-to-date');
    process.exit(0);
  }
  console.log(`updates available: ${behind} commit(s) behind origin/${branch}`);
  process.exit(1);
}

function showStatus() {
  const branch = defaultBranch();
  const head = git(['rev-parse', '--short', 'HEAD']).stdout;
  const msg = git(['log', '-1', '--format=%s', 'HEAD']).stdout;
  console.log(`commit:  ${head} ${msg}`);
  git(['fetch', 'origin']);
  const behind = git(['rev-list', '--count', `HEAD..origin/${branch}`]).stdout || '0';
  const ahead = git(['rev-list', '--count', `origin/${branch}..HEAD`]).stdout || '0';
  console.log(`remote: ${behind === '0' ? 'up-to-date' : `${behind} behind`}${ahead === '0' ? '' : `, ${ahead} ahead`}`);
  if (isDirty()) {
    console.log('working tree: dirty');
    console.log(git(['status', '--porcelain']).stdout);
  } else {
    console.log('working tree: clean');
  }
}

// ─── main ────────────────────────────────────────────────────────────

function ask(rl, prompt) {
  return new Promise(r => rl.question(prompt, r));
}

async function main() {
  // Must run from a git repo
  if (git(['rev-parse', '--is-inside-work-tree']).stdout !== 'true') {
    console.error('[update] Not inside a git repository. Run from the project root.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (args.includes('--check')) { checkOnly(); return; }
  if (args.includes('--status')) { showStatus(); return; }
  if (args.includes('--pull') || args.includes('--pull-noninteractive')) { doPull(); return; }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await interactive(rl);
  rl.close();
}

main().catch(e => { console.error(e); process.exit(1); });
