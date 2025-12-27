import { useEffect } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import './App.css'

function App() {
  const { ready, authenticated, user, login, logout } = usePrivy()
  const { wallets } = useWallets()

  // Find Solana wallet
  const solanaWallet = wallets?.find(w => w.walletClientType === 'solana') || wallets?.[0]
  const isPopup = !!window.opener

  // When authenticated in popup mode, send wallet back to parent
  useEffect(() => {
    if (isPopup && authenticated && solanaWallet?.address) {
      window.opener.postMessage({
        type: 'privy-auth-success',
        address: solanaWallet.address
      }, '*')
      setTimeout(() => window.close(), 500)
    }
  }, [isPopup, authenticated, solanaWallet?.address])

  // Auto-open login in popup mode
  useEffect(() => {
    if (isPopup && ready && !authenticated) {
      login()
    }
  }, [isPopup, ready, authenticated, login])

  if (!ready) {
    return <div className="loading">Loading Privy...</div>
  }

  // Popup mode - minimal UI
  if (isPopup) {
    return (
      <div className="auth-popup">
        <div className="auth-container">
          <img src="/website/logo-icon.jpg" alt="LAUNCHR" className="auth-logo" />
          <h2>LAUNCHR Auth</h2>
          {authenticated ? (
            <div className="auth-success">
              <p>Connected!</p>
              <p className="address">{solanaWallet?.address?.slice(0,8)}...</p>
              <p className="closing">Closing...</p>
            </div>
          ) : (
            <div className="auth-prompt">
              <p>Connecting to Privy...</p>
              <button onClick={login} className="btn-connect">Connect Wallet</button>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Normal dashboard mode (fallback)
  return (
    <div className="dashboard">
      <header className="header">
        <div className="logo">
          <img src="/website/logo-icon.jpg" alt="LAUNCHR" />
          <span>LAUNCHR</span>
        </div>
        <nav>
          <a href="/">Home</a>
          <a href="/launchpad">Launchpad</a>
          <a href="/dashboard" className="active">Dashboard</a>
        </nav>
        {authenticated ? (
          <div className="wallet-info">
            <span className="address">
              {solanaWallet?.address?.slice(0, 4)}...{solanaWallet?.address?.slice(-4)}
            </span>
            <button onClick={logout} className="btn-disconnect">Disconnect</button>
          </div>
        ) : (
          <button onClick={login} className="btn-connect">Connect Wallet</button>
        )}
      </header>

      <main className="main">
        <h1>Creator Dashboard</h1>
        {authenticated ? (
          <div className="connected-content">
            <div className="wallet-card">
              <h2>Wallet Connected</h2>
              <p><strong>Address:</strong> {solanaWallet?.address || 'No Solana wallet'}</p>
              <p><strong>Email:</strong> {user?.email?.address || 'N/A'}</p>
            </div>
          </div>
        ) : (
          <div className="connect-prompt">
            <h2>Connect Your Wallet</h2>
            <p>Connect with email or your existing wallet to access the dashboard.</p>
            <button onClick={login} className="btn-connect-large">Connect with Privy</button>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
