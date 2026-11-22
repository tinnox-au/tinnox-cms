// OTH-11: dependency versions are exact (adoption plan step 9). `.npmrc` sets save-exact, but a
// hand-edited range that the lockfile satisfies passes `npm ci`, and the next lockfile refresh
// moves it silently. Read by scripts/lib/exact-pin.test.ts over every package.json.

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** One exact semantic version, as npm writes it with save-exact: no prefix, no range. */
const EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** The form a workspace reference has: npm links the local workspace whatever its version. */
export const WORKSPACE_REFERENCE = '*';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kindOf(spec: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.includes('/')) return 'a URL, path or alias';
  if (/^[a-z]/i.test(spec)) return 'a tag';
  return 'a range';
}

/**
 * One problem per dependency whose version is not one exact version.
 * @param path the manifest's path from the repository root
 * @param manifest the parsed package.json
 * @param workspaces the names of the repository's workspaces, referenced as "*"
 */
export function pinProblems(
  path: string,
  manifest: unknown,
  workspaces: ReadonlySet<string>,
): string[] {
  if (!isObject(manifest)) return [`${path} is not a JSON object`];
  const problems: string[] = [];
  for (const section of SECTIONS) {
    const entries = manifest[section];
    if (entries === undefined) continue;
    if (!isObject(entries)) {
      problems.push(`${path}: "${section}" is not an object of package names and versions`);
      continue;
    }
    for (const [name, spec] of Object.entries(entries)) {
      const at = `${path}: "${section}"."${name}"`;
      if (typeof spec !== 'string') {
        problems.push(`${at} is not a version string`);
      } else if (workspaces.has(name)) {
        if (spec !== WORKSPACE_REFERENCE) {
          problems.push(
            `${at} is "${spec}"; reference a workspace package as "${WORKSPACE_REFERENCE}", as every other workspace reference does`,
          );
        }
      } else if (!EXACT_VERSION.test(spec)) {
        problems.push(
          `${at} is "${spec}", ${kindOf(spec)}, not one exact version: pin the version package-lock.json resolves (npm ls ${name}), for example with npm install ${name}@<version>, which .npmrc saves exactly`,
        );
      }
    }
  }
  return problems;
}

/** A problem unless .npmrc sets save-exact=true, which makes npm install write exact versions. */
export function npmrcProblems(text: string): string[] {
  const settings = text
    .split('\n')
    .map((line) => line.replace(/[#;].*$/, '').trim())
    .filter((line) => line !== '');
  return settings.some((line) => /^save-exact\s*=\s*true$/.test(line))
    ? []
    : ['.npmrc does not set save-exact=true: add that line, so npm install writes exact versions'];
}
