import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";

type FormAction = (formData: FormData) => void | Promise<void>;

export function LoginForm({ signIn, signUp }: { signIn: FormAction; signUp: FormAction }) {
  return (
    <form className="mt-6 flex flex-col gap-4">
      <TextField label="Email" name="email" type="email" required autoComplete="email" />
      <TextField
        label="Password"
        name="password"
        type="password"
        required
        minLength={10}
        maxLength={72}
        autoComplete="current-password"
        hint="At least 10 characters"
      />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" formAction={signIn}>
          Sign in
        </Button>
        <Button type="submit" variant="outline" formAction={signUp}>
          Create account
        </Button>
      </div>
      <div className="flex flex-col">
        <Link href="/login/reset" className="inline-flex min-h-11 items-center text-sm font-medium text-text-accent underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          Forgot your password?
        </Link>
        <Link href="/login/resend" className="inline-flex min-h-11 items-center text-sm font-medium text-text-accent underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          Didn&apos;t get the confirmation email?
        </Link>
      </div>
    </form>
  );
}
