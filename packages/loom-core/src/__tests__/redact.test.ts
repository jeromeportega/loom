import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../util/redact.js';

describe('redactSecrets (util/redact.ts)', () => {
  it('[AC4] masks an Anthropic sk-ant-... key embedded in surrounding text', () => {
    const input = 'Using key sk-ant-api03-abc123XYZ789abcdefghijklmnop for requests';
    const out = redactSecrets(input);
    assert.ok(!out.includes('sk-ant-api03-abc123XYZ789abcdefghijklmnop'), 'original key must not appear');
    assert.ok(out.includes('sk-ant-[REDACTED]'), 'replacement placeholder must appear');
    assert.ok(out.startsWith('Using key '), 'surrounding text before must be preserved');
    assert.ok(out.endsWith(' for requests'), 'surrounding text after must be preserved');
  });

  it('[AC4] masks a GitHub PAT classic (ghp_) embedded in surrounding text', () => {
    const pat = 'ghp_' + 'A'.repeat(36);
    const input = `token=${pat}&other=foo`;
    const out = redactSecrets(input);
    assert.ok(!out.includes(pat), 'original PAT must not appear');
    assert.ok(out.includes('ghp_[REDACTED]'), 'ghp_ placeholder must appear');
    assert.ok(out.includes('&other=foo'), 'surrounding text must be preserved');
  });

  it('[AC4] masks a fine-grained GitHub PAT (github_pat_)', () => {
    const pat = 'github_pat_' + 'B'.repeat(40);
    const out = redactSecrets(`secret: ${pat}`);
    assert.ok(!out.includes(pat));
    assert.ok(out.includes('github_pat_[REDACTED]'));
  });

  it('[AC4] leaves secret-free text byte-identical', () => {
    const safe = 'Hello, world! No secrets here. Version: 1.2.3';
    assert.equal(redactSecrets(safe), safe);
  });

  it('[AC4] is idempotent — redacting already-redacted output is a no-op', () => {
    const input = `key=sk-ant-api03-${'x'.repeat(20)}`;
    const once = redactSecrets(input);
    const twice = redactSecrets(once);
    assert.equal(once, twice, 'second pass must produce the same output as first');
    assert.ok(once.includes('sk-ant-[REDACTED]'), 'placeholder present after first pass');
  });

  it('[AC4] handles empty string without throwing', () => {
    assert.doesNotThrow(() => redactSecrets(''));
    assert.equal(redactSecrets(''), '');
  });

  it('[AC4] does not throw on a partial/split token (short key-like prefix)', () => {
    // A token split across two chunks — the partial prefix should not match
    // the pattern requiring >=10 chars after `sk-ant-`.
    const partial = 'sk-ant-ab'; // 2 chars after prefix — below minimum
    assert.doesNotThrow(() => redactSecrets(partial));
    assert.equal(redactSecrets(partial), partial, 'partial token must pass through unchanged');
  });

  it('[AC4] redacts multiple secrets in one chunk', () => {
    const key = 'sk-ant-api03-' + 'Z'.repeat(20);
    const pat = 'ghp_' + 'Y'.repeat(36);
    const input = `key=${key} token=${pat}`;
    const out = redactSecrets(input);
    assert.ok(!out.includes(key));
    assert.ok(!out.includes(pat));
    assert.ok(out.includes('sk-ant-[REDACTED]'));
    assert.ok(out.includes('ghp_[REDACTED]'));
  });

  it('[AC4] GitHub other tokens preserve token-type prefix in placeholder', () => {
    // Each token type must produce a type-specific placeholder so incident
    // responders can identify which credential family to rotate.
    const oauthTok = 'gho_' + 'A'.repeat(25);
    const userTok = 'ghu_' + 'B'.repeat(25);
    const serverTok = 'ghs_' + 'C'.repeat(25);
    const actionTok = 'ghf_' + 'D'.repeat(25);

    assert.equal(redactSecrets(`tok=${oauthTok}`), 'tok=gho_[REDACTED]');
    assert.equal(redactSecrets(`tok=${userTok}`), 'tok=ghu_[REDACTED]');
    assert.equal(redactSecrets(`tok=${serverTok}`), 'tok=ghs_[REDACTED]');
    assert.equal(redactSecrets(`tok=${actionTok}`), 'tok=ghf_[REDACTED]');
  });

  it('[AC4] GITHUB_OTHER redaction is idempotent (placeholder never re-matches)', () => {
    const tok = 'gho_' + 'A'.repeat(25);
    const once = redactSecrets(tok);
    const twice = redactSecrets(once);
    assert.equal(once, twice, 'second pass must produce same result as first');
    assert.equal(once, 'gho_[REDACTED]');
  });
});
