// DamageModel pure-math self-test — no browser, no three.js scene needed.
// Run: node scripts/damage-selftest.mjs
import assert from 'node:assert/strict';
import {
  DAMAGE_LAYOUTS,
  effectiveArmorMm,
  integrityState,
  isRicochet,
  moduleMaxIntegrity,
  postPenPathMm,
  rayBox,
} from '../src/game/DamageModel.ts';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  passed++;
  console.log(`  ok  ${name}`);
};

console.log('rayBox');
ok('ray hits box', rayBox(0, 0, -10, 0, 0, 1, 0, 0, 0, 1, 1, 1, 100) !== null);
ok('ray misses box', rayBox(5, 5, -10, 0, 0, 1, 0, 0, 0, 1, 1, 1, 100) === null);
ok('parallel outside slab misses', rayBox(5, 0, -10, 0, 0, 1, 0, 0, 0, 1, 1, 1, 100) === null);

console.log('effectiveArmorMm');
ok('normal incidence = mm', effectiveArmorMm(500, 1) === 500);
ok('60 deg doubles', Math.abs(effectiveArmorMm(500, 0.5) - 1000) < 1e-9);
ok('cos clamped at 0.26', Math.abs(effectiveArmorMm(500, 0.01) - 500 / 0.26) < 1e-6);

console.log('isRicochet');
ok('80 deg ricochets vs 500mm (600 pen < 1250)', isRicochet(500, 600, Math.cos((80 * Math.PI) / 180)));
ok('head-on never ricochets', !isRicochet(500, 600, 1));
ok('overmatch defeats ricochet', !isRicochet(500, 2000, Math.cos((80 * Math.PI) / 180)));
ok('72 deg boundary: cos72 ~0.309 not < 0.309', !isRicochet(500, 100, Math.cos((72 * Math.PI) / 180)));

console.log('postPenPathMm');
ok('min clamp 0.6', postPenPathMm(300, 399) === 0.6);
ok('grows with residual', postPenPathMm(600, 500) > 0.6);
ok('max clamp 3.5', postPenPathMm(99999, 0) === 3.5);

console.log('integrityState / moduleMaxIntegrity');
ok('ammo max integrity 1.2', moduleMaxIntegrity('ammo') === 1.2);
ok('engine max integrity 1.0', moduleMaxIntegrity('engine') === 1.0);
ok('state boundaries', integrityState(1.0) === 'ok' && integrityState(0.6) === 'damaged' && integrityState(0.3) === 'damaged' && integrityState(0) === 'destroyed');

console.log('DAMAGE_LAYOUTS class subsets');
const ids = (c) => new Set(DAMAGE_LAYOUTS[c].modules.map((m) => m.id));
const normal = ids('normal');
ok('normal has loader', normal.has('loader'));
ok('normal has both tracks', normal.has('track_left') && normal.has('track_right'));
ok('ifv has no loader', !ids('ifv').has('loader'));
ok('ifv has turret_ring', ids('ifv').has('turret_ring'));
ok('humvee wheels not tracks', ids('humvee').has('wheels_left') && !ids('humvee').has('track_left'));
ok('humvee has turret_ring (MG ring)', ids('humvee').has('turret_ring'));
ok('rocket has launcher, no gun', ids('rocket').has('launcher') && !ids('rocket').has('gun'));
ok('rocket has wheels', ids('rocket').has('wheels_left'));
ok('armour tables sane', DAMAGE_LAYOUTS.normal.hullArmor.front === 500 && DAMAGE_LAYOUTS.heavy.hullArmor.front === 650 && DAMAGE_LAYOUTS.ifv.hullArmor.front === 60);
ok('softSkin flags', DAMAGE_LAYOUTS.humvee.softSkin === true && DAMAGE_LAYOUTS.rocket.softSkin === true && DAMAGE_LAYOUTS.normal.softSkin === false);

console.log(`\n${passed} checks passed`);
