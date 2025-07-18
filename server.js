// SERVER SIDE CODE (server.js)
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');

process.env.NODE_ENV = 'production';

// Throttled version of the game state broadcast
let fullStateUpdatePending = false;
const FULL_STATE_UPDATE_INTERVAL = 3000; // 3 seconds

function scheduleFullStateUpdate() {
    if (fullStateUpdatePending) return;
    
    fullStateUpdatePending = true;
    setTimeout(() => {
        io.emit('full_game_state', { 
            players,
            gameObjects: getCompressedGameObjects(),
            timestamp: Date.now()
        });
        fullStateUpdatePending = false;
    }, FULL_STATE_UPDATE_INTERVAL);
}

// Compress game objects by removing unnecessary data
function getCompressedGameObjects() {
    return {
        trees: gameObjects.trees,
        rocks: gameObjects.rocks,
        coins: gameObjects.coins.filter(c => !c.collected),
        ammoPacks: gameObjects.ammoPacks.filter(a => !a.collected),
        baitPacks: gameObjects.baitPacks.filter(b => !b.collected),
        ponds: gameObjects.ponds,
        decorativeLakes: gameObjects.decorativeLakes
    };
}

// Call this after any major state change
scheduleFullStateUpdate();

// Initialize app
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  pingTimeout: 30000,
  pingInterval: 5000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 10e6,
  transports: ["websocket", "polling"],
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());
//keep alive
if (process.env.PROJECT_DOMAIN) {
    require('./keep-alive.js');
}
// Initialize SQLite database
const dataDir = path.join(__dirname, '.data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}
const db = new sqlite3.Database(path.join(dataDir, 'gamedb.sqlite'));

// Log the database location for verification
console.log(`Database initialized at: ${path.join(dataDir, 'gamedb.sqlite')}`);

// Create tables if they don't exist
db.serialize(() => {
    // Users table
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            color TEXT DEFAULT '#FF0000',
            score INTEGER DEFAULT 0,
            last_login TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            is_admin INTEGER DEFAULT 0
        )
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS fish (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            size REAL NOT NULL,
            rarity TEXT NOT NULL,
            caught_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);
    console.log('Database initialized');
});
function cleanupAndSetupAdmin() {
    // First, clean up all admin users
    db.run('DELETE FROM users WHERE is_admin = 1', [], function(err) {
        if (err) {
            console.error('Error cleaning up admin users:', err);
            return;
        }
        console.log(`Deleted ${this.changes} admin user(s)`);
        
        // After cleanup, create the new admin from env variables
        setTimeout(ensureAdminExists, 1000); // Wait a second before creating new
    });
}

function ensureAdminExists() {
    // Get admin credentials from environment variables
    const adminUsername = process.env.ADMIN_USER || 'admin';
    const adminPassword = process.env.ADMIN_PASS || 'admin123';
    
    db.get('SELECT * FROM users WHERE username = ?', [adminUsername], async (err, row) => {
        if (err) {
            console.error('Error checking for admin user:', err);
            return;
        }
        
        if (!row) {
            // Admin doesn't exist, create it
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(adminPassword, saltRounds);
            
            db.run(
                'INSERT INTO users (username, password, is_admin) VALUES (?, ?, ?)',
                [adminUsername, hashedPassword, 1],
                function(err) {
                    if (err) {
                        console.error('Failed to create admin user:', err);
                        return;
                    }
                    console.log('Admin user created successfully with username:', adminUsername);
                }
            );
        } else {
            console.log('Admin user already exists with username:', adminUsername);
        }
    });
}


db.serialize(() => {

    
    // Clean up and setup admin user
    cleanupAndSetupAdmin();
});

