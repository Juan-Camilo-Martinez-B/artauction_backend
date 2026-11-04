# ai-service

Fachada de modelos generativos de ArtAuction AI. Es el **único** servicio del sistema con la clave del proveedor de IA, Groq (`GROQ_API_KEY`); ningún otro servicio la conoce (mínimo privilegio). Expone `artauction.ai.v1.AiService` por gRPC (puerto `50055`) y no tiene base de datos.

| RPC | Quién la llama | Qué hace |
|---|---|---|
| `AuditArtwork` | audit-service | Evalúa el **expediente de evidencias** de una obra y devuelve score, precio sugerido y hallazgos |
| `DesignGallery` | gallery-service | Propone una configuración de galería 3D a partir de preferencias |
| `TranslateLot` | catalog-service | Traduce título, descripción, materiales y procedencia de una ficha al otro idioma de la plataforma, con un modelo local |

Solo acepta tokens de servicio emitidos por identity-service, y cada RPC comprueba el `client_id` de quien llama.

## Proveedor: Groq

Groq se eligió por su plan gratuito: no entrena con los datos y se puede activar Zero Data Retention. También por su modo de **JSON estricto**. Gemini se retiró. Detalle en el ADR 0011.

- Se llama por la API compatible con OpenAI (`POST https://api.groq.com/openai/v1/chat/completions`), con `fetch` y sin dependencias. Groq no ofrece gRPC público (ADR 0002).
- Modelo por omisión: `openai/gpt-oss-120b` (`GROQ_MODEL`). Debe admitir el modo estricto, como los gpt-oss: la auditoría y el diseño de salas dependen de ese formato.
- La clave viaja en la cabecera `Authorization`, nunca en la URL.

## La IA no ve imágenes

audit-service mide las imágenes (resolución, nitidez, metadatos, duplicados en el catálogo) y aplica reglas deterministas. A ai-service le llega solo ese **expediente**, un JSON compacto de unos 400 a 700 tokens, en lugar de imágenes. Detalle en el README de audit-service y en el ADR 0009.

## Cómo se acota el gasto y se asegura el formato

- **JSON estricto:** `response_format` con `json_schema` y `strict: true`. Groq restringe la generación al esquema, así que la respuesta siempre lo cumple. `strictSchema` pasa cada esquema a la forma que exige ese modo:
  - cierra los objetos (`additionalProperties: false`);
  - declara todas las propiedades en `required`;
  - quita las palabras clave de rango que Groq no documenta (`minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`). Los rangos los sigue validando quien recibe la respuesta.
- **Tope de salida:** 600 tokens para la auditoría y 2 048 para la galería, más un margen fijo de 1 024 para el razonamiento de gpt-oss, que sale del mismo tope.
- **Razonamiento acotado:** `reasoning_effort: "low"` y `include_reasoning: false`. El modelo piensa poco y no devuelve ese texto.
- **Temperatura 0** en la auditoría: el mismo expediente da la misma respuesta.
- Una respuesta cortada por el tope (`finish_reason = length`) o vacía se trata como fallo.

## Argumentos verificables y defensa contra inyección de prompt

- Las instrucciones van en el mensaje `system`. Los textos del vendedor van como datos dentro de `declared`, con la orden explícita de no tratarlos como instrucciones.
- Cada hallazgo del modelo debe citar códigos de evidencia que existan en el expediente, como `img1.exif.software`. Los que no citan nada, o citan códigos inventados, se descartan (`sanitizeAssessment`).
- Un hallazgo **crítico de las reglas** marca la evaluación como crítica aunque el modelo diga lo contrario.
- Score, precios, códigos y longitud de los mensajes se acotan antes de responder.
- Un rango de precio que empieza en 0 no sirve para abrir una subasta. Las instrucciones piden al modelo un precio mayor que 0 y, si aun así no lo da, la evaluación conserva su score y sus hallazgos pero toma el rango de la evaluación local.

## Respaldo local

La evaluación local determinista (`local-rules`):

- parte de 85 y descuenta 12 puntos por cada advertencia de las reglas; con una regla crítica da 28;
- propone un precio mínimo de 400 artacoins menos 60 por advertencia (nunca menos de 50), y el doble como máximo (`localPriceBand`).

`AuditArtwork` la usa:

- con `GROQ_API_KEY` vacía;
- **en cuanto Groq falla**: cuota agotada (429), caída (5xx), timeout, circuit breaker abierto o una respuesta que no se puede sanear. No se deja la obra esperando: se responde de inmediato y queda un `warn` en el log con el motivo.

La respuesta lleva `model = local-rules`. Con eso audit-service la registra como `decided_by = LOCAL` (no como IA) y no la guarda en la caché. Solo aprueba una obra sin advertencias; lo demás va a revisión manual, donde el administrador puede pedir **re-auditar con IA**.

`DesignGallery` no tiene respaldo aquí: responde `FAILED_PRECONDITION` o `UNAVAILABLE` y gallery-service usa su diseño local. Un diseño generado por IA se marca con el origen neutro `"ai"`, que no depende del proveedor.

