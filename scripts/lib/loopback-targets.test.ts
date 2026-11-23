import { describe, expect, it } from 'vitest';
import {
  allowListedEnv,
  hostsOf,
  isLoopbackAddress,
  isLoopbackTarget,
  localhostProblem,
  loopbackProblems,
  pointsSomewhere,
  type Target,
} from './loopback-targets.ts';

const target = (name: string, value: string): Target => ({ name, value, source: 'the root .env' });

describe('isLoopbackAddress (EAX-08, EAX-09)', () => {
  it('accepts 127.0.0.0/8 and ::1 in every spelling', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '127.255.255.255', '::1', '[::1]', '0:0::1']) {
      expect(isLoopbackAddress(host), host).toBe(true);
    }
  });

  it('refuses names, private ranges, the unspecified address and a mapped address', () => {
    for (const host of [
      'localhost',
      '10.0.0.5',
      '192.168.1.10',
      '172.16.0.1',
      '0.0.0.0',
      '::',
      '::ffff:127.0.0.1',
      '128.0.0.1',
    ]) {
      expect(isLoopbackAddress(host), host).toBe(false);
    }
  });
});

describe('isLoopbackTarget and hostsOf (EAX-09)', () => {
  it('accepts localhost, 127.0.0.0/8 and ::1, bare and in URLs', () => {
    for (const value of [
      'localhost',
      '127.0.0.1',
      '127.9.9.9',
      '::1',
      'http://localhost:5173',
      'http://127.0.0.1:8025/api/v1',
      'http://[::1]:4000',
      'HTTP://LOCALHOST:8080/realms/tinnox-dev',
    ]) {
      const hosts = hostsOf(value);
      expect(hosts !== null && hosts.every(isLoopbackTarget), value).toBe(true);
    }
  });

  it('refuses a public name, a private-range address and names that only look local', () => {
    for (const value of [
      'smtp.example.com',
      'https://idp.example.com/realms/x',
      '192.168.1.20',
      'http://10.1.2.3:4000',
      'relay.localhost',
      'localhost.example.com',
      '127.0.0.1.nip.io',
      'http://127.0.0.1.example.com/',
      // The userinfo trick: the host is what follows the last @.
      'http://127.0.0.1@evil.example/',
      // pg-connection-string connects to a host query parameter over the authority.
      'postgres://u:p@127.0.0.1/db?host=db.example.com',
      'postgres://u:p@localhost/db?host=127.0.0.1,db.example.com',
      'postgres://u:p@127.0.0.1/db?hostaddr=10.0.0.5',
    ]) {
      const hosts = hostsOf(value);
      expect(hosts !== null && hosts.every(isLoopbackTarget), value).toBe(false);
    }
  });

  it('reads every host of a URL: its authority and its host and hostaddr parameters', () => {
    expect(
      hostsOf('postgres://u:p@127.0.0.1:54329/db?host=localhost,::1&hostaddr=127.0.0.2'),
    ).toEqual(['127.0.0.1', 'localhost', '::1', '127.0.0.2']);
  });

  it('reads no host from a value that is neither a URL nor a host name', () => {
    for (const value of [
      '127.0.0.1:1025',
      'smtp example com',
      'http://',
      'mailto:a@b.c',
      // A socket path in a host parameter is not an address this check can judge.
      'postgres://u:p@127.0.0.1/db?host=/var/run/postgresql',
    ]) {
      expect(hostsOf(value), value).toBe(null);
    }
  });
});

describe('pointsSomewhere (EAX-09)', () => {
  it('takes the _HOST, _URL, _URI, _ORIGIN and _ISSUER names and any value that is a URL', () => {
    expect(pointsSomewhere('SMTP_HOST', '127.0.0.1')).toBe(true);
    expect(pointsSomewhere('DATABASE_URL', 'x')).toBe(true);
    expect(pointsSomewhere('OIDC_REDIRECT_URI', 'x')).toBe(true);
    expect(pointsSomewhere('PORTAL_ORIGIN', 'x')).toBe(true);
    expect(pointsSomewhere('OIDC_ISSUER', 'x')).toBe(true);
    expect(pointsSomewhere('WEBHOOK_TARGET', 'https://hooks.example.com/x')).toBe(true);
  });

  it('skips empty values and values that are not addresses', () => {
    expect(pointsSomewhere('SMTP_HOST', '')).toBe(false);
    expect(pointsSomewhere('SMTP_PORT', '1025')).toBe(false);
    expect(pointsSomewhere('MEDIA_ROOT', './data/media')).toBe(false);
  });
});

