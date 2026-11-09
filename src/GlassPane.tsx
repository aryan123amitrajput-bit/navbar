import React, { useMemo } from 'react';
import {
  BackdropFilter,
  Blur,
  Group,
  Paint,
  RuntimeShader,
  Skia,
  RoundedRect,
} from '@shopify/react-native-skia';

import { LIQUID_GLASS_SHADER } from './shader';

export type GlassRecipe = {
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
export function toFloat4(color: string): Float32Array {
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

type Props = {
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
export const GlassPane: React.FC<Props> = ({
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
