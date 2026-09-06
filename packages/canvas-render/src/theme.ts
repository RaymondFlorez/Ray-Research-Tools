/**
 * Render tokens.
 *
 * The renderer emits a draw list of tokens rather than CSS or GL calls, so the
 * same scene can be drawn by the WebGL layer, the DOM layer, or a test. Colors
 * live here so a dark theme is a token swap, not a second code path.
 */

export interface Theme {
  /** Canvas ground. */
  background: string;
  /** Warm paper tint behind loose objects (PRD 3.2). */
  paper: string;
  /** Fill behind bound and wired objects. */
  surface: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  /** Status colors, keyed by NodeRuntimeState.status. */
  idle: string;
  stale: string;
  computing: string;
  ready: string;
  error: string;
  unverified: string;
  /** Edge classes. */
  edgeData: string;
  edgeReference: string;
  edgeAnnotation: string;
  causalPositive: string;
  causalNegative: string;
  /** Passive mode. */
  wash: string;
  haloLow: string;
  haloMedium: string;
  haloHigh: string;
  /** Live data dot on a bound object. */
  live: string;
  /** Port dots on a wired node. */
  port: string;
}

export const lightTheme: Theme = {
  background: '#f6f5f2',
  paper: '#fdf8ee',
  surface: '#ffffff',
  border: '#c9c6bf',
  borderStrong: '#3d3a34',
  text: '#1c1a17',
  textMuted: '#6f6a61',
  idle: '#9a958c',
  stale: '#c9903a',
  computing: '#3a7bc9',
  ready: '#3d8a5f',
  error: '#c0392b',
  unverified: '#8e44ad',
  edgeData: '#5a6b7a',
  edgeReference: '#a8a29a',
  edgeAnnotation: '#8d8880',
  causalPositive: '#2f7d55',
  causalNegative: '#b1442f',
  wash: '#e0733a',
  haloLow: '#d9b04a',
  haloMedium: '#d97a2b',
  haloHigh: '#c0392b',
  live: '#3d8a5f',
  port: '#5a6b7a',
};

export const darkTheme: Theme = {
  background: '#14161a',
  paper: '#221f19',
  surface: '#1d2026',
  border: '#3a3f47',
  borderStrong: '#d8d4cc',
  text: '#eceae5',
  textMuted: '#9a958c',
  idle: '#6f6a61',
  stale: '#d9a54c',
  computing: '#5b9bdd',
  ready: '#5aab7c',
  error: '#e05a48',
  unverified: '#a86cc8',
  edgeData: '#8996a3',
  edgeReference: '#5b5f66',
  edgeAnnotation: '#6f7379',
  causalPositive: '#4fa87a',
  causalNegative: '#d2664e',
  wash: '#e0733a',
  haloLow: '#d9b04a',
  haloMedium: '#d97a2b',
  haloHigh: '#e05a48',
  live: '#5aab7c',
  port: '#8996a3',
};
