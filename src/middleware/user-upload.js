import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import multer from 'multer';
import { acquireUserOperation, isUserPurgeBlocked } from '../user-operation-state.js';

/**
 * 按账户实例分离暂存文件，并跟踪写入直到文件句柄关闭。
 * @param {string} root 上传暂存根目录
 * @returns {import('express').RequestHandler}
 */
export function createUserUploadMiddleware(root) {
    const upload = multer({
        limits: { fieldSize: 500 * 1024 * 1024 },
        storage: {
            _handleFile(request, file, callback) {
                const { accountId, handle } = request.user.profile;
                const controller = new AbortController();
                const release = acquireUserOperation(handle, { onAbort: () => controller.abort() });
                if (!release) return callback(Object.assign(new Error('账号已到清除截止时间'), { status: 403 }));
                const destination = path.join(root, accountId ?? 'default-user');
                const filename = randomUUID();
                const target = path.join(destination, filename);
                const abort = () => controller.abort();
                request.once('aborted', abort);
                (async () => {
                    let output;
                    try {
                        await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
                        if (!(await fs.promises.lstat(destination)).isDirectory()) throw new Error('上传暂存路径无效');
                        output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
                        await pipeline(file.stream, output, { signal: controller.signal });
                        if (isUserPurgeBlocked(handle) || request.aborted) throw Object.assign(new Error('上传已中止'), { status: 403 });
                        callback(null, { destination, filename, path: target, size: output.bytesWritten });
                    } catch (error) {
                        if (output && !output.pending && error.code !== 'EEXIST') await fs.promises.rm(target, { force: true }).catch(() => {});
                        callback(error);
                    } finally {
                        request.removeListener('aborted', abort);
                        release();
                    }
                })().catch(error => {
                    request.destroy(error);
                    release();
                });
            },
            _removeFile(_request, file, callback) {
                fs.rm(file.path, { force: true }, callback);
            },
        },
    }).single('avatar');
    return (request, response, next) => upload(request, response, error => {
        if (error) return next(error);
        const target = request.file?.path;
        if (target) {
            const remove = () => fs.rm(target, { force: true }, () => {});
            // 不在 close 时提前删除：已断开的路由仍可能在读取上传文件。
            response.once('finish', remove);
        }
        if (isUserPurgeBlocked(request.user.profile.handle)) return response.sendStatus(403);
        return next();
    });
}
