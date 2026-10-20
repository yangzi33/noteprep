# Worker 打包与 Linux 主机部署(staging)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 worker 打成不可变、非 root、无开发依赖的镜像,经手动工作流按摘要发布到 GHCR,并在一台 Linux 主机上以"worker 容器 + 无秘密 runner 的 rootless Docker 沙箱"方式运行 staging,配好存活信号、优雅停止、主机上的沙箱测试与端到端冒烟。

**Architecture:** worker 以加固容器运行在宿主**rootful** Docker 上(仅管理员可访问该守护进程,不挂载其 socket);每次编译的沙箱容器由专用无秘密账户 `noteprep-runner` 的 **rootless** Docker 启动,worker 只拿到 runner 守护进程的 socket 目录。worker 代码用 esbuild 打包(保留 `react-server` 条件,见 D-27),镜像只含生产依赖与 docker CLI。本计划只针对 **staging**;不声称生产就绪。

**Tech Stack:** Node 24.13.1(`.nvmrc`)、pnpm 10.33.0(`packageManager`)、esbuild 0.28.2(已作为 tsx 的依赖安装,改为显式 devDependency)、Docker Engine(rootful + rootless)、systemd、GitHub Actions + GHCR、Vitest 5、Playwright 1.64.1。

**Spec:** 无单独 spec。依据:`CLAUDE.md` §3、§8、§10、§12;`docs/architecture.md` §11、§12;`docs/staging-setup.md` §5;`docs/decisions.md` D-03、D-20、D-27、D-44、D-47、D-50;本计划由 Planner 根据上述文件和现有代码(`worker/*.ts`、`src/lib/latex/{sandbox,docker-compiler}.ts`、`docker/latex/*`、`.github/workflows/*.yml`)写成。

## Global Constraints

- 项目文档(含本计划和 runbook)用中文;代码标识符和注释用英文(CLAUDE.md §2)。
- 运行时不安装、不下载任何东西;基础镜像按摘要固定;生产 `LATEX_IMAGE` 必须是 `name@sha256:<64 hex>`(D-47)。
- 不把 `/var/run/docker.sock` 挂进任何容器,也不把任何账户加入 `docker` 组:两者都等同于宿主 root。
- 沙箱(编译容器)不继承 worker 的任何凭据;runner 账户不持有任何业务秘密(architecture §11.1)。
- 秘密只放在主机上的 `/etc/noteprep/worker.env`(root:root 0600);绝不进镜像、仓库、日志、runner 账户。
- 第三方 Actions 按 commit SHA 固定;PR 运行没有秘密;发布工作流只能手动触发且只在 `main` 上运行(CLAUDE.md §12)。
- 不创建任何付费资源,不部署生产;主机提供商与规格(D-20)由人决定。
- Git:在 `feat/worker-deploy` 上小步提交;只按明确路径 `git add`(禁止 `git add -A`),提交前看 `git status` 与 `git diff --cached`;提交信息末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 不删除、不放宽现有测试;已有测试因新规则需要补字段时,只补字段,断言不变。

## Review Focus

- rootless Docker 在缺少 cgroup 委派时会**静默丢弃** `--memory/--cpus/--pids-limit`:期望编译失败而不是不受限地运行 → Task 5 的 cgroup 测试。
- runner 的 rootless 守护进程重启后 socket 被重建:期望 worker 不需重启即可继续编译 → 挂载的是**目录**而非 socket 文件;Task 9 runbook 的演练项"重启 runner 的 docker 后再生成一次"。
- 配置错误时 worker 拒绝启动,且错误输出里**不出现**任何秘密值 → Task 4 的哨兵秘密测试。
- 运行中的作业遇到 SIGTERM:期望该作业完成或租约过期后被接管,绝不重复结算、也不再领新作业 → Task 2 的循环测试 + Task 4 的停止测试。
- 冒烟脚本被指向错误目标或把签名 URL/Cookie 写进报告 → Task 8 的目标校验单元测试 + 关闭 trace/截图/视频。

## 关键决定(实施者无需再选;记录为 D-52..D-56)

**D-52 主机拓扑(Opus 复核)。** 比较过的选项:
1. 把 `/var/run/docker.sock` 挂进 worker 容器:等同 root,**拒绝**。
2. systemd 服务 + 账户在 `docker` 组:等同 root,**拒绝**。
3. worker 与 rootless Docker 同一账户:沙箱逃逸会落在持有全部秘密的账户上(同 uid 可读 `/proc/<pid>/environ`),违背"runner 无秘密",**拒绝**。
4. **选用**:worker 容器(uid 10001,只读根,无能力)由宿主 rootful Docker 运行;沙箱由 `noteprep-runner`(nologin、无 sudo、不在 docker 组)的 rootless Docker 运行,socket 放在 `/run/noteprep-runner/`(0750,组 `noteprep-runner`),仅该目录被挂进 worker 容器并 `--group-add` 该组。worker 容器的秘密由 root 守护进程持有,runner 读不到。

**它保护什么:** worker 被攻破 ≠ 宿主 root(只能以 runner 身份启动容器);沙箱逃逸落在无秘密的 runner 账户(rootless 守护进程下还要再跨一层用户命名空间)。
**它不保护什么(必须写进 runbook):** ① 共享内核:内核漏洞可从沙箱或 worker 直达宿主 root(没有 gVisor);② worker 被攻破时攻击者拥有全部 worker 秘密(worker DB 角色、Storage secret key、LLM key),并能用 runner 守护进程消耗资源、篡改其他正在编译的作业产物、经 rootless 网络出站;③ 逃逸到 runner 的攻击者同样能篡改并发作业的 PDF(宿主只检查格式与活动内容)、占满磁盘;④ runner 账户没有出站防火墙;⑤ 宿主 root 可经 `docker inspect` 看到 worker 秘密(只限管理员)。
**生产还需要(不在本计划内):** 在目标主机上评估 gVisor `runsc`(与 rootless 的兼容性未验证)或 Firecracker(D-03/D-20);runner uid 的 nftables 出站拒绝;镜像签名/来源证明;告警系统;在生产主机重跑 `test:latex`(D-44)。

**D-53 镜像内容。** esbuild 打包 `worker/main.ts` 与 `worker/healthcheck.ts`(`packages: "external"`、`conditions: ["react-server"]`),运行时 `node --conditions=react-server`;生产依赖 `pnpm install --prod --frozen-lockfile --ignore-scripts`(Prisma 客户端已打进包,不需要 postinstall);删除 npm/corepack/yarn;`USER 10001:10001`。

**D-54 发布。** 手动工作流 `images.yml` 只用 runner 自带的 docker CLI 与 `GITHUB_TOKEN`(只在测试之后的 login/push 步骤里出现),不引入新的第三方 Action;镜像以 git SHA 打标签,输出并写入 Step Summary 的是**摘要**,主机只按摘要拉取。

