import asyncio
import websockets
import json
import uuid # For generating unique client IDs if needed, though using remote_address for now

# clients: { client_id (str, e.g., "host:port"): websocket_object }
clients = {}
# sessions: { session_id (str): { "sender_ws": websocket_object, "requester_ws": websocket_object (optional), "metadata": {} (optional) } }
sessions = {}

async def register_client(websocket):
    client_id = str(websocket.remote_address) # Simple unique ID
    clients[client_id] = websocket
    print(f"Client {client_id} connected. Total clients: {len(clients)}")
    return client_id

async def unregister_client(client_id):
    if client_id in clients:
        del clients[client_id]
        print(f"Client {client_id} disconnected. Total clients: {len(clients)}")
        # Clean up sessions associated with this client
        sessions_to_remove = []
        for session_id, session_data in sessions.items():
            if session_data.get("sender_ws") == client_id or session_data.get("requester_ws") == client_id:
                sessions_to_remove.append(session_id)
            # If sender disconnects, notify requester if any
            elif session_data.get("sender_ws") and str(session_data["sender_ws"].remote_address) == client_id:
                 if "requester_ws" in session_data and session_data["requester_ws"] in clients: # check if requester is still connected
                    requester_websocket = clients[session_data["requester_ws"]]
                    try:
                        await requester_websocket.send(json.dumps({
                            "type": "peer-disconnected",
                            "sessionId": session_id,
                            "reason": "Sender disconnected"
                        }))
                    except Exception as e:
                        print(f"Error notifying requester about sender disconnection: {e}")
                 sessions_to_remove.append(session_id)
            # If requester disconnects, notify sender if any (less critical but good for cleanup)
            elif session_data.get("requester_ws") and str(session_data["requester_ws"].remote_address) == client_id:
                if "sender_ws" in session_data and session_data["sender_ws"] in clients: # check if sender is still connected
                    sender_websocket = clients[session_data["sender_ws"]]
                    try:
                        await sender_websocket.send(json.dumps({
                            "type": "peer-disconnected",
                            "sessionId": session_id,
                            "reason": "Requester disconnected"
                        }))
                    except Exception as e:
                        print(f"Error notifying sender about requester disconnection: {e}")
                sessions_to_remove.append(session_id)


        for session_id in sessions_to_remove:
            if session_id in sessions:
                print(f"Cleaning up session {session_id} due to client {client_id} disconnection.")
                del sessions[session_id]


async def handler(websocket, path):
    client_id = await register_client(websocket)
    try:
        async for message_str in websocket:
            try:
                message = json.loads(message_str)
                msg_type = message.get("type")
                session_id = message.get("sessionId")

                print(f"Received message from {client_id}: {message}")

                if msg_type == "file-offer":
                    sessions[session_id] = {
                        "sender_id": client_id, # Store sender's actual ID
                        "sender_ws": websocket, # Keep websocket for direct communication initially
                        "metadata": {
                            "fileName": message.get("fileName"),
                            "fileSize": message.get("fileSize"),
                            "fileType": message.get("fileType")
                        },
                        "requester_id": None # Will be filled when a request comes
                    }
                    print(f"Session {session_id} created by {client_id} for file {message.get('fileName')}")
                    # No immediate ack to sender, sender UI shows link.

                elif msg_type == "file-request":
                    if session_id in sessions:
                        session_data = sessions[session_id]
                        sender_id = session_data["sender_id"]
                        sender_ws = clients.get(sender_id) # Get sender's websocket from clients dict

                        if sender_ws and sender_id != client_id: # Ensure sender is connected and not self-request
                            session_data["requester_id"] = client_id
                            session_data["requester_ws"] = websocket # Store requester's websocket for this session

                            # Notify original sender to initiate WebRTC
                            await sender_ws.send(json.dumps({
                                "type": "initiate-webrtc",
                                "requesterId": client_id, # Let sender know who is asking
                                "sessionId": session_id
                            }))
                            print(f"Sent 'initiate-webrtc' to {sender_id} for session {session_id} from {client_id}")
                        elif sender_id == client_id:
                             print(f"Client {client_id} attempted to request their own file for session {session_id}.")
                             await websocket.send(json.dumps({"type": "error", "message": "Cannot request your own file."}))
                        else:
                            await websocket.send(json.dumps({"type": "peer-not-found", "sessionId": session_id, "reason": "Sender disconnected"}))
                    else:
                        await websocket.send(json.dumps({"type": "peer-not-found", "sessionId": session_id, "reason": "Session ID does not exist"}))

                elif msg_type in ["offer", "answer", "ice-candidate"]:
                    target_id = message.get("targetId")
                    if not target_id:
                        print(f"Error: Message type {msg_type} from {client_id} is missing targetId.")
                        continue

                    target_ws = clients.get(target_id)
                    if target_ws:
                        # Add senderId to the message so target knows who it's from
                        payload = message.copy() # Avoid modifying original if it's used later
                        payload["senderId"] = client_id

                        # For ICE candidates, the candidate might be nested
                        if msg_type == "ice-candidate" and "candidate" in message:
                             full_payload = {"type": msg_type, "candidate": message["candidate"], "sessionId": session_id, "senderId": client_id}
                        elif msg_type == "offer" and "sdp" in message:
                             full_payload = {"type": msg_type, "sdp": message["sdp"], "sessionId": session_id, "senderId": client_id}
                        elif msg_type == "answer" and "sdp" in message:
                             full_payload = {"type": msg_type, "sdp": message["sdp"], "sessionId": session_id, "senderId": client_id}
                        else: # Should not happen if client sends correct format
                            print(f"Warning: Potentially malformed {msg_type} from {client_id}")
                            full_payload = payload

                        await target_ws.send(json.dumps(full_payload))
                        print(f"Relayed {msg_type} from {client_id} to {target_id} for session {session_id}")
                    else:
                        print(f"Target client {target_id} not found for message {msg_type} from {client_id}.")
                        # Optionally, notify sender that target is not available
                        # await websocket.send(json.dumps({"type": "error", "message": f"Target {target_id} not available"}))

                else:
                    print(f"Unhandled message type {msg_type} from {client_id}")

            except json.JSONDecodeError:
                print(f"Could not decode JSON from {client_id}: {message_str}")
            except Exception as e:
                print(f"Error processing message from {client_id} ({message_str}): {e}")
                # Consider sending an error message back to the client for critical errors
                # await websocket.send(json.dumps({"type": "error", "message": str(e)}))

    except websockets.exceptions.ConnectionClosedError:
        print(f"Client {client_id} connection closed (error).")
    except Exception as e:
        print(f"An error occurred with client {client_id}: {e}")
    finally:
        await unregister_client(client_id)

async def main():
    host = 'localhost'
    port = 8765
    async with websockets.serve(handler, host, port):
        print(f"WebSocket signaling server started on ws://{host}:{port}")
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Server shutting down...")
