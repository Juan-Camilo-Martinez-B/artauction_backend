# syntax=docker/dockerfile:1

# Una sola receta para todos los microservicios. El servicio se elige con
#   docker build --build-arg SERVICE=catalog-service .
# El builder compila solo ese servicio y los paquetes compartidos; la imagen
# final instala solo sus dependencias de produccion y corre sin privilegios.
# Secretos y configuracion llegan en tiempo de ejecucion (variables y volumen).

ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS builder
ARG SERVICE
RUN test -n "$SERVICE" || (echo "Falta --build-arg SERVICE" && exit 1)
# openssl: motor de Prisma en musl.
RUN apk add --no-cache openssl
WORKDIR /repo
COPY . .
RUN npm ci --ignore-scripts \
 && npm run build -w @artauction/contracts -w @artauction/platform -w @artauction/service-kit -w "@artauction/${SERVICE}"
# Solo los package.json, con su ruta, para resolver los workspaces en la imagen final.
RUN mkdir /manifests \
 && cp package.json package-lock.json /manifests/ \
 && for file in packages/*/package.json services/*/package.json; do mkdir -p "/manifests/$(dirname "$file")" && cp "$file" "/manifests/$file"; done

FROM ${NODE_IMAGE} AS runner
ARG SERVICE
ENV NODE_ENV=production
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=builder /manifests ./
RUN npm ci --omit=dev --ignore-scripts \
      -w @artauction/contracts -w @artauction/platform -w @artauction/service-kit -w "@artauction/${SERVICE}" \
 && npm cache clean --force
COPY --from=builder /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /repo/packages/platform/dist ./packages/platform/dist
COPY --from=builder /repo/packages/service-kit/dist ./packages/service-kit/dist
COPY --from=builder /repo/services/${SERVICE}/dist ./services/${SERVICE}/dist
COPY scripts/docker/grpc-health.cjs ./scripts/docker/grpc-health.cjs
USER node
WORKDIR /app/services/${SERVICE}
CMD ["node", "dist/main.js"]
