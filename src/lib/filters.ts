/**
 * OpenCanvas filter engine.
 *
 * Every filter is a pure ImageData -> ImageData transform with a small,
 * serializable parameter schema. The PS UI builds its controls from that
 * schema, so adding a filter here automatically adds it to the gallery.
 */

export type FilterValue = number | string | boolean;

export type FilterParam = {
  key: string;
  label: string;
  kind?: "range" | "select" | "check" | "color";
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  default: FilterValue;
};

export type FilterDefinition = {
  id: string;
  name: string;
  category: string;
  params: FilterParam[];
  apply: (source: ImageData, params: Record<string, FilterValue>) => ImageData;
};

export const FILTER_CATEGORIES = [
  "Blur",
  "Sharpen",
  "Noise",
  "Distort",
  "Pixelate",
  "Stylize",
  "Artistic",
  "Brush Strokes",
  "Sketch",
  "Texture",
  "Render",
  "Other",
  "Color",
] as const;

type RGB = { r: number; g: number; b: number };
type HSL = { h: number; s: number; l: number };

const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const clampByte = (value: number) => clamp(Math.round(value), 0, 255);
const n = (params: Record<string, FilterValue>, key: string, fallback: number) => {
  const value = Number(params[key]);
  return Number.isFinite(value) ? value : fallback;
};
const s = (params: Record<string, FilterValue>, key: string, fallback: string) => {
  const value = params[key];
  return typeof value === "string" ? value : fallback;
};
const b = (params: Record<string, FilterValue>, key: string, fallback: boolean) => {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
};

function clone(source: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
}

function pixel(source: ImageData, x: number, y: number): RGB {
  const px = clamp(Math.round(x), 0, source.width - 1);
  const py = clamp(Math.round(y), 0, source.height - 1);
  const i = (py * source.width + px) * 4;
  return { r: source.data[i], g: source.data[i + 1], b: source.data[i + 2] };
}

function alphaAt(source: ImageData, x: number, y: number): number {
  const px = clamp(Math.round(x), 0, source.width - 1);
  const py = clamp(Math.round(y), 0, source.height - 1);
  return source.data[(py * source.width + px) * 4 + 3];
}

function setPixel(target: ImageData, x: number, y: number, color: RGB, alpha = 255) {
  const i = (y * target.width + x) * 4;
  target.data[i] = clampByte(color.r);
  target.data[i + 1] = clampByte(color.g);
  target.data[i + 2] = clampByte(color.b);
  target.data[i + 3] = clampByte(alpha);
}

function luma(color: RGB) {
  return color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function rgbToHsl(color: RGB): HSL {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let sat = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s: sat, l };
}

function hslToRgb(hsl: HSL): RGB {
  const hue = ((hsl.h % 1) + 1) % 1;
  const { s: sat, l } = hsl;
  if (sat === 0) {
    const value = clampByte(l * 255);
    return { r: value, g: value, b: value };
  }
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return {
    r: channel(hue + 1 / 3) * 255,
    g: channel(hue) * 255,
    b: channel(hue - 1 / 3) * 255,
  };
}

function mapPixels(source: ImageData, fn: (color: RGB, x: number, y: number, alpha: number) => RGB): ImageData {
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const i = (y * source.width + x) * 4;
      const color = { r: source.data[i], g: source.data[i + 1], b: source.data[i + 2] };
      const next = fn(color, x, y, source.data[i + 3]);
      target.data[i] = clampByte(next.r);
      target.data[i + 1] = clampByte(next.g);
      target.data[i + 2] = clampByte(next.b);
    }
  }
  return target;
}

function mapRgb(source: ImageData, fn: (color: RGB) => RGB): ImageData {
  return mapPixels(source, (color) => fn(color));
}

function convolve(source: ImageData, kernel: number[], divisor?: number, offset = 0): ImageData {
  const size = Math.round(Math.sqrt(kernel.length));
  const half = Math.floor(size / 2);
  const div = divisor || kernel.reduce((sum, value) => sum + value, 0) || 1;
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let ky = 0; ky < size; ky += 1) {
        for (let kx = 0; kx < size; kx += 1) {
          const sample = pixel(source, x + kx - half, y + ky - half);
          const weight = kernel[ky * size + kx];
          r += sample.r * weight;
          g += sample.g * weight;
          b += sample.b * weight;
        }
      }
      const i = (y * source.width + x) * 4;
      target.data[i] = clampByte(r / div + offset);
      target.data[i + 1] = clampByte(g / div + offset);
      target.data[i + 2] = clampByte(b / div + offset);
    }
  }
  return target;
}

function gaussianKernel(radius: number): number[] {
  const sigma = Math.max(0.1, radius / 2.5);
  const size = Math.max(3, Math.ceil(radius * 2) * 2 + 1);
  const half = Math.floor(size / 2);
  const kernel: number[] = [];
  let sum = 0;
  for (let i = 0; i < size; i += 1) {
    const x = i - half;
    const value = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel.push(value);
    sum += value;
  }
  return kernel.map((value) => value / sum);
}

function gaussianBlur(source: ImageData, radius: number): ImageData {
  if (radius <= 0.01) return clone(source);
  const kernel = gaussianKernel(radius);
  const half = Math.floor(kernel.length / 2);
  const horizontal = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < kernel.length; k += 1) {
        const sampleX = clamp(x + k - half, 0, source.width - 1);
        const i = (y * source.width + sampleX) * 4;
        const weight = kernel[k];
        r += source.data[i] * weight;
        g += source.data[i + 1] * weight;
        b += source.data[i + 2] * weight;
        a += source.data[i + 3] * weight;
      }
      const i = (y * source.width + x) * 4;
      horizontal.data[i] = clampByte(r);
      horizontal.data[i + 1] = clampByte(g);
      horizontal.data[i + 2] = clampByte(b);
      horizontal.data[i + 3] = clampByte(a);
    }
  }
  const target = clone(horizontal);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < kernel.length; k += 1) {
        const sampleY = clamp(y + k - half, 0, source.height - 1);
        const i = (sampleY * source.width + x) * 4;
        const weight = kernel[k];
        r += horizontal.data[i] * weight;
        g += horizontal.data[i + 1] * weight;
        b += horizontal.data[i + 2] * weight;
        a += horizontal.data[i + 3] * weight;
      }
      const i = (y * source.width + x) * 4;
      target.data[i] = clampByte(r);
      target.data[i + 1] = clampByte(g);
      target.data[i + 2] = clampByte(b);
      target.data[i + 3] = clampByte(a);
    }
  }
  return target;
}

function boxBlur(source: ImageData, radius: number): ImageData {
  const r = Math.max(1, Math.round(radius));
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let yy = -r; yy <= r; yy += 1) {
        for (let xx = -r; xx <= r; xx += 1) {
          const sample = pixel(source, x + xx, y + yy);
          red += sample.r;
          green += sample.g;
          blue += sample.b;
          count += 1;
        }
      }
      setPixel(target, x, y, { r: red / count, g: green / count, b: blue / count }, alphaAt(source, x, y));
    }
  }
  return target;
}

function motionBlur(source: ImageData, angle: number, distance: number): ImageData {
  const radians = (angle * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const steps = Math.max(2, Math.round(distance));
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let step = 0; step < steps; step += 1) {
        const offset = (step / Math.max(1, steps - 1) - 0.5) * distance;
        const sample = pixel(source, x + dx * offset, y + dy * offset);
        r += sample.r;
        g += sample.g;
        b += sample.b;
      }
      setPixel(target, x, y, { r: r / steps, g: g / steps, b: b / steps }, alphaAt(source, x, y));
    }
  }
  return target;
}

function radialBlur(source: ImageData, amount: number, mode: string, quality: string): ImageData {
  const samples = quality === "best" ? 24 : quality === "draft" ? 6 : 12;
  const cx = source.width / 2;
  const cy = source.height / 2;
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const distance = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sample = 0; sample < samples; sample += 1) {
        const t = (sample / samples - 0.5) * (amount / 100);
        let sx = x;
        let sy = y;
        if (mode === "zoom") {
          sx = cx + dx * (1 + t);
          sy = cy + dy * (1 + t);
        } else {
          const nextAngle = angle + t * 0.8;
          sx = cx + Math.cos(nextAngle) * distance;
          sy = cy + Math.sin(nextAngle) * distance;
        }
        const sampleColor = pixel(source, sx, sy);
        r += sampleColor.r;
        g += sampleColor.g;
        b += sampleColor.b;
      }
      setPixel(target, x, y, { r: r / samples, g: g / samples, b: b / samples }, alphaAt(source, x, y));
    }
  }
  return target;
}

function surfaceBlur(source: ImageData, radius: number, threshold: number): ImageData {
  const r = Math.max(1, Math.round(radius));
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const center = pixel(source, x, y);
      let red = 0;
      let green = 0;
      let blue = 0;
      let weightSum = 0;
      for (let yy = -r; yy <= r; yy += 1) {
        for (let xx = -r; xx <= r; xx += 1) {
          const sample = pixel(source, x + xx, y + yy);
          const diff = Math.abs(sample.r - center.r) + Math.abs(sample.g - center.g) + Math.abs(sample.b - center.b);
          if (diff > threshold * 3) continue;
          const weight = 1 - diff / (threshold * 3 + 1);
          red += sample.r * weight;
          green += sample.g * weight;
          blue += sample.b * weight;
          weightSum += weight;
        }
      }
      if (weightSum > 0) setPixel(target, x, y, { r: red / weightSum, g: green / weightSum, b: blue / weightSum }, alphaAt(source, x, y));
    }
  }
  return target;
}

function unsharpMask(source: ImageData, amount: number, radius: number, threshold: number): ImageData {
  const blurred = gaussianBlur(source, radius);
  const target = clone(source);
  for (let i = 0; i < source.data.length; i += 4) {
    const diffR = source.data[i] - blurred.data[i];
    const diffG = source.data[i + 1] - blurred.data[i + 1];
    const diffB = source.data[i + 2] - blurred.data[i + 2];
    const diff = Math.abs(diffR) + Math.abs(diffG) + Math.abs(diffB);
    if (diff < threshold * 3) continue;
    target.data[i] = clampByte(source.data[i] + diffR * (amount / 100));
    target.data[i + 1] = clampByte(source.data[i + 1] + diffG * (amount / 100));
    target.data[i + 2] = clampByte(source.data[i + 2] + diffB * (amount / 100));
  }
  return target;
}

