import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import App from './App.jsx'
import './index.css'

// Get config from server-injected global
const PRIVY_APP_ID = window.LAUNCHR_CONFIG?.PRIVY_APP_ID || ''

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email', 'wallet'],
        appearance: {
          theme: 'dark',
          accentColor: '#FFD966',
        },
        embeddedWallets: {
          createOnLogin: 'users-without-wallets',
        },
        solanaClusters: [
          { name: 'mainnet-beta', rpcUrl: window.LAUNCHR_CONFIG?.SOLANA_RPC || 'https://api.mainnet-beta.solana.com' }
        ],
      }}
    >
      <App />
    </PrivyProvider>
  </StrictMode>,
)
