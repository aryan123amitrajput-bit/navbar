/**
 * Liquid Glass navigation bar — single-file version for Expo Snack.
 *
 * Everything lives in this one file on purpose: Snack gives you a single editor pane, so you can
 * paste this whole file, press Run, and see it on your phone without creating sibling modules.
 *
 * Why it looks like real glass and not a translucent rectangle:
 *  • A Skia runtime shader whose backdrop child is the snapshotted pixels behind the pane, so the
 *    glass genuinely refracts the scene instead of faking a tint.
 *  • Rounded-rect SDF plus an outward edge warp: pixels compress into the rim like a real lens.
 *  • Chromatic dispersion, edge-selective diffusion, a frost lift, an illuminated rim and a moving
 *    specular sweep.
 *  • A second, nested glass pane for the selection lens — it refracts the capsule's own glass.
 *  • Specular highlights drawn on top of the icons, so glyphs read as sitting *inside* the glass.
 *
 * Motion runs on the UI thread: one Reanimated shared value drives the lens, icons, labels and
 * glow, so a slide costs no React re-renders.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BackdropFilter,
  Blur,
  Canvas,
  Group,
  LinearGradient,
  Oval,
  Paint,
  RadialGradient,
  Rect,
  RoundedRect,
  RuntimeShader,
  Skia,
  vec,
  useClock,
} from '@shopify/react-native-skia';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  Easing,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

// ───────────────────────── src/tokens.ts ─────────────────────────
/**
 * Liquid Glass design tokens.
 *
 * Everything visual is expressed here so the look can be retuned without touching render code.
 * Values were picked against dark, colourful backdrops — the harshest case for translucent glass.
 */

const layout = {
  /** Height of the floating capsule. */
  barHeight: 66,
  /** Horizontal inset from the screen edges. */
  barSideInset: 18,
  /** Distance from the bottom safe-area inset. */
  barBottomGap: 12,
  /** Padding between the capsule edge and the selection lens. */
  lensInset: 6,
  /** Diameter of the icons. */
  iconSize: 23,
  /** Gap between icon and label. */
  iconLabelGap: 3,
  labelSize: 9.5,
  labelLetterSpacing: 0.4,
};

const palette = {
  ink: '#FFFFFF',
  inkIdle: 'rgba(255,255,255,0.62)',
  inkActive: '#FFFFFF',
  labelIdle: 'rgba(255,255,255,0.55)',
  labelActive: 'rgba(255,255,255,1)',
};

/**
 * Glass recipes.
 *
 * `rim`, `specular`, `inner` and `fringe` are tuned per surface: the big capsule gets a restrained
 * edge so it does not fight the content, while the small lens is brighter because it is the focal
 * point of the whole component.
 */
const glass = {
  bar: {
    /** Vertical tint over the refracted backdrop. */
    tintTop: 'rgba(255,255,255,0.17)',
    tintBottom: 'rgba(255,255,255,0.07)',
    /**
     * How far the refraction is lifted toward the glass's diffuse white. This is the single most
     * important value for the "luminous glass" read — too low and it looks like a dark scrim.
     */
    frost: 0.32,
    /** Gaussian blur sigma applied to the backdrop before refraction, in px. */
    blur: 10,
    /** Refracting band width as a fraction of the capsule height. */
    band: 0.55,
    /** Maximum optical squeeze in px at the rim. */
    push: 9,
    /** Extra pinch right at the edge, reads as thick glass. */
    dip: 4,
    /** Chromatic dispersion in px. */
    chroma: 1.3,
    /** Illuminated rim strength. */
    rim: 0.8,
    /** Sharp top-edge specular. */
    specular: 0.5,
    /** Dark inner bevel bottom-right. */
    inner: 0.22,
    /** Colour fringe strength. */
    fringe: 0.5,
    /** Ambient glow around the pane. */
    glow: 'rgba(140,215,255,0.55)',
    glowAlpha: 0.16,
  },
  lens: {
    tintTop: 'rgba(255,255,255,0.15)',
    tintBottom: 'rgba(255,255,255,0.055)',
    frost: 0.18,
    blur: 4,
    band: 0.9,
    push: 13,
    dip: 6,
    chroma: 2.0,
    rim: 0.5,
    specular: 0.38,
    inner: 0.2,
    fringe: 0.65,
    glow: 'rgba(180,235,255,0.65)',
    glowAlpha: 0.22,
  },
};

/** Spring used for the selection lens. Critically-tuned for a short overshoot. */
const spring = {
  damping: 17,
  stiffness: 190,
  mass: 0.9,
};

/** Backdrop palette (the aurora wallpaper the glass refracts). */
const aurora = {
  base: '#06070D',
  mid: '#0B1730',
  deep: '#04050A',
  violet: '#3B2A6B',
  cyan: '#1E6E8C',
  magenta: '#7A2A5E',
  warm: '#8A4B2C',
  cool: '#9CC4FF',
};

