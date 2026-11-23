import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from '@jest/globals';
import {
    SeedStorageError,
    assertSeedSpace,
    copySeedFile,
    measureTreeBytes,
    resetSeedCloneCache,
    supportsSeedClone,
} from '../src/seed-storage.js';

let root;

beforeEach(() => {
    resetSeedCloneCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-seed-storage-'));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function listSeedTemps(directory) {
    return fs.readdirSync(directory).filter(name => name.includes('.seed-'));
}

test('measureTreeBytes 递归统计文件逻辑字节', () => {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'a.bin'), Buffer.alloc(10));
    fs.writeFileSync(path.join(root, 'nested', 'b.bin'), Buffer.alloc(25));

    expect(measureTreeBytes(root)).toBe(35);
    expect(measureTreeBytes(path.join(root, 'a.bin'))).toBe(10);
});

test('copySeedFile 以普通复制写入完整内容且不留临时文件', () => {
    const source = path.join(root, 'source.txt');
    const destination = path.join(root, 'destination.txt');
    const payload = '种子资源内容';
    fs.writeFileSync(source, payload);

    copySeedFile(source, destination, false);

    expect(fs.readFileSync(destination, 'utf8')).toBe(payload);
    expect(listSeedTemps(root)).toEqual([]);
});

test('copySeedFile 在克隆模式下仍能生成正确且独立的目标文件', () => {
    const source = path.join(root, 'source.txt');
    const destination = path.join(root, 'destination.txt');
    fs.writeFileSync(source, 'original');
    fs.writeFileSync(destination, 'stale');

    copySeedFile(source, destination, true);

    expect(fs.readFileSync(destination, 'utf8')).toBe('original');
    // 用户修改目标文件不得影响共享源文件
    fs.writeFileSync(destination, 'user-change');
    expect(fs.readFileSync(source, 'utf8')).toBe('original');
    expect(listSeedTemps(root)).toEqual([]);
});

test('supportsSeedClone 对已存在目录返回布尔值并缓存结果', () => {
    const first = supportsSeedClone(root);
    const second = supportsSeedClone(root);
    expect(typeof first).toBe('boolean');
    expect(second).toBe(first);
});

test('assertSeedSpace 在明显不足时抛出 SeedStorageError', () => {
    expect(() => assertSeedSpace(root, Number.MAX_SAFE_INTEGER)).toThrow(SeedStorageError);
    try {
        assertSeedSpace(root, Number.MAX_SAFE_INTEGER);
    } catch (error) {
        expect(error.code).toBe('INSUFFICIENT_SEED_SPACE');
    }
});

test('assertSeedSpace 在需求很小时不抛错', () => {
    expect(() => assertSeedSpace(root, 1)).not.toThrow();
});