function medianFilter(source: ImageData, radius: number): ImageData {
  const r = Math.max(1, Math.round(radius));
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const reds: number[] = [];
      const greens: number[] = [];
      const blues: number[] = [];
      for (let yy = -r; yy <= r; yy += 1) {
        for (let xx = -r; xx <= r; xx += 1) {
          const sample = pixel(source, x + xx, y + yy);
          reds.push(sample.r);
          greens.push(sample.g);
          blues.push(sample.b);
        }
      }
      reds.sort((a, b) => a - b);
      greens.sort((a, b) => a - b);
      blues.sort((a, b) => a - b);
      const mid = Math.floor(reds.length / 2);
      setPixel(target, x, y, { r: reds[mid], g: greens[mid], b: blues[mid] }, alphaAt(source, x, y));
    }
  }
  return target;
}

function addNoise(source: ImageData, amount: number, mono: boolean, gaussian: boolean): ImageData {
  const target = clone(source);
  for (let i = 0; i < source.data.length; i += 4) {
    const noise = () => {
      const base = gaussian
        ? (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 0.5
        : Math.random() * 2 - 1;
      return base * amount;
    };
    if (mono) {
      const value = noise();
      target.data[i] = clampByte(source.data[i] + value);
      target.data[i + 1] = clampByte(source.data[i + 1] + value);
      target.data[i + 2] = clampByte(source.data[i + 2] + value);
    } else {
      target.data[i] = clampByte(source.data[i] + noise());
      target.data[i + 1] = clampByte(source.data[i + 1] + noise());
      target.data[i + 2] = clampByte(source.data[i + 2] + noise());
    }
  }
  return target;
}

function dustAndScratches(source: ImageData, radius: number, threshold: number): ImageData {
  const median = medianFilter(source, radius);
  const target = clone(source);
  for (let i = 0; i < source.data.length; i += 4) {
    const diff = Math.abs(source.data[i] - median.data[i]) + Math.abs(source.data[i + 1] - median.data[i + 1]) + Math.abs(source.data[i + 2] - median.data[i + 2]);
    if (diff > threshold * 3) {
      target.data[i] = median.data[i];
      target.data[i + 1] = median.data[i + 1];
      target.data[i + 2] = median.data[i + 2];
    }
  }
  return target;
}

function pixelate(source: ImageData, size: number): ImageData {
  const cell = Math.max(2, Math.round(size));
  const target = clone(source);
  for (let y = 0; y < source.height; y += cell) {
    for (let x = 0; x < source.width; x += cell) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let yy = 0; yy < cell; yy += 1) {
        for (let xx = 0; xx < cell; xx += 1) {
          if (x + xx >= source.width || y + yy >= source.height) continue;
          const sample = pixel(source, x + xx, y + yy);
          r += sample.r;
          g += sample.g;
          b += sample.b;
          count += 1;
        }
      }
      const color = { r: r / count, g: g / count, b: b / count };
      for (let yy = 0; yy < cell; yy += 1) {
        for (let xx = 0; xx < cell; xx += 1) {
          if (x + xx < source.width && y + yy < source.height) setPixel(target, x + xx, y + yy, color, alphaAt(source, x + xx, y + yy));
        }
      }
    }
  }
  return target;
}

function crystallize(source: ImageData, size: number): ImageData {
  const cell = Math.max(2, Math.round(size));
  const target = clone(source);
  for (let y = 0; y < source.height; y += cell) {
    for (let x = 0; x < source.width; x += cell) {
      const color = pixel(source, x + Math.random() * cell, y + Math.random() * cell);
      for (let yy = 0; yy < cell; yy += 1) {
        for (let xx = 0; xx < cell; xx += 1) {
          if (x + xx < source.width && y + yy < source.height) setPixel(target, x + xx, y + yy, color, alphaAt(source, x + xx, y + yy));
        }
      }
    }
  }
  return target;
}

function pointillize(source: ImageData, size: number): ImageData {
  const target = clone(source);
  const cell = Math.max(2, Math.round(size));
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const cx = Math.floor(x / cell) * cell + cell / 2;
      const cy = Math.floor(y / cell) * cell + cell / 2;
      const distance = Math.hypot(x - cx, y - cy);
      const sample = pixel(source, cx, cy);
      if (distance <= cell * 0.48) setPixel(target, x, y, sample, alphaAt(source, x, y));
      else setPixel(target, x, y, { r: 255, g: 255, b: 255 }, alphaAt(source, x, y));
    }
  }
  return target;
}

function halftone(source: ImageData, size: number, angle: number): ImageData {
  const target = clone(source);
  const cell = Math.max(2, Math.round(size));
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const rx = x * cos + y * sin;
      const ry = -x * sin + y * cos;
      const cx = (Math.floor(rx / cell) + 0.5) * cell;
      const cy = (Math.floor(ry / cell) + 0.5) * cell;
      const sample = pixel(source, cx * cos - cy * sin, cx * sin + cy * cos);
      const l = luma(sample) / 255;
      const distance = Math.hypot(rx - cx, ry - cy);
      const radius = Math.sqrt(1 - l) * cell * 0.7;
      setPixel(target, x, y, distance <= radius ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }, alphaAt(source, x, y));
    }
  }
  return target;
}

function emboss(source: ImageData, amount: number, angle: number): ImageData {
  const radians = (angle * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const a = pixel(source, x - dx * amount, y - dy * amount);
      const b = pixel(source, x + dx * amount, y + dy * amount);
      const value = 128 + (luma(a) - luma(b)) * 0.8;
      setPixel(target, x, y, { r: value, g: value, b: value }, alphaAt(source, x, y));
    }
  }
  return target;
}

function findEdges(source: ImageData, strength: number): ImageData {
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const tl = pixel(source, x - 1, y - 1);
      const tc = pixel(source, x, y - 1);
      const tr = pixel(source, x + 1, y - 1);
      const ml = pixel(source, x - 1, y);
      const mr = pixel(source, x + 1, y);
      const bl = pixel(source, x - 1, y + 1);
      const bc = pixel(source, x, y + 1);
      const br = pixel(source, x + 1, y + 1);
      const gx = -tl.r - 2 * ml.r - bl.r + tr.r + 2 * mr.r + br.r;
      const gy = -tl.r - 2 * tc.r - tr.r + bl.r + 2 * bc.r + br.r;
      const edge = Math.min(255, Math.hypot(gx, gy) * (strength / 100));
      setPixel(target, x, y, { r: 255 - edge, g: 255 - edge, b: 255 - edge }, alphaAt(source, x, y));
    }
  }
  return target;
}

function solarize(source: ImageData, threshold: number): ImageData {
  return mapRgb(source, (color) => (luma(color) >= threshold ? { r: 255 - color.r, g: 255 - color.g, b: 255 - color.b } : color));
}

function oilPaint(source: ImageData, radius: number, levels: number): ImageData {
  const r = Math.max(1, Math.round(radius));
  const bins = Math.max(2, Math.round(levels));
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const counts = new Map<number, { count: number; r: number; g: number; b: number }>();
      for (let yy = -r; yy <= r; yy += 1) {
        for (let xx = -r; xx <= r; xx += 1) {
          const sample = pixel(source, x + xx, y + yy);
          const bin = Math.floor((luma(sample) / 255) * (bins - 1));
          const entry = counts.get(bin) ?? { count: 0, r: 0, g: 0, b: 0 };
          entry.count += 1;
          entry.r += sample.r;
          entry.g += sample.g;
          entry.b += sample.b;
          counts.set(bin, entry);
        }
      }
      let best = { count: 0, r: 0, g: 0, b: 0 };
      for (const entry of counts.values()) if (entry.count > best.count) best = entry;
      if (best.count) setPixel(target, x, y, { r: best.r / best.count, g: best.g / best.count, b: best.b / best.count }, alphaAt(source, x, y));
    }
  }
  return target;
}

function edgeMap(source: ImageData): Uint8ClampedArray {
  const edges = new Uint8ClampedArray(source.width * source.height);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const left = pixel(source, x - 1, y);
      const right = pixel(source, x + 1, y);
      const top = pixel(source, x, y - 1);
      const bottom = pixel(source, x, y + 1);
      const gx = Math.abs(luma(right) - luma(left));
      const gy = Math.abs(luma(bottom) - luma(top));
      edges[y * source.width + x] = Math.min(255, Math.hypot(gx, gy));
    }
  }
  return edges;
}

function stylizeEdges(source: ImageData, amount: number, invert = false): ImageData {
  const edges = edgeMap(source);
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const edge = edges[y * source.width + x] * (amount / 100);
      const color = pixel(source, x, y);
      const value = invert ? Math.min(255, luma(color) + edge) : Math.max(0, luma(color) - edge);
      setPixel(target, x, y, { r: value, g: value, b: value }, alphaAt(source, x, y));
    }
  }
  return target;
}

function wind(source: ImageData, amount: number, direction: string): ImageData {
  const target = clone(source);
  const sign = direction === "right" ? 1 : -1;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const color = pixel(source, x, y);
      if (luma(color) > 200) {
        for (let step = 1; step <= amount; step += 1) {
          const sx = x - step * sign;
          if (sx < 0 || sx >= source.width) continue;
          const sample = pixel(source, sx, y);
          if (luma(sample) < 200) setPixel(target, sx, y, color, alphaAt(source, sx, y));
        }
      }
    }
  }
  return target;
}

function diffuse(source: ImageData, amount: number): ImageData {
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const ox = Math.round((Math.random() - 0.5) * amount);
      const oy = Math.round((Math.random() - 0.5) * amount);
      setPixel(target, x, y, pixel(source, x + ox, y + oy), alphaAt(source, x, y));
    }
  }
  return target;
}

function posterize(source: ImageData, levels: number): ImageData {
  const steps = Math.max(2, Math.round(levels));
  return mapRgb(source, (color) => ({
    r: Math.round(color.r / 255 * (steps - 1)) / (steps - 1) * 255,
    g: Math.round(color.g / 255 * (steps - 1)) / (steps - 1) * 255,
    b: Math.round(color.b / 255 * (steps - 1)) / (steps - 1) * 255,
  }));
}

function threshold(source: ImageData, level: number): ImageData {
  return mapRgb(source, (color) => {
    const value = luma(color) >= level ? 255 : 0;
    return { r: value, g: value, b: value };
  });
}

