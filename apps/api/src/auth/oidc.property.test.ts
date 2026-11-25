import fc from 'fast-check';
import { LogoutResponseSchema } from '@tinnox/contracts';
import * as oidc from 'openid-client';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.ts';
import { MAX_TOKEN_LENGTH, tokenArb } from './oidc.test-support.ts';
import { createIdentityProvider } from './oidc.ts';

// Adoption plan section 4.4, property 12 (UTX-01), and D11: every run draws a fresh seed, and a
// failure prints the seed and the shrunk counterexample. A counterexample is committed below as
// a plain example test with its fix, never as a seed or path.

// Discovery is replaced so no provider is needed; URL building stays the library's own (as in
// oidc.test.ts).
vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof oidc>();
  return { ...actual, discovery: vi.fn() };
});

const ISSUER = 'https://id.signage.example/realms/tinnox';

const config = {
  oidc: {
    issuer: ISSUER,
    clientId: 'tinnox-portal',
    clientSecret: 'test-secret',
    redirectUri: 'http://localhost:3000/api/auth/callback',
    postLogoutRedirectUri: 'http://localhost:5173/',
    mfaAcrValues: [],
    mfaAmrValues: [],
    allowInsecureRequests: false,
  },
} as unknown as AppConfig;

vi.mocked(oidc.discovery).mockResolvedValue(
  new oidc.Configuration(
    { issuer: ISSUER, end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout` },
    config.oidc.clientId,
  ),
);
const provider = createIdentityProvider(config);

describe('end-session generators: self-checks', () => {
  it('tokens are 0 to 8192 characters long', () => {
    fc.assert(
      fc.property(tokenArb, (token) => {
        expect(token.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
      }),
    );
  });
});

describe('endSessionUrl: properties (property 12, UTX-01)', () => {
  it('what the API answers for any stored ID token parses with LogoutResponseSchema', async () => {
    await fc.assert(
      fc.asyncProperty(fc.option(tokenArb, { nil: null }), async (token) => {
        const redirectTo = await provider.endSessionUrl(token);
        expect(LogoutResponseSchema.safeParse({ redirectTo }).error?.issues ?? []).toEqual([]);
        // Never null with this provider: the URL without the token always fits.
        expect(redirectTo).not.toBeNull();
      }),
    );
  });
});
