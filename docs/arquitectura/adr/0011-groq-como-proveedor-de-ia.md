# ADR 0011: Groq como proveedor de IA

Estado: aceptado. Reemplaza a Gemini como proveedor del ADR 0002; el principio de ese ADR (REST hacia el proveedor, encapsulado en `ai-service`) sigue vigente.

## Contexto

La auditoría y el asistente de salas usaban el plan gratuito de Gemini. En la práctica:

- La cuota gratuita se agotaba o la API tardaba demasiado. Al publicar varias obras seguidas se abría el circuit breaker y la auditoría caía en la evaluación local. Esa evaluación asigna el mismo rango de precio genérico (400-800) a cualquier obra sin advertencias.
- Los términos del plan gratuito de Gemini permiten usar el contenido para mejorar los productos de Google y que lo lean revisores humanos. Eso choca con la regla del proyecto de proteger los datos: textos del vendedor, procedencia y precios.

Se compararon los planes gratuitos de Groq, Cerebras, OpenRouter, Mistral y GitHub Models. La API de Claude se descartó por ser de pago por uso: una suscripción personal no sirve para un backend que atiende a varios usuarios.

## Decisión

- `ai-service` usa Groq por su API compatible con OpenAI (`POST /openai/v1/chat/completions`), con `fetch` y sin dependencias nuevas. Groq no ofrece gRPC público.
- Modelo por omisión: `openai/gpt-oss-120b`. En Groq solo los modelos gpt-oss y unos pocos más garantizan la salida JSON con esquema en modo estricto (constrained decoding). La auditoría y el diseño de salas dependen de ese formato.
- El adaptador pasa cada esquema a la forma estricta: objetos cerrados (`additionalProperties: false`) y todas las propiedades en `required`. Además quita las palabras clave de rango que el modo estricto no documenta (`minimum`, `maxLength`, `maxItems`…). Los rangos los sigue validando quien recibe la respuesta: `sanitizeAssessment` en la auditoría y `validateGalleryConfig` en la galería.
- El razonamiento de gpt-oss va en esfuerzo bajo y no se devuelve. Como sale del mismo tope de tokens, se suma un margen fijo a la salida pedida. Una respuesta cortada por el tope se trata como fallo.
- Se retira el código de Gemini. El origen de un diseño de sala generado por IA pasa a ser el valor neutro `"ai"` (migración 0035 de `artauction_bd`), para que los datos no dependan del proveedor.
- Se recomienda activar Zero Data Retention en *Data Controls* de la consola de Groq.

## Consecuencias

- El resto del sistema no cambia: el proveedor está detrás del puerto `LanguageModel`.
- Se conservan el timeout, el reintento único ante 5xx, el circuit breaker, la ausencia de reintento ante 429 y la evaluación local de respaldo.
- La cuota del plan gratuito de Groq la fija la consola de cada cuenta (límites por minuto y por día según el modelo). La auditoría consume poco: unos 1 500 tokens de entrada y hasta 600 de salida por obra, y la misma obra sin cambios reutiliza su evaluación durante 30 días.
- Cambiar de proveedor otra vez es escribir otra implementación de `LanguageModel`.
