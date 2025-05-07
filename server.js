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
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('Database initialized');
});

// Game state
const players = {};
const usernames = new Set();
const gameObjects = {
    trees: [],
    rocks: [],
    coins: [],
    ammoPacks: [] // Add this new array
};
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
    
    console.log(`Generated ${treeCount} trees, ${rockCount} rocks, ${coinCount} coins, and ${ammoPackCount} ammo packs`);
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