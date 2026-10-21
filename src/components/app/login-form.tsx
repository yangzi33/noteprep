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
      />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" formAction={signIn}>
          Sign in
        </Button>
        <Button type="submit" variant="outline" formAction={signUp}>
          Create account
        </Button>
      </div>
    </form>
  );
}
