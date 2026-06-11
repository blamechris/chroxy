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
const PROBE_TIMEOUT_MS = 1500;

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
