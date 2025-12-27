import { useEffect, useMemo } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import './App.css'

function App() {
  const { ready, authenticated, user, login, logout } = usePrivy()
  const { wallets } = useWallets()

  // Get wallet address from multiple sources:
  // 1. Privy embedded wallet (user.wallet) - created for email/social login
  // 2. Linked Solana wallets in user.linkedAccounts
  // 3. External wallets from useWallets() hook
  const walletAddress = useMemo(() => {
    // Check embedded wallet first
    if (user?.wallet?.address) {
      return user.wallet.address
    }

    // Check linkedAccounts for Solana wallets
    const linkedSolana = user?.linkedAccounts?.find(
      (acc) => acc.type === 'wallet' && acc.chainType === 'solana'
    )
    if (linkedSolana?.address) {
      return linkedSolana.address
    }

    // Fall back to external wallets
    const externalWallet = wallets?.find(w => w.walletClientType === 'solana') || wallets?.[0]
    return externalWallet?.address
  }, [user, wallets])

  const isPopup = !!window.opener

  // When authenticated in popup mode, send wallet back to parent
  useEffect(() => {
    if (isPopup && authenticated && walletAddress) {
      window.opener.postMessage({
        type: 'privy-auth-success',
        address: walletAddress
      }, '*')
      setTimeout(() => window.close(), 500)
    }
  }, [isPopup, authenticated, walletAddress])

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
              <p className="address">{walletAddress?.slice(0,8) || 'Loading...'}...</p>
              <p className="closing">{walletAddress ? 'Closing...' : 'Getting wallet...'}</p>
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
              {walletAddress?.slice(0, 4)}...{walletAddress?.slice(-4)}
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
              <p><strong>Address:</strong> {walletAddress || 'No wallet'}</p>
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