**D-55 存活与停止。** worker 在每次成功的 sweep(每 `SWEEP_INTERVAL_SECONDS`,访问数据库)和每次成功的轮询后 `touch` `WORKER_LIVENESS_FILE`;`healthcheck` 检查文件新于 120 s。SIGTERM:停止领取新作业,**让在途作业完成**(现有行为,补测试);宿主停止超时 180 s,超过则 SIGKILL,由租约过期 + sweeper 接管(不扣额度)。Docker 不会因 unhealthy 自动重启:它只用于告警。

**D-56 staging 冒烟。** Playwright 走**真实登录表单**(而不是脚本里用 Supabase 密码流程伪造 `@supabase/ssr` 的 Cookie,也不调用 Server Action):这样不依赖库的内部 Cookie 格式、不需要任何 key,测的就是用户路径。每次运行消耗测试账户 1 次免费生成;账户为一次性 staging 用户,额度用完就换新用户(额度绝不重置)。

**主机上跑沙箱测试:** 不在主机上 checkout 仓库;同一 Dockerfile 的 `hosttest` 目标(含 devDeps 与 `tests/latex`)和 worker 镜像一起按摘要发布,在主机上以**与 worker 完全相同的身份与挂载**运行(无 env-file、无秘密),只排除需要数据库的 `tests/latex/pipeline.test.ts`(全链路由 CI 与冒烟覆盖)。

---

### Task 1: worker 环境规则——生产必须指向 runner 的 socket,存活文件路径(Opus 复核)

**Files:**
- Modify: `worker/env.ts`(schema 与 `superRefine`)
- Test: `tests/unit/worker-env.test.ts`

**Interfaces:**
- Produces: `WorkerConfig.WORKER_LIVENESS_FILE?: string`(绝对路径);`WorkerConfig.DOCKER_HOST?: string`;生产 + `COMPILER=docker` 时报错信息含 `DOCKER_HOST must name the sandbox runner's unix socket`。

- [ ] **Step 1: 写失败的测试**(加到 `describe("worker configuration")` 中;并给现有两个生产成功用例的输入对象加 `DOCKER_HOST: RUNNER`,断言不变)

```ts
const RUNNER = "unix:///run/noteprep-runner/docker.sock";
it("in production the compiler must talk to the runner's own socket, never the host's rootful daemon", () => {
  const digest = `registry.example.test/noteprep-latex@sha256:${"a".repeat(64)}`;
  const prod = { WORKER_DATABASE_URL: base.WORKER_DATABASE_URL, NODE_ENV: "production", COMPILER: "docker", LATEX_IMAGE: digest, OBJECT_STORE: "supabase", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "k" };
  for (const bad of [undefined, "unix:///var/run/docker.sock", "unix:///run/docker.sock", "tcp://127.0.0.1:2375"]) {
    expect(() => workerEnv({ ...prod, DOCKER_HOST: bad }), String(bad)).toThrow(/DOCKER_HOST must name the sandbox runner's unix socket/);
  }
  expect(workerEnv({ ...prod, DOCKER_HOST: RUNNER }).dockerClientEnv.DOCKER_HOST).toBe(RUNNER);
});
it("accepts only an absolute liveness file path", () => {
  expect(workerEnv({ ...base, WORKER_LIVENESS_FILE: "/run/noteprep/alive" }).WORKER_LIVENESS_FILE).toBe("/run/noteprep/alive");
  expect(() => workerEnv({ ...base, WORKER_LIVENESS_FILE: "alive" })).toThrow();
});
```

- [ ] **Step 2:** `pnpm vitest run tests/unit/worker-env.test.ts` → FAIL(规则不存在)。
- [ ] **Step 3: 实现**:在 schema 中加入

```ts
    /** The Docker client's daemon address. In production it must be the sandbox runner's rootless socket (D-52). */
    DOCKER_HOST: z.string().max(200).optional(),
    /** Touched while the worker can reach the database; read by worker/healthcheck.ts (D-55). */
    WORKER_LIVENESS_FILE: z.string().startsWith("/").max(200).optional(),
```

并在 `superRefine` 末尾加入(这是防误配的绊线,不是安全边界):

```ts
    const ROOTFUL_SOCKETS = new Set(["unix:///var/run/docker.sock", "unix:///run/docker.sock"]);
    if (env.NODE_ENV === "production" && env.COMPILER === "docker" && (!env.DOCKER_HOST?.startsWith("unix:///") || ROOTFUL_SOCKETS.has(env.DOCKER_HOST))) {
      ctx.addIssue({ code: "custom", message: "DOCKER_HOST must name the sandbox runner's unix socket in production (never the host's rootful daemon)" });
    }
```

- [ ] **Step 4:** 同一命令 → PASS;`pnpm lint && pnpm typecheck`。
- [ ] **Step 5:** 提交 `worker/env.ts tests/unit/worker-env.test.ts`,信息 `feat(worker): require the runner socket in production and accept a liveness file path`。

### Task 2: 存活信号与优雅停止

**Files:**
- Create: `worker/liveness.ts`、`worker/healthcheck.ts`
- Modify: `worker/loop.ts`(`LoopOptions`、`sweepForever`、`runWorkerLoop`)、`worker/main.ts`(传入 `onAlive`)
- Test: `tests/unit/worker-liveness.test.ts`、`tests/unit/worker-loop.test.ts`

**Interfaces:**
- Consumes: `WorkerConfig.WORKER_LIVENESS_FILE`(Task 1)。
- Produces: `createLiveness(file: string | undefined, now?: () => number, minIntervalMs?: number): () => void`;`isFresh(mtimeMs: number, nowMs: number, maxAgeMs: number): boolean`;`checkLiveness(file: string, maxAgeSeconds: number, nowMs?: number): boolean`;CLI `node dist/worker/healthcheck.mjs <file> <maxAgeSeconds>`(退出码 0 = 存活);`LoopOptions.onAlive?: () => void`;`LoopOptions.runOnce?: (deps: PipelineDeps, workerId: string) => Promise<JobOutcome | null>`(测试接缝,默认现有 `runOnce`)。

- [ ] **Step 1: 写失败的测试** `tests/unit/worker-loop.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { runWorkerLoop } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";

const empty = { requeued: 0, failed: 0, canceled: 0, drift: [] };
const deps = (sweep: () => Promise<unknown>) => ({ jobs: { sweep } }) as unknown as PipelineDeps;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("worker loop shutdown and liveness", () => {
  it("on shutdown lets the in-flight job finish and claims nothing more", async () => {
    const stop = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0, done = false;
    const loop = runWorkerLoop({ deps: deps(async () => empty), workerId: "w", pollMs: 5, sweepMs: 5, signal: stop.signal,
      runOnce: async () => { calls++; await gate; return "succeeded"; } });
    await tick(20); stop.abort(); void loop.then(() => (done = true)); await tick(50);
    expect(done).toBe(false);
    release(); await loop;
    expect(calls).toBe(1);
  });
  it("beats after a successful sweep even while polls fail, and never when both fail", async () => {
    for (const [sweepOk, expectBeats] of [[true, true], [false, false]] as const) {
      const stop = new AbortController();
      let beats = 0;
      const loop = runWorkerLoop({ deps: deps(async () => { if (!sweepOk) throw new Error("db down"); return empty; }), workerId: "w", pollMs: 5,
        sweepMs: 5, signal: stop.signal, onAlive: () => beats++, runOnce: async () => { throw new Error("db down"); } });
      await tick(40); stop.abort(); await loop;
      expect(beats > 0).toBe(expectBeats);
    }
  });
});
```

