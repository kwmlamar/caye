// GLSL for CayePresence's particle sphere. Kept as plain strings (no glslify
// / shader-loader dependency) — this is the entire rendering budget: one
// draw call, one noise field evaluated per vertex, one soft point sprite
// per fragment. No postprocessing passes.
//
// Noise: Ashima Arts' classic 3D simplex noise (MIT/public-domain, the
// standard `webgl-noise` snippet used across the WebGL ecosystem) —
// inlined rather than pulled in as an npm dependency for ~20 lines of GLSL.

const SIMPLEX_NOISE_3D = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`

export const PARTICLE_VERTEX_SHADER = /* glsl */ `
attribute vec3 aDir;
attribute float aSeed;
attribute float aSize;
attribute float aRadiusScale;

uniform float uTime;
uniform float uRadius;
uniform float uNoiseAmount;
uniform float uNoiseSpeed;
uniform float uAudioLevel;
uniform float uAudioDisplacementGain;
uniform float uBaseSize;
uniform float uPixelRatio;
uniform float uFocusDistance;

varying float vFacing;
varying float vNoise;
varying float vSeed;
varying float vDepth;

${SIMPLEX_NOISE_3D}

void main() {
  vSeed = aSeed;
  // 0 at the outer shell, up to 1 for the rare, shallow interior tail —
  // matches the *0.34 pull-in range aRadiusScale is generated with.
  vDepth = clamp((1.0 - aRadiusScale) * 2.94, 0.0, 1.0);

  float n = snoise(aDir * 1.8 + vec3(0.0, 0.0, uTime * uNoiseSpeed) + aSeed * 12.0);
  vNoise = n;

  float audioPush = uAudioLevel * uAudioDisplacementGain * (0.4 + 0.6 * max(n, 0.0));
  float displacement = uNoiseAmount * n + audioPush;
  float radius = uRadius * aRadiusScale * (1.0 + displacement);

  vec3 displaced = aDir * radius;
  vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);

  vec3 viewNormal = normalize(mat3(modelViewMatrix) * aDir);
  vFacing = viewNormal.z;

  gl_Position = projectionMatrix * mvPosition;
  // uBaseSize is the approximate on-screen pixel diameter at the camera's
  // resting distance (uFocusDistance) — the ratio corrects for points that
  // end up nearer/farther after displacement. Interior particles render a
  // touch smaller — a cheap atmospheric-perspective cue that reinforces
  // "further away" alongside the cream tint in the fragment shader.
  float depthSize = mix(1.0, 0.7, vDepth);
  gl_PointSize = aSize * uBaseSize * uPixelRatio * depthSize * (uFocusDistance / max(-mvPosition.z, 0.001));
}
`

export const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

uniform vec3 uColorCool;
uniform vec3 uColorWarm;
uniform vec3 uColorAccent;
uniform float uColorWarmth;
uniform float uGlowIntensity;

varying float vFacing;
varying float vNoise;
varying float vSeed;
varying float vDepth;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = length(uv);
  if (d > 1.0) discard;

  float core = smoothstep(0.4, 0.0, d);
  float halo = smoothstep(1.0, 0.0, d) * 0.45;
  float alpha = core + halo;

  float facingBoost = smoothstep(-0.4, 1.0, vFacing);
  float twinkle = 0.82 + 0.18 * vNoise;
  // Brighter overall + a stronger front-facing lift than before — the
  // outer/facing particles should read as the brightest part of the
  // cloud, not just barely lifted above the rest.
  float brightness = mix(0.68, 1.5, facingBoost) * twinkle;

  float warmth = clamp(uColorWarmth + (vSeed - 0.5) * 0.16, 0.0, 1.0);
  vec3 color = mix(uColorCool, uColorWarm, warmth);
  // Small warm-white/cream lift toward the interior — depth as light
  // variation within the existing palette, not a new color.
  color = mix(color, uColorAccent, vDepth * 0.28);
  color *= brightness * (1.0 + uGlowIntensity);

  gl_FragColor = vec4(color, alpha * clamp(brightness, 0.0, 1.5));
}
`
