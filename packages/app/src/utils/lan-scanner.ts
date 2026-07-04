/**
 * LAN scanner utility — scans a /24 subnet for Chroxy servers.
 * Pure async logic extracted from ConnectScreen for testability.
 */

export interface DiscoveredServer {
  ip: string;
  port: number;
  hostname: string;
  mode: string;
  version: string;
}

export interface ScanCallbacks {
  onProgress: (progress: number) => void;
  onFound: (servers: DiscoveredServer[]) => void;
}

export interface ScanResult {
  servers: DiscoveredServer[];
  aborted: boolean;
}

const BATCH_SIZE = 30;
// Per-probe timeout. On a LAN, a live daemon answers `/health` in a few ms, so a
// short timeout would be plenty for the *found* case. The timeout only bites on
// dead IPs — and only on networks that silently DROP packets to unused addresses
// (many consumer routers) rather than sending a fast RST. On such a network every
// probe waits the full timeout, so if the live daemon's probe happens to be
// queued behind a batch of dropped-packet connections (iOS caps concurrent
// sockets), too-short a timeout can miss a reachable daemon. 2s gives the live
// probe headroom to answer on a DROP network while keeping the whole sweep
// (~ceil(254/BATCH_SIZE) batches) inside the E2E flow's 30s budget. On a network
// that RSTs dead IPs fast (the common case) this value is irrelevant — dead
// probes reject immediately regardless — so the found-case latency is unchanged.
const PROBE_TIMEOUT_MS = 2000;

/**
 * Validate a port string and return the numeric port, or null if invalid.
 */
export function validatePort(portStr: string): number | null {
  if (!/^\d+$/.test(portStr)) return null;
  const parsed = Number(portStr);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

/**
 * True when `ip` is a dotted-quad IPv4 we can actually derive a scannable /24
 * from — i.e. a real host address on some network, not a placeholder or an
 * address whose peers we could never reach.
 *
 * Rejects: non-IPv4 (empty, IPv6, junk), the unspecified `0.0.0.0`, loopback
 * `127/8`, and link-local `169.254/16` (APIPA — the phone has no real DHCP lease,
 * so there is no LAN to sweep). Everything else, including any RFC1918 private
 * range, is accepted; we intentionally do NOT hard-code "must be 10/192.168/172"
 * because some networks hand out other ranges.
 */
export function isScannableIpv4(ip: string | null | undefined): boolean {
  if (!ip || typeof ip !== 'string') return false;
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets;
  if (a === 0) return false; // 0.0.0.0 / 0/8 — unspecified
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local (no DHCP lease)
  return true;
}

/**
 * Derive the /24 subnet prefix (e.g. `"10.0.0"`) we sweep for a given device IP,
 * or `null` when the IP isn't scannable (see {@link isScannableIpv4}).
 *
 * We assume a /24 because that is what the vast majority of home/office Wi-Fi
 * networks use and expo-network does not expose the interface netmask. If the
 * daemon lives on a wider network (e.g. a /16) or a different subnet than the
 * phone, this sweep will not reach it — hence the UI surfaces the exact subnet
 * scanned so a subnet mismatch is visible, and always offers manual entry / QR
 * as the reliable, discovery-independent fallback.
 */
export function deriveSubnet24(ip: string | null | undefined): string | null {
  if (!isScannableIpv4(ip)) return null;
  return (ip as string).split('.').slice(0, 3).join('.');
}

/**
 * The `/health` response shape. The server exposes `{ status, mode, version }`
 * (plus an optional `hostname`) on an unauthenticated `GET /health`
 * (see bearer-token-authority.md §10). This is fingerprint-level data only —
 * it does NOT prove the responder is a particular daemon, just that *some*
 * chroxy is listening. Identity is established by the auth handshake, not here.
 */
export interface HealthInfo {
  status: string;
  mode: string;
  version: string;
  hostname?: string;
}

/**
 * Map a `ws(s)://`/`http(s)://` URL to its `http(s)://host:port` origin,
 * dropping any path/query/hash. Falls back to a regex normalisation if `URL`
 * can't parse the input (defensive — RN's `URL` is reliable for these shapes).
 */
function lanWsToHttpOrigin(url: string): string {
  const httpish = url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  try {
    return new URL(httpish).origin;
  } catch {
    return httpish.replace(/\/+(ws)?\/*$/i, '');
  }
}

/**
 * Probe a `ws://`/`wss://` (or `http(s)://`) URL's `/health` endpoint.
 *
 * Reused by both the subnet scanner and the endpoint selector (#5518). Returns
 * the parsed health body when the endpoint answers `{ status: 'ok' }`, else
 * `null` (unreachable, non-ok, or non-chroxy). Never throws — a probe failure
 * is the common case and is reported as `null`.
 *
 * The optional `outerSignal` lets a caller cancel an in-flight batch; the
 * internal timeout still bounds a single probe.
 */
export async function probeHealth(
  url: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  outerSignal?: AbortSignal,
): Promise<HealthInfo | null> {
  // Normalise ws(s):// → http(s):// and strip ANY path/query/hash so we always
  // hit the origin's `/health` (not e.g. `.../ws/health`). `URL.origin` is the
  // reliable way to do this — a trailing-slash regex only handled `/` and `/ws`
  // and would mis-target any other pathname.
  const httpBase = lanWsToHttpOrigin(url);
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuterAbort = () => {
    clearTimeout(timeout);
    ctrl.abort();
  };
  if (outerSignal) {
    if (outerSignal.aborted) {
      clearTimeout(timeout);
      return null;
    }
    outerSignal.addEventListener('abort', onOuterAbort);
  }
  try {
    const res = await fetch(`${httpBase}/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.status === 'ok') {
      return {
        status: 'ok',
        mode: data.mode || 'unknown',
        version: data.version || '',
        hostname: data.hostname,
      };
    }
  } catch {
    // Expected for most IPs — connection refused, timeout, etc.
  } finally {
    clearTimeout(timeout);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
  return null;
}

/**
 * Probe a single IP:port for a Chroxy health endpoint.
 * Returns DiscoveredServer if found, null otherwise.
 */
async function probeHost(
  ip: string,
  port: number,
  outerSignal: AbortSignal,
): Promise<DiscoveredServer | null> {
  const health = await probeHealth(`http://${ip}:${port}`, PROBE_TIMEOUT_MS, outerSignal);
  if (!health) return null;
  return {
    ip,
    port,
    hostname: health.hostname || ip,
    mode: health.mode,
    version: health.version,
  };
}

/**
 * Scan a /24 subnet for Chroxy servers.
 * Probes IPs 1-254 in batches, calling callbacks for progress and found servers.
 */
export async function scanSubnet(
  subnet: string,
  port: number,
  signal: AbortSignal,
  callbacks: ScanCallbacks,
): Promise<ScanResult> {
  const allServers: DiscoveredServer[] = [];
  let scanned = 0;

  for (let start = 1; start <= 254 && !signal.aborted; start += BATCH_SIZE) {
    const batch: Promise<DiscoveredServer | null>[] = [];
    for (let i = start; i < Math.min(start + BATCH_SIZE, 255); i++) {
      batch.push(probeHost(`${subnet}.${i}`, port, signal));
    }

    const results = await Promise.all(batch);
    if (signal.aborted) break;

    const found = results.filter((r): r is DiscoveredServer => r !== null);
    if (found.length > 0) {
      allServers.push(...found);
      callbacks.onFound(found);
    }
    scanned += batch.length;
    callbacks.onProgress(Math.min(scanned / 254, 1));
  }

  return { servers: allServers, aborted: signal.aborted };
}
