# Enterprise Self-Hosting Guide

Deploy Chroxy on enterprise infrastructure with Docker, Kubernetes, reverse proxies, and security hardening.

For basic setup (standalone server, Quick/Named Tunnel, systemd/launchd), see [Self-Hosting Guide](self-hosting-guide.md).

## Docker

The repo ships with a production-ready `Dockerfile` and `docker-compose.yml` at the repo root.

### Build and Run

```bash
# Build the image
docker compose build

# Start (foreground — see logs)
docker compose up

# Start (background)
docker compose up -d

# View logs
docker compose logs -f chroxy

# Stop
docker compose down
```

### Named Tunnel with Docker

For stable URLs, uncomment the cloudflared volume mount in `docker-compose.yml` and set `CHROXY_TUNNEL=named`:

```bash
# .env
CHROXY_TUNNEL=named
CHROXY_TUNNEL_NAME=my-tunnel
CHROXY_TUNNEL_HOSTNAME=chroxy.example.com
```

Run `npx chroxy tunnel setup` on the host first to create the tunnel and credentials.

## Kubernetes

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chroxy
  labels:
    app: chroxy
spec:
  replicas: 1    # Single replica — Claude sessions are stateful
  selector:
    matchLabels:
      app: chroxy
  template:
    metadata:
      labels:
        app: chroxy
    spec:
      containers:
        - name: chroxy
          image: ghcr.io/blamechris/chroxy:latest   # or your registry
          ports:
            - containerPort: 8765
          env:
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: chroxy-secrets
                  key: anthropic-api-key
            - name: CHROXY_PORT
              value: "8765"
          volumeMounts:
            - name: chroxy-config
              mountPath: /home/chroxy/.chroxy
            - name: claude-config
              mountPath: /home/chroxy/.claude
            - name: workspace
              mountPath: /workspace
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
          livenessProbe:
            httpGet:
              path: /
              port: 8765
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /
              port: 8765
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: chroxy-config
          persistentVolumeClaim:
            claimName: chroxy-config-pvc
        - name: claude-config
          persistentVolumeClaim:
            claimName: claude-config-pvc
        - name: workspace
          persistentVolumeClaim:
            claimName: chroxy-workspace-pvc
```

### Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: chroxy
spec:
  selector:
    app: chroxy
  ports:
    - port: 8765
      targetPort: 8765
      protocol: TCP
  type: ClusterIP
```

### Secrets

```bash
kubectl create secret generic chroxy-secrets \
  --from-literal=anthropic-api-key=sk-ant-... \
  --from-literal=chroxy-api-token=$(openssl rand -hex 32)
```

### PersistentVolumeClaims

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: chroxy-config-pvc
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: claude-config-pvc
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: chroxy-workspace-pvc
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 50Gi
```

### Notes

- **Single replica**: Claude sessions are stateful. Multiple replicas would require session affinity and shared storage.
- **Health checks**: The server responds to `GET /` with `{"status":"ok"}` — used for both liveness and readiness probes.
- **Resource limits**: Claude Code can be CPU-intensive during file operations. Adjust based on workload.

## Reverse Proxy (Alternative to Cloudflare Tunnel)

If you prefer your own TLS termination instead of Cloudflare tunnels.

### nginx

```nginx
# /etc/nginx/sites-available/chroxy
upstream chroxy {
    server 127.0.0.1:8765;
}

server {
    listen 443 ssl http2;
    server_name chroxy.example.com;

    ssl_certificate     /etc/letsencrypt/live/chroxy.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chroxy.example.com/privkey.pem;

    # WebSocket support
    location / {
        proxy_pass http://chroxy;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Long-lived WebSocket connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        # Large payloads (image/document attachments)
        client_max_body_size 10m;
    }
}

# HTTP -> HTTPS redirect
server {
    listen 80;
    server_name chroxy.example.com;
    return 301 https://$host$request_uri;
}
```

Start the server without tunnel mode when using a reverse proxy:

```bash
npx chroxy start --no-tunnel
```

### Caddy

```caddyfile
chroxy.example.com {
    reverse_proxy localhost:8765
}
```

Caddy handles TLS automatically via Let's Encrypt. WebSocket proxying works by default.

Start the server without tunnel mode:

```bash
npx chroxy start --no-tunnel
```

### QR Code with Reverse Proxy

When using a reverse proxy instead of a Cloudflare tunnel, the server won't generate a QR code automatically. Set the external URL in config:

```json
{
  "externalUrl": "wss://chroxy.example.com"
}
```

Or manually enter `wss://chroxy.example.com` in the app's manual connection screen.

## Security Hardening

### API Token

The server generates a random API token on `npx chroxy init`. For production:

