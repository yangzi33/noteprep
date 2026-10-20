# Worker 主机 Runbook(staging)

> 相关:[decisions D-52..D-56](decisions.md) · [architecture §11](architecture.md) · [staging-setup §5](staging-setup.md) · [database-roles](database-roles.md) · 主机文件:[deploy/host/](../deploy/host/)
>
> **标记约定**:`[主机上验证]` = 只能在真实 Linux 主机上验证,本仓库没有任何一台主机的运行证据;在你于主机上亲自执行并记录之前,这类说明全部是 **UNVERIFIED**。本文的命令来自对 Docker/systemd 文档的阅读与仓库内的单元测试,**没有在主机上执行过**。
>
> 本文不包含任何创建付费资源的命令(购买主机、注册表、DNS 等由你决定,见 D-20)。

## 0. 范围

- 仅 **staging**。这**不是**生产就绪声明;没有任何东西在真实主机上跑过(见 §12)。
- 拓扑见 D-52:worker 容器(uid 10001、只读根、无能力)由宿主 rootful Docker 运行;LaTeX 沙箱由独立账户 `noteprep-runner` 的 **rootless** Docker 运行,socket 在 `/run/noteprep-runner/`,仅该目录以只读方式挂进 worker 容器。
- **它保护什么**:worker 被攻破 ≠ 宿主 root(只能以 runner 身份启动容器);沙箱逃逸落在无秘密的 runner 账户(rootless 守护进程下还要再跨一层用户命名空间)。
- **它不保护什么**(D-52 原文):
  1. 共享内核:内核漏洞可从沙箱或 worker 直达宿主 root(没有 gVisor)。
  2. worker 被攻破时攻击者拥有全部 worker 秘密(worker DB 角色、Storage secret key、LLM key),并能用 runner 守护进程消耗资源、篡改其他正在编译的作业产物、经 rootless 网络出站。
  3. 逃逸到 runner 的攻击者同样能篡改并发作业的 PDF(宿主只检查格式与活动内容)、占满磁盘。
  4. runner 账户没有出站防火墙。
  5. 宿主 root 可经 `docker inspect` 看到 worker 秘密(只限管理员)。

下文凡是写 `<worker_ref>`、`<latex_ref>`、`<hosttest_ref>` 的地方,取自发布工作流 `images.yml`(手动触发,仅 main)的 Step Summary,形如 `ghcr.io/<owner>/noteprep-worker@sha256:<64 位十六进制>`。只用摘要,不用标签。

## 1. 主机清单(与提供商无关)

- x86_64(镜像只构建 linux/amd64)。
- cgroup v2:

  ```sh
  stat -fc %T /sys/fs/cgroup        # 期望: cgroup2fs
  ```

