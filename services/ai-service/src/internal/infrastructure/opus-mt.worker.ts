// Hilo que ejecuta los modelos Opus-MT. La inferencia ocupa la CPU uno o dos
// segundos por texto: en el hilo principal frenaria las llamadas gRPC de la
// auditoria y del diseno de salas.
import { parentPort, workerData } from 'node:worker_threads';
import { env, pipeline } from '@huggingface/transformers';

interface WorkerConfig {
  cacheDir: string;
  /** Modelo por direccion, por ejemplo { 'es-en': 'Xenova/opus-mt-es-en' }. */
  models: Record<string, string>;
}

interface TranslateMessage {
  id: number;
  direction: string;
  texts: string[];
}

type Translate = (texts: string[]) => Promise<unknown>;

const config = workerData as WorkerConfig;
// Los modelos se descargan una vez a esta carpeta y despues se leen de ahi.
env.cacheDir = config.cacheDir;

const loaded = new Map<string, Promise<Translate>>();

function translatorFor(direction: string): Promise<Translate> {
  const cached = loaded.get(direction);
  if (cached) {
    return cached;
  }
  const model = config.models[direction];
  if (!model) {
    return Promise.reject(new Error(`No hay modelo para ${direction}`));
  }
  // q8: la variante cuantizada, unos 113 MB por direccion en lugar de ~450 MB.
  const created = pipeline('translation', model, { dtype: 'q8' }).then((translate) => (texts: string[]) => translate(texts));
  loaded.set(direction, created);
  // Si la carga falla (sin red en la primera descarga), el siguiente intento la repite.
  created.catch(() => loaded.delete(direction));
  return created;
}

/** El pipeline devuelve { translation_text } por texto, a veces envuelto en un arreglo. */
function textsOf(output: unknown): string[] {
  const items = Array.isArray(output) ? output.flat() : [output];
  return items.map((item) =>
    typeof item === 'object' && item !== null && 'translation_text' in item ? String((item as { translation_text: unknown }).translation_text) : '',
  );
}

parentPort?.on('message', (message: TranslateMessage) => {
  void translatorFor(message.direction)
    .then((translate) => translate(message.texts))
    .then((output) => {
      parentPort?.postMessage({ id: message.id, outputs: textsOf(output) });
    })
    .catch((error: unknown) => {
      parentPort?.postMessage({ id: message.id, error: error instanceof Error ? error.message : 'Fallo la traduccion' });
    });
});
