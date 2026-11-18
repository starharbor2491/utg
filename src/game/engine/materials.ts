import {
  BLEND_ADDITIVE,
  BLEND_ADDITIVEALPHA,
  BLEND_NONE,
  BLEND_NORMAL,
  CULLFACE_BACK,
  CULLFACE_NONE,
  SHADERLANGUAGE_GLSL,
  ShaderChunks,
  StandardMaterial,
} from 'playcanvas';
import type { Color, Texture } from 'playcanvas';
import { SHADER_CHUNKS_VERSION, getDevice } from './app';
import { srgb } from './math';

type ColorInput = string | number | Color;

const toColor = (c: ColorInput): Color => (typeof c === 'string' || typeof c === 'number' ? srgb(c) : c.clone());

export interface StandardOptions {
  name?: string;
  /** sRGB, like Three's material.color. */
  color?: ColorInput;
  roughness?: number;
  metalness?: number;
  emissive?: ColorInput;
  emissiveIntensity?: number;
  opacity?: number;
  /** Alpha blending (Three's transparent: true). */
  transparent?: boolean;
  additive?: boolean;
  depthWrite?: boolean;
  depthTest?: boolean;
  doubleSided?: boolean;
  /** Multiply albedo by linear vertex colours (Three's vertexColors: true). */
  vertexColors?: boolean;
  /** Environment reflection strength (Three's envMapIntensity). */
  envIntensity?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  map?: Texture | null;
  normalMap?: Texture | null;
  normalScale?: number;
  alphaTest?: number;
  fog?: boolean;
  flatShading?: boolean;
}

/** Lit PBR material with metalness/roughness semantics matching Three's MeshStandardMaterial. */
export function standard(o: StandardOptions = {}): StandardMaterial {
  const m = new StandardMaterial();
  if (o.name) m.name = o.name;
  m.useMetalness = true;
  m.diffuse = toColor(o.color ?? '#ffffff');
  m.metalness = o.metalness ?? 0;
  m.gloss = 1 - (o.roughness ?? 1);
  if (o.emissive !== undefined) {
    m.emissive = toColor(o.emissive);
    m.emissiveIntensity = o.emissiveIntensity ?? 1;
  }
  if (o.envIntensity !== undefined) m.reflectivity = o.envIntensity;
  if (o.clearcoat) {
    m.clearCoat = o.clearcoat;
    m.clearCoatGloss = 1 - (o.clearcoatRoughness ?? 0);
  }
  if (o.map) m.diffuseMap = o.map;
  if (o.normalMap) {
    m.normalMap = o.normalMap;
    m.bumpiness = o.normalScale ?? 1;
  }
  if (o.vertexColors) {
    m.diffuseVertexColor = true;
    m.diffuseVertexColorChannel = 'rgb';
  }
  if (o.flatShading) m.flatShading = true;
  if (o.fog === false) m.useFog = false;
  applyBlend(m, o);
  m.update();
  return m;
}

export interface UnlitOptions {
  name?: string;
  color?: ColorInput;
  opacity?: number;
  map?: Texture | null;
  /** Use the map's alpha channel for opacity (default true when a map is given). */
  mapAlpha?: boolean;
  transparent?: boolean;
  additive?: boolean;
  depthWrite?: boolean;
  depthTest?: boolean;
  doubleSided?: boolean;
  vertexColors?: boolean;
  fog?: boolean;
  alphaTest?: number;
}

/** Unlit colour (Three's MeshBasicMaterial). Still fogged and tone-mapped like Three's default. */
export function unlit(o: UnlitOptions = {}): StandardMaterial {
  const m = new StandardMaterial();
  if (o.name) m.name = o.name;
  m.useLighting = false;
  m.useSkybox = false;
  m.useMetalness = true;
  m.metalness = 0;
  m.specularityFactor = 0;
  m.diffuse.set(0, 0, 0);
  m.emissive = toColor(o.color ?? '#ffffff');
  m.emissiveIntensity = 1;
  if (o.map) {
    m.emissiveMap = o.map;
    if (o.mapAlpha ?? true) {
      m.opacityMap = o.map;
      m.opacityMapChannel = 'a';
    }
  }
  if (o.vertexColors) {
    m.emissiveVertexColor = true;
    m.emissiveVertexColorChannel = 'rgb';
  }
  if (o.fog === false) m.useFog = false;
  applyBlend(m, o);
  m.update();
  return m;
}

