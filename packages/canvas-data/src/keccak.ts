/**
 * Keccak-256, for EIP-55 address checksums (PRD 5.1).
 *
 * Ethereum's hash is the original Keccak submission, not NIST SHA3-256: same
 * permutation, different padding byte (0x01 rather than 0x06). Using a
 * platform SHA3 would produce a well-formed and entirely wrong checksum, so
 * the permutation is written out here and checked against published vectors
 * that do not come from this file.
 *
 * Lanes are BigInts. An address check hashes forty bytes, rarely; clarity is
 * worth more here than the factor a 32-bit-pair implementation would buy.
 */

const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets, indexed x + 5y. */
const ROTATIONS: readonly number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl(v: bigint, n: number): bigint {
  if (n === 0) return v;
  return ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK;
}

function permute(a: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // θ
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++) c[x] = a[x]! ^ a[x + 5]! ^ a[x + 10]! ^ a[x + 15]! ^ a[x + 20]!;
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) a[x + y] = a[x + y]! ^ d;
    }
    // ρ and π
    const b: bigint[] = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y]!, ROTATIONS[x + 5 * y]!);
      }
    }
    // χ
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        a[x + y] = b[x + y]! ^ (~b[((x + 1) % 5) + y]! & MASK & b[((x + 2) % 5) + y]!);
      }
    }
    // ι
    a[0] = a[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

/** Keccak-256 of bytes, as Ethereum computes it. Returns 32 bytes. */
export function keccak256(input: Uint8Array): Uint8Array {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1]! |= 0x80;

  const state: bigint[] = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + b]!);
      state[i] = state[i]! ^ lane;
    }
    permute(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i]!;
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The EIP-55 mixed-case spelling of a 20-byte address. */
export function toChecksumAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`${address} is not a 20-byte hex address`);
  const hash = toHex(keccak256(new TextEncoder().encode(hex)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? hex[i]!.toUpperCase() : hex[i]!;
  return out;
}

/**
 * Whether an address spelling is acceptable under EIP-55.
 *
 * All-lower and all-upper spellings carry no checksum and are accepted as
 * such. A mixed-case spelling *is* a checksum, and must be the right one: a
 * mixed-case address with one wrong character is a typo the case was there to
 * catch, and lower-casing it first — which is what made it look canonical —
 * throws the check away.
 */
export function isValidChainAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}
