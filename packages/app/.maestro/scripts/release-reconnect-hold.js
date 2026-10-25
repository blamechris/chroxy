// Maestro runs this on the host after the disconnected no-op assertions.
const response = http.post('http://127.0.0.1:9876/maestro/reconnect-hold/release', { body: '' })
let result
try {
  result = JSON.parse(response.body)
} catch {
  throw new Error(`Mock reconnect-hold release returned invalid JSON (HTTP ${response.status})`)
}
if (response.status !== 200 || result.released !== true) {
  throw new Error(`Mock reconnect-hold release failed (HTTP ${response.status})`)
}
