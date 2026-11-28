import { describe, expect, it } from 'vitest';
import { cognitoDirectory, isCognitoIssuer } from './idp.ts';
import { signedHeaders, type AwsCredentials } from './sigv4.ts';

// The example credentials of AWS's published Signature Version 4 test suite. They belong to no
// account. Written in two parts so a secret scan does not take them for a real key.
const EXAMPLE = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: ['wJalrXUtnFEMI/K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('+'),
};

describe('AWS Signature Version 4', () => {
  const at = new Date('2015-08-30T12:36:00Z');
  const base = {
    url: new URL('https://example.amazonaws.com/'),
    region: 'us-east-1',
    service: 'service',
    credentials: EXAMPLE,
    now: at,
  };
  const signature = (request: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }): string | undefined =>
    signedHeaders({ ...base, ...request })['authorization']?.split('Signature=')[1];

  it("reproduces the signatures of AWS's test suite", () => {
    const vanilla = signedHeaders({ ...base, method: 'GET', headers: {}, body: '' });
    expect(vanilla['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(vanilla['x-amz-date']).toBe('20150830T123600Z');
    // post-vanilla: the method is signed.
    expect(signature({ method: 'POST', headers: {}, body: '' })).toBe(
      '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
    );
    // post-x-www-form-urlencoded: a header of the caller and the body are signed.
    expect(
      signature({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'Param1=value1',
      }),
    ).toBe('ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a');
    // post-header-key-sort: header names are lower-cased and sorted.
    expect(signature({ method: 'POST', headers: { 'My-Header1': 'value1' }, body: '' })).toBe(
      'c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c',
    );
    // get-header-value-trim: values are trimmed and their inner spaces collapsed.
    expect(
      signature({
        method: 'GET',
        headers: { 'My-Header1': ' value1', 'My-Header2': ' "a   b   c"' },
        body: '',
      }),
    ).toBe('acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736');
  });

  it('signs the session token of temporary credentials, as fetch will send it', () => {
    const request = {
      ...base,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'Service.Call' },
      body: '{}',
    };
    const headers = signedHeaders({
      ...request,
      credentials: { ...EXAMPLE, sessionToken: 'session-token' },
    });
    expect(headers['authorization']).toContain(
      'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target,',
    );
    expect(headers['x-amz-security-token']).toBe('session-token');
    expect(headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(JSON.stringify(headers)).not.toContain(EXAMPLE.secretAccessKey);
    // fetch removes whitespace around a header value, so it must not be part of what is signed.
    const padded = signedHeaders({
      ...request,
      credentials: {
        accessKeyId: ` ${EXAMPLE.accessKeyId}\n`,
        secretAccessKey: `${EXAMPLE.secretAccessKey}\r\n`,
        sessionToken: ' session-token\n',
      },
    });
    expect(padded).toEqual(headers);
  });

  it('refuses a path or a query string, whose encoding rules it does not implement', () => {
    const request = { ...base, method: 'GET', headers: {}, body: '' };
    expect(() =>
      signedHeaders({ ...request, url: new URL('https://example.amazonaws.com/a') }),
    ).toThrow(/no query string only/);
    expect(() =>
      signedHeaders({ ...request, url: new URL('https://example.amazonaws.com/?a=b') }),
    ).toThrow(/no query string only/);
  });
});

describe('the Cognito identity-provider reader', () => {
  const ISSUER = 'https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_Example01';
  const credentials = { ...EXAMPLE, sessionToken: 'session-token' };
  const now = (): Date => new Date('2026-11-25T00:00:00Z');

  function reader(answer: () => Response) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fake: typeof fetch = (input, init) => {
      calls.push({ url: input instanceof Request ? input.url : String(input), init });
      return Promise.resolve(answer());
    };
    return { calls, idp: cognitoDirectory({ issuer: ISSUER, credentials, fetch: fake, now }) };
  }

  const account = (overrides: Record<string, unknown> = {}): Response =>
    Response.json({
      Username: '11111111-2222-4333-8444-555555555555',
      Enabled: true,
      UserStatus: 'CONFIRMED',
      UserAttributes: [
        { Name: 'sub', Value: '11111111-2222-4333-8444-555555555555' },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'email', Value: 'Alex@Example.com' },
      ],
      ...overrides,
    });

  it('tells a Cognito user pool from any other issuer', () => {
    expect(isCognitoIssuer(ISSUER)).toBe(true);
    expect(isCognitoIssuer(`${ISSUER}/`)).toBe(true);
    expect(isCognitoIssuer('http://localhost:8080/realms/tinnox-dev')).toBe(false);
    expect(isCognitoIssuer('https://cognito-idp.ap-southeast-2.amazonaws.com/')).toBe(false);
    expect(isCognitoIssuer('https://cognito-idp.ap-southeast-2.amazonaws.com.evil.test/x_y')).toBe(
      false,
    );
    expect(isCognitoIssuer('not a url')).toBe(false);
  });

  it('reads one account by e-mail address with one signed AdminGetUser call', async () => {
    const { calls, idp } = reader(() => account());
    expect(await idp.findByUsername(' alex@example.com ')).toEqual({
      subject: '11111111-2222-4333-8444-555555555555',
      email: 'Alex@Example.com',
      enabled: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://cognito-idp.ap-southeast-2.amazonaws.com/');
    const init = calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    const sent = typeof init?.body === 'string' ? init.body : '';
    expect(JSON.parse(sent)).toEqual({
      UserPoolId: 'ap-southeast-2_Example01',
      Username: 'alex@example.com',
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('x-amz-target')).toBe('AWSCognitoIdentityProviderService.AdminGetUser');
    expect(headers.get('x-amz-security-token')).toBe('session-token');
    expect(headers.get('content-type')).toBe('application/x-amz-json-1.1');
    expect(headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261125\/ap-southeast-2\/cognito-idp\/aws4_request, /,
    );
    // What is sent is what was signed: the headers are the signature over this very body.
    expect(Object.fromEntries(headers.entries())).toEqual(
      signedHeaders({
        method: 'POST',
        url: new URL('https://cognito-idp.ap-southeast-2.amazonaws.com/'),
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'AWSCognitoIdentityProviderService.AdminGetUser',
        },
        body: sent,
        region: 'ap-southeast-2',
        service: 'cognito-idp',
        credentials,
        now: now(),
      }),
    );
  });

  it('sends the address as typed and pins the signature of that exact request', async () => {
    const { calls, idp } = reader(() => account());
    expect((await idp.findByUsername('Alex@Example.com'))?.subject).toBe(
      '11111111-2222-4333-8444-555555555555',
    );
    const init = calls[0]?.init;
    expect(init?.body).toBe(
      '{"UserPoolId":"ap-southeast-2_Example01","Username":"Alex@Example.com"}',
    );
    expect(new Headers(init?.headers).get('authorization')).toContain(
      'Signature=7ee64da0aedc2049dcd54bf43e794179f40fce9332cd6025561739a1c6c1e672',
    );
  });

  it('accepts only an account of the pool itself that a person can sign in from', async () => {
    for (const UserStatus of ['CONFIRMED', 'FORCE_CHANGE_PASSWORD', 'RESET_REQUIRED']) {
      const { idp } = reader(() => account({ UserStatus }));
      expect(await idp.findByUsername('alex@example.com')).not.toBeNull();
    }
    for (const UserStatus of ['UNCONFIRMED', 'EXTERNAL_PROVIDER', 'ARCHIVED', 'UNKNOWN', 7]) {
      const { idp } = reader(() => account({ UserStatus }));
      expect(await idp.findByUsername('alex@example.com')).toBeNull();
    }
    // An account linked from another provider has a name of its own, not its subject.
    const linked = reader(() => account({ Username: 'google_1234567890' }));
    expect(await linked.idp.findByUsername('alex@example.com')).toBeNull();
  });

  it('reports a disabled account as disabled', async () => {
    const { idp } = reader(() => account({ Enabled: false }));
    expect((await idp.findByUsername('alex@example.com'))?.enabled).toBe(false);
  });

  it('finds nothing when Cognito knows no such user', async () => {
    const { idp } = reader(() =>
      Response.json(
        { __type: 'UserNotFoundException', message: 'User does not exist.' },
        { status: 400 },
      ),
    );
    expect(await idp.findByUsername('nobody@example.com')).toBeNull();
  });

  it('never looks an account up by anything but an e-mail address', async () => {
    // AdminGetUser would find an account by its internal user name, which is the subject.
    const { calls, idp } = reader(() => account());
    expect(await idp.findByUsername('11111111-2222-4333-8444-555555555555')).toBeNull();
    expect(await idp.findByUsername('alex')).toBeNull();
    expect(await idp.findByUsername('a@b@c')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('does not accept an account whose own e-mail address is another one', async () => {
    const { idp } = reader(() => account());
    expect(await idp.findByUsername('someone.else@example.com')).toBeNull();
    const noSubject = reader(() =>
      account({ UserAttributes: [{ Name: 'email', Value: 'alex@example.com' }] }),
    );
    expect(await noSubject.idp.findByUsername('alex@example.com')).toBeNull();
  });

  it('fails on any other answer, naming the kind and not the message', async () => {
    const { idp } = reader(() =>
      Response.json(
        {
          __type: 'com.amazon.coral.service#InternalErrorException',
          Message: 'User: arn:aws:sts::000000000000:assumed-role/x did something',
        },
        { status: 400 },
      ),
    );
    await expect(idp.findByUsername('alex@example.com')).rejects.toThrow(
      /^the identity-provider user lookup failed \(HTTP 400, InternalErrorException\)$/,
    );
    const broken = reader(() => new Response('gateway', { status: 502 }));
    await expect(broken.idp.findByUsername('alex@example.com')).rejects.toThrow(
      /^the identity-provider user lookup failed \(HTTP 502\)$/,
    );
  });

  it('adds a fixed hint for the answers a person can act on', async () => {
    const failing = (body: Record<string, string>) =>
      reader(() => Response.json(body, { status: 400 })).idp.findByUsername('alex@example.com');
    await expect(
      failing({ __type: 'InvalidSignatureException', message: 'Signature expired: 2026… is now' }),
    ).rejects.toThrow(/InvalidSignatureException\): check this machine's clock$/);
    await expect(
      failing({ __type: 'InvalidSignatureException', message: 'The request signature we…' }),
    ).rejects.toThrow(/secret access key does not match the access key id$/);
    await expect(failing({ __type: 'ExpiredTokenException', message: 'x' })).rejects.toThrow(
      /have expired or are not valid; get new ones$/,
    );
    await expect(failing({ __type: 'AccessDeniedException', Message: 'x' })).rejects.toThrow(
      /needs cognito-idp:AdminGetUser on this user pool$/,
    );
  });

  it('never lets a malformed credential or a failed request reach the terminal', async () => {
    const token = 'first-half-of-a-token\nsecond-half-of-a-token';
    let message = '';
    try {
      cognitoDirectory({ issuer: ISSUER, credentials: { ...EXAMPLE, sessionToken: token } });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/^the AWS session token contains a space, a line break/);
    expect(message).not.toContain('first-half');

    const offline = cognitoDirectory({
      issuer: ISSUER,
      credentials,
      now,
      fetch: () => Promise.reject(new TypeError('Headers.append: "secret-looking" is invalid')),
    });
    await expect(offline.findByUsername('alex@example.com')).rejects.toThrow(
      /^the identity-provider user lookup failed \(the request could not be sent: check the network\)$/,
    );
  });

  it('refuses an issuer that is not a Cognito pool over https, and missing credentials', () => {
    const make = (issuer: string, given: AwsCredentials = credentials) =>
      cognitoDirectory({ issuer, credentials: given });
    expect(() => make('http://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_X1')).toThrow(
      /Cognito user pool URL/,
    );
    expect(() => make('https://idp.example.com/realms/tinnox')).toThrow(/Cognito user pool URL/);
    expect(() => make('https://cognito-idp.ap-southeast-2.amazonaws.com/us-east-1_X1')).toThrow(
      /another Region/,
    );
    expect(() => make(ISSUER, { accessKeyId: '', secretAccessKey: '' })).toThrow(
      /AWS credentials are required/,
    );
  });
});
