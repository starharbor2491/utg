import * as THREE from 'three';

import { instantiateTankRig, loadAllGameAssets } from './game/AssetLoader';
import { World } from './game/World';
import { Tank } from './game/Tank';
import { EffectsManager } from './game/Effects';
import { DestructionManager } from './game/Destruction';
import { BallisticsManager, predictBarrelImpact } from './game/Ballistics';
import { PlayerController } from './game/PlayerController';
import { BotAIManager } from './game/BotAI';
import { Match } from './game/Match';
import { HUD } from './game/HUD';
import { HitCam } from './game/HitCam';
import { auditThreeObject, type AuditIssue } from './game/SceneAudit';
import type {
  DamageEvent,
  HUDTelemetry,
  MinimapObstacle,
  MinimapUnit,
  ScreenReticlePos,
  ShellSpec,
  TankEntity,
  TankIntent,
  Team,
  VehicleClass,
} from './game/types';

interface UnitMarkerDOM {
  el: HTMLDivElement;
  codeEl: HTMLSpanElement;
  distEl: HTMLSpanElement;
  barFillEl: HTMLDivElement;
  barTrackEl: HTMLDivElement;
  isAlly: boolean;
  losTimer: number;
  losBlocked: boolean;
}

function projectWorldToScreen(
  worldPos: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  out: ScreenReticlePos,
  scratch: THREE.Vector3
): void {
  scratch.copy(worldPos).project(camera);
  out.visible = scratch.z >= -1 && scratch.z <= 1.0;
  out.x = (scratch.x * 0.5 + 0.5) * width;
  out.y = (-scratch.y * 0.5 + 0.5) * height;
}

function markerCodeForClass(cls: VehicleClass): string {
  if (cls === 'heavy') return 'Heavy';
  if (cls === 'ifv') return 'IFV';
  if (cls === 'humvee') return 'Humvee';
  if (cls === 'rocket') return 'Rocket';
  return 'MBT';
}

