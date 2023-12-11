import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { MongoClient, ServerApiVersion } from 'mongodb';
import { CronJob } from 'cron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { PORT, MONGODB, SPOTIFY_CLIENTID, SPOTIFY_CLIENTSECRET } = process.env;
let SPOTIFY_ACCESSTOKEN = '';

const app = express();
const wss = new WebSocketServer({ 
	server: app.listen(PORT, () => { 
		console.log(`[${new Date().toISOString()}]: The NodeJS application (${__dirname.split('/').pop()}) is running on port ${PORT};`) 
	})
});
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

function getcurrentlyplaying() {
	return  getSpotifyData('https://api.spotify.com/v1/me/player', SPOTIFY_ACCESSTOKEN);
}

async function logcurrentlyplaying() {
    const currentlyplaying = await getcurrentlyplaying();
    if (currentlyplaying && currentlyplaying.item) {
        // Fetch the last played track from MongoDB
        const lastplayedtrack = await mongo.db('Spotify').collection('tracks').findOne({}, { sort: { $natural: -1 } });

        // Check if the last played track exists and if it's different from the current track
        if (!lastplayedtrack || currentlyplaying.item.id !== lastplayedtrack.id) {
            // Prepare the track data
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

            // Insert the new track into MongoDB
await mongo.db('Spotify').collection('tracks').insertOne(track);
console.log('New track logged: ' + currentlyplaying.item.name);

// Send data over websockets
const trackData = JSON.stringify(track);
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

	setInterval(() => {
		if (ws.readyState === WebSocket.OPEN) ws.ping();
	}, 2e4);

	ws.on('message', async (message) => {
		const request = JSON.parse(message);
		switch (request.type) {
			case 'get-playback-state':
				console.log(`[${new Date().toISOString()}]: ${clientIp} websocket client (${clientId}) is requesting ${request.type} from spotify-web-api`);
				ws.send(JSON.stringify({ type: request.type, data: await getSpotifyData('https://api.spotify.com/v1/me/player', SPOTIFY_ACCESSTOKEN) }));
				break;
			case 'get-recently-played-tracks':
				console.log(`[${new Date().toISOString()}]: ${clientIp} websocket client (${clientId}) is requesting ${request.type} from spotify-web-api`);
				// ws.send(JSON.stringify({ type: request.type, data: await getSpotifyData('https://api.spotify.com/v1/me/player/recently-played', SPOTIFY_ACCESSTOKEN) }));
				break;
			case 'get-track':
				console.log(`[${new Date().toISOString()}]: ${clientIp} websocket client (${clientId}) is requesting ${request.type} from spotify-web-api`);
				ws.send(JSON.stringify({ type: request.type, data: await getSpotifyData(`https://api.spotify.com/v1/tracks/${request.data}`, SPOTIFY_ACCESSTOKEN) }));
				break;
		}
	});

	ws.on('close', () => {
		console.log(`[${new Date().toISOString()}]: ${clientIp} websocket client (${clientId}) disconnected`);
	});
});

wss.on('error', (error) => {
	console.error(`[${new Date().toISOString()}]: ${error.message}`);
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

app.get('/login', (req, res) => {
	const params = new URLSearchParams({
		client_id: SPOTIFY_CLIENTID,
		response_type: 'code',
		redirect_uri: `https://${__dirname.split('/').pop()}/callback`,
		scope: 'user-read-currently-playing user-read-playback-state user-read-recently-played'
	});
	res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/callback', async (req, res) => {
	const callbackCode = req.query.code;
	if (callbackCode) {
		const requestOptions = {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Authorization': 'Basic ' + (new Buffer.from(`${SPOTIFY_CLIENTID}:${SPOTIFY_CLIENTSECRET}`).toString('base64'))
			},
			body: `grant_type=authorization_code&code=${callbackCode}&redirect_uri=https://${__dirname.split('/').pop()}/callback`
		};
		try {
			const requestResponse = await fetch('https://accounts.spotify.com/api/token', requestOptions);
			if (requestResponse.ok) {
				const data = await requestResponse.json();
				await mongo.db('Spotify').collection('tokens').updateOne({}, {
					$set: {
						access_token: data.access_token,
						refresh_token: data.refresh_token,
						scope: data.scope
					}
				}, { upsert: true });
				await setAccessToken();
				res.redirect('/');
			} else {
				throw new Error('failed to request the access_token from spotify-web-api');
			}
		} catch (error) {
			console.error(`[${new Date().toISOString()}]: ${error.message}`);
			res.sendStatus(500);
		}
	} else {
		res.redirect('/login');
	}
});

app.use('/robots.txt', (req, res) => {
	res.type('text/plain');
	res.send('User-agent: *\nDisallow: /');
});

process.on('SIGINT', () => {
	console.log(`[${new Date().toISOString()}]: The NodeJS application (${__dirname.split('/').pop()}) on port ${PORT} is being shutdown from SIGINT (Ctrl-C);`);
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
					'Authorization': 'Basic ' + (new Buffer.from(`${SPOTIFY_CLIENTID}:${SPOTIFY_CLIENTSECRET}`).toString('base64'))
				},
				body: `grant_type=refresh_token&refresh_token=${spotifyTokens.refresh_token}`
			};
			try {
				const requestResponse = await fetch('https://accounts.spotify.com/api/token', requestOptions);
				if (requestResponse.ok) {
					const data = await requestResponse.json();
					await mongo.db('Spotify').collection('tokens').updateOne({}, {
						$set: {
							access_token: data.access_token
						}
					}, { upsert: true });
					await setAccessToken();
					return;
				} else {
					throw new Error('failed to refresh the access_token for spotify-web-api');
				}
			} catch (error) {
				console.error(`[${new Date().toISOString()}]: ${error.message}`);
			}
		} else {
			throw new Error(`authorize spotify-web-api at https://${__dirname.split('/').pop()}/login`);
		}
	} catch (error) {
		console.error(`[${new Date().toISOString()}]: ${error.message}`);
	}
}).start();