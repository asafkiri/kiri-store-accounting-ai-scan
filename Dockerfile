FROM node:22-bookworm-slim AS verify
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm run build && npm test

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=verify /app/node_modules ./node_modules
COPY package.json ./package.json
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
