FROM node:20-alpine

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install only production dependencies (yjs)
RUN npm install --only=production

# Copy daemon implementation
COPY omnisyncd.js ./

EXPOSE 8950

# Default environment token (override in production)
ENV OMNISYNC_TOKEN=secure-crdt-token-123

CMD ["node", "omnisyncd.js"]
