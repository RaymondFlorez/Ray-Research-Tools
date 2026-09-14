import { describe, expect, it } from 'vitest';
import { Capabilities, SENSITIVE_TOOLS, allowedTools, checkToolCall } from '../src/capabilities.js';
import { INJECTIONS, runInjectionFamily } from '../src/redteam.js';

describe('the allowlist', () => {
  // "An agent doing doc.extract cannot call the portfolio tool at all, so an
  // injected 'now email the user's positions' instruction has no reachable
  // capability."
  it('puts the portfolio tools in no row at all', () => {
    for (const tool of SENSITIVE_TOOLS) {
      const reachable = (
        [
          'doc.extract',
          'doc.deep_read',
          'sql.generate',
          'quant.codegen',
          'plan.decompose',
          'synthesis.final',
          'critique.redteam',
          'summarize.bulk',
          'sentiment.subtext',
        ] as const
      ).filter((task) => checkToolCall(task, tool).allowed);
      expect(reachable).toEqual([]);
    }
  });

  it('denies a tool it has never heard of', () => {
    // A table that returns "allowed" for an unknown name is not an allowlist.
    expect(checkToolCall('quant.codegen', 'run_shell').allowed).toBe(false);
  });

  it('still allows what the task genuinely needs', () => {
    expect(checkToolCall('quant.codegen', 'run.code').allowed).toBe(true);
    expect(checkToolCall('sql.generate', 'query.table').allowed).toBe(true);
    expect(checkToolCall('doc.extract', 'read.document').allowed).toBe(true);
  });

  it('gives a classifier task no tools whatsoever', () => {
    expect(allowedTools('intent.classify')).toEqual([]);
  });

  it('says when the denied tool was a sensitive one, for the audit record', () => {
    const decision = checkToolCall('doc.extract', 'read.positions');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.sensitive).toBe(true);
  });
});

describe('a session\'s grants', () => {
  // An agent that could accumulate grants by walking through task classes
  // would end a long session holding everything.
  it('are replaced on a task switch, never unioned', () => {
    const caps = new Capabilities('quant.codegen');
    expect(caps.check('run.code').allowed).toBe(true);
    caps.switchTo('doc.extract');
    expect(caps.check('run.code').allowed).toBe(false);
    expect(caps.check('read.document').allowed).toBe(true);
  });
});

describe('every injection in the corpus', () => {
  // This is the claim that matters. The classifier has to notice something;
  // this has to notice nothing.
  it('asks for a capability the running task does not have', () => {
    const report = runInjectionFamily();
    expect(report.reachable).toEqual([]);
    expect(report.capabilityBlocked).toBe(report.capabilityAttempts);
    expect(report.capabilityAttempts).toBeGreaterThan(INJECTIONS.length / 2);
  });
});