function brightnessContrast(source: ImageData, brightness: number, contrast: number): ImageData {
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  return mapRgb(source, (color) => ({
    r: factor * (color.r - 128) + 128 + brightness,
    g: factor * (color.g - 128) + 128 + brightness,
    b: factor * (color.b - 128) + 128 + brightness,
  }));
}

function levels(source: ImageData, black: number, white: number, gamma: number): ImageData {
  const range = Math.max(1, white - black);
  return mapRgb(source, (color) => {
    const adjust = (value: number) => Math.pow(clamp((value - black) / range, 0, 1), 1 / Math.max(0.05, gamma)) * 255;
    return { r: adjust(color.r), g: adjust(color.g), b: adjust(color.b) };
  });
}

function exposure(source: ImageData, stops: number): ImageData {
  const factor = Math.pow(2, stops);
  return mapRgb(source, (color) => ({ r: color.r * factor, g: color.g * factor, b: color.b * factor }));
}

function vibrance(source: ImageData, amount: number): ImageData {
  return mapPixels(source, (color) => {
    const hsl = rgbToHsl(color);
    const boost = (amount / 100) * (1 - hsl.s) * 0.8;
    return hslToRgb({ ...hsl, s: clamp(hsl.s + boost, 0, 1) });
  });
}

function hueSaturation(source: ImageData, hue: number, saturation: number, lightness: number): ImageData {
  return mapPixels(source, (color) => {
    const hsl = rgbToHsl(color);
    return hslToRgb({
      h: hsl.h + hue / 360,
      s: clamp(hsl.s + saturation / 100, 0, 1),
      l: clamp(hsl.l + lightness / 100, 0, 1),
    });
  });
}

function colorBalance(source: ImageData, red: number, green: number, blue: number): ImageData {
  return mapRgb(source, (color) => {
    const l = luma(color) / 255;
    const weight = l < 0.5 ? 1 - l : 1 - (1 - l);
    return {
      r: color.r + red * weight,
      g: color.g + green * weight,
      b: color.b + blue * weight,
    };
  });
}

function blackWhite(source: ImageData, red: number, green: number, blue: number): ImageData {
  return mapRgb(source, (color) => {
    const value = color.r * red / 100 + color.g * green / 100 + color.b * blue / 100;
    return { r: value, g: value, b: value };
  });
}

function photoFilter(source: ImageData, hex: string, density: number): ImageData {
  const target = hex.replace("#", "");
  const tint = {
    r: parseInt(target.slice(0, 2), 16) || 255,
    g: parseInt(target.slice(2, 4), 16) || 160,
    b: parseInt(target.slice(4, 6), 16) || 80,
  };
  return mapRgb(source, (color) => mix(color, tint, density / 100));
}

function channelMixer(source: ImageData, rr: number, rg: number, rb: number, gr: number, gg: number, gb: number, br: number, bg: number, bb: number): ImageData {
  return mapRgb(source, (color) => ({
    r: (color.r * rr + color.g * rg + color.b * rb) / 100,
    g: (color.r * gr + color.g * gg + color.b * gb) / 100,
    b: (color.r * br + color.g * bg + color.b * bb) / 100,
  }));
}

function gradientMap(source: ImageData, shadow: string, highlight: string): ImageData {
  const parse = (hex: string) => {
    const value = hex.replace("#", "");
    return { r: parseInt(value.slice(0, 2), 16) || 0, g: parseInt(value.slice(2, 4), 16) || 0, b: parseInt(value.slice(4, 6), 16) || 0 };
  };
  const a = parse(shadow);
  const b = parse(highlight);
  return mapRgb(source, (color) => mix(a, b, luma(color) / 255));
}

function selectiveColor(source: ImageData, hue: number, saturation: number, lightness: number): ImageData {
  return mapPixels(source, (color) => {
    const hsl = rgbToHsl(color);
    const targetHue = hue / 360;
    const distance = Math.min(Math.abs(hsl.h - targetHue), 1 - Math.abs(hsl.h - targetHue));
    if (distance > 0.12) return color;
    return hslToRgb({ ...hsl, s: clamp(hsl.s + saturation / 100, 0, 1), l: clamp(hsl.l + lightness / 100, 0, 1) });
  });
}

function invert(source: ImageData): ImageData {
  return mapRgb(source, (color) => ({ r: 255 - color.r, g: 255 - color.g, b: 255 - color.b }));
}

function highPass(source: ImageData, radius: number): ImageData {
  const blurred = gaussianBlur(source, radius);
  return mapPixels(source, (color, x, y) => {
    const i = (y * source.width + x) * 4;
    return {
      r: 128 + color.r - blurred.data[i],
      g: 128 + color.g - blurred.data[i + 1],
      b: 128 + color.b - blurred.data[i + 2],
    };
  });
}

function offset(source: ImageData, horizontal: number, vertical: number): ImageData {
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sx = ((x + horizontal) % source.width + source.width) % source.width;
      const sy = ((y + vertical) % source.height + source.height) % source.height;
      const i = (y * source.width + x) * 4;
      const j = (sy * source.width + sx) * 4;
      target.data[i] = source.data[j];
      target.data[i + 1] = source.data[j + 1];
      target.data[i + 2] = source.data[j + 2];
      target.data[i + 3] = source.data[j + 3];
    }
  }
  return target;
}

function morphology(source: ImageData, radius: number, maximum: boolean): ImageData {
  const r = Math.max(1, Math.round(radius));
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      let best = maximum ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
      for (let yy = -r; yy <= r; yy += 1) {
        for (let xx = -r; xx <= r; xx += 1) {
          const sample = pixel(source, x + xx, y + yy);
          if (maximum ? luma(sample) > luma(best) : luma(sample) < luma(best)) best = sample;
        }
      }
      setPixel(target, x, y, best, alphaAt(source, x, y));
    }
  }
  return target;
}

function transformPixels(source: ImageData, map: (x: number, y: number) => [number, number]): ImageData {
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const [sx, sy] = map(x, y);
      setPixel(target, x, y, pixel(source, sx, sy), alphaAt(source, sx, sy));
    }
  }
  return target;
}

function pinch(source: ImageData, amount: number): ImageData {
  const cx = source.width / 2;
  const cy = source.height / 2;
  const strength = amount / 100;
  return transformPixels(source, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const distance = Math.hypot(dx, dy) / Math.hypot(cx, cy);
    const factor = Math.pow(Math.max(0, distance), strength * 0.8);
    return [cx + dx * factor, cy + dy * factor];
  });
}

function spherize(source: ImageData, amount: number): ImageData {
  const cx = source.width / 2;
  const cy = source.height / 2;
  const radius = Math.max(cx, cy);
  const strength = amount / 100;
  return transformPixels(source, (x, y) => {
    const dx = (x - cx) / radius;
    const dy = (y - cy) / radius;
    const distance = Math.hypot(dx, dy);
    if (distance === 0 || distance > 1) return [x, y];
    const factor = Math.sin(distance * Math.PI / 2) / distance;
    return [cx + dx * radius * (1 + (factor - 1) * strength), cy + dy * radius * (1 + (factor - 1) * strength)];
  });
}

function twirl(source: ImageData, amount: number): ImageData {
  const cx = source.width / 2;
  const cy = source.height / 2;
  const radius = Math.min(cx, cy);
  return transformPixels(source, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const distance = Math.hypot(dx, dy);
    if (distance > radius) return [x, y];
    const angle = Math.atan2(dy, dx) + (1 - distance / radius) * (amount / 100) * Math.PI * 2;
    return [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance];
  });
}

function wave(source: ImageData, amplitude: number, wavelength: number, phase: number): ImageData {
  const lambda = Math.max(1, wavelength);
  return transformPixels(source, (x, y) => [
    x + Math.sin((y / lambda) * TAU + phase) * amplitude,
    y + Math.cos((x / lambda) * TAU + phase) * amplitude,
  ]);
}

function ripple(source: ImageData, amount: number, wavelength: number): ImageData {
  const cx = source.width / 2;
  const cy = source.height / 2;
  const lambda = Math.max(1, wavelength);
  return transformPixels(source, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const distance = Math.hypot(dx, dy);
    const offset = Math.sin(distance / lambda * TAU) * (amount / 100) * 20;
    return [x + dx / Math.max(1, distance) * offset, y + dy / Math.max(1, distance) * offset];
  });
}

function polarCoordinates(source: ImageData, mode: string): ImageData {
  const cx = source.width / 2;
  const cy = source.height / 2;
  const radius = Math.min(cx, cy);
  return transformPixels(source, (x, y) => {
    const dx = (x - cx) / radius;
    const dy = (y - cy) / radius;
    if (mode === "polar-to-rect") {
      const angle = Math.atan2(dy, dx);
      const distance = Math.hypot(dx, dy);
      return [((angle + Math.PI) / TAU) * source.width, distance * source.height];
    }
    const angle = (x / source.width) * TAU - Math.PI;
    const distance = (y / source.height) * radius;
    return [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance];
  });
}

function lensDistortion(source: ImageData, amount: number): ImageData {
  const cx = source.width / 2;
  const cy = source.height / 2;
  const radius = Math.min(cx, cy);
  return transformPixels(source, (x, y) => {
    const dx = (x - cx) / radius;
    const dy = (y - cy) / radius;
    const distance = Math.hypot(dx, dy);
    const factor = 1 + (amount / 100) * distance * distance;
    return [cx + dx * factor * radius, cy + dy * factor * radius];
  });
}

function zigzag(source: ImageData, amount: number, ridges: number): ImageData {
  const count = Math.max(1, Math.round(ridges));
  return transformPixels(source, (x, y) => [
    x + Math.sin((y / source.height) * TAU * count) * amount,
    y + Math.cos((x / source.width) * TAU * count) * amount,
  ]);
}

function shear(source: ImageData, amount: number): ImageData {
  return transformPixels(source, (x, y) => [x + (y / source.height) * amount, y]);
}

function watercolor(source: ImageData, detail: number): ImageData {
  const median = medianFilter(source, Math.max(1, Math.round(detail / 8)));
  const poster = posterize(median, Math.max(3, Math.round(detail / 6)));
  const edges = edgeMap(poster);
  const target = clone(poster);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const edge = edges[y * source.width + x] / 255;
      const color = pixel(poster, x, y);
      setPixel(target, x, y, { r: color.r * (1 - edge * 0.25), g: color.g * (1 - edge * 0.25), b: color.b * (1 - edge * 0.25) }, alphaAt(source, x, y));
    }
  }
  return target;
}

