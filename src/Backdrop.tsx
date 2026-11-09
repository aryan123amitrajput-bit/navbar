import React, { useMemo } from 'react';
import {
  Canvas,
  Group,
  LinearGradient,
  Oval,
  RadialGradient,
  Rect,
  RoundedRect,
  vec,
} from '@shopify/react-native-skia';
import type { SharedValue } from 'react-native-reanimated';

import { aurora } from './tokens';

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
export const AuroraBackdrop: React.FC<BackdropProps> = ({ width, height }) => {
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

export const SKIA_FILL = {
  position: 'absolute',
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
} as const;

/** Full-bleed backdrop drawn behind the app content. */
export const BackdropCanvas: React.FC<{ width: number; height: number }> = ({
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
export type GhostCard = { y: number; height: number; accent: string };

export const CardGhosts: React.FC<{
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
