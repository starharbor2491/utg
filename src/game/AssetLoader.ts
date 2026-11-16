import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Team, VehicleClass } from './types';

export type ModelKey =
  | 'player_mbt_lod1'
  | 'ruined_building'
  | 'guard_tower'
  | 'fuel_station'
  | 'boulder_large'
  | 'boulder_medium'
  | 'tree'
  | 'barrier_wall'
  | 'supply_crates';

export interface WheelNodeBinding {
  node: THREE.Object3D;
  side: 'L' | 'R';
  radius: number;
}

export interface InstantiatedTankRig {
  root: THREE.Group;
  hullTiltGroup: THREE.Group;
  visualRoot: THREE.Object3D;
  turretPivot: THREE.Object3D;
  turretRestPos: THREE.Vector3;
  gunPivot: THREE.Object3D;
  gunRecoilGroup: THREE.Object3D;
  muzzleNode: THREE.Object3D;
  coaxNode: THREE.Object3D;
  rwsNode: THREE.Object3D | null;
  wheels: WheelNodeBinding[];
  hullMeshes: THREE.Mesh[];
}

export interface TerrainTextures {
  grassColor: THREE.Texture;
  grassNormal: THREE.Texture;
  grassRoughness: THREE.Texture;
  dirtColor: THREE.Texture;
  dirtNormal: THREE.Texture;
  dirtRoughness: THREE.Texture;
}

export interface LoadedGameAssets {
  models: Record<ModelKey, THREE.Group>;
  terrainTextures: TerrainTextures;
  skyEnvMap: THREE.Texture;
  skyBackground: THREE.DataTexture;
}

const MODEL_PATHS: Record<ModelKey, string> = {
  player_mbt_lod1: './assets/models/player_mbt_lod1.glb',
  ruined_building: './assets/models/ruined_building.glb',
  guard_tower: './assets/models/guard_tower.glb',
  fuel_station: './assets/models/fuel_station.glb',
  boulder_large: './assets/models/boulder_large.glb',
  boulder_medium: './assets/models/boulder_medium.glb',
  tree: './assets/models/tree.glb',
  barrier_wall: './assets/models/barrier_wall.glb',
  supply_crates: './assets/models/supply_crates.glb',
};

