/**
 * 数据库写入退避统一封装模块
 * 提供统一的重试策略和错误处理，支持MariaDB
 */

const logger = require('../config/logger');

/**
 * 默认重试配置
 */
const DEFAULT_RETRY_CONFIG = {
    maxRetries: 8,           // 最大重试次数
    baseDelay: 50,           // 基础延迟（毫秒）
    maxDelay: 5000,          // 最大延迟（毫秒）
    jitterRange: 40,         // 随机抖动范围（毫秒）
    indexingCheckDelay: 150, // 索引进行中的额外延迟
    indexingJitter: 150,     // 索引延迟的随机抖动
};

/**
 * 检查是否为数据库忙碌错误（支持MariaDB）
 * @param {Error} error - 错误对象
 * @returns {boolean} 是否为可重试的忙碌错误
 */
function isDatabaseBusyError(error) {
    if (!error || !error.message) return false;
    const msg = String(error.message);
    
    // MariaDB/MySQL错误检查
    if (error.code) {
        // 常见的可重试MariaDB错误代码
        const retryableCodes = [
            'ER_LOCK_WAIT_TIMEOUT',     // 锁等待超时
            'ER_LOCK_DEADLOCK',         // 死锁
            'ER_TOO_MANY_CONNECTIONS',  // 连接数过多
            'ECONNRESET',               // 连接重置
            'ETIMEDOUT',                // 连接超时
            'MARIADB_TIMEOUT'           // 自定义超时
        ];
        if (retryableCodes.includes(error.code)) return true;
    }
    
    // 错误消息检查
    return /lock wait timeout|deadlock found|too many connections|connection.*reset|connection.*timeout|database.*busy/i.test(msg);
}

/**
 * 检查是否为索引进行中的错误（保持兼容性）
 * @param {Error} error - 错误对象
 * @returns {boolean} 是否为索引相关错误
 */
function isIndexingError(error) {
    if (!error || !error.message) return false;
    const msg = String(error.message);
    // MariaDB中的索引操作错误
    return /waiting for.*lock|index.*operation|table.*repair/i.test(msg);
}

/**
 * 计算重试延迟
 * @param {number} attempt - 当前重试次数（从0开始）
 * @param {object} config - 重试配置
 * @param {boolean} isIndexing - 是否为索引相关错误
 * @returns {number} 延迟毫秒数
 */
function calculateDelay(attempt, config = DEFAULT_RETRY_CONFIG, isIndexing = false) {
    // 指数退避：基础延迟 * 2^attempt
    let delay = Math.min(
        config.baseDelay * Math.pow(2, attempt),
        config.maxDelay
    );
    
    // 添加随机抖动避免雷群效应
    const jitter = Math.random() * config.jitterRange;
    delay += jitter;
    
    // 索引相关错误额外延迟
    if (isIndexing) {
        delay += config.indexingCheckDelay;
        delay += Math.random() * config.indexingJitter;
    }
    
    return Math.round(delay);
}

/**
 * 睡眠函数
 * @param {number} ms - 毫秒数
 * @returns {Promise} Promise对象
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的数据库写入操作
 * @param {Function} operation - 要执行的数据库操作函数
 * @param {object} options - 重试选项
 * @param {object} options.config - 重试配置
 * @param {string} options.operationName - 操作名称（用于日志）
 * @param {object} options.context - 操作上下文信息
 * @returns {Promise} 操作结果
 */
async function withRetry(operation, options = {}) {
    const config = { ...DEFAULT_RETRY_CONFIG, ...options.config };
    const operationName = options.operationName || '数据库操作';
    const context = options.context || {};
    
    let lastError;
    
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        try {
            const result = await operation();
            
            // 如果之前有重试，记录成功日志
            if (attempt > 0) {
                logger.info(`${operationName} 重试成功`, {
                    attempt: attempt + 1,
                    totalRetries: config.maxRetries + 1,
                    context
                });
            }
            
            return result;
        } catch (error) {
            lastError = error;
            
            // 检查是否为可重试错误
            const isBusy = isDatabaseBusyError(error);
            const isIndexing = isIndexingError(error);
            
            if (!isBusy && !isIndexing) {
                // 不可重试错误，直接抛出
                throw error;
            }
            
            if (attempt >= config.maxRetries) {
                // 已达最大重试次数
                logger.error(`${operationName} 达到最大重试次数后仍失败`, {
                    maxRetries: config.maxRetries,
                    lastError: error.message,
                    context
                });
                throw error;
            }
            
            // 计算延迟并等待
            const delay = calculateDelay(attempt, config, isIndexing);
            
            logger.warn(`${operationName} 遇到可重试错误，将在 ${delay}ms 后重试`, {
                attempt: attempt + 1,
                maxRetries: config.maxRetries,
                error: error.message,
                errorCode: error.code,
                delay,
                context
            });
            
            await sleep(delay);
        }
    }
    
    // 这里应该不会到达，但为了类型安全
    throw lastError;
}

/**
 * 写入缩略图状态（带重试）
 * @param {string} dbType - 数据库类型
 * @param {string} path - 文件路径
 * @param {object} statusData - 状态数据
 * @param {object} options - 选项
 * @returns {Promise} 执行结果
 */
async function writeThumbStatusWithRetry(dbType, path, statusData, options = {}) {
    const { dbRun } = require('./multi-db');
    
    return withRetry(async () => {
        const sql = `INSERT INTO thumb_status (path, status, mtime, last_checked) 
                     VALUES (?, ?, ?, ?) 
                     ON DUPLICATE KEY UPDATE 
                     status = VALUES(status), 
                     mtime = VALUES(mtime), 
                     last_checked = VALUES(last_checked)`;
        
        return await dbRun(dbType, sql, [
            path,
            statusData.status || 'pending',
            statusData.mtime || 0,
            statusData.last_checked || Date.now()
        ]);
    }, {
        operationName: '写入缩略图状态',
        context: { dbType, path, status: statusData.status },
        ...options
    });
}

/**
 * 批量执行预编译语句（带重试）
 * @param {string} dbType - 数据库类型
 * @param {string} sql - SQL语句
 * @param {Array} rows - 数据行数组
 * @param {object} options - 选项
 * @returns {Promise<number>} 处理的行数
 */
async function runPreparedBatchWithRetry(dbType, sql, rows, options = {}) {
    const { runPreparedBatch } = require('./multi-db');
    
    return withRetry(async () => {
        return await runPreparedBatch(dbType, sql, rows, options.batchOptions);
    }, {
        operationName: '批量数据库操作',
        context: { dbType, rowCount: rows.length },
        ...options
    });
}

module.exports = {
    withRetry,
    writeThumbStatusWithRetry,
    runPreparedBatchWithRetry,
    isDatabaseBusyError,
    isIndexingError,
    calculateDelay,
    DEFAULT_RETRY_CONFIG
};