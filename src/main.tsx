import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Toaster
      theme="dark"
      position="bottom-right"
      toastOptions={{
        style: {
          fontFamily: "'Albert Sans', sans-serif",
          fontSize: '12px',
          letterSpacing: '0.03em',
          background: '#241416',
          border: '1px solid #5A3237',
          color: '#F9E7DF',
        },
      }}
    />
  </StrictMode>,
)
