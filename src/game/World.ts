import * as THREE from 'three';
import type { LoadedGameAssets } from './AssetLoader';
import type { ObstacleCollider, ObstacleKind, TerrainQuery, WorldRayHit } from './types';

interface LandmarkPad {
  x: number;
  z: number;
  innerRadius: number;
  outerRadius: number;
  elevation: number;
}

interface FallingPropAnim {
  mesh: THREE.Object3D;
  axis: THREE.Vector3;
  angle: number;
  angVel: number;
  maxAngle: number;
  sinkY: number;
}

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);

  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm(x: number, z: number): number {
  let v = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < 4; i++) {
    v += amp * (valueNoise(x * freq, z * freq) * 2 - 1);
    freq *= 2.03;
    amp *= 0.5;
  }
  return v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export class World implements TerrainQuery {
  public readonly worldHalfSize = 260;
  public readonly root = new THREE.Group();
  public readonly sunLight: THREE.DirectionalLight;
  public readonly hemiLight: THREE.HemisphereLight;

  private readonly pads: LandmarkPad[] = [];
  private readonly obstacles: ObstacleCollider[] = [];
  private readonly fallingProps: FallingPropAnim[] = [];
  private grassMesh: THREE.InstancedMesh | null = null;
  private grassTimeUniform = { value: 0 };
  private elapsedTime = 0;

  private readonly _rayPt = new THREE.Vector3();
  private readonly _rayNorm = new THREE.Vector3();
  private readonly _rayHitResult: WorldRayHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    hitKind: 'terrain',
  };
  private lastShadowSnapX = Infinity;
  private lastShadowSnapZ = Infinity;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly assets: LoadedGameAssets
  ) {
    this.root.name = 'battlefield_world';
    this.scene.add(this.root);

    // Calibrated atmospheric sky & environment reflections
    this.scene.background = assets.skyBackground;
    this.scene.environment = assets.skyEnvMap;
    this.scene.environmentIntensity = 0.92;
    this.scene.fog = new THREE.FogExp2('#9eb0ba', 0.00145);

    // Warm golden-afternoon directional sun + cool sky bounce hemisphere
    this.hemiLight = new THREE.HemisphereLight('#c6dcff', '#5b6344', 0.52);
    this.root.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight('#fff1d6', 2.65);
    this.sunLight.position.set(110, 145, -85);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1536, 1536);
    this.sunLight.shadow.camera.near = 20;
    this.sunLight.shadow.camera.far = 340;
    const shadowHalf = 80;
    this.sunLight.shadow.camera.left = -shadowHalf;
    this.sunLight.shadow.camera.right = shadowHalf;
    this.sunLight.shadow.camera.top = shadowHalf;
    this.sunLight.shadow.camera.bottom = -shadowHalf;
    this.sunLight.shadow.bias = -0.00045;
    this.sunLight.shadow.normalBias = 0.025;
    this.root.add(this.sunLight);
    this.root.add(this.sunLight.target);

    this.initLandmarkPads();
    this.buildTerrainMesh();
    this.populateBattlefieldProps();
    this.buildInstancedSteppeGrass();
  }

  private rawSteppeHeight(x: number, z: number): number {
    // Rolling central steppe hills (+/- 6.4m) with gentle tank hull-down defilade hollows
    const macro = fbm(x * 0.0052 + 3.1, z * 0.0052 - 1.7) * 6.4;
    const mid = fbm(x * 0.016 - 5.4, z * 0.016 + 2.8) * 1.65;
    let h = macro + mid;

    // Slightly flatten main roads so driving roads feels graded & engineered
    const road = this.getRoadFactorAt(x, z);
    h *= 1 - road * 0.32;

    // Gentle southern staging meadow calming around (0, -190)
    const dSpawn = Math.hypot(x - 0, z + 190);
    if (dSpawn < 36) {
      const w = 1 - smoothstep(12, 36, dSpawn);
      h = THREE.MathUtils.lerp(h, 0.0, w * 0.82);
    }

    // Outer perimeter foothills beyond playable 250m square to frame the horizon naturally
    const boxDist = Math.max(Math.abs(x), Math.abs(z));
    if (boxDist > 235) {
      const ridgeT = smoothstep(235, 310, boxDist);
      const ridgeDetail = 0.7 + 0.6 * valueNoise(x * 0.025, z * 0.025);
      h += ridgeT * 21.0 * ridgeDetail;
    }

    return h;
  }

  private initLandmarkPads(): void {
    const padSpecs: Omit<LandmarkPad, 'elevation'>[] = [
      // Central crossroads ruined apartment blocks
      { x: 38, z: 28, innerRadius: 15, outerRadius: 28 },
      { x: -46, z: -18, innerRadius: 15, outerRadius: 28 },
      // Northern abandoned fuel depot
      { x: 14, z: 126, innerRadius: 15, outerRadius: 28 },
      // Guard tower checkpoints
      { x: -94, z: 96, innerRadius: 10, outerRadius: 20 },
      { x: 106, z: -88, innerRadius: 10, outerRadius: 20 },
    ];

    for (const p of padSpecs) {
      this.pads.push({
        ...p,
        elevation: this.rawSteppeHeight(p.x, p.z),
      });
    }
  }

  public getHeightAt(x: number, z: number): number {
    let h = this.rawSteppeHeight(x, z);
    for (let i = 0; i < this.pads.length; i++) {
      const p = this.pads[i];
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.outerRadius) {
        const w = 1 - smoothstep(p.innerRadius, p.outerRadius, d);
        h = THREE.MathUtils.lerp(h, p.elevation, w);
      }
    }
    return h;
  }

  public getNormalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const eps = 0.6;
    const hL = this.getHeightAt(x - eps, z);
    const hR = this.getHeightAt(x + eps, z);
    const hD = this.getHeightAt(x, z - eps);
    const hU = this.getHeightAt(x, z + eps);
    return out.set(hL - hR, 2 * eps, hD - hU).normalize();
  }

  public getRoadFactorAt(x: number, z: number): number {
    // Primary North-South winding steppe road
    const nsCenterX = 16 * Math.sin(z * 0.0135) + 6 * Math.cos(z * 0.031);
    const dNS = Math.abs(x - nsCenterX);
    const roadNS = 1 - smoothstep(4.2, 8.8, dNS);

    // Secondary East-West tactical crossroad
    const ewCenterZ = 8 + 15 * Math.sin(x * 0.0145);
    const dEW = Math.abs(z - ewCenterZ);
    const roadEW = 1 - smoothstep(3.8, 8.2, dEW);

    // Outer patrol track loop at radius ~136m
    const r = Math.hypot(x * 0.96, z * 1.04);
    const dLoop = Math.abs(r - 136 + 10 * Math.sin(Math.atan2(z, x) * 3));
    const roadLoop = (1 - smoothstep(3.4, 7.5, dLoop)) * 0.88;

    return Math.max(roadNS, roadEW, roadLoop);
  }

  /** Register a runtime obstacle (e.g. a settled wreck). Returns nothing; pass the same object to removeObstacle. */
  public addObstacle(obs: ObstacleCollider): void {
    this.obstacles.push(obs);
  }

  public removeObstacle(obs: ObstacleCollider): void {
    const idx = this.obstacles.indexOf(obs);
    if (idx >= 0) this.obstacles.splice(idx, 1);
  }

  public getObstacles(): readonly ObstacleCollider[] {
    return this.obstacles;
  }

  public setQuality(quality: 'high' | 'medium'): void {
    if (this.grassMesh) {
      this.grassMesh.count =
        quality === 'high'
          ? this.grassMesh.instanceMatrix.count
          : Math.floor(this.grassMesh.instanceMatrix.count * 0.45);
    }
    const targetShadow = quality === 'high' ? 2048 : 1024;
    if (this.sunLight.shadow.mapSize.x !== targetShadow) {
      this.sunLight.shadow.mapSize.set(targetShadow, targetShadow);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
  }

  private buildTerrainMesh(): void {
    const terrainSize = 620;
    const segs = 144;
    const geo = new THREE.PlaneGeometry(terrainSize, terrainSize, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position as THREE.BufferAttribute;
    const roadAttr = new Float32Array(pos.count);
    const meadowAttr = new Float32Array(pos.count);

    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vz = pos.getZ(i);
      const vy = this.getHeightAt(vx, vz);
      pos.setY(i, vy);

      let dirtMask = this.getRoadFactorAt(vx, vz);
      for (const pad of this.pads) {
        const dp = Math.hypot(vx - pad.x, vz - pad.z);
        if (dp < pad.outerRadius * 0.82) {
          dirtMask = Math.max(dirtMask, (1 - smoothstep(pad.innerRadius * 0.5, pad.outerRadius * 0.82, dp)) * 0.78);
        }
      }
      roadAttr[i] = dirtMask;
      meadowAttr[i] = valueNoise(vx * 0.048 + 11.3, vz * 0.048 + 11.3);
    }

    geo.setAttribute('aRoadMask', new THREE.BufferAttribute(roadAttr, 1));
    geo.setAttribute('aMeadowDry', new THREE.BufferAttribute(meadowAttr, 1));
    geo.computeVertexNormals();

    const tex = this.assets.terrainTextures;
    const mat = new THREE.MeshStandardMaterial({
      map: tex.grassColor,
      normalMap: tex.grassNormal,
      roughness: 0.90,
      metalness: 0.02,
      envMapIntensity: 0.55,
    });

    // Fast 4-tap splat + wet-puddle specular + drifting cumulus cloud shadows + directional Mie aerial perspective
    mat.customProgramCacheKey = () => 'steppe-terrain-hyper-v2';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDirtColor = { value: tex.dirtColor };
      shader.uniforms.uDirtNormal = { value: tex.dirtNormal };
      shader.uniforms.uTime = this.grassTimeUniform;
      shader.uniforms.uSunDir = { value: new THREE.Vector3(110, 145, -85).normalize() };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aRoadMask;
          attribute float aMeadowDry;
          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;
          varying float vRoadMask;
          varying float vMeadowDry;`
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vTerrainWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
          vRoadMask = aRoadMask;
          vMeadowDry = aMeadowDry;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D uDirtColor;
          uniform sampler2D uDirtNormal;
          uniform float uTime;
          uniform vec3 uSunDir;
          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;
          varying float vRoadMask;
          varying float vMeadowDry;

          float fastCloudNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
            float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
            float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
            float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
          }`
        )
        .replace(
          '#include <map_fragment>',
          `
          vec2 detailUV = vTerrainWorldPos.xz * 0.145;
          vec3 grassCol = texture2D(map, detailUV).rgb;
          grassCol *= mix(vec3(0.74, 0.85, 0.60), vec3(1.05, 0.96, 0.72), vMeadowDry * 0.74);

          vec3 dirtCol = texture2D(uDirtColor, detailUV * 1.15).rgb * vec3(0.90, 0.83, 0.74);

          float slopeFactor = smoothstep(0.11, 0.34, 1.0 - clamp(vTerrainWorldNormal.y, 0.0, 1.0));
          float splatDirt = clamp(max(vRoadMask * 0.96, slopeFactor * 0.88) + (vMeadowDry - 0.62) * 0.22, 0.0, 1.0);

          // Wet mud wheel-ruts & rain puddles along flat road stretches
          float rutWave = sin(vTerrainWorldPos.x * 0.85 + vTerrainWorldPos.z * 0.65);
          float puddleMask = smoothstep(0.62, 0.92, vRoadMask)
                           * smoothstep(0.56, 0.80, vMeadowDry + rutWave * 0.18)
                           * smoothstep(0.94, 0.995, vTerrainWorldNormal.y);

          vec3 baseAlbedo = mix(grassCol, dirtCol, splatDirt);
          baseAlbedo = mix(baseAlbedo, dirtCol * vec3(0.46, 0.44, 0.42), puddleMask * 0.78);

          // Drifting overhead cumulus cloud shadows across the 520m valley
          vec2 cloudUV = vTerrainWorldPos.xz * 0.0085 + vec2(uTime * 0.011, uTime * 0.005);
          float cloudN = fastCloudNoise(cloudUV) * 0.65 + fastCloudNoise(cloudUV * 2.3 + 4.1) * 0.35;
          float cloudLight = mix(0.68, 1.06, smoothstep(0.34, 0.68, cloudN));

          diffuseColor.rgb *= baseAlbedo * cloudLight;
          `
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `
          float roughnessFactor = roughness;
          float rutWaveR = sin(vTerrainWorldPos.x * 0.85 + vTerrainWorldPos.z * 0.65);
          float puddleR = smoothstep(0.62, 0.92, vRoadMask)
                        * smoothstep(0.56, 0.80, vMeadowDry + rutWaveR * 0.18)
                        * smoothstep(0.94, 0.995, vTerrainWorldNormal.y);
          // Mirror-smooth wet puddle specular glints (0.13) vs matte grass/soil (0.90)
          roughnessFactor = mix(mix(0.92, 0.76, vRoadMask), 0.13, puddleR);
          `
        )
        .replace(
          '#include <normal_fragment_maps>',
          `
          vec2 nUV = vTerrainWorldPos.xz * 0.145;
          vec3 gN = texture2D(normalMap, nUV).xyz * 2.0 - 1.0;
          vec3 dN = texture2D(uDirtNormal, nUV * 1.15).xyz * 2.0 - 1.0;
          float slopeN = smoothstep(0.11, 0.34, 1.0 - clamp(vTerrainWorldNormal.y, 0.0, 1.0));
          float splatN = clamp(max(vRoadMask * 0.96, slopeN * 0.88), 0.0, 1.0);
          float rutWaveN = sin(vTerrainWorldPos.x * 0.85 + vTerrainWorldPos.z * 0.65);
          float puddleN = smoothstep(0.62, 0.92, vRoadMask)
                        * smoothstep(0.56, 0.80, vMeadowDry + rutWaveN * 0.18)
                        * smoothstep(0.94, 0.995, vTerrainWorldNormal.y);
          vec3 blendedTangentN = normalize(mix(gN, dN, splatN));
          // Flatten surface normal across standing water puddles for razor-sharp sky speculars
          float bumpAmp = mix(0.42, 0.04, puddleN);
          vec3 worldPerturb = normalize(vTerrainWorldNormal + vec3(blendedTangentN.x * bumpAmp, 0.0, blendedTangentN.y * bumpAmp));
          normal = normalize((viewMatrix * vec4(worldPerturb, 0.0)).xyz);
          `
        )
        .replace(
          '#include <fog_fragment>',
          `#ifdef USE_FOG
            vec3 viewToFrag = normalize(vTerrainWorldPos - cameraPosition);
            float sunAlign = max(dot(viewToFrag, uSunDir), 0.0);
            vec3 rayleighSky = vec3(0.58, 0.69, 0.80);
            vec3 mieSunHaze  = vec3(0.96, 0.86, 0.70);
            vec3 scatterColor = mix(rayleighSky, mieSunHaze, pow(sunAlign, 3.0) * 0.72);
            float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, scatterColor, clamp(fogFactor, 0.0, 1.0));
          #endif`
        );
    };

    const terrainMesh = new THREE.Mesh(geo, mat);
    terrainMesh.name = 'steppe_terrain';
    terrainMesh.receiveShadow = true;
    terrainMesh.updateMatrix();
    terrainMesh.matrixAutoUpdate = false;
    this.root.add(terrainMesh);
  }

  private populateBattlefieldProps(): void {
    // 1. Central Ruined Apartment Compounds (with foundation skirt sitting flush on flattened pads)
    this.placeRuinedBuilding('bldg_east', 38, 28, -0.35);
    this.placeRuinedBuilding('bldg_west', -46, -18, 2.65);

    // 2. Northern Abandoned Fuel Station Depot
    this.placeFuelStation('fuel_north', 14, 126, 0.18);

    // 3. Guard Tower Checkpoints (tower + destructible gate boom)
    this.placeGuardTower('tower_nw', -94, 96, 0.72);
    this.placeGuardTower('tower_se', 106, -88, -2.15);

    // 4. Tactical Hesco Defensive Berms — batched into ONE InstancedMesh!
    const bermClusters: { cx: number; cz: number; yaw: number; count: number }[] = [
      { cx: 12, cz: -34, yaw: 0.12, count: 4 },
      { cx: -18, cz: 46, yaw: -0.45, count: 4 },
      { cx: 68, cz: 10, yaw: 1.35, count: 3 },
      { cx: -76, cz: -58, yaw: 0.65, count: 3 },
      { cx: -4, cz: 102, yaw: 0.08, count: 4 },
      { cx: 64, cz: -115, yaw: -0.5, count: 3 },
    ];
    const wallTransforms: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    let wallIdx = 0;
    for (const c of bermClusters) {
      const cosY = Math.cos(c.yaw);
      const sinY = Math.sin(c.yaw);
      for (let i = 0; i < c.count; i++) {
        const offset = (i - (c.count - 1) * 0.5) * 3.05;
        const wx = c.cx + cosY * offset;
        const wz = c.cz - sinY * offset;
        const wy = this.getHeightAt(wx, wz) - 0.04;
        dummy.position.set(wx, wy, wz);
        dummy.rotation.set(0, c.yaw, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        wallTransforms.push(dummy.matrix.clone());
        this.obstacles.push({
          id: `hesco_${wallIdx++}`,
          kind: 'barrier',
          x: wx,
          y: wy,
          z: wz,
          radius: 1.42,
          height: 1.43,
          destructible: false,
          destroyed: false,
        });
      }
    }
    this.addBatchedStaticModel(this.assets.models.barrier_wall, wallTransforms, false);

    // 5. Destructible Supply Crate Stacks near compounds & checkpoints
    const crateCoords: [number, number, number][] = [
      [25, 22, 0.3],
      [28, 34, 1.1],
      [-33, -22, -0.4],
      [-55, -8, 0.8],
      [26, 120, -0.2],
      [-2, 122, 0.6],
      [-88, 88, 0.5],
      [98, -80, -0.7],
      [15, -39, 0.2],
      [-22, 51, 1.0],
      [72, 14, -0.3],
      [-72, -52, 0.4],
    ];
    crateCoords.forEach(([cx, cz, yaw], idx) => {
      const cy = this.getHeightAt(cx, cz) - 0.03;
      const crate = this.assets.models.supply_crates.clone(true);
      crate.position.set(cx, cy, cz);
      crate.rotation.y = yaw;
      this.root.add(crate);
      this.obstacles.push({
        id: `crate_${idx}`,
        kind: 'crates',
        x: cx,
        y: cy,
        z: cz,
        radius: 1.38,
        height: 2.6,
        destructible: true,
        destroyed: false,
        mesh: crate,
      });
    });

    // 6. Deterministic Limestone Boulder Outcrops — batched into TWO InstancedMeshes (1 draw call each)!
    const largeRockTransforms: THREE.Matrix4[] = [];
    const medRockTransforms: THREE.Matrix4[] = [];
    let rockIdx = 0;
    for (let i = 0; i < 38; i++) {
      const angle = i * 2.399963 + 0.5;
      const rad = 36 + ((i * 47) % 195);
      const rx = Math.cos(angle) * rad;
      const rz = Math.sin(angle) * rad;
      if (!this.isClearForScatter(rx, rz, 8.5)) continue;

      const isLarge = i % 3 !== 0;
      const scale = isLarge ? 0.95 + hash2(i, 7.1) * 0.65 : 0.9 + hash2(i, 3.3) * 0.55;
      const ry = this.getHeightAt(rx, rz) - 0.08 * scale;
      dummy.position.set(rx, ry, rz);
      dummy.rotation.set(0, hash2(i, 19.3) * Math.PI * 2, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      if (isLarge) largeRockTransforms.push(dummy.matrix.clone());
      else medRockTransforms.push(dummy.matrix.clone());

      this.obstacles.push({
        id: `rock_${rockIdx++}`,
        kind: 'rock',
        x: rx,
        y: ry,
        z: rz,
        radius: (isLarge ? 1.32 : 0.74) * scale,
        height: (isLarge ? 1.38 : 0.74) * scale,
        destructible: false,
        destroyed: false,
      });
    }
    this.addBatchedStaticModel(this.assets.models.boulder_large, largeRockTransforms, true);
    this.addBatchedStaticModel(this.assets.models.boulder_medium, medRockTransforms, false);

    // 7. Lean Aspen Tree Groves (~28 well-spaced trees to keep draw calls & shadow tris super fast)
    let treeIdx = 0;
    for (let i = 0; i < 36; i++) {
      const clusterAngle = (i % 12) * ((Math.PI * 2) / 12) + Math.floor(i / 12) * 0.34;
      const baseR = i < 18 ? 68 + ((i * 37) % 135) : 195 + ((i * 23) % 42);
      const jitterX = (hash2(i, 41.2) - 0.5) * 26;
      const jitterZ = (hash2(i, 83.7) - 0.5) * 26;
      const tx = Math.cos(clusterAngle) * baseR + jitterX;
      const tz = Math.sin(clusterAngle) * baseR + jitterZ;
      if (Math.abs(tx) > this.worldHalfSize - 10 || Math.abs(tz) > this.worldHalfSize - 10) continue;
      if (!this.isClearForScatter(tx, tz, 6.5)) continue;

      const scale = 0.82 + hash2(i, 12.9) * 0.42;
      const ty = this.getHeightAt(tx, tz) - 0.08 * scale;
      const tree = this.assets.models.tree.clone(true);
      tree.position.set(tx, ty, tz);
      tree.rotation.y = hash2(i, 55.1) * Math.PI * 2;
      tree.scale.setScalar(scale); // Strictly uniform scale!
      this.root.add(tree);

      this.obstacles.push({
        id: `tree_${treeIdx++}`,
        kind: 'tree',
        x: tx,
        y: ty,
        z: tz,
        radius: 0.48 * scale, // Trunk collision cylinder!
        height: 14.2 * scale,
        destructible: true,
        destroyed: false,
        mesh: tree,
      });
    }
  }

  private addBatchedStaticModel(
    template: THREE.Object3D,
    worldMatrices: readonly THREE.Matrix4[],
    castShadow: boolean
  ): void {
    if (worldMatrices.length === 0) return;
    template.updateMatrixWorld(true);
    const invRoot = new THREE.Matrix4().copy(template.matrixWorld).invert();
    const localMat = new THREE.Matrix4();
    const finalMat = new THREE.Matrix4();

    template.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      localMat.multiplyMatrices(invRoot, mesh.matrixWorld);
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, worldMatrices.length);
      inst.castShadow = castShadow;
      inst.receiveShadow = true;
      inst.matrixAutoUpdate = false;
      for (let i = 0; i < worldMatrices.length; i++) {
        finalMat.multiplyMatrices(worldMatrices[i], localMat);
        inst.setMatrixAt(i, finalMat);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      this.root.add(inst);
    });
  }

  private placeRuinedBuilding(id: string, x: number, z: number, yaw: number): void {
    const y = this.getHeightAt(x, z);
    const bldg = this.assets.models.ruined_building.clone(true);
    bldg.position.set(x, y, z);
    bldg.rotation.y = yaw;
    bldg.updateMatrixWorld(true);
    bldg.traverse((o) => {
      o.matrixAutoUpdate = false;
    });
    this.root.add(bldg);

    // Verified from asset_report.json: ruined_building bounds center is [+1.56, 6.43, +2.47]
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const localCx = 1.56;
    const localCz = 2.47;
    const worldCx = x + localCx * cosY + localCz * sinY;
    const worldCz = z - localCx * sinY + localCz * cosY;

    this.obstacles.push({
      id,
      kind: 'building',
      x: worldCx,
      y,
      z: worldCz,
      radius: 9.6,
      height: 13.0,
      destructible: false,
      destroyed: false,
      mesh: bldg,
    });
  }

  private placeFuelStation(id: string, x: number, z: number, yaw: number): void {
    const y = this.getHeightAt(x, z);
    const station = this.assets.models.fuel_station.clone(true);
    station.position.set(x, y, z);
    station.rotation.y = yaw;
    station.updateMatrixWorld(true);
    station.traverse((o) => {
      o.matrixAutoUpdate = false;
    });
    this.root.add(station);

    this.obstacles.push({
      id,
      kind: 'station',
      x,
      y,
      z,
      radius: 8.8,
      height: 6.0,
      destructible: false,
      destroyed: false,
      mesh: station,
    });
  }

  private placeGuardTower(id: string, x: number, z: number, yaw: number): void {
    const y = this.getHeightAt(x, z);
    const towerAssembly = this.assets.models.guard_tower.clone(true);
    towerAssembly.position.set(x, y, z);
    towerAssembly.rotation.y = yaw;
    towerAssembly.updateMatrixWorld(true);
    towerAssembly.traverse((o) => {
      if (o.name !== 'barrier_gate') o.matrixAutoUpdate = false;
    });
    this.root.add(towerAssembly);

    // Main 5.8x5.8m tower at local [0, 0, 0]
    this.obstacles.push({
      id,
      kind: 'tower',
      x,
      y,
      z,
      radius: 3.05,
      height: 10.45,
      destructible: false,
      destroyed: false,
      mesh: towerAssembly,
    });

    // Checkpoint barrier gate sub-assembly at local [+7.5, 0, 0] (destructible if rammed!)
    const gateNode = towerAssembly.getObjectByName('barrier_gate');
    if (gateNode) {
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const gx = x + 7.5 * cosY;
      const gz = z - 7.5 * sinY;
      this.obstacles.push({
        id: `${id}_gate`,
        kind: 'barrier',
        x: gx,
        y,
        z: gz,
        radius: 2.3,
        height: 2.3,
        destructible: true,
        destroyed: false,
        mesh: gateNode,
      });
    }
  }

  private isClearForScatter(x: number, z: number, clearance: number): boolean {
    // Keep southern player staging spawn meadow clear
    if (Math.hypot(x - 0, z + 190) < 30) return false;
    // Keep roads clear
    if (this.getRoadFactorAt(x, z) > 0.35) return false;
    // Keep landmark pads clear
    for (const pad of this.pads) {
      if (Math.hypot(x - pad.x, z - pad.z) < pad.innerRadius + 4) return false;
    }
    // Keep existing obstacles clear
    for (const obs of this.obstacles) {
      const minD = obs.radius + clearance * 0.45;
      if ((x - obs.x) * (x - obs.x) + (z - obs.z) * (z - obs.z) < minD * minD) return false;
    }
    return true;
  }

  /**
   * Builds 7,500 lightweight GPU-instanced 4-blade grass clumps in a single fast draw call.
   */
  private buildInstancedSteppeGrass(): void {
    const bladeCount = 4;
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];

    const rootCol = new THREE.Color('#2d381d');
    const tipCol = new THREE.Color('#778348');

    for (let b = 0; b < bladeCount; b++) {
      const ang = (b / bladeCount) * Math.PI * 2 + b * 0.43;
      const lean = 0.09 + (b % 3) * 0.055;
      const h = 0.24 + (b % 4) * 0.065;
      const hw = 0.024;

      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);
      const offX = cosA * 0.06;
      const offZ = sinA * 0.06;

      const lx = offX - sinA * hw;
      const lz = offZ + cosA * hw;
      const rx = offX + sinA * hw;
      const rz = offZ - cosA * hw;
      const tx = offX + cosA * lean;
      const tz = offZ + sinA * lean;

      positions.push(lx, 0, lz, rx, 0, rz, tx, h, tz);
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      colors.push(rootCol.r, rootCol.g, rootCol.b, rootCol.r, rootCol.g, rootCol.b, tipCol.r, tipCol.g, tipCol.b);
    }

    const tuftGeo = new THREE.BufferGeometry();
    tuftGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    tuftGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    tuftGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    tuftGeo.computeBoundingSphere();

    const tuftMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    tuftMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.grassTimeUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec3 instWorld = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float swayWeight = clamp(position.y * 2.4, 0.0, 1.0);
          float gust = sin(uTime * 2.0 + instWorld.x * 0.14 + instWorld.z * 0.11) * 0.07;
          transformed.x += gust * swayWeight;
          transformed.z += gust * 0.5 * swayWeight;`
        );
    };

    const maxTufts = 7500;
    const inst = new THREE.InstancedMesh(tuftGeo, tuftMat, maxTufts);
    inst.name = 'steppe_grass_instanced';
    inst.receiveShadow = false;
    inst.castShadow = false;

    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    let placed = 0;

    for (let i = 0; i < maxTufts * 3 && placed < maxTufts; i++) {
      const gx = (hash2(i, 1.17) * 2 - 1) * 230;
      const gz = (hash2(i, 9.43) * 2 - 1) * 230;
      if (this.getRoadFactorAt(gx, gz) > 0.22) continue;
      // Cluster into natural organic meadow patches instead of uniform isolated dots
      if (valueNoise(gx * 0.07 + 4.2, gz * 0.07 - 2.9) < 0.34) continue;

      let insidePad = false;
      for (const pad of this.pads) {
        if (Math.hypot(gx - pad.x, gz - pad.z) < pad.innerRadius + 1.5) {
          insidePad = true;
          break;
        }
      }
      if (insidePad) continue;

      const gy = this.getHeightAt(gx, gz);
      const n = this.getNormalAt(gx, gz, this._rayNorm);
      if (n.y < 0.84) continue;

      const sc = 0.75 + hash2(i, 27.6) * 0.72;
      dummy.position.set(gx, gy - 0.015, gz);
      dummy.rotation.set(0, hash2(i, 61.4) * Math.PI * 2, 0);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      inst.setMatrixAt(placed, dummy.matrix);

      const dry = valueNoise(gx * 0.055 + 11.3, gz * 0.055 + 11.3);
      tint.setRGB(
        THREE.MathUtils.lerp(0.82, 1.12, dry),
        THREE.MathUtils.lerp(0.92, 1.00, dry),
        THREE.MathUtils.lerp(0.74, 0.80, dry)
      );
      inst.setColorAt(placed, tint);
      placed++;
    }

    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.grassMesh = inst;
    this.root.add(inst);
  }

  public crushObstacle(obstacle: ObstacleCollider, impactDirXZ?: THREE.Vector2): void {
    if (obstacle.destroyed || !obstacle.destructible) return;
    obstacle.destroyed = true;
    if (!obstacle.mesh) return;

    const dirX = impactDirXZ && impactDirXZ.lengthSq() > 0.001 ? impactDirXZ.x : 0.7;
    const dirZ = impactDirXZ && impactDirXZ.lengthSq() > 0.001 ? impactDirXZ.y : 0.7;
    const len = Math.hypot(dirX, dirZ) || 1;
    // Rotation axis perpendicular to impact direction in world XZ (`up × impactDir`)
    const axis = new THREE.Vector3(dirZ / len, 0, -dirX / len).normalize();

    this.fallingProps.push({
      mesh: obstacle.mesh,
      axis,
      angle: 0,
      angVel: obstacle.kind === 'tree' ? 1.35 : 3.2,
      maxAngle: obstacle.kind === 'tree' ? Math.PI * 0.47 : Math.PI * 0.48,
      sinkY: obstacle.kind === 'crates' ? 0.55 : 0.05,
    });
  }

  public raycastWorld(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): WorldRayHit | null {
    let bestDist = maxDist;
    let hitKind: 'terrain' | 'obstacle' | null = null;
    let hitObs: ObstacleCollider | undefined;
    const hitPoint = this._rayPt;
    const hitNormal = this._rayNorm.set(0, 1, 0);

    // 1. Analytical vertical cylinder intersection against non-destroyed obstacles
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;
    const horizLenSq = dx * dx + dz * dz;

    if (horizLenSq > 1e-7) {
      for (let i = 0; i < this.obstacles.length; i++) {
        const obs = this.obstacles[i];
        if (obs.destroyed) continue;
        const ox = origin.x - obs.x;
        const oz = origin.z - obs.z;
        const b = ox * dx + oz * dz;
        const c = ox * ox + oz * oz - obs.radius * obs.radius;
        if (c > 0 && b > 0) continue;

        const disc = b * b - horizLenSq * c;
        if (disc < 0) continue;

        const t = Math.max(0, (-b - Math.sqrt(disc)) / horizLenSq);
        if (t >= bestDist) continue;

        const py = origin.y + dy * t;
        if (py >= obs.y && py <= obs.y + obs.height) {
          bestDist = t;
          hitKind = 'obstacle';
          hitObs = obs;
          hitPoint.set(origin.x + dx * t, py, origin.z + dz * t);
          hitNormal.set(hitPoint.x - obs.x, 0, hitPoint.z - obs.z).normalize();
        }
      }
    }

    // 2. Fast adaptive heightmap march + 4-step binary refinement
    const stepBase = 3.6;
    let prevT = 0;

    for (let t = stepBase; t <= bestDist + stepBase; t += stepBase) {
      const clampedT = Math.min(t, bestDist);
      const px = origin.x + dx * clampedT;
      const py = origin.y + dy * clampedT;
      const pz = origin.z + dz * clampedT;

      if (py <= this.getHeightAt(px, pz)) {
        let lo = prevT;
        let hi = clampedT;
        for (let iter = 0; iter < 4; iter++) {
          const mid = 0.5 * (lo + hi);
          if (origin.y + dy * mid <= this.getHeightAt(origin.x + dx * mid, origin.z + dz * mid)) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        if (hi <= bestDist) {
          bestDist = hi;
          hitKind = 'terrain';
          hitObs = undefined;
          hitPoint.set(origin.x + dx * hi, origin.y + dy * hi, origin.z + dz * hi);
          hitPoint.y = this.getHeightAt(hitPoint.x, hitPoint.z);
          this.getNormalAt(hitPoint.x, hitPoint.z, hitNormal);
        }
        break;
      }

      prevT = clampedT;
      if (clampedT >= bestDist) break;
    }

    if (!hitKind) return null;

    this._rayHitResult.point.copy(hitPoint);
    this._rayHitResult.normal.copy(hitNormal);
    this._rayHitResult.distance = bestDist;
    this._rayHitResult.hitKind = hitKind;
    this._rayHitResult.obstacle = hitObs;
    return this._rayHitResult;
  }

  public getSafeSpawnPoint(
    preferRadiusMin: number,
    preferRadiusMax: number,
    avoidPoints: readonly THREE.Vector3[],
    center?: { x: number; z: number }
  ): THREE.Vector3 {
    const cx0 = center?.x ?? 0;
    const cz0 = center?.z ?? 0;
    const best = new THREE.Vector3(cx0, 0, cz0);
    let bestScore = -Infinity;

    for (let attempt = 0; attempt < 42; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = THREE.MathUtils.lerp(preferRadiusMin, preferRadiusMax, Math.random());
      const cx = THREE.MathUtils.clamp(cx0 + Math.cos(ang) * rad, -this.worldHalfSize + 24, this.worldHalfSize - 24);
      const cz = THREE.MathUtils.clamp(cz0 + Math.sin(ang) * rad, -this.worldHalfSize + 24, this.worldHalfSize - 24);

      // Must be clear of solid obstacles
      let blocked = false;
      for (const obs of this.obstacles) {
        if (obs.destroyed) continue;
        const dSq = (cx - obs.x) * (cx - obs.x) + (cz - obs.z) * (cz - obs.z);
        const need = obs.radius + 5.5;
        if (dSq < need * need) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      let minDistToAvoid = 999;
      for (const p of avoidPoints) {
        const d = Math.hypot(cx - p.x, cz - p.z);
        if (d < minDistToAvoid) minDistToAvoid = d;
      }

      if (minDistToAvoid > bestScore) {
        bestScore = minDistToAvoid;
        best.set(cx, this.getHeightAt(cx, cz), cz);
      }
      if (minDistToAvoid > 165) break;
    }

    best.y = this.getHeightAt(best.x, best.z);
    return best;
  }

  public update(dt: number, shadowFocusPos: THREE.Vector3): void {
    this.elapsedTime += dt;
    this.grassTimeUniform.value = this.elapsedTime;

    // Only update sun shadow frustum when player moves onto a new 3m cell
    const snap = 3.0;
    const fx = Math.round(shadowFocusPos.x / snap) * snap;
    const fz = Math.round(shadowFocusPos.z / snap) * snap;
    if (fx !== this.lastShadowSnapX || fz !== this.lastShadowSnapZ) {
      this.lastShadowSnapX = fx;
      this.lastShadowSnapZ = fz;
      const fy = this.getHeightAt(fx, fz);
      this.sunLight.target.position.set(fx, fy, fz);
      this.sunLight.position.set(fx + 110, fy + 145, fz - 85);
      this.sunLight.target.updateMatrixWorld();
    }

    // Animate toppling trees / crushed crates
    for (let i = this.fallingProps.length - 1; i >= 0; i--) {
      const fp = this.fallingProps[i];
      fp.angVel += 4.2 * dt;
      const step = Math.min(fp.angVel * dt, fp.maxAngle - fp.angle);
      fp.angle += step;
      fp.mesh.rotateOnWorldAxis(fp.axis, step);
      fp.mesh.position.y -= fp.sinkY * (step / fp.maxAngle);
      if (fp.angle >= fp.maxAngle - 0.001) {
        this.fallingProps.splice(i, 1);
      }
    }
  }
}
