// Arte generativo del catalogo de demostracion: diez piezas propias, sin
// licencias de terceros. Cada una es determinista (misma semilla, misma imagen)
// y sale como PNG, sin dependencias, con zlib de Node.
import { deflateSync } from 'node:zlib';

const SIZE = 1400;

/** Generador pseudoaleatorio con semilla: asi la carga es repetible. */
function randomFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hsl(h, s, l) {
  const hue = ((h % 1) + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    const x = ((t % 1) + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255];
}

class Canvas {
  constructor(size, background = [12, 12, 18]) {
    this.size = size;
    this.data = new Float32Array(size * size * 3);
    for (let i = 0; i < this.data.length; i += 3) {
      this.data.set(background, i);
    }
  }
  set(x, y, [r, g, b]) {
    const i = (y * this.size + x) * 3;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
  }
  add(x, y, [r, g, b]) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.size || iy >= this.size) {
      return;
    }
    const i = (iy * this.size + ix) * 3;
    this.data[i] += r;
    this.data[i + 1] += g;
    this.data[i + 2] += b;
  }
  /** Pinta cada pixel con una funcion de su posicion en [0, 1). */
  shade(paint) {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        this.set(x, y, paint(x / this.size, y / this.size));
      }
    }
  }
  disc(cx, cy, radius, color) {
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(this.size - 1, cy + radius); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(this.size - 1, cx + radius); x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) {
          this.set(x, y, color);
        }
      }
    }
  }
  png() {
    const stride = this.size * 3 + 1;
    const raw = Buffer.alloc(stride * this.size);
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size * 3; x += 1) {
        raw[y * stride + 1 + x] = Math.max(0, Math.min(255, Math.round(this.data[y * this.size * 3 + x])));
      }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.size, 0);
    header.writeUInt32BE(this.size, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_value, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([length, body, sum]);
}

/** Tiempo de escape suavizado de una iteracion compleja; null si no escapa. */
function escape(zr, zi, cr, ci, limit) {
  let a = zr;
  let b = zi;
  for (let i = 0; i < limit; i += 1) {
    const aa = a * a;
    const bb = b * b;
    if (aa + bb > 256) {
      return i + 1 - Math.log2(Math.log2(aa + bb) / 2);
    }
    b = 2 * a * b + ci;
    a = aa - bb + cr;
  }
  return null;
}

