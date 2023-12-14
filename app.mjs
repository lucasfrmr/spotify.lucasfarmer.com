import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { MongoClient, ServerApiVersion } from 'mongodb';
import { CronJob } from 'cron';
import fs from 'fs';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { PORT, MONGODB, SPOTIFY_CLIENTID, SPOTIFY_CLIENTSECRET } = process.env;
let SPOTIFY_ACCESSTOKEN = '';

const app = express();
const wss = new WebSocketServer({ noServer: true });
const mongo = new MongoClient(MONGODB, { serverApi: ServerApiVersion.v1 });

async function setAccessToken() {
    try {
        const spotifyTokens = await mongo.db('Spotify').collection('tokens').findOne();
        if (spotifyTokens) {
            SPOTIFY_ACCESSTOKEN = spotifyTokens.access_token;
            return;
        } else {
            throw new Error(`authorize spotify web api at https://${__dirname.split('/').pop()}/login`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}]: ${error.message}`);
    }
}

await setAccessToken();

function generateRandomId(length) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from({ length }, () => characters[Math.floor(Math.random() * characters.length)]).join('');
}

async function getSpotifyData(spotifyUrl, accessToken) {
    const requestOptions = { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}` } };
    try {
        const requestResponse = await fetch(spotifyUrl, requestOptions);
        if (requestResponse.status === 200) {
            return await requestResponse.json();
        } else {
            throw new Error(`spotify-web-api status code ${requestResponse.status}`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}]: ${error.message}`);
        return { status: 'error', message: error.message };
    }
}

async function logcurrentlyplaying() {
    const currentlyplaying = await getSpotifyData('https://api.spotify.com/v1/me/player', SPOTIFY_ACCESSTOKEN);
    if (currentlyplaying && currentlyplaying.item) {
        const lastplayedtrack = await mongo.db('Spotify').collection('tracks').findOne({}, { sort: { $natural: -1 } });
        if (!lastplayedtrack || currentlyplaying.item.id !== lastplayedtrack.id) {
            const track = {
                id: currentlyplaying.item.id,
                name: currentlyplaying.item.name,
                artists: currentlyplaying.item.artists.map(artist => artist.name),
                album: currentlyplaying.item.album.name,
                album_image: currentlyplaying.item.album.images[1].url,
                album_href: currentlyplaying.item.album.external_urls.spotify,
                track_href: currentlyplaying.item.external_urls.spotify,
                duration_ms: currentlyplaying.item.duration_ms,
                progress_ms: currentlyplaying.progress_ms,
                is_playing: currentlyplaying.is_playing,
                timestamp: new Date().toISOString()
            };
            await mongo.db('Spotify').collection('tracks').insertOne(track);
            console.log('New track logged: ' + currentlyplaying.item.name);
			const trackData = JSON.stringify({ type: 'update-playback-state', data: track });
			wss.clients.forEach(client => {
				if (client.readyState === WebSocket.OPEN) {
					client.send(trackData);
				}
			});
        } else {
            console.log('No new track to log');
        }
    } else {
        console.error('Error fetching currently playing track');
    }
}

setInterval(logcurrentlyplaying, 4000);

wss.on('connection', async (ws, req) => {
    const clientId = generateRandomId(16);
    const clientIp = req.headers['x-forwarded-for'].split(',')[0].trim();
    console.log(`[${new Date().toISOString()}]: ${clientIp} websocket client (${clientId}) connected`);

    // Regularly check WebSocket connection status
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20000);

    // Handle incoming messages from the client
    ws.on('message', async (message) => {
        const request = JSON.parse(message);
        switch (request.type) {
            case 'get-playback-state':
                ws.send(JSON.stringify({ type: request.type, data: await getSpotifyData('https://api.spotify.com/v1/me/player', SPOTIFY_ACCESSTOKEN) }));
                
                break;
            case 'get-recently-played-tracks':
                // Handle this case if needed
                break;
            case 'get-track':
                ws.send(JSON.stringify({ type: request.type, data: await getSpotifyData(`https://api.spotify.com/v1/tracks/${request.data}`, SPOTIFY_ACCESSTOKEN) }));
                break;
            case 'history':
                console.log('history');
                const historyData = await mongo.db('Spotify').collection('tracks').find().sort({ timestamp: -1 }).toArray();
                ws.send(JSON.stringify({ type: request.type, data: historyData }));
                break;
            case 'search':
                console.log('search term is: ' + request.data.searchTerm);
                ws.send(JSON.stringify({ type: request.type, data: await getSpotifyData(`https://api.spotify.com/v1/search?q=${request.data.searchTerm}&type=track&limit=5`, SPOTIFY_ACCESSTOKEN) }));
                break;
        }
    });

    // Handle WebSocket disconnection
    ws.on('close', () => {
        console.log(`[${new Date().toISOString()}]: ${clientIp} websocket client (${clientId}) disconnected`);
    });

    // Fetch and send the most recent song after connection
    try {
        const recentSong = await mongo.db('Spotify').collection('tracks').findOne({}, { sort: { $natural: -1 } });
        if (recentSong) {
            ws.send(JSON.stringify({ type: 'recent-song', data: recentSong }));
        }
    } catch (error) {
        console.error(`Error fetching recent song: ${error.message}`);
    }
});

wss.on('error', (error) => {
    console.error(`[${new Date().toISOString()}]: ${error.message}`);
});

const server = app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}]: Server running on port ${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

app.locals.pretty = true;
app.set('trust proxy', true);
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.disable('x-powered-by');

app.get('/', async (req, res) => {
    if (SPOTIFY_ACCESSTOKEN) {
        res.sendFile(__dirname + '/views/index.html');
    } else {
        res.sendStatus(500);
    }
});

// Implement other routes like /login, /callback, etc. here

app.use('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send('User-agent: *\nDisallow: /');
});

process.on('SIGINT', () => {
    console.log(`[${new Date().toISOString()}]: Server shutting down from SIGINT (Ctrl-C)`);
    process.exit(0);
});

new CronJob('*/15 * * * *', async () => {
    try {
        const spotifyTokens = await mongo.db('Spotify').collection('tokens').findOne();
        if (spotifyTokens) {
            const requestOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + (Buffer.from(`${SPOTIFY_CLIENTID}:${SPOTIFY_CLIENTSECRET}`).toString('base64'))
                },
                body: `grant_type=refresh_token&refresh_token=${spotifyTokens.refresh_token}`
            };
            const requestResponse = await fetch('https://accounts.spotify.com/api/token', requestOptions);
            if (requestResponse.ok) {
                const data = await requestResponse.json();
                await mongo.db('Spotify').collection('tokens').updateOne({}, {
                    $set: {
                        access_token: data.access_token
                    }
                }, { upsert: true });
                await setAccessToken();
            } else {
                throw new Error('Failed to refresh the access_token for Spotify API');
            }
        } else {
            throw new Error(`Authorize Spotify API at https://${__dirname.split('/').pop()}/login`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}]: ${error.message}`);
    }
}).start();

