import { environment } from '../../../environments/environment';
import { ArtifactUrlPipe } from './artifact-url.pipe';

describe('ArtifactUrlPipe', () => {
  it('delegates to artifactUrl()', () => {
    const pipe = new ArtifactUrlPipe();
    expect(pipe.transform('/artifacts/1/2/diff.png')).toBe(`${environment.artifactBaseUrl}/artifacts/1/2/diff.png`);
    expect(pipe.transform('/artifacts/../secret')).toBeNull();
    expect(pipe.transform(null)).toBeNull();
  });
});
