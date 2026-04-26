FROM node:22-slim

WORKDIR /app

# Install deps (tsx needed at runtime for TypeScript execution)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx -y tsx --version

# Copy source (self-contained — all needed files are in the add-on dir)
COPY lib/ lib/
COPY ccx/ ccx/
COPY protocol/ protocol/
COPY bridge/main.ts bridge/
COPY tsconfig.json ./
COPY run.sh ./

# Default config/data mount points
RUN mkdir -p /config/ccx-bridge /data

ENV NODE_ENV=production

CMD ["/bin/sh", "/app/run.sh"]