// ───────────────────────── src/shader.ts ─────────────────────────
/**
 * The liquid glass shader.
 *
 * This runs as a Skia *backdrop* shader: it receives a snapshot of the pixels already drawn behind
 * the glass (`uniform shader backdrop`) and returns what should be painted on the glass surface.
 * That is exactly what real glass does — it does not tint the scene, it bends it.
 *
 * Optics implemented here, in the order they are applied:
 *
 *  1. Rounded-rectangle SDF to find the distance from the rim.
 *  2. Edge warp: inside a narrow band near the rim, samples are pushed *outward* along the normal
 *     with a cubic falloff. Pixels therefore get compressed into the rim, which is the optical
 *     squeeze seen on the edge of a real lens.
 *  3. Chromatic dispersion: the red and blue channels are sampled at slightly different offsets,
 *     producing the faint colour fringe of thick glass.
 *  4. Diffusion: a cheap 5-tap blur that grows toward the rim, so the centre stays crisp and the
 *     edges go soft — a lens, not a frosted window.
 *  5. Tint, side shading and inner shadow.
 *  6. A directional specular sweep that follows the incident angle of the light.
 *
 * Uniforms are plain floats so the whole effect can be driven from a Reanimated worklet without
 * crossing back into JS on every frame.
 */

const LIQUID_GLASS_SHADER = `
uniform shader backdrop;

uniform float2 size;        // width/height of the glass pane, px
uniform float  radius;      // corner radius, px
uniform float  band;        // refracting rim width, px
uniform float  push;        // outward optical squeeze at the rim, px
uniform float  dip;         // extra pinch at the very edge, px
uniform float  chroma;      // chromatic dispersion, px
uniform float  rim;         // illuminated rim strength, 0..1
uniform float  specular;    // top specular strength, 0..1
uniform float  inner;       // inner bevel strength, 0..1
uniform float  fringe;      // colour fringe strength, 0..1
uniform float  diffusion;   // edge diffusion amount, px
uniform float  frostAmount; // how far the glass lifts toward its diffuse white

uniform float4 tintTop;     // straight (non-premultiplied) colour
uniform float4 tintBottom;

uniform float2 lightDir;    // normalised direction light comes from

float sdRoundRect(float2 p, float2 halfSize, float r) {
  float2 q = abs(p) - (halfSize - float2(r));
  float2 a = max(q, float2(0.0));
  return length(a) + min(max(q.x, q.y), 0.0) - r;
}

float4 over(float4 top, float4 bottom) {
  float a = top.a + bottom.a * (1.0 - top.a);
  if (a <= 0.0) { return float4(0.0); }
  float3 rgb = (top.rgb * top.a + bottom.rgb * bottom.a * (1.0 - top.a)) / a;
  return float4(rgb, a);
}

half4 main(float2 xy) {
  float2 halfSize = size * 0.5;
  float2 p = xy - halfSize;

  float sd = sdRoundRect(p, halfSize, radius);
  float depth = -sd;                                  // >0 inside the pane
  float t = clamp(depth / max(band, 0.001), 0.0, 1.0); // 0 at the very rim, 1 deep inside

  // ---- 1. outward normal of the rounded rect -------------------------------------------
  float2 q = abs(p) - (halfSize - float2(radius));
  float2 n;
  if (q.x > 0.0 && q.y > 0.0) {
    n = p / max(length(p), 0.0001);
  } else if (q.x > q.y) {
    n = float2(p.x < 0.0 ? -1.0 : 1.0, 0.0);
  } else {
    n = float2(0.0, p.y < 0.0 ? -1.0 : 1.0);
  }

  // ---- 2. edge warp: cubic ease-in so only the very rim is squeezed ---------------------
  float ease = 1.0 - t;
  ease = ease * ease * ease;
  float amount = push * ease + dip * ease * ease;
  float2 uv = xy + n * amount;

  // ---- 3. chromatic dispersion ----------------------------------------------------------
  float ca = chroma * ease;
  half4 centre = backdrop.eval(uv);
  half r = backdrop.eval(uv + n * ca).r;
  half b = backdrop.eval(uv - n * ca).b;
  float3 refracted = float3(r, centre.g, b);

  // ---- 4. lens diffusion: soft at the rim, crisp in the middle ---------------------------
  float spread = diffusion * (1.0 - t) * (1.0 - t);
  float4 blur = float4(refracted, 1.0);
  if (spread > 0.05) {
    float2 d = float2(spread, spread);
    half4 s1 = backdrop.eval(uv + float2(d.x, 0.0));
    half4 s2 = backdrop.eval(uv - float2(d.x, 0.0));
    half4 s3 = backdrop.eval(uv + float2(0.0, d.y));
    half4 s4 = backdrop.eval(uv - float2(0.0, d.y));
    float3 ring = float3((s1.r + s2.r + s3.r + s4.r) * 0.25,
                         (s1.g + s2.g + s3.g + s4.g) * 0.25,
                         (s1.b + s2.b + s3.b + s4.b) * 0.25);
    float mixAmount = clamp(spread / 6.0, 0.0, 0.55);
    blur.rgb = mix(refracted, ring, mixAmount);
  }

  // ---- 5. frosting: lift toward the glass's own diffuse white -----------------------------
  // Real glass does not only tint what is behind it, it scatters light and raises the whole
  // surface toward its own diffuse colour. This single line is what makes the pane read as
  // luminous glass instead of a dark scrim over a photograph.
  float4 body = float4(blur.rgb, 1.0);
  float luminance = dot(body.rgb, float3(0.2126, 0.7152, 0.0722));
  float frost = clamp(frostAmount * (1.0 - luminance * 0.85), 0.0, 0.85);
  body.rgb = mix(body.rgb, float3(0.90, 0.94, 1.0), frost);

  // Then the directional tint on top: a white wash, heavier at the top.
  float4 tint = mix(tintTop, tintBottom, clamp(xy.y / size.y, 0.0, 1.0));
  body.rgb = body.rgb + tint.rgb * tint.a;
  body.a = 1.0;

  // Top deck catches light, bottom gathers density.
  float vertical = clamp(xy.y / size.y, 0.0, 1.0);
  body.rgb += float3(0.13, 0.14, 0.17) * (1.0 - smoothstep(0.0, 0.42, vertical));

  // Directional bloom on the side the light comes from: glass catches light, it does not glow
  // evenly. Kept low so it lifts the surface without washing out the refraction underneath.
  float2 lightNormal = normalize(p + float2(0.0001));
  float facing = clamp(dot(lightNormal, lightDir), 0.0, 1.0);
  body.rgb += float3(0.9, 0.95, 1.0) * pow(facing, 3.0) * 0.10;
  body.rgb -= float3(0.10, 0.09, 0.08) * smoothstep(0.5, 1.0, vertical);

  // Thick wall: dark bevel concentrated on the bottom-right arc.
  float2 bd = (xy - halfSize) / halfSize;
  float lowerRight = clamp(dot(bd, normalize(float2(0.7, 0.7))) * 0.5 + 0.5, 0.0, 1.0);
  float wall = (1.0 - smoothstep(0.0, 1.0, t)) * lowerRight;
  body.rgb *= 1.0 - inner * wall;

  // ---- 6. rim illumination and specular sweep ------------------------------------------
  float edge = 1.0 - smoothstep(0.0, min(band, 18.0) * 0.55, depth);
  float topGlow = clamp(dot(-n, normalize(float2(0.0, -1.0))), 0.0, 1.0);
  float bottomGlow = clamp(dot(n, normalize(float2(0.0, 1.0))), 0.0, 1.0);

  body.rgb += float3(1.0) * edge * rim * (0.16 + 0.44 * topGlow);
  body.rgb += float3(0.68, 0.82, 1.0) * edge * rim * 0.30 * bottomGlow;

  // A narrow specular line that slides with the light direction.
  float specAngle = dot(normalize(p + float2(0.0001)), lightDir);
  float specBand = smoothstep(0.55, 1.0, specAngle);
  body.rgb += float3(1.0) * edge * specular * specBand * 0.85;

  // Chromatic fringe: warm on one side, cool on the other.
  float side = clamp(dot(normalize(p + float2(0.0001)), normalize(float2(1.0, -0.35))), -1.0, 1.0);
  body.rgb += float3(0.35, 0.75, 1.0) * max(side, 0.0) * edge * fringe * 0.16;
  body.rgb += float3(1.0, 0.55, 0.85) * max(-side, 0.0) * edge * fringe * 0.14;

  // Keep the alpha full: the pane's own clip defines the silhouette.
  body.a = 1.0;
  return half4(body.rgb, 1.0);
}
`;

