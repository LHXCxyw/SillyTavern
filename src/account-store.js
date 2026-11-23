import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 账户存储模块（过渡期）。
 * - KV 仍是权威存储：所有写入仍由调用方先写 node-persist。
 * - 内存索引用于快速读取（管理员列表等）。
 * - 可选 SQLite 影子写：双写失败不会影响 KV 主流程。
 */

/** @type {Map<string, object>} 小写 handle -> 账户对象 */
const accounts = new Map();
let storageDir = '';
let lastDirSignature = '';
let initialized = false;

/** @type {null | {db: any, upsert: any, remove: any}} */
let shadow = null;
let shadowDisabled = false;

/**
 * 计算 node-persist 文件名。
 * @param {string} key 完整键
 * @returns {string} SHA-256 十六进制
 */
function storageFileName(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * 目录签名：文件数 + 目录 mtime + 文件最大 mtime。
 * 后者用于发现“原地改写同一个文件”的外部修改（如 recover.js）。
 * @param {string} directory 目录
 * @returns {string} 签名
 */
function dirSignature(directory) {
    try {
        const stat = fs.statSync(directory);
        const names = fs.readdirSync(directory).filter(name => !name.startsWith('.'));
        let maxMtime = 0;
        for (const name of names) {
            try {
                const fileStat = fs.lstatSync(path.join(directory, name));
                if (fileStat.mtimeMs > maxMtime) {
                    maxMtime = fileStat.mtimeMs;
                }
            } catch {
                // 单个文件读取失败不影响签名
            }
        }
        return `${names.length}:${stat.mtimeMs}:${maxMtime}`;
    } catch {
        return '';
    }
}

/**
 * 从存储目录逐文件读取账户，构建索引。
 * 单条读取、有大小上限，不调用 node-persist 的全量 values()。
 * @param {string} directory _storage 目录
 */
function buildFromDirectory(directory) {
    accounts.clear();
    let names = [];
    try {
        names = fs.readdirSync(directory).filter(name => !name.startsWith('.'));
    } catch {
        return;
    }

    for (const name of names) {
        const fullPath = path.join(directory, name);
        try {
            const stat = fs.lstatSync(fullPath);
            if (!stat.isFile() || stat.size > 16 * 1024 * 1024) {
                continue;
            }
            const envelope = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            if (!envelope || typeof envelope.key !== 'string' || !envelope.key.startsWith('user:')) {
                continue;
            }
            const user = envelope.value;
            if (!user || typeof user !== 'object') {
                continue;
            }
            const handle = String(user.handle ?? envelope.key.slice('user:'.length));
            if (!handle) {
                continue;
            }
            const key = handle.toLowerCase();
            if (accounts.has(key)) {
                console.warn(`[账户索引] 用户名冲突，保留先出现的账号：${handle}`);
                continue;
            }
            accounts.set(key, { ...user, handle });
        } catch {
            // 单个坏文件不影响其他账号
        }
    }
}

/**
 * 初始化影子 SQLite。文件不存在或不可写时静默降级。
 * @param {string} dataRoot 数据根目录
 */
async function initShadow(dataRoot) {
    shadowDisabled = true;
    const dbPath = path.join(dataRoot, '_migration-accounts.sqlite');
    if (!fs.existsSync(dbPath)) {
        return;
    }
    try {
        fs.accessSync(dbPath, fs.constants.W_OK);
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(dbPath);
        db.exec('PRAGMA journal_mode = WAL');
        const upsert = db.prepare(`
            INSERT INTO accounts (handle, handle_lower, account_id, enabled, admin, has_password, payload, source_hash, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(handle) DO UPDATE SET
                handle_lower = excluded.handle_lower,
                account_id = excluded.account_id,
                enabled = excluded.enabled,
                admin = excluded.admin,
                has_password = excluded.has_password,
                payload = excluded.payload,
                source_hash = excluded.source_hash,
                imported_at = excluded.imported_at
        `);
        const remove = db.prepare('DELETE FROM accounts WHERE handle = ?');
        shadow = { db, upsert, remove };
        shadowDisabled = false;
    } catch (error) {
        shadow = null;
        shadowDisabled = true;
        console.warn(`[账户索引] SQLite 影子写已禁用：${error?.message ?? error}`);
    }
}

/**
 * 初始化账户索引。
 * @param {{dataRoot: string}} options 数据根目录
 * @returns {Promise<void>}
 */
export async function initAccountStore({ dataRoot }) {
    storageDir = path.join(dataRoot, '_storage');
    buildFromDirectory(storageDir);
    lastDirSignature = dirSignature(storageDir);
    await initShadow(dataRoot);
    initialized = true;
}

/**
 * 若存储目录发生外部变化（如 recover.js），重建索引。
 * 仅在目录签名变化时读盘。
 */
export function refreshAccountIndexIfChanged() {
    if (!initialized) {
        return;
    }
    const signature = dirSignature(storageDir);
    if (signature !== lastDirSignature) {
        buildFromDirectory(storageDir);
        lastDirSignature = signature;
    }
}

/**
 * 获取全部账户（浅拷贝）。
 * @returns {object[]} 账户数组
 */
export function getAllAccounts() {
    refreshAccountIndexIfChanged();
    return [...accounts.values()].map(user => ({ ...user }));
}

/**
 * 按 handle 获取账户，大小写不敏感。
 * @param {string} handle 用户名
 * @returns {object|null} 账户对象浅拷贝
 */
export function getAccount(handle) {
    refreshAccountIndexIfChanged();
    const user = accounts.get(String(handle ?? '').toLowerCase());
    return user ? { ...user } : null;
}

/**
 * 记录一次账户写入：更新内存索引与可选 SQLite 影子。
 * 调用方仍需先写入 KV（KV 是权威存储）。
 * @param {object} user 账户对象
 */
export function recordAccount(user) {
    if (!user || typeof user !== 'object' || !user.handle) {
        return;
    }
    const handle = String(user.handle);
    accounts.set(handle.toLowerCase(), { ...user, handle });
    lastDirSignature = dirSignature(storageDir);

    if (!shadow) {
        return;
    }
    try {
        shadow.upsert.run(
            handle,
            handle.toLowerCase(),
            String(user.accountId ?? ''),
            user.enabled === false ? 0 : 1,
            user.admin ? 1 : 0,
            user.password ? 1 : 0,
            JSON.stringify(user),
            storageFileName(`user:${handle}`),
            Date.now(),
        );
    } catch (error) {
        if (!shadowDisabled) {
            console.warn(`[账户索引] SQLite 影子写失败，后续继续使用 KV：${error?.message ?? error}`);
            shadowDisabled = true;
            shadow = null;
        }
    }
}

/**
 * 记录一次账户删除。
 * @param {string} handle 用户名
 */
export function removeAccount(handle) {
    const key = String(handle ?? '').toLowerCase();
    accounts.delete(key);
    lastDirSignature = dirSignature(storageDir);

    if (!shadow) {
        return;
    }
    try {
        shadow.remove.run(String(handle));
    } catch (error) {
        if (!shadowDisabled) {
            console.warn(`[账户索引] SQLite 影子删除失败：${error?.message ?? error}`);
            shadowDisabled = true;
            shadow = null;
        }
    }
}

/**
 * 关闭索引与影子连接。用于测试或进程退出前释放文件句柄。
 */
export function closeAccountStore() {
    if (shadow) {
        try { shadow.db.close(); } catch { /* 忽略关闭失败 */ }
    }
    shadow = null;
    shadowDisabled = false;
    accounts.clear();
    lastDirSignature = '';
    initialized = false;
}

/**
 * 供测试使用的状态查询。
 * @returns {{size: number, shadowEnabled: boolean}}
 */
export function getAccountStoreState() {
    return { size: accounts.size, shadowEnabled: Boolean(shadow) };
}
