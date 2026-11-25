/**
 * The identity-provider readers of TINNOX's provisioning script (scripts/provision-member.ts).
 * They only look accounts up: staff create and reset accounts by hand in the identity provider.
 * Two providers:
 * - Keycloak, for development: the client it uses holds `view-users` only
 *   (infra/keycloak/realm-template.json, `tinnox-provisioning`);
 * - Amazon Cognito, for a deployed environment: one AdminGetUser call, signed with the
 *   short-lived AWS credentials of the person who runs the script. No secret is stored for it.
 * Never prints a client secret, a token or an AWS credential.
 */
import { signedHeaders, type AwsCredentials } from './sigv4.ts';

export interface IdpAccount {
  /** The OIDC "sub" claim the API sees (membership.oidc_sub). */
  readonly subject: string;
  /** The account's e-mail address; null when the account has none. */
  readonly email: string | null;
  readonly enabled: boolean;
}

export interface IdpDirectory {
  /** Exactly one account whose username equals `username` (ignoring case), or null. */
  findByUsername(username: string): Promise<IdpAccount | null>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Keycloak: a client_credentials token for PROVISION_IDP_CLIENT_ID (view-users only), then
 * GET {base}/admin/realms/{realm}/users?username={u}&exact=true. In Keycloak the user id is the
 * ID token's `sub`.
 */
export function keycloakDirectory(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}): IdpDirectory {
  const issuer = new URL(options.issuer);
  const realmPath = /^(.*)\/realms\/([^/]+)\/?$/.exec(issuer.pathname);
  if (realmPath === null || realmPath[2] === undefined) {
    throw new Error('the identity-provider issuer must be a Keycloak realm URL (…/realms/<realm>)');
  }
  // The client secret and a token that reads every account go over this connection.
  if (issuer.protocol !== 'https:' && !LOCAL_HOSTS.has(issuer.hostname)) {
    throw new Error('the identity-provider issuer must use https unless it is on this machine');
  }
  const base = `${issuer.origin}${realmPath[1] ?? ''}`;
  const realm = realmPath[2];
  const send = options.fetch ?? fetch;
  const basic = Buffer.from(
    `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`,
  ).toString('base64');

  async function token(): Promise<string> {
    const response = await send(`${base}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(
        `the identity provider refused the provisioning client (HTTP ${response.status})`,
      );
    }
    const body: unknown = await response.json();
    const accessToken =
      typeof body === 'object' && body !== null && 'access_token' in body
        ? body.access_token
        : undefined;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new Error('the identity provider answered without an access token');
    }
    return accessToken;
  }

  return {
    async findByUsername(username) {
      const query = new URLSearchParams({ username, exact: 'true' });
      const response = await send(`${base}/admin/realms/${realm}/users?${query.toString()}`, {
        headers: { authorization: `Bearer ${await token()}` },
        redirect: 'error',
      });
      if (!response.ok) {
        throw new Error(`the identity-provider user search failed (HTTP ${response.status})`);
      }
      const list: unknown = await response.json();
      if (!Array.isArray(list)) throw new Error('the identity-provider user search gave no list');
      const wanted = username.toLowerCase();
      const matches = list.filter(
        (user: unknown): user is { id?: unknown; email?: unknown; enabled?: unknown } =>
          typeof user === 'object' &&
          user !== null &&
          'username' in user &&
          typeof user.username === 'string' &&
          user.username.toLowerCase() === wanted,
      );
      const user = matches.length === 1 ? matches[0] : undefined;
      if (user === undefined || typeof user.id !== 'string' || user.id === '') return null;
      return {
        subject: user.id,
        email: typeof user.email === 'string' && user.email !== '' ? user.email : null,
        enabled: user.enabled === true,
      };
    },
  };
}

const COGNITO_HOST = /^cognito-idp\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com$/;
const COGNITO_POOL = /^\/([a-z]{2}(?:-[a-z]+)+-\d_[A-Za-z0-9]+)\/?$/;

/** Whether the issuer is a Cognito user pool: https://cognito-idp.<region>.amazonaws.com/<pool id>. */
export function isCognitoIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer);
    return COGNITO_HOST.test(url.hostname) && COGNITO_POOL.test(url.pathname);
  } catch {
    return false;
  }
}

function attribute(list: unknown, name: string): string | null {
  if (!Array.isArray(list)) return null;
  for (const entry of list as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (!('Name' in entry) || entry.Name !== name) continue;
    if ('Value' in entry && typeof entry.Value === 'string' && entry.Value !== '') {
      return entry.Value;
    }
  }
  return null;
}

/**
 * Amazon Cognito: AdminGetUser on the pool the issuer names. The pool signs people in by e-mail
 * address (infra/aws/identity.yml), so the "username" of a provisioning command is the e-mail
 * address, and the account's `sub` attribute is the ID token's `sub`.
 *
 * AdminGetUser also finds an account by its internal user name, which in such a pool is the
 * `sub` itself. A provisioning command names a person, not an identifier, so anything that is
 * not an e-mail address finds nothing, and an account counts only when its own e-mail attribute
 * is the address that was asked for.
 *
 * The caller needs `cognito-idp:AdminGetUser` on the pool and nothing else.
 */
export function cognitoDirectory(options: {
  issuer: string;
  credentials: AwsCredentials;
  fetch?: typeof fetch;
  now?: () => Date;
}): IdpDirectory {
  const issuer = new URL(options.issuer);
  const region = COGNITO_HOST.exec(issuer.hostname)?.[1];
  const pool = COGNITO_POOL.exec(issuer.pathname)?.[1];
  if (issuer.protocol !== 'https:' || region === undefined || pool === undefined) {
    throw new Error(
      'the identity-provider issuer must be a Cognito user pool URL (https://cognito-idp.<region>.amazonaws.com/<pool id>)',
    );
  }
  // The pool's Region must be the one the pool id starts with: the request goes there.
  if (!pool.startsWith(`${region}_`)) {
    throw new Error('the identity-provider issuer names a pool of another Region');
  }
  const { credentials } = options;
  if (credentials.accessKeyId === '' || credentials.secretAccessKey === '') {
    throw new Error('AWS credentials are required to read the Cognito user pool');
  }
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const endpoint = new URL(`https://cognito-idp.${region}.amazonaws.com/`);

  return {
    async findByUsername(username) {
      const wanted = username.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(wanted)) return null;
      const body = JSON.stringify({ UserPoolId: pool, Username: wanted });
      const response = await send(endpoint, {
        method: 'POST',
        headers: signedHeaders({
          method: 'POST',
          url: endpoint,
          headers: {
            'content-type': 'application/x-amz-json-1.1',
            'x-amz-target': 'AWSCognitoIdentityProviderService.AdminGetUser',
          },
          body,
          region,
          service: 'cognito-idp',
          credentials,
          now: now(),
        }),
        body,
        redirect: 'error',
      });
      const answer: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const kind =
          typeof answer === 'object' &&
          answer !== null &&
          '__type' in answer &&
          typeof answer.__type === 'string'
            ? (answer.__type.split('#').at(-1) ?? '')
            : '';
        if (response.status === 400 && kind === 'UserNotFoundException') return null;
        // The kind only: an AWS error message can repeat what was sent.
        throw new Error(
          `the identity-provider user lookup failed (HTTP ${response.status}${/^[A-Za-z]+$/.test(kind) ? `, ${kind}` : ''})`,
        );
      }
      if (typeof answer !== 'object' || answer === null) {
        throw new Error('the identity-provider user lookup gave no account');
      }
      const attributes = 'UserAttributes' in answer ? answer.UserAttributes : undefined;
      const subject = attribute(attributes, 'sub');
      const email = attribute(attributes, 'email');
      if (subject === null || email === null || email.trim().toLowerCase() !== wanted) return null;
      return {
        subject,
        email,
        enabled: 'Enabled' in answer && answer.Enabled === true,
      };
    },
  };
}