`tests/unit/worker-liveness.test.ts`:

```ts
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkLiveness, createLiveness, isFresh } from "../../worker/liveness";

describe("liveness file", () => {
  it("writes, throttles, and never throws on an unwritable path (logging once)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "noteprep-alive-"));
    const file = path.join(dir, "alive");
    try {
      let t = 1_000_000;
      const beat = createLiveness(file, () => t, 5_000);
      beat(); const first = await readFile(file, "utf8");
      t += 1_000; beat(); expect(await readFile(file, "utf8")).toBe(first); // throttled
      t += 5_000; beat(); expect(await readFile(file, "utf8")).not.toBe(first);
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const bad = createLiveness(path.join(dir, "missing", "alive"), () => (t += 10_000), 0);
      bad(); bad();
      expect(write.mock.calls.filter(([l]) => String(l).includes("liveness_write_failed"))).toHaveLength(1);
      write.mockRestore();
      expect(checkLiveness(file, 120, (await stat(file)).mtimeMs + 1_000)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("is fresh only within the age limit and not from the future; a missing file is not alive", () => {
    expect(isFresh(1_000, 120_000, 120_000)).toBe(true);
    expect(isFresh(1_000, 122_000, 120_000)).toBe(false);
    expect(isFresh(200_000, 100_000, 120_000)).toBe(false);
    expect(checkLiveness("/nonexistent/noteprep-alive", 120)).toBe(false);
  });
});
```

- [ ] **Step 2:** `pnpm vitest run tests/unit/worker-loop.test.ts tests/unit/worker-liveness.test.ts` → FAIL(模块/选项不存在)。
- [ ] **Step 3: 实现** `worker/liveness.ts`:

```ts
import { statSync, writeFileSync } from "node:fs";
import { log } from "./log";

/** A cheap callback recording "the worker just reached the database". Throttled; never throws. */
export function createLiveness(file: string | undefined, now: () => number = Date.now, minIntervalMs = 5_000): () => void {
  if (!file) return () => {};
  let last = -Infinity, warned = false;
  return () => {
    const t = now();
    if (t - last < minIntervalMs) return;
    last = t;
    try { writeFileSync(file, `${new Date(t).toISOString()}\n`, { mode: 0o600 }); warned = false; }
    catch (error) { if (!warned) log("liveness_write_failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" }); warned = true; }
  };
}
export const isFresh = (mtimeMs: number, nowMs: number, maxAgeMs: number) => nowMs - mtimeMs <= maxAgeMs && mtimeMs <= nowMs + 5_000;
export function checkLiveness(file: string, maxAgeSeconds: number, nowMs: number = Date.now()): boolean {
  try { return isFresh(statSync(file).mtimeMs, nowMs, maxAgeSeconds * 1000); } catch { return false; }
}
```

`worker/healthcheck.ts`(只读 argv,不读 env):

```ts
import { checkLiveness } from "./liveness";
// Container HEALTHCHECK: node dist/worker/healthcheck.mjs <file> <maxAgeSeconds>. Exit 0 = alive.
const [file, maxAge] = process.argv.slice(2);
const seconds = Number(maxAge);
process.exit(file && Number.isInteger(seconds) && seconds > 0 && checkLiveness(file, seconds) ? 0 : 1);
```

`worker/loop.ts`:`LoopOptions` 增加 `onAlive?` 与 `runOnce?`;`sweepForever(jobs, sweepMs, signal, onAlive)` 在 `await jobs.sweep()` 成功后调用 `onAlive?.()`;主循环 `const step = options.runOnce ?? runOnce;`,`await step(deps, workerId)` 成功返回后调用 `onAlive?.()`。在途作业仍被 `await`,abort 只阻止下一次领取(保持现有语义)。`worker/main.ts`:`runWorkerLoop({ ..., onAlive: createLiveness(config.WORKER_LIVENESS_FILE) })`。
- [ ] **Step 4:** 同一命令 → PASS;`pnpm test && pnpm lint && pnpm typecheck`。
- [ ] **Step 5:** 提交上述 6 个文件:`feat(worker): liveness file, healthcheck entry and tested graceful shutdown`。

### Task 3: worker 生产包(esbuild)

**Files:**
- Create: `scripts/build-worker.mjs`
- Modify: `package.json`(devDependency `esbuild` `0.28.2`,脚本 `worker:build`、`worker:start`)、`.gitignore`(`/dist/`)、`eslint.config.mjs`(`globalIgnores` 加 `dist/**`)

**Interfaces:**
- Produces: `dist/worker/main.mjs`、`dist/worker/healthcheck.mjs`;`pnpm worker:start` = `node --conditions=react-server --enable-source-maps dist/worker/main.mjs`。

- [ ] **Step 1:** `pnpm add -D -E esbuild@0.28.2`(与 tsx 已用的版本相同,不引入第二份);加入脚本 `"worker:build": "node scripts/build-worker.mjs"`、`"worker:start": "node --conditions=react-server --enable-source-maps dist/worker/main.mjs"`。
- [ ] **Step 2: 写构建脚本**

```js
// Bundles the worker for production (D-53). Node packages stay external (installed with --prod);
// our own code, including the generated Prisma client, is bundled. Keeps the react-server condition (D-27).
import { readFileSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: { main: "worker/main.ts", healthcheck: "worker/healthcheck.ts" },
  outdir: "dist/worker",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  conditions: ["react-server"],
  tsconfig: "tsconfig.json",
  sourcemap: true,
  logLevel: "info",
});
for (const file of ["dist/worker/main.mjs", "dist/worker/healthcheck.mjs"]) {
  if (/(from\s*|import\(\s*)["']@\//.test(readFileSync(file, "utf8"))) throw new Error(`${file}: an @/ alias was left unresolved`);
}
```

- [ ] **Step 3: 验证**:`pnpm worker:build` 成功;`pnpm db:up` 后用 `.env` 中的本地值运行 `node --env-file=.env --conditions=react-server dist/worker/main.mjs`,看到 `worker_started`,`Ctrl-C` 后看到 `worker_stopped`(若 Prisma 客户端在打包后找不到运行时文件,会在这里报错:按 Prisma 7 文档调整 external 列表,不要改为 tsx 运行)。
- [ ] **Step 4:** `pnpm lint && pnpm typecheck && pnpm test`;提交 `scripts/build-worker.mjs package.json pnpm-lock.yaml .gitignore eslint.config.mjs`:`build(worker): production bundle with esbuild`。

### Task 4: worker 镜像与镜像测试(Opus 复核)

**Files:**
- Create: `docker/worker/Dockerfile`、`.dockerignore`、`vitest.image.config.mts`、`tests/image/worker-image.test.ts`
- Modify: `package.json`(脚本 `worker:image`、`test:image`)