function applyBlend(
  m: StandardMaterial,
  o: { opacity?: number; transparent?: boolean; additive?: boolean; depthWrite?: boolean; depthTest?: boolean; doubleSided?: boolean; alphaTest?: number }
): void {
  m.opacity = o.opacity ?? 1;
  if (o.additive) m.blendType = o.transparent === false ? BLEND_ADDITIVE : BLEND_ADDITIVEALPHA;
  else m.blendType = o.transparent ? BLEND_NORMAL : BLEND_NONE;
  // Three keeps depthWrite on for transparent materials unless told otherwise.
  m.depthWrite = o.depthWrite ?? true;
  if (o.depthTest !== undefined) m.depthTest = o.depthTest;
  if (o.doubleSided) {
    m.cull = CULLFACE_NONE;
    m.twoSidedLighting = true;
  } else {
    m.cull = CULLFACE_BACK;
  }
  if (o.alphaTest !== undefined) m.alphaTest = o.alphaTest;
}

// ---------------------------------------------------------------------------
// Shader hooks: composable snippets injected into StandardMaterial chunks. They
// replace Three's onBeforeCompile and keep PlayCanvas fog, shadows, tone mapping
// and instancing intact. GLSL only: the device is pinned to WebGL2.
// ---------------------------------------------------------------------------

export interface ShaderHooks {
  /** Vertex declarations (attributes, varyings, uniforms, functions). Inserted before transform code. */
  vsDecl?: string;
  /** Code at the end of the vertex main(); vertex_position (vec4), vPositionW, vNormalW are available. */
  vsMainEnd?: string;
  /**
   * Code inside getLocalPosition(vec3 vertexPosition) before it returns; edit the vec3 localPos.
   * Runs for colour and shadow passes, so displacement shadows correctly.
   */
  vsLocalPosition?: string;
  /** Fragment declarations: varyings, uniforms and helper functions used by the hooks below. */
  psDecl?: string;
  /** Appended inside getAlbedo(); edit vec3 dAlbedo. vPositionW and vNormalW are available. */
  albedo?: string;
  /** Appended inside getGlossiness(); edit float dGlossiness (1 - roughness). */
  gloss?: string;
  /** Appended inside getMetalness(); edit float dMetalness. */
  metalness?: string;
  /** Appended inside getEmission(); edit vec3 dEmission. Requires a non-black emissive or emissive map. */
  emission?: string;
  /** Appended inside getOpacity(); edit float dAlpha. Only compiled for blended or alpha-tested materials. */
  opacity?: string;
  /** End of the fragment main(); edit gl_FragColor (already lit, fogged and tone mapped). */
  psMainEnd?: string;
}

const hooksOf = new WeakMap<StandardMaterial, Required<ShaderHooks>>();
const EMPTY: Required<ShaderHooks> = {
  vsDecl: '', vsMainEnd: '', vsLocalPosition: '', psDecl: '', albedo: '', gloss: '', metalness: '',
  emission: '', opacity: '', psMainEnd: '',
};

/** Clones a standard material together with hooks registered by this module. */
export function cloneStandardMaterial(src: StandardMaterial): StandardMaterial {
  const clone = src.clone() as StandardMaterial;
  const hooks = hooksOf.get(src);
  if (hooks) addShaderHooks(clone, hooks);
  return clone;
}

function appendToFunction(source: string, code: string): string {
  const end = source.lastIndexOf('}');
  return `${source.slice(0, end)}\n${code}\n${source.slice(end)}`;
}