// ───────────────────────── src/GlassPane.tsx ─────────────────────────
type GlassRecipe = {
  tintTop: string;
  tintBottom: string;
  frost: number;
  band: number;
  push: number;
  dip: number;
  chroma: number;
  rim: number;
  specular: number;
  inner: number;
  fringe: number;
  glow: string;
  glowAlpha: number;
  /** Gaussian blur sigma applied to the backdrop before refraction. */
  blur: number;
};

const effect = Skia.RuntimeEffect.Make(LIQUID_GLASS_SHADER);

/** Parse '#RGB' / '#RRGGBB' / 'rgba(r,g,b,a)' into a straight-alpha float4. */
function toFloat4(color: string): Float32Array {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex;
    return new Float32Array([
      parseInt(full.slice(0, 2), 16) / 255,
      parseInt(full.slice(2, 4), 16) / 255,
      parseInt(full.slice(4, 6), 16) / 255,
      1,
    ]);
  }
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) return new Float32Array([1, 1, 1, 1]);
  const parts = match[1].split(',').map((p) => parseFloat(p.trim()));
  return new Float32Array([
    parts[0] / 255,
    parts[1] / 255,
    parts[2] / 255,
    parts.length > 3 ? parts[3] : 1,
  ]);
}

type GlassPaneProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  recipe: GlassRecipe;
  /** Direction the light comes from, unit vector. */
  light?: { x: number; y: number };
  /** In-shader edge diffusion in px: softness right at the rim. */
  diffusion?: number;
  /** Override the recipe's blur sigma. */
  blur?: number;
};

/**
 * A single pane of liquid glass.
 *
 * Draw order matters:
 *  1. `BackdropFilter` snapshots everything already painted behind this group *inside the clip*,
 *     runs the glass shader over that snapshot, and replaces the backdrop with the result.
 *  2. Two hairlines add the crisp silhouette and the top specular — things a per-pixel shader
 *     cannot antialias as cleanly as the rasteriser.
 *
 * Pure Skia primitives, so no extra React Native views are laid out per frame.
 */
