document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('fileInput');
    const shareButton = document.getElementById('shareButton');
    const shareLinkDisplay = document.getElementById('shareLinkDisplay');
    const joinLinkInput = document.getElementById('joinLinkInput');
    const downloadButton = document.getElementById('downloadButton');

    let webSocket;
    let localSessionId = null; // To store the ID of the session this client initiates
    let peerConnection;
    let dataChannel;
    let currentRemotePeerId = null; // Stores the ID of the remote peer for the current WebRTC connection

    const servers = {'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]};
    const CHUNK_SIZE = 64 * 1024; // 64KB

    function connectWebSocket() {
        webSocket = new WebSocket('ws://localhost:8765');

        webSocket.onopen = () => {
            console.log('WebSocket connection established.');
            // Potentially enable UI elements that depend on WebSocket here
        };

        webSocket.onerror = (error) => {
            console.error('WebSocket error:', error);
            shareLinkDisplay.textContent = 'Error connecting to signaling server. Please ensure it is running.';
            // Potentially disable or update UI elements
        };

        webSocket.onmessage = (event) => {
            console.log('WebSocket message received:', event.data);
            try {
                const message = JSON.parse(event.data);
                console.log('Parsed message:', message);

                switch (message.type) {
                    // Existing cases from previous step (file-offer-ack, peer-not-found for requester)
                    // ... these are primarily for the client acting as a RECEIVER
                    case 'file-offer-ack':
                        console.log(`Received acknowledgment for session ${message.sessionId}`);
                        console.log(`File details: Name: ${message.fileName}, Size: ${message.fileSize}, Type: ${message.fileType}`);
                        alert(`File offer acknowledged by original sender: ${message.fileName}. Preparing for WebRTC setup.`);
                        // This case is actually if THIS client sent a file-request and the SENDER acknowledged it.
                        // The SENDER would have received 'initiate-webrtc' and then sent an 'offer'.
                        // This client (requester) will soon receive an 'offer'.
                        break;
                    case 'peer-not-found':
                        alert(`Share link ID "${message.sessionId}" not found or peer has disconnected. Please check the link or try again.`);
                        currentRemotePeerId = null;
                        break;

                    // New cases for SENDER's WebRTC initiation logic
                    case 'initiate-webrtc': // Sent from server to original file sharer
                        if (message.sessionId === localSessionId) { // Ensure it's for a session this client started
                            console.log(`Peer ${message.requesterId} wants to connect for session ${message.sessionId}. Initializing WebRTC.`);
                            currentRemotePeerId = message.requesterId; // Store who we are talking to

                            peerConnection = new RTCPeerConnection(servers);

                            peerConnection.onicecandidate = event => {
                                if (event.candidate && webSocket && webSocket.readyState === WebSocket.OPEN) {
                                    webSocket.send(JSON.stringify({
                                        type: 'ice-candidate',
                                        candidate: event.candidate,
                                        sessionId: message.sessionId,
                                        targetId: currentRemotePeerId // Send to the requester
                                    }));
                                    console.log('Sent ICE candidate to', currentRemotePeerId);
                                }
                            };

                            peerConnection.oniceconnectionstatechange = () => {
                                console.log(`ICE connection state: ${peerConnection.iceConnectionState}`);
                                if (peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'failed') {
                                    currentRemotePeerId = null;
                                    // Potentially close peerConnection and dataChannel here
                                }
                            };

                            dataChannel = peerConnection.createDataChannel('fileTransferChannel');
                            // Note: Data channel reliability is not guaranteed by default.
                            // For critical control messages like metadata or completion, consider using WebSocket if issues arise,
                            // or implement an ACK mechanism over the data channel. For file data, default (unreliable) is often fine.
                            dataChannel.onopen = () => {
                                console.log('Data channel OPEN with', currentRemotePeerId);
                                shareLinkDisplay.textContent = `Data channel open with ${currentRemotePeerId}.`;

                                const file = fileInput.files[0];
                                if (file) {
                                    console.log(`Starting file send: ${file.name} (${file.size} bytes)`);
                                    shareLinkDisplay.textContent = `Sending ${file.name}... (0%)`;

                                    // 1. Send metadata first
                                    const metadata = {
                                        type: 'file-metadata',
                                        name: file.name,
                                        size: file.size,
                                        fileType: file.type
                                    };
                                    dataChannel.send(JSON.stringify(metadata));
                                    console.log('Sent file metadata:', metadata);

                                    // 2. Start sending file chunks
                                    sendFileInChunks(file);
                                } else {
                                    // Fallback to test message if no file selected, though UI flow should prevent this.
                                    const testMessage = "Hello from sender! (No file selected)";
                                    dataChannel.send(testMessage);
                                    console.log("Sent test message (no file was selected):", testMessage);
                                    shareLinkDisplay.textContent = `Data channel open. Test message sent as no file was selected.`;
                                }
                            };
                            dataChannel.onclose = () => {
                                console.log('Data channel CLOSE with', currentRemotePeerId);
                                currentRemotePeerId = null;
                            };
                            dataChannel.onerror = (error) => {
                                console.error('Data channel error with', currentRemotePeerId, ':', error);
                            };
                            dataChannel.onmessage = (event) => { // For ACKs or other control messages from receiver
                                console.log('Data channel message from', currentRemotePeerId, ':', event.data);
                            };

                            peerConnection.createOffer()
                                .then(offer => peerConnection.setLocalDescription(offer))
                                .then(() => {
                                    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
                                        webSocket.send(JSON.stringify({
                                            type: 'offer',
                                            sdp: peerConnection.localDescription,
                                            sessionId: message.sessionId,
                                            targetId: currentRemotePeerId // Send to the requester
                                        }));
                                        console.log('Sent offer to', currentRemotePeerId);
                                    }
                                })
                                .catch(e => console.error('Error creating or sending offer:', e));
                        } else {
                            console.log("Received 'initiate-webrtc' for a session not started by this client or mismatched ID, ignoring.", message.sessionId, localSessionId);
                        }
                        break;

                    // Cases for handling incoming SDP (offer/answer) and ICE candidates
                    case 'offer': // Received by the REQUESTER (this client, when it sent a file-request)
                        if (message.sessionId && message.sdp && message.senderId) {
                            console.log(`Received SDP offer from ${message.senderId} for session ${message.sessionId}.`);
                            currentRemotePeerId = message.senderId; // Store who sent the offer

                            // Ensure peerConnection is nullified if it exists from a previous failed attempt or different session
                            if (peerConnection) {
                                peerConnection.close();
                            }
                            peerConnection = new RTCPeerConnection(servers);

                            // Re-setup handlers for the new peerConnection instance
                            peerConnection.onicecandidate = event => {
                                if (event.candidate && webSocket && webSocket.readyState === WebSocket.OPEN) {
                                    webSocket.send(JSON.stringify({
                                        type: 'ice-candidate',
                                        candidate: event.candidate,
                                        sessionId: message.sessionId,
                                        targetId: currentRemotePeerId // Send back to the offerer (original sender)
                                    }));
                                    console.log('Sent ICE candidate to', currentRemotePeerId);
                                }
                            };

                            peerConnection.oniceconnectionstatechange = () => {
                                console.log(`ICE connection state: ${peerConnection.iceConnectionState}`);
                                 if (peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'failed') {
                                    currentRemotePeerId = null;
                                }
                            };

                            peerConnection.ondatachannel = event => {
                                dataChannel = event.channel;
                                console.log('Data channel received:', dataChannel.label);
                                shareLinkDisplay.textContent = `Connected for file download via data channel: ${dataChannel.label}`;

                                dataChannel.onopen = () => {
                                    console.log('Data channel OPEN (received)');
                                    shareLinkDisplay.textContent = `Data channel open with ${currentRemotePeerId}. Waiting for data...`;
                                    alert(`Data channel with ${currentRemotePeerId} is open! Ready to receive data.`);
                                };
                                dataChannel.onclose = () => {
                                    console.log('Data channel CLOSE (received)');
                                    shareLinkDisplay.textContent = `Data channel with ${currentRemotePeerId} closed.`;
                                    currentRemotePeerId = null;
                                };
                                dataChannel.onerror = (error) => {
                                    console.error('Data channel error (received):', error);
                                    shareLinkDisplay.textContent = `Data channel error with ${currentRemotePeerId}.`;
                                };
                                dataChannel.onmessage = (event) => {
                                    console.log('Data channel message (received):', event.data);
                                    shareLinkDisplay.textContent = `Received from ${currentRemotePeerId}: "${event.data}"`;
                                    alert(`Received message: ${event.data}`);
                                    // Later, this will handle file chunks
                                };
                            };

                            // Add oniceconnectionstatechange for requester as well
                            peerConnection.oniceconnectionstatechange = () => {
                                console.log(`ICE connection state (requester): ${peerConnection.iceConnectionState}`);
                                if (peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'failed') {
                                    currentRemotePeerId = null;
                                    shareLinkDisplay.textContent = "Connection lost.";
                                } else if (peerConnection.iceConnectionState === 'connected') {
                                     shareLinkDisplay.textContent = `Connected to ${currentRemotePeerId}.`;
                                }
                            };

                            peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp))
                                .then(() => {
                                    console.log('Remote description (offer) set successfully.');
                                    return peerConnection.createAnswer();
                                })
                                .then(answer => {
                                    console.log('Answer created successfully.');
                                    return peerConnection.setLocalDescription(answer);
                                })
                                .then(() => {
                                    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
                                        webSocket.send(JSON.stringify({
                                            type: 'answer',
                                            sdp: peerConnection.localDescription,
                                            sessionId: message.sessionId,
                                            targetId: currentRemotePeerId // Send answer back to the offerer
                                        }));
                                        console.log('Sent answer to', currentRemotePeerId);
                                    }
                                })
                                .catch(e => console.error('Error processing offer or creating answer:', e));
                        } else {
                            console.error("Received malformed 'offer':", message);
                        }
                        break;

                    case 'answer': // Received by the SENDER (this client, when it initiated with createOffer)
                        if (message.sessionId === localSessionId && message.sdp && message.senderId === currentRemotePeerId) {
                            console.log(`Received SDP answer from ${message.senderId} for session ${message.sessionId}.`);
                            peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp))
                                .then(() => {
                                    console.log('Remote description (answer) set successfully by sender.');
                                    // Connection should now be established, data channel will open.
                                })
                                .catch(e => console.error('Error setting remote description (answer):', e));
                        } else {
                             console.warn("Received 'answer' for unexpected session/peer or malformed:", message, localSessionId, currentRemotePeerId);
                        }
                        break;

                    case 'ice-candidate': // Received by either SENDER or REQUESTER
                        if (peerConnection && message.candidate && message.senderId === currentRemotePeerId) {
                            console.log(`Received ICE candidate from ${message.senderId} for session ${message.sessionId}.`);
                            peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate))
                                .then(() => console.log('Added received ICE candidate successfully.'))
                                .catch(e => console.error('Error adding received ICE candidate:', e));
                        } else {
                            console.warn("Received 'ice-candidate' but peerConnection not ready, or sender mismatch, or malformed:", message, currentRemotePeerId);
                        }
                        break;

                    case 'peer-disconnected':
                        if (message.sessionId === localSessionId || (currentRemotePeerId && message.senderId === currentRemotePeerId) ) {
                             alert(`Peer for session ${message.sessionId} has disconnected: ${message.reason}`);
                             if (peerConnection) {
                                 peerConnection.close();
                                 peerConnection = null;
                             }
                             if (dataChannel) {
                                 dataChannel.close();
                                 dataChannel = null;
                             }
                             currentRemotePeerId = null;
                             // Reset UI related to this connection if necessary
                        }
                        break;

                    default:
                        console.log('Received unhandled message type:', message.type, message);
                }
            } catch (e) {
            console.error('Failed to parse message or handle incoming message:', e, event.data);
            }
        };

        webSocket.onclose = () => {
            console.log('WebSocket connection closed.');
            // Potentially disable or update UI elements, attempt reconnection, etc.
            shareLinkDisplay.textContent = 'Disconnected from signaling server.';
        };
    }

    shareButton.addEventListener('click', () => {
        if (!fileInput.files || fileInput.files.length === 0) {
            alert('Please select a file to share.');
            return;
        }

        if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
            alert('WebSocket is not connected. Please wait or try refreshing.');
            return;
        }

        const file = fileInput.files[0];
        localSessionId = generateUniqueId(); // Store this session ID

        const message = {
            type: 'file-offer',
            sessionId: localSessionId,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type
        };

        webSocket.send(JSON.stringify(message));
        console.log('Sent file offer:', message);

        shareLinkDisplay.textContent = `Your share link: #${localSessionId}`;
        // Disable share button or file input here if desired, to prevent sharing multiple files
        // under the same generated link or to simplify state management.
        // For now, we allow re-sharing which will generate a new link.
    });

    downloadButton.addEventListener('click', () => {
        const linkValue = joinLinkInput.value.trim();
        if (!linkValue) {
            alert('Please paste a share link.');
            return;
        }

        const sessionId = linkValue.startsWith('#') ? linkValue.substring(1) : linkValue;

        if (!sessionId) {
            alert('Invalid share link format.');
            return;
        }

        if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
            alert('WebSocket is not connected. Please wait or try refreshing.');
            return;
        }

        const message = {
            type: 'file-request',
            sessionId: sessionId
        };

        webSocket.send(JSON.stringify(message));
        console.log('Sent file request for session ID:', sessionId);
        // Optionally, provide feedback to the user, like "Request sent, waiting for peer..."
    });

    function generateUniqueId() {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }

    // Initialize WebSocket connection when the script loads
    connectWebSocket();

    function sendFileInChunks(file, offset = 0) {
        const reader = new FileReader();

        reader.onload = () => {
            if (!dataChannel || dataChannel.readyState !== 'open') {
                console.warn('Data channel closed or not open while trying to send chunk. Aborting.');
                shareLinkDisplay.textContent = 'Error: Data channel closed during transfer.';
                return;
            }
            try {
                dataChannel.send(reader.result); // reader.result is an ArrayBuffer
                offset += reader.result.byteLength;

                const progress = Math.round((offset / file.size) * 100);
                shareLinkDisplay.textContent = `Sending ${file.name}... (${progress}%)`;
                console.log(`Sent chunk. Offset: ${offset}, Progress: ${progress}%`);

                if (offset < file.size) {
                    sendFileInChunks(file, offset); // Schedule next chunk
                } else {
                    console.log('File sending complete.');
                    shareLinkDisplay.textContent = `File ${file.name} sent successfully!`;
                    dataChannel.send(JSON.stringify({ type: 'transfer-complete' }));
                }
            } catch (error) {
                console.error('Error sending data chunk:', error);
                shareLinkDisplay.textContent = `Error sending file: ${error.message}`;
                // Potentially close datachannel or send error message
            }
        };

        reader.onerror = (error) => {
            console.error('FileReader error:', error);
            shareLinkDisplay.textContent = `Error reading file: ${error.message}`;
        };

        if (offset < file.size) {
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            reader.readAsArrayBuffer(slice);
        }
    }
});
