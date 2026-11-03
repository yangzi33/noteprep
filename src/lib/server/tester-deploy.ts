import { MAIL_SENDER_VAR, TESTER_DEPLOY_VAR, isPlaceholder } from "../ui/legal";
import { parseSupportEmail } from "../ui/support";

type Env = Record<string, string | undefined>;

/** What a deploy marked as a tester deploy must have set. Empty when the deploy is not marked. Pure, so next.config.ts can run it at build time. */
export function testerDeployProblems(env: Env): string[] {
  if (env[TESTER_DEPLOY_VAR] !== "1") return [];
  const problems: string[] = [];
  if (!parseSupportEmail(env.NEXT_PUBLIC_SUPPORT_EMAIL)) {
    problems.push("NEXT_PUBLIC_SUPPORT_EMAIL must be a plain contact address: the privacy notice promises access and deletion requests and needs a way to reach us");
  }
  if (isPlaceholder(env[MAIL_SENDER_VAR])) {
    problems.push(`${MAIL_SENDER_VAR} must name the party that actually sends sign-in emails (owner to confirm); it is unset or still a placeholder`);
  }
  if (!env.LLM_PROVIDER?.trim()) {
    problems.push("LLM_PROVIDER must be set explicitly here, with the same value as on the worker: the privacy notice states whether AI is on from it");
  }
  return problems;
}

export function assertTesterDeploy(env: Env): void {
  const problems = testerDeployProblems(env);
  if (problems.length > 0) throw new Error(`${TESTER_DEPLOY_VAR}=1 but the notice configuration is incomplete:\n- ${problems.join("\n- ")}`);
}