const GlassPane: React.FC<GlassPaneProps> = ({
  x,
  y,
  width,
  height,
  radius,
  recipe,
  light = { x: -0.55, y: -0.83 },
  diffusion = 1.4,
  blur,
}) => {
  const clip = useMemo(
    () => Skia.RRectXY(Skia.XYWHRect(x, y, width, height), radius, radius),
    [x, y, width, height, radius],
  );

  const uniforms = useMemo(
    () => ({
      size: [width, height],
      radius,
      band: Math.max(8, Math.min(width, height) * recipe.band * 0.5),
      push: recipe.push,
      dip: recipe.dip,
      chroma: recipe.chroma,
      rim: recipe.rim,
      specular: recipe.specular,
      inner: recipe.inner,
      fringe: recipe.fringe,
      diffusion,
      frostAmount: recipe.frost,
      tintTop: toFloat4(recipe.tintTop),
      tintBottom: toFloat4(recipe.tintBottom),
      lightDir: [light.x, light.y],
    }),
    // `recipe` is a frozen constant from tokens.ts, so identity is stable.
    [width, height, radius, recipe, diffusion, light.x, light.y],
  );

  if (!effect) {
    // Shader unavailable: draw a readable fallback pane rather than an empty box.
    return (
      <Group>
        <RoundedRect
          x={x}
          y={y}
          width={width}
          height={height}
          r={radius}
          color="rgba(38,46,64,0.72)"
        />
        <RoundedRect
          x={x}
          y={y}
          width={width}
          height={height}
          r={radius}
          style="stroke"
          strokeWidth={1}
          color="rgba(255,255,255,0.28)"
        />
      </Group>
    );
  }

  return (
    <Group>
      {/*
        The blur is a *child* of the runtime shader. Because RuntimeShader hands its children the
        source image, the shader receives an already-diffused backdrop: a true gaussian frost,
        then the optical warp on top of it. Without this stage the refraction reads as a clean
        photograph seen through warped glass rather than as frosted glass.
      */}
      <BackdropFilter
        clip={clip}
        filter={
          <RuntimeShader source={effect} uniforms={uniforms}>
            <Blur blur={(blur ?? recipe.blur) / 2} />
          </RuntimeShader>
        }
      >
        <Paint opacity={1} />
      </BackdropFilter>

      {/* Crisp outer silhouette. */}
      <RoundedRect
        x={x}
        y={y}
        width={width}
        height={height}
        r={radius}
        style="stroke"
        strokeWidth={1}
        color="rgba(255,255,255,0.30)"
      />
      {/* Specular hairline hugging the top edge. */}
      <RoundedRect
        x={x + 1.4}
        y={y + 1.4}
        width={width - 2.8}
        height={height - 2.8}
        r={Math.max(1, radius - 1.4)}
        style="stroke"
        strokeWidth={0.8}
        color="rgba(255,255,255,0.20)"
      />
    </Group>
  );
};

// ───────────────────────── src/Backdrop.tsx ─────────────────────────
/**
 * The scene the glass refracts.
 *
 * The important design decision: this is a plain Skia component tree, and it is rendered **twice** —
 * once full-bleed behind the app, and once inside the navigation bar's own canvas. Because a
 * `BackdropFilter` can only sample pixels already painted on *its own* canvas, rendering the same
 * scene into the bar canvas is what makes the glass refract a believable image without any
 * snapshot/async round-trip.
 *
 * It is also why this layer must be cheap: a handful of gradients, no blurs, no filters.
 */

type BackdropProps = {
  width: number;
  height: number;
  /** Optional slow drift, animated on the UI thread, so the refraction visibly changes. */
  drift?: SharedValue<number>;
};

const RIBBONS = [
  // cx, cy, radius, colour, alpha, rotation
  { cx: 0.18, cy: 0.2, r: 0.82, color: aurora.violet, alpha: 0.85, rot: 22 },
  { cx: 0.92, cy: 0.14, r: 0.66, color: aurora.cyan, alpha: 0.72, rot: 12 },
  { cx: 0.72, cy: 0.66, r: 0.74, color: aurora.magenta, alpha: 0.62, rot: -8 },
  { cx: 0.1, cy: 0.82, r: 0.62, color: aurora.cyan, alpha: 0.5, rot: 34 },
  { cx: 0.52, cy: 1.02, r: 0.55, color: aurora.warm, alpha: 0.4, rot: -6 },
];

const withAlpha = (hex: string, alpha: number) => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};

/**
 * Aurora field: a deep base, five soft ribbons and a cool key light.
 * Pure gradients — no images, no filters, so it stays at 60 FPS even on low-end devices.
 */
