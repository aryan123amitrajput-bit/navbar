import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Canvas, Group, LinearGradient, Oval, Skia, vec } from '@shopify/react-native-skia';
import { Ionicons } from '@expo/vector-icons';

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

export const GlassCard: React.FC<CardProps> = ({ title, accent, icon }) => (
  <View style={styles.card}>
    {/* Soft accent bloom behind the avatar, clipped by the card radius. */}
    <Canvas style={styles.cardGlow} pointerEvents="none">
      <Group>
        <Oval x={6} y={6} width={54} height={54}>
          <LinearGradient
            start={vec(6, 6)}
            end={vec(60, 60)}
            colors={[withAlpha(accent, 0.55), 'rgba(0,0,0,0)']}
          />
        </Oval>
      </Group>
    </Canvas>

    <View style={[styles.avatar, { backgroundColor: accent }]}>
      <Ionicons name={icon} size={19} color="rgba(255,255,255,0.95)" />
    </View>
    <View style={styles.cardText}>
      <Text style={styles.cardTitle}>{title}</Text>
      <View style={styles.cardBar} />
    </View>
    <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.32)" />
  </View>
);

const withAlpha = (hex: string, alpha: number) => {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(
    h.slice(4, 6),
    16,
  )},${alpha})`;
};

const styles = StyleSheet.create({
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
export const StatusChip: React.FC<{ label: string; value: string }> = ({ label, value }) => (
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
export const skiaInstance = Skia;
