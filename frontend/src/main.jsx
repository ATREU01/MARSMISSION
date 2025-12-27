import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'
import App from './App.jsx'
import './index.css'

// Create Solana wallet connectors for Phantom, Solflare, etc.
const solanaConnectors = toSolanaWalletConnectors({
  shouldAutoConnect: true,
})

// PrivyGate - waits for config before initializing Privy
function PrivyGate({ children }) {
  const [appId, setAppId] = useState(null)
  const [rpcUrl, setRpcUrl] = useState(null)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const id = window.LAUNCHR_CONFIG?.PRIVY_APP_ID
      const rpc = window.LAUNCHR_CONFIG?.SOLANA_RPC
      if (id) {
        setAppId(id)
        setRpcUrl(rpc || 'https://api.mainnet-beta.solana.com')
      }
    }
  }, [])

  if (!appId) {
    return <div className="loading">Loading...</div>
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
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
      }}
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
