// Prints, as a JSON array, the options of Docker's `run` command that start the media worker on
// a job folder of the host with the isolation of its service in infra/docker-compose.yml (OTH-15;
// rules in scripts/lib/worker-runtime-check.ts). For a tool outside scripts/ and tests/, which
// may not import scripts/lib: apps/media-worker/scripts/direct-check.mjs.
//   node scripts/worker-run-args.ts <job folder>
import { resolve } from 'node:path';
import { repoRoot } from './lib/env.ts';
import {
  DEVELOPMENT_COMPOSE_FILE,
  renderedWorkerService,
  workerRunArgs,
} from './lib/worker-runtime-check.ts';

const jobs = process.argv[2];
if (jobs === undefined || jobs === '') {
  process.stderr.write('usage: node scripts/worker-run-args.ts <job folder>\n');
  process.exit(2);
}
process.stdout.write(
  `${JSON.stringify(workerRunArgs(renderedWorkerService(repoRoot, DEVELOPMENT_COMPOSE_FILE), resolve(jobs)))}\n`,
);
