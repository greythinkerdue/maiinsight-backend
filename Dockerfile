# --- deps: install once, cached while source changes.
# `prisma generate` runs via postinstall and needs the `prisma` CLI (a devDependency), so this
# stage installs everything; the runtime stage below only copies the resulting node_modules.
FROM node:20-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

# --- runtime ---
FROM node:20-alpine
RUN apk add --no-cache curl openssl \
  && addgroup -S maiinsight && adduser -S maiinsight -G maiinsight
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

USER maiinsight
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:5000/api/health || exit 1

CMD ["npm", "start"]