**Interfaces:**
- Consumes: `pnpm worker:build`(Task 3);Task 1 的生产规则;Task 2 的 healthcheck。
- Produces: 镜像目标 `runtime`;镜像约定:`USER 10001:10001`,`ENV DOCKER_HOST=unix:///run/noteprep-runner/docker.sock`,`WORKER_LIVENESS_FILE=/run/noteprep/alive`,入口 `node --conditions=react-server --enable-source-maps /app/dist/worker/main.mjs`。

- [ ] **Step 1: 查摘要(只读)**:`docker buildx imagetools inspect node:24.13.1-bookworm-slim` 取 linux/amd64 清单摘要;`docker buildx imagetools inspect docker:29.8.2-cli`(与本机 Engine 29.8.2 同版本;若该标签不存在,取官方 `docker` 仓库里 29.x 最新的 `-cli` 标签)取 linux/amd64 摘要。把两个摘要和查询日期写进 Dockerfile 注释与 D-53。
- [ ] **Step 2: `.dockerignore`(白名单,`.env` 永远进不了构建上下文)**

```
**
!package.json
!pnpm-lock.yaml
!pnpm-workspace.yaml
!.npmrc
!prisma/
!prisma7.config.ts
!tsconfig.json
!src/
!worker/
!scripts/build-worker.mjs
!tests/
!docker/latex/
!vitest.host.config.mts
src/generated/
**/.env*
```

- [ ] **Step 3: Dockerfile**(`<NODE_DIGEST>`/`<CLI_DIGEST>` 用 Step 1 查到的值替换,三个 node FROM 用同一个)

```dockerfile
# Worker image (D-53, docs/worker-host-runbook.md). Build context: repository root, platform linux/amd64.
# Contains no secrets: configuration arrives at run time from /etc/noteprep/worker.env on the host.
FROM docker:29.8.2-cli@sha256:<CLI_DIGEST> AS dockercli

FROM node:24.13.1-bookworm-slim@sha256:<NODE_DIGEST> AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

FROM base AS build
COPY prisma ./prisma
COPY prisma7.config.ts tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY worker ./worker
COPY scripts/build-worker.mjs ./scripts/build-worker.mjs
RUN pnpm worker:build

FROM base AS prod-deps
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24.13.1-bookworm-slim@sha256:<NODE_DIGEST> AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production HOME=/tmp DOCKER_CONFIG=/tmp/.docker \
    DOCKER_HOST=unix:///run/noteprep-runner/docker.sock WORKER_LIVENESS_FILE=/run/noteprep/alive
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "/app/dist/worker/healthcheck.mjs", "/run/noteprep/alive", "120"]
ENTRYPOINT ["node", "--conditions=react-server", "--enable-source-maps", "/app/dist/worker/main.mjs"]
```

脚本:`"worker:image": "docker build --platform linux/amd64 -f docker/worker/Dockerfile --target runtime -t noteprep-worker:dev ."`、`"test:image": "vitest run --config vitest.image.config.mts"`。
- [ ] **Step 4: 写测试** `vitest.image.config.mts` 复制 `vitest.latex.config.mts`,把 include 改为 `["tests/image/**/*.test.ts"]`、超时 180 s(复用 integration 的 globalSetup,它会建临时库、跑迁移、建 worker 登录用户)。`tests/image/worker-image.test.ts`:

```ts
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, describe, expect, inject, it } from "vitest";

const run = promisify(execFile);
const IMAGE = process.env.WORKER_IMAGE;
if (!IMAGE) throw new Error("set WORKER_IMAGE (build it with pnpm worker:image)"); // never skip
const PIN = `registry.example.test/noteprep-latex@sha256:${"a".repeat(64)}`;
const SENTINEL = `sentinel-${randomBytes(8).toString("hex")}`;
const started: string[] = [];
afterAll(async () => { for (const n of started) await run("docker", ["rm", "-f", n]).catch(() => {}); });

const envArgs = (vars: Record<string, string>) => Object.entries(vars).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
const prod = (db: string) => ({ NODE_ENV: "production", WORKER_DATABASE_URL: db, COMPILER: "docker", LATEX_IMAGE: PIN, OBJECT_STORE: "supabase",
  SUPABASE_URL: "https://example.invalid", SUPABASE_SECRET_KEY: SENTINEL, LLM_API_KEY: SENTINEL, POLL_INTERVAL_MS: "200", SWEEP_INTERVAL_SECONDS: "1" });
async function docker(args: string[]): Promise<{ code: number; out: string }> {
  try { const r = await run("docker", args, { timeout: 120_000 }); return { code: 0, out: r.stdout + r.stderr }; } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : -1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

describe("the worker image", () => {
  it("refuses to boot without configuration", async () => {
    const r = await docker(["run", "--rm", IMAGE]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("worker_fatal");
  });
  it("refuses an unpinned compile image or the host's rootful socket, and never prints a secret", async () => {
    const db = inject("testDb").workerUrl;
    for (const [over, message] of [[{ LATEX_IMAGE: "noteprep-latex:latest" }, "pinned by digest"], [{ DOCKER_HOST: "unix:///var/run/docker.sock" }, "DOCKER_HOST"]] as const) {
      const r = await docker(["run", "--rm", ...envArgs({ ...prod(db), ...over }), IMAGE]);
      expect(r.code).toBe(1);
      expect(r.out).toContain(message);
      expect(r.out).not.toContain(SENTINEL);
    }
  });
  it("runs as 10001 with no dev tooling, no package managers, no .env and no secrets baked in", async () => {
    const r = await docker(["run", "--rm", "--entrypoint", "sh", IMAGE, "-c",
      "id -u; test ! -e /app/.env && echo noenv; test ! -e /app/node_modules/vitest && test ! -e /app/node_modules/tsx && test ! -e /app/node_modules/prisma && echo nodev; command -v npm || command -v pnpm || echo nopm"]);
    expect(r.out.trim().split("\n")).toEqual(["10001", "noenv", "nodev", "nopm"]);
    const env = JSON.parse((await docker(["image", "inspect", "--format", "{{json .Config.Env}}", IMAGE])).out) as string[];
    expect(env.filter((e) => /KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL/.test(e.split("=")[0]!))).toEqual([]);
  });
  it("boots against a real database, turns healthy, and stops cleanly on SIGTERM", async () => {
    const name = `noteprep-worker-test-${randomBytes(4).toString("hex")}`;
    started.push(name);
    const up = await docker(["run", "-d", "--name", name, "--network", "host", "--init", "--read-only", "--tmpfs", "/tmp",
      "--tmpfs", "/run/noteprep:uid=10001,gid=10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--health-interval", "1s", "--health-retries", "1", "--health-start-period", "0s",
      ...envArgs({ ...prod(inject("testDb").workerUrl), DOCKER_HOST: "unix:///run/noteprep-runner/docker.sock" }), IMAGE]);
    expect(up.code).toBe(0);
    await expect.poll(async () => (await docker(["inspect", "-f", "{{.State.Health.Status}}", name])).out.trim(), { timeout: 60_000 }).toBe("healthy");
    expect((await docker(["stop", "--time", "30", name])).code).toBe(0);
    expect((await docker(["inspect", "-f", "{{.State.ExitCode}}", name])).out.trim()).toBe("0");
    const logs = (await docker(["logs", name])).out;
    expect(logs).toMatch(/"event":"worker_started".*"compiler":"docker-latex".*"store":"supabase"/);
    expect(logs).toContain("shutdown_requested");
    expect(logs).toContain("worker_stopped");
    expect(logs).not.toContain(SENTINEL);
  });
});
```

