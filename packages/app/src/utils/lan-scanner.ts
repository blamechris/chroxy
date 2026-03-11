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
  const parsed = parseInt(portStr, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
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
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const onOuterAbort = () => {
    clearTimeout(timeout);
    ctrl.abort();
  };
  outerSignal.addEventListener('abort', onOuterAbort);
  try {
    const res = await fetch(`http://${ip}:${port}/health`, { signal: ctrl.signal });
    const data = await res.json();
    if (data.status === 'ok') {
      return {
        ip,
        port,
        hostname: data.hostname || ip,
        mode: data.mode || 'unknown',
        version: data.version || '',
      };
    }
  } catch {
    // Expected for most IPs — connection refused, timeout, etc.
  } finally {
    clearTimeout(timeout);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
  return null;
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
