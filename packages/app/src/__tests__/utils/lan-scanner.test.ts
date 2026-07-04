import {
  validatePort,
  isScannableIpv4,
  deriveSubnet24,
} from '../../utils/lan-scanner';

describe('validatePort', () => {
  it('accepts valid ports in range', () => {
    expect(validatePort('8765')).toBe(8765);
    expect(validatePort('1')).toBe(1);
    expect(validatePort('65535')).toBe(65535);
  });

  it('rejects out-of-range, non-numeric, and empty input', () => {
    expect(validatePort('0')).toBeNull();
    expect(validatePort('65536')).toBeNull();
    expect(validatePort('')).toBeNull();
    expect(validatePort('80a')).toBeNull();
    expect(validatePort('-1')).toBeNull();
    expect(validatePort('12.5')).toBeNull();
  });
});

describe('isScannableIpv4', () => {
  it('accepts real host addresses on private and other ranges', () => {
    expect(isScannableIpv4('10.0.0.71')).toBe(true);
    expect(isScannableIpv4('192.168.1.5')).toBe(true);
    expect(isScannableIpv4('172.16.4.2')).toBe(true);
    // We intentionally do not restrict to RFC1918 — some networks hand out others.
    expect(isScannableIpv4('100.64.1.1')).toBe(true);
  });

  it('rejects unspecified, loopback, and link-local addresses (no LAN to sweep)', () => {
    expect(isScannableIpv4('0.0.0.0')).toBe(false);
    expect(isScannableIpv4('127.0.0.1')).toBe(false);
    expect(isScannableIpv4('169.254.10.20')).toBe(false); // APIPA — no DHCP lease
  });

  it('rejects non-IPv4 / malformed input', () => {
    expect(isScannableIpv4('')).toBe(false);
    expect(isScannableIpv4(null)).toBe(false);
    expect(isScannableIpv4(undefined)).toBe(false);
    expect(isScannableIpv4('not-an-ip')).toBe(false);
    expect(isScannableIpv4('10.0.0')).toBe(false);
    expect(isScannableIpv4('10.0.0.256')).toBe(false); // octet > 255
    expect(isScannableIpv4('fe80::1')).toBe(false); // IPv6
    expect(isScannableIpv4('10.0.0.1.5')).toBe(false);
  });
});

describe('deriveSubnet24', () => {
  it('returns the /24 prefix for a scannable IP', () => {
    expect(deriveSubnet24('10.0.0.71')).toBe('10.0.0');
    expect(deriveSubnet24('192.168.1.200')).toBe('192.168.1');
  });

  it('returns null for any address we cannot scan from', () => {
    expect(deriveSubnet24('0.0.0.0')).toBeNull();
    expect(deriveSubnet24('127.0.0.1')).toBeNull();
    expect(deriveSubnet24('169.254.1.1')).toBeNull();
    expect(deriveSubnet24('')).toBeNull();
    expect(deriveSubnet24(null)).toBeNull();
    expect(deriveSubnet24('garbage')).toBeNull();
  });
});
