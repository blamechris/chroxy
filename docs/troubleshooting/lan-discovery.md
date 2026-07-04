# LAN discovery: "Scan Local Network" finds no server

**Symptom:** On the mobile app's **Connect** screen you tap **Scan Local Network**,
the scan completes, and it shows *"No servers found"* — even though the Chroxy
daemon is running on your computer and both devices are on the same Wi-Fi.

This guide explains how the scan actually works, why it can come up empty, how to
fix it at the router, and the fallbacks that work **regardless** of your router.

> **TL;DR — the reliable way in:** on the Connect screen tap **Enter manually** and
> type your computer's LAN IP and port (e.g. `10.0.0.71` : `8765`), or **Scan QR
> Code**. Discovery is a convenience; the connection itself does not need it.

---

## How the scan actually works (it is *not* mDNS/Bonjour)

The app does **not** use mDNS/Bonjour/multicast to find the daemon. It does a
**unicast subnet sweep**:

1. It reads the phone's own Wi-Fi IP (e.g. `10.0.0.42`).
2. It assumes a `/24` network and derives the subnet prefix (`10.0.0`).
3. It sends a plain HTTP `GET /health` to **every** address in that subnet
   (`10.0.0.1` … `10.0.0.254`) on the scan port.
4. Any address that answers `{"status":"ok"}` is listed as a discovered server.

Two consequences follow directly from this design:

- **`dns-sd` / Bonjour advertising is irrelevant.** The daemon advertising
  `_chroxy._tcp` over mDNS (and any router multicast/IGMP filtering) does **not**
  affect this scan — the app never listens for mDNS. If a scan finds nothing, the
  cause is that the phone could not open a **unicast** HTTP connection to the
  daemon's address, or the daemon isn't on the scanned `/24`.
- **The daemon must be listening on your LAN IP, not loopback.** Start it exposed
  on all interfaces (`0.0.0.0`), which is what `chroxy start` does by default in
  the current builds. If it is bound to `127.0.0.1`, no other device can reach it.
  Confirm on the computer:

  ```bash
  lsof -iTCP:8765 -sTCP:LISTEN -n -P
  # want: node ... TCP *:8765 (LISTEN)   — the "*" means all interfaces
  # NOT:  node ... TCP 127.0.0.1:8765 (LISTEN)
  ```

---

## Step 0 — the one test that tells you where the problem is

From the **phone**, with **Wi-Fi ON and cellular data OFF**, open a browser and go
to your computer's health endpoint:

```
http://<your-computer-LAN-IP>:8765/health
```

(Find the IP on the computer with `ipconfig getifaddr en0` on macOS, or `hostname -I`
on Linux.)

- **It loads `{"status":"ok",…}`** → the phone **can** reach the daemon over
  unicast. Discovery *should* work; re-run the scan, and if it still comes up empty
  see [Same subnet, still not found](#same-subnet-still-not-found). Either way,
  **Enter manually** with that same IP + port will connect.
- **It hangs / "cannot connect"** → the phone **cannot** reach the daemon's IP at
  all. That is your router isolating devices from each other (or the phone being on
  a different network/subnet). Continue to [Router-side fixes](#router-side-fixes).

Turning cellular data **off** during this test matters: with it on, the phone may
route the request over the cellular network instead of Wi-Fi and give a misleading
result.

---

## Router-side fixes

These are the common consumer-router / mesh settings that block **unicast**
device-to-device traffic on the same Wi-Fi. You usually only need one of them.

### 1. Client / AP isolation ("device isolation", "wireless isolation")

The single most common cause. When enabled, the router forwards each Wi-Fi client's
traffic **only** to the internet, not to other devices on the same network — so the
phone cannot reach the computer even though both are "on the same Wi-Fi".

Find it under **Wireless → Advanced**, or in a mesh app under the network/security
settings, named one of:

| Vendor / app | Setting to turn **off** |
| --- | --- |
| eero | *(no direct toggle; ensure devices are **not** on a "guest" or "isolated" profile)* |
| Google/Nest Wifi | "Device / client isolation" is off by default; check per-device "Guest" assignment |
| Netgear Orbi | Wireless → Advanced → **Enable Wireless Isolation** → off |
| ASUS | Wireless → Professional → **Set AP Isolated** → No |
| TP-Link / Deco | Advanced → Wireless → **AP Isolation** → off (Deco app: More → Advanced) |
| ISP-supplied routers | Often labelled "AP isolation", "client isolation", or "guest" — off |

### 2. Guest network

If the phone (or the computer) is joined to a **Guest** SSID, most routers isolate
guest clients from the main LAN by design. Put **both** devices on your **main**
Wi-Fi network.

### 3. Separate 2.4 GHz / 5 GHz SSIDs, or band/AP steering

If your router exposes the two radio bands as **different SSIDs** (e.g.
`MyWifi` and `MyWifi-5G`), and the phone and computer are on different ones, they
can land on different subnets and won't see each other. Either join both devices to
the **same** SSID, or (if the router uses one SSID with band steering) this is
usually fine — verify with [Step 0](#step-0--the-one-test-that-tells-you-where-the-problem-is).

### 4. Mesh "device isolation" / IoT segments

Mesh systems (eero, Deco, Orbi, Google/Nest) sometimes put devices into isolated
profiles or a separate IoT network. In the mesh app, make sure the phone and the
computer are on the **same** network/profile with device-to-device access allowed.

> **A note on multicast / IGMP snooping:** you may see advice to "enable multicast"
> or "turn on IGMP snooping" for Bonjour/mDNS discovery. That advice is for
> *multicast* discovery — **Chroxy's scan is unicast, so it does not apply here.**
> Fix client/AP isolation instead.

---

## Same subnet, still not found

If [Step 0](#step-0--the-one-test-that-tells-you-where-the-problem-is) loads the
health page (the phone *can* reach the daemon) but the scan still lists nothing:

- **Check the subnet the app scanned.** The empty state shows the range it swept
  (e.g. *"Scanned `10.0.0.1-254`"*). If that prefix does **not** match your
  computer's IP prefix, your network isn't a simple `/24` or the two devices are on
  different subnets — use **Enter manually**.
- **Check the port.** The scan uses the port in the box next to the button (default
  `8765`). If you started the daemon on a different port, set it here.
- **Re-run once.** A single sweep can miss a host under momentary Wi-Fi contention;
  the scan probes ~254 addresses with a short timeout each.

---

## Reliable fallbacks (no discovery required)

These always work as long as the phone can reach the daemon's IP:

1. **Enter manually** — Connect screen → **Enter manually** → type
   `host:port` (e.g. `10.0.0.71:8765`) and your token. This bypasses discovery
   entirely.
2. **Scan QR Code** — the QR shown by `chroxy start` encodes the host **and** the
   token, so a scan connects in one step.
3. **Reconnect** — once you've connected successfully, the app remembers the host
   and shows a one-tap **Reconnect** on the Connect screen next time.

---

## Related

- [`docs/security/bearer-token-authority.md`](../security/bearer-token-authority.md)
  — §10 documents the unauthenticated `GET /health` fingerprint endpoint the scan
  probes.
- Tracking issue:
  [#6561](https://github.com/blamechris/chroxy/issues/6561).
