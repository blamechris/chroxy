import { useState, useEffect } from 'react'

/** Server-injected config from window.__CHROXY_CONFIG__ */
interface ChroxyConfig {
  port: number
  noEncrypt: boolean
}

declare global {
  interface Window {
    __CHROXY_CONFIG__?: ChroxyConfig
  }
}

export function App() {
  const [config] = useState<ChroxyConfig | null>(
    () => window.__CHROXY_CONFIG__ ?? null,
  )
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setReady(true)
  }, [])

  return (
    <div id="app">
      <header id="header">
        <div className="header-left">
          <span className="logo">Chroxy</span>
          <span className="status-dot disconnected" />
        </div>
      </header>
      <main style={{ padding: 24, color: '#e0e0e0' }}>
        {ready ? (
          <p>
            React dashboard loaded.
            {config ? ` Server port: ${config.port}` : ' No config detected.'}
          </p>
        ) : (
          <p>Loading...</p>
        )}
      </main>
    </div>
  )
}
