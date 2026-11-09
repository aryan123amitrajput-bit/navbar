import React, { useCallback, useMemo, useState } from 'react';
import {
  Dimensions,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedScrollHandler,
  useSharedValue,
} from 'react-native-reanimated';
import type { Ionicons } from '@expo/vector-icons';

import { BackdropCanvas } from './Backdrop';
import type { GhostCard } from './Backdrop';
import { GlassCard, StatusChip } from './Content';
import { LiquidGlassNavBar, NavItem } from './LiquidGlassNavBar';
import { layout } from './tokens';

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
export const DemoScreen: React.FC = () => {
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
    <View style={styles.root}>
      {/* 1. Scene. */}
      <BackdropCanvas width={width} height={height} />

      {/* 2. Content that scrolls beneath the capsule. */}
      <Animated.ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + 30,
            paddingBottom: barBottom + layout.barHeight + 44,
          },
        ]}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.chips}>
          <StatusChip label="engine" value="Skia runtime shader" />
          <StatusChip label="fps" value="60" />
        </View>

        <Text style={styles.bigTitle}>Liquid Glass</Text>
        <Text style={styles.subtitle}>{SUBTITLES[selected]}</Text>

        <View style={styles.cardList}>
          {CARDS.map((card) => (
            <GlassCard key={card.title} {...card} />
          ))}
        </View>

        <Text style={styles.footnote}>
          Scroll these cards behind the capsule. The refraction, chromatic dispersion and rim light
          all track the content in real time — nothing is a static blur.
        </Text>
      </Animated.ScrollView>

      {/* 3. Floating capsule. */}
      <View style={[styles.barHost, { bottom: barBottom }]} pointerEvents="box-none">
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

const styles = StyleSheet.create({
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
