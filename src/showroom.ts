import {
  Application,
  Entity,
  FILLMODE_FILL_WINDOW,
  FOG_EXP2,
  Mesh,
  MeshInstance,
  PRIMITIVE_LINES,
  RESOLUTION_AUTO,
  SHADOW_PCF3,
  TONEMAP_ACES,
} from 'playcanvas';
import { loadAllGameAssets, instantiateTankRig } from './game/AssetLoader';
import type { LoadedGameAssets } from './game/AssetLoader';
import { auditThreeObject } from './game/SceneAudit';
import type { AuditIssue } from './game/SceneAudit';
import { setApp } from './game/engine/app';
import { circle } from './game/engine/geometry';
import { standard, unlit } from './game/engine/materials';
import { Box3, degToRad, srgb, Vec3 } from './game/engine/math';
import { findByName, meshNode, worldBounds } from './game/engine/scene';
import type { Team, VehicleClass } from './game/types';

// Dev-only vehicle showroom. Query params remain compatible with the Three version.
const CLASSES: readonly VehicleClass[] = ['normal', 'heavy', 'ifv', 'humvee', 'rocket', 'support', 'littlebird', 'apache'];
const TEAMS: readonly Team[] = ['blue', 'red'];
const params = new URLSearchParams(location.search);
const singleClass = params.get('v') as VehicleClass | null;
const singleTeam = (params.get('team') as Team | null) ?? 'blue';
const view = params.get('view') ?? '34';
const posePitch = parseFloat(params.get('pitch') ?? '0') || 0;
const poseYaw = parseFloat(params.get('yaw') ?? '0') || 0;
const host = document.getElementById('app')!;
const loadingEl = document.getElementById('loading')!;
const overlayEl = document.getElementById('audit-overlay')!;
const canvas = document.createElement('canvas');
host.appendChild(canvas);
const pc = new Application(canvas, { graphicsDeviceOptions: { antialias: true, powerPreference: 'high-performance' } });
setApp(pc);
pc.autoRender = false;
pc.setCanvasFillMode(FILLMODE_FILL_WINDOW);
pc.setCanvasResolution(RESOLUTION_AUTO);
pc.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 1.35);
pc.resizeCanvas(window.innerWidth, window.innerHeight);
pc.scene.exposure = 1.05;
pc.scene.fog.type = FOG_EXP2;
pc.scene.fog.color.set(0.62, 0.69, 0.73);
pc.scene.fog.density = 0.0016;
const scene = pc.root;
const camera = new Entity('showroom_camera');
camera.addComponent('camera', { fov: 50, nearClip: 0.1, farClip: 500 });
camera.camera!.toneMapping = TONEMAP_ACES;
scene.addChild(camera);

const ground = meshNode(circle(60, 64), standard({ color: '#4c5537', roughness: 0.95 }), scene, { castShadows: false });
ground.setLocalEulerAngles(-90, 0, 0);
const gridPositions: number[] = [];
for (let i = -30; i <= 30; i++) {
  gridPositions.push(-30, 0.012, i, 30, 0.012, i, i, 0.012, -30, i, 0.012, 30);
}
const gridMesh = new Mesh(pc.graphicsDevice);
gridMesh.setPositions(gridPositions);
const gridNormals: number[] = [];
for (let i = 0; i < gridPositions.length / 3; i++) gridNormals.push(0, 1, 0);
gridMesh.setNormals(gridNormals);
gridMesh.update(PRIMITIVE_LINES);
const grid = new Entity('showroom_grid');
grid.addComponent('render', {});
grid.render!.meshInstances = [new MeshInstance(gridMesh, unlit({ color: '#6a7250', opacity: 0.25, transparent: true, depthWrite: false }), grid)];
scene.addChild(grid);
pc.scene.ambientLight.set(0.30, 0.34, 0.40);
const sun = new Entity('showroom_sun');
sun.addComponent('light', { type: 'directional', color: srgb('#fff1d6'), intensity: 2.65 / Math.PI,
  castShadows: true, shadowType: SHADOW_PCF3, shadowResolution: 2048, shadowBias: -0.00045,
  normalOffsetBias: 0.025, shadowDistance: 180 });
