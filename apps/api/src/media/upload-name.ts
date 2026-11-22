import { ABSOLUTE } from '@tinnox/contracts';

/**
 * Turns the client's file name into a display label: no path, no control or
 * formatting characters, bounded length. It is never used to build a path or a command.
 */
export function displayNameFromUpload(filename: unknown): string {
  if (typeof filename !== 'string') return 'upload';
  const base = filename.normalize('NFC').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- removing control characters is the purpose
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .trim();
  const clipped = Array.from(cleaned).slice(0, ABSOLUTE.maxOriginalNameLength).join('');
  return clipped === '' ? 'upload' : clipped.slice(0, ABSOLUTE.maxOriginalNameLength);
}
