import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { serverEnv } from "@/lib/server/env";
import { allowanceSentence, dailyRefreshReminder } from "@/lib/ui/dashboard-view";
import { exhaustedNotice, generationErrorMessage } from "@/lib/ui/messages";
import { createLesson } from "./actions";

const inputClass = "w-full rounded border px-3 py-2";

export default async function NewLessonPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { ctx } = await requireAccount();
  if (serverEnv().FLOW_MODE === "draft") redirect("/prepare");
  const { error } = await searchParams;
  const allowance = await webDal().history.getAllowance(ctx);
  const exhausted = allowance !== null && allowance.remaining <= 0;
  // One key per rendered form: a double click or a retried submit returns the same job.
  const key = randomUUID();

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">New lesson</h1>
      <p className="mt-2 text-sm" data-testid="allowance">
        {allowanceSentence(allowance)}
      </p>
      {dailyRefreshReminder(allowance) && (
        <p className="mt-1 text-sm text-muted-foreground" data-testid="refresh-reminder">
          {dailyRefreshReminder(allowance)}
        </p>
      )}

      {error && (
        <Notice intent="error" className="mt-4">
          {generationErrorMessage(error, allowance ? allowance.source : null)}
        </Notice>
      )}
      {exhausted && (
        <Notice intent="info" role="status" className="mt-4">
          {exhaustedNotice(allowance.source)} You can still view your history.
        </Notice>
      )}

      <form action={createLesson} className="mt-6 flex flex-col gap-4">
        <input type="hidden" name="key" value={key} />
        <label className="flex flex-col gap-1 text-sm">
          Topic
          <select name="topic" className={inputClass} defaultValue="linear_equations_one_variable">
            <option value="linear_equations_one_variable">Linear equations in one variable</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Learner level
          <input name="level" required maxLength={80} defaultValue="Grade 7-8 equivalent" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Learning objectives (one per line, up to 5)
          <textarea name="objectives" required rows={3} defaultValue="Solve equations of the form ax + b = c" className={inputClass} />
        </label>
        <div className="grid grid-cols-3 gap-4">
          <label className="flex flex-col gap-1 text-sm">
            Lesson length (minutes)
            <input name="durationMinutes" type="number" required min={15} max={180} defaultValue={60} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Difficulty
            <select name="difficulty" className={inputClass} defaultValue="mixed">
              <option value="basic">Basic</option>
              <option value="mixed">Mixed</option>
              <option value="challenge">Challenge</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Number of questions
            <input name="questionCount" type="number" required min={1} max={20} defaultValue={8} className={inputClass} />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          Extra requests (optional)
          <textarea name="notes" rows={2} maxLength={500} className={inputClass} />
          <span className="text-muted-foreground">Describe learners anonymously. Do not include names or contact details.</span>
        </label>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={exhausted}>
            Generate lesson
          </Button>
          <Link href="/lessons" className="text-sm underline">
            History
          </Link>
        </div>
      </form>
    </main>
  );
}
