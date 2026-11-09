/**
 * Renders the liquid glass shader with CanvasKit (Skia compiled to WASM).
 *
 * This is the same SkSL that runs on device, so it doubles as a validation step: if the shader has a
 * type error or uses an unsupported feature, `RuntimeEffect.Make` returns null and this script fails
 * loudly. It also writes PNG previews so the optics can be reviewed without a phone.
 *
 * Usage: node tools/preview-shader.mjs   (needs `canvaskit-wasm` installed)
 */
import CanvasKitInit from 'canvaskit-wasm';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Pull the shader straight out of the app source so there is a single source of truth.
const { LIQUID_GLASS_SHADER } = await import('../src/shader.ts.mjs').catch(() => ({}));
const shaderSource = LIQUID_GLASS_SHADER ?? (await readShaderFromTs());

async function readShaderFromTs() {
  const { readFileSync } = await import('node:fs');
  const ts = readFileSync(join(__dirname, '../src/shader.ts'), 'utf8');
  const match = ts.match(/export const LIQUID_GLASS_SHADER = `([\s\S]*?)`;/);
  if (!match) throw new Error('Could not find LIQUID_GLASS_SHADER in src/shader.ts');
  return match[1];
}

const CanvasKit = await CanvasKitInit({ locateFile: (f) => `../../.cache/ck/node_modules/canvaskit-wasm/bin/${f}` });

const W = 390;
const H = 340;
const BAR = { x: 18, y: 240, width: 354, height: 66, radius: 33 };

const surface = CanvasKit.MakeSurface(W, H);
const canvas = surface.getCanvas();

// ---- 1. Scene: the same aurora field the app draws (gradients only, like Backdrop.tsx) ----
const scene = [
  [['#06070D', 0], ['#0B1730', 0.45], ['#04050A', 1]],
];
const bg = new CanvasKit.Paint();
bg.setShader(
  CanvasKit.Shader.MakeLinearGradient(
    [0, 0], [0, H],
    scene[0].map((c) => CanvasKit.Color4f(...hex(c[0]), 1)),
    scene[0].map((c) => c[1]),
    CanvasKit.TileMode.Clamp,
  ),
);
canvas.drawRect(CanvasKit.XYWHRect(0, 0, W, H), bg);

const ribbon = (cx, cy, r, color, alpha, rot) => {
  const paint = new CanvasKit.Paint();
  paint.setShader(
    CanvasKit.Shader.MakeRadialGradient(
      [cx, cy], r,
      [rgba(color, alpha), rgba(color, alpha * 0.42), [0, 0, 0, 0]],
      [0, 0.45, 1], CanvasKit.TileMode.Clamp,
    ),
  );
  canvas.save();
  canvas.rotate((rot * 180) / Math.PI, cx, cy);
  canvas.drawOval(CanvasKit.XYWHRect(cx - r, cy - r * 0.55, r * 2, r * 1.1), paint);
  canvas.restore();
};
ribbon(W * 0.18, H * 0.2, W * 0.82, '#3B2A6B', 0.85, 22);
ribbon(W * 0.92, H * 0.14, W * 0.66, '#1E6E8C', 0.72, 12);
ribbon(W * 0.72, H * 0.66, W * 0.74, '#7A2A5E', 0.62, -8);
ribbon(W * 0.1, H * 0.82, W * 0.62, '#1E6E8C', 0.5, 34);
ribbon(W * 0.52, H * 1.02, W * 0.55, '#8A4B2C', 0.4, -6);

// Reference objects behind the glass — these are what the optics must visibly bend.
const drawScene = canvas;
const accent = (x, y, w, h, color) => {
  const p = new CanvasKit.Paint();
  p.setColor(CanvasKit.Color4f(...hex(color), 0.95));
  drawScene.drawRRect(CanvasKit.RRectXY(CanvasKit.XYWHRect(x, y, w, h), h / 2, h / 2), p);
};
accent(40, 170, 46, 46, '#6EA8FF');
accent(100, 178, 150, 10, '#FFFFFF');
accent(280, 150, 46, 46, '#FF8FBF');
accent(40, 120, 120, 8, '#4ED6C0');
accent(220, 200, 90, 8, '#FFC46B');

// ---- 2. Glass ----
const effect = CanvasKit.RuntimeEffect.Make(shaderSource);
if (!effect) {
  console.error('SHADER COMPILE FAILED');
  process.exit(1);
}
const uniforms = {
  size: [BAR.width, BAR.height],
  radius: BAR.radius,
  band: BAR.height * 0.55 * 0.5,
  push: 9,
  dip: 4,
  chroma: 1.3,
  rim: 0.8,
  specular: 0.5,
  inner: 0.22,
  fringe: 0.5,
  diffusion: 2.6,
  tintTop: [...hex('#FFFFFF'), 0.17],
  tintBottom: [...hex('#FFFFFF'), 0.07],
  lightDir: [-0.55, -0.83],
};

const rr = CanvasKit.RRectXY(
  CanvasKit.XYWHRect(BAR.x, BAR.y, BAR.width, BAR.height),
  BAR.radius, BAR.radius,
);

// Backdrop filter: run the shader over the pixels already on the canvas, inside the clip.
canvas.save();
canvas.clipRRect(rr, true);
const img = surface.makeImageSnapshot();
// A real backdrop filter inherits the canvas CTM, so the child shader samples device pixels.
// Here the canvas is translated by the pane origin, so shift the image lookup by the same amount.
const backdropShader = img.makeShaderOptions(
  CanvasKit.TileMode.Clamp, CanvasKit.TileMode.Clamp,
  CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None,
  CanvasKit.Matrix.translated(-BAR.x, -BAR.y),
);
const glassPaint = new CanvasKit.Paint();
glassPaint.setShader(
  effect.makeShaderWithChildren(flatten(uniforms), [backdropShader]),
);
glassPaint.setBlendMode(CanvasKit.BlendMode.Src);
// The shader works in pane-local coordinates.
canvas.translate(BAR.x, BAR.y);
canvas.clipRRect(CanvasKit.RRectXY(CanvasKit.XYWHRect(0, 0, BAR.width, BAR.height), BAR.radius, BAR.radius), true);
canvas.drawRect(CanvasKit.XYWHRect(0, 0, BAR.width, BAR.height), glassPaint);
canvas.restore();

// Hairlines, matching GlassPane.tsx.
const stroke = new CanvasKit.Paint();
stroke.setStyle(CanvasKit.PaintStyle.Stroke);
stroke.setStrokeWidth(1);
stroke.setColor(CanvasKit.Color4f(1, 1, 1, 0.3));
canvas.drawRRect(rr, stroke);

const png = surface.makeImageSnapshot().encodeToBytes();
mkdirSync(join(__dirname, 'out'), { recursive: true });
writeFileSync(join(__dirname, 'out/glass-preview.png'), png);
console.log('shader compiled OK; wrote tools/out/glass-preview.png');

function hex(c) {
  const h = c.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}
function rgba(c, a) {
  const [r, g, b] = hex(c);
  return [r, g, b, a];
}
function flatten(obj) {
  const out = [];
  for (const k of Object.keys(obj)) out.push(...[].concat(obj[k]));
  return out;
}
