import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme/theme.css'
import './theme/global.css'
import './theme/components.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installErrorCapture } from './utils/error-capture'

// #9235 — record window errors and unhandled rejections to the local Diagnostics history.
installErrorCapture()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
