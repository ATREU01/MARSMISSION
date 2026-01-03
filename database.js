/**
 * CULTURE COINS DATABASE MODULE
 * Production-ready SQLite database for cultures, posts, and profiles
 * Billion-dollar grade - no bullshit
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Database directory - use volume for production persistence
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'culturecoins.db');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Initialize database
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // Better concurrent access
db.pragma('foreign_keys = ON');

console.log(`[DATABASE] Initialized: ${DB_FILE}`);

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

db.exec(`
  -- Cultures table
  CREATE TABLE IF NOT EXISTS cultures (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ticker TEXT NOT NULL,
    creator_wallet TEXT NOT NULL,
    creator_name TEXT,
    category TEXT DEFAULT 'other',
    token_address TEXT UNIQUE,
    tx_signature TEXT,
    ethos TEXT, -- JSON array
    beliefs TEXT, -- JSON array
    theme TEXT, -- JSON object
    tiers TEXT, -- JSON array
    unlocks TEXT, -- JSON array
    dev_buy_amount REAL DEFAULT 0,
    holders INTEGER DEFAULT 0,
    market_cap REAL DEFAULT 0,
    volume REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Profiles table
  CREATE TABLE IF NOT EXISTS profiles (
    wallet TEXT PRIMARY KEY,
    display_name TEXT,
    bio TEXT,
    pfp_url TEXT,
    banner_url TEXT,
    followers INTEGER DEFAULT 0,
    following INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Posts table
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    author_wallet TEXT NOT NULL,
    content TEXT,
    media_url TEXT,
    media_type TEXT, -- 'image' or 'video'
    culture_id TEXT,
    likes TEXT DEFAULT '[]', -- JSON array of wallet addresses
    reposts INTEGER DEFAULT 0,
    reposted_by TEXT DEFAULT '[]', -- JSON array
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (author_wallet) REFERENCES profiles(wallet),
    FOREIGN KEY (culture_id) REFERENCES cultures(id)
  );

  -- Comments table
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    author_wallet TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  );

  -- Media files table (tracking uploaded files)
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT,
    mime_type TEXT,
    size INTEGER,
    uploader_wallet TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Rate limiting table
  CREATE TABLE IF NOT EXISTS rate_limits (
    ip TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    request_count INTEGER DEFAULT 1,
    window_start TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ip, endpoint)
  );

  -- Create indexes for performance
  CREATE INDEX IF NOT EXISTS idx_cultures_creator ON cultures(creator_wallet);
  CREATE INDEX IF NOT EXISTS idx_cultures_token ON cultures(token_address);
  CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_wallet);
  CREATE INDEX IF NOT EXISTS idx_posts_culture ON posts(culture_id);
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
`);

console.log('[DATABASE] Schema initialized');

// ═══════════════════════════════════════════════════════════════════════════
// CULTURE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

const cultureDB = {
  // Create a new culture
  create: (culture) => {
    const id = culture.id || crypto.randomUUID();
    const stmt = db.prepare(`
      INSERT INTO cultures (id, name, ticker, creator_wallet, creator_name, category,
        token_address, tx_signature, ethos, beliefs, theme, tiers, unlocks, dev_buy_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      culture.name,
      culture.ticker,
      culture.wallet,
      culture.creatorName || '',
      culture.category || 'other',
      culture.tokenAddress || null,
      culture.txSignature || null,
      JSON.stringify(culture.ethos || []),
      JSON.stringify(culture.beliefs || []),
      JSON.stringify(culture.theme || {}),
      JSON.stringify(culture.tiers || []),
      JSON.stringify(culture.unlocks || []),
      culture.devBuyAmount || 0
    );

    return { ...culture, id };
  },

  // Get culture by ID
  getById: (id) => {
    const stmt = db.prepare('SELECT * FROM cultures WHERE id = ?');
    const row = stmt.get(id);
    return row ? parseCultureRow(row) : null;
  },

  // Get culture by token address
  getByTokenAddress: (tokenAddress) => {
    const stmt = db.prepare('SELECT * FROM cultures WHERE token_address = ?');
    const row = stmt.get(tokenAddress);
    return row ? parseCultureRow(row) : null;
  },

  // Get all cultures by creator
  getByCreator: (wallet) => {
    const stmt = db.prepare('SELECT * FROM cultures WHERE creator_wallet = ? ORDER BY created_at DESC');
    return stmt.all(wallet).map(parseCultureRow);
  },

  // Get all cultures
  getAll: () => {
    const stmt = db.prepare('SELECT * FROM cultures ORDER BY created_at DESC');
    return stmt.all().map(parseCultureRow);
  },

  // Update culture
  update: (id, updates) => {
    const fields = [];
    const values = [];

    if (updates.name) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.theme) { fields.push('theme = ?'); values.push(JSON.stringify(updates.theme)); }
    if (updates.beliefs) { fields.push('beliefs = ?'); values.push(JSON.stringify(updates.beliefs)); }
    if (updates.tiers) { fields.push('tiers = ?'); values.push(JSON.stringify(updates.tiers)); }
    if (updates.unlocks) { fields.push('unlocks = ?'); values.push(JSON.stringify(updates.unlocks)); }
    if (updates.ethos) { fields.push('ethos = ?'); values.push(JSON.stringify(updates.ethos)); }
    if (updates.holders !== undefined) { fields.push('holders = ?'); values.push(updates.holders); }
    if (updates.marketCap !== undefined) { fields.push('market_cap = ?'); values.push(updates.marketCap); }
    if (updates.volume !== undefined) { fields.push('volume = ?'); values.push(updates.volume); }

    if (fields.length === 0) return false;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`UPDATE cultures SET ${fields.join(', ')} WHERE id = ?`);
    return stmt.run(...values).changes > 0;
  },

  // Delete culture
  delete: (id) => {
    const stmt = db.prepare('DELETE FROM cultures WHERE id = ?');
    return stmt.run(id).changes > 0;
  }
};

// Parse culture row from DB
function parseCultureRow(row) {
  return {
    id: row.id,
    name: row.name,
    ticker: row.ticker,
    wallet: row.creator_wallet,
    creatorName: row.creator_name,
    category: row.category,
    tokenAddress: row.token_address,
    txSignature: row.tx_signature,
    ethos: JSON.parse(row.ethos || '[]'),
    beliefs: JSON.parse(row.beliefs || '[]'),
    theme: JSON.parse(row.theme || '{}'),
    tiers: JSON.parse(row.tiers || '[]'),
    unlocks: JSON.parse(row.unlocks || '[]'),
    devBuyAmount: row.dev_buy_amount,
    holders: row.holders,
    marketCap: row.market_cap,
    volume: row.volume,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROFILE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

const profileDB = {
  // Create or update profile
  upsert: (wallet, profile) => {
    const stmt = db.prepare(`
      INSERT INTO profiles (wallet, display_name, bio, pfp_url, banner_url)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(wallet) DO UPDATE SET
        display_name = excluded.display_name,
        bio = excluded.bio,
        pfp_url = excluded.pfp_url,
        banner_url = excluded.banner_url,
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(
      wallet,
      profile.displayName || '',
      profile.bio || '',
      profile.pfpUrl || null,
      profile.bannerUrl || null
    );

    return { wallet, ...profile };
  },

  // Get profile by wallet
  get: (wallet) => {
    const stmt = db.prepare('SELECT * FROM profiles WHERE wallet = ?');
    const row = stmt.get(wallet);
    if (!row) return null;

    return {
      wallet: row.wallet,
      displayName: row.display_name,
      bio: row.bio,
      pfpUrl: row.pfp_url,
      bannerUrl: row.banner_url,
      followers: row.followers,
      following: row.following,
      createdAt: row.created_at
    };
  },

  // Get all profiles
  getAll: () => {
    const stmt = db.prepare('SELECT * FROM profiles');
    return stmt.all().map(row => ({
      wallet: row.wallet,
      displayName: row.display_name,
      bio: row.bio,
      pfpUrl: row.pfp_url,
      bannerUrl: row.banner_url,
      followers: row.followers,
      following: row.following
    }));
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

const postDB = {
  // Create a new post
  create: (post) => {
    const id = post.id || crypto.randomUUID();
    const stmt = db.prepare(`
      INSERT INTO posts (id, author_wallet, content, media_url, media_type, culture_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      post.authorWallet,
      post.content || '',
      post.mediaUrl || null,
      post.mediaType || null,
      post.cultureId || null
    );

    return { ...post, id };
  },

  // Get post by ID
  getById: (id) => {
    const stmt = db.prepare('SELECT * FROM posts WHERE id = ?');
    const row = stmt.get(id);
    return row ? parsePostRow(row) : null;
  },

  // Get all posts (with pagination)
  getAll: (limit = 50, offset = 0) => {
    const stmt = db.prepare(`
      SELECT p.*, pr.display_name as author_name, pr.pfp_url as author_pfp,
             c.name as culture_name, c.ticker as culture_ticker
      FROM posts p
      LEFT JOIN profiles pr ON p.author_wallet = pr.wallet
      LEFT JOIN cultures c ON p.culture_id = c.id
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset).map(parsePostRowWithProfile);
  },

  // Get posts by author
  getByAuthor: (wallet, limit = 50) => {
    const stmt = db.prepare(`
      SELECT p.*, pr.display_name as author_name, pr.pfp_url as author_pfp,
             c.name as culture_name, c.ticker as culture_ticker
      FROM posts p
      LEFT JOIN profiles pr ON p.author_wallet = pr.wallet
      LEFT JOIN cultures c ON p.culture_id = c.id
      WHERE p.author_wallet = ?
      ORDER BY p.created_at DESC
      LIMIT ?
    `);
    return stmt.all(wallet, limit).map(parsePostRowWithProfile);
  },

  // Like/unlike post
  toggleLike: (postId, wallet) => {
    const stmt = db.prepare('SELECT likes FROM posts WHERE id = ?');
    const row = stmt.get(postId);
    if (!row) return null;

    const likes = JSON.parse(row.likes || '[]');
    const index = likes.indexOf(wallet);

    if (index === -1) {
      likes.push(wallet);
    } else {
      likes.splice(index, 1);
    }

    const updateStmt = db.prepare('UPDATE posts SET likes = ? WHERE id = ?');
    updateStmt.run(JSON.stringify(likes), postId);

    return likes;
  },

  // Repost
  toggleRepost: (postId, wallet) => {
    const stmt = db.prepare('SELECT reposts, reposted_by FROM posts WHERE id = ?');
    const row = stmt.get(postId);
    if (!row) return null;

    const repostedBy = JSON.parse(row.reposted_by || '[]');
    const index = repostedBy.indexOf(wallet);
    let reposts = row.reposts;

    if (index === -1) {
      repostedBy.push(wallet);
      reposts++;
    } else {
      repostedBy.splice(index, 1);
      reposts = Math.max(0, reposts - 1);
    }

    const updateStmt = db.prepare('UPDATE posts SET reposts = ?, reposted_by = ? WHERE id = ?');
    updateStmt.run(reposts, JSON.stringify(repostedBy), postId);

    return { reposts, repostedBy };
  },

  // Add comment
  addComment: (postId, authorWallet, content) => {
    const id = crypto.randomUUID();
    const stmt = db.prepare(`
      INSERT INTO comments (id, post_id, author_wallet, content)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, postId, authorWallet, content);
    return { id, postId, authorWallet, content };
  },

  // Get comments for post
  getComments: (postId) => {
    const stmt = db.prepare(`
      SELECT c.*, p.display_name as author_name
      FROM comments c
      LEFT JOIN profiles p ON c.author_wallet = p.wallet
      WHERE c.post_id = ?
      ORDER BY c.created_at ASC
    `);
    return stmt.all(postId).map(row => ({
      id: row.id,
      author: row.author_name || row.author_wallet.slice(0, 6) + '...' + row.author_wallet.slice(-4),
      authorWallet: row.author_wallet,
      content: row.content,
      createdAt: row.created_at
    }));
  },

  // Delete post
  delete: (id) => {
    const stmt = db.prepare('DELETE FROM posts WHERE id = ?');
    return stmt.run(id).changes > 0;
  }
};

// Parse post row
function parsePostRow(row) {
  return {
    id: row.id,
    authorWallet: row.author_wallet,
    content: row.content,
    mediaUrl: row.media_url,
    mediaType: row.media_type,
    cultureId: row.culture_id,
    likes: JSON.parse(row.likes || '[]'),
    reposts: row.reposts,
    repostedBy: JSON.parse(row.reposted_by || '[]'),
    createdAt: row.created_at
  };
}

function parsePostRowWithProfile(row) {
  return {
    ...parsePostRow(row),
    authorName: row.author_name || row.author_wallet?.slice(0, 6) + '...' + row.author_wallet?.slice(-4),
    authorPfp: row.author_pfp,
    cultureName: row.culture_name,
    cultureTicker: row.culture_ticker
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MEDIA FILE STORAGE
// ═══════════════════════════════════════════════════════════════════════════

const mediaDB = {
  // Save file and return URL
  saveFile: (buffer, originalName, mimeType, uploaderWallet) => {
    const id = crypto.randomUUID();
    const ext = path.extname(originalName) || '.bin';
    const filename = `${id}${ext}`;
    const filepath = path.join(MEDIA_DIR, filename);

    fs.writeFileSync(filepath, buffer);

    const stmt = db.prepare(`
      INSERT INTO media (id, filename, original_name, mime_type, size, uploader_wallet)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, filename, originalName, mimeType, buffer.length, uploaderWallet);

    return `/api/media/${filename}`;
  },

  // Get file path
  getFilePath: (filename) => {
    const filepath = path.join(MEDIA_DIR, filename);
    if (fs.existsSync(filepath)) {
      return filepath;
    }
    return null;
  },

  // Delete file
  deleteFile: (filename) => {
    const filepath = path.join(MEDIA_DIR, filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      const stmt = db.prepare('DELETE FROM media WHERE filename = ?');
      stmt.run(filename);
      return true;
    }
    return false;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════

const RATE_LIMITS = {
  'default': { requests: 100, windowMs: 60000 },      // 100 req/min default
  'create': { requests: 5, windowMs: 60000 },         // 5 creates/min
  'upload': { requests: 10, windowMs: 60000 },        // 10 uploads/min
  'post': { requests: 20, windowMs: 60000 },          // 20 posts/min
};

const rateLimiter = {
  check: (ip, endpoint = 'default') => {
    const config = RATE_LIMITS[endpoint] || RATE_LIMITS.default;
    const now = new Date().toISOString();
    const windowStart = new Date(Date.now() - config.windowMs).toISOString();

    // Clean old entries
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(windowStart);

    // Get current count
    const stmt = db.prepare(`
      SELECT request_count, window_start FROM rate_limits
      WHERE ip = ? AND endpoint = ? AND window_start > ?
    `);
    const row = stmt.get(ip, endpoint, windowStart);

    if (!row) {
      // First request in window
      db.prepare(`
        INSERT INTO rate_limits (ip, endpoint, request_count, window_start)
        VALUES (?, ?, 1, ?)
      `).run(ip, endpoint, now);
      return { allowed: true, remaining: config.requests - 1 };
    }

    if (row.request_count >= config.requests) {
      return { allowed: false, remaining: 0, retryAfter: config.windowMs / 1000 };
    }

    // Increment count
    db.prepare(`
      UPDATE rate_limits SET request_count = request_count + 1
      WHERE ip = ? AND endpoint = ?
    `).run(ip, endpoint);

    return { allowed: true, remaining: config.requests - row.request_count - 1 };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION: Import existing JSON data
// ═══════════════════════════════════════════════════════════════════════════

const migrateFromJSON = () => {
  const oldCulturesFile = path.join(DATA_DIR, 'cultures.json');

  if (fs.existsSync(oldCulturesFile)) {
    try {
      const cultures = JSON.parse(fs.readFileSync(oldCulturesFile, 'utf8'));
      let migrated = 0;

      for (const culture of cultures) {
        try {
          // Check if already exists
          const existing = cultureDB.getById(culture.id);
          if (!existing) {
            // Normalize wallet field - could be wallet, creatorWallet, or creator
            const normalizedCulture = {
              ...culture,
              wallet: culture.wallet || culture.creatorWallet || culture.creator || 'unknown'
            };
            cultureDB.create(normalizedCulture);
            migrated++;
          }
        } catch (e) {
          console.error(`[MIGRATE] Failed to migrate culture ${culture.id}:`, e.message);
        }
      }

      if (migrated > 0) {
        console.log(`[MIGRATE] Migrated ${migrated} cultures from JSON to SQLite`);
        // Rename old file
        fs.renameSync(oldCulturesFile, oldCulturesFile + '.migrated');
      }
    } catch (e) {
      console.error('[MIGRATE] Error reading old cultures file:', e.message);
    }
  }
};

// Run migration on startup
migrateFromJSON();

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  db,
  cultureDB,
  profileDB,
  postDB,
  mediaDB,
  rateLimiter,
  MEDIA_DIR,
  DATA_DIR
};
