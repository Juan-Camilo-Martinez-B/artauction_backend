# ADR 0001: microservicios con capa internal y capa api

Estado: aceptado.

## Contexto

El monolito modular comparte un Prisma y un Mongo entre modulos. Varias transacciones cruzan contextos (pujas, cierre, auditoria) y los modulos importan servicios de otros modulos. Se quiere bajo acoplamiento y encapsulamiento real.

## Decision

Cada contexto delimitado (DDD) es un microservicio desplegable por separado. Dentro de cada uno se aplica arquitectura hexagonal:

- `internal/domain`: entidades, value objects y reglas puras, sin frameworks.
- `internal/application`: casos de uso y puertos (interfaces) que el caso de uso necesita.
- `internal/infrastructure`: implementaciones de puertos de persistencia y planificacion.
- `api`: la unica frontera. Expone el servidor gRPC, traduce entre mensajes proto y DTO de aplicacion, e implementa los puertos que llaman a otros servicios.

La capa api es la unica que habla con la parte interna y con la api de otros servicios. Ningun tipo generado de un `.proto` entra en `internal`.

## Consecuencias

- SOLID: SRP por caso de uso, OCP y LSP mediante adaptadores intercambiables, ISP con puertos pequenos y DIP porque `internal` depende de abstracciones que `api` implementa.
- Las fronteras se comprueban en el lint con `no-restricted-imports`.
- Hay mas codigo de mapeo; es el precio del encapsulamiento.
