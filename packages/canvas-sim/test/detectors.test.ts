import { describe, expect, it } from 'vitest';
import { audit, negativeLagTest, shuffleTest, SHUFFLE_ALARM } from '../src/detectors.js';
import { backtest, type Strategy } from '../src/engine.js';
import { History, LookAheadError } from '../src/pointInTime.js';

/**
 * Deterministic price history.
 *
 * `momentum` sets the autocorrelation of returns. At zero this is a random
 * walk, where no trend-following strategy can have an edge; above zero there is
 * a real one to find, which is what an honest strategy needs in order for the
 * shuffle test to have something to destroy.
 */
function market(days = 400, seed = 42, momentum = 0) {
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4_294_967_296) - 0.5;
  };
  const dates: string[] = [];
  const prices: number[] = [];
  let price = 100;
  let previous = 0;
  for (let d = 0; d < days; d += 1) {
    const shock = next() * 0.03 + 0.0002;
    const ret = momentum * previous + shock;
    previous = ret;
    price *= 1 + ret;
    dates.push(new Date(Date.UTC(2024, 0, 1 + d)).toISOString().slice(0, 10));
    prices.push(price);
  }
  return { dates, prices };
}

function historyOf(dates: string[], prices: number[]): History {
  const history = new History();
  history.addSeries(
    'price:ACME',
    dates.map((date, i) => ({ date, value: prices[i] as number })),
  );
  return history;
}

const OPTIONS = { symbols: ['ACME'], initialCash: 1_000_000, trials: 1 };

/**
 * Look-ahead as it actually occurs: a strategy that closes over the whole price
 * array and indexes it by the current bar.
 *
 * It never reads the point-in-time view, so the view cannot protect against it.
 * Two bars ahead rather than one, because an order decided on bar t fills at
 * t+1 and earns t+1 → t+2 — a one-bar leak would predict a return the position
 * never sees, which is the engine's fill delay doing its job.
 */
function closureLeak(dates: readonly string[], prices: readonly number[]): Strategy {
  const index = new Map(dates.map((date, i) => [date, i]));
  return (_view, state) => {
    const i = index.get(state.date) ?? 0;
    const next = prices[i + 1];
    const after = prices[i + 2];
    const future = next !== undefined && after !== undefined ? after / next - 1 : 0;
    return [{ symbol: 'ACME', targetShares: future > 0 ? 5000 : -5000 }];
  };
}

/** An honest strategy, reading only what the view will show it. */
function trendFollower(window = 60, size = 3000): Strategy {
  return (view) => {
    const prices = view.window('price:ACME', window);
    if (prices.length < window) return [];
    const last = prices[prices.length - 1] as number;
    const first = prices[0] as number;
    return [{ symbol: 'ACME', targetShares: last > first ? size : -size }];
  };
}

describe('the shuffle test', () => {
  const { dates, prices } = market();
  const history = historyOf(dates, prices);

  /**
   * Phase 4's exit criterion: "Shuffle test correctly flags a deliberately
   * leaky backtest."
   *
   * The leak here is the classic one. The strategy reads a "signal" series that
   * was built from the *next* bar's return — a join off by one day, which is
   * how it happens in real code. Nothing about the strategy looks wrong; it
   * reads a number and trades on it.
   */
  /**
   * Phase 4's exit criterion: "Shuffle test correctly flags a deliberately
   * leaky backtest."
   *
   * The leak is the one that actually happens. Real look-ahead does not come
   * from a data read — the point-in-time view already refuses those — it comes
   * from a **captured variable**: an array loaded once, indexed by bar, and
   * closed over by the strategy. Nothing in the strategy looks wrong. It never
   * touches the view at all, which is precisely why the view cannot save it.
   *
   * And that is what makes the shuffle test the right detector for it. PRD 5.8:
   * "A backtest that passes the shuffle test gets flagged loudly, because it
   * means something is leaking." Scrambling the signal dates changes this
   * strategy's results by *nothing*, because the closure never saw the dates.
   */
  it('flags a deliberately leaky backtest', () => {
    const strategy = closureLeak(dates, prices);

    const result = backtest(history, strategy, OPTIONS);
    // It backtests beautifully, which is exactly the problem.
    expect(result.sharpe).toBeGreaterThan(5);

    const test = shuffleTest(history, strategy, OPTIONS, 20);
    expect(test.leaking).toBe(true);
    // The shuffle did not dent it, because there was nothing to shuffle.
    expect(test.shuffledMedian).toBeCloseTo(test.actual, 6);
    expect(test.survivalRate).toBeGreaterThan(SHUFFLE_ALARM);
    expect(test.verdict).toContain('LEAKING');
    expect(test.verdict).toContain('not coming from the signals');
  });

  it('leaves an honest strategy alone', () => {
    // A market with real trend in it, and momentum on prices the strategy could
    // actually have seen. Shuffling the dates should destroy this, because the
    // edge lives in the order of the observations.
    const trending = market(1200, 9, 0.5);
    const trendHistory = historyOf(trending.dates, trending.prices);
    const test = shuffleTest(trendHistory, trendFollower(), OPTIONS, 20);
    expect(test.inconclusive).toBe(false);
    expect(test.leaking).toBe(false);
    expect(test.verdict).toContain('clean');
    // Shuffling really did cost it something.
    expect(test.shuffledMedian).toBeLessThan(test.actual);
  });

  /**
   * The limit of the test, stated as a test.
   *
   * A strategy with no edge survives its own shuffle, because there was never
   * anything to lose. That is not a leak, and calling it one would train
   * analysts to ignore the detector on the runs where it matters.
   */
  it('says so rather than crying leak when there was no performance', () => {
    const flat: Strategy = (view) => [
      { symbol: 'ACME', targetShares: (view.latest('price:ACME') ?? 0) > 100 ? 500 : -500 },
    ];
    const test = shuffleTest(history, flat, OPTIONS, 12);
    expect(test.inconclusive).toBe(true);
    expect(test.leaking).toBe(false);
    expect(test.verdict).toContain('nothing for a shuffle to destroy');
  });

  it('is deterministic, so a flagged run can be re-run and re-flagged', () => {
    const strategy: Strategy = (view) => [
      { symbol: 'ACME', targetShares: (view.latest('price:ACME') ?? 0) > 100 ? 1000 : 0 },
    ];
    const first = shuffleTest(history, strategy, OPTIONS, 8);
    const second = shuffleTest(history, strategy, OPTIONS, 8);
    expect(second.shuffled).toEqual(first.shuffled);
    expect(second.survivalRate).toBe(first.survivalRate);
  });
});

