/**
 * 索引服务模块 - 按需生成版本
 * 管理文件系统监控、索引重建、增量更新，禁用自动缩略图生成
 */
const chokidar = require('chokidar');
const path = require('path');
const nativeFs = require('fs');
const { promises: fs } = nativeFs;
const logger = require('../config/logger');
const { TraceManager } = require('../utils/trace');
const { redis } = require('../config/redis');
const { safeRedisIncr, safeRedisDel } = require('../utils/helpers');
const { invalidateTags } = require('./cache.service');
const { PHOTOS_DIR, THUMBS_DIR, INDEX_STABILIZE_DELAY_MS } = require('../config');
const { dbRun, runPreparedBatch, dbAll } = require('../db/multi-db');
const { withTransaction } = require('../services/tx.manager');
const { getIndexingWorker, getVideoWorker, createDisposableWorker } = require('./worker.manager');
const settingsService = require('./settings.service');
const orchestrator = require('./orchestrator');
const { invalidateCoverCache } = require('./file.service');
const crypto = require('crypto');
const { sanitizePath, isPathSafe } = require('../utils/path.utils');
const { normalizeWorkerMessage } = require('../utils/workerMessage');

const PHOTOS_ROOT = path.resolve(PHOTOS_DIR);

const LARGE_FILE_HASH_THRESHOLD_BYTES = Number(process.env.INDEX_HASH_SIZE_THRESHOLD || (200 * 1024 * 1024));
const HASH_SAMPLE_BYTES = Number(process.env.INDEX_HASH_SAMPLE_BYTES || (4 * 1024 * 1024));

function logIndexerIgnore(scope, error) {
    if (!error) return;
    logger.silly(`[IndexerService] ${scope} 忽略异常: ${error.message}`);
}

/**
 * 文件过滤器
 * 集中管理文件监听的过滤逻辑
 */
class FileFilter {
    constructor() {
        // 从配置中读取过滤规则，支持环境变量扩展
        this.ignorePatterns = this.buildIgnorePatterns();
    }

    /**
     * 构建忽略模式列表
     */
    buildIgnorePatterns() {
        const patterns = [
            /(^|[\/\\])@eaDir/,  // 忽略隐藏文件和Synology系统目录
            /(^|[\/\\])\.tmp/,   // 忽略临时目录
            /temp_opt_.*/,      // 忽略临时文件
            /.*\.tmp$/          // 忽略.tmp后缀文件
        ];

        // 支持环境变量添加自定义忽略模式
        const customIgnores = process.env.WATCH_CUSTOM_IGNORES;
        if (customIgnores) {
            try {
                const customPatterns = customIgnores.split(',').map(pattern => new RegExp(pattern.trim()));
                patterns.push(...customPatterns);
            } catch (e) {
                logger.warn('解析自定义忽略模式失败：', customIgnores);
            }
        }

        return patterns;
    }

    /**
     * 检查文件是否应该被忽略
     */
    shouldIgnore(filePath) {
        return this.ignorePatterns.some(pattern => pattern.test(filePath));
    }

    /**
     * 检查是否是受支持的媒体文件
     */
    isSupportedMediaFile(filePath) {
        return /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(filePath);
    }

    /**
     * 检查是否是视频文件
     */
    isVideoFile(filePath) {
        return /\.(mp4|webm|mov)$/i.test(filePath);
    }

    /**
     * 检查是否是图片文件
     */
    isImageFile(filePath) {
        return /\.(jpe?g|png|webp|gif)$/i.test(filePath);
    }

    /**
     * 获取文件类型
     */
    getFileType(filePath) {
        if (this.isVideoFile(filePath)) return 'video';
        if (this.isImageFile(filePath)) return 'image';
        return 'unknown';
    }

    /**
     * 过滤文件变更事件
     */
    shouldProcessFileChange(type, filePath) {
        // 检查是否应该忽略
        if (this.shouldIgnore(filePath)) {
            return false;
        }

        const normalizedType = typeof type === 'string' ? type.toLowerCase() : '';
        if (normalizedType === 'adddir' || normalizedType === 'unlinkdir') {
            return true;
        }

        // 检查文件类型
        if (!this.isSupportedMediaFile(filePath)) {
            return false;
        }

        return true;
    }

    /**
     * 获取过滤器配置（用于chokidar）
     */
    getChokidarConfig() {
        return {
            ignored: this.ignorePatterns,
            awaitWriteFinish: {
                stabilityThreshold: Number(process.env.WATCH_STABILITY_THRESHOLD || 2000),
                pollInterval: Number(process.env.WATCH_POLL_INTERVAL || 100)
            },
            usePolling: (process.env.WATCH_USE_POLLING || 'false').toLowerCase() === 'true',
            interval: Number(process.env.WATCH_POLL_INTERVAL || 1000),
            binaryInterval: Number(process.env.WATCH_POLL_BINARY_INTERVAL || 1500),
        };
    }
}

// 创建单例文件过滤器
const fileFilter = new FileFilter();

// 索引服务状态管理
let rebuildTimeout;           // 重建超时定时器
let isIndexing = false;       // 索引进行中标志
let pendingIndexChanges = new Map(); // filePath -> [changes]

let postIndexMaintenanceScheduled = false;
const MANUAL_ENQUEUE_DEFAULT_DELAY_MS = Math.min(INDEX_STABILIZE_DELAY_MS, 500);
function enqueueIndexChange(change) {
    if (!change || !change.filePath) {
        return;
    }

    const key = String(change.filePath);
    let bucket = pendingIndexChanges.get(key);
    if (!bucket) {
        bucket = [];
        pendingIndexChanges.set(key, bucket);
    }
    bucket.push(change);
}

function flattenPendingChanges() {
    const merged = [];
    for (const list of pendingIndexChanges.values()) {
        if (Array.isArray(list) && list.length > 0) {
            merged.push(...list);
        }
    }
    return merged;
}

function getPendingChangeCount() {
    let total = 0;
    for (const list of pendingIndexChanges.values()) {
        total += Array.isArray(list) ? list.length : 0;
    }
    return total;
}

function consolidateAndExtractChanges() {
    const snapshot = flattenPendingChanges();
    pendingIndexChanges.clear();
    return consolidateIndexChanges(snapshot);
}

