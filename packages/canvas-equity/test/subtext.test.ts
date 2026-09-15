import { describe, expect, it } from 'vitest';
import {
  TRAILING_CALLS,
  guidanceDiff,
  hedgingDensity,
  forwardLookingRatio,
  questionEntities,
  questionEvasion,
  read,
  tone,
  toneDelta,
} from '../src/subtext.js';
import { UnevidencedMetric, metric, sentences, type Transcript } from '../src/transcript.js';

function call(
  callId: string,
  period: string,
  utterances: Transcript['utterances'],
): Transcript {
  return { callId, company: 'ACME', period, at: '2026-02-26', utterances };
}

const hedged = call('q1', '2026Q1', [
  {
    speaker: 'CFO',
    role: 'executive',
    section: 'prepared',
    text:
      'Revenue grew 12 percent. We expect the next quarter to be roughly in line, and margins should ' +
      'potentially improve somewhat. Our guidance for the full year is unchanged.',
  },
  {
    speaker: 'Analyst A',
    role: 'analyst',
    section: 'qa',
    text: 'Can you talk about China demand and the datacenter gross margin trajectory?',
  },
  {
    speaker: 'CFO',
    role: 'executive',
    section: 'qa',
    text: 'The overall demand environment remains constructive and we feel good about the portfolio.',
  },
  {
    speaker: 'Analyst B',
    role: 'analyst',
    section: 'qa',
    text: 'What drove the inventory build this quarter?',
  },
  {
    speaker: 'CFO',
    role: 'executive',
    section: 'qa',
    text: 'The inventory build reflects timing of shipments, and we expect it to normalize.',
  },
]);

describe('every metric cites the sentences behind it', () => {
  // "click a score and land on the sentences" is only true if something
  // refuses a number with nothing to click.
  it('refuses a non-zero value with no spans', () => {
    expect(() => metric('invented', 33, 'per thousand words', [])).toThrow(UnevidencedMetric);
    expect(() => metric('honest zero', 0, 'per thousand words', [])).not.toThrow();
  });

  it('points every hedging span at a real hedge', () => {
    const result = hedgingDensity(hedged, 'prepared');
    expect(result.spans.length).toBeGreaterThan(0);
    for (const span of result.spans) {
      const source = hedged.utterances[span.utterance]!.text;
      expect(source.slice(span.start, span.end)).toBe(span.text);
    }
  });
});

describe('sections are the unit of analysis', () => {
  // Prepared remarks are written and lawyered; the Q&A is not. A density
  // across both measures how long the prepared section was.
  it('scores prepared remarks and Q&A separately', () => {
    const result = read({ current: hedged });
    expect(result.hedgingPrepared.value).not.toBe(result.hedgingQa.value);
    for (const span of result.hedgingPrepared.spans) {
      expect(hedged.utterances[span.utterance]!.section).toBe('prepared');
    }
  });

  it('never counts an analyst as a speaker whose hedging matters', () => {
    const result = hedgingDensity(hedged, 'qa');
    for (const span of result.spans) {
      expect(hedged.utterances[span.utterance]!.role).toBe('executive');
    }
  });

  it('caveats a section too short to carry a density', () => {
    expect(hedgingDensity(hedged, 'prepared').caveat).toContain('words of executive speech');
  });
});

describe('the forward-looking ratio', () => {
  // A ratio, not a count: a long prepared section and a short one produce very
  // different counts of the same behaviour.
  it('is a share of sentences, so section length does not drive it', () => {
    const short = call('a', '2026Q1', [
      { speaker: 'CEO', role: 'executive', section: 'prepared', text: 'We expect growth. Revenue was 10.' },
    ]);
    const long = call('b', '2026Q1', [
      {
        speaker: 'CEO',
        role: 'executive',
        section: 'prepared',
        text: 'We expect growth. Revenue was 10. We expect margin. Costs were 4.',
      },
    ]);
    expect(forwardLookingRatio(short, 'prepared').value).toBeCloseTo(0.5, 10);
    expect(forwardLookingRatio(long, 'prepared').value).toBeCloseTo(0.5, 10);
  });
});

describe('question evasion', () => {
  // The PRD's operational definition: "does the answer contain the entities
  // the question asked about".
  it('names the terms the answer never mentioned', () => {
    const result = questionEvasion(hedged);
    const china = result.exchanges[0]!;
    expect(china.missed).toContain('china');
    expect(china.missed).toContain('datacenter');
    expect(china.evasion).toBeGreaterThan(0.5);
  });

  it('scores a responsive answer as responsive', () => {
    const result = questionEvasion(hedged);
    const inventory = result.exchanges[1]!;
    expect(inventory.answered).toContain('inventory');
    expect(inventory.evasion).toBeLessThan(china(result).evasion);
  });

  function china(result: ReturnType<typeof questionEvasion>) {
    return result.exchanges[0]!;
  }

  // The spans point at the answer, because the question is already in front
  // of the analyst.
  it('cites the answer, not the question', () => {
    const result = questionEvasion(hedged);
    for (const span of result.spans) {
      expect(hedged.utterances[span.utterance]!.role).toBe('executive');
    }
  });

  it('drops filler words before deciding what was asked', () => {
    const asked = questionEntities('Hi guys, thanks for taking my question. Can you talk about China?');
    expect(asked).toContain('china');
    expect(asked).not.toContain('thanks');
    expect(asked).not.toContain('question');
  });

  it('ignores a question with nothing substantive in it', () => {
    const pleasantries = call('x', '2026Q1', [
      { speaker: 'Analyst', role: 'analyst', section: 'qa', text: 'Thanks, and hi.' },
      { speaker: 'CFO', role: 'executive', section: 'qa', text: 'Good morning.' },
    ]);
    expect(questionEvasion(pleasantries).exchanges).toHaveLength(0);
  });

  it('caveats a call with too few exchanges to average over', () => {
    expect(questionEvasion(hedged).caveat).toContain('exchange');
  });
});

