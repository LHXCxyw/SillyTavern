import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getAvailableBytes } from './seed-storage.js';

/**
 * 账户迁移只读盘点。
 * 逐文件解析 node-persist 存储，不调用会全量加载 value 的 values()/keys()，
 * 不修改任何文件；仅输出可用于停服迁移前评审的报告。
 */

/** 单个 KV 文件允许的最大字节数，超过则记录为阻断错误。 */
export const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
/** 导出的 SQLite 文件名。 */
export const EXPORT_DB_NAME = '_migration-accounts.sqlite';
/** 迁移日志目录名。 */
export const MIGRATION_LOG_DIR = '_migration-logs';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** 允许的账号头像 data URL 前缀。 */
const AVATAR_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;

/**
 * 计算 node-persist 对键的存储文件名。
 * @param {string} key 完整键，例如 user:alice
 * @returns {string} SHA-256 十六进制文件名
 */
export function storageFileName(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * 判断字符串是否为 data URL 形式图片。
 * @param {string} value 待检查值
 * @returns {boolean} 是否图片 data URL
 */
export function isImageDataUrl(value) {
    return typeof value === 'string' && AVATAR_DATA_URL.test(value);
}

/**
 * 读取并校验单个存储文件。
 * @param {string} storageDir 存储目录
 * @param {string} fileName 文件名
 * @returns {{entry?: object, error?: object}} 解析结果
 */
function readEntry(storageDir, fileName) {
    const fullPath = path.join(storageDir, fileName);
    let stat;
    try {
        stat = fs.lstatSync(fullPath);
    } catch (error) {
        return { error: { file: fileName, code: 'STAT_FAILED', message: String(error?.message ?? error) } };
    }
    if (!stat.isFile()) {
        return { error: { file: fileName, code: 'NOT_A_FILE', message: '存储目录中存在非普通文件，需人工检查。' } };
    }
    if (stat.size > MAX_ENTRY_BYTES) {
        return { error: { file: fileName, code: 'ENTRY_TOO_LARGE', message: `文件 ${stat.size} 字节，超过上限 ${MAX_ENTRY_BYTES}。` } };
    }

    let envelope;
    try {
        envelope = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch {
        return { error: { file: fileName, code: 'INVALID_JSON', message: '文件不是合法 JSON。' } };
    }
    if (!envelope || typeof envelope !== 'object' || typeof envelope.key !== 'string') {
        return { error: { file: fileName, code: 'INVALID_ENVELOPE', message: '缺少字符串 key 字段。' } };
    }

    const key = envelope.key;
    if (!key.startsWith('user:') && !key.startsWith('avatar:')) {
        return { entry: null };
    }

    return {
        entry: {
            file: fileName,
            size: stat.size,
            key,
            value: envelope.value,
            hashMatches: storageFileName(key) === fileName,
        },
    };
}

/**
 * 只读盘点旧账户存储。
 * @param {string} dataRoot 数据根目录
 * @returns {{ok: boolean, dataRoot: string, storageDir: string, accounts: object[], avatars: object[], issues: object[], summary: object}}
 */
export function scanLegacyAccounts(dataRoot) {
    const storageDir = path.join(dataRoot, '_storage');
    const accounts = [];
    const avatars = [];
    const issues = [];

    if (!fs.existsSync(storageDir)) {
        return {
            ok: false,
            dataRoot,
            storageDir,
            accounts,
            avatars,
            issues: [{ file: '_storage', code: 'STORAGE_MISSING', message: '未找到 _storage 目录。' }],
            summary: { accountCount: 0, avatarCount: 0, totalBytes: 0 },
        };
    }

    const seenHandles = new Map();
    let fileNames = [];
    try {
        fileNames = fs.readdirSync(storageDir).filter(name => !name.startsWith('.'));
    } catch (error) {
        issues.push({ file: '_storage', code: 'READ_DIR_FAILED', message: String(error?.message ?? error) });
    }

    for (const fileName of fileNames) {
        const { entry, error } = readEntry(storageDir, fileName);
        if (error) {
            issues.push(error);
            continue;
        }
        if (!entry) {
            continue;
        }
        if (!entry.hashMatches) {
            issues.push({ file: fileName, code: 'HASH_MISMATCH', message: `文件名与 key 的 SHA-256 不一致：${entry.key}` });
        }

        if (entry.key.startsWith('user:')) {
            const handle = entry.key.slice('user:'.length);
            const user = entry.value;
            if (!handle) {
                issues.push({ file: fileName, code: 'EMPTY_HANDLE', message: '账号 handle 为空。' });
                continue;
            }
            if (!user || typeof user !== 'object') {
                issues.push({ file: fileName, code: 'INVALID_USER', message: `账号 ${handle} 的值不是对象。` });
                continue;
            }
            const lowered = handle.toLowerCase();
            if (seenHandles.has(lowered)) {
                issues.push({
                    file: fileName,
                    code: 'DUPLICATE_HANDLE',
                    message: `用户名冲突：${seenHandles.get(lowered)} 与 ${handle}`,
                });
            } else {
                seenHandles.set(lowered, handle);
            }
            if (!user.accountId) {
                issues.push({ file: fileName, code: 'MISSING_ACCOUNT_ID', message: `账号 ${handle} 缺少 accountId。` });
            } else if (!UUID.test(String(user.accountId))) {
                issues.push({ file: fileName, code: 'INVALID_ACCOUNT_ID', message: `账号 ${handle} 的 accountId 不是 UUID。` });
            }
            accounts.push({
                handle,
                accountId: user.accountId ?? null,
                enabled: user.enabled !== false,
                admin: Boolean(user.admin),
                hasPassword: Boolean(user.password),
                size: entry.size,
            });
            continue;
        }

        const handle = entry.key.slice('avatar:'.length);
        const value = entry.value;
        if (typeof value === 'string' && value.length > 0 && !isImageDataUrl(value)) {
            issues.push({ file: fileName, code: 'INVALID_AVATAR', message: `账号 ${handle} 的头像不是图片 data URL。` });
        }
        avatars.push({
            handle,
            size: entry.size,
            empty: value === '' || value == null,
        });
    }

    accounts.sort((a, b) => a.handle.localeCompare(b.handle));
    avatars.sort((a, b) => a.handle.localeCompare(b.handle));

    const totalBytes = [...accounts, ...avatars].reduce((sum, item) => sum + item.size, 0);

    return {
        ok: issues.length === 0,
        dataRoot,
        storageDir,
        accounts,
        avatars,
        issues,
        summary: {
            accountCount: accounts.length,
            avatarCount: avatars.length,
            totalBytes,
        },
    };
}

/**
 * 写入迁移日志，权限 0700/0600，内容不含敏感值。
 * @param {string} dataRoot 数据根目录
 * @param {object} payload 日志内容
 * @returns {string} 日志文件路径
 */
function writeMigrationLog(dataRoot, payload) {
    const logDir = path.join(dataRoot, MIGRATION_LOG_DIR);
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const file = path.join(logDir, `export-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    return file;
}

/**
 * 把旧 KV 账户只读导出到 SQLite。不会修改或删除任何 KV 文件。
 * 任一步失败会删除临时数据库并抛出错误，不留下半成品。
 * @param {string} dataRoot 数据根目录
 * @param {{force?: boolean}} [options] force 为 true 时覆盖已有导出库
 * @returns {Promise<{dbPath: string, accountCount: number, avatarCount: number, bytes: number, logPath: string}>}
 */
export async function exportAccountsToSqlite(dataRoot, options = {}) {
    const { force = false } = options;
    const dbPath = path.join(dataRoot, EXPORT_DB_NAME);

    if (!force && fs.existsSync(dbPath)) {
        throw new Error(`导出数据库已存在：${dbPath}。使用 --force 覆盖，或先执行 --rollback。`);
    }

    const report = scanLegacyAccounts(dataRoot);
    if (!report.ok) {
        writeMigrationLog(dataRoot, { stage: 'preflight', ok: false, issues: report.issues });
        throw new Error('盘点存在阻断问题，拒绝导出。请先修复问题列表中的项。');
    }

    const available = getAvailableBytes(dataRoot);
    const required = report.summary.totalBytes * 2 + 16 * 1024 * 1024;
    if (available !== null && available < required) {
        writeMigrationLog(dataRoot, { stage: 'space', ok: false, available, required });
        throw new Error(`磁盘空间不足：需要约 ${required} 字节，可用 ${available} 字节。`);
    }

    const tempPath = `${dbPath}.tmp-${process.pid}`;
    let db = null;
    try {
        let DatabaseSync;
        try {
            ({ DatabaseSync } = await import('node:sqlite'));
        } catch {
            throw new Error('当前 Node 不支持 node:sqlite，请使用 Node 22.13 及以上版本。');
        }

        db = new DatabaseSync(tempPath);
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = FULL');
        db.exec(`
            CREATE TABLE accounts (
                handle TEXT PRIMARY KEY,
                handle_lower TEXT NOT NULL UNIQUE,
                account_id TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL,
                admin INTEGER NOT NULL,
                has_password INTEGER NOT NULL,
                payload TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                imported_at INTEGER NOT NULL
            )
        `);

        const insert = db.prepare(`
            INSERT INTO accounts (handle, handle_lower, account_id, enabled, admin, has_password, payload, source_hash, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const fileNames = fs.readdirSync(report.storageDir).filter(name => !name.startsWith('.'));
        let imported = 0;
        const importedAt = Date.now();

        db.exec('BEGIN IMMEDIATE');
        try {
            for (const fileName of fileNames) {
                const { entry } = readEntry(report.storageDir, fileName);
                if (!entry || !entry.key.startsWith('user:')) {
                    continue;
                }
                const handle = entry.key.slice('user:'.length);
                const user = entry.value;
                insert.run(
                    handle,
                    handle.toLowerCase(),
                    String(user.accountId),
                    user.enabled === false ? 0 : 1,
                    user.admin ? 1 : 0,
                    user.password ? 1 : 0,
                    JSON.stringify(user),
                    storageFileName(entry.key),
                    importedAt,
                );
                imported++;
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }

        const row = db.prepare('SELECT COUNT(*) AS count FROM accounts').get();
        if (Number(row?.count) !== imported) {
            throw new Error(`导入数量校验失败：期望 ${imported}，实际 ${row?.count}。`);
        }

        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
        db = null;

        fs.renameSync(tempPath, dbPath);

        const logPath = writeMigrationLog(dataRoot, {
            stage: 'export',
            ok: true,
            dbPath,
            accountCount: imported,
            avatarCount: report.summary.avatarCount,
            sourceBytes: report.summary.totalBytes,
        });

        return {
            dbPath,
            accountCount: imported,
            avatarCount: report.summary.avatarCount,
            bytes: report.summary.totalBytes,
            logPath,
        };
    } catch (error) {
        if (db) {
            try { db.close(); } catch { /* 忽略关闭失败 */ }
        }
        for (const file of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) {
            try { fs.rmSync(file, { force: true }); } catch { /* 忽略清理失败 */ }
        }
        writeMigrationLog(dataRoot, { stage: 'export', ok: false, error: String(error?.message ?? error) });
        throw error;
    }
}

/**
 * 校验导出库与当前 KV 是否一致。只读，不修改任何文件。
 * @param {string} dataRoot 数据根目录
 * @returns {Promise<{ok: boolean, dbPath: string, kvAccounts: number, dbAccounts: number, mismatches: object[]}>}
 */
export async function verifyExport(dataRoot) {
    const dbPath = path.join(dataRoot, EXPORT_DB_NAME);
    if (!fs.existsSync(dbPath)) {
        throw new Error(`导出数据库不存在：${dbPath}。请先执行 --export。`);
    }

    const report = scanLegacyAccounts(dataRoot);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const mismatches = [];
    try {
        const total = Number(db.prepare('SELECT COUNT(*) AS count FROM accounts').get()?.count ?? 0);
        const select = db.prepare('SELECT account_id, source_hash FROM accounts WHERE handle = ?');
        const known = new Set(report.accounts.map(account => account.handle));

        for (const account of report.accounts) {
            const row = select.get(account.handle);
            if (!row) {
                mismatches.push({ handle: account.handle, code: 'MISSING_IN_DB' });
                continue;
            }
            if (String(row.account_id) !== String(account.accountId)) {
                mismatches.push({ handle: account.handle, code: 'ACCOUNT_ID_MISMATCH' });
            }
            if (String(row.source_hash) !== storageFileName(`user:${account.handle}`)) {
                mismatches.push({ handle: account.handle, code: 'SOURCE_HASH_MISMATCH' });
            }
        }

        for (const row of db.prepare('SELECT handle FROM accounts').all()) {
            if (!known.has(row.handle)) {
                mismatches.push({ handle: row.handle, code: 'EXTRA_IN_DB' });
            }
        }

        return {
            ok: mismatches.length === 0 && total === report.summary.accountCount,
            dbPath,
            kvAccounts: report.summary.accountCount,
            dbAccounts: total,
            mismatches,
        };
    } finally {
        db.close();
    }
}

/**
 * 对比当前 KV 全量扫描与 SQLite 分页查询的耗时，仅用于评估，不改数据。
 * @param {string} dataRoot 数据根目录
 * @param {{limit?: number, rounds?: number}} [options] 分页大小与重复次数
 * @returns {Promise<object>} 耗时与数量摘要
 */
export async function benchmarkAccountQueries(dataRoot, options = {}) {
    const { limit = 25, rounds = 20 } = options;

    const kvStart = performance.now();
    const report = scanLegacyAccounts(dataRoot);
    const kvMs = performance.now() - kvStart;

    const dbPath = path.join(dataRoot, EXPORT_DB_NAME);
    if (!fs.existsSync(dbPath)) {
        throw new Error(`导出数据库不存在：${dbPath}。请先执行 --export。`);
    }

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const page = db.prepare('SELECT handle, enabled, admin FROM accounts ORDER BY handle_lower LIMIT ? OFFSET ?');
        const count = db.prepare('SELECT COUNT(*) AS count FROM accounts');
        const start = performance.now();
        let rows = 0;
        for (let index = 0; index < rounds; index++) {
            rows += page.all(limit, index * limit).length;
            count.get();
        }
        const sqliteMs = (performance.now() - start) / rounds;
        return {
            kvAccounts: report.summary.accountCount,
            dbAccounts: Number(count.get()?.count ?? 0),
            kvFullScanMs: Number(kvMs.toFixed(1)),
            sqlitePagedAvgMs: Number(sqliteMs.toFixed(2)),
            limit,
            rounds,
            sampledRows: rows,
        };
    } finally {
        db.close();
    }
}

/**
 * 删除已导出的 SQLite 文件（不触碰 KV 账户）。
 * @param {string} dataRoot 数据根目录
 * @returns {boolean} 是否删除了文件
 */
export function removeExportedDatabase(dataRoot) {
    const dbPath = path.join(dataRoot, EXPORT_DB_NAME);
    let removed = false;
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (fs.existsSync(file)) {
            fs.rmSync(file, { force: true });
            removed = true;
        }
    }
    return removed;
}
