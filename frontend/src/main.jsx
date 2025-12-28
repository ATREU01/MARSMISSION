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
log('Creating Solana connectors...')
const solanaConnectors = toSolanaWalletConnectors({
  shouldAutoConnect: true,
})
log('Solana connectors created:', solanaConnectors)

// PrivyGate - waits for config before initializing Privy
function PrivyGate({ children }) {
  const [appId, setAppId] = useState(null)
  const [rpcUrl, setRpcUrl] = useState(null)
  const [error, setError] = useState(null)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    log('PrivyGate useEffect running... (attempt', retryCount + 1, ')')
    log('window.LAUNCHR_CONFIG:', window.LAUNCHR_CONFIG)

    const checkConfig = () => {
      const id = window.LAUNCHR_CONFIG?.PRIVY_APP_ID
      const rpc = window.LAUNCHR_CONFIG?.SOLANA_RPC
      log('PRIVY_APP_ID:', id ? (id.substring(0, 8) + '...') : 'NOT SET')
      log('SOLANA_RPC:', rpc || 'NOT SET')

      if (id && id.length > 0) {
        setAppId(id)
        setRpcUrl(rpc || 'https://api.mainnet-beta.solana.com')
        log('Config set! appId:', id.substring(0, 8) + '...', 'rpcUrl:', rpc || 'default')
        return true
      }
      return false
    }

    // Check immediately
    if (checkConfig()) return

    // Retry a few times with delay (config might not be injected yet)
    if (retryCount < 5) {
      const timer = setTimeout(() => {
        if (!checkConfig()) {
          setRetryCount(prev => prev + 1)
        }
      }, 200)
      return () => clearTimeout(timer)
    } else {
      log('ERROR: PRIVY_APP_ID not found after retries!')
      setError('Privy configuration not found. Please check PRIVY_APP_ID environment variable is set on Railway.')
    }
  }, [retryCount])

  if (error) {
    return (
      <div className="error-container" style={{
        padding: '40px',
        textAlign: 'center',
        background: '#1a1a2e',
        color: '#ff6b6b',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <h2>Configuration Error</h2>
        <p>{error}</p>
        <p style={{color: '#888', fontSize: '12px', marginTop: '20px'}}>
          Ensure PRIVY_APP_ID is set in Railway environment variables
        </p>
        <button
          onClick={() => { setError(null); setRetryCount(0); }}
          style={{
            marginTop: '20px',
            padding: '10px 20px',
            background: '#FFD966',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}
        >
          Retry
        </button>
      </div>
    )
  }

  if (!appId) {
    log('Waiting for appId... (retry', retryCount, ')')
    return (
      <div className="loading" style={{
        padding: '40px',
        textAlign: 'center',
        background: '#1a1a2e',
        color: '#FFD966',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <p>Loading Privy configuration...</p>
        {retryCount > 2 && <p style={{color: '#888', fontSize: '12px'}}>This is taking longer than expected...</p>}
      </div>
    )
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
