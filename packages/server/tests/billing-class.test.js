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

/**
 * #7333 — the era is now gated on an OPERATOR FLAG, not the calendar.
 *
 * Anthropic paused the programmatic-credit change on 2026-06-15 and it never
 * shipped, so a bare date comparison asserted a billing regime that does not
 * exist. Every era-ON assertion below therefore has to declare the flag; the
 * era-OFF assertions are the behaviour in force today.
 */
function withEraEnabled(body) {
  const saved = process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
  process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA = '1'
  const restore = () => {
    if (saved === undefined) delete process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
    else process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA = saved
  }
  // Promise-aware on purpose. A plain try/finally restores the flag the moment
  // an ASYNC body returns its promise — i.e. before the body has run — so the
  // assertions execute with the era already off. That silently un-did the
  // wrapper for one async test here, and would have done the same to the next
  // async test added to the sibling copies of this helper.
  let out
  try {
    out = body()
  } catch (err) {
    restore()
    throw err
  }
  if (out && typeof out.then === 'function') return out.finally(restore)
  restore()
  return out
}

/**
 * The mirror of {@link withEraEnabled}, and just as necessary. An era-OFF
 * assertion that merely relies on the flag being absent from the ambient
 * environment tests nothing on a machine where an operator HAS set it: the
 * premise silently inverts and the case either fails for the wrong reason or
 * stops covering the default it exists to pin. Same class as #7360.
 */
function withEraDisabled(body) {
  const saved = process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
  delete process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
  const restore = () => {
    if (saved === undefined) delete process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
    else process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA = saved
  }
  let out
  try {
    out = body()
  } catch (err) {
    restore()
    throw err
  }
  if (out && typeof out.then === 'function') return out.finally(restore)
  restore()
  return out
}

describe('the era is OFF by default (#7333)', () => {
  // The bug in one assertion: on any date at or after the announced cutover,
  // the old code said "programmatic credit pool". It never started.
  it('is false at, after, and long after the announced cutover date', () => withEraDisabled(() => {
    for (const now of [
      PROGRAMMATIC_CREDIT_ERA_START,
      PROGRAMMATIC_CREDIT_ERA_START + 1,
      Date.UTC(2027, 0, 1),
    ]) {
      assert.equal(isProgrammaticCreditEra(now), false, `should be off at ${now}`)
    }
  }))

  it('classifies claude-cli and claude-sdk as subscription after the cutover', () => withEraDisabled(() => {
    for (const p of ['claude-cli', 'claude-sdk']) {
      assert.equal(
        billingClassForProvider(p, Date.UTC(2027, 0, 1)),
        BILLING_CLASSES.SUBSCRIPTION,
        `${p} must not be billed as metered credit`,
      )
    }
  }))

  it('says "Claude subscription" and never mentions a credit pool', () => withEraDisabled(() => {
    const detail = billingDetailForClass(
      billingClassForProvider('claude-cli', Date.UTC(2027, 0, 1)),
    )
    assert.match(detail, /subscription/i)
    assert.equal(/credit pool|metered/i.test(detail), false)
  }))
})

describe('isProgrammaticCreditEra(now) — with the operator flag set', () => {
  it('is false one second before the boundary', () => {
    assert.equal(isProgrammaticCreditEra(JUST_BEFORE), false)
  })
  it('is true exactly at the boundary (>= is inclusive)', () => withEraEnabled(() => {
    assert.equal(isProgrammaticCreditEra(AT_BOUNDARY), true)
  }))
  it('is true one second after the boundary', () => withEraEnabled(() => {
    assert.equal(isProgrammaticCreditEra(ONE_SEC_AFTER), true)
  }))
  // #5825 — pin the inclusivity to the exact millisecond tick, not just a
  // whole second clear of the boundary. This is what makes a future `>=` → `>`
  // off-by-one (or a date drift) fail CI: at START the era is on; at START-1ms
  // it is not.
  it('is true AT the constant instant and false exactly one ms before it', () => withEraEnabled(() => {
    assert.equal(isProgrammaticCreditEra(PROGRAMMATIC_CREDIT_ERA_START), true)
    assert.equal(isProgrammaticCreditEra(PROGRAMMATIC_CREDIT_ERA_START - 1), false)
  }))
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
    it(`${p} is programmatic-credit AT the boundary`, () => withEraEnabled(() => {
      assert.equal(billingClassForProvider(p, AT_BOUNDARY), BILLING_CLASSES.PROGRAMMATIC_CREDIT)
    }))
    it(`${p} is programmatic-credit AFTER the boundary`, () => withEraEnabled(() => {
      assert.equal(billingClassForProvider(p, ONE_SEC_AFTER), BILLING_CLASSES.PROGRAMMATIC_CREDIT)
    }))
    // #5825 — millisecond-precision flip at the exact constant.
    it(`${p} flips exactly at the constant instant (START vs START-1ms)`, () => withEraEnabled(() => {
      assert.equal(billingClassForProvider(p, PROGRAMMATIC_CREDIT_ERA_START), BILLING_CLASSES.PROGRAMMATIC_CREDIT)
      assert.equal(billingClassForProvider(p, PROGRAMMATIC_CREDIT_ERA_START - 1), BILLING_CLASSES.SUBSCRIPTION)
    }))
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