declare global {
  interface Window {
    __EMBEDDED_VFS__?: Record<string, string>;
  }
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function decodeEmbeddedGzipAsset(b64Gzip: string): Promise<Uint8Array> {
  const compressed = base64ToUint8(b64Gzip);
  const ds = new DecompressionStream('gzip');
  const blob = new Blob([compressed as unknown as BlobPart]);
  const decompressedStream = blob.stream().pipeThrough(ds);
  const ab = await new Response(decompressedStream).arrayBuffer();
  return new Uint8Array(ab);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function configureEmbeddedKTX2Loader(
  ktx2Loader: KTX2Loader,
  jsText: string,
  wasmBuffer: ArrayBuffer
): void {
  const ktxAny = ktx2Loader as unknown as {
    workerConfig: unknown;
    transcoderBinary: ArrayBuffer;
    transcoderPending: Promise<void>;
    workerPool: { setWorkerCreator: (fn: () => Worker) => void };
  };
  const ktxStatic = KTX2Loader as unknown as {
    BasisWorker: () => void;
    EngineFormat: unknown;
    EngineType: unknown;
    TranscoderFormat: unknown;
    BasisFormat: unknown;
  };

  const fn = ktxStatic.BasisWorker.toString();
  const body = [
    '/* constants */',
    'let _EngineFormat = ' + JSON.stringify(ktxStatic.EngineFormat),
    'let _EngineType = ' + JSON.stringify(ktxStatic.EngineType),
    'let _TranscoderFormat = ' + JSON.stringify(ktxStatic.TranscoderFormat),
    'let _BasisFormat = ' + JSON.stringify(ktxStatic.BasisFormat),
    '/* basis_transcoder.js */',
    jsText,
    '/* worker */',
    fn.substring(fn.indexOf('{') + 1, fn.lastIndexOf('}')),
  ].join('\n');

  // Use a data: URL worker so even strict `file://` (null opaque origin) never blocks Worker creation!
  const workerBytes = new TextEncoder().encode(body);
  const dataWorkerUrl = 'data:text/javascript;base64,' + uint8ToBase64(workerBytes);

  ktxAny.transcoderBinary = wasmBuffer;
  ktxAny.transcoderPending = Promise.resolve().then(() => {
    ktxAny.workerPool.setWorkerCreator(() => {
      const worker = new Worker(dataWorkerUrl);
      const binCopy = ktxAny.transcoderBinary.slice(0);
      worker.postMessage({ type: 'init', config: ktxAny.workerConfig, transcoderBinary: binCopy }, [
        binCopy,
      ]);
      return worker;
    });
  });
}

/**
 * Lightweight single-pass Rolled-Homogeneous-Armor (RHA) micro-grain, dust edge-sheen,
 * mud skirt weathering & contact ambient-occlusion shader (zero extra render passes!).
 */
export function applyRealisticArmorShader(mat: THREE.MeshStandardMaterial, cacheTag = 'rha-v1'): void {
  const key = `${cacheTag}-${mat.map ? 'tex' : 'notex'}-${mat.normalMap ? 'nrm' : 'nonrm'}`;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vArmorLocalPos;
        varying vec3 vArmorWorldNormal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vArmorLocalPos = position;
        vArmorWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vArmorLocalPos;
        varying vec3 vArmorWorldNormal;
        float rhaHash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        // Micro-scale cast/rolled steel grain + lower-skirt mud splatter + sun-kissed top dust
        float steelGrain = rhaHash(floor(vArmorLocalPos * 46.0)) * 0.08 - 0.04;
        float mudHeight = 1.0 - smoothstep(0.05, 0.72, vArmorLocalPos.y);
        vec3 mudTint = vec3(0.34, 0.29, 0.21);
        diffuseColor.rgb = mix(diffuseColor.rgb * (1.0 + steelGrain), mudTint, mudHeight * 0.34);
        float topDust = smoothstep(0.55, 0.98, vArmorWorldNormal.y) * 0.07;
        diffuseColor.rgb += vec3(topDust * 0.95, topDust * 0.90, topDust * 0.74);`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float grainR = rhaHash(floor(vArmorLocalPos * 32.0)) * 0.12 - 0.06;
        roughnessFactor = clamp(roughnessFactor + grainR, 0.18, 0.96);`
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        // Analytical undercarriage & road-wheel contact ambient occlusion (replaces expensive GTAO!)
        float contactAO = mix(0.44, 1.0, smoothstep(-0.05, 0.95, vArmorLocalPos.y));
        reflectedLight.indirectDiffuse *= contactAO;
        reflectedLight.indirectSpecular *= contactAO;
        reflectedLight.directDiffuse *= mix(0.76, 1.0, contactAO);`
      );
  };
}

export async function loadAllGameAssets(
  renderer: THREE.WebGLRenderer,
  onProgress?: (progress01: number, label: string) => void
): Promise<LoadedGameAssets> {
  if ('ready' in MeshoptDecoder && MeshoptDecoder.ready) {
    await MeshoptDecoder.ready;
  }

  const vfs = window.__EMBEDDED_VFS__;

  const ktx2Loader = new KTX2Loader();
  ktx2Loader.detectSupport(renderer);

  if (vfs && vfs['./decoders/basis/basis_transcoder.js'] && vfs['./decoders/basis/basis_transcoder.wasm']) {
    const [basisJsBytes, basisWasmBytes] = await Promise.all([
      decodeEmbeddedGzipAsset(vfs['./decoders/basis/basis_transcoder.js']),
      decodeEmbeddedGzipAsset(vfs['./decoders/basis/basis_transcoder.wasm']),
    ]);
    const basisJsText = new TextDecoder().decode(basisJsBytes);
    configureEmbeddedKTX2Loader(ktx2Loader, basisJsText, basisWasmBytes.buffer as ArrayBuffer);
  } else {
    ktx2Loader.setTranscoderPath('./decoders/basis/');
  }

  const gltfLoader = new GLTFLoader();
  gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  gltfLoader.setKTX2Loader(ktx2Loader);

  const texLoader = new THREE.TextureLoader();
  const hdrLoader = new HDRLoader();

  const modelKeys = Object.keys(MODEL_PATHS) as ModelKey[];
  const totalTasks = modelKeys.length + 5;
  let completed = 0;

  const bump = (label: string) => {
    completed++;
    onProgress?.(Math.min(0.98, completed / totalTasks), label);
  };

  const models = {} as Record<ModelKey, THREE.Group>;

  await Promise.all(
    modelKeys.map(async (key) => {
      const relPath = MODEL_PATHS[key];
      let sceneRoot: THREE.Group;
      if (vfs && vfs[relPath]) {
        const bytes = await decodeEmbeddedGzipAsset(vfs[relPath]);
        const gltf = await gltfLoader.parseAsync(bytes.buffer as ArrayBuffer, '');
        sceneRoot = gltf.scene;
      } else {
        const gltf = await gltfLoader.loadAsync(relPath);
        sceneRoot = gltf.scene;
      }
      prepareModelMaterialsAndShadows(sceneRoot, key);
      models[key] = sceneRoot;
      bump(`Loaded ${key.replace(/_/g, ' ')}`);
    })
  );

  const maxAniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const loadTiledTex = async (url: string, isSRGB: boolean, label: string): Promise<THREE.Texture> => {
    let tex: THREE.Texture;
    if (vfs && vfs[url]) {
      const bytes = await decodeEmbeddedGzipAsset(vfs[url]);
      const dataUrl = 'data:image/jpeg;base64,' + uint8ToBase64(bytes);
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      tex = new THREE.Texture(img);
    } else {
      tex = await texLoader.loadAsync(url);
    }
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = isSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = maxAniso;
    tex.needsUpdate = true;
    bump(label);
    return tex;
  };

  const loadHdrSky = async (url: string): Promise<THREE.DataTexture> => {
    let t: THREE.DataTexture;
    if (vfs && vfs[url]) {
      const bytes = await decodeEmbeddedGzipAsset(vfs[url]);
      t = (
        hdrLoader as unknown as { createDataTexture: (buf: ArrayBuffer) => THREE.DataTexture }
      ).createDataTexture(bytes.buffer as ArrayBuffer);
    } else {
      t = await hdrLoader.loadAsync(url);
    }
    bump('Atmospheric HDRI sky');
    return t;
  };

  const [grassColor, grassNormal, dirtColor, dirtNormal, hdrTex] = await Promise.all([
    loadTiledTex('./assets/textures/terrain/grass_color.jpg', true, 'Terrain grass albedo'),
    loadTiledTex('./assets/textures/terrain/grass_normal.jpg', false, 'Terrain grass normal'),
    loadTiledTex('./assets/textures/terrain/dirt_color.jpg', true, 'Terrain dirt albedo'),
    loadTiledTex('./assets/textures/terrain/dirt_normal.jpg', false, 'Terrain dirt normal'),
    loadHdrSky('./assets/hdri/sky.hdr'),
  ]);

  hdrTex.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const skyEnvMap = pmrem.fromEquirectangular(hdrTex).texture;
  pmrem.dispose();

  ktx2Loader.dispose();

  onProgress?.(1, 'Ready');

  return {
    models,
    terrainTextures: {
      grassColor,
      grassNormal,
      grassRoughness: grassNormal,
      dirtColor,
      dirtNormal,
      dirtRoughness: dirtNormal,
    },
    skyEnvMap,
    skyBackground: hdrTex,
  };
}

function prepareModelMaterialsAndShadows(root: THREE.Object3D, key: ModelKey): void {
  const isFoliage = key === 'tree';
  const isVehicle = key === 'player_mbt_lod1';
  const isSmallProp =
    key === 'boulder_medium' || key === 'barrier_wall' || key === 'supply_crates';

  // Remove high-poly sub-twig `branches_lod1` on Aspen trees (saves ~2,400 tris & 1 draw call per tree!)
  if (isFoliage) {
    const toRemove: THREE.Object3D[] = [];
    root.traverse((o) => {
      if ((o.name || '').toLowerCase().includes('branches')) toRemove.push(o);
    });
    for (const r of toRemove) r.parent?.remove(r);
  }

  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const mName = (mesh.name || '').toLowerCase();
    const pName = (mesh.parent?.name || '').toLowerCase();

    if (isVehicle) {
      // Only main hull body & turret shell need to cast shadow (saves 24 wheel/hatch/fitting shadow draw calls per tank!)
      const isMinorPart =
        mName.includes('wheel') ||
        pName.includes('wheel') ||
        mName.includes('idler') ||
        pName.includes('idler') ||
        mName.includes('sprocket') ||
        pName.includes('sprocket') ||
        mName.includes('hatch') ||
        pName.includes('hatch') ||
        mName.includes('fitting');
      mesh.castShadow = !isMinorPart;
      mesh.receiveShadow = !isMinorPart;
    } else {
      mesh.castShadow = !isSmallProp;
      mesh.receiveShadow = !isFoliage;
    }

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      const std = m as THREE.MeshStandardMaterial;
      if (std.isMeshStandardMaterial) {
        std.envMapIntensity = isFoliage ? 0.8 : 1.08;
        if (isFoliage && (std.alphaTest > 0 || mName.includes('leaves'))) {
          std.side = THREE.DoubleSide;
          std.alphaTest = Math.max(std.alphaTest, 0.42);
        } else {
          std.side = THREE.FrontSide;
        }
        if (!std.map && !std.roughnessMap) {
          const matName = (std.name || '').toLowerCase();
          if (matName.includes('steel')) {
            std.metalness = 0.56;
            std.roughness = 0.44;
          } else if (matName.includes('track')) {
            std.metalness = 0.22;
            std.roughness = 0.85;
          } else if (matName.includes('glass')) {
            std.metalness = 0.88;
            std.roughness = 0.14;
          } else {
            std.metalness = 0.24;
            std.roughness = 0.64;
          }
        }
        std.needsUpdate = true;
      }
    }
  });
}

/**
 * Builds grounded (`min.y === 0`), articulated rigs for all 3 vehicle classes:
 * - Normal MBT (`normal`)
 * - Heavy Tank (`heavy` — ERA reactive armor wedges, 152mm heavy barrel & muzzle brake, twin rear fuel drums)
 * - Infantry Fighting Vehicle (`ifv` — agile tracked IFV chassis + rapid-fire 30mm chain-gun unmanned turret)
 */
export function instantiateTankRig(
  assets: LoadedGameAssets,
  vehicleClass: VehicleClass,
  team: Team
): InstantiatedTankRig {
  const root = new THREE.Group();
  root.name = `tank_${team}_${vehicleClass}`;

  const hullTiltGroup = new THREE.Group();
  hullTiltGroup.name = 'hull_tilt_group';
  hullTiltGroup.rotation.order = 'YXZ';
  root.add(hullTiltGroup);

  const wheels: WheelNodeBinding[] = [];
  const hullMeshes: THREE.Mesh[] = [];

  const isBlue = team === 'blue';
  const isHeavy = vehicleClass === 'heavy';
  const isIFV = vehicleClass === 'ifv';

  // -------------------------------------------------------------------------
  // CLASS 3: INFANTRY FIGHTING VEHICLE (Weathered PBR Tracked Chassis + Unmanned 30mm RWS Turret)
  // -------------------------------------------------------------------------
  if (isIFV) {
    const visualRoot = assets.models.player_mbt_lod1.clone(true);
    visualRoot.name = 'ifv_visual';

    // Remove heavy MBT turret assembly so we mount a sleek low-profile unmanned 30mm IFV RWS turret + troop deck!
    const origTurret = visualRoot.getObjectByName('turret');
    if (origTurret) {
      origTurret.parent?.remove(origTurret);
    }

    cloneInstanceMaterials(visualRoot, hullMeshes, isBlue ? 'nato_ifv' : 'opfor_ifv');

    visualRoot.updateMatrixWorld(true);
    const restBox = new THREE.Box3().setFromObject(visualRoot);
    if (Number.isFinite(restBox.min.y)) {
      visualRoot.position.y = -restBox.min.y;
    }
    hullTiltGroup.add(visualRoot);

    const hullTone = isBlue ? '#3c4832' : '#584d3b';
    const armorMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hullTone),
      roughness: 0.56,
      metalness: 0.28,
      envMapIntensity: 1.05,
    });
    applyRealisticArmorShader(armorMat, 'ifv-turret');

    const gunSteelMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#1d211f'),
      roughness: 0.38,
      metalness: 0.72,
      envMapIntensity: 1.15,
    });
    applyRealisticArmorShader(gunSteelMat, 'ifv-steel');

    const opticGlassMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(isBlue ? '#1b4a5e' : '#5e221b'),
      roughness: 0.12,
      metalness: 0.9,
      envMapIntensity: 1.4,
    });

    // Raised armored rear troop compartment superstructure seated flush onto hull deck (y = 1.58)
    const troopDeck = new THREE.Mesh(new THREE.BoxGeometry(2.68, 0.28, 3.65), armorMat);
    troopDeck.position.set(0, 1.66, -1.55);
    troopDeck.castShadow = true;
    visualRoot.add(troopDeck);
    hullMeshes.push(troopDeck);

    const turretRestPos = new THREE.Vector3(0, 1.68, 0.22);
    const turretPivot = new THREE.Group();
    turretPivot.name = 'ifv_turret_pivot';
    turretPivot.position.copy(turretRestPos);
    visualRoot.add(turretPivot);

    const ringBase = new THREE.Mesh(new THREE.CylinderGeometry(0.86, 0.98, 0.24, 16), armorMat);
    ringBase.position.set(0, 0.08, 0);

    const turretCore = new THREE.Mesh(new THREE.BoxGeometry(1.36, 0.44, 1.72), armorMat);
    turretCore.position.set(0, 0.34, -0.06);
    turretCore.castShadow = true;

    // Side reconnaissance / launcher pods for unmistakable IFV silhouette
    const podGeo = new THREE.BoxGeometry(0.28, 0.34, 1.28);
    const podL = new THREE.Mesh(podGeo, armorMat);
    podL.position.set(0.86, 0.38, -0.12);
    const podR = new THREE.Mesh(podGeo, armorMat);
    podR.position.set(-0.86, 0.38, -0.12);

    const opticHousing = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.26, 0.34), armorMat);
    opticHousing.position.set(-0.38, 0.68, -0.25);
    const opticLens = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.05), opticGlassMat);
    opticLens.position.set(-0.38, 0.69, -0.07);

    turretPivot.add(ringBase, turretCore, podL, podR, opticHousing, opticLens);
    hullMeshes.push(ringBase, turretCore, podL, podR, opticHousing);

    if (!isBlue) {
      const opforMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#a62820'),
        roughness: 0.65,
        metalness: 0.15,
      });
      const idStripe = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.14, 0.48), opforMat);
      idStripe.position.set(0, 0.40, -0.32);
      turretPivot.add(idStripe);
      hullMeshes.push(idStripe);
    }

    const gunPivot = new THREE.Group();
    gunPivot.name = 'ifv_gun_pivot';
    gunPivot.position.set(0, 0.36, 0.72);
    turretPivot.add(gunPivot);

    const gunRecoilGroup = new THREE.Group();
    gunRecoilGroup.name = 'ifv_gun_recoil';
    gunPivot.add(gunRecoilGroup);

    const shroud = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.24, 0.96), gunSteelMat);
    shroud.position.set(0, 0, 0.42);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.064, 2.45, 12), gunSteelMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0, 1.45);
    const muzzleBrake = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.065, 0.24, 12), gunSteelMat);
    muzzleBrake.rotation.x = Math.PI / 2;
    muzzleBrake.position.set(0, 0, 2.68);

    gunRecoilGroup.add(shroud, barrel, muzzleBrake);
    hullMeshes.push(shroud, barrel, muzzleBrake);

    const muzzleNode = new THREE.Object3D();
    muzzleNode.name = 'muzzle_datum';
    muzzleNode.position.set(0, 0, 2.82);
    gunRecoilGroup.add(muzzleNode);

    const coaxNode = new THREE.Object3D();
    coaxNode.name = 'coax_datum';
    coaxNode.position.set(0, 0, 2.82);
    gunRecoilGroup.add(coaxNode);

    // Bind PBR spinning road wheels on IFV too!
    for (let i = 1; i <= 7; i++) {
      const wl = visualRoot.getObjectByName(`road_wheel_L${i}`);
      const wr = visualRoot.getObjectByName(`road_wheel_R${i}`);
      if (wl) wheels.push({ node: wl, side: 'L', radius: 0.35 });
      if (wr) wheels.push({ node: wr, side: 'R', radius: 0.35 });
    }
    const idlerL = visualRoot.getObjectByName('idler_L');
    const idlerR = visualRoot.getObjectByName('idler_R');
    const sprL = visualRoot.getObjectByName('sprocket_L');
    const sprR = visualRoot.getObjectByName('sprocket_R');
    if (idlerL) wheels.push({ node: idlerL, side: 'L', radius: 0.29 });
    if (idlerR) wheels.push({ node: idlerR, side: 'R', radius: 0.29 });
    if (sprL) wheels.push({ node: sprL, side: 'L', radius: 0.36 });
    if (sprR) wheels.push({ node: sprR, side: 'R', radius: 0.36 });

    return {
      root,
      hullTiltGroup,
      visualRoot,
      turretPivot,
      turretRestPos,
      gunPivot,
      gunRecoilGroup,
      muzzleNode,
      coaxNode,
      rwsNode: opticHousing,
      wheels,
      hullMeshes,
    };
  }

  // -------------------------------------------------------------------------
  // CLASS 1 & 2: NORMAL MBT & HEAVY BREAKTHROUGH TANK
  // Use LOD1 (20.8k tris) for enemies (and even heavy add-on base if enemy) to save 42k tris per tank!
  // -------------------------------------------------------------------------
  const visualRoot = assets.models.player_mbt_lod1.clone(true);
  visualRoot.name = isHeavy ? 'heavy_mbt_visual' : 'normal_mbt_visual';

  const palette = isHeavy
    ? isBlue
      ? 'nato_heavy'
      : 'opfor_heavy'
    : isBlue
      ? 'nato_mbt'
      : 'opfor_mbt';
  cloneInstanceMaterials(visualRoot, hullMeshes, palette);

  visualRoot.updateMatrixWorld(true);
  const restBox = new THREE.Box3().setFromObject(visualRoot);
  if (Number.isFinite(restBox.min.y)) {
    visualRoot.position.y = -restBox.min.y;
  }
  hullTiltGroup.add(visualRoot);

  const turretPivot = visualRoot.getObjectByName('turret')!;
  const turretRestPos = new THREE.Vector3(0, 1.62, -0.5);
  const gunPivot = visualRoot.getObjectByName('gun')!;
  const rwsNode = visualRoot.getObjectByName('weapon_station') ?? null;

  const gunRecoilGroup = new THREE.Group();
  gunRecoilGroup.name = 'gun_recoil_slide';
  const existingGunChildren = [...gunPivot.children];
  gunPivot.add(gunRecoilGroup);
  for (const ch of existingGunChildren) {
    gunRecoilGroup.add(ch);
  }

  let muzzleZ = 5.305;

  // Heavy Tank Add-On Package: Sloped ERA Cheek Wedges + Heavy Side-Skirt ERA + 152mm Gun Collar & Muzzle Brake + Twin Fuel Drums
  if (isHeavy) {
    const eraMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(isBlue ? '#272f29' : '#3a332b'),
      roughness: 0.58,
      metalness: 0.34,
      envMapIntensity: 1.1,
    });
    applyRealisticArmorShader(eraMat, 'heavy-era');

    const barrelMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#1d211f'),
      roughness: 0.42,
      metalness: 0.68,
    });
    applyRealisticArmorShader(barrelMat, 'heavy-gun');

    // 1. Heavy Turret ERA Cheek Blocks (socketed into front-side cheeks)
    const cheekGeo = new THREE.BoxGeometry(0.36, 0.66, 1.38);
    const cheekL = new THREE.Mesh(cheekGeo, eraMat);
    cheekL.position.set(1.22, 0.42, 0.52);
    cheekL.rotation.y = -0.22;
    cheekL.castShadow = true;

    const cheekR = new THREE.Mesh(cheekGeo, eraMat);
    cheekR.position.set(-1.22, 0.42, 0.52);
    cheekR.rotation.y = 0.22;
    cheekR.castShadow = true;
    turretPivot.add(cheekL, cheekR);

    // 2. Heavy Side-Skirt ERA Reactive Armor Panels along hull flanks
    const skirtGeo = new THREE.BoxGeometry(0.18, 0.54, 5.4);
    const skirtL = new THREE.Mesh(skirtGeo, eraMat);
    skirtL.position.set(1.88, 1.08, -0.1);
    const skirtR = new THREE.Mesh(skirtGeo, eraMat);
    skirtR.position.set(-1.88, 1.08, -0.1);
    visualRoot.add(skirtL, skirtR);

    // 3. Twin Rear External Cylindrical Fuel Drums
    const drumGeo = new THREE.CylinderGeometry(0.34, 0.34, 1.25, 14);
    drumGeo.rotateZ(Math.PI / 2);
    const drumL = new THREE.Mesh(drumGeo, eraMat);
    drumL.position.set(0.95, 1.38, -4.08);
    const drumR = new THREE.Mesh(drumGeo, eraMat);
    drumR.position.set(-0.95, 1.38, -4.08);
    visualRoot.add(drumL, drumR);

    // 4. Up-Gunned 152mm Thermal Sleeve + Heavy Double-Baffle Muzzle Brake
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.165, 3.6, 14), barrelMat);
    sleeve.rotation.x = Math.PI / 2;
    sleeve.position.set(0, 0, 2.75);
    const brakeBox = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.58), barrelMat);
    brakeBox.position.set(0, 0, 5.38);
    brakeBox.castShadow = true;
    gunRecoilGroup.add(sleeve, brakeBox);
    muzzleZ = 5.68;

    hullMeshes.push(cheekL, cheekR, skirtL, skirtR, drumL, drumR, sleeve, brakeBox);
  }

  const muzzleNode = new THREE.Object3D();
  muzzleNode.name = 'muzzle_datum';
  muzzleNode.position.set(0, 0, muzzleZ);
  gunRecoilGroup.add(muzzleNode);

  const coaxNode = new THREE.Object3D();
  coaxNode.name = 'coax_datum';
  coaxNode.position.set(0.24, 0.03, 1.45);
  gunRecoilGroup.add(coaxNode);

  if (!isBlue) {
    const markerMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#a62820'),
      roughness: 0.68,
      metalness: 0.12,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    const stripeGeo = new THREE.BoxGeometry(0.05, 0.34, 1.15);
    const leftStripe = new THREE.Mesh(stripeGeo, markerMat);
    leftStripe.name = 'opfor_id_L';
    leftStripe.position.set(1.30, 0.48, -1.25);
    const rightStripe = new THREE.Mesh(stripeGeo, markerMat);
    rightStripe.name = 'opfor_id_R';
    rightStripe.position.set(-1.30, 0.48, -1.25);
    turretPivot.add(leftStripe, rightStripe);
    hullMeshes.push(leftStripe, rightStripe);
  }

  for (let i = 1; i <= 7; i++) {
    const wl = visualRoot.getObjectByName(`road_wheel_L${i}`);
    const wr = visualRoot.getObjectByName(`road_wheel_R${i}`);
    if (wl) wheels.push({ node: wl, side: 'L', radius: 0.35 });
    if (wr) wheels.push({ node: wr, side: 'R', radius: 0.35 });
  }
  const idlerL = visualRoot.getObjectByName('idler_L');
  const idlerR = visualRoot.getObjectByName('idler_R');
  const sprL = visualRoot.getObjectByName('sprocket_L');
  const sprR = visualRoot.getObjectByName('sprocket_R');
  if (idlerL) wheels.push({ node: idlerL, side: 'L', radius: 0.29 });
  if (idlerR) wheels.push({ node: idlerR, side: 'R', radius: 0.29 });
  if (sprL) wheels.push({ node: sprL, side: 'L', radius: 0.36 });
  if (sprR) wheels.push({ node: sprR, side: 'R', radius: 0.36 });

  return {
    root,
    hullTiltGroup,
    visualRoot,
    turretPivot,
    turretRestPos,
    gunPivot,
    gunRecoilGroup,
    muzzleNode,
    coaxNode,
    rwsNode,
    wheels,
    hullMeshes,
  };
}

function cloneInstanceMaterials(
  root: THREE.Object3D,
  outMeshes: THREE.Mesh[],
  palette: 'nato_mbt' | 'opfor_mbt' | 'nato_heavy' | 'opfor_heavy' | 'nato_ifv' | 'opfor_ifv'
): void {
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    outMeshes.push(mesh);

    const cloneMat = (m: THREE.Material): THREE.Material => {
      const c = m.clone() as THREE.MeshStandardMaterial;
      if (c.isMeshStandardMaterial) {
        const mName = (c.name || '').toLowerCase();
        if (palette === 'opfor_mbt') {
          c.color.multiply(new THREE.Color(0.94, 0.84, 0.68));
        } else if (palette === 'nato_heavy') {
          c.color.multiply(new THREE.Color(0.66, 0.72, 0.68));
        } else if (palette === 'opfor_heavy') {
          c.color.multiply(new THREE.Color(0.72, 0.64, 0.56));
        } else if (palette === 'nato_ifv') {
          c.color.multiply(new THREE.Color(0.84, 0.94, 0.78));
        } else if (palette === 'opfor_ifv') {
          c.color.multiply(new THREE.Color(0.95, 0.85, 0.70));
        }
        if (!mName.includes('glass')) {
          applyRealisticArmorShader(c, 'vehicle-armor');
        }
      }
      return c;
    };

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(cloneMat);
    } else if (mesh.material) {
      mesh.material = cloneMat(mesh.material);
    }
  });
}
