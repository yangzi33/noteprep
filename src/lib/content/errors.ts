import { DomainError } from "@/lib/domain/errors";

export class PackageBuildError extends DomainError {
  constructor(message: string) {
    super("PACKAGE_BUILD_FAILED", message);
  }
}