const AuroraBackdrop: React.FC<BackdropProps> = ({ width, height }) => {
  const ribbons = useMemo(
    () =>
      RIBBONS.map((r) => ({
        ...r,
        cx: width * r.cx,
        cy: height * r.cy,
        radius: width * r.r,
      })),
    [width, height],
  );

  return (
    <Group>
      {/* Base field. */}
      <Rect x={0} y={0} width={width} height={height}>
        <LinearGradient
          start={vec(0, 0)}
          end={vec(0, height)}
          colors={[aurora.base, aurora.mid, aurora.deep]}
          positions={[0, 0.45, 1]}
        />
      </Rect>

      {/* Aurora ribbons. */}
      {ribbons.map((r, i) => (
        <Group
          key={i}
          origin={vec(r.cx, r.cy)}
          transform={[{ rotate: (r.rot * Math.PI) / 180 }]}
        >
          <Oval
            x={r.cx - r.radius}
            y={r.cy - r.radius * 0.55}
            width={r.radius * 2}
            height={r.radius * 1.1}
          >
            <RadialGradient
              c={vec(r.cx, r.cy)}
              r={r.radius}
              colors={[
                withAlpha(r.color, r.alpha),
                withAlpha(r.color, r.alpha * 0.42),
                'rgba(0,0,0,0)',
              ]}
              positions={[0, 0.45, 1]}
            />
          </Oval>
        </Group>
      ))}

      {/* Cool key light, mirrored by the specular on the glass. */}
      <Rect x={0} y={0} width={width} height={height}>
        <RadialGradient
          c={vec(width * 0.18, height * 0.06)}
          r={width * 0.9}
          colors={[
            withAlpha(aurora.cool, 0.5),
            withAlpha(aurora.cool, 0.14),
            'rgba(0,0,0,0)',
          ]}
          positions={[0, 0.42, 1]}
        />
      </Rect>

      {/* Vignette keeps the floating capsule readable. */}
      <Rect x={0} y={0} width={width} height={height}>
        <LinearGradient
          start={vec(0, 0)}
          end={vec(0, height)}
          colors={[
            'rgba(0,0,0,0.30)',
            'rgba(0,0,0,0)',
            'rgba(0,0,0,0)',
            'rgba(0,0,0,0.46)',
          ]}
          positions={[0, 0.3, 0.74, 1]}
        />
      </Rect>
    </Group>
  );
};

const SKIA_FILL = {
  position: 'absolute',
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
} as const;

/** Full-bleed backdrop drawn behind the app content. */
const BackdropCanvas: React.FC<{ width: number; height: number }> = ({
  width,
  height,
}) => (
  <Canvas style={SKIA_FILL} pointerEvents="none">
    <AuroraBackdrop width={width} height={height} />
  </Canvas>
);

/**
 * Ghost of the scrolling cards, drawn inside the bar's canvas so the glass has real geometry to
 * bend. It is intentionally *simplified* — a refracted image is soft and distorted, so a few
 * rounded rectangles are indistinguishable from the real cards through glass, at a fraction of the
 * cost.
 *
 * `scrollY` is a Reanimated shared value, so scrolling updates this layer on the UI thread with no
 * React re-render.
 */
type GhostCard = { y: number; height: number; accent: string };

const CardGhosts: React.FC<{
  width: number;
  cards: GhostCard[];
  scrollY: SharedValue<number>;
  x: number;
  radius: number;
}> = ({ width, cards, x, radius }) => (
  <Group>
    {cards.map((card, i) => (
      <Group key={i}>
        <RoundedRect
          x={x}
          y={card.y}
          width={width}
          height={card.height}
          r={radius}
          color="rgba(255,255,255,0.07)"
        />
        {/* Accent disc, the most visible feature through the glass. */}
        <Oval
          x={x + 16}
          y={card.y + (card.height - 42) / 2}
          width={42}
          height={42}
        >
          <RadialGradient
            c={vec(x + 37, card.y + card.height / 2)}
            r={26}
            colors={[card.accent, 'rgba(0,0,0,0)']}
          />
        </Oval>
        <RoundedRect
          x={x + 72}
          y={card.y + card.height / 2 - 13}
          width={132}
          height={7}
          r={3.5}
          color="rgba(255,255,255,0.28)"
        />
        <RoundedRect
          x={x + 72}
          y={card.y + card.height / 2 + 4}
          width={92}
          height={6}
          r={3}
          color="rgba(255,255,255,0.14)"
        />
      </Group>
    ))}
  </Group>
);

// ───────────────────────── src/Content.tsx ─────────────────────────
/**
 * Content surfaces used by the demo.
 *
 * These are deliberately *not* glass: only the bar runs the full liquid-glass shader. Keeping the
 * expensive effect on a single element is what makes the whole screen hold 60 FPS, and it makes the
 * bar the obvious focal point.
 */

type CardProps = {
  title: string;
  accent: string;
  icon: keyof typeof Ionicons.glyphMap;
};

const GlassCard: React.FC<CardProps> = ({ title, accent, icon }) => (
  <View style={contentStyles.card}>
    {/* Soft accent bloom behind the avatar, clipped by the card radius. */}
    <Canvas style={contentStyles.cardGlow} pointerEvents="none">
      <Group>
        <Oval x={6} y={6} width={54} height={54}>
          <LinearGradient
            start={vec(6, 6)}
            end={vec(60, 60)}
            colors={[contentWithAlpha(accent, 0.55), 'rgba(0,0,0,0)']}
          />
        </Oval>
      </Group>
    </Canvas>

    <View style={[contentStyles.avatar, { backgroundColor: accent }]}>
      <Ionicons name={icon} size={19} color="rgba(255,255,255,0.95)" />
    </View>
    <View style={contentStyles.cardText}>
      <Text style={contentStyles.cardTitle}>{title}</Text>
      <View style={contentStyles.cardBar} />
    </View>
    <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.32)" />
  </View>
);

