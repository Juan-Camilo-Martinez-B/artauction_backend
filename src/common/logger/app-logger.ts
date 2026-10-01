import { Injectable, type LoggerService } from '@nestjs/common';

@Injectable()
export class AppLogger implements LoggerService {
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

  private write(level: string, message: unknown, context?: string, trace?: string): void {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message: typeof message === 'string' ? message : message,
      context: context ?? null,
      trace: trace ?? null,
    });
    process.stdout.write(`${line}\n`);
  }
}
