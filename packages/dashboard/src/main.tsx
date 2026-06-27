import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme/theme.css'
import './theme/global.css'
import './theme/components.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
