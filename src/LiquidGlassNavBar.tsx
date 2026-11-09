import React, { useCallback, useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Canvas,
  Group,
  LinearGradient,
  RoundedRect,
  vec,
  useClock,
} from '@shopify/react-native-skia';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { AuroraBackdrop, CardGhosts } from './Backdrop';
import type { GhostCard } from './Backdrop';
import { GlassPane } from './GlassPane';
import { glass, layout, palette, spring } from './tokens';

export type NavItem = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconActive: keyof typeof Ionicons.glyphMap;
};

type Props = {
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
export const LiquidGlassNavBar: React.FC<Props> = ({
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
      <View style={styles.row} pointerEvents="box-none">
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
      style={styles.button}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={item.label}
      hitSlop={8}
    >
      <Animated.View style={[styles.glow, glowStyle]} pointerEvents="none" />
      <Animated.View style={glyphStyle}>
        <Ionicons
          name={selected ? item.iconActive : item.icon}
          size={layout.iconSize}
          color={palette.ink}
        />
      </Animated.View>
      {showLabel && (
        <Animated.Text style={[styles.label, labelStyle]} numberOfLines={1}>
          {item.label}
        </Animated.Text>
      )}
    </Pressable>
  );
};

const styles = StyleSheet.create({
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
