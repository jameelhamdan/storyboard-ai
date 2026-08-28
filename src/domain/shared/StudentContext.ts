import type { Language } from './Language.js';

/** FR-14. Every field optional; the pipeline must degrade gracefully without them. */
export const STUDENT_LEVELS = ['primary', 'secondary', 'high_school', 'bachelor', 'master', 'doctorate'] as const;
export type StudentLevel = (typeof STUDENT_LEVELS)[number];

export interface StudentProfile {
  readonly name?: string;
  readonly age?: number;
  readonly language?: Language;
  readonly strengths?: readonly string[];
  readonly weaknesses?: readonly string[];
}

export class StudentContext {
  private constructor(
    public readonly level: StudentLevel | undefined,
    public readonly goal: string | undefined,
    public readonly instructions: string | undefined,
    public readonly profile: StudentProfile | undefined,
  ) {}

  public static empty(): StudentContext {
    return new StudentContext(undefined, undefined, undefined, undefined);
  }

  public static of(input: {
    level?: string;
    goal?: string;
    instructions?: string;
    profile?: StudentProfile;
  }): StudentContext {
    const level = input.level && (STUDENT_LEVELS as readonly string[]).includes(input.level)
      ? (input.level as StudentLevel)
      : undefined;
    return new StudentContext(
      level,
      input.goal?.trim() || undefined,
      input.instructions?.trim() || undefined,
      input.profile,
    );
  }

  /** True when nothing was supplied — the neutral-default path. */
  public get isEmpty(): boolean {
    return !this.level && !this.goal && !this.instructions && !this.profile;
  }

  public get weaknesses(): readonly string[] {
    return this.profile?.weaknesses ?? [];
  }
}
