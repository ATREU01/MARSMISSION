import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'
import App from './App.jsx'
import './index.css'

// Debug logger
const DEBUG = true
const log = (...args) => DEBUG && console.log('[PRIVY-INIT]', ...args)

log('=== MAIN.JSX LOADING ===')
log('window.LAUNCHR_CONFIG:', window.LAUNCHR_CONFIG)
log('window.solana:', window.solana)
log('window.phantom:', window.phantom)

// Create Solana wallet connectors for Phantom, Solflare, etc.
// shouldAutoConnect: false - require fresh login each time for security
log('Creating Solana connectors...')
const solanaConnectors = toSolanaWalletConnectors({
  shouldAutoConnect: false,
})
log('Solana connectors created:', solanaConnectors)

// PrivyGate - waits for config before initializing Privy
function PrivyGate({ children }) {
  const [appId, setAppId] = useState(null)
  const [rpcUrl, setRpcUrl] = useState(null)

  useEffect(() => {
    log('PrivyGate useEffect running...')
    log('window.LAUNCHR_CONFIG:', window.LAUNCHR_CONFIG)
    if (typeof window !== 'undefined') {
      const id = window.LAUNCHR_CONFIG?.PRIVY_APP_ID
      const rpc = window.LAUNCHR_CONFIG?.SOLANA_RPC
      log('PRIVY_APP_ID:', id)
      log('SOLANA_RPC:', rpc)
      if (id) {
        setAppId(id)
        setRpcUrl(rpc || 'https://api.mainnet-beta.solana.com')
        log('Config set! appId:', id, 'rpcUrl:', rpc || 'https://api.mainnet-beta.solana.com')
      } else {
        log('ERROR: No PRIVY_APP_ID found!')
      }
    }
  }, [])

  if (!appId) {
    log('Waiting for appId...')
    return <div className="loading">Loading...</div>
  }

  const privyConfig = {
    loginMethods: ['wallet'],
    appearance: {
      theme: 'dark',
      accentColor: '#FFD966',
      walletChainType: 'solana-only',
      walletList: ['phantom', 'solflare', 'detected_solana_wallets'],
    },
    embeddedWallets: {
      createOnLogin: 'off',
    },
    externalWallets: {
      solana: {
        connectors: solanaConnectors,
      },
    },
    solanaClusters: [
      { name: 'mainnet-beta', rpcUrl: rpcUrl }
    ],
  }

  log('=== INITIALIZING PRIVY PROVIDER ===')
  log('appId:', appId)
  log('config:', privyConfig)

  return (
    <PrivyProvider
      appId={appId}
      config={privyConfig}
      onSuccess={(user) => log('Privy onSuccess:', user)}
      onError={(error) => log('Privy onError:', error)}
    >
      {children}
    </PrivyProvider>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <PrivyGate>
      <App />
    </PrivyGate>
  </StrictMode>,
)
