/**
 * Session layer: clean, lossless reconnection.
 *
 * The controller's link is expected to die — a successful lockdown disables the
 * Wi-Fi it was travelling over. So the protocol is built so that losing the
 * connection at any instant is uneventful:
 *
 *  - `seq` is a per-FRAME transport sequence number. It must strictly advance,
 *    which is what detects reordered and delayed frames.
 *  - `commandId` is a per-COMMAND identity. It is stable across every retry.
 *
 * Keeping these separate is what makes resume work. A command that may or may
 * not have been delivered is resent with the SAME commandId and a FRESH seq:
 *   - if the device already processed it, the commandId is in the seen-set and
 *     the device replies with the stored result, applying nothing twice;
 *   - if it never arrived, the fresh seq passes the ordering check and it is
 *     processed exactly once.
 * Either way the controller learns the true outcome and the device's state is
 * identical to the no-failure case.
 *
 * On reconnect, HELLO/HELLO_ACK exchanges high-water marks and the device's
 * current lockdown state, so the controller re-synchronises from facts rather
 * than from assumptions about what happened while it was away.
 */

import type { CommandResult, LockdownState } from '../core/types.ts';
import type { CommandPayload } from './envelope.ts';

export type Hello = {
  readonly type: 'HELLO';
  /** Random per controller process; lets the device correlate resumes in its log. */
  readonly sessionId: string;
  /** Highest frame seq the controller believes it has sent. */
  readonly lastSentSeq: number;
  readonly sentAt: number;
};

export type HelloAck = {
  readonly type: 'HELLO_ACK';
  /** Highest frame seq the device has accepted. The controller resumes above it. */
  readonly highestSeq: number;
  readonly state: LockdownState;
  readonly lockdownId: string | null;
  readonly restoreDeadline: number | null;
  readonly serverTime: number;
  /** commandIds the device has already processed, so the controller can settle its outbox. */
  readonly processed: readonly string[];
};

export type CommandFrame = {
  readonly type: 'COMMAND';
  readonly command: CommandPayload;
};

export type ReplyFrame = {
  readonly type: 'REPLY';
  readonly inReplyTo: string;
  readonly seq: number;
  readonly result: CommandResult;
  /** True when the reply came from the exactly-once cache rather than fresh work. */
  readonly cached: boolean;
};

export type RejectFrame = {
  readonly type: 'REJECT';
  readonly inReplyTo: string | null;
  readonly code: string;
  readonly reason: string;
};

export type Ping = { readonly type: 'PING'; readonly at: number };
export type Pong = { readonly type: 'PONG'; readonly at: number; readonly state: LockdownState };

export type ControllerMessage = Hello | CommandFrame | Ping;
export type DeviceMessage = HelloAck | ReplyFrame | RejectFrame | Pong;
export type SessionMessage = ControllerMessage | DeviceMessage;

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 20_000;
export const DEFAULT_PORT = 8731;
/** Commands are short-lived, which is what makes a delayed frame harmless. */
export const COMMAND_TTL_MS = 15_000;

export function isControllerMessage(value: unknown): value is ControllerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'HELLO' || t === 'COMMAND' || t === 'PING';
}

export function isDeviceMessage(value: unknown): value is DeviceMessage {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'HELLO_ACK' || t === 'REPLY' || t === 'REJECT' || t === 'PONG';
}
