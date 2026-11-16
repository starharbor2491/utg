import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadAllGameAssets, instantiateTankRig } from './game/AssetLoader';
import type { LoadedGameAssets } from './game/AssetLoader';
import { auditThreeObject } from './game/SceneAudit';
import type { AuditIssue } from './game/SceneAudit';
import type { Team, VehicleClass } from './game/types';

/**
 * Dev-only vehicle showroom (not shipped by `npm run build` — vite only
 * bundles index.html). Query params:
 *   ?v=<class>&team=blue|red            frame a single vehicle
 *   &view=front|side|34|top|rear|close-wheel|close-pod|close-gun
 *   &pitch=<rad>&yaw=<rad>              pose turret/gun (radians)
 * No `v` param -> all 5 classes x both teams in a row + audit overlay.
 */

const CLASSES: readonly VehicleClass[] = ['normal', 'heavy', 'ifv', 'humvee', 'rocket'];
const TEAMS: readonly Team[] = ['blue', 'red'];

const params = new URLSearchParams(location.search);
const singleClass = (params.get('v') as VehicleClass | null) ?? null;
const singleTeam = (params.get('team') as Team | null) ?? 'blue';
const view = params.get('view') ?? '34';
const posePitch = parseFloat(params.get('pitch') ?? '0') || 0;
const poseYaw = parseFloat(params.get('yaw') ?? '0') || 0;

const app = document.getElementById('app')!;
const loadingEl = document.getElementById('loading')!;
const overlayEl = document.getElementById('audit-overlay')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);

// Same environment/lighting vocabulary as the game World
scene.fog = new THREE.FogExp2('#9eb0ba', 0.0016);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.52;

// Ground disc
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(60, 48),
  new THREE.MeshStandardMaterial({ color: '#4c5537', roughness: 0.95, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(60, 60, '#6a7250', '#39402b');
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.25;
grid.position.y = 0.01;
scene.add(grid);

const hemi = new THREE.HemisphereLight('#c6dcff', '#5b6344', 0.52);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff1d6', 2.65);
sun.position.set(60, 80, -45);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 260;
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
sun.shadow.bias = -0.00045;
sun.shadow.normalBias = 0.025;
scene.add(sun);
scene.add(sun.target);

const auditLines: string[] = [];
const poseRig = (rig: ReturnType<typeof instantiateTankRig>) => {
  rig.turretPivot.rotation.y = poseYaw;
  rig.gunPivot.rotation.x = -posePitch;
  rig.articulate?.(posePitch);
  rig.root.updateMatrixWorld(true);
};

const frameVehicle = (camPos: THREE.Vector3, target: THREE.Vector3) => {
  camera.position.copy(camPos);
  controls.target.copy(target);
  controls.update();
};

const boxOf = (obj: THREE.Object3D) => new THREE.Box3().setFromObject(obj);

async function main() {
  const assets: LoadedGameAssets = await loadAllGameAssets(renderer, (p, label) => {
    loadingEl.textContent = `LOADING ASSETS… ${Math.round(p * 100)}% — ${label}`;
  });

  scene.background = assets.skyBackground;
  scene.environment = assets.skyEnvMap;
  scene.environmentIntensity = 0.92;

  const rigs: { cls: VehicleClass; team: Team; rig: ReturnType<typeof instantiateTankRig>; box: THREE.Box3 }[] = [];

  if (singleClass) {
    const rig = instantiateTankRig(assets, singleClass, singleTeam);
    poseRig(rig);
    scene.add(rig.root);
    rigs.push({ cls: singleClass, team: singleTeam, rig, box: boxOf(rig.root) });
  } else {
    // All 5 classes x both teams in a row, spaced by footprint
    let cursorX = 0;
    for (const cls of CLASSES) {
      for (const team of TEAMS) {
        const rig = instantiateTankRig(assets, cls, team);
        poseRig(rig);
        rig.root.position.x = cursorX;
        scene.add(rig.root);
        const box = boxOf(rig.root);
        rigs.push({ cls, team, rig, box });
        cursorX += Math.max(7.5, box.max.x - box.min.x + 3.2);
      }
    }
  }

  // Audit every rig
  for (const { cls, team, rig } of rigs) {
    const issues: AuditIssue[] = auditThreeObject(rig.root, {
      groundY: 0,
      maxGap: 0.02,
      checkConnectivity: true,
      checkInterpenetration: false,
    });
    const errs = issues.filter((i) => i.severity === 'error').length;
    const warns = issues.length - errs;
    auditLines.push(`${cls}/${team}: ${errs} error, ${warns} warn`);
    for (const i of issues) {
      auditLines.push(`  [${i.severity}] ${i.code}: ${i.message}`);
      console.log(`[audit ${cls}/${team}]`, i.severity, i.code, i.message);
    }
  }
  overlayEl.textContent = auditLines.join('\n');
  (window as unknown as { __showroom: unknown }).__showroom = { scene, rigs, assets };

  // Camera framing
  if (singleClass && rigs[0]) {
    const { rig, box } = rigs[0];
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    const dist = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.15;

    const place = (dir: THREE.Vector3, distMul = 1) => {
      frameVehicle(center.clone().addScaledVector(dir.clone().normalize(), dist * distMul), center);
    };

    switch (view) {
      case 'front':
        place(new THREE.Vector3(0, 0.25, 1));
        break;
      case 'side':
        place(new THREE.Vector3(1, 0.22, 0));
        break;
      case 'top':
        place(new THREE.Vector3(0, 1, 0.001), 1.4);
        break;
      case 'rear':
        place(new THREE.Vector3(0, 0.25, -1));
        break;
      case 'close-wheel': {
        // Near the front-left wheel
        const wheel = rig.root.getObjectByName('wheel_FL') ?? rig.root.getObjectByName('wheel_FL1');
        const wp = wheel ? wheel.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(center.x - size.x * 0.3, 0.6, center.z + size.z * 0.3);
        frameVehicle(wp.clone().add(new THREE.Vector3(-2.2, 1.1, 2.4)), wp);
        break;
      }
      case 'close-pod': {
        // Close on the launch pod / tubes (rocket) or roof mount
        const pod = rig.root.getObjectByName('rocket_tube_0') ?? rig.muzzleNode;
        const pp = pod ? pod.getWorldPosition(new THREE.Vector3()) : center.clone().add(new THREE.Vector3(0, size.y * 0.3, 0));
        frameVehicle(pp.clone().add(new THREE.Vector3(2.6, 1.2, 3.2)), pp);
        break;
      }
      case 'close-gun': {
        const mz = rig.muzzleNode.getWorldPosition(new THREE.Vector3());
        frameVehicle(mz.clone().add(new THREE.Vector3(1.6, 0.9, 1.8)), mz);
        break;
      }
      case '34':
      default:
        place(new THREE.Vector3(0.72, 0.5, 0.72));
        break;
    }
  } else {
    // Row overview: frame the whole row
    const all = new THREE.Box3();
    for (const r of rigs) all.union(r.box);
    const center = all.getCenter(new THREE.Vector3());
    const size = all.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y) * 0.5;
    const dist = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.12;
    frameVehicle(center.clone().add(new THREE.Vector3(dist * 0.62, dist * 0.52, dist * 0.62)), center);
  }

  loadingEl.style.display = 'none';

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch((err) => {
  loadingEl.textContent = `FAILED: ${err}`;
  console.error(err);
});
