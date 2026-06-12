import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from '../guardrails/PolicyEngine.js';
import type { Policy } from '../types.js';

// Default policy — same as loom init produces
const defaultEngine = new PolicyEngine(PolicyEngine.defaultPolicy());

// Engine with an allowed remote configured
const withRemote = new PolicyEngine({
  ...PolicyEngine.defaultPolicy(),
  git: {
    ...PolicyEngine.defaultPolicy().git,
    allowed_remotes: ['git@github.com:myorg/*'],
    agents_must_use_pr: true,
  },
} as Policy);

// ─── git: forbidden flags ──────────────────────────────────────────────────

describe('PolicyEngine — git forbidden flags', () => {
  it('blocks git push --force', () => {
    const r = defaultEngine.check('git push --force');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('blocks git push --force-with-lease', () => {
    const r = defaultEngine.check('git push --force-with-lease');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('blocks git reset --hard HEAD~1', () => {
    const r = defaultEngine.check('git reset --hard HEAD~1');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('blocks git push --force=target', () => {
    // Handles --flag=value form
    const r = defaultEngine.check('git push --force=origin');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('allows git add .', () => {
    const r = defaultEngine.check('git add .');
    assert.equal(r.allowed, true);
  });

  it('allows git commit -m "message"', () => {
    const r = defaultEngine.check('git commit -m "add feature"');
    assert.equal(r.allowed, true);
  });

  it('allows git status', () => {
    const r = defaultEngine.check('git status');
    assert.equal(r.allowed, true);
  });
});

// ─── git: allowed remotes ─────────────────────────────────────────────────

describe('PolicyEngine — git allowed remotes', () => {
  it('blocks push to URL when allowed_remotes is empty', () => {
    const r = defaultEngine.check('git push git@github.com:someorg/repo.git story/001');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.allowed_remotes');
  });

  it('allows push to URL matching allowed_remotes glob', () => {
    const r = withRemote.check('git push git@github.com:myorg/myrepo.git story/001');
    assert.equal(r.allowed, true);
  });

  it('blocks push to URL not matching allowed_remotes glob', () => {
    const r = withRemote.check('git push git@github.com:stranger/repo.git story/001');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.allowed_remotes');
  });

  it('allows push to named remote (cannot resolve URL at check time)', () => {
    // Named remotes like "origin" cannot be validated without resolving the remote URL
    const r = withRemote.check('git push origin story/001');
    assert.equal(r.allowed, true);
  });
});

// ─── filesystem: protected paths ──────────────────────────────────────────

describe('PolicyEngine — filesystem protected paths', () => {
  it('blocks rm -rf ~/.ssh', () => {
    const r = defaultEngine.check('rm -rf ~/.ssh');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'filesystem.protected_paths');
  });

  it('blocks rm -rf ~/.aws', () => {
    const r = defaultEngine.check('rm -rf ~/.aws');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'filesystem.protected_paths');
  });

  it('blocks rm /etc/passwd', () => {
    const r = defaultEngine.check('rm /etc/passwd');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'filesystem.protected_paths');
  });

  it('blocks rm /usr/local/bin/node', () => {
    const r = defaultEngine.check('rm /usr/local/bin/node');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'filesystem.protected_paths');
  });

  it('blocks write commands touching ~/.gnupg', () => {
    const r = defaultEngine.check('cp key.gpg ~/.gnupg/private.gpg');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'filesystem.protected_paths');
  });

  it('allows rm -rf ./dist (within project)', () => {
    const r = defaultEngine.check('rm -rf ./dist');
    assert.equal(r.allowed, true);
  });

  it('allows rm -rf ./node_modules', () => {
    const r = defaultEngine.check('rm -rf ./node_modules');
    assert.equal(r.allowed, true);
  });

  it('blocks rm of path outside allowed_write_root', () => {
    const r = defaultEngine.check('rm -rf /tmp/some-file');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'filesystem.allowed_write_root');
  });
});

// ─── shell metacharacters (chained command bypass) ────────────────────────

describe('PolicyEngine — shell metacharacters', () => {
  it('blocks semicolon chaining', () => {
    const r = defaultEngine.check('git status; git push --force');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
  });

  it('blocks && chaining', () => {
    const r = defaultEngine.check('git add . && git push --force');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
  });

  it('blocks || chaining', () => {
    const r = defaultEngine.check('test -f file || rm -rf ~/.ssh');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
  });

  it('blocks backtick substitution', () => {
    const r = defaultEngine.check('echo `rm -rf ~/.ssh`');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
  });

  it('blocks $() substitution', () => {
    const r = defaultEngine.check('echo $(rm -rf ~/.ssh)');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
  });

  it('blocks trailing-semicolon flag bypass', () => {
    // The original parser would have allowed this because the flag-check
    // matched '--force' exactly but the token was '--force;'
    const r = defaultEngine.check('git push --force;');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
  });

  it('allows && inside quoted commit messages (false-positive guard)', () => {
    const r = defaultEngine.check('git commit -m "feat: combine a && b"');
    assert.equal(r.allowed, true);
  });

  it('allows ; inside quoted commit messages', () => {
    const r = defaultEngine.check('git commit -m "fix: handle ; case"');
    assert.equal(r.allowed, true);
  });

  it('allows pipes (we scan for paths in the raw string anyway)', () => {
    const r = defaultEngine.check('ls -la | grep loom');
    assert.equal(r.allowed, true);
  });
});

// ─── shell redirection (fd-duplication forms are not backgrounding) ───────

describe('PolicyEngine — redirection forms', () => {
  it('allows stderr-to-stdout merge: npm test 2>&1', () => {
    const r = defaultEngine.check('npm test 2>&1');
    assert.equal(r.allowed, true);
  });

  it('allows stdout-to-stderr: npm test >&2', () => {
    const r = defaultEngine.check('npm test >&2');
    assert.equal(r.allowed, true);
  });

  it('allows m>&n duplication: cmd 3>&2', () => {
    const r = defaultEngine.check('cmd 3>&2');
    assert.equal(r.allowed, true);
  });

  it('allows symmetric input duplication: cmd <&0', () => {
    const r = defaultEngine.check('cmd <&0');
    assert.equal(r.allowed, true);
  });

  it('allows n<&m duplication: cmd 4<&3', () => {
    const r = defaultEngine.check('cmd 4<&3');
    assert.equal(r.allowed, true);
  });

  it('allows fd close: cmd 2>&-', () => {
    const r = defaultEngine.check('cmd 2>&-');
    assert.equal(r.allowed, true);
  });

  it('allows input fd close: cmd <&-', () => {
    const r = defaultEngine.check('cmd <&-');
    assert.equal(r.allowed, true);
  });

  it('allows combined redirect: npm test &> out.log', () => {
    const r = defaultEngine.check('npm test &> out.log');
    assert.equal(r.allowed, true);
  });

  it('allows combined append redirect: npm test &>> out.log', () => {
    const r = defaultEngine.check('npm test &>> out.log');
    assert.equal(r.allowed, true);
  });

  it('blocks trailing backgrounding: sleep 10 &', () => {
    const r = defaultEngine.check('sleep 10 &');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
    assert.match(r.reason ?? '', /backgrounding/);
  });

  it('blocks mid-command backgrounding: a & b', () => {
    const r = defaultEngine.check('a & b');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
    assert.match(r.reason ?? '', /backgrounding/);
  });

  it('blocks && chaining smuggled past redirection: foo 2>&1 && rm -rf /', () => {
    const r = defaultEngine.check('foo 2>&1 && rm -rf /');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
  });

  it('blocks semicolon chaining smuggled past redirection: foo 2>&1 ; bar', () => {
    const r = defaultEngine.check('foo 2>&1 ; bar');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
  });

  it('blocks ambiguous variable fd target: >& $FD (fail-safe)', () => {
    const r = defaultEngine.check('cmd >& $FD');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
  });

  it('blocks exotic non-token form: {fd}>&1 (fail-safe)', () => {
    const r = defaultEngine.check('cmd {fd}>&1');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
  });

  it('blocks mixed redirection plus trailing backgrounding: npm test 2>&1 &', () => {
    const r = defaultEngine.check('npm test 2>&1 &');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.metacharacters');
    assert.match(r.reason ?? '', /backgrounding/);
  });
});

// ─── wrapper programs (eval, bash -c) ─────────────────────────────────────

describe('PolicyEngine — wrapper programs', () => {
  it('blocks bash -c', () => {
    const r = defaultEngine.check('bash -c "git push --force"');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.wrapper_program');
  });

  it('blocks sh -c', () => {
    const r = defaultEngine.check('sh -c "rm -rf ~/.ssh"');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.wrapper_program');
  });

  it('blocks eval', () => {
    const r = defaultEngine.check('eval "git push --force"');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.wrapper_program');
  });

  it('blocks zsh', () => {
    const r = defaultEngine.check('zsh -c "anything"');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.wrapper_program');
  });

  it('blocks env (could shadow PATH)', () => {
    const r = defaultEngine.check('env PATH=/tmp/evil git push');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'shell.wrapper_program');
  });
});

// ─── edge cases ────────────────────────────────────────────────────────────

describe('PolicyEngine — edge cases', () => {
  it('handles empty command gracefully', () => {
    const r = defaultEngine.check('');
    assert.equal(r.allowed, true);
  });

  it('handles command with only whitespace', () => {
    const r = defaultEngine.check('   ');
    assert.equal(r.allowed, true);
  });

  it('handles single-quoted arguments', () => {
    const r = defaultEngine.check("git push --force 'origin'");
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('handles double-quoted arguments', () => {
    const r = defaultEngine.check('git commit -m "fix: resolve issue"');
    assert.equal(r.allowed, true);
  });

  it('allows non-git, non-rm commands freely', () => {
    const r = defaultEngine.check('npm install');
    assert.equal(r.allowed, true);
  });

  it('allows node script execution', () => {
    const r = defaultEngine.check('node dist/index.js');
    assert.equal(r.allowed, true);
  });
});