function dryBrush(source: ImageData, size: number, detail: number): ImageData {
  const radius = Math.max(1, Math.round(size / 6));
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sample = pixel(source, x + (Math.random() - 0.5) * radius, y + (Math.random() - 0.5) * radius);
      const poster = Math.round(luma(sample) / 255 * detail) / detail * 255;
      setPixel(target, x, y, { r: poster, g: poster, b: poster }, alphaAt(source, x, y));
    }
  }
  return target;
}

function posterEdges(source: ImageData, levels: number, edgeAmount: number): ImageData {
  const poster = posterize(source, levels);
  const edges = edgeMap(source);
  const target = clone(poster);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const edge = (edges[y * source.width + x] / 255) * (edgeAmount / 100);
      const color = pixel(poster, x, y);
      setPixel(target, x, y, { r: color.r * (1 - edge), g: color.g * (1 - edge), b: color.b * (1 - edge) }, alphaAt(source, x, y));
    }
  }
  return target;
}

function cutout(source: ImageData, levels: number): ImageData {
  const poster = posterize(source, levels);
  return posterize(medianFilter(poster, 1), Math.max(2, Math.round(levels / 2)));
}

function filmGrain(source: ImageData, amount: number, size: number): ImageData {
  const blurred = gaussianBlur(source, Math.max(0.1, size / 3));
  const target = clone(blurred);
  for (let i = 0; i < target.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * amount;
    target.data[i] = clampByte(target.data[i] + noise);
    target.data[i + 1] = clampByte(target.data[i + 1] + noise);
    target.data[i + 2] = clampByte(target.data[i + 2] + noise);
  }
  return target;
}

function fresco(source: ImageData, size: number, texture: number): ImageData {
  const blurred = medianFilter(source, Math.max(1, Math.round(size / 8)));
  const target = clone(blurred);
  for (let i = 0; i < target.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * texture;
    target.data[i] = clampByte(target.data[i] + noise);
    target.data[i + 1] = clampByte(target.data[i + 1] + noise);
    target.data[i + 2] = clampByte(target.data[i + 2] + noise);
  }
  return target;
}

function paintDaubs(source: ImageData, size: number, sharpness: number): ImageData {
  const oil = oilPaint(source, Math.max(1, Math.round(size / 8)), 12);
  return unsharpMask(oil, sharpness, 1, 0);
}

function paletteKnife(source: ImageData, size: number, detail: number): ImageData {
  const blurred = motionBlur(source, 35, size);
  return posterEdges(blurred, Math.max(3, Math.round(detail / 6)), 45);
}

function plasticWrap(source: ImageData, strength: number, detail: number): ImageData {
  const blurred = gaussianBlur(source, Math.max(0.2, detail / 10));
  const target = clone(blurred);
  for (let i = 0; i < target.data.length; i += 4) {
    const l = (target.data[i] + target.data[i + 1] + target.data[i + 2]) / 3;
    const highlight = Math.pow(l / 255, 2) * strength;
    target.data[i] = clampByte(target.data[i] + highlight * 0.3);
    target.data[i + 1] = clampByte(target.data[i + 1] + highlight * 0.3);
    target.data[i + 2] = clampByte(target.data[i + 2] + highlight * 0.3);
  }
  return target;
}

function roughPastels(source: ImageData, size: number, texture: number): ImageData {
  const base = posterize(gaussianBlur(source, Math.max(0.2, size / 10)), 12);
  const target = clone(base);
  for (let i = 0; i < target.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * texture;
    target.data[i] = clampByte(target.data[i] + noise);
    target.data[i + 1] = clampByte(target.data[i + 1] + noise);
    target.data[i + 2] = clampByte(target.data[i + 2] + noise);
  }
  return target;
}

function smudgeStick(source: ImageData, size: number, detail: number): ImageData {
  return posterize(motionBlur(source, 25, size), Math.max(4, Math.round(detail / 5)));
}

function sponge(source: ImageData, size: number, definition: number): ImageData {
  const base = gaussianBlur(source, Math.max(0.1, size / 8));
  const target = clone(base);
  for (let i = 0; i < target.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * definition;
    target.data[i] = clampByte(target.data[i] + noise);
    target.data[i + 1] = clampByte(target.data[i + 1] + noise);
    target.data[i + 2] = clampByte(target.data[i + 2] + noise);
  }
  return target;
}

function underpainting(source: ImageData, size: number, texture: number): ImageData {
  return posterize(gaussianBlur(source, Math.max(0.2, size / 5)), Math.max(4, Math.round(texture / 5)));
}

function coloredPencil(source: ImageData, size: number, detail: number): ImageData {
  const edges = edgeMap(source);
  const base = gaussianBlur(source, Math.max(0.1, size / 12));
  const target = clone(base);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const edge = edges[y * source.width + x] / 255;
      const color = pixel(base, x, y);
      const value = 1 - edge * (detail / 100);
      setPixel(target, x, y, { r: color.r * value, g: color.g * value, b: color.b * value }, alphaAt(source, x, y));
    }
  }
  return target;
}

function accentedEdges(source: ImageData, width: number, brightness: number): ImageData {
  const edges = edgeMap(source);
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const edge = edges[y * source.width + x] / 255;
      const color = pixel(source, x, y);
      const boost = edge * (brightness / 100) * (width / 3);
      setPixel(target, x, y, { r: color.r + boost * 0.3, g: color.g + boost * 0.3, b: color.b + boost * 0.3 }, alphaAt(source, x, y));
    }
  }
  return target;
}

function angledStrokes(source: ImageData, directionBalance: number, strokeLength: number, sharpness: number): ImageData {
  const angle = directionBalance >= 50 ? 35 : -35;
  return unsharpMask(motionBlur(source, angle, Math.max(2, strokeLength)), sharpness, 1, 0);
}

function crosshatch(source: ImageData, strokeLength: number, sharpness: number): ImageData {
  const base = mapRgb(source, (color) => {
    const value = luma(color);
    const line = (Math.sin(value / 8) + 1) / 2;
    return { r: value * line, g: value * line, b: value * line };
  });
  return unsharpMask(motionBlur(base, 45, Math.max(2, strokeLength)), sharpness, 1, 0);
}

function darkStrokes(source: ImageData, balance: number, blackIntensity: number): ImageData {
  const base = mapRgb(source, (color) => {
    const value = luma(color);
    return value < 128 ? { r: value * (blackIntensity / 100), g: value * (blackIntensity / 100), b: value * (blackIntensity / 100) } : color;
  });
  return motionBlur(base, balance >= 50 ? 45 : 135, 4);
}

function inkOutlines(source: ImageData, length: number, darkIntensity: number): ImageData {
  const edges = edgeMap(source);
  const base = gaussianBlur(source, Math.max(0.1, length / 6));
  const target = clone(base);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const edge = edges[y * source.width + x] / 255;
      const color = pixel(base, x, y);
      const value = 1 - edge * (darkIntensity / 100);
      setPixel(target, x, y, { r: color.r * value, g: color.g * value, b: color.b * value }, alphaAt(source, x, y));
    }
  }
  return target;
}

function spatter(source: ImageData, radius: number, smoothness: number): ImageData {
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const angle = Math.random() * TAU;
      const distance = Math.random() * radius;
      setPixel(target, x, y, pixel(source, x + Math.cos(angle) * distance, y + Math.sin(angle) * distance), alphaAt(source, x, y));
    }
  }
  return gaussianBlur(target, Math.max(0, smoothness / 20));
}

function sprayedStrokes(source: ImageData, radius: number, direction: string): ImageData {
  const base = motionBlur(source, direction === "right" ? 0 : 180, radius * 2);
  return diffuse(base, Math.max(1, radius));
}

function sumiE(source: ImageData, width: number, pressure: number): ImageData {
  const gray = mapRgb(source, (color) => {
    const value = luma(color);
    return { r: value, g: value, b: value };
  });
  const blurred = gaussianBlur(gray, Math.max(0.1, width / 8));
  return posterize(blurred, Math.max(3, Math.round(pressure / 8)));
}

function basRelief(source: ImageData, detail: number, smoothness: number): ImageData {
  return gaussianBlur(emboss(source, Math.max(1, detail / 20), 135), Math.max(0, smoothness / 20));
}

function chalkCharcoal(source: ImageData, angle: number, strokeLength: number): ImageData {
  const base = motionBlur(source, angle, Math.max(2, strokeLength));
  const target = clone(base);
  for (let i = 0; i < target.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 60;
    target.data[i] = clampByte(target.data[i] + noise);
    target.data[i + 1] = clampByte(target.data[i + 1] + noise);
    target.data[i + 2] = clampByte(target.data[i + 2] + noise);
  }
  return target;
}

function charcoal(source: ImageData, thickness: number, detail: number): ImageData {
  const base = gaussianBlur(source, Math.max(0.1, thickness / 8));
  const target = clone(base);
  for (let i = 0; i < target.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * detail;
    target.data[i] = clampByte(target.data[i] * 0.7 + noise);
    target.data[i + 1] = clampByte(target.data[i + 1] * 0.7 + noise);
    target.data[i + 2] = clampByte(target.data[i + 2] * 0.7 + noise);
  }
  return target;
}

function chrome(source: ImageData, detail: number, smoothness: number): ImageData {
  const base = gaussianBlur(source, Math.max(0.1, smoothness / 10));
  const target = clone(base);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const left = pixel(base, x - 1, y);
      const right = pixel(base, x + 1, y);
      const value = 128 + (luma(right) - luma(left)) * (detail / 20);
      setPixel(target, x, y, { r: value, g: value, b: value }, alphaAt(source, x, y));
    }
  }
  return target;
}

function conteCrayon(source: ImageData, foreground: number, background: number): ImageData {
  const base = gaussianBlur(source, 0.8);
  return mapRgb(base, (color) => {
    const value = luma(color);
    const t = clamp((value - foreground) / Math.max(1, background - foreground), 0, 1);
    return mix({ r: 70, g: 40, b: 25 }, { r: 245, g: 235, b: 215 }, t);
  });
}

function graphicPen(source: ImageData, strokeLength: number, direction: string): ImageData {
  const base = motionBlur(source, direction === "right" ? 45 : 135, Math.max(2, strokeLength));
  return mapRgb(base, (color) => {
    const value = luma(color) > 128 ? 255 : 0;
    return { r: value, g: value, b: value };
  });
}