function schedulePostIndexMaintenance() {
    if (postIndexMaintenanceScheduled) {
        return;
    }
    postIndexMaintenanceScheduled = true;

    const startDelay = Number(process.env.POST_INDEX_BACKFILL_DELAY_MS || 8000);
    const retryInterval = Number(process.env.POST_INDEX_BACKFILL_RETRY_MS || 60000);
    const timeoutMs = Number(process.env.POST_INDEX_BACKFILL_TIMEOUT_MS || (15 * 60 * 1000));

    try {
        orchestrator.runWhenIdle('post-index-backfill', async () => {
            try {
                await runIndexingTask('post_index_backfill', { photosDir: PHOTOS_DIR });
            } catch (err) {
                logger.debug('post-index maintenance 任务失败（忽略）：', err && err.message ? err.message : err);
            } finally {
                postIndexMaintenanceScheduled = false;
            }
        }, {
            startDelayMs: startDelay,
            retryIntervalMs: retryInterval,
            timeoutMs,
            category: 'index-maintenance'
        });
    } catch (err) {
        postIndexMaintenanceScheduled = false;
        logger.debug('post-index maintenance 调度失败（忽略）：', err && err.message ? err.message : err);
    }
}
let currentWatcher = null;     // 当前的文件监听器实例

const WATCH_LOG_INTERVAL_MS = Number(process.env.WATCH_LOG_INTERVAL_MS || 2000);
const watchLogBuckets = {
    detected: new Map(),
    skipped: new Map()
};
let watchLogTimer = null;

function formatDirLabel(dirPath) {
    const rel = getSafeRelativePath(dirPath, PHOTOS_DIR);
    if (rel === null) return dirPath;
    if (!rel) return '/';
    return rel;
}

function accumulateWatchLog(kind, type, filePath) {
    try {
        const bucket = kind === 'skip' ? watchLogBuckets.skipped : watchLogBuckets.detected;
        const dirPath = (type === 'addDir' || type === 'unlinkDir') ? filePath : path.dirname(filePath);
        const key = formatDirLabel(dirPath);
        const counts = bucket.get(key) || { add: 0, unlink: 0, addDir: 0, unlinkDir: 0 };
        if (counts[type] !== undefined) {
            counts[type] += 1;
        } else {
            counts[type] = 1;
        }
        bucket.set(key, counts);
        if (!watchLogTimer) {
            watchLogTimer = setTimeout(flushWatchLogs, WATCH_LOG_INTERVAL_MS);
        }
    } catch (error) {
        logger.debug('[Watcher] 记录目录变更统计失败：' + (error && error.message));
    }
}

function flushWatchBucket(bucket, prefix) {
    for (const [dir, counts] of bucket.entries()) {
        const segments = [];
        if (counts.add) segments.push(`add:${counts.add}`);
        if (counts.unlink) segments.push(`unlink:${counts.unlink}`);
        if (counts.addDir) segments.push(`addDir:${counts.addDir}`);
        if (counts.unlinkDir) segments.push(`unlinkDir:${counts.unlinkDir}`);
        if (segments.length > 0) {
            logger.debug(`[Watcher] 目录 ${dir} ${prefix} ${segments.join(' ')}`);
        }
    }
    bucket.clear();
}

function flushWatchLogs() {
    watchLogTimer = null;
    flushWatchBucket(watchLogBuckets.detected, '检测到');
    flushWatchBucket(watchLogBuckets.skipped, '索引进行中跳过');
}

function resolveVideoTaskPaths(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
        return null;
    }

    const absoluteCandidate = path.isAbsolute(inputPath) ? inputPath : path.resolve(PHOTOS_ROOT, inputPath);
    const relativeRaw = path.relative(PHOTOS_ROOT, absoluteCandidate);
    const sanitizedRelative = sanitizePath(relativeRaw);
    if (!sanitizedRelative || !isPathSafe(sanitizedRelative)) {
        logger.warn(`[VideoQueue] 拒绝不安全的视频路径: ${relativeRaw}`);
        return null;
    }

    const resolvedAbsolute = path.resolve(PHOTOS_ROOT, sanitizedRelative);
    if (!resolvedAbsolute.startsWith(PHOTOS_ROOT)) {
        logger.warn(`[VideoQueue] 视频任务路径超出受信目录: ${resolvedAbsolute}`);
        return null;
    }

    return {
        relativePath: sanitizedRelative,
        absolutePath: resolvedAbsolute
    };
}

/**
 * 以分批、低优先级的方式，将视频处理任务加入队列
 * @param {Array<Object>} videos - 从数据库查询出的视频对象数组
 */
async function queueVideoTasksInBatches(videos) {
    if (!videos || videos.length === 0) {
        return;
    }

    logger.debug(`[Main-Thread] 发现 ${videos.length} 个视频待处理，开始以分批方式加入队列...`);

    // HLS处理已改为手动模式，跳过所有批量视频处理

}

/**
 * 设置工作线程监听器
 * 为索引工作线程、设置工作线程和视频工作线程添加消息处理
 */
