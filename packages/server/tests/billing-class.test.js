import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BILLING_CLASSES,
  PROGRAMMATIC_CREDIT_ERA_START,
  isProgrammaticCreditEra,
  billingClassForProvider,
  billingDetailForClass,
} from '../src/billing-class.js'

// Fixed instants around the 2026-06-15T00:00:00Z boundary. All tests pass an
// explicit `now` — NO Date.now() / fake timers (#5630 acceptance criterion).
const JUST_BEFORE = Date.parse('2026-06-14T23:59:59Z')
const AT_BOUNDARY = Date.parse('2026-06-15T00:00:00Z')
const ONE_SEC_AFTER = AT_BOUNDARY + 1000

describe('PROGRAMMATIC_CREDIT_ERA_START', () => {
  it('is exactly 2026-06-15T00:00:00 UTC', () => {
    assert.equal(PROGRAMMATIC_CREDIT_ERA_START, Date.UTC(2026, 5, 15))
    assert.equal(PROGRAMMATIC_CREDIT_ERA_START, AT_BOUNDARY)
  })
})

describe('isProgrammaticCreditEra(now)', () => {
  it('is false one second before the boundary', () => {
    assert.equal(isProgrammaticCreditEra(JUST_BEFORE), false)
  })
  it('is true exactly at the boundary (>= is inclusive)', () => {
    assert.equal(isProgrammaticCreditEra(AT_BOUNDARY), true)
  })
  it('is true one second after the boundary', () => {
    assert.equal(isProgrammaticCreditEra(ONE_SEC_AFTER), true)
  })
  // #5825 — pin the inclusivity to the exact millisecond tick, not just a
  // whole second clear of the boundary. This is what makes a future `>=` → `>`
  // off-by-one (or a date drift) fail CI: at START the era is on; at START-1ms
  // it is not.
  it('is true AT the constant instant and false exactly one ms before it', () => {
    assert.equal(isProgrammaticCreditEra(PROGRAMMATIC_CREDIT_ERA_START), true)
    assert.equal(isProgrammaticCreditEra(PROGRAMMATIC_CREDIT_ERA_START - 1), false)
  })
})

describe('billingClassForProvider — era-independent classes', () => {
  for (const now of [JUST_BEFORE, AT_BOUNDARY, ONE_SEC_AFTER]) {
    it(`api-key providers are always api-key (now=${now})`, () => {
      assert.equal(billingClassForProvider('claude-byok', now), BILLING_CLASSES.API_KEY)
      assert.equal(billingClassForProvider('docker-byok', now), BILLING_CLASSES.API_KEY)
      // docker-cli / docker-sdk forward a key into the container (no OAuth
      // fallback), so they bill the raw API account regardless of the era.
      assert.equal(billingClassForProvider('docker-cli', now), BILLING_CLASSES.API_KEY)
      assert.equal(billingClassForProvider('docker-sdk', now), BILLING_CLASSES.API_KEY)
    })
    it(`subscription providers are always subscription (now=${now})`, () => {
      assert.equal(billingClassForProvider('claude-tui', now), BILLING_CLASSES.SUBSCRIPTION)
      assert.equal(billingClassForProvider('claude-channel', now), BILLING_CLASSES.SUBSCRIPTION)
    })
    it(`non-Claude providers are always api-key (now=${now})`, () => {
      for (const p of ['codex', 'gemini', 'deepseek', 'ollama', 'anthropic-compatible', 'some-custom-provider']) {
        assert.equal(billingClassForProvider(p, now), BILLING_CLASSES.API_KEY, p)
      }
    })
  }
})

describe('billingClassForProvider — era-gated programmatic providers', () => {
  const PROGRAMMATIC = ['claude-cli', 'claude-sdk']
  for (const p of PROGRAMMATIC) {
    it(`${p} is subscription BEFORE the boundary`, () => {
      assert.equal(billingClassForProvider(p, JUST_BEFORE), BILLING_CLASSES.SUBSCRIPTION)
    })
    it(`${p} is programmatic-credit AT the boundary`, () => {
      assert.equal(billingClassForProvider(p, AT_BOUNDARY), BILLING_CLASSES.PROGRAMMATIC_CREDIT)
    })
    it(`${p} is programmatic-credit AFTER the boundary`, () => {
      assert.equal(billingClassForProvider(p, ONE_SEC_AFTER), BILLING_CLASSES.PROGRAMMATIC_CREDIT)
    })
    // #5825 — millisecond-precision flip at the exact constant.
    it(`${p} flips exactly at the constant instant (START vs START-1ms)`, () => {
      assert.equal(billingClassForProvider(p, PROGRAMMATIC_CREDIT_ERA_START), BILLING_CLASSES.PROGRAMMATIC_CREDIT)
      assert.equal(billingClassForProvider(p, PROGRAMMATIC_CREDIT_ERA_START - 1), BILLING_CLASSES.SUBSCRIPTION)
    })
  }
})

describe('billingClassForProvider — apiKeyAuth refinement', () => {
  it('forces api-key for claude-sdk with an explicit key, in BOTH eras', () => {
    assert.equal(
      billingClassForProvider('claude-sdk', JUST_BEFORE, { apiKeyAuth: true }),
      BILLING_CLASSES.API_KEY,
    )
    assert.equal(
      billingClassForProvider('claude-sdk', ONE_SEC_AFTER, { apiKeyAuth: true }),
      BILLING_CLASSES.API_KEY,
    )
  })
  it('forces api-key for claude-cli with an explicit key, in BOTH eras', () => {
    assert.equal(
      billingClassForProvider('claude-cli', JUST_BEFORE, { apiKeyAuth: true }),
      BILLING_CLASSES.API_KEY,
    )
    assert.equal(
      billingClassForProvider('claude-cli', ONE_SEC_AFTER, { apiKeyAuth: true }),
      BILLING_CLASSES.API_KEY,
    )
  })
  it('apiKeyAuth has no effect on era-independent subscription providers', () => {
    assert.equal(
      billingClassForProvider('claude-tui', ONE_SEC_AFTER, { apiKeyAuth: true }),
      BILLING_CLASSES.SUBSCRIPTION,
    )
  })
})

describe('billingDetailForClass', () => {
  it('returns class-specific human copy', () => {
    assert.match(billingDetailForClass(BILLING_CLASSES.API_KEY), /per-token/i)
    assert.match(billingDetailForClass(BILLING_CLASSES.PROGRAMMATIC_CREDIT), /credit pool/i)
    assert.match(billingDetailForClass(BILLING_CLASSES.SUBSCRIPTION), /subscription/i)
  })
  it('prefixes the provider label when given', () => {
    assert.match(
      billingDetailForClass(BILLING_CLASSES.API_KEY, { providerLabel: 'DeepSeek' }),
      /^DeepSeek: /,
    )
  })
})
