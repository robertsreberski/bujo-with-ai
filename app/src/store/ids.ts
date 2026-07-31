const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTimestamp = -1;
let lastRandom = new Array<number>(16).fill(0);

function encodeTimestamp(timestamp: number): string {
  let remaining = timestamp;
  const encoded = new Array<string>(10);
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = CROCKFORD[remaining % 32] ?? '0';
    remaining = Math.floor(remaining / 32);
  }
  if (remaining !== 0) throw new RangeError('Timestamp exceeds ULID range.');
  return encoded.join('');
}

function randomDigits(): number[] {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value & 31);
}

function incrementRandom(digits: number[]): number[] {
  const next = [...digits];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const value = (next[index] ?? 0) + 1;
    next[index] = value & 31;
    if (value < 32) return next;
  }
  throw new RangeError('ULID monotonic random component overflowed.');
}

/** Creates a monotonic, Crockford-base32 ULID without a runtime dependency. */
export function createUlid(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('Invalid ULID timestamp.');

  if (now === lastTimestamp) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTimestamp = now;
    lastRandom = randomDigits();
  }

  return `${encodeTimestamp(now)}${lastRandom.map((digit) => CROCKFORD[digit]).join('')}`;
}
