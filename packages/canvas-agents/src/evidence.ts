/**
 * The EvidenceNode (PRD 3.3, 5.7).
 *
 * > `EvidenceNode`: document excerpts with span anchors and stance labels.
 *
 * 5.7's subtext query ends by writing one — "output an `EvidenceNode` with
 * spans plus a scored summary" — and the Critic's disconfirming retrieval is
 * what fills its `contradicts` column. Two rules make it evidence rather than a
 * list of quotations.
 *
 * ## An anchor lands on the text it quotes, or the excerpt is refused
 *
 * A model quoting a filing paraphrases without meaning to: it tidies a clause,
 * drops a "not", normalizes a number. An excerpt whose anchor points at
 * characters 4,210-4,288 and whose text is not those characters is a paraphrase
 * wearing a citation, and the reader who clicks through finds something else.
 * So every excerpt's text is compared with the document at its anchor, exactly,
 * at construction — the same rule `metric()` applies to a transcript score and
 * the Reconciler applies to a document-sourced number.
 *
 * ## The absence of dissent is reported, not implied
 *
 * An evidence node with six supporting excerpts and no contradicting ones reads
 * as settled. It may be; or nobody looked. The node carries its stance counts
 * and says so in words when the `contradicts` column is empty, because the
 * difference between "no disconfirming evidence exists" and "none was found"
 * is exactly what the Critic is there to test.
 */

import { createNode, type NodeID, type ParamValue, type PicassoNode } from '@picasso/canvas-core';

export type Stance = 'supports' | 'contradicts' | 'context';

export const STANCES: readonly Stance[] = ['supports', 'contradicts', 'context'];

export interface Excerpt {
  docId: string;
  /** Character offsets into the document, end exclusive. */
  charStart: number;
  charEnd: number;
  /** The quoted text. Must equal the document at the anchor. */
  text: string;
  stance: Stance;
}

export class AnchorMismatch extends Error {
  constructor(readonly excerpt: Excerpt, readonly found: string | undefined) {
    super(
      found === undefined
        ? `excerpt cites ${excerpt.docId}, which is not among the documents supplied`
        : `excerpt at ${excerpt.docId}:${excerpt.charStart}-${excerpt.charEnd} quotes ` +
            `${JSON.stringify(excerpt.text)} but the document there reads ${JSON.stringify(found)}`,
    );
    this.name = 'AnchorMismatch';
  }
}

export interface EvidenceSummary {
  counts: Record<Stance, number>;
  /** Present when nothing contradicts the claim: said, not implied. */
  note?: string;
}

export function summarizeEvidence(excerpts: readonly Excerpt[]): EvidenceSummary {
  const counts: Record<Stance, number> = { supports: 0, contradicts: 0, context: 0 };
  for (const e of excerpts) counts[e.stance] += 1;
  const summary: EvidenceSummary = { counts };
  if (counts.contradicts === 0) {
    summary.note =
      counts.supports > 0
        ? 'no contradicting excerpt was found; that is not the same as none existing'
        : 'nothing here bears on the claim either way';
  }
  return summary;
}

/**
 * Builds an EvidenceNode, checking every anchor against its document.
 *
 * Nothing is repaired: an excerpt that does not match is refused with what the
 * document actually says, and the caller — usually a model — is asked again.
 */
export function createEvidenceNode(
  id: NodeID,
  claim: string,
  excerpts: readonly Excerpt[],
  documents: ReadonlyMap<string, string>,
): PicassoNode {
  for (const excerpt of excerpts) {
    if (!STANCES.includes(excerpt.stance)) {
      throw new Error(`"${excerpt.stance}" is not a stance: use supports, contradicts or context`);
    }
    const document = documents.get(excerpt.docId);
    if (document === undefined) throw new AnchorMismatch(excerpt, undefined);
    const valid =
      Number.isInteger(excerpt.charStart) &&
      Number.isInteger(excerpt.charEnd) &&
      excerpt.charStart >= 0 &&
      excerpt.charEnd > excerpt.charStart &&
      excerpt.charEnd <= document.length;
    const found = valid ? document.slice(excerpt.charStart, excerpt.charEnd) : '';
    if (!valid || found !== excerpt.text) throw new AnchorMismatch(excerpt, found);
  }
  const summary = summarizeEvidence(excerpts);
  const params: Record<string, ParamValue> = {
    claim,
    excerpts: excerpts.map((e) => ({
      docId: e.docId,
      charStart: e.charStart,
      charEnd: e.charEnd,
      text: e.text,
      stance: e.stance,
    })),
    supports: summary.counts.supports,
    contradicts: summary.counts.contradicts,
    context: summary.counts.context,
  };
  if (summary.note) params.note = summary.note;
  return createNode({
    id,
    kind: 'EvidenceNode',
    binding: 'bound',
    inputs: [],
    outputs: [{ id: 'evidence', name: 'Evidence', type: 'document', cardinality: 'one', required: false }],
    params,
  });
}
