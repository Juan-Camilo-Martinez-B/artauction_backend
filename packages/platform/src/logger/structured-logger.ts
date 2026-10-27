import { currentContext } from '../context/request-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type Sink = (line: string) => void;

/**
 * Logger JSON de una linea por evento. Cada linea lleva el servicio y el
 * correlation id de la peticion en curso para seguir una operacion entre
 * servicios. Cumple la interfaz LoggerService de NestJS sin depender de ella.
 */
export class StructuredLogger {
  constructor(
    private readonly service: string,
    private readonly sink: Sink = (line) => process.stdout.write(`${line}\n`),
  ) {}

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  private write(level: LogLevel, message: unknown, context?: string, trace?: string): void {
    this.sink(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        service: this.service,
        correlationId: currentContext()?.correlationId ?? null,
        context: context ?? null,
        message: message instanceof Error ? message.message : message,
        trace: trace ?? null,
      }),
    );
  }
}
