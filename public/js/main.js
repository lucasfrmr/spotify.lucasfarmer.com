function displayPlaybackState(data) {
    $('#album-href').attr('href', data.album_href);
    $('#album-image').attr('src', data.album_image);
    $('#track-href').attr('href', data.track_href);
    $('#track-name').text(data.name);
    $('#track-artists').text(data.artists.join(', '));
}

function updateHistoryContent(historyData) {
    // Assuming historyData is an array of history items
    const historyTableBody = document.querySelector('#history-tab tbody');
    historyTableBody.innerHTML = ''; // Clear existing content

    historyData.forEach(item => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="whitespace-nowrap px-6 py-4">${item.datePlayed}</td>
            <td class="whitespace-nowrap px-6 py-4">${item.trackName}</td>
            <td class="whitespace-nowrap px-6 py-4">${item.artist}</td>
            <td class="whitespace-nowrap px-6 py-4">${item.album}</td>
            <td class="whitespace-nowrap px-6 py-4">${item.duration}</td>
        `;
        historyTableBody.appendChild(row);
    });
}

function connectWebSocket() {
    const ws = new WebSocket(`wss://${window.location.hostname}`);

    ws.addEventListener('open', () => {
        console.log('WebSocket Connected!');
        // No need to send a message here; server will send recent-song on connection
    });

    ws.addEventListener('message', (event) => {
        const response = JSON.parse(event.data);
        if (response.status !== 'error') {
            if (response.type === 'update-playback-state' || response.type === 'recent-song') {
                displayPlaybackState(response.data);
            }
        } else {
            console.error(response.message);
        }
    });

    ws.addEventListener('open', () => {
        console.log('WebSocket Connected!');
        // Request history data after establishing connection
        ws.send(JSON.stringify({ type: 'get-history' }));
    });

    ws.addEventListener('message', (event) => {
        const response = JSON.parse(event.data);
        if (response.status !== 'error') {
            if (response.type === 'update-playback-state' || response.type === 'recent-song') {
                displayPlaybackState(response.data);
            } else if (response.type === 'history-data') {
                // Handle the history data
                updateHistoryContent(response.data);
            }
        } else {
            console.error(response.message);
        }
    });

    ws.addEventListener('close', () => {
        console.log('WebSocket Disconnected. Attempting to reconnect...');
        setTimeout(connectWebSocket, 4000);
    });

    ws.addEventListener('error', (error) => {
        console.error('WebSocket Error:', error);
    });
}

$(document).ready(() => {
    connectWebSocket();
});
