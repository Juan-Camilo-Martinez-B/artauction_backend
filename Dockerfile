# syntax=docker/dockerfile:1

# Imagen de producción del monolito NestJS para Cloud Run.
# Escucha en $PORT. El mismo artefacto sirve HTTP y el gateway Socket.IO.
# El worker de auditoría corre en el mismo proceso y consume pg-boss.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json
USER app
EXPOSE 8080
CMD ["node", "dist/main.js"]
