# ADR 0010: PostgreSQL como único motor

Estado: aceptado. Reemplaza la parte de Mongo del ADR 0003.

## Contexto

Hasta F9, cuatro servicios guardaban documentos en una base de Mongo propia:

- identity: sesiones de refresh;
- audit: informes completos;
- gallery: galería social y feed;
- notification: avisos.

Todo lo demás vivía en Postgres.

La plataforma se va a desplegar en la nube con planes gratuitos. Con dos motores harían falta dos proveedores (por ejemplo, Supabase o Neon y MongoDB Atlas M0), cada uno con sus límites, sus credenciales, su respaldo y su forma de pausarse por inactividad.

Revisando qué hacía Mongo en cada caso:

- documentos que se leen completos (el informe de auditoría);
- listas por dueño y fecha (galería, feed, avisos);
- un índice TTL (sesiones).

Ninguna de esas cosas necesita un motor documental: Postgres las cubre con JSONB, índices compuestos y parciales, y un barrido periódico. Además, el informe de auditoría se escribía en Mongo antes de la transacción del resumen. Si esa transacción fallaba, quedaba un informe huérfano.

## Decisión

- **Un solo motor, PostgreSQL**, sin extensiones obligatorias. Cada colección pasa a una tabla del esquema de su dueño (migración `0022` de artauction_bd):
  - `identity.refresh_sessions`;
  - `audit.reports`;
  - `gallery.items` y `gallery.activity`;
  - `notification.notifications` y `notification.inbox`.
- **notification recibe su propio esquema**, con el rol `notification_rw` y el login `notification_svc`. Se conserva el esquema por servicio del ADR 0003: ningún servicio lee tablas de otro.
- **Lo anidado va en JSONB y lo que se filtra, en columnas.** El informe de auditoría guarda el expediente y la evaluación en JSONB, y tiene columnas para la obra, quién decidió y la fecha.
- **El informe usa la llave de su resumen** (FK dentro del esquema `audit`) y se escribe en la misma transacción que el resumen y el evento del outbox.
- **El TTL de las sesiones lo reemplaza `PurgeExpiredSessions`**, un barrido periódico de identity-service con la misma retención: un día después de vencer. Se descartó `pg_cron` porque depende del proveedor, no existe en la imagen local y deja de correr si el proyecto gratuito se pausa.
- **Las escrituras idempotentes de Mongo (`$setOnInsert`) pasan a ser `INSERT ... ON CONFLICT DO NOTHING`** sobre los ids deterministas que ya usaban gallery y notification.
- **Sin migración de datos.** La semilla recrea los documentos; base y backend se publican juntos.

## Consecuencias

- Toda la plataforma cabe en un solo plan gratuito de Postgres administrado, con un respaldo y una credencial por servicio.
- Desaparecen el contenedor de Mongo en compose y en CI, `mongodb` y `mongoose` de cuatro servicios, y los esquemas, índices y respaldos de Mongo en artauction_bd.
- Ninguna escritura de la plataforma cruza dos motores, y el informe de auditoría no puede quedar sin su resumen.
- Se pierde la flexibilidad de esquema de Mongo. Un campo nuevo en un documento JSONB no necesita migración, pero uno nuevo en columnas sí, igual que en el resto del modelo.
- **pgvector** queda como mejora futura: indexaría la búsqueda de imágenes duplicadas (`bit(64)` con el operador de Hamming y un índice HNSW) cuando el catálogo crezca.
- Al desplegar, cada servicio debe conectarse por el pooler del proveedor, porque los planes gratuitos limitan las conexiones. Se configura cuando se elija la nube.
