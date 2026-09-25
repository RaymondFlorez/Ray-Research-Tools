// Loaded by scripts/csp-check.mjs as a same-origin <script src>, so it runs as
// page script under the page's CSP. DevTools evaluation is exempt from CSP and
// cannot test this; a script the page itself runs can.
try {
  // eslint-disable-next-line no-eval
  eval('1');
  window.__cspEval = 'allowed';
} catch {
  window.__cspEval = 'refused';
}
try {
  new Function('return 1')();
  window.__cspFunction = 'allowed';
} catch {
  window.__cspFunction = 'refused';
}
