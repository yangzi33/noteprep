/** Minutes a learner is assumed to need per practice question; the lesson planner (`planOutline`) budgets on the same figure. */
export const PRACTICE_MINUTES_PER_QUESTION = 5;

export interface PracticeEstimate {
  questions: number;
  /** Estimated minutes to work the questions. */
  minutes: number;
  lessonMinutes: number;
  /** Minutes beyond the lesson time; 0 when the practice fits. */
  overBy: number;
  /** True when the estimate is longer than the lesson: a warning for the tutor, never a block. */
  exceedsLesson: boolean;
}

/** The one practice-time estimate (pure; the draft preview and later slices reuse it). */
export function estimatePractice(questionCount: number, lessonMinutes: number): PracticeEstimate {
  const questions = Math.max(0, Math.trunc(questionCount));
  const minutes = questions * PRACTICE_MINUTES_PER_QUESTION;
  const overBy = Math.max(0, minutes - lessonMinutes);
  return { questions, minutes, lessonMinutes, overBy, exceedsLesson: overBy > 0 };
}
