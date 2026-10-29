# audit-service

Auditoría de autenticidad de ArtAuction AI. Decide si una obra se publica sola o va a revisión manual, con argumentos verificables. Es el dueño del esquema `audit` (`audit_summaries`, `audit_requests`, `ai_assessments`, `outbox`, `inbox`) y de la base Mongo `artauction_audit`. Expone `artauction.audit.v1.AuditService` y `AuditEventHandlerService` por gRPC (puerto `50056`).

## Flujo

```
catalog --LotSubmitted--> audit-service --(cola propia)--> worker
                                                            |
            ficha y duplicados (catalog) <------------------+
            imagenes (Garage / hosts permitidos) <----------+  expediente de evidencias
            reglas deterministas ---------------------------+
                                                            |
               critica? --si--> revision manual (sin IA, 0 tokens)
                  | no
               cache del expediente? --si--> evaluacion anterior
                  | no
               ai-service (Gemini o evaluacion local)
                                                            |
            resumen + AuditCompleted (outbox) + informe (Mongo)
                                                            |
            catalog (estado y precios), auction (programa la sala), notification (aviso)
```

## Expediente de evidencias

La IA nunca recibe imágenes. El sistema mide la obra y la IA razona sobre ese resumen, de modo que el costo en tokens es acotado y cada argumento queda verificable.

| Fuente | Evidencias (código = valor) |
|---|---|
| Lo declarado | `lot.declared_year`, `lot.declared_materials`, `lot.declared_aspect` y, en el texto, título, artista, procedencia y descripción recortada |
| Cada imagen (`sharp`) | `imgN.size`, `imgN.aspect`, `imgN.sharpness` (varianza del Laplaciano), `imgN.entropy`, `imgN.saturation`, `imgN.dominant_color` |
| Metadatos (`exifr`: EXIF, XMP, IPTC) | `imgN.exif.software`, `imgN.exif.camera`, `imgN.exif.taken_at`, `imgN.exif.generator` |
| Catálogo | `catalog.duplicateN`: imagen casi idéntica (dHash, distancia de Hamming ≤ 6) en otra obra, vía `FindSimilarImages` |

## Reglas deterministas

| Código | Severidad | Cuándo |
|---|---|---|
| `MATERIAL_ANACHRONISM` | crítica | Material declarado anterior a su invención, como acrílico antes de 1950 o giclée antes de 1990 |
| `DUPLICATE_IMAGE_OTHER_SELLER` | crítica | La imagen aparece en la obra de otro vendedor |
| `AI_GENERATOR_METADATA` | crítica | Los metadatos mencionan Midjourney, DALL·E, Stable Diffusion, Firefly u otro generador |
| `DUPLICATE_IMAGE_SAME_SELLER` | advertencia | El vendedor reutiliza la imagen de otra de sus obras |
| `ASPECT_MISMATCH` | advertencia | La proporción de la imagen principal no cuadra con las medidas declaradas (tolerancia 15 %) |
| `LOW_RESOLUTION` | advertencia | Lado mayor por debajo de 800 px |
| `BLURRY_IMAGE` | advertencia | Nitidez baja |
| `NO_ANALYZABLE_IMAGES` | advertencia | Ninguna imagen se pudo analizar |

Cada hallazgo cita las evidencias que lo sostienen.

## Ahorro de tokens

1. **Cortocircuito:** si una regla crítica ya decide, no se llama a la IA (`decided_by = RULES`).
2. **Caché:** la huella SHA-256 del expediente (lo declarado, las evidencias y los hallazgos) se busca en `audit.ai_assessments` durante 30 días. La misma obra sin cambios no vuelve a consultar al modelo. La evaluación local no se cachea, para que una clave de Gemini posterior sí opine.
3. **Entrada compacta:** solo JSON con claves cortas y textos recortados. Salida acotada (ver el README de ai-service).

## Veredicto

Va a revisión manual si hay algo crítico (de las reglas o del modelo) o si el score queda por debajo de 40; si no, la obra se aprueba. En ningún caso la IA puede anular una regla crítica.

## Cola y reintentos

- `HandleLotSubmitted` registra el evento en el inbox y crea la solicitud en la **misma transacción**, así una auditoría nunca se pierde ni se duplica. El índice único parcial impide dos auditorías pendientes de la misma obra.
- El worker toma solicitudes con `FOR UPDATE SKIP LOCKED` y un lease de 2 minutos. Un fallo, por ejemplo con ai-service caído, se reintenta con backoff: 10 s, 20 s, 40 s, 80 s.
- Al quinto fallo emite `AuditCompleted` con revisión manual (`decided_by = FALLBACK`): la obra nunca queda atascada.
- Si la obra ya no está `PENDIENTE_AUDITORIA`, la solicitud se cierra sin emitir nada.
- El resumen, el evento del outbox y el cierre de la solicitud van en una sola transacción. El informe completo va antes a Mongo, idempotente por `_id`.

## Seguridad de las descargas

Las imágenes se descargan solo desde la base pública de Garage y los hosts https de `AUDIT_IMAGE_HOSTS`, como protección contra SSRF. No se siguen redirecciones, hay timeout y tope de bytes, solo se acepta `image/*`, y `sharp` limita los píxeles de entrada.

Node en Windows no resuelve `*.localhost`. Por eso una URL de la base pública de Garage se pide a `MEDIA_INTERNAL_BASE_URL` conservando la cabecera `Host`, que es como Garage elige el bucket.

## Revisión manual

`BatchGetReviewReports`, solo para ADMIN, devuelve por obra el último resumen con sus hallazgos. Cada hallazgo trae el **valor** de las evidencias que cita, tomado del expediente guardado en Mongo; por ejemplo, `lot.declared_year = 1910`. El administrador decide con los mismos argumentos que usó la auditoría. Los informes anteriores a F7 se leen igual, con sus hallazgos y sin evidencias.

## Estructura

```
src/
  api/grpc/          AuditService (resúmenes) y AuditEventHandlerService (LotSubmitted)
  api/clients/       catalog (ficha y FindSimilarImages) y ai (AuditArtwork)
  api/events/        rutas del outbox de AuditCompleted
  internal/
    domain/          expediente, reglas, huella, veredicto y evento
    application/     EnqueueAudit, RunAuditWorker, GetLatestSummaries y puertos
    infrastructure/  Prisma (cola, caché, resúmenes), Mongo (informes), MediaFetcher, SharpImageAnalyzer
  audit.module.ts    raíz de composición, worker y relay del outbox
```

## Ejecutar

```bash
cp .env.example .env     # completar DATABASE_URL (usuario audit_svc) y SERVICE_CLIENT_SECRET
npm run build -w @artauction/audit-service
npm start -w @artauction/audit-service
```

## Pruebas

`npm test -w @artauction/audit-service`:

- reglas (anacronismo, duplicados, resolución, nitidez, proporción, metadatos de generador) y estabilidad de la huella;
- worker: camino con IA y caché, cortocircuito sin IA, acierto de caché, la evaluación local no se cachea, reintentos con backoff, respaldo al quinto fallo y obras que ya no esperan auditoría;
- descargador que rechaza hosts no permitidos, http externo y credenciales en la URL;
- análisis de una imagen real generada con `sharp`.
