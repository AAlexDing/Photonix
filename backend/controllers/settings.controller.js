/**
 * @file 系统设置相关控制器 (Settings Controller)
 * @description 负责处理与系统设置相关的所有 HTTP 接口，包括客户端设置信息获取、系统设置更新、更新状态查询、系统维护操作等。
 */

const logger = require('../config/logger');
const settingsService = require('../services/settings.service');
const albumManagementService = require('../services/albumManagement.service');
const manualSyncScheduler = require('../services/manualSyncScheduler.service');
const { hasPermission, getUserRole, PERMISSIONS } = require('../middleware/permissions');
const { AppError, AuthorizationError, ValidationError, ConfigurationError } = require('../utils/errors');

/**
 * 管理员密钥验证错误处理
 * @param {object} result 验证返回结果对象
 * @param {string} [defaultMessage='管理员密钥验证失败'] 默认错误提示
 * @returns {AppError} 对应类型的错误对象
 */
function mapAdminSecretError(result, defaultMessage = '管理员密钥验证失败') {
  const message = result?.msg || defaultMessage;
  const code = result?.code || 500;

  if (code === 400) return new ValidationError(message);
  if (code === 401 || code === 403) return new AuthorizationError(message);
  if (code === 500) return new ConfigurationError(message);
  return new AppError(message, code);
}

/**
 * 自动维护计划更新错误处理
 * @param {Error} error 原始错误对象
 * @returns {AppError} 自定义错误对象
 */
function mapScheduleUpdateError(error) {
  if (error instanceof AppError) return error;
  const message = error?.message || '更新自动维护计划失败';

  // 转译典型计划格式错误为验证类异常
  if (/Cron|分钟|计划|字段|间隔|整数|范围|表达式/.test(message)) {
    return new ValidationError(message);
  }
  return new AppError(message, 500);
}

// 设置更新相关服务
const {
  generateUniqueId,
  validateAndFilterSettings,
  handlePasswordOperations,
  detectAuthChanges,
  buildAuditContext,
  verifySensitiveOperations,
  dispatchUpdateTask,
  buildUpdateResponse
} = require('../services/settings/update.service');

// 设置更新状态相关服务
const {
  seedUpdateStatus,
  applyStatusUpdate,
  resolveUpdateStatus
} = require('../services/settings/status.service');

// 系统维护/同步相关服务
const {
  thumbnailSyncService,
  getIndexStatus,
  getHlsStatus,
  triggerSyncOperation,
  triggerCleanupOperation,
  getTypeDisplayName
} = require('../services/settings/maintenance.service');

/**
 * 获取客户端设置信息
 * @function getSettingsForClient
 * @description 提供前端所需的基础设置信息，如各项功能启用及安全配置状态
 * @param {Express.Request} _req
 * @param {Express.Response} res
 * @returns {void}
 */
exports.getSettingsForClient = async (_req, res) => {
  const allSettings = await settingsService.getAllSettings();
  res.json({
    AI_ENABLED: allSettings.AI_ENABLED,
    PASSWORD_ENABLED: allSettings.PASSWORD_ENABLED,
    hasPassword: Boolean(allSettings.PASSWORD_HASH && allSettings.PASSWORD_HASH !== ''),
    isAdminSecretConfigured: Boolean(process.env.ADMIN_SECRET && process.env.ADMIN_SECRET.trim() !== ''),
    albumDeletionEnabled: allSettings.ALBUM_DELETE_ENABLED === 'true',
    manualSyncSchedule: allSettings.MANUAL_SYNC_SCHEDULE || 'off',
    manualSyncStatus: manualSyncScheduler.getStatus()
  });
};

/**
 * 更新系统设置
 * @function updateSettings
 * @description 包括参数校验、密码处理、敏感操作校验及异步分发任务等
 * @param {Express.Request} req
 * @param {Express.Response} res
 * @returns {Promise<void>}
 */
