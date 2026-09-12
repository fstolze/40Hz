/**
 * Electron navigation and external-link policy.
 *
 * `shell.openExternal` runs whatever the OS has registered for a scheme, so
 * forwarding an arbitrary URL is a way to launch arbitrary handlers. These
 * assert the allowlist holds, and that the window can still reload itself.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { isSafeExternalUrl, isSameOrigin } from '../electron/url-policy.ts';

describe('external link policy', () => {
  it('allows https', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true);
  });

  it('denies plaintext http', () => {
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
  });

  it('denies schemes that would reach the local machine or another app', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vscode://file/etc/passwd',
      'smb://share/x',
      'ms-msdt:/id',
    ]) {
      expect(isSafeExternalUrl(url)).toBe(false);
    }
  });

  it('denies malformed input', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
  });
});

describe('navigation policy', () => {
  it('permits a dev-server reload', () => {
    expect(isSameOrigin('http://localhost:5273/', 'http://localhost:5273/')).toBe(true);
    expect(isSameOrigin('http://localhost:5273/?x=1', 'http://localhost:5273/')).toBe(true);
  });

  it('permits reloading the packaged file', () => {
    const url = 'file:///Applications/40Hz.app/renderer/index.html';
    expect(isSameOrigin(url, url)).toBe(true);
  });

  it('blocks another local file, which shares the opaque file origin', () => {
    expect(
      isSameOrigin('file:///etc/passwd', 'file:///Applications/40Hz.app/renderer/index.html'),
    ).toBe(false);
  });

  it('blocks a different host or port', () => {
    expect(isSameOrigin('https://evil.example', 'http://localhost:5273/')).toBe(false);
    expect(isSameOrigin('http://localhost:9999/', 'http://localhost:5273/')).toBe(false);
  });

  it('blocks malformed input', () => {
    expect(isSameOrigin('not a url', 'http://localhost:5273/')).toBe(false);
  });
});
