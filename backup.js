const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Backup directory
const backupDir = path.join(__dirname, '.data', 'backups');
if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
}

// Database path
const dbPath = path.join(__dirname, '.data', 'gamedb.sqlite');

// Create backup
function createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `backup-${timestamp}.sqlite`);
    
    // Only backup if the database exists
    if (fs.existsSync(dbPath)) {
        try {
            // Copy the database file
            fs.copyFileSync(dbPath, backupPath);
            console.log(`Backup created at: ${backupPath}`);
            
            // Keep only the 5 most recent backups
            const backups = fs.readdirSync(backupDir)
                .filter(file => file.startsWith('backup-'))
                .sort()
                .reverse();
                
            if (backups.length > 5) {
                backups.slice(5).forEach(file => {
                    fs.unlinkSync(path.join(backupDir, file));
                    console.log(`Removed old backup: ${file}`);
                });
            }
        } catch (err) {
            console.error('Backup failed:', err);
        }
    } else {
        console.log('Database file not found, skipping backup');
    }
}

// Run backup
createBackup();