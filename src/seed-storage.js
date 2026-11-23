import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 判断文件系统是否支持写时复制克隆（reflink）。
 * 这里仅用于“探测失败即普通复制”的降级判断，不参与任何数据格式。
 */
const CLONE_UNSUPPORTED_CODES = new Set([
    'ENOTSUP',
    'EOPNOTSUPP',
    'EXDEV',
    'ENOSYS',
    'EINVAL',
    'EPERM',
]);

/** 按设备缓存的克隆能力探测结果。 @type {Map<string, boolean>} */
const cloneSupportCache = new Map();

/** 已提示过回退的设备，避免重复刷日志。 @type {Set<string>} */
const reportedFallback = new Set();

/**
 * 种子资源存储错误，用于区分“普通异常”和“必须阻止开户”的存储条件。
 */
export class SeedStorageError extends Error {
    /**
     * @param {string} code 错误码
     * @param {string} message 错误信息
     */
    constructor(code, message) {
        super(message);
        this.name = 'SeedStorageError';
        this.code = code;
    }
}

/**
 * 获取目录所在卷的可用字节数。
 * @param {string} directory 目标目录
 * @returns {number|null} 可用字节数；无法获取时返回 null
 */
export function getAvailableBytes(directory) {
    try {
        const stats = fs.statfsSync(directory);
        const available = Number(stats.bavail) * Number(stats.bsize);
        return Number.isFinite(available) ? available : null;
    } catch {
        return null;
    }
}

/**
 * 获取目录所在设备标识，用于缓存克隆能力。
 * @param {string} directory 目录
 * @returns {string} 缓存键
 */
function getDeviceKey(directory) {
    try {
        return String(fs.statSync(directory).dev);
    } catch {
        return path.resolve(directory);
    }
}

/**
 * 探测目标目录所在卷是否真正支持文件级写时复制。
 * 探测失败时视为不支持，交由调用方普通复制。
 * @param {string} directory 已存在的目录
 * @returns {boolean} 是否支持强制克隆
 */
export function supportsSeedClone(directory) {
    const key = getDeviceKey(directory);
    const cached = cloneSupportCache.get(key);
    if (cached !== undefined) {
        return cached;
    }

    const token = crypto.randomBytes(8).toString('hex');
    const probeSource = path.join(directory, `.seed-probe-${token}.src`);
    const probeTarget = path.join(directory, `.seed-probe-${token}.dst`);
    let supported = false;
    try {
        fs.writeFileSync(probeSource, 'sillytavern-seed-clone-probe');
        fs.copyFileSync(probeSource, probeTarget, fs.constants.COPYFILE_FICLONE_FORCE);
        supported = true;
    } catch {
        supported = false;
    } finally {
        for (const file of [probeSource, probeTarget]) {
            try {
                fs.unlinkSync(file);
            } catch {
                // 忽略探测文件清理失败
            }
        }
    }

    cloneSupportCache.set(key, supported);
    if (!supported && !reportedFallback.has(key)) {
        reportedFallback.add(key);
        console.info('[种子存储] 当前数据卷不支持写时复制克隆，新账号默认素材将使用普通复制。');
    }
    return supported;
}

/**
 * 清空克隆能力缓存。仅供测试或卷挂载变化后使用。
 */
export function resetSeedCloneCache() {
    cloneSupportCache.clear();
    reportedFallback.clear();
}

/**
 * 统计文件或目录树的逻辑字节数。
 * @param {string} target 文件或目录
 * @returns {number} 逻辑字节数
 */
export function measureTreeBytes(target) {
    const stats = fs.lstatSync(target);
    if (stats.isDirectory()) {
        let total = 0;
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
            total += measureTreeBytes(path.join(target, entry.name));
        }
        return total;
    }
    if (stats.isFile()) {
        return stats.size;
    }
    return 0;
}

/**
 * 判断普通复制是否可能耗尽目标卷，并预留安全余量。
 * @param {string} directory 目标目录
 * @param {number} requiredBytes 本次预计新增的逻辑字节数
 * @throws {SeedStorageError} 空间不足时抛出
 */
export function assertSeedSpace(directory, requiredBytes) {
    const available = getAvailableBytes(directory);
    if (available === null) {
        return;
    }

    const margin = Math.max(64 * 1024 * 1024, Math.ceil(requiredBytes * 0.1));
    if (available < requiredBytes + margin) {
        throw new SeedStorageError(
            'INSUFFICIENT_SEED_SPACE',
            `默认素材需要 ${requiredBytes} 字节，目标卷仅剩 ${available} 字节，拒绝在此卷播种。`,
        );
    }
}

/**
 * 判断错误是否代表目标文件系统不支持克隆。
 * @param {NodeJS.ErrnoException} error 复制错误
 * @returns {boolean} 是否应回退普通复制
 */
export function isCloneUnsupportedError(error) {
    return Boolean(error && CLONE_UNSUPPORTED_CODES.has(String(error.code)));
}

/**
 * 以临时文件 + 同目录原子改名的方式播种单个种子文件。
 * 支持克隆时使用强制 CoW；不支持时回退普通复制。
 * @param {string} source 源文件
 * @param {string} destination 目标文件
 * @param {boolean} [clone] 是否尝试克隆，默认按目标目录探测
 */
export function copySeedFile(source, destination, clone = supportsSeedClone(path.dirname(destination))) {
    const temporary = path.join(
        path.dirname(destination),
        `.${path.basename(destination)}.seed-${crypto.randomBytes(6).toString('hex')}`,
    );

    try {
        if (clone) {
            try {
                fs.copyFileSync(source, temporary, fs.constants.COPYFILE_FICLONE_FORCE);
            } catch (error) {
                if (!isCloneUnsupportedError(error)) {
                    throw error;
                }
                fs.copyFileSync(source, temporary);
            }
        } else {
            fs.copyFileSync(source, temporary);
        }
        fs.renameSync(temporary, destination);
    } catch (error) {
        try {
            fs.unlinkSync(temporary);
        } catch {
            // 忽略临时文件清理失败
        }
        throw error;
    }
}
