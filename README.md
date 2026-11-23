# SillyTavern · 云端多用户版

本分支以 SillyTavern 为基础，主要优化自行托管的云端多用户部署：在上游多账号功能上增加卡密邀请、QQ 邮箱注册与找回、管理员邮件设置、通知后延期清除，以及可续传的用户数据备份。部署本分支请使用**本仓库的源码或基于本仓库构建的镜像**；上游镜像不包含这些改动。

[Linux 部署](#linux-部署) · [邮箱配置](#邮箱配置) · [Docker 部署](#docker-部署) · [上线验收与备份](#上线验收与备份)

## Linux 部署

推荐拓扑：**公网 → Nginx/Caddy（HTTPS）→ 同机 `127.0.0.1:8000`（SillyTavern）**。公网只开放反代所需的 Web 端口，不开放 `8000`；SSH 另按运维范围放行。如果应用在容器内，先看 [Docker 部署](#docker-部署)，不能照搬回环监听设置。

### 1. 安装并准备配置

建议使用 **Node.js 24**，这是本分支云端升级工作流验证的版本；[package.json](package.json) 声明的最低版本是 Node.js 20。以下以源码目录 `/opt/sillytavern`、运行账户及组 `sillytavern`、数据目录 `/var/lib/sillytavern` 为例。先准备专用非 root 账户，从本仓库检出源码；确保该账户可以写入运行配置、数据目录和应用所需的运行目录。

新部署可用 `sudo install -d -m 0750 -o sillytavern -g sillytavern /var/lib/sillytavern` 准备数据目录。以下命令以运行账户执行：

```bash
cd /opt/sillytavern
node --version
npm ci --omit=dev --ignore-scripts
umask 077
# 全新云端部署可直接使用模板（已启用多用户与隐匿登录、关闭自动打开浏览器）
if [ ! -f config.yaml ]; then cp default/config.cloud.yaml config.yaml; fi
```

不想改变登录页默认行为时，改用 `cp default/config.yaml config.yaml`。模板只影响首次创建，已有 `config.yaml` 不会被覆盖。

新账号默认素材会优先尝试文件级写时复制（CoW）克隆：XFS（启用 reflink）、Btrfs 等支持时节省磁盘块，不支持时自动回退普通复制并在日志中记录。可用 `df -T /var/lib/sillytavern` 查看数据卷类型。

编辑源码根目录的 `config.yaml`，不是仓库里的 [default/config.yaml](default/config.yaml)。以下是需要合并的配置项，**修改现有键，不要在文件末尾再粘贴同名区块**。已有部署请保留当前 `dataRoot`，除非已停服并迁移完整数据。

```yaml
dataRoot: /var/lib/sillytavern
listen: false
port: 8000
protocol:
  ipv4: true
  ipv6: false
browserLaunch:
  enabled: false
ssl:
  enabled: false                 # HTTPS 由同机反代终止

enableUserAccounts: true
# 只隐藏账号列表，不代替密码
enableDiscreetLogin: true
sessionTimeout: 86400            # 会话超时，单位为秒；按站点策略调整
whitelistMode: false             # 后端不对公网直连，由反代和应用账号管控入口
basicAuthMode: false
disableCsrfProtection: false
securityOverride: false
enableCorsProxy: false
requestProxy:
  enabled: false                 # 这是出站请求代理，不是 Nginx/Caddy 反代
hostWhitelist:
  enabled: true
  hosts:
    - tavern.example.com         # 只填域名，不填 https://、端口或路径
privateAddressWhitelist:
  enabled: true                  # 限制应用的私网 HTTP 请求；不是入站白名单
  allowedRanges: []              # 如需访问自建内网模型，只加必要的 IP/CIDR

forwardedHeaders:
  xRealIp: true
  xForwardedFor: false
  cfConnectingIp: false
rateLimiting:
  preferRealIpHeader: true       # 仅用于反代覆盖头部且后端不可被公网直连的场景

userLifecycle:
  publicUrl: https://tavern.example.com/  # 删除通知中的对外访问链接
```

将 `tavern.example.com` 换成自己的域名。`listen: false` 绑定回环地址，不会按 `listenAddress` 对外监听；应用自带的 Basic Auth 在此模式下不会挂载。若只允许固定来源访问，可在代理或 VPN 层限制来源。若启用应用的 `whitelistMode`，代理的连接 IP 必须在 `whitelist` 中；同时启用 `enableForwardedWhitelist` 时，应用从转发头识别出的客户端 IP 也必须在白名单中（若识别到）。因此仅放行回环地址可能导致外网用户收到 `403`。

常规启动从工作目录读取 `./config.yaml`；可用 `node server.js --configPath /绝对路径/config.yaml` 指定配置。启动时可能自动补齐缺项，修改 YAML 后需要重启应用才能生效。相对 `dataRoot` 按**启动工作目录**解析，而不是按配置文件所在目录。对同时支持三种来源的选项，优先级为**命令行参数 > `SILLYTAVERN_*` 环境变量 > YAML**，例如服务中的 `SILLYTAVERN_PORT` 会覆盖 YAML 的 `port`。SMTP 的专用覆盖规则见下文。

### 2. 先初始化管理员，再开放域名

保持公网反代关闭或仅向运维人员开放。以运行账户在源码目录执行 `NODE_ENV=production node server.js`，在服务器本机访问应用，或通过 SSH 转发本机端口到服务器的 `127.0.0.1:8000`，例如 `ssh -N -L 127.0.0.1:8000:127.0.0.1:8000 ops@your-server`，再访问 `http://127.0.0.1:8000`。空数据目录会创建无密码管理员 `default-user`，并可能自动登录；**在「用户设置 → 帐户 → 修改密码」设置强密码，退出后确认能用新密码登录，再开放公网入口**。普通账号也应设置密码。不要用 `securityOverride: true` 或关闭 CSRF 来解决启动或反代问题。

以下是 Nginx 的代理片段，放进已配置证书和 `server_name tavern.example.com` 的 HTTPS `server` 块。示例适用于 Nginx 直接接收客户端连接；如前面还有 CDN、负载均衡或其他反代，先按实际拓扑配置受信任来源的真实 IP 解析，再开启应用的 `rateLimiting.preferRealIpHeader`。

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header CF-Connecting-IP "";
    proxy_set_header Remote-User "";
    proxy_set_header X-Authentik-Username "";
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

代理保留对外域名，覆盖客户端传入的 IP 头，并清除本例不使用的 SSO 身份头。Caddy 或其他代理也应做到同样的 Host 和头部处理。等服务常驻运行，并确定下文的注册入口策略后，再执行 `sudo nginx -t` 并重载开放域名。调整应用端口时同步修改反代目标；文件上传遇到 `413` 时，检查入口的请求体大小限制（Nginx 为 `client_max_body_size`）。

### 3. 用 systemd 常驻运行

停止上一步的前台进程，再创建系统服务 `/etc/systemd/system/sillytavern.service`。`ExecStart` 中的 Node 路径按实际安装位置调整；用 `nvm` 安装时不能指望 systemd 自动加载交互式 shell 的 PATH。

```ini
[Unit]
Description=SillyTavern
After=network.target

[Service]
User=sillytavern
Group=sillytavern
WorkingDirectory=/opt/sillytavern
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/sillytavern/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sillytavern
sudo journalctl -u sillytavern -n 100 --no-pager
```

## 邮箱配置

SMTP 发信可用 QQ 邮箱、企业邮箱或其他支持认证和 TLS 的 SMTP 服务，**不要求发件人是 QQ 邮箱**。本分支的自助注册收件人则只接受数字 QQ 邮箱（形如 `123456789@qq.com`），不接受其他邮箱或 QQ 邮箱别名。

### 1. 填写连接和发件人

先在邮箱服务商的后台开启 SMTP。以 QQ 邮箱为例，在网页端设置中启用 SMTP 并生成授权码，**不要使用 QQ 登录密码**。在运行用的 `config.yaml` 中修改 `smtp` 区块，替换示例中的邮箱和授权码：

```yaml
smtp:
  host: smtp.qq.com
  port: 465
  secure: true
  user: '123456789@qq.com'        # SMTP 登录账号，按服务商要求填写
  pass: '替换为邮箱 SMTP 授权码'   # 保留引号，确保按字符串读取
  from: '123456789@qq.com'        # 填服务商许可的发件地址，通常与登录邮箱相同
  allowedEndpoints: []
  testRecipient: 'ops@example.com' # 用于管理员测试的固定收件箱，不限 QQ
```

服务商要求 **465 / 隐式 TLS** 时设 `secure: true`；要求 **587 / STARTTLS** 时通常设 `port: 587` 和 `secure: false`。这里 `false` 仍强制 STARTTLS 并验证证书，不会降级到明文。按服务商文档成对填写端口与加密方式，端口不会自动改变 `secure`。

`allowedEndpoints: []` 表示仅允许部署端配置的这一组 `host`、`port`、`secure`，**不是不限端点**。若要允许管理员切换端点，在 YAML 白名单里逐项列出允许的完整三元组。`host` 只填主机名，不加 `smtp://`；`testRecipient` 只填一个邮箱地址，不加显示名。

### 2. 保护运行配置并重启

授权码可直接填在 `smtp.pass`，**不必设置环境变量**。已有部署的非空 `SMTP_PASS` 仍优先；通用配置变量 `SILLYTAVERN_SMTP_PASS` 也能覆盖 YAML。若要切换回 YAML，移除旧的环境变量注入后重启。授权码只在服务端用于发信，管理员页面只显示是否已配置，不能查看或修改授权码。

运行配置不在应用的静态资源目录 `public/` 下，但服务器上的可见性取决于文件权限。Linux 建议让运行账户拥有配置文件并设为 `0600`，由具备运维权限的人员维护；不要把含授权码的文件提交到 Git、复制到 `public/`，或将源码目录作为反代的站点根目录。

修改 YAML 后重启应用。systemd 部署执行 `sudo systemctl restart sillytavern`；Docker 修改挂载的配置后重启服务容器，若同时移除了 Compose 的环境变量注入，则重新创建容器。

`host`、`port`、`secure`、`user`、`from` 的有效值依次取：**专用 `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_FROM` → 管理员已保存值 → 部署配置默认值**。专用环境变量存在就锁定该字段，不要设为空。若重启后后台仍显示旧值，检查有无专用环境变量；未锁定的字段可在后台同步更新。测试收件人由 `SMTP_TEST_RECIPIENT` 覆盖 `smtp.testRecipient`，不能从管理页面临时指定。

### 3. 验证投递和用户流程

管理员登录后，从 **用户设置 → 管理员面板** 打开账户控制台，在「邮件设置」里点击「发送测试邮件」。如果改了页面参数，先保存。页面显示「已配置」只代表本地参数通过检查；测试成功表示 SMTP 服务已接受邮件，**仍要到固定收件箱（含垃圾邮件夹）确认入箱**。每个进程至少间隔 60 秒才能再次测试。若按钮不可用，核对实际生效字段、`smtp.pass` 或覆盖它的环境变量，以及测试收件人；若发送失败，检查云主机出站规则、服务商 SMTP 权限、发件地址、授权码和端口/TLS 配对。不要以正式用户的清除通知代替测试邮件。

| 多用户功能 | 部署时需注意 |
| --- | --- |
| 管理员建号 | 在账户控制台创建，不需要 SMTP、卡密或验证码。给账号设置强密码。 |
| 自助注册 | 管理员在 `/cardkeys` 生成并私下分发卡密；用户在 `/register` 使用数字 QQ 邮箱、邮箱验证码和未使用的卡密注册。卡密只限制注册成功，**发验证码不需要卡密**，也不会自动发送邀请邮件。 |
| 找回密码 | 数字 QQ 邮箱账号向已绑定地址发码，真实有效期为 **5 分钟**；注册验证码则是 **10 分钟**。未绑定合规 QQ 邮箱时，找回码仅出现在服务端日志；已绑定但邮件发送失败时不会回退到日志。不要公开服务日志。 |
| 延期清除 | 管理员确认后须由 SMTP 明确接受通知，且应用记录成功，才开始 **168 小时**保留期；缺地址或投递未确认不会开始计时。`userLifecycle.paused: true` 暂停通知和物理清除，但不会延长已有期限或恢复到期账号的访问。 |

如果只允许管理员建号，且不需要邮件找回和清除通知，可以不配置 SMTP。本分支没有独立的自助注册开关；在反代或访问网关限制注册页（`/register`、`/register.html`）和接口（`/api/users/send-verification`、`/api/users/register`、`/api/cardkeys-public/verify`）。规则须覆盖大小写和尾部斜杠变体；不要只隐藏注册链接或停止发卡密。找回接口 `/api/users/recover-step1`、`/api/users/recover-step2` 是否对外开放另按站点策略决定。

若开放自助注册，建议在入口为发信接口再加总量限流。默认的 `rateLimiting.accountsVerificationMaxAttempts: 3`、`rateLimiting.accountsRegisterMaxAttempts: 5` 是每 IP + 邮箱、每 5 分钟的进程内限额，不是站点总发信配额。

## Docker 部署

使用本仓库的 [docker/docker-compose.yml](docker/docker-compose.yml)。Compose 默认的运行配置在宿主机 `docker/config/config.yaml`，数据挂载在 `docker/data/`。先创建配置目录，并在配置文件不存在时复制 [default/config.yaml](default/config.yaml)。保留 Compose 现有挂载、`build: ..` 和健康检查；**修改** `sillytavern` 服务的 `image` 和 `ports`（不要追加一个公网映射）：

```yaml
image: sillytavern-cloud:local
ports:
  - '127.0.0.1:8000:8000'
```

这段适用于反代在宿主机上、应用在容器内。反代也在 Docker 内时，初始化后可移除 `ports`，让代理通过仅可信容器加入的网络连接 `sillytavern:8000`。不要拉取上游 `latest` 来替代本分支源码构建。

沿用 Linux 示例中的账号、Host 白名单、SMTP 等设置，但容器内使用 `dataRoot: ./data`、`listen: true`、`listenAddress.ipv4: 0.0.0.0`；入口脚本已传 `--listen`。对空数据目录，若使用 `whitelistMode: false`，启动检查会拒绝无密码的初始管理员。首次启动先不开放反代，保持端口只映射到宿主机回环，临时设置 `basicAuthMode: true`、`perUserBasicAuth: false`，并自定义 `basicAuthUser.username` / `basicAuthUser.password`，不要用模板凭据。通过 SSH 转发访问，给 `default-user` 设密码后，关闭临时 Basic Auth、移除临时凭据并重启，再开放反代。

配置邮件时，在宿主机的 `docker/config/config.yaml` 填写 `smtp.pass`。建议按宿主目录的所有者设置 `PUID`、`PGID`，使应用在容器内降权运行，并确保该运行用户能读取配置。

```bash
docker compose -f docker/docker-compose.yml build sillytavern
docker compose -f docker/docker-compose.yml up -d --pull never
```

## 上线验收与备份

1. 从公网确认域名用 HTTPS 可达、`8000` 不可直连；用无痕窗口确认不会自动成为管理员。用普通账号检查其数据和管理权限与管理员账号分开。
2. 若接入 SMTP，先验证测试邮件实际入箱，再用受控账号测试注册、卡密和邮箱找回。检查反代侧的来源 IP 与限流是否按预期，而不是把所有用户都算成同一代理 IP。
3. 定期备份**完整 `dataRoot` 和有效配置**，包括隐藏或以下划线开头的内部目录；用户目录之外还保存账号、SMTP 设置和清除任务。配置备份可能包含 SMTP 授权码，须限制访问；同时保存启用的插件及第三方扩展。迁移或制作一致性备份时停止写入或使用一致性快照；不要让多个实例并发写入同一文件型数据目录。
4. 用户自助备份的 ZIP 可续传但有期限和磁盘配额，不是运维灾备。按数据盘容量检查 `backups.fullData.minFreeBytes`、`maxTotalBytes` 和 `ttlHours`，并演练在独立数据目录中恢复。

## 上游资源与许可证

[SillyTavern GitHub](https://github.com/SillyTavern/SillyTavern) · [上游文档](https://docs.sillytavern.app/) · [Discord](https://discord.gg/sillytavern) · [Reddit](https://reddit.com/r/SillyTavernAI)

AGPL-3.0
