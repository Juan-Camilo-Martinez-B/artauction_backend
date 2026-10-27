/**
 * Ejecuta en serie, por orden de llegada, las tareas que comparten clave y en
 * paralelo las de claves distintas. Cada clave guarda solo la cola de su ultima
 * tarea; al terminar la ultima, la clave se elimina para no acumular memoria.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(work, work);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return current;
  }

  get pendingKeys(): number {
    return this.tails.size;
  }
}