function setupWorkerListeners() {
    // --- 将批处理逻辑完全封装在当前作用域内，避免引用错误 ---
    let completedVideoBatch = [];
    let videoCompletionTimer = null;

    function processCompletedVideoBatch() {
        if (completedVideoBatch.length === 0) return;

        logger.info(`[Main-Thread] 开始处理 ${completedVideoBatch.length} 个已完成视频的后续任务...`);
        
        for (const videoPath of completedVideoBatch) {
            enqueueIndexChange({ type: 'add', filePath: videoPath });
        }
        
        triggerDelayedIndexProcessing();

        completedVideoBatch = [];
        if (videoCompletionTimer) {
            clearTimeout(videoCompletionTimer);
            videoCompletionTimer = null;
        }
    }

    // --- 启动时检查已禁用（HLS处理改为手动模式）---

    // --- 监听器设置 ---
    const indexingWorker = getIndexingWorker();
    const videoWorker = getVideoWorker();
    videoWorker.on('message', (rawMessage) => {
        const processMessage = () => {
            try {
                const message = normalizeWorkerMessage(rawMessage);
                const payload = message.payload || {};

                if (message.kind === 'log') {
                    const level = (payload.level || 'debug').toLowerCase();
                    const text = payload.message || payload.text || '';
                    const fn = typeof logger[level] === 'function' ? level : 'debug';
                    logger[fn](`[视频线程] ${text}`);
                    return;
                }

                if (message.kind === 'error') {
                    if (payload.type === 'worker_shutdown') {
                        logger.info(`[VIDEO-WORKER] 线程关闭: ${payload.reason || 'unknown'}`);
                    } else {
                        const errorPath = payload.path || (payload.task && payload.task.relativePath) || 'unknown';
                        const errorMessage = (payload.error && payload.error.message) || payload.message || '未知错误';
                        logger.error(`视频处理失败: ${errorPath}, 原因: ${errorMessage}`);
                    }
                    return;
                }

                if (payload.success === true) {
                    const resolvedPath = payload.path || (payload.task && payload.task.relativePath);
                    if (resolvedPath) {
                        logger.debug(`视频处理完成或跳过: ${resolvedPath}`);
                        completedVideoBatch.push(resolvedPath);
                    }
                }

                if (videoCompletionTimer) {
                    clearTimeout(videoCompletionTimer);
                }

                if (completedVideoBatch.length >= 10) {
                    processCompletedVideoBatch();
                } else {
                    videoCompletionTimer = setTimeout(processCompletedVideoBatch, 5000);
                }
            } catch (err) {
                logger.debug('[Main-Thread] 视频消息处理失败（忽略）:', err && err.message ? err.message : err);
            }
        };

        try {
            const traceContext = TraceManager.fromWorkerMessage(rawMessage);
            if (traceContext) {
                TraceManager.run(traceContext, processMessage);
            } else {
                processMessage();
            }
        } catch (err) {
            logger.debug('[Main-Thread] 视频消息追踪恢复失败（忽略）:', err && err.message ? err.message : err);
        }
    });

    indexingWorker.on('message', async (rawMessage) => {
        const processMessage = async () => {
            try {
                const message = normalizeWorkerMessage(rawMessage);
                const payload = message.payload || {};

                if (message.kind === 'log') {
                    const level = (payload.level || 'debug').toLowerCase();
                    const text = payload.message || payload.text || '';
                    const fn = typeof logger[level] === 'function' ? level : 'debug';
                    logger[fn](`[IndexingWorker] ${text}`);
                    return;
                }

                const eventType = payload.type || (rawMessage && rawMessage.type) || message.kind;
                const eventTypeCnMap = {
                    rebuild_complete: '索引重建完成',
                    index_complete: '索引完成',
                    process_changes_complete: '变更处理完成',
                    backfill_dimensions_complete: '尺寸回填完成',
                    backfill_mtime_complete: 'mtime 回填完成'
                };
                const eventTypeDisplay = eventTypeCnMap[eventType] || eventType;
                logger.debug(`收到来自 Indexing Worker 的消息: ${eventTypeDisplay}`);

                if (message.kind === 'error') {
                    const errorMessage = (payload.error && payload.error.message) || payload.message || 'UNKNOWN_ERROR';
                    logger.error(`[Main-Thread] Indexing Worker 报告一个错误: ${errorMessage}`);
                    isIndexing = false;
                    return;
                }

                switch (eventType) {
                    case 'rebuild_complete': {
                        const processed = typeof payload.count === 'number' ? payload.count : 0;
                        logger.info(`[Main-Thread] Indexing Worker 完成索引重建，共处理 ${processed} 个条目。`);
                        isIndexing = false;

                        (async () => {
                            try {
                                const ItemsRepository = require('../repositories/items.repo');
                                const itemsRepo = new ItemsRepository();
                                const videos = await itemsRepo.getVideos();
                                if (videos && videos.length > 0) {
                                    await queueVideoTasksInBatches(videos);
                                }
                            } catch (e) {
                                logger.error('[Main-Thread] 启动分批视频处理任务时出错:', e);
                            }
                        })();
                        break;
                    }

                    case 'all_media_items_result':
                        // 完全禁用自动缩略图批量处理
                        break;

                    case 'process_changes_complete': {
                        logger.info('[Main-Thread] Indexing Worker 完成索引增量更新。');
                        isIndexing = false;

                        try {
                            const videoPaths = Array.isArray(payload.videoPaths) ? payload.videoPaths : [];
                            if (videoPaths.length > 0) {
                                const vw = getVideoWorker();
                                for (const absPath of videoPaths) {
                                    const safePaths = resolveVideoTaskPaths(absPath);
                                    if (!safePaths) {
                                        continue;
                                    }

                                    if (!/\.(mp4|webm|mov)$/i.test(safePaths.relativePath)) {
                                        continue;
                                    }

                                    try {
                                        const messageToWorker = TraceManager.injectToWorkerMessage({
                                            filePath: safePaths.absolutePath,
                                            relativePath: safePaths.relativePath,
                                            thumbsDir: THUMBS_DIR
                                        });
                                        vw.postMessage(messageToWorker);
                                    } catch (error) {
                                        logIndexerIgnore('通知视频线程缩略图任务', error);
                                    }
                                }
                            }
                        } catch (e) {
                            logger.debug('增量视频后处理触发失败（忽略）：', e && e.message);
                        }

                        if (payload && payload.needsMaintenance) {
                            schedulePostIndexMaintenance();
                        }

                        break;
                    }

                    case 'backfill_dimensions_complete': {
                        try {
                            const updated = typeof payload.updated === 'number' ? payload.updated : 0;
                            logger.info(`[Main-Thread] 媒体尺寸回填完成，更新 ${updated} 条记录。`);
                        } catch (e) {
                            logger.debug('[Main-Thread] 记录尺寸回填结果失败（忽略）');
                        }
                        break;
                    }

                    case 'backfill_mtime_complete':
                    case 'post_index_backfill_complete':
                        // 保持兼容：记录完成即可
                        logger.info(`[Main-Thread] 收到 ${eventType} 通知。`);
                        break;

                    default:
                        logger.warn(`[Main-Thread] 收到来自Indexing Worker的未知消息类型: ${eventType}`);
                }
            } catch (error) {
                logger.debug('[Main-Thread] Indexing Worker 消息处理失败（忽略）:', error && error.message ? error.message : error);
            }
        };

        try {
            const traceContext = TraceManager.fromWorkerMessage(rawMessage);
            if (traceContext) {
                await TraceManager.run(traceContext, processMessage);
            } else {
                await processMessage();
            }
        } catch (error) {
            logger.debug('[Main-Thread] Indexing Worker 追踪恢复失败（忽略）:', error && error.message ? error.message : error);
        }
    });

    // 设置工作线程消息处理
    const { getSettingsWorker } = require('./worker.manager');
    const settingsWorker = getSettingsWorker();
    settingsWorker.on('message', (rawMessage) => {
        const processMessage = () => {
            try {
                const message = normalizeWorkerMessage(rawMessage);
                const payload = message.payload || {};

                if (message.kind === 'log') {
                    const level = (payload.level || 'debug').toLowerCase();
                    const text = payload.message || payload.text || '';
                    const fn = typeof logger[level] === 'function' ? level : 'debug';
                    logger[fn](`[SettingsWorker] ${text}`);
                    return;
                }

                const eventType = payload.type || (rawMessage && rawMessage.type) || message.kind;
                logger.debug(`收到来自 Settings Worker 的消息: ${eventType}`);

                if (message.kind === 'error') {
                    const errorMessage = (payload.error && payload.error.message) || payload.message || '未知错误';
                    logger.error(`[Main-Thread] 设置更新失败: ${errorMessage}`);
                    try {
                        const { updateSettingsStatus } = require('../controllers/settings.controller');
                        updateSettingsStatus('failed', errorMessage, payload && payload.updateId);
                    } catch (e) {
                        logger.debug('无法更新设置状态（控制器可能未加载）');
                    }
                    return;
                }

                if (eventType === 'settings_update_complete') {
                    const updatedKeys = Array.isArray(payload.updatedKeys) ? payload.updatedKeys : [];
                    logger.info(`[Main-Thread] 设置更新成功: ${updatedKeys.join(', ')}`);
                    settingsService.clearCache();
                    try {
                        const { updateSettingsStatus } = require('../controllers/settings.controller');
                        updateSettingsStatus('success', '设置更新成功', payload && payload.updateId);
                    } catch (e) {
                        logger.debug('无法更新设置状态（控制器可能未加载）');
                    }
                } else {
                    logger.warn(`[Main-Thread] 收到来自Settings Worker的未知消息类型: ${eventType}`);
                }
            } catch (error) {
                logger.debug('[Main-Thread] Settings Worker 消息处理失败（忽略）:', error && error.message ? error.message : error);
            }
        };

        try {
            const traceContext = TraceManager.fromWorkerMessage(rawMessage);
            if (traceContext) {
                TraceManager.run(traceContext, processMessage);
            } else {
                processMessage();
            }
        } catch (error) {
            logger.debug('[Main-Thread] Settings Worker 追踪恢复失败（忽略）:', error && error.message ? error.message : error);
        }
    });

    // 索引工作线程错误和退出处理
    indexingWorker.on('error', (err) => {
        logger.error(`[Main-Thread] Indexing Worker 遇到致命错误，索引功能可能中断: ${err.message}`, err);
        isIndexing = false;
    });

    indexingWorker.on('exit', (code) => {
        if (code !== 0) {
            logger.warn(`[Main-Thread] Indexing Worker 意外退出，退出码: ${code}。索引功能将停止。`);
        }
        isIndexing = false;
    });
}