function halftonePattern(source: ImageData, size: number, contrast: number): ImageData {
  const base = halftone(source, size, 45);
  return brightnessContrast(base, 0, contrast);
}

function notePaper(source: ImageData, imageBalance: number, graininess: number): ImageData {
  const base = gaussianBlur(source, 0.5);
  const target = clone(base);
  for (let i = 0; i < target.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * graininess;
    target.data[i] = clampByte(target.data[i] * (imageBalance / 100) + noise);
    target.data[i + 1] = clampByte(target.data[i + 1] * (imageBalance / 100) + noise);
    target.data[i + 2] = clampByte(target.data[i + 2] * (imageBalance / 100) + noise);
  }
  return target;
}

function photocopy(source: ImageData, detail: number, darkness: number): ImageData {
  const base = gaussianBlur(source, Math.max(0.1, detail / 20));
  return mapRgb(base, (color) => {
    const value = luma(color) > 255 - darkness * 1.5 ? 0 : 255;
    return { r: value, g: value, b: value };
  });
}

function plaster(source: ImageData, balance: number, smoothness: number): ImageData {
  const base = gaussianBlur(source, Math.max(0.1, smoothness / 10));
  return mapRgb(base, (color) => {
    const value = luma(color) * (balance / 100) + 40;
    return { r: value, g: value, b: value };
  });
}

function reticulation(source: ImageData, density: number, foreground: number): ImageData {
  const base = gaussianBlur(source, 0.4);
  const target = clone(base);
  for (let i = 0; i < target.data.length; i += 4) {
    const noise = Math.random() < density / 100 ? foreground : 0;
    target.data[i] = clampByte(target.data[i] + noise);
    target.data[i + 1] = clampByte(target.data[i + 1] + noise);
    target.data[i + 2] = clampByte(target.data[i + 2] + noise);
  }
  return target;
}

function stamp(source: ImageData, smoothness: number): ImageData {
  const base = gaussianBlur(source, Math.max(0.1, smoothness / 10));
  return threshold(base, 128);
}

function tornEdges(source: ImageData, balance: number, smoothness: number): ImageData {
  const base = gaussianBlur(source, Math.max(0.1, smoothness / 10));
  const target = clone(base);
  for (let i = 0; i < target.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * balance;
    target.data[i] = clampByte(target.data[i] + noise);
    target.data[i + 1] = clampByte(target.data[i + 1] + noise);
    target.data[i + 2] = clampByte(target.data[i + 2] + noise);
  }
  return target;
}

function waterPaper(source: ImageData, fiberLength: number, brightness: number): ImageData {
  const base = motionBlur(source, 0, Math.max(2, fiberLength));
  return brightnessContrast(base, brightness, 0);
}

function craquelure(source: ImageData, crackSpacing: number, crackDepth: number): ImageData {
  const target = clone(source);
  const spacing = Math.max(3, Math.round(crackSpacing));
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if ((x + y) % spacing === 0 || (x - y + source.width) % spacing === 0) {
        const color = pixel(source, x, y);
        const depth = crackDepth;
        setPixel(target, x, y, { r: color.r - depth, g: color.g - depth, b: color.b - depth }, alphaAt(source, x, y));
      }
    }
  }
  return target;
}

function grain(source: ImageData, intensity: number): ImageData {
  return addNoise(source, intensity, true, true);
}

function mosaicTiles(source: ImageData, tileSize: number, grout: number): ImageData {
  const cell = Math.max(2, Math.round(tileSize));
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const inGrout = x % cell < grout || y % cell < grout;
      setPixel(target, x, y, inGrout ? { r: 230, g: 230, b: 225 } : pixel(source, Math.floor(x / cell) * cell + cell / 2, Math.floor(y / cell) * cell + cell / 2), alphaAt(source, x, y));
    }
  }
  return target;
}

function patchwork(source: ImageData, size: number, relief: number): ImageData {
  const base = pixelate(source, size);
  const target = clone(base);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (x % Math.round(size) === 0 || y % Math.round(size) === 0) {
        const color = pixel(base, x, y);
        setPixel(target, x, y, { r: color.r - relief, g: color.g - relief, b: color.b - relief }, alphaAt(source, x, y));
      }
    }
  }
  return target;
}

function stainedGlass(source: ImageData, size: number, lightIntensity: number): ImageData {
  const base = crystallize(source, size);
  const edges = edgeMap(base);
  const target = clone(base);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const edge = edges[y * source.width + x] / 255;
      const color = pixel(base, x, y);
      const boost = edge * lightIntensity;
      setPixel(target, x, y, { r: color.r * (1 - edge) + boost, g: color.g * (1 - edge) + boost, b: color.b * (1 - edge) + boost }, alphaAt(source, x, y));
    }
  }
  return target;
}

function texturizer(source: ImageData, texture: string, scaling: number, relief: number): ImageData {
  const base = gaussianBlur(source, Math.max(0.1, scaling / 20));
  const target = clone(base);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const pattern = texture === "canvas" ? Math.sin(x / 3) * Math.cos(y / 3) : Math.sin((x + y) / 5);
      const value = pattern * relief;
      const color = pixel(base, x, y);
      setPixel(target, x, y, { r: color.r + value, g: color.g + value, b: color.b + value }, alphaAt(source, x, y));
    }
  }
  return target;
}

function clouds(source: ImageData, scale: number, seed: number): ImageData {
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const value = (Math.sin((x + seed) / scale) + Math.cos((y - seed) / scale) + Math.sin((x + y) / (scale * 2)) + 3) / 6 * 255;
      setPixel(target, x, y, { r: value, g: value, b: value }, alphaAt(source, x, y));
    }
  }
  return target;
}

function differenceClouds(source: ImageData, scale: number, seed: number): ImageData {
  const cloud = clouds(source, scale, seed);
  return mapPixels(source, (color, x, y) => {
    const i = (y * source.width + x) * 4;
    return {
      r: Math.abs(color.r - cloud.data[i]),
      g: Math.abs(color.g - cloud.data[i + 1]),
      b: Math.abs(color.b - cloud.data[i + 2]),
    };
  });
}

function fibers(source: ImageData, variance: number, strength: number): ImageData {
  const target = clone(source);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const value = (Math.sin(y / Math.max(1, variance)) + 1) / 2 * strength;
      const color = pixel(source, x, y);
      setPixel(target, x, y, { r: color.r * (0.6 + value / 255), g: color.g * (0.6 + value / 255), b: color.b * (0.6 + value / 255) }, alphaAt(source, x, y));
    }
  }
  return target;
}

function lensFlare(source: ImageData, brightness: number): ImageData {
  const target = clone(source);
  const cx = source.width * 0.65;
  const cy = source.height * 0.35;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      const glow = Math.max(0, 1 - distance / (Math.min(source.width, source.height) * 0.4)) * brightness;
      const color = pixel(source, x, y);
      setPixel(target, x, y, { r: color.r + glow, g: color.g + glow * 0.8, b: color.b + glow * 0.5 }, alphaAt(source, x, y));
    }
  }
  return target;
}

function applyCustomConvolution(source: ImageData, amount: number): ImageData {
  const strength = amount / 100;
  const kernel = [0, -strength, 0, -strength, 1 + 4 * strength, -strength, 0, -strength, 0];
  return convolve(source, kernel, 1, 0);
}

// ------------------------------------------------------------------ registry

const amount = (min = 0, max = 100, def = 50, label = "Amount"): FilterParam => ({ key: "amount", label, kind: "range", min, max, step: 1, default: def });
const radius = (def = 4, min = 0.1, max = 100): FilterParam => ({ key: "radius", label: "Radius", kind: "range", min, max, step: 0.1, default: def });
const angle = (def = 0): FilterParam => ({ key: "angle", label: "Angle", kind: "range", min: -180, max: 180, step: 1, default: def });
const size = (def = 10, min = 1, max = 200, label = "Size"): FilterParam => ({ key: "size", label, kind: "range", min, max, step: 1, default: def });
const level = (def = 4, min = 2, max = 32): FilterParam => ({ key: "levels", label: "Levels", kind: "range", min, max, step: 1, default: def });
const direction = (def = "right"): FilterParam => ({ key: "direction", label: "Direction", kind: "select", options: [{ value: "left", label: "Left" }, { value: "right", label: "Right" }], default: def });
const quality = (): FilterParam => ({ key: "quality", label: "Quality", kind: "select", options: [{ value: "draft", label: "Draft" }, { value: "good", label: "Good" }, { value: "best", label: "Best" }], default: "good" });
const distribution = (): FilterParam => ({ key: "distribution", label: "Distribution", kind: "select", options: [{ value: "uniform", label: "Uniform" }, { value: "gaussian", label: "Gaussian" }], default: "uniform" });
const mono = (): FilterParam => ({ key: "monochromatic", label: "Monochromatic", kind: "check", default: false });
const colorA = (def = "#1f2937", label = "Shadow"): FilterParam => ({ key: "shadow", label, kind: "color", default: def });
const colorB = (def = "#f8fafc", label = "Highlight"): FilterParam => ({ key: "highlight", label, kind: "color", default: def });
const texture = (): FilterParam => ({ key: "texture", label: "Texture", kind: "select", options: [{ value: "canvas", label: "Canvas" }, { value: "brick", label: "Brick" }, { value: "sandstone", label: "Sandstone" }], default: "canvas" });

