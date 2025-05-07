// SERVER SIDE CODE (server.js)
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');

// Initialize app
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

// Initialize SQLite database
const db = new sqlite3.Database('./gamedb.sqlite');

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
function ensureAdminExists() {
    const adminUsername = 'admin';
    const adminPassword = 'admin123'; // You should change this to a secure password
    
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
                    console.log('Admin user created successfully');
                }
            );
        }
    });
}

// Call this function after initializing the database
ensureAdminExists();
// Game state
const players = {};
const usernames = new Set();
const gameObjects = {
    trees: [],
    rocks: [],
    coins: [],
    ammoPacks: [], // Add this new array
    ponds: [] // New ponds array
};
const fishTypes = [
    {
        id: 1,
        name: "Common Carp",
        minSize: 20,
        maxSize: 45,
        rarity: "Common",
        chance: 0.25 // 25% chance
    },
    {
        id: 2,
        name: "Sunfish",
        minSize: 10,
        maxSize: 20,
        rarity: "Common",
        chance: 0.20 // 20% chance
    },
    {
        id: 3,
        name: "Catfish",
        minSize: 25,
        maxSize: 60,
        rarity: "Uncommon",
        chance: 0.15 // 15% chance
    },
    {
        id: 4,
        name: "Bass",
        minSize: 20,
        maxSize: 40,
        rarity: "Uncommon",
        chance: 0.15 // 15% chance
    },
    {
        id: 5,
        name: "Rainbow Trout",
        minSize: 15,
        maxSize: 35,
        rarity: "Uncommon",
        chance: 0.10 // 10% chance
    },
    {
        id: 6,
        name: "Pike",
        minSize: 40,
        maxSize: 80,
        rarity: "Rare",
        chance: 0.07 // 7% chance
    },
    {
        id: 7,
        name: "Salmon",
        minSize: 30,
        maxSize: 70,
        rarity: "Rare",
        chance: 0.05 // 5% chance
    },
    {
        id: 8,
        name: "Golden Perch",
        minSize: 25,
        maxSize: 50,
        rarity: "Epic",
        chance: 0.02 // 2% chance
    },
    {
        id: 9,
        name: "Sturgeon",
        minSize: 60,
        maxSize: 120,
        rarity: "Epic",
        chance: 0.007 // 0.7% chance
    },
    {
        id: 10,
        name: "Mythical Koi",
        minSize: 50,
        maxSize: 100,
        rarity: "Legendary",
        chance: 0.003 // 0.3% chance
    }
];
const bullets = [];
const BULLET_SPEED = 10;
const BULLET_DAMAGE = 10;
const BULLET_LIFETIME = 1000; // 1 seconds max bullet lifetime
const MAX_AMMO = 10; // Maximum ammo capacity
const AMMO_PACK_SIZE = 5 // Amount of ammo in each pack
function generateGameObjects(mapWidth, mapHeight) {
    // Clear existing objects
    gameObjects.trees = [];
    gameObjects.rocks = [];
    gameObjects.coins = [];
    gameObjects.ammoPacks = []; 
    gameObjects.ponds = [];
    
    // Generate trees (20-30)
    const treeCount = Math.floor(Math.random() * 11) + 20;
    for (let i = 0; i < treeCount; i++) {
        gameObjects.trees.push({
            id: `tree-${i}`,
            x: Math.random() * (mapWidth - 80),  // Adjust for tree size
            y: Math.random() * (mapHeight - 100),
            size: Math.floor(Math.random() * 30) + 70  // Random size between 70-100
        });
    }
    
    // Generate rocks (15-25)
    const rockCount = Math.floor(Math.random() * 11) + 15;
    for (let i = 0; i < rockCount; i++) {
        gameObjects.rocks.push({
            id: `rock-${i}`,
            x: Math.random() * (mapWidth - 60),  // Adjust for rock size
            y: Math.random() * (mapHeight - 60),
            size: Math.floor(Math.random() * 20) + 40  // Random size between 40-60
        });
    }

    const pondCount =1;
    for (let i = 0; i < pondCount; i++) {
        // Make ponds different sizes
        const pondWidth = Math.floor(Math.random() * 150) + 200; // 200-350
        const pondHeight = Math.floor(Math.random() * 100) + 150; // 150-250
        
        // Find a location that doesn't overlap with trees or rocks
        let validLocation = false;
        let pondX, pondY;
        let attempts = 0;
        
        while (!validLocation && attempts < 50) {
            attempts++;
            pondX = Math.random() * (mapWidth - pondWidth);
            pondY = Math.random() * (mapHeight - pondHeight);
            
            // Check for overlap with trees and rocks
            let overlap = false;
            
            // Simple overlap check - could be improved for production
            for (const tree of gameObjects.trees) {
                if (
                    pondX < tree.x + tree.size &&
                    pondX + pondWidth > tree.x &&
                    pondY < tree.y + tree.size &&
                    pondY + pondHeight > tree.y
                ) {
                    overlap = true;
                    break;
                }
            }
            
            if (!overlap) {
                for (const rock of gameObjects.rocks) {
                    if (
                        pondX < rock.x + rock.size &&
                        pondX + pondWidth > rock.x &&
                        pondY < rock.y + rock.size &&
                        pondY + pondHeight > rock.y
                    ) {
                        overlap = true;
                        break;
                    }
                }
            }
            
            validLocation = !overlap;
        }
        
        // Add the pond
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
    
    // Generate coins (10-15)
    const coinCount = Math.floor(Math.random() * 6) + 10;
    for (let i = 0; i < coinCount; i++) {
        gameObjects.coins.push({
            id: `coin-${i}`,
            x: Math.random() * (mapWidth - 30),  // Adjust for coin size
            y: Math.random() * (mapHeight - 30),
            collected: false
        });
    }
    const ammoPackCount = Math.floor(Math.random() * 6) + 5;
    for (let i = 0; i < ammoPackCount; i++) {
        gameObjects.ammoPacks.push({
            id: `ammo-${i}`,
            x: Math.random() * (mapWidth - 30),
            y: Math.random() * (mapHeight - 30),
            collected: false
        });
    }
    
    console.log(`Generated ${treeCount} trees, ${rockCount} rocks, ${pondCount} ponds, ${coinCount} coins, and ${ammoPackCount} ammo packs`);
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
            bullet.x > 2000 || // WORLD_WIDTH
            bullet.y < 0 ||
            bullet.y > 1500    // WORLD_HEIGHT
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
            // In a real app, you would use JWT or another secure token method
            const adminToken = require('crypto').randomBytes(64).toString('hex');
            
            // Store the token (in-memory for simplicity - in production use Redis or similar)
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
        
        // Store username
        usernames.add(username);
        
        // Create player with random position and saved color
        players[socket.id] = {
            id: socket.id,
            username: username,
            x: Math.random() * 800,
            y: Math.random() * 500,
            color: color,
            score: 0,  // Initialize score
            ammo: 30 // Start with 30 bullets
        };
         // Generate game objects if first player
        if (Object.keys(players).length === 1) {
            generateGameObjects(2000, 1500);  // Use larger map size
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
        
        // Check if player is near water (simple implementation)
        let nearWater = false;
        const playerCenter = {
            x: player.x + 25, // Half of PLAYER_SIZE
            y: player.y + 25
        };
        
        for (const pond of gameObjects.ponds) {
            // Check if player is in ellipse of pond
            const dx = (playerCenter.x - (pond.x + pond.width/2)) / (pond.width/2);
            const dy = (playerCenter.y - (pond.y + pond.height/2)) / (pond.height/2);
            
            if (dx*dx + dy*dy <= 1) {
                nearWater = true;
                break;
            }
        }
        
        if (nearWater) {
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
        } else {
            // Player not near water - this is a cheat attempt or client/server desync
            socket.emit('chat_message', {
                username: 'System',
                message: 'You need to be at a pond to fish!'
            });
        }
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
        
        // Add server timestamp for bullet lifetime tracking
        bulletData.timestamp = Date.now();
        
        // Add bullet to server list
        bullets.push(bulletData);
        
        // Broadcast the new bullet to all players
        io.emit('bullets_update', bullets);
    }
});
socket.on('collect_ammo', (ammoPackId) => {
    if (players[socket.id]) {
        const username = players[socket.id].username;
        
        // Find the ammo pack
        const ammoPackIndex = gameObjects.ammoPacks.findIndex(ap => ap.id === ammoPackId);
        
        if (ammoPackIndex !== -1 && !gameObjects.ammoPacks[ammoPackIndex].collected) {
            // Mark ammo pack as collected
            gameObjects.ammoPacks[ammoPackIndex].collected = true;
            
            // Increase player ammo
            players[socket.id].ammo = Math.min(players[socket.id].ammo + AMMO_PACK_SIZE, MAX_AMMO);
            
            // Broadcast updated game state
            io.emit('game_state', { players, gameObjects });
            
            // Send notification
            io.emit('chat_message', {
                username: 'System',
                message: `${username} collected ammo! Ammo: ${players[socket.id].ammo}`
            });
            
            // Send direct ammo update to the client
            socket.emit('ammo_update', { ammo: players[socket.id].ammo });
            
            // Generate a new ammo pack after some time
            setTimeout(() => {
                if (Object.keys(players).length > 0) {  // Only if players still in game
                    const newAmmoPack = {
                        id: `ammo-${Date.now()}`,
                        x: Math.random() * 1970,
                        y: Math.random() * 1470,
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


    // Add a new handler for coin collection
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
            
            // Send notification
            io.emit('chat_message', {
                username: 'System',
                message: `${username} collected a coin! Score: ${players[socket.id].score}`
            });
            
            // Generate a new coin after some time
            setTimeout(() => {
                if (Object.keys(players).length > 0) {  // Only if players still in game
                    const newCoin = {
                        id: `coin-${Date.now()}`,
                        x: Math.random() * 1970,
                        y: Math.random() * 1470,
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
        // Keep player within world bounds
        if (position.x < 0) position.x = 0;
        if (position.y < 0) position.y = 0;
        if (position.x > 2000 - 50) position.x = 2000 - 50; // WORLD_WIDTH - PLAYER_SIZE
        if (position.y > 1500 - 50) position.y = 1500 - 50; // WORLD_HEIGHT - PLAYER_SIZE
        
        // Get the input sequence number from client
        const sequence = position.sequence;
        
        // Validate server-side that there's no collision
        if (!checkServerCollision(socket.id, position)) {
            players[socket.id].x = position.x;
            players[socket.id].y = position.y;
            
            // Store the last processed sequence number
            if (sequence !== undefined) {
                players[socket.id].lastProcessedSequence = sequence;
            }
            
            // Broadcast updated game state to all players
            io.emit('game_state', { 
                players, 
                sequence: players[socket.id].lastProcessedSequence 
            });
        } else {
            // If collision detected, send the original position back to the client
            socket.emit('game_state', { 
                players,
                sequence: players[socket.id].lastProcessedSequence 
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
            
            // Remove player from active game
            usernames.delete(username);
            delete players[socket.id];
            
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
        
        // Insert fish into database
        db.run(
            'INSERT INTO fish (user_id, type_id, name, size, rarity) VALUES (?, ?, ?, ?, ?)',
            [user.id, fish.typeId, fish.name, fish.size, fish.rarity],
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
    // Same collision logic as client side
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
function handlePlayerHit(playerId, bullet) {
    const shooterId = bullet.playerId;
    const BULLET_DAMAGE = 10; // Make sure this is defined
    
    // Shooter gains points
    if (players[shooterId]) {
        players[shooterId].score += BULLET_DAMAGE;
        
        // Update shooter's score in database
        const shooterUsername = players[shooterId].username;
        db.run(
            'UPDATE users SET score = ? WHERE username = ?',
            [players[shooterId].score, shooterUsername]
        );
    }
    
    // Hit player loses points
    if (players[playerId]) {
        // Prevent negative scores
        const newScore = Math.max(0, players[playerId].score - BULLET_DAMAGE);
        players[playerId].score = newScore;
        
        // Update hit player's score in database
        const playerUsername = players[playerId].username;
        db.run(
            'UPDATE users SET score = ? WHERE username = ?',
            [players[playerId].score, playerUsername]
        );
    }
    
    // Broadcast hit to all players
    io.emit('player_hit', {
        playerId: playerId,
        shooterId: shooterId,
        damage: BULLET_DAMAGE
    });
    
    // Broadcast updated game state with new scores
    io.emit('game_state', { players, gameObjects });
    
    // Optional: System message about hit
    io.emit('chat_message', {
        username: 'System',
        message: `${players[shooterId].username} hit ${players[playerId].username}! (+${BULLET_DAMAGE}/-${BULLET_DAMAGE} points)`
    });
}
setInterval(updateServerBullets, 33); // ~30 updates per second
// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});