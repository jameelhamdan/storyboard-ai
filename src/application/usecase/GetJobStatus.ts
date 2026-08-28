import type { JobRepositoryPort } from '../port/JobRepositoryPort.js';
import { JobId } from '@domain/job/JobId.js';
import type { VideoJob } from '@domain/job/VideoJob.js';

export class GetJobStatus {
  constructor(private readonly repository: JobRepositoryPort) {}

  public async execute(rawId: string): Promise<VideoJob | undefined> {
    // An id that isn't a UUIDv4 cannot exist, so this is a 404 rather than a 400 —
    // the caller learns nothing either way, which is the point.
    if (!JobId.isValid(rawId)) return undefined;
    return this.repository.find(JobId.of(rawId));
  }
}
