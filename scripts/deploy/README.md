# Despliegue en producción

| Parte | Dónde | Detalle |
|---|---|---|
| Frontend | Vercel | Repositorio `artauction_frontend`, rama `main` |
| Backend | Azure Container Apps, Canadá Central | Una app por servicio; solo `api-gateway` es público |
| Base de datos | Supabase, Este de EE. UU. | Un usuario por servicio, por el pooler en modo sesión |
| Imágenes y modelos | Supabase Storage | Bucket público `artauction-media`, API S3 |

Canadá Central no es una elección libre: Azure for Students solo permite ciertas regiones en cada suscripción, y esta es la más cercana a la base.

## Secretos

Nada de esto se versiona.

| Archivo | Contenido |
|---|---|
| `../artauction_bd/.env.supabase` | URL de administrador de la base y contraseñas de cada servicio |
| `secrets/production/storage.env` | Claves S3 de Supabase Storage |
| `secrets/production/demo.env` | Contraseñas del administrador y de los vendedores |
| `secrets/production/vercel.env` | Variables del frontend |
| `secrets/production/jwt-*.pem`, `service-clients.env` | Claves JWT y secretos entre servicios |
| `services/ai-service/.env` | Clave de Groq |

## Pasos

```bash
node scripts/deploy/azure.mjs secrets   # crea lo que falte; no sobrescribe
node scripts/deploy/azure.mjs infra     # grupo de recursos, registro y entorno
node scripts/deploy/azure.mjs images    # construye y publica las 9 imágenes
FRONTEND_ORIGIN=https://artauction-frontend.vercel.app node scripts/deploy/azure.mjs apps
```

Todos se pueden repetir. Para actualizar solo algunas apps, usa `DEPLOY_ONLY=api-gateway,catalog-service`.

Las migraciones y los usuarios de la base van aparte, desde `artauction_bd`, con `scripts/migrate/apply.sh` y `scripts/roles/create-logins.sh` usando `.env.supabase`. No cargues la semilla: trae cuentas con contraseñas conocidas.

La cuenta de administrador se registra por la API y después se cambia su rol a `ADMIN` con SQL, porque la API nunca permite elegir ese rol.

## Cargar el catálogo

1. Lanza las apps con `DEPLOY_LOAD_MODE=1`: ai-service queda sin Groq y audit-service sin aprobación automática, y así cada obra sale con su precio.
2. Sigue [demo-catalog/README.md](../catalog/demo-catalog/README.md), con `DEMO_API_URL` apuntando al gateway y las variables de `demo.env`.
3. Vuelve a lanzar `apps` sin esa variable, para `ai-service` y `audit-service`.

## Lo que costó descubrir

- **Entorno express:** sin indicar el modo, Azure crea un entorno express, sin HTTP/2 y por tanto sin gRPC. Por eso el script usa la API con `environmentMode: WorkloadProfiles`.
- **gRPC interno:** cada servicio se llama por `nombre:80`, con `transport: http2` y `allowInsecure`. El tráfico no sale de la red del entorno.
- **Una sola réplica:** `api-gateway` guarda las salas en memoria, así que no puede tener varias sin cambios.
- **Etiqueta de imagen:** las apps usan la última etiqueta publicada, guardada en `secrets/production/image-tag`, no el último commit.

## Para ver qué pasa

```bash
az containerapp replica list -n catalog-service -g artauction-prod
az containerapp logs show -n catalog-service -g artauction-prod --tail 50
```
