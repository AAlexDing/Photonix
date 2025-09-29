/**
 * 索引服务模块 - 按需生成版本
 * 管理文件系统监控、索引重建、增量更新，禁用自动缩略图生成
 */
const chokidar = require('chokidar');
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { redis, bullConnection } = require('../config/redis');
const { Queue } = require('bullmq');
const { invalidateTags } = require('./cache.service');
const { PHOTOS_DIR, THUMBS_DIR, INDEX_STABILIZE_DELAY_MS } = require('../config');
const { dbRun, runPreparedBatch, dbAll } = require('../db/multi-db');
const { getIndexingWorker, getVideoWorker, ensureCoreWorkers } = require('./worker.manager');
const { shouldDisableHlsBackfill } = require('./adaptive.service');
const settingsService = require('./settings.service');
const { invalidateCoverCache } = require('./file.service');
const crypto = require('crypto');

// 依赖文件服务的封面批处理能力
const { findCoverPhotosBatchDb } = require('./file.service');

// 索引服务状态管理
let rebuildTimeout;           // 重建超时定时器
let isIndexing = false;       // 索引进行中标志
let pendingIndexChanges = []; // 待处理的索引变更队列

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
            if (!pendingIndexChanges.some(c => c.filePath === videoPath)) {
                pendingIndexChanges.push({ type: 'add', filePath: videoPath });
            }
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
    videoWorker.on('message', (result) => {
        if (result.success) {
            logger.info(`视频处理完成或跳过: ${result.path}`);
            completedVideoBatch.push(result.path);

            if (videoCompletionTimer) {
                clearTimeout(videoCompletionTimer);
            }

            if (completedVideoBatch.length >= 10) {
                processCompletedVideoBatch();
            } else {
                videoCompletionTimer = setTimeout(processCompletedVideoBatch, 5000);
            }
        } else {
            logger.error(`视频处理失败: ${result.path}, 原因: ${result.error}`);
        }
    });

    indexingWorker.on('message', async (msg) => {
        logger.debug(`收到来自 Indexing Worker 的消息: ${msg.type}`);
        switch (msg.type) {
            case 'rebuild_complete':
                logger.info(`[Main-Thread] Indexing Worker 完成索引重建，共处理 ${msg.count} 个条目。`);
                isIndexing = false;

                // 禁用自动缩略图生成

                (async () => {
                    try {
                        const videos = await dbAll('main', `SELECT path FROM items WHERE type='video'`);
                        if (videos && videos.length > 0) {
                            await queueVideoTasksInBatches(videos);
                        }
                    } catch (e) {
                        logger.error('[Main-Thread] 启动分批视频处理任务时出错:', e);
                    }
                })();
                
                break;

            case 'all_media_items_result':
                // 完全禁用自动缩略图批量处理
                let items = msg.payload || [];

                break;

            case 'process_changes_complete':
                // 增量更新完成
                logger.info('[Main-Thread] Indexing Worker 完成索引增量更新。');
                isIndexing = false;
                // 增量完成后，不启动缩略图检查


                // 对本批次变更中的视频，触发一次 faststart 检查/优化
                try {
                    const changes = Array.isArray(pendingIndexChanges) ? [...pendingIndexChanges] : [];
                    const vw = getVideoWorker();
                    for (const ch of changes) {
                        if (ch && ch.filePath && /\.(mp4|webm|mov)$/i.test(ch.filePath)) {
                            try { 
                                const relativePath = path.relative(PHOTOS_DIR, ch.filePath);
                                vw.postMessage({ 
                                    filePath: ch.filePath,
                                    relativePath: relativePath,
                                    thumbsDir: THUMBS_DIR
                                }); 
                            } catch {} // 忽略 postMessage 失败
                        }
                    }
                } catch (e) {
                    logger.debug('增量视频处理触发失败（忽略）：', e && e.message);
                }

                // 新增：主动重算受影响相册的封面，写入 album_covers 表
                try {
                    await recomputeAndPersistAlbumCovers();
                } catch (e) {
                    logger.warn('主动重算相册封面失败（忽略）:', e && e.message);
                }

                // 新增：后台回填缺失的媒体尺寸，减少运行时探测
                try {
                    logger.info('[Main-Thread] 触发一次媒体尺寸回填后台任务...');
                    const worker = getIndexingWorker();
                    worker.postMessage({ type: 'backfill_missing_dimensions', payload: { photosDir: PHOTOS_DIR } });
                } catch (e) {
                    logger.warn('触发媒体尺寸回填失败（忽略）:', e && e.message);
                }

                // 新增：后台回填缺失的 mtime，避免运行时频繁 fs.stat
                try {
                    logger.info('[Main-Thread] 触发一次 mtime 回填后台任务...');
                    const worker = getIndexingWorker();
                    worker.postMessage({ type: 'backfill_missing_mtime', payload: { photosDir: PHOTOS_DIR } });
                } catch (e) {
                    logger.warn('触发 mtime 回填失败（忽略）:', e && e.message);
                }
                break;
                
            case 'backfill_dimensions_complete':
                // 尺寸回填完成事件：记录更新条数
                try {
                    const updated = typeof msg.updated === 'number' ? msg.updated : 0;
                    logger.info(`[Main-Thread] 媒体尺寸回填完成，更新 ${updated} 条记录。`);
                } catch (e) {
                    logger.debug('[Main-Thread] 记录尺寸回填结果失败（忽略）');
                }
                break;

            case 'error':
                // 索引工作线程报告错误
                logger.error(`[Main-Thread] Indexing Worker 报告一个错误: ${msg.error}`);
                isIndexing = false;
                break;
            default:
                logger.warn(`[Main-Thread] 收到来自Indexing Worker的未知消息类型: ${msg.type}`);
        }
    });

    // 设置工作线程消息处理
    const { getSettingsWorker } = require('./worker.manager');
    const settingsWorker = getSettingsWorker();
    settingsWorker.on('message', (msg) => {
        logger.debug(`收到来自 Settings Worker 的消息: ${msg.type}`);
        switch (msg.type) {
            case 'settings_update_complete':
                // 设置更新成功
                logger.info(`[Main-Thread] 设置更新成功: ${msg.updatedKeys.join(', ')}`);
                settingsService.clearCache();
                // 更新设置状态（如果控制器可用）
                try {
                    const { updateSettingsStatus } = require('../controllers/settings.controller');
                    updateSettingsStatus('success', '设置更新成功');
                } catch (e) {
                    logger.debug('无法更新设置状态（控制器可能未加载）');
                }
                break;
                
            case 'settings_update_failed':
                // 设置更新失败
                logger.error(`[Main-Thread] 设置更新失败: ${msg.error}, 涉及设置: ${msg.updatedKeys.join(', ')}`);
                // 更新设置状态（如果控制器可用）
                try {
                    const { updateSettingsStatus } = require('../controllers/settings.controller');
                    updateSettingsStatus('failed', msg.error);
                } catch (e) {
                    logger.debug('无法更新设置状态（控制器可能未加载）');
                }
                break;
                
            default:
                logger.warn(`[Main-Thread] 收到来自Settings Worker的未知消息类型: ${msg.type}`);
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
    // 使用流式处理避免大文件导致内存溢出
    const fs = require('fs'); // 需要引入核心fs模块以使用createReadStream
    return new Promise((resolve) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => {
            hash.update(data);
        });
        stream.on('end', () => {
            resolve(hash.digest('hex'));
        });
        stream.on('error', (err) => {
            logger.warn(`流式计算文件 hash 失败: ${filePath}`, err);
            resolve(null); // 发生错误时返回 null，保持原有行为
        });
    });
}

