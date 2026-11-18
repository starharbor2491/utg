import type { StandardMaterial } from 'playcanvas';
import { addShaderHooks } from '../engine/materials';

/** Small, view-filtered material details, evaluated in the existing PBR pass. */
export function applySurfaceFinish(mat: StandardMaterial, finish: 'wheel' | 'track' | 'carbon' | 'glass'): void {
  const declarations = `
    varying vec3 vFinishPos;
    float finishBand(float x) {
      return sin(x * 6.2831853) * (1.0 - smoothstep(0.18, 0.5, fwidth(x)));
    }
    uniform vec3 view_position;
  `;
  if (finish === 'glass') {
    addShaderHooks(mat, {
      vsDecl: 'varying vec3 vFinishPos;',
      vsMainEnd: 'vFinishPos = vertex_position.xyz;',
      psDecl: declarations,
      albedo: `
        float finishGrazing = pow(1.0 - clamp(dot(normalize(vNormalW), normalize(view_position - vPositionW)), 0.0, 1.0), 3.0);
        dAlbedo = mix(dAlbedo, vec3(0.18, 0.31, 0.37), finishGrazing * 0.44);`,
      opacity: 'dAlpha = clamp(dAlpha + 0.08, 0.0, 1.0);',
    });
    return;
  }
  const albedo = {
    wheel: `float rubber = 1.0 - smoothstep(0.014, 0.023, dAlbedo.r);
      float filing = finishBand(vFinishPos.x * 27.0) + 0.4 * finishBand((vFinishPos.z + vFinishPos.y) * 61.0);
      dAlbedo *= 1.0 + filing * mix(0.055, 0.18, rubber);`,
    track: `float milling = finishBand(vFinishPos.z * 44.0 + vFinishPos.x * 1.5);
      float face = smoothstep(0.012, 0.025, vFinishPos.y);
      dAlbedo *= 0.93 + face * 0.21 + milling * 0.055;`,
    carbon: `vec2 p = vFinishPos.xz * 340.0;
      float weave = finishBand(p.x) * finishBand(p.y) + 0.4 * finishBand((p.x - p.y) * 0.5);
      dAlbedo *= 1.0 + weave * 0.24;`,
  }[finish];
  addShaderHooks(mat, {
    vsDecl: 'varying vec3 vFinishPos;',
    vsMainEnd: 'vFinishPos = vertex_position.xyz;',
    psDecl: declarations,
    albedo,
    gloss: finish === 'wheel'
      ? 'float finishRubber = 1.0 - smoothstep(0.014, 0.023, material_diffuse.r); dGlossiness = mix(0.55, 0.06, finishRubber);'
      : undefined,
    metalness: finish === 'wheel'
      ? 'float finishRubber = 1.0 - smoothstep(0.014, 0.023, material_diffuse.r); dMetalness = mix(0.67, 0.015, finishRubber);'
      : undefined,
  });
}
