import './hud.css';
import { TANK_STATS } from './Tank';
import type {
  HUDTelemetry,
  MinimapObstacle,
  MinimapUnit,
  ObstacleKind,
  VehicleClass,
} from './types';

export interface HUDCallbacks {
  onEngageClick: () => void;
  onSelectVehicleClass?: (cls: VehicleClass) => void;
}

interface FeedSlot {
  row: HTMLDivElement;
  tag: HTMLSpanElement;
  body: HTMLSpanElement;
  text: HTMLSpanElement;
  parts: HTMLSpanElement;
  actor: HTMLSpanElement;
  verb: HTMLSpanElement;
  target: HTMLSpanElement;
  lastId: number;
  lastAccent: 'kill' | 'death' | 'info' | '';
  active: boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const TWO_PI = Math.PI * 2;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

const BORE_RING_RADIUS = 25;
const BORE_RING_CIRCUMFERENCE = TWO_PI * BORE_RING_RADIUS;

const HP_SEGMENT_COUNT = 16;
const FEED_POOL_SIZE = 6;

const BRIEFING_VEHICLES: readonly { id: VehicleClass; name: string; armament: string }[] = [
  { id: 'normal', name: 'Main battle tank', armament: 'APFSDS, HE' },
  { id: 'heavy', name: 'Heavy tank', armament: 'APCBC, HE' },
  { id: 'ifv', name: 'IFV', armament: 'APDS-T, HEI-T' },
  { id: 'humvee', name: 'Humvee', armament: 'M2 .50 cal' },
  { id: 'rocket', name: 'Rocket artillery', armament: '6-rocket salvo' },
];

const BRIEFING_CONTROLS: readonly { keys: readonly string[]; action: string }[] = [
  { keys: ['W', 'A', 'S', 'D'], action: 'Drive' },
  { keys: ['Mouse'], action: 'Aim' },
  { keys: ['Left click'], action: 'Fire main gun' },
  { keys: ['Right click'], action: 'Zoom' },
  { keys: ['1', '2', 'Q'], action: 'Switch shell' },
  { keys: ['Space'], action: 'Machine gun' },
  { keys: ['Esc'], action: 'Pause' },
];

const RADAR_CSS_SIZE = 196;
const RADAR_RANGE_METERS = 220;
const RADAR_SCOPE_RADIUS = 84;

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return v < min ? min : v > max ? max : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Wraps radians into [-PI, +PI] */
function wrapPi(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  let a = (rad + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

export class HUD {
  private readonly container: HTMLElement;
  private readonly callbacks: HUDCallbacks;
  private readonly root: HTMLDivElement;

  // State tracking for zero-churn DOM updates
  private loadingEverCalled = false;
  private briefingVisible = true;
  private elapsedSec = 0;
  private maxObservedRespawn = 3.0;

  // Cached last strings/classes to avoid redundant layout/style writes
  private lastBoreRangeStr = '';
  private lastBoreState: 'ready' | 'locked' | 'reloading' = 'ready';
  private lastSniperActive = false;
  private lastLrfStr = '';
  private lastLrfSubStr = '';
  private lastHpStr = '';
  private lastSpeedStr = '';
  private lastCannonStr = '';
  private lastCannonReady = true;
  private lastCannonBadge: 'ready' | 'reload' | 'neutral' = 'neutral';
  private lastMgStr = '';
  private lastMgOverheat = false;
  private lastRespawnVisible = false;
  private lastVehicleDmgState: 'ok' | 'warn' | 'crit' | 'dead' = 'ok';

  // Fullscreen vignette & sniper optic refs
  private readonly damageVignetteEl: HTMLDivElement;
  private readonly sniperOverlayEl: HTMLDivElement;
  private readonly sniperDropPipEl: SVGGElement;
  private readonly sniperLrfValEl: HTMLSpanElement;
  private readonly sniperLrfSubEl: HTMLSpanElement;

  // Dual-reticle, hit marker & incoming damage arc refs
  private readonly commanderAimEl: HTMLDivElement;
  private readonly gunnerBoreEl: HTMLDivElement;
  private readonly boreReloadCircleEl: SVGCircleElement;
  private readonly boreRangeTextEl: HTMLSpanElement;
  private readonly hitMarkerEl: HTMLDivElement;
  private readonly killBannerEl: HTMLDivElement;
  private readonly damageArcEl: HTMLDivElement;

  // Bottom-left paper-doll & vehicle systems refs
  private readonly vehiclePanelEl: HTMLDivElement;
  private readonly pdHullGroupEl: SVGGElement;
  private readonly pdTurretGroupEl: SVGGElement;
  private readonly hpReadoutEl: HTMLSpanElement;
  private readonly hpSegEls: HTMLDivElement[] = [];
  private readonly speedNumEl: HTMLSpanElement;
  private readonly cannonStatusEl: HTMLSpanElement;
  private readonly cannonBarFillEl: HTMLDivElement;
  private readonly mgStatusEl: HTMLSpanElement;
  private readonly mgBarFillEl: HTMLDivElement;
  private readonly shellPillEls: HTMLSpanElement[];
  private readonly shellCodeEls: HTMLSpanElement[];

  // Bottom-right 2D cartographic radar refs
  private readonly radarCanvas: HTMLCanvasElement;
  private readonly radarCtx: CanvasRenderingContext2D;
  private radarDpr = 0;

  // Event feed, scoreboard & respawn banner refs
  private readonly feedSlots: FeedSlot[] = [];
  private readonly scoreboardEl: HTMLDivElement;
  private readonly scoreBlueEl: HTMLSpanElement;
  private readonly scoreRedEl: HTMLSpanElement;
  private lastScoreBlue = -1;
  private lastScoreRed = -1;
  private readonly respawnBannerEl: HTMLDivElement;
  private readonly respawnSecEl: HTMLSpanElement;
  private readonly respawnBarFillEl: HTMLDivElement;

  // Briefing / loading screen refs
  private readonly briefingBackdropEl: HTMLDivElement;
  private readonly loaderFillEl: HTMLSpanElement;
  private readonly engageBtnEl: HTMLButtonElement;
  private readonly engageMainTextEl: HTMLSpanElement;
  private readonly engageSubTextEl: HTMLSpanElement;

  // Bound event listeners for clean disposal
  private readonly handleEngageClick: () => void;
  private readonly handleResize: () => void;

  constructor(container: HTMLElement, callbacks: HUDCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.root = document.createElement('div');
    this.root.className = 'fcs-root';

    // 1. Low-HP / Damage Vignette
    this.damageVignetteEl = document.createElement('div');
    this.damageVignetteEl.className = 'fcs-damage-vignette';
    this.root.appendChild(this.damageVignetteEl);

    // 2. Gunner 2.8x Sniper Optic Layer
    const sniper = this.buildSniperOpticLayer();
    this.sniperOverlayEl = sniper.overlay;
    this.sniperDropPipEl = sniper.dropPip;
    this.sniperLrfValEl = sniper.lrfVal;
    this.sniperLrfSubEl = sniper.lrfSub;
    this.root.appendChild(this.sniperOverlayEl);

    // 3. Center Reticles, Hit Marker, Kill Micro-Banner & Directional Damage Arc
    const reticles = this.buildReticleLayer();
    this.commanderAimEl = reticles.commanderAim;
    this.gunnerBoreEl = reticles.gunnerBore;
    this.boreReloadCircleEl = reticles.boreReloadCircle;
    this.boreRangeTextEl = reticles.boreRangeText;
    this.hitMarkerEl = reticles.hitMarker;
    this.killBannerEl = reticles.killBanner;
    this.damageArcEl = reticles.damageArc;
    this.root.appendChild(reticles.layer);

    // 6. Bottom-Left Live Paper-Doll & Vehicle Propulsion/Ordnance Panel
    const vehicle = this.buildVehiclePanel();
    this.vehiclePanelEl = vehicle.panel;
    this.pdHullGroupEl = vehicle.hullGroup;
    this.pdTurretGroupEl = vehicle.turretGroup;
    this.hpReadoutEl = vehicle.hpReadout;
    this.speedNumEl = vehicle.speedNum;
    this.cannonStatusEl = vehicle.cannonStatus;
    this.cannonBarFillEl = vehicle.cannonBarFill;
    this.mgStatusEl = vehicle.mgStatus;
    this.mgBarFillEl = vehicle.mgBarFill;
    this.shellPillEls = vehicle.pillEls;
    this.shellCodeEls = vehicle.pillCodes;
    this.root.appendChild(this.vehiclePanelEl);

    // 7. Bottom-Right 2D Cartographic Radar
    const radar = this.buildRadarPanel();
    this.radarCanvas = radar.canvas;
    this.radarCtx = radar.ctx;
    this.root.appendChild(radar.panel);

    this.root.appendChild(this.buildEventFeed());

    // Top-center team scoreboard
    this.scoreboardEl = document.createElement('div');
    this.scoreboardEl.className = 'fcs-scoreboard';
    const scoreBlueLbl = document.createElement('span');
    scoreBlueLbl.className = 'fcs-score-label fcs-score-blue';
    scoreBlueLbl.textContent = 'Blue';
    this.scoreBlueEl = document.createElement('span');
    this.scoreBlueEl.className = 'fcs-score-num';
    const scoreSep = document.createElement('span');
    scoreSep.className = 'fcs-score-sep';
    scoreSep.textContent = '–';
    this.scoreRedEl = document.createElement('span');
    this.scoreRedEl.className = 'fcs-score-num';
    const scoreRedLbl = document.createElement('span');
    scoreRedLbl.className = 'fcs-score-label fcs-score-red';
    scoreRedLbl.textContent = 'Red';
    this.scoreboardEl.append(scoreBlueLbl, this.scoreBlueEl, scoreSep, this.scoreRedEl, scoreRedLbl);
    this.root.appendChild(this.scoreboardEl);

    // 9. Respawn Countdown Banner
    const respawn = this.buildRespawnBanner();
    this.respawnBannerEl = respawn.banner;
    this.respawnSecEl = respawn.sec;
    this.respawnBarFillEl = respawn.barFill;
    this.root.appendChild(this.respawnBannerEl);

    // 10. Briefing / Asset Loading / Pause Overlay
    const briefing = this.buildBriefingOverlay();
    this.briefingBackdropEl = briefing.backdrop;
    this.loaderFillEl = briefing.loaderFill;
    this.engageBtnEl = briefing.engageBtn;
    this.engageMainTextEl = briefing.engageMainText;
    this.engageSubTextEl = briefing.engageSubText;
    this.root.appendChild(this.briefingBackdropEl);

    // Bind interactive callbacks
    this.handleEngageClick = () => {
      if (this.engageBtnEl.disabled) return;
      this.callbacks.onEngageClick();
    };
    this.handleResize = () => {
      this.syncCanvasHiDPI();
    };

    this.engageBtnEl.addEventListener('click', this.handleEngageClick);
    window.addEventListener('resize', this.handleResize);

    this.container.appendChild(this.root);

    this.syncCanvasHiDPI();
    this.setBriefingVisible(true);
  }

  public setLoadingProgress(progress01: number, statusText: string): void {
    this.loadingEverCalled = true;
    const p = clamp01(progress01);
    const pct = Math.round(p * 100);

    this.loaderFillEl.style.width = `${(p * 100).toFixed(1)}%`;
    const loaderBar = this.loaderFillEl.parentElement;
    if (p >= 0.999) {
      this.engageBtnEl.disabled = false;
      this.engageMainTextEl.textContent = 'Play';
      this.engageSubTextEl.textContent = '';
      if (loaderBar) loaderBar.style.display = 'none';
    } else {
      this.engageBtnEl.disabled = true;
      this.engageMainTextEl.textContent = `Loading ${pct}%`;
      this.engageSubTextEl.textContent = statusText || 'Loading assets...';
      if (loaderBar) loaderBar.style.display = '';
    }
  }

  public setBriefingVisible(visible: boolean): void {
    this.briefingVisible = visible;
    this.briefingBackdropEl.classList.toggle('is-visible', visible);
    this.container.classList.toggle('is-briefing', visible);
  }

  private radarAccum = 0;

  public update(telemetry: HUDTelemetry, dt: number): void {
    if (!this.loadingEverCalled) {
      this.setLoadingProgress(1, 'Ready');
    }

    const safeDt = clamp(dt, 0, 0.25);
    this.elapsedSec += safeDt;

    this.updateReticlesAndOptics(telemetry);
    this.updateDamageEffects(telemetry);
    this.updateVehiclePanel(telemetry);

    // Throttle 2D minimap canvas redraw to ~30 Hz to save CPU
    this.radarAccum += safeDt;
    if (this.radarAccum >= 0.032) {
      this.radarAccum = 0;
      this.drawCartographicRadar(telemetry);
    }

    this.updateRespawnBanner(telemetry);
    this.updateEventFeed(telemetry);
    this.updateScoreboard(telemetry);
  }

  private updateScoreboard(t: HUDTelemetry): void {
    if (t.score.blue === this.lastScoreBlue && t.score.red === this.lastScoreRed) return;
    this.lastScoreBlue = t.score.blue;
    this.lastScoreRed = t.score.red;
    this.scoreBlueEl.textContent = String(t.score.blue);
    this.scoreRedEl.textContent = String(t.score.red);
  }

  public dispose(): void {
    this.engageBtnEl.removeEventListener('click', this.handleEngageClick);
    window.removeEventListener('resize', this.handleResize);
    if (this.root.parentNode === this.container) {
      this.container.removeChild(this.root);
    }
  }

  // =========================================================================
  // RUNTIME SUBSYSTEM UPDATES (ZERO INNERHTML CHURN)
  // =========================================================================

  private syncCanvasHiDPI(): void {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    if (Math.abs(dpr - this.radarDpr) > 0.01) {
      this.radarDpr = dpr;
      this.radarCanvas.width = Math.round(RADAR_CSS_SIZE * dpr);
      this.radarCanvas.height = Math.round(RADAR_CSS_SIZE * dpr);
    }
  }

  private updateReticlesAndOptics(t: HUDTelemetry): void {
    const showHudReticles = t.alive && !this.briefingVisible;

    // 1. Commander Aim Circle (38px diameter)
    if (showHudReticles && t.commanderAim.visible) {
      const cx = t.commanderAim.x;
      const cy = t.commanderAim.y;
      const dx = t.gunnerBore.x - cx;
      const dy = t.gunnerBore.y - cy;
      const sep = Math.hypot(dx, dy);
      const aimOpacity = sep < 4 && t.gunnerBore.onTarget ? 0.62 : 0.92;
      this.commanderAimEl.style.opacity = aimOpacity.toFixed(2);
      this.commanderAimEl.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0)`;
    } else {
      this.commanderAimEl.style.opacity = '0';
    }

    // 2. Gunner Bore Ballistic Crosshair + Radial Reload SVG Ring
    const reloadP = clamp01(t.cannonReloadProgress);
    const isReady = reloadP >= 0.999;

    if (showHudReticles && t.gunnerBore.visible) {
      const bx = t.gunnerBore.x;
      const by = t.gunnerBore.y;
      this.gunnerBoreEl.style.opacity = '1';
      this.gunnerBoreEl.style.transform = `translate3d(${bx.toFixed(1)}px, ${by.toFixed(1)}px, 0)`;

      const dashOffset = BORE_RING_CIRCUMFERENCE * (1 - reloadP);
      this.boreReloadCircleEl.style.strokeDashoffset = dashOffset.toFixed(2);

      const boreState: 'ready' | 'locked' | 'reloading' = !isReady
        ? 'reloading'
        : t.gunnerBore.onTarget
          ? 'locked'
          : 'ready';

      if (boreState !== this.lastBoreState) {
        this.lastBoreState = boreState;
        this.gunnerBoreEl.classList.toggle('is-reloading', boreState === 'reloading');
        this.gunnerBoreEl.classList.toggle('is-locked', boreState === 'locked');
      }

      const rangeClamped = clamp(t.gunnerBore.rangeMeters, 0, 9999);
      const rangeStr = `${Math.round(rangeClamped)} m`;
      if (rangeStr !== this.lastBoreRangeStr) {
        this.lastBoreRangeStr = rangeStr;
        this.boreRangeTextEl.textContent = rangeStr;
      }
    } else {
      this.gunnerBoreEl.style.opacity = '0';
    }

    // 3. Gunner 2.8x Sniper Optic Mode
    const sniperActive = Boolean(t.sniperZoom && t.alive && !this.briefingVisible);
    if (sniperActive !== this.lastSniperActive) {
      this.lastSniperActive = sniperActive;
      this.sniperOverlayEl.classList.toggle('is-active', sniperActive);
    }

    if (sniperActive) {
      const rng = clamp(t.gunnerBore.rangeMeters, 0, 9999);
      const lrfStr = `${Math.round(rng)} m`;
      if (lrfStr !== this.lastLrfStr) {
        this.lastLrfStr = lrfStr;
        this.sniperLrfValEl.textContent = lrfStr;
      }

      const muzzleV = Math.max(50, Math.round(t.shellSpeedMs || 260));
      const activeShellCode = t.activeShellIndex === 0 ? t.shell0Code : t.shell1Code;
      const lrfSub = `${activeShellCode} · ${isReady ? 'Ready' : `Reloading ${Math.max(0, t.cannonCooldownSec).toFixed(1)} s`}`;
      if (lrfSub !== this.lastLrfSubStr) {
        this.lastLrfSubStr = lrfSub;
        this.sniperLrfSubEl.textContent = lrfSub;
      }

      // Dynamic ballistic drop pip on the etched vertical mil ladder
      // Gravity drop angle approx: theta ~= 0.5 * g * d / v^2 (radians), 1 mil ~= 0.001 rad
      const dropMils = clamp((0.5 * 9.81 * rng * 1000) / (muzzleV * muzzleV), 0, 22);
      const ladderY = clamp(260 + dropMils * 7.5, 278, 434);
      this.sniperDropPipEl.setAttribute('transform', `translate(0 ${ladderY.toFixed(1)})`);
    }

    // 4. Hit / Destroyed Confirmation Marker at Gunner Bore
    const hmIntensity = clamp01(t.hitMarker.intensity);
    if (hmIntensity > 0.01 && t.hitMarker.kind !== 'none' && !this.briefingVisible) {
      const bx = t.gunnerBore.visible ? t.gunnerBore.x : window.innerWidth * 0.5;
      const by = t.gunnerBore.visible ? t.gunnerBore.y : window.innerHeight * 0.5;
      const isKill = t.hitMarker.kind === 'kill';
      const scale = isKill ? 1 + 0.34 * hmIntensity : 1 + 0.18 * hmIntensity;

      this.hitMarkerEl.classList.toggle('is-kill', isKill);
      this.hitMarkerEl.style.opacity = clamp01(hmIntensity * 1.25).toFixed(2);
      this.hitMarkerEl.style.transform = `translate3d(${bx.toFixed(1)}px, ${by.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;

      if (isKill) {
        const bannerOpacity = clamp01(hmIntensity * 1.35);
        this.killBannerEl.style.opacity = bannerOpacity.toFixed(2);
        this.killBannerEl.style.transform = `translate3d(-50%, ${((1 - bannerOpacity) * 6).toFixed(1)}px, 0)`;
      } else {
        this.killBannerEl.style.opacity = '0';
      }
    } else {
      this.hitMarkerEl.style.opacity = '0';
      this.killBannerEl.style.opacity = '0';
    }
  }

  private updateDamageEffects(t: HUDTelemetry): void {
    // 1. Incoming Hit Directional Arc
    // Screen CW angle from 12-o'clock UP toward attacker azimuth `fromWorldYaw`:
    //   forwardComp = cos(fromWorldYaw - camYaw)
    //   rightComp   = -sin(fromWorldYaw - camYaw)
    //   atan2(rightComp, forwardComp) = wrapPi(camYaw - fromWorldYaw)
    const arcIntensity = clamp01(t.incomingDamageArc.intensity);
    if (arcIntensity > 0.01 && t.alive && !this.briefingVisible) {
      const relAngleRad = wrapPi(t.cameraYaw - t.incomingDamageArc.fromWorldYaw);
      this.damageArcEl.style.opacity = arcIntensity.toFixed(2);
      this.damageArcEl.style.transform = `rotate(${(relAngleRad * RAD_TO_DEG).toFixed(1)}deg)`;
    } else {
      this.damageArcEl.style.opacity = '0';
    }

    // 2. Low-HP (<35%) Hull Breach Vignette + Incoming Hit Flash
    const hpRatio = t.alive ? clamp01(t.hp / Math.max(1, t.maxHp)) : 0;
    let vignetteAlpha = 0;
    if (!t.alive) {
      vignetteAlpha = 0.55;
    } else if (hpRatio < 0.35) {
      const severity = (0.35 - hpRatio) / 0.35;
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsedSec * 7.2);
      vignetteAlpha = clamp01(0.24 + severity * 0.46 + pulse * 0.16 * severity);
    }
    if (t.alive && arcIntensity > 0.1) {
      vignetteAlpha = Math.max(vignetteAlpha, arcIntensity * 0.34);
    }
    this.damageVignetteEl.style.opacity = vignetteAlpha.toFixed(2);
  }

  private updateVehiclePanel(t: HUDTelemetry): void {
    // 1. Live SVG Tank Paper-Doll Rotations
    // Screen CW rotation for world yaw relative to cameraYaw is `cameraYaw - worldYaw`
    const hullScreenDeg = wrapPi(t.cameraYaw - t.hullYaw) * RAD_TO_DEG;
    const turretScreenDeg = wrapPi(t.cameraYaw - t.turretWorldYaw) * RAD_TO_DEG;

    this.pdHullGroupEl.setAttribute('transform', `rotate(${hullScreenDeg.toFixed(2)} 48 48)`);
    this.pdTurretGroupEl.setAttribute('transform', `rotate(${turretScreenDeg.toFixed(2)} 48 48)`);

    // 2. Segmented Hull Armor HP Bar
    const maxHp = Math.max(1, Math.round(t.maxHp));
    const curHp = t.alive ? clamp(Math.ceil(t.hp), 0, maxHp) : 0;
    const hpRatio = curHp / maxHp;

    const dmgState: 'ok' | 'warn' | 'crit' | 'dead' = !t.alive
      ? 'dead'
      : hpRatio < 0.35
        ? 'crit'
        : hpRatio < 0.65
          ? 'warn'
          : 'ok';

    if (dmgState !== this.lastVehicleDmgState) {
      this.lastVehicleDmgState = dmgState;
      this.vehiclePanelEl.classList.toggle('is-warn', dmgState === 'warn');
      this.vehiclePanelEl.classList.toggle('is-crit', dmgState === 'crit');
      this.vehiclePanelEl.classList.toggle('is-dead', dmgState === 'dead');
    }

    const hpStr = `${curHp} / ${maxHp}`;
    if (hpStr !== this.lastHpStr) {
      this.lastHpStr = hpStr;
      this.hpReadoutEl.textContent = hpStr;
      this.hpReadoutEl.style.color =
        dmgState === 'crit' || dmgState === 'dead'
          ? 'var(--fcs-danger)'
          : dmgState === 'warn'
            ? 'var(--fcs-text-2)'
            : 'var(--fcs-text)';
    }

    const activeColor =
      dmgState === 'crit' || dmgState === 'dead'
        ? 'var(--fcs-danger)'
        : 'var(--fcs-text-2)';

    const exactFilled = hpRatio * HP_SEGMENT_COUNT;
    for (let i = 0; i < HP_SEGMENT_COUNT; i++) {
      const seg = this.hpSegEls[i];
      const cellFill = clamp01(exactFilled - i);
      if (cellFill <= 0.02) {
        seg.style.backgroundColor = 'var(--fcs-hairline)';
        seg.style.opacity = '1';
      } else {
        seg.style.backgroundColor = activeColor;
        seg.style.opacity = (0.35 + 0.65 * cellFill).toFixed(2);
      }
    }

    // 3. Speedometer
    const absSpeed = Math.abs(Math.round(Number.isFinite(t.speedKmh) ? t.speedKmh : 0));
    const speedStr = `${absSpeed}`;
    if (speedStr !== this.lastSpeedStr) {
      this.lastSpeedStr = speedStr;
      this.speedNumEl.textContent = speedStr;
    }

    // 4. Primary Weapon / Cannon Reload & Shell Selector
    this.shellCodeEls[0].textContent = t.shell0Code;
    this.shellCodeEls[1].textContent = t.shell1Code;
    this.shellPillEls[0].classList.toggle('is-active-shell', t.activeShellIndex === 0);
    this.shellPillEls[1].classList.toggle('is-active-shell', t.activeShellIndex === 1);

    const cannonTitleEl = this.cannonStatusEl.previousElementSibling as HTMLElement | null;
    if (cannonTitleEl) {
      cannonTitleEl.textContent = t.vehicleClass === 'rocket' ? 'Rocket pod' : 'Main gun';
    }

    const cannonP = t.hasMainCannon ? clamp01(t.cannonReloadProgress) : 1;
    const cannonReady = cannonP >= 0.999;
    this.cannonBarFillEl.style.width = `${(cannonP * 100).toFixed(1)}%`;

    if (cannonReady !== this.lastCannonReady) {
      this.lastCannonReady = cannonReady;
      this.cannonBarFillEl.classList.toggle('is-ready', cannonReady);
      this.cannonBarFillEl.classList.toggle('is-reloading', !cannonReady);
      this.vehiclePanelEl.classList.toggle('is-reloading', !cannonReady);
    }

    let cannonBadge: 'ready' | 'reload' | 'neutral' = 'neutral';
    let cannonStr: string;
    if (t.vehicleClass === 'rocket') {
      if (t.rocketsLeft > 0) {
        cannonStr = `Rockets ${t.rocketsLeft} / ${t.salvoSize ?? 6}`;
        cannonBadge = 'ready';
      } else if (cannonReady) {
        cannonStr = 'Pod empty';
      } else {
        cannonStr = `Reloading ${Math.max(0, t.cannonCooldownSec).toFixed(1)} s`;
        cannonBadge = 'reload';
      }
    } else if (!t.hasMainCannon) {
      cannonStr = 'Infinite ammo';
    } else if (cannonReady) {
      cannonStr = 'Ready';
      cannonBadge = 'ready';
    } else {
      cannonStr = `Reloading ${Math.max(0, t.cannonCooldownSec).toFixed(1)} s`;
      cannonBadge = 'reload';
    }
    if (cannonBadge !== this.lastCannonBadge) {
      this.lastCannonBadge = cannonBadge;
      this.cannonStatusEl.classList.toggle('fcs-badge-ready', cannonBadge === 'ready');
      this.cannonStatusEl.classList.toggle('fcs-badge-reload', cannonBadge === 'reload');
      this.cannonStatusEl.classList.toggle('fcs-badge-neutral', cannonBadge === 'neutral');
    }
    if (cannonStr !== this.lastCannonStr) {
      this.lastCannonStr = cannonStr;
      this.cannonStatusEl.textContent = cannonStr;
    }

    // 5. Coaxial MG Thermal Gauge (hidden on IFV where main weapon IS the
    // infinite-ammo MG, and on the rocket launcher which has no coax at all)
    const mgBlockEl = this.mgStatusEl.closest('.fcs-bar-block') as HTMLElement | null;
    if (mgBlockEl) {
      mgBlockEl.style.display = t.infiniteMG || !t.hasCoaxMG ? 'none' : 'flex';
    }
    const heat = clamp01(t.mgHeat);
    this.mgBarFillEl.style.width = `${(heat * 100).toFixed(1)}%`;
    this.mgBarFillEl.classList.toggle('is-hot', t.mgOverheated || heat > 0.78);

    if (t.mgOverheated !== this.lastMgOverheat) {
      this.lastMgOverheat = t.mgOverheated;
      this.mgStatusEl.classList.toggle('fcs-badge-overheat', t.mgOverheated);
    }

    const mgStr = t.mgOverheated ? 'Overheat' : `${Math.round(heat * 100)}%`;
    if (mgStr !== this.lastMgStr) {
      this.lastMgStr = mgStr;
      this.mgStatusEl.textContent = mgStr;
    }
  }

  private drawCartographicRadar(t: HUDTelemetry): void {
    const { playerX, playerZ, worldHalfSize, units, obstacles } = t.minimap;

    const ctx = this.radarCtx;
    const dpr = this.radarDpr || 1;
    const size = RADAR_CSS_SIZE;
    const cx = size * 0.5;
    const cy = size * 0.5;
    const rScope = RADAR_SCOPE_RADIUS;
    const scale = rScope / RADAR_RANGE_METERS;

    const sinCam = Math.sin(t.cameraYaw);
    const cosCam = Math.cos(t.cameraYaw);

    // Exact camera-forward-up projection:
    //   forwardComp = dx * sin(camYaw) + dz * cos(camYaw)  (screen UP = -canvasY)
    //   rightComp   = -dx * cos(camYaw) + dz * sin(camYaw) (screen RIGHT = +canvasX)
    const projectXZ = (wx: number, wz: number): [number, number] => {
      const dx = wx - playerX;
      const dz = wz - playerZ;
      const rightComp = -dx * cosCam + dz * sinCam;
      const forwardComp = dx * sinCam + dz * cosCam;
      return [cx + rightComp * scale, cy - forwardComp * scale];
    };

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    // Outer housing background
    ctx.fillStyle = '#0a0e0a';
    ctx.fillRect(0, 0, size, size);

    // Clip to circular tactical radar scope
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rScope, 0, TWO_PI);
    ctx.clip();

    // Out-of-bounds base dark crimson-olive shade (visible beyond world boundary square)
    ctx.fillStyle = '#140f0e';
    ctx.fillRect(cx - rScope, cy - rScope, rScope * 2, rScope * 2);

    // Project world boundary square [-H, +H]^2 and fill active sector ground
    const H = Math.max(50, worldHalfSize || 250);
    const c0 = projectXZ(-H, -H);
    const c1 = projectXZ(H, -H);
    const c2 = projectXZ(H, H);
    const c3 = projectXZ(-H, H);

    ctx.beginPath();
    ctx.moveTo(c0[0], c0[1]);
    ctx.lineTo(c1[0], c1[1]);
    ctx.lineTo(c2[0], c2[1]);
    ctx.lineTo(c3[0], c3[1]);
    ctx.closePath();

    const scopeGrad = ctx.createRadialGradient(cx, cy, 4, cx, cy, rScope);
    scopeGrad.addColorStop(0, '#141b13');
    scopeGrad.addColorStop(1, '#0d120c');
    ctx.fillStyle = scopeGrad;
    ctx.fill();

    // Clip grid lines strictly inside the world boundary square
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = 'rgba(143, 168, 118, 0.11)';
    ctx.lineWidth = 0.8;
    const gridStep = 50;
    const minGX = Math.max(-H, Math.floor((playerX - RADAR_RANGE_METERS) / gridStep) * gridStep);
    const maxGX = Math.min(H, Math.ceil((playerX + RADAR_RANGE_METERS) / gridStep) * gridStep);
    const minGZ = Math.max(-H, Math.floor((playerZ - RADAR_RANGE_METERS) / gridStep) * gridStep);
    const maxGZ = Math.min(H, Math.ceil((playerZ + RADAR_RANGE_METERS) / gridStep) * gridStep);

    ctx.beginPath();
    for (let gx = minGX; gx <= maxGX; gx += gridStep) {
      const pA = projectXZ(gx, minGZ - gridStep);
      const pB = projectXZ(gx, maxGZ + gridStep);
      ctx.moveTo(pA[0], pA[1]);
      ctx.lineTo(pB[0], pB[1]);
    }
    for (let gz = minGZ; gz <= maxGZ; gz += gridStep) {
      const pA = projectXZ(minGX - gridStep, gz);
      const pB = projectXZ(maxGX + gridStep, gz);
      ctx.moveTo(pA[0], pA[1]);
      ctx.lineTo(pB[0], pB[1]);
    }
    ctx.stroke();
    ctx.restore();

    // Draw clipped world boundary perimeter in dashed phosphor amber
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(232, 169, 56, 0.55)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(c0[0], c0[1]);
    ctx.lineTo(c1[0], c1[1]);
    ctx.lineTo(c2[0], c2[1]);
    ctx.lineTo(c3[0], c3[1]);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // Draw terrain obstacle footprints by kind
    this.drawRadarObstacles(ctx, obstacles, playerX, playerZ, sinCam, cosCam, cx, cy, scale, rScope);

    // Concentric 100m & 200m cartographic range rings + scope crosshairs
    ctx.strokeStyle = 'rgba(143, 168, 118, 0.16)';
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(cx - rScope, cy);
    ctx.lineTo(cx + rScope, cy);
    ctx.moveTo(cx, cy - rScope);
    ctx.lineTo(cx, cy + rScope);
    ctx.stroke();

    const r100 = 100 * scale;
    const r200 = 200 * scale;
    ctx.strokeStyle = 'rgba(143, 168, 118, 0.28)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(cx, cy, r100, 0, TWO_PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r200, 0, TWO_PI);
    ctx.stroke();

    ctx.font = '600 8px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.fillStyle = 'rgba(143, 168, 118, 0.68)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('100M', cx + 3, cy - r100 - 1);
    ctx.fillText('200M', cx + 3, cy - r200 - 1);

    // Camera FOV Cone (always pointing straight UP = -PI/2 on canvas)
    const aspect = clamp(window.innerWidth / Math.max(1, window.innerHeight), 1, 2.4);
    const vFov = clamp(t.cameraFovRad || 1.0, 0.22, 1.8);
    const halfHFov = clamp(Math.atan(Math.tan(vFov * 0.5) * aspect), 0.14, 1.15);

    const fovGrad = ctx.createRadialGradient(cx, cy, 4, cx, cy, rScope);
    fovGrad.addColorStop(0, 'rgba(232, 169, 56, 0.18)');
    fovGrad.addColorStop(0.7, 'rgba(143, 168, 118, 0.07)');
    fovGrad.addColorStop(1, 'rgba(143, 168, 118, 0.0)');

    ctx.fillStyle = fovGrad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rScope, -Math.PI * 0.5 - halfHFov, -Math.PI * 0.5 + halfHFov);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(232, 169, 56, 0.34)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - Math.sin(halfHFov) * rScope, cy - Math.cos(halfHFov) * rScope);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(halfHFov) * rScope, cy - Math.cos(halfHFov) * rScope);
    ctx.stroke();