describe('the negative-lag detector', () => {
  const { prices } = market(300);
  const returns = prices.slice(1).map((p, i) => p / (prices[i] as number) - 1);

  it('catches a signal that knows returns that already happened', () => {
    // The signal IS the contemporaneous return, which is the purest leak.
    const test = negativeLagTest(returns, returns, 5);
    expect(test.leaking).toBe(true);
    expect(test.verdict).toContain('knows more about the past than the future');
  });

  it('does not flag a signal that merely predicts', () => {
    // Correlated with the NEXT return and nothing before it. That is an edge.
    const signal = returns.map((_, i) => (returns[i + 1] ?? 0) * 0.6);
    const test = negativeLagTest(signal, returns, 5);
    expect(test.leaking).toBe(false);
  });

  it('does not flag noise', () => {
    let state = 7;
    const noise = returns.map(() => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648 - 0.5;
    });
    expect(negativeLagTest(noise, returns, 5).leaking).toBe(false);
  });
});

describe('the point-in-time guard', () => {
  it('will not show a strategy a restatement it could not have seen', () => {
    const history = new History();
    history.addSeries('price:ACME', [
      { date: '2024-01-02', value: 100 },
      { date: '2024-01-03', value: 101 },
    ]);
    // Reported in January, restated in March.
    history.add('earnings', { validTime: '2024-01-02', knowledgeTime: '2024-01-02', value: 30.04 });
    history.add('earnings', { validTime: '2024-01-02', knowledgeTime: '2024-03-01', value: 29.71 });

    expect(history.viewAt('2024-01-03').latest('earnings')).toBe(30.04);
    expect(history.viewAt('2024-04-01').latest('earnings')).toBe(29.71);
  });

  it('resolves a universe as of the date, delistings included', () => {
    const view = new History().viewAt('2024-06-01');
    const universe = [
      { symbol: 'ALIVE', from: '2020-01-01' },
      { symbol: 'DELISTED', from: '2020-01-01', until: '2024-03-01' },
      { symbol: 'NOTYET', from: '2025-01-01' },
    ];
    // The name that later died was in the index that day, and the one that
    // joined later was not. Building the universe from today's members is the
    // most common look-ahead there is.
    expect(view.members(universe)).toEqual(['ALIVE']);
    expect(new History().viewAt('2024-01-15').members(universe)).toEqual(['ALIVE', 'DELISTED']);
  });

  it('exports an error that names the record, for callers that enforce harder', () => {
    const error = new LookAheadError('earnings', '2024-01-03', '2024-03-01');
    expect(error.message).toContain('was not knowable on 2024-01-03');
    expect(error.message).toContain('asked for a fact from its own future');
  });
});

describe('the audit runs everything, without being asked', () => {
  const { dates, prices } = market();

  it('collects every reason to distrust a backtest', () => {
    const history = historyOf(dates, prices);
    const result = audit(history, closureLeak(dates, prices), { ...OPTIONS, trials: 200 }, 12);
    expect(result.trustworthy).toBe(false);
    expect(result.findings.some((f) => f.includes('LEAKING'))).toBe(true);
    expect(result.shuffle.leaking).toBe(true);
  });

  it('says so when a backtest survives every check', () => {
    const trending = market(1200, 9, 0.5);
    const result = audit(
      historyOf(trending.dates, trending.prices),
      trendFollower(),
      { ...OPTIONS, trials: 1 },
      12,
    );
    expect(result.shuffle.leaking).toBe(false);
    expect(result.shuffle.inconclusive).toBe(false);
  });
});