// Call this function after initializing the database
ensureAdminExists();
// Game state
const players = {};
const usernames = new Set();
const gameObjects = {
    trees: [],
    rocks: [],
    coins: [],
    ammoPacks: [],
    baitPacks: [],
    ponds: [], // New ponds array
     decorativeLakes: [] // New purely cosmetic frozen lakes
};
const fishTypes = [
    // Common: 39% / 2 = 19.5% each
    { id: 1, name: "Common Carp", minSize: 20, maxSize: 45, rarity: "Common", chance: 0.195 },
    { id: 2, name: "Sunfish", minSize: 10, maxSize: 20, rarity: "Common", chance: 0.195 },

    // Uncommon: 29% / 3 ≈ 9.67% each
    { id: 3, name: "Catfish", minSize: 25, maxSize: 60, rarity: "Uncommon", chance: 0.0967 },
    { id: 4, name: "Bass", minSize: 20, maxSize: 40, rarity: "Uncommon", chance: 0.0967 },
    { id: 5, name: "Rainbow Trout", minSize: 15, maxSize: 35, rarity: "Uncommon", chance: 0.0967 },

    // Rare: 14% / 2 = 7% each
    { id: 6, name: "Pike", minSize: 40, maxSize: 80, rarity: "Rare", chance: 0.07 },
    { id: 7, name: "Salmon", minSize: 30, maxSize: 70, rarity: "Rare", chance: 0.07 },

    // Epic: 8% / 2 = 4% each
    { id: 8, name: "Golden Perch", minSize: 25, maxSize: 50, rarity: "Epic", chance: 0.04 },
    { id: 9, name: "Sturgeon", minSize: 60, maxSize: 120, rarity: "Epic", chance: 0.04 },

    // Legendary: 4%
    { id: 10, name: "Mythical Koi", minSize: 50, maxSize: 100, rarity: "Legendary", chance: 0.04 },

    // Mythical: 3.1% custom split
    { id: 11, name: "Kyogre", minSize: 400, maxSize: 450, rarity: "Mythical", chance: 0.001 },
    { id: 12, name: "Manaphy", minSize: 25, maxSize: 30, rarity: "Mythical", chance: 0.001 },
    { id: 13, name: "Golden Magikarp", minSize: 50, maxSize: 90, rarity: "Mythical", chance: 0.005 },
    { id: 14, name: "Shiny Gyarados", minSize: 500, maxSize: 700, rarity: "Mythical", chance: 0.005 },
    { id: 15, name: "Wailord", minSize: 1450, maxSize: 2000, rarity: "Mythical", chance: 0.009 },
    { id: 16, name: "Lapras", minSize: 150, maxSize: 300, rarity: "Mythical", chance: 0.009 }
];
const WORLD_WIDTH = 4000;  
const WORLD_HEIGHT = 3000; 
const bullets = [];
const BULLET_SPEED = 10;
const BULLET_DAMAGE = 10;
const BULLET_LIFETIME = 5000; // 5 seconds max bullet lifetime
const MAX_AMMO = 10; // Maximum ammo capacity
const AMMO_PACK_SIZE = 5 // Amount of ammo in each pack
const MAX_BAIT = 10; // Maximum bait capacity
//sprite collision size
const COIN_SIZE = 20;
const AMMO_SIZE = 70;
const BAIT_PACK_SIZE = 60;
function generateGameObjects(mapWidth, mapHeight) {
    // Clear existing objects
    gameObjects.trees = [];
    gameObjects.rocks = [];
    gameObjects.coins = [];
    gameObjects.ammoPacks = []; 
    gameObjects.ponds = [];
    gameObjects.decorativeLakes = []; // Clear decorative lakes too
    
    
    
    // Generate fishable ponds first (larger lakes)
    const pondCount = Math.floor(Math.random() * 2) + 4;
    for (let i = 0; i < pondCount; i++) {
        // Make ponds significantly larger
        const pondWidth = Math.floor(Math.random() * 250) + 350; // 350-600
        const pondHeight = Math.floor(Math.random() * 200) + 250; // 250-450
        
        // Find a location that doesn't overlap with other water bodies
        let validLocation = false;
        let pondX, pondY;
        let attempts = 0;
        
        while (!validLocation && attempts < 100) {
            attempts++;
            pondX = Math.random() * (mapWidth - pondWidth);
            pondY = Math.random() * (mapHeight - pondHeight);
            
            // Check overlap with other ponds - maintain larger minimum distance
            let overlap = false;
            for (const pond of gameObjects.ponds) {
                const distance = Math.sqrt(
                    Math.pow(pondX + pondWidth/2 - (pond.x + pond.width/2), 2) +
                    Math.pow(pondY + pondHeight/2 - (pond.y + pond.height/2), 2)
                );
                // Increased minimum distance between lakes to 500px
                if (distance < 600) {
                    overlap = true;
                    break;
                }
            }
            
            validLocation = !overlap;
        }
        
        // Add the pond if we found a valid location
        if (validLocation) {
            gameObjects.ponds.push({
                id: `pond-${i}`,
                x: pondX,
                y: pondY,
                width: pondWidth,
                height: pondHeight
            });
        }
    }

    // Generate decorative frozen lakes after ponds
    const decorativeLakeCount = Math.floor(Math.random() * 2) + 3;
    for (let i = 0; i < decorativeLakeCount; i++) {
        // Make larger frozen lakes
        const lakeWidth = Math.floor(Math.random() * 300) + 300; // 300-600
        const lakeHeight = Math.floor(Math.random() * 200) + 200; // 200-400
        
        // Find a location that doesn't overlap with other water bodies
        let validLocation = false;
        let lakeX, lakeY;
        let attempts = 0;
        
        while (!validLocation && attempts < 50) {
            attempts++;
            lakeX = Math.random() * (mapWidth - lakeWidth);
            lakeY = Math.random() * (mapHeight - lakeHeight);
            
            // Check for overlap with all existing water bodies
            let overlap = false;
            
            // Check overlap with fishable ponds - keep good distance
            for (const pond of gameObjects.ponds) {
                const distance = Math.sqrt(
                    Math.pow(lakeX + lakeWidth/2 - (pond.x + pond.width/2), 2) +
                    Math.pow(lakeY + lakeHeight/2 - (pond.y + pond.height/2), 2)
                );
                // Increased minimum distance between lakes and ponds
                if (distance < 500) {
                    overlap = true;
                    break;
                }
            }
            
            // Check overlap with other decorative lakes
            if (!overlap) {
                for (const lake of gameObjects.decorativeLakes) {
                    const distance = Math.sqrt(
                        Math.pow(lakeX + lakeWidth/2 - (lake.x + lake.width/2), 2) +
                        Math.pow(lakeY + lakeHeight/2 - (lake.y + lake.height/2), 2)
                    );
                    // Increased minimum distance between decorative lakes
                    if (distance < 500) {
                        overlap = true;
                        break;
                    }
                }
            }
            
            validLocation = !overlap;
        }
        
        // Add the decorative lake if we found a valid location
        if (validLocation) {
            gameObjects.decorativeLakes.push({
                id: `decorative-lake-${i}`,
                x: lakeX,
                y: lakeY,
                width: lakeWidth,
                height: lakeHeight,
                isDecorative: true
            });
        }
    }
    
    
    // Generate trees - scale up count for larger world
    const treeCount = Math.floor(Math.random() * 21) + 40; // 40-60 trees
    for (let i = 0; i < treeCount; i++) {
        const treeSize = Math.floor(Math.random() * 30) + 70;
        
        // Find a valid location that doesn't overlap with water bodies
        let validLocation = false;
        let treeX, treeY;
        let attempts = 0;
        
        while (!validLocation && attempts < 50) {
            attempts++;
            treeX = Math.random() * (mapWidth - treeSize);
            treeY = Math.random() * (mapHeight - treeSize);
            
            // Check for overlap with all water bodies
            let overlap = false;
            
            // Check overlap with fishable ponds
            for (const pond of gameObjects.ponds) {
                // Keep trees away from edges of ponds (for fishing access)
                const buffer = 10; // Small buffer to allow some trees near water
                if (
                    treeX < pond.x + pond.width + buffer &&
                    treeX + treeSize > pond.x - buffer &&
                    treeY < pond.y + pond.height + buffer &&
                    treeY + treeSize > pond.y - buffer
                ) {
                    overlap = true;
                    break;
                }
            }
            
            // Check overlap with decorative lakes
            if (!overlap) {
                for (const lake of gameObjects.decorativeLakes) {
                    const buffer = 5; // Smaller buffer for decorative lakes
                    if (
                        treeX < lake.x + lake.width + buffer &&
                        treeX + treeSize > lake.x - buffer &&
                        treeY < lake.y + lake.height + buffer &&
                        treeY + treeSize > lake.y - buffer
                    ) {
                        overlap = true;
                        break;
                    }
                }
            }
            
            validLocation = !overlap;
        }
        
        if (validLocation) {
            gameObjects.trees.push({
                id: `tree-${i}`,
                x: treeX,
                y: treeY,
                size: treeSize
            });
        }
    }
    
    // Generate rocks - scale up count
    const rockCount = Math.floor(Math.random() * 21) + 30; // 30-50 rocks
    for (let i = 0; i < rockCount; i++) {
        const rockSize = Math.floor(Math.random() * 20) + 40;
        
        // Find a valid location that doesn't overlap with water bodies or trees
        let validLocation = false;
        let rockX, rockY;
        let attempts = 0;
        
        while (!validLocation && attempts < 50) {
            attempts++;
            rockX = Math.random() * (mapWidth - rockSize);
            rockY = Math.random() * (mapHeight - rockSize);
            
            // Check for overlap
            let overlap = false;
            
            // Check overlap with fishable ponds
            for (const pond of gameObjects.ponds) {
                // Keep rocks away from edges of ponds
                const buffer = 5;
                if (
                    rockX < pond.x + pond.width + buffer &&
                    rockX + rockSize > pond.x - buffer &&
                    rockY < pond.y + pond.height + buffer &&
                    rockY + rockSize > pond.y - buffer
                ) {
                    overlap = true;
                    break;
                }
            }
            
            // Check overlap with decorative lakes
            if (!overlap) {
                for (const lake of gameObjects.decorativeLakes) {
                    const buffer = 5;
                    if (
                        rockX < lake.x + lake.width + buffer &&
                        rockX + rockSize > lake.x - buffer &&
                        rockY < lake.y + lake.height + buffer &&
                        rockY + rockSize > lake.y - buffer
                    ) {
                        overlap = true;
                        break;
                    }
                }
            }
            
            // Check overlap with trees (prevent excessive clustering)
            if (!overlap) {
                for (const tree of gameObjects.trees) {
                    if (
                        rockX < tree.x + tree.size &&
                        rockX + rockSize > tree.x &&
                        rockY < tree.y + tree.size &&
                        rockY + rockSize > tree.y
                    ) {
                        overlap = true;
                        break;
                    }
                }
            }
            
            validLocation = !overlap;
        }
        
        if (validLocation) {
            gameObjects.rocks.push({
                id: `rock-${i}`,
                x: rockX,
                y: rockY,
                size: rockSize
            });
        }
    }
    
    // Generate coins (10-15)
    const coinCount = Math.floor(Math.random() * 10) + 20;
   
for (let i = 0; i < coinCount; i++) {
    // Find a valid position for the coin
    const position = findValidItemPosition(COIN_SIZE, mapWidth, mapHeight, gameObjects);
    
    gameObjects.coins.push({
        id: `coin-${i}`,
        x: position.x,
        y: position.y,
        collected: false
    });
}
    const ammoPackCount = Math.floor(Math.random() * 10) + 10; // Increased from 5-10 to 10-19
   
for (let i = 0; i < ammoPackCount; i++) {
    // Find a valid position for the ammo pack
    const position = findValidItemPosition(AMMO_SIZE, mapWidth, mapHeight, gameObjects);
    
    gameObjects.ammoPacks.push({
        id: `ammo-${i}`,
        x: position.x,
        y: position.y,
        collected: false
    });
}
     // Generate bait packs (3-7) - tend to place closer to water
     const baitPackCount = Math.floor(Math.random() * 8) + 7; // Increased from 3-7 to 7-14
     
for (let i = 0; i < baitPackCount; i++) {
    
    let position;
    
    if (gameObjects.ponds.length > 0 && Math.random() < 0.7) {
        // Choose a random pond
        const pond = gameObjects.ponds[Math.floor(Math.random() * gameObjects.ponds.length)];
        
        // Try to place near pond edge
        const attempts = 10;
        for (let j = 0; j < attempts; j++) {
            const angle = Math.random() * Math.PI * 2;
            const distance = Math.random() * 100 + 50; // 50-150 pixels from pond center
            
            const testX = pond.x + pond.width/2 + Math.cos(angle) * distance;
            const testY = pond.y + pond.height/2 + Math.sin(angle) * distance;
            
            // Keep within map bounds
            const x = Math.max(0, Math.min(testX, mapWidth - BAIT_PACK_SIZE));
            const y = Math.max(0, Math.min(testY, mapHeight - BAIT_PACK_SIZE));
            
            // Check if position is valid
            if (isValidItemPosition(x, y, BAIT_PACK_SIZE, gameObjects)) {
                position = { x, y };
                break;
            }
        }
    }
    
    // If we couldn't find a position near water or random chance, find any valid position
    if (!position) {
        position = findValidItemPosition(BAIT_PACK_SIZE, mapWidth, mapHeight, gameObjects);
    }
    
    gameObjects.baitPacks.push({
        id: `bait-${i}`,
        x: position.x,
        y: position.y,
        collected: false
    });
}
     
     console.log(`Generated ${treeCount} trees, ${rockCount} rocks, ${pondCount} ponds, ${decorativeLakeCount} frozen lakes, ${coinCount} coins, ${ammoPackCount} ammo packs, and ${baitPackCount} bait packs`);
}
function updateServerBullets() {
    const currentTime = Date.now();
    
    for (let i = bullets.length - 1; i >= 0; i--) {
        const bullet = bullets[i];
        
        // Check if bullet has expired
        if (currentTime - bullet.timestamp > BULLET_LIFETIME) {
            bullets.splice(i, 1);
            continue;
        }
        
        // Move bullet
        bullet.x += bullet.dirX * BULLET_SPEED;
        bullet.y += bullet.dirY * BULLET_SPEED;
        
        // Check if bullet is out of bounds
        if (
            bullet.x < 0 ||
            bullet.x > 4000 || 
            bullet.y < 0 ||
            bullet.y > 3000    
        ) {
            bullets.splice(i, 1);
            continue;
        }
        
        // Check collision with obstacles
        if (checkServerBulletObstacleCollision(bullet)) {
            bullets.splice(i, 1);
            continue;
        }
        
        // Check collision with players
        for (const playerId in players) {
            // Don't hit the shooter
            if (playerId === bullet.playerId) continue;
            
            const player = players[playerId];
            
            // Simple collision detection
            if (
                bullet.x >= player.x &&
                bullet.x <= player.x + 50 && // PLAYER_SIZE
                bullet.y >= player.y &&
                bullet.y <= player.y + 50
            ) {
                // Player hit!
                handlePlayerHit(playerId, bullet);
                bullets.splice(i, 1);
                break;
            }
        }
    }
    
    // If bullets were updated, broadcast the updated list
    io.emit('bullets_update', bullets);
}


// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint for user registration
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Validate input
        if (!username || !password || username.length < 3 || password.length < 4) {
            return res.status(400).json({ error: 'Invalid username or password' });
        }
        
        // Check if username exists
        db.get('SELECT username FROM users WHERE username = ?', [username], async (err, row) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (row) {
                return res.status(400).json({ error: 'Username already exists' });
            }
            
            // Hash password
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(password, saltRounds);
            const randomColor = getRandomColor();
            
            // Insert new user
            db.run(
                'INSERT INTO users (username, password, color, last_login) VALUES (?, ?, ?, ?)',
                [username, hashedPassword, randomColor, new Date().toISOString()],
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to register user' });
                    }
                    
                    return res.status(201).json({ 
                        message: 'User registered successfully',
                        userId: this.lastID,
                        color: randomColor
                    });
                }
            );
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// API endpoint for user login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Validate input
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }
        
        // Find user
        db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (!user) {
                return res.status(401).json({ error: 'Invalid username or password' });
            }
            
            // Check password
            const passwordMatch = await bcrypt.compare(password, user.password);
            
            if (!passwordMatch) {
                return res.status(401).json({ error: 'Invalid username or password' });
            }
            
            // Update last login
            db.run(
                'UPDATE users SET last_login = ? WHERE id = ?',
                [new Date().toISOString(), user.id]
            );
            
            // Return success with score
            return res.status(200).json({
                message: 'Login successful',
                userId: user.id,
                username: user.username,
                color: user.color,
                score: user.score || 0
            });
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});
app.post('/api/update-score', async (req, res) => {
    try {
        const { username, score } = req.body;
        
        if (!username || score === undefined) {
            return res.status(400).json({ error: 'Username and score are required' });
        }
        
        // Update score in database
        db.run(
            'UPDATE users SET score = ? WHERE username = ?',
            [score, username],
            function(err) {
                if (err) {
                    return res.status(500).json({ error: 'Failed to update score' });
                }
                
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'User not found' });
                }
                
                return res.status(200).json({ message: 'Score updated successfully' });
            }
        );
    } catch (error) {
        console.error('Update score error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});
// API endpoint to update user color
app.post('/api/update-color', async (req, res) => {
    try {
        const { username, color } = req.body;
        
        if (!username || !color) {
            return res.status(400).json({ error: 'Username and color are required' });
        }
        
        // Update color in database
        db.run(
            'UPDATE users SET color = ? WHERE username = ?',
            [color, username],
            function(err) {
                if (err) {
                    return res.status(500).json({ error: 'Failed to update color' });
                }
                
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'User not found' });
                }
                
                return res.status(200).json({ message: 'Color updated successfully' });
            }
        );
    } catch (error) {
        console.error('Update color error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});app.post('/api/delete-account', async (req, res) => {
    try {
        const { username } = req.body;
        
        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }
        
        // Delete the user from the database
        db.run(
            'DELETE FROM users WHERE username = ?',
            [username],
            function(err) {
                if (err) {
                    console.error('Database error:', err);
                    return res.status(500).json({ error: 'Failed to delete account' });
                }
                
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'User not found' });
                }
                
                // Find and remove the player from the game
                const socketId = Object.keys(players).find(
                    key => players[key].username === username
                );
                
                if (socketId) {
                    // Remove player from active game
                    usernames.delete(username);
                    delete players[socketId];
                    
                    // Broadcast updated game state
                    io.emit('game_state', { players });
                    
                    // System message
                    io.emit('chat_message', {
                        username: 'System',
                        message: `${username} has left the lobby.`
                    });
                }
                
                return res.status(200).json({ message: 'Account deleted successfully' });
            }
        );
    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});
// API endpoint to change username
app.post('/api/change-username', async (req, res) => {
    try {
        const { currentPassword, newUsername, username } = req.body;

        if (!currentPassword || !newUsername || !username) {
            return res.status(400).json({ error: 'Current password and new username are required' });
        }

        db.get('SELECT password FROM users WHERE username = ?', [username], async (err, user) => {
            if (err) {
                console.error('Database error (get user):', err);
                return res.status(500).json({ error: 'Database error' });
            }

            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            const passwordMatch = await bcrypt.compare(currentPassword, user.password);

            if (!passwordMatch) {
                return res.status(401).json({ error: 'Invalid current password' });
            }

            // Check if the new username already exists
            db.get('SELECT username FROM users WHERE username = ?', [newUsername], (getUsernameErr, row) => {
                if (getUsernameErr) {
                    console.error('Database error (check username):', getUsernameErr);
                    return res.status(500).json({ error: 'Database error' });
                }
                if (row) {
                    return res.status(400).json({ error: 'New username already exists' });
                }

                db.run('UPDATE users SET username = ? WHERE username = ?', [newUsername, username], function(runErr) {
                    if (runErr) {
                        console.error('Database error (update username):', runErr);
                        return res.status(500).json({ error: 'Failed to change username' });
                    }
                    return res.status(200).json({ message: 'Username changed successfully' });
                });
            });
        });
    } catch (error) {
        console.error('Change username error (outer):', error);
        return res.status(500).json({ error: 'Server error' });
    }
});

