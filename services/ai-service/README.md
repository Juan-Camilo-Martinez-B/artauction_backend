# ai-service

Fachada de modelos generativos de ArtAuction AI. Es el **único** servicio del sistema con la clave de Gemini (`GEMINI_API_KEY`): ningún otro servicio ni el monolito la conocen (mínimo privilegio). Expone `artauction.ai.v1.AiService` por gRPC (puerto `50055`) y no tiene base de datos.

| RPC | Quién la llama | Qué hace |
|---|---|---|
| `AuditArtwork` | audit-service | Evalúa el **expediente de evidencias** de una obra y devuelve score, precio sugerido y hallazgos |
| `DesignGallery` | la galería (hoy el monolito, como `gallery-service`) | Propone una configuración de galería 3D a partir de preferencias |

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

## Sin clave

Con `GEMINI_API_KEY` vacía:

- `AuditArtwork` usa la evaluación local determinista (`local-rules`): parte de 85 y descuenta por cada hallazgo de las reglas.
- `DesignGallery` responde `FAILED_PRECONDITION` y la galería usa su diseño local.

## Resiliencia

Cada llamada a Gemini tiene timeout (`GEMINI_TIMEOUT_MS`). Se reintenta solo ante 429, 5xx o un corte de red, con backoff exponencial y jitter, y pasa por un circuit breaker (3 fallos seguidos lo abren 30 s). Un fallo sale como `UNAVAILABLE` para que audit-service reintente más tarde. La clave viaja en la cabecera `x-goog-api-key`, nunca en la URL.

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
- adaptador de Gemini con un `fetch` falso: clave en cabecera, esquema de salida, configuración de razonamiento por modelo, reintento de un 503 y ningún reintento ante un 400.
