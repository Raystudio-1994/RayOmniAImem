#!/bin/bash
# OmniSync Production Launcher Script

echo "=================================================="
echo "⚡ Starting OmniSync CRDT Sync Daemon..."
echo "=================================================="
node omnisyncd.js &
DAEMON_PID=$!

# Allow daemon to bind to port 8950
sleep 1

echo "=================================================="
echo "🚀 Launching Electron Desktop GUI App..."
echo "=================================================="
NODE_ENV=production npx electron .

# Clean up daemon on app exit
echo "Closing background sync daemon..."
kill $DAEMON_PID
echo "Done."