/**
 * 计算文件内容哈希值（SHA256）
 * 用于检测文件是否真正发生变化
 * @param {string} filePath - 文件路径
 * @returns {Promise<string|null>} 文件哈希值或null
 */
async function computeFileHash(filePath) {
    try {
        const stats = await nativeFs.promises.stat(filePath);
        const fileSize = stats.size || 0;

        if (fileSize === 0) {
            return null;
        }

        const shouldSample = fileSize >= LARGE_FILE_HASH_THRESHOLD_BYTES;
        const hash = crypto.createHash('sha256');

        if (!shouldSample) {
            return await new Promise((resolve) => {
                const stream = nativeFs.createReadStream(filePath);
                stream.on('data', (chunk) => hash.update(chunk));
                stream.on('end', () => resolve(hash.digest('hex')));
                stream.on('error', (err) => {
                    logger.debug(`流式计算文件 hash 失败: ${filePath}`, err);
                    resolve(null);
                });
            });
        }

        const headLength = Math.min(HASH_SAMPLE_BYTES, fileSize);
        const tailLength = Math.min(HASH_SAMPLE_BYTES, Math.max(fileSize - headLength, 0));
        const tailStart = Math.max(fileSize - tailLength, 0);

        return await new Promise((resolve) => {
            let completed = 0;
            let resolved = false;

            const finalize = () => {
                if (resolved) return;
                resolved = true;
                hash.update(Buffer.from(String(fileSize)));
                resolve(hash.digest('hex'));
            };

            const fail = (err) => {
                if (resolved) return;
                resolved = true;
                logger.debug(`采样哈希失败: ${filePath}`, err);
                resolve(null);
            };

            const headStream = nativeFs.createReadStream(filePath, { start: 0, end: headLength - 1 });
            headStream.on('data', (chunk) => hash.update(chunk));
            headStream.on('error', fail);
            headStream.on('end', () => {
                completed += 1;
                if (completed === 2) finalize();
            });

            const tailStream = nativeFs.createReadStream(filePath, { start: tailStart, end: fileSize - 1 });
            tailStream.on('data', (chunk) => hash.update(chunk));
            tailStream.on('error', fail);
            tailStream.on('end', () => {
                completed += 1;
                if (completed === 2) finalize();
            });
        });
    } catch (err) {
        logger.warn(`计算文件哈希失败: ${filePath}`, err && err.message ? err.message : err);
        return null;
    }
}