exports.updateSettings = async (req, res) => {
  try {
    const { newPassword, adminSecret, settingsToUpdate } = validateAndFilterSettings(req.body);
    const allSettings = await settingsService.getAllSettings();
    const passwordOps = await handlePasswordOperations(settingsToUpdate, newPassword, allSettings);
    const auditContextBuilder = (extra) => buildAuditContext(req, extra);

    // 敏感操作验证（如密码变更等需密钥）
    const verifyResult = await verifySensitiveOperations(passwordOps.isSensitiveOperation, adminSecret, auditContextBuilder);
    if (!verifyResult.ok) {
      throw mapAdminSecretError(verifyResult);
    }

    // 若启用密码访问但未设置密码，则阻止操作
    if (
      Object.prototype.hasOwnProperty.call(settingsToUpdate, 'PASSWORD_ENABLED') &&
      settingsToUpdate.PASSWORD_ENABLED === 'true' &&
      !passwordOps.passwordIsCurrentlySet &&
      !passwordOps.isTryingToSetOrChangePassword
    ) {
      throw new ValidationError('请设置新密码以启用密码访问');
    }

    const hasAuthChanges = detectAuthChanges(settingsToUpdate);
    const updateId = generateUniqueId();
    seedUpdateStatus(updateId, Object.keys(settingsToUpdate));

    const dispatchResult = await dispatchUpdateTask(settingsToUpdate, updateId, hasAuthChanges, auditContextBuilder);
    const response = buildUpdateResponse(dispatchResult, hasAuthChanges, settingsToUpdate, auditContextBuilder);

    return res.status(response.statusCode).json(response.body);
  } catch (error) {
    logger.error('设置更新过程中发生未预期的错误:', error);
    throw error;
  }
};

/**
 * 获取设置更新状态
 * @function getSettingsUpdateStatus
 * @description 查询指定ID的设置更新进度或结果，兼容多种参数名
 * @param {Express.Request} req
 * @param {Express.Response} res
 * @returns {Promise<void>}
 */
exports.getSettingsUpdateStatus = async (req, res) => {
  // 支持 query/body, id/updateId 形式
  const id = req.query?.id || req.query?.updateId || req.body?.id || req.body?.updateId;
  const result = await resolveUpdateStatus(id);
  return res.status(result.statusCode).json(result.body);
};

/**
 * 设置更新状态内部变更（通常由服务间调用）
 * @function updateSettingsStatus
 * @param {string} status 状态（pending|success|failed|timeout）
 * @param {string} [message] 可选说明
 * @param {string} [updateId] 更新ID（可选）
 * @returns {void}
 */
exports.updateSettingsStatus = (status, message = null, updateId = null) => {
  applyStatusUpdate(updateId, status, message);
};

/**
 * 获取内部各处理任务状态表
 * @function getStatusTables
 * @description 包括索引状态、缩略图处理状态、HLS转码状态等
 * @param {Express.Request} _req
 * @param {Express.Response} res
 * @returns {Promise<void>}
 */
