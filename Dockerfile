# One image for all three services; SERVICE_PKG (set per Railway service)
# selects which workspace's `start` script runs.
FROM node:24-slim

WORKDIR /app

# Install dependencies first for layer caching. Copy the root manifest plus
# every workspace's package.json so `npm install` can resolve the workspace graph.
COPY package.json package-lock.json ./
COPY packages/shared/package.json        packages/shared/
COPY packages/marketplace-api/package.json packages/marketplace-api/
COPY packages/creator-agent/package.json   packages/creator-agent/
COPY packages/buyer-agent/package.json     packages/buyer-agent/
COPY packages/contracts/package.json       packages/contracts/
RUN npm install --no-audit --no-fund

# App source (node_modules, build junk, and secrets excluded by .dockerignore)
COPY . .

# Root "start" runs: npm start --workspace packages/${SERVICE_PKG}
CMD ["npm", "start"]
