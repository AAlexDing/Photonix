/**
 * @file sse.js
 * @module SSE
 * @description
 * 负责处理服务器推送事件（Server-Sent Events），如缩略图生成通知等，包含自动重连与认证逻辑。
 */

import { registerThumbnailBuffer } from '../core/event-buffer.js';
import { getAuthToken } from './auth.js';
import { triggerMasonryUpdate } from '../features/gallery/masonry.js';
import { createModuleLogger } from '../core/logger.js';
import { safeClassList, safeQuerySelectorAll } from '../shared/dom-utils.js';
import { SSE } from '../core/constants.js';
import { setManagedTimeout } from '../core/timer-manager.js';

// 日志实例
const sseLogger = createModuleLogger('SSE');

// 直接导入重试管理器，避免异步导入问题
import { thumbnailRetryManager } from '../features/gallery/lazyload.js';

// 活动连接与重连相关变量
let eventSource = null;
let streamAbortController = null;
let retryCount = 0;

// 日志函数
const sseLog = (message, ...args) => {
    sseLogger.debug(message, args);
};
const sseWarn = (message, ...args) => {
    sseLogger.warn(message, args);
};
const sseError = (message, ...args) => {
    sseLogger.error(message, args);
};

// 缓冲器实例
let thumbnailBuffer = null;

/**
 * 初始化事件缓冲器
 * 注册缩略图生成事件缓冲器，可扩展注册其他事件缓冲器
 */
function initializeEventBuffers() {
    thumbnailBuffer = registerThumbnailBuffer(async (batch) => {
        await processThumbnailBatch(batch);
    });

    // 可在此注册其他事件缓冲器
    // registerIndexBuffer(indexFlushCallback);
    // registerMediaBuffer(mediaFlushCallback);
}

/**
 * 批量处理缩略图刷新事件
 * @param {Array<Object>} batch - 缩略图事件批次
 * @returns {Promise<void>}
 */
async function processThumbnailBatch(batch) {
    if (!batch || batch.length === 0) return;

    sseLog(`批量处理 ${batch.length} 个缩略图更新事件`);

    const tasks = batch.map(async (eventData) => {
        const imagePath = eventData.path;

        // 查找所有匹配 path 的图片元素
        const imagesToUpdate = Array.from(safeQuerySelectorAll('img.lazy-image')).filter(img => {
            const dataSrc = img.dataset.src;
            if (!dataSrc) return false;
            try {
                const url = new URL(dataSrc, window.location.origin);
                const pathParam = url.searchParams.get('path');
                if (!pathParam) return false;
                const decodedPathParam = decodeURIComponent(pathParam);
                return decodedPathParam === imagePath;
            } catch {
                return false;
            }
        });

        if (imagesToUpdate.length > 0) {
            sseLog('批量刷新匹配图片数量:', imagesToUpdate.length, 'path:', imagePath);
        }

        for (const img of imagesToUpdate) {
            try {
                await updateThumbnailImage(img, imagePath);
            } catch (error) {
                sseWarn('缩略图更新失败:', error);
                safeClassList(img, 'remove', 'opacity-0');
                img.dispatchEvent(new Event('error'));
            }
        }
    });

    try {
        await Promise.all(tasks);
    } finally {
        try { triggerMasonryUpdate(); } catch {}
    }
}

/**
 * 更新单个缩略图图片
 * @param {HTMLImageElement} img - 图片元素
 * @param {string} imagePath - 图片路径
 * @returns {Promise<void>}
 */
