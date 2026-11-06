// Carga las obras propias de las cuentas de demostracion (demo-catalog/personal.json).
// Son proyectos publicos: no pasan por auditoria ni se subastan, asi que nunca se
// venden y la sala de cada cuenta conserva siempre algo que mostrar.
//
//   npm run catalog:demo:personal
//
// Es idempotente: la identidad de una obra es su titulo dentro de su vendedor.
// Usa las mismas variables DEMO_* que publish-demo-catalog.mjs.
import { DIGITAL_KIND, FLAT_KIND, attachImage } from './demo-catalog/lot-files.mjs';
import { SELLER_PASSWORD, api, login, personalEntries, requirePasswords, sellerEmail } from './demo-catalog/shared.mjs';

const KINDS = { flat: FLAT_KIND, digital: DIGITAL_KIND };

requirePasswords();

const works = personalEntries();
let failed = 0;
for (const key of new Set(works.map((work) => work.seller))) {
  const token = await login(sellerEmail(key), SELLER_PASSWORD);
  const mine = await api('GET', '/lots/mine', { token });
  for (const work of works.filter((candidate) => candidate.seller === key)) {
    try {
      const kind = KINDS[work.kind];
      const existing = mine.find((item) => item.title === work.title);
      // Una obra del catalogo con el mismo titulo no es esta: se vende y no contaria como propia.
      if (existing && existing.status !== 'PERSONAL') {
        throw new Error(`el titulo ya lo usa una obra del catalogo (${String(existing.status)})`);
      }
      const lot =
        existing ??
        (await api('POST', '/lots', {
          token,
          body: { title: work.title, description: work.description, materials: work.materials, destination: 'PERSONAL', visibility: 'PUBLIC', ...kind.fields(work) },
        }));
      if (lot.images?.length) {
        console.log(`${key} / ${work.title}: ya estaba`);
        continue;
      }
      const { image, contentType } = await kind.files(work);
      await attachImage(token, lot.id, image, contentType);
      console.log(`${key} / ${work.title}: cargada`);
    } catch (error) {
      failed += 1;
      console.error(`${key} / ${work.title}: ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
if (failed > 0) {
  console.error(`Fallaron ${String(failed)} obras; repite el comando para retomarlas.`);
  process.exit(1);
}
