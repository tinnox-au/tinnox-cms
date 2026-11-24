import { describe, expect, it } from 'vitest';
import { isLoopbackAddress } from './loopback.ts';

// The two copies this rule replaced (EAX-08): the API's (mail.ts took 127.0.0.1 and ::1 as typed;
// config.ts isLoopbackHost also took localhost, *.localhost and 127.0.0.1/::1) and the e2e
// stack's (127.0.0.0/8 and every spelling of ::1, and it threw on a zone id). Where they
// disagreed the narrower answer was taken.
describe('isLoopbackAddress (EAX-08)', () => {
  it('accepts 127.0.0.1 and every spelling of ::1, bare or in URL brackets', () => {
    for (const host of [
      '127.0.0.1',
      '::1',
      '[::1]',
      '0:0::1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
    ]) {
      expect(isLoopbackAddress(host), host).toBe(true);
    }
  });

  it('refuses names, including localhost and *.localhost (the API copy took them)', () => {
    for (const host of ['localhost', 'relay.localhost', 'LOCALHOST', 'localhost.example.com', '']) {
      expect(isLoopbackAddress(host), host).toBe(false);
    }
  });

  it('refuses the rest of 127.0.0.0/8 (the e2e copy took it, the API never did)', () => {
    for (const host of ['127.0.0.2', '127.1.2.3', '127.255.255.255', '127.0.0.01']) {
      expect(isLoopbackAddress(host), host).toBe(false);
    }
  });

  it('refuses private ranges, the unspecified address, a mapped address and a zone id', () => {
    for (const host of [
      '10.0.0.5',
      '192.168.1.10',
      '172.16.0.1',
      '0.0.0.0',
      '128.0.0.1',
      '::',
      '::2',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      // isIP calls it IPv6; the e2e copy threw on it.
      '::1%lo0',
      '[::1',
      '::1]',
      '[[::1]]',
      '127.0.0.1.nip.io',
      '127.0.0.1:25',
    ]) {
      expect(() => isLoopbackAddress(host), host).not.toThrow();
      expect(isLoopbackAddress(host), host).toBe(false);
    }
  });
});
