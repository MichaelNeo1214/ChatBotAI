# syntax=docker/dockerfile:1
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first so source edits do not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The server, plus the static frontend it serves from the repo root.
COPY src ./src
COPY tsconfig.json .node-version ./
COPY index.html ./
COPY css ./css
COPY js ./js
COPY components ./components
COPY landing-page ./landing-page

# SQLite lives here; mount a volume to keep it across container replacements.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
ENV DATABASE_PATH=/app/data/chatbot.db

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/index.ts"]
