/**
 * AWS Signature Version 4 for one HTTPS request, with node:crypto only. The provisioning
 * script's Cognito reader (scripts/lib/idp.ts) is its one caller: it signs a single POST with
 * the short-lived credentials of the person who runs the script. The repository has no AWS SDK,
 * and one request does not justify one.
 *
 * It is not a general signer. It signs a request to the path "/" with no query string, which
 * is what AWS's JSON services take: the rules for encoding other paths and queries differ
 * between services, and nothing here needs them. Any other URL is refused.
 *
 * It signs exactly the headers it is given, plus `host`, `x-amz-date` and, when the credentials
 * carry one, `x-amz-security-token`. Every value is signed as fetch sends it: surrounding
 * whitespace removed. Never prints or returns the secret key.
 */
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present for temporary credentials (a role, AWS CloudShell, single sign-on). */
  readonly sessionToken?: string;
}

export interface RequestToSign {
  readonly method: string;
  readonly url: URL;
  /** Headers to send and to sign. Names in any case; `host` and the two `x-amz-` ones are added. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * The headers to send with the request: the ones given (names in lower case), `host`,
 * `x-amz-date`, `x-amz-security-token` for temporary credentials, and `authorization`.
 */
export function signedHeaders(request: RequestToSign): Record<string, string> {
  const { credentials, region, service, url } = request;
  if (url.pathname !== '/' || url.search !== '') {
    throw new Error('this signer takes a request to "/" with no query string only');
  }
  const stamp = request.now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  }
  headers['host'] = url.host;
  headers['x-amz-date'] = stamp;
  const sessionToken = credentials.sessionToken?.trim() ?? '';
  if (sessionToken !== '') headers['x-amz-security-token'] = sessionToken;

  const names = Object.keys(headers).sort();
  const signed = names.join(';');
  const canonical = [
    request.method.toUpperCase(),
    '/',
    '',
    ...names.map((name) => `${name}:${headers[name] ?? ''}`),
    '',
    signed,
    sha256Hex(request.body),
  ].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey.trim()}`, day), region), service),
    'aws4_request',
  );
  const signature = hmac(key, toSign).toString('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId.trim()}/${scope}, ` +
    `SignedHeaders=${signed}, Signature=${signature}`;
  return headers;
}
