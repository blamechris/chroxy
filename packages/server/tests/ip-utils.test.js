// #5831: ip-utils — IPv4/IPv6 validation + IPv6 canonicalisation shared by the
// egress resolver and the datacenter classifier.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isIpv4, isIpv6, expandIpv6, normalizeIpv6Prefix } from '../src/ip-utils.js'

test('isIpv4 accepts dotted quads in range, rejects junk and out-of-range', () => {
  assert.equal(isIpv4('1.2.3.4'), true)
  assert.equal(isIpv4('255.0.1.255'), true)
  assert.equal(isIpv4('999.999.999.999'), false)
  assert.equal(isIpv4('1.2.3'), false)
  assert.equal(isIpv4('2a01:4f8::1'), false)
  assert.equal(isIpv4(''), false)
  assert.equal(isIpv4(undefined), false)
})

test('expandIpv6 canonicalises compressed, padded, and full forms', () => {
  assert.equal(expandIpv6('2a01:4f8::1'), '2a01:04f8:0000:0000:0000:0000:0000:0001')
  assert.equal(expandIpv6('::1'), '0000:0000:0000:0000:0000:0000:0000:0001')
  assert.equal(expandIpv6('::'), '0000:0000:0000:0000:0000:0000:0000:0000')
  assert.equal(
    expandIpv6('2001:0db8:0000:0000:0000:0000:0000:0001'),
    '2001:0db8:0000:0000:0000:0000:0000:0001',
  )
  // uppercase is lowercased
  assert.equal(expandIpv6('2A01:4F8::1'), '2a01:04f8:0000:0000:0000:0000:0000:0001')
})

test('expandIpv6 strips a zone id and brackets', () => {
  assert.equal(expandIpv6('[2a01:4f8::1]'), '2a01:04f8:0000:0000:0000:0000:0000:0001')
  assert.equal(expandIpv6('fe80::1%eth0'), 'fe80:0000:0000:0000:0000:0000:0000:0001')
})

test('expandIpv6 rejects invalid addresses', () => {
  assert.equal(expandIpv6('not-an-ip'), null)
  assert.equal(expandIpv6('1.2.3.4'), null)          // no colon
  assert.equal(expandIpv6('2a01::4f8::1'), null)     // two `::`
  assert.equal(expandIpv6('1:2:3:4:5:6:7'), null)    // too few groups, no `::`
  assert.equal(expandIpv6('1:2:3:4:5:6:7:8:9'), null) // too many groups
  assert.equal(expandIpv6('2a01:4f8:zzzz::1'), null) // non-hex group
  assert.equal(expandIpv6('1:2:3:4:5:6:7:8::'), null) // `::` standing in for nothing
})

test('isIpv6 mirrors expandIpv6 validity', () => {
  assert.equal(isIpv6('2a01:4f8::1'), true)
  assert.equal(isIpv6('::1'), true)
  assert.equal(isIpv6('1.2.3.4'), false)
  assert.equal(isIpv6('garbage'), false)
})

test('normalizeIpv6Prefix zero-pads each group, preserving the trailing colon', () => {
  assert.equal(normalizeIpv6Prefix('2a02:1370:'), '2a02:1370:')
  assert.equal(normalizeIpv6Prefix('2A01:4F8:'), '2a01:04f8:')
  assert.equal(normalizeIpv6Prefix('2001:db8:'), '2001:0db8:')
})
