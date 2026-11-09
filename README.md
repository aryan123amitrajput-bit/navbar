# Liquid Glass — iOS-style navigation bar (Expo / React Native)

A floating **liquid glass** navigation bar with real optical refraction: four destinations
(Home, Search, Alerts, Profile), a spring-driven selection lens, and functional navigation.

The glass is not a blurred translucent `View`. It is a **Skia runtime shader running as a backdrop
filter**, so the pane genuinely bends the pixels behind it.

![preview](docs/preview.png)

---

## What's in the box

| Path | What it is |
| --- | --- |
| `App.singlefile.tsx` | **Everything in one file.** Best for pasting into Expo Snack or a fresh project. |
| `App.tsx` + `src/` | The same code as modules (tokens, shader, GlassPane, Backdrop, Content, LiquidGlassNavBar, DemoScreen). |
| `tools/` | CanvasKit scripts that compile the shader and render previews without a device. |
| `docs/preview.png` | Rendered output of the composition. |

---

## Run it locally (fastest)

```bash
npm install
npx expo start
```

Scan the QR code with **Expo Go** on your phone. Press `w` for a browser preview (uses CanvasKit/WASM —
fine for a look, but the phone is the real test).

### Run it in Expo Snack (no install, phone in about a minute)

1. Open <https://snack.expo.dev> and sign in.
2. In **Dependencies**, add:
   - `@shopify/react-native-skia` → `2.14.0`
   - `react-native-reanimated` → `4.7.1`
   - `react-native-worklets` → `0.13.0`
   - `expo-haptics`
   - `react-native-safe-area-context`
   - `@expo/vector-icons`
3. Replace the contents of `App.js` with `App.singlefile.tsx`.
4. Press **Run**, then scan the QR with Expo Go.

---

## How the glass works

`BackdropFilter` snapshots the pixels already painted behind the pane; a runtime shader
(`src/shader.ts`) transforms that snapshot per pixel:

| Stage | Effect |
| --- | --- |
| Rounded-rect SDF | True distance from the rim |
| Edge warp | Samples pushed **outward** at the rim with a cubic falloff → the optical squeeze of a real lens |
| Chromatic dispersion | Red/blue sampled at slightly different offsets → faint colour fringe |
| Edge diffusion | 5-tap blur growing toward the rim: crisp centre, soft edges |
| Frost lift | Raises the refraction toward the glass's diffuse white → luminous, not a dark scrim |
| Tint + shading | Directional white wash, denser bottom, dark bevel on the lower-right arc |
| Rim + specular | Illuminated rim facing the light, narrow specular band tracking the incident angle |

The selection lens is a **second nested glass pane**, so it refracts the capsule's own glass — light
bent twice. That is what gives it layered depth.

The bar's canvas re-draws the scene and a lightweight ghost of the scrolling cards, because a
`BackdropFilter` can only sample pixels already on its own canvas. Scroll updates ride a Reanimated
shared value, so the refraction tracks the content on the UI thread.

---

## Performance

- Two shader passes total (capsule + lens); everything else is gradients and hairlines.
- Backdrop is gradients only — no images, no independent blur pass.
- One Reanimated shared value drives lens, icons, labels and glow on the **UI thread**; a slide costs
  zero React re-renders.
- `performanceMode` prop freezes the specular sweep and softens diffusion for low-end devices.

---

## Tuning

All visual values live in `src/tokens.ts`:

```ts
glass.bar  = { tintTop, tintBottom, frost, blur, band, push, dip, chroma, rim, specular, inner, fringe }
glass.lens = { ... }
```

- `frost` — the most important value. Higher = milkier and more Apple-like; lower = clearer glass.
- `blur` — gaussian sigma applied to the backdrop before refraction.
- `push` / `dip` / `band` — how hard and how far the rim squeezes.
- `chroma` — strength of the colour fringe.
- `layout` / `spring` — geometry and lens motion.

---

## Using the bar in your own screen

```tsx
<LiquidGlassNavBar
  items={items}
  selected={index}
  onSelect={setIndex}
  width={screenWidth - layout.barSideInset * 2}
  canvasHeight={layout.barHeight + bottomInset + 520}
  sceneHeight={screenHeight}
  ghosts={ghostCards}
  ghostScroll={scrollY}
/>
```

Keep the bar's host canvas covering the capsule **and** the ghost content, and derive the ghost cards
from the same constants as your real list so the refraction lines up.

---

## Verify the shader without a phone

```bash
npm i -D canvaskit-wasm
node tools/preview-shader.mjs     # writes tools/out/glass-preview.png
node tools/render-navbar.mjs      # writes tools/out/navbar-preview.png
```

These run the same SkSL through CanvasKit (Skia compiled to WebAssembly), so they double as a
validation step: if the shader stops compiling, `RuntimeEffect.Make` returns `null` and the script
fails loudly.

## Notes and limits

- The shader compiles once at module load. If a platform ever returned `null`, `GlassPane` falls back
  to a readable opaque pane instead of an empty box.
- Labels use the platform font rasteriser by design.
- Verified with `tsc --noEmit` against Expo SDK 58 / Skia 2.14 / Reanimated 4.7 types.
- Not yet verified on a physical device — device-specific `BackdropFilter` cropping and real FPS are
  still to be confirmed.
