# Worker 主机 Runbook(staging)

> 相关:[decisions D-52..D-56](decisions.md) · [architecture §11](architecture.md) · [staging-setup §5](staging-setup.md) · [database-roles](database-roles.md) · 主机文件:[deploy/host/](../deploy/host/)
>
> **标记约定**:`[主机上验证]` = 只能在真实 Linux 主机上验证,本仓库没有任何一台主机的运行证据;在你于主机上亲自执行并记录之前,这类说明全部是 **UNVERIFIED**。本文的命令来自对 Docker/systemd 文档的阅读与仓库内的单元测试。**2026-10-20 起**,其中一部分已在一台 DigitalOcean Droplet(Ubuntu 24.04、Docker 29.9.1、4 GB / 2 vCPU)上逐项执行;已验证的项在 §12 里打了勾并标注日期,**没有标注的仍是 UNVERIFIED**。这是 staging 的一次演练记录,不是生产就绪声明。
>
> 本文不包含任何创建付费资源的命令(购买主机、注册表、DNS 等由你决定,见 D-20)。

## 0. 范围

- 仅 **staging**。这**不是**生产就绪声明;在一台真实主机上执行过的项见 §12(2026-10-20),其余仍是 UNVERIFIED。
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
- **内存至少 4 GB、2 vCPU**(实测,2026-10-20)。在 512 MB 的 Droplet 上,内核的全局 OOM 杀掉了 runner 的 `dockerd`,§7 的 41 个测试里 9 个失败(真实编译在约 90 ms 内失败、并发与"全新容器"测试超时)。原因是 hosttest 容器(1 GB 上限)、沙箱容器(1 GB 上限)与两个 Docker 守护进程同时运行。改为 4 GB / 2 vCPU(仅 CPU 与 RAM,磁盘不变)后 41 个测试全部通过。`dmesg -T | grep -c global_oom` 应为 0。磁盘:8.7 GB 的根盘在拉取 worker、hosttest(root 守护进程)与 LaTeX(runner 守护进程)三个镜像后还剩约 3.5 GB;镜像更新(§6 不删旧镜像)会占用更多,留意 §11 的磁盘告警。
- cgroup v2:

  ```sh
  stat -fc %T /sys/fs/cgroup        # 期望: cgroup2fs
  ```