## Resiliencia

Cada llamada a Groq tiene timeout (`GROQ_TIMEOUT_MS`) y pasa por un circuit breaker: 3 fallos seguidos lo abren 30 s. Solo un 5xx, un timeout o un corte de red se reintentan, **una vez**. Un 429 no se reintenta: la cuota agotada no se arregla repitiendo y el respaldo local responde enseguida. Un 400 tampoco.

## Consumo de tokens

Tras cada respuesta correcta se registra una línea `info` con contexto `ai-usage` y las cifras del campo `usage` (tokens de entrada, de salida y total). Solo van cifras: ni el expediente ni la respuesta llegan al log. Para ver el gasto en desarrollo:

```bash
grep ai-usage ai.log
```

Los límites de la cuenta se consultan en la consola de Groq (*Settings › Limits*).

## Traducción de fichas

La plataforma está en español e inglés. `TranslateLot` traduce los textos de la ficha de una obra al otro idioma con **Opus-MT** (Helsinki-NLP, licencia Apache 2.0), un modelo que corre **dentro del servicio**: sin clave, sin cuota y sin que los textos salgan del servidor.

- **Motor:** Transformers.js (`@huggingface/transformers`) con los modelos `Xenova/opus-mt-es-en` y `Xenova/opus-mt-en-es` en su variante cuantizada (`q8`, unos 113 MB por dirección). Se descargan la primera vez a `TRANSLATION_CACHE_DIR` y se quedan en memoria.
- **Hilo aparte:** la inferencia ocupa la CPU uno o dos segundos por texto, así que corre en un *worker thread* (`opus-mt.worker`) y no frena las llamadas de la auditoría ni del diseño de salas. La primera traducción de cada dirección tarda unos 8 s porque carga el modelo; las siguientes, menos de 1 s.
- **Idioma de origen:** `tinyld` lo detecta en la descripción, el texto más largo. Cada campo de al menos 12 caracteres se detecta aparte: un campo que ya está en el idioma destino se copia, no se traduce. Así una ficha con el título en inglés y la descripción en español (como las del Met) queda bien.
- **Lo que no se traduce:** direcciones web, correos y texto entre comillas (`«…»`, `"…"`, `“…”`) viajan como marcadores (`ZXQ0`, `ZXQ1`…) y vuelven intactos. Opus-MT inventa contenido cuando una oración mezcla idiomas y desfigura nombres y dominios; los marcadores, en cambio, pasan sin cambios. Si el modelo pierde o repite un marcador, el campo conserva su texto original.
- **Textos largos:** se trocean por párrafos y oraciones hasta 400 caracteres, por debajo del límite del modelo, y se vuelven a unir.
- **Límites conocidos:** algún nombre propio sin comillas o término de arte puede salir mal (por ejemplo «pátina» como *plate*). Por eso la ficha traducida dice que es automática, deja ver el original y, si hay diferencias, vale el original.
- **Docker:** el runtime ONNX solo tiene binarios para glibc, así que la imagen de ai-service usa `node:24-bookworm-slim` (Debian) y no Alpine. Los modelos viven en el volumen `translation-models`.
- **CI:** `TRANSLATION_ENABLED=false`, para no descargar los modelos en cada corrida. Sin traductor, `TranslateLot` responde `FAILED_PRECONDITION` y las fichas se muestran en su idioma original.

## Estructura

```
src/
  api/grpc/            AiService: traduce mensajes y comprueba quién llama
  internal/
    domain/            expediente, saneo de la respuesta y evaluación local
    application/       AuditArtwork, DesignGallery, TranslateLot, prompts y los puertos LanguageModel, Translator y LanguageDetector
    infrastructure/    GroqModel (REST, esquema estricto, reintentos, circuit breaker), OpusMtTranslator y su hilo, TinyLdDetector
  ai.module.ts         raíz de composición
```

Cambiar de proveedor es escribir otra implementación de `LanguageModel`; los casos de uso no cambian.

## Ejecutar

```bash
cp .env.example .env     # GROQ_API_KEY opcional (console.groq.com)
npm run build -w @artauction/ai-service
npm start -w @artauction/ai-service
```

## Pruebas

`npm test -w @artauction/ai-service`:

- descarte de citas inventadas y prevalencia de una regla crítica;
- evaluación local determinista y recorte del expediente;
- adaptador de Groq con un `fetch` falso:
  - clave en cabecera;
  - esquema estricto y razonamiento acotado;
  - forma estricta del esquema sin tocar el original;
  - un solo reintento ante un 503, ninguno ante un 429 o un 400;
  - lectura de `usage`;
  - rechazo de respuestas vacías o cortadas;
- origen neutro `"ai"` del diseño de sala;
- respaldo local cuando el modelo falla o responde algo que no se puede sanear;
- traducción con un traductor y un detector falsos: trozos por párrafo y oración, marcadores que vuelven a su lugar (o el original si se pierden), campos que ya están en el idioma destino, fichas en inglés y en español, y el servicio sin traductor.
