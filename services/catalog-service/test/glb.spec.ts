import { DomainError } from '@artauction/platform';
import { inspectGlb, MODEL_LIMITS } from '../src/internal/domain/glb';

/** GLB minimo: cabecera, bloque JSON y un bloque binario de relleno. */
function glb(json: Record<string, unknown>, options: { version?: number; magic?: number } = {}): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const binLength = 16;
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, options.magic ?? 0x46546c67, true);
  view.setUint32(4, options.version ?? 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(text, 20);
  view.setUint32(20 + jsonLength, binLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  return bytes;
}

/** Escena con una malla de `triangles` caras indexadas, dentro de una caja dada. */
function scene(triangles: number, box: { min: number[]; max: number[] }, node: Record<string, unknown> = { mesh: 0 }, extra: Record<string, unknown> = {}) {
  return {
    asset: { version: '2.0', generator: 'Blender' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [node],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { count: triangles, type: 'VEC3', componentType: 5126, min: box.min, max: box.max },
      { count: triangles * 3, type: 'SCALAR', componentType: 5125 },
    ],
    buffers: [{ byteLength: 16 }],
    ...extra,
  };
}

function expectInvalid(run: () => unknown, fragment: string): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).kind).toBe('INVALID_ARGUMENT');
  expect((caught as DomainError).message).toContain(fragment);
}

const STATUE = { min: [-0.2, 0, -0.15], max: [0.2, 1.8, 0.15] };

describe('lectura de un modelo GLB', () => {
  it('mide triangulos, vertices y la caja de una estatua exportada de Blender', () => {
    expect(inspectGlb(glb(scene(12_000, STATUE)))).toEqual({ triangles: 12_000, vertices: 12_000, size: { x: 0.4, y: 1.8, z: expect.closeTo(0.3) as number } });
  });

  it('lleva la caja al mundo con la escala y la rotacion del nodo', () => {
    // Escala 2 y giro de 90 grados sobre X: la altura pasa al eje Z.
    const half = Math.SQRT1_2;
    const report = inspectGlb(glb(scene(5_000, STATUE, { mesh: 0, scale: [2, 2, 2], rotation: [half, 0, 0, half] })));
    expect(report.size.x).toBeCloseTo(0.8);
    expect(report.size.y).toBeCloseTo(0.6);
    expect(report.size.z).toBeCloseTo(3.6);
  });

  it('una malla usada por varios nodos cuenta cada vez', () => {
    const twice = scene(3_000, STATUE, { children: [1, 2] }, {
      scenes: [{ nodes: [0] }],
      nodes: [{ children: [1, 2] }, { mesh: 0 }, { mesh: 0, translation: [1, 0, 0] }],
    });
    const report = inspectGlb(glb(twice));
    expect(report.triangles).toBe(6_000);
    expect(report.size.x).toBeCloseTo(1.4);
  });

  it('respeta los limites de triangulos', () => {
    expectInvalid(() => inspectGlb(glb(scene(MODEL_LIMITS.minTriangles - 1, STATUE))), 'el minimo es 1000');
    expectInvalid(() => inspectGlb(glb(scene(MODEL_LIMITS.maxTriangles + 1, STATUE))), 'Decimate');
  });

  it('rechaza lo que no es un GLB 2.0 completo', () => {
    expectInvalid(() => inspectGlb(new Uint8Array(10)), 'demasiado corto');
    expectInvalid(() => inspectGlb(glb(scene(2_000, STATUE), { magic: 0x12345678 })), 'no es un archivo GLB');
    expectInvalid(() => inspectGlb(glb(scene(2_000, STATUE), { version: 1 })), 'glTF 2.0');
    const truncated = glb(scene(2_000, STATUE)).subarray(0, 60);
    expectInvalid(() => inspectGlb(truncated), 'incompleto');
  });

  it('rechaza recursos externos y extensiones que la sala no abre', () => {
    expectInvalid(() => inspectGlb(glb(scene(2_000, STATUE, { mesh: 0 }, { buffers: [{ byteLength: 16, uri: 'https://example.com/data.bin' }] }))), 'archivos externos');
    expectInvalid(() => inspectGlb(glb(scene(2_000, STATUE, { mesh: 0 }, { images: [{ uri: 'textura.png' }] }))), 'texturas estan fuera');
    expectInvalid(() => inspectGlb(glb(scene(2_000, STATUE, { mesh: 0 }, { extensionsRequired: ['VENDOR_secreto'] }))), 'VENDOR_secreto');
    expect(inspectGlb(glb(scene(2_000, STATUE, { mesh: 0 }, { extensionsRequired: ['KHR_draco_mesh_compression'] }))).triangles).toBe(2_000);
  });

  it('un ciclo entre nodos no cuelga el servicio', () => {
    const loop = scene(2_000, STATUE, { mesh: 0, children: [0] });
    expectInvalid(() => inspectGlb(glb(loop)), 'ciclos');
  });

  it('exige posiciones declaradas como pide glTF', () => {
    const broken = scene(2_000, STATUE);
    broken.accessors = [{ count: 2_000, type: 'VEC3', componentType: 5126 }, { count: 6_000, type: 'SCALAR', componentType: 5125 }] as never;
    expectInvalid(() => inspectGlb(glb(broken)), 'posiciones');
  });
});
