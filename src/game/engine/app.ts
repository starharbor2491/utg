import type { AppBase, GraphicsDevice } from 'playcanvas';

/** Installed engine major.minor; chunk overrides are written against this version. */
export const SHADER_CHUNKS_VERSION = '2.24';

let current: AppBase | null = null;

export function setApp(app: AppBase): void {
  current = app;
}

export function getApp(): AppBase {
  if (!current) throw new Error('PlayCanvas app has not been created yet');
  return current;
}

export function getDevice(): GraphicsDevice {
  return getApp().graphicsDevice;
}