- Use a strong token: `openssl rand -hex 32`
- Store in a secrets manager, not in config files
- Rotate periodically (the app prompts for a new token on next connect)

### TLS

- **Cloudflare Tunnel**: TLS is handled by Cloudflare edge. Traffic between cloudflared and the server is over localhost — no TLS needed.
- **Reverse Proxy**: Use a trusted certificate (Let's Encrypt, corporate CA). Never expose the WebSocket port without TLS.
- **E2E Encryption**: Chroxy supports optional end-to-end encryption (X25519 key exchange + AES-GCM). This encrypts all messages between the app and server, even through the tunnel.

### Network

| Direction | Port | Protocol | Purpose |
|---|---|---|---|
| Outbound | 443 | HTTPS | Cloudflare tunnel (no inbound ports needed) |
| Loopback | 8765 | HTTP/WS | Server <> cloudflared or reverse proxy |

If using Cloudflare tunnels, **no inbound ports are required**. The tunnel initiates an outbound connection.

If using a reverse proxy, only expose port 443 (HTTPS) on the reverse proxy. Keep port 8765 bound to localhost.

### Firewall Rules

```bash
# UFW (Ubuntu)
ufw default deny incoming
ufw allow out 443/tcp           # Cloudflare tunnel outbound
ufw allow from 127.0.0.1 to any port 8765  # Localhost only

# iptables
iptables -A INPUT -p tcp --dport 8765 -s 127.0.0.1 -j ACCEPT
iptables -A INPUT -p tcp --dport 8765 -j DROP
```

### Authentication

- The API token is required for all WebSocket connections
- Rate limiting on failed auth attempts (5 failures per IP triggers 60s block)
- Token is transmitted during the WebSocket handshake, not in URL params

### Checklist

- [ ] API token is randomly generated (32+ bytes)
- [ ] API token stored in secrets manager or env var, not committed to git
- [ ] TLS enabled (Cloudflare tunnel or reverse proxy with valid cert)
- [ ] WebSocket port (8765) not directly exposed to internet
- [ ] Firewall allows only outbound 443 (tunnel) or inbound 443 on proxy
- [ ] E2E encryption enabled if traversing untrusted networks
- [ ] Anthropic API key stored as a secret, not in config files
- [ ] Server runs as non-root user
- [ ] Working directory has appropriate file permissions
- [ ] Log files don't contain API tokens (server redacts by default)

## Multi-User Considerations

Chroxy is designed as a single-user tool (one developer, one Claude session set). For teams:

### Separate Instances

The simplest approach: each developer runs their own Chroxy instance with their own API token and Anthropic API key.

```yaml
# docker-compose.multi.yml
services:
  chroxy-alice:
    <<: *chroxy-base
    environment:
      - ANTHROPIC_API_KEY=${ALICE_API_KEY}
      - CHROXY_PORT=8765
    ports: ["8765:8765"]

  chroxy-bob:
    <<: *chroxy-base
    environment:
      - ANTHROPIC_API_KEY=${BOB_API_KEY}
      - CHROXY_PORT=8766
    ports: ["8766:8766"]
```

Each instance gets its own Named Tunnel or reverse proxy route:
- `alice-chroxy.example.com` -> `localhost:8765`
- `bob-chroxy.example.com` -> `localhost:8766`

### Session Isolation

Each Chroxy instance:
- Has its own config directory (`~/.chroxy/`)
- Manages its own Claude sessions
- Uses its own API token (auth is per-instance)
- Operates on its own working directory

Sessions from one instance cannot access another instance's state.

### Shared Infrastructure

For a team sharing one server:
- Each developer runs Chroxy in a separate Docker container or K8s pod
- Use separate PVCs for each user's config and workspace
- Route through a shared reverse proxy with path-based or subdomain-based routing
- Each container uses its own Anthropic API key for billing isolation

## Monitoring

### Health Check

```bash
# HTTP health check
curl -s https://your-chroxy-url/ | jq .status
# Returns: "ok"

# During restart (supervisor mode)
# Returns: { "status": "restarting" }
```

### Logs

Server logs to stdout by default. With systemd or Docker, logs are captured automatically:

```bash
# systemd
journalctl -u chroxy -f

# Docker
docker compose logs -f chroxy

# Kubernetes
kubectl logs -f deployment/chroxy
```

### Metrics to Watch

- **Health endpoint response time**: Should be <100ms. Slow responses indicate server overload.
- **Tunnel reconnections**: Frequent `tunnel_lost`/`tunnel_recovered` in logs suggests network instability.
- **Supervisor restarts**: More than 2-3 restarts per hour suggests a recurring crash. Check for Claude Code issues.
- **Memory usage**: Unbounded growth may indicate a session leak. Restart the container if it exceeds limits.
