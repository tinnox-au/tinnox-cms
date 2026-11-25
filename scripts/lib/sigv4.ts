/**
 * AWS Signature Version 4 for one HTTPS request, with node:crypto only. The provisioning
 * script's Cognito reader (scripts/lib/idp.ts) is its one caller: it signs a single POST with
 * the short-lived credentials of the person who runs the script. The repository has no AWS SDK,
 * and one request does not justify one.
 *
 * It signs exactly the headers it is given, plus `host`, `x-amz-date` and, when the credentials
 * carry one, `x-amz-security-token`. Never prints or returns the secret key.
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

/** RFC 3986 unreserved characters stay; everything else is percent-encoded, in capitals. */
function encode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalPath(pathname: string): string {
  // Each segment encoded once, as the services other than S3 expect. The URL class has already
  // percent-encoded the path, so it is decoded first.
  return pathname
    .split('/')
    .map((segment) => encode(decodeURIComponent(segment)))
    .join('/');
}

function canonicalQuery(parameters: URLSearchParams): string {
  return [...parameters.entries()]
    .map(([name, value]): [string, string] => [encode(name), encode(value)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/**
 * The headers to send with the request: the ones given (names in lower case), `host`,
 * `x-amz-date`, `x-amz-security-token` for temporary credentials, and `authorization`.
 */
export function signedHeaders(request: RequestToSign): Record<string, string> {
  const { credentials, region, service, url } = request;
  const stamp = request.now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  }
  headers['host'] = url.host;
  headers['x-amz-date'] = stamp;
  if (credentials.sessionToken !== undefined && credentials.sessionToken !== '') {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }

  const names = Object.keys(headers).sort();
  const signed = names.join(';');
  const canonical = [
    request.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    ...names.map((name) => `${name}:${headers[name] ?? ''}`),
    '',
    signed,
    sha256Hex(request.body),
  ].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service),
    'aws4_request',
  );
  const signature = hmac(key, toSign).toString('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signed}, Signature=${signature}`;
  return headers;
}
