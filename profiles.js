const fs = require('fs');
const path = require('path');

// Use /app/data/ for Railway volume persistence, fallback to local data/ for dev
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');

console.log(`[PROFILES] Data file: ${PROFILES_FILE}`);

// Ensure data directory exists
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            console.log(`[PROFILES] Created data directory: ${DATA_DIR}`);
        } catch (e) {
            console.error(`[PROFILES] Failed to create data directory: ${e.message}`);
        }
    }
}

// Load profiles data
function loadProfiles() {
    ensureDataDir();
    try {
        if (fs.existsSync(PROFILES_FILE)) {
            return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[PROFILES] Error loading profiles:', e.message);
    }
    return { profiles: {}, follows: [] };
}

// Save profiles data
function saveProfiles(data) {
    ensureDataDir();
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(data, null, 2));
}

// Get or create a profile by wallet address
function getProfile(wallet) {
    const data = loadProfiles();

    if (!data.profiles[wallet]) {
        // Create default profile
        data.profiles[wallet] = {
            wallet: wallet,
            username: null,
            displayName: null,
            avatar: null,
            bio: null,
            twitter: null,
            telegram: null,
            website: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        saveProfiles(data);
    }

    // Add computed stats
    const profile = { ...data.profiles[wallet] };
    profile.followers = getFollowerCount(wallet);
    profile.following = getFollowingCount(wallet);

    return profile;
}

// Update a profile
function updateProfile(wallet, updates) {
    const data = loadProfiles();

    if (!data.profiles[wallet]) {
        data.profiles[wallet] = {
            wallet: wallet,
            createdAt: Date.now()
        };
    }

    // Only allow certain fields to be updated
    const allowedFields = ['username', 'displayName', 'avatar', 'bio', 'twitter', 'telegram', 'website'];

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            data.profiles[wallet][field] = updates[field];
        }
    }

    data.profiles[wallet].updatedAt = Date.now();
    saveProfiles(data);

    return getProfile(wallet);
}

// Check if username is available
function isUsernameAvailable(username, excludeWallet = null) {
    if (!username) return true;

    const data = loadProfiles();
    const normalizedUsername = username.toLowerCase();

    for (const [wallet, profile] of Object.entries(data.profiles)) {
        if (excludeWallet && wallet === excludeWallet) continue;
        if (profile.username && profile.username.toLowerCase() === normalizedUsername) {
            return false;
        }
    }

    return true;
}

// Get profile by username
function getProfileByUsername(username) {
    const data = loadProfiles();
    const normalizedUsername = username.toLowerCase();

    for (const [wallet, profile] of Object.entries(data.profiles)) {
        if (profile.username && profile.username.toLowerCase() === normalizedUsername) {
            const fullProfile = { ...profile };
            fullProfile.followers = getFollowerCount(wallet);
            fullProfile.following = getFollowingCount(wallet);
            return fullProfile;
        }
    }

    return null;
}

// Follow a user
function followUser(followerWallet, followingWallet) {
    if (followerWallet === followingWallet) {
        return { success: false, error: 'Cannot follow yourself' };
    }

    const data = loadProfiles();

    // Check if already following
    const existingFollow = data.follows.find(
        f => f.follower === followerWallet && f.following === followingWallet
    );

    if (existingFollow) {
        return { success: false, error: 'Already following' };
    }

    data.follows.push({
        follower: followerWallet,
        following: followingWallet,
        createdAt: Date.now()
    });

    saveProfiles(data);

    return { success: true };
}

// Unfollow a user
function unfollowUser(followerWallet, followingWallet) {
    const data = loadProfiles();

    const index = data.follows.findIndex(
        f => f.follower === followerWallet && f.following === followingWallet
    );

    if (index === -1) {
        return { success: false, error: 'Not following' };
    }

    data.follows.splice(index, 1);
    saveProfiles(data);

    return { success: true };
}

// Check if user is following another user
function isFollowing(followerWallet, followingWallet) {
    const data = loadProfiles();
    return data.follows.some(
        f => f.follower === followerWallet && f.following === followingWallet
    );
}

// Get follower count
function getFollowerCount(wallet) {
    const data = loadProfiles();
    return data.follows.filter(f => f.following === wallet).length;
}

// Get following count
function getFollowingCount(wallet) {
    const data = loadProfiles();
    return data.follows.filter(f => f.follower === wallet).length;
}

// Get followers list (with profiles)
function getFollowers(wallet, limit = 50, offset = 0) {
    const data = loadProfiles();
    const followerWallets = data.follows
        .filter(f => f.following === wallet)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(offset, offset + limit)
        .map(f => f.follower);

    return followerWallets.map(w => getProfile(w));
}

// Get following list (with profiles)
function getFollowing(wallet, limit = 50, offset = 0) {
    const data = loadProfiles();
    const followingWallets = data.follows
        .filter(f => f.follower === wallet)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(offset, offset + limit)
        .map(f => f.following);

    return followingWallets.map(w => getProfile(w));
}

// Get all profiles (for leaderboard, etc.)
function getAllProfiles(sortBy = 'followers', limit = 50, offset = 0) {
    const data = loadProfiles();

    const profiles = Object.entries(data.profiles).map(([wallet, profile]) => ({
        ...profile,
        wallet,
        followers: getFollowerCount(wallet),
        following: getFollowingCount(wallet)
    }));

    // Sort
    if (sortBy === 'followers') {
        profiles.sort((a, b) => b.followers - a.followers);
    } else if (sortBy === 'createdAt') {
        profiles.sort((a, b) => b.createdAt - a.createdAt);
    }

    return profiles.slice(offset, offset + limit);
}

module.exports = {
    getProfile,
    updateProfile,
    isUsernameAvailable,
    getProfileByUsername,
    followUser,
    unfollowUser,
    isFollowing,
    getFollowerCount,
    getFollowingCount,
    getFollowers,
    getFollowing,
    getAllProfiles
};