- systemd 版本满足当时 Docker rootless 官方文档的要求(以 <https://docs.docker.com/engine/security/rootless/> 为准;本文不写死版本号)。
- **无入站端口**(仅 SSH 管理;worker 轮询数据库)。云防火墙默认拒绝所有入站,仅放行来自你的管理地址的 SSH。
- 自动安全更新已开启(例如 Debian/Ubuntu 的 `unattended-upgrades`);内核更新后需要重启并重跑 §10(共享内核是 D-52 的已知限制)。
- 磁盘占用告警阈值(建议 80%);时间同步(`timedatectl show -p NTPSynchronized` 为 `yes`)。租约和 webhook 容差依赖时钟。
- 主机没有云实例角色/元数据凭据,或元数据端点被封(见 §9)。

[主机上验证] 以上每一项。

## 2. 安装 Docker

按 Docker 官方文档的 apt 仓库方式安装 Engine,并额外安装 `docker-ce-rootless-extras` 与 `uidmap`(官方步骤见 <https://docs.docker.com/engine/install/>;不要用 `curl | sh` 便捷脚本)。**不要把任何人加入 `docker` 组**:

```sh
getent group docker               # 期望: 成员列表为空,形如 docker:x:999:
```

root 守护进程仍然存在(它运行 worker 容器);它的 socket(`/var/run/docker.sock`)永远不挂进任何容器。

## 3. runner 账户与 rootless 守护进程

```sh
# 以 root 执行
useradd --system --create-home --shell /usr/sbin/nologin noteprep-runner
grep noteprep-runner /etc/subuid /etc/subgid     # 若没有条目则添加,例如:
#   echo 'noteprep-runner:200000:65536' >> /etc/subuid   (subgid 同理;范围避开已有条目)
loginctl enable-linger noteprep-runner

# 仓库里的主机文件(先把仓库的 deploy/host/ 复制到主机,例如 scp;主机上不 checkout 仓库)
install -d -m 0755 -o root -g root /etc/systemd/system/user@.service.d
install -m 0644 -o root -g root user-delegate.conf /etc/systemd/system/user@.service.d/delegate.conf
install -m 0644 -o root -g root noteprep-runner.tmpfiles.conf /etc/tmpfiles.d/noteprep-runner.conf
install -d -m 0755 -o root -g root /etc/systemd/user/docker.service.d
install -m 0644 -o root -g root runner-docker.conf /etc/systemd/user/docker.service.d/noteprep.conf
systemd-tmpfiles --create /etc/tmpfiles.d/noteprep-runner.conf
systemctl daemon-reload
```

要点:

- `runner-docker.conf` **必须由 root 拥有并放在 `/etc/systemd/user/docker.service.d/`**,不能放进 runner 的家目录(否则 runner 可以改自己守护进程的参数)。
- 它对所有用户的 `docker.service` 生效;预期只有 `noteprep-runner` 运行这个单元。
- 先重启使 cgroup 委托生效:`systemctl restart user@$(id -u noteprep-runner).service`,或重启主机。

以 runner 身份安装并启用 rootless 守护进程(账户是 nologin,所以显式指定 shell):

```sh
sudo -iu noteprep-runner -s /bin/sh           # 或: machinectl shell noteprep-runner@
# 以下在 runner 的 shell 里
export XDG_RUNTIME_DIR=/run/user/$(id -u)     # 若未设置
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
```

**检查 dockerd-rootless.sh 的位置**:`runner-docker.conf` 中写的是 `/usr/bin/dockerd-rootless.sh`,以实际安装位置为准(`command -v dockerd-rootless.sh`;`rpm`/`dpkg -L docker-ce-rootless-extras` 也可),并确认它接受 `-H` 与 `--group`(`dockerd-rootless.sh --help` 会转发给 dockerd)。位置不同就改 drop-in 里的路径后 `systemctl --user daemon-reload && systemctl --user restart docker`。[主机上验证]

验证(在**宿主**上,以 root 或其他账户):

```sh
stat -c '%a %U %G' /run/noteprep-runner/docker.sock
# 期望: 660 noteprep-runner noteprep-runner
stat -c '%a %G' /run/noteprep-runner/docker.sock
# 必须输出: 660 noteprep-runner

sudo -iu noteprep-runner -s /bin/sh -c 'DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker info' | grep -E 'rootless|Cgroup Version|WARNING'
# 期望: 含 "rootless" 与 "Cgroup Version: 2";不得出现 "No memory limit support" / "No cpu cfs quota support" 之类警告
```

**socket 组不对怎么办**(UNVERIFIED):rootless 守护进程在用户命名空间里运行,`--group noteprep-runner` 可能映射成未映射的 gid,socket 的组变成 `nogroup`。此时按 `deploy/host/runner-docker.conf` 里的注释改为 `--group 0`(命名空间 root,对应宿主上 runner 自己的 gid),重新 `daemon-reload`、重启,再检查一遍 `stat -c '%a %G'`。组必须是 runner 自己的主组,**不要**换成 `docker` 组。[主机上验证]

`worker.image` 里的 `RUNNER_GID` 必须等于 runner 组的 gid:

```sh
getent group noteprep-runner | cut -d: -f3        # 把这个数字写进 /etc/noteprep/worker.image 的 RUNNER_GID
```

账户体检(都应满足,否则停下):

```sh
getent passwd noteprep-runner | cut -d: -f7       # 期望: /usr/sbin/nologin
sudo -l -U noteprep-runner                        # 期望: 输出 "User noteprep-runner is not allowed to run sudo"(没有任何条目)
id noteprep-runner                                # 期望: 组列表里没有 docker
getent group docker                               # 期望: 成员为空
# 家目录里没有任何凭据(runner 不应持有 GHCR token、.env、密钥)。
find /home/noteprep-runner -xdev \( -name config.json -o -name '.env*' -o -name '*token*' -o -name '*.pem' -o -name '*.key' \) 2>/dev/null
# 期望: 无输出。例外: 若出现 ~/.config/docker/daemon.json 等守护进程自己的配置,逐个检查内容,里面不得有 auths/凭据。
```

worker 容器的 uid 10001 **不需要**宿主账户,宿主上也不应存在可登录的 10001 用户:`getent passwd 10001` 应无输出。[主机上验证]

## 4. 秘密

```sh
install -d -m 0750 -o root -g root /etc/noteprep
# 在密码管理器里准备值;用 read -s 输入,避免进入 shell 历史
install -m 0600 -o root -g root /dev/null /etc/noteprep/worker.env
${EDITOR:-nano} /etc/noteprep/worker.env           # 内容以 deploy/host/worker.env.example 为准,只填占位符对应的真实值
install -m 0644 -o root -g root /dev/null /etc/noteprep/worker.image
${EDITOR:-nano} /etc/noteprep/worker.image         # WORKER_IMAGE=<worker_ref>  RUNNER_GID=<见 §3>
```

检查:

```sh
stat -c '%a %U %G' /etc/noteprep /etc/noteprep/worker.env
# 期望:  750 root root   和   600 root root
sudo -u noteprep-runner cat /etc/noteprep/worker.env     # 期望: Permission denied
sudo -u noteprep-runner ls /etc/noteprep                 # 期望: Permission denied
```

- `worker_login` 数据库角色按 [database-roles.md](database-roles.md) 创建;worker 只用它,不用迁移凭据。
- 轮换:密码管理器里换新值 → 改 `/etc/noteprep/worker.env` → `systemctl restart noteprep-worker` →(必要时)在提供方吊销旧值。
- **禁止**把秘密放进 runner 的家目录、镜像、命令行参数或 shell 历史。
- `LATEX_IMAGE`(在 `worker.env` 里)与 §6 的主机沙箱测试使用同一个摘要。
- 首次演练用 `LLM_PROVIDER=fake`、`LESSON_PROSE=template`(样例文件默认),不产生模型费用。

[主机上验证] 上面的 `stat` 与被拒绝的读取。

## 5. 拉取镜像(只按摘要;runner 不持有任何注册表凭据)

**root** 用只读 PAT(只给 `read:packages`)从 GHCR 拉取三个镜像,然后立即登出:

```sh
read -rs GHCR_TOKEN && echo                              # 粘贴只读 PAT,不回显
printf %s "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
unset GHCR_TOKEN
docker pull <worker_ref>
docker pull <hosttest_ref>
docker pull <latex_ref>
docker logout ghcr.io
```

核对摘要(输出必须包含与 Step Summary 相同的 `sha256:`):

```sh
docker image inspect --format '{{.RepoDigests}}' <worker_ref> <hosttest_ref> <latex_ref>
```

**LaTeX 镜像要进入 runner 的守护进程,而 runner 不能 `docker login`**(它不得持有 GHCR token)。两种做法,二选一:

- 做法 A(默认):root 拉取后经管道导入 runner 的守护进程:

  ```sh
  docker save <latex_ref> | sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker load
  sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker image inspect --format '{{.Id}}' <latex_ref>
  ```

  **UNVERIFIED**:`save`/`load` 之后,按摘要引用 `<latex_ref>` 是否仍能被 runner 的守护进程解析,取决于 Docker 的镜像存储实现(containerd 镜像存储 vs. 经典存储),本仓库没有验证。如果最后一条 `inspect` 失败(找不到 `@sha256:` 引用),**不要**改成按标签运行;改用做法 B,或把 `<latex_ref>` 的镜像 ID 与 Step Summary 对照后另行决定并记录。[主机上验证]
- 做法 B:把 LaTeX 镜像包设为公开(它不含秘密),runner 直接 `docker pull <latex_ref>`,无需任何凭据。公开与否是你的决定。

核对 runner 家目录里没有留下凭据:`find /home/noteprep-runner -name config.json`(应无输出)。

## 6. 启停、更新与回滚

首次启用(前提:§3-§5 与 §7 的主机沙箱测试全绿):

```sh
install -m 0644 -o root -g root noteprep-worker.service /etc/systemd/system/noteprep-worker.service
systemctl daemon-reload
systemctl enable --now noteprep-worker
systemctl status noteprep-worker --no-pager
```

单元的行为见 `deploy/host/noteprep-worker.service`(`--pull never`、只读根、只读挂载 runner 目录、`--log-driver none`、`--stop-timeout 180`)。**这里不复制它的参数**,以文件为准。`ExecStartPre` 会拒绝任何不是 `name@sha256:<64 位十六进制>` 的 `WORKER_IMAGE`:

```sh
# 负面检查(不会启动容器):把 WORKER_IMAGE 临时改成带标签的值,期望 systemctl start 失败且没有容器
systemctl start noteprep-worker; systemctl is-active noteprep-worker   # 期望: failed
```

更新顺序(每一步都可回头):

1. 先做数据库迁移(expand,向后兼容),见 [staging-setup §1](staging-setup.md) 第 4 点(`Database migrations` 工作流,先 status 再 deploy)。
2. `images.yml` 发布新镜像,记下新摘要。
3. root 拉取(§5),LaTeX 镜像送入 runner(§5)。**不删除旧镜像。**
4. 跑 §7 主机沙箱测试(新的 `<hosttest_ref>` 与 `<latex_ref>`)。
5. 把 `/etc/noteprep/worker.env` 的 `LATEX_IMAGE` 与 `/etc/noteprep/worker.image` 的 `WORKER_IMAGE` 改成新摘要。
6. `systemctl restart noteprep-worker`(优雅停止最多 180 s,见 §10)。
7. 追加一行到 `/etc/noteprep/releases.log`:

   ```sh
   printf '%s old_worker=%s new_worker=%s old_latex=%s new_latex=%s\n' "$(date -u +%FT%TZ)" "<旧worker摘要>" "<新worker摘要>" "<旧latex摘要>" "<新latex摘要>" >> /etc/noteprep/releases.log
   ```

回滚:把 `worker.env` 与 `worker.image` 写回 `releases.log` 上一行的旧摘要 → `systemctl restart noteprep-worker` → 确认日志出现 `worker_started`。新版本验证通过之前不删除旧镜像。迁移只做向后兼容的 expand,回滚代码不需要回滚数据库。

启动限制:300 s 内连续启动失败达到 10 次后,systemd 会拒绝再启动(`start-limit-hit`)。修好原因后先 `systemctl reset-failed noteprep-worker`,再 `systemctl start noteprep-worker`。

## 7. 主机沙箱测试(阻断上线的闸门)

用 `hosttest` 镜像在主机上以**与 worker 完全相同的身份与挂载**运行 `tests/latex`(无 env-file、无秘密;只排除需要数据库的 `pipeline.test.ts`)。`HOST_SANDBOX_STRICT=1` 要求 `LATEX_IMAGE` 是摘要,否则测试在启动时就报错:

```sh
RUNNER_GID=$(getent group noteprep-runner | cut -d: -f3)
docker run --rm --read-only --tmpfs /tmp --user 10001:10001 --group-add "$RUNNER_GID" \
  --cap-drop ALL --security-opt no-new-privileges \
  -v /run/noteprep-runner:/run/noteprep-runner \
  -e HOST_SANDBOX_STRICT=1 -e LATEX_IMAGE=<latex_ref> \
  <hosttest_ref>
# 期望: vitest 全部通过,退出码 0
```

- 此命令是 root 守护进程运行的容器,socket **目录**被挂入;**不要**挂 `/var/run/docker.sock`(仓库里 CI 为一次性 runner 这样做,生产主机永远不)。
- 反向检查:`-e LATEX_IMAGE=noteprep-latex:dev` 带 `HOST_SANDBOX_STRICT=1` 必须立即失败(`pinned by digest`)。
- **任何失败 → 阻断上线,不降级**(architecture §11.2)。不要通过放松沙箱参数、改成 root、或跳过某条测试来"修复"。
- 以 runner 身份读不到 worker 秘密(§4 已检查,此处复查):`sudo -u noteprep-runner cat /etc/noteprep/worker.env` 被拒绝。

[主机上验证] 全部(尤其是 hosttest 以 uid 10001 在真实主机上能否连上 socket;cgroup v1 主机上的行为也没有验证)。

## 8. 检查运行中的 worker

```sh
docker inspect -f '{{json .Mounts}} {{.HostConfig.NetworkMode}} {{.HostConfig.PidMode}} {{.HostConfig.Privileged}} {{.HostConfig.CapDrop}}' noteprep-worker
# 期望: Mounts 里只有 /run/noteprep-runner 一项且 "RW":false;NetworkMode=default(默认 bridge,见 §9);PidMode 为空;Privileged=false;CapDrop=[ALL]
docker exec noteprep-worker ls /var/run/docker.sock
# 期望: 失败("No such file or directory"),退出码非 0
docker exec noteprep-worker id          # 期望: uid=10001 gid=10001,附加组含 RUNNER_GID
docker inspect -f '{{.HostConfig.LogConfig.Type}} {{.HostConfig.ReadonlyRootfs}}' noteprep-worker   # 期望: none true
docker logs noteprep-worker             # 期望: 因 --log-driver none 报错,日志只在 journalctl
```

[主机上验证] 以上。

## 9. 网络暴露

worker 容器在默认 bridge 上,可以出站(它需要访问 Supabase、LLM 提供方)。要确认:

- 主机没有云实例角色,或元数据端点被封(`169.254.169.254`):

  ```sh
  docker exec noteprep-worker node -e "fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('REACHABLE',r.status)).catch(()=>console.log('blocked'))"
  # 期望: blocked(若云厂商没有元数据端点则同样 blocked)。输出 REACHABLE 时先封端点或去掉实例角色,再继续
  ```

- 主机上没有任何服务监听在 docker0 网桥地址(容器能访问它):

  ```sh
  ip -4 addr show docker0 | grep inet            # 记下网桥地址,通常 172.17.0.1
  ss -ltnp | grep -E '172\.17\.0\.1|0\.0\.0\.0|\*:'   # 期望: 除 SSH 外无监听;SSH 若监听 0.0.0.0 则确认防火墙拒绝来自 docker0 的访问
  ```

- 如实记录(不是修复项):**runner 账户没有出站防火墙**(D-52 ④);沙箱容器本身 `--network none`,但攻破 runner 守护进程的攻击者可经 rootless 网络出站。**宿主 root 可经 `docker inspect noteprep-worker` 读到 worker 秘密**(D-52 ⑤),只限管理员,管理员账户要按此保护。

[主机上验证] 以上。

## 10. 优雅停止与重启(D-55)

- `systemctl stop|restart noteprep-worker`:停止领取新作业,**让在途作业完成**;容器最多等 180 s(`--stop-timeout 180`,`TimeoutStopSec=200`)。超时后 SIGKILL,由租约过期 + sweeper 接管:作业被重新排队或按规则失败,**不重复扣额度**。
- Docker 不会因 `unhealthy` 自动重启容器;健康状态只用于告警(§11)。
- 单元 `Restart=on-failure`,`StartLimitBurst=10`/300 s;持续崩溃会被 systemd 限流,表现为 `NRestarts` 增长。

## 11. 日志与告警

`journalctl -u noteprep-worker` 是**唯一权威日志**(容器 `--log-driver none`)。日志是 JSON 行,不含课程内容。

```sh
journalctl -u noteprep-worker -o cat | jq -c 'select(.event=="worker_fatal" or .event=="loop_error" or .event=="sweep_error" or .event=="job_unsettled" or .event=="liveness_write_failed")'
journalctl -u noteprep-worker -o cat | jq -c 'select(.event=="sweep" and .drift>0)'
docker inspect -f '{{.State.Health.Status}}' noteprep-worker      # 期望 healthy;其他值 = 告警
systemctl show -p NRestarts noteprep-worker                       # 增长 = 告警
```

(日志行形如 `{"ts":...,"event":...,...}`,见 `worker/log.ts`。)

告警事件:`worker_fatal`、`loop_error`、`sweep_error`、`job_unsettled`、`liveness_write_failed`、`sweep` 中 `drift>0`。这些目前只是**可检索的日志与查询**,没有接入任何告警系统(也不在本计划内,见 §13)。

在 Supabase staging 的 SQL Editor 里运行(只读):

```sql
-- 积压:5 分钟前就该运行却仍在排队
select count(*) from generation_job where state = 'queued' and run_after < now() - interval '5 minutes';
-- 卡住:租约过期超过 2 分钟的运行中作业(sweeper 正常会接管;持续非零 = 告警)
select count(*) from generation_job where state = 'running' and lease_expires_at < now() - interval '2 minutes';
-- 近 1 小时失败率
select count(*) filter (where state = 'failed')::float
       / nullif(count(*) filter (where state in ('succeeded', 'failed')), 0)
from generation_job where finished_at > now() - interval '1 hour';
-- 近 1 天错误分布
select error_code, count(*) from generation_job where finished_at > now() - interval '1 day' group by 1;
```

(表名/列名取自 `prisma/schema.prisma` 的 `@map`。)

## 12. staging 演练清单(逐项打勾,记录日期与摘要)

演练日期:______  worker 摘要:______  latex 摘要:______  hosttest 摘要:______

- [ ] §1 主机清单全部满足(`cgroup2fs`、无入站端口、时间同步)
- [ ] §3 runner 账户体检通过;`stat -c '%a %G'` socket = `660 noteprep-runner`;`docker info` 显示 rootless、cgroup v2、无资源限制警告;rootless drop-in 由 root 拥有
- [ ] §4 `/etc/noteprep` = `750 root root`,`worker.env` = `600 root root`;runner 读不到
- [ ] §5 镜像按摘要拉取并核对;runner 家目录没有凭据;LaTeX 镜像已进入 runner 的守护进程
- [ ] 数据库迁移:`db-migrate.yml`(status → deploy),见 [staging-setup §1](staging-setup.md)
- [ ] 课程数据集:`curriculum-load.yml`(validate → load sample-1)
- [ ] §7 主机沙箱测试全绿(`HOST_SANDBOX_STRICT=1`、摘要固定的 `LATEX_IMAGE`)
- [ ] 启动 worker:`journalctl -u noteprep-worker -o cat | grep worker_started` 的行含 `"compiler":"docker"` 与 `"store":"supabase"`
- [ ] §8 对运行中的 worker 的检查全部符合预期;`docker exec noteprep-worker ls /var/run/docker.sock` 失败
- [ ] §9 元数据端点被封、docker0 上无监听
- [ ] 在你的开发机上运行冒烟(每次消耗该测试账户 1 次免费生成,额度绝不重置;账户是一次性 staging 用户):

  ```sh
  pnpm exec playwright install chromium
  SMOKE_TARGET=staging SMOKE_BASE_URL=https://noteprep.app SMOKE_EMAIL=<一次性测试用户> SMOKE_PASSWORD=<密码> pnpm smoke:staging
  ```

  期望:Notes、Worksheet、Solutions 三份均 `ok`。
- [ ] 重启演练:生成进行中 `systemctl restart noteprep-worker`;期望作业仍成功,且该账户额度只被消耗 1 次(用只读 SQL 核对用量记录,不手改数据)
- [ ] runner 守护进程重启:`sudo -iu noteprep-runner -s /bin/sh -c 'systemctl --user restart docker'` 后再跑一次冒烟(验证挂载的是目录而不是 socket 文件,worker 不必重启)
- [ ] **整机重启演练**:`reboot` 后不做任何手工操作,期望:runner 的 rootless 守护进程(linger)、`/run/noteprep-runner`(tmpfiles)与 `noteprep-worker` 单元都自动起来,`stat` 的 socket 属性不变,再跑一次冒烟成功
- [ ] 回滚演练一次(§6)

[主机上验证] 上表每一项。没有任何一项已经被执行过。

## 13. 生产前还需要(D-52 原文,不在本计划内)

- 在目标主机上评估 gVisor `runsc`(与 rootless 的兼容性未验证)或 Firecracker(D-03/D-20)。
- runner uid 的 nftables 出站拒绝。
- 镜像签名/来源证明。
- 告警系统(把 §11 的日志与查询接进去)。
- 在生产主机重跑 `test:latex`(D-44),并按 §7 在该主机上执行主机沙箱测试。
- 以及 CLAUDE.md §11 的其余上线条件(真实支付、人工数学审核、备份恢复演练、成本上限等)。

本 runbook 的全部内容都是 **UNVERIFIED**,直到有人在真实主机上逐项执行并留下记录。
