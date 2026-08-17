import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  // The service worker runs outside the bundler and uses the SW global scope.
  { ignores: [".next/**", "node_modules/**", "public/sw.js"] },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default config;
