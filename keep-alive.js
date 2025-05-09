const https = require('https');

if (process.env.PROJECT_DOMAIN) {
    setInterval(() => {
        const url = `https://${process.env.PROJECT_DOMAIN}.glitch.me/ping`;
        https.get(url, (res) => {
            console.log(`Keep-alive ping to ${url}:`, res.statusCode);
        }).on('error', (err) => {
            console.error('Keep-alive ping error:', err.message);
        });
    }, 280000);
} else {
    console.log('Not running on Glitch, skipping keep-alive setup');
}