- [ ] **Step 5:** `pnpm worker:image && pnpm db:up && WORKER_IMAGE=noteprep-worker:dev pnpm test:image` → 全部 PASS(先在 Dockerfile 去掉 `USER` 行跑一次,确认第三个测试 FAIL,再恢复)。
- [ ] **Step 6:** `pnpm lint && pnpm typecheck`;提交 `docker/worker/Dockerfile .dockerignore vitest.image.config.mts tests/image/worker-image.test.ts package.json`:`feat(worker): non-root production image with boot, health and shutdown tests`。

### Task 5: 主机沙箱测试镜像与 cgroup 限额测试(Opus 复核)

**Files:**
- Create: `vitest.host.config.mts`
- Modify: `docker/worker/Dockerfile`(新增 `hosttest` 目标)、`tests/latex/sandbox-negative.test.ts`(新增一个用例)、`package.json`(`worker:hosttest-image`、`test:latex:host`)

**Interfaces:**
- Produces: 镜像目标 `hosttest`(入口 `vitest run --config vitest.host.config.mts`,需要 `-e LATEX_IMAGE=<digest ref>`)。

- [ ] **Step 1: 写失败的测试**(在 `describe("what code inside the sandbox cannot do")` 中;`DEFAULT_SANDBOX` 从 `@/lib/latex/sandbox` 导入)

```ts
  it("has its limits applied by the kernel, not just requested (rootless Docker without cgroup delegation drops them)", async () => {
    const p = await probe("cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max");
    expect(p.exitCode, p.stderr).toBe(0);
    const [memory, swap, pids, cpu] = p.stdout.trim().split("\n");
    expect(Number(memory)).toBe(DEFAULT_SANDBOX.memoryMb * 1024 * 1024);
    expect(swap).toBe("0");
    expect(Number(pids)).toBe(DEFAULT_SANDBOX.pidsLimit);
    expect(cpu).toBe(`${DEFAULT_SANDBOX.cpus * 100_000} 100000`);
  });
```

- [ ] **Step 2:** `pnpm latex:image && pnpm test:latex` → 新用例在本机(cgroup v2)应 PASS;临时把 `dockerRunArgs` 的 `--memory` 去掉跑一次确认 FAIL 后恢复。若本机是 cgroup v1 则会 FAIL:那正是期望(staging 主机必须 cgroup v2)。
- [ ] **Step 3: `vitest.host.config.mts`**:与 `vitest.latex.config.mts` 相同的 `resolve.alias`;**没有** globalSetup;`cacheDir: "/tmp/vitest-cache"`;`test.include: ["tests/latex/**/*.test.ts"]`、`test.exclude: ["tests/latex/pipeline.test.ts"]`、`fileParallelism: false`、两个超时 120 s;注释说明 pipeline 全链路需要数据库,由 CI 与 staging 冒烟覆盖。
- [ ] **Step 4: Dockerfile 追加**

```dockerfile
# Sandbox tests to run ON THE HOST, with the worker's exact identity and mounts but no secrets (runbook section 10).
FROM build AS hosttest
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY tests ./tests
COPY docker/latex ./docker/latex
COPY vitest.host.config.mts ./
ENV HOME=/tmp DOCKER_CONFIG=/tmp/.docker DOCKER_HOST=unix:///run/noteprep-runner/docker.sock
USER 10001:10001
ENTRYPOINT ["/app/node_modules/.bin/vitest", "run", "--config", "vitest.host.config.mts"]
```

脚本:`"worker:hosttest-image": "docker build --platform linux/amd64 -f docker/worker/Dockerfile --target hosttest -t noteprep-hosttest:dev ."`、`"test:latex:host": "vitest run --config vitest.host.config.mts"`。
- [ ] **Step 5: 本机验证**(仅本机/CI;主机上绝不这样挂 socket):`pnpm worker:hosttest-image && docker run --rm --read-only --tmpfs /tmp -e LATEX_IMAGE=noteprep-latex:dev -e DOCKER_HOST=unix:///var/run/docker.sock -v /var/run/docker.sock:/var/run/docker.sock --user 0 noteprep-hosttest:dev` → PASS。
- [ ] **Step 6:** 提交 `docker/worker/Dockerfile vitest.host.config.mts tests/latex/sandbox-negative.test.ts package.json`:`test(latex): host test image and kernel-applied cgroup limits`。

### Task 6: CI 构建检查与 GHCR 发布工作流(Opus 复核)

**Files:**
- Modify: `.github/workflows/ci.yml`(新作业 `worker-image`;`latex-sandbox` 末尾跑 hosttest 镜像)
- Create: `.github/workflows/images.yml`

**Interfaces:**
- Produces: 工作流输出 `latex_ref`、`worker_ref`、`hosttest_ref`(形如 `ghcr.io/<owner>/noteprep-worker@sha256:…`),并写入 Step Summary。

- [ ] **Step 1: ci.yml `worker-image` 作业**:services/env 与 `integration` 作业完全相同(同一 postgres 摘要、同一 `TEST_DATABASE_ADMIN_URL`),步骤为同一组按 SHA 固定的 checkout(`persist-credentials: false`)/corepack/setup-node/`pnpm install --frozen-lockfile`,再 `pnpm worker:image` 与 `WORKER_IMAGE=noteprep-worker:dev pnpm test:image`。`latex-sandbox` 末尾加 `pnpm worker:hosttest-image` 和 Task 5 Step 5 的命令(注释:一次性 CI 运行器、只跑本仓库代码,挂 socket 在这里可接受;主机上禁止)。PR 上仍没有任何秘密。
- [ ] **Step 2: images.yml**(`services.postgres`、`env.TEST_DATABASE_ADMIN_URL` 与前四个步骤逐字复制 ci.yml 的 `latex-sandbox` 作业)