/**
 * 合并索引变更事件
 * 将连续的变更事件合并，避免重复处理
 * @param {Array} changes - 原始变更事件数组
 * @returns {Array} 合并后的变更事件数组
 */
    function consolidateIndexChanges(changes) {
    logger.debug(`开始合并 ${changes.length} 个原始变更事件`);
    const changeMap = new Map();
    
    for (const change of changes) {
        const { type, filePath, hash } = change;
        const existingChange = changeMap.get(filePath);
        
        if (existingChange) {
            // --- 合并规则 ---
            // 1) add -> unlink（抖动）：直接抵消（无变化）。不依赖 hash。
            if ((existingChange.type === 'add' && type === 'unlink') || (existingChange.type === 'addDir' && type === 'unlinkDir')) {
                changeMap.delete(filePath);
                continue;
            }

            // 2) unlink 之后出现 add：视为真正的更新（文件被替换/重建）。
            if ((existingChange.type === 'unlink' && type === 'add') || (existingChange.type === 'unlinkDir' && type === 'addDir')) {
                changeMap.set(filePath, { ...change, type: 'update' });
                continue;
            }

            // 3) 连续 add 且 hash 相同：保留一次
            if (existingChange.type === 'add' && type === 'add' && existingChange.hash && existingChange.hash === hash) {
                changeMap.set(filePath, change);
                continue;
            }

            // 4) 其它同路径变化：统一视为 update（例如 add -> add(hash 变) / update -> unlink 之外情况）
            changeMap.set(filePath, { ...change, type: 'update' });
        } else {
            changeMap.set(filePath, change);
        }
    }
    
    const consolidated = Array.from(changeMap.values());
    logger.debug(`合并后剩余 ${consolidated.length} 个有效变更事件`);
    return consolidated;
}

/**
 * 一次性索引任务会话：创建临时 Indexing Worker，完成/失败即退出
 * @param {string} type - 任务类型（rebuild_index | process_changes | backfill_missing_dimensions | backfill_missing_mtime）
 * @param {object} payload - 任务载荷
 * @returns {Promise<object>} - 完成消息
 */
async function runIndexingTask(type, payload) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const worker = createDisposableWorker('indexing');
        const cleanup = () => {
            try {
                worker.removeAllListeners();
            } catch (error) {
                logIndexerIgnore('清理临时索引线程监听', error);
            }
            try {
                worker.terminate();
            } catch (error) {
                logIndexerIgnore('终止临时索引线程', error);
            }
        };
        worker.on('message', (rawMessage) => {
            const processMessage = () => {
                try {
                    const message = normalizeWorkerMessage(rawMessage);
                    const payload = message.payload || {};

                    if (message.kind === 'log') {
                        const level = (payload.level || 'debug').toLowerCase();
                        const text = payload.message || payload.text || '';
                        const fn = typeof logger[level] === 'function' ? level : 'debug';
                        logger[fn](`[IndexingWorker/once] ${text}`);
                        return;
                    }

                    const eventType = payload.type || (rawMessage && rawMessage.type) || message.kind;
                    const eventTypeCnMap = {
                        rebuild_complete: '索引重建完成',
                        index_complete: '索引完成',
                        process_changes_complete: '变更处理完成',
                        backfill_dimensions_complete: '尺寸回填完成',
                        backfill_mtime_complete: 'mtime 回填完成'
                    };
                    const eventTypeDisplay = eventTypeCnMap[eventType] || eventType;
                    logger.debug(`收到来自 Indexing Worker 的消息: ${eventTypeDisplay}`);

                    if (message.kind === 'error') {
                        const errMsg = (payload.error && payload.error.message) || payload.message || 'Indexing worker error';
                        if (!settled) { settled = true; cleanup(); reject(new Error(errMsg)); }
                        return;
                    }

                    const doneTypes = new Set([
                        'rebuild_complete',
                        'process_changes_complete',
                        'backfill_dimensions_complete',
                        'backfill_mtime_complete',
                        'post_index_backfill_complete'
                    ]);

                    if (doneTypes.has(eventType)) {
                        if (!settled) {
                            settled = true;
                            cleanup();
                            resolve({ ...payload, type: eventType });
                        }
                    }
                } catch (e) {
                    if (!settled) { settled = true; cleanup(); reject(e); }
                }
            };

            try {
                const traceContext = TraceManager.fromWorkerMessage(rawMessage);
                if (traceContext) {
                    TraceManager.run(traceContext, processMessage);
                } else {
                    processMessage();
                }
            } catch (error) {
                logIndexerIgnore('恢复一次性索引任务追踪上下文', error);
                processMessage();
            }
        });
        worker.on('error', (err) => {
            if (!settled) { settled = true; cleanup(); reject(err); }
        });
        worker.on('exit', (code) => {
            if (!settled) {
                settled = true; cleanup();
                if (code === 0) resolve({ type: 'exit_ok' });
                else reject(new Error(`Indexing worker exit ${code}`));
            }
        });
        try {
            const message = TraceManager.injectToWorkerMessage({ type, payload });
            worker.postMessage(message);
        } catch (e) {
            settled = true; cleanup(); reject(e);
        }
    });
}

/**
 * 构建搜索索引
 * 执行全量索引重建
 */
async function buildSearchIndex() {
    if (isIndexing) {
        logger.warn('索引任务已在进行中，本次全量重建请求被跳过。');
        return;
    }

    // 暂停文件监听器，避免索引过程中的误报
    if (currentWatcher) {
        logger.debug('[Watcher] 索引开始，暂停文件监听器');
        await currentWatcher.close();
        currentWatcher = null;
    }

    isIndexing = true;
    logger.info('向 Indexing Worker 发送索引重建任务(一次性会话)...');
    try {
        await runIndexingTask('rebuild_index', { photosDir: PHOTOS_DIR });
    } finally {
        isIndexing = false;

        // 重新启动文件监听器
        logger.debug('[Watcher] 索引完成，重新启动文件监听器');
        setTimeout(() => {
            if (!isIndexing) { // 确保没有其他索引任务
                watchPhotosDir();
            }
        }, 5000); // 延迟5秒启动，避免立即触发
    }
}

/**
 * 处理待处理的索引变更
 * 执行增量索引更新
 */
async function processPendingIndexChanges() {
    if (isIndexing) {
        logger.warn('索引任务已在进行中，本次增量更新请求被跳过。');
        return;
    }
    if (pendingIndexChanges.size === 0) return;

    const changesToProcess = consolidateAndExtractChanges();

    if (changesToProcess.length === 0) {
        logger.info('所有文件变更相互抵消，无需更新索引。');
        return;
    }

    if (changesToProcess.length > 5000) {
        logger.warn(`检测到超过 5000 个文件变更，将执行全量索引重建以保证数据一致性。`);
        await buildSearchIndex();
        return;
    }

    // 执行增量索引更新（一次性会话）
    isIndexing = true;
    logger.info(`向 Indexing Worker 发送 ${changesToProcess.length} 个索引变更以进行处理(一次性会话)...`);
    try {
        await runIndexingTask('process_changes', { changes: changesToProcess, photosDir: PHOTOS_DIR });
    } finally {
        isIndexing = false;
    }
}

