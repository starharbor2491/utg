import {
  ADDRESS_REPEAT,
  AppBase,
  Asset,
  CULLFACE_BACK,
  CULLFACE_NONE,
  ContainerResource,
  Entity,
  EnvLighting,
  Material,
  PIXELFORMAT_RGBA8,
  PIXELFORMAT_SRGBA8,
  StandardMaterial,
  Texture,
  basisInitialize,
  meshoptInitialize,
} from 'playcanvas';
import { MeshoptDecoder } from 'meshoptimizer';
import { buildApacheRig } from './models/Apache';
import { buildRocketLauncherRig } from './models/RocketLauncher';
import { buildSupportVehicleRig } from './models/SupportVehicle';
import { buildLittleBirdRig } from './models/LittleBird';
import { addMovingTracks, removeBakedTracks } from './models/Tracks';
import { setApp } from './engine/app';
import { box, cylinder, extrude, Geo, lathe, roundedBox, Shape, torus } from './engine/geometry';
import { createHdrTexture } from './engine/hdr';
import { addShaderHooks, applyRealisticArmorShader, standard } from './engine/materials';
import { Box3, Mat4, Vec2, Vec3, applyMat4, degToRad } from './engine/math';
import { findByName, group, meshNode, userData, worldBounds } from './engine/scene';
import type { Team, VehicleClass } from './types';

export type ModelKey =
  | 'player_mbt_lod1' | 'humvee' | 'ifv' | 'ruined_building' | 'guard_tower'
  | 'fuel_station' | 'boulder_large' | 'boulder_medium' | 'tree' | 'barrier_wall' | 'supply_crates' | 'littlebird' | 'apache';

export interface WheelNodeBinding { node: Entity; side: 'L' | 'R'; radius: number }

export interface InstantiatedTankRig {
  root: Entity;
  hullTiltGroup: Entity;
  visualRoot: Entity;
  turretPivot: Entity;
  turretRestPos: Vec3;
  gunPivot: Entity;
  gunRecoilGroup: Entity;
  muzzleNode: Entity;
  coaxNode: Entity;
  rwsNode: Entity | null;
  wheels: WheelNodeBinding[];
  steerNodes: Entity[];
  rocketMeshes: Entity[];
  articulate?: (gunPitch: number) => void;
  tracks?: { side: 'L' | 'R'; advance: (meters: number) => void }[];
  spinRotors?: (dt: number) => void;
  spinGatling?: (dt: number) => void;
  hullMeshes: Entity[];
}

export interface TerrainTextures {
  grassColor: Texture;
  grassNormal: Texture;
  grassRoughness: Texture;
  dirtColor: Texture;
  dirtNormal: Texture;
  dirtRoughness: Texture;
}

export interface LoadedGameAssets {
  models: Record<ModelKey, Entity>;
  terrainTextures: TerrainTextures;
  skyEnvAtlas: Texture;
  skyBox: Texture;
}

const MODEL_PATHS: Record<ModelKey, string> = {
  player_mbt_lod1: './assets/models/player_mbt_lod1.glb',
  humvee: './assets/models/humvee.glb',
  ifv: './assets/models/ifv.glb',
  ruined_building: './assets/models/ruined_building.glb',
  guard_tower: './assets/models/guard_tower.glb',
  fuel_station: './assets/models/fuel_station.glb',
  boulder_large: './assets/models/boulder_large.glb',
  boulder_medium: './assets/models/boulder_medium.glb',
  tree: './assets/models/tree.glb',
  barrier_wall: './assets/models/barrier_wall.glb',
  supply_crates: './assets/models/supply_crates.glb',
  littlebird: './assets/models/littlebird.glb',
  apache: './assets/models/apache.glb',
};

