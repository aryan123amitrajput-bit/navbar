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

export const LIQUID_GLASS_SHADER = `
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