// API endpoint to change password
app.post('/api/change-password', async (req, res) => {
    try {
        const { currentPassword, newPassword, username } = req.body;

        if (!currentPassword || !newPassword || !username) {
            return res.status(400).json({ error: 'Current password and new password are required' });
        }

        db.get('SELECT password FROM users WHERE username = ?', [username], async (err, user) => {
            if (err) {
                console.error('Database error (get user):', err);  // Log the error
                return res.status(500).json({ error: 'Database error' });
            }

            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            const passwordMatch = await bcrypt.compare(currentPassword, user.password);

            if (!passwordMatch) {
                return res.status(401).json({ error: 'Invalid current password' });
            }

            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

            db.run('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, username], function(runErr) { // Changed err name
                if (runErr) {
                    console.error('Database error (update password):', runErr); // Log the error
                    return res.status(500).json({ error: 'Failed to change password' });
                }
                return res.status(200).json({ message: 'Password changed successfully' });
            });
        });
    } catch (error) {
        console.error('Change password error (outer):', error);
        return res.status(500).json({ error: 'Server error' });
    }
});
app.post('/api/delete-fish', async (req, res) => {
    try {
        const { username, fishId } = req.body;
        
        if (!username || !fishId) {
            return res.status(400).json({ error: 'Username and fish ID are required' });
        }
        
        // Get user ID from username
        db.get('SELECT id FROM users WHERE username = ?', [username], (err, user) => {
            if (err || !user) {
                return res.status(401).json({ error: 'User not found' });
            }
            
            // Delete the fish record
            db.run('DELETE FROM fish WHERE id = ? AND user_id = ?', 
                [fishId, user.id], 
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to delete fish' });
                    }
                    
                    if (this.changes === 0) {
                        return res.status(404).json({ error: 'Fish not found or does not belong to you' });
                    }
                    
                    return res.status(200).json({ 
                        message: 'Fish deleted successfully',
                        fishId: fishId
                    });
                }
            );
        });
    } catch (error) {
        console.error('Delete fish error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/ping', (req, res) => {
    res.status(200).send('OK');
});

// Admin login route
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Validate input
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }
        
        // Find user
        db.get('SELECT * FROM users WHERE username = ? AND is_admin = 1', [username], async (err, user) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (!user) {
                return res.status(401).json({ error: 'Invalid admin credentials' });
            }
            
            // Check password
            const passwordMatch = await bcrypt.compare(password, user.password);
            
            if (!passwordMatch) {
                return res.status(401).json({ error: 'Invalid admin credentials' });
            }
            
            // Return success with admin token
            const adminToken = require('crypto').randomBytes(64).toString('hex');
            
            // Store the token
            app.locals.adminToken = adminToken;
            
            return res.status(200).json({
                message: 'Admin login successful',
                token: adminToken
            });
        });
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Middleware to verify admin token
function verifyAdminToken(req, res, next) {
    const token = req.headers['x-admin-token'];
    
    if (!token || token !== app.locals.adminToken) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    next();
}

// Get all users
app.get('/api/admin/users', verifyAdminToken, (req, res) => {
    db.all('SELECT id, username, color, score, last_login, created_at, is_admin FROM users', [], (err, users) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        res.status(200).json({ users });
    });
});

// Search users
app.get('/api/admin/users/search', verifyAdminToken, (req, res) => {
    const { query } = req.query;
    
    if (!query) {
        return res.status(400).json({ error: 'Search query is required' });
    }
    
    db.all(
        'SELECT id, username, color, score, last_login, created_at, is_admin FROM users WHERE username LIKE ?',
        [`%${query}%`],
        (err, users) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            
            res.status(200).json({ users });
        }
    );
});

// Edit user
app.put('/api/admin/users/:id', verifyAdminToken, async (req, res) => {
    const userId = req.params.id;
    const { username, password, color, score } = req.body;
    
    try {
        // Start building the update query
        let query = 'UPDATE users SET ';
        const params = [];
        
        // Add fields to update
        if (username) {
            query += 'username = ?, ';
            params.push(username);
        }
        
        if (password) {
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(password, saltRounds);
            query += 'password = ?, ';
            params.push(hashedPassword);
        }
        
        if (color) {
            query += 'color = ?, ';
            params.push(color);
        }
        
        if (score !== undefined) {
            query += 'score = ?, ';
            params.push(score);
        }
        
        // Remove trailing comma and space
        query = query.slice(0, -2);
        
        // Add WHERE clause
        query += ' WHERE id = ?';
        params.push(userId);
        
        // Execute query
        db.run(query, params, function(err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to update user' });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            res.status(200).json({ message: 'User updated successfully' });
        });
    } catch (error) {
        console.error('Edit user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete user
app.delete('/api/admin/users/:id', verifyAdminToken, (req, res) => {
    const userId = req.params.id;
    
    db.get('SELECT username, is_admin FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Prevent deleting the only admin
        if (user.is_admin) {
            db.get('SELECT COUNT(*) as count FROM users WHERE is_admin = 1', [], (err, result) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }
                
                if (result.count <= 1) {
                    return res.status(400).json({ error: 'Cannot delete the only admin user' });
                }
                
                // If there are other admins, proceed with deletion
                deleteUser(userId, user.username, res);
            });
        } else {
            // Non-admin user can be deleted directly
            deleteUser(userId, user.username, res);
        }
    });
});

app.get('/api/admin/fish', verifyAdminToken, (req, res) => {
    db.all(`
        SELECT f.id, f.type_id, f.name, f.size, f.rarity, f.caught_at, 
               u.username, u.id as user_id
        FROM fish f
        JOIN users u ON f.user_id = u.id
        ORDER BY f.caught_at DESC
    `, [], (err, fishes) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        res.status(200).json({ fishes });
    });
});

// Get fish statistics
app.get('/api/admin/fish/stats', verifyAdminToken, (req, res) => {
    // Get total counts by rarity
    db.all(`
        SELECT rarity, COUNT(*) as count
        FROM fish
        GROUP BY rarity
    `, [], (err, rarityCounts) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        // Get total counts by type
        db.all(`
            SELECT type_id, name, COUNT(*) as count
            FROM fish
            GROUP BY type_id
        `, [], (err, typeCounts) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            // Get top fishers
            db.all(`
                SELECT u.username, COUNT(*) as fish_count, 
                       MAX(f.size) as largest_fish,
                       COUNT(DISTINCT f.type_id) as unique_types
                FROM fish f
                JOIN users u ON f.user_id = u.id
                GROUP BY f.user_id
                ORDER BY fish_count DESC
                LIMIT 10
            `, [], (err, topFishers) => {
                if (err) {
                    console.error('Database error:', err);
                    return res.status(500).json({ error: 'Database error' });
                }
                
                // Get recent catches
                db.all(`
                    SELECT f.id, f.type_id, f.name, f.size, f.rarity, f.caught_at,
                           u.username
                    FROM fish f
                    JOIN users u ON f.user_id = u.id
                    ORDER BY f.caught_at DESC
                    LIMIT 10
                `, [], (err, recentCatches) => {
                    if (err) {
                        console.error('Database error:', err);
                        return res.status(500).json({ error: 'Database error' });
                    }
                    
                    res.status(200).json({
                        rarityCounts,
                        typeCounts,
                        topFishers,
                        recentCatches
                    });
                });
            });
        });
    });
});

// Get fish for a specific user
app.get('/api/admin/users/:userId/fish', verifyAdminToken, (req, res) => {
    const userId = req.params.userId;
    
    db.all(`
        SELECT f.id, f.type_id, f.name, f.size, f.rarity, f.caught_at
        FROM fish f
        WHERE f.user_id = ?
        ORDER BY f.caught_at DESC
    `, [userId], (err, fishes) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        res.status(200).json({ fishes });
    });
});

// Delete a fish
app.delete('/api/admin/fish/:id', verifyAdminToken, (req, res) => {
    const fishId = req.params.id;
    
    db.run('DELETE FROM fish WHERE id = ?', [fishId], function(err) {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to delete fish' });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Fish not found' });
        }
        
        res.status(200).json({ message: 'Fish deleted successfully' });
    });
});

