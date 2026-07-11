import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as Y from 'yjs';

// OmniSync CRDT Sync Daemon (omnisyncd)
// Implements secure, persistent Yjs multi-peer synchronization.

const PORT = 8950;
const STATE_FILE = 'omnisync-state.bin';
const EXPECTED_TOKEN = process.env.OMNISYNC_TOKEN || 'secure-crdt-token-123';

const clients = new Set();
const ydoc = new Y.Doc();

// Load persistent state from disk (Free option: direct file-based binary storage)
if (fs.existsSync(STATE_FILE)) {
  try {
    const stateBuffer = fs.readFileSync(STATE_FILE);
    Y.applyUpdate(ydoc, new Uint8Array(stateBuffer));
    console.log(`[omnisyncd] Restored persistent CRDT rules state from "${STATE_FILE}".`);
  } catch (err) {
    console.error('[omnisyncd] Failed to load persistent state:', err.message);
  }
}

// Persist document updates to disk on every state modification
ydoc.on('update', () => {
  try {
    const state = Y.encodeStateAsUpdate(ydoc);
    fs.writeFileSync(STATE_FILE, Buffer.from(state));
  } catch (err) {
    console.error('[omnisyncd] State persistence failed:', err.message);
  }
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OmniSync Yjs CRDT Sync Daemon is running.');
});

server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket') {
    socket.destroy();
    return;
  }

  // Token-Based Handshake Authentication for secure cross-machine setups
  const urlParams = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
  const token = urlParams.get('token');
  
  if (token !== EXPECTED_TOKEN) {
    console.log('[omnisyncd] Access denied: Invalid security handshake token.');
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // WebSocket Handshake
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`
  ];

  socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');
  clients.add(socket);
  console.log('[omnisyncd] Multi-peer client authorized and connected successfully.');

  socket.on('data', (buffer) => {
    // Parse WebSocket frame
    const firstByte = buffer[0];
    const secondByte = buffer[1];
    
    const opCode = firstByte & 0x0f;
    if (opCode === 8) {
      console.log('[omnisyncd] Connection terminated by peer.');
      clients.delete(socket);
      socket.end();
      return;
    }

    const isMasked = (secondByte & 0x80) === 0x80;
    let payloadLength = secondByte & 0x7f;
    let maskKeyOffset = 2;

    if (payloadLength === 126) {
      payloadLength = buffer.readUInt16BE(2);
      maskKeyOffset = 4;
    } else if (payloadLength === 127) {
      payloadLength = Number(buffer.readBigUInt64BE(2));
      maskKeyOffset = 10;
    }

    if (isMasked) {
      const maskKey = buffer.slice(maskKeyOffset, maskKeyOffset + 4);
      const payload = buffer.slice(maskKeyOffset + 4, maskKeyOffset + 4 + payloadLength);
      
      const result = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i++) {
        result[i] = payload[i] ^ maskKey[i % 4];
      }
      
      const textMsg = result.toString('utf8');
      
      try {
        const parsed = JSON.parse(textMsg);
        
        // Handle Yjs CRDT Synchronization Messages
        if (parsed.type === 'sync-step-1') {
          const remoteStateVector = new Uint8Array(Buffer.from(parsed.stateVector, 'base64'));
          const update = Y.encodeStateAsUpdate(ydoc, remoteStateVector);
          
          sendFrame(socket, JSON.stringify({
            status: 'broadcasted',
            timestamp: new Date().toLocaleTimeString(),
            payload: {
              type: 'sync-step-2',
              update: Buffer.from(update).toString('base64'),
            }
          }));
        } else if (parsed.type === 'sync-step-2' || parsed.type === 'update') {
          if (parsed.type === 'update') {
            if (!parsed.signature || !parsed.publicKey) {
              console.error('[omnisyncd] SECURITY ALERT: Rejecting unsigned update.');
              return;
            }
            try {
              // 1. Cryptographic verification of the signature
              const verifier = crypto.createVerify('RSA-SHA256');
              verifier.update(parsed.update);
              const isValid = verifier.verify(parsed.publicKey, parsed.signature, 'base64');
              if (!isValid) {
                console.error('[omnisyncd] SECURITY ALERT: Invalid cryptographic signature for Yjs update. Update rejected.');
                return;
              }
              
              // 2. Impersonation check: check if the publicKey matches authorized developers
              const homeDir = process.env.HOME || process.env.USERPROFILE;
              const authorizedKeysPath = path.join(homeDir, '.ssh', 'authorized_keys');
              const localPubkeyPath = path.join(homeDir, '.ssh', 'id_rsa.pub');
              
              let isAuthorized = false;
              
              // Helper to clean public keys for comparison (ignore whitespace, comments, key-type prefix)
              const getCleanKeyBody = (keyStr) => {
                if (!keyStr) return '';
                const parts = keyStr.trim().split(/\s+/);
                // Standard SSH public key format: "ssh-rsa AAAA.... comment"
                if (parts.length >= 2 && parts[0].startsWith('ssh-')) {
                  return parts[1];
                }
                return keyStr.replace(/[\s\r\n]/g, '');
              };
              
              const payloadKeyBody = getCleanKeyBody(parsed.publicKey);
              
              if (fs.existsSync(localPubkeyPath)) {
                const localPubkey = fs.readFileSync(localPubkeyPath, 'utf8');
                if (getCleanKeyBody(localPubkey) === payloadKeyBody) {
                  isAuthorized = true;
                }
              }
              
              if (!isAuthorized && fs.existsSync(authorizedKeysPath)) {
                const authKeysContent = fs.readFileSync(authorizedKeysPath, 'utf8');
                const lines = authKeysContent.split('\n');
                for (const line of lines) {
                  const cleanedLine = line.trim();
                  if (cleanedLine && !cleanedLine.startsWith('#')) {
                    if (getCleanKeyBody(cleanedLine) === payloadKeyBody) {
                      isAuthorized = true;
                      break;
                    }
                  }
                }
              }
              
              if (!isAuthorized) {
                console.error('[omnisyncd] SECURITY ALERT: Public key is not authorized. Update rejected.');
                return;
              }
              
              console.log('[omnisyncd] Cryptographic signature and public key authorization verified successfully.');
            } catch (err) {
              console.error('[omnisyncd] SECURITY ALERT: Signature verification error:', err.message);
              return;
            }
          }

          const updateBytes = new Uint8Array(Buffer.from(parsed.update, 'base64'));
          
          // Apply local update to server's master doc (persists update automatically)
          Y.applyUpdate(ydoc, updateBytes, 'client');
          
          // Broadcast delta to all other active peer channels
          const broadcastMsg = JSON.stringify({
            status: 'broadcasted',
            timestamp: new Date().toLocaleTimeString(),
            payload: parsed
          });

          for (const client of clients) {
            if (client !== socket && client.writable) {
              sendFrame(client, broadcastMsg);
            }
          }
        }
      } catch (err) {
        console.error('[omnisyncd] CRDT frame routing error:', err.message);
      }
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
  });

  socket.on('end', () => {
    clients.delete(socket);
  });

  socket.on('error', (err) => {
    clients.delete(socket);
    console.error('[omnisyncd] Socket error:', err.message);
  });
});

function sendFrame(socket, message) {
  const payload = Buffer.from(message, 'utf8');
  const payloadLength = payload.length;
  
  let header;
  if (payloadLength <= 125) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = payloadLength;
  } else if (payloadLength <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

if (process.argv.includes('--sync-trigger')) {
  runCliClient();
} else {
  server.listen(PORT, () => {
    console.log(`[omnisyncd] Secure CRDT Daemon listening on ws://localhost:${PORT}`);
  });
}

