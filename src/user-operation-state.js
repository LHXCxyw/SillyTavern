const locks = new Map();
const deadlines = new Map();
const activeOperations = new Map();
const idleWaiters = new Map();
const wrappedRouters = new WeakSet();

/**
 * 按用户名串行提交读改写，失败不会阻塞后续操作。
 * @template T
 * @param {string} handle 用户名
 * @param {() => T | Promise<T>} action 操作
 * @returns {Promise<T>}
 */
export function withUserLock(handle, action) {
    const key = handle.toLowerCase();
    const task = (locks.get(key) ?? Promise.resolve()).then(action);
    const tail = task.then(() => {}, () => {});
    locks.set(key, tail);
    return task.finally(() => {
        if (locks.get(key) === tail) locks.delete(key);
    });
}

export function setUserPurgeDeadline(handle, timeOrNull) {
    const key = handle.toLowerCase();
    if (timeOrNull === null) deadlines.delete(key);
    else deadlines.set(key, timeOrNull);
}

export function getUserPurgeDeadline(handle) {
    return deadlines.get(handle.toLowerCase()) ?? null;
}

export function isUserPurgeBlocked(handle) {
    const deadline = getUserPurgeDeadline(handle);
    return deadline !== null && deadline <= Date.now();
}

/**
 * 直到访问者实际结束（包括文件句柄关闭）才调用释放函数。
 * @param {string} handle 用户名
 * @param {{onAbort?: () => void}} [options] 需要在到期时主动结束的操作
 * @returns {(() => void) | null}
 */
export function acquireUserOperation(handle, { onAbort } = {}) {
    const key = handle.toLowerCase();
    if (isUserPurgeBlocked(key)) return null;
    const entries = activeOperations.get(key) ?? new Set();
    const entry = { onAbort };
    entries.add(entry);
    activeOperations.set(key, entries);
    return () => {
        if (!entries.delete(entry) || entries.size !== 0) return;
        activeOperations.delete(key);
        for (const waiter of idleWaiters.get(key) ?? []) waiter(true);
    };
}

export function abortUserOperations(handle) {
    for (const entry of activeOperations.get(handle.toLowerCase()) ?? []) {
        try {
            entry.onAbort?.();
        } catch {
            console.warn('到期操作未能主动中止，等待正常退出。');
        }
    }
}

export function waitForUserOperations(handle, timeoutMs = 30_000) {
    const key = handle.toLowerCase();
    if (!activeOperations.has(key)) return Promise.resolve(true);
    return new Promise(resolve => {
        const waiters = idleWaiters.get(key) ?? new Set();
        idleWaiters.set(key, waiters);
        const finish = (idle) => {
            clearTimeout(timer);
            waiters.delete(finish);
            if (waiters.size === 0) idleWaiters.delete(key);
            resolve(idle);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        waiters.add(finish);
    });
}

/**
 * 请求关闭不代表执行中的异步路由已结束。跟踪已注册的 Express 路由处理函数，
 * 不额外持有针对公共路由或 Express 错误处理中间件的锁。
 * @param {import('express').Router} router 私有路由
 * @returns {import('express').Router}
 */
export function trackUserRouter(router) {
    if (wrappedRouters.has(router)) return router;
    wrappedRouters.add(router);
    for (const layer of router.stack) {
        if (layer.route) {
            for (const routeLayer of layer.route.stack) trackLayer(routeLayer);
        } else if (Array.isArray(layer.handle.stack)) {
            trackUserRouter(layer.handle);
        } else {
            trackLayer(layer);
        }
    }
    return router;
}

export function trackAuthenticatedRequest(request, response, next) {
    const release = acquireUserOperation(request.user.profile.handle);
    if (!release) return response.sendStatus(403);
    response.once('finish', release);
    response.once('close', release);
    return next();
}

function trackLayer(layer) {
    const handler = layer.handle;
    if (handler.length > 3) return;
    layer.handle = function trackUserRequest(request, response, next) {
        if (response.destroyed) return;
        const handle = request.user?.profile.handle;
        if (!handle) return handler(request, response, next);
        const release = acquireUserOperation(handle);
        if (!release) return response.sendStatus(403);
        try {
            const result = handler(request, response, next);
            if (result && typeof result.then === 'function') {
                return Promise.resolve(result).then(release, error => {
                    release();
                    next(error);
                });
            }
            release();
            return result;
        } catch (error) {
            release();
            throw error;
        }
    };
}
