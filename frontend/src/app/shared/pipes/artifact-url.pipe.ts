import { Pipe, type PipeTransform } from '@angular/core';
import { artifactUrl } from '../../core/utils/artifact-url.util';

/** Template wrapper around `artifactUrl()` (the only place an image URL is built). */
@Pipe({ name: 'artifactUrl' })
export class ArtifactUrlPipe implements PipeTransform {
  transform(path: string | null | undefined): string | null {
    return artifactUrl(path);
  }
}
