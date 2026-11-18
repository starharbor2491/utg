import type { Entity } from 'playcanvas';
import { clamp, quatFromEuler, Quat, radToDeg, Vec3 } from './engine/math';
import type { TankEntity, TankIntent, TerrainQuery } from './types';

const BASE_FOV_DEG = 58;
const DEFAULT_SNIPER_FOV_DEG = 22; // ~2.8x optical magnification
const DEFAULT_TP_DISTANCE = 11.5;
const MIN_TP_DISTANCE = 7.5;
const MAX_TP_DISTANCE = 18.0;
const MAX_AIM_RAY_DIST = 550;

function wrapAnglePi(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

export interface PlayerControllerOptions {
  onCycleQuality?: () => void;
}

export class PlayerController {
  private readonly camera: Entity;
  private readonly canvas: HTMLElement;
  public onCycleQuality?: () => void;

  private readonly keysDown = new Set<string>();
  private mouseLeftDown = false;
  private mouseRightDown = false;
  /** F5b: while a player FPV drone is airborne the mouse drives the drone,
   *  the vehicle brakes, and the camera sits at the drone. */
  public droneMode = false;
  private aircraftControls = false;
  public fpvCamPos: Vec3 | null = null;
  public fpvCamQuat: Quat | null = null;
  private _droneDX = 0;
  private _droneDY = 0;
  private _edgeLmb = false;
  private _edgeRmb = false;
  /** Per-frame click edges (set by mousedown, cleared each update) — quick
   *  clicks that down+up inside one frame still register once. */
  public frameLmb = false;
  public frameRmb = false;
  public get pressedKeys(): ReadonlySet<string> {
    return this.keysDown;
  }

  private _cameraYaw = 0;
  private _cameraPitch = -0.06;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private readonly fpvLookRotation = new Quat();
  private readonly fpvCombinedRotation = new Quat();
  private _sniperZoom = false;
  private rmbZoomDownTime = 0;
  private rmbTurnedZoomOn = false;
  private _pointerLocked = false;
  private _pointerLockBlocked = false;
  private _engaged = false;
  private pendingShellSlot: 0 | 1 | 'toggle' | null = null;
  private lastDragX: number | null = null;
  private lastDragY: number | null = null;
  private initialized = false;

  private tpDistance = DEFAULT_TP_DISTANCE;
  private sniperFovDeg = DEFAULT_SNIPER_FOV_DEG;
  private currentFovDeg = BASE_FOV_DEG;

  private trauma = 0;
  private shakeClock = 0;

  private readonly followPivot = new Vec3();
  public readonly commanderAimWorld = new Vec3(0, 0, 100);

  private readonly intent: TankIntent & { aimRayOrigin: Vec3 } = {
    throttle: 0,
    steer: 0,
    brake: false,
    aimPoint: new Vec3(0, 0, 100),
    aimRayOrigin: new Vec3(),
    fireCannon: false,
    fireMG: false,
  };

  // Scratch vectors to avoid per-frame allocations
  private readonly _lookDir = new Vec3();
  private readonly _anchor = new Vec3();
  private readonly _baseCamPos = new Vec3();
  private readonly _finalCamPos = new Vec3();
  private readonly _holdPos = new Vec3();
  private readonly _holdDir = new Vec3();
  private readonly _rayOrigin = new Vec3();
  private readonly _camOffsetDir = new Vec3();
  private readonly _camRight = new Vec3();
  private readonly _camUp = new Vec3();
  private readonly _lookTarget = new Vec3();
  private readonly _enemyCenter = new Vec3();

  // Bound DOM listeners for clean disposal
  private readonly _onKeyDown: (e: KeyboardEvent) => void;
  private readonly _onKeyUp: (e: KeyboardEvent) => void;
  private readonly _onMouseDown: (e: MouseEvent) => void;
  private readonly _onMouseUp: (e: MouseEvent) => void;
  private readonly _onMouseMove: (e: MouseEvent) => void;
  private readonly _onWheel: (e: WheelEvent) => void;
  private readonly _onContextMenu: (e: MouseEvent) => void;
  private readonly _onPointerLockChange: () => void;
  private readonly _onPointerLockError: () => void;
  private readonly _onWindowBlur: () => void;

  constructor(
    camera: Entity,
    canvas: HTMLElement,
    onCycleQualityOrOpts?: (() => void) | PlayerControllerOptions
  ) {
    this.camera = camera;
    this.canvas = canvas;
    if (typeof onCycleQualityOrOpts === 'function') {
      this.onCycleQuality = onCycleQualityOrOpts;
    } else if (onCycleQualityOrOpts?.onCycleQuality) {
      this.onCycleQuality = onCycleQualityOrOpts.onCycleQuality;
    }

    this._pointerLocked = document.pointerLockElement === this.canvas;

    this._onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!this.pointerLocked && e.code === 'Space' && tag === 'BUTTON') return;
      const alt = e.code === 'AltLeft' || e.code === 'AltRight';
      if (alt && !this.pointerLocked) return;

      if (
        alt ||
        e.code === 'Space' ||
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight'
      ) {
        e.preventDefault();
      }

      if (alt && !this.freeLooking) {
        this.orbitYaw = this.droneMode ? 0 : this._cameraYaw;
        this.orbitPitch = this.droneMode ? 0 : this._cameraPitch;
        this._edgeLmb = this._edgeRmb = false;
        this._droneDX = this._droneDY = 0;
      }
      this.keysDown.add(e.code);

      if (!e.repeat) {
        if (e.code === 'KeyV' || (!this.aircraftControls && (e.code === 'ShiftLeft' || e.code === 'ShiftRight'))) {
          if (!this.freeLooking) this._sniperZoom = !this._sniperZoom;
        } else if (e.code === 'Digit1') {
          this.pendingShellSlot = 0;
        } else if (e.code === 'Digit2') {
          this.pendingShellSlot = 1;
        } else if (e.code === 'KeyQ') {
          const slot = this.pendingShellSlot;
          this.pendingShellSlot = slot === null ? 'toggle' : slot === 'toggle' ? null : slot === 0 ? 1 : 0;
        } else if (e.code === 'Escape' || e.code === 'KeyP') {
          if (this._pointerLocked) {
            document.exitPointerLock?.();
          }
          this._engaged = false;
          this.clearHeldInput();
        }
      }
    };

    this._onKeyUp = (e: KeyboardEvent) => {
      this.keysDown.delete(e.code);
    };

    this._onMouseDown = (e: MouseEvent) => {
      const targetEl = e.target as HTMLElement | null;
      const clickedInteractiveUI = Boolean(targetEl?.closest('button, a'));

      if (!this._pointerLocked && !this._engaged) {
        if (targetEl === this.canvas) {
          this._engaged = true;
          this.requestLock();
        }
        return;
      }
      if (!this._pointerLocked && !clickedInteractiveUI) {
        this.requestLock();
      }
      this.lastDragX = e.clientX;
      this.lastDragY = e.clientY;
      if (this.freeLooking) return;
      if (e.button === 0 && !clickedInteractiveUI) {
        this.mouseLeftDown = true;
        this._edgeLmb = true;
      } else if (e.button === 2) {
        e.preventDefault();
        this.mouseRightDown = true;
        if (this.droneMode) {
          this._edgeRmb = true;
        } else {
          this.rmbZoomDownTime = performance.now();
          this._sniperZoom = !this._sniperZoom;
          this.rmbTurnedZoomOn = this._sniperZoom;
        }
      } else if (e.button === 1) {
        e.preventDefault();
        this._sniperZoom = !this._sniperZoom;
      }
    };

    this._onMouseUp = (e: MouseEvent) => {
      this.lastDragX = null;
      this.lastDragY = null;
      if (e.button === 0) {
        this.mouseLeftDown = false;
      } else if (e.button === 2) {
        this.mouseRightDown = false;
        // Hybrid hold/tap zoom: if held >= 230ms, releasing RMB exits zoom; quick tap keeps zoom toggled ON
        const heldMs = performance.now() - this.rmbZoomDownTime;
        if (this.rmbTurnedZoomOn && heldMs >= 230) {
          this._sniperZoom = false;
        }
        this.rmbTurnedZoomOn = false;
      }
    };

    this._onMouseMove = (e: MouseEvent) => {
      let dx = 0;
      let dy = 0;
      if (this._pointerLocked) {
        dx = e.movementX;
        dy = e.movementY;
      } else if (this._engaged) {
        dx = e.movementX || (this.lastDragX !== null ? e.clientX - this.lastDragX : 0);
        dy = e.movementY || (this.lastDragY !== null ? e.clientY - this.lastDragY : 0);
        this.lastDragX = e.clientX;
        this.lastDragY = e.clientY;
      } else {
        return;
      }

      if (this.freeLooking) {
        this.orbitYaw = wrapAnglePi(this.orbitYaw - dx * 0.007);
        this.orbitPitch = clamp(this.orbitPitch - dy * 0.005, -1.52, 1.52);
        return;
      }

      if (this.droneMode) {
        this._droneDX += dx;
        this._droneDY += dy;
        return;
      }

      // Scale mouse sensitivity naturally with active FOV so 2.8x sniper optic has crisp precision
      const baseSens = 0.0021;
      const fovScale = this._sniperZoom ? (this.sniperFovDeg / BASE_FOV_DEG) * 0.92 : 1.0;
      const sens = baseSens * fovScale;

      this._cameraYaw = wrapAnglePi(this._cameraYaw - dx * sens);

      const minPitch = this.aircraftControls ? -0.68 : this._sniperZoom ? -0.34 : -0.48;
      const maxPitch = this.aircraftControls ? 0.66 : this._sniperZoom ? 0.46 : 0.62;
      this._cameraPitch = clamp(
        this._cameraPitch - dy * sens,
        minPitch,
        maxPitch
      );
    };

    this._onWheel = (e: WheelEvent) => {
      if (!this._pointerLocked && e.target !== this.canvas) return;
      e.preventDefault();
      if (this.freeLooking || this.droneMode) return;
      const delta = Math.sign(e.deltaY);
      if (delta === 0) return;

      if (this._sniperZoom) {
        this.sniperFovDeg = clamp(this.sniperFovDeg * (delta > 0 ? 1.19 : 1 / 1.19), 4, 28);
      } else {
        this.tpDistance = clamp(
          this.tpDistance + delta * 0.9,
          MIN_TP_DISTANCE,
          MAX_TP_DISTANCE
        );
      }
    };

    this._onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    this._onPointerLockChange = () => {
      const wasLocked = this._pointerLocked;
      this._pointerLocked = document.pointerLockElement === this.canvas;
      if (this._pointerLocked) {
        this._pointerLockBlocked = false;
        this._engaged = true;
        document.body.style.cursor = 'none';
      } else {
        document.body.style.cursor = '';
        if (wasLocked) {
          this._engaged = false;
          this.clearHeldInput();
        }
      }
    };

    this._onPointerLockError = () => {
      this._pointerLockBlocked = true;
    };

    this._onWindowBlur = () => this.clearHeldInput();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('pointerlockerror', this._onPointerLockError);
    window.addEventListener('blur', this._onWindowBlur);
  }

  public get cameraYaw(): number {
    return this.freeLooking && !this.droneMode ? this.orbitYaw : this._cameraYaw;
  }

  public get cameraPitch(): number {
    return this.freeLooking && !this.droneMode ? this.orbitPitch : this._cameraPitch;
  }

  public get sniperZoom(): boolean {
    return this._sniperZoom && !this.freeLooking && !this.droneMode;
  }

  public get freeLooking(): boolean {
    return this.pointerLocked && (this.keysDown.has('AltLeft') || this.keysDown.has('AltRight'));
  }

  public get pointerLocked(): boolean {
    return this._pointerLocked || this._engaged;
  }

  public get hasTruePointerLock(): boolean {
    return this._pointerLocked;
  }

  public get pointerLockBlockedByHost(): boolean {
    return this._pointerLockBlocked;
  }

  public setEngaged(engaged: boolean): void {
    this._engaged = engaged;
  }

  private clearHeldInput(): void {
    this.keysDown.clear();
    this.mouseLeftDown = this.mouseRightDown = false;
    this._edgeLmb = this._edgeRmb = false;
    this._droneDX = this._droneDY = 0;
    this.pendingShellSlot = null;
    this.lastDragX = this.lastDragY = null;
  }

  public setViewAngles(yaw: number, pitch: number): void {
    this._cameraYaw = wrapAnglePi(yaw);
    this._cameraPitch = clamp(pitch, -0.55, 0.65);
  }

  public setSniperZoom(enabled: boolean): void {
    this._sniperZoom = enabled;
  }

  public requestLock(): void {
    if (document.pointerLockElement === this.canvas) return;
    try {
      this.canvas.focus?.();
      const maybePromise = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {
          this._pointerLockBlocked = true;
        });
      }
    } catch {
      this._pointerLockBlocked = true;
    }
  }

  public addShake(amount: number): void {
    if (amount > 0) {
      this.trauma = Math.min(1.25, this.trauma + amount);
    }
  }

  public update(
    dt: number,
    playerTank: TankEntity,
    world: TerrainQuery,
    allTanks: readonly TankEntity[],
    shakeTrauma: number
  ): TankIntent {
    const safeDt = Math.min(Math.max(dt, 0.0001), 0.08);
    this.aircraftControls = playerTank.stats.drive === 'air';
    this.frameLmb = this._edgeLmb;
    this.frameRmb = this._edgeRmb;
    this._edgeLmb = false;
    this._edgeRmb = false;

    // First-frame or post-respawn teleport snap
    if (!this.initialized) {
      this.initialized = true;
      this._cameraYaw = playerTank.hullYaw;
      this._cameraPitch = this.aircraftControls ? 0 : -0.05;
      this.followPivot.copy(playerTank.position);
    } else if (this.followPivot.distanceSq(playerTank.position) > 25 * 25) {
      this.followPivot.copy(playerTank.position);
      this._cameraYaw = playerTank.hullYaw;
    } else {
      const followAlpha = 1 - Math.exp(-14.5 * safeDt);
      this.followPivot.lerp(this.followPivot, playerTank.position, followAlpha);
    }

    if (!playerTank.alive) {
      this._sniperZoom = false;
    }

    // Compute un-shaken unit look vector from (cameraYaw, cameraPitch)
    const freeLook = this.freeLooking;
    const viewYaw = this.cameraYaw;
    const viewPitch = this.cameraPitch;
    const cosP = Math.cos(viewPitch);
    const sinP = Math.sin(viewPitch);
    const sinY = Math.sin(viewYaw);
    const cosY = Math.cos(viewYaw);
    this._lookDir.set(sinY * cosP, sinP, cosY * cosP).normalize();

    // Right-hand screen horizontal basis: rightXZ = (-cosY, 0, sinY)
    this._camRight.set(-cosY, 0, sinY);
    this._camUp.cross(this._camRight, this._lookDir).normalize();

    // Position camera in either Gunner 2.8x Sniper Optic or Third-Person Chase mode
    let targetFovDeg: number;
    if (this.sniperZoom && playerTank.alive) {
      // Gunner optic mounted just above/forward of turret roof so hull never occludes view
      this._baseCamPos.set(
        playerTank.position.x + sinY * 1.25,
        playerTank.position.y + 1.95 + sinP * 0.25,
        playerTank.position.z + cosY * 1.25
      );
      const minGroundY = world.getHeightAt(this._baseCamPos.x, this._baseCamPos.z) + 0.65;
      if (this._baseCamPos.y < minGroundY) {
        this._baseCamPos.y = minGroundY;
      }
      targetFovDeg = this.sniperFovDeg;
    } else {
      // Third-person orbital chase camera (~11.5m back, ~4.2m above hull base)
      this._anchor.set(
        this.followPivot.x,
        this.followPivot.y + 2.35,
        this.followPivot.z
      );

      const dist = freeLook ? Math.max(7, this.tpDistance) : this.tpDistance;
      this._baseCamPos.set(
        this._anchor.x - this._lookDir.x * dist,
        freeLook ? this._anchor.y - this._lookDir.y * dist : this._anchor.y + 1.85 - this._lookDir.y * dist * 0.78,
        this._anchor.z - this._lookDir.z * dist
      );

      // Pull camera forward if a tall building/cliff sits between anchor and chase camera
      this._camOffsetDir.sub2(this._baseCamPos, this._anchor);
      const offsetLen = this._camOffsetDir.length();
      if (offsetLen > 0.5) {
        this._camOffsetDir.mulScalar(1 / offsetLen);
        const camBlockHit = world.raycastWorld(this._anchor, this._camOffsetDir, offsetLen);
        if (
          camBlockHit &&
          (camBlockHit.hitKind === 'terrain' ||
            (camBlockHit.obstacle && !camBlockHit.obstacle.lightCover))
        ) {
          const safeDist = Math.max(freeLook ? 0.2 : 3.4, camBlockHit.distance - 0.55);
          this._baseCamPos.copy(this._anchor).addScaled(this._camOffsetDir, safeDist);
        }
      }

      // Hard clamp above terrain heightmap so camera NEVER clips underground
      const minTerrainY = world.getHeightAt(this._baseCamPos.x, this._baseCamPos.z) +
        (world.getWaterDepthAt?.(this._baseCamPos.x, this._baseCamPos.z) ?? 0) + 1.12;
      if (this._baseCamPos.y < minTerrainY) {
        this._baseCamPos.y = minTerrainY;
      }

      const speedBoostFov = clamp(Math.abs(playerTank.speed) * 0.26, 0, 4.2);
      targetFovDeg = BASE_FOV_DEG + speedBoostFov;
    }

    // Smoothly interpolate camera FOV
    const fovLerp = 1 - Math.exp(-16 * safeDt);
    this.currentFovDeg += (targetFovDeg - this.currentFovDeg) * fovLerp;
    if (!this.fpvCamPos && Math.abs(this.camera.camera!.fov - this.currentFovDeg) > 0.01) {
      this.camera.camera!.fov = this.currentFovDeg;
    }

    if (!freeLook && !this.droneMode) this.updateAim(playerTank, world, allTanks);

    // Apply trauma shake (from EffectsManager impulses + direct addShake)
    if (shakeTrauma > 0) {
      this.trauma = Math.min(1.25, this.trauma + shakeTrauma);
    }
    this.trauma = Math.max(0, this.trauma - safeDt * 2.35);
    this.shakeClock += safeDt * 38;

    this._finalCamPos.copy(this._baseCamPos);
    const shakeAmt = this.trauma * this.trauma * (this._sniperZoom ? 0.32 : 1.0);

    let shakePitch = 0;
    let shakeYaw = 0;
    let shakeRoll = 0;
    if (shakeAmt > 0.0001) {
      const s1 = Math.sin(this.shakeClock * 1.13) * 0.65 + Math.cos(this.shakeClock * 2.41) * 0.35;
      const s2 = Math.cos(this.shakeClock * 1.47) * 0.6 + Math.sin(this.shakeClock * 2.89) * 0.4;
      const s3 = Math.sin(this.shakeClock * 1.91);

      this._finalCamPos.addScaled(this._camRight, s1 * 0.26 * shakeAmt);
      this._finalCamPos.addScaled(this._camUp, s2 * 0.24 * shakeAmt);

      // Keep shaken camera safely above terrain too
      const shakenFloor = world.getHeightAt(this._finalCamPos.x, this._finalCamPos.z) + 0.65;
      if (this._finalCamPos.y < shakenFloor) {
        this._finalCamPos.y = shakenFloor;
      }

      shakeYaw = s1 * 0.014 * shakeAmt;
      shakePitch = s2 * 0.016 * shakeAmt;
      shakeRoll = s3 * 0.020 * shakeAmt;
    }

    if (this.fpvCamPos && this.fpvCamQuat) {
      this.camera.setPosition(this.fpvCamPos);
      this.fpvCombinedRotation.copy(this.fpvCamQuat);
      if (freeLook) {
        // Orbit the view relative to the FPV nose without feeding the pilot any mouse delta.
        quatFromEuler(this.fpvLookRotation, this.orbitPitch, this.orbitYaw, 0, 'YXZ');
        this.fpvCombinedRotation.mul(this.fpvLookRotation);
      }
      this.camera.setRotation(this.fpvCombinedRotation);
      if (Math.abs(this.camera.camera!.fov - 95) > 0.01) this.camera.camera!.fov = 95;
    } else {
      this.camera.setPosition(this._finalCamPos);
      if (freeLook) {
        this.camera.lookAt(this._anchor);
      } else {
        const effYaw = viewYaw + shakeYaw;
        const effPitch = clamp(viewPitch + shakePitch, -1.35, 1.35);
        const effCosP = Math.cos(effPitch);
        this._lookTarget.set(
          this._finalCamPos.x + Math.sin(effYaw) * effCosP * 60,
          this._finalCamPos.y + Math.sin(effPitch) * 60,
          this._finalCamPos.z + Math.cos(effYaw) * effCosP * 60
        );
        this.camera.lookAt(this._lookTarget);
      }
      if (shakeRoll !== 0) this.camera.rotateLocal(0, 0, radToDeg(shakeRoll));
    }

    // Build player TankIntent
    if (!playerTank.alive) {
      this.intent.throttle = 0;
      this.intent.steer = 0;
      this.intent.brake = true;
      this.intent.aimPoint.copy(this.commanderAimWorld);
      this.intent.fireCannon = false;
      this.intent.fireMG = false;
      this.intent.selectShell = null;
      return this.intent;
    }

    if (this.droneMode) {
      // Vehicle brakes to a stop and holds its turret while the drone flies.
      this.intent.throttle = 0;
      this.intent.steer = 0;
      this.intent.brake = true;
      this.intent.fireCannon = false;
      this.intent.fireMG = false;
      this.intent.selectShell = null;
      // hold turret: aim at a point along the current muzzle line
      playerTank.getMuzzleWorld(this._holdPos, this._holdDir);
      this.intent.aimPoint.copy(this._holdPos).addScaled(this._holdDir, 80);
      return this.intent;
    }

    const fwd = this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp') ? 1 : 0;
    const rev = this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown') ? 1 : 0;
    // KeyA / ArrowLeft -> +1 (+hullYaw CCW = turns toward screen LEFT)
    // KeyD / ArrowRight -> -1 (-hullYaw CW = turns toward screen RIGHT)
    const left = this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft') ? 1 : 0;
    const right = this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight') ? 1 : 0;

    this.intent.throttle = fwd - rev;
    this.intent.steer = left - right;
    this.intent.brake = this.keysDown.has('KeyX');
    this.intent.flightYaw = this.aircraftControls ? this._cameraYaw : undefined;
    this.intent.flightPitch = this.aircraftControls ? -this._cameraPitch : undefined;
    this.intent.lift = this.aircraftControls
      ? Number(this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight')) -
        Number(this.keysDown.has('ControlLeft') || this.keysDown.has('ControlRight'))
      : undefined;
    this.intent.aimPoint.copy(this.commanderAimWorld);
    // Handle [1], [2], or [Q] shell / belt slot toggle
    if (this.pendingShellSlot !== null) {
      if (this.pendingShellSlot === 'toggle') {
        this.intent.selectShell = playerTank.selectedShellIndex === 0 ? 1 : 0;
      } else {
        this.intent.selectShell = this.pendingShellSlot;
      }
      this.pendingShellSlot = null;
    } else {
      this.intent.selectShell = null;
    }

    const activeControl = this.pointerLocked && !freeLook;
    this.intent.fireCannon =
      activeControl && (this.mouseLeftDown || this.frameLmb || this.keysDown.has('KeyF'));
    this.intent.fireMG =
      activeControl && (this.keysDown.has('Space') || this.keysDown.has('KeyC'));

    return this.intent;
  }

  private updateAim(playerTank: TankEntity, world: TerrainQuery, allTanks: readonly TankEntity[]): void {
    // Start in front of the hull in chase view, but keep the sight origin for the seeker.
    this.intent.aimRayOrigin.copy(this._baseCamPos);
    let startAdvance = 0;
    if (!this.sniperZoom) {
      const toTankX = playerTank.position.x - this._baseCamPos.x;
      const toTankY = playerTank.position.y + 1.6 - this._baseCamPos.y;
      const toTankZ = playerTank.position.z - this._baseCamPos.z;
      const proj =
        toTankX * this._lookDir.x + toTankY * this._lookDir.y + toTankZ * this._lookDir.z;
      startAdvance = Math.max(0, proj + 1.2);
    }

    this._rayOrigin.copy(this._baseCamPos).addScaled(this._lookDir, startAdvance);

    let bestAimDist = MAX_AIM_RAY_DIST;
    const worldAimHit = world.raycastWorld(this._rayOrigin, this._lookDir, MAX_AIM_RAY_DIST);
    if (worldAimHit && worldAimHit.distance < bestAimDist) {
      bestAimDist = worldAimHit.distance;
    }

    // Also intersect enemy tank bounding spheres so aiming directly at a hull/turret locks cleanly
    for (let i = 0; i < allTanks.length; i++) {
      const t = allTanks[i];
      if (t === playerTank || !t.alive) continue;
      t.getCenterMassWorld(this._enemyCenter);
      const ocX = this._rayOrigin.x - this._enemyCenter.x;
      const ocY = this._rayOrigin.y - this._enemyCenter.y;
      const ocZ = this._rayOrigin.z - this._enemyCenter.z;
      const r = t.stats.hitRadius;
      const b = ocX * this._lookDir.x + ocY * this._lookDir.y + ocZ * this._lookDir.z;
      const c = ocX * ocX + ocY * ocY + ocZ * ocZ - r * r;
      if (b < 0) {
        const disc = b * b - c;
        if (disc >= 0) {
          const hitD = -b - Math.sqrt(disc);
          if (hitD >= 0 && hitD < bestAimDist) {
            bestAimDist = hitD;
          }
        }
      }
    }

    this.commanderAimWorld.copy(this._rayOrigin).addScaled(this._lookDir, bestAimDist);
  }

  /** Consume accumulated mouse pixel deltas for drone control. */
  public takeDroneDelta(): { dx: number; dy: number } {
    const out = { dx: this._droneDX, dy: this._droneDY };
    this._droneDX = 0;
    this._droneDY = 0;
    return out;
  }

  /** Edge-triggered drone buttons (LMB launch / RMB abort) — per-frame
   *  latched edges so instant clicks register. */
  public takeDroneEdges(): { lmb: boolean; rmb: boolean } {
    const edges = { lmb: this.frameLmb, rmb: this.frameRmb };
    this.frameLmb = this.frameRmb = false;
    return edges;
  }

  // ---- chase-camera state save/restore across FPV ----
  private _savedCamYaw = 0;
  private _savedCamPitch = 0;
  private _savedSniper = false;
  private _savedTpDist = 0;
  public saveChaseState(): void {
    this._savedCamYaw = this._cameraYaw;
    this._savedCamPitch = this._cameraPitch;
    this._dbgCamWrite = `save (${this._cameraYaw.toFixed(3)},${this._cameraPitch.toFixed(3)})`;
    this._savedSniper = this._sniperZoom;
    this._savedTpDist = this.tpDistance;
  }
  public _dbgCamWrite = '';
  public restoreChaseState(): void {
    this._cameraYaw = this._savedCamYaw;
    this._cameraPitch = this._savedCamPitch;
    this.orbitYaw = this._cameraYaw;
    this.orbitPitch = this._cameraPitch;
    this._dbgCamWrite = `restore saved=(${this._savedCamYaw.toFixed(3)},${this._savedCamPitch.toFixed(3)})`;
    this._sniperZoom = this._savedSniper;
    this.tpDistance = this._savedTpDist;
  }

  public dispose(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.removeEventListener('pointerlockerror', this._onPointerLockError);
    window.removeEventListener('blur', this._onWindowBlur);
  }
}