```yaml
name: Publish images
# Manual only, from main. Tests run BEFORE the registry token appears; only the login step gets it (D-54).
on:
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: images
  cancel-in-progress: false
jobs:
  publish:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    timeout-minutes: 45
    permissions:
      contents: read
      packages: write
    # services: postgres + env: TEST_DATABASE_ADMIN_URL, copied from ci.yml latex-sandbox
    outputs:
      latex_ref: ${{ steps.digests.outputs.latex_ref }}
      worker_ref: ${{ steps.digests.outputs.worker_ref }}
      hosttest_ref: ${{ steps.digests.outputs.hosttest_ref }}
    steps:
      # checkout (persist-credentials: false), corepack enable, setup-node, pnpm install --frozen-lockfile: copied from ci.yml
      - name: Build and test
        run: |
          owner="${GITHUB_REPOSITORY_OWNER,,}"
          LATEX="ghcr.io/${owner}/noteprep-latex:${GITHUB_SHA}"; WORKER="ghcr.io/${owner}/noteprep-worker:${GITHUB_SHA}"; HOSTTEST="ghcr.io/${owner}/noteprep-hosttest:${GITHUB_SHA}"
          printf 'LATEX=%s\nWORKER=%s\nHOSTTEST=%s\n' "$LATEX" "$WORKER" "$HOSTTEST" >> "$GITHUB_ENV"
          labels=(--label "org.opencontainers.image.source=https://github.com/${GITHUB_REPOSITORY}" --label "org.opencontainers.image.revision=${GITHUB_SHA}")
          docker build --platform linux/amd64 "${labels[@]}" -t "$LATEX" docker/latex
          LATEX_IMAGE="$LATEX" pnpm test:latex
          docker build --platform linux/amd64 "${labels[@]}" -f docker/worker/Dockerfile --target runtime -t "$WORKER" .
          docker build --platform linux/amd64 "${labels[@]}" -f docker/worker/Dockerfile --target hosttest -t "$HOSTTEST" .
          WORKER_IMAGE="$WORKER" pnpm test:image
      - name: Log in to GHCR
        env:
          GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
      - id: digests
        name: Push and record digests
        run: |
          for n in LATEX WORKER HOSTTEST; do
            docker push "${!n}" >/dev/null
            ref="$(docker image inspect --format '{{index .RepoDigests 0}}' "${!n}")"
            echo "${n,,}_ref=${ref}" >> "$GITHUB_OUTPUT"
            echo "- ${n,,}: \`${ref}\`" >> "$GITHUB_STEP_SUMMARY"
          done
      - if: always()
        run: docker logout ghcr.io
```

- [ ] **Step 3:** 若本机有 `actionlint` 则检查两个文件;推分支后确认 `CI` 新作业通过。`images.yml` 只能在合并到 main 后由人手动运行;运行后确认 Summary 有三个 `@sha256:` 引用,且被测试的就是被推送的同一标签。
- [ ] **Step 4:** 提交 `.github/workflows/ci.yml .github/workflows/images.yml`:`ci: build and test the worker image; manual GHCR publish by digest`。

### Task 7: 主机部署文件与静态检查(Opus 复核)

**Files:**
- Create: `deploy/host/noteprep-worker.service`、`deploy/host/runner-docker.conf`、`deploy/host/user-delegate.conf`、`deploy/host/noteprep-runner.tmpfiles.conf`、`deploy/host/worker.env.example`、`deploy/host/worker.image.example`
- Test: `tests/unit/deploy-files.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const unit = readFileSync("deploy/host/noteprep-worker.service", "utf8");
const dockerfile = readFileSync("docker/worker/Dockerfile", "utf8");
// Text checks are a tripwire next to the image tests and the host run, never a substitute for them.
describe("host deployment files", () => {
  it("runs the worker hardened, from a root-only env file, with only the runner's socket directory", () => {
    for (const flag of ["--init", "--read-only", "--user 10001:10001", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 256",
      "--env-file /etc/noteprep/worker.env", "-v /run/noteprep-runner:/run/noteprep-runner", "--group-add ${RUNNER_GID}", "--stop-timeout 180", "${WORKER_IMAGE}"]) {
      expect(unit, flag).toContain(flag);
    }
    expect(unit).not.toMatch(/docker\.sock|--privileged|--network[ =]host|--pid[ =]host|-v \/:|--cap-add/);
  });
  it("the image never copies the whole context and bakes in no secret-looking variable", () => {
    expect(dockerfile).not.toMatch(/^COPY \. /m);
    expect(dockerfile).not.toMatch(/^ENV .*(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL)/m);
    expect(dockerfile).toMatch(/AS runtime[\s\S]*USER 10001:10001/);
  });
  it("example env files hold placeholders only", () => {
    const env = readFileSync("deploy/host/worker.env.example", "utf8");
    expect(env).not.toMatch(/sk-|eyJ|postgres(ql)?:\/\/[^<]*:[^<@]+@/);
  });
});
```

