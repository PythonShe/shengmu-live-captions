// Imported first by the scripts end users run. Node 24 releases before this
// one carry known CVEs; keep in step with package.json "engines".
export const MIN_NODE_VERSION = "24.22.2";

/** @param {string} version e.g. "v24.22.2" @param {string} [minimum] */
export function nodeVersionSupported(version, minimum = MIN_NODE_VERSION) {
  const parse = (value) => String(value).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const have = parse(version);
  const need = parse(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return have[index] > need[index];
  }
  return true;
}

if (!nodeVersionSupported(process.version)) {
  console.error(
    `Node.js ${MIN_NODE_VERSION} or newer is required (this is ${process.version}). ` +
      "Install the latest Node.js 24 LTS from https://nodejs.org"
  );
  process.exit(1);
}
