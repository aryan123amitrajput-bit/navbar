/**
 * Renders the full navigation bar (capsule + nested selection lens + icons) with CanvasKit.
 *
 * Purpose: validate the *composition*, not just the shader. Nested backdrop filters are the risky
 * part of the design, so this script runs the capsule pass, then runs the lens pass over the result
 * — exactly the order the on-device renderer uses.
 */
import CanvasKitInit from 'canvaskit-wasm';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ts = readFileSync(join(__dirname, '../src/shader.ts'), 'utf8');
const SHADER = ts.match(/export const LIQUID_GLASS_SHADER = `([\s\S]*?)`;/)[1];

const CanvasKit = await CanvasKitInit({});

const W = 390, H = 700;
const BAR_W = 354, BAR_H = 66, BAR_X = 18, BAR_Y = 600, R = 33;
const SLOT = BAR_W / 4;
const LENS_INSET = 6;
const LENS_W = SLOT - LENS_INSET * 2, LENS_H = BAR_H - LENS_INSET * 2;
const SELECTED = 1;

const hex = (c) => {
  const h = c.replace('#', '');
  return [parseInt(h.slice(0,2),16)/255, parseInt(h.slice(2,4),16)/255, parseInt(h.slice(4,6),16)/255];
};
const rgba = (c, a) => [...hex(c), a];

const surface = CanvasKit.MakeSurface(W, H);
const canvas = surface.getCanvas();

// ---------------- scene ----------------
const basePaint = new CanvasKit.Paint();
basePaint.setShader(CanvasKit.Shader.MakeLinearGradient([0,0],[0,H],
  [rgba('#06070D',1), rgba('#0B1730',1), rgba('#04050A',1)], [0,0.45,1], CanvasKit.TileMode.Clamp));
canvas.drawRect(CanvasKit.XYWHRect(0,0,W,H), basePaint);

const ribbon = (cx, cy, r, color, alpha, deg) => {
  const p = new CanvasKit.Paint();
  p.setShader(CanvasKit.Shader.MakeRadialGradient([cx,cy], r,
    [rgba(color,alpha), rgba(color,alpha*0.42), [0,0,0,0]], [0,0.45,1], CanvasKit.TileMode.Clamp));
  canvas.save(); canvas.rotate(deg, cx, cy);
  canvas.drawOval(CanvasKit.XYWHRect(cx-r, cy-r*0.55, r*2, r*1.1), p);
  canvas.restore();
};
ribbon(W*0.18, H*0.2, W*0.82, '#3B2A6B', 0.85, 22);
ribbon(W*0.92, H*0.14, W*0.66, '#1E6E8C', 0.72, 12);
ribbon(W*0.72, H*0.66, W*0.74, '#7A2A5E', 0.62, -8);
ribbon(W*0.1, H*0.82, W*0.62, '#1E6E8C', 0.5, 34);
ribbon(W*0.52, H*1.02, W*0.55, '#8A4B2C', 0.4, -6);

// Cards that sit behind the bar — the refraction must bend these.
const cardPaint = new CanvasKit.Paint();
cardPaint.setColor(CanvasKit.Color4f(1,1,1,0.07));
const avatar = (x, y, color) => {
  const p = new CanvasKit.Paint();
  p.setColor(CanvasKit.Color4f(...hex(color), 0.92));
  canvas.drawCircle(x, y, 21, p);
};
const bar = (x,y,w,h,a) => {
  const p = new CanvasKit.Paint();
  p.setColor(CanvasKit.Color4f(1,1,1,a));
  canvas.drawRRect(CanvasKit.RRectXY(CanvasKit.XYWHRect(x,y,w,h), h/2, h/2), p);
};
for (let i = 0; i < 4; i++) {
  const y = 545 + i * 86;
  canvas.drawRRect(CanvasKit.RRectXY(CanvasKit.XYWHRect(22,y,346,74), 22,22), cardPaint);
  avatar(22+16+21, y+37, ['#6EA8FF','#9D7BFF','#4ED6C0','#FF8FBF'][i]);
  bar(22+72, y+37-13, 132, 7, 0.28);
  bar(22+72, y+37+4, 92, 6, 0.14);
}