- [ ] **Step 2:** `pnpm vitest run tests/unit/deploy-files.test.ts` → FAIL。
- [ ] **Step 3: 文件内容**
  - `noteprep-worker.service`:`[Unit] After=docker.service network-online.target`、`Requires=docker.service`、`Wants=network-online.target`;`[Service] EnvironmentFile=/etc/noteprep/worker.image`、`ExecStartPre=-/usr/bin/docker rm -f noteprep-worker`、`ExecStart=/usr/bin/docker run --rm --name noteprep-worker --init --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --tmpfs /run/noteprep:rw,noexec,nosuid,nodev,size=1m,uid=10001,gid=10001 --user 10001:10001 --group-add ${RUNNER_GID} --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 1g --env-file /etc/noteprep/worker.env --mount type=bind,source=/run/noteprep-runner,target=/run/noteprep-runner,readonly --stop-timeout 180 --log-driver none ${WORKER_IMAGE}`(另有 `--pull never`、`--memory-swap`、`--cpus`、摘要守卫 `ExecStartPre`,以 `deploy/host/noteprep-worker.service` 为准)、`ExecStop=/usr/bin/docker stop --time 180 noteprep-worker`、`TimeoutStopSec=200`、`Restart=on-failure`、`RestartSec=10`;`[Install] WantedBy=multi-user.target`。
  - `runner-docker.conf`(装到 root 拥有的 `/etc/systemd/user/docker.service.d/noteprep.conf`):`[Service]`、`ExecStart=`、`ExecStart=/usr/bin/dockerd-rootless.sh -H unix:///run/noteprep-runner/docker.sock --group noteprep-runner`(`dockerd-rootless.sh` 路径以安装结果为准)。
  - `user-delegate.conf`(装到 `/etc/systemd/system/user@.service.d/delegate.conf`):`[Service]`、`Delegate=cpu cpuset io memory pids`(以 Docker rootless 官方文档当时的写法为准)。
  - `noteprep-runner.tmpfiles.conf`(装到 `/etc/tmpfiles.d/`):`d /run/noteprep-runner 0750 noteprep-runner noteprep-runner -`。
  - `worker.image.example`:`WORKER_IMAGE=ghcr.io/<owner>/noteprep-worker@sha256:<digest>`、`RUNNER_GID=<gid of noteprep-runner>`(非秘密,0644)。
  - `worker.env.example`:仅占位,列出 `NODE_ENV=production`、`COMPILER=docker`、`LATEX_IMAGE`、`WORKER_DATABASE_URL`、`OBJECT_STORE=supabase`、`SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`LLM_PROVIDER`/`LESSON_PROSE`(首次演练 `fake`/`template`)、LLM 四项(注释说明)、`WORKER_ID=staging-1`;顶部注释"root:root 0600,不进仓库、不进镜像、不给 runner"。
- [ ] **Step 4:** 测试 PASS;`pnpm lint`;提交 `deploy/host/* tests/unit/deploy-files.test.ts`:`feat(deploy): systemd unit and rootless runner configuration for the staging host`。

### Task 8: staging 冒烟

**Files:**
- Create: `tests/smoke/target.ts`、`tests/smoke/staging.spec.ts`、`playwright.smoke.config.ts`
- Modify: `package.json`(`"smoke:staging": "playwright test --config playwright.smoke.config.ts"`)、`eslint.config.mjs`(把 `playwright.smoke.config.ts` 加进允许读 env 的文件列表)
- Test: `tests/unit/smoke-target.test.ts`

**Interfaces:**
- Produces: `smokeTarget(env: Record<string, string | undefined>): { baseURL: string; email: string; password: string }`(不合格时抛错)。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { smokeTarget } from "../smoke/target";

const ok = { SMOKE_TARGET: "staging", SMOKE_BASE_URL: "https://noteprep.app", SMOKE_EMAIL: "smoke@example.test", SMOKE_PASSWORD: "x" };
describe("staging smoke target", () => {
  it("accepts an explicit https staging origin", () => expect(smokeTarget(ok).baseURL).toBe("https://noteprep.app"));
  it("refuses anything else", () => {
    for (const bad of [{ SMOKE_TARGET: undefined }, { SMOKE_TARGET: "production" }, { SMOKE_BASE_URL: "http://noteprep.app" },
      { SMOKE_BASE_URL: "https://x.vercel.app" }, { SMOKE_BASE_URL: "https://localhost:3000" }, { SMOKE_EMAIL: undefined }, { SMOKE_PASSWORD: "" }]) {
      expect(() => smokeTarget({ ...ok, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });
});
```

- [ ] **Step 2:** FAIL → 实现 `tests/smoke/target.ts`:

```ts
/** Where the staging smoke may run. Production is never a target; the throwaway user's credentials come from the shell. */
export function smokeTarget(env: Record<string, string | undefined>) {
  if (env.SMOKE_TARGET !== "staging") throw new Error("set SMOKE_TARGET=staging");
  const url = new URL(env.SMOKE_BASE_URL ?? "");
  if (url.protocol !== "https:" || url.hostname === "localhost" || url.hostname.endsWith(".vercel.app")) throw new Error("SMOKE_BASE_URL must be the https staging domain");
  if (!env.SMOKE_EMAIL || !env.SMOKE_PASSWORD) throw new Error("set SMOKE_EMAIL and SMOKE_PASSWORD (a throwaway staging user)");
  return { baseURL: url.origin, email: env.SMOKE_EMAIL, password: env.SMOKE_PASSWORD };
}
```

- [ ] **Step 3: 配置与用例**。`playwright.smoke.config.ts`:`testDir: "tests/smoke"`、`workers: 1`、`retries: 0`、`timeout: 300_000`、`reporter: "list"`、`use: { baseURL: smokeTarget(process.env).baseURL, trace: "off", screenshot: "off", video: "off" }`(报告里不得留下 Cookie 或签名 URL)、单个 chromium 项目;无 webServer、无 globalSetup。`tests/smoke/staging.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { smokeTarget } from "./target";

const { email, password } = smokeTarget(process.env);
const BASE = "sample-math@sample-1/level-a/course-1";
const TOPIC_URL = `/prepare?v=sample-math@sample-1&level=sample-math@sample-1/level-a&course=${BASE}&unit=${BASE}/equations&topic=${BASE}/equations/both-sides`;

