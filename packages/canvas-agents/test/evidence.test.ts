import { describe, expect, it } from 'vitest';
import {
  AnchorMismatch,
  createEvidenceNode,
  summarizeEvidence,
  type Excerpt,
} from '../src/evidence.js';

const CALL =
  'We expect gross margin to be in the low seventies for the full year. ' +
  'We are not providing guidance on data center revenue beyond the current quarter. ' +
  'Supply remains constrained through the first half.';

const documents = new Map([['nvda-q4-call', CALL]]);

function quote(text: string, stance: Excerpt['stance']): Excerpt {
  const charStart = CALL.indexOf(text);
  return { docId: 'nvda-q4-call', charStart, charEnd: charStart + text.length, text, stance };
}

describe('an EvidenceNode', () => {
  it('holds excerpts whose anchors land on the text they quote', () => {
    const node = createEvidenceNode(
      'ev1',
      'management is hedging on data center growth',
      [
        quote('We are not providing guidance on data center revenue beyond the current quarter.', 'supports'),
        quote('Supply remains constrained through the first half.', 'context'),
      ],
      documents,
    );
    expect(node.kind).toBe('EvidenceNode');
    expect(node.params.supports).toBe(1);
    expect(node.params.context).toBe(1);
  });

  it('refuses a paraphrase wearing a citation', () => {
    // The "not" dropped, and the anchor still points at the real sentence.
    const real = quote('We are not providing guidance on data center revenue beyond the current quarter.', 'supports');
    const paraphrase = { ...real, text: 'We are providing guidance on data center revenue beyond the current quarter.' };
    expect(() => createEvidenceNode('ev2', 'claim', [paraphrase], documents)).toThrow(AnchorMismatch);
    expect(() => createEvidenceNode('ev2', 'claim', [paraphrase], documents)).toThrow(/the document there reads/);
  });

  it('refuses an anchor that is off by one character', () => {
    const real = quote('Supply remains constrained through the first half.', 'context');
    const shifted = { ...real, charStart: real.charStart + 1, charEnd: real.charEnd + 1 };
    expect(() => createEvidenceNode('ev3', 'claim', [shifted], documents)).toThrow(AnchorMismatch);
  });

  it('refuses a document it was not given, and an anchor outside the document', () => {
    const real = quote('Supply remains constrained through the first half.', 'context');
    expect(() => createEvidenceNode('ev4', 'c', [{ ...real, docId: 'amd-q4-call' }], documents)).toThrow(
      /not among the documents/,
    );
    expect(() =>
      createEvidenceNode('ev5', 'c', [{ ...real, charEnd: CALL.length + 10 }], documents),
    ).toThrow(AnchorMismatch);
  });

  it('refuses a stance outside the three', () => {
    const odd = { ...quote('Supply remains constrained through the first half.', 'context'), stance: 'bullish' as never };
    expect(() => createEvidenceNode('ev6', 'c', [odd], documents)).toThrow(/not a stance/);
  });
});

describe('the absence of dissent', () => {
  it('is said in words when nothing contradicts the claim', () => {
    const summary = summarizeEvidence([
      quote('We expect gross margin to be in the low seventies for the full year.', 'supports'),
    ]);
    expect(summary.note).toContain('not the same as none existing');
  });

  it('is not said when something does', () => {
    const summary = summarizeEvidence([
      quote('We expect gross margin to be in the low seventies for the full year.', 'supports'),
      quote('Supply remains constrained through the first half.', 'contradicts'),
    ]);
    expect(summary.note).toBeUndefined();
    expect(summary.counts).toEqual({ supports: 1, contradicts: 1, context: 0 });
  });

  it('travels on the node', () => {
    const node = createEvidenceNode(
      'ev7',
      'margins hold',
      [quote('We expect gross margin to be in the low seventies for the full year.', 'supports')],
      documents,
    );
    expect(node.params.note).toContain('no contradicting excerpt was found');
  });
});
