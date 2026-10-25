FROM oven/bun:1.3-slim

WORKDIR /app

# Install dependencies dulu (cache-friendly)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Salin source
COPY src/ ./src/
COPY tsconfig.json ./

# Workspace sandbox tool Pi (di-mount sebagai disk di Render bila persistent)
RUN mkdir -p /app/workspace

ENV PORT=3000 \
    AGENT_CWD=/app/workspace

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)process.exit(1)})" || exit 1

CMD ["bun", "run", "src/index.ts"]
