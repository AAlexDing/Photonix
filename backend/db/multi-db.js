const mysql = require('mysql2/promise');
const os = require('os');
const { 
    MARIADB_HOST,
    MARIADB_PORT, 
    MARIADB_USER,
    MARIADB_PASSWORD,
    DB_MAIN,
    DB_SETTINGS,
    DB_HISTORY,
    DB_INDEX
} = require('../config');
const logger = require('../config/logger');

// 连接池配置 - MySQL2兼容
const poolConfig = {
    host: MARIADB_HOST,
    port: MARIADB_PORT,
    user: MARIADB_USER,
    password: MARIADB_PASSWORD,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // 移除无效的MySQL2配置参数: acquireTimeout, timeout
    multipleStatements: true,
    charset: 'utf8mb4'
};

// 数据库连接池
const dbConnections = {};

// 数据库连接健康状态
const dbHealthStatus = new Map();

// 连接监控配置
const DB_HEALTH_CHECK_INTERVAL = Number(process.env.DB_HEALTH_CHECK_INTERVAL || 60000); // 1分钟
const DB_RECONNECT_ATTEMPTS = Number(process.env.DB_RECONNECT_ATTEMPTS || 3);
const QUERY_TIMEOUT_DEFAULT = process.env.MARIADB_QUERY_TIMEOUT
    ? parseInt(process.env.MARIADB_QUERY_TIMEOUT, 10)
    : 30000; // ms

let __dynamicQueryTimeoutMs = QUERY_TIMEOUT_DEFAULT;

const QUERY_TIMEOUT_MIN = 15000;
const QUERY_TIMEOUT_MAX = 60000;

function getQueryTimeoutMs() {
    return __dynamicQueryTimeoutMs;
}

/**
 * 为 Promise 添加超时功能
 * @param {Promise} promise - 要执行的 Promise
 * @param {number} ms - 超时毫秒数
 * @param {object} queryInfo - 查询信息，用于日志记录
 * @returns {Promise} - 带超时的 Promise
 */
const withTimeout = (promise, ms, queryInfo) => {
    let timerId;
    return new Promise((resolve, reject) => {
        timerId = setTimeout(() => {
            const queryPreview = queryInfo.sql ? queryInfo.sql.substring(0, 100) + (queryInfo.sql.length > 100 ? '...' : '') : 'Unknown query';
            const error = new Error(`Query timed out after ${ms}ms. Query: ${queryPreview}`);
            error.code = 'MARIADB_TIMEOUT';
            error.timeout = ms;
            error.queryInfo = queryInfo;
            
            // 添加性能优化建议
            if (queryInfo.sql && queryInfo.sql.includes('ORDER BY') && !queryInfo.sql.includes('LIMIT')) {
                error.suggestion = 'Consider adding LIMIT clause to large ORDER BY queries';
            }
            
            logger.error(`[DB-TIMEOUT] 查询超时 ${ms}ms: ${queryPreview}`);
            reject(error);
        }, ms);

        promise.then((val) => {
            clearTimeout(timerId);
            resolve(val);
        }).catch((err) => {
            clearTimeout(timerId);
            // 增强错误信息
            if (err.code === 'ER_LOCK_WAIT_TIMEOUT') {
                err.suggestion = 'Database lock timeout - consider optimizing concurrent queries';
                logger.warn(`[DB-LOCK-TIMEOUT] 数据库锁等待超时: ${queryInfo.sql ? queryInfo.sql.substring(0, 100) : 'Unknown query'}`);
            }
            reject(err);
        });
    });
};

// 获取数据库名称映射
const getDbName = (dbType) => {
    switch (dbType) {
        case 'main': return DB_MAIN;
        case 'settings': return DB_SETTINGS;
        case 'history': return DB_HISTORY;
        case 'index': return DB_INDEX;
        default: throw new Error(`未知的数据库类型: ${dbType}`);
    }
};

// 创建数据库连接池的通用函数
const createDBConnection = async (dbType) => {
    try {
        const dbName = getDbName(dbType);
        const config = {
            ...poolConfig,
            database: dbName
        };
        
        const pool = mysql.createPool(config);
        logger.info(`成功连接到 ${dbType} 数据库: ${dbName}`);
        
        // 设置连接健康状态
        dbHealthStatus.set(dbType, 'connected');
        
        return pool;
    } catch (error) {
        logger.error(`无法连接到 ${dbType} 数据库: ${error.message}`);
        dbHealthStatus.set(dbType, 'error');
        throw error;
    }
};

// 创建数据库（如果不存在）
const createDatabaseIfNotExists = async (dbName) => {
    const rootConfig = {
        host: MARIADB_HOST,
        port: MARIADB_PORT,
        user: 'root',
        password: process.env.MARIADB_ROOT_PASSWORD || MARIADB_PASSWORD,
        multipleStatements: true
    };
    
    try {
        const connection = await mysql.createConnection(rootConfig);
        await connection.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await connection.end();
        logger.info(`数据库 ${dbName} 已确保存在`);
    } catch (error) {
        logger.error(`创建数据库 ${dbName} 失败: ${error.message}`);
        throw error;
    }
};