declare global {
  interface Window { __EMBEDDED_VFS__?: Record<string, string> }
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function decodeEmbeddedGzipAsset(b64Gzip: string): Promise<Uint8Array> {
  const blob = new Blob([base64ToUint8(b64Gzip) as unknown as BlobPart]);
  return new Uint8Array(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function embeddedUrl(path: string, mime: string): Promise<string | null> {
  const encoded = window.__EMBEDDED_VFS__?.[path];
  if (!encoded) return null;
  const bytes = await decodeEmbeddedGzipAsset(encoded);
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
}

export async function assetUrl(path: string, mime: string): Promise<string> {
  return await embeddedUrl(path, mime) ?? path;
}

let decodersReady: Promise<void> | null = null;
async function initializeDecoders(): Promise<void> {
  if (decodersReady) return decodersReady;
  decodersReady = (async () => {
    meshoptInitialize({ decoder: MeshoptDecoder });
    await MeshoptDecoder.ready;
    const js = await embeddedUrl('./decoders/pc-basis/basis.wasm.js', 'text/javascript');
    const wasm = await embeddedUrl('./decoders/pc-basis/basis.wasm.wasm', 'application/wasm');
    basisInitialize(js && wasm
      ? { glueUrl: js, wasmUrl: wasm }
      : { glueUrl: './decoders/pc-basis/basis.wasm.js', wasmUrl: './decoders/pc-basis/basis.wasm.wasm' });
  })();
  return decodersReady;
}

function loadContainer(app: AppBase, url: string, name: string): Promise<ContainerResource> {
  return new Promise((resolve, reject) => {
    const asset = new Asset(name, 'container', { url });
    app.assets.add(asset);
    asset.ready((a) => resolve(a.resource as ContainerResource));
    asset.once('error', (err) => reject(new Error(`${name}: ${err}`)));
    app.assets.load(asset);
  });
}

export async function loadAllGameAssets(
  app: AppBase,
  onProgress?: (progress01: number, label: string) => void
): Promise<LoadedGameAssets> {
  setApp(app);
  await initializeDecoders();
  const modelKeys = Object.keys(MODEL_PATHS) as ModelKey[];
  const totalTasks = modelKeys.length + 5;
  let completed = 0;
  const bump = (label: string) => onProgress?.(Math.min(0.98, ++completed / totalTasks), label);
  const models = {} as Record<ModelKey, Entity>;

  await Promise.all(modelKeys.map(async (key) => {
    const url = await assetUrl(MODEL_PATHS[key], 'model/gltf-binary');
    const container = await loadContainer(app, url, key);
    const root = container.instantiateRenderEntity();
    root.name = key;
    prepareModelMaterialsAndShadows(root, key);
    models[key] = root;
    bump(`Loaded ${key.replace(/_/g, ' ')}`);
  }));

  const maxAniso = Math.min(4, app.graphicsDevice.maxAnisotropy);
  const loadTiledTex = async (url: string, isSRGB: boolean, label: string): Promise<Texture> => {
    const src = await assetUrl(url, 'image/jpeg');
    const img = new Image();
    img.src = src;
    await img.decode();
    const tex = new Texture(app.graphicsDevice, {
      width: img.width,
      height: img.height,
      format: isSRGB ? PIXELFORMAT_SRGBA8 : PIXELFORMAT_RGBA8,
      mipmaps: true,
      addressU: ADDRESS_REPEAT,
      addressV: ADDRESS_REPEAT,
      anisotropy: maxAniso,
    });
    tex.setSource(img);
    bump(label);
    return tex;
  };

  const loadHdrSky = async (url: string): Promise<Texture> => {
    let buffer: ArrayBuffer;
    if (window.__EMBEDDED_VFS__?.[url]) {
      const bytes = await decodeEmbeddedGzipAsset(window.__EMBEDDED_VFS__[url]);
      buffer = bytes.buffer as ArrayBuffer;
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HDR ${url}: ${response.status}`);
      buffer = await response.arrayBuffer();
    }
    bump('Atmospheric HDRI sky');
    return createHdrTexture(app.graphicsDevice, buffer, 'sky');
  };

  const [grassColor, grassNormal, dirtColor, dirtNormal, hdrTex] = await Promise.all([
    loadTiledTex('./assets/textures/terrain/grass_color.jpg', true, 'Terrain grass albedo'),
    loadTiledTex('./assets/textures/terrain/grass_normal.jpg', false, 'Terrain grass normal'),
    loadTiledTex('./assets/textures/terrain/dirt_color.jpg', true, 'Terrain dirt albedo'),
    loadTiledTex('./assets/textures/terrain/dirt_normal.jpg', false, 'Terrain dirt normal'),
    loadHdrSky('./assets/hdri/sky.hdr'),
  ]);
  const skyBox = EnvLighting.generateSkyboxCubemap(hdrTex);
  const lightingSource = EnvLighting.generateLightingSource(hdrTex);
  const skyEnvAtlas = EnvLighting.generateAtlas(lightingSource);
  lightingSource.destroy();
  hdrTex.destroy();
  onProgress?.(1, 'Ready');
  return {
    models,
    terrainTextures: { grassColor, grassNormal, grassRoughness: grassNormal, dirtColor, dirtNormal, dirtRoughness: dirtNormal },
    skyEnvAtlas,
    skyBox,
  };
}

function prepareModelMaterialsAndShadows(root: Entity, key: ModelKey): void {
  const isFoliage = key === 'tree';
  const isVehicle = key === 'player_mbt_lod1' || key === 'humvee' || key === 'ifv' || key === 'littlebird' || key === 'apache';
  const isSmallProp = key === 'boulder_medium' || key === 'barrier_wall' || key === 'supply_crates';
  if (isFoliage) {
    const remove: Entity[] = [];
    root.forEach((n) => { if ((n.name || '').toLowerCase().includes('branches')) remove.push(n as Entity); });
    for (const entity of remove) entity.parent?.removeChild(entity);
  }
  root.forEach((node) => {
    const obj = node as Entity;
    const mName = obj.name.toLowerCase(), pName = (obj.parent?.name || '').toLowerCase();
    if (obj.render) {
      if (isVehicle) {
        const minor = mName.includes('wheel') || pName.includes('wheel') || mName.includes('idler') || pName.includes('idler') ||
          mName.includes('sprocket') || pName.includes('sprocket') || mName.includes('hatch') || pName.includes('hatch') || mName.includes('fitting');
        obj.render.castShadows = !minor;
        obj.render.receiveShadows = !minor;
      } else {
        obj.render.castShadows = !isSmallProp;
        obj.render.receiveShadows = !isFoliage;
      }
    }
    for (const mi of obj.render?.meshInstances ?? []) {
      const mat = mi.material as StandardMaterial;
      if (!(mat instanceof StandardMaterial)) continue;
      mat.reflectivity = isFoliage ? 0.8 : 1.08;
      mat.useDynamicRefraction = false;
      if (key === 'apache') {
        // The converted GLB already carries distinct livery, metal, and glazing finishes.
        if (obj.name === 'Apache_Canopy') {
          mat.depthWrite = false;
          obj.render!.castShadows = false;
        }
        mat.update();
        continue;
      }
      if (key === 'littlebird' && mat.name === 'vidrio') {
        mat.refraction = 0;
        mat.opacity = 0.40;
        mat.depthWrite = false;
      }
      if (isFoliage && (mat.alphaTest > 0 || mName.includes('leaves'))) {
        mat.cull = CULLFACE_NONE;
        mat.twoSidedLighting = true;
        mat.alphaTest = Math.max(mat.alphaTest, 0.42);
      } else {
        mat.cull = CULLFACE_BACK;
      }
      if (!mat.diffuseMap && !mat.glossMap) {
        const name = mat.name.toLowerCase();
        mat.useMetalness = true;
        if (name.includes('steel')) { mat.metalness = 0.56; mat.gloss = 0.56; }
        else if (name.includes('track')) { mat.metalness = 0.22; mat.gloss = 0.15; }
        else if (name.includes('glass')) { mat.metalness = 0.88; mat.gloss = 0.86; }
        else { mat.metalness = 0.24; mat.gloss = 0.36; }
      }
      mat.update();
    }
  });
  if (key === 'littlebird') {
    // The source faces +Z with its origin under the rotor; seat its skids at the existing rig size.
    const scale = 0.70;
    // Container children aren't active until their template is attached to a scene.
    const minY = worldBounds(root, undefined, true, true).min.y;
    if (!Number.isFinite(minY)) throw new Error('Little Bird airframe has no measurable geometry.');
    root.setLocalScale(scale, scale, scale);
    root.setLocalPosition(0, -minY * scale, 0);
  }
}

export function instantiateTankRig(assets: LoadedGameAssets, vehicleClass: VehicleClass, team: Team): InstantiatedTankRig {
  const rig = buildVehicleRig(assets, vehicleClass, team);
  const tracked = vehicleClass === 'normal' || vehicleClass === 'heavy' || vehicleClass === 'ifv';
  if (tracked && removeBakedTracks(rig, vehicleClass === 'ifv')) addMovingTracks(rig);
  return rig;
}

function buildVehicleRig(assets: LoadedGameAssets, vehicleClass: VehicleClass, team: Team): InstantiatedTankRig {
  if (vehicleClass === 'rocket') return buildRocketLauncherRig(team);
  if (vehicleClass === 'support') return buildSupportVehicleRig(team);
  if (vehicleClass === 'littlebird') return buildLittleBirdRig(team, assets.models.littlebird);
  if (vehicleClass === 'apache') return buildApacheRig(team, assets.models.apache);

  const root = group(`tank_${team}_${vehicleClass}`);
  const hullTiltGroup = group('hull_tilt_group', root);
  const wheels: WheelNodeBinding[] = [], steerNodes: Entity[] = [], rocketMeshes: Entity[] = [], hullMeshes: Entity[] = [];
  const isBlue = team === 'blue', isHeavy = vehicleClass === 'heavy';
  const measureWheelRadius = (node: Entity): number => {
    const bounds = worldBounds(node), pivot = node.getPosition();
    return Math.max(0.2, bounds.max.y - pivot.y, pivot.y - bounds.min.y, bounds.max.z - pivot.z,
      pivot.z - bounds.min.z, bounds.max.x - pivot.x, pivot.x - bounds.min.x);
  };

  if (vehicleClass === 'ifv') {
    const visualRoot = assets.models.ifv.clone();
    visualRoot.name = 'ifv_visual';
    cloneInstanceMaterials(visualRoot, hullMeshes, isBlue ? 'nato_ifv' : 'opfor_ifv');
    const restBox = worldBounds(visualRoot, undefined, true);
    if (Number.isFinite(restBox.min.y)) visualRoot.setLocalPosition(0, -restBox.min.y, 0);
    hullTiltGroup.addChild(visualRoot);
    const turretPivot = findByName(visualRoot, 'turret')!;
    const turretRestPos = turretPivot.getLocalPosition().clone();
    const gunPivot = findByName(visualRoot, 'gun')!;
    const gunRecoilGroup = group('ifv_gun_recoil');
    const existing = [...gunPivot.children] as Entity[];
    gunPivot.addChild(gunRecoilGroup);
    for (const child of existing) gunRecoilGroup.addChild(child);
    const gunBox = worldBounds(gunPivot).applyMatrix4(new Mat4().copy(gunPivot.getWorldTransform()).invert());
    const muzzleZ = gunBox.max.z + 0.06, boreX = (gunBox.min.x + gunBox.max.x) * 0.5, boreY = (gunBox.min.y + gunBox.max.y) * 0.5;
    const muzzleNode = group('muzzle_datum', gunRecoilGroup), coaxNode = group('coax_datum', gunRecoilGroup);
    muzzleNode.setLocalPosition(boreX, boreY, muzzleZ);
    coaxNode.setLocalPosition(boreX, boreY, muzzleZ);
    for (let i = 1; i <= 6; i++) {
      const wl = findByName(visualRoot, `road_wheel_L${i}`), wr = findByName(visualRoot, `road_wheel_R${i}`);
      if (wl) wheels.push({ node: wl, side: 'L', radius: measureWheelRadius(wl) });
      if (wr) wheels.push({ node: wr, side: 'R', radius: measureWheelRadius(wr) });
    }
    for (const [name, side] of [['idler_L', 'L'], ['idler_R', 'R'], ['sprocket_L', 'L'], ['sprocket_R', 'R']] as const) {
      const wheel = findByName(visualRoot, name);
      if (wheel) wheels.push({ node: wheel, side, radius: measureWheelRadius(wheel) });
    }
    return { root, hullTiltGroup, visualRoot, turretPivot, turretRestPos, gunPivot, gunRecoilGroup, muzzleNode, coaxNode, rwsNode: null, wheels, steerNodes, rocketMeshes, hullMeshes };
  }

  if (vehicleClass === 'humvee') {
    const visualRoot = assets.models.humvee.clone();
    visualRoot.name = 'humvee_visual';
    cloneInstanceMaterials(visualRoot, hullMeshes, isBlue ? 'nato_humvee' : 'opfor_humvee');
    const restBox = worldBounds(visualRoot, undefined, true);
    if (Number.isFinite(restBox.min.y)) visualRoot.setLocalPosition(0, -restBox.min.y, 0);
    hullTiltGroup.addChild(visualRoot);
    const turretRestPos = new Vec3(0, 2.47, -0.345);
    const turretPivot = group('humvee_turret_pivot', visualRoot);
    turretPivot.setLocalPosition(turretRestPos);
    const gunPivot = group('humvee_gun_pivot', turretPivot);
    gunPivot.setLocalPosition(0, 0.09, 0.03);
    const gunRecoilGroup = group('m2_recoil_group', gunPivot);
    const muzzleNode = group('muzzle_datum'), coaxNode = group('coax_datum');
    buildM2HumveeGun(gunPivot, gunRecoilGroup, muzzleNode, coaxNode, hullMeshes, isBlue);
    for (const [name, side] of [['wheel_FL', 'L'], ['wheel_FR', 'R'], ['wheel_RL', 'L'], ['wheel_RR', 'R']] as const) {
      const wheel = findByName(visualRoot, name);
      if (wheel) wheels.push({ node: wheel, side, radius: measureWheelRadius(wheel) });
    }
    for (const name of ['steer_FL', 'steer_FR']) {
      const steer = findByName(visualRoot, name);
      if (steer) steerNodes.push(steer);
    }
    // This GLB's outer tire vertices extend 3 cm below its authored ground datum.
    visualRoot.setLocalPosition(0, visualRoot.getLocalPosition().y + 0.03, 0);
    return { root, hullTiltGroup, visualRoot, turretPivot, turretRestPos, gunPivot, gunRecoilGroup, muzzleNode, coaxNode, rwsNode: null, wheels, steerNodes, rocketMeshes, hullMeshes };
  }

  const visualRoot = assets.models.player_mbt_lod1.clone();
  visualRoot.name = isHeavy ? 'heavy_mbt_visual' : 'normal_mbt_visual';
  const palette = isHeavy ? (isBlue ? 'nato_heavy' : 'opfor_heavy') : (isBlue ? 'nato_mbt' : 'opfor_mbt');
  cloneInstanceMaterials(visualRoot, hullMeshes, palette);
  const restBox = worldBounds(visualRoot, undefined, true);
  if (Number.isFinite(restBox.min.y)) visualRoot.setLocalPosition(0, -restBox.min.y, 0);
  hullTiltGroup.addChild(visualRoot);
  const turretPivot = findByName(visualRoot, 'turret')!;
  const turretRestPos = new Vec3(0, 1.62, -0.5);
  const gunPivot = findByName(visualRoot, 'gun')!;
  const rwsNode = findByName(visualRoot, 'weapon_station');
  const gunRecoilGroup = group('gun_recoil_slide');
  const existing = [...gunPivot.children] as Entity[];
  gunPivot.addChild(gunRecoilGroup);
  for (const child of existing) gunRecoilGroup.addChild(child);
  let muzzleZ = 5.305;

  if (isHeavy) {
    const eraMat = standard({ color: isBlue ? '#272f29' : '#3a332b', roughness: 0.58, metalness: 0.34, envIntensity: 1.1 });
    applyRealisticArmorShader(eraMat, 'heavy-era');
    const barrelMat = standard({ color: '#1d211f', roughness: 0.42, metalness: 0.68 });
    applyRealisticArmorShader(barrelMat, 'heavy-gun');
    // Region-merged ERA arrays: small bevel-edged tiles over a continuous backing plate.
    for (const sx of [-1, 1]) {
      const cheekParts: Geo[] = [box(0.30, 0.62, 1.34).translate(sx * 1.22, 0.42, 0.52)];
      for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) {
        cheekParts.push(box(0.09, 0.17, 0.26).translate(sx * 1.405, 0.20 + row * 0.215, 0.04 + col * 0.32));
      }
      for (let row = 0; row < 3; row++) cheekParts.push(box(0.31, 0.17, 0.09).translate(sx * 1.22, 0.20 + row * 0.215, 1.225));
      const cheek = meshNode(Geo.merge(cheekParts)!, eraMat, turretPivot, { castShadows: true });
      cheek.setLocalEulerAngles(0, -sx * 12.61, 0);
      hullMeshes.push(cheek);

      const skirtParts: Geo[] = [box(0.13, 0.51, 5.35).translate(sx * 1.88, 1.08, -0.1)];
      for (let row = 0; row < 2; row++) for (let col = 0; col < 12; col++) {
        skirtParts.push(box(0.085, 0.205, 0.385).translate(sx * 1.98, 0.93 + row * 0.255, -2.59 + col * 0.45));
      }
      const skirt = meshNode(Geo.merge(skirtParts)!, eraMat, visualRoot, { castShadows: true });
      hullMeshes.push(skirt);
    }
    const roofParts: Geo[] = [];
    for (const sx of [-1, 1]) for (let col = 0; col < 3; col++) roofParts.push(box(0.42, 0.065, 0.28).translate(sx * 0.58, 0.79, 0.10 + col * 0.35));
    hullMeshes.push(meshNode(Geo.merge(roofParts)!, eraMat, turretPivot, { castShadows: true }));
    const drumGeo = cylinder(0.34, 0.34, 1.25, 14).rotateZ(Math.PI / 2);
    const drumL = meshNode(drumGeo, eraMat, visualRoot); drumL.setLocalPosition(0.95, 1.38, -4.08);
    const drumR = meshNode(drumGeo, eraMat, visualRoot); drumR.setLocalPosition(-0.95, 1.38, -4.08);
    const sleeveParts: Geo[] = [cylinder(0.145, 0.165, 3.6, 18).rotateX(Math.PI / 2).translate(0, 0, 2.75)];
    for (const z of [1.15, 2.10, 3.05, 4.20]) sleeveParts.push(cylinder(0.177, 0.177, 0.075, 18).rotateX(Math.PI / 2).translate(0, 0, z));
    const sleeve = meshNode(Geo.merge(sleeveParts)!, barrelMat, gunRecoilGroup);
    const brakeParts: Geo[] = [cylinder(0.19, 0.19, 0.56, 16).rotateX(Math.PI / 2)];
    for (const sx of [-1, 1]) for (const z of [-0.15, 0.15]) brakeParts.push(box(0.23, 0.13, 0.10).translate(sx * 0.19, 0, z));
    const brakeBox = meshNode(Geo.merge(brakeParts)!, barrelMat, gunRecoilGroup, { castShadows: true });
    brakeBox.setLocalPosition(0, 0, 5.38);
    muzzleZ = 5.68;
    hullMeshes.push(drumL, drumR, sleeve, brakeBox);
  }
  const muzzleNode = group('muzzle_datum', gunRecoilGroup), coaxNode = group('coax_datum', gunRecoilGroup);
  muzzleNode.setLocalPosition(0, 0, muzzleZ);
  coaxNode.setLocalPosition(0.24, 0.03, 1.45);
  for (let i = 1; i <= 7; i++) {
    const wl = findByName(visualRoot, `road_wheel_L${i}`), wr = findByName(visualRoot, `road_wheel_R${i}`);
    if (wl) wheels.push({ node: wl, side: 'L', radius: 0.35 });
    if (wr) wheels.push({ node: wr, side: 'R', radius: 0.35 });
  }
  for (const [name, side, radius] of [['idler_L', 'L', 0.29], ['idler_R', 'R', 0.29], ['sprocket_L', 'L', 0.36], ['sprocket_R', 'R', 0.36]] as const) {
    const wheel = findByName(visualRoot, name);
    if (wheel) wheels.push({ node: wheel, side, radius });
  }
  // The MBT source hull datum is 2.97 cm above its contact surface.
  visualRoot.setLocalPosition(0, visualRoot.getLocalPosition().y - 0.0297, 0);
  return { root, hullTiltGroup, visualRoot, turretPivot, turretRestPos, gunPivot, gunRecoilGroup, muzzleNode, coaxNode, rwsNode, wheels, steerNodes, rocketMeshes, hullMeshes };
}

function buildM2HumveeGun(
  gunPivot: Entity,
  recoilGroup: Entity,
  muzzleNode: Entity,
  coaxNode: Entity,
  hullMeshes: Entity[],
  isBlue: boolean
): void {
  const steelMat = standard({ color: '#23271f', roughness: 0.42, metalness: 0.7, envIntensity: 1.1 });
  applyRealisticArmorShader(steelMat, 'm2-steel');
  const woodMat = standard({ color: '#4a3826', roughness: 0.72, metalness: 0.05 });
  applyRealisticArmorShader(woodMat, 'm2-wood');
  const shieldMat = standard({ color: isBlue ? '#3d4a34' : '#544a38', roughness: 0.58, metalness: 0.3, doubleSided: true });
  applyRealisticArmorShader(shieldMat, 'm2-shield');
  const sightGlassMat = standard({ color: '#16222c', roughness: 0.15, metalness: 0.6 });
  const part = (parent: Entity, geo: Geo, mat: Material, x = 0, y = 0, z = 0, cast = false) => {
    const node = meshNode(geo, mat, parent, { castShadows: cast, receiveShadows: true });
    node.setLocalPosition(x, y, z);
    return node;
  };
  const receiver = part(recoilGroup, roundedBox(0.16, 0.20, 0.62, 3, 0.025), steelMat, 0, 0.05, 0.15, true);
  const topCover = part(recoilGroup, roundedBox(0.14, 0.05, 0.5, 2, 0.015), steelMat, 0, 0.16, 0.15);
  const barrelProfile = [new Vec2(0.026, 0.38), new Vec2(0.022, 0.55), new Vec2(0.019, 1.28), new Vec2(0.024, 1.42),
    new Vec2(0.028, 1.50), new Vec2(0.028, 1.58), new Vec2(0.02, 1.60), new Vec2(0, 1.60)];
  const barrel = part(recoilGroup, lathe(barrelProfile, 16).rotateX(Math.PI / 2), steelMat, 0, 0, 0, true);
  const hiderSlots = group('flash_hider_slots', recoilGroup);
  for (let i = 0; i < 3; i++) part(hiderSlots, box(0.062, 0.014, 0.05), steelMat, 0, 0.026 - i * 0.001, 1.46 + i * 0.045);
  for (let i = 0; i < 3; i++) {
    part(recoilGroup, cylinder(0.032, 0.032, 0.085, 14, 1, true).rotateX(Math.PI / 2), steelMat, 0, 0, 0.46 + i * 0.115);
    for (const sx of [-1, 1]) part(recoilGroup, box(0.009, 0.012, 0.038), steelMat, sx * 0.031, 0, 0.46 + i * 0.115);
  }
  part(recoilGroup, roundedBox(0.19, 0.018, 0.23, 2, 0.005), steelMat, 0, 0.12, 0.06);
  part(recoilGroup, box(0.12, 0.025, 0.035), steelMat, -0.13, 0.04, -0.08);
  const carryHandle = part(recoilGroup, torus(0.1, 0.011, 8, 14, Math.PI), steelMat, 0, 0.15, 0.15);
  carryHandle.setLocalEulerAngles(0, 90, 180);
  const gripGeo = roundedBox(0.04, 0.13, 0.05, 2, 0.014);
  const gripL = part(recoilGroup, gripGeo, woodMat, 0.07, -0.03, -0.12); gripL.setLocalEulerAngles(-31.52, 0, 0);
  const gripR = part(recoilGroup, gripGeo, woodMat, -0.07, -0.03, -0.12); gripR.setLocalEulerAngles(-31.52, 0, 0);
  part(recoilGroup, cylinder(0.018, 0.018, 0.22, 10).rotateZ(Math.PI / 2), steelMat, 0, 0.015, -0.16);
  for (const sx of [-1, 1]) part(recoilGroup, roundedBox(0.035, 0.055, 0.14, 2, 0.012), woodMat, sx * 0.105, 0.015, -0.19);
  part(recoilGroup, roundedBox(0.19, 0.02, 0.26, 2, 0.008), steelMat, 0, 0.165, 0.12);
  hullMeshes.push(receiver, barrel, topCover);
  const trunnion = part(gunPivot, cylinder(0.04, 0.04, 0.34, 10), steelMat, 0, 0, -0.02); trunnion.setLocalEulerAngles(0, 0, 90);
  const cheekGeo = roundedBox(0.035, 0.26, 0.4, 2, 0.012);
  const cheekL = part(gunPivot, cheekGeo, shieldMat, 0.09, -0.03, -0.12);
  const cheekR = part(gunPivot, cheekGeo, shieldMat, -0.09, -0.03, -0.12);
  const ammoCan = part(gunPivot, roundedBox(0.17, 0.24, 0.4, 3, 0.025), steelMat, -0.17, -0.1, 0.15, true);
  part(gunPivot, box(0.035, 0.07, 0.34), steelMat, -0.1, -0.04, 0.15);
  for (let i = 0; i < 6; i++) part(gunPivot, box(0.018, 0.024, 0.065), steelMat, -0.12 + i * 0.021, 0.025, 0.12 + Math.sin(i * 0.6) * 0.012);
  const sRo = 0.43, sRi = 0.416, sHalf = degToRad(54), sCtr = -Math.PI / 2, sGap = degToRad(12);
  const shieldGeos: Geo[] = [];
  for (const [a0, a1] of [[sCtr - sHalf, sCtr - sGap], [sCtr + sGap, sCtr + sHalf]] as const) {
    const shape = new Shape();
    shape.absarc(0, 0, sRo, a0, a1, false).absarc(0, 0, sRi, a1, a0, true).closePath();
    shieldGeos.push(extrude(shape, { depth: 0.38, bevelEnabled: false, steps: 1 }).rotateX(-Math.PI / 2).translate(0, -0.19, 0));
  }
  const shield = part(gunPivot, Geo.merge(shieldGeos)!, shieldMat, 0, 0, 0.1, true);
  part(gunPivot, roundedBox(0.11, 0.1, 0.14, 2, 0.015), steelMat, 0, 0.16, 0.58);
  part(gunPivot, box(0.085, 0.05, 0.02), sightGlassMat, 0, 0.17, 0.65);
  part(gunPivot, box(0.1, 0.065, 0.015), steelMat, 0, 0.17, 0.66);
  hullMeshes.push(cheekL, cheekR, shield, ammoCan);
  muzzleNode.setLocalPosition(0, 0.05, 1.62);
  coaxNode.setLocalPosition(0, 0.05, 1.62);
  recoilGroup.addChild(muzzleNode);
  recoilGroup.addChild(coaxNode);
}

type Palette = 'nato_mbt' | 'opfor_mbt' | 'nato_heavy' | 'opfor_heavy' | 'nato_ifv' | 'opfor_ifv' | 'nato_humvee' | 'opfor_humvee';
function cloneInstanceMaterials(root: Entity, outMeshes: Entity[], palette: Palette): void {
  const clones = new Map<Material, Material>();
  const tint: [number, number, number] = palette === 'opfor_mbt' ? [0.94, 0.84, 0.68]
    : palette === 'nato_heavy' ? [0.66, 0.72, 0.68]
    : palette === 'opfor_heavy' ? [0.72, 0.64, 0.56]
    : palette === 'nato_ifv' ? [0.84, 0.94, 0.78]
    : palette === 'opfor_ifv' ? [0.95, 0.85, 0.70]
    : palette === 'nato_humvee' ? [0.88, 0.93, 0.80]
    : palette === 'opfor_humvee' ? [0.96, 0.86, 0.68] : [1, 1, 1];
  root.forEach((node) => {
    const entity = node as Entity;
    if (entity.render) outMeshes.push(entity);
    for (const mi of entity.render?.meshInstances ?? []) {
      const source = mi.material;
      if (!source) continue;
      let clone = clones.get(source);
      if (!clone) {
        clone = source.clone();
        clones.set(source, clone);
        if (clone instanceof StandardMaterial) {
          const c = clone.diffuse.linear();
          c.r *= tint[0]; c.g *= tint[1]; c.b *= tint[2];
          clone.diffuse.copy(c.gamma());
          if (!clone.name.toLowerCase().includes('glass')) applyRealisticArmorShader(clone, 'vehicle-armor');
          clone.update();
        }
      }
      mi.material = clone;
    }
  });
}