test("staging: sign in, generate, preview, and every PDF downloads", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await page.goto("/lessons");
  const allowance = ((await page.getByTestId("allowance").textContent()) ?? "").trim();
  expect(Number(/^(\d+) of \d+ generations left/.exec(allowance)?.[1] ?? 0), "no free generations left: use a new throwaway staging user").toBeGreaterThan(0);
  await page.goto(TOPIC_URL);
  await page.getByRole("button", { name: "Generate lesson" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  console.log(`job ${page.url().split("/").pop()}`);
  await expect(page).toHaveURL(/\/lessons\/[0-9a-f-]{36}\?rev=[0-9a-f-]{36}$/, { timeout: 240_000 });
  const [, lessonId, revisionId] = /\/lessons\/([0-9a-f-]{36})\?rev=([0-9a-f-]{36})/.exec(page.url())!;
  console.log(`lesson ${lessonId} revision ${revisionId}`);
  await expect(page.getByTestId("document-tabs").getByRole("link")).toHaveText(["Tutor Lesson Notes", "Student Practice Worksheet", "Solutions / Answer Key"]);
  for (const doc of ["notes", "worksheet", "solutions"]) {
    const res = await page.request.get(`/lessons/${lessonId}/documents/${doc}?rev=${revisionId}&download=1`, { maxRedirects: 0 });
    expect(res.status(), `${doc}: expected a redirect to the file`).toBe(302);
    const file = await fetch(res.headers()["location"] ?? "about:blank"); // a signed URL: never print it
    expect(file.status, `${doc}: download status`).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString("latin1"), `${doc}: not a PDF`).toBe("%PDF-");
    console.log(`${doc}: ok`);
  }
});
```

- [ ] **Step 4:** `pnpm test`(含 `smoke-target`)PASS;`pnpm lint && pnpm typecheck`;确认 `pnpm test:e2e` 不会收进 `tests/smoke`(其 `testDir` 是 `tests/e2e`)。提交 `tests/smoke/* tests/unit/smoke-target.test.ts playwright.smoke.config.ts package.json eslint.config.mjs`:`test(smoke): staging end-to-end smoke through the real sign-in form`。

### Task 9: 主机 runbook 与文档(中文;安全章节 Opus 复核)

**Files:**
- Create: `docs/worker-host-runbook.md`
- Modify: `docs/decisions.md`(追加 D-52..D-56,正文取自本计划"关键决定")、`docs/staging-setup.md` §5(改为指向 runbook,保留"需要你决定 D-20")、`docs/architecture.md` §11.2(注明 staging 采用 D-52,runner 机制已定;gVisor 仍待定)、`README.md`(新增"Worker 打包与 staging 主机"一节:脚本、镜像、未验证项)、`.env.example`(注释 `WORKER_LIVENESS_FILE`、`DOCKER_HOST` 生产规则)

- [ ] **Step 1: runbook 章节(每节写可直接执行的命令,不含任何创建付费资源的命令)**
  0. 范围:仅 staging;"不保护什么"原文照抄 D-52;不是生产就绪声明。
  1. 主机清单(与提供商无关):x86_64、cgroup v2(`stat -fc %T /sys/fs/cgroup` = `cgroup2fs`)、systemd ≥ 当时 Docker rootless 文档要求、无入站端口(仅 SSH 管理)、自动安全更新、磁盘告警阈值、时间同步。
  2. 安装:按 Docker 官方 apt 仓库装 Engine 与 `docker-ce-rootless-extras`、`uidmap`;**不**把任何人加入 `docker` 组(`getent group docker` 成员为空)。
  3. 用户:`useradd --system --create-home --shell /usr/sbin/nologin noteprep-runner`;`/etc/subuid`/`/etc/subgid` 条目;`loginctl enable-linger noteprep-runner`;安装 `user-delegate.conf`、tmpfiles、`runner-docker.conf`;以 runner 身份(`sudo -iu noteprep-runner -s /bin/sh` 或 `machinectl shell noteprep-runner@`)运行 `dockerd-rootless-setuptool.sh install` 并启用用户单元;验证 `stat -c '%a %U %G' /run/noteprep-runner/docker.sock` = `660 noteprep-runner noteprep-runner`,`DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker info` 显示 `rootless`、`Cgroup Version: 2`,且无 "No memory limit / cpu cfs" 警告。worker 容器不需要宿主账户(uid 10001 不应存在于宿主或不应有登录)。
  4. 秘密:`install -d -m 0750 /etc/noteprep`;`worker.env` 用 `install -m 0600 -o root -g root` 写入;来源是密码管理器;轮换步骤(换值 → `systemctl restart`);`worker_login` 按 database-roles.md 创建;禁止把秘密放进 runner 家目录、镜像、shell 历史(`read -s`)。
  5. 拉取(按摘要):root `docker login ghcr.io`(只读 PAT,`--password-stdin`)→ `docker pull <worker_ref>` → `docker logout`;runner:同样临时登录 → `docker pull <latex_ref>` 与 `<hosttest_ref>` → logout;`docker image inspect --format '{{.RepoDigests}}'` 核对。
  6. 主机沙箱测试:`docker run --rm --read-only --tmpfs /tmp --user 10001:10001 --group-add <RUNNER_GID> --cap-drop ALL --security-opt no-new-privileges -v /run/noteprep-runner:/run/noteprep-runner -e LATEX_IMAGE=<latex_ref> <hosttest_ref>` 必须全绿;任何失败 → 阻断上线,不降级(architecture §11.2)。另做:以 runner 身份确认读不到 `/etc/noteprep/worker.env`(`sudo -u noteprep-runner cat …` 被拒)。
  7. 启停/更新/回滚:`systemctl enable --now noteprep-worker`;更新顺序 = 先迁移(expand)→ runner 拉新 LaTeX 镜像 → 改 `worker.env` 的 `LATEX_IMAGE` 与 `worker.image` 的 `WORKER_IMAGE` → `systemctl restart`(优雅停止最多 180 s);每次变更把旧/新摘要与时间追加到 `/etc/noteprep/releases.log`;回滚 = 写回上一行摘要并重启;新版本验证前不删除旧镜像。
  8. 日志与告警:`journalctl -u noteprep-worker -o cat | jq`;告警事件 `worker_fatal`、`loop_error`、`sweep_error`、`job_unsettled`、`liveness_write_failed`、`sweep` 中 `drift>0`;`docker inspect -f '{{.State.Health.Status}}' noteprep-worker` ≠ healthy;`systemctl show -p NRestarts noteprep-worker` 增长。SQL(staging SQL Editor,只读):积压 `select count(*) from generation_job where state='queued' and run_after < now() - interval '5 minutes';`;卡住 `select count(*) from generation_job where state='running' and lease_expires_at < now() - interval '2 minutes';`;失败率 `select count(*) filter (where state='failed')::float / nullif(count(*) filter (where state in ('succeeded','failed')),0) from generation_job where finished_at > now() - interval '1 hour';`;错误分布 `select error_code, count(*) from generation_job where finished_at > now() - interval '1 day' group by 1;`。
  9. 优雅停止语义(D-55):停止领取、在途作业完成;超时 SIGKILL 后由租约 + sweeper 接管,不重复扣额度。
  10. staging 演练清单(逐项打勾,并记录日期/摘要):Database migrations(status → deploy)→ Load curriculum dataset(validate → load sample-1)→ 主机沙箱测试全绿 → 启动 worker,日志出现 `worker_started` 且 `compiler":"docker-latex"`、`store":"supabase"` → 在本机 `SMOKE_TARGET=staging SMOKE_BASE_URL=https://noteprep.app SMOKE_EMAIL=… SMOKE_PASSWORD=… pnpm smoke:staging`(先 `pnpm exec playwright install chromium`)→ 三份 `ok` → 生成进行中 `systemctl restart noteprep-worker`,作业仍成功且额度只扣一次 → 以 runner 身份 `systemctl --user restart docker` 后再跑一次冒烟(验证 socket 目录挂载)→ 回滚演练一次。
  11. 生产前还需要:照抄 D-52"生产还需要"。
- [ ] **Step 2:** 更新其他文档;`pnpm lint`;提交上述文件:`docs: worker host runbook, decisions D-52..D-56, staging setup and README`。

### Task 10: 全量检查、变异检查与合并

- [ ] **Step 1:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:integration`;`pnpm latex:image && pnpm test:latex`;`pnpm worker:image && WORKER_IMAGE=noteprep-worker:dev pnpm test:image`;Task 5 Step 5。
- [ ] **Step 2: 变异检查(每项改动后对应测试必须变红,再恢复)**:去掉 Task 1 的 DOCKER_HOST 规则;`sweepForever` 不调用 `onAlive`;循环在 abort 时用 `Promise.race` 不等在途作业;Dockerfile 去掉 `USER`;`prod-deps` 去掉 `--prod`;`main.ts` 的 `worker_fatal` 改为输出整个 `source` 环境;unit 文件加 `-v /var/run/docker.sock:/var/run/docker.sock`;`dockerRunArgs` 去掉 `--pids-limit`;`smokeTarget` 去掉 `.vercel.app` 检查。把结果写进 README 新节。
- [ ] **Step 3:** 明确记录**未运行**的检查:真实主机上的 rootless/socket/cgroup 行为、GHCR 发布、staging 冒烟(这些需要人提供主机与凭据)。
- [ ] **Step 4:** 合并到 main(无冲突、合并结果上全量检查通过后),推送;若 CI 变红立即修复。

---

## 未验证的假设(实施时逐项确认,失败即停下报告)

- `dockerd-rootless.sh` 接受 `-H unix:///run/noteprep-runner/docker.sock --group noteprep-runner`,socket 权限为 0660 且组正确;worker 容器经 `--group-add` 能连接该 socket。
- 当前 systemd 的用户 slice 在 `Delegate=cpu cpuset io memory pids` 后,rootless 容器的 `cpu.max/memory.max/pids.max` 生效(Task 5 测试会给出结论)。
- esbuild 的 `packages: "external"` 不把 `@/` tsconfig 别名当作外部包(构建脚本会检查);Prisma 7 生成的客户端打包后能在运行时加载其运行时文件(镜像启动测试会给出结论)。
- `node:24.13.1-bookworm-slim` 与 `docker:29.8.2-cli` 标签存在;静态链接的 docker CLI 能在 Debian 镜像中运行。
- GHCR 拉取私有包需要 classic PAT(`read:packages`);以 GitHub 当时文档为准。
- Docker `--health-start-period 0s`、`--group-add` 数字 gid、systemd 单元中的 `${VAR}` 展开按预期工作。