// ---------------- glass helpers ----------------
const effect = CanvasKit.RuntimeEffect.Make(SHADER);
if (!effect) { console.error('SHADER FAILED'); process.exit(1); }

/**
 * Blurs a snapshot with a real gaussian, mirroring <Blur> as a child of <RuntimeShader>.
 */
function blurImage(img, sigma) {
  if (sigma <= 0) return img;
  const scratch = CanvasKit.MakeSurface(W, H);
  const sc = scratch.getCanvas();
  const p = new CanvasKit.Paint();
  p.setImageFilter(
    CanvasKit.ImageFilter.MakeBlur(sigma, sigma, CanvasKit.TileMode.Clamp, null),
  );
  sc.drawImage(img, 0, 0, p);
  return scratch.makeImageSnapshot();
}

/**
 * One backdrop-filter pass, emulated the way Skia defines it:
 *   1. snapshot everything already painted (device space),
 *   2. re-project that snapshot into the pane's local space,
 *   3. run the shader over it with NO local matrix (the pane fills 0,0..w,h),
 *   4. draw the result at the pane's device position.
 *
 * Doing it this way means nested passes behave exactly like nested <BackdropFilter>s on device.
 */
function glassPass(surface, canvas, pane, uniforms, sigma = 0) {
  const src = blurImage(surface.makeImageSnapshot(), sigma);

  // 2. pane-local backdrop
  const local = CanvasKit.MakeSurface(Math.ceil(pane.width), Math.ceil(pane.height));
  const lc = local.getCanvas();
  lc.clear(CanvasKit.Color4f(0, 0, 0, 0));
  lc.drawImage(src, -pane.x, -pane.y);

  const child = local
    .makeImageSnapshot()
    .makeShaderOptions(
      CanvasKit.TileMode.Clamp,
      CanvasKit.TileMode.Clamp,
      CanvasKit.FilterMode.Linear,
      CanvasKit.MipmapMode.None,
    );

  const paint = new CanvasKit.Paint();
  paint.setShader(effect.makeShaderWithChildren(flat(uniforms), [child]));
  paint.setBlendMode(CanvasKit.BlendMode.Src);

  canvas.save();
  canvas.translate(pane.x, pane.y);
  canvas.clipRRect(
    CanvasKit.RRectXY(
      CanvasKit.XYWHRect(0, 0, pane.width, pane.height),
      pane.radius,
      pane.radius,
    ),
    true,
  );
  canvas.drawRect(CanvasKit.XYWHRect(0, 0, pane.width, pane.height), paint);
  canvas.restore();
}

function flat(uniforms) {
  const out = [];
  for (const k of Object.keys(uniforms)) out.push(...[].concat(uniforms[k]));
  return out;
}

// ---------------- 1. capsule ----------------
glassPass(surface, canvas, { x: BAR_X, y: BAR_Y, width: BAR_W, height: BAR_H, radius: R }, {
  size: [BAR_W, BAR_H],
  radius: R,
  band: BAR_H * 0.55 * 0.5,
  push: 9, dip: 4, chroma: 1.3,
  rim: 0.8, specular: 0.5, inner: 0.22, fringe: 0.5,
  diffusion: 1.4,
  frostAmount: 0.32,
  tintTop: rgba('#FFFFFF', 0.17),
  tintBottom: rgba('#FFFFFF', 0.07),
  lightDir: [-0.55, -0.83],
}, 5);

// ---------------- 2. lens (refracts the capsule) ----------------
const lensX = BAR_X + LENS_INSET + SELECTED * SLOT;
const lensY = BAR_Y + LENS_INSET;
glassPass(surface, canvas, { x: lensX, y: lensY, width: LENS_W, height: LENS_H, radius: LENS_H / 2 }, {
  size: [LENS_W, LENS_H],
  radius: LENS_H / 2,
  band: LENS_H * 0.9 * 0.5,
  push: 13, dip: 6, chroma: 2.0,
  rim: 0.5, specular: 0.38, inner: 0.2, fringe: 0.65,
  diffusion: 1.8,
  frostAmount: 0.18,
  tintTop: rgba('#FFFFFF', 0.15),
  tintBottom: rgba('#FFFFFF', 0.055),
  lightDir: [-0.55, -0.83],
}, 2);

