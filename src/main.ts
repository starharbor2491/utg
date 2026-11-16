import * as THREE from 'three';

import { loadAllGameAssets } from './game/AssetLoader';
import { World } from './game/World';
import { Tank } from './game/Tank';
import { EffectsManager } from './game/Effects';
import { BallisticsManager, predictBarrelImpact } from './game/Ballistics';
import { PlayerController } from './game/PlayerController';
import { EnemyAIManager } from './game/EnemyAI';
import { HUD } from './game/HUD';
import { HitCam } from './game/HitCam';
import { auditThreeObject, type AuditIssue } from './game/SceneAudit';
import type {
  DamageEvent,
  HUDTelemetry,
  MinimapEnemy,
  MinimapObstacle,
  ScreenReticlePos,
  ShellSpec,
  TankVariant,
  VehicleClass,
} from './game/types';

interface HostileMarkerDOM {
  el: HTMLDivElement;
  codeEl: HTMLSpanElement;
  distEl: HTMLSpanElement;
  barFillEl: HTMLDivElement;
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

function variantForPlayerClass(cls: VehicleClass): TankVariant {
  if (cls === 'heavy') return 'player_heavy';
  if (cls === 'ifv') return 'player_ifv';
  return 'player_normal';
}

function markerCodeForVariant(v: TankVariant): string {
  if (v.endsWith('_heavy')) return 'HEAVY';
  if (v.endsWith('_ifv')) return 'IFV';
  return 'MBT';
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
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.3, 900);
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
    onQualityChange: () => {},
    onSelectVehicleClass: (cls) => {
      swapPlayerClassFn?.(cls);
    },
  });

  const markerLayer = document.createElement('div');
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
  const ballistics = new BallisticsManager(scene, effects);

  // Pre-build all 3 player vehicles once so switching class is instantaneous with zero runtime allocations!
  const playerSpawn = new THREE.Vector3(0, world.getHeightAt(0, -190), -190);
  const playerVehicles: Record<VehicleClass, Tank> = {
    normal: new Tank('player_normal', 'player', 'player_normal', assets, playerSpawn, 0),
    heavy: new Tank('player_heavy', 'player', 'player_heavy', assets, playerSpawn, 0),
    ifv: new Tank('player_ifv', 'player', 'player_ifv', assets, playerSpawn, 0),
  };
  let activePlayerClass: VehicleClass = 'normal';
  let playerTank: Tank = playerVehicles.normal;
  scene.add(playerTank.root);

  // Spawn mixed 3-class OPFOR platoon far North (230m - 365m away from player staging area)
  const initialEnemyConfigs: { variant: TankVariant; x: number; z: number; yaw: number }[] = [
    { variant: 'enemy_normal', x: 22, z: 42, yaw: Math.PI },
    { variant: 'enemy_ifv', x: -58, z: 68, yaw: 2.5 },
    { variant: 'enemy_heavy', x: 74, z: 88, yaw: -2.4 },
    { variant: 'enemy_normal', x: -16, z: 148, yaw: Math.PI },
    { variant: 'enemy_ifv', x: -102, z: 122, yaw: 2.1 },
  ];

  const enemies: Tank[] = [];
  const hostileMarkers: HostileMarkerDOM[] = [];

  initialEnemyConfigs.forEach((cfg, idx) => {
    const pos = new THREE.Vector3(cfg.x, world.getHeightAt(cfg.x, cfg.z), cfg.z);
    const enemy = new Tank(`enemy_${idx + 1}`, 'enemy', cfg.variant, assets, pos, cfg.yaw);
    scene.add(enemy.root);
    enemies.push(enemy);

    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:0;top:0;transform:translate(-50%,-100%);display:none;flex-direction:column;align-items:center;gap:2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;text-shadow:0 1px 2px rgba(0,0,0,0.95);';

    const topRow = document.createElement('div');
    topRow.style.cssText =
      'display:flex;align-items:center;gap:5px;font-size:10px;font-weight:700;letter-spacing:0.06em;color:#f0b6ad;';

    const codeEl = document.createElement('span');
    codeEl.textContent = markerCodeForVariant(cfg.variant);
    const distEl = document.createElement('span');
    distEl.style.color = '#eae6dc';
    distEl.style.opacity = '0.85';
    topRow.append(codeEl, distEl);

    const barTrack = document.createElement('div');
    barTrack.style.cssText =
      'width:38px;height:3px;background:rgba(16,19,15,0.85);border:1px solid rgba(217,70,54,0.55);';
    const barFillEl = document.createElement('div');
    barFillEl.style.cssText = 'width:100%;height:100%;background:#d94636;';
    barTrack.appendChild(barFillEl);

    const diamond = document.createElement('div');
    diamond.style.cssText =
      'width:7px;height:7px;border:1.5px solid #d94636;transform:rotate(45deg);margin-top:2px;background:rgba(217,70,54,0.28);';

    el.append(topRow, barTrack, diamond);
    markerLayer.appendChild(el);
    hostileMarkers.push({ el, codeEl, distEl, barFillEl });
  });

  const allTanks: Tank[] = [playerTank, ...enemies];
  const enemyAI = new EnemyAIManager();

  swapPlayerClassFn = (nextCls: VehicleClass) => {
    if (nextCls === activePlayerClass) return;
    const prevPos = playerTank.position.clone();
    const prevYaw = playerTank.hullYaw;
    const prevTurret = playerTank.turretRelYaw;
    scene.remove(playerTank.root);

    activePlayerClass = nextCls;
    playerTank = playerVehicles[nextCls];
    playerTank.respawnAt(prevPos, prevYaw);
    playerTank.turretRelYaw = prevTurret;
    scene.add(playerTank.root);
    allTanks[0] = playerTank;
    void variantForPlayerClass;
  };

  const controller = new PlayerController(camera, canvas);
  controllerRef = controller;

  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(getOptimalDpr());
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

  const minimapEnemies: MinimapEnemy[] = enemies.map((e) => ({
    x: e.position.x,
    z: e.position.z,
    yaw: e.hullYaw,
    variant: e.variant,
    alive: e.alive,
    alerted: false,
  }));

  let kills = 0;
  let deaths = 0;

  // Compact cursor-lock status pill + 3-step micro-tutorial bar (top-center)
  const topPromptsWrap = document.createElement('div');
  topPromptsWrap.style.cssText =
    'position:fixed;top:16px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;z-index:22;pointer-events:none;';
  hudRoot.appendChild(topPromptsWrap);

  const lockBannerEl = document.createElement('button');
  lockBannerEl.type = 'button';
  lockBannerEl.style.cssText =
    'display:none;pointer-events:auto;cursor:pointer;padding:5px 12px;background:rgba(19,23,18,0.88);border:1px solid #e8a938;color:#e8a938;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:700;letter-spacing:0.12em;';
  lockBannerEl.textContent = 'CLICK TO LOCK MOUSE INSIDE WINDOW  //  [ESC] PAUSE';
  lockBannerEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (controller.pointerLockBlockedByHost) {
      window.open(window.location.href, '_blank');
    } else {
      controller.setEngaged(true);
      controller.requestLock();
    }
  });
  topPromptsWrap.appendChild(lockBannerEl);

  const tutBarEl = document.createElement('div');
  tutBarEl.style.cssText =
    'display:none;align-items:center;gap:12px;padding:7px 14px;background:rgba(15,19,14,0.90);border:1px solid rgba(232,169,56,0.42);border-left:3px solid #e8a938;box-shadow:0 4px 14px rgba(0,0,0,0.45);';
  const tutStepBadge = document.createElement('span');
  tutStepBadge.style.cssText =
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;font-weight:700;letter-spacing:0.12em;color:#e8a938;padding:2px 6px;background:rgba(232,169,56,0.14);border:1px solid rgba(232,169,56,0.35);';
  const tutTextEl = document.createElement('span');
  tutTextEl.style.cssText =
    'font-size:13px;font-weight:700;letter-spacing:0.08em;color:#eae6dc;white-space:nowrap;';
  const tutSkipHint = document.createElement('span');
  tutSkipHint.style.cssText =
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:rgba(234,230,220,0.52);letter-spacing:0.08em;';
  tutSkipHint.textContent = '[TAB] SKIP';
  tutBarEl.append(tutStepBadge, tutTextEl, tutSkipHint);
  topPromptsWrap.appendChild(tutBarEl);

  let tutStage: 0 | 1 | 2 | 3 | 4 = 0;
  let tutDoneTimer = 0;
  let initialCamYawSample: number | null = null;
  let playerFiredOnce = false;

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab' && tutStage < 4 && controller.pointerLocked) {
      e.preventDefault();
      tutStage = 4;
    }
  });

  let hitMarkerKind: 'none' | 'hit' | 'kill' = 'none';
  let hitMarkerTimer = 0;
  let incomingDamageYaw = 0;
  let incomingDamageTimer = 0;

  const handleDamage = (ev: DamageEvent) => {
    const victim = ev.victim as Tank;
    const attacker = ev.attacker as Tank | null;
    const killedNow = ev.killed;

    if (victim.faction === 'enemy' && attacker === playerTank) {
      enemyAI.notifyDamaged(victim.id);
      if (ev.xrayReport) {
        hitCam.showHit(ev.xrayReport);
      }
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
    } else if (victim === playerTank) {
      if (attacker) {
        incomingDamageYaw = Math.atan2(
          attacker.position.x - playerTank.position.x,
          attacker.position.z - playerTank.position.z
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
  const _avoidList: THREE.Vector3[] = [];
  const _emptyFeed: readonly [] = [];

  const commanderAimScreen: ScreenReticlePos = { x: 0, y: 0, visible: true };
  const gunnerBoreScreen = { x: 0, y: 0, visible: true, onTarget: false, rangeMeters: 100 };

  let fpsSmooth = 60;
  let cameraOverrideActive = false;
  let forceHideBriefing = false;

  const tankCallbacks = {
    onFireCannon: (shooter: Tank, pos: THREE.Vector3, dir: THREE.Vector3, shell: ShellSpec) => {
      ballistics.fireCannon(shooter, pos, dir, shell);
      if (shooter === playerTank) {
        playerFiredOnce = true;
        controller.addShake(shooter.stats.vehicleClass === 'heavy' ? 0.52 : 0.34);
      }
    },
    onFireMG: (shooter: Tank, pos: THREE.Vector3, dir: THREE.Vector3, beltSpec?: ShellSpec) => {
      ballistics.fireCoaxMG(shooter, pos, dir, beltSpec);
      if (shooter === playerTank) {
        playerFiredOnce = true;
        if (beltSpec) {
          controller.addShake(0.035);
        }
      }
    },
    onTrackDust: (pos: THREE.Vector3, intensity01: number) => {
      effects.spawnTrackDust(pos, intensity01);
    },
    onWreckSmoke: (pos: THREE.Vector3) => {
      effects.spawnWreckSmoke(pos);
    },
  };

  let lastFrameTime = performance.now();
  let shadowTickToggle = 0;

  const updateHostileMarkers = (vw: number, vh: number) => {
    const hideAll = !controller.pointerLocked && !forceHideBriefing;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const m = hostileMarkers[i];
      if (hideAll || !e.alive) {
        m.el.style.display = 'none';
        continue;
      }

      const dist = playerTank.position.distanceTo(e.position);
      const maxSpotDist = controller.sniperZoom ? 340 : 235;
      if (dist > maxSpotDist) {
        m.el.style.display = 'none';
        continue;
      }

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

      _losDir.subVectors(_markerWorldPos, camera.position);
      const losLen = _losDir.length();
      if (losLen > 1) {
        _losDir.multiplyScalar(1 / losLen);
        const hit = world.raycastWorld(camera.position, _losDir, losLen - 2.2);
        if (hit && (hit.hitKind === 'terrain' || !hit.obstacle?.destructible)) {
          m.el.style.display = 'none';
          continue;
        }
      }

      const sx = (_projScratch.x * 0.5 + 0.5) * vw;
      const sy = (-_projScratch.y * 0.5 + 0.5) * vh;
      m.el.style.display = 'flex';
      m.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
      m.distEl.textContent = `${Math.round(dist)}M`;
      const hpPct = THREE.MathUtils.clamp((e.hp / e.maxHp) * 100, 0, 100);
      m.barFillEl.style.width = `${hpPct.toFixed(0)}%`;
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

    if (!forceHideBriefing) {
      hud.setBriefingVisible(!controller.pointerLocked);
    }

    if (!playerTank.alive && playerTank.respawnTimer <= 0.01) {
      _avoidList.length = 0;
      for (const e of enemies) {
        if (e.alive) _avoidList.push(e.position);
      }
      const sp = world.getSafeSpawnPoint(45, 95, _avoidList);
      const faceCenterYaw = Math.atan2(-sp.x, -sp.z);
      playerTank.respawnAt(sp, faceCenterYaw);
      controller.setViewAngles(faceCenterYaw, -0.05);
    }

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive && e.respawnTimer <= 0.01) {
        _avoidList.length = 0;
        _avoidList.push(playerTank.position);
        for (const other of enemies) {
          if (other !== e && other.alive) _avoidList.push(other.position);
        }
        const sp = world.getSafeSpawnPoint(155, 225, _avoidList);
        const yawToPlayer = Math.atan2(playerTank.position.x - sp.x, playerTank.position.z - sp.z);
        e.respawnAt(sp, yawToPlayer);
      }
    }

    const shakeImpulse = effects.consumeCameraShake(camera.position);
    let playerIntent = null;
    if (!cameraOverrideActive) {
      playerIntent = controller.update(dt, playerTank, world, allTanks, shakeImpulse);
    }

    const aiIntents = isDeployed ? enemyAI.update(dt, enemies, playerTank, world) : null;

    playerTank.stepKinematics(dt, isDeployed ? playerIntent : null, world, allTanks, tankCallbacks);

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const eIntent = aiIntents ? (aiIntents.get(e.id) ?? null) : null;
      e.stepKinematics(dt, eIntent, world, allTanks, tankCallbacks);
    }

    ballistics.update(dt, world, allTanks, handleDamage);
    world.update(dt, playerTank.position);
    effects.update(dt, camera);

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
      _boreImpactWorld
    );
    projectWorldToScreen(_boreImpactWorld, camera, vw, vh, gunnerBoreScreen, _projScratch);
    gunnerBoreScreen.rangeMeters = rangeMeters;
    const reticlePixelGap = Math.hypot(
      gunnerBoreScreen.x - commanderAimScreen.x,
      gunnerBoreScreen.y - commanderAimScreen.y
    );
    gunnerBoreScreen.onTarget = reticlePixelGap < 18 && playerTank.cannonCooldown <= 0.01;

    hitMarkerTimer = Math.max(0, hitMarkerTimer - dt);
    if (hitMarkerTimer <= 0) hitMarkerKind = 'none';
    incomingDamageTimer = Math.max(0, incomingDamageTimer - dt);

    let activeEnemyCount = 0;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.alive) activeEnemyCount++;
      minimapEnemies[i].x = e.position.x;
      minimapEnemies[i].z = e.position.z;
      minimapEnemies[i].yaw = e.hullYaw;
      minimapEnemies[i].alive = e.alive;
      minimapEnemies[i].alerted = enemyAI.isAlerted(e.id);
    }

    const reloadProg =
      1 - THREE.MathUtils.clamp(playerTank.cannonCooldown / playerTank.stats.cannonReloadTime, 0, 1);

    const telemetry: HUDTelemetry = {
      vehicleClass: playerTank.stats.vehicleClass,
      activeShellIndex: playerTank.selectedShellIndex,
      shell0Code: playerTank.stats.shells[0].shortCode,
      shell1Code: playerTank.stats.shells[1].shortCode,
      hasMainCannon: playerTank.stats.hasMainCannon,
      infiniteMG: playerTank.stats.infiniteMG,
      hp: playerTank.hp,
      maxHp: playerTank.maxHp,
      alive: playerTank.alive,
      respawnRemaining: playerTank.respawnTimer,
      speedKmh: playerTank.speed * 3.6,
      gearLabel: 'F',
      throttle: playerIntent?.throttle ?? 0,
      hullYaw: playerTank.hullYaw,
      turretWorldYaw: playerTank.turretWorldYaw,
      cameraYaw: controller.cameraYaw,
      cameraFovRad: THREE.MathUtils.degToRad(camera.fov),
      cannonReloadProgress: reloadProg,
      cannonCooldownSec: playerTank.cannonCooldown,
      shellSpeedMs: activeShell.muzzleSpeed,
      mgHeat: playerTank.mgHeat,
      mgOverheated: playerTank.mgOverheated,
      commanderAim: commanderAimScreen,
      gunnerBore: gunnerBoreScreen,
      kills,
      deaths,
      activeEnemies: activeEnemyCount,
      fps: Math.round(fpsSmooth),
      hitMarker: {
        kind: hitMarkerKind,
        intensity: THREE.MathUtils.clamp(hitMarkerTimer * 2.2, 0, 1),
      },
      incomingDamageArc: {
        fromWorldYaw: incomingDamageYaw,
        intensity: THREE.MathUtils.clamp(incomingDamageTimer, 0, 1),
      },
      feedMessages: _emptyFeed,
      pointerLocked: isDeployed,
      sniperZoom: controller.sniperZoom,
      minimap: {
        playerX: playerTank.position.x,
        playerZ: playerTank.position.z,
        worldHalfSize: world.worldHalfSize,
        enemies: minimapEnemies,
        obstacles: minimapObstacles,
      },
    };

    if (!cameraOverrideActive) {
      hud.update(telemetry, dt);
      updateHostileMarkers(vw, vh);

      if (isDeployed && !controller.hasTruePointerLock && !forceHideBriefing) {
        lockBannerEl.style.display = 'block';
        lockBannerEl.textContent = controller.pointerLockBlockedByHost
          ? 'IDE PREVIEW BLOCKS MOUSE LOCK — CLICK TO OPEN IN BROWSER TAB ↗'
          : 'CLICK SCREEN TO LOCK MOUSE INSIDE WINDOW  //  [ESC] PAUSE';
      } else {
        lockBannerEl.style.display = 'none';
      }

      hitCam.update(dt);

      if (isDeployed && tutStage < 4) {
        if (initialCamYawSample === null) initialCamYawSample = controller.cameraYaw;

        if (tutStage === 0) {
          tutStepBadge.textContent = 'STEP 1/3';
          tutTextEl.textContent = '[W A S D] Drive  ·  [1 / 2] Switch Shell Type';
          if (Math.hypot(playerTank.position.x, playerTank.position.z + 190) > 3.2) {
            tutStage = 1;
            initialCamYawSample = controller.cameraYaw;
          }
        } else if (tutStage === 1) {
          tutStepBadge.textContent = 'STEP 2/3';
          tutTextEl.textContent = '[MOUSE] Aim turret  ·  [RIGHT CLICK] 2.8x Zoom';
          const swept = Math.abs(
            Math.atan2(
              Math.sin(controller.cameraYaw - initialCamYawSample),
              Math.cos(controller.cameraYaw - initialCamYawSample)
            )
          );
          if (swept > 0.22 || controller.sniperZoom) {
            tutStage = 2;
            playerFiredOnce = false;
          }
        } else if (tutStage === 2) {
          tutStepBadge.textContent = 'STEP 3/3';
          tutTextEl.textContent = '[LEFT CLICK] Fire  ·  [SPACE] Machine Gun';
          if (playerFiredOnce) {
            tutStage = 3;
            tutDoneTimer = 2.0;
          }
        } else if (tutStage === 3) {
          tutStepBadge.textContent = 'READY';
          tutTextEl.textContent = 'GOOD HUNTING — ESC TO SWITCH VEHICLE CLASS';
          tutSkipHint.style.display = 'none';
          tutDoneTimer -= dt;
          if (tutDoneTimer <= 0) {
            tutStage = 4;
          }
        }
        tutBarEl.style.display = tutStage < 4 ? 'flex' : 'none';
      } else {
        tutBarEl.style.display = 'none';
      }
    } else {
      markerLayer.style.display = 'none';
      lockBannerEl.style.display = 'none';
      tutBarEl.style.display = 'none';
    }

    // Refresh directional shadow map every 2nd active frame (30 Hz) — cuts shadow GPU work by 50%!
    shadowTickToggle = (shadowTickToggle + 1) & 1;
    if (shadowTickToggle === 0) {
      renderer.shadowMap.needsUpdate = true;
    }

    const hideOwnTankInOptic = controller.sniperZoom && !cameraOverrideActive && playerTank.alive;
    if (hideOwnTankInOptic) playerTank.root.visible = false;
    renderer.render(scene, camera);
    if (hideOwnTankInOptic) playerTank.root.visible = true;
  }

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
    getRenderStats: () => ({
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs?.length ?? 0,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      activeClass: playerTank.stats.vehicleClass,
      activeShell: playerTank.activeShell.shortCode,
    }),
    runThreeAudit: () => {
      const results: Record<string, AuditIssue[]> = {};
      const testVariants: TankVariant[] = ['player_normal', 'player_heavy', 'player_ifv'];
      for (const v of testVariants) {
        const tempTank = new Tank(`audit_${v}`, 'player', v, assets, new THREE.Vector3(0, 0, 0), 0);
        results[v] = auditThreeObject(tempTank.root, {
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
