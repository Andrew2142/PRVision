import { environment } from '../../../environments/environment';
import { artifactUrl } from './artifact-url.util';

describe('artifactUrl', () => {
  it('prefixes environment.artifactBaseUrl', () => {
    expect(artifactUrl('/artifacts/4/12/head.png')).toBe(`${environment.artifactBaseUrl}/artifacts/4/12/head.png`);
  });

  it('rejects non-/artifacts/ paths', () => {
    expect(artifactUrl('/api/settings')).toBeNull();
    expect(artifactUrl('artifacts/4/12/head.png')).toBeNull();
    expect(artifactUrl('https://evil.example/artifacts/x.png')).toBeNull();
  });

  it('rejects .., backslash, ?, # and //', () => {
    expect(artifactUrl('/artifacts/../.env')).toBeNull();
    expect(artifactUrl('/artifacts/4/..')).toBeNull();
    expect(artifactUrl('/artifacts/4\\12/head.png')).toBeNull();
    expect(artifactUrl('/artifacts/4/12/head.png?x=1')).toBeNull();
    expect(artifactUrl('/artifacts/4/12/head.png#frag')).toBeNull();
    expect(artifactUrl('/artifacts//4/head.png')).toBeNull();
  });

  it('null → null', () => {
    expect(artifactUrl(null)).toBeNull();
    expect(artifactUrl(undefined)).toBeNull();
    expect(artifactUrl('')).toBeNull();
  });
});