// ---------------- 3. hairlines ----------------
const edge = new CanvasKit.Paint();
edge.setStyle(CanvasKit.PaintStyle.Stroke);
edge.setStrokeWidth(1.2);
edge.setColor(CanvasKit.Color4f(1,1,1,0.34));
canvas.drawRRect(CanvasKit.RRectXY(CanvasKit.XYWHRect(BAR_X+1, BAR_Y+1, BAR_W-2, BAR_H-2), R-1, R-1), edge);

const lensEdge = new CanvasKit.Paint();
lensEdge.setStyle(CanvasKit.PaintStyle.Stroke);
lensEdge.setStrokeWidth(1);
lensEdge.setColor(CanvasKit.Color4f(1,1,1,0.42));
canvas.drawRRect(CanvasKit.RRectXY(CanvasKit.XYWHRect(lensX+1, lensY+1, LENS_W-2, LENS_H-2), LENS_H/2-1, LENS_H/2-1), lensEdge);

// ---------------- 4. icons ----------------
// Hand-drawn glyph paths so the preview matches the Ionicons used on device.
const GLYPHS = {
  home: 'M6 11 L12 5.5 L18 11 M7.6 10.2 V18.6 H16.4 V10.2 M10.5 18.6 V14.4 H13.5 V18.6',
  search: 'M14.2 10.6 A3.6 3.6 0 1 1 7 10.6 A3.6 3.6 0 1 1 14.2 10.6 M13.3 13.9 L17 17.6',
  bell: 'M6.6 16 H17.4 C17.4 16 16.2 14.6 16.2 11.2 C16.2 8.6 14.4 6.8 12 6.8 C9.6 6.8 7.8 8.6 7.8 11.2 C7.8 14.6 6.6 16 6.6 16 Z M10.4 18.4 C10.8 19 11.3 19.2 12 19.2 C12.7 19.2 13.2 19 13.6 18.4',
  person: 'M15.4 9.4 A3.4 3.4 0 1 1 8.6 9.4 A3.4 3.4 0 1 1 15.4 9.4 M5.6 19 C5.9 16 8.4 14 12 14 C15.6 14 18.1 16 18.4 19',
};
const KEYS = ['home','search','bell','person'];
// Inverse of the app's scale mapping: active = 0.9 + 0.16, idle = 0.9.
const iconPaint = new CanvasKit.Paint();
iconPaint.setStyle(CanvasKit.PaintStyle.Stroke);
iconPaint.setStrokeCap(CanvasKit.StrokeCap.Round);
iconPaint.setStrokeJoin(CanvasKit.StrokeJoin.Round);

KEYS.forEach((key, i) => {
  const cx = BAR_X + SLOT * (i + 0.5);
  const cy = BAR_Y + BAR_H / 2 - 4;
  const active = i === SELECTED;
  iconPaint.setStrokeWidth(1.85);
  iconPaint.setColor(CanvasKit.Color4f(1, 1, 1, active ? 1 : 0.62));
  const path = CanvasKit.Path.MakeFromSVGString(GLYPHS[key]);
  const scale = active ? 1.06 : 0.9;
  canvas.save();
  canvas.translate(cx, cy);
  canvas.scale(scale, scale);
  canvas.translate(-12, -12);
  canvas.drawPath(path, iconPaint);
  canvas.restore();
});

const png = surface.makeImageSnapshot().encodeToBytes();
mkdirSync(join(__dirname, 'out'), { recursive: true });
writeFileSync(join(__dirname, 'out/navbar-preview.png'), png);
console.log('wrote tools/out/navbar-preview.png');
