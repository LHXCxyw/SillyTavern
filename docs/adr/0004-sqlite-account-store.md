# 0004 · 以 Node 内置 SQLite 作为账户权威存储

**状态：**提案，待用户确认。

**背景：**当前 `node-persist` `_storage` 同时承载账户、头像、邮箱验证码、卡密和 SMTP 设置。其 `values(prefix)` 会先枚举并读取解析所有 KV 文件，再筛选前缀；账户增多后，登录列表、管理员列表和启动时账户枚举会重复支付全目录读取和 JSON 解析成本。清除任务和备份任务本身另存在文件中，不属于账户 KV。管理员分页目前发生在全量读取及筛选之后。

**决定：**单实例部署中，使用 Node 内置 SQLite，将账户资料、启用/角色/活动属性和 `accountId` 作为权威状态，提供一个深模块式账户存储接口以替代核心的 `user:` 直接访问。按 SQLite 查询筛选、确定性排序和分页。`accountId` 保留实例身份语义，禁止按用户名重建数据库 ID。把账户头像从 `avatar:` base64 KV 迁到用户目录内的受控普通图片文件；新列表接口返回分页资料，新前端在授权后按需请求单张头像，并设置 private/no-store。旧 KV avatar 不包含在原用户 ZIP；文件化头像会进入后续 ZIP，作为迁移的显式导出内容变化予以公告。旧的列表接口在未指定新模式时仍返回兼容原响应，供旧调用方使用；它不是给新 UI 使用的快路径。

**迁移与回滚：**这是元数据迁移，不是用户数据搬家。维护窗口停止所有写入并取得独占迁移锁；只处理 `user:`/`avatar:` 候选 KV 和 manifest 明确列出的种子路径，不递归扫描或复制聊天、世界书、上传、备份等用户目录。由于文件名只是 SHA-256(key)，迁移器需逐个读取 `_storage` 文件 envelope/header 的 key 字段识别前缀；单个 envelope 有大小上限，每次只读取/解析一个，非目标项随即释放，不归档或导出其 value。禁止调用会全量加载所有 KV value 的 `node-persist.values()/keys()`。dry-run 检查 envelope、handle 冲突、`accountId`、头像格式和目标路径，并记录大小/hash 摘要，不保留原始敏感值。空间预检按阶段峰值估算 SQLite/journal、同卷 rename 归档、最大单头像和临时文件、种子母版、有界日志及安全余量，检查 `dataRoot` volume 实际可用字节。空间不足、记录损坏、冲突或峰值不能可靠估算时，在任何改写前非零退出，源数据不动。

通过预检后创建限额临时 DB，账户完整 JSON payload（包含未知字段、原始 TTL）导入 SQLite 并逐项校验源 hash、字段及 `accountId`。通过后将旧 `user:` 与 `avatar:` KV 文件按原文件名在同卷原子 rename 至 `_migration-legacy`；保留原始字节、不增加 data block，并使旧账户/头像 value 不再参与 `_storage` 前缀扫描。这个 cutover 阶段**不解码、不复制现有头像图像**；SQLite 账号行保留原 handle/头像迁移映射，新服务对未转换头像按原 SHA key 从归档点读 data URL。头像文件化是独立、可选的后续批次，每个文件转换前单独做容量检查；转换失败时可从归档 key 还原。新上传/改图写文件也须先做容量检查，空间不足就拒绝这次头像更新，不破坏旧值。完整账户迁移与计数、字段、实例 ID、原 KV hash 全部校验后才原子切换 storage marker；旧二进制始终停机。

后续头像批次必须 dry-run 计算所选图片的真实解码大小和日志/journal 上界。每张图片写入经 hash 校验的临时文件、原子改名后，才从 archive 移除对应 base64 key；错误时由用户文件重建 key，单张处理/回滚为幂等步骤。默认不做无界全用户头像批量解码；若剩余空间不能容纳当前图片和余量，保留 archive key、继续按需服务 legacy avatar。

头像文件化的每个 opt-in 批次都先核算总解码字节；达不到空间门槛时零修改拒绝批次。`--apply` 的首个错误即停止剩余导入，完成资源级 rollback 并返回非零；stdout/stderr 立即打印阶段、脱敏 handle/记录号、操作与错误码。stack、内部 key/path、实际/预估空间和每一步回退结果写入 0700 目录中的 0600 有界日志；日志也不包含密码、salt、密码 hash、邮件凭据或文件内容。journal/log 达到上限或自身写入失败，一样停止。journal 未解决时新旧服务都拒绝启动，必须先显式恢复和核验。

cutover 前首错停止：回滚临时 SQLite 和 sidecar；账户归档文件按原 hash rename 回 `_storage`；头像按 journal 从归档 key 或 hash 已验证的新文件恢复，再清理由本次创建且 hash 未变的图片/临时 DB。legacy key 集与 dry-run 摘要完全一致且无未决 journal 才解锁旧版。cutover 后回退走可重入导出：由 SQLite 当前账户逐条更新 legacy 归档、移除已清除账号 key、从当前头像文件重建现存 `avatar:` keys，完整校验后才 rename 回 `_storage` 并切 marker。导出出错或空间不足时 SQLite 保持唯一权威，旧版禁止启动，修复后可重试；预检计算 SQLite 与恢复后的 KV 同时存在的峰值。全过程不复制完整 70 GB 用户目录；整机灾备另存其他介质，不是本地转换回滚前提。

**影响及待决条件：**最低运行 Node 版本至少提高到 22.13（`node:sqlite` 从 22.5 引入，22.13 只移除了 `--experimental-sqlite` CLI 开关；Node 22.13 官方 API 文档的稳定性仍为 `1.1 - Active development`，Node 24 不能被写成稳定 API。参见 [Node 22.13.1 SQLite 文档](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html) 和 [Node 22.13.0 发布说明](https://nodejs.org/zh-cn/blog/release/v22.13.0)。本 ADR 选择内置 SQLite 是有意接受实验 API 的候选方案，最终确认前必须由项目维护者接受该稳定性风险，或改选成熟外部 SQLite 模块/暂缓权威存储迁移。云端多用户只支持 Node；Bun/Deno 不属于本方案承诺。部署、Docker 基镜像、CI 矩阵、安装文档和云升级冒烟须同步更新。官方 HTTP/API、普通用户目录与用户 ZIP 语义需保持；`node-persist` 的 `user:` / `avatar:` 私有键不再是第三方扩展可依赖的契约，变更须公告。初始迁移及升级/降级须有停机、快照和演练，不做跨多进程写入保证。注册、密码验证码、卡密、SMTP、清除任务与备份任务在本提案中继续使用当前独立存储和恢复机制。
