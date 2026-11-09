/**
 * Liquid Glass design tokens.
 *
 * Everything visual is expressed here so the look can be retuned without touching render code.
 * Values were picked against dark, colourful backdrops — the harshest case for translucent glass.
 */

export const layout = {
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

export const palette = {
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
export const glass = {
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
export const spring = {
  damping: 17,
  stiffness: 190,
  mass: 0.9,
};

/** Backdrop palette (the aurora wallpaper the glass refracts). */
export const aurora = {
  base: '#06070D',
  mid: '#0B1730',
  deep: '#04050A',
  violet: '#3B2A6B',
  cyan: '#1E6E8C',
  magenta: '#7A2A5E',
  warm: '#8A4B2C',
  cool: '#9CC4FF',
};