function deleteUser(userId, username, res) {
    db.run('DELETE FROM users WHERE id = ?', [userId], function(err) {
        if (err) {
            return res.status(500).json({ error: 'Failed to delete user' });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Find and remove the player from the game
        const socketId = Object.keys(players).find(
            key => players[key].username === username
        );
        
        if (socketId) {
            // Remove player from active game
            usernames.delete(username);
            delete players[socketId];
            
            // Broadcast updated game state
            io.emit('game_state', { players });
            
            // System message
            io.emit('chat_message', {
                username: 'System',
                message: `${username} has been removed by an admin.`
            });
        }
        
        res.status(200).json({ message: 'User deleted successfully' });
    });
}

// Serve the admin page
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});
// Socket.IO connection handling
io.on('connection', (socket) => {
    if (socket.conn.transport.name !== 'websocket') {
    socket.conn.on('upgrade', () => {
      console.log('Client upgraded to WebSocket connection');
    });
  }
    console.log('A user connected:', socket.id);
    
    // Handle player login via socket (after REST authentication)
    socket.on('join_game', (userData) => {
        const { username, color } = userData;
        
        // Check if already in game
        if (usernames.has(username)) {
            const existingSocketId = Object.keys(players).find(
                key => players[key].username === username
            );
            
            if (existingSocketId) {
                // Remove old connection
                delete players[existingSocketId];
            }
        }
        socket.on('request_unstuck', () => {
    if (!players[socket.id]) return;
    
    // Find a safe spawn position
    const safePosition = findSafeSpawnPosition(WORLD_WIDTH, WORLD_HEIGHT, 50);
    
    // Update player position
    players[socket.id].x = safePosition.x;
    players[socket.id].y = safePosition.y;
    
    // Send confirmation back to the client
    socket.emit('unstuck_response', { 
        success: true,
        x: safePosition.x,
        y: safePosition.y
    });
    
    // Broadcast updated position to all players
    io.emit('game_state', { players });
    
    // Optional: Log unstuck usage
    console.log(`Player ${players[socket.id].username} used unstuck feature`);
});
        // Store username
        usernames.add(username);
        
        // Create player with random position and saved color
        const safePosition = findSafeSpawnPosition(WORLD_WIDTH,  WORLD_HEIGHT, 50);
    
        players[socket.id] = {
            id: socket.id,
            username: username,
            x: safePosition.x,
            y: safePosition.y,
            color: color,
            score: 0,
            ammo: 10,
            bait: 5
        };
         // Generate game objects if first player
        if (Object.keys(players).length === 1) {
             generateGameObjects(4000, 3000);
        }
         // Get player score from database
    db.get('SELECT score FROM users WHERE username = ?', [username], (err, row) => {
        if (!err && row) {
            players[socket.id].score = row.score || 0;
        }
        // Send success response
        socket.emit('join_success', socket.id);
        
        // Broadcast updated game state to all players
        io.emit('game_state', { players, gameObjects });
        
        // Welcome message
        io.emit('chat_message', {
            username: 'System',
            message: `${username} has joined the lobby!`
        });
    });
});
socket.on('catch_fish', () => {
    if (players[socket.id]) {
        const player = players[socket.id];
        
       
    
        // Determine which fish is caught based on rarity chances
            const caughtFish = determineCaughtFish();
            
            // Store fish in database
            storeFishInDatabase(player.username, caughtFish, (err, fishId) => {
                if (err) {
                    console.error('Error storing fish:', err);
                    return;
                }
                
                // Include database ID with the fish data
                caughtFish.id = fishId;
                
                // Send the caught fish to the player
                socket.emit('fish_caught', caughtFish);
                
                // Broadcast a message to all players
                io.emit('chat_message', {
                    username: 'System',
                    message: `${player.username} caught a ${caughtFish.rarity} ${caughtFish.name} (${caughtFish.size.toFixed(1)} cm)!`
                });
            });
        
    }
});

socket.on('get_fish_inventory', () => {
    if (players[socket.id]) {
        const username = players[socket.id].username;
        
        // Get user ID from username
        db.get('SELECT id FROM users WHERE username = ?', [username], (err, user) => {
            if (err || !user) {
                console.error('Error getting user ID:', err);
                return;
            }
            
            // Query fish from database
            db.all(
                'SELECT * FROM fish WHERE user_id = ? ORDER BY rarity DESC, size DESC', 
                [user.id], 
                (err, fishes) => {
                    if (err) {
                        console.error('Error getting fish inventory:', err);
                        return;
                    }
                    
                    // Format the data for client
                    const formattedFishes = fishes.map(fish => {
                        return {
                            id: fish.id,
                            typeId: fish.type_id,
                            name: fish.name,
                            size: fish.size,
                            rarity: fish.rarity,
                            caughtAt: fish.caught_at
                        };
                    });
                    
                    // Send fish inventory to client
                    socket.emit('fish_inventory', formattedFishes);
                }
            );
        });
    }
});
socket.on('delete_fish', (data) => {
    if (players[socket.id]) {
        const username = players[socket.id].username;
        const fishId = data.fishId;
        
        if (!fishId) {
            socket.emit('fish_deleted', { 
                success: false, 
                error: 'Invalid fish ID' 
            });
            return;
        }
        
        // Get user ID from username
        db.get('SELECT id FROM users WHERE username = ?', [username], (err, user) => {
            if (err || !user) {
                console.error('Error getting user ID:', err);
                socket.emit('fish_deleted', { 
                    success: false, 
                    error: 'Failed to authenticate user' 
                });
                return;
            }
            
            // Get fish details for the response message
            db.get('SELECT name, rarity FROM fish WHERE id = ? AND user_id = ?', 
                [fishId, user.id], 
                (err, fish) => {
                    if (err) {
                        console.error('Error getting fish details:', err);
                        socket.emit('fish_deleted', { 
                            success: false, 
                            error: 'Database error' 
                        });
                        return;
                    }
                    
                    if (!fish) {
                        socket.emit('fish_deleted', { 
                            success: false, 
                            error: 'Fish not found or does not belong to you' 
                        });
                        return;
                    }
                    
                    // Delete the fish record
                    db.run('DELETE FROM fish WHERE id = ? AND user_id = ?', 
                        [fishId, user.id], 
                        function(err) {
                            if (err) {
                                console.error('Error deleting fish:', err);
                                socket.emit('fish_deleted', { 
                                    success: false, 
                                    error: 'Failed to delete fish' 
                                });
                                return;
                            }
                            
                            if (this.changes === 0) {
                                socket.emit('fish_deleted', { 
                                    success: false, 
                                    error: 'Fish not found or does not belong to you' 
                                });
                                return;
                            }
                            
                            // Successful deletion
                            socket.emit('fish_deleted', {
                                success: true,
                                fishId: fishId,
                                fishName: `${fish.rarity} ${fish.name}`
                            });
                            
                            // Log the deletion
                            console.log(`User ${username} deleted fish ${fishId}`);
                        }
                    );
                }
            );
        });
    } else {
        socket.emit('fish_deleted', { 
            success: false, 
            error: 'User not authenticated' 
        });
    }
});
socket.on('search_player_fish', (data) => {
    if (!players[socket.id]) {
        socket.emit('other_player_fish', { 
            error: 'You must be logged in to search for players.' 
        });
        return;
    }
    
    const searchName = data.playerName;
    console.log(`Player ${players[socket.id].username} searching for ${searchName}'s fish`);
    
    // Make sure searchName is valid
    if (!searchName || searchName.trim() === '') {
        socket.emit('other_player_fish', { 
            error: 'Please enter a valid player name.' 
        });
        return;
    }
    
    // Don't search for your own fish - just show your inventory
    if (searchName.toLowerCase() === players[socket.id].username.toLowerCase()) {
        socket.emit('other_player_fish', { 
            error: 'That\'s you! Showing your own fish collection.' 
        });
        socket.emit('get_fish_inventory');
        return;
    }
    
    // Find player by username (case insensitive)
    db.get('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', [searchName], (err, user) => {
        if (err) {
            console.error('Database error when searching for player:', err);
            socket.emit('other_player_fish', { 
                error: 'Database error when searching for player.' 
            });
            return;
        }
        
        if (!user) {
            // Player not found
            socket.emit('other_player_fish', { 
                error: `Player "${searchName}" not found.` 
            });
            return;
        }
        
        // Get the correct username with proper case
        db.get('SELECT username FROM users WHERE id = ?', [user.id], (err, userDetail) => {
            if (err || !userDetail) {
                socket.emit('other_player_fish', { 
                    error: 'Failed to find player details.' 
                });
                return;
            }
            
            const correctUsername = userDetail.username;
            
            // Query fish from database
            db.all(
                'SELECT * FROM fish WHERE user_id = ? ORDER BY rarity DESC, size DESC', 
                [user.id], 
                (err, fishes) => {
                    if (err) {
                        console.error('Error getting fish inventory:', err);
                        socket.emit('other_player_fish', { 
                            error: 'Failed to load fish inventory.' 
                        });
                        return;
                    }
                    
                    // Format the data for client
                    const formattedFishes = fishes.map(fish => {
                        return {
                            id: fish.id,
                            typeId: fish.type_id,
                            name: fish.name,
                            size: fish.size,
                            rarity: fish.rarity,
                            caughtAt: fish.caught_at
                        };
                    });
                    
                    // Log the search for monitoring
                    console.log(`User ${players[socket.id].username} viewed ${correctUsername}'s fish collection (${formattedFishes.length} fish)`);
                    
                    // Send fish inventory to client
                    socket.emit('other_player_fish', {
                        playerName: correctUsername,
                        fishes: formattedFishes
                    });
                    
                    // Notify the player that someone viewed their collection (Only if they're online)
                    const targetSocketId = Object.keys(players).find(
                        id => players[id].username.toLowerCase() === correctUsername.toLowerCase()
                    );
                    
                    if (targetSocketId) {
                        io.to(targetSocketId).emit('chat_message', {
                            username: 'System',
                            message: `${players[socket.id].username} is viewing your fish collection!`
                        });
                    }
                }
            );
        });
    });
});
socket.on('shoot_bullet', (bulletData) => {
    if (players[socket.id] && players[socket.id].ammo > 0) {
        // Decrease ammo
        players[socket.id].ammo--;
        
        // Validate bullet (starting position should be near the player)
        const player = players[socket.id];
        const bulletX = bulletData.x;
        const bulletY = bulletData.y;
        const playerCenterX = player.x + 25; 
        const playerCenterY = player.y + 25;
        
        // Calculate distance from bullet start to player center
        const distance = Math.sqrt(
            Math.pow(bulletX - playerCenterX, 2) + 
            Math.pow(bulletY - playerCenterY, 2)
        );
        
        // If bullet starts too far from player, reject it (anti-cheat)
        if (distance > 50) {
            return;
        }
        
        // Server timestamp for bullet lifetime tracking
        bulletData.timestamp = Date.now();
        
        // Bullet to server list
        bullets.push(bulletData);
        
        // Broadcast the new bullet to all players
        io.emit('bullets_update', bullets);
    }
});
socket.on('collect_bait', (baitPackId) => {
    if (players[socket.id]) {
        // Check if player is already at max capacity
        if (players[socket.id].bait >= MAX_BAIT) {
            // Reject the collection attempt
            socket.emit('bait_update', { bait: players[socket.id].bait });
            return;
        }
        
        const username = players[socket.id].username;
        
        // Find the bait pack
        const baitPackIndex = gameObjects.baitPacks.findIndex(bp => bp.id === baitPackId);
        
        if (baitPackIndex !== -1 && !gameObjects.baitPacks[baitPackIndex].collected) {
            // Store the position of the collected bait pack for spawn logic
            const collectedX = gameObjects.baitPacks[baitPackIndex].x;
            const collectedY = gameObjects.baitPacks[baitPackIndex].y;
            
            // Mark bait pack as collected
            gameObjects.baitPacks[baitPackIndex].collected = true;
            
            // Increase player bait
            const BAIT_PACK_SIZE = 1;
            players[socket.id].bait = Math.min(players[socket.id].bait + BAIT_PACK_SIZE, MAX_BAIT);
            
            // Broadcast updated game state
            io.emit('game_state', { players, gameObjects });
            
            // Send direct bait update to the client
            socket.emit('bait_update', { bait: players[socket.id].bait });
            
            // Generate a new bait pack after some time
            setTimeout(() => {
                if (Object.keys(players).length > 0) {
                    let position;
                    const MIN_SPAWN_DISTANCE = 200; // Minimum distance from previous spawn
                    
                    // Try multiple times to find a position far from previous one
                    for (let i = 0; i < 10; i++) {
                        // Try to place near a pond first 
                        if (gameObjects.ponds.length > 0 && Math.random() < 0.7) {
                            // Choose a random pond
                            const pond = gameObjects.ponds[Math.floor(Math.random() * gameObjects.ponds.length)];
                            
                            // Try positions around the pond
                            const angle = Math.random() * Math.PI * 2;
                            const distance = Math.random() * 100 + 50;
                            
                            const testX = pond.x + pond.width/2 + Math.cos(angle) * distance;
                            const testY = pond.y + pond.height/2 + Math.sin(angle) * distance;
                            
                            // Keep within map bounds
                            const x = Math.max(0, Math.min(testX, WORLD_WIDTH - BAIT_PACK_SIZE));
                            const y = Math.max(0, Math.min(testY, WORLD_HEIGHT - BAIT_PACK_SIZE));
                            
                            // Make sure it's valid and far enough from collected position
                            if (isValidItemPosition(x, y, BAIT_PACK_SIZE, gameObjects)) {
                                const distFromPrev = Math.sqrt(
                                    Math.pow(x - collectedX, 2) + 
                                    Math.pow(y - collectedY, 2)
                                );
                                
                                if (distFromPrev >= MIN_SPAWN_DISTANCE) {
                                    position = { x, y };
                                    break;
                                }
                            }
                        }
                    }
                    
                    // If no suitable position found, get any valid position far from previous
                    if (!position) {
                        for (let i = 0; i < 15; i++) {
                            const testPos = findValidItemPosition(BAIT_PACK_SIZE, WORLD_WIDTH, WORLD_HEIGHT, gameObjects);
                            
                            // Check distance from collected position
                            const distFromPrev = Math.sqrt(
                                Math.pow(testPos.x - collectedX, 2) + 
                                Math.pow(testPos.y - collectedY, 2)
                            );
                            
                            if (distFromPrev >= MIN_SPAWN_DISTANCE) {
                                position = testPos;
                                break;
                            }
                        }
                    }
                    
                    // If still no position, use any valid position as fallback
                    if (!position) {
                        position = findValidItemPosition(BAIT_PACK_SIZE, WORLD_WIDTH, WORLD_HEIGHT, gameObjects);
                    }
                    
                    const newBaitPack = {
                        id: `bait-${Date.now()}`,
                        x: position.x,
                        y: position.y,
                        collected: false
                    };
                    
                    // Remove collected bait pack and add new one
                    gameObjects.baitPacks = gameObjects.baitPacks.filter(b => !b.collected);
                    gameObjects.baitPacks.push(newBaitPack);
                    
                    // Broadcast updated game objects
                    io.emit('game_state', { players, gameObjects });
                }
            }, 15000);  // Generate new bait pack after 15 seconds
        }
    }
});

// Handler for updating bait count
socket.on('update_bait', (data) => {
    if (players[socket.id]) {
        players[socket.id].bait = data.bait;
    }
});
socket.on('collect_ammo', (ammoPackId) => {
    if (players[socket.id]) {
      //  const username = players[socket.id].username;
        
        // Find the ammo pack
        const ammoPackIndex = gameObjects.ammoPacks.findIndex(ap => ap.id === ammoPackId);
        
        if (ammoPackIndex !== -1 && !gameObjects.ammoPacks[ammoPackIndex].collected) {
            // Mark ammo pack as collected
            gameObjects.ammoPacks[ammoPackIndex].collected = true;
            
            // Increase player ammo
            players[socket.id].ammo = Math.min(players[socket.id].ammo + AMMO_PACK_SIZE, MAX_AMMO);
            
            // Broadcast updated game state
            io.emit('game_state', { players, gameObjects });
            
            
            // Send direct ammo update to the client
            socket.emit('ammo_update', { ammo: players[socket.id].ammo });
            
            // Generate a new ammo pack after some time
            setTimeout(() => {
            if (Object.keys(players).length > 0) {
                // Find a valid position for the new ammo pack

                const position = findValidItemPosition(AMMO_SIZE, WORLD_WIDTH, WORLD_HEIGHT, gameObjects);
                
                const newAmmoPack = {
                    id: `ammo-${Date.now()}`,
                    x: position.x,
                    y: position.y,
                    collected: false
                };
                
                // Remove collected ammo pack and add new one
                gameObjects.ammoPacks = gameObjects.ammoPacks.filter(a => !a.collected);
                gameObjects.ammoPacks.push(newAmmoPack);
                
                // Broadcast updated game objects
                io.emit('game_state', { players, gameObjects });
            }
        }, 10000);  // Generate new ammo pack after 10 seconds
        }
    }
});

// Update player ammo
socket.on('update_ammo', (data) => {
    if (players[socket.id]) {
        players[socket.id].ammo = data.ammo;
    }
});


    // Handler for coin collection
socket.on('collect_coin', (coinId) => {
    if (players[socket.id]) {
        const username = players[socket.id].username;
        
        // Find the coin
        const coinIndex = gameObjects.coins.findIndex(coin => coin.id === coinId);
        
        if (coinIndex !== -1 && !gameObjects.coins[coinIndex].collected) {
            // Mark coin as collected
            gameObjects.coins[coinIndex].collected = true;
            
            // Increase player score
            players[socket.id].score += 10;
            
            // Update score in database
            db.run(
                'UPDATE users SET score = ? WHERE username = ?',
                [players[socket.id].score, username]
            );
            
            // Broadcast updated game state
            io.emit('game_state', { players, gameObjects });
            
            
            // Generate a new coin after some time
            setTimeout(() => {
            if (Object.keys(players).length > 0) {  // Only if players still in game
                // Find a valid position for the new coin
              
                const position = findValidItemPosition(COIN_SIZE, WORLD_WIDTH, WORLD_HEIGHT, gameObjects);
                
                const newCoin = {
                    id: `coin-${Date.now()}`,
                    x: position.x,
                    y: position.y,
                    collected: false
                };
                
                // Remove collected coin and add new one
                gameObjects.coins = gameObjects.coins.filter(c => !c.collected);
                gameObjects.coins.push(newCoin);
                
                // Broadcast updated game objects
                io.emit('game_state', { players, gameObjects });
            }
        }, 5000);  // Generate new coin after 5 seconds
        }
    }
});
    // Handle player movement
   socket.on('move', (position) => {
    if (players[socket.id]) {
        // Store client timestamp for better synchronization
        const clientTimestamp = position.timestamp || Date.now();
        
        // Keep player within world bounds
        position.x = Math.max(0, Math.min(position.x, WORLD_WIDTH - 50));
        position.y = Math.max(0, Math.min(position.y, WORLD_HEIGHT - 50));
        
        // Validate server-side that there's no collision
        if (!checkServerCollision(socket.id, position)) {
            // Update player position
            players[socket.id].x = position.x;
            players[socket.id].y = position.y;
            players[socket.id].lastUpdate = Date.now();
            players[socket.id].lastClientTimestamp = clientTimestamp;
            
            const updatedPlayer = players[socket.id];
            const nearbyPlayers = getNearbyPlayerSockets(socket.id, 1500); // 1500px radius
            
            if (nearbyPlayers.length > 0) {
                io.to(nearbyPlayers).emit('player_move', {
                    id: socket.id,
                    x: updatedPlayer.x,
                    y: updatedPlayer.y,
                    timestamp: Date.now(),
                    clientTimestamp: clientTimestamp
                });
            }
        } else {
            // If collision detected, send correction to the client only
            socket.emit('position_correction', {
                x: players[socket.id].x,
                y: players[socket.id].y,
                timestamp: Date.now()
            });
        }
    }
});
    
    // Handle color change
    socket.on('change_color', (colorData) => {
        if (players[socket.id]) {
            const { color } = colorData;
            const username = players[socket.id].username;
            
            // Update color in game state
            players[socket.id].color = color;
            
            // Update in database (fire and forget)
            db.run(
                'UPDATE users SET color = ? WHERE username = ?',
                [color, username]
            );
            
            // Broadcast updated game state
            io.emit('game_state', { players });
        }
    });
    
    // Handle chat messages
    socket.on('chat_message', (message) => {
        if (players[socket.id]) {
            io.emit('chat_message', {
                username: players[socket.id].username,
                message: message
            });
        }
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
    if (players[socket.id]) {
        const username = players[socket.id].username;
        
        // Save final score to database before removing the player
        db.run(
            'UPDATE users SET score = ? WHERE username = ?',
            [players[socket.id].score, username]
        );
        
        // Remove player from active game
        usernames.delete(username);
        delete players[socket.id];
        
        // Remove from pending updates if present
        pendingScoreUpdates.delete(socket.id);
        
        // Broadcast updated game state
        io.emit('game_state', { players });
        
        // Goodbye message
        io.emit('chat_message', {
            username: 'System',
            message: `${username} has left the lobby.`
        });
        
        console.log('User disconnected:', username);
    }
});
});
function determineCaughtFish() {
    // Calculate total chance for normalization
    const totalChance = fishTypes.reduce((sum, fish) => sum + fish.chance, 0);
    
    // Generate random number between 0 and total chance
    const random = Math.random() * totalChance;
    
    // Determine which fish is caught based on cumulative chance
    let cumulativeChance = 0;
    let caughtFishType = fishTypes[0]; // Default to first fish
    
    for (const fishType of fishTypes) {
        cumulativeChance += fishType.chance;
        if (random <= cumulativeChance) {
            caughtFishType = fishType;
            break;
        }
    }
    
    // Determine size (random between min and max)
    const size = caughtFishType.minSize + 
                 Math.random() * (caughtFishType.maxSize - caughtFishType.minSize);
    
    // Create fish object
    return {
        typeId: caughtFishType.id,
        name: caughtFishType.name,
        size: parseFloat(size.toFixed(1)), // Round to 1 decimal place
        rarity: caughtFishType.rarity
    };
}

