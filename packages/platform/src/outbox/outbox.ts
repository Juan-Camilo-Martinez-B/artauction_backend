import { randomUUID } from 'node:crypto';

/** Evento de dominio listo para guardarse en el outbox. `payload` es JSON plano. */
export interface DomainEvent {
  type: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export interface OutboxMessage {
  id: string;
  seq: number;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
}

/**
 * Ejecuta SQL parametrizado ($1, $2, ...). Cada servicio lo adapta a su cliente
 * de base de datos, con o sin transaccion.
 */
export interface SqlExecutor {
  query<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  execute(sql: string, ...params: unknown[]): Promise<number>;
}

/** Forma minima de un cliente con SQL crudo, como PrismaClient o su transaccion. */
export interface RawSqlClient {
  $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
}

export function sqlExecutorFrom(client: RawSqlClient): SqlExecutor {
  return {
    query: <T>(sql: string, ...params: unknown[]) => client.$queryRawUnsafe<T[]>(sql, ...params),
    execute: (sql: string, ...params: unknown[]) => client.$executeRawUnsafe(sql, ...params),
  };
}

export interface OutboxStore {
  /**
   * Reserva hasta `limit` mensajes entregables por `leaseMs`. Un mensaje es
   * entregable si no esta publicado, ya vencio su espera y no hay otro anterior
   * del mismo agregado pendiente.
   */
  claim(limit: number, now: Date, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(id: string, at: Date): Promise<void>;
  markFailed(id: string, error: string, retryAt: Date): Promise<void>;
}

const SCHEMA = /^[a-z_][a-z0-9_]*$/;

function assertSchema(schema: string): string {
  if (!SCHEMA.test(schema)) {
    throw new Error(`Esquema invalido para el outbox: ${schema}`);
  }
  return schema;
}

/** Inserta eventos en `<schema>.outbox`. Llamar dentro de la transaccion del cambio. */
export async function appendToOutbox(executor: SqlExecutor, schema: string, events: readonly DomainEvent[]): Promise<void> {
  const table = `${assertSchema(schema)}.outbox`;
  for (const event of events) {
    await executor.execute(
      `INSERT INTO ${table} (id, event_type, aggregate_id, payload) VALUES ($1::uuid, $2, $3, $4::jsonb)`,
      randomUUID(),
      event.type,
      event.aggregateId,
      JSON.stringify(event.payload),
    );
  }
}

/**
 * Registra un evento entrante en `<schema>.inbox`. Devuelve false si ya estaba:
 * el consumidor debe ignorarlo. Llamar dentro de la transaccion que lo aplica.
 */
export async function recordInbox(executor: SqlExecutor, schema: string, eventId: string, eventType: string): Promise<boolean> {
  const inserted = await executor.execute(
    `INSERT INTO ${assertSchema(schema)}.inbox (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
    eventId,
    eventType,
  );
  return inserted === 1;
}

interface OutboxRow {
  id: string;
  seq: bigint | number | string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
}

export class PostgresOutboxStore implements OutboxStore {
  private readonly table: string;

  constructor(
    private readonly executor: SqlExecutor,
    schema: string,
  ) {
    this.table = `${assertSchema(schema)}.outbox`;
  }

  async claim(limit: number, now: Date, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.executor.query<OutboxRow>(
      `UPDATE ${this.table} AS o
          SET available_at = $2::timestamptz + make_interval(secs => $3::double precision / 1000)
        WHERE o.id IN (
          SELECT c.id FROM ${this.table} AS c
           WHERE c.published_at IS NULL
             AND c.available_at <= $2::timestamptz
             AND NOT EXISTS (
               SELECT 1 FROM ${this.table} AS p
                WHERE p.aggregate_id = c.aggregate_id AND p.published_at IS NULL AND p.seq < c.seq
             )
           ORDER BY c.seq
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING o.id::text AS id, o.seq, o.event_type, o.aggregate_id, o.payload, o.occurred_at, o.attempts`,
      limit,
      now,
      leaseMs,
    );
    return rows
      .map((row) => ({
        id: row.id,
        seq: Number(row.seq),
        eventType: row.event_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        occurredAt: row.occurred_at,
        attempts: row.attempts,
      }))
      .sort((left, right) => left.seq - right.seq);
  }

  async markPublished(id: string, at: Date): Promise<void> {
    await this.executor.execute(
      `UPDATE ${this.table} SET published_at = $2::timestamptz, last_error = NULL WHERE id = $1::uuid`,
      id,
      at,
    );
  }

  async markFailed(id: string, error: string, retryAt: Date): Promise<void> {
    await this.executor.execute(
      `UPDATE ${this.table} SET attempts = attempts + 1, last_error = $2, available_at = $3::timestamptz WHERE id = $1::uuid`,
      id,
      error.slice(0, 1000),
      retryAt,
    );
  }
}
