/**
 * The media worker runs with no network, a read-only root, no capabilities and no secrets
 * (OTH-15, adoption plan step 33; prototype-m0.md D11), wherever it runs. Each compose file
 * that defines it is rendered by Docker Compose itself (`docker compose config`), judged by the
 * rules of scripts/lib/worker-runtime-check.ts, and compared with the other; the image's USER
 * is compared with them; and a container created with the options the worker tests use
 * (`workerContainerArgs`, built from infra/docker-compose.yml) is inspected, so what Docker
 * actually applies is what the compose file says.
 *
 * Needs Docker and the image `tinnox-cms-media-worker:m0` (`npm run infra:up` builds it).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dockerfileUser,
  isolationOf,
  WORKER_COMPOSE_FILES,
  WORKER_DOCKERFILE,
  workerServiceProblems,
} from '../../scripts/lib/worker-runtime-check.ts';
import { composeWorkerService, repoRoot, WORKER_IMAGE, workerContainerArgs } from './support.ts';

describe('the media worker runs isolated wherever it is defined (OTH-15)', () => {
  const services = WORKER_COMPOSE_FILES.map((file) => ({
    file,
    service: composeWorkerService(file),
  }));

  it.each(WORKER_COMPOSE_FILES)('%s gives the worker every isolation property', (file) => {
    const found = services.find((s) => s.file === file);
    expect(found).toBeDefined();
    expect(workerServiceProblems(file, found?.service ?? {})).toEqual([]);
  });

  it('defines the same isolation in development and on a deployed server', () => {
    const [development, ...others] = services;
    for (const other of others) {
      expect(
        isolationOf(other.service),
        `${other.file} against ${String(development?.file)}`,
      ).toEqual(isolationOf(development?.service ?? {}));
    }
  });

  it('runs as the user the image is built for', () => {
    const user = dockerfileUser(readFileSync(join(repoRoot, WORKER_DOCKERFILE), 'utf8'));
    for (const { file, service } of services) expect(service['user'], file).toBe(user);
  });

  it('starts the test container with what Docker applies for the compose file', () => {
    const jobsDir = mkdtempSync(join(tmpdir(), 'tinnox-worker-runtime-'));
    // Created, not started: the configuration is what is read, and nothing runs.
    const id = execFileSync('docker', ['create', ...workerContainerArgs(jobsDir), WORKER_IMAGE], {
      encoding: 'utf8',
    }).trim();
    try {
      const [inspected] = JSON.parse(
        execFileSync('docker', ['inspect', id], { encoding: 'utf8' }),
      ) as {
        Config: { User: string; Env: string[] };
        HostConfig: {
          NetworkMode: string;
          ReadonlyRootfs: boolean;
          CapDrop: string[] | null;
          CapAdd: string[] | null;
          SecurityOpt: string[] | null;
          Privileged: boolean;
          PidsLimit: number;
          Binds: string[] | null;
        };
      }[];
      const host = inspected?.HostConfig;
      expect({
        network: host?.NetworkMode,
        readOnlyRoot: host?.ReadonlyRootfs,
        capDrop: host?.CapDrop,
        capAdd: host?.CapAdd,
        securityOpt: host?.SecurityOpt,
        privileged: host?.Privileged,
        pids: host?.PidsLimit,
        mounts: host?.Binds,
        user: inspected?.Config.User,
      }).toEqual({
        network: 'none',
        readOnlyRoot: true,
        capDrop: ['ALL'],
        capAdd: null,
        securityOpt: ['no-new-privileges:true'],
        privileged: false,
        pids: 128,
        mounts: [`${jobsDir}:/jobs:rw`],
        user: '10001:10001',
      });
      // No secret reaches it: its environment is the image's own and the compose file's.
      const namesOf = (env: readonly string[]): string[] =>
        env.map((entry) => entry.slice(0, entry.indexOf('=')));
      const [image] = JSON.parse(
        execFileSync('docker', ['image', 'inspect', WORKER_IMAGE], { encoding: 'utf8' }),
      ) as { Config: { Env: string[] | null } }[];
      const allowed = new Set([
        ...namesOf(image?.Config.Env ?? []),
        ...Object.keys(services[0]?.service['environment'] ?? {}),
      ]);
      expect(namesOf(inspected?.Config.Env ?? []).filter((name) => !allowed.has(name))).toEqual([]);
    } finally {
      execFileSync('docker', ['rm', '--force', id], { stdio: 'ignore' });
      rmSync(jobsDir, { recursive: true, force: true });
    }
  });
});
