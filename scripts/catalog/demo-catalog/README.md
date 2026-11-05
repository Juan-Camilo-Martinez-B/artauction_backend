# Catálogo de demostración

Datos de las 100 obras que carga `npm run catalog:demo`. Cada ficha se redactó una a una y se contrastó con la imagen real de la obra. Alrededor del 70 % está en español y el 30 % en inglés, para que la demostración muestre la traducción de fichas en los dos sentidos.

| Archivo | Obras | Origen | Licencia |
|---|---|---|---|
| `flat.json` | 32 pinturas, 14 fotografías, 12 estampas | [Art Institute of Chicago](https://www.artic.edu/open-access/open-access-images) | Dominio público, imágenes CC0 |
| `models.json` | 12 esculturas, 8 cerámicas, 12 objetos artísticos, todos con modelo 3D | [Poly Haven](https://polyhaven.com) | CC0 |
| `digital.json` | 10 piezas de arte digital | `generate-art.mjs`, código propio | Del proyecto |

## Qué es cada obra

- Las obras de museo son **reproducciones**. La ficha lo dice en la procedencia, con el título original, el autor, la fecha y el enlace a la obra en el museo. La plataforma usa monedas simuladas: nada de esto vende un original.
- Las piezas 3D llevan su modelo real y el crédito de quien lo hizo.
- Las piezas digitales se generan al cargar, siempre iguales porque usan semillas fijas. Su ficha dice que están hechas con código y que no hay original físico.
- Las imágenes se copian al bucket propio por el flujo normal de subida: la plataforma no depende de los servidores del museo.

## Vendedores

Cinco cuentas de demostración, con correo `<clave>@<DEMO_EMAIL_DOMAIN>`. Los nombres son inventados.

| Clave | Nombre | Qué vende |
|---|---|---|
| `aurora` | Aurora Galería de Arte | Pintura europea, cerámica |
| `bellamy` | Bellamy Fine Art | Pintura en inglés, bronces, objetos de latón |
| `norte` | Norte Estudio y Colección | Estampa japonesa, pintura, objetos |
| `lumen` | Lumen Fotografía Histórica | Fotografía del siglo XIX y principios del XX |
| `vertice` | Vértice Arte Digital | Arte generativo, objetos de diseño |

## Cómo cargarlo

Con la plataforma levantada, reinicia dos servicios con estas variables y lanza el script:

```bash
# ai-service: sin modelo, para no gastar la cuota de Groq.
GROQ_API_KEY= npm start -w @artauction/ai-service

# audit-service: la evaluación local no aprueba sola, y el administrador fija cada precio.
AUDIT_LOCAL_AUTO_APPROVE=false npm start -w @artauction/audit-service

npm run catalog:demo
```

Contra un gateway que no sea local, `DEMO_ADMIN_PASSWORD` y `DEMO_SELLER_PASSWORD` son obligatorias: las contraseñas de desarrollo solo valen en local. Las demás variables están al inicio de `publish-demo-catalog.mjs`.

Es idempotente: si se corta, se repite el comando y cada obra sigue donde quedó. La identidad de una obra es su título dentro de su vendedor, así que cambiar un título aquí crea una obra nueva.

## Traducciones

Opus-MT, el traductor local, confunde justo lo que abunda aquí: nombres propios y términos de arte («red de arenque» salía como «waste network»). Por eso estas fichas llevan traducciones redactadas en `translations.json`, también por una IA pero una a una y contrastadas con la obra. Cuando la cola de traducción termine con las obras, aplícalas:

```bash
npm run --silent catalog:demo:translations > traducciones.sql
psql "$DATABASE_URL" -f traducciones.sql
```

Se guardan con la huella del texto publicado. Si alguien edita su ficha, la huella deja de coincidir y Opus-MT la retoma; las obras que se publiquen durante la demostración usan también Opus-MT.

## Después de cargar

1. Pasa las salas a la rotación, para que la cartelera tenga siempre salas abiertas:

   ```bash
   psql "$DATABASE_URL" -f scripts/catalog/demo-catalog/rotation.sql
   ```

2. Reinicia ai-service y audit-service con su configuración normal.

## Cómo añadir una obra

- **De museo:** el Art Institute of Chicago pide identificarse con la cabecera `AIC-User-Agent`; sin ella, sus imágenes responden 403. Comprueba `is_public_domain` en su API antes de usarla.
- **3D:** el modelo debe ser GLB de 1.000 a 300.000 triángulos y hasta 30 MB. Con el glTF de 1k de Poly Haven suele bastar.
- **Ficha:** mira la imagen antes de escribir. Los materiales deciden el marco en la galería 3D (`src/lib/gallery/frames.ts` en el frontend).
