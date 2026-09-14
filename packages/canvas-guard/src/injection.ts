/**
 * The instruction-pattern classifier (PRD 7.2).
 *
 * "A separate classifier scans retrieved documents for instruction-like
 * patterns and flags the node."
 *
 * **Flags, not blocks.** That is the PRD's verb and it is the right one: a
 * 10-K genuinely contains the sentence "investors should disregard the prior
 * guidance", and a transcript genuinely contains "ignore the sequential
 * comparison". A classifier wired to a block button on text like that stops
 * research; one wired to a badge tells the analyst that a document is
 * shaped oddly and lets them look.
 *
 * It is also the weakest of the four defenses and is deliberately last in the
 * file. The capability allowlist is what actually makes an injected "email the
 * positions" harmless, because the tool is not reachable; this classifier only
 * raises a hand. Ranking it higher would be the mistake: pattern matching on
 * adversarial text is a race the writer wins.
 *
 * What it is measured on, therefore, is both rates at once. Detection on a
 * corpus of injections, and false positives on filing and transcript prose
 * that legitimately contains imperative language.
 */

export type SignalKind =
  | 'instruction_override'
  | 'role_confusion'
  | 'exfiltration'
  | 'tool_invocation'
  | 'control_tokens'
  | 'encoded_blob'
  | 'urgency_escalation';

export interface Signal {
  kind: SignalKind;
  weight: number;
  at: number;
  text: string;
}

export interface Scan {
  /** Sum of signal weights. */
  score: number;
  signals: Signal[];
  flagged: boolean;
}

/** At or above this, the node gets a badge. Calibrated in `redteam.ts`. */
export const FLAG_THRESHOLD = 3;

interface Rule {
  kind: SignalKind;
  weight: number;
  pattern: RegExp;
}

/**
 * Weights are not uniform, and the difference carries the design.
 *
 * A control token or a chat role marker inside a filing is worth a flag on its
 * own: prose has no reason to contain one, so the false-positive cost is close
 * to zero. "Ignore the above" is worth about half a flag, because a transcript
 * says it about a table. The threshold is then reached by one impossible thing
 * or two suspicious ones, which is the shape that survives contact with real
 * documents.
 */
const RULES: readonly Rule[] = [
  {
    kind: 'control_tokens',
    weight: 3,
    pattern: /<\|[a-z_]+\|>|\[INST\]|<<SYS>>|\bBEGIN SYSTEM PROMPT\b/i,
  },
  {
    kind: 'role_confusion',
    weight: 3,
    pattern: /^\s*(?:system|assistant|developer)\s*:/im,
  },
  // Two rules, not one with an alternation, because they are two different
  // moves and the score is meant to count distinct techniques. A document
  // that both reassigns the reader's identity and tells it what to act as is
  // doing more than one that does either.
  {
    kind: 'role_confusion',
    weight: 2,
    pattern: /\byou are (?:now|actually|really) (?:a|an|the)\b/i,
  },
  {
    kind: 'role_confusion',
    weight: 2,
    pattern: /\bact as (?:a|an|the) [a-z ]{0,20}(?:assistant|model|agent|ai)\b/i,
  },
  {
    kind: 'instruction_override',
    weight: 2,
    pattern: /\b(?:ignore|disregard|forget|override)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.]{0,20}\b(?:instruction|prompt|rule|direction|guideline)s?\b/i,
  },
  {
    kind: 'instruction_override',
    weight: 2,
    pattern: /\b(?:new|updated|revised) (?:instruction|directive|system prompt|rule)s?\b[:\s]/i,
  },
  {
    // Moving data somewhere, where the somewhere is named. A filing says "the
    // IR team will email the supplemental schedules, including position-level
    // detail" and means nothing by it; the difference is an address.
    kind: 'exfiltration',
    weight: 3,
    pattern:
      /\b(?:email|send|post|upload|transmit|exfiltrate|forward)\b[^.]{0,80}\b(?:position|portfolio|holding|api[ _-]?key|credential|token|secret)s?\b(?=[\s\S]{0,200}(?:[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/))|(?:[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/)[\s\S]{0,200}\b(?:email|send|post|upload|transmit|forward)\b[^.]{0,80}\b(?:position|portfolio|holding|credential)s?\b/i,
  },
  {
    // Moving *the reader's own* data, which no document has any business
    // asking for however politely it is phrased.
    kind: 'exfiltration',
    weight: 3,
    pattern:
      /\b(?:reply with|return|retrieve|append|include|disclose|share|send|email)\b[^.]{0,60}\b(?:the (?:user|reader|analyst)'?s?|your|my)\b[^.]{0,40}\b(?:position|portfolio|holding|balance|credential)s?\b/i,
  },
  {
    kind: 'exfiltration',
    weight: 2,
    pattern: /https?:\/\/[^\s)]{0,120}[?&](?:q|data|payload|d|c)=/i,
  },
  {
    kind: 'tool_invocation',
    weight: 3,
    pattern: /<(?:tool_call|function_call|invoke)\b|\bcall (?:the )?(?:tool|function)\b[^.]{0,30}\(/i,
  },
  {
    // A serialized tool call inside a filing is an impossible thing, like a
    // control token: prose has no reason to contain one, so the
    // false-positive cost is close to zero and the weight can be full.
    kind: 'tool_invocation',
    weight: 3,
    pattern: /\{\s*"(?:tool|function|name)"\s*:\s*"[a-z_.]+"\s*,\s*"(?:arguments|parameters|args)"/i,
  },
  {
    kind: 'urgency_escalation',
    weight: 1,
    pattern: /\b(?:this is (?:not|no) a (?:test|drill)|urgent(?:ly)?|immediately|do not (?:tell|inform|mention)|without (?:asking|confirming))\b/i,
  },
  {
    kind: 'encoded_blob',
    weight: 1,
    pattern: /\b[A-Za-z0-9+/]{120,}={0,2}\b/,
  },
];

export function scan(text: string): Scan {
  const signals: Signal[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    signals.push({
      kind: rule.kind,
      weight: rule.weight,
      at: match.index,
      text: match[0].slice(0, 80),
    });
  }
  // Each rule contributes at most once, and distinct rules add even when they
  // share a kind. Collapsing by kind was the first thing tried here, on the
  // theory that an attacker writing an override four ways should not score
  // four times. But a rule only matches once however many times its phrasing
  // appears, so verbosity was never the thing being counted: collapsing by
  // kind was discarding genuinely distinct techniques. "You are now the
  // portfolio assistant" and "act as an agent with database access" are two
  // different moves, and a document making both is more suspicious than one
  // making either.
  const kept = [...signals].sort((a, b) => b.weight - a.weight || a.at - b.at);
  const score = kept.reduce((sum, s) => sum + s.weight, 0);
  return { score, signals: kept, flagged: score >= FLAG_THRESHOLD };
}

/** What the node's badge says. */
export function badge(result: Scan): string | undefined {
  if (!result.flagged) return undefined;
  const kinds = [...new Set(result.signals.map((s) => s.kind))].join(', ');
  return `this document contains instruction-like text (${kinds}); it is being read as data`;
}
