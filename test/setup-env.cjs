// Corre antes de cualquier import de los tests. Fija las bases de prueba antes
// de que @prisma/client cargue .env: sin esto, los tests de integracion usarian
// la base de desarrollo de .env y dejarian datos en ella.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://artauction:artauction@127.0.0.1:54329/artauction?schema=public';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27018/artauction';
process.env.JWT_PUBLIC_KEY_PATH = '';