// Function to store fish in database
function storeFishInDatabase(username, fish, callback) {
    // Get user ID from username
    db.get('SELECT id FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) {
            console.error('Error getting user ID:', err);
            if (callback) callback(err, null);
            return;
        }
        
        // Create a properly formatted ISO timestamp
        const currentTime = new Date().toISOString();
        
        // Insert fish into database with explicit timestamp
        db.run(
            'INSERT INTO fish (user_id, type_id, name, size, rarity, caught_at) VALUES (?, ?, ?, ?, ?, ?)',
            [user.id, fish.typeId, fish.name, fish.size, fish.rarity, currentTime],
            function(err) {
                if (err) {
                    console.error('Error inserting fish:', err);
                    if (callback) callback(err, null);
                    return;
                }
                
                // Return inserted ID
                if (callback) callback(null, this.lastID);
            }
        );
    });
}
// Helper function to generate random color

function getRandomColor() {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
        color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
}
function checkServerCollision(playerId, position) {
    const playerHitbox = {
        x: position.x + 10,
        y: position.y + 10,
        width: 30, // PLAYER_SIZE - 20, assuming PLAYER_SIZE is 50
        height: 30
    };
    
    // Check collision with trees
    for (const tree of gameObjects.trees) {
        const treeSize = tree.size || 70;
        const treeHitbox = {
            x: tree.x + treeSize * 0.2,
            y: tree.y + treeSize * 0.5,
            width: treeSize * 0.6,
            height: treeSize * 0.5
        };
        
        if (
            playerHitbox.x < treeHitbox.x + treeHitbox.width &&
            playerHitbox.x + playerHitbox.width > treeHitbox.x &&
            playerHitbox.y < treeHitbox.y + treeHitbox.height &&
            playerHitbox.y + playerHitbox.height > treeHitbox.y
        ) {
            return true; // Collision detected
        }
    }
    
    // Check collision with rocks
    for (const rock of gameObjects.rocks) {
        const rockSize = rock.size || 40;
        const rockHitbox = {
            x: rock.x + rockSize * 0.1,
            y: rock.y + rockSize * 0.1,
            width: rockSize * 0.8,
            height: rockSize * 0.8
        };
        
        if (
            playerHitbox.x < rockHitbox.x + rockHitbox.width &&
            playerHitbox.x + playerHitbox.width > rockHitbox.x &&
            playerHitbox.y < rockHitbox.y + rockHitbox.height &&
            playerHitbox.y + playerHitbox.height > rockHitbox.y
        ) {
            return true; // Collision detected
        }
    }
    
    return false; // No collision
}
function checkServerBulletObstacleCollision(bullet) {
    // Check rocks
    for (const rock of gameObjects.rocks) {
        const rockSize = rock.size || 40;
        if (
            bullet.x >= rock.x &&
            bullet.x <= rock.x + rockSize &&
            bullet.y >= rock.y &&
            bullet.y <= rock.y + rockSize
        ) {
            return true;
        }
    }
    
    // Check trees
    for (const tree of gameObjects.trees) {
        const treeSize = tree.size || 70;
        // Only collide with the trunk part
        if (
            bullet.x >= tree.x + treeSize * 0.3 &&
            bullet.x <= tree.x + treeSize * 0.7 &&
            bullet.y >= tree.y + treeSize * 0.5 &&
            bullet.y <= tree.y + treeSize
        ) {
            return true;
        }
    }
    
    return false;
}
// Find a safe spawn position that doesn't overlap with objects
function findSafeSpawnPosition(worldWidth, worldHeight, playerSize) {
    const padding = 50; 
    let attempts = 0;
    const maxAttempts = 30; // Limit number of attempts to prevent infinite loops
    
    while (attempts < maxAttempts) {
        // Generate random position
        const x = Math.random() * (worldWidth - playerSize - padding * 2) + padding;
        const y = Math.random() * (worldHeight - playerSize - padding * 2) + padding;
        
        // Check if position collides with any game objects
        if (!isPositionColliding(x, y, playerSize)) {
            return { x, y };
        }
        
        attempts++;
    }
    
    // If no safe position found after max attempts, use a predetermined safe area
    return { 
        x: worldWidth / 2, 
        y: worldHeight / 2 
    };
}
// Check if a position collides with any game objects
function isPositionColliding(x, y, playerSize) {
    const playerHitbox = {
        x: x + 10,
        y: y + 10,
        width: playerSize - 20,
        height: playerSize - 20
    };
    
    // Check collision with trees
    for (const tree of gameObjects.trees) {
        const treeSize = tree.size || 70;
        const treeHitbox = {
            x: tree.x + treeSize * 0.2,
            y: tree.y + treeSize * 0.5,
            width: treeSize * 0.6,
            height: treeSize * 0.5
        };
        
        if (
            playerHitbox.x < treeHitbox.x + treeHitbox.width &&
            playerHitbox.x + playerHitbox.width > treeHitbox.x &&
            playerHitbox.y < treeHitbox.y + treeHitbox.height &&
            playerHitbox.y + playerHitbox.height > treeHitbox.y
        ) {
            return true; // Collision detected
        }
    }
    
    // Check collision with rocks
    for (const rock of gameObjects.rocks) {
        const rockSize = rock.size || 40;
        const rockHitbox = {
            x: rock.x + rockSize * 0.1,
            y: rock.y + rockSize * 0.1,
            width: rockSize * 0.8,
            height: rockSize * 0.8
        };
        
        if (
            playerHitbox.x < rockHitbox.x + rockHitbox.width &&
            playerHitbox.x + playerHitbox.width > rockHitbox.x &&
            playerHitbox.y < rockHitbox.y + rockHitbox.height &&
            playerHitbox.y + playerHitbox.height > rockHitbox.y
        ) {
            return true; // Collision detected
        }
    }
    
    // Check collision with ponds (players should be able to spawn in water)
    for (const pond of gameObjects.ponds) {
        // Simple rectangular collision check for ponds
        if (
            playerHitbox.x < pond.x + pond.width &&
            playerHitbox.x + playerHitbox.width > pond.x &&
            playerHitbox.y < pond.y + pond.height &&
            playerHitbox.y + playerHitbox.height > pond.y
        ) {
            return true; // Collision detected
        }
    }
    
    // Check collision with other players
    for (const id in players) {
        const player = players[id];
        if (
            playerHitbox.x < player.x + playerSize &&
            playerHitbox.x + playerHitbox.width > player.x &&
            playerHitbox.y < player.y + playerSize &&
            playerHitbox.y + playerHitbox.height > player.y
        ) {
            return true; // Collision detected
        }
    }
    
    return false; // No collision
}
const SCORE_UPDATE_INTERVAL = 10000; // Update database every 10 seconds
const pendingScoreUpdates = new Set(); // Track which players need DB updates
function handlePlayerHit(playerId, bullet) {
    const shooterId = bullet.playerId;
   
    // Shooter gains points
    if (players[shooterId]) {
        players[shooterId].score += BULLET_DAMAGE;
        // Mark for database update instead of immediate write
        pendingScoreUpdates.add(shooterId);
    }
    
    // Hit player loses points
    if (players[playerId]) {
        // Prevent negative scores
        const newScore = Math.max(0, players[playerId].score - BULLET_DAMAGE);
        players[playerId].score = newScore;
        // Mark for database update instead of immediate write
        pendingScoreUpdates.add(playerId);
    }
    
    // Broadcast hit to all players
    io.emit('player_hit', {
        playerId: playerId,
        shooterId: shooterId,
        damage: BULLET_DAMAGE
    });
    
    // Optimize by only sending updated player information, not full game state
    const updatedPlayers = {};
    if (players[shooterId]) updatedPlayers[shooterId] = players[shooterId];
    if (players[playerId]) updatedPlayers[playerId] = players[playerId];
    
    io.emit('players_update', updatedPlayers);
}