describe('tone delta', () => {
  function toned(id: string, text: string): Transcript {
    return call(id, id, [{ speaker: 'CFO', role: 'executive', section: 'qa', text }]);
  }

  const positive = 'Demand is strong and momentum is robust. We are pleased and confident.';
  const negative = 'Demand is weak. Pressure is challenging and the outlook is uncertain.';

  it('scores tone as net positive terms per thousand words', () => {
    expect(tone(toned('a', positive), 'qa', 'CFO').score).toBeGreaterThan(0);
    expect(tone(toned('b', negative), 'qa', 'CFO').score).toBeLessThan(0);
  });

  it('measures against the same speaker\'s own past, not an absolute scale', () => {
    const trailing = [toned('t1', positive), toned('t2', positive), toned('t3', positive)];
    const result = toneDelta(toned('now', negative), trailing, 'qa', 'CFO');
    expect(result.value).toBeLessThan(0);
    expect(result.trailing).toHaveLength(3);
  });

  it('takes only the trailing four calls', () => {
    const trailing = Array.from({ length: 9 }, (_, i) => toned(`t${i}`, positive));
    expect(toneDelta(toned('now', negative), trailing, 'qa', 'CFO').trailing).toHaveLength(TRAILING_CALLS);
  });

  it('says so when there is no prior call from this speaker', () => {
    const result = toneDelta(toned('now', negative), [], 'qa', 'CFO');
    expect(result.caveat).toContain('no prior call');
    expect(result.spans).toEqual([]);
  });

  // Four observations do not support a standard deviation, and the caveat has
  // to say so in the units the reader can act on.
  it('names the relative error of a sigma drawn from four calls', () => {
    const trailing = Array.from({ length: 4 }, (_, i) =>
      toned(`t${i}`, i % 2 === 0 ? positive : `${positive} Costs declined somewhat.`),
    );
    const result = toneDelta(toned('now', negative), trailing, 'qa', 'CFO');
    expect(result.caveat).toContain('baseline is 4 calls');
    expect(result.caveat).toMatch(/\d+% relative error/);
    expect(result.z).toBeDefined();
  });
});

describe('guidance language change', () => {
  const prior = call('q4', '2025Q4', [
    {
      speaker: 'CFO',
      role: 'executive',
      section: 'prepared',
      text: 'For the full year we expect revenue growth of 12 to 14 percent. Our outlook for margin is unchanged.',
    },
  ]);

  it('diffs the exact phrasing against the prior quarter', () => {
    const current = call('q1', '2026Q1', [
      {
        speaker: 'CFO',
        role: 'executive',
        section: 'prepared',
        text: 'For the full year we expect revenue growth of 8 to 10 percent. Our outlook for margin is unchanged.',
      },
    ]);
    const result = guidanceDiff(current, prior);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.removed).toEqual(expect.arrayContaining(['12', '14']));
    expect(result.changes[0]?.added).toEqual(expect.arrayContaining(['8', '10']));
  });

  it('reports an unchanged sentence as unchanged', () => {
    expect(guidanceDiff(prior, prior).changes).toEqual([]);
    expect(guidanceDiff(prior, prior).value).toBe(0);
  });

  // "We are withdrawing full-year guidance" has no prior-quarter counterpart.
  // Diffing it against a revenue range would produce a word salad where the
  // finding should be one word: withdrawn.
  it('calls a sentence with no counterpart novel rather than diffing it against the least-bad match', () => {
    const current = call('q1', '2026Q1', [
      {
        speaker: 'CFO',
        role: 'executive',
        section: 'prepared',
        text: 'We are withdrawing full-year guidance given the macro environment.',
      },
    ]);
    const result = guidanceDiff(current, prior);
    expect(result.novel).toHaveLength(1);
    expect(result.changes).toEqual([]);
    expect(result.dropped.length).toBeGreaterThan(0);
  });

  it('cites the current-quarter sentence so the analyst lands on it', () => {
    const current = call('q1', '2026Q1', [
      {
        speaker: 'CFO',
        role: 'executive',
        section: 'prepared',
        text: 'For the full year we expect revenue growth of 8 to 10 percent.',
      },
    ]);
    const result = guidanceDiff(current, prior);
    const span = result.spans[0]!;
    expect(current.utterances[span.utterance]!.text.slice(span.start, span.end)).toBe(span.text);
  });
});

describe('sentence splitting', () => {
  it('keeps each sentence\'s offset in the source', () => {
    const text = 'First one. Second one! Third?';
    const found = sentences(text);
    expect(found).toHaveLength(3);
    for (const sentence of found) {
      expect(text.slice(sentence.start, sentence.end)).toBe(sentence.text);
    }
  });

  it('keeps a trailing fragment with no terminator', () => {
    expect(sentences('Complete. Incomplete').map((s) => s.text)).toEqual(['Complete.', 'Incomplete']);
  });
});
