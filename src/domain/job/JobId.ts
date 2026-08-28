import { randomUUID } from 'node:crypto';

/**
 * UUIDv4. This matters more than it looks: GET /status has no auth, so the id is
 * the only thing standing between a caller and someone else's job. Sequential or
 * guessable ids would make the status endpoint an enumeration target.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class JobId {
  private constructor(public readonly value: string) {}

  public static generate(): JobId {
    return new JobId(randomUUID());
  }

  public static of(value: string): JobId {
    if (!UUID_V4.test(value)) throw new RangeError(`JobId must be a UUIDv4, got '${value}'.`);
    return new JobId(value.toLowerCase());
  }

  public static isValid(value: string): boolean {
    return UUID_V4.test(value);
  }

  public equals(other: JobId): boolean {
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }
}
