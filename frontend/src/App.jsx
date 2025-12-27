import { usePrivy, useWallets } from '@privy-io/react-auth'
import './App.css'

function App() {
  const { ready, authenticated, user, login, logout } = usePrivy()
  const { wallets } = useWallets()

  // Find the first Solana wallet or any wallet
  const solanaWallet = wallets?.find(w => w.walletClientType === 'solana') || wallets?.[0]

  if (!ready) {
    return <div className="loading">Loading...</div>
  }

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

            <div className="actions">
              <h2>Quick Actions</h2>
              <div className="action-buttons">
                <a href="/launchpad" className="action-btn">Launch Token</a>
                <button className="action-btn">View Portfolio</button>
                <button className="action-btn">Trade</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="connect-prompt">
            <h2>Connect Your Wallet</h2>
            <p>Connect with email or your existing wallet to access the dashboard.</p>
            <button onClick={login} className="btn-connect-large">
              Connect with Privy
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