exports.getStatusTables = async (_req, res) => {
  try {
    const statusTables = {
      index: await getIndexStatus(),
      thumbnail: await thumbnailSyncService.getThumbnailStatus(),
      hls: await getHlsStatus()
    };
    res.json({
      success: true,
      data: statusTables,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('获取状态表信息失败:', error);
    throw new AppError(error?.message || '获取状态表信息失败', 500, 'STATUS_TABLE_FETCH_FAILED', {
      originalError: error?.message
    });
  }
};

/**
 * 手动触发数据补全任务
 * @function triggerSync
 * @description 补全索引、缩略图、HLS、或全部（需校验权限及密钥）
 * @param {Express.Request} req
 * @param {Express.Response} res
 * @returns {Promise<void>}
 */
exports.triggerSync = async (req, res) => {
  try {
    const { type } = req.params;
    const validTypes = ['index', 'thumbnail', 'hls', 'all'];
    if (!validTypes.includes(type)) {
      throw new ValidationError('无效的补全类型', { validTypes });
    }
    // 索引重建需鉴权与密钥检验
    if (type === 'index') {
      const hasPermissionToRun = hasPermission(getUserRole(req), PERMISSIONS.GENERATE_THUMBNAILS);
      if (!hasPermissionToRun) {
        throw new AuthorizationError('需要先设置访问密码才能重建索引');
      }
      const adminSecret = req.headers['x-admin-secret'] || req.body?.adminSecret;
      const buildCtx = (extra) => ({
        requestId: req.requestId || '-',
        userId: (req.user && req.user.id) ? String(req.user.id) : 'anonymous',
        action: 'trigger_sync',
        type: 'index',
        sensitive: true,
        ...extra
      });
      const verifyResult = await verifySensitiveOperations(true, adminSecret, buildCtx);
      if (!verifyResult.ok) {
        throw mapAdminSecretError(verifyResult, '重建索引验证失败');
      }
      logger.info(JSON.stringify(buildCtx({ status: 'approved', message: '重建索引管理员密钥验证成功' })));
    }
    const syncResult = await triggerSyncOperation(type);
    res.json({
      success: true,
      message: `已启动${getTypeDisplayName(type)}补全任务`,
      data: syncResult,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`触发${req.params.type}补全失败:`, error);
    if (error instanceof AppError) throw error;
    throw new AppError(error?.message || '补全操作失败', 500, 'SYNC_OPERATION_FAILED', {
      originalError: error?.message,
      type: req.params.type
    });
  }
};

/**
 * 手动重同步缩略图状态
 * @function resyncThumbnails
 * @description 全量扫描与修复缩略图状态，解决缩略图表与实际文件不一致
 * @param {Express.Request} _req
 * @param {Express.Response} res
 * @returns {Promise<void>}
 */
exports.resyncThumbnails = async (_req, res) => {
  try {
    logger.info('手动触发缩略图状态重同步请求');
    const result = await thumbnailSyncService.resyncThumbnailStatus({ trigger: 'manual-api', waitForCompletion: true });
    const syncedCount = Number(result?.syncedCount || 0);
    res.json({
      success: true,
      message: `缩略图状态重同步完成，共同步 ${syncedCount} 个文件`,
      data: { syncedCount, details: result },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('手动触发缩略图状态重同步请求失败:', error);
    if (error instanceof AppError) throw error;
    throw new AppError(error?.message || '缩略图状态重同步失败', 500, 'THUMBNAIL_RESYNC_FAILED', {
      originalError: error?.message
    });
  }
};

/**
 * 触发冗余文件的清理任务
 * @function triggerCleanup
 * @description 包括缩略图/HLS/全量清理（根据类型参数）
 * @param {Express.Request} req
 * @param {Express.Response} res
 * @returns {Promise<void>}
 */
exports.triggerCleanup = async (req, res) => {
  try {
    const { type } = req.params;
    const validTypes = ['thumbnail', 'hls', 'all'];
    if (!validTypes.includes(type)) {
      throw new ValidationError('无效的同步类型', { validTypes });
    }
    const cleanupResult = await triggerCleanupOperation(type);
    res.json({
      success: true,
      message: `已启动${getTypeDisplayName(type)}同步任务`,
      data: cleanupResult,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`触发${req.params.type}同步失败:`, error);
    if (error instanceof AppError) throw error;
    throw new AppError(error?.message || '同步操作失败', 500, 'CLEANUP_OPERATION_FAILED', {
      originalError: error?.message,
      type: req.params.type
    });
  }
};

/**
 * 手动同步相册与媒体数据
 * @function manualAlbumSync
 * @description 带密钥校验的相册与媒体库结构同步，并补齐缩略图
 * @param {Express.Request} req
 * @param {Express.Response} res
 * @returns {Promise<void>}
 */
exports.manualAlbumSync = async (req, res) => {
  try {
    const adminSecret = req.body?.adminSecret;
    const buildCtx = (extra) => buildAuditContext(req, { action: 'manual_album_sync', sensitive: true, ...extra });
    const verified = await verifySensitiveOperations(true, adminSecret, buildCtx);
    if (!verified.ok) throw mapAdminSecretError(verified);

    const result = await albumManagementService.syncAlbumsAndMedia();
    const summary = result.summary || { added: { albums: 0, photos: 0, videos: 0, media: 0 }, removed: { albums: 0, photos: 0, videos: 0, media: 0 }, totalChanges: 0 };
    const diff = result.diff || {};
    const addedPhotos = diff?.addedMedia?.photo || [];
    const addedVideos = diff?.addedMedia?.video || [];
    const removedPhotos = diff?.removedMedia?.photo || [];
    const removedVideos = diff?.removedMedia?.video || [];
    const removalList = [...removedPhotos, ...removedVideos];

    if (addedPhotos.length || addedVideos.length || removalList.length) {
      try {
        await thumbnailSyncService.updateThumbnailStatusIncremental({
          addedPhotos,
          addedVideos,
          removed: removalList,
          trigger: 'manual-sync',
          waitForCompletion: true
        });
      } catch (syncError) {
        logger.warn('缩略图增量更新失败，降级为后台全量重建:', syncError && syncError.message ? syncError.message : syncError);
        const fallback = thumbnailSyncService.resyncThumbnailStatus({
          trigger: 'manual-sync-fallback',
          waitForCompletion: false
        });
        const fallbackPromise = fallback && typeof fallback.then === 'function'
          ? fallback
          : fallback?.promise;
        if (fallbackPromise && typeof fallbackPromise.then === 'function') {
          fallbackPromise.catch((fallbackError) => {
            logger.error('缩略图状态全量重建失败（降级阶段）:', fallbackError && fallbackError.message ? fallbackError.message : fallbackError);
          });
        }
      }
    }
    const message = summary.totalChanges > 0 ? '手动同步完成' : '没有检测到需要同步的内容';
    logger.info(JSON.stringify(buildCtx({ status: 'approved', summary })));

    res.json({
      success: true,
      message,
      summary,
      changesApplied: Boolean(result.changesApplied),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('手动同步相册失败:', error);
    throw error;
  }
};

/**
 * 单独校验管理员密钥合法性
 * @function verifyAdminSecretOnly
 * @param {Express.Request} req
 * @param {Express.Response} res
 * @returns {Promise<void>}
 */
exports.verifyAdminSecretOnly = async (req, res) => {
  try {
    const adminSecret = req.body?.adminSecret;
    const buildCtx = (extra) => buildAuditContext(req, { action: 'verify_admin_secret', sensitive: true, ...extra });
    const verified = await verifySensitiveOperations(true, adminSecret, buildCtx);
    if (!verified.ok) throw mapAdminSecretError(verified);

    logger.info(JSON.stringify(buildCtx({ status: 'approved' })));
    res.json({ success: true });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof ValidationError || error instanceof ConfigurationError) {
      logger.warn('管理员密钥单独验证失败:', error.message);
    } else {
      logger.error('管理员密钥单独验证失败:', error);
    }
    throw error;
  }
};

/**
 * 设置是否允许相册删除
 * @function toggleAlbumDeletion
 * @description 管理员密钥校验后启用/禁用相册删除功能
 * @param {Express.Request} req
 * @param {Express.Response} res
 * @returns {Promise<void>}
 */
exports.toggleAlbumDeletion = async (req, res) => {
  try {
    const desired = Boolean(req.body?.enabled);
    const adminSecret = req.body?.adminSecret;
    const buildCtx = (extra) => buildAuditContext(req, {
      action: 'toggle_album_deletion',
      sensitive: true,
      target: desired ? 'enable' : 'disable',
      ...extra
    });

    const verified = await verifySensitiveOperations(true, adminSecret, buildCtx);
    if (!verified.ok) throw mapAdminSecretError(verified);

    await settingsService.updateSettings({ ALBUM_DELETE_ENABLED: desired ? 'true' : 'false' });
    logger.info(JSON.stringify(buildCtx({ status: 'approved' })));

    res.json({
      success: true,
      enabled: desired,
      message: desired ? '已启用相册删除' : '已禁用相册删除',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('切换相册删除开关失败:', error);
    throw error;
  }
};

/**
 * 更新手动同步计划（定时任务）
 * @function updateManualSyncSchedule
 * @description 允许修改/关闭手动同步计划（需管理员密钥）
 * @param {Express.Request} req
 * @param {Express.Response} res
 * @returns {Promise<void>}
 */
exports.updateManualSyncSchedule = async (req, res) => {
  try {
    const scheduleInput = req.body?.schedule;
    const adminSecret = req.body?.adminSecret;
    const buildCtx = (extra) => buildAuditContext(req, {
      action: 'update_manual_sync_schedule',
      sensitive: true,
      schedule: scheduleInput,
      ...extra
    });

    const verified = await verifySensitiveOperations(true, adminSecret, buildCtx);
    if (!verified.ok) throw mapAdminSecretError(verified);

    let normalized;
    try {
      normalized = await manualSyncScheduler.updateSchedule(scheduleInput);
    } catch (error) {
      throw mapScheduleUpdateError(error);
    }
    logger.info(JSON.stringify(buildCtx({ status: 'approved', normalizedSchedule: normalized.raw })));

    const status = manualSyncScheduler.getStatus();
    res.json({
      success: true,
      schedule: status.schedule,
      type: status.type,
      running: status.running,
      nextRunAt: status.nextRunAt,
      lastRunAt: status.lastRunAt,
      message: status.type === 'off' ? '已关闭自动维护计划' : '已更新自动维护计划'
    });
  } catch (error) {
    logger.error('更新手动同步计划失败:', error);
    throw error;
  }
};