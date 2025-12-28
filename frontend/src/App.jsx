import { useEffect, useMemo } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import './App.css'

// Debug logger
const DEBUG = true
const log = (...args) => DEBUG && console.log('[PRIVY-DEBUG]', ...args)

function App() {
  const { ready, authenticated, user, login, logout } = usePrivy()
  const { wallets } = useWallets()

  // Debug: Log all state changes
  useEffect(() => {
    log('=== STATE UPDATE ===')
    log('ready:', ready)
    log('authenticated:', authenticated)
    log('user:', user)
    log('wallets:', wallets)
    log('window.solana:', window.solana)
    log('window.solana?.isPhantom:', window.solana?.isPhantom)
    log('window.phantom:', window.phantom)
    log('linkedAccounts:', user?.linkedAccounts)
  }, [ready, authenticated, user, wallets])

  // Get wallet address - prefer Solana, accept any
  const walletAddress = useMemo(() => {
    log('=== FINDING WALLET ===')

    // 1. Check linkedAccounts for Solana wallets
    const linkedSolana = user?.linkedAccounts?.find(
      (acc) => acc.type === 'wallet' && acc.chainType === 'solana'
    )
    log('linkedSolana:', linkedSolana)
    if (linkedSolana?.address) {
      log('Using linkedSolana address:', linkedSolana.address)
      return linkedSolana.address
    }

    // 2. Check connected wallets - find non-Ethereum
    const solanaWallet = wallets?.find(w => !w.address?.startsWith('0x'))
    log('solanaWallet from wallets:', solanaWallet)
    if (solanaWallet?.address) {
      log('Using solanaWallet address:', solanaWallet.address)
      return solanaWallet.address
    }

    // 3. Any wallet from linkedAccounts
    const anyWallet = user?.linkedAccounts?.find(
      (acc) => acc.type === 'wallet' && acc.address && !acc.address.startsWith('0x')
    )
    log('anyWallet:', anyWallet)
    if (anyWallet?.address) {
      log('Using anyWallet address:', anyWallet.address)
      return anyWallet.address
    }

    log('No wallet found!')
    return null
  }, [user, wallets])

  const isPopup = !!window.opener
  const isAuthPage = window.location.pathname === '/auth'

  // When authenticated, notify parent window (via BroadcastChannel + postMessage for cross-tab reliability)
  useEffect(() => {
    if (authenticated && walletAddress && (isPopup || isAuthPage)) {
      const message = {
        type: 'privy-auth-success',
        address: walletAddress
      }

      // Use BroadcastChannel for reliable cross-tab communication
      try {
        const channel = new BroadcastChannel('launchr-auth')
        channel.postMessage(message)
        log('Sent auth via BroadcastChannel:', walletAddress)
        channel.close()
      } catch (e) {
        log('BroadcastChannel failed:', e)
      }

      // Also try window.opener.postMessage as fallback
      if (window.opener) {
        try {
          window.opener.postMessage(message, '*')
          log('Sent auth via postMessage:', walletAddress)
        } catch (e) {
          log('postMessage failed:', e)
        }
      }

      // Close tab after a short delay if we're in popup mode
      if (isPopup) {
        setTimeout(() => window.close(), 500)
      }
    }
  }, [authenticated, walletAddress, isPopup, isAuthPage])

  // Auto-open login on auth page
  useEffect(() => {
    if (isAuthPage && ready && !authenticated) {
      login()
    }
  }, [isAuthPage, ready, authenticated, login])

  // Auto-logout if authenticated but no Solana wallet found (only Ethereum)
  useEffect(() => {
    if (authenticated && ready && !walletAddress) {
      // Give it a moment to find wallets, then logout if still none
      const timer = setTimeout(() => {
        if (!walletAddress) {
          console.log('[AUTH] No Solana wallet found, logging out...')
          logout()
        }
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [authenticated, ready, walletAddress, logout])

  if (!ready) {
    return <div className="loading">Loading Privy...</div>
  }

  // Auth page mode - minimal UI for wallet connection
  if (isAuthPage || isPopup) {
    return (
      <div className="auth-popup">
        <div className="auth-container">
          <img src="/website/logo-icon.jpg" alt="LAUNCHR" className="auth-logo" />
          <h2>LAUNCHR Auth</h2>
          {authenticated ? (
            <div className="auth-success">
              {walletAddress ? (
                <>
                  <p>Connected!</p>
                  <p className="address">{walletAddress.slice(0,8)}...{walletAddress.slice(-4)}</p>
                  <p className="hint">Session active. Return to dashboard to continue.</p>
                  <button onClick={() => window.location.href = '/dashboard'} className="btn-connect">
                    Return to Dashboard
                  </button>
                  {isPopup && <button onClick={() => window.close()} className="btn-close">Close</button>}
                </>
              ) : (
                <>
                  <p>No Solana Wallet Found</p>
                  <p className="hint">Please connect a Solana wallet (Phantom, Solflare, etc.)</p>
                  <button onClick={logout} className="btn-disconnect">Try Again</button>
                  <button onClick={() => window.location.href = '/dashboard'} className="btn-close">Back to Dashboard</button>
                </>
              )}
            </div>
          ) : (
            <div className="auth-prompt">
              <p>Connect your Solana wallet</p>
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
