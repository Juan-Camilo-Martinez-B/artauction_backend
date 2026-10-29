// Healthcheck de contenedor: llama a grpc.health.v1.Health/Check del propio
// servicio y sale con 0 solo si responde SERVING. No necesita proto: la
// peticion vacia es un buffer vacio y la respuesta SERVING es el campo 1 = 1.
const grpc = require('@grpc/grpc-js');

const port = process.env.GRPC_PORT;
const SERVING = Buffer.from([0x08, 0x01]);
const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());

client.makeUnaryRequest(
  '/grpc.health.v1.Health/Check',
  () => Buffer.alloc(0),
  (bytes) => bytes,
  {},
  { deadline: Date.now() + 3000 },
  (error, response) => {
    client.close();
    process.exit(!error && response && response.equals(SERVING) ? 0 : 1);
  },
);
