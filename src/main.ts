import * as THREE from 'three';

import { loadAllGameAssets } from './game/AssetLoader';
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
  VehicleClass,
} from './game/types';

interface UnitMarkerDOM {
  el: HTMLDivElement;
  codeEl: HTMLSpanElement;
  distEl: HTMLSpanElement;
  barFillEl: HTMLDivElement;
  barTrackEl: HTMLDivElement;
  isAlly: boolean;
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
  return { el, codeEl, distEl, barFillEl, barTrackEl, isAlly };
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

  let fpsSmooth = 60;
  let cameraOverrideActive = false;
  let forceHideBriefing = false;
  const perfProbe = { active: false, target: 0, frames: 0, simMs: 0, renderMs: 0 };

  const tankCallbacks = {
    onFireCannon: (shooter: Tank, pos: THREE.Vector3, dir: THREE.Vector3, shell: ShellSpec) => {
      ballistics.fireCannon(shooter, pos, dir, shell);
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
    onWreckSmoke: (pos: THREE.Vector3) => {
      effects.spawnWreckSmoke(pos);
    },
  };

  let lastFrameTime = performance.now();
  let shadowTickToggle = 0;

  const updateUnitMarkers = (vw: number, vh: number) => {
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
    if (!cameraOverrideActive) {
      playerIntent = controller.update(dt, human, world, allTanks, shakeImpulse);
    }
    lastPlayerThrottle = playerIntent?.throttle ?? 0;

    const aiIntents = isDeployed ? botAI.update(dt, bots, allTanks, world) : null;

    human.stepKinematics(dt, isDeployed ? playerIntent : null, world, allTanks, tankCallbacks);
    for (let i = 0; i < bots.length; i++) {
      const e = bots[i];
      const eIntent = aiIntents ? (aiIntents.get(e.id) ?? null) : null;
      e.stepKinematics(dt, eIntent, world, allTanks, tankCallbacks);
    }

    ballistics.update(dt, world, allTanks, handleDamage);
    match.update(dt);
    world.update(dt, human.position);
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
      },
    };

    if (!cameraOverrideActive) {
      hud.update(telemetry, dt);
      updateUnitMarkers(vw, vh);

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
    shadowTickToggle = (shadowTickToggle + 1) & 1;
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
    setCameraForTest: (px: number, py: number, pz: number, lx: number, ly: number, lz: number) => {
      cameraOverrideActive = true;
      camera.position.set(px, py, pz);
      camera.lookAt(lx, ly, lz);
      camera.updateMatrixWorld();
    },
    clearCameraForTest: () => {
      cameraOverrideActive = false;
    },
    setWreckFxVisible: (v: boolean) => effects.setWreckFxVisible(v),
    killForTest: (tankId: string, catastrophic: boolean) => {
      const t = allTanks.find((x) => x.id === tankId);
      if (!t || !t.alive) return false;
      const fx = Math.sin(t.hullYaw);
      const fz = Math.cos(t.hullYaw);
      _markerWorldPos.set(t.position.x + fx * t.stats.collisionRadius, t.position.y + 1.4, t.position.z + fz * t.stats.collisionRadius);
      effects.spawnExplosion(_markerWorldPos, _projScratch.set(0, 1, 0), 1.3, 'tank_kill');
      destruction.applyBlast(_markerWorldPos, 6, 12);
      t.debugKill(catastrophic);
      return true;
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
      })),
    }),
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
