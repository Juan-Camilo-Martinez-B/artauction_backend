# ai-service

Fachada de modelos generativos de ArtAuction AI. Es el **único** servicio del sistema con la clave de Gemini (`GEMINI_API_KEY`): ningún otro servicio la conoce (mínimo privilegio). Expone `artauction.ai.v1.AiService` por gRPC (puerto `50055`) y no tiene base de datos.

| RPC | Quién la llama | Qué hace |
|---|---|---|
| `AuditArtwork` | audit-service | Evalúa el **expediente de evidencias** de una obra y devuelve score, precio sugerido y hallazgos |
| `DesignGallery` | gallery-service | Propone una configuración de galería 3D a partir de preferencias |

Solo acepta tokens de servicio emitidos por identity-service, y cada RPC comprueba el `client_id` de quien llama.

## La IA no ve imágenes

audit-service mide las imágenes (resolución, nitidez, metadatos, duplicados en el catálogo) y aplica reglas deterministas. A ai-service le llega solo ese **expediente**, un JSON compacto de unos 400 a 700 tokens, en lugar de imágenes que cuestan entre 258 y más de 1 000 tokens cada una. Detalle en el README de audit-service y en el ADR 0009.

## Cómo se acota el gasto

- **Salida estructurada:** `responseMimeType: application/json` con `responseJsonSchema`. El modelo no gasta tokens en prosa y la respuesta se valida contra el esquema.
- **Tope de salida:** `maxOutputTokens` de 600 para la auditoría y 2 048 para la galería, cuya configuración ocupa unos 1 800 caracteres en JSON compacto.
- **Razonamiento al mínimo:** los modelos 2.x usan `thinkingBudget: 0` y los 3.x en adelante `thinkingLevel: "minimal"`. Enviar ambos campos a la vez da error 400, así que el adaptador elige uno según el nombre del modelo (`GEMINI_MODEL`).
- **Temperatura 0** en la auditoría: el mismo expediente da la misma respuesta.

## Argumentos verificables y defensa contra inyección de prompt

- Las instrucciones van en `systemInstruction`; los textos del vendedor van como datos dentro de `declared`, con la orden explícita de no tratarlos como instrucciones.
- Cada hallazgo del modelo debe citar códigos de evidencia que existan en el expediente, como `img1.exif.software`. Los que no citan nada, o citan códigos inventados, se descartan (`sanitizeAssessment`).
- Un hallazgo **crítico de las reglas** marca la evaluación como crítica aunque el modelo diga lo contrario.
- Score, precios, códigos y longitud de los mensajes se acotan antes de responder.

## Respaldo local

La evaluación local determinista (`local-rules`) parte de 85 y descuenta 12 puntos por cada advertencia de las reglas; con una regla crítica da 28. `AuditArtwork` la usa:

- con `GEMINI_API_KEY` vacía;
- **en cuanto Gemini falla**: cuota agotada (429), caída (5xx), timeout, circuit breaker abierto o una respuesta que no se puede sanear. No se deja la obra esperando: se responde de inmediato y queda un `warn` en el log con el motivo.

La respuesta lleva `model = local-rules`. Con eso audit-service la registra como `decided_by = LOCAL` (no como IA), no la guarda en la caché y solo aprueba una obra sin advertencias; lo demás va a revisión manual, donde el administrador puede pedir **re-auditar con IA**.

`DesignGallery` no tiene respaldo aquí: responde `FAILED_PRECONDITION` o `UNAVAILABLE` y gallery-service usa su diseño local.

## Resiliencia

Cada llamada a Gemini tiene timeout (`GEMINI_TIMEOUT_MS`) y pasa por un circuit breaker (3 fallos seguidos lo abren 30 s). Solo un 5xx, un timeout o un corte de red se reintentan, **una vez**. Un 429 no se reintenta: la cuota agotada no se arregla repitiendo y el respaldo local responde enseguida. Un 400 tampoco. La clave viaja en la cabecera `x-goog-api-key`, nunca en la URL.

## Consumo de tokens

Tras cada respuesta correcta se registra una línea `info` con contexto `gemini-usage` y las cifras de `usageMetadata` (tokens de entrada, de salida y total). Solo van cifras: ni el expediente ni la respuesta llegan al log. Para ver el gasto en desarrollo:

```bash
grep gemini-usage ai.log
```

La cuota restante no la expone la API de Gemini; se consulta en Google AI Studio.

Gemini se llama por REST porque no ofrece gRPC público estable (ADR 0002).

## Estructura

```
src/
  api/grpc/            AiService: traduce mensajes y comprueba quién llama
  internal/
    domain/            expediente, saneo de la respuesta y evaluación local
    application/       AuditArtwork, DesignGallery, prompts y el puerto LanguageModel
    infrastructure/    GeminiModel (REST, reintentos, circuit breaker)
  ai.module.ts         raíz de composición
```

Cambiar de proveedor es escribir otra implementación de `LanguageModel`; los casos de uso no cambian.

## Ejecutar

```bash
cp .env.example .env     # GEMINI_API_KEY opcional
npm run build -w @artauction/ai-service
npm start -w @artauction/ai-service
```

## Pruebas

`npm test -w @artauction/ai-service`:

- descarte de citas inventadas y prevalencia de una regla crítica;
- evaluación local determinista y recorte del expediente;
- adaptador de Gemini con un `fetch` falso: clave en cabecera, esquema de salida, configuración de razonamiento por modelo, un solo reintento ante un 503 y ninguno ante un 429 o un 400, y lectura de `usageMetadata`;
- respaldo local cuando el modelo falla o responde algo que no se puede sanear.
