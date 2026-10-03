/** Validate, do not repair aliases: manifests must be safe on Windows and POSIX. */
export function validateRelativePath(path: string): string {
  // With /u, valid surrogate pairs are single code points outside this lone-surrogate range.
  if (typeof path !== 'string' || !path || /[\ud800-\udfff]/u.test(path) || path !== path.normalize('NFC')) {
    throw new Error('Unsafe relative path: empty, malformed, or non-canonical Unicode');
  }
  const normalized = path.replaceAll('\\', '/');
  for (const component of normalized.split('/')) {
    if (!component || component === '.' || component === '..' ||
        /[<>:"|?*\u0000-\u001f\u007f]/u.test(component) || /[. ]$/u.test(component)) {
      throw new Error(`Unsafe relative path: ${JSON.stringify(path)}`);
    }
    const stem = component.split('.')[0]!.trimEnd();
    if (/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(stem)) {
      throw new Error(`Reserved Windows device path: ${JSON.stringify(path)}`);
    }
  }
  return normalized;
}
