# ADR 0009: auditoría por expediente de evidencias

Estado: aceptado.

## Contexto

En el monolito la auditoría enviaba a Gemini el texto de la obra y los hashes perceptuales de sus imágenes: el modelo no veía la obra y los hashes no le dicen nada. Mandar las imágenes daría a la IA algo que mirar, pero cada una cuesta de 258 a más de 1 000 tokens y deja la decisión en una caja negra. Además, la descripción la escribe el vendedor, que podría intentar convencer al modelo de aprobar una falsificación (inyección de prompt).

## Decisión

- **audit-service mide la obra** y arma un expediente de evidencias:
  - lo declarado por el vendedor;
  - métricas de cada imagen con `sharp`, como resolución, nitidez, entropía, saturación y proporción;
  - metadatos con `exifr`: cámara, software y marcas de generadores de IA;
  - duplicados en el catálogo por distancia de Hamming del dHash, con una RPC nueva de catalog, `FindSimilarImages`.
- **Reglas deterministas** sobre el expediente producen hallazgos con severidad y la evidencia que los sostiene.
- **Cortocircuito:** si una regla crítica ya decide, no se llama a la IA.
- **Caché** de la evaluación por huella SHA-256 del expediente.
- **ai-service es una fachada delgada:** recibe el expediente compacto y devuelve score, precios y hallazgos. Es el único servicio con la clave de Gemini.
  - Pide salida JSON con esquema, tope de tokens y razonamiento al mínimo.
  - Exige que cada hallazgo cite códigos de evidencia existentes y descarta los demás.
  - Las reglas críticas siempre prevalecen sobre el modelo.
- **La cola de auditorías es una tabla propia** (`audit.audit_requests`), encolada en la misma transacción que el inbox, en lugar de pg-boss.
- Tras 5 fallos de la IA, la obra va a revisión manual con un veredicto de respaldo.

## Alternativas descartadas

- **Enviar las imágenes a un modelo multimodal:** más tokens por obra y una decisión menos explicable; un modelo puede ser engañado por la propia imagen o el texto.
- **Solo reglas, sin IA:** las reglas no valoran el conjunto ni sugieren precio. El modelo aporta criterio sobre las evidencias, sin poder anular lo que las reglas prueban.
- **pg-boss como cola:** el encolado quedaba fuera de la transacción del inbox. Un corte entre ambos perdía la auditoría o la duplicaba.

## Consecuencias

- El costo por obra está acotado: unos 400 a 700 tokens de entrada y como máximo 600 de salida. Los casos claros cuestan cero.
- Cada decisión se puede explicar. El informe en `artauction_audit.audit_reports` guarda el expediente completo y los hallazgos citan sus evidencias.
- La calidad depende de lo que el sistema sabe medir; agregar una señal nueva es agregar una evidencia y, si hace falta, una regla.
- La búsqueda de duplicados recorre todas las imágenes con hash. A la escala actual es barata; con millones haría falta un índice (BK-tree o un tipo bit con operador de vecindad).
