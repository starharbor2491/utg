import type { ModuleHealthState, ModuleId, ShellHitXRayReport } from './types';

interface ModuleBoxVis {
  id: ModuleId;
  shortName: string;
  space: 'hull' | 'turret';
  isCrew: boolean;
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Exact 3D internal module & crew layout matching Tank.ts hitboxes:
 * - Hull space: +Z forward, +Y up (0 = track bottom), +X vehicle left.
 * - Turret space: relative to turret pivot [0, 1.62, -0.50].
 */
export const MBT_INTERNAL_MODULES: readonly ModuleBoxVis[] = [
  {
    id: 'track_left',
    shortName: 'L-TRACK',
    space: 'hull',
    isCrew: false,
    min: [1.22, 0.05, -3.55],
    max: [1.86, 0.92, 3.45],
  },
  {
    id: 'track_right',
    shortName: 'R-TRACK',
    space: 'hull',
    isCrew: false,
    min: [-1.86, 0.05, -3.55],
    max: [-1.22, 0.92, 3.45],
  },
  {
    id: 'engine',
    shortName: 'ENGINE',
    space: 'hull',
    isCrew: false,
    min: [-1.05, 0.35, -3.75],
    max: [1.05, 1.42, -1.55],
  },
  {
    id: 'ammo_hull',
    shortName: 'HULL AMMO',
    space: 'hull',
    isCrew: false,
    min: [-0.46, 0.26, -0.85],
    max: [0.46, 0.62, 0.12],
  },
  {
    id: 'driver',
    shortName: 'DRIVER',
    space: 'hull',
    isCrew: true,
    min: [-0.62, 0.45, 1.35],
    max: [0.18, 1.42, 2.75],
  },
  {
    id: 'turret_ring',
    shortName: 'TURRET RING',
    space: 'hull',
    isCrew: false,
    min: [-1.08, 1.38, -1.55],
    max: [1.08, 1.66, 0.55],
  },
  {
    id: 'cannon_breech',
    shortName: 'BREECH / GUN',
    space: 'turret',
    isCrew: false,
    min: [-0.34, 0.12, -0.45],
    max: [0.34, 0.66, 4.95],
  },
  {
    id: 'gunner',
    shortName: 'GUNNER',
    space: 'turret',
    isCrew: true,
    min: [-0.98, 0.05, -0.65],
    max: [-0.36, 0.88, 0.48],
  },
  {
    id: 'loader',
    shortName: 'LOADER',
    space: 'turret',
    isCrew: true,
    min: [0.36, 0.05, -0.82],
    max: [0.98, 0.88, 0.35],
  },
  {
    id: 'ammo_bustle',
    shortName: 'AMMO RACK',
    space: 'turret',
    isCrew: false,
    min: [-0.84, 0.24, -2.68],
    max: [0.84, 0.72, -1.55],
  },
];

const BOX_EDGES: readonly [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * War Thunder-style Top-Right 3D X-Ray Ballistic Hit Camera & Internal Injury Readout.
 */
export class HitCam {
  private readonly rootEl: HTMLDivElement;
  private readonly headerZoneEl: HTMLSpanElement;
  private readonly headerStatusEl: HTMLSpanElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hpFillEl: HTMLDivElement;
  private readonly injuryListEl: HTMLDivElement;

  private activeReport: ShellHitXRayReport | null = null;
  private displayTimer = 0;
  private animElapsed = 0;
  private readonly TOTAL_DURATION = 5.2;
  private readonly REPLAY_DURATION = 0.92;

  constructor(parent: HTMLElement) {
    this.rootEl = document.createElement('div');
    this.rootEl.className = 'hud-plate';
    this.rootEl.style.cssText = [
      'position:fixed',
      'top:18px',
      'right:18px',
      'width:296px',
      'padding:8px 10px 10px',
      'background:rgba(12,16,13,0.92)',
      'border:1px solid rgba(232,169,56,0.38)',
      'display:none',
      'flex-direction:column',
      'gap:6px',
      'z-index:25',
      'pointer-events:none',
      'box-shadow:0 8px 24px rgba(0,0,0,0.65)',
    ].join(';');

    const topBar = document.createElement('div');
    topBar.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;gap:6px;border-bottom:1px solid rgba(232,169,56,0.22);padding-bottom:4px;';

    this.headerZoneEl = document.createElement('span');
    this.headerZoneEl.style.cssText =
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;font-weight:700;letter-spacing:0.12em;color:#e8a938;';
    this.headerZoneEl.textContent = 'X-RAY // IMPACT';

    this.headerStatusEl = document.createElement('span');
    this.headerStatusEl.style.cssText =
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;font-weight:700;letter-spacing:0.1em;color:#eae6dc;';
    this.headerStatusEl.textContent = 'PENETRATION';

    topBar.append(this.headerZoneEl, this.headerStatusEl);

    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText =
      'position:relative;width:286px;height:164px;background:radial-gradient(circle at 50% 52%, rgba(26,38,30,0.65) 0%, rgba(7,10,8,0.96) 100%);border:1px solid rgba(143,168,118,0.28);overflow:hidden;';

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:286px;height:164px;display:block;';
    this.ctx = this.canvas.getContext('2d')!;
    canvasWrap.appendChild(this.canvas);

    // Enemy Structural Integrity Bar
    const hpWrap = document.createElement('div');
    hpWrap.style.cssText =
      'width:100%;height:4px;background:rgba(255,255,255,0.08);border:1px solid rgba(234,230,220,0.16);';
    this.hpFillEl = document.createElement('div');
    this.hpFillEl.style.cssText = 'height:100%;width:100%;background:#d94636;transition:width 140ms ease-out;';
    hpWrap.appendChild(this.hpFillEl);

    this.injuryListEl = document.createElement('div');
    this.injuryListEl.style.cssText =
      'display:flex;flex-direction:column;gap:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;letter-spacing:0.05em;';

    this.rootEl.append(topBar, canvasWrap, hpWrap, this.injuryListEl);
    parent.appendChild(this.rootEl);
  }

  public showHit(report: ShellHitXRayReport): void {
    // Do not overwrite an active cannon X-ray replay with a minor MG plink unless MG damaged a module!
    if (
      report.weapon === 'mg' &&
      report.hitModules.length === 0 &&
      !report.killed &&
      this.displayTimer > 1.2 &&
      this.activeReport?.weapon === 'cannon'
    ) {
      this.activeReport.hpRemaining = report.hpRemaining;
      const pct = Math.max(0, Math.min(100, (report.hpRemaining / report.maxHp) * 100));
      this.hpFillEl.style.width = `${pct.toFixed(0)}%`;
      return;
    }

    this.activeReport = report;
    this.displayTimer = report.killed ? 5.8 : this.TOTAL_DURATION;
    this.animElapsed = 0;
    this.rootEl.style.display = 'flex';
    this.rootEl.style.opacity = '1';

    this.headerZoneEl.textContent = `HIT // ${report.armorZone}`;
    if (report.killed) {
      this.headerStatusEl.textContent = report.killReason ?? 'TARGET DESTROYED';
      this.headerStatusEl.style.color = '#ff4b3a';
      this.rootEl.style.borderColor = 'rgba(217,70,54,0.75)';
    } else if (report.hitModules.length > 0) {
      this.headerStatusEl.textContent = 'CRITICAL DAMAGE';
      this.headerStatusEl.style.color = '#e8a938';
      this.rootEl.style.borderColor = 'rgba(232,169,56,0.52)';
    } else {
      this.headerStatusEl.textContent = report.weapon === 'cannon' ? 'SPALLING HIT' : 'ARMOR GRAZE';
      this.headerStatusEl.style.color = '#eae6dc';
      this.rootEl.style.borderColor = 'rgba(232,169,56,0.34)';
    }

    const pct = Math.max(0, Math.min(100, (report.hpRemaining / report.maxHp) * 100));
    this.hpFillEl.style.width = `${pct.toFixed(0)}%`;

    this.injuryListEl.innerHTML = '';
    if (report.killed && report.killReason) {
      const fatalRow = document.createElement('div');
      fatalRow.style.cssText =
        'padding:3px 6px;background:rgba(217,70,54,0.22);border-left:2px solid #ff4b3a;color:#ffd3ce;font-weight:700;';
      fatalRow.textContent = `■ ${report.killReason}`;
      this.injuryListEl.appendChild(fatalRow);
    }

    if (report.hitModules.length === 0 && !report.killed) {
      const row = document.createElement('div');
      row.style.cssText = 'color:rgba(234,230,220,0.72);padding:2px 4px;';
      row.textContent =
        report.weapon === 'cannon'
          ? '• HULL STRUCTURAL SHOCK (NO VITAL MODULE HIT)'
          : '• SUPERFICIAL 7.62MM RICOCHET';
      this.injuryListEl.appendChild(row);
    } else {
      const shown = report.hitModules.slice(0, 4);
      for (const m of shown) {
        const row = document.createElement('div');
        const isDead = m.newState === 'destroyed';
        row.style.cssText = `padding:2px 6px;background:${
          isDead ? 'rgba(217,70,54,0.15)' : 'rgba(232,169,56,0.12)'
        };border-left:2px solid ${isDead ? '#ff4b3a' : '#e8a938'};color:${
          isDead ? '#ffb8b0' : '#f5d996'
        };font-weight:600;`;
        row.textContent = `${isDead ? '✖' : '▲'} ${m.label}: ${m.effectText}`;
        this.injuryListEl.appendChild(row);
      }
    }
  }

  public update(dt: number): void {
    if (!this.activeReport || this.displayTimer <= 0) {
      this.rootEl.style.display = 'none';
      return;
    }

    this.displayTimer -= dt;
    this.animElapsed += dt;

    if (this.displayTimer <= 0) {
      this.rootEl.style.display = 'none';
      this.activeReport = null;
      return;
    }

    if (this.displayTimer < 0.45) {
      this.rootEl.style.opacity = (this.displayTimer / 0.45).toFixed(2);
    }

    this.renderXRayCanvas(this.activeReport);
  }

  private renderXRayCanvas(rep: ShellHitXRayReport): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 286;
    const h = 164;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Subtle X-ray background gridlines
    ctx.strokeStyle = 'rgba(143, 168, 118, 0.08)';
    ctx.lineWidth = 1;
    for (let gx = 24; gx < w; gx += 24) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.stroke();
    }
    for (let gy = 24; gy < h; gy += 24) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    // Choose 3/4 X-ray camera angle facing the impacted side of the tank!
    const [ex, , ez] = rep.entryLocal;
    const rawImpactAz = Math.atan2(ex, ez);
    // Offset slightly toward a readable 3/4 isometric perspective if dead-on front/back
    let camAz = rawImpactAz;
    if (Math.abs(Math.sin(camAz)) < 0.45) {
      camAz += (ex >= 0 ? 1 : -1) * 0.55;
    }
    const camEl = 0.36;
    const cosAz = Math.cos(camAz);
    const sinAz = Math.sin(camAz);
    const cosEl = Math.cos(camEl);
    const sinEl = Math.sin(camEl);

    const scale = 25.5;
    const cx = w * 0.5;
    const cy = h * 0.58;

    const project = (px: number, py: number, pz: number): [number, number, number] => {
      const cyShift = py - 1.35;
      // Rotate around Y by -camAz so camera at camAz looks toward origin
      const rx = px * cosAz - pz * sinAz;
      const rz = px * sinAz + pz * cosAz;
      // Pitch by camEl
      const sy = cyShift * cosEl - rz * sinEl;
      const depth = cyShift * sinEl + rz * cosEl;
      return [cx + rx * scale, cy - sy * scale, depth];
    };

    const turretToHull = (tx: number, ty: number, tz: number): [number, number, number] => {
      const c = Math.cos(rep.turretRelYaw);
      const s = Math.sin(rep.turretRelYaw);
      // Matches Three.js rotation.y = yaw: x' = x*cos + z*sin, z' = -x*sin + z*cos
      return [
        tx * c + tz * s,
        1.62 + ty,
        -0.5 + (-tx * s + tz * c),
      ];
    };

    const drawWireBox = (
      min: [number, number, number],
      max: [number, number, number],
      inTurret: boolean,
      stroke: string,
      fill: string | null,
      lineW = 1
    ): [number, number] => {
      const corners: [number, number, number][] = [
        [min[0], min[1], min[2]],
        [max[0], min[1], min[2]],
        [max[0], min[1], max[2]],
        [min[0], min[1], max[2]],
        [min[0], max[1], min[2]],
        [max[0], max[1], min[2]],
        [max[0], max[1], max[2]],
        [min[0], max[1], max[2]],
      ];

      const pts = corners.map(([x, y, z]) => {
        const [hx, hy, hz] = inTurret ? turretToHull(x, y, z) : [x, y, z];
        return project(hx, hy, hz);
      });

      if (fill) {
        // Fill bounding 2D silhouette approximation (top + front/side quad)
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(pts[4][0], pts[4][1]);
        ctx.lineTo(pts[5][0], pts[5][1]);
        ctx.lineTo(pts[6][0], pts[6][1]);
        ctx.lineTo(pts[7][0], pts[7][1]);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        ctx.lineTo(pts[1][0], pts[1][1]);
        ctx.lineTo(pts[5][0], pts[5][1]);
        ctx.lineTo(pts[4][0], pts[4][1]);
        ctx.closePath();
        ctx.fill();
      }

      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      for (const [a, b] of BOX_EDGES) {
        ctx.moveTo(pts[a][0], pts[a][1]);
        ctx.lineTo(pts[b][0], pts[b][1]);
      }
      ctx.stroke();

      let sumX = 0;
      let sumY = 0;
      for (const p of pts) {
        sumX += p[0];
        sumY += p[1];
      }
      return [sumX / 8, sumY / 8];
    };

    // 1. Draw Ghostly X-Ray Outer MBT Armor Wireframe (Sloped Hull + Road Wheels + Rotated Turret)
    drawWireBox(
      [-1.85, 0.35, -3.95],
      [1.85, 1.56, 3.82],
      false,
      'rgba(165, 200, 185, 0.28)',
      'rgba(40, 62, 52, 0.14)',
      1.05
    );

    // 7 Road wheel circles per side for authentic MBT X-ray silhouette
    ctx.strokeStyle = 'rgba(165, 200, 185, 0.22)';
    ctx.lineWidth = 0.9;
    for (const sideX of [-1.52, 1.52]) {
      for (let wIdx = 0; wIdx < 7; wIdx++) {
        const wz = 2.7 - wIdx * 0.83;
        const [wx, wy] = project(sideX, 0.44, wz);
        ctx.beginPath();
        ctx.arc(wx, wy, 0.34 * scale * 0.72, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Outer Turret Shell & 120mm Gun Barrel
    drawWireBox(
      [-1.48, 0.0, -2.95],
      [1.48, 0.98, 1.35],
      true,
      'rgba(175, 212, 196, 0.34)',
      'rgba(46, 70, 58, 0.14)',
      1.1
    );
    drawWireBox(
      [-0.14, 0.28, 1.35],
      [0.14, 0.52, 5.45],
      true,
      'rgba(175, 212, 196, 0.38)',
      null,
      1.1
    );

    // 2. Animation timeline: 0..0.24s incoming shell, 0.24..1.0s internal penetration + spall
    const tNorm = Math.min(1.35, this.animElapsed / this.REPLAY_DURATION);
    const approachT = Math.min(1, tNorm / 0.26);
    const internalT = Math.max(0, Math.min(1, (tNorm - 0.26) / 0.74));

    const hitTimingMap = new Map<ModuleId, { state: ModuleHealthState; t: number }>();
    for (const hm of rep.hitModules) {
      hitTimingMap.set(hm.id, { state: hm.newState, t: hm.hitTime01 });
    }

    const placedLabels: [number, number][] = [];

    // 3. Draw all 10 internal modules & crew (lit up as the shell/spall wave reaches them!)
    for (const mod of MBT_INTERNAL_MODULES) {
      const hitInfo = hitTimingMap.get(mod.id);
      const postState = rep.allModuleStates[mod.id];

      let stateToRender: ModuleHealthState = 'ok';
      let justStruckFlash = 0;

      if (hitInfo) {
        if (internalT >= hitInfo.t) {
          stateToRender = hitInfo.state;
          justStruckFlash = Math.max(0, 1 - (internalT - hitInfo.t) * 3.5);
        }
      } else if (postState !== 'ok') {
        // Previously damaged module from an earlier shot
        stateToRender = postState;
      }

      let stroke = mod.isCrew ? 'rgba(130, 195, 215, 0.26)' : 'rgba(143, 168, 118, 0.24)';
      let fill: string | null = null;
      let lw = 0.9;

      if (stateToRender === 'damaged') {
        stroke = justStruckFlash > 0.2 ? '#fff4cc' : '#e8a938';
        fill = 'rgba(232, 169, 56, 0.26)';
        lw = 1.45;
      } else if (stateToRender === 'destroyed') {
        stroke = justStruckFlash > 0.2 ? '#ffffff' : '#ff4b3a';
        fill = 'rgba(225, 56, 42, 0.36)';
        lw = 1.65;
      }

      const [labelX, labelY] = drawWireBox(
        mod.min,
        mod.max,
        mod.space === 'turret',
        stroke,
        fill,
        lw
      );

      // Draw crew head sphere on top of crew torso box
      if (mod.isCrew) {
        const cxLocal = (mod.min[0] + mod.max[0]) * 0.5;
        const czLocal = (mod.min[2] + mod.max[2]) * 0.5;
        const hyLocal = mod.max[1] + 0.14;
        const [hx, hy, hz] =
          mod.space === 'turret'
            ? turretToHull(cxLocal, hyLocal, czLocal)
            : [cxLocal, hyLocal, czLocal];
        const [px, py] = project(hx, hy, hz);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.arc(px, py, 3.6, 0, Math.PI * 2);
        if (fill) {
          ctx.fillStyle = fill;
          ctx.fill();
        }
        ctx.stroke();
      }

      // Floating tag on newly struck modules (de-overlapped so wireframe stays crisp)
      if (hitInfo && internalT >= hitInfo.t) {
        const collides = placedLabels.some(
          ([px, py]) => Math.abs(px - labelX) < 52 && Math.abs(py - (labelY - 3)) < 12
        );
        if (!collides) {
          placedLabels.push([labelX, labelY - 3]);
          ctx.font = 'bold 8.5px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'center';
          ctx.fillStyle = stateToRender === 'destroyed' ? '#ffd0ca' : '#ffe6ad';
          ctx.fillText(mod.shortName, labelX, labelY - 3);
        }
      }
    }

    // 4. Draw Incoming Shell Trajectory, Entry Flash & Internal Spall Shrapnel Cone
    const [ex0, ey0, ez0] = rep.entryLocal;
    const [dx, dy, dz] = rep.dirLocal;
    const outerStartDist = 2.6;
    const sx0 = ex0 - dx * outerStartDist;
    const sy0 = ey0 - dy * outerStartDist;
    const sz0 = ez0 - dz * outerStartDist;

    const curEntryX = sx0 + (ex0 - sx0) * approachT;
    const curEntryY = sy0 + (ey0 - sy0) * approachT;
    const curEntryZ = sz0 + (ez0 - sz0) * approachT;

    const [pOutX, pOutY] = project(sx0, sy0, sz0);
    const [pImpactX, pImpactY] = project(curEntryX, curEntryY, curEntryZ);

    // Incoming trajectory dashed line + hot shell bolt
    ctx.strokeStyle = 'rgba(232, 169, 56, 0.78)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pOutX, pOutY);
    ctx.lineTo(pImpactX, pImpactY);
    ctx.stroke();
    ctx.setLineDash([]);

    if (approachT < 1) {
      ctx.fillStyle = '#fff5d6';
      ctx.beginPath();
      ctx.arc(pImpactX, pImpactY, 3.4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const [pEntryX, pEntryY] = project(ex0, ey0, ez0);
      const [pxEnd, pyEnd, pzEnd] = rep.penEndLocal;
      const curPenX = ex0 + (pxEnd - ex0) * internalT;
      const curPenY = ey0 + (pyEnd - ey0) * internalT;
      const curPenZ = ez0 + (pzEnd - ez0) * internalT;
      const [pPenX, pPenY] = project(curPenX, curPenY, curPenZ);

      // Spall shrapnel cone streaks
      for (const ray of rep.spallRays) {
        const [rsx, rsy, rsz] = ray.start;
        const [rex, rey, rez] = ray.end;
        const rx = rsx + (rex - rsx) * internalT;
        const ry = rsy + (rey - rsy) * internalT;
        const rz = rsz + (rez - rsz) * internalT;
        const [psX, psY] = project(rsx, rsy, rsz);
        const [peX, peY] = project(rx, ry, rz);

        ctx.strokeStyle = ray.hitModule
          ? 'rgba(255, 92, 64, 0.88)'
          : 'rgba(232, 169, 56, 0.45)';
        ctx.lineWidth = ray.hitModule ? 1.35 : 0.9;
        ctx.beginPath();
        ctx.moveTo(psX, psY);
        ctx.lineTo(peX, peY);
        ctx.stroke();
      }

      // Main penetrator core beam inside armor
      ctx.strokeStyle = '#ffdf9e';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(pEntryX, pEntryY);
      ctx.lineTo(pPenX, pPenY);
      ctx.stroke();

      // Glowing penetrator head
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(pPenX, pPenY, 2.8, 0, Math.PI * 2);
      ctx.fill();

      // Armor entry breach starburst
      const pulse = 5.5 + Math.sin(this.animElapsed * 18) * 1.4;
      const grad = ctx.createRadialGradient(pEntryX, pEntryY, 0.5, pEntryX, pEntryY, pulse * 1.9);
      grad.addColorStop(0, 'rgba(255, 250, 220, 0.95)');
      grad.addColorStop(0.45, 'rgba(255, 110, 48, 0.78)');
      grad.addColorStop(1, 'rgba(217, 70, 54, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(pEntryX, pEntryY, pulse * 1.9, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}
