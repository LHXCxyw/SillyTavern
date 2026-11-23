#!/usr/bin/env node
/**
 * 账户迁移只读盘点命令。
 * 用法：
 *   node migrate-accounts.js                 # 自动读取 config.yaml 的 dataRoot
 *   node migrate-accounts.js --data-root /path/to/data
 *   node migrate-accounts.js --json          # 机器可读输出
 *   node migrate-accounts.js --export        # 只读导出到 SQLite（不改 KV）
 *   node migrate-accounts.js --verify        # 校验导出库与当前 KV 一致
 *   node migrate-accounts.js --benchmark     # 对比 KV 扫描与 SQLite 分页耗时
 *   node migrate-accounts.js --rollback      # 删除导出的 SQLite 文件
 * 该命令不会修改或删除任何 KV 账户文件；--apply 尚未实现，会直接拒绝。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import YAML from 'yaml';

import { benchmarkAccountQueries, exportAccountsToSqlite, removeExportedDatabase, scanLegacyAccounts, verifyExport } from './src/account-migration.js';

const args = process.argv.slice(2);

if (args.includes('--apply')) {
    console.error('拒绝执行：--apply 权威迁移尚未实现。当前可用 --export 做只读 SQLite 导出。');
    process.exit(2);
}

/**
 * 读取命令行参数值。
 * @param {string} name 参数名
 * @returns {string|null} 参数值
 */
function valueAfter(name) {
    const index = args.indexOf(name);
    if (index === -1) {
        return null;
    }
    const value = args[index + 1];
    return value && !value.startsWith('--') ? value : null;
}

/**
 * 解析数据根目录。
 * @returns {string} 绝对路径
 */
function resolveDataRoot() {
    const explicit = valueAfter('--data-root');
    if (explicit) {
        return path.resolve(explicit);
    }
    const configPath = path.join(process.cwd(), 'config.yaml');
    if (fs.existsSync(configPath)) {
        try {
            const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
            if (typeof config?.dataRoot === 'string' && config.dataRoot.trim()) {
                return path.resolve(process.cwd(), config.dataRoot);
            }
        } catch {
            // 配置解析失败时退回默认目录
        }
    }
    return path.join(process.cwd(), 'data');
}

/**
 * 格式化字节数。
 * @param {number} bytes 字节
 * @returns {string} 可读大小
 */
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

const dataRoot = resolveDataRoot();

if (args.includes('--verify')) {
    try {
        const result = await verifyExport(dataRoot);
        console.log('导出库与当前 KV 一致性校验');
        console.log(`KV 账号数: ${result.kvAccounts}`);
        console.log(`库账号数: ${result.dbAccounts}`);
        console.log(`结论: ${result.ok ? '一致' : '不一致，详见下方'}`);
        for (const item of result.mismatches) {
            console.log(`  [${item.code}] ${item.handle}`);
        }
        process.exit(result.ok ? 0 : 1);
    } catch (error) {
        console.error(`校验失败: ${error?.message ?? error}`);
        process.exit(1);
    }
}

if (args.includes('--benchmark')) {
    try {
        const result = await benchmarkAccountQueries(dataRoot);
        console.log('查询耗时对比（只读，仅供参考）');
        console.log(`账号数: ${result.kvAccounts}`);
        console.log(`KV 全量扫描: ${result.kvFullScanMs} ms`);
        console.log(`SQLite 分页均值（每页 ${result.limit} 条，${result.rounds} 轮）: ${result.sqlitePagedAvgMs} ms`);
        process.exit(0);
    } catch (error) {
        console.error(`基准测试失败: ${error?.message ?? error}`);
        process.exit(1);
    }
}

if (args.includes('--rollback')) {
    const removed = removeExportedDatabase(dataRoot);
    console.log(removed ? `已删除导出数据库: ${path.join(dataRoot, '_migration-accounts.sqlite')}` : '没有找到导出数据库，无需清理。');
    process.exit(0);
}

if (args.includes('--export')) {
    try {
        const result = await exportAccountsToSqlite(dataRoot, { force: args.includes('--force') });
        console.log('账户只读导出完成（KV 未改动）');
        console.log(`数据库: ${result.dbPath}`);
        console.log(`账号数: ${result.accountCount}`);
        console.log(`头像数: ${result.avatarCount}`);
        console.log(`源字节: ${formatBytes(result.bytes)}`);
        console.log(`日志:   ${result.logPath}`);
        process.exit(0);
    } catch (error) {
        console.error(`导出失败: ${error?.message ?? error}`);
        process.exit(1);
    }
}

const report = scanLegacyAccounts(dataRoot);

if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log('账户存储只读盘点（不会修改任何文件）');
    console.log(`数据根目录: ${report.dataRoot}`);
    console.log(`存储目录:   ${report.storageDir}`);
    console.log(`账号数:     ${report.summary.accountCount}`);
    console.log(`头像记录:   ${report.summary.avatarCount}`);
    console.log(`相关字节:   ${formatBytes(report.summary.totalBytes)}`);
    console.log(`结论:       ${report.ok ? '可进入迁移评审' : '存在阻断问题，先修复'}`);
    if (report.accounts.length > 0) {
        console.log('\n账号明细（最多显示 20 条）:');
        for (const account of report.accounts.slice(0, 20)) {
            const tags = [account.admin ? '管理员' : '普通', account.enabled ? '启用' : '禁用', account.hasPassword ? '有密码' : '无密码'];
            console.log(`  ${account.handle}  accountId=${account.accountId ?? '缺失'}  ${tags.join('/')}  ${formatBytes(account.size)}`);
        }
    }
    if (report.issues.length > 0) {
        console.log('\n问题列表:');
        for (const issue of report.issues) {
            console.log(`  [${issue.code}] ${issue.file}: ${issue.message}`);
        }
    }
}

process.exitCode = report.ok ? 0 : 1;
