# ADR 0003: un esquema Postgres por servicio

Estado: aceptado. La parte de Mongo la reemplaza el ADR 0010: desde F10 todo vive en Postgres.

## Contexto

Database per service exige que ningun servicio lea tablas de otro. Se valoraron una base por servicio, un esquema por servicio y un contenedor por servicio.

## Decision

Una sola base Postgres con un esquema por servicio: `identity`, `catalog`, `auction`, `wallet`, `audit` y `gallery` (y `notification` desde F10). Cada servicio se conecta con un rol propio que solo tiene permisos sobre su esquema. En Mongo, una base por servicio (`artauction_identity`, `artauction_audit`, `artauction_gallery`, `artauction_notification`).

Se eliminan las llaves foraneas entre contextos (por ejemplo `lots.seller_id -> users.id`). La integridad entre servicios pasa a ser responsabilidad de los casos de uso y de los eventos.

## Consecuencias

- El aislamiento depende de los permisos por rol, que se crean en la migracion.
- Un solo servidor de base de datos en local y en CI.
- La migracion sigue el patron expand y contract: primero se mueven las tablas y se dejan vistas de compatibilidad para el monolito; al retirarlo se eliminan las vistas.