describe('loopbackProblems (EAX-09)', () => {
  it('passes the stack as this repository configures it', () => {
    expect(
      loopbackProblems([
        target('SMTP_HOST', '127.0.0.1'),
        target('API_HOST', '127.0.0.1'),
        target('OIDC_ISSUER', 'http://localhost:8080/realms/tinnox-dev'),
        target('DATABASE_URL', 'postgres://tinnox_app:pw@127.0.0.1:54329/tinnox_e2e_test'),
        target('SMTP_PORT', '1025'),
        target('SMTP_USER', ''),
      ]),
    ).toEqual([]);
  });

  it('refuses a public SMTP_HOST, naming the variable, its source and what to set', () => {
    const [problem, ...rest] = loopbackProblems([target('SMTP_HOST', 'smtp.example.com')]);
    expect(rest).toEqual([]);
    expect(problem).toContain('SMTP_HOST (the root .env) points at smtp.example.com');
    expect(problem).toContain('set it to localhost, 127.0.0.1 or ::1');
  });

  it('refuses a URL with credentials in it without showing them', () => {
    const problems = loopbackProblems([
      target('DATABASE_URL', 'postgres://tinnox_app:s3cret-pw@db.example.com:5432/tinnox'),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('DATABASE_URL (the root .env) points at db.example.com');
    expect(problems[0]).not.toContain('s3cret-pw');
    expect(problems[0]).not.toContain('tinnox_app');
  });

  it('refuses a database URL whose host parameter leaves this machine, without its password', () => {
    const problems = loopbackProblems([
      target(
        'DATABASE_MIGRATOR_URL',
        'postgres://tinnox_migrator:s3cret-pw@127.0.0.1:54330/tinnox?host=db.example.com',
      ),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      'DATABASE_MIGRATOR_URL (the root .env) points at db.example.com,',
    );
    expect(problems[0]).toContain('a host or hostaddr query parameter');
    expect(problems[0]).not.toContain('s3cret-pw');
  });

  it('refuses a value it cannot read without showing it', () => {
    const problems = loopbackProblems([target('SMTP_HOST', 'user:s3cret@relay:25')]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('SMTP_HOST (the root .env) is not a host name or a URL');
    expect(problems[0]).not.toContain('s3cret');
  });

  it('refuses a URL under any name, and reports every target', () => {
    expect(
      loopbackProblems([
        target('WEBHOOK_TARGET', 'https://hooks.example.com/x'),
        target('OIDC_ISSUER', 'https://login.example.com/realms/x'),
      ]).map((problem) => problem.split(' (')[0]),
    ).toEqual(['WEBHOOK_TARGET', 'OIDC_ISSUER']);
  });
});

describe('localhostProblem (EAX-08, EAX-09)', () => {
  it('passes when localhost resolves to loopback addresses only', () => {
    expect(localhostProblem(['127.0.0.1', '::1'])).toBe(null);
  });

  it('refuses a localhost that resolves elsewhere, or to nothing', () => {
    expect(localhostProblem(['127.0.0.1', '192.168.1.5'])).toContain('resolves to 192.168.1.5');
    expect(localhostProblem([])).toContain('resolves to nothing');
  });
});

describe('allowListedEnv (EAX-09)', () => {
  const names = ['SMTP_HOST', 'OIDC_ISSUER', 'TRUST_PROXY', 'LIMIT_X'];

  it('takes fixed values and listed names only, and blanks every other name', () => {
    expect(
      allowListedEnv(
        { names, fixed: { SMTP_HOST: '127.0.0.1' }, fromSource: ['OIDC_ISSUER'] },
        {
          SMTP_HOST: 'smtp.example.com',
          OIDC_ISSUER: 'http://localhost:8080/realms/tinnox-dev',
          TRUST_PROXY: '10.0.0.0/8',
          HOME: '/home/someone',
        },
      ),
    ).toEqual({
      SMTP_HOST: '127.0.0.1',
      OIDC_ISSUER: 'http://localhost:8080/realms/tinnox-dev',
      TRUST_PROXY: '',
      LIMIT_X: '',
    });
  });

  it('refuses a listed name the process does not read, and a name listed twice', () => {
    expect(() =>
      allowListedEnv({ names, fixed: { SMTP_HOSTNAME: 'x' }, fromSource: [] }, {}),
    ).toThrow('SMTP_HOSTNAME is not read by the process');
    expect(() =>
      allowListedEnv({ names, fixed: { SMTP_HOST: 'x' }, fromSource: ['SMTP_HOST'] }, {}),
    ).toThrow('SMTP_HOST is both fixed and taken from the source');
  });
});