function buildUnitMarker(isAlly: boolean, callsign: string, cls: VehicleClass): UnitMarkerDOM {
  const el = document.createElement('div');
  el.className = `fcs-unit-marker${isAlly ? ' is-ally' : ' is-enemy'}`;

  const topRow = document.createElement('div');
  topRow.className = 'fcs-um-top';

  const codeEl = document.createElement('span');
  codeEl.className = 'fcs-um-code';
  codeEl.textContent = isAlly ? callsign : markerCodeForClass(cls);
  const distEl = document.createElement('span');
  distEl.className = 'fcs-um-dist';
  topRow.append(codeEl, distEl);

  const barTrackEl = document.createElement('div');
  barTrackEl.className = 'fcs-um-bar';
  const barFillEl = document.createElement('div');
  barFillEl.className = 'fcs-um-bar-fill';
  barTrackEl.appendChild(barFillEl);

  const diamond = document.createElement('div');
  diamond.className = 'fcs-um-diamond';

  el.dataset.unitMarker = isAlly ? 'ally' : 'enemy';
  el.append(topRow, barTrackEl, diamond);
  return { el, codeEl, distEl, barFillEl, barTrackEl, isAlly,
    losTimer: Math.random() * 0.2,
    losBlocked: false,};
}

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const hudRoot = document.getElementById('hud-root') as HTMLElement;

  // Render directly to native WebGL2 backbuffer with Apple Silicon on-chip tile 4x MSAA
  // (Eliminates offscreen FBO resolves & 13-pass bloom bandwidth -> silent M4 Max fans!)
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
  });
  const getOptimalDpr = () => Math.min(window.devicePixelRatio || 1, 1.35);
  renderer.setPixelRatio(getOptimalDpr());
  renderer.setSize(window.innerWidth, window.innerHeight);
  let qualityLevel = 0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.3, 1400);
  const scene = new THREE.Scene();

  let controllerRef: PlayerController | null = null;
  let swapPlayerClassFn: ((cls: VehicleClass) => void) | null = null;

  const hud = new HUD(hudRoot, {
    onEngageClick: () => {
      if (!controllerRef) return;
      controllerRef.setEngaged(true);
      controllerRef.requestLock();
      hud.setBriefingVisible(false);
    },
    onSelectVehicleClass: (cls) => {
      swapPlayerClassFn?.(cls);
    },
  });

  const markerLayer = document.createElement('div');
  markerLayer.className = 'fcs-marker-layer';
  markerLayer.style.cssText =
    'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:2;';
  hudRoot.appendChild(markerLayer);

  const hitCam = new HitCam(hudRoot);

  hud.setLoadingProgress(0.04, 'Initializing...');

  const assets = await loadAllGameAssets(renderer, (progress, label) => {
    hud.setLoadingProgress(progress, label);
  });

  const world = new World(scene, assets);
  const effects = new EffectsManager(scene);
  effects.groundProbe = (x, z) => world.getHeightAt(x, z);
  const ballistics = new BallisticsManager(scene, effects);
  const destruction = new DestructionManager(scene, world, effects);
  const match = new Match(scene, world, assets);

  // Kill first-kill hitches: bake wreck cache + compile every vehicle/wreck/
  // debris shader program while the loading screen is still up. Runs after
  // Match so the 12 live tanks' programs are covered too.
  hud.setLoadingProgress(0.97, 'Compiling shaders...');
  await destruction.prewarmWrecksAndVehicles(renderer, scene, camera, assets);
  hud.setLoadingProgress(1, 'Ready');

  // Persistent physical wrecks for every kill (current roster + prebuilt human vehicles)
  match.forEachTankEver((t) => {
    t.onDestroyed = (info) => destruction.spawnWreck(info);
  });

  // Bots = every tank except the human (tanks[0]); stable for the whole match
  const allTanks: Tank[] = match.tanks;
  const bots: Tank[] = match.tanks.slice(1);
  const botAI = new BotAIManager({
    blue: match.baseCenter('blue'),
    red: match.baseCenter('red'),
  });

  // Per-unit screen markers: enemies get class code + HP bar, allies get callsign chevron
  const unitMarkers: UnitMarkerDOM[] = [];
  for (const bot of bots) {
    const isAlly = bot.team === 'blue';
    const m = buildUnitMarker(isAlly, bot.callsign, bot.stats.vehicleClass);
    markerLayer.appendChild(m.el);
    unitMarkers.push(m);
  }

  // Minimap unit telemetry (reused objects, zero per-frame allocations)
  const minimapUnits: MinimapUnit[] = bots.map((b) => ({
    x: b.position.x,
    z: b.position.z,
    yaw: b.hullYaw,
    alive: b.alive,
    ally: b.team === 'blue',
    spotted: false,
  }));

  let kills = 0;
  let deaths = 0;
  let friendlyFireEvents = 0;

  swapPlayerClassFn = (cls: VehicleClass) => {
    match.selectHumanClass(cls);
  };

  const controller = new PlayerController(camera, canvas);
  controllerRef = controller;

  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(qualityLevel === 0 ? getOptimalDpr() : 1.0);
    renderer.setSize(w, h);
  });

  const minimapObstacles: MinimapObstacle[] = world
    .getObstacles()
    .filter((o) => o.kind !== 'tree' && o.kind !== 'crates')
    .map((o) => ({
      x: o.x,
      z: o.z,
      radius: o.radius,
      kind: o.kind,
    }));

  // Static terrain layers for the tactical radar (rivers + mounds)
  const radarRivers = world.getRiverRadarSamples();
  const radarMounds = world.getMoundRadarSamples();

  // River ford telemetry: per-bot side flips across each centreline
  const riverSidesNow = [0, 0];
  const riverSidePrev: number[][] = bots.map(() => [0, 0]);
  const riverCrossings: number[][] = bots.map(() => [0, 0]);

  // Cursor-lock prompt (top-center)
  const lockBannerEl = document.createElement('button');
  lockBannerEl.type = 'button';
  lockBannerEl.className = 'fcs-lock-banner';
  lockBannerEl.textContent = 'Click to aim · Esc pauses';
  lockBannerEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (controller.pointerLockBlockedByHost) {
      window.open(window.location.href, '_blank');
    } else {
      controller.setEngaged(true);
      controller.requestLock();
    }
  });
  hudRoot.appendChild(lockBannerEl);

  let hitMarkerKind: 'none' | 'hit' | 'kill' = 'none';
  let hitMarkerTimer = 0;
  let incomingDamageYaw = 0;
  let incomingDamageTimer = 0;

  const handleDamage = (ev: DamageEvent) => {
    match.onDamage(ev);
    if (ev.attacker && ev.attacker.team === ev.victim.team) {
      friendlyFireEvents++;
    }

    const victim = ev.victim as Tank;
    const attacker = ev.attacker as Tank | null;
    const killedNow = ev.killed;

    if (!victim.isHuman && ev.xrayReport && attacker?.isHuman) {
      xrayFlashCount++;
      hitCam.showHit(ev.xrayReport);
    }
    if (killedNow) {
      // Heavy kills jolt nearby sleeping wreck bodies back to life
      destruction.applyBlast(ev.hitPoint, ev.weapon === 'cannon' ? 7 : 3, 14);
    }
    if (!victim.isHuman) {
      botAI.notifyDamaged(victim.id, attacker?.id ?? null);
    }

    if (attacker?.isHuman && victim.team !== 'blue') {
      if (killedNow) {
        kills++;
        hitMarkerKind = 'kill';
        hitMarkerTimer = 0.85;
      } else {
        if (hitMarkerKind !== 'kill' || hitMarkerTimer <= 0.1) {
          hitMarkerKind = 'hit';
        }
        hitMarkerTimer = Math.max(hitMarkerTimer, ev.weapon === 'cannon' ? 0.45 : 0.18);
      }
    } else if (victim.isHuman) {
      if (attacker) {
        incomingDamageYaw = Math.atan2(
          attacker.position.x - victim.position.x,
          attacker.position.z - victim.position.z
        );
        incomingDamageTimer = 1.1;
      }
      controller.addShake(ev.weapon === 'cannon' ? 0.2 : 0.025);
      if (killedNow) {
        deaths++;
      }
    }
  };

  const _muzzlePos = new THREE.Vector3();
  const _muzzleDir = new THREE.Vector3();
  const _boreImpactWorld = new THREE.Vector3();
  const _projScratch = new THREE.Vector3();
  const _markerWorldPos = new THREE.Vector3();
  const _losDir = new THREE.Vector3();

  const commanderAimScreen: ScreenReticlePos = { x: 0, y: 0, visible: true };
  const gunnerBoreScreen = { x: 0, y: 0, visible: true, onTarget: false, rangeMeters: 100 };
  const lockTargetScreen: ScreenReticlePos = { x: 0, y: 0, visible: true };
  const _qaAimPoint = new THREE.Vector3();
  const _qaAimOrigin = new THREE.Vector3();
  const _qaIntent: TankIntent = {
    throttle: 0,
    steer: 0,
    brake: false,
    aimPoint: _qaAimPoint,
    aimRayOrigin: _qaAimOrigin,
    fireCannon: false,
    fireMG: false,
    selectShell: null,
  };
  let qaIntentOverride: TankIntent | null = null;
  let qaFireCannonOnce = false;

  let fpsSmooth = 60;
  let cameraOverrideActive = false;
  let forceHideBriefing = false;
  const perfProbe = { active: false, target: 0, frames: 0, simMs: 0, renderMs: 0 };

  // --- Bench/QA instrumentation (dev tooling, zero-cost when unused) ---
  interface BenchFx {
    smokeMesh: THREE.Object3D;
    fireMesh: THREE.Object3D;
    sparkMesh: THREE.Object3D;
    flashMesh: THREE.Object3D;
    ringMesh: THREE.Object3D;
    scorchMesh: THREE.Object3D;
    lightPool: { light: THREE.PointLight }[];
  }
  interface BenchDest {
    debrisMeshes: THREE.Object3D[];
    wrecks: { group: THREE.Object3D; active: boolean }[];
    wreckLights: THREE.PointLight[];
    mergeCount: number;
  }
  interface BenchWorld {
    grassMesh: THREE.Object3D | null;
  }
  const benchFx = effects as unknown as BenchFx;
  const benchDest = destruction as unknown as BenchDest;
  const benchWorld = world as unknown as BenchWorld;

  const hitchLog: { t: number; ms: number; tags: string; rc: number }[] = [];
  const frameTimes: number[] = [];
  let xrayFlashCount = 0;

  const tankCallbacks = {
    onFireCannon: (shooter: Tank, pos: THREE.Vector3, dir: THREE.Vector3, shell: ShellSpec, guideTarget?: TankEntity | null) => {
      ballistics.fireCannon(shooter, pos, dir, shell, guideTarget);
      if (shooter === match.human) {
        controller.addShake(shooter.stats.vehicleClass === 'heavy' ? 0.52 : 0.34);
      }
    },
    onFireMG: (shooter: Tank, pos: THREE.Vector3, dir: THREE.Vector3, beltSpec?: ShellSpec) => {
      ballistics.fireCoaxMG(shooter, pos, dir, beltSpec);
      if (shooter === match.human && beltSpec) {
        controller.addShake(0.035);
      }
    },
    onTrackDust: (pos: THREE.Vector3, intensity01: number) => {
      effects.spawnTrackDust(pos, intensity01);
    },
    onWaterWake: (pos: THREE.Vector3, intensity01: number) => {
      effects.spawnWaterWake(pos, intensity01);
    },
    onWreckSmoke: (pos: THREE.Vector3) => {
      effects.spawnWreckSmoke(pos);
    },
  };

  let lastFrameTime = performance.now();
  let shadowTickToggle = 0;

  // Adaptive quality: L0 = full, L1 = DPR 1.0 + medium world, L2 = L1 + 15 Hz
  // shadows + halved wreck FX + max 4 burning-wreck fire emitters.
  let qualityManual: number | null = null;
  let qualityEma = 8;
  let qualityBadTime = 0;
  let qualityGoodTime = 0;
  let shadowInterval = 2;
  const applyQuality = (lvl: number): void => {
    qualityLevel = lvl;
    renderer.setPixelRatio(lvl === 0 ? getOptimalDpr() : 1.0);
    renderer.setSize(window.innerWidth, window.innerHeight);
    world.setQuality(lvl === 0 ? 'default' : 'medium');
    shadowInterval = lvl === 2 ? 4 : 2;
    destruction.fxRateMul = lvl === 2 ? 0.5 : 1;
    destruction.maxFireWrecks = lvl === 2 ? 4 : Infinity;
  };

  const updateUnitMarkers = (vw: number, vh: number, markerDt: number) => {
    const human = match.human;
    const hideAll = !controller.pointerLocked && !forceHideBriefing;
    for (let i = 0; i < bots.length; i++) {
      const e = bots[i];
      const m = unitMarkers[i];
      if (hideAll || !e.alive) {
        m.el.style.display = 'none';
        continue;
      }

      const dist = human.position.distanceTo(e.position);
      _markerWorldPos.set(
        e.position.x,
        e.position.y + (e.stats.vehicleClass === 'ifv' ? 2.9 : 3.35),
        e.position.z
      );
      _projScratch.copy(_markerWorldPos).project(camera);
      if (_projScratch.z < -1 || _projScratch.z > 1) {
        m.el.style.display = 'none';
        continue;
      }

      if (m.isAlly) {
        // Allies: small blue chevron + callsign, visible out to 400m, no LOS test
        if (dist > 400) {
          m.el.style.display = 'none';
          continue;
        }
        const sx = (_projScratch.x * 0.5 + 0.5) * vw;
        const sy = (-_projScratch.y * 0.5 + 0.5) * vh;
        m.el.style.display = 'flex';
        m.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
        m.distEl.textContent = ` · ${Math.round(dist)} m`;
        continue;
      }

      // Enemies: existing spot-range + LOS rules
      const maxSpotDist = controller.sniperZoom ? 340 : 235;
      if (dist > maxSpotDist) {
        m.el.style.display = 'none';
        continue;
      }

      m.losTimer -= markerDt;
      if (m.losTimer <= 0) {
        m.losTimer = 0.2;
        m.losBlocked = false;
        _losDir.subVectors(_markerWorldPos, camera.position);
        const losLen = _losDir.length();
        if (losLen > 1) {
          _losDir.multiplyScalar(1 / losLen);
          const hit = world.raycastWorld(camera.position, _losDir, losLen - 2.2);
          if (hit && (hit.hitKind === 'terrain' || !hit.obstacle?.destructible)) {
            m.losBlocked = true;
          }
        }
      }
      if (m.losBlocked) {
        m.el.style.display = 'none';
        continue;
      }

      const sx = (_projScratch.x * 0.5 + 0.5) * vw;
      const sy = (-_projScratch.y * 0.5 + 0.5) * vh;
      m.el.style.display = 'flex';
      m.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
      m.distEl.textContent = ` · ${Math.round(dist)} m`;
      const hpPct = THREE.MathUtils.clamp((e.hp / e.maxHp) * 100, 0, 100);
      m.barFillEl.style.width = `${hpPct.toFixed(0)}%`;
    }
  };

  let activeEnemyCount = 0;
  let lastPlayerThrottle = 0;

  // All simulation work (no HUD/DOM/render) — steppable headlessly via __tankQA.fastForward
  const stepSimulation = (dt: number): void => {
    const human = match.human;
    const isDeployed = controller.pointerLocked || forceHideBriefing;

    const shakeImpulse = effects.consumeCameraShake(camera.position);
    let playerIntent = null;
    if (qaIntentOverride) {
      playerIntent = qaIntentOverride;
    } else if (!cameraOverrideActive) {
      playerIntent = controller.update(dt, human, world, allTanks, shakeImpulse);
      // Player aim ray originates at the camera (seeker lock cone)
      if (playerIntent) playerIntent.aimRayOrigin = camera.position;
    }
    if (playerIntent && qaFireCannonOnce) {
      playerIntent.fireCannon = true;
      qaFireCannonOnce = false;
    }
    lastPlayerThrottle = playerIntent?.throttle ?? 0;

    const aiIntents = isDeployed ? botAI.update(dt, bots, allTanks, world) : null;

    human.stepKinematics(dt, isDeployed ? playerIntent : null, world, allTanks, tankCallbacks);
    for (let i = 0; i < bots.length; i++) {
      const e = bots[i];
      const eIntent = aiIntents ? (aiIntents.get(e.id) ?? null) : null;
      e.stepKinematics(dt, eIntent, world, allTanks, tankCallbacks);
    }

    ballistics.update(dt, world, allTanks, handleDamage, destruction.getDecoyPoints());
    match.update(dt);
    world.update(dt, human.position, camera.position);
    effects.update(dt, camera);
    destruction.update(dt, camera.position);

    // Minimap unit telemetry + enemy spotting (red visible only within 220m of a live blue tank)
    activeEnemyCount = 0;
    for (let i = 0; i < bots.length; i++) {
      const e = bots[i];
      const u = minimapUnits[i];
      u.x = e.position.x;
      u.z = e.position.z;
      u.yaw = e.hullYaw;
      u.alive = e.alive;
      if (e.team === 'red') {
        if (e.alive) {
          activeEnemyCount++;
          u.spotted = false;
          for (let a = 0; a < allTanks.length; a++) {
            const ally = allTanks[a];
            if (!ally.alive || ally.team !== 'blue') continue;
            const sdx = ally.position.x - e.position.x;
            const sdz = ally.position.z - e.position.z;
            if (sdx * sdx + sdz * sdz <= 48400) {
              u.spotted = true;
              break;
            }
          }
        } else {
          u.spotted = false;
        }
      }

      // Ford tracking: a crossing = side flip between two non-zero readings
      world.getRiverSides(e.position.x, e.position.z, riverSidesNow);
      const prevSides = riverSidePrev[i];
      const cross = riverCrossings[i];
      for (let ri = 0; ri < riverSidesNow.length; ri++) {
        const s = riverSidesNow[ri];
        const p = prevSides[ri];
        if (s !== 0 && p !== 0 && s !== p) cross[ri]++;
        if (s !== 0) prevSides[ri] = s;
      }
    }
  };

  function tick(now: number): void {
    requestAnimationFrame(tick);

    // Zero GPU burn when browser tab is hidden/minimized!
    if (document.hidden) {
      lastFrameTime = now;
      return;
    }

    const isDeployed = controller.pointerLocked || forceHideBriefing;
    // Thermal frame limiter: 60 FPS max when playing (prevents 120Hz ProMotion double GPU load), 15 FPS when paused on menu!
    const minIntervalMs = isDeployed || cameraOverrideActive ? 15.6 : 64.0;
    const elapsedMs = now - lastFrameTime;
    if (elapsedMs < minIntervalMs) {
      return;
    }

    const rawDt = elapsedMs * 0.001;
    lastFrameTime = now - (elapsedMs % minIntervalMs);
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    fpsSmooth = THREE.MathUtils.lerp(fpsSmooth, 1 / Math.max(rawDt, 0.001), 0.08);

    // Hitch instrumentation: snapshot per-frame work counters at frame start
    const marks0 = {
      programs: renderer.info.programs?.length ?? 0,
      merges: benchDest.mergeCount,
      explosions: effects.explosionsSpawned,
      xrays: xrayFlashCount,
      raycasts: world.raycastCount,
    };
    const frameStart = performance.now();
    frameTimes.push(now);
    if (frameTimes.length > 900) frameTimes.splice(0, frameTimes.length - 900);

    if (!forceHideBriefing) {
      hud.setBriefingVisible(!controller.pointerLocked);
    }

    const _perfS0 = perfProbe.active ? performance.now() : 0;
    stepSimulation(dt);
    if (perfProbe.active) perfProbe.simMs += performance.now() - _perfS0;
    const playerTank = match.human;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    projectWorldToScreen(controller.commanderAimWorld, camera, vw, vh, commanderAimScreen, _projScratch);

    playerTank.getMuzzleWorld(_muzzlePos, _muzzleDir);
    const activeShell = playerTank.activeShell;
    const rangeMeters = predictBarrelImpact(
      _muzzlePos,
      _muzzleDir,
      activeShell.muzzleSpeed,
      world,
      allTanks,
      playerTank,
      _boreImpactWorld,
      activeShell
    );
    projectWorldToScreen(_boreImpactWorld, camera, vw, vh, gunnerBoreScreen, _projScratch);
    gunnerBoreScreen.rangeMeters = rangeMeters;
    const reticlePixelGap = Math.hypot(
      gunnerBoreScreen.x - commanderAimScreen.x,
      gunnerBoreScreen.y - commanderAimScreen.y
    );
    gunnerBoreScreen.onTarget = reticlePixelGap < 18 && playerTank.cannonCooldown <= 0.01;

    // Seeker lock box: project the locked/acquiring target; drop when it
    // leaves the viewport. While locked the ballistic pip is hidden — the
    // lock box replaces it.
    let lockOnTelemetry: HUDTelemetry['lockOn'];
    const seeker = playerTank.seekerLock;
    if (seeker?.target && seeker.progress > 0 && playerTank.stats.salvoSize) {
      const lt = seeker.target as Tank;
      lt.getCenterMassWorld(_projScratch);
      projectWorldToScreen(_projScratch, camera, vw, vh, lockTargetScreen, _markerWorldPos);
      const margin = 30;
      const offScreen =
        !lockTargetScreen.visible ||
        lockTargetScreen.x < -margin ||
        lockTargetScreen.x > vw + margin ||
        lockTargetScreen.y < -margin ||
        lockTargetScreen.y > vh + margin;
      if (offScreen) {
        lt.dropSeekerLock();
      } else {
        lockOnTelemetry = {
          targetId: lt.id,
          progress: seeker.progress,
          locked: seeker.locked,
          screenX: lockTargetScreen.x,
          screenY: lockTargetScreen.y,
          onScreen: true,
          rangeMeters: playerTank.position.distanceTo(lt.position),
        };
      }
    }
    if (seeker?.locked) {
      // Lock box replaces the predicted-impact pip for guided rockets
      gunnerBoreScreen.visible = false;
    }

    hitMarkerTimer = Math.max(0, hitMarkerTimer - dt);
    if (hitMarkerTimer <= 0) hitMarkerKind = 'none';
    incomingDamageTimer = Math.max(0, incomingDamageTimer - dt);

    const reloadProg =
      1 - THREE.MathUtils.clamp(playerTank.cannonCooldown / playerTank.stats.cannonReloadTime, 0, 1);

    const telemetry: HUDTelemetry = {
      vehicleClass: playerTank.stats.vehicleClass,
      activeShellIndex: playerTank.selectedShellIndex,
      shell0Code: playerTank.stats.shells[0].shortCode,
      shell1Code: playerTank.stats.shells[1].shortCode,
      hasMainCannon: playerTank.stats.hasMainCannon,
      hasCoaxMG: playerTank.stats.hasCoaxMG,
      infiniteMG: playerTank.stats.infiniteMG,
      hp: playerTank.hp,
      maxHp: playerTank.maxHp,
      alive: playerTank.alive,
      respawnRemaining: playerTank.respawnTimer,
      speedKmh: playerTank.speed * 3.6,
      gearLabel: 'F',
      throttle: lastPlayerThrottle,
      hullYaw: playerTank.hullYaw,
      turretWorldYaw: playerTank.turretWorldYaw,
      cameraYaw: controller.cameraYaw,
      cameraFovRad: THREE.MathUtils.degToRad(camera.fov),
      cannonReloadProgress: reloadProg,
      cannonCooldownSec: playerTank.cannonCooldown,
      rocketsLeft: playerTank.rocketsLeft,
      salvoSize: playerTank.stats.salvoSize,
      shellSpeedMs: activeShell.muzzleSpeed,
      mgHeat: playerTank.mgHeat,
      mgOverheated: playerTank.mgOverheated,
      commanderAim: commanderAimScreen,
      gunnerBore: gunnerBoreScreen,
      lockOn: lockOnTelemetry,
      kills,
      deaths,
      activeEnemies: activeEnemyCount,
      score: match.score,
      playerTeam: 'blue',
      fps: Math.round(fpsSmooth),
      hitMarker: {
        kind: hitMarkerKind,
        intensity: THREE.MathUtils.clamp(hitMarkerTimer * 2.2, 0, 1),
      },
      incomingDamageArc: {
        fromWorldYaw: incomingDamageYaw,
        intensity: THREE.MathUtils.clamp(incomingDamageTimer, 0, 1),
      },
      feedMessages: match.feed,
      pointerLocked: isDeployed,
      sniperZoom: controller.sniperZoom,
      minimap: {
        playerX: playerTank.position.x,
        playerZ: playerTank.position.z,
        worldHalfSize: world.worldHalfSize,
        units: minimapUnits,
        obstacles: minimapObstacles,
        rivers: radarRivers,
        mounds: radarMounds,
      },
    };

    if (!cameraOverrideActive) {
      hud.update(telemetry, dt);
      updateUnitMarkers(vw, vh, dt);

      if (isDeployed && !controller.hasTruePointerLock && !forceHideBriefing) {
        lockBannerEl.style.display = 'block';
        lockBannerEl.textContent = controller.pointerLockBlockedByHost
          ? 'Mouse lock is blocked here · click to open in a browser tab'
          : 'Click to aim · Esc pauses';
      } else {
        lockBannerEl.style.display = 'none';
      }

      hitCam.update(dt);
    } else {
      markerLayer.style.display = 'none';
      lockBannerEl.style.display = 'none';
    }

    // Refresh directional shadow map every 2nd active frame (30 Hz) — cuts shadow GPU work by 50%!
    shadowTickToggle = (shadowTickToggle + 1) % shadowInterval;
    if (shadowTickToggle === 0) {
      renderer.shadowMap.needsUpdate = true;
    }

    const hideOwnTankInOptic = controller.sniperZoom && !cameraOverrideActive && playerTank.alive;
    if (hideOwnTankInOptic) playerTank.root.visible = false;
    const _perfR0 = perfProbe.active ? performance.now() : 0;
    renderer.render(scene, camera);
    if (perfProbe.active) {
      perfProbe.renderMs += performance.now() - _perfR0;
      perfProbe.frames++;
      if (perfProbe.frames >= perfProbe.target) perfProbe.active = false;
    }
    if (hideOwnTankInOptic) playerTank.root.visible = true;

    // Hitch log: frames whose total wall time exceeds 25 ms, tagged by work done
    const frameMs = performance.now() - frameStart;
    if (frameMs > 25) {
      const tags: string[] = [];
      const dPrograms = (renderer.info.programs?.length ?? 0) - marks0.programs;
      const dMerges = benchDest.mergeCount - marks0.merges;
      const dExplosions = effects.explosionsSpawned - marks0.explosions;
      const dXrays = xrayFlashCount - marks0.xrays;
      const dRaycasts = world.raycastCount - marks0.raycasts;
      if (dPrograms > 0) tags.push(`shader+${dPrograms}`);
      if (dMerges > 0) tags.push(`wreckBake+${dMerges}`);
      if (dExplosions > 0) tags.push(`explosion+${dExplosions}`);
      if (dXrays > 0) tags.push(`xray+${dXrays}`);
      if (dRaycasts > 200) tags.push(`raycasts+${dRaycasts}`);
      hitchLog.push({
        t: now / 1000,
        ms: Math.round(frameMs * 10) / 10,
        tags: tags.join(',') || 'other',
        rc: dRaycasts,
      });
      if (hitchLog.length > 300) hitchLog.splice(0, hitchLog.length - 300);
    }

    // Adaptive quality: cheap always-on CPU EMA (sim + render submit + HUD).
    qualityEma += (frameMs - qualityEma) * 0.08;
    if (qualityManual === null) {
      if (qualityEma > 12) {
        qualityBadTime += dt;
        qualityGoodTime = 0;
      } else if (qualityEma < 6) {
        qualityGoodTime += dt;
        qualityBadTime = 0;
      } else {
        qualityBadTime = 0;
        qualityGoodTime = 0;
      }
      if (qualityBadTime > 2 && qualityLevel < 2) {
        applyQuality(qualityLevel + 1);
        qualityBadTime = 0;
        qualityGoodTime = 0;
      } else if (qualityGoodTime > 10 && qualityLevel > 0) {
        applyQuality(qualityLevel - 1);
        qualityBadTime = 0;
        qualityGoodTime = 0;
      }
    }
  }

  const killTankNow = (t: Tank, catastrophic: boolean): boolean => {
    if (!t.alive) return false;
    const fx = Math.sin(t.hullYaw);
    const fz = Math.cos(t.hullYaw);
    _markerWorldPos.set(t.position.x + fx * t.stats.collisionRadius, t.position.y + 1.4, t.position.z + fz * t.stats.collisionRadius);
    effects.spawnExplosion(_markerWorldPos, _projScratch.set(0, 1, 0), 1.3, 'tank_kill');
    destruction.applyBlast(_markerWorldPos, 6, 12);
    t.debugKill(catastrophic);
    return true;
  };

  /** Shared guidedTest/guidedScene setup: player rocket 300 m south of a
   *  red tank circling at 12 m/s around (0,-50); all other tanks parked. */
  const setupGuidedScene = (target: Tank): void => {
    const human = match.human;
    const px = 0;
    const pz = -350;
    human.respawnAt(_markerWorldPos.set(px, world.getHeightAt(px, pz), pz), 0);
    (human as unknown as { spawnProtect: number }).spawnProtect = 0;

    target.qaDriveCircle = { cx: 0, cz: -50, radius: 40, speed: 12, phase: 0 };
    target.respawnAt(_markerWorldPos.set(40, world.getHeightAt(40, -50), -50), 0);
    (target as unknown as { spawnProtect: number }).spawnProtect = 0;

    let parkIdx = 0;
    for (const b of allTanks) {
      if (b === human || b === target) continue;
      const a = parkIdx * 2.399;
      const r = 465;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      b.respawnAt(_markerWorldPos.set(x, world.getHeightAt(x, z), z), a);
      (b as unknown as { spawnProtect: number }).spawnProtect = 0;
      parkIdx++;
    }
  };

  // Expose QA & GPU render-stats telemetry for programmatic verification
  (window as unknown as Record<string, unknown>).__tankQA = {
    engageForTest: () => {
      forceHideBriefing = true;
      controller.setEngaged(true);
      hud.setBriefingVisible(false);
      markerLayer.style.display = 'block';
    },
    selectClassForTest: (cls: VehicleClass) => {
      swapPlayerClassFn?.(cls);
    },
    setCameraForTest: (px: number, py: number, pz: number, lx: number, ly: number, lz: number) => {
      cameraOverrideActive = true;
      camera.position.set(px, py, pz);
      camera.lookAt(lx, ly, lz);
      camera.updateMatrixWorld();
    },
    clearCameraForTest: () => {
      cameraOverrideActive = false;
    },
    /** Free-roam stress: teleports the player along a serpentine path every
     *  call to force grass-chunk/terrain work; returns current position. */
    teleportRoamForTest: (leg: number) => {
      const t = match.human;
      // Serpentine across the map: x sweeps -400..400, z oscillates 0..±300
      const phase = (leg % 8) / 8;
      const x = -400 + phase * 800;
      const z = Math.sin(leg * 0.9) * 300;
      const y = world.getHeightAt(x, z);
      t.respawnAt(_markerWorldPos.set(x, y, z), Math.atan2(-x, -z));
      return { x, y, z };
    },
    setWreckFxVisible: (v: boolean) => effects.setWreckFxVisible(v),
    killForTest: (tankId: string, catastrophic: boolean) => {
      const t = allTanks.find((x) => x.id === tankId);
      return t ? killTankNow(t, catastrophic) : false;
    },
    /** Deterministic big-fight stress scene: all bots on a 50–140 m ring ±35°
     *  in front of the camera, facing the ring centre; 5 are killed
     *  catastrophically (wreck FX on). Leaves a 3v3 bot fight + 5 wrecks. */
    setupBigFight: () => {
      const human = match.human;
      const camYaw = controller.cameraYaw;
      const ringX = human.position.x + Math.sin(camYaw) * 95;
      const ringZ = human.position.z + Math.cos(camYaw) * 95;
      const n = bots.length;
      for (let i = 0; i < n; i++) {
        const b = bots[i];
        const bearing = camYaw + THREE.MathUtils.degToRad(-35 + (70 * i) / Math.max(1, n - 1));
        const dist = 50 + ((i * 53) % 91);
        const x = human.position.x + Math.sin(bearing) * dist;
        const z = human.position.z + Math.cos(bearing) * dist;
        const y = world.getHeightAt(x, z);
        b.respawnAt(_markerWorldPos.set(x, y, z), Math.atan2(ringX - x, ringZ - z));
        (b as unknown as { spawnProtect: number }).spawnProtect = 0;
      }
      // Kill indices 1,3 (blue) + 6,8,10 (red) -> 3v3 still fighting, 5 wrecks
      for (const idx of [1, 3, 6, 8, 10]) {
        if (bots[idx]) killTankNow(bots[idx], true);
      }
      return { placed: n, killed: 5 };
    },
    /** Synchronous GPU+CPU frame cost: n renders at the 30 Hz shadow cadence,
     *  forced to completion with a 1x1 readPixels. */
    benchRender: (n: number) => {
      const frames = Math.max(1, Math.round(n));
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        renderer.shadowMap.needsUpdate = i % 2 === 0;
        renderer.render(scene, camera);
      }
      const gl = renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      const total = performance.now() - t0;
      return {
        msPerFrame: Math.round((total / frames) * 100) / 100,
        totalMs: Math.round(total * 10) / 10,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        programs: renderer.info.programs?.length ?? 0,
        dpr: renderer.getPixelRatio(),
      };
    },
    setBenchToggle: (name: string, on: boolean) => {
      switch (name) {
        case 'smoke':
          benchFx.smokeMesh.visible = on;
          break;
        case 'fire':
          benchFx.fireMesh.visible = on;
          break;
        case 'debris':
          for (const m of benchDest.debrisMeshes) m.visible = on;
          break;
        case 'wreckFx':
          effects.wreckFxVisible = on;
          break;
        case 'pointLights':
          for (const s of benchFx.lightPool) s.light.visible = on;
          for (const l of benchDest.wreckLights) l.visible = on;
          break;
        case 'shadows':
          renderer.shadowMap.enabled = on;
          scene.traverse((o) => {
            const mat = (o as unknown as { material?: THREE.Material | THREE.Material[] }).material;
            if (!mat) return;
            if (Array.isArray(mat)) for (const m of mat) m.needsUpdate = true;
            else mat.needsUpdate = true;
          });
          break;
        case 'grass':
          if (benchWorld.grassMesh) benchWorld.grassMesh.visible = on;
          break;
        case 'wrecks':
          for (const w of benchDest.wrecks) w.group.visible = on && w.active;
          break;
        case 'vehicles':
          for (const t of allTanks) t.root.visible = on && t.alive;
          break;
        case 'markers':
          markerLayer.style.display = on ? '' : 'none';
          break;
        default:
          return false;
      }
      return true;
    },
    setBenchDpr: (x: number) => {
      renderer.setPixelRatio(Math.max(0.5, x));
      renderer.setSize(window.innerWidth, window.innerHeight);
      return renderer.getPixelRatio();
    },
    getQualityLevel: () => qualityLevel,
    forceQualityLevel: (n: number | null) => {
      qualityManual = n;
      if (n !== null) applyQuality(Math.max(0, Math.min(2, Math.round(n))));
      return qualityLevel;
    },
    getHitchLog: () => hitchLog.slice(),
    /** Program cache keys for shader-growth diffing (dev tooling). */
    getProgramKeys: () =>
      (renderer.info.programs ?? []).map((p) => {
        const q = p as unknown as { cacheKey?: string; name?: string };
        return `${q.name ?? '?'}|${q.cacheKey ?? ''}`;
      }),
    /** Timestamps (ms) of executed ticks — deltas give true rendered-frame pacing. */
    getFrameTimes: () => frameTimes.slice(),
    /** Mesh counts per rig region for all 5 classes x 2 teams (dev tooling). */
    getRigMeshCounts: () => {
      const out: Record<string, { total: number; hull: number; turret: number; gun: number; wheels: number; physical: number; glass: number }> = {};
      const classes: VehicleClass[] = ['normal', 'heavy', 'ifv', 'humvee', 'rocket'];
      const teams: Team[] = ['blue', 'red'];
      for (const cls of classes) {
        for (const team of teams) {
          const rig = instantiateTankRig(assets, cls, team);
          const wheelNodes = new Set<THREE.Object3D>(rig.wheels.map((w) => w.node));
          const counts = { total: 0, hull: 0, turret: 0, gun: 0, wheels: 0, physical: 0, glass: 0 };
          const inSubtree = (root: THREE.Object3D, mesh: THREE.Object3D): boolean => {
            for (let p: THREE.Object3D | null = mesh; p; p = p.parent) {
              if (p === root) return true;
              if (p === rig.visualRoot) return false;
            }
            return false;
          };
          rig.visualRoot.traverse((o) => {
            if (!(o as THREE.Mesh).isMesh) return;
            counts.total++;
            const matProp = (o as THREE.Mesh).material;
            const mats = (Array.isArray(matProp) ? matProp : [matProp]) as THREE.Material[];
            for (const mm of mats) {
              if ((mm as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) counts.physical++;
              const mn = (mm.name || '').toLowerCase();
              const ms = mm as THREE.MeshStandardMaterial;
              if (ms.transparent || /glass|window|lens/.test(mn)) counts.glass++;
            }
            if (inSubtree(rig.gunRecoilGroup, o)) counts.gun++;
            else if (inSubtree(rig.turretPivot, o)) counts.turret++;
            else {
              let isWheel = false;
              for (const w of wheelNodes) {
                if (inSubtree(w, o)) { isWheel = true; break; }
              }
              if (isWheel) counts.wheels++;
              else counts.hull++;
            }
          });
          out[`${cls}_${team}`] = counts;
        }
      }
      return out;
    },
    physicsSelfTest: () => destruction.selfTest(),
    getWreckState: () => destruction.getWreckState(),
    probeWreckClearance: () => destruction.probeClearance(),
    perfSample: (frames: number) => {
      perfProbe.active = true;
      perfProbe.target = Math.max(1, Math.round(frames));
      perfProbe.frames = 0;
      perfProbe.simMs = 0;
      perfProbe.renderMs = 0;
    },
    getPerfResult: () => ({
      frames: perfProbe.frames,
      simMsAvg: perfProbe.frames ? perfProbe.simMs / perfProbe.frames : 0,
      renderMsAvg: perfProbe.frames ? perfProbe.renderMs / perfProbe.frames : 0,
      active: perfProbe.active,
    }),
    getRenderStats: () => ({
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs?.length ?? 0,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      activeClass: match.human.stats.vehicleClass,
      activeShell: match.human.activeShell.shortCode,
      rocketsLeft: match.human.rocketsLeft,
      salvoActive: match.human.salvoInProgress,
    }),
    fastForward: (seconds: number) => {
      const steps = Math.max(1, Math.round(seconds * 30));
      for (let i = 0; i < steps; i++) {
        stepSimulation(1 / 30);
      }
    },
    /** Precise teleport for verification shots (x, z, yaw radians). */
    teleportForTest: (x: number, z: number, yaw = 0) => {
      const t = match.human;
      const y = world.getHeightAt(x, z);
      t.respawnAt(_markerWorldPos.set(x, y, z), yaw);
      return { x, y, z };
    },
    /** Fire a shell straight down into the river at (x,z) for splash shots. */
    splashAtForTest: (x: number, z: number) => {
      const lvl = world.getWaterLevelAt(x, z);
      const depth = world.getWaterDepthAt(x, z);
      if (depth <= 0.05) return { ok: false, reason: 'no water', depth };
      const dir = new THREE.Vector3(0, -1, 0);
      const pos = new THREE.Vector3(x, lvl + 60, z);
      ballistics.fireCannon(match.human, pos, dir, match.human.activeShell);
      return { ok: true, depth, level: lvl };
    },
    /** Single-point water query for ford scouting. */
    waterAtForTest: (x: number, z: number) => ({
      depth: world.getWaterDepthAt(x, z),
      level: world.getWaterLevelAt(x, z),
      height: world.getHeightAt(x, z),
    }),
    /** World/terrain probe for F2 verification. */
    probeWorld: () => ({
      worldHalfSize: world.worldHalfSize,
      mounds: world.moundCount,
      moundSamples: world.getMoundRadarSamples(),
      rivers: world.riverCount,
      obstacles: world.obstacleCount,
      grass: world.grassStats,
      waterSamples: [
        { x: 0, z: -170, depth: world.getWaterDepthAt(0, -170), level: world.getWaterLevelAt(0, -170) },
        { x: 100, z: -170, depth: world.getWaterDepthAt(100, -170), level: world.getWaterLevelAt(100, -170) },
        { x: -200, z: -170, depth: world.getWaterDepthAt(-200, -170), level: world.getWaterLevelAt(-200, -170) },
        { x: 0, z: 170, depth: world.getWaterDepthAt(0, 170), level: world.getWaterLevelAt(0, 170) },
        { x: 100, z: 170, depth: world.getWaterDepthAt(100, 170), level: world.getWaterLevelAt(100, 170) },
        { x: 0, z: 0, depth: world.getWaterDepthAt(0, 0), level: world.getWaterLevelAt(0, 0) },
        { x: 0, z: -420, depth: world.getWaterDepthAt(0, -420) },
        { x: 0, z: 420, depth: world.getWaterDepthAt(0, 420) },
      ],
      spawnChecks: (() => {
        const out: { x: number; z: number; ok: boolean; depth: number }[] = [];
        let seed = 1234567;
        const rng = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        for (let i = 0; i < 30; i++) {
          const ang = rng() * Math.PI * 2;
          const rad = 10 + rng() * 30;
          const bz = i % 2 === 0 ? -420 : 420;
          const x = Math.cos(ang) * rad;
          const z = bz + Math.sin(ang) * rad;
          const depth = world.getWaterDepthAt(x, z);
          out.push({ x: Math.round(x), z: Math.round(z), ok: depth <= 0.02, depth: Math.round(depth * 100) / 100 });
        }
        return out;
      })(),
    }),
    getRiverCrossings: () => ({
      // [botIndex][riverIndex] crossing counts; river 0 = south (~z=-170), 1 = north (~z=+170)
      perBot: riverCrossings.map((r) => [r[0], r[1]]),
      bots: bots.map((b, i) => ({
        id: b.id,
        team: b.team,
        cls: b.stats.vehicleClass,
        south: riverCrossings[i]?.[0] ?? 0,
        north: riverCrossings[i]?.[1] ?? 0,
      })),
      totals: [
        riverCrossings.reduce((s, r) => s + r[0], 0),
        riverCrossings.reduce((s, r) => s + r[1], 0),
      ],
    }),
    getMatchState: () => ({
      score: { blue: match.score.blue, red: match.score.red },
      friendlyFireEvents,
      kills,
      deaths,
      tanks: allTanks.map((t) => ({
        id: t.id,
        team: t.team,
        cls: t.stats.vehicleClass,
        alive: t.alive,
        hp: Math.round(t.hp),
        x: Math.round(t.position.x * 10) / 10,
        z: Math.round(t.position.z * 10) / 10,
        seeker: t.seekerLock
          ? {
              target: t.seekerLock.target?.id ?? null,
              progress: Math.round(t.seekerLock.progress * 100) / 100,
              locked: t.seekerLock.locked,
            }
          : undefined,
      })),
    }),
    /** Sets up the guidedTest scene WITHOUT running it: player rocket at
     *  (0,-350), a red tank circling at 12 m/s around (0,-50) ~300 m ahead,
     *  all other tanks parked at the map rim. Real seeker/HUD path then runs. */
    guidedScene: () => {
      swapPlayerClassFn?.('rocket');
      const human = match.human;
      const target =
        bots.find((b) => b.team === 'red' && b.stats.vehicleClass !== 'rocket') ??
        bots.find((b) => b.team === 'red') ??
        null;
      if (!target) return { error: 'no red bot available' };
      setupGuidedScene(target);
      return { ok: true, targetId: target.id };
    },
    /** Fires one player cannon trigger through the normal intent path. */
    firePlayerCannonForTest: () => {
      qaFireCannonOnce = true;
      return true;
    },
    /** Guided-munition QA: a red tank drives a 40 m circle at 12 m/s, 300 m
     *  from the player's rocket launcher. Runs guided (locked), unguided
     *  (no lock) and decoy (burning wreck in front of target, 3 salvos)
     *  scenarios; reports hits, min miss distance and decoy count. */
    guidedTest: () => {
      swapPlayerClassFn?.('rocket');
      const human = match.human;
      const target =
        bots.find((b) => b.team === 'red' && b.stats.vehicleClass !== 'rocket') ??
        bots.find((b) => b.team === 'red') ??
        null;
      if (!target) return { error: 'no red bot available' };

      const runScenario = (mode: 'guided' | 'unguided' | 'decoy') => {
        ballistics.resetGuidedStats();
        ballistics.missProbeTarget = target;
        ballistics.missProbeMin = Infinity;
        setupGuidedScene(target);

        // Decoy mode: kill spare bots at the near-side point before each salvo
        const decoySpare = allTanks.filter((t) => t !== human && t !== target);
        let decoyArmed = 0;

        qaIntentOverride = _qaIntent;
        let steps = 0;
        const maxSteps = mode === 'decoy' ? 1600 : 800;
        const wantSalvos = mode === 'decoy' ? 3 : 1;
        let salvosStarted = 0;
        let lastSalvoStep = -1;
        let wasSalvo = false;
        let unguidedFired = false;

        while (steps < maxSteps) {
          steps++;
          target.getCenterMassWorld(_qaAimPoint);
          _qaAimOrigin.set(human.position.x, human.position.y + 2.2, human.position.z);
          _qaIntent.throttle = 0;
          _qaIntent.steer = 0;
          _qaIntent.brake = false;
          _qaIntent.fireMG = false;
          _qaIntent.selectShell = null;

          const canTrigger =
            human.cannonCooldown <= 0 && human.rocketsLeft > 0 && !human.salvoInProgress;

          if (mode === 'unguided') {
            // Fire the first available salvo with no lock wait
            _qaIntent.fireCannon = !unguidedFired && canTrigger;
            if (human.salvoInProgress) unguidedFired = true;
          } else {
            const locked = Boolean(human.seekerLock?.locked);
            _qaIntent.fireCannon = locked && canTrigger && salvosStarted < wantSalvos;
          }

          if (mode === 'decoy' && salvosStarted < wantSalvos) {
            // Arm a fresh burning wreck ~30 m in front of the target line
            const need = salvosStarted; // one per upcoming salvo
            if (decoyArmed <= need && decoySpare.length > 0) {
              const spare = decoySpare[decoyArmed % decoySpare.length];
              const bx = 0;
              const bz = -110 - decoyArmed * 6;
              spare.respawnAt(_markerWorldPos.set(bx, world.getHeightAt(bx, bz), bz), 0);
              (spare as unknown as { spawnProtect: number }).spawnProtect = 0;
              killTankNow(spare, true);
              decoyArmed++;
            }
          }

          stepSimulation(1 / 30);

          const isSalvo = human.salvoInProgress;
          if (isSalvo && !wasSalvo) {
            salvosStarted++;
            lastSalvoStep = steps;
          }
          wasSalvo = isSalvo;

          if (salvosStarted >= wantSalvos && steps > lastSalvoStep + 260) break;
        }

        qaIntentOverride = null;
        target.qaDriveCircle = null;
        ballistics.missProbeTarget = null;

        const minMiss = ballistics.missProbeMin;
        return {
          mode,
          steps,
          salvos: salvosStarted,
          hits: ballistics.guidedHits,
          decoys: ballistics.guidedDecoys,
          minMiss: minMiss === Infinity ? null : Math.round(minMiss * 10) / 10,
          guidedMinMiss:
            ballistics.guidedMinMiss === Infinity ? null : Math.round(ballistics.guidedMinMiss * 10) / 10,
          targetAlive: target.alive,
          targetHp: Math.round(target.hp),
        };
      };

      const guided = runScenario('guided');
      const unguided = runScenario('unguided');
      const decoy = runScenario('decoy');
      return { guided, unguided, decoy };
    },
    runThreeAudit: () => {
      const results: Record<string, AuditIssue[]> = {};
      const testClasses: VehicleClass[] = ['normal', 'heavy', 'ifv', 'humvee', 'rocket'];
      for (const cls of testClasses) {
        const tempTank = new Tank(`audit_${cls}`, 'blue', cls, assets, new THREE.Vector3(0, 0, 0), 0, false, 'Audit');
        results[cls] = auditThreeObject(tempTank.root, {
          groundY: 0,
          maxGap: 0.02,
          camera,
          checkConnectivity: true,
          checkInterpenetration: false,
        });
      }
      return results;
    },
  };

  requestAnimationFrame(tick);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
});