sun.setPosition(60, 80, -45);
sun.lookAt(0, 0, 0);
scene.addChild(sun);

// Damped orbit controller with the same mouse gestures as OrbitControls.
const orbit = { target: new Vec3(), yaw: 0, pitch: 0.4, distance: 15, desiredYaw: 0, desiredPitch: 0.4, desiredDistance: 15 };
let dragButton = -1, lastX = 0, lastY = 0;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => { dragButton = e.button; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('mouseup', () => { dragButton = -1; });
window.addEventListener('mousemove', (e) => {
  if (dragButton < 0) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
  if (dragButton === 0) { orbit.desiredYaw -= dx * 0.006; orbit.desiredPitch = Math.max(-0.05, Math.min(Math.PI * 0.49, orbit.desiredPitch + dy * 0.006)); }
  else {
    const right = new Vec3(Math.cos(orbit.yaw), 0, -Math.sin(orbit.yaw));
    orbit.target.addScaled(right, -dx * orbit.distance * 0.0015);
    orbit.target.y += dy * orbit.distance * 0.0015;
  }
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.desiredDistance = Math.max(0.5, orbit.desiredDistance * Math.exp(e.deltaY * 0.001)); }, { passive: false });
function frameVehicle(camPos: Vec3, target: Vec3): void {
  orbit.target.copy(target);
  const d = new Vec3().sub2(camPos, target);
  orbit.distance = orbit.desiredDistance = Math.max(0.1, d.length());
  orbit.pitch = orbit.desiredPitch = Math.asin(Math.max(-1, Math.min(1, d.y / Math.max(d.length(), 1e-6))));
  orbit.yaw = orbit.desiredYaw = Math.atan2(d.x, d.z);
  updateOrbit(1);
}
function updateOrbit(blend: number): void {
  orbit.yaw += (orbit.desiredYaw - orbit.yaw) * blend;
  orbit.pitch += (orbit.desiredPitch - orbit.pitch) * blend;
  orbit.distance += (orbit.desiredDistance - orbit.distance) * blend;
  const cp = Math.cos(orbit.pitch), d = orbit.distance;
  camera.setPosition(orbit.target.x + Math.sin(orbit.yaw) * cp * d, orbit.target.y + Math.sin(orbit.pitch) * d, orbit.target.z + Math.cos(orbit.yaw) * cp * d);
  camera.lookAt(orbit.target);
}

const poseRig = (rig: ReturnType<typeof instantiateTankRig>) => {
  rig.turretPivot.setLocalEulerAngles(0, poseYaw * 180 / Math.PI, 0);
  rig.gunPivot.setLocalEulerAngles(-posePitch * 180 / Math.PI, 0, 0);
  rig.articulate?.(posePitch);
  rig.root.getWorldTransform();
};
const boxOf = (obj: Entity) => worldBounds(obj, undefined, true);

async function main() {
  const assets: LoadedGameAssets = await loadAllGameAssets(pc, (p, label) => {
    loadingEl.textContent = `LOADING ASSETS… ${Math.round(p * 100)}% — ${label}`;
  });
  pc.scene.skybox = assets.skyBox;
  pc.scene.envAtlas = assets.skyEnvAtlas;
  pc.scene.skyboxIntensity = 0.92;
  const rigs: { cls: VehicleClass; team: Team; rig: ReturnType<typeof instantiateTankRig>; box: Box3 }[] = [];
  if (singleClass) {
    const rig = instantiateTankRig(assets, singleClass, singleTeam);
    poseRig(rig); scene.addChild(rig.root);
    rigs.push({ cls: singleClass, team: singleTeam, rig, box: boxOf(rig.root) });
  } else {
    let cursorX = 0;
    for (const cls of CLASSES) for (const team of TEAMS) {
      const rig = instantiateTankRig(assets, cls, team);
      poseRig(rig); rig.root.setLocalPosition(cursorX, 0, 0); scene.addChild(rig.root);
      const box = boxOf(rig.root); rigs.push({ cls, team, rig, box });
      cursorX += Math.max(7.5, box.max.x - box.min.x + 3.2);
    }
  }
  const auditLines: string[] = [];
  for (const { cls, team, rig } of rigs) {
    const issues: AuditIssue[] = auditThreeObject(rig.root, { groundY: 0, maxGap: 0.02, checkConnectivity: true, checkInterpenetration: false });
    const errs = issues.filter((i) => i.severity === 'error').length;
    auditLines.push(`${cls}/${team}: ${errs} error, ${issues.length - errs} warn`);
    for (const i of issues) {
      auditLines.push(`  [${i.severity}] ${i.code}: ${i.message}`);
      console.log(`[audit ${cls}/${team}]`, i.severity, i.code, i.message);
    }
  }
  overlayEl.textContent = auditLines.join('\n');
  (window as unknown as { __showroom: unknown }).__showroom = { scene, rigs, assets, app: pc };

  if (singleClass && rigs[0]) {
    const { rig, box } = rigs[0], center = box.getCenter(new Vec3()), size = box.getSize(new Vec3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    const dist = radius / Math.tan(degToRad(camera.camera!.fov * 0.5)) * 1.15;
    const place = (dir: Vec3, mul = 1) => frameVehicle(new Vec3().copy(center).addScaled(dir.normalize(), dist * mul), center);
    switch (view) {
      case 'front': place(new Vec3(0, 0.25, 1)); break;
      case 'side': place(new Vec3(1, 0.22, 0)); break;
      case 'top': place(new Vec3(0, 1, 0.001), 1.4); break;
      case 'rear': place(new Vec3(0, 0.25, -1)); break;
      case 'close-wheel': {
        const wheel = findByName(rig.root, 'wheel_FL') ?? findByName(rig.root, 'wheel_FL1');
        const wp = wheel ? wheel.getPosition().clone() : new Vec3(center.x - size.x * 0.3, 0.6, center.z + size.z * 0.3);
        frameVehicle(wp.clone().add(new Vec3(-2.2, 1.1, 2.4)), wp); break;
      }
      case 'close-pod': {
        const pod = findByName(rig.root, 'rocket_tube_0') ?? rig.muzzleNode;
        const pp = pod.getPosition().clone(); frameVehicle(pp.clone().add(new Vec3(2.6, 1.2, 3.2)), pp); break;
      }
      case 'close-gun': {
        const mz = rig.muzzleNode.getPosition().clone(); frameVehicle(mz.clone().add(new Vec3(1.6, 0.9, 1.8)), mz); break;
      }
      default: place(new Vec3(0.72, 0.5, 0.72));
    }
  } else {
    const all = new Box3().makeEmpty(); for (const r of rigs) all.union(r.box);
    const center = all.getCenter(new Vec3()), size = all.getSize(new Vec3());
    const dist = Math.max(size.x, size.y) * 0.5 / Math.tan(degToRad(camera.camera!.fov * 0.5)) * 1.12;
    frameVehicle(center.clone().add(new Vec3(dist * 0.62, dist * 0.52, dist * 0.62)), center);
  }
  loadingEl.style.display = 'none';
  window.addEventListener('resize', () => {
    camera.camera!.aspectRatio = window.innerWidth / window.innerHeight;
    pc.resizeCanvas(window.innerWidth, window.innerHeight);
  });
  const tick = () => {
    requestAnimationFrame(tick);
    if (document.hidden) return;
    updateOrbit(0.12);
    pc.renderNextFrame = true;
    pc.render();
  };
  requestAnimationFrame(tick);
}

main().catch((err) => { loadingEl.textContent = `FAILED: ${err}`; console.error(err); });
