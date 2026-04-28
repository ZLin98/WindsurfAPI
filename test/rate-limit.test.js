import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  getAccountList,
  getApiKey,
  getRpmStats,
  buildRateLimitSnapshot,
  markRateLimited,
  rememberAccountAffinity,
  releaseAccount,
  removeAccount,
  setAccountTier,
} from '../src/auth.js';
import { handleChatCompletions, rateLimitCooldownMs } from '../src/handlers/chat.js';
import { getExperimental, setExperimental } from '../src/runtime-config.js';

const createdAccountIds = [];
const originalExperimental = getExperimental();

function addTestAccount(label = 'test-account') {
  const account = addAccountByKey(`test-key-${Date.now()}-${Math.random().toString(36).slice(2)}`, label);
  createdAccountIds.push(account.id);
  return account;
}

afterEach(() => {
  setExperimental(originalExperimental);
  while (createdAccountIds.length) {
    removeAccount(createdAccountIds.pop());
  }
});

describe('rate-limit handling', () => {
  it('normalizes upstream message limits into an account snapshot', () => {
    const snapshot = buildRateLimitSnapshot({
      hasCapacity: false,
      messagesRemaining: 3,
      maxMessages: 20,
      retryAfterMs: 90_000,
    }, 1_700_000_000_000);

    assert.equal(snapshot.hasCapacity, false);
    assert.equal(snapshot.messagesRemaining, 3);
    assert.equal(snapshot.maxMessages, 20);
    assert.equal(snapshot.messagesUsed, 17);
    assert.equal(snapshot.percentRemaining, 15);
    assert.equal(snapshot.resetAt, 1_700_000_090_000);
    assert.equal(snapshot.resetAtIso, new Date(1_700_000_090_000).toISOString());
    assert.equal(snapshot.fetchedAt, 1_700_000_000_000);
  });

  it('keeps unknown upstream message limits explicit instead of inventing totals', () => {
    const snapshot = buildRateLimitSnapshot({
      hasCapacity: true,
      messagesRemaining: -1,
      maxMessages: -1,
      retryAfterMs: null,
    }, 1_700_000_000_000);

    assert.equal(snapshot.hasCapacity, true);
    assert.equal(snapshot.messagesRemaining, -1);
    assert.equal(snapshot.maxMessages, -1);
    assert.equal(snapshot.messagesUsed, null);
    assert.equal(snapshot.percentRemaining, null);
    assert.equal(snapshot.resetAt, null);
  });

  it('does not poison local cooldowns when preflight has no retryAfter hint', async () => {
    const account = addTestAccount('preflight-no-hint');
    let checks = 0;
    setExperimental({ preflightRateLimit: true });

    const request = {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const context = {
      async checkMessageRateLimit() {
        checks++;
        return { hasCapacity: false, messagesRemaining: 0, maxMessages: 1, retryAfterMs: null };
      },
      async waitForAccount(tried, signal, maxWaitMs, modelKey) {
        return tried.length === 0 ? getApiKey(tried, modelKey) : null;
      },
    };

    const first = await handleChatCompletions(request, context);
    const second = await handleChatCompletions(request, context);
    const listed = getAccountList().find(a => a.id === account.id);

    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.equal(checks, 2);
    assert.deepEqual(listed.modelRateLimits, {});
  });

  it('parses explicit retry-after seconds instead of defaulting to five minutes', () => {
    assert.equal(rateLimitCooldownMs('Please retry after 117 seconds'), 117000);
    assert.equal(rateLimitCooldownMs('quota hit'), 60000);
  });

  it('parses Cascade reset windows into real model cooldowns', () => {
    assert.equal(
      rateLimitCooldownMs('Reached message rate limit for this model. Please try again later. Resets in: 2h59m58s (trace ID: abc)'),
      (2 * 60 * 60 * 1000) + (59 * 60 * 1000) + (58 * 1000)
    );
    assert.equal(rateLimitCooldownMs('Resets in: 59s'), 59000);
    assert.equal(rateLimitCooldownMs('resets in 3h'), 3 * 60 * 60 * 1000);
  });

  it('does not extend an existing cooldown when a later 429 arrives for the same model', async () => {
    const account = addTestAccount('max-extend');
    const modelKey = 'gemini-2.5-flash';

    markRateLimited(account.apiKey, 2000, modelKey);
    const firstUntil = getAccountList().find(a => a.id === account.id).modelRateLimits[modelKey];
    await new Promise(resolve => setTimeout(resolve, 250));
    markRateLimited(account.apiKey, 1750, modelKey);
    const secondUntil = getAccountList().find(a => a.id === account.id).modelRateLimits[modelKey];

    assert.ok(secondUntil >= firstUntil);
    assert.ok(secondUntil - firstUntil < 120, `expected max-extend semantics, got delta ${secondUntil - firstUntil}ms`);
  });

  it('surfaces real model cooldown expiries in account list state', () => {
    const account = addTestAccount('real-expiry');
    const modelKey = 'gemini-2.5-flash';
    const now = Date.now();

    markRateLimited(account.apiKey, 1200, modelKey);
    const listed = getAccountList().find(a => a.id === account.id);
    const until = listed.modelRateLimits[modelKey];
    const detail = listed.modelRateLimitDetails.find(x => x.modelKey === modelKey);

    assert.ok(until >= now + 1000, `expected near-real expiry, got ${until - now}ms`);
    assert.ok(until <= now + 2500, `expected short cooldown, got ${until - now}ms`);
    assert.equal(detail.modelKey, modelKey);
    assert.equal(detail.resetAt, until);
    assert.ok(detail.retryAfterMs >= 1000, `expected retryAfterMs >= 1000, got ${detail.retryAfterMs}`);
    assert.ok(detail.retryAfterSec >= 1, `expected retryAfterSec >= 1, got ${detail.retryAfterSec}`);
  });

  it('prefers the previous successful account for the same caller and model', () => {
    const first = addTestAccount('affinity-first');
    const second = addTestAccount('affinity-second');
    const modelKey = 'gemini-2.5-flash';

    const warmedSecond = getApiKey([first.apiKey], modelKey);
    assert.equal(warmedSecond.apiKey, second.apiKey);
    releaseAccount(warmedSecond.apiKey);

    rememberAccountAffinity(second.apiKey, modelKey, 'caller-sticky');
    const selected = getApiKey([], modelKey, 'caller-sticky');

    assert.equal(selected.apiKey, second.apiKey);
    releaseAccount(selected.apiKey);
  });

  it('falls back from a sticky account when that model is cooling down', () => {
    const first = addTestAccount('affinity-fallback-first');
    const second = addTestAccount('affinity-fallback-second');
    const modelKey = 'gemini-2.5-flash';

    rememberAccountAffinity(second.apiKey, modelKey, 'caller-sticky-limited');
    markRateLimited(second.apiKey, 60_000, modelKey);

    const selected = getApiKey([], modelKey, 'caller-sticky-limited');
    assert.equal(selected.apiKey, first.apiKey);
    releaseAccount(selected.apiKey);
  });

  it('returns 429 when every eligible account is locally RPM-exhausted', async () => {
    const account = addTestAccount('rpm-full');
    setAccountTier(account.id, 'free');

    for (let i = 0; i < 10; i++) {
      const checkedOut = getApiKey([], 'gemini-2.5-flash');
      assert.equal(checkedOut?.apiKey, account.apiKey);
      releaseAccount(account.apiKey);
    }

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async waitForAccount() {
        return null;
      },
    });

    assert.equal(result.status, 429);
    assert.equal(result.body.error.type, 'rate_limit_exceeded');
    assert.match(result.headers['Retry-After'], /^\d+$/);
  });

  it('refunds RPM reservations when preflight skips the upstream request', async () => {
    const account = addTestAccount('refund-preflight');
    setExperimental({ preflightRateLimit: true });

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async checkMessageRateLimit() {
        return { hasCapacity: false, messagesRemaining: 0, maxMessages: 1, retryAfterMs: null };
      },
      async waitForAccount(tried, signal, maxWaitMs, modelKey) {
        return tried.length === 0 ? getApiKey(tried, modelKey) : null;
      },
    });

    assert.equal(result.status, 503);
    assert.equal(getRpmStats()[account.id].used, 0);
  });
});
