const fs = require('fs');
const path = require('path');
const https = require('https');

// Simple .env parser
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key && value) {
        process.env[key.trim()] = value.trim();
      }
    });
  }
}

loadEnv();

const CLIENT_ID = process.env.IGDB_CLIENT_ID;
const CLIENT_SECRET = process.env.IGDB_CLIENT_SECRET;
const DATA_FILE = path.resolve(__dirname, '../src/_data/recommendations.json');
const IMAGE_DIR = path.resolve(__dirname, '../src/images/recommendations');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: IGDB_CLIENT_ID and IGDB_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

async function getAccessToken() {
  const url = `https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`;
  const response = await fetch(url, { method: 'POST' });
  const data = await response.json();
  return data.access_token;
}

async function fetchGameCover(title, accessToken) {
  const url = 'https://api.igdb.com/v4/games';
  const query = `search "${title}"; fields name, cover.url; limit 1;`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Client-ID': CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'text/plain'
    },
    body: query
  });

  const games = await response.json();
  if (games && games.length > 0 && games[0].cover) {
    return 'https:' + games[0].cover.url.replace('t_thumb', 't_cover_big');
  }
  return null;
}

async function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 200) {
        const fileStream = fs.createWriteStream(filepath);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });
      } else {
        reject(new Error(`Failed to download image: ${res.statusCode}`));
      }
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function main() {
  try {
    const accessToken = await getAccessToken();
    console.log('Authenticated with IGDB.');

    const items = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    let updatedCount = 0;

    for (let item of items) {
      // Only fetch for games that don't have an image yet
      if (item.tags.includes('game') && !item.image) {
        console.log(`Fetching cover for game: ${item.title}...`);
        const coverUrl = await fetchGameCover(item.title, accessToken);
        
        if (coverUrl) {
          const fileName = item.title.toLowerCase().replace(/[^a-z0-8]/g, '-') + '.jpg';
          const filePath = path.join(IMAGE_DIR, fileName);
          
          await downloadImage(coverUrl, filePath);
          item.image = `/images/recommendations/${fileName}`;
          updatedCount++;
          console.log(`  Updated image for ${item.title}`);
        } else {
          console.warn(`  No cover found for ${item.title}`);
        }
      }
    }

    if (updatedCount > 0) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
      console.log(`Successfully updated ${updatedCount} recommendations in ${DATA_FILE}`);
    } else {
      console.log('No updates needed.');
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

main();
