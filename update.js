#!/usr/bin/env node
/**
 * update.js — update FreeDeepseekAPI from the Git remote without losing local auth/config.
 *
 * Commands:
 *   node update.js            interactive menu
 *   node update.js --check    check if updates are available (exit code 0=up-to-date, 1=updates)
 *   node update.js --pull     non-interactive pull (stash auth → git pull → restore)
 *   node update.js --status   show current commit + remote status
 *
 * No npm dependencies — pure Node.js 18+.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ─── helpers ─────────────────────────────────────────────────────────

const repo = process.cwd();
const protected = [
  '.env',
  'auth.json',
  'deepseek-auth.json',
  'accounts/*.json',
  'package-lock.json',
];

/** Is a file tracked by git? */
function tracked(fp) {
  try {
    execSync(`git ls-files --error-unmatch "${fp}"`, { cwd: repo, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Run git with args, return {stdout, stderr, status} */
function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8', ...opts });
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), status: r.status };
}

function log(...args) { console.log(args.join(' ')); }

// ─── stash protected / restore ───────────────────────────────────────

function stashProtected() {
  const files = [];
  for (const pat of protected) {
    try {
      // expand glob via git ls-files (untracked files won't be in git but still need stash)
      const r = execSync(`ls ${pat} 2>/dev/null`, { cwd: repo, encoding: 'utf-8' }).trim();
      if (r) files.push(...r.split('\n').filter(Boolean));
    } catch {}
  }
  // also any existing untracked that matches
  const untracked = [];
  for (const pat of protected) {
    try {
      const r = execSync(`git ls-files --others --exclude-standard ${pat}`, { cwd: repo, encoding: 'utf-8' }).trim();
      if (r) untracked.push(...r.split('\n').filter(Boolean));
    } catch {}
  }
  const stashSet = new Set([...files, ...untracked]);
  const stashList = [...stashSet].filter(f => fs.existsSync(path.join(repo, f)));
  if (stashList.length === 0) return { staged: [], unstaged: [], untracked: [] };

  // Separate into tracked (staged/unstaged) vs untracked
  const trackedF = stashList.filter(f => tracked(f));
  const untrackedF = stashList.filter(f => !tracked(f));

  // --include-untracked for untracked files only
  const untrackedPaths = untrackedF.map(f => `--untracked-files=${f}`);

  // Try a targeted stash: stash only the protected tracked files + untracked
  const args = ['stash', 'push', '--include-untracked', '-m', 'update-protected'];
  if (trackedF.length || untrackedF.length) {
    const paths = [...trackedF, ...untrackedF];
    // git stash push <pathspec> stashes only the matching tracked files but
    // we also want untracked — --include-untracked handles that.
    args.push('--', ...paths);
  }

  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
  if (r.status !== 0) {
    console.error(`[update] stash failed: ${r.stderr}`);
    return { staged: [], unstaged: [], untracked: [] };
  }
  console.log('[update] Stashed protected files:', stashList.join(', '));
  return { stashIndex: 0 };
}

function restoreProtected() {
  // pop the stash created by stashProtected
  const alts = ['stash@{0}', 'stash@{1}', '0'];
  for (const ref of alts) {
    const r = spawnSync('git', ['stash', 'pop', ref], { cwd: repo, encoding: 'utf-8' });
    if (r.status === 0) {
      console.log('[update] Restored stashed protected files.');
      return true;
    }
    if (!r.stderr.includes(ref) && !r.stderr.includes('No stash')) {
      console.error(`[update] stash pop ${ref} failed: ${r.stderr}`);
    }
  }
  console.warn('[update] No stash to restore (protected files may not have changed).');
  return false;
}

// ─── commands ────────────────────────────────────────────────────────

async function interactive(rl) {
  // show current commit
  const head = git(['rev-parse', '--short', 'HEAD']).stdout;
  log(`\n=== FreeDeepseekAPI Update ===`);
  log(`Current commit: ${head}`);
  log(`Remote: ${git(['remote', 'get-url', 'origin']).stdout}\n`);

  // fetch without touching working tree
  log('Fetching remote...');
  git(['fetch', 'origin']);

  const behind = git(['rev-list', '--count', 'HEAD..origin/main']).stdout || '0';
  const ahead = git(['rev-list', '--count', 'origin/main..HEAD']).stdout || '0';

  if (behind === '0' && ahead === '0') {
    log('✅ Up to date. Nothing to update.');
    return;
  }

  log(`Remote: ${behind} commit(s) ahead, ${ahead} local-only commit(s)`);

  if (ahead !== '0') {
    log('⚠️  You have local commits not on the remote. Update will rebase them on top.');
  }

  const answer = await ask(rl, 'Pull update? [y/N] ');
  if (!answer.toLowerCase().startsWith('y')) {
    log('Cancelled.');
    return;
  }
  doPull();
}

function doPull() {
  stashProtected();

  // Rebase is safer: it keeps our local commits on top
  const r = git(['pull', '--rebase', 'origin', 'main']);
  if (r.status !== 0) {
    console.error(`[update] git pull --rebase failed:\n${r.stderr}`);
    console.log('[update] Aborting rebase and restoring...');
    git(['rebase', '--abort']);
    restoreProtected();
    process.exit(1);
  }

  restoreProtected();

  // Re-run syntax check
  log('\n[update] Running syntax check...');
  const check = spawnSync('node', ['--check', 'server.js'], { cwd: repo, encoding: 'utf-8' });
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
  git(['fetch', 'origin']);
  const behind = git(['rev-list', '--count', 'HEAD..origin/main']).stdout || '0';
  if (behind === '0') {
    console.log('up-to-date');
    process.exit(0);
  }
  console.log(`updates available: ${behind} commit(s) behind origin/main`);
  process.exit(1);
}

function showStatus() {
  const head = git(['rev-parse', '--short', 'HEAD']).stdout;
  const msg = git(['log', '-1', '--format=%s', 'HEAD']).stdout;
  console.log(`commit:  ${head} ${msg}`);
  git(['fetch', 'origin']);
  const behind = git(['rev-list', '--count', 'HEAD..origin/main']).stdout || '0';
  const ahead = git(['rev-list', '--count', 'origin/main..HEAD']).stdout || '0';
  console.log(`remote: ${behind === '0' ? 'up-to-date' : `${behind} behind`}${ahead === '0' ? '' : `, ${ahead} ahead`}`);
}

// ─── main ────────────────────────────────────────────────────────────

function ask(rl, prompt) {
  return new Promise(r => rl.question(prompt, r));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) { checkOnly(); return; }
  if (args.includes('--status')) { showStatus(); return; }
  if (args.includes('--pull') || args.includes('--pull-noninteractive')) { doPull(); return; }

  // interactive
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await interactive(rl);
  rl.close();
}

main().catch(e => { console.error(e); process.exit(1); });