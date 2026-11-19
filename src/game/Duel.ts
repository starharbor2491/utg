import { Peer, type DataConnection } from 'peerjs';
import type { VehicleClass } from './types';

export const DUEL_CLASSES: readonly VehicleClass[] = ['normal', 'heavy', 'ifv', 'humvee', 'rocket', 'support', 'littlebird', 'apache'];
const PREFIX = 'utg-duel-v2-';
const READY = 5, LOBBY = 6, ACK_START = 7, START = 8;
const COUNTDOWN_MS = 3000;
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export type DuelStatus = 'connecting' | 'waiting' | 'connected' | 'error' | 'closed';
export interface DuelLobbyView {
  localReady: boolean;
  opponentReady: boolean;
  countdown: number;
  starting: boolean;
}
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
  private connected = false;
  private localReady = false;
  private opponentReady = false;
  private guestRevision = 0;
  private countdownEnd = 0;
  private countdownTimer?: ReturnType<typeof setTimeout>;
  private starting = false;
  private inBattle = false;

  constructor(
    readonly host: boolean,
    readonly code: string,
    private readonly status: (state: DuelStatus, detail?: string) => void,
    private readonly receive: (data: unknown) => void,
    private readonly lobby: (state: DuelLobbyView) => void,
    private readonly enterBattle: () => void,
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
        if (this.connected && (err.type === 'network' || err.type === 'disconnected' || err.type === 'server-error')) return;
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
      if (this.connected) this.fail(this.inBattle ? 'Opponent disconnected.' : 'Opponent disconnected before the battle.');
      else if (this.host) { clearTimeout(this.timer); this.connection = undefined; conn.close(); this.status('waiting'); }
      else this.fail('Could not connect to the host. Check the code and try again.');
    };
    conn.on('open', () => conn.send(PREFIX));
    conn.on('data', (data) => {
      if (this.connection !== conn || this.disposed) return;
      if (!this.connected) {
        if (data !== PREFIX) { expire(); return; }
        clearTimeout(this.timer);
        this.connected = true;
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
      if (Array.isArray(data) && this.receiveLobby(data)) return;
      this.receive(data);
    });
    conn.on('close', () => { if (this.connection === conn && !this.disposed) expire(); });
    conn.on('error', () => { if (this.connection === conn && !this.disposed) expire(); });
  }

  toggleReady(): void {
    if (!this.connected || this.disposed || this.inBattle || this.starting) return;
    this.localReady = !this.localReady;
    if (this.host) this.refreshCountdown();
    else {
      this.send([READY, Number(this.localReady), ++this.guestRevision], true);
      this.showLobby(0);
    }
  }

  private showLobby(countdown: number): void {
    this.lobby({ localReady: this.localReady, opponentReady: this.opponentReady, countdown, starting: this.starting });
  }

  private refreshCountdown(): void {
    clearTimeout(this.countdownTimer);
    if (!this.localReady || !this.opponentReady) {
      this.countdownEnd = 0;
      this.starting = false;
      this.publishLobby(0);
      return;
    }
    if (!this.countdownEnd) this.countdownEnd = performance.now() + COUNTDOWN_MS;
    const left = this.countdownEnd - performance.now();
    if (left <= 0) {
      // Commit only after the guest confirms it hasn't withdrawn during the countdown.
      this.starting = true;
      this.publishLobby(-1);
    } else {
      const seconds = Math.ceil(left / 1000);
      this.publishLobby(seconds);
      this.countdownTimer = setTimeout(() => this.refreshCountdown(), Math.ceil(left - (seconds - 1) * 1000));
    }
  }

  private publishLobby(countdown: number): void {
    this.send([LOBBY, Number(this.localReady) | (Number(this.opponentReady) << 1), this.guestRevision, countdown], true);
    this.showLobby(Math.max(0, countdown));
  }

  private receiveLobby(data: unknown[]): boolean {
    const kind = data[0];
    if (kind !== READY && kind !== LOBBY && kind !== ACK_START && kind !== START) return false;
    if (this.inBattle) return true;
    if (this.host) {
      if (kind === READY && numberPacket(data, 3) && (data[1] === 0 || data[1] === 1) &&
        data[2] === this.guestRevision + 1 && !!data[1] !== this.opponentReady) {
        this.guestRevision = data[2];
        this.opponentReady = !!data[1];
        this.refreshCountdown();
      } else if (kind === ACK_START && numberPacket(data, 2) && data[1] === this.guestRevision &&
        this.starting && this.localReady && this.opponentReady) {
        this.send([START], true);
        this.inBattle = true;
        this.enterBattle();
      }
    } else if (kind === LOBBY && numberPacket(data, 4) && Number.isInteger(data[1]) && data[1] >= 0 && data[1] <= 3 &&
      Number.isInteger(data[3]) && data[3] >= -1 && data[3] <= 3) {
      this.opponentReady = !!(data[1] & 1);
      const both = this.localReady && data[1] === 3 && data[2] === this.guestRevision;
      if (both && data[3] === -1) {
        this.starting = true;
        this.send([ACK_START, this.guestRevision], true);
      }
      this.showLobby(both ? Math.max(0, data[3]) : 0);
    } else if (kind === START && data.length === 1 && this.starting) {
      this.inBattle = true;
      this.enterBattle();
    }
    return true;
  }

  private fail(message: string): void {
    if (this.disposed) return;
    const wasConnected = this.connected;
    this.close();
    this.status(wasConnected ? 'closed' : 'error', message);
  }

  send(packet: number[], reliable = false): void {
    // Only drop superseded gameplay samples, never lobby transitions.
    if (this.connected && this.connection?.open && (reliable || this.connection.dataChannel.bufferedAmount < 65536)) this.connection.send(packet);
  }

  close(): void {
    if (this.disposed) return;
    if (this.connected && this.connection?.open) this.connection.send('leave');
    this.disposed = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    clearTimeout(this.countdownTimer);
    this.connection?.close();
    this.peer?.destroy();
  }
}
