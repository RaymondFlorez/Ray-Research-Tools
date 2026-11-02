/**
 * A `UniverseNode` evaluated at the canvas's time, through a point-in-time
 * source (PRD 3.3, 3.8, 5.8).
 *
 * `resolveUniverse` takes rows whose values are already point-in-time and
 * says which names pass. This builds those rows: each numeric field of each
 * name is read as the fact `INSTRUMENT.field` from a `PointInTimeSource` — the
 * in-process store or the Go data plane — at the knowledge time the canvas's
 * time names, so a screen on a canvas scrubbed to a morning screens what was
 * known that morning, restatements and all.
 *
 * The data plane stores numbers. A name's listing dates and its categorical
 * fields (sector, country) come from the instrument reference passed in, as
 * they stand; they are not read point-in-time.
 *
 * Three rules, each one a way a screen could otherwise return a plausible
 * answer to a different question:
 *
 *   - **A field outside the catalog is refused before anything is read.** The
 *     catalog is the numeric fields the source carries. A field that is in it
 *     but has no value for any name on the date is unknown for every name and
 *     reported so — not refused, because a field can postdate the date.
 *   - **A field whose latest period is withheld is withheld, not the older
 *     period.** The same rule as the fact tile (`latestKnown`), and the name is
 *     counted under `withheld`, not under missing data.
 *   - **A read that lands after the canvas moved is discarded.**
 *
 * And one that is the analyst's to set: `maxAgeDays`. A value whose period
 * ended longer ago than that, at the knowledge time, is stale: kept on the
 * row with its period, not screened on, and counted under `stale`. Without
 * it nothing is stale, but every row still says how old each value is, and
 * the universe gives the oldest period it screened on.
 *
 * Reads go through the source's `readMany` when it has one: a screen is one
 * request to the data plane, not one per name per field.
 */

import type { PicassoNode } from '@picasso/canvas-core';
import type { Instant } from './bitemporal.js';
import { latestKnown, type PointInTimeSource, type SourceRead } from './factTile.js';
import { fieldsOf, parseScreen, refuseUnknownFields, resolveUniverse, type FieldValue, type ScreenRow, type Universe } from './screener.js';
import { knowledgeTimeFor, type CanvasTime } from './timescrub.js';

/** A name as the reference layer has it: listing dates and categorical fields. */
export interface InstrumentReference {
  instrument: string;
  listed: string;
  delisted?: string;
  /** Fields that are not read point-in-time, such as sector. */
  fields?: Readonly<Record<string, FieldValue>>;
}

/** The fact key a name's field is stored under. */
export const fieldKey = (instrument: string, field: string) => `${instrument}.${field}`;

/**
 * Rows for `fields` of every name eligible at `knowledgeTime`, read from
 * `source`. Names not yet listed, or already delisted, are not read.
 */
export async function loadScreenRows(
  source: PointInTimeSource,
  reference: readonly InstrumentReference[],
  fields: readonly string[],
  knowledgeTime: Instant,
  options: { maxAgeDays?: number } = {},
): Promise<ScreenRow[]> {
  const eligible = (name: InstrumentReference) =>
    name.listed <= knowledgeTime && (name.delisted === undefined || name.delisted > knowledgeTime);
  const keys = reference.filter(eligible).flatMap((name) => fields.map((field) => fieldKey(name.instrument, field)));
  const reads: ReadonlyMap<string, SourceRead> = source.readMany && keys.length > 0
    ? await source.readMany(keys, knowledgeTime)
    : new Map(await Promise.all(keys.map(async (key) => [key, await source.read({ key, knowledgeTime })] as const)));
  const at = Date.parse(knowledgeTime);
  return reference.map((name) => {
    const row: ScreenRow & { fields: Record<string, FieldValue>; withheld: Record<string, string>; periods: Record<string, { validTime: string; knownAt: string }>; stale: Record<string, string> } = {
      instrument: name.instrument,
      listed: name.listed,
      ...(name.delisted !== undefined ? { delisted: name.delisted } : {}),
      fields: { ...name.fields },
      withheld: {},
      periods: {},
      stale: {},
    };
    for (const field of fields) row.fields[field] = undefined;
    if (!eligible(name)) return row;
    for (const field of fields) {
      const read = reads.get(fieldKey(name.instrument, field));
      if (!read) throw new Error(`the source returned no read for ${fieldKey(name.instrument, field)}`);
      const latest = latestKnown(read);
      if (latest.kind === 'blocked') row.withheld[field] = latest.message;
      if (latest.kind !== 'value') continue;
      const { validTime, knownAt, value } = latest.observation;
      row.periods[field] = { validTime, knownAt };
      const ageDays = (at - Date.parse(validTime)) / 86_400_000;
      if (options.maxAgeDays !== undefined && ageDays > options.maxAgeDays) {
        row.stale[field] = `latest period ${validTime}, ${Math.floor(ageDays)} days before ${knowledgeTime}; the screen allows ${options.maxAgeDays}`;
      } else {
        row.fields[field] = value;
      }
    }
    return row;
  });
}

export type UniverseValue =
  | { kind: 'universe'; universe: Universe; source: string }
  /** The canvas moved while the reads were in flight; nothing was written. */
  | { kind: 'superseded'; asof: Instant };

/**
 * Screens at the canvas's time and settles the node.
 *
 * `catalog` names the numeric fields the source carries. The node's
 * provenance is stamped with the knowledge time before the reads, and the
 * answer stands only if it is still the node's knowledge time afterwards.
 */
export async function evaluateUniverseNode(
  node: PicassoNode,
  source: PointInTimeSource,
  reference: readonly InstrumentReference[],
  catalog: readonly string[],
  time: CanvasTime,
  now: () => Instant,
): Promise<UniverseValue> {
  const expression = String(node.params.expression ?? '');
  const expr = parseScreen(expression);
  const referenceFields = new Set(reference.flatMap((name) => Object.keys(name.fields ?? {})));
  refuseUnknownFields(expr, new Set([...referenceFields, ...catalog]));
  const toRead = [...fieldsOf(expr)].filter((field) => !referenceFields.has(field));

  const asof = knowledgeTimeFor(time, now);
  node.provenance = { ...node.provenance, asof };
  node.state = { ...node.state, status: 'computing' };
  const maxAgeDays = node.params.maxAgeDays;
  if (maxAgeDays !== undefined && (typeof maxAgeDays !== 'number' || !(maxAgeDays >= 0))) {
    throw new Error(`maxAgeDays must be a number of days, not ${JSON.stringify(maxAgeDays)}`);
  }
  const rows = await loadScreenRows(source, reference, toRead, asof, maxAgeDays !== undefined ? { maxAgeDays } : {});
  if (node.provenance.asof !== asof) return { kind: 'superseded', asof };

  node.state = { status: 'ready', lastComputedAt: Date.now() };
  return { kind: 'universe', universe: resolveUniverse(expression, rows, asof), source: source.name };
}