async function updateThumbnailImage(img, imagePath) {
    safeClassList(img, 'remove', 'error');
    safeClassList(img, 'remove', 'loaded');
    safeClassList(img, 'add', 'opacity-0');

    const decodedPathParam = decodeURIComponent(imagePath);
    const freshThumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(decodedPathParam)}&v=${Date.now()}`;

    const token = getAuthToken();
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

    const response = await fetch(freshThumbnailUrl, { headers, cache: 'no-cache' });

    if (response.status === 202) {
        // 仍在生成，保持 processing 状态并加入重试队列
        img.dataset.thumbStatus = 'processing';
        safeClassList(img, 'add', 'processing');
        img.dataset.src = freshThumbnailUrl;
        thumbnailRetryManager.addRetry(img, freshThumbnailUrl);
        return;
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const blob = await response.blob();

    setManagedTimeout(() => {
        if (img.dataset.processingBySSE) return;
        img.dataset.processingBySSE = 'true';

        if (window.blobUrlManager) {
            window.blobUrlManager.cleanup(img);
        } else {
            try {
                if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
            } catch {}
        }

        const newBlobUrl = URL.createObjectURL(blob);
        img.src = newBlobUrl;
        if (window.blobUrlManager) {
            window.blobUrlManager.activeBlobUrls.set(img, newBlobUrl);
        }
        img.dataset.src = freshThumbnailUrl;

        img.dataset.thumbStatus = '';
        safeClassList(img, 'remove', 'processing');

        safeClassList(img, 'remove', 'opacity-0');
        safeClassList(img, 'add', 'loaded');
        thumbnailRetryManager.removeRetry(img);

        setManagedTimeout(() => {
            if (img.onload) img.onload = null;
            try { triggerMasonryUpdate(); } catch {}
            delete img.dataset.processingBySSE;
        }, 100, 'sse-thumbnail-finalize');
    }, 10, 'sse-thumbnail-update');
}

/**
 * 清理当前活动的 SSE 连接和流控制器
 */
function clearActiveConnection() {
    if (eventSource) {
        try { eventSource.close(); } catch {}
    }
    eventSource = null;
    if (streamAbortController) {
        try { streamAbortController.abort(); } catch {}
    }
    streamAbortController = null;
}

/**
 * 安排自动重连
 */
function scheduleReconnect() {
    const delay = Math.min(SSE.MAX_RETRY_DELAY, 1000 * Math.pow(2, retryCount));
    retryCount++;
    setManagedTimeout(connect, delay, 'sse-reconnect');
}

/**
 * 处理 connected 事件
 * @param {Object} data - 事件数据
 */
function handleConnectedEvent(data) {
    try {
        if (!data) return;
    } catch {}
}

/**
 * 处理 thumbnail-generated 事件
 * @param {Object} data - 事件数据
 */
function handleThumbnailGeneratedEvent(data) {
    if (!data || !data.path) return;
    try {
        thumbnailBuffer.enqueue(data);
    } catch (error) {
        sseError('Error buffering thumbnail-generated event:', error);
    }
}

/**
 * 分发 SSE 事件
 * @param {string} evtType - 事件类型
 * @param {Object} payload - 事件载荷
 */
function dispatchSseEvent(evtType, payload) {
    if (evtType === 'connected') {
        handleConnectedEvent(payload);
        return;
    }
    if (evtType === 'thumbnail-generated') {
        handleThumbnailGeneratedEvent(payload);
    }
}

/**
 * 解析原始 SSE 事件字符串并分发
 * @param {string} rawEvent - 原始事件字符串
 */
function parseAndDispatch(rawEvent) {
    const lines = rawEvent.split(/\r?\n/);
    let eventType = 'message';
    let dataLines = [];
    for (const line of lines) {
        if (!line) continue;
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
            eventType = line.slice(6).trim() || 'message';
            continue;
        }
        if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
        }
    }
    if (dataLines.length === 0) {
        dispatchSseEvent(eventType, null);
        return;
    }
    const rawData = dataLines.join('\n');
    try {
        const parsed = JSON.parse(rawData);
        dispatchSseEvent(eventType, parsed);
    } catch (error) {
        sseError('解析 SSE 数据失败:', error);
    }
}

/**
 * 建立带认证的流式 SSE 连接
 * @param {string} token - 认证令牌
 * @returns {Promise<void>}
 */
async function streamWithAuth(token) {
    streamAbortController = new AbortController();
    const controller = streamAbortController;
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
        const response = await fetch('/api/events', {
            headers: { 'Authorization': `Bearer ${token}` },
            cache: 'no-store',
            signal: controller.signal,
        });

        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
        }

        retryCount = 0;
        sseLog('SSE 认证流已建立');

        const reader = response.body.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (controller.signal.aborted) return;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
                const chunk = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                if (chunk.trim().length > 0) {
                    parseAndDispatch(chunk);
                }
                boundary = buffer.indexOf('\n\n');
            }
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
            parseAndDispatch(buffer);
        }
        scheduleReconnect();
    } catch (error) {
        if (!controller.signal.aborted) {
            sseError('SSE 认证流错误:', error);
            scheduleReconnect();
        }
    } finally {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    }
}

/**
 * 建立带认证的 SSE 连接
 * @param {string} token - 认证令牌
 */
function connectWithAuth(token) {
    streamWithAuth(token);
}

/**
 * 建立到后端的 SSE 连接，包含自动重连和认证逻辑
 */
function connect() {
    clearActiveConnection();

    const token = getAuthToken();
    if (token) {
        connectWithAuth(token);
        return;
    }

    const url = '/api/events';
    eventSource = new EventSource(url);

    eventSource.onopen = () => {
        retryCount = 0;
        sseLog('连接已建立');
    };

    eventSource.onerror = (err) => {
        sseError('连接错误:', err);
        clearActiveConnection();
        scheduleReconnect();
    };

    eventSource.addEventListener('connected', (e) => {
        try {
            const data = JSON.parse(e.data);
            handleConnectedEvent(data);
        } catch (error) {
            sseError('解析 connected 事件失败:', error);
        }
    });

    eventSource.addEventListener('thumbnail-generated', (e) => {
        try {
            const data = JSON.parse(e.data);
            handleThumbnailGeneratedEvent(data);
        } catch (error) {
            sseError('解析 thumbnail-generated 事件失败:', error);
        }
    });
}

/**
 * 初始化 SSE 服务
 * 初始化事件缓冲器并建立 SSE 连接
 */
export function initializeSSE() {
    initializeEventBuffers();
    connect();
}