function isValidItemPosition(x, y, size, gameObjects) {
    const itemHitbox = {
        x: x,
        y: y,
        width: size,
        height: size
    };
    
    // Check overlap with trees
    for (const tree of gameObjects.trees) {
        const treeSize = tree.size || 70;
        const treeHitbox = {
            x: tree.x + treeSize * 0.2,
            y: tree.y + treeSize * 0.5,
            width: treeSize * 0.6,
            height: treeSize * 0.5
        };
        
        if (
            itemHitbox.x < treeHitbox.x + treeHitbox.width &&
            itemHitbox.x + itemHitbox.width > treeHitbox.x &&
            itemHitbox.y < treeHitbox.y + treeHitbox.height &&
            itemHitbox.y + itemHitbox.height > treeHitbox.y
        ) {
            return false; // Overlaps with tree
        }
    }
    
    // Check overlap with rocks
    for (const rock of gameObjects.rocks) {
        const rockSize = rock.size || 40;
        const rockHitbox = {
            x: rock.x + rockSize * 0.1,
            y: rock.y + rockSize * 0.1,
            width: rockSize * 0.8,
            height: rockSize * 0.8
        };
        
        if (
            itemHitbox.x < rockHitbox.x + rockHitbox.width &&
            itemHitbox.x + itemHitbox.width > rockHitbox.x &&
            itemHitbox.y < rockHitbox.y + rockHitbox.height &&
            itemHitbox.y + itemHitbox.height > rockHitbox.y
        ) {
            return false; // Overlaps with rock
        }
    }
    
    // Check if in deep part of ponds
    for (const pond of gameObjects.ponds) {
        // Calculate center point of item
        const itemCenterX = x + size/2;
        const itemCenterY = y + size/2;
        
        // Calculate pond center and radiuses
        const pondCenterX = pond.x + pond.width/2;
        const pondCenterY = pond.y + pond.height/2;
        const pondRadiusX = pond.width/2;
        const pondRadiusY = pond.height/2;
        
        // Calculate normalized distance from center (elliptical equation)
        const dx = (itemCenterX - pondCenterX) / pondRadiusX;
        const dy = (itemCenterY - pondCenterY) / pondRadiusY;
        const distanceSquared = dx*dx + dy*dy;
        
        // If item is deeper than 70% into the pond (same as player collision logic), reject position
        if (distanceSquared < 0.7*0.7) {
            return false; // Too deep in water
        }
    }
    
    return true; // Position is valid
}
function updatePendingScores() {
    if (pendingScoreUpdates.size === 0) return;
    
    // Create a batch update
    pendingScoreUpdates.forEach(playerId => {
        if (players[playerId]) {
            const username = players[playerId].username;
            const score = players[playerId].score;
            
            db.run(
                'UPDATE users SET score = ? WHERE username = ?',
                [score, username],
                (err) => {
                    if (err) console.error(`Error updating score for ${username}:`, err);
                }
            );
        }
    });
    
    // Clear the pending updates after processing
    pendingScoreUpdates.clear();
}
setInterval(updatePendingScores, SCORE_UPDATE_INTERVAL);
// Find a valid position for items
function findValidItemPosition(itemSize, worldWidth, worldHeight, gameObjects, maxAttempts = 30) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Generate random position
        const x = Math.random() * (worldWidth - itemSize);
        const y = Math.random() * (worldHeight - itemSize);
        
        // Check if position is valid
        if (isValidItemPosition(x, y, itemSize, gameObjects)) {
            return { x, y };
        }
    }
    
    
    for (let attempt = 0; attempt < 10; attempt++) {
        const x = Math.random() * (worldWidth - itemSize);
        const y = Math.random() * (worldHeight - itemSize);
        
        // Only check pond overlaps
        let inDeepWater = false;
        
        for (const pond of gameObjects.ponds) {
            const itemCenterX = x + itemSize/2;
            const itemCenterY = y + itemSize/2;
            const pondCenterX = pond.x + pond.width/2;
            const pondCenterY = pond.y + pond.height/2;
            const pondRadiusX = pond.width/2;
            const pondRadiusY = pond.height/2;
            const dx = (itemCenterX - pondCenterX) / pondRadiusX;
            const dy = (itemCenterY - pondCenterY) / pondRadiusY;
            
            if (dx*dx + dy*dy < 0.7*0.7) {
                inDeepWater = true;
                break;
            }
        }
        
        if (!inDeepWater) {
            return { x, y };
        }
    }
    
    // Last resort - just return a random position
    return {
        x: Math.random() * (worldWidth - itemSize),
        y: Math.random() * (worldHeight - itemSize)
    };
}
function getNearbyPlayerSockets(playerId, radius) {
    if (!players[playerId]) return [];
    
    const sourcePlayer = players[playerId];
    const nearbyPlayerIds = [];
    
    for (const id in players) {
        if (id === playerId) continue;
        
        const otherPlayer = players[id];
        const distance = Math.sqrt(
            Math.pow(sourcePlayer.x - otherPlayer.x, 2) +
            Math.pow(sourcePlayer.y - otherPlayer.y, 2)
        );
        
        if (distance <= radius) {
            nearbyPlayerIds.push(id);
        }
    }
    
    return nearbyPlayerIds;
}
setInterval(updateServerBullets, 33); // ~30 updates per second
// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});