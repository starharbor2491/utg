import { Peer, type DataConnection } from 'peerjs';
import type { VehicleClass } from './types';

export const DUEL_CLASSES: readonly VehicleClass[] = ['normal', 'heavy', 'ifv', 'humvee', 'rocket', 'support', 'littlebird', 'apache'];
const PREFIX = 'utg-duel-v1-';
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export type DuelStatus = 'connecting' | 'waiting' | 'connected' | 'error' | 'closed';
export const validCode = (code: string) => code.length === 6 && [...code].every((c) => ALPHABET.includes(c));
export const makeCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => ALPHABET[n & 31]).join('');

export function numberPacket(data: unknown, length: number): data is number[] {
  return Array.isArray(data) && data.length === length &&
    data.every((v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6);
}

export class DuelRoom {
  private peer?: Peer;
  private connection?: DataConnection;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastHeard = 0;
  private disposed = false;
  private ready = false;

  constructor(
    readonly host: boolean,
    readonly code: string,
    private readonly status: (state: DuelStatus, detail?: string) => void,
    private readonly receive: (data: unknown) => void,
  ) {}

  connect(): void {
    this.status('connecting');
    this.timer = setTimeout(() => this.fail(this.host ? 'Could not reach the room service. Try again.' :
      'Could not reach the host. Check the code and try again.'), 18000);
    try {
      if (this.disposed) return;
      const peer = this.host ? new Peer(PREFIX + this.code) : new Peer();
      this.peer = peer;
      peer.on('open', () => {
        if (this.host) {
          clearTimeout(this.timer);
          this.status('waiting');
        } else {
          this.attach(peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json', label: PREFIX }));
        }
      });
      peer.on('connection', (conn) => {
        if (!this.host || conn.label !== PREFIX || this.connection) { conn.close(); return; }
        this.attach(conn);
      });
      peer.on('error', (err) => {
        if (this.ready && (err.type === 'network' || err.type === 'disconnected' || err.type === 'server-error')) return;
        this.fail(err.type === 'peer-unavailable' ? 'Room not found. Check the code or ask the host for a new one.' :
          err.type === 'unavailable-id' ? 'That code is already in use. Host again for a new one.' :
          'Room connection failed. Try again. Both players need an internet connection.');
      });
    } catch {
      this.fail('Could not start 1v1. Try again.');
    }
  }

  private attach(conn: DataConnection): void {
    this.connection = conn;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => expire(), 15000);
    const expire = () => {
      if (this.ready) this.fail('Opponent disconnected.');
      else if (this.host) { this.connection = undefined; conn.close(); this.status('waiting'); }
      else this.fail('Could not connect to the host. Check the code and try again.');
    };
    conn.on('open', () => conn.send(PREFIX));
    conn.on('data', (data) => {
      if (this.connection !== conn || this.disposed) return;
      if (!this.ready) {
        if (data !== PREFIX) { expire(); return; }
        clearTimeout(this.timer);
        this.ready = true;
        this.lastHeard = performance.now();
        this.heartbeat = setInterval(() => {
          if (performance.now() - this.lastHeard > 12000) this.fail('Lost connection to your opponent.');
          else if (conn.open) conn.send('ping');
        }, 2000);
        this.status('connected');
        return;
      }
      this.lastHeard = performance.now();
      if (data === 'leave') { this.fail('Opponent left the duel.'); return; }
      if (data === 'ping') return;
      this.receive(data);
    });
    conn.on('close', () => { if (this.connection === conn && !this.disposed) expire(); });
    conn.on('error', () => { if (this.connection === conn && !this.disposed) expire(); });
  }

  private fail(message: string): void {
    if (this.disposed) return;
    const wasReady = this.ready;
    this.close();
    this.status(wasReady ? 'closed' : 'error', message);
  }

  send(packet: number[]): void {
    // Never build up a queue of obsolete input/snapshots on a congested connection.
    if (this.ready && this.connection?.open && this.connection.dataChannel.bufferedAmount < 65536) this.connection.send(packet);
  }

  close(): void {
    if (this.disposed) return;
    if (this.ready && this.connection?.open) this.connection.send('leave');
    this.disposed = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.connection?.close();
    this.peer?.destroy();
  }
}