// 初始化所有数据库连接
const initializeConnections = async () => {
    try {
        logger.info('开始初始化所有数据库连接...');
        
        // 首先创建所有数据库
        await createDatabaseIfNotExists(DB_MAIN);
        await createDatabaseIfNotExists(DB_SETTINGS);
        await createDatabaseIfNotExists(DB_HISTORY);
        await createDatabaseIfNotExists(DB_INDEX);
        
        // 然后创建连接池
        dbConnections.main = await createDBConnection('main');
        dbConnections.settings = await createDBConnection('settings');
        dbConnections.history = await createDBConnection('history');
        dbConnections.index = await createDBConnection('index');

        logger.info('所有数据库连接已初始化完成');
        return dbConnections;
    } catch (error) {
        logger.error('初始化数据库连接失败:', error.message);
        throw error;
    }
};

// 获取指定数据库连接
const getDB = (dbType = 'main') => {
    if (!dbConnections[dbType]) {
        throw new Error(`数据库连接 ${dbType} 不存在`);
    }
    return dbConnections[dbType];
};

// 关闭所有数据库连接
const closeAllConnections = async () => {
    const promises = Object.entries(dbConnections).map(async ([name, pool]) => {
        try {
            await pool.end();
            logger.info(`成功关闭 ${name} 数据库连接`);
        } catch (error) {
            logger.error(`关闭 ${name} 数据库连接失败:`, error.message);
        }
    });
    
    await Promise.all(promises);
};

// 通用数据库操作函数
const runAsync = async (dbType, sql, params = [], successMessage = '') => {
    try {
        const pool = getDB(dbType);
        if (!pool) {
            throw new Error(`数据库连接池 ${dbType} 未找到`);
        }
        
        logger.debug(`[${dbType}] 执行SQL:`, sql.substring(0, 100) + (sql.length > 100 ? '...' : ''));
        logger.debug(`[${dbType}] 参数:`, params);
        
        const promise = pool.execute(sql, params);
        const result = await withTimeout(promise, getQueryTimeoutMs(), { sql });
        
        if (successMessage) {
            logger.info(`[${dbType}] ${successMessage}`);
        }
        
        logger.debug(`[${dbType}] SQL执行成功`);
        return result[0];
    } catch (error) {
        logger.error(`[${dbType}] SQL执行失败: ${error.message || error.toString()}`);
        logger.debug(`[${dbType}] 失败的SQL:`, sql);
        logger.debug(`[${dbType}] 参数:`, params);
        
        // 重新抛出原始错误，确保错误信息不丢失
        throw error;
    }
};

const dbRun = async (dbType, sql, params = []) => {
    const pool = getDB(dbType);
    const promise = pool.execute(sql, params);
    const result = await withTimeout(promise, getQueryTimeoutMs(), { sql });
    return result[0];
};

const dbAll = async (dbType, sql, params = []) => {
    const pool = getDB(dbType);
    const promise = pool.execute(sql, params);
    const result = await withTimeout(promise, getQueryTimeoutMs(), { sql });
    return result[0];
};

const dbGet = async (dbType, sql, params = []) => {
    const pool = getDB(dbType);
    const promise = pool.execute(sql, params);
    const result = await withTimeout(promise, getQueryTimeoutMs(), { sql });
    return result[0][0] || null;
};

// 检查表和列是否存在
const hasColumn = async (dbType, table, column) => {
    const dbName = getDbName(dbType);
    const sql = `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS 
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`;
    const result = await dbGet(dbType, sql, [dbName, table, column]);
    return result && result.count > 0;
};

const hasTable = async (dbType, table) => {
    const dbName = getDbName(dbType);
    const sql = `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.TABLES 
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`;
    const result = await dbGet(dbType, sql, [dbName, table]);
    return result && result.count > 0;
};

/**
 * 检查数据库连接健康状态
 */
async function checkDatabaseHealth() {
    const dbTypes = ['main', 'settings', 'history', 'index'];
    
    for (const dbType of dbTypes) {
        const pool = dbConnections[dbType];
        if (!pool) continue;
        
        try {
            // 执行简单查询测试连接
            await pool.execute('SELECT 1 as test');
            
            // 连接正常
            if (dbHealthStatus.get(dbType) !== 'connected') {
                logger.info(`${dbType} 数据库连接已恢复`);
                dbHealthStatus.set(dbType, 'connected');
            }
        } catch (error) {
            logger.warn(`${dbType} 数据库连接检查失败:`, error.message);
            dbHealthStatus.set(dbType, 'unhealthy');
            
            // 尝试重新连接
            await attemptReconnect(dbType);
        }
    }
}

/**
 * 尝试重新连接数据库
 */