export const FILTERS: FilterDefinition[] = [
  // Blur
  { id: "gaussian-blur", name: "Gaussian Blur", category: "Blur", params: [radius(4)], apply: (src, p) => gaussianBlur(src, n(p, "radius", 4)) },
  { id: "box-blur", name: "Box Blur", category: "Blur", params: [radius(3)], apply: (src, p) => boxBlur(src, n(p, "radius", 3)) },
  { id: "motion-blur", name: "Motion Blur", category: "Blur", params: [angle(0), { key: "distance", label: "Distance", kind: "range", min: 1, max: 200, step: 1, default: 12 }], apply: (src, p) => motionBlur(src, n(p, "angle", 0), n(p, "distance", 12)) },
  { id: "radial-blur", name: "Radial Blur", category: "Blur", params: [amount(1, 100, 20), { key: "mode", label: "Method", kind: "select", options: [{ value: "spin", label: "Spin" }, { value: "zoom", label: "Zoom" }], default: "spin" }, quality()], apply: (src, p) => radialBlur(src, n(p, "amount", 20), s(p, "mode", "spin"), s(p, "quality", "good")) },
  { id: "surface-blur", name: "Surface Blur", category: "Blur", params: [radius(5), { key: "threshold", label: "Threshold", kind: "range", min: 2, max: 255, step: 1, default: 15 }], apply: (src, p) => surfaceBlur(src, n(p, "radius", 5), n(p, "threshold", 15)) },
  { id: "lens-blur", name: "Lens Blur", category: "Blur", params: [radius(6), amount(0, 100, 35, "Highlight")], apply: (src, p) => gaussianBlur(unsharpMask(src, n(p, "amount", 35), 2, 0), n(p, "radius", 6)) },
  { id: "smart-blur", name: "Smart Blur", category: "Blur", params: [radius(4), { key: "threshold", label: "Threshold", kind: "range", min: 1, max: 255, step: 1, default: 20 }], apply: (src, p) => surfaceBlur(src, n(p, "radius", 4), n(p, "threshold", 20)) },
  { id: "blur-more", name: "Blur More", category: "Blur", params: [], apply: (src) => gaussianBlur(src, 1.6) },
  { id: "average-blur", name: "Average", category: "Blur", params: [size(8)], apply: (src, p) => boxBlur(src, n(p, "size", 8)) },

  // Sharpen
  { id: "unsharp-mask", name: "Unsharp Mask", category: "Sharpen", params: [amount(1, 500, 80), radius(1.5), { key: "threshold", label: "Threshold", kind: "range", min: 0, max: 255, step: 1, default: 0 }], apply: (src, p) => unsharpMask(src, n(p, "amount", 80), n(p, "radius", 1.5), n(p, "threshold", 0)) },
  { id: "sharpen", name: "Sharpen", category: "Sharpen", params: [], apply: (src) => unsharpMask(src, 60, 0.8, 0) },
  { id: "sharpen-more", name: "Sharpen More", category: "Sharpen", params: [], apply: (src) => unsharpMask(src, 150, 0.8, 0) },
  { id: "sharpen-edges", name: "Sharpen Edges", category: "Sharpen", params: [amount(1, 500, 100)], apply: (src, p) => unsharpMask(src, n(p, "amount", 100), 1, 6) },
  { id: "smart-sharpen", name: "Smart Sharpen", category: "Sharpen", params: [amount(1, 500, 120), radius(1), { key: "reduceNoise", label: "Reduce Noise", kind: "range", min: 0, max: 100, step: 1, default: 10 }], apply: (src, p) => unsharpMask(surfaceBlur(src, 1, 10), n(p, "amount", 120), n(p, "radius", 1), 0) },

  // Noise
  { id: "add-noise", name: "Add Noise", category: "Noise", params: [amount(0.1, 100, 12, "Amount"), distribution(), mono()], apply: (src, p) => addNoise(src, n(p, "amount", 12), b(p, "monochromatic", false), s(p, "distribution", "uniform") === "gaussian") },
  { id: "median", name: "Median", category: "Noise", params: [radius(2)], apply: (src, p) => medianFilter(src, n(p, "radius", 2)) },
  { id: "dust-scratches", name: "Dust & Scratches", category: "Noise", params: [radius(2), { key: "threshold", label: "Threshold", kind: "range", min: 0, max: 255, step: 1, default: 12 }], apply: (src, p) => dustAndScratches(src, n(p, "radius", 2), n(p, "threshold", 12)) },
  { id: "despeckle", name: "Despeckle", category: "Noise", params: [], apply: (src) => medianFilter(src, 1) },
  { id: "reduce-noise", name: "Reduce Noise", category: "Noise", params: [radius(3), { key: "threshold", label: "Preserve Detail", kind: "range", min: 1, max: 255, step: 1, default: 25 }], apply: (src, p) => surfaceBlur(src, n(p, "radius", 3), n(p, "threshold", 25)) },

  // Distort
  { id: "pinch", name: "Pinch", category: "Distort", params: [amount(-100, 100, 35)], apply: (src, p) => pinch(src, n(p, "amount", 35)) },
  { id: "spherize", name: "Spherize", category: "Distort", params: [amount(-100, 100, 40)], apply: (src, p) => spherize(src, n(p, "amount", 40)) },
  { id: "twirl", name: "Twirl", category: "Distort", params: [angle(45)], apply: (src, p) => twirl(src, n(p, "angle", 45)) },
  { id: "wave", name: "Wave", category: "Distort", params: [amount(1, 100, 10, "Amplitude"), { key: "wavelength", label: "Wavelength", kind: "range", min: 2, max: 200, step: 1, default: 30 }, { key: "phase", label: "Phase", kind: "range", min: 0, max: 360, step: 1, default: 0 }], apply: (src, p) => wave(src, n(p, "amount", 10), n(p, "wavelength", 30), n(p, "phase", 0) * Math.PI / 180) },
  { id: "ripple", name: "Ripple", category: "Distort", params: [amount(1, 100, 20), { key: "wavelength", label: "Wavelength", kind: "range", min: 2, max: 200, step: 1, default: 25 }], apply: (src, p) => ripple(src, n(p, "amount", 20), n(p, "wavelength", 25)) },
  { id: "polar-coordinates", name: "Polar Coordinates", category: "Distort", params: [{ key: "mode", label: "Mode", kind: "select", options: [{ value: "rect-to-polar", label: "Rect to Polar" }, { value: "polar-to-rect", label: "Polar to Rect" }], default: "rect-to-polar" }], apply: (src, p) => polarCoordinates(src, s(p, "mode", "rect-to-polar")) },
  { id: "lens-distortion", name: "Lens Distortion", category: "Distort", params: [amount(-100, 100, 25)], apply: (src, p) => lensDistortion(src, n(p, "amount", 25)) },
  { id: "zigzag", name: "ZigZag", category: "Distort", params: [amount(1, 100, 12), { key: "ridges", label: "Ridges", kind: "range", min: 1, max: 20, step: 1, default: 5 }], apply: (src, p) => zigzag(src, n(p, "amount", 12), n(p, "ridges", 5)) },
  { id: "shear", name: "Shear", category: "Distort", params: [amount(-100, 100, 20)], apply: (src, p) => shear(src, n(p, "amount", 20)) },

  // Pixelate
  { id: "mosaic", name: "Mosaic", category: "Pixelate", params: [size(12)], apply: (src, p) => pixelate(src, n(p, "size", 12)) },
  { id: "crystallize", name: "Crystallize", category: "Pixelate", params: [size(10)], apply: (src, p) => crystallize(src, n(p, "size", 10)) },
  { id: "pointillize", name: "Pointillize", category: "Pixelate", params: [size(10)], apply: (src, p) => pointillize(src, n(p, "size", 10)) },
  { id: "color-halftone", name: "Color Halftone", category: "Pixelate", params: [size(8), angle(45)], apply: (src, p) => halftone(src, n(p, "size", 8), n(p, "angle", 45)) },
  { id: "fragment", name: "Fragment", category: "Pixelate", params: [amount(1, 100, 20)], apply: (src, p) => diffuse(src, n(p, "amount", 20)) },
  { id: "mezzotint", name: "Mezzotint", category: "Pixelate", params: [amount(1, 100, 40)], apply: (src, p) => mapRgb(src, (color) => { const v = Math.random() < n(p, "amount", 40) / 100 ? 255 : 0; return { r: v, g: v, b: v }; }) },

  // Stylize
  { id: "emboss", name: "Emboss", category: "Stylize", params: [amount(1, 10, 2), angle(135)], apply: (src, p) => emboss(src, n(p, "amount", 2), n(p, "angle", 135)) },
  { id: "find-edges", name: "Find Edges", category: "Stylize", params: [amount(1, 200, 100)], apply: (src, p) => findEdges(src, n(p, "amount", 100)) },
  { id: "trace-contour", name: "Trace Contour", category: "Stylize", params: [level(128, 0, 255)], apply: (src, p) => stylizeEdges(src, n(p, "levels", 128)) },
  { id: "solarize", name: "Solarize", category: "Stylize", params: [level(128, 0, 255)], apply: (src, p) => solarize(src, n(p, "levels", 128)) },
  { id: "oil-paint", name: "Oil Paint", category: "Stylize", params: [radius(4), { key: "levels", label: "Bristle Detail", kind: "range", min: 2, max: 32, step: 1, default: 12 }], apply: (src, p) => oilPaint(src, n(p, "radius", 4), n(p, "levels", 12)) },
  { id: "neon-glow", name: "Neon Glow", category: "Stylize", params: [amount(1, 100, 45), { key: "radius", label: "Glow Radius", kind: "range", min: 1, max: 20, step: 1, default: 4 }], apply: (src, p) => stylizeEdges(src, n(p, "amount", 45), true) },
  { id: "glowing-edges", name: "Glowing Edges", category: "Stylize", params: [amount(1, 100, 50)], apply: (src, p) => stylizeEdges(src, n(p, "amount", 50), true) },
  { id: "wind", name: "Wind", category: "Stylize", params: [amount(1, 100, 8), direction("right")], apply: (src, p) => wind(src, n(p, "amount", 8), s(p, "direction", "right")) },
  { id: "diffuse", name: "Diffuse", category: "Stylize", params: [amount(1, 50, 5)], apply: (src, p) => diffuse(src, n(p, "amount", 5)) },

  // Artistic
  { id: "watercolor", name: "Watercolor", category: "Artistic", params: [size(12), { key: "detail", label: "Detail", kind: "range", min: 1, max: 100, step: 1, default: 35 }], apply: (src, p) => watercolor(src, n(p, "detail", 35)) },
  { id: "dry-brush", name: "Dry Brush", category: "Artistic", params: [size(8), { key: "detail", label: "Detail", kind: "range", min: 1, max: 100, step: 1, default: 30 }], apply: (src, p) => dryBrush(src, n(p, "size", 8), n(p, "detail", 30)) },
  { id: "poster-edges", name: "Poster Edges", category: "Artistic", params: [level(6), amount(0, 100, 50, "Edge Intensity")], apply: (src, p) => posterEdges(src, n(p, "levels", 6), n(p, "amount", 50)) },
  { id: "cutout", name: "Cutout", category: "Artistic", params: [level(6)], apply: (src, p) => cutout(src, n(p, "levels", 6)) },
  { id: "film-grain", name: "Film Grain", category: "Artistic", params: [amount(1, 100, 30), size(4)], apply: (src, p) => filmGrain(src, n(p, "amount", 30), n(p, "size", 4)) },
  { id: "fresco", name: "Fresco", category: "Artistic", params: [size(8), { key: "texture", label: "Texture", kind: "range", min: 0, max: 100, step: 1, default: 25 }], apply: (src, p) => fresco(src, n(p, "size", 8), n(p, "texture", 25)) },
  { id: "paint-daubs", name: "Paint Daubs", category: "Artistic", params: [size(8), { key: "sharpness", label: "Sharpness", kind: "range", min: 1, max: 100, step: 1, default: 35 }], apply: (src, p) => paintDaubs(src, n(p, "size", 8), n(p, "sharpness", 35)) },
  { id: "palette-knife", name: "Palette Knife", category: "Artistic", params: [size(8), { key: "detail", label: "Detail", kind: "range", min: 1, max: 100, step: 1, default: 40 }], apply: (src, p) => paletteKnife(src, n(p, "size", 8), n(p, "detail", 40)) },
  { id: "plastic-wrap", name: "Plastic Wrap", category: "Artistic", params: [amount(1, 100, 40, "Strength"), { key: "detail", label: "Detail", kind: "range", min: 1, max: 100, step: 1, default: 20 }], apply: (src, p) => plasticWrap(src, n(p, "amount", 40), n(p, "detail", 20)) },
  { id: "rough-pastels", name: "Rough Pastels", category: "Artistic", params: [size(8), { key: "texture", label: "Texture", kind: "range", min: 0, max: 100, step: 1, default: 30 }], apply: (src, p) => roughPastels(src, n(p, "size", 8), n(p, "texture", 30)) },
  { id: "smudge-stick", name: "Smudge Stick", category: "Artistic", params: [size(8), { key: "detail", label: "Detail", kind: "range", min: 1, max: 100, step: 1, default: 35 }], apply: (src, p) => smudgeStick(src, n(p, "size", 8), n(p, "detail", 35)) },
  { id: "sponge", name: "Sponge", category: "Artistic", params: [size(8), { key: "definition", label: "Definition", kind: "range", min: 1, max: 100, step: 1, default: 25 }], apply: (src, p) => sponge(src, n(p, "size", 8), n(p, "definition", 25)) },
  { id: "underpainting", name: "Underpainting", category: "Artistic", params: [size(12), { key: "texture", label: "Texture", kind: "range", min: 1, max: 100, step: 1, default: 30 }], apply: (src, p) => underpainting(src, n(p, "size", 12), n(p, "texture", 30)) },
  { id: "colored-pencil", name: "Colored Pencil", category: "Artistic", params: [size(8), { key: "detail", label: "Detail", kind: "range", min: 1, max: 100, step: 1, default: 40 }], apply: (src, p) => coloredPencil(src, n(p, "size", 8), n(p, "detail", 40)) },

  // Brush Strokes
  { id: "accented-edges", name: "Accented Edges", category: "Brush Strokes", params: [size(4), amount(1, 100, 50, "Brightness")], apply: (src, p) => accentedEdges(src, n(p, "size", 4), n(p, "amount", 50)) },
  { id: "angled-strokes", name: "Angled Strokes", category: "Brush Strokes", params: [amount(0, 100, 50, "Direction Balance"), size(8, 1, 50, "Stroke Length"), { key: "sharpness", label: "Sharpness", kind: "range", min: 1, max: 100, step: 1, default: 30 }], apply: (src, p) => angledStrokes(src, n(p, "amount", 50), n(p, "size", 8), n(p, "sharpness", 30)) },
  { id: "crosshatch", name: "Crosshatch", category: "Brush Strokes", params: [size(8, 1, 50, "Stroke Length"), { key: "sharpness", label: "Sharpness", kind: "range", min: 1, max: 100, step: 1, default: 30 }], apply: (src, p) => crosshatch(src, n(p, "size", 8), n(p, "sharpness", 30)) },
  { id: "dark-strokes", name: "Dark Strokes", category: "Brush Strokes", params: [amount(0, 100, 50, "Balance"), { key: "blackIntensity", label: "Black Intensity", kind: "range", min: 1, max: 100, step: 1, default: 50 }], apply: (src, p) => darkStrokes(src, n(p, "amount", 50), n(p, "blackIntensity", 50)) },
  { id: "ink-outlines", name: "Ink Outlines", category: "Brush Strokes", params: [size(4), { key: "darkIntensity", label: "Dark Intensity", kind: "range", min: 1, max: 100, step: 1, default: 50 }], apply: (src, p) => inkOutlines(src, n(p, "size", 4), n(p, "darkIntensity", 50)) },
  { id: "spatter", name: "Spatter", category: "Brush Strokes", params: [radius(8), { key: "smoothness", label: "Smoothness", kind: "range", min: 1, max: 100, step: 1, default: 15 }], apply: (src, p) => spatter(src, n(p, "radius", 8), n(p, "smoothness", 15)) },
  { id: "sprayed-strokes", name: "Sprayed Strokes", category: "Brush Strokes", params: [radius(8), direction("right")], apply: (src, p) => sprayedStrokes(src, n(p, "radius", 8), s(p, "direction", "right")) },
  { id: "sumi-e", name: "Sumi-e", category: "Brush Strokes", params: [size(4), { key: "pressure", label: "Pressure", kind: "range", min: 1, max: 100, step: 1, default: 30 }], apply: (src, p) => sumiE(src, n(p, "size", 4), n(p, "pressure", 30)) },

  // Sketch
  { id: "bas-relief", name: "Bas Relief", category: "Sketch", params: [amount(1, 20, 4, "Detail"), { key: "smoothness", label: "Smoothness", kind: "range", min: 1, max: 100, step: 1, default: 20 }], apply: (src, p) => basRelief(src, n(p, "amount", 4), n(p, "smoothness", 20)) },
  { id: "chalk-charcoal", name: "Chalk & Charcoal", category: "Sketch", params: [angle(45), { key: "strokeLength", label: "Stroke Length", kind: "range", min: 1, max: 50, step: 1, default: 8 }], apply: (src, p) => chalkCharcoal(src, n(p, "angle", 45), n(p, "strokeLength", 8)) },
  { id: "charcoal", name: "Charcoal", category: "Sketch", params: [size(4, 1, 50, "Thickness"), { key: "detail", label: "Detail", kind: "range", min: 1, max: 100, step: 1, default: 30 }], apply: (src, p) => charcoal(src, n(p, "size", 4), n(p, "detail", 30)) },
  { id: "chrome", name: "Chrome", category: "Sketch", params: [amount(1, 20, 4, "Detail"), { key: "smoothness", label: "Smoothness", kind: "range", min: 1, max: 100, step: 1, default: 20 }], apply: (src, p) => chrome(src, n(p, "amount", 4), n(p, "smoothness", 20)) },
  { id: "conte-crayon", name: "Conté Crayon", category: "Sketch", params: [{ key: "foreground", label: "Foreground", kind: "range", min: 0, max: 255, step: 1, default: 30 }, { key: "background", label: "Background", kind: "range", min: 0, max: 255, step: 1, default: 220 }], apply: (src, p) => conteCrayon(src, n(p, "foreground", 30), n(p, "background", 220)) },
  { id: "graphic-pen", name: "Graphic Pen", category: "Sketch", params: [size(8, 1, 50, "Stroke Length"), direction("right")], apply: (src, p) => graphicPen(src, n(p, "size", 8), s(p, "direction", "right")) },
  { id: "halftone-pattern", name: "Halftone Pattern", category: "Sketch", params: [size(8), { key: "contrast", label: "Contrast", kind: "range", min: 0, max: 100, step: 1, default: 30 }], apply: (src, p) => halftonePattern(src, n(p, "size", 8), n(p, "contrast", 30)) },
  { id: "note-paper", name: "Note Paper", category: "Sketch", params: [amount(1, 100, 50, "Image Balance"), { key: "graininess", label: "Graininess", kind: "range", min: 1, max: 100, step: 1, default: 20 }], apply: (src, p) => notePaper(src, n(p, "amount", 50), n(p, "graininess", 20)) },
  { id: "photocopy", name: "Photocopy", category: "Sketch", params: [amount(1, 20, 5, "Detail"), { key: "darkness", label: "Darkness", kind: "range", min: 1, max: 100, step: 1, default: 30 }], apply: (src, p) => photocopy(src, n(p, "amount", 5), n(p, "darkness", 30)) },
  { id: "plaster", name: "Plaster", category: "Sketch", params: [amount(1, 100, 50, "Image Balance"), { key: "smoothness", label: "Smoothness", kind: "range", min: 1, max: 100, step: 1, default: 20 }], apply: (src, p) => plaster(src, n(p, "amount", 50), n(p, "smoothness", 20)) },
  { id: "reticulation", name: "Reticulation", category: "Sketch", params: [amount(1, 100, 50, "Density"), { key: "foreground", label: "Foreground", kind: "range", min: 0, max: 255, step: 1, default: 40 }], apply: (src, p) => reticulation(src, n(p, "amount", 50), n(p, "foreground", 40)) },
  { id: "stamp", name: "Stamp", category: "Sketch", params: [{ key: "smoothness", label: "Smoothness", kind: "range", min: 1, max: 100, step: 1, default: 20 }], apply: (src, p) => stamp(src, n(p, "smoothness", 20)) },
  { id: "torn-edges", name: "Torn Edges", category: "Sketch", params: [amount(1, 100, 50, "Image Balance"), { key: "smoothness", label: "Smoothness", kind: "range", min: 1, max: 100, step: 1, default: 20 }], apply: (src, p) => tornEdges(src, n(p, "amount", 50), n(p, "smoothness", 20)) },
  { id: "water-paper", name: "Water Paper", category: "Sketch", params: [size(8, 1, 50, "Fiber Length"), { key: "brightness", label: "Brightness", kind: "range", min: -100, max: 100, step: 1, default: 0 }], apply: (src, p) => waterPaper(src, n(p, "size", 8), n(p, "brightness", 0)) },

  // Texture
  { id: "craquelure", name: "Craquelure", category: "Texture", params: [size(20, 3, 100, "Crack Spacing"), { key: "depth", label: "Crack Depth", kind: "range", min: 1, max: 100, step: 1, default: 20 }], apply: (src, p) => craquelure(src, n(p, "size", 20), n(p, "depth", 20)) },
  { id: "grain-texture", name: "Grain", category: "Texture", params: [amount(1, 100, 20)], apply: (src, p) => grain(src, n(p, "amount", 20)) },
  { id: "mosaic-tiles", name: "Mosaic Tiles", category: "Texture", params: [size(16), { key: "grout", label: "Grout Width", kind: "range", min: 0, max: 10, step: 1, default: 2 }], apply: (src, p) => mosaicTiles(src, n(p, "size", 16), n(p, "grout", 2)) },
  { id: "patchwork", name: "Patchwork", category: "Texture", params: [size(12), { key: "relief", label: "Relief", kind: "range", min: 0, max: 50, step: 1, default: 10 }], apply: (src, p) => patchwork(src, n(p, "size", 12), n(p, "relief", 10)) },
  { id: "stained-glass", name: "Stained Glass", category: "Texture", params: [size(14), { key: "light", label: "Light Intensity", kind: "range", min: 1, max: 100, step: 1, default: 30 }], apply: (src, p) => stainedGlass(src, n(p, "size", 14), n(p, "light", 30)) },
  { id: "texturizer", name: "Texturizer", category: "Texture", params: [texture(), size(8, 1, 100, "Scaling"), { key: "relief", label: "Relief", kind: "range", min: 1, max: 50, step: 1, default: 10 }], apply: (src, p) => texturizer(src, s(p, "texture", "canvas"), n(p, "size", 8), n(p, "relief", 10)) },

  // Render
  { id: "clouds", name: "Clouds", category: "Render", params: [size(30, 2, 200, "Scale"), { key: "seed", label: "Seed", kind: "range", min: 0, max: 999, step: 1, default: 7 }], apply: (src, p) => clouds(src, n(p, "size", 30), n(p, "seed", 7)) },
  { id: "difference-clouds", name: "Difference Clouds", category: "Render", params: [size(30, 2, 200, "Scale"), { key: "seed", label: "Seed", kind: "range", min: 0, max: 999, step: 1, default: 7 }], apply: (src, p) => differenceClouds(src, n(p, "size", 30), n(p, "seed", 7)) },
  { id: "fibers", name: "Fibers", category: "Render", params: [amount(1, 100, 16, "Variance"), { key: "strength", label: "Strength", kind: "range", min: 1, max: 100, step: 1, default: 40 }], apply: (src, p) => fibers(src, n(p, "amount", 16), n(p, "strength", 40)) },
  { id: "lens-flare", name: "Lens Flare", category: "Render", params: [amount(1, 100, 40, "Brightness")], apply: (src, p) => lensFlare(src, n(p, "amount", 40)) },

  // Other
  { id: "high-pass", name: "High Pass", category: "Other", params: [radius(10)], apply: (src, p) => highPass(src, n(p, "radius", 10)) },
  { id: "offset", name: "Offset", category: "Other", params: [{ key: "horizontal", label: "Horizontal", kind: "range", min: -500, max: 500, step: 1, default: 20 }, { key: "vertical", label: "Vertical", kind: "range", min: -500, max: 500, step: 1, default: 20 }], apply: (src, p) => offset(src, n(p, "horizontal", 20), n(p, "vertical", 20)) },
  { id: "minimum", name: "Minimum", category: "Other", params: [radius(1)], apply: (src, p) => morphology(src, n(p, "radius", 1), false) },
  { id: "maximum", name: "Maximum", category: "Other", params: [radius(1)], apply: (src, p) => morphology(src, n(p, "radius", 1), true) },
  { id: "custom-convolution", name: "Custom Convolution", category: "Other", params: [amount(0, 200, 20, "Strength")], apply: (src, p) => applyCustomConvolution(src, n(p, "amount", 20)) },

  // Color
  { id: "brightness-contrast", name: "Brightness / Contrast", category: "Color", params: [{ key: "brightness", label: "Brightness", kind: "range", min: -100, max: 100, step: 1, default: 0 }, { key: "contrast", label: "Contrast", kind: "range", min: -100, max: 100, step: 1, default: 0 }], apply: (src, p) => brightnessContrast(src, n(p, "brightness", 0), n(p, "contrast", 0)) },
  { id: "levels", name: "Levels", category: "Color", params: [{ key: "black", label: "Black", kind: "range", min: 0, max: 255, step: 1, default: 0 }, { key: "white", label: "White", kind: "range", min: 0, max: 255, step: 1, default: 255 }, { key: "gamma", label: "Gamma", kind: "range", min: 0.1, max: 3, step: 0.01, default: 1 }], apply: (src, p) => levels(src, n(p, "black", 0), n(p, "white", 255), n(p, "gamma", 1)) },
  { id: "curves", name: "Curves", category: "Color", params: [{ key: "gamma", label: "Midtones", kind: "range", min: 0.2, max: 3, step: 0.01, default: 1 }, { key: "contrast", label: "Contrast", kind: "range", min: -100, max: 100, step: 1, default: 0 }], apply: (src, p) => brightnessContrast(levels(src, 0, 255, n(p, "gamma", 1)), 0, n(p, "contrast", 0)) },
  { id: "exposure", name: "Exposure", category: "Color", params: [{ key: "stops", label: "Exposure", kind: "range", min: -3, max: 3, step: 0.05, default: 0 }], apply: (src, p) => exposure(src, n(p, "stops", 0)) },
  { id: "vibrance", name: "Vibrance", category: "Color", params: [amount(-100, 100, 25)], apply: (src, p) => vibrance(src, n(p, "amount", 25)) },
  { id: "hue-saturation", name: "Hue / Saturation", category: "Color", params: [{ key: "hue", label: "Hue", kind: "range", min: -180, max: 180, step: 1, default: 0 }, { key: "saturation", label: "Saturation", kind: "range", min: -100, max: 100, step: 1, default: 0 }, { key: "lightness", label: "Lightness", kind: "range", min: -100, max: 100, step: 1, default: 0 }], apply: (src, p) => hueSaturation(src, n(p, "hue", 0), n(p, "saturation", 0), n(p, "lightness", 0)) },
  { id: "color-balance", name: "Color Balance", category: "Color", params: [{ key: "red", label: "Red / Cyan", kind: "range", min: -100, max: 100, step: 1, default: 0 }, { key: "green", label: "Green / Magenta", kind: "range", min: -100, max: 100, step: 1, default: 0 }, { key: "blue", label: "Blue / Yellow", kind: "range", min: -100, max: 100, step: 1, default: 0 }], apply: (src, p) => colorBalance(src, n(p, "red", 0), n(p, "green", 0), n(p, "blue", 0)) },
  { id: "black-white", name: "Black & White", category: "Color", params: [{ key: "red", label: "Reds", kind: "range", min: 0, max: 200, step: 1, default: 30 }, { key: "green", label: "Greens", kind: "range", min: 0, max: 200, step: 1, default: 59 }, { key: "blue", label: "Blues", kind: "range", min: 0, max: 200, step: 1, default: 11 }], apply: (src, p) => blackWhite(src, n(p, "red", 30), n(p, "green", 59), n(p, "blue", 11)) },
  { id: "photo-filter", name: "Photo Filter", category: "Color", params: [{ key: "color", label: "Color", kind: "color", default: "#ec8a3c" }, amount(0, 100, 25, "Density")], apply: (src, p) => photoFilter(src, s(p, "color", "#ec8a3c"), n(p, "amount", 25)) },
  { id: "channel-mixer", name: "Channel Mixer", category: "Color", params: [{ key: "rr", label: "Red R", kind: "range", min: -200, max: 200, step: 1, default: 100 }, { key: "rg", label: "Red G", kind: "range", min: -200, max: 200, step: 1, default: 0 }, { key: "rb", label: "Red B", kind: "range", min: -200, max: 200, step: 1, default: 0 }, { key: "gr", label: "Green R", kind: "range", min: -200, max: 200, step: 1, default: 0 }, { key: "gg", label: "Green G", kind: "range", min: -200, max: 200, step: 1, default: 100 }, { key: "gb", label: "Green B", kind: "range", min: -200, max: 200, step: 1, default: 0 }, { key: "br", label: "Blue R", kind: "range", min: -200, max: 200, step: 1, default: 0 }, { key: "bg", label: "Blue G", kind: "range", min: -200, max: 200, step: 1, default: 0 }, { key: "bb", label: "Blue B", kind: "range", min: -200, max: 200, step: 1, default: 100 }], apply: (src, p) => channelMixer(src, n(p, "rr", 100), n(p, "rg", 0), n(p, "rb", 0), n(p, "gr", 0), n(p, "gg", 100), n(p, "gb", 0), n(p, "br", 0), n(p, "bg", 0), n(p, "bb", 100)) },
  { id: "gradient-map", name: "Gradient Map", category: "Color", params: [colorA(), colorB()], apply: (src, p) => gradientMap(src, s(p, "shadow", "#1f2937"), s(p, "highlight", "#f8fafc")) },
  { id: "invert", name: "Invert", category: "Color", params: [], apply: (src) => invert(src) },
  { id: "posterize", name: "Posterize", category: "Color", params: [level(6)], apply: (src, p) => posterize(src, n(p, "levels", 6)) },
  { id: "threshold", name: "Threshold", category: "Color", params: [level(128, 0, 255)], apply: (src, p) => threshold(src, n(p, "levels", 128)) },
  { id: "selective-color", name: "Selective Color", category: "Color", params: [{ key: "hue", label: "Hue", kind: "range", min: 0, max: 360, step: 1, default: 20 }, { key: "saturation", label: "Saturation", kind: "range", min: -100, max: 100, step: 1, default: 20 }, { key: "lightness", label: "Lightness", kind: "range", min: -100, max: 100, step: 1, default: 0 }], apply: (src, p) => selectiveColor(src, n(p, "hue", 20), n(p, "saturation", 20), n(p, "lightness", 0)) },
];

export function getFilter(id: string) {
  return FILTERS.find((filter) => filter.id === id) ?? FILTERS[0];
}

export function defaultFilterParams(filter: FilterDefinition): Record<string, FilterValue> {
  return Object.fromEntries(filter.params.map((param) => [param.key, param.default]));
}

export function filterCategoriesWithCounts() {
  return FILTER_CATEGORIES.map((category) => ({
    category,
    count: FILTERS.filter((filter) => filter.category === category).length,
  }));
}
