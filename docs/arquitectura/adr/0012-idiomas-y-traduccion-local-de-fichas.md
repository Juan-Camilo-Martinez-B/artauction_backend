# ADR 0012: Idiomas de la plataforma y traducción local de fichas

Estado: aceptado.

## Contexto

La plataforma estaba escrita solo en español, tanto la interfaz como los errores de los servicios. Hacía falta ofrecerla también en inglés, cambiable desde la configuración. Las fichas de las obras llegan en el idioma de su autor, español o inglés, y quien las mira debe poder leerlas en el suyo.

Había tres problemas distintos: los textos de la interfaz, los errores del backend y el contenido que escriben las personas.

Para traducir fichas se compararon APIs y modelos abiertos:

- Las APIs de traducción cobran por uso o envían a un tercero el texto de los vendedores. Los paquetes que imitan a Google Translate dependen de un servicio no oficial.
- NLLB y Tower tienen licencia no comercial. mBART no declara licencia. MADLAD pesa demasiado para correr sin GPU.
- Opus-MT (Helsinki-NLP) tiene licencia Apache 2.0, ocupa unos 228 MB cuantizado para las dos direcciones y traduce en menos de un segundo por ficha en CPU una vez cargado.

## Decisión

**Interfaz.** next-intl en el frontend, sin prefijo en la URL. El idioma sale de la cookie `NEXT_LOCALE`; sin cookie, del navegador; si no se ofrece, español. Con sesión manda el idioma guardado en la cuenta (`identity.users.locale`). Las funciones puras de `lib` devuelven claves y datos, no frases: el texto lo pone el componente.

**Errores.** `DomainError` lleva un `code` opcional de un registro fijo (`ERROR_CODES` en `@artauction/platform`) y `params` de texto. Viajan en los trailers gRPC `x-error-code` y `x-error-params`, y el gateway responde siempre con un `code`: el propio o el genérico de la categoría. El `message` sigue en español para logs y como respaldo. Las 150 validaciones internas no necesitan código propio: solo lo llevan los errores que una persona llega a ver.

**Fichas.** Se guarda el original tal cual y aparte una traducción por idioma (`catalog.lot_translations`).

- `ai-service` traduce con Opus-MT en un worker thread, detrás del puerto `Translator`. Corre en local: el texto no sale de la plataforma.
- catalog reconcilia en vez de reaccionar a eventos: cada pocos segundos encola las fichas públicas cuya versión actual no tiene traducción. La versión se reconoce por una huella SHA-256 del texto, calculada igual en SQL y en TypeScript. Así un solo camino cubre las obras que se publican, las que se editan y las que ya existían.
- El gateway elige el idioma con `Accept-Language` y devuelve además `sourceLocale`, `translated` y `original`. Las rutas de edición y de administración devuelven siempre el original.
- La ficha avisa «Traducido automáticamente · Ver original». Lo que vale es el texto del autor.

**Controles de la traducción.** Opus-MT inventa contenido con cierta entrada, así que la salida se revisa antes de aceptarla. Si un control falla, el campo queda en su idioma original:

- URLs, correos y texto entre comillas viajan como marcadores (`ZXQ0`). Si el modelo pierde o repite uno, se descarta.
- Una traducción con un número ausente del original se descarta (agregó «120 x 36 cm» a «Oil on canvas»). Un romano cuenta como su número: «siglo XIX» puede ser «19th century».
- Una salida que triplica el texto se descarta (con ciertas palabras repite «oh, oh, oh…» hasta el tope).
- El idioma se detecta sin contar lo citado. Un campo que ya está en el idioma destino se copia.

## Consecuencias

- Agregar un idioma pide un diccionario, un par de modelos Opus-MT y su valor en las listas de idiomas. Una prueba exige que los diccionarios tengan las mismas claves y marcadores.
- `ai-service` pasa a una imagen Debian: `onnxruntime-node` no corre en Alpine. Los modelos se descargan la primera vez a un volumen.
- La calidad tiene límites: algunos términos de arte salen mal («patinado» como *skating*). Por eso el aviso y el enlace al original son parte del diseño, no un adorno.
- Una ficha puede quedar marcada como traducida con algún campo en su idioma original, si ese campo no pasó los controles.
- Lo que escribe el backend y no es una ficha sigue en su idioma: los hallazgos de auditoría del panel de administración, la descripción de venta de una subasta y el resumen de una sala ya generada. La descripción de venta no se muestra cuando la ficha viene traducida.
- En CI la traducción va apagada (`TRANSLATION_ENABLED=false`) para no descargar los modelos.