async function attemptReconnect(dbType) {
    const maxAttempts = DB_RECONNECT_ATTEMPTS;
    let attempts = 0;
    
    while (attempts < maxAttempts) {
        attempts++;
        try {
            logger.info(`尝试重新连接 ${dbType} 数据库 (第${attempts}次)...`);
            
            // 关闭旧连接
            if (dbConnections[dbType]) {
                try {
                    await dbConnections[dbType].end();
                } catch (error) {
                    logger.warn(`关闭 ${dbType} 旧连接失败:`, error.message);
                }
            }
            
            // 重新创建连接
            dbConnections[dbType] = await createDBConnection(dbType);
            
            logger.info(`${dbType} 数据库重新连接成功`);
            return true;
        } catch (error) {
            logger.error(`${dbType} 数据库重新连接失败 (第${attempts}次):`, error.message);
            
            if (attempts < maxAttempts) {
                // 指数退避重试
                const delay = Math.min(1000 * Math.pow(2, attempts - 1), 10000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    logger.error(`${dbType} 数据库重新连接最终失败，已达到最大重试次数`);
    return false;
}

// 启动数据库健康检查
const dbHealthCheckInterval = setInterval(checkDatabaseHealth, DB_HEALTH_CHECK_INTERVAL);

// 清理数据库健康检查定时器
function cleanupDbHealthCheck() {
    if (dbHealthCheckInterval) {
        clearInterval(dbHealthCheckInterval);
    }
}

// 进程退出时清理数据库连接
process.on('beforeExit', async () => {
    cleanupDbHealthCheck();
    await closeAllConnections();
});
process.on('SIGINT', async () => {
    logger.info('收到 SIGINT 信号，清理数据库连接...');
    cleanupDbHealthCheck();
    await closeAllConnections();
});
process.on('SIGTERM', async () => {
    logger.info('收到 SIGTERM 信号，清理数据库连接...');
    cleanupDbHealthCheck();
    await closeAllConnections();
});

/**
 * 安全的SQL IN子句构建器
 * @param {Array} values - 值数组
 * @returns {Object} 包含 placeholders 和 values 的对象
 */
function buildSafeInClause(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return { placeholders: '(NULL)', values: [] };
    }

    // 验证所有值都是基本类型，防止SQL注入
    const validValues = values.filter(value => {
        const type = typeof value;
        return type === 'string' || type === 'number' || value === null || value === undefined;
    });

    if (validValues.length === 0) {
        return { placeholders: '(NULL)', values: [] };
    }

    const placeholders = validValues.map(() => '?').join(',');
    return {
        placeholders: `(${placeholders})`,
        values: validValues
    };
}

module.exports = {
    initializeConnections,
    getDB,
    closeAllConnections,
    runAsync,
    dbRun,
    dbAll,
    dbGet,
    hasColumn,
    hasTable,
    buildSafeInClause,
    dbConnections,
    checkDatabaseHealth,
    attemptReconnect,
    dbHealthStatus,
    
    /**
     * 动态调节 MariaDB 超时参数（全局）
     */
    adaptDbTimeouts: ({ queryTimeoutDeltaMs = 0 } = {}) => {
        __dynamicQueryTimeoutMs = Math.max(QUERY_TIMEOUT_MIN, Math.min(QUERY_TIMEOUT_MAX, __dynamicQueryTimeoutMs + (queryTimeoutDeltaMs | 0)));
        logger.debug(`DB 超时自适应: query=${__dynamicQueryTimeoutMs}ms`);
        return { queryTimeoutMs: __dynamicQueryTimeoutMs };
    },
    
    /**
     * 批量执行预编译语句（Prepared Statement）
     * - 默认内部管理事务（BEGIN/COMMIT/ROLLBACK）
     * - 支持分块提交，降低长事务风险
     * @param {('main'|'settings'|'history'|'index')} dbType
     * @param {string} sql - 预编译 SQL，例如 INSERT ... VALUES (?, ?, ?)
     * @param {Array<Array<any>>} rows - 参数数组列表
     * @param {Object} options
     * @param {number} [options.chunkSize=500]
     * @param {boolean} [options.manageTransaction=true]
     * @returns {Promise<number>} processed - 成功执行的行数
     */
    runPreparedBatch: async function runPreparedBatch(dbType, sql, rows, options = {}) {
        const pool = getDB(dbType);
        const chunkSize = Number.isFinite(options.chunkSize) ? options.chunkSize : 500;
        const manageTx = options.manageTransaction !== false; // 默认管理事务
        
        if (!Array.isArray(rows) || rows.length === 0) return 0;

        const connection = await pool.getConnection();
        let processed = 0;
        
        try {
            if (manageTx) {
                await connection.beginTransaction();
            }
            
            for (let i = 0; i < rows.length; i += chunkSize) {
                const slice = rows.slice(i, i + chunkSize);
                for (const params of slice) {
                    await connection.execute(sql, params);
                    processed += 1;
                }
            }
            
            if (manageTx) {
                await connection.commit();
            }
        } catch (e) {
            if (manageTx) {
                try {
                    await connection.rollback();
                } catch (rollbackErr) {
                    logger.error('事务回滚失败:', rollbackErr);
                }
            }
            throw e;
        } finally {
            connection.release();
        }
        
        return processed;
    }
};