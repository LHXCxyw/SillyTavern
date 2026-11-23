# 0005 · 以低空间预检和首错停止迁移

**状态：**提案，待用户确认。

**背景：**目标服务器只有约 80 GB 磁盘，已有 70 多 GB 酒馆数据。完整 `dataRoot` 快照要求额外接近 70 GB 容量，会使原本数 MB 级账户元数据迁移无法执行或在中途耗尽磁盘。迁移可能触碰账户 KV、头像文件和少量与发行清单匹配的默认种子，不能把聊天、世界书、上传、用户备份或其他用户目录混入复制范围。

**决定：**维护窗口停机、取得 `dataRoot` 独占锁，以 read-only dry-run 盘点受影响项；由于文件名是 SHA-256(key)，通过目录项逐个打开 envelope/header 读取 key 字段识别 `user:`/`avatar:`；同一时刻只处理一个有字节上限的 envelope；解析 key 需读取该 envelope 的 JSON value，但验证码、卡密、SMTP 等其他项随即释放，不持久化或迁移其 value。禁止调用会同时读取所有 KV value 的 `node-persist.values()/keys()`。种子只按 manifest 里的已知相对路径访问。dry-run 按**逐阶段峰值**计算临时 SQLite 与 transaction journal、同卷归档的旧账户 KV、DB 与 account KV rename 归档峰值、seed master 增量、限定大小的 journal/详细日志和安全余量，再通过 dataRoot 所在 volume 的可用字节核验。账户 KV 用同卷原子 rename，不产生文件数据副本。SQLite cutover 默认不解码头像；可选头像文件化是单独任务，先测所选批次的全部解码字节，再按批次文件和最大单项临时文件做预检。cutover 后反向导出时 SQLite 与当前 legacy KV 内容同时存在，峰值必须另外估算。计算结果不足就零修改退出；不得以“先继续再观察”处理低剩余空间。

导入 SQLite 保留完整 JSON payload（含未知字段/TTL）和 source hash；dry-run 容量通过后 apply。旧 `user:`/`avatar:` KV 文件按原 SHA key 同卷 rename 归档到 `dataRoot/_migration-legacy`，不复制 payload；SQLite cutover 不解码现有头像。可选头像文件化单独按选中批次实测/预检空间后执行，不强制迁移所有头像。迁移错误先停后续项，以 SQLite source payload 和 journal 将归档 user/avatar 文件 rename 回原 `_storage` 名称；已文件化头像从 hash 验证的新文件逐项重编码恢复原 key。完整校验旧 key 集与 hash 相等，才释放锁并启动旧版。若还原失败，保持锁/journal，服务 fail-closed，等待人工修复。

操作信息立即输出到 stderr；受限详细日志位于 `dataRoot/_migration-logs` 私有目录（目录权限 0700、日志 0600、文件大小/保留数有上限，预留空间计入 dry-run）。日志应提供阶段、关联脱敏记录标识、受限日志内的源/目标路径、errno/SQLite 结果、预计/可用空间、stack 与回退结果；不得记录密码、salt、密码 hash、SMTP 秘密或头像/用户文件内容。只打印错误类别不够，必须能定位发生阶段和受影响记录。日志写入本身失败时也要向 stderr 报错并立即停止。

cutover 后的旧版回退另走离线反向导出：SQLite 当前 payload 逐条更新 `dataRoot/_migration-legacy`（含 cutover 后新增、修改和已清除账户状态）；未文件化头像沿用原归档 bytes，已文件化头像才由当前文件逐项流式编码回旧格式。核验后将归档 KV rename 回 `_storage` 并切换 marker。预检计算 SQLite 与归档总量同时存在的峰值。导出出错或空间不足时 SQLite 继续权威、旧版拒绝启动，可修复重试。此流程只触碰账户和头像 metadata，不复制 70 GB 用户目录；全盘灾备另存其他设备，不是 migration journal 回退的必要条件。

**影响：**迁移计划将携带可量化的阶段前置字节计算和不同于“全盘快照”的错误回退保证。旧 avatar base64 可在归档中按需读取，不必为了迁移账户库先占用全体解码图像空间。空间不足时账户库不迁移；不允许为完成迁移而压缩/删改用户聊天、上传或备份。迁移失败不依赖完整同卷备份：cutover 前用户目录不变，账户 KV 原文件未改写并可原子归档还原，头像通过受限 journal 按文件状态恢复；cutover 后显式由 SQLite 反向导出，失败时保持 SQLite 权威并阻止旧版启动。整机/磁盘损坏仍需异地灾备，这不是同一迁移回滚能力。遇到无法恢复的 journal，先保持服务停机和数据原样，不静默跳过记录或继续第二个账号。