    // Ally + spotted hostile tactical markers (with rim-clamped chevrons for distant hostiles)
    this.drawRadarUnits(ctx, units, playerX, playerZ, t.cameraYaw, sinCam, cosCam, cx, cy, scale, rScope);

    // Center Player Tank Hull + Turret Gun Line
    const playerHullAngle = wrapPi(t.cameraYaw - t.hullYaw);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(playerHullAngle);
    ctx.fillStyle = 'rgba(143, 168, 118, 0.85)';
    ctx.strokeStyle = '#EAE6DC';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.rect(-3.6, -5.6, 7.2, 11.2);
    ctx.fill();
    ctx.stroke();
    // Bow chevron mark on player hull
    ctx.strokeStyle = '#0d120c';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(-2.2, -2.5);
    ctx.lineTo(0, -4.7);
    ctx.lineTo(2.2, -2.5);
    ctx.stroke();
    ctx.restore();

    const playerTurretAngle = wrapPi(t.cameraYaw - t.turretWorldYaw);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(playerTurretAngle);
    ctx.strokeStyle = '#E8A938';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -12.5);
    ctx.stroke();
    ctx.fillStyle = '#EAE6DC';
    ctx.beginPath();
    ctx.arc(0, 0, 2.1, 0, TWO_PI);
    ctx.fill();
    ctx.restore();

    // End circular scope clip
    ctx.restore();

    // Scope bezel ring + outer rotating compass rim (`N`, `E`, `S`, `W` + 15° ticks)
    ctx.strokeStyle = 'rgba(232, 169, 56, 0.36)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, rScope, 0, TWO_PI);
    ctx.stroke();

    // Fixed top lubber triangle at 12 o'clock on bezel
    ctx.fillStyle = '#E8A938';
    ctx.beginPath();
    ctx.moveTo(cx, cy - rScope + 1.5);
    ctx.lineTo(cx - 3, cy - rScope - 3.5);
    ctx.lineTo(cx + 3, cy - rScope - 3.5);
    ctx.closePath();
    ctx.fill();

    // Rotating degree ticks & cardinal markers around outer rim
    // Compass bearing B has world yaw `-B * DEG_TO_RAD`, so its CW screen angle from UP is:
    //   thetaCW = cameraYaw - (-B * DEG_TO_RAD) = cameraYaw + B * DEG_TO_RAD
    for (let deg = 0; deg < 360; deg += 15) {
      const thetaCW = t.cameraYaw + deg * DEG_TO_RAD;
      const sinT = Math.sin(thetaCW);
      const cosT = Math.cos(thetaCW);
      const isCardinal = deg % 90 === 0;
      if (isCardinal) continue;

      const rIn = rScope + 2;
      const rOut = deg % 30 === 0 ? rScope + 5.5 : rScope + 4;
      ctx.strokeStyle = deg % 30 === 0 ? 'rgba(234, 230, 220, 0.42)' : 'rgba(234, 230, 220, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + sinT * rIn, cy - cosT * rIn);
      ctx.lineTo(cx + sinT * rOut, cy - cosT * rOut);
      ctx.stroke();
    }

    const cardinals: readonly { deg: number; label: string; isNorth: boolean }[] = [
      { deg: 0, label: 'N', isNorth: true },
      { deg: 90, label: 'E', isNorth: false },
      { deg: 180, label: 'S', isNorth: false },
      { deg: 270, label: 'W', isNorth: false },
    ];

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const rCard = rScope + 7.5;

    for (let i = 0; i < cardinals.length; i++) {
      const c = cardinals[i];
      const thetaCW = t.cameraYaw + c.deg * DEG_TO_RAD;
      const lx = cx + Math.sin(thetaCW) * rCard;
      const ly = cy - Math.cos(thetaCW) * rCard;

      if (c.isNorth) {
        ctx.fillStyle = '#0d120c';
        ctx.beginPath();
        ctx.arc(lx, ly, 5.5, 0, TWO_PI);
        ctx.fill();
        ctx.strokeStyle = '#E8A938';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = '700 8.5px "Bahnschrift", "DIN Condensed", system-ui, sans-serif';
        ctx.fillStyle = '#E8A938';
        ctx.fillText('N', lx, ly + 0.5);
      } else {
        ctx.font = '700 8px "Bahnschrift", "DIN Condensed", system-ui, sans-serif';
        ctx.fillStyle = 'rgba(234, 230, 220, 0.72)';
        ctx.fillText(c.label, lx, ly + 0.5);
      }
    }

    ctx.restore();
  }

  private drawRadarObstacles(
    ctx: CanvasRenderingContext2D,
    obstacles: readonly MinimapObstacle[],
    playerX: number,
    playerZ: number,
    sinCam: number,
    cosCam: number,
    cx: number,
    cy: number,
    scale: number,
    rScope: number,
  ): void {
    const maxDist = RADAR_RANGE_METERS + 24;
    const maxDistSq = maxDist * maxDist;

    for (let i = 0; i < obstacles.length; i++) {
      const obs = obstacles[i];
      const dx = obs.x - playerX;
      const dz = obs.z - playerZ;
      if (dx * dx + dz * dz > maxDistSq) continue;

      const rightComp = -dx * cosCam + dz * sinCam;
      const forwardComp = dx * sinCam + dz * cosCam;
      const ox = cx + rightComp * scale;
      const oy = cy - forwardComp * scale;
      const rPx = Math.max(1.6, obs.radius * scale);

      if (ox + rPx < cx - rScope || ox - rPx > cx + rScope || oy + rPx < cy - rScope || oy - rPx > cy + rScope) {
        continue;
      }

      this.drawSingleObstacleFootprint(ctx, obs.kind, ox, oy, rPx);
    }
  }

  private drawSingleObstacleFootprint(
    ctx: CanvasRenderingContext2D,
    kind: ObstacleKind,
    ox: number,
    oy: number,
    rPx: number,
  ): void {
    switch (kind) {
      case 'building':
      case 'station': {
        const s = Math.max(2.6, rPx * 0.92);
        ctx.fillStyle = kind === 'station' ? 'rgba(232, 169, 56, 0.24)' : 'rgba(234, 230, 220, 0.22)';
        ctx.strokeStyle = kind === 'station' ? 'rgba(232, 169, 56, 0.68)' : 'rgba(234, 230, 220, 0.52)';
        ctx.lineWidth = 0.9;
        ctx.fillRect(ox - s, oy - s, s * 2, s * 2);
        ctx.strokeRect(ox - s, oy - s, s * 2, s * 2);
        break;
      }
      case 'tower': {
        const r = Math.max(2.4, rPx);
        ctx.fillStyle = 'rgba(232, 169, 56, 0.22)';
        ctx.strokeStyle = 'rgba(232, 169, 56, 0.72)';
        ctx.lineWidth = 0.95;
        ctx.beginPath();
        ctx.arc(ox, oy, r, 0, TWO_PI);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'barrier': {
        const s = Math.max(2.0, rPx * 0.85);
        ctx.fillStyle = 'rgba(234, 230, 220, 0.36)';
        ctx.fillRect(ox - s, oy - 1.3, s * 2, 2.6);
        break;
      }
      case 'rock': {
        ctx.fillStyle = 'rgba(176, 180, 166, 0.30)';
        ctx.strokeStyle = 'rgba(234, 230, 220, 0.34)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(ox, oy, Math.max(1.8, rPx * 0.9), 0, TWO_PI);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'crates': {
        const s = Math.max(1.6, rPx * 0.75);
        ctx.fillStyle = 'rgba(232, 169, 56, 0.34)';
        ctx.fillRect(ox - s, oy - s, s * 2, s * 2);
        break;
      }
      case 'tree':
      default: {
        ctx.fillStyle = 'rgba(143, 168, 118, 0.30)';
        ctx.beginPath();
        ctx.arc(ox, oy, Math.max(1.5, rPx * 0.78), 0, TWO_PI);
        ctx.fill();
        break;
      }
    }
  }

  private drawRadarUnits(
    ctx: CanvasRenderingContext2D,
    units: readonly MinimapUnit[],
    playerX: number,
    playerZ: number,
    camYaw: number,
    sinCam: number,
    cosCam: number,
    cx: number,
    cy: number,
    scale: number,
    rScope: number,
  ): void {
    for (let i = 0; i < units.length; i++) {
      const e = units[i];
      const dx = e.x - playerX;
      const dz = e.z - playerZ;
      const rightComp = -dx * cosCam + dz * sinCam;
      const forwardComp = dx * sinCam + dz * cosCam;

      const rx = rightComp * scale;
      const ry = -forwardComp * scale;
      const distPx = Math.hypot(rx, ry);

      if (!e.alive) {
        if (distPx < rScope - 4 && e.ally) {
          const ex = cx + rx;
          const ey = cy + ry;
          ctx.strokeStyle = 'rgba(234, 230, 220, 0.24)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(ex - 2.5, ey - 2.5);
          ctx.lineTo(ex + 2.5, ey + 2.5);
          ctx.moveTo(ex + 2.5, ey - 2.5);
          ctx.lineTo(ex - 2.5, ey + 2.5);
          ctx.stroke();
        }
        continue;
      }

      // Unspotted hostiles never appear on the radar
      if (!e.ally && !e.spotted) continue;

      // Clamped rim contact chevron when hostile is beyond 220m scope radius
      if (!e.ally && distPx > rScope - 5) {
        const bearingAngle = Math.atan2(ry, rx);
        const rimR = rScope - 3.5;
        ctx.save();
        ctx.translate(cx + Math.cos(bearingAngle) * rimR, cy + Math.sin(bearingAngle) * rimR);
        ctx.rotate(bearingAngle + Math.PI * 0.5);
        ctx.fillStyle = '#D94636';
        ctx.beginPath();
        ctx.moveTo(0, -3.5);
        ctx.lineTo(-3.2, 2.8);
        ctx.lineTo(3.2, 2.8);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        continue;
      }

      const ex = cx + rx;
      const ey = cy + ry;
      const headAngleCW = wrapPi(camYaw - e.yaw);
      const isAlly = e.ally;
      const markColor = isAlly ? '#8FB4D8' : '#D94636';
      const diamondSize = isAlly ? 3.6 : 4.6;

      // Heading tick in unit forward direction
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(headAngleCW);
      ctx.strokeStyle = isAlly ? 'rgba(143, 180, 216, 0.85)' : '#EAE6DC';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, -diamondSize + 0.5);
      ctx.lineTo(0, -(diamondSize + 4.8));
      ctx.stroke();
      ctx.restore();

      // Team diamond: blue allies / red spotted hostiles
      ctx.fillStyle = markColor;
      ctx.strokeStyle = isAlly ? 'rgba(14, 17, 13, 0.9)' : 'rgba(14, 17, 13, 0.9)';
      ctx.lineWidth = 0.95;
      ctx.beginPath();
      ctx.moveTo(ex, ey - diamondSize);
      ctx.lineTo(ex + diamondSize, ey);
      ctx.lineTo(ex, ey + diamondSize);
      ctx.lineTo(ex - diamondSize, ey);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  private updateEventFeed(t: HUDTelemetry): void {
    const msgs = t.feedMessages;
    const total = msgs.length;
    const startIdx = Math.max(0, total - FEED_POOL_SIZE);
    const visibleCount = total - startIdx;

    for (let i = 0; i < FEED_POOL_SIZE; i++) {
      const slot = this.feedSlots[i];
      if (i >= visibleCount) {
        if (slot.active) {
          slot.active = false;
          slot.row.classList.remove('is-active');
        }
        continue;
      }

      const msg = msgs[startIdx + i];
      if (!slot.active) {
        slot.active = true;
        slot.row.classList.add('is-active');
      }

      if (slot.lastId !== msg.id) {
        slot.lastId = msg.id;
        if (msg.actorName && msg.targetName) {
          slot.text.style.display = 'none';
          slot.parts.style.display = 'flex';
          slot.actor.textContent = msg.actorName;
          slot.actor.className = `fcs-feed-actor ${msg.actorTeam === 'blue' ? 'is-blue' : 'is-red'}`;
          slot.verb.textContent = 'destroyed';
          slot.target.textContent = msg.targetName;
          slot.target.className = `fcs-feed-target ${msg.targetTeam === 'blue' ? 'is-blue' : 'is-red'}`;
        } else {
          slot.parts.style.display = 'none';
          slot.text.style.display = '';
          slot.text.textContent = msg.text;
        }
      }

      if (slot.lastAccent !== msg.accent) {
        slot.lastAccent = msg.accent;
        slot.row.classList.remove('fcs-feed-row--kill', 'fcs-feed-row--death', 'fcs-feed-row--info');
        slot.row.classList.add(`fcs-feed-row--${msg.accent}`);
        slot.tag.textContent = msg.accent === 'kill' ? 'Kill' : msg.accent === 'death' ? 'Down' : '';
        slot.tag.style.display = msg.accent === 'info' ? 'none' : '';
      }

      // Smooth fade by age (seconds)
      const fade = msg.age <= 2.8 ? 1 : clamp(1 - (msg.age - 2.8) / 2.8, 0.14, 1);
      slot.row.style.opacity = fade.toFixed(2);
    }
  }

  private updateRespawnBanner(t: HUDTelemetry): void {
    const showRespawn = !t.alive && !this.briefingVisible;
    if (showRespawn !== this.lastRespawnVisible) {
      this.lastRespawnVisible = showRespawn;
      this.respawnBannerEl.classList.toggle('is-visible', showRespawn);
      if (showRespawn) {
        this.maxObservedRespawn = Math.max(3.0, t.respawnRemaining);
      }
    }

    if (showRespawn) {
      const rem = Math.max(0, Number.isFinite(t.respawnRemaining) ? t.respawnRemaining : 0);
      if (rem > this.maxObservedRespawn) {
        this.maxObservedRespawn = rem;
      }
      this.respawnSecEl.textContent = `Back in ${rem.toFixed(1)} s`;
      const progress = clamp01(1 - rem / Math.max(0.1, this.maxObservedRespawn));
      this.respawnBarFillEl.style.width = `${(progress * 100).toFixed(1)}%`;
    }
  }

  // =========================================================================
  // ONE-TIME DOM BUILDERS (CONSTRUCTOR ONLY)
  // =========================================================================

  private buildSniperOpticLayer(): {
    overlay: HTMLDivElement;
    dropPip: SVGGElement;
    lrfVal: HTMLSpanElement;
    lrfSub: HTMLSpanElement;
  } {
    const overlay = document.createElement('div');
    overlay.className = 'fcs-sniper-overlay';

    const vignette = document.createElement('div');
    vignette.className = 'fcs-sniper-vignette';
    overlay.appendChild(vignette);

    // Etched Gunner 2.8x Periscope Glass Reticle & Mil-Dot Ballistic Ladder
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 560 520');
    svg.setAttribute('class', 'fcs-sniper-ladder-svg');

    let ladderMarkup = `
      <path d="M 52 130 A 250 250 0 0 0 52 390" fill="none" stroke="rgba(232,169,56,0.34)" stroke-width="1.2"/>
      <path d="M 508 130 A 250 250 0 0 1 508 390" fill="none" stroke="rgba(232,169,56,0.34)" stroke-width="1.2"/>
      <line x1="68" y1="260" x2="220" y2="260" stroke="rgba(232,169,56,0.36)" stroke-width="1"/>
      <line x1="340" y1="260" x2="492" y2="260" stroke="rgba(232,169,56,0.36)" stroke-width="1"/>
      <line x1="280" y1="278" x2="280" y2="436" stroke="rgba(232,169,56,0.42)" stroke-width="1"/>
    `;

    // Horizontal mil ticks at +-8, 12, 16, 20, 24 mils (7.5px per mil)
    for (let mil = 8; mil <= 24; mil += 4) {
      const dx = mil * 7.5;
      const tickH = mil % 8 === 0 ? 6 : 3.5;
      ladderMarkup += `
        <line x1="${280 - dx}" y1="${260 - tickH}" x2="${280 - dx}" y2="${260 + tickH}" stroke="rgba(232,169,56,0.52)" stroke-width="1"/>
        <line x1="${280 + dx}" y1="${260 - tickH}" x2="${280 + dx}" y2="${260 + tickH}" stroke="rgba(232,169,56,0.52)" stroke-width="1"/>
      `;
      if (mil % 8 === 0) {
        ladderMarkup += `
          <text x="${280 - dx}" y="250" text-anchor="middle" fill="rgba(234,230,220,0.55)" font-family="ui-monospace, monospace" font-size="8.5">${mil}</text>
          <text x="${280 + dx}" y="250" text-anchor="middle" fill="rgba(234,230,220,0.55)" font-family="ui-monospace, monospace" font-size="8.5">${mil}</text>
        `;
      }
    }

    // Vertical ballistic drop ladder ticks below bore (04, 08, 12, 16, 20 = 400m..2000m)
    for (let mil = 4; mil <= 20; mil += 2) {
      const y = 260 + mil * 7.5;
      const halfW = mil % 4 === 0 ? 11 : 5.5;
      ladderMarkup += `
        <line x1="${280 - halfW}" y1="${y}" x2="${280 + halfW}" y2="${y}" stroke="rgba(232,169,56,0.62)" stroke-width="1"/>
      `;
      if (mil % 4 === 0) {
        const tag = String(mil).padStart(2, '0');
        ladderMarkup += `
          <text x="262" y="${y + 3}" text-anchor="end" fill="rgba(232,169,56,0.78)" font-family="ui-monospace, monospace" font-size="8.5">${tag}</text>
        `;
      }
    }

    // Stadia 2.7m Tank Silhouette Rangefinder Curve (bottom-left quadrant)
    ladderMarkup += `
      <line x1="110" y1="398" x2="206" y2="398" stroke="rgba(143,168,118,0.5)" stroke-width="1"/>
      <path d="M 114 364 Q 148 384 202 392" fill="none" stroke="rgba(143,168,118,0.55)" stroke-width="1" stroke-dasharray="3 2"/>
      <text x="114" y="359" fill="rgba(143,168,118,0.72)" font-family="ui-monospace, monospace" font-size="8">2.7M STADIA // 04-16</text>
      <g id="fcs-sniper-drop-pip" transform="translate(0 280)">
        <polygon points="294,0 300,-3 300,3" fill="#EAE6DC"/>
      </g>
    `;

    svg.innerHTML = ladderMarkup;
    overlay.appendChild(svg);

    const dropPip = svg.querySelector('#fcs-sniper-drop-pip') as SVGGElement;

    const topTag = document.createElement('div');
    topTag.className = 'fcs-sniper-top-tag';
    topTag.textContent = '2.8×';
    overlay.appendChild(topTag);

    const lrfBox = document.createElement('div');
    lrfBox.className = 'fcs-sniper-lrf-box';
    const lrfVal = document.createElement('span');
    lrfVal.className = 'fcs-sniper-lrf-val';
    lrfVal.textContent = '0 m';
    const lrfSub = document.createElement('span');
    lrfSub.className = 'fcs-sniper-lrf-sub';
    lrfSub.textContent = '—';
    lrfBox.append(lrfVal, lrfSub);
    overlay.appendChild(lrfBox);

    return { overlay, dropPip, lrfVal, lrfSub };
  }

  private buildReticleLayer(): {
    layer: HTMLDivElement;
    commanderAim: HTMLDivElement;
    gunnerBore: HTMLDivElement;
    boreReloadCircle: SVGCircleElement;
    boreRangeText: HTMLSpanElement;
    hitMarker: HTMLDivElement;
    killBanner: HTMLDivElement;
    damageArc: HTMLDivElement;
  } {
    const layer = document.createElement('div');
    layer.className = 'fcs-reticle-layer';

    // 1. Incoming Hit Directional Arc around screen center
    const damageArc = document.createElement('div');
    damageArc.className = 'fcs-damage-arc';
    damageArc.innerHTML = `
      <svg viewBox="0 0 360 360" width="360" height="360">
        <defs>
          <linearGradient id="fcs-dmg-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#D94636" stop-opacity="0.95"/>
            <stop offset="100%" stop-color="#D94636" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        <path d="M 122 36 A 155 155 0 0 1 238 36 L 226 52 A 136 136 0 0 0 134 52 Z" fill="url(#fcs-dmg-grad)" stroke="#D94636" stroke-width="1"/>
        <polygon points="180,14 172,26 188,26" fill="#D94636"/>
      </svg>
    `;
    layer.appendChild(damageArc);

    // 2. Commander Aim Circle (exact 38px diameter outer amber ring)
    const commanderAim = document.createElement('div');
    commanderAim.className = 'fcs-commander-aim';
    commanderAim.innerHTML = `
      <svg viewBox="0 0 46 46" width="46" height="46">
        <circle cx="23" cy="23" r="19" fill="none" stroke="#E8A938" stroke-width="1.5"/>
        <line x1="23" y1="1.5" x2="23" y2="5" stroke="#E8A938" stroke-width="1.3"/>
        <line x1="23" y1="41" x2="23" y2="44.5" stroke="#E8A938" stroke-width="1.3"/>
        <line x1="1.5" y1="23" x2="5" y2="23" stroke="#E8A938" stroke-width="1.3"/>
        <line x1="41" y1="23" x2="44.5" y2="23" stroke="#E8A938" stroke-width="1.3"/>
        <circle cx="23" cy="23" r="1.2" fill="#E8A938" opacity="0.7"/>
      </svg>
    `;
    layer.appendChild(commanderAim);

    // 3. Gunner Bore Ballistic Crosshair + Radial Reload SVG Circle + Stadia Ticks
    const gunnerBore = document.createElement('div');
    gunnerBore.className = 'fcs-gunner-bore';
    gunnerBore.innerHTML = `
      <svg class="fcs-bore-svg" viewBox="0 0 128 128">
        <!-- Reload Ring Track & Progress -->
        <circle cx="64" cy="64" r="${BORE_RING_RADIUS}" fill="none" stroke="rgba(234,230,220,0.16)" stroke-width="2"/>
        <circle
          id="fcs-bore-reload-ring"
          class="fcs-bore-stroke"
          cx="64"
          cy="64"
          r="${BORE_RING_RADIUS}"
          fill="none"
          stroke-width="2.2"
          stroke-dasharray="${BORE_RING_CIRCUMFERENCE.toFixed(2)}"
          stroke-dashoffset="0"
          transform="rotate(-90 64 64)"
        />
        <!-- Horizontal & Vertical Ballistic Stadia Crosshair -->
        <line class="fcs-bore-stroke" x1="24" y1="64" x2="56" y2="64" stroke-width="1.35"/>
        <line class="fcs-bore-stroke" x1="72" y1="64" x2="104" y2="64" stroke-width="1.35"/>
        <line class="fcs-bore-stroke" x1="64" y1="28" x2="64" y2="55" stroke-width="1.2"/>
        <line class="fcs-bore-stroke" x1="64" y1="73" x2="64" y2="104" stroke-width="1.2"/>
        <!-- Stadia Horizontal Range Ticks -->
        <line class="fcs-bore-stroke" x1="34" y1="61.5" x2="34" y2="66.5" stroke-width="1.1"/>
        <line class="fcs-bore-stroke" x1="44" y1="62" x2="44" y2="66" stroke-width="1.1"/>
        <line class="fcs-bore-stroke" x1="52" y1="62.5" x2="52" y2="65.5" stroke-width="1.1"/>
        <line class="fcs-bore-stroke" x1="76" y1="62.5" x2="76" y2="65.5" stroke-width="1.1"/>
        <line class="fcs-bore-stroke" x1="84" y1="62" x2="84" y2="66" stroke-width="1.1"/>
        <line class="fcs-bore-stroke" x1="94" y1="61.5" x2="94" y2="66.5" stroke-width="1.1"/>
        <!-- Stadia Vertical Drop Ticks -->
        <line class="fcs-bore-stroke" x1="61.5" y1="78" x2="66.5" y2="78" stroke-width="1.1"/>
        <line class="fcs-bore-stroke" x1="60.5" y1="86" x2="67.5" y2="86" stroke-width="1.1"/>
        <line class="fcs-bore-stroke" x1="61.5" y1="94" x2="66.5" y2="94" stroke-width="1.1"/>
        <!-- Center Precision Impact Chevron -->
        <polyline class="fcs-bore-stroke" points="60.8,67.4 64,64 67.2,67.4" fill="none" stroke-width="1.5"/>
        <!-- Target Lock Brackets -->
        <path class="fcs-bore-lock-bracket" d="M 43 49 L 43 43 L 49 43 M 85 49 L 85 43 L 79 43 M 43 79 L 43 85 L 49 85 M 85 79 L 85 85 L 79 85" fill="none" stroke-width="1.5"/>
      </svg>
      <div class="fcs-bore-readout">
        <span id="fcs-bore-rng">0 m</span>
      </div>
    `;
    layer.appendChild(gunnerBore);

    const boreReloadCircle = gunnerBore.querySelector('#fcs-bore-reload-ring') as SVGCircleElement;
    const boreRangeText = gunnerBore.querySelector('#fcs-bore-rng') as HTMLSpanElement;

    // 4. Hit / Kill Diagonal X-Ticks at Bore
    const hitMarker = document.createElement('div');
    hitMarker.className = 'fcs-hit-marker';
    hitMarker.innerHTML = `
      <svg viewBox="0 0 56 56" width="56" height="56">
        <line class="hm-tick" x1="10" y1="10" x2="21" y2="21"/>
        <line class="hm-tick" x1="46" y1="10" x2="35" y2="21"/>
        <line class="hm-tick" x1="10" y1="46" x2="21" y2="35"/>
        <line class="hm-tick" x1="46" y1="46" x2="35" y2="35"/>
        <polygon class="hm-accent" points="28,16 40,28 28,40 16,28" fill="none"/>
      </svg>
    `;
    layer.appendChild(hitMarker);

    // 5. TARGET DESTROYED Micro-Banner
    const killBanner = document.createElement('div');
    killBanner.className = 'fcs-kill-banner';
    killBanner.innerHTML = `
      <span class="fcs-kill-banner-tag">Ordnance impact</span>
      <span class="fcs-kill-banner-title">Target destroyed</span>
    `;
    layer.appendChild(killBanner);

    return {
      layer,
      commanderAim,
      gunnerBore,
      boreReloadCircle,
      boreRangeText,
      hitMarker,
      killBanner,
      damageArc,
    };
  }

  private buildVehiclePanel(): {
    panel: HTMLDivElement;
    hullGroup: SVGGElement;
    turretGroup: SVGGElement;
    hpReadout: HTMLSpanElement;
    speedNum: HTMLSpanElement;
    cannonStatus: HTMLSpanElement;
    cannonBarFill: HTMLDivElement;
    mgStatus: HTMLSpanElement;
    mgBarFill: HTMLDivElement;
    pillEls: HTMLSpanElement[];
    pillCodes: HTMLSpanElement[];
  } {
    const panel = document.createElement('div');
    panel.className = 'hud-plate fcs-vehicle-panel';

    // Left Column: 96x96 Live SVG Tank Paper-Doll
    const pdCol = document.createElement('div');
    pdCol.className = 'fcs-paperdoll-col';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 96 96');
    svg.setAttribute('class', 'fcs-paperdoll-svg');

    let azimuthTicks = '';
    for (let deg = 0; deg < 360; deg += 30) {
      const rad = deg * DEG_TO_RAD;
      const r1 = deg % 90 === 0 ? 41 : 42.5;
      const r2 = 45;
      const x1 = 48 + Math.sin(rad) * r1;
      const y1 = 48 - Math.cos(rad) * r1;
      const x2 = 48 + Math.sin(rad) * r2;
      const y2 = 48 - Math.cos(rad) * r2;
      azimuthTicks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(234,230,220,0.28)" stroke-width="1"/>`;
    }

    svg.innerHTML = `
      <!-- Polar Azimuth Ring & Camera Sight UP Caret -->
      <circle cx="48" cy="48" r="45" fill="rgba(8,11,8,0.55)" stroke="rgba(236,234,228,0.16)" stroke-width="1"/>
      ${azimuthTicks}
      <polygon points="48,2 45,7 51,7" fill="#E8A938" opacity="0.88"/>

      <!-- Hull Silhouette Group (Bow points UP at 0 deg) -->
      <g id="fcs-pd-hull" transform="rotate(0 48 48)">
        <!-- Left & Right Track Sponsons -->
        <rect class="fcs-pd-track-fill" x="28" y="23" width="6.5" height="50" stroke-width="1"/>
        <rect class="fcs-pd-track-fill" x="61.5" y="23" width="6.5" height="50" stroke-width="1"/>
        <line x1="28" y1="31" x2="34.5" y2="31" stroke="rgba(234,230,220,0.3)" stroke-width="0.9"/>
        <line x1="28" y1="40" x2="34.5" y2="40" stroke="rgba(234,230,220,0.3)" stroke-width="0.9"/>
        <line x1="28" y1="56" x2="34.5" y2="56" stroke="rgba(234,230,220,0.3)" stroke-width="0.9"/>
        <line x1="28" y1="65" x2="34.5" y2="65" stroke="rgba(234,230,220,0.3)" stroke-width="0.9"/>
        <line x1="61.5" y1="31" x2="68" y2="31" stroke="rgba(234,230,220,0.3)" stroke-width="0.9"/>
        <line x1="61.5" y1="40" x2="68" y2="40" stroke="rgba(234,230,220,0.3)" stroke-width="0.9"/>
        <line x1="61.5" y1="56" x2="68" y2="56" stroke="rgba(234,230,220,0.3)" stroke-width="0.9"/>
        <line x1="61.5" y1="65" x2="68" y2="65" stroke="rgba(234,230,220,0.3)" stroke-width="0.9"/>
        <!-- Main Armored Chassis & Sloped Glacis Bow -->
        <polygon class="fcs-pd-hull-fill" points="34.5,27 40,22 56,22 61.5,27 61.5,72 34.5,72" stroke-width="1.3"/>
        <!-- Bow Forward Chevron & Rear Engine Louvers -->
        <polyline points="43,28 48,24 53,28" fill="none" stroke="rgba(234,230,220,0.75)" stroke-width="1.2"/>
        <line x1="38" y1="65" x2="58" y2="65" stroke="rgba(234,230,220,0.28)" stroke-width="1"/>
        <line x1="38" y1="68.5" x2="58" y2="68.5" stroke="rgba(234,230,220,0.28)" stroke-width="1"/>
      </g>

      <!-- Turret + 120mm Barrel Group (Muzzle points UP at 0 deg) -->
      <g id="fcs-pd-turret" transform="rotate(0 48 48)">
        <!-- 7.62mm Coaxial Barrel Stub -->
        <line x1="52.2" y1="24" x2="52.2" y2="35" stroke="rgba(234,230,220,0.65)" stroke-width="1.2"/>
        <!-- 120mm Smoothbore Gun + Bore Evacuator + Muzzle -->
        <line class="fcs-pd-gun-stroke" x1="48" y1="7" x2="48" y2="36" stroke-width="2.4"/>
        <rect x="46.2" y="17" width="3.6" height="6.5" fill="#131712" stroke="rgba(236,234,228,0.55)" stroke-width="1"/>
        <line class="fcs-pd-gun-stroke" x1="45.8" y1="7.5" x2="50.2" y2="7.5" stroke-width="1.8"/>
        <!-- Welded Composite MBT Turret & Rear Bustle -->
        <polygon class="fcs-pd-turret-fill" points="42,34 54,34 58,41 56.5,58 39.5,58 38,41" stroke-width="1.35"/>
        <line x1="40.5" y1="53.5" x2="55.5" y2="53.5" stroke="rgba(236,234,228,0.28)" stroke-width="1"/>
        <circle cx="51.5" cy="46.5" r="3" fill="rgba(19,23,18,0.8)" stroke="rgba(236,234,228,0.6)" stroke-width="1"/>
      </g>
    `;

    const hullGroup = svg.querySelector('#fcs-pd-hull') as SVGGElement;
    const turretGroup = svg.querySelector('#fcs-pd-turret') as SVGGElement;

    pdCol.append(svg);

    // Right Column: Hull Armor, Drive Telemetry & Ordnance
    const sysCol = document.createElement('div');
    sysCol.className = 'fcs-systems-col';

    // 1. Segmented Hull Armor HP Block
    const hpBlock = document.createElement('div');
    hpBlock.className = 'fcs-bar-block';
    const hpHeader = document.createElement('div');
    hpHeader.className = 'fcs-bar-header';
    const hpTitle = document.createElement('span');
    hpTitle.className = 'fcs-bar-title';
    hpTitle.textContent = 'Hull';
    const hpReadout = document.createElement('span');
    hpReadout.className = 'fcs-bar-readout';
    hpReadout.textContent = '0 / 0';
    hpHeader.append(hpTitle, hpReadout);

    const hpSegments = document.createElement('div');
    hpSegments.className = 'fcs-hp-segments';
    for (let i = 0; i < HP_SEGMENT_COUNT; i++) {
      const seg = document.createElement('div');
      seg.className = 'fcs-hp-seg';
      this.hpSegEls.push(seg);
      hpSegments.appendChild(seg);
    }
    hpBlock.append(hpHeader, hpSegments);

    // 2. Speedometer Row
    const driveRow = document.createElement('div');
    driveRow.className = 'fcs-drive-row';

    const speedGroup = document.createElement('div');
    speedGroup.className = 'fcs-speed-group';
    const speedNum = document.createElement('span');
    speedNum.className = 'fcs-speed-num';
    speedNum.textContent = '0';
    const speedUnit = document.createElement('span');
    speedUnit.className = 'fcs-speed-unit';
    speedUnit.textContent = 'km/h';
    speedGroup.append(speedNum, speedUnit);

    driveRow.append(speedGroup);

    // 3. Ordnance Status Bars (120mm HE-FRAG & 7.62mm COAX)
    const ordGrid = document.createElement('div');
    ordGrid.className = 'fcs-ordnance-grid';

    const cannonBlock = document.createElement('div');
    cannonBlock.className = 'fcs-bar-block';
    const cannonHeader = document.createElement('div');
    cannonHeader.className = 'fcs-bar-header';
    const cannonTitle = document.createElement('span');
    cannonTitle.className = 'fcs-bar-title';
    cannonTitle.textContent = 'Main gun';
    const cannonStatus = document.createElement('span');
    cannonStatus.className = 'fcs-bar-readout fcs-badge-ready';
    cannonStatus.textContent = 'Ready';
    cannonHeader.append(cannonTitle, cannonStatus);
    const cannonTrack = document.createElement('div');
    cannonTrack.className = 'fcs-linear-track';
    const cannonBarFill = document.createElement('div');
    cannonBarFill.className = 'fcs-linear-fill is-ready';
    cannonTrack.appendChild(cannonBarFill);
    cannonBlock.append(cannonHeader, cannonTrack);

    const mgBlock = document.createElement('div');
    mgBlock.className = 'fcs-bar-block';
    const mgHeader = document.createElement('div');
    mgHeader.className = 'fcs-bar-header';
    const mgTitle = document.createElement('span');
    mgTitle.className = 'fcs-bar-title';
    mgTitle.textContent = 'Coax';
    const mgStatus = document.createElement('span');
    mgStatus.className = 'fcs-bar-readout';
    mgStatus.textContent = '0%';
    mgHeader.append(mgTitle, mgStatus);
    const mgTrack = document.createElement('div');
    mgTrack.className = 'fcs-linear-track';
    const mgBarFill = document.createElement('div');
    mgBarFill.className = 'fcs-linear-fill';
    mgBarFill.style.width = '0%';
    mgTrack.appendChild(mgBarFill);
    mgBlock.append(mgHeader, mgTrack);

    // Shell / Belt Slot Pills ([1] / [2])
    const shellPills = document.createElement('div');
    shellPills.id = 'fcs-shell-pills';
    shellPills.className = 'fcs-shell-pills';
    const pillEls: HTMLSpanElement[] = [];
    const pillCodes: HTMLSpanElement[] = [];
    const mkPill = (key: string, code: string, active: boolean): HTMLSpanElement => {
      const pill = document.createElement('span');
      pill.className = `fcs-shell-pill${active ? ' is-active-shell' : ''}`;
      const cap = document.createElement('span');
      cap.className = 'fcs-key-cap';
      cap.textContent = key;
      const codeEl = document.createElement('span');
      codeEl.className = 'fcs-shell-code';
      codeEl.textContent = code;
      pill.append(cap, codeEl);
      pillEls.push(pill);
      pillCodes.push(codeEl);
      return pill;
    };
    shellPills.append(mkPill('1', 'APFSDS', true), mkPill('2', 'HE-FRAG', false));

    ordGrid.append(shellPills, cannonBlock, mgBlock);
    sysCol.append(hpBlock, driveRow, ordGrid);
    panel.append(pdCol, sysCol);

    return {
      panel,
      hullGroup,
      turretGroup,
      hpReadout,
      speedNum,
      cannonStatus,
      cannonBarFill,
      mgStatus,
      mgBarFill,
      pillEls,
      pillCodes,
    };
  }

  private buildRadarPanel(): {
    panel: HTMLDivElement;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
  } {
    const panel = document.createElement('div');
    panel.className = 'hud-plate fcs-radar-panel';

    const header = document.createElement('div');
    header.className = 'fcs-radar-header';
    const title = document.createElement('span');
    title.className = 'fcs-radar-title';
    title.textContent = `Radar · ${RADAR_RANGE_METERS} m`;
    header.append(title);

    const frame = document.createElement('div');
    frame.className = 'fcs-radar-canvas-frame';
    const canvas = document.createElement('canvas');
    canvas.className = 'fcs-radar-canvas';
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D context for HUD tactical radar');
    }
    frame.appendChild(canvas);

    panel.append(header, frame);
    return { panel, canvas, ctx };
  }

  private buildEventFeed(): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'fcs-event-feed';

    for (let i = 0; i < FEED_POOL_SIZE; i++) {
      const row = document.createElement('div');
      row.className = 'fcs-feed-row';
      const tag = document.createElement('span');
      tag.className = 'fcs-feed-tag';
      const body = document.createElement('span');
      body.className = 'fcs-feed-body';
      const text = document.createElement('span');
      text.className = 'fcs-feed-text';
      const parts = document.createElement('span');
      parts.className = 'fcs-feed-parts';
      parts.style.display = 'none';
      const actor = document.createElement('span');
      actor.className = 'fcs-feed-actor';
      const verb = document.createElement('span');
      verb.className = 'fcs-feed-verb';
      const target = document.createElement('span');
      target.className = 'fcs-feed-target';
      parts.append(actor, verb, target);
      body.append(text, parts);
      row.append(tag, body);
      wrap.appendChild(row);
      this.feedSlots.push({
        row,
        tag,
        body,
        text,
        parts,
        actor,
        verb,
        target,
        lastId: -1,
        lastAccent: '',
        active: false,
      });
    }

    return wrap;
  }

  private buildRespawnBanner(): {
    banner: HTMLDivElement;
    sec: HTMLSpanElement;
    barFill: HTMLDivElement;
  } {
    const banner = document.createElement('div');
    banner.className = 'hud-plate fcs-respawn-banner';

    const title = document.createElement('div');
    title.className = 'fcs-respawn-title';
    title.textContent = 'Vehicle destroyed';

    const sec = document.createElement('span');
    sec.className = 'fcs-respawn-sec';
    sec.textContent = 'Back in 3.0 s';

    const bar = document.createElement('div');
    bar.className = 'fcs-respawn-bar';
    const barFill = document.createElement('div');
    barFill.className = 'fcs-respawn-bar-fill';
    bar.appendChild(barFill);

    banner.append(title, sec, bar);
    return { banner, sec, barFill };
  }

  private buildBriefingOverlay(): {
    backdrop: HTMLDivElement;
    loaderFill: HTMLSpanElement;
    engageBtn: HTMLButtonElement;
    engageMainText: HTMLSpanElement;
    engageSubText: HTMLSpanElement;
  } {
    const backdrop = document.createElement('div');
    backdrop.className = 'fcs-briefing-backdrop is-visible';

    const modal = document.createElement('div');
    modal.className = 'hud-plate fcs-briefing-modal';

    const head = document.createElement('div');
    head.className = 'fcs-briefing-head';
    const title = document.createElement('h1');
    title.className = 'fcs-briefing-title';
    title.textContent = 'untitled tank game';
    const sub = document.createElement('p');
    sub.className = 'fcs-briefing-sub';
    sub.textContent = 'Team deathmatch · 6 v 6 · no score limit';
    head.append(title, sub);

    // Vehicle Class Selector
    const classSection = document.createElement('div');
    classSection.className = 'fcs-bsec';
    const classLabel = document.createElement('div');
    classLabel.className = 'fcs-bsec-label';
    classLabel.textContent = 'Vehicle';

    const classList = document.createElement('div');
    classList.className = 'fcs-vlist';

    const classBtns: HTMLButtonElement[] = [];
    BRIEFING_VEHICLES.forEach((spec, idx) => {
      const stats = TANK_STATS[spec.id];
      const kmh = Math.floor(stats.maxForwardSpeed * 3.6);
      const armament = spec.id === 'rocket' && stats.salvoSize
        ? `${stats.salvoSize}-rocket salvo`
        : spec.armament;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `fcs-vrow${idx === 0 ? ' is-selected' : ''}`;
      const name = document.createElement('span');
      name.className = 'fcs-vname';
      name.textContent = spec.name;
      const specEl = document.createElement('span');
      specEl.className = 'fcs-vspec';
      specEl.textContent = `${kmh} km/h · ${armament}`;
      btn.append(name, specEl);
      btn.addEventListener('click', () => {
        classBtns.forEach((b) => b.classList.remove('is-selected'));
        btn.classList.add('is-selected');
        this.callbacks.onSelectVehicleClass?.(spec.id);
      });
      classBtns.push(btn);
      classList.appendChild(btn);
    });
    classSection.append(classLabel, classList);

    // Controls matrix
    const kbSection = document.createElement('div');
    kbSection.className = 'fcs-bsec';
    const kbLabel = document.createElement('div');
    kbLabel.className = 'fcs-bsec-label';
    kbLabel.textContent = 'Controls';

    const kbGrid = document.createElement('div');
    kbGrid.className = 'fcs-kbgrid';

    for (const { keys, action } of BRIEFING_CONTROLS) {
      const row = document.createElement('div');
      row.className = 'fcs-kbrow';
      const caps = document.createElement('span');
      caps.className = 'fcs-kbcaps';
      for (const key of keys) {
        const cap = document.createElement('span');
        cap.className = 'fcs-key-cap';
        cap.textContent = key;
        caps.appendChild(cap);
      }
      const desc = document.createElement('span');
      desc.className = 'fcs-key-desc';
      desc.textContent = action;
      row.append(caps, desc);
      kbGrid.appendChild(row);
    }
    kbSection.append(kbLabel, kbGrid);

    // Primary Play Button with bottom-edge loading bar
    const engageBtn = document.createElement('button');
    engageBtn.type = 'button';
    engageBtn.className = 'fcs-engage-btn';
    engageBtn.disabled = true;

    const engageMainText = document.createElement('span');
    engageMainText.className = 'fcs-engage-main';
    engageMainText.textContent = 'Loading';

    const engageSubText = document.createElement('span');
    engageSubText.className = 'fcs-engage-sub';
    engageSubText.textContent = '';

    const engageLoader = document.createElement('span');
    engageLoader.className = 'fcs-engage-loader';
    const loaderFill = document.createElement('span');
    loaderFill.className = 'fcs-engage-fill';
    engageLoader.appendChild(loaderFill);

    engageBtn.append(engageMainText, engageSubText, engageLoader);

    modal.append(head, classSection, kbSection, engageBtn);
    backdrop.appendChild(modal);

    return {
      backdrop,
      loaderFill,
      engageBtn,
      engageMainText,
      engageSubText,
    };
  }
}
