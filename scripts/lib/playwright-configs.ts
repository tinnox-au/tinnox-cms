// OTH-05: Playwright traces, videos and screenshots stay off, because they would record the
// sign-in form and its one-time code. Read by scripts/lib/playwright-configs.test.ts over every
// Playwright config in the repository.

/** A Playwright config file, by name. */
export const PLAYWRIGHT_CONFIG = /(^|\/)playwright(\.[^/]+)?\.config\.[cm]?[jt]s$/;

const RECORDINGS = ['trace', 'video', 'screenshot'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Each option takes a mode string or an object with a mode ({ mode: 'off', size }).
function isOff(value: unknown): boolean {
  return value === 'off' || (isObject(value) && value['mode'] === 'off');
}

/**
 * One problem per recording option that is not off. The top-level `use` must say 'off' for
 * each, so the intent is visible; a project's `use` may leave one out and inherit it.
 * @param config the config's default export
 */
export function recordingProblems(path: string, config: unknown): string[] {
  const fix = `set it to 'off' in ${path}: a recording would hold the sign-in form and its one-time code (OTH-05)`;
  const top = isObject(config) && isObject(config['use']) ? config['use'] : {};
  const problems = RECORDINGS.filter((option) => !isOff(top[option])).map(
    (option) => `${path}: use.${option} is not 'off'; ${fix}`,
  );
  const projects = isObject(config) && Array.isArray(config['projects']) ? config['projects'] : [];
  for (const [index, project] of projects.entries()) {
    const use = isObject(project) && isObject(project['use']) ? project['use'] : {};
    const name =
      isObject(project) && typeof project['name'] === 'string' ? project['name'] : `#${index}`;
    for (const option of RECORDINGS) {
      if (option in use && !isOff(use[option])) {
        problems.push(`${path}: project ${name} sets use.${option} other than 'off'; ${fix}`);
      }
    }
  }
  return problems;
}