/**
 * Adds shader snippets to a StandardMaterial. Repeated calls accumulate, so features such as
 * instance tints and procedural weathering compose. Call before the material first renders.
 */
export function addShaderHooks(m: StandardMaterial, hooks: ShaderHooks): void {
  const acc = { ...(hooksOf.get(m) ?? EMPTY) };
  for (const k of Object.keys(hooks) as (keyof ShaderHooks)[]) {
    if (hooks[k]) acc[k] = acc[k] ? `${acc[k]}\n${hooks[k]}` : hooks[k]!;
  }
  hooksOf.set(m, acc);
  const stock = ShaderChunks.get(getDevice(), SHADERLANGUAGE_GLSL);
  const chunks = m.getShaderChunks(SHADERLANGUAGE_GLSL);
  m.shaderChunksVersion = SHADER_CHUNKS_VERSION;
  if (acc.vsDecl) chunks.set('litUserDeclarationVS', acc.vsDecl);
  if (acc.vsMainEnd) chunks.set('litUserMainEndVS', acc.vsMainEnd);
  if (acc.psDecl) chunks.set('litUserDeclarationPS', acc.psDecl);
  if (acc.psMainEnd) chunks.set('litUserMainEndPS', acc.psMainEnd);
  if (acc.vsLocalPosition) {
    const core = stock.get('transformCoreVS')!;
    chunks.set('transformCoreVS', core.replace('return localPos;', `${acc.vsLocalPosition}\n\treturn localPos;`));
  }
  const fns: [keyof ShaderHooks, string][] = [
    ['albedo', 'diffusePS'], ['gloss', 'glossPS'], ['metalness', 'metalnessPS'], ['emission', 'emissivePS'], ['opacity', 'opacityPS'],
  ];
  for (const [key, chunk] of fns) {
    if (acc[key]) chunks.set(chunk, appendToFunction(stock.get(chunk)!, acc[key]));
  }
  m.update();
}

/** Rolled-steel grain, lower-skirt mud and top-surface dust in the standard PBR pass. */
export function applyRealisticArmorShader(
  mat: StandardMaterial,
  _cacheTag = 'rha-v1',
  opts?: { grain?: number; heightRef?: number; dust?: number }
): void {
  const grain = opts?.grain ?? 1, heightRef = opts?.heightRef ?? 0, dust = opts?.dust ?? 0.07;
  addShaderHooks(mat, {
    vsDecl: 'varying vec3 vArmorLocalPos;',
    vsMainEnd: 'vArmorLocalPos = vertex_position.xyz;',
    psDecl: `
      varying vec3 vArmorLocalPos;
      float rhaHash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }`,
    albedo: `
      float armorH = vArmorLocalPos.y + ${heightRef.toFixed(3)};
      float steelGrain = rhaHash(floor(vArmorLocalPos * 46.0)) * ${(0.08 * grain).toFixed(4)} - ${(0.04 * grain).toFixed(4)};
      float mudHeight = 1.0 - smoothstep(0.05, 0.72, armorH);
      dAlbedo = mix(dAlbedo * (1.0 + steelGrain), vec3(0.34, 0.29, 0.21), mudHeight * 0.34);
      float topDust = smoothstep(0.55, 0.98, normalize(vNormalW).y) * ${dust.toFixed(4)};
      dAlbedo += vec3(topDust * 0.95, topDust * 0.90, topDust * 0.74);
      float contactAO = mix(0.55, 1.0, smoothstep(-0.05, 0.95, armorH));
      dAlbedo *= contactAO;`,
    gloss: `
      float grainR = rhaHash(floor(vArmorLocalPos * 32.0)) * ${(0.12 * grain).toFixed(4)} - ${(0.06 * grain).toFixed(4)};
      dGlossiness = clamp(dGlossiness - grainR, 0.04, 0.82);`,
  });
}

/** Uniforms read by hook code. Values are raw: convert sRGB colours with Color#linear(). */
export function setUniform(m: StandardMaterial, name: string, value: number | number[] | Float32Array): void {
  m.setParameter(name, value);
}
