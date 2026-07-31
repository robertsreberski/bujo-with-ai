import type { Request, RequestHandler } from 'express';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import { HttpError } from './errors.js';

export const DEVICE_COOKIE = 'journal_device';
export const DEVICE_COOKIE_TTL_MS = 365 * 24 * 60 * 60 * 1_000;

export interface DeviceIdentity {
  deviceId: string;
  expiresAt: string;
}

export interface DeviceAuthenticator {
  pairDevice(
    label?: string,
  ): (DeviceIdentity & { secret: string }) | Promise<DeviceIdentity & { secret: string }>;
  authenticateDevice(secret: string): DeviceIdentity | null | Promise<DeviceIdentity | null>;
}

declare global {
  // Express exposes request augmentation through its global namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      device?: DeviceIdentity;
    }
  }
}

function normalizeAuthority(authority: string): string {
  return authority.trim().toLowerCase().replace(/\.$/, '');
}

function targetFromOrigin(
  origin: string,
): { protocol: 'http:' | 'https:'; authority: string } | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { protocol: url.protocol, authority: normalizeAuthority(url.host) };
  } catch {
    return null;
  }
}

function requestAuthority(request: Request): string {
  return normalizeAuthority(request.get('host') ?? '');
}

export function createHostGuard(hostAllowlist: readonly string[]): RequestHandler {
  const allowed = new Set(hostAllowlist.map(normalizeAuthority));
  return (request, _response, next) => {
    const authority = requestAuthority(request);
    if (!authority || !allowed.has(authority)) {
      next(new HttpError(403, 'host_not_allowed', 'Host is not allowed.'));
      return;
    }
    next();
  };
}

export function createOriginGuard(options: {
  hostAllowlist: readonly string[];
  requireOrigin?: boolean;
}): RequestHandler {
  const allowed = new Set(options.hostAllowlist.map(normalizeAuthority));
  return (request, _response, next) => {
    const origin = request.get('origin');
    if (!origin) {
      if (options.requireOrigin === true) {
        next(new HttpError(403, 'origin_required', 'A same-origin request is required.'));
        return;
      }
      next();
      return;
    }

    const originTarget = targetFromOrigin(origin);
    const requestProtocol = `${request.protocol.toLowerCase()}:`;
    if (
      !originTarget ||
      originTarget.protocol !== requestProtocol ||
      !allowed.has(originTarget.authority) ||
      originTarget.authority !== requestAuthority(request)
    ) {
      next(new HttpError(403, 'origin_not_allowed', 'Origin is not allowed.'));
      return;
    }
    next();
  };
}

export function isSecureRequest(request: Request, production: boolean): boolean {
  return production || request.secure;
}

export function parseDeviceCredential(request: Request): string | null {
  const raw = parseCookie(request.get('cookie') ?? '')[DEVICE_COOKIE];
  return raw && /^[A-Za-z0-9_-]{32,}$/.test(raw) ? raw : null;
}

export function createPairHandler(options: {
  devices: DeviceAuthenticator;
  production: boolean;
}): RequestHandler {
  return async (request, response, next) => {
    try {
      const label =
        typeof request.body === 'object' &&
        request.body !== null &&
        typeof (request.body as { label?: unknown }).label === 'string'
          ? (request.body as { label: string }).label.slice(0, 80)
          : undefined;
      const device = await options.devices.pairDevice(label);

      response.setHeader(
        'Set-Cookie',
        serializeCookie(DEVICE_COOKIE, device.secret, {
          httpOnly: true,
          sameSite: 'strict',
          secure: isSecureRequest(request, options.production),
          path: '/',
          expires: new Date(device.expiresAt),
          maxAge: Math.floor(DEVICE_COOKIE_TTL_MS / 1_000),
        }),
      );
      response.status(201).json({ deviceId: device.deviceId, expiresAt: device.expiresAt });
    } catch (error) {
      next(error);
    }
  };
}

export function createDeviceAuth(devices: DeviceAuthenticator): RequestHandler {
  return async (request, _response, next) => {
    try {
      const credential = parseDeviceCredential(request);
      if (!credential) {
        next(new HttpError(401, 'unauthenticated', 'Pair this device before using the app API.'));
        return;
      }
      const device = await devices.authenticateDevice(credential);
      if (!device || Date.parse(device.expiresAt) <= Date.now()) {
        next(new HttpError(401, 'unauthenticated', 'Device pairing is invalid or expired.'));
        return;
      }
      request.device = device;
      next();
    } catch (error) {
      next(error);
    }
  };
}
