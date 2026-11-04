# syntax=docker/dockerfile:1

# Una sola receta para todos los microservicios. El servicio se elige con
#   docker build --build-arg SERVICE=catalog-service .
# El builder compila solo ese servicio y los paquetes compartidos; la imagen
# final instala solo sus dependencias de produccion y corre sin privilegios.
# Secretos y configuracion llegan en tiempo de ejecucion (variables y volumen).

# Alpine (musl) por omision. ai-service usa una base Debian (glibc) porque el
# runtime ONNX de su traductor no tiene binarios para musl (ver compose.yaml).
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS builder
ARG SERVICE
RUN test -n "$SERVICE" || (echo "Falta --build-arg SERVICE" && exit 1)
# openssl: motor de Prisma. La base puede ser Alpine (apk) o Debian (apt).
RUN if command -v apk > /dev/null; then apk add --no-cache openssl; \
    else apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*; fi
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
RUN if command -v apk > /dev/null; then apk add --no-cache openssl; \
    else apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*; fi
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
# Carpeta de los modelos de traduccion de ai-service: un volumen nuevo montado
# aqui hereda este duenio, asi el servicio (sin privilegios) puede escribir.
RUN mkdir -p /models && chown node:node /models
USER node
WORKDIR /app/services/${SERVICE}
CMD ["node", "dist/main.js"]
