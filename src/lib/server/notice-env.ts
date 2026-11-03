// Reads the few settings the published notices are derived from (see buildDisclosure). process.env is allowed here by eslint.config.mjs.
export function noticeEnv(): Record<string, string | undefined> {
  return {
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    NOTEPREP_MAIL_SENDER: process.env.NOTEPREP_MAIL_SENDER,
  };
}