async function runCliClient() {
  const triggerIdx = process.argv.indexOf('--sync-trigger');
  const repoPath = process.argv[triggerIdx + 1] || process.cwd();
  
  const possiblePaths = [
    path.join(repoPath, '.agents', 'AGENTS.md'),
    path.join(repoPath, 'AGENTS.md'),
    path.join(repoPath, '.cursorrules')
  ];
  
  let rulesContent = null;
  let foundPath = null;
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      rulesContent = fs.readFileSync(p, 'utf8');
      foundPath = p;
      break;
    }
  }
  
  if (!rulesContent) {
    console.log('[omnisync-hook] No rulebook files found to sync. Exiting.');
    process.exit(0);
  }
  
  console.log(`[omnisync-hook] Syncing rulebook from: ${foundPath}`);
  
  const tempDoc = new Y.Doc();
  const yText = tempDoc.getText('rulebook');
  yText.insert(0, rulesContent);
  const update = Y.encodeStateAsUpdate(tempDoc);
  const base64Update = Buffer.from(update).toString('base64');
  
  let signature = undefined;
  let publicKey = undefined;
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const privateKeyPath = path.join(homeDir, '.ssh', 'id_rsa');
  const publicKeyPath = path.join(homeDir, '.ssh', 'id_rsa.pub');
  
  if (!fs.existsSync(privateKeyPath)) {
    console.error(`[omnisync-hook] CRITICAL SECURITY ERROR: Local SSH private key not found at ${privateKeyPath}.`);
    process.exit(1);
  }
  if (!fs.existsSync(publicKeyPath)) {
    console.error(`[omnisync-hook] CRITICAL SECURITY ERROR: Local SSH public key not found at ${publicKeyPath}.`);
    process.exit(1);
  }
  
  try {
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    publicKey = fs.readFileSync(publicKeyPath, 'utf8');
    
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(base64Update);
    signature = signer.sign(privateKey, 'base64');
    console.log('[omnisync-hook] Cryptographic signature generated for update.');
  } catch (err) {
    console.error('[omnisync-hook] Failed to sign update with SSH key:', err.message);
    process.exit(1);
  }
  
  let useNodeSqlite = false;
  let DatabaseSyncClass = null;
  try {
    const sqliteModule = await import('node:sqlite');
    DatabaseSyncClass = sqliteModule.DatabaseSync;
    useNodeSqlite = true;
  } catch (e) {
    // fallback to CLI
  }

  const { execSync } = await import('child_process');
  const DB_FILE = path.join(homeDir, '.omnisync-queue.db');

  function initQueueDb() {
    if (useNodeSqlite) {
      const db = new DatabaseSyncClass(DB_FILE);
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT,
          update_data TEXT,
          signature TEXT,
          public_key TEXT
        )
      `);
      db.close();
    } else {
      try {
        execSync(`sqlite3 "${DB_FILE}" "CREATE TABLE IF NOT EXISTS sync_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, update_data TEXT, signature TEXT, public_key TEXT);"`);
      } catch (err) {
        console.error('[omnisync-hook] SQLite CLI initialization failed:', err.message);
      }
    }
  }

  function loadQueue() {
    initQueueDb();
    const queue = [];
    if (useNodeSqlite) {
      const db = new DatabaseSyncClass(DB_FILE);
      const stmt = db.prepare('SELECT id, type, update_data, signature, public_key FROM sync_queue ORDER BY id ASC');
      const rows = stmt.all();
      for (const row of rows) {
        queue.push({
          id: row.id,
          type: row.type,
          update: row.update_data,
          ...(row.signature && row.public_key ? { signature: row.signature, publicKey: row.public_key } : {})
        });
      }
      db.close();
    } else {
      try {
        const output = execSync(`sqlite3 "${DB_FILE}" "SELECT id, type, update_data, signature, public_key FROM sync_queue ORDER BY id ASC;"`, { encoding: 'utf8' });
        const lines = output.trim().split('\n');
        for (const line of lines) {
          if (!line) continue;
          const parts = line.split('|');
          if (parts.length >= 3) {
            const id = parts[0];
            const type = parts[1];
            const update_data = parts[2];
            const signatureVal = parts[3] || '';
            const public_keyVal = parts[4] || '';
            queue.push({
              id: parseInt(id, 10),
              type,
              update: update_data,
              ...(signatureVal && public_keyVal ? { signature: signatureVal, publicKey: public_keyVal } : {})
            });
          }
        }
      } catch (err) {
        console.error('[omnisync-hook] Failed to load offline queue via SQLite CLI:', err.message);
      }
    }
    return queue;
  }

  function addToQueue(payloadData) {
    initQueueDb();
    if (useNodeSqlite) {
      const db = new DatabaseSyncClass(DB_FILE);
      const stmt = db.prepare('INSERT INTO sync_queue (type, update_data, signature, public_key) VALUES (?, ?, ?, ?)');
      stmt.run(payloadData.type, payloadData.update, payloadData.signature || null, payloadData.publicKey || null);
      db.close();
    } else {
      try {
        const type = payloadData.type;
        const update_data = payloadData.update;
        const signatureVal = payloadData.signature || '';
        const public_keyVal = payloadData.publicKey || '';
        const esc = (str) => str.replace(/'/g, "''");
        execSync(`sqlite3 "${DB_FILE}" "INSERT INTO sync_queue (type, update_data, signature, public_key) VALUES ('${esc(type)}', '${esc(update_data)}', '${esc(signatureVal)}', '${esc(public_keyVal)}');"`);
      } catch (err) {
        console.error('[omnisync-hook] Failed to add to offline queue via SQLite CLI:', err.message);
      }
    }
  }

  function clearQueue() {
    initQueueDb();
    if (useNodeSqlite) {
      const db = new DatabaseSyncClass(DB_FILE);
      db.exec('DELETE FROM sync_queue');
      db.close();
    } else {
      try {
        execSync(`sqlite3 "${DB_FILE}" "DELETE FROM sync_queue;"`);
      } catch (err) {
        console.error('[omnisync-hook] Failed to clear offline queue via SQLite CLI:', err.message);
      }
    }
  }

  const payload = {
    type: 'update',
    update: base64Update,
    ...(signature && publicKey ? { signature, publicKey } : {})
  };

  try {
    const WebSocketClient = globalThis.WebSocket || (await import('ws')).default;
    const ws = new WebSocketClient(`ws://localhost:${PORT}?token=${EXPECTED_TOKEN}`);
    let connected = false;

    ws.onopen = () => {
      connected = true;
      const queue = loadQueue();
      if (queue.length > 0) {
        console.log(`[omnisync-hook] Reconnecting online. Replaying ${queue.length} buffered updates...`);
        for (const queuedPayload of queue) {
          ws.send(JSON.stringify(queuedPayload));
        }
        clearQueue();
      }

      ws.send(JSON.stringify(payload));
      console.log('[omnisync-hook] CRDT update sent successfully.');
      setTimeout(() => {
        ws.close();
        process.exit(0);
      }, 500);
    };
    
    ws.onerror = (err) => {
      if (!connected) {
        console.warn('[omnisync-hook] Connection failed. Buffering update to offline queue:', err.message);
        addToQueue(payload);
        process.exit(0);
      }
    };
  } catch (err) {
    console.error('[omnisync-hook] Failed to initialize WebSocket client:', err.message);
    addToQueue(payload);
    process.exit(1);
  }
}