/**
 * 合并索引变更事件
 * 将连续的变更事件合并，避免重复处理
 * @param {Array} changes - 原始变更事件数组
 * @returns {Array} 合并后的变更事件数组
 */
    function consolidateIndexChanges(changes) {
    logger.info(`开始合并 ${changes.length} 个原始变更事件...`);
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
    logger.info(`合并后剩余 ${consolidated.length} 个有效变更事件。`);
    return consolidated;
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
    isIndexing = true;
    logger.info('向 Indexing Worker 发送索引重建任务...');
    const worker = getIndexingWorker();
    worker.postMessage({ type: 'rebuild_index', payload: { photosDir: PHOTOS_DIR } });
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
    if (pendingIndexChanges.length === 0) return;

    const changesToProcess = consolidateIndexChanges(pendingIndexChanges);
    pendingIndexChanges = [];

    if (changesToProcess.length === 0) {
        logger.info('所有文件变更相互抵消，无需更新索引。');
        return;
    }

    if (changesToProcess.length > 5000) {
        logger.warn(`检测到超过 5000 个文件变更，将执行全量索引重建以保证数据一致性。`);
        await buildSearchIndex();
        return;
    }

    // 执行增量索引更新
    isIndexing = true;
    logger.info(`向 Indexing Worker 发送 ${changesToProcess.length} 个索引变更以进行处理...`);
    const worker = getIndexingWorker();
    worker.postMessage({ type: 'process_changes', payload: { changes: changesToProcess, photosDir: PHOTOS_DIR } });
}