const ART = {
  mandelbrot(canvas) {
    const [cx, cy, span] = [-0.7436, 0.1318, 0.03];
    canvas.shade((u, v) => {
      const t = escape(0, 0, cx + (u - 0.5) * span, cy + (v - 0.5) * span, 700);
      return t === null ? [6, 6, 16] : hsl(0.58 + t * 0.011, 0.75, 0.5 + 0.28 * Math.sin(t * 0.09));
    });
  },
  julia(canvas) {
    canvas.shade((u, v) => {
      const t = escape((u - 0.5) * 3.1, (v - 0.5) * 3.1, -0.8, 0.156, 400);
      return t === null ? [24, 6, 30] : hsl(0.86 + t * 0.012, 0.8, Math.min(0.72, 0.12 + t * 0.016));
    });
  },
  flow(canvas) {
    const random = randomFrom(7);
    const field = (x, y) => Math.sin(x * 0.0041) * 2.3 + Math.cos(y * 0.0053) * 2.1 + Math.sin((x + y) * 0.0021) * 1.4;
    for (let line = 0; line < 9000; line += 1) {
      let x = random() * canvas.size;
      let y = random() * canvas.size;
      const color = hsl(0.53 + random() * 0.12, 0.7, 0.55);
      for (let step = 0; step < 160; step += 1) {
        const angle = field(x, y);
        x += Math.cos(angle) * 1.1;
        y += Math.sin(angle) * 1.1;
        canvas.add(x, y, [color[0] * 0.13, color[1] * 0.13, color[2] * 0.13]);
      }
    }
  },
  truchet(canvas) {
    const random = randomFrom(11);
    const cells = 28;
    const cell = canvas.size / cells;
    const flips = Array.from({ length: cells * cells }, () => random() < 0.5);
    canvas.shade((u, v) => {
      const gx = u * cells;
      const gy = v * cells;
      const col = Math.floor(gx);
      const row = Math.floor(gy);
      let fx = gx - col;
      const fy = gy - row;
      if (flips[row * cells + col]) {
        fx = 1 - fx;
      }
      const ring = Math.min(Math.abs(Math.hypot(fx, fy) - 0.5), Math.abs(Math.hypot(1 - fx, 1 - fy) - 0.5));
      return ring < 0.13 ? hsl(0.08 + u * 0.1, 0.72, 0.56) : hsl(0.62, 0.42, 0.14 + v * 0.1);
    });
    return cell;
  },
  voronoi(canvas) {
    const random = randomFrom(23);
    const seeds = Array.from({ length: 170 }, () => [random(), random(), random()]);
    canvas.shade((u, v) => {
      let best = Infinity;
      let second = Infinity;
      let owner = seeds[0];
      for (const seed of seeds) {
        const d = (seed[0] - u) ** 2 + (seed[1] - v) ** 2;
        if (d < best) {
          second = best;
          best = d;
          owner = seed;
        } else if (d < second) {
          second = d;
        }
      }
      if (Math.sqrt(second) - Math.sqrt(best) < 0.0035) {
        return [14, 12, 16];
      }
      return hsl(0.95 + owner[0] * 0.28 + owner[1] * 0.1, 0.72, 0.36 + owner[2] * 0.26);
    });
  },
  moire(canvas) {
    canvas.shade((u, v) => {
      const a = Math.sin(Math.hypot(u - 0.42, v - 0.5) * 340);
      const b = Math.sin(Math.hypot(u - 0.58, v - 0.5) * 340);
      const value = (a > 0) === (b > 0) ? 0.86 : 0.1;
      return hsl(0.11, 0.3, value);
    });
  },
  phyllotaxis(canvas) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let n = 2600; n > 0; n -= 1) {
      const radius = Math.sqrt(n) * (canvas.size / 108);
      const angle = n * golden;
      canvas.disc(canvas.size / 2 + Math.cos(angle) * radius, canvas.size / 2 + Math.sin(angle) * radius, 3 + Math.sqrt(n) * 0.2, hsl(0.09 + (n % 34) * 0.006, 0.82, 0.3 + (n / 2600) * 0.34));
    }
  },
  attractor(canvas) {
    const [a, b, c, d] = [-1.7, 1.8, -1.9, -0.4];
    let [x, y] = [0.1, 0.1];
    for (let i = 0; i < 9_000_000; i += 1) {
      const nx = Math.sin(a * y) + c * Math.cos(a * x);
      const ny = Math.sin(b * x) + d * Math.cos(b * y);
      x = nx;
      y = ny;
      canvas.add((x + 3) * (canvas.size / 6), (y + 2.2) * (canvas.size / 4.6), [1.7, 0.95, 0.42]);
    }
    for (let i = 0; i < canvas.data.length; i += 1) {
      canvas.data[i] = 255 * (1 - Math.exp(-canvas.data[i] / 150));
    }
  },
  interference(canvas) {
    const sources = [[0.2, 0.25], [0.8, 0.3], [0.5, 0.82], [0.32, 0.6]];
    canvas.shade((u, v) => {
      const wave = sources.reduce((sum, [sx, sy]) => sum + Math.sin(Math.hypot(u - sx, v - sy) * 95), 0) / sources.length;
      return hsl(0.5 + wave * 0.16, 0.68, 0.42 + wave * 0.26);
    });
  },
  subdivision(canvas) {
    const random = randomFrom(41);
    const palette = [[220, 56, 44], [240, 196, 54], [38, 84, 160], [244, 240, 228], [244, 240, 228], [244, 240, 228], [24, 24, 28]];
    const split = (x, y, w, h, depth) => {
      if (depth === 0 || (depth < 4 && random() < 0.22)) {
        const color = palette[Math.floor(random() * palette.length)];
        for (let j = Math.floor(y) + 5; j < y + h - 5; j += 1) {
          for (let i = Math.floor(x) + 5; i < x + w - 5; i += 1) {
            canvas.set(i, j, color);
          }
        }
        return;
      }
      const cut = 0.3 + random() * 0.4;
      if (w > h) {
        split(x, y, w * cut, h, depth - 1);
        split(x + w * cut, y, w * (1 - cut), h, depth - 1);
      } else {
        split(x, y, w, h * cut, depth - 1);
        split(x, y + h * cut, w, h * (1 - cut), depth - 1);
      }
    };
    split(0, 0, canvas.size, canvas.size, 6);
  },
};

export function renderArt(name) {
  const draw = ART[name];
  if (!draw) {
    throw new Error(`no existe la pieza generativa ${name}`);
  }
  const canvas = new Canvas(SIZE);
  draw(canvas);
  return canvas.png();
}
