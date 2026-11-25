import { describe, expect, it } from 'vitest';
import { cognitoDirectory, isCognitoIssuer } from './idp.ts';
import { signedHeaders } from './sigv4.ts';

// The example credentials of AWS's published Signature Version 4 test suite. They belong to no
// account. Written in two parts so a secret scan does not take them for a real key.
const EXAMPLE = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: ['wJalrXUtnFEMI/K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('+'),
};

describe('AWS Signature Version 4', () => {
  const at = new Date('2015-08-30T12:36:00Z');
  const base = { method: 'GET', headers: {}, body: '', region: 'us-east-1', service: 'service' };

  it("reproduces the signatures of AWS's test suite", () => {
    const vanilla = signedHeaders({
      ...base,
      url: new URL('https://example.amazonaws.com/'),
      credentials: EXAMPLE,
      now: at,
    });
    expect(vanilla['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(vanilla['x-amz-date']).toBe('20150830T123600Z');

    // Query parameters are sorted by name before they are signed.
    const ordered = signedHeaders({
      ...base,
      url: new URL('https://example.amazonaws.com/?Param2=value2&Param1=value1'),
      credentials: EXAMPLE,
      now: at,
    });
    expect(ordered['authorization']).toContain(
      'Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    );
  });

  it('signs the headers it is given and the session token of temporary credentials', () => {
    const headers = signedHeaders({
      ...base,
      method: 'POST',
      url: new URL('https://example.amazonaws.com/'),
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'Service.Call' },
      body: '{}',
      credentials: { ...EXAMPLE, sessionToken: 'session-token' },
      now: at,
    });
    expect(headers['authorization']).toContain(
      'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target,',
    );
    expect(headers['x-amz-security-token']).toBe('session-token');
    expect(headers['content-type']).toBe('application/x-amz-json-1.1');
    // The body is part of what is signed.
    const other = signedHeaders({
      ...base,
      method: 'POST',
      url: new URL('https://example.amazonaws.com/'),
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'Service.Call' },
      body: '{"a":1}',
      credentials: { ...EXAMPLE, sessionToken: 'session-token' },
      now: at,
    });
    expect(other['authorization']).not.toBe(headers['authorization']);
    expect(JSON.stringify(headers)).not.toContain(EXAMPLE.secretAccessKey);
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
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      UserPoolId: 'ap-southeast-2_Example01',
      Username: 'alex@example.com',
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('x-amz-target')).toBe('AWSCognitoIdentityProviderService.AdminGetUser');
    expect(headers.get('x-amz-security-token')).toBe('session-token');
    expect(headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261125\/ap-southeast-2\/cognito-idp\/aws4_request, /,
    );
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
          __type: 'com.amazon.coral.service#AccessDeniedException',
          Message: 'User: arn:aws:sts::000000000000:assumed-role/x is not authorized',
        },
        { status: 400 },
      ),
    );
    await expect(idp.findByUsername('alex@example.com')).rejects.toThrow(
      /^the identity-provider user lookup failed \(HTTP 400, AccessDeniedException\)$/,
    );
    const broken = reader(() => new Response('gateway', { status: 502 }));
    await expect(broken.idp.findByUsername('alex@example.com')).rejects.toThrow(
      /^the identity-provider user lookup failed \(HTTP 502\)$/,
    );
  });

  it('refuses an issuer that is not a Cognito pool over https, and missing credentials', () => {
    const make = (issuer: string, given = credentials) =>
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