/**
 * 触发延迟索引处理
 * 在文件系统稳定后清理相关缓存并处理索引变更
 * 使用5秒延迟确保文件系统操作完成
 */
function triggerDelayedIndexProcessing() {
    clearTimeout(rebuildTimeout);
    // 自适应聚合延迟：根据近期变更密度放大延迟，降低抖动
    const dynamicDelay = (() => {
        const changes = pendingIndexChanges.length;
        if (changes > 10000) return Math.max(INDEX_STABILIZE_DELAY_MS, 30000);
        if (changes > 5000) return Math.max(INDEX_STABILIZE_DELAY_MS, 20000);
        if (changes > 1000) return Math.max(INDEX_STABILIZE_DELAY_MS, 10000);
        return INDEX_STABILIZE_DELAY_MS;
    })();

    rebuildTimeout = setTimeout(async () => {
        logger.info('文件系统稳定，开始按标签精细化失效缓存并处理索引变更...');
        try {
            // 基于当前待处理的变更，推导受影响的相册层级标签
            const pendingSnapshot = Array.isArray(pendingIndexChanges) ? [...pendingIndexChanges] : [];
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
                    const changes = pendingIndexChanges.length;
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
                                if (typeof redis.unlink === 'function') await redis.unlink(...keys); else await redis.del(...keys);
                                cleared += keys.length;
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
    // 配置chokidar文件监控器
    const watcher = chokidar.watch(PHOTOS_DIR, {
        ignoreInitial: true,    // 忽略初始扫描
        persistent: true,       // 持续监控
        depth: 99,              // 监控深度99层
        ignored: [
            /(^|[\/\\])@eaDir/,  // 忽略隐藏文件和Synology系统目录
            /(^|[\/\\])\.tmp/,   // 忽略临时目录
            /temp_opt_.*/,      // 忽略临时文件
            /.*\.tmp$/          // 忽略.tmp后缀文件
        ],
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }, // 等待文件写入完成
        // 在 SMB/NFS/网络挂载/某些 Windows 环境下，FS 事件可能丢失；允许通过环境变量切换为轮询模式
        usePolling: (process.env.WATCH_USE_POLLING || 'false').toLowerCase() === 'true',
        interval: Number(process.env.WATCH_POLL_INTERVAL || 1000),
        binaryInterval: Number(process.env.WATCH_POLL_BINARY_INTERVAL || 1500),
    });

    if ((process.env.WATCH_USE_POLLING || 'false').toLowerCase() === 'true') {
        logger.warn('[Watcher] 已启用轮询模式(usePolling)。interval=%dms binaryInterval=%dms', 
            Number(process.env.WATCH_POLL_INTERVAL || 1000),
            Number(process.env.WATCH_POLL_BINARY_INTERVAL || 1500));
    }

    /**
     * 文件变更事件处理函数
     * 处理文件添加、删除、目录创建等事件
     * @param {string} type - 事件类型（add, unlink, addDir, unlinkDir）
     * @param {string} filePath - 文件路径
     */
    const onFileChange = async (type, filePath) => {
        logger.debug(`检测到文件变动: ${filePath} (${type})。等待文件系统稳定...`);

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

            // 删除孤立的缩略图文件（降噪：仅 debug 级别记录）
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
                    // 数据库同步清理该子树的 thumb_status 记录（失败忽略）
                    try { await dbRun('main', `DELETE FROM thumb_status WHERE path LIKE CONCAT(?, '/%')`, [relDir]); } catch {} // 忽略删除失败
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
            const isDbLike = /\.(db|db3|sql|bak|log|tmp)$/i.test(filePath) || /history\.db(-wal|-shm)?$/i.test(filePath);
            if (!isMedia || isDbLike) {
                return;
            }
        }

        // 避免重复添加相同的变更事件
        if (!pendingIndexChanges.some(c => c.type === type && c.filePath === filePath && (type !== 'add' || c.hash === hash))) {
            pendingIndexChanges.push({ type, filePath, ...(type === 'add' && hash ? { hash } : {}) });
        }
        
        // 触发延迟索引处理
        triggerDelayedIndexProcessing();
    };

    logger.info(`开始监控照片目录: ${PHOTOS_DIR}`);
    
    // 绑定文件系统事件监听器
    watcher
        .on('add', path => onFileChange('add', path))           // 文件添加事件
        .on('unlink', path => onFileChange('unlink', path))     // 文件删除事件
        .on('addDir', path => onFileChange('addDir', path))     // 目录添加事件
        .on('unlinkDir', path => onFileChange('unlinkDir', path)) // 目录删除事件
        .on('error', error => logger.error('目录监控出错:', error)); // 错误处理
}


// 导出索引服务函数
module.exports = {
    setupWorkerListeners,    // 设置工作线程监听器
    buildSearchIndex,        // 构建搜索索引
    watchPhotosDir,          // 监控照片目录
};

/**
 * 主动重算受影响相册的封面并持久化到 album_covers
 * 逻辑：根据最近的 pendingIndexChanges 推导相册路径集合，批量查封面后 UPSERT 到表
 */
async function recomputeAndPersistAlbumCovers() {
    try {
        const snapshot = Array.isArray(pendingIndexChanges) ? [...pendingIndexChanges] : [];
        if (snapshot.length === 0) return;

        const albumRelSet = new Set();
        for (const change of snapshot) {
            const rawPath = change && change.filePath ? String(change.filePath) : '';
            const rel = getSafeRelativePath(rawPath, PHOTOS_DIR);
            if (rel === null) continue;
            if (!rel) { albumRelSet.add(''); continue; }
            const isDirEvent = change.type === 'addDir' || change.type === 'unlinkDir';
            const relDir = isDirEvent ? rel : rel.split('/').slice(0, -1).join('/');
            const segments = relDir.split('/').filter(Boolean);
            let cur = '';
            albumRelSet.add('');
            for (const seg of segments) {
                cur = cur ? `${cur}/${seg}` : seg;
                albumRelSet.add(cur);
            }
        }

        if (albumRelSet.size === 0) return;
        const rels = Array.from(albumRelSet);
        const coversMap = await findCoverPhotosBatchDb(rels);

        // 构造 UPSERT
        const upserts = [];
        for (const rel of rels) {
            const absAlbum = require('path').join(PHOTOS_DIR, rel);
            const info = coversMap.get(absAlbum);
            if (!info || !info.path) continue;
            // 修正正则表达式，应该是 /\\/g 而不是 /\/g
            const coverRel = require('path').relative(PHOTOS_DIR, info.path).replace(/\\/g, '/');
            const mtime = info.mtime || Date.now();
            const width = info.width || 1;
            const height = info.height || 1;
            upserts.push({ albumPath: rel, coverPath: coverRel, mtime, width, height });
        }

        if (upserts.length === 0) return;

        // 统一使用通用批处理助手执行 UPSERT
        const upsertSql = `INSERT INTO album_covers (album_path, cover_path, width, height, mtime)
                           VALUES (?, ?, ?, ?, ?)
                           ON DUPLICATE KEY UPDATE
                               cover_path=VALUES(cover_path),
                               width=VALUES(width),
                               height=VALUES(height),
                               mtime=VALUES(mtime)`;
        const rows = upserts.map(r => [r.albumPath, r.coverPath, r.width, r.height, r.mtime]);
        await runPreparedBatch('main', upsertSql, rows, { chunkSize: 800 });
        // 完成后无需立即清Redis，这在触发路径已有 invalidateCoverCache；这里仅保障表数据新鲜
    } catch (e) {
        logger.error('recomputeAndPersistAlbumCovers 操作失败:', e.message);
        await handleErrorRecovery(e, 'album_covers_recompute', 2);
    }
}

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
        const retryCount = await redis.incr(errorKey).catch(() => 0);
        
        if (retryCount <= maxRetries) {
            logger.warn(`${context} 操作失败 (第${retryCount}次重试): ${error.message}`);
            // 指数退避重试
            const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 30000);
            await new Promise(resolve => setTimeout(resolve, delay));
            return true; // 允许重试
        } else {
            logger.error(`${context} 操作最终失败，已达到最大重试次数: ${error.message}`);
            await redis.del(errorKey).catch(() => {});
            return false; // 不再重试
        }
    } catch (e) {
        logger.error(`错误恢复处理失败: ${e.message}`);
        return false;
    }
}