async function processManualChanges(changes = []) {
    if (!Array.isArray(changes) || changes.length === 0) {
        return { processed: 0 };
    }

    const consolidated = await consolidateIndexChanges(changes);
    if (consolidated.length === 0) {
        return { processed: 0 };
    }

    if (isIndexing) {
        const start = Date.now();
        while (isIndexing && Date.now() - start < 60000) {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (isIndexing) {
            throw new Error('索引任务正在进行中，请稍后重试');
        }
    }

    isIndexing = true;
    try {
        logger.info(`[ManualIndex] 准备处理 ${consolidated.length} 个手动索引变更`);
        await runIndexingTask('process_changes', { changes: consolidated, photosDir: PHOTOS_DIR });
        schedulePostIndexMaintenance();
        return { processed: consolidated.length };
    } finally {
        isIndexing = false;
    }
}

function normalizeQueuedChange(change) {
    if (!change || typeof change !== 'object') {
        return null;
    }

    const type = typeof change.type === 'string' ? change.type : '';
    let filePath = typeof change.filePath === 'string' ? change.filePath : '';
    if (!type || !filePath) {
        return null;
    }

    filePath = filePath.trim();
    if (!filePath) {
        return null;
    }

    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(PHOTOS_DIR, filePath.replace(/^[\\/]+/, ''));

    return { type, filePath: absolutePath, ...(change.hash ? { hash: change.hash } : {}) };
}

async function enqueueManualChanges(changes = [], options = {}) {
    if (!Array.isArray(changes) || changes.length === 0) {
        return { queued: 0 };
    }

    const normalized = [];
    for (const change of changes) {
        const normalizedChange = normalizeQueuedChange(change);
        if (!normalizedChange) {
            continue;
        }
        normalized.push(normalizedChange);
        enqueueIndexChange(normalizedChange);
    }

    if (normalized.length === 0) {
        return { queued: 0 };
    }

    const reason = options && options.reason ? String(options.reason) : '';
    const delayCandidate = options && Number.isFinite(options.delayMs) ? options.delayMs : undefined;
    const delayMs = (delayCandidate !== undefined && delayCandidate >= 0)
        ? delayCandidate
        : MANUAL_ENQUEUE_DEFAULT_DELAY_MS;

    logger.info(`[ManualIndex] 已排队 ${normalized.length} 个手动变更${reason ? ` (${reason})` : ''}`);

    // 使用 Promise.resolve 包裹，确保不会阻塞调用方
    Promise.resolve().then(() => {
        try {
            triggerDelayedIndexProcessing(delayMs);
        } catch (err) {
            logger.warn('触发手动索引处理调度失败（忽略）:', err && err.message ? err.message : err);
        }
    });

    return { queued: normalized.length };
}

/**
 * 触发延迟索引处理
 * 在文件系统稳定后清理相关缓存并处理索引变更
 * 使用5秒延迟确保文件系统操作完成
 */
function triggerDelayedIndexProcessing(customDelayMs) {
    clearTimeout(rebuildTimeout);
    // 自适应聚合延迟：根据近期变更密度放大延迟，降低抖动
    const hasCustomDelay = Number.isFinite(customDelayMs) && customDelayMs >= 0;
    const dynamicDelay = hasCustomDelay ? customDelayMs : (() => {
        const changes = getPendingChangeCount();
        if (changes > 10000) return Math.max(INDEX_STABILIZE_DELAY_MS, 30000);
        if (changes > 5000) return Math.max(INDEX_STABILIZE_DELAY_MS, 20000);
        if (changes > 1000) return Math.max(INDEX_STABILIZE_DELAY_MS, 10000);
        return INDEX_STABILIZE_DELAY_MS;
    })();

    rebuildTimeout = setTimeout(async () => {
        logger.info('文件系统稳定，开始按标签精细化失效缓存并处理索引变更...');
        try {
            // 基于当前待处理的变更，推导受影响的相册层级标签
            const pendingSnapshot = flattenPendingChanges();
            const albumTags = new Set();
            for (const change of pendingSnapshot) {
                const rawPath = change && change.filePath ? String(change.filePath) : '';
                if (!rawPath) continue;
                // 仅处理位于 PHOTOS_DIR 下的路径
                if (!rawPath.startsWith(PHOTOS_DIR)) continue;
                // 修正正则表达式，确保替换所有反斜杠为正斜杠
                const rel = rawPath.substring(PHOTOS_DIR.length).replace(/\\/g, '/').replace(/^\/+/, '');
                if (!rel) {
                    albumTags.add('album:/');
                    continue;
                }
                // 目录标签链：album:/、album:/A、album:/A/B ...
                const isDirEvent = change.type === 'addDir' || change.type === 'unlinkDir';
                const relDir = isDirEvent ? rel : rel.split('/').slice(0, -1).join('/');
                const segments = relDir.split('/').filter(Boolean);
                let current = '';
                albumTags.add('album:/');
                for (const seg of segments) {
                    current = `${current}/${seg}`;
                    albumTags.add(`album:${current}`);
                }
            }

            if (albumTags.size > 0) {
                const tagsArr = Array.from(albumTags);
                const dynamicTagLimit = (() => {
                    const changes = getPendingChangeCount();
                    if (changes > 10000) return Math.max(2000, 6000);
                    if (changes > 5000) return Math.max(2000, 4000);
                    if (changes > 1000) return Math.max(2000, 3000);
                    return 2000;
                })();

                if (tagsArr.length > dynamicTagLimit) {
                    // 标签数过大，自动降级：粗粒度清理 browse 路由缓存
                    try {
                        let cursor = '0';
                        let cleared = 0;
                        do {
                            const res = await redis.scan(cursor, 'MATCH', 'route:browse:*', 'COUNT', 1000);
                            cursor = res[0];
                            const keys = res[1] || [];
                            if (keys.length > 0) {
                                const deleted = await safeRedisDel(redis, keys, '清理browse路由缓存');
                                cleared += (deleted || keys.length);
                            }
                        } while (cursor !== '0');
                        logger.info(`[Index] 标签数量 ${tagsArr.length} 超过上限 ${dynamicTagLimit}，已降级清理 browse 路由缓存，共 ${cleared} 个键。`);
                    } catch (e) {
                        logger.warn(`[Index] 降级清理 browse 路由缓存失败: ${e && e.message}`);
                    }
                } else {
                    await invalidateTags(tagsArr);
                    logger.info(`[Index] 已按标签失效路由缓存：${tagsArr.length} 个相册层级标签。`);
                }
            }
        } catch (err) {
            logger.warn('按标签精细化失效缓存时出错（将继续处理索引变更）:', err && err.message ? err.message : err);
        }

        try {
            await processPendingIndexChanges();
        } catch (err) {
            logger.error('处理索引变更失败:', err);
        }
    }, dynamicDelay); // 自适应延迟，等待文件系统稳定
}


/**
 * 监控照片目录
 * 使用chokidar库监控文件系统变化，处理文件添加、删除、目录创建等事件
 */
function watchPhotosDir() {
    const { DISABLE_WATCH } = require('../config');
    if (DISABLE_WATCH) {
        logger.warn('[Watcher] 已禁用实时文件监听(DISABLE_WATCH=true)。将依赖维护任务/手动触发增量。');
        return;
    }

    // 如果正在索引中，延迟启动文件监听
    if (isIndexing) {
        logger.debug('[Watcher] 检测到索引进行中，延迟启动文件监听');
        setTimeout(() => {
            if (!isIndexing) { // 再次检查索引是否已完成
                watchPhotosDir();
            }
        }, 30000); // 30秒后重试
        return;
    }
    const configuredDepth = Number(process.env.WATCH_DEPTH);
    const normalizedDepth = Number.isFinite(configuredDepth) && configuredDepth >= 0 ? configuredDepth : 99;
    const watcherOptions = {
        ignoreInitial: true,
        persistent: true,
        depth: normalizedDepth,
        ...fileFilter.getChokidarConfig(),
    };

    // 配置chokidar文件监控器
    const watcher = currentWatcher = chokidar.watch(PHOTOS_DIR, watcherOptions);
    
    // 标记监听器正在运行
    const state = require('./state.manager');
    state.watcher.setRunning(true);

    if (watcherOptions.usePolling) {
        const pollInterval = watcherOptions.interval ?? Number(process.env.WATCH_POLL_INTERVAL || 1000);
        const pollBinaryInterval = watcherOptions.binaryInterval ?? Number(process.env.WATCH_POLL_BINARY_INTERVAL || 1500);
        logger.warn('[Watcher] 已启用轮询模式(usePolling)。interval=%dms binaryInterval=%dms', pollInterval, pollBinaryInterval);
    }

    /**
     * 文件变更事件处理函数
     * 处理文件添加、删除、目录创建等事件
     * @param {string} type - 事件类型（add, unlink, addDir, unlinkDir）
     * @param {string} filePath - 文件路径
     */
    const onFileChange = async (type, filePath) => {
        // 在索引进行中时，跳过文件变动处理，避免误报
        if (isIndexing) {
            accumulateWatchLog('skip', type, filePath);
            return;
        }

        if (!fileFilter.shouldProcessFileChange(type, filePath)) {
            accumulateWatchLog('skip', type, filePath);
            return;
        }

        // 智能失效封面缓存
        try {
            await invalidateCoverCache(filePath);
        } catch (error) {
            logger.warn(`智能失效封面缓存失败: ${filePath}`, error);
        }

        // HLS处理已改为手动模式，不再自动处理新视频文件
        if (type === 'add' && /\.(mp4|webm|mov)$/i.test(filePath)) {

            return;
        }

        // 处理文件删除事件，清理对应的缩略图
        if (type === 'unlink') {
            const relativePath = getSafeRelativePath(filePath, PHOTOS_DIR);
            if (relativePath === null) {
                logger.warn(`检测到可疑文件删除路径，跳过处理: ${filePath}`);
                return;
            }
            const isVideo = /\.(mp4|webm|mov)$/i.test(relativePath);
            const extension = isVideo ? '.jpg' : '.webp';
            const thumbRelPath = relativePath.replace(/\.[^.]+$/, extension);
            const thumbPath = path.join(THUMBS_DIR, thumbRelPath);

            // 删除孤立的缩略图文件
            try {
                await fs.unlink(thumbPath);
                logger.debug(`成功删除孤立的缩略图: ${thumbPath}`);
            } catch (err) {
                if (err.code !== 'ENOENT') { // 忽略"文件不存在"的错误
                    logger.error(`删除缩略图失败: ${thumbPath}`, err);
                }
            }
        }

        // 处理目录删除事件（或重命名导致的旧目录消失）：递归清理对应缩略图子树
        if (type === 'unlinkDir') {
            try {
                const relDir = getSafeRelativePath(filePath, PHOTOS_DIR);
                if (relDir === null) {
                    logger.warn(`检测到可疑目录删除路径，跳过处理: ${filePath}`);
                    return;
                }
                
                if (relDir && !relDir.startsWith('..')) {
                    const thumbsSubtree = path.join(THUMBS_DIR, relDir);
                    await fs.rm(thumbsSubtree, { recursive: true, force: true }).catch(() => {});
                    logger.debug(`[Watcher] 目录移除，已递归清理缩略图子树: ${thumbsSubtree}`);
                    
                    // 数据库同步清理该子树的 thumb_status 与 album_covers 记录
                    // 使用Repository层进行事务保护的删除操作
                    try {
                        const ThumbStatusRepository = require('../repositories/thumbStatus.repo');
                        const AlbumCoversRepository = require('../repositories/albumCovers.repo');
                        
                        const thumbStatusRepo = new ThumbStatusRepository();
                        const albumCoversRepo = new AlbumCoversRepository();

                        await withTransaction('main', async () => {
                            await thumbStatusRepo.deleteByDirectory(relDir);
                            await albumCoversRepo.deleteByDirectory(relDir);
                        });
                        logger.debug(`[Watcher] 已清理目录 ${relDir} 的相关数据库记录`);
                    } catch (e) {
                        // 数据库清理失败不阻止流程，但记录警告
                        logger.warn(`[Watcher] 清理目录 ${relDir} 的数据库记录失败:`, e.message);
                    }
                }
            } catch (e) {
                logger.warn('[Watcher] 清理目录缩略图子树失败（忽略）：', e && e.message);
            }
        }
        
        // 只对添加事件计算文件哈希值，用于检测重复事件
        let hash = undefined;
        if (type === 'add') {
            hash = await computeFileHash(filePath);
        }
        
        // 仅跟踪媒体文件或目录；非媒体文件（含 .db/.wal/.shm）直接忽略
        if (type === 'add') {
            const isMedia = /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(filePath);
            const isDbLike = /\.(db|db3|sqlite|sqlite3|wal|shm)$/i.test(filePath) || /history\.db(-wal|-shm)?$/i.test(filePath);
            if (!isMedia || isDbLike) {
                return;
            }
        }

        accumulateWatchLog('detect', type, filePath);

        // 避免重复添加相同的变更事件
        enqueueIndexChange({ type, filePath, ...(type === 'add' && hash ? { hash } : {}) });
        
        // 触发延迟索引处理
        triggerDelayedIndexProcessing();
    };

    // 空闲自停：无事件且无待处理且未索引中超过 WATCHER_IDLE_STOP_MS 则自动停止
    let lastEventTs = Date.now();
    const WATCHER_IDLE_STOP_MS = Number(process.env.WATCHER_IDLE_STOP_MS || 120000);
    const idleTimer = setInterval(() => {
        try {
            const noEventsFor = Date.now() - lastEventTs;
        const pendingLen = pendingIndexChanges.size;
        if (noEventsFor > WATCHER_IDLE_STOP_MS && pendingLen === 0 && !isIndexing) {
                const state = require('./state.manager');
                watcher.close().then(() => {
                    logger.info('[监听器] 空闲超时，已自动停止文件监听。');
                    state.watcher.setRunning(false); // 标记监听器已停止
                    clearInterval(idleTimer);
                }).catch(() => {
                    state.watcher.setRunning(false); // 标记监听器已停止
                    clearInterval(idleTimer);
                });
            }
        } catch (error) {
            logIndexerIgnore('获取视频线程状态', error);
            clearInterval(idleTimer);
        }
    }, 5000);

    logger.info(`开始监控照片目录: ${PHOTOS_DIR}`);
    
    // 绑定文件系统事件监听器
    watcher
        .on('add', p => { lastEventTs = Date.now(); onFileChange('add', p); })           // 文件添加事件
        .on('unlink', p => { lastEventTs = Date.now(); onFileChange('unlink', p); })     // 文件删除事件
        .on('addDir', p => { lastEventTs = Date.now(); onFileChange('addDir', p); })     // 目录添加事件
        .on('unlinkDir', p => { lastEventTs = Date.now(); onFileChange('unlinkDir', p); }) // 目录删除事件
        .on('error', error => logger.error('目录监控出错:', error)); // 错误处理
}


/**
 * 检查并重启文件监听器（如果已停止）
 * 用于中间件或定时任务调用，确保监听器按需运行
 */
function ensureWatcherRunning() {
    const { DISABLE_WATCH } = require('../config');
    if (DISABLE_WATCH) {
        return; // 如果禁用了监听，不做任何操作
    }

    const state = require('./state.manager');
    
    // 检查监听器是否正在运行
    if (!state.watcher.isRunning() && !isIndexing) {
        logger.info('[监听器] 检测到监听器未运行，自动重启...');
        watchPhotosDir();
    }
}

// 导出索引服务函数
module.exports = {
    setupWorkerListeners,    // 设置工作线程监听器
    buildSearchIndex,        // 构建搜索索引
    watchPhotosDir,          // 监控照片目录
    ensureWatcherRunning,    // 确保监听器运行
    processManualChanges,    // 手动变更处理（同步）
    enqueueManualChanges,    // 手动变更排队（异步）
};

/**
 * 安全的路径验证函数
 * @param {string} filePath - 要验证的文件路径
 * @param {string} baseDir - 基础目录
 * @returns {boolean} - 路径是否安全
 */
function validatePath(filePath, baseDir) {
    if (!filePath || typeof filePath !== 'string') {
        return false;
    }
    
    try {
        const normalizedPath = require('path').resolve(filePath);
        const normalizedBaseDir = require('path').resolve(baseDir);
        return normalizedPath.startsWith(normalizedBaseDir);
    } catch (error) {
        logger.warn(`路径验证失败: ${filePath}`, error.message);
        return false;
    }
}

/**
 * 安全的相对路径提取函数
 * @param {string} filePath - 完整文件路径
 * @param {string} baseDir - 基础目录
 * @returns {string|null} - 相对路径或null
 */
function getSafeRelativePath(filePath, baseDir) {
    if (!validatePath(filePath, baseDir)) {
        logger.warn(`检测到可疑路径: ${filePath}`);
        return null;
    }
    
    try {
        const relativePath = require('path').relative(baseDir, filePath);
        return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    } catch (error) {
        logger.warn(`相对路径提取失败: ${filePath}`, error.message);
        return null;
    }
}

/**
 * 错误恢复处理函数
 * @param {Error} error - 错误对象
 * @param {string} context - 错误上下文
 * @param {number} maxRetries - 最大重试次数
 */
async function handleErrorRecovery(error, context = '', maxRetries = 3) {
    try {
        const errorKey = `error_retry:${context}`;
        const retryCount = await safeRedisIncr(redis, errorKey, '错误重试计数') || 0;
        
        if (retryCount <= maxRetries) {
            logger.warn(`${context} 操作失败 (第${retryCount}次重试): ${error.message}`);
            // 指数退避重试
            const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 30000);
            await new Promise(resolve => setTimeout(resolve, delay));
            return true; // 允许重试
        } else {
            logger.error(`${context} 操作最终失败，已达到最大重试次数: ${error.message}`);
            // 清理错误标记，如果失败则记录但不影响主要流程
            await safeRedisDel(redis, errorKey, '清理错误标记');
            return false; // 不再重试
        }
    } catch (e) {
        logger.error(`错误恢复处理失败: ${e.message}`);
        return false;
    }
}