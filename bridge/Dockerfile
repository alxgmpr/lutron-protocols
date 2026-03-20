FROM node:22-slim

WORKDIR /app

# Install deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source (only what's needed)
COPY lib/ lib/
COPY ccx/ ccx/
COPY protocol/ protocol/
COPY bridge/main.ts bridge/
COPY tools/leap-client.ts tools/
COPY tsconfig.json ./

# Default config volume mount point
RUN mkdir -p /config

ENV NODE_ENV=production

CMD ["npx", "tsx", "bridge/main.ts"]