- systemd 版本满足当时 Docker rootless 官方文档的要求(以 <https://docs.docker.com/engine/security/rootless/> 为准;本文不写死版本号)。
- **无入站端口**(仅 SSH 管理;worker 轮询数据库)。云防火墙默认拒绝所有入站,仅放行来自你的管理地址的 SSH。
- 自动安全更新已开启(例如 Debian/Ubuntu 的 `unattended-upgrades`);内核更新后需要重启并重跑 §7(共享内核是 D-52 的已知限制)。
- 磁盘占用告警阈值(建议 80%);时间同步(`timedatectl show -p NTPSynchronized` 为 `yes`)。租约和 webhook 容差依赖时钟。
- 主机没有云实例角色/元数据凭据,或元数据端点被封(见 §9)。

[主机上验证] 以上每一项。

## 2. 安装 Docker

按 Docker 官方文档的 apt 仓库方式安装 Engine,并额外安装 `docker-ce-rootless-extras` 与 `uidmap`(官方步骤见 <https://docs.docker.com/engine/install/>;不要用 `curl | sh` 便捷脚本)。另外建议安装 `dbus-user-session`(Docker 的 rootless 文档要求用户级 D-Bus)与 `systemd-container`(提供 §3 方式一用的 `machinectl`)。2026-10-20 的实测只确认了:这台主机上 `machinectl shell noteprep-runner@ /bin/sh` 可用;**没有**单独验证过缺少 `dbus-user-session` 时 rootless 守护进程会不会起不来,所以"必须安装"这一点仍是 UNVERIFIED。**不要把任何人加入 `docker` 组**:

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

- `runner-docker.conf` 由 root 拥有并放在 `/etc/systemd/user/docker.service.d/`,使预期的守护进程参数由 root 控制且可审查,**不要**放进 runner 的家目录。注意这**不能**阻止 runner 在 `~/.config/systemd/user` 下覆盖自己的用户级单元(用户目录优先级更高);runner 不在威胁模型里获得比它本来就有的更多权限(见 `deploy/host/runner-docker.conf` 开头注释)。
- 它对所有用户的 `docker.service` 生效;预期只有 `noteprep-runner` 运行这个单元。
- 先重启使 cgroup 委托生效:`systemctl restart user@$(id -u noteprep-runner).service`,或重启主机。[主机上验证]

以 runner 身份安装并启用 rootless 守护进程。账户是 nologin,**不要给它真实的登录 shell**;只在这条命令的持续期间用 `/bin/sh` 作为命令。`sudo -i`/`-s` 会被拒绝或进入 nologin,`systemctl --user` 在 sudo 下也没有用户总线,所以显式传 `XDG_RUNTIME_DIR`(需要 linger 已启用,`/run/user/<uid>` 才存在):

```sh
# 以 root 执行。方式一:
machinectl shell noteprep-runner@ /bin/sh
# 方式二(不经 machinectl):
sudo -u noteprep-runner env XDG_RUNTIME_DIR=/run/user/$(id -u noteprep-runner) /bin/sh
# 以下在上面打开的 /bin/sh 里,退出后不留下 shell
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
exit
```

`dockerd-rootless-setuptool.sh install` 末尾的就绪探测检查 `$XDG_RUNTIME_DIR/docker.sock`,而我们的 drop-in 把 socket 移到了 `/run/noteprep-runner`,所以它的最终检查**会**报错(2026-10-20 实测:`failed to connect to the docker API at unix:///run/user/999/docker.sock … no such file or directory`),但此时守护进程已是 `active (running)`,drop-in 已生效。这个报错无害;权威检查是下一步的 `stat` 与 `docker info`。另外 `systemctl --user enable --now docker` 要单独执行(粘贴在同一行会被当作 setuptool 的参数);执行后用 `systemctl --user -M noteprep-runner@ is-enabled docker` 确认为 `enabled`。

[主机上验证] 两种方式都只是按文档推断,哪一种在你的主机上可用要实测;`dockerd-rootless-setuptool.sh` 的路径与 `PATH` 同理。

**检查 dockerd-rootless.sh 的位置**:`runner-docker.conf` 中写的是 `/usr/bin/dockerd-rootless.sh`,以实际安装位置为准(`command -v dockerd-rootless.sh`;`rpm`/`dpkg -L docker-ce-rootless-extras` 也可),并确认它接受 `-H` 与 `--group`(`dockerd-rootless.sh --help` 会转发给 dockerd)。位置不同就改 drop-in 里的路径(root 编辑),再让 runner 的用户管理器重载并重启:`systemctl --user -M noteprep-runner@ daemon-reload && systemctl --user -M noteprep-runner@ restart docker`。[主机上验证]

验证(在**宿主**上,以 root 或其他账户):

```sh
stat -c '%a %U %G' /run/noteprep-runner/docker.sock
# 期望: 660 noteprep-runner noteprep-runner
stat -c '%a %G' /run/noteprep-runner/docker.sock
# 必须输出: 660 noteprep-runner

sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker info | grep -E 'rootless|Cgroup Version|WARNING'
# 期望: 含 "rootless" 与 "Cgroup Version: 2";不得出现 "No memory limit support" / "No cpu cfs quota support" 之类警告 [主机上验证]
```

**socket 组**(已在 DigitalOcean / Ubuntu 24.04 / Docker 29.9.1 上验证,2026-10-20):rootless 守护进程在用户命名空间里运行,`--group noteprep-runner` 在命名空间里是未映射的 gid,socket 的组显示为 `UNKNOWN`(即 `nogroup`):`660 noteprep-runner UNKNOWN`。仓库里的 `deploy/host/runner-docker.conf` 现在已经用 `--group 0`(命名空间 root,对应宿主上 runner 自己的主组 gid),实测 `stat -c '%a %U %G'` 为 `660 noteprep-runner noteprep-runner`,`stat -c '%u:%g'` 为 `999:987`,整机重启后不变。如果你的 drop-in 还是旧的 `--group noteprep-runner`,按下面改:

```sh
sed -i 's/--group noteprep-runner$/--group 0/' /etc/systemd/user/docker.service.d/noteprep.conf
systemctl --user -M noteprep-runner@ daemon-reload && systemctl --user -M noteprep-runner@ restart docker
```

然后再检查 `stat -c '%a %G'`。组必须是 runner 自己的主组,**不要**换成 `docker` 组。其他发行版/Docker 版本上的行为仍是 UNVERIFIED。

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
find /home/noteprep-runner -xdev -path /home/noteprep-runner/.local/share/docker -prune -o \( -name config.json -o -name '.env*' -o -name '*token*' -o -name '*.pem' -o -name '*.key' \) -print 2>/dev/null
# 期望: 无输出(已排除 rootless 数据目录 ~/.local/share/docker,其内容是镜像层而非凭据)。例外: 若出现 ~/.config/docker/daemon.json 等守护进程自己的配置,逐个检查内容,里面不得有 auths/凭据。
```

worker 容器的 uid 10001 **不需要**宿主账户,宿主上也不应存在可登录的 10001 用户:`getent passwd 10001` 应无输出。[主机上验证]

## 4. 秘密

```sh
install -d -m 0750 -o root -g root /etc/noteprep
# 在密码管理器里准备值,在编辑器里粘贴(不要把值写在命令行上,避免进入 shell 历史)
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
- **改完 `worker.env` 必须重启单元才生效**:`docker run --env-file` 只在容器启动时读取文件。2026-10-20 实测:改了文件没有重启,worker 一直用旧的 `SUPABASE_SECRET_KEY`,每次生成都以 `storage_failed` 失败;重启后第一次生成成功。核对运行中的容器拿到的是哪把密钥,用**指纹**而不是打印值(哈希前 12 位不可逆推出密钥):

  ```sh
  docker exec noteprep-worker node -e "console.log(require('crypto').createHash('sha256').update(process.env.SUPABASE_SECRET_KEY||'').digest('hex').slice(0,12))"
  # 在你的开发机上对你手里的新密钥做同样的哈希(read -rs 输入,不回显),两个 12 位值应一致
  ```

- **`storage_failed` 排错**(2026-10-20):worker 原来只记录 `job_failed code=storage_failed` 与 `attempt_cleanup_failed code=StorageError`,**不记录** HTTP 状态与消息,所以上传、读回校验和清理的失败在日志里长得一样。现在 `job_failed`、`job_requeued` 与 `attempt_cleanup_failed` 还带 `storageOp`(`put`/`stat`/`list`/`remove`/`verify`/`path`)、`storageStatus`(HTTP 状态)与 `storageMessage`(清洗过的短消息,单行、至多 200 字符,不含类似密钥或 JWT 的文本,也不含对象路径)。**这些字段只在发布并部署包含 `fix/storage-error-detail` 的新 worker 镜像(§6)之后才会出现**;之前运行的镜像仍是旧行为。如果连 `attempt_cleanup_failed` 也出现,说明列目录/删除也失败,多半是密钥、`SUPABASE_URL` 或网络;没有它时才轮到路径、大小或桶设置。区分密钥问题与桶问题,在开发机上用**同一个** supabase-js(版本见 `package.json`)直接测,而不是手写 curl:新式 `sb_secret_…` 密钥不是 JWT,裸 curl 要么缺 `Authorization`(`headers must have required property 'authorization'`),要么把它当 JWT 解析(`Invalid Compact JWS`),这两种 400/403 都**不**能说明密钥好坏:

  ```sh
  read -rs SB_KEY; export SB_KEY
  node -e "const {createClient}=require('@supabase/supabase-js');createClient('https://<project-ref>.supabase.co',process.env.SB_KEY,{auth:{persistSession:false}}).storage.from('lesson-artifacts').list('',{limit:1}).then(r=>console.log(r.error?{status:r.error.status??r.error.statusCode,message:r.error.message}:'ok, '+r.data.length+' items'))"
  unset SB_KEY
  ```
- **禁止**把秘密放进 runner 的家目录、镜像、命令行参数或 shell 历史。
- `LATEX_IMAGE`(在 `worker.env` 里)与 §7 的主机沙箱测试使用同一个摘要。
- 首次演练用 `LLM_PROVIDER=fake`、`LESSON_PROSE=template`(样例文件默认),不产生模型费用。

[主机上验证] 上面的 `stat` 与被拒绝的读取。

## 5. 拉取镜像(只按摘要;runner 不持有任何注册表凭据)

[主机上验证] 本节与 §2、§6、§10、§11 的所有主机命令都未在真实主机上执行过。

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

核对摘要(输出必须包含与 Step Summary 里相同的清单摘要 `sha256:`;Step Summary 给的是**清单摘要**,不是镜像 ID):

```sh
docker image inspect --format '{{.RepoDigests}}' <worker_ref> <hosttest_ref> <latex_ref>
```

**LaTeX 镜像要进入 runner 的守护进程,而 runner 不能 `docker login`**(它不得持有 GHCR token)。两种做法,二选一:

- 做法 A(默认):root 拉取后经管道导入 runner 的守护进程:

  ```sh
  docker save <latex_ref> | sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker load
  sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker image inspect --format '{{.Id}}' <latex_ref>
  ```

  **UNVERIFIED**:`save`/`load` 之后,按摘要引用 `<latex_ref>` 是否仍能被 runner 的守护进程解析,取决于 Docker 的镜像存储实现(containerd 镜像存储 vs. 经典存储),本仓库没有验证。因为沙箱以 `--pull never` 运行,如果 `save|load` 没有保留摘要引用,编译会直接失败(找不到镜像)。此时**不要**改成按标签运行,也不要拿镜像 ID 去对 Step Summary(两者不是同一个值);改用做法 B(公开镜像,由 runner 的守护进程直接按摘要拉取)。这一点保持 UNVERIFIED。[主机上验证]
- 做法 B:把 LaTeX 镜像包设为公开(它不含秘密),runner 直接 `docker pull <latex_ref>`,无需任何凭据。公开与否是你的决定。

核对 runner 家目录里没有留下凭据:`find /home/noteprep-runner -path /home/noteprep-runner/.local/share/docker -prune -o -name config.json -print`(应无输出)。

## 6. 启停、更新与回滚

首次启用(前提:§3-§5 与 §7 的主机沙箱测试全绿):

```sh
install -m 0644 -o root -g root noteprep-worker.service /etc/systemd/system/noteprep-worker.service
systemctl daemon-reload
systemctl enable --now noteprep-worker
systemctl status noteprep-worker --no-pager
```

单元的行为见 `deploy/host/noteprep-worker.service`(`--pull never`、只读根、只读挂载 runner 目录、`--log-driver none`、`--stop-timeout 180`)。**这里不复制它的参数**,以文件为准。`ExecStartPre` 守卫会拒绝不是 `name@sha256:<64 位十六进制>` 的 `WORKER_IMAGE`,以及不是正整数的 `RUNNER_GID`。负面检查(顺序重要:对已运行的单元 `start` 什么都不会做):

```sh
systemctl stop noteprep-worker
cp /etc/noteprep/worker.image /root/worker.image.bak          # 先备份
# 把 /etc/noteprep/worker.image 里的 WORKER_IMAGE 改成带标签的值(例如 ...:latest),然后:
systemctl start noteprep-worker; echo "exit=$?"                # 期望: 非零退出
journalctl -u noteprep-worker -n 20 --no-pager                 # 期望: 看到 ExecStartPre 失败
docker ps -a --filter name=noteprep-worker                     # 期望: 无容器
# 恢复摘要值(RUNNER_GID 的负面检查同理,改成空值或 0 再恢复):
install -m 0644 -o root -g root /root/worker.image.bak /etc/noteprep/worker.image
systemctl reset-failed noteprep-worker
systemctl start noteprep-worker
```

因为 `Restart=on-failure`,失败后单元状态可能显示 `failed`,也可能是 `activating (auto-restart)`(正在 `RestartSec=10` 的等待里,每次都会再次被守卫拒绝);两者都算通过。检查完务必恢复并确认 `worker_started`。[主机上验证]

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

用 `hosttest` 镜像在主机上运行 `tests/latex`(无 env-file、无秘密;只排除需要数据库的 `pipeline.test.ts`)。它与 worker 使用**同一个 uid/gid、同一个附加组、只读根、丢弃全部能力、no-new-privileges 和同一个 socket 目录挂载**,并镜像单元里的 `--init`/`--pids-limit`/`--memory`/`--cpus` 与 `/run/noteprep` tmpfs;但它**不是**逐位相同的运行环境(例如没有 env-file、入口不同),所以通过只说明沙箱在这些条件下可用。具体数值以 `deploy/host/noteprep-worker.service` 为准,如有变动同步改这里。`HOST_SANDBOX_STRICT=1` 要求 `LATEX_IMAGE` 是摘要,否则测试在启动时就报错:

```sh
RUNNER_GID=$(getent group noteprep-runner | cut -d: -f3)
docker run --rm --init --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --tmpfs /run/noteprep:rw,noexec,nosuid,nodev,size=1m,uid=10001,gid=10001 \
  --user 10001:10001 --group-add "$RUNNER_GID" \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 256 --memory 1g --memory-swap 1g --cpus 1 --pull never \
  --mount type=bind,source=/run/noteprep-runner,target=/run/noteprep-runner,readonly \
  -e HOST_SANDBOX_STRICT=1 -e LATEX_IMAGE=<latex_ref> \
  <hosttest_ref>
# 期望: vitest 全部通过,退出码 0
```

Task 5/5b 在本机 Docker 上用 `--read-only --tmpfs /tmp`(Docker 默认的 tmpfs 选项含 `noexec`)跑过 hosttest 镜像(41 个测试通过);GitHub Actions 上的 `ci.yml` hosttest 步骤已在 PR #10 的 `LaTeX sandbox` 作业里通过(2026-10-20);真实主机上的行为仍是 UNVERIFIED。所以 `/tmp` 的 `noexec` 不是可能的失败原因。在真实主机上**真正没测过**的是:`/tmp` 的 64m 容量上限、`--memory 1g`、`--pids-limit 256`、`--cap-drop ALL`、uid 10001,以及真实的 runner socket 目录挂载。若在这些限制下出现磁盘空间不足或内存不足,这是一个**需要记录的结果**(开 issue 或写入 decisions 并按证据调整配置),**不是**放松隔离参数的理由。[主机上验证]

- 此命令是 root 守护进程运行的容器,socket **目录**被挂入;**不要**挂 `/var/run/docker.sock`(仓库里 CI 为一次性 runner 这样做,生产主机永远不)。
- 反向检查:`-e LATEX_IMAGE=noteprep-latex:dev` 带 `HOST_SANDBOX_STRICT=1` 必须立即失败(`pinned by digest`)。
- **任何失败 → 阻断上线,不降级**(architecture §11.2)。不要通过放松沙箱参数、改成 root、或跳过某条测试来"修复"。
- 以 runner 身份读不到 worker 秘密(§4 已检查,此处复查):`sudo -u noteprep-runner cat /etc/noteprep/worker.env` 被拒绝。

**实测记录(2026-10-20,DigitalOcean、Ubuntu 24.04、Docker 29.9.1、4 GB / 2 vCPU)**:41 个测试全部通过(约 10 分钟,退出码 0);hosttest 以 uid 10001 + 附加组 987 能连上 runner 的 socket 目录。反向检查(`LATEX_IMAGE=noteprep-latex:dev`)立即失败,退出码 1,信息含 `requires LATEX_IMAGE pinned by digest`。注意:

- `RUNNER_GID` 是 shell 变量;在新会话(例如重启后)里它是空的,`--group-add ""` 会报 `unable to find group : no matching entries in group file`。每次先 `RUNNER_GID=$(getent group noteprep-runner | cut -d: -f3)`。
- 在 512 MB 主机上这一步会失败(见 §1 的内存要求),不要把那种失败当成沙箱参数的问题。
- 运行期间 `dmesg` 里可能出现一条 `CONSTRAINT_MEMCG` 的 `perl` 被杀(容器自己的内存上限生效);它与"cannot use more memory than its limit"测试的时间相符,但我们没有逐条对应过。区别于全局 OOM:`dmesg -T | grep -c global_oom` 应为 0。

仍未验证:cgroup v1 主机。

## 8. 检查运行中的 worker

```sh
docker inspect -f '{{json .Mounts}} {{.HostConfig.NetworkMode}} {{.HostConfig.PidMode}} {{.HostConfig.Privileged}} {{.HostConfig.CapDrop}}' noteprep-worker
# 期望: Mounts 里只有 /run/noteprep-runner 一项且 "RW":false;NetworkMode 为 `default` 或 `bridge`(即默认 bridge,见 §9);PidMode 为空;Privileged=false;CapDrop=[ALL]
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

  **DigitalOcean 实测(2026-10-20)**:默认**可达**(`REACHABLE 404`),宿主 sshd 也能经桥地址 `172.17.0.1:22` 从容器连上(`SSH REACHABLE`,sshd 监听 `0.0.0.0:22` 与 `[::]:22`)。修复是 `deploy/host/noteprep-block-metadata.service`:元数据端点的流量是转发流量,所以放在 `DOCKER-USER` 链;容器到宿主自身的 sshd 走 `INPUT` 链,只限 `-i docker0` 与端口 22(没有整体封 docker0,因为容器 DNS 等是否受影响没有测过)。它在 Docker 启动后、worker 启动前重新套用(iptables 规则重启即丢)。安装:

  ```sh
  install -m 0644 -o root -g root noteprep-block-metadata.service /etc/systemd/system/noteprep-block-metadata.service
  systemctl daemon-reload && systemctl enable --now noteprep-block-metadata
  iptables -L DOCKER-USER -v -n --line-numbers      # 期望: 一行 DROP 到 169.254.169.254
  iptables -L INPUT -v -n --line-numbers            # 期望: in 列为 docker0 的 tcp dpt:22 DROP(不能是 *,否则会把你自己的 SSH 也封掉)
  ```

  验证:元数据检查输出 `blocked`;SSH 检查因为是 DROP 而不是 REJECT,表现为**连接超时**而不是 `closed`,两者都算通过,只有 `SSH REACHABLE` 是失败(用带 3 秒超时的版本:`const s=require('net').connect({port:22,host:'172.17.0.1'});s.setTimeout(3000);…`)。整机重启后两条规则都自动回来了(见 §12)。这只保护 worker 容器,不保护 runner 的 rootless 网络(下面第三条仍是未检查)。

- 主机上没有任何服务监听在 docker0 网桥地址(容器能访问它),包括 IPv6 通配监听:

  ```sh
  ip -4 addr show docker0 | grep inet            # 记下网桥地址,通常 172.17.0.1
  ss -ltnp | grep -E '172\.17\.0\.1|0\.0\.0\.0:|\*:|\[::\]:'   # 期望: 除 SSH 外无监听
  # SSH 若监听通配地址(0.0.0.0 / [::]),手动确认主机防火墙拒绝 docker0 → 22(例如 nft list ruleset 里有对应规则),并从容器内确认:
  docker exec noteprep-worker node -e "require('net').connect(22,'172.17.0.1').on('connect',()=>{console.log('SSH REACHABLE');process.exit()}).on('error',()=>console.log('closed'))"   # 期望: closed
  ```

- 同样的元数据端点检查要从 runner 的 rootless 网络做一遍(用一个一次性容器经 runner 的 socket 启动,命令里的镜像用 §5 已送入的 LaTeX 镜像不合适,因为它没有 node/curl;用你已在 runner 守护进程里有的任何最小镜像,或手动确认主机防火墙对 runner uid 的出站规则;没有这类镜像时就记录为"未检查")。[主机上验证]
- 如实记录(不是修复项):**runner 账户没有出站防火墙**(D-52 ④);沙箱容器本身 `--network none`,但攻破 runner 守护进程的攻击者可经 rootless 网络出站。**宿主 root 可经 `docker inspect noteprep-worker` 读到 worker 秘密**(D-52 ⑤),只限管理员,管理员账户要按此保护。

[主机上验证] 以上。

## 10. 优雅停止与重启(D-55)

[主机上验证] 本节描述的行为来自单元文件与代码,没有在主机上演练过(演练见 §12)。

- `systemctl stop|restart noteprep-worker`:停止领取新作业,**让在途作业完成**;容器最多等 180 s(`--stop-timeout 180`,`TimeoutStopSec=200`)。超时后 SIGKILL,由租约过期 + sweeper 接管:作业被重新排队或按规则失败,**不重复扣额度**。
- Docker 不会因 `unhealthy` 自动重启容器;健康状态只用于告警(§11)。
- 单元 `Restart=on-failure`,`StartLimitBurst=10`/300 s;持续崩溃会被 systemd 限流,表现为 `NRestarts` 增长。

## 11. 日志与告警

**健康检查的局限(D-55)**:容器 `HEALTHCHECK` 只证明 worker 能访问数据库(存活文件在成功的 sweep/轮询后更新)。如果 runner 的 socket 或组映射坏了,worker 仍然显示 `healthy`,而每次编译都会以 `sandbox_unavailable` 失败。所以告警**必须同时**监控失败作业数(见下面的 SQL)。另外 Dockerfile 的 `HEALTHCHECK` 写死了 `/run/noteprep/alive`,因此 **不要** 在 `worker.env` 里覆盖 `WORKER_LIVENESS_FILE`。

[主机上验证] 下面的 `jq` 过滤与 `docker inspect` 输出格式需要在真实日志上确认。

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
-- 沙箱不可用(socket/组映射/runner 守护进程坏了;持续非零 = 告警,即使容器是 healthy)
select count(*) from generation_job where state = 'failed' and error_code = 'sandbox_unavailable' and finished_at > now() - interval '15 minutes';
-- 近 1 天错误分布
select error_code, count(*) from generation_job where finished_at > now() - interval '1 day' group by 1;
```

(表名/列名取自 `prisma/schema.prisma` 的 `@map`。)

## 12. staging 演练清单(逐项打勾,记录日期与摘要)

演练日期:2026-10-20(第一次,部分完成;DigitalOcean、Ubuntu 24.04、4 GB / 2 vCPU)  
worker 摘要:`ghcr.io/yangzi33/noteprep-worker@sha256:18662c994ebcc05c2404a71f8092fd4168e471b64b39b3005c2b2b7015454840`  
latex 摘要:`ghcr.io/yangzi33/noteprep-latex@sha256:6a0aa483856e90be750e9c76919699e76050fc513e26793b6b220c69548dff20`  
hosttest 摘要:`ghcr.io/yangzi33/noteprep-hosttest@sha256:6414bdc1b00c50ec7c7f9ef3990ff09748ba691da45742d0db8c1efa47b7d677`  
(摘要由 GitHub API 读取,commit `7c207fa`;Step Summary 未逐项核对。)

- [x] §1 主机清单全部满足(`cgroup2fs`、x86_64、systemd 255、时间同步、`unattended-upgrades` 已装)(2026-10-20)。"云防火墙只放行你的 IP 的 SSH"由你在控制台确认,这里没有看到规则内容;`ss -ltn` 只看到 sshd 与回环上的 DNS 桩。**内存要求见 §1:512 MB 不够。**
- [x] §3 runner 账户体检通过(2026-10-20):`stat` socket = `660 noteprep-runner noteprep-runner`(需要 `--group 0`,见 §3);`docker info` 显示 rootless、cgroup v2、无警告;nologin、无 sudo、不在 docker 组(`docker` 组成员为空)、`getent passwd 10001` 无输出、家目录里没有凭据。rootless drop-in 由 root 拥有。
- [ ] §4 `/etc/noteprep` = `750 root root`,`worker.env` = `600 root root`;runner 读不到。**这几条 `stat` 与 `Permission denied` 检查的输出没有被记录**,所以不打勾。已验证的只有:`worker.env` 的变量名齐全(曾因 `COMPLIER` 拼写错误使 worker 拒绝启动,见 D-57)、以 `worker_login` 身份用其连接串能连库(`current_user` = `worker_login`;第一次用错了 `postgres` 所有者连接串,已改)。
- [x] §5 镜像按摘要拉取并核对(`docker image inspect` 的 RepoDigests 与上面一致);worker 与 hosttest 由 root 用只读 PAT 拉取后已 `docker logout`;runner 家目录没有 `config.json`;LaTeX 镜像按**做法 B**(包设为公开)由 runner 的守护进程直接按摘要拉取,没有走 `save | load`,所以做法 A 的摘要保留问题**仍是 UNVERIFIED**(2026-10-20)
- [ ] 数据库迁移:`Database migrations` 工作流(status → deploy),见 [staging-setup §1](staging-setup.md)
- [ ] 课程数据集:`Load curriculum dataset` 工作流(validate → load sample-1)
- [x] §7 主机沙箱测试全绿(`HOST_SANDBOX_STRICT=1`、摘要固定的 `LATEX_IMAGE`):41/41,退出码 0,反向检查失败如预期(2026-10-20;第一次在 512 MB 主机上 9 个失败,原因是内存不足,见 §1)
- [x] 启动 worker:`worker_started` 行含 `"compiler":"docker-latex"` 与 `"store":"supabase"`(`llm: fake`、`prose: template`)(2026-10-20)。§6 的两个负面检查也做了:带标签的 `WORKER_IMAGE` 与 `RUNNER_GID=0` 都被 `ExecStartPre` 拒绝(`exit=1`,无容器),恢复后正常启动
- [x] §8 对运行中的 worker 的检查全部符合预期(2026-10-20):只有 `/run/noteprep-runner` 一个只读挂载、bridge、`Privileged=false`、`CapDrop=[ALL]`;`/var/run/docker.sock` 不存在;`uid=10001 gid=10001 groups=10001,987`;日志驱动 `none`、根文件系统只读;`docker logs` 报错
- [x] §9 元数据端点被封、docker0 上无监听(2026-10-20,**需要** `noteprep-block-metadata.service`,见 §9:修复前两者都可达)。runner 的 rootless 网络出站**未检查**
- [ ] 在你的开发机上运行冒烟(每次消耗该测试账户 1 次免费生成,额度绝不重置;账户是一次性 staging 用户):

  ```sh
  pnpm exec playwright install chromium
  read -rs SMOKE_PASSWORD; export SMOKE_PASSWORD        # 输入不回显,不进 shell 历史
  SMOKE_TARGET=staging SMOKE_BASE_URL=https://noteprep.app SMOKE_EMAIL=<一次性测试用户> pnpm smoke:staging
  unset SMOKE_PASSWORD
  ```

  期望:Notes、Worksheet、Solutions 三份均 `ok`。
- [ ] 重启演练:生成进行中 `systemctl restart noteprep-worker`;期望作业仍成功,且该账户额度只被消耗 1 次(用只读 SQL 核对用量记录,不手改数据)
- [ ] runner 守护进程重启:`systemctl --user -M noteprep-runner@ restart docker`(以 root 执行)后再跑一次冒烟(验证挂载的是目录而不是 socket 文件,worker 不必重启)
- [ ] **整机重启演练**:`reboot` 后不做任何手工操作,期望:runner 的 rootless 守护进程(linger)、`/run/noteprep-runner`(tmpfiles)与 `noteprep-worker` 单元都自动起来,`stat` 的 socket 属性不变,再跑一次冒烟成功。**2026-10-20 已验证"自动起来"部分**:重启后 socket 为 `660 noteprep-runner noteprep-runner`、rootless + cgroup v2 无警告、`docker`/`noteprep-block-metadata`/`noteprep-worker` 都是 `active`、两条 iptables 规则都在、一个 `worker_started`、容器 `healthy`。**"再跑一次冒烟成功"仍未做**,所以整项不打勾
- [ ] 回滚演练一次(§6)

**2026-10-20 的状态**:上表里打勾的是在那台主机上亲眼看到输出的;没打勾的(§4 的权限检查输出、数据库迁移与课程数据集工作流、冒烟、生成进行中的重启、runner 守护进程重启后的冒烟、回滚演练,以及整机重启后的冒烟)**仍是 UNVERIFIED**。另外 §6 的"更新顺序"、§10 的在途作业优雅停止、§11 的日志与告警、`images.yml` 的 Step Summary 核对,都没有演练过。另外:2026-10-20 在 `https://noteprep.app` 上**手动**生成成功了一次(`fake` LLM、`template` 文稿,生成者查看了结果,有小的排版优化项留到后面);这**不是**脚本化的 `pnpm smoke:staging`,所以冒烟那一项仍不打勾。**不要因为这张表的进度就认为 staging 可用于真实用户。**

## 13. 生产前还需要(D-52 原文,不在本计划内)

- 在目标主机上评估 gVisor `runsc`(与 rootless 的兼容性未验证)或 Firecracker(D-03/D-20)。
- runner uid 的 nftables 出站拒绝。
- 镜像签名/来源证明。
- 告警系统(把 §11 的日志与查询接进去)。
- 在生产主机重跑 `test:latex`(D-44),并按 §7 在该主机上执行主机沙箱测试。
- 以及 CLAUDE.md §11 的其余上线条件(真实支付、人工数学审核、备份恢复演练、成本上限等)。

本 runbook 的全部内容都是 **UNVERIFIED**,直到有人在真实主机上逐项执行并留下记录。

## 14. S4b export (English)

Exports (`kind = 'export'` jobs) are handled by the same worker unit and the same compiler. Nothing in this runbook changes, and `worker.env` gains no required variable. Before enabling `EXPORT_ENABLED` anywhere, update this host to the S4b image and keep web and worker on the same commit. See the "S4b export worker" note in [fresh-droplet-setup.md](fresh-droplet-setup.md) (section K) for the rollout order, the failure modes of an old worker, and the zero-pending-exports rollback check.
