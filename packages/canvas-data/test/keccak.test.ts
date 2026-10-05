import { describe, expect, it } from 'vitest';
import { isValidChainAddress, keccak256, toChecksumAddress, toHex } from '../src/keccak.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('Keccak-256, against published vectors', () => {
  it('hashes the empty string to the value Ethereum documents', () => {
    expect(toHex(keccak256(new Uint8Array()))).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
  });

  it('is Keccak, not NIST SHA3-256, which hashes the empty string differently', () => {
    expect(toHex(keccak256(new Uint8Array()))).not.toBe(
      'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a',
    );
  });

  it('hashes "abc" and a two-block input as published', () => {
    expect(toHex(keccak256(utf8('abc')))).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    // 200 bytes crosses the 136-byte rate.
    expect(toHex(keccak256(new Uint8Array(200).fill(0xa3)))).toBe(
      '3a57666b048777f2c953dc4456f45a2588e1cb6f2da760122d530ac2ce607d4a',
    );
  });
});

describe('EIP-55', () => {
  // The four examples in the EIP itself.
  const EXAMPLES = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];

  it('reproduces the specification examples from their lower-case form', () => {
    for (const address of EXAMPLES) expect(toChecksumAddress(address.toLowerCase())).toBe(address);
  });

  it('accepts a spelling with no checksum, and a correct checksum', () => {
    for (const address of EXAMPLES) {
      expect(isValidChainAddress(address)).toBe(true);
      expect(isValidChainAddress(address.toLowerCase())).toBe(true);
      expect(isValidChainAddress(`0x${address.slice(2).toUpperCase()}`)).toBe(true);
    }
  });

  it('refuses a mixed-case address with one case flipped, which is what a typo looks like', () => {
    for (const address of EXAMPLES) {
      const i = address.slice(2).search(/[a-fA-F]/) + 2;
      const c = address[i]!;
      const flipped = address.slice(0, i) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + address.slice(i + 1);
      expect(isValidChainAddress(flipped)).toBe(false);
    }
  });

  it('refuses something that is not an address at all', () => {
    expect(isValidChainAddress('0x1234')).toBe(false);
    expect(isValidChainAddress('5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(false);
  });
});