const contentWithAlpha = (hex: string, alpha: number) => {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(
    h.slice(4, 6),
    16,
  )},${alpha})`;
};

const contentStyles = StyleSheet.create({
  card: {
    height: 74,
    borderRadius: 22,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.16)',
    overflow: 'hidden',
  },
  cardGlow: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 66,
    height: 66,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardText: {
    flex: 1,
    marginLeft: 14,
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '600',
  },
  cardBar: {
    marginTop: 8,
    height: 6,
    width: 132,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
});

/** Small glassy chip used for the status row at the top of the demo. */
const StatusChip: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={chipStyles.chip}>
    <Text style={chipStyles.label}>{label}</Text>
    <Text style={chipStyles.value}>{value}</Text>
    {label === 'engine' ? (
      <Canvas style={chipStyles.dot}>
        <Oval x={0} y={0} width={8} height={8}>
          <LinearGradient
            start={vec(0, 0)}
            end={vec(8, 8)}
            colors={['#8FF6C4', '#35C98A']}
          />
        </Oval>
      </Canvas>
    ) : null}
  </View>
);

const chipStyles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  label: { color: 'rgba(255,255,255,0.42)', fontSize: 10, fontWeight: '600' },
  value: { color: 'rgba(255,255,255,0.92)', fontSize: 10.5, fontWeight: '700' },
  dot: { width: 8, height: 8 },
});

// `Skia` is re-exported for consumers that want to build their own effects.
const skiaInstance = Skia;

// ───────────────────────── src/LiquidGlassNavBar.tsx ─────────────────────────
type NavItem = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconActive: keyof typeof Ionicons.glyphMap;
};

type NavBarProps = {
  items: NavItem[];
  selected: number;
  onSelect: (index: number) => void;
  /** Width of the capsule. Pass `screenWidth - 2 * layout.barSideInset`. */
  width: number;
  /** Height of the host canvas — must cover every ghost card you pass. */
  canvasHeight: number;
  /** Scene height, used to rebuild the backdrop inside the bar canvas. */
  sceneHeight: number;
  /** Ghost of the scrolling content, so the glass refracts real geometry. */
  ghosts?: GhostCard[];
  ghostScroll?: SharedValue<number>;
  showLabels?: boolean;
  /**
   * Balanced mode: freezes the specular sweep and softens edge diffusion. Everything else
   * (refraction, dispersion, springs) stays on.
   */
  performanceMode?: boolean;
};

const springConfig = {
  damping: spring.damping,
  stiffness: spring.stiffness,
  mass: spring.mass,
};

/**
 * Floating liquid-glass navigation bar.
 *
 * Architecture, from back to front, all inside one Skia canvas:
 *   1. The scene  — the aurora field, re-drawn inside the bar canvas so the backdrop filter has
 *                   pixels to sample.
 *   2. Card ghosts — a simplified copy of the content that sits behind the bar, moved on the UI
 *                   thread by the scroll position.
 *   3. The capsule — a backdrop filter running the liquid glass shader over 1 + 2.
 *   4. The lens    — a second backdrop filter that refracts *the capsule itself*. That nested
 *                   refraction is what gives the component its layered depth: the lens bends light
 *                   that has already been bent once.
 *
 * Icons and labels are real React Native views above the canvas, so text uses the platform font
 * rasteriser and stays crisp. Their motion is driven by one shared value on the UI thread, so a
 * slide never re-renders React.
 */
const LiquidGlassNavBar: React.FC<NavBarProps> = ({
  items,
  selected,
  onSelect,
  width,
  canvasHeight,
  sceneHeight,
  ghosts,
  ghostScroll,
  showLabels = true,
  performanceMode = false,
}) => {
  const height = layout.barHeight;
  const radius = height / 2;
  const slotWidth = width / items.length;
  const lensW = slotWidth - layout.lensInset * 2;
  const lensH = height - layout.lensInset * 2;

  // Lens position in slot units (0 .. items.length - 1).
  const progress = useSharedValue(selected);

  useEffect(() => {
    progress.value = withSpring(selected, springConfig);
  }, [selected, progress]);

  const lensTransform = useDerivedValue(() => {
    const value = progress.value;
    const distance = Math.abs(value - Math.round(value));
    // Squash only while travelling between slots: the lens stretches along its motion vector.
    const travel = Math.sin(distance * Math.PI);
    const squash = travel * 0.055;
    return [
      { translateX: layout.lensInset + value * slotWidth },
      { scaleX: 1 + squash },
      { scaleY: 1 - squash * 0.6 },
    ];
  });

  const lensOrigin = useMemo(() => vec(lensW / 2, lensH / 2), [lensW, lensH]);

  // Slow specular sweep across the capsule. A moving gradient, not a filter: one draw call.
  const clock = useClock();
  const sweep = useDerivedValue(() => {
    const t = performanceMode ? 0.35 : (clock.value % 9000) / 9000;
    return t;
  });
  const sweepStart = useDerivedValue(() => vec(-width * 0.75 + sweep.value * width * 2.1, 0));
  const sweepEnd = useDerivedValue(() => vec(-width * 0.35 + sweep.value * width * 2.1, height));

  // The bar canvas is anchored so that y = barTop lands exactly on the capsule.
  const barTop = canvasHeight - height - layout.barBottomGap;

  const ghostCards = useMemo(() => ghosts ?? [], [ghosts]);

  return (
    <View style={{ width, height }}>
      <Canvas style={StyleSheet.absoluteFill}>
        {/* 1. Scene, re-drawn inside this canvas so the backdrop filter has something to sample. */}
        <AuroraBackdrop width={width} height={sceneHeight} />

        {/* 2. Content ghost, scrolling with the real content. */}
        {ghostScroll ? (
          <Group transform={[{ translateY: 0 }]}>
            <GhostLayer
              cards={ghostCards}
              width={width}
              scrollY={ghostScroll}
              offset={barTop}
            />
          </Group>
        ) : null}

        {/* 3. The capsule. */}
        <GlassPane
          x={0}
          y={0}
          width={width}
          height={height}
          radius={radius}
          recipe={glass.bar}
          diffusion={performanceMode ? 0.8 : 1.4}
        />

        {/* 4. Selection lens: refracts the capsule's own glass. */}
        <Group transform={lensTransform} origin={lensOrigin}>
          <GlassPane
            x={0}
            y={0}
            width={lensW}
            height={lensH}
            radius={lensH / 2}
            recipe={glass.lens}
            diffusion={performanceMode ? 1.0 : 1.8}
          />
        </Group>

        {/* 5. Specular sweep. */}
        <RoundedRect x={0} y={0} width={width} height={height} r={radius} opacity={0.55}>
          <LinearGradient
            start={sweepStart}
            end={sweepEnd}
            colors={[
              'rgba(255,255,255,0)',
              'rgba(255,255,255,0.14)',
              'rgba(255,255,255,0)',
            ]}
            positions={[0, 0.5, 1]}
          />
        </RoundedRect>

        {/* 6. Top specular edge, drawn last so it sits on the glass surface. */}
        <RoundedRect
          x={1}
          y={1}
          width={width - 2}
          height={height - 2}
          r={radius - 1}
          style="stroke"
          strokeWidth={1.2}
          color="rgba(255,255,255,0.34)"
        />
      </Canvas>

      {/* Icons and labels live above the canvas. */}
      <View style={navStyles.row} pointerEvents="box-none">
        {items.map((item, index) => (
          <NavButton
            key={item.key}
            item={item}
            index={index}
            progress={progress}
            selected={selected === index}
            showLabel={showLabels}
            onPress={() => onSelect(index)}
          />
        ))}
      </View>
    </View>
  );
};

/**
 * Ghost content layer.
 *
 * The cards behind the bar are translated by the live scroll offset on the UI thread. Drawing a
 * simplified copy of them here (rather than trying to sample the real views) keeps the refraction
 * honest without any snapshot round-trip, and costs a dozen rectangles.
 */
const GhostLayer: React.FC<{
  cards: GhostCard[];
  width: number;
  scrollY: SharedValue<number>;
  offset: number;
}> = ({ cards, width, scrollY, offset }) => (
  <CardGhosts
    width={width}
    cards={cards}
    scrollY={scrollY}
    x={0}
    radius={22}
  />
);

type ButtonProps = {
  item: NavItem;
  index: number;
  progress: SharedValue<number>;
  selected: boolean;
  showLabel: boolean;
  onPress: () => void;
};

const NavButton: React.FC<ButtonProps> = ({
  item,
  index,
  progress,
  selected,
  showLabel,
  onPress,
}) => {
  const press = useSharedValue(0);

  const glyphStyle = useAnimatedStyle(() => {
    const raw = 1 - Math.abs(progress.value - index);
    const f = Math.max(0, Math.min(1, raw));
    const eased = f * f * (3 - 2 * f); // smoothstep
    const scale = (0.9 + 0.16 * eased) * (1 - 0.1 * press.value);
    return { opacity: 0.6 + 0.4 * eased, transform: [{ scale }] };
  });

  const glowStyle = useAnimatedStyle(() => {
    const raw = 1 - Math.abs(progress.value - index);
    const f = Math.max(0, Math.min(1, raw));
    return { opacity: f * 0.9, transform: [{ scale: 0.8 + 0.2 * f }] };
  });

  const labelStyle = useAnimatedStyle(() => {
    const raw = 1 - Math.abs(progress.value - index);
    const f = Math.max(0, Math.min(1, raw));
    return { opacity: f * f, transform: [{ translateY: (1 - f) * 3 }] };
  });

  const handlePressIn = useCallback(() => {
    press.value = withTiming(1, { duration: 110, easing: Easing.out(Easing.quad) });
  }, [press]);

  const handlePressOut = useCallback(() => {
    press.value = withTiming(0, { duration: 220, easing: Easing.out(Easing.quad) });
  }, [press]);

  const handlePress = useCallback(() => {
    if (!selected) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    onPress();
  }, [onPress, selected]);

  return (
    <Pressable
      style={navStyles.button}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={item.label}
      hitSlop={8}
    >
      <Animated.View style={[navStyles.glow, glowStyle]} pointerEvents="none" />
      <Animated.View style={glyphStyle}>
        <Ionicons
          name={selected ? item.iconActive : item.icon}
          size={layout.iconSize}
          color={palette.ink}
        />
      </Animated.View>
      {showLabel && (
        <Animated.Text style={[navStyles.label, labelStyle]} numberOfLines={1}>
          {item.label}
        </Animated.Text>
      )}
    </Pressable>
  );
};

const navStyles = StyleSheet.create({
  row: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  button: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.13)',
    top: '50%',
    marginTop: -25,
  },
  label: {
    marginTop: layout.iconLabelGap,
    fontSize: layout.labelSize,
    letterSpacing: layout.labelLetterSpacing,
    fontWeight: '600',
    color: palette.labelActive,
  },
});

// ───────────────────────── src/DemoScreen.tsx ─────────────────────────
const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: 'Home', icon: 'home-outline', iconActive: 'home' },
  { key: 'search', label: 'Search', icon: 'search-outline', iconActive: 'search' },
  { key: 'alerts', label: 'Alerts', icon: 'notifications-outline', iconActive: 'notifications' },
  { key: 'profile', label: 'Profile', icon: 'person-outline', iconActive: 'person' },
];

const SUBTITLES = [
  'Home · the lens bends light that is already bent',
  'Search · refraction follows your finger',
  'Alerts · nested glass, layered depth',
  'Profile · specular sweep and dispersion',
];

type Card = {
  title: string;
  accent: string;
  icon: keyof typeof Ionicons.glyphMap;
};

const CARDS: Card[] = [
  { title: 'Ambient light study', accent: '#6EA8FF', icon: 'color-wand-outline' },
  { title: 'Refraction test card', accent: '#9D7BFF', icon: 'prism-outline' },
  { title: 'Specular sweep', accent: '#4ED6C0', icon: 'sparkles-outline' },
  { title: 'Chromatic fringe', accent: '#FF8FBF', icon: 'eyedrop-outline' },
  { title: 'Frosted depth', accent: '#FFC46B', icon: 'layers-outline' },
  { title: 'Layer blending', accent: '#7FF3C8', icon: 'git-merge-outline' },
];

const CARD_HEIGHT = 74;
const CARD_GAP = 12;

/**
 * Demo screen.
 *
 * Layout contract (important if you reuse the bar):
 *  - The backdrop is painted once, full bleed, at the back of the screen.
 *  - Scrolling content sits above it and passes *under* the bar.
 *  - The bar hosts its own canvas that re-paints the backdrop plus a ghost of the content, which is
 *    what the glass refracts.
 *
 * The ghost cards are derived from the very same constants as the real cards, so the refraction
 * always lines up with what you see behind the glass.
 */
const DemoScreen: React.FC = () => {
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState(0);
  const { width, height } = Dimensions.get('window');

  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollY.value = event.contentOffset.y;
    },
  });

  const handleSelect = useCallback((index: number) => setSelected(index), []);

  const barWidth = width - layout.barSideInset * 2;
  const barBottom = Math.max(insets.bottom, 8) + layout.barBottomGap;

  // Host canvas for the bar: covers the capsule and every ghost card that can scroll behind it.
  const canvasHeight = layout.barHeight + barBottom + 520;

  /**
   * Where the cards sit in scene coordinates while the list is at scroll offset 0. The ghost layer
   * subtracts the live scroll offset from these, so the refraction tracks the real content.
   */
  const ghostCards: GhostCard[] = useMemo(() => {
    const listTop = insets.top + 30 + 34 + 6 + 20 + 26; // title block + margins
    return CARDS.map((card, i) => ({
      y: listTop + i * (CARD_HEIGHT + CARD_GAP),
      height: CARD_HEIGHT,
      accent: card.accent,
    }));
  }, [insets.top]);

  return (
    <View style={demoStyles.root}>
      {/* 1. Scene. */}
      <BackdropCanvas width={width} height={height} />

      {/* 2. Content that scrolls beneath the capsule. */}
      <Animated.ScrollView
        style={demoStyles.scroll}
        contentContainerStyle={[
          demoStyles.scrollContent,
          {
            paddingTop: insets.top + 30,
            paddingBottom: barBottom + layout.barHeight + 44,
          },
        ]}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        <View style={demoStyles.chips}>
          <StatusChip label="engine" value="Skia runtime shader" />
          <StatusChip label="fps" value="60" />
        </View>

        <Text style={demoStyles.bigTitle}>Liquid Glass</Text>
        <Text style={demoStyles.subtitle}>{SUBTITLES[selected]}</Text>

        <View style={demoStyles.cardList}>
          {CARDS.map((card) => (
            <GlassCard key={card.title} {...card} />
          ))}
        </View>

        <Text style={demoStyles.footnote}>
          Scroll these cards behind the capsule. The refraction, chromatic dispersion and rim light
          all track the content in real time — nothing is a static blur.
        </Text>
      </Animated.ScrollView>

      {/* 3. Floating capsule. */}
      <View style={[demoStyles.barHost, { bottom: barBottom }]} pointerEvents="box-none">
        <LiquidGlassNavBar
          items={NAV_ITEMS}
          selected={selected}
          onSelect={handleSelect}
          width={barWidth}
          canvasHeight={canvasHeight}
          sceneHeight={height}
          ghosts={ghostCards}
          ghostScroll={scrollY}
        />
      </View>
    </View>
  );
};

const demoStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#06070D' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 22 },
  chips: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  bigTitle: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.7,
  },
  subtitle: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
    fontWeight: '500',
  },
  cardList: { marginTop: 26, gap: CARD_GAP },
  footnote: {
    marginTop: 26,
    color: 'rgba(255,255,255,0.38)',
    fontSize: 12,
    lineHeight: 18,
  },
  barHost: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
});

// ───────────────────────── App.tsx ─────────────────────────

function Root() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <DemoScreen />
    </SafeAreaProvider>
  );
}

export default Root;
