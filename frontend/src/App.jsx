import { usePrivy, useWallets } from '@privy-io/react-auth'
import { useEffect } from 'react'
import './App.css'

function App() {
  const { ready, authenticated, user, login, logout } = usePrivy()
  const { wallets } = useWallets()

  // Find the first Solana wallet or any wallet
  const solanaWallet = wallets?.find(w => w.walletClientType === 'solana') || wallets?.[0]
  const walletAddress = solanaWallet?.address || user?.wallet?.address

  // Check if this is an auth redirect
  const urlParams = new URLSearchParams(window.location.search)
  const returnTo = urlParams.get('returnTo')

  // Store wallet in localStorage and redirect back when authenticated
  useEffect(() => {
    if (ready && authenticated && walletAddress) {
      // Store wallet info for other pages
      localStorage.setItem('privyWallet', walletAddress)
      localStorage.setItem('privyConnected', 'true')
      localStorage.setItem('privyEmail', user?.email?.address || '')

      // If we have a returnTo URL, redirect back
      if (returnTo) {
        window.location.href = decodeURIComponent(returnTo)
      }
    }
  }, [ready, authenticated, walletAddress, returnTo, user])

  // Handle logout - clear storage
  const handleLogout = async () => {
    localStorage.removeItem('privyWallet')
    localStorage.removeItem('privyConnected')
    localStorage.removeItem('privyEmail')
    await logout()
  }

  if (!ready) {
    return (
      <div className="loading-screen">
        <div className="loading-content">
          <img src="/website/logo-icon.jpg" alt="LAUNCHR" className="loading-logo" />
          <div className="loading-text">Initializing Privy...</div>
        </div>
      </div>
    )
  }

  // If returnTo is set and not authenticated, auto-trigger login
  useEffect(() => {
    if (ready && !authenticated && returnTo) {
      login()
    }
  }, [ready, authenticated, returnTo, login])

  return (
    <div className="auth-page">
      <header className="header">
        <a href="/" className="logo">
          <img src="/website/logo-icon.jpg" alt="LAUNCHR" />
          <span>LAUNCHR</span>
        </a>
        <nav>
          <a href="/">Home</a>
          <a href="/launchpad">Launchpad</a>
          <a href="/dashboard">Dashboard</a>
        </nav>
        {authenticated ? (
          <div className="wallet-info">
            <span className="address">
              {walletAddress?.slice(0, 4)}...{walletAddress?.slice(-4)}
            </span>
            <button onClick={handleLogout} className="btn-disconnect">Disconnect</button>
          </div>
        ) : (
          <button onClick={login} className="btn-connect">Connect</button>
        )}
      </header>

      <main className="main">
        <h1>Wallet Authentication</h1>
        <p className="subtitle">Secure wallet connection powered by Privy</p>

        {authenticated ? (
          <div className="connected-content">
            <div className="wallet-card">
              <div className="success-icon">&#10003;</div>
              <h2>Wallet Connected</h2>
              <div className="info-row">
                <span className="info-label">Address</span>
                <span className="info-value">{walletAddress || 'Loading...'}</span>
              </div>
              {user?.email?.address && (
                <div className="info-row">
                  <span className="info-label">Email</span>
                  <span className="info-value">{user.email.address}</span>
                </div>
              )}
            </div>

            {returnTo ? (
              <div className="redirect-notice">
                <div className="spinner"></div>
                <p>Redirecting you back...</p>
              </div>
            ) : (
              <div className="actions">
                <h2>Continue to</h2>
                <div className="action-buttons">
                  <a href="/launchpad" className="action-btn">Launch Token</a>
                  <a href="/dashboard" className="action-btn">Dashboard</a>
                  <a href="/" className="action-btn">Home</a>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="connect-prompt">
            <div className="connect-icon">&#128274;</div>
            <h2>Connect Your Wallet</h2>
            <p>Sign in with email or connect your existing Solana wallet to continue.</p>
            <button onClick={login} className="btn-connect-large">
              Connect with Privy
            </button>
            <div className="alt-options">
              <p>Prefer Phantom or Solflare? <a href="/launchpad">Use the Launchpad</a></p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
