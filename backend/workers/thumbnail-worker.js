const { parentPort, workerData } = require('worker_threads');
const sharp = require('sharp');
// 限制 sharp/libvips 缓存以控制内存占用
try {
    const memMb = Number(process.env.SHARP_CACHE_MEMORY_MB || 32);
    const items = Number(process.env.SHARP_CACHE_ITEMS || 100);
    const files = Number(process.env.SHARP_CACHE_FILES || 0);
    sharp.cache({ memory: memMb, items, files });
    const conc = Number(process.env.SHARP_CONCURRENCY || 1);
    if (conc > 0) sharp.concurrency(conc);
} catch {}
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

function translateErrorMessage(message = '') {
    const msg = String(message || '').toLowerCase();
    if (msg.includes('webp') && (msg.includes('unable to parse image') || msg.includes('corrupt header'))) {
        return 'WebP 文件头损坏或格式异常，无法解析';
    }
    if (msg.includes('invalid marker') || msg.includes('jpeg')) {
        return 'JPEG 文件损坏或不完整，无法解析';
    }
    if (msg.includes('png') && (msg.includes('bad') || msg.includes('invalid'))) {
        return 'PNG 文件损坏或格式异常，无法解析';
    }
    if (msg.includes('unsupported image format')) {
        return 'Input file contains unsupported image format';
    }
    return message || '无法解析的图片文件';
}

// 使用 ffmpeg 作为后备方案处理 sharp 无法识别的图片格式
async function generateImageThumbnailWithFfmpeg(imagePath, thumbPath) {
    return new Promise((resolve) => {
        const args = [
            '-v', 'error',
            '-y',
            '-i', imagePath,
            '-vf', 'scale=500:-2',
            '-frames:v', '1',
            '-q:v', '3',
            thumbPath
        ];
        execFile('ffmpeg', args, (err) => {
            if (err) return resolve({ success: false, error: err.message });
            resolve({ success: true });
        });
    });
}

// 增加对损坏或非标准图片文件的容错处理
async function generateImageThumbnail(imagePath, thumbPath) {
    const mainProcessing = async () => {
        // 首先读取元数据，检查图片尺寸
        const metadata = await sharp(imagePath, { limitInputPixels: Number(process.env.SHARP_MAX_PIXELS || (24000 * 24000)) }).metadata();
        const pixelCount = (metadata.width || 1) * (metadata.height || 1);
        
        // 设定1亿像素的上限，超过此上限直接抛出错误
        const MAX_PIXELS = 100000000; // 1亿像素
        if (pixelCount > MAX_PIXELS) {
            throw new Error(`图片尺寸过大: ${metadata.width}x${metadata.height} (${pixelCount.toLocaleString()} 像素)，超过安全上限 ${MAX_PIXELS.toLocaleString()} 像素`);
        }
        
        let dynamicQuality;

        if (pixelCount > 8000000) {
            dynamicQuality = 65;
        } else if (pixelCount > 2000000) {
            dynamicQuality = 70;
        } else {
            dynamicQuality = 80;
        }

        await sharp(imagePath, { limitInputPixels: Number(process.env.SHARP_MAX_PIXELS || (24000 * 24000)) })
            .resize({ width: 500, withoutEnlargement: true })
            .webp({ quality: dynamicQuality })
            .toFile(thumbPath);
    };

    try {
        await mainProcessing();
        return { success: true };
    } catch (error) {
        const zhReason = translateErrorMessage(error && error.message);
        console.warn(`[WORKER] 图片: ${path.basename(imagePath)} 首次处理失败，原因: ${zhReason}。尝试进入安全模式...`);
        
        try {
            // 使用 failOn: 'none' 模式，让 sharp 尽可能忽略错误，完成转换
            await sharp(imagePath, { failOn: 'none', limitInputPixels: Number(process.env.SHARP_MAX_PIXELS || (24000 * 24000)) })
                .resize({ width: 500, withoutEnlargement: true })
                .webp({ quality: 60 }) // 在安全模式下使用稍低的质量
                .toFile(thumbPath);
            
            console.log(`[WORKER] 图片: ${path.basename(imagePath)} 在安全模式下处理成功。`);
            return { success: true };
        } catch (safeError) {
            // 如果连安全模式都失败了，尝试最后的后备方案
            const zhSafeReason = translateErrorMessage(safeError && safeError.message);

            // 如果是"不支持的格式"错误，尝试使用 ffmpeg 处理
            if (zhSafeReason.includes('unsupported image format')) {
                console.warn(`[WORKER] 图片: ${path.basename(imagePath)} sharp 无法处理，尝试使用 ffmpeg...`);
                try {
                    const ffmpegResult = await generateImageThumbnailWithFfmpeg(imagePath, thumbPath);
                    if (ffmpegResult.success) {
                        console.log(`[WORKER] 图片: ${path.basename(imagePath)} ffmpeg 处理成功。`);
                        return { success: true };
                    }
                } catch (ffmpegError) {
                    console.error(`[WORKER] 图片: ${path.basename(imagePath)} ffmpeg 也失败了: ${ffmpegError.message}`);
                }
            }

            console.error(`[WORKER] 图片: ${path.basename(imagePath)} 所有处理方法均失败: ${zhSafeReason}`);
            return { success: false, error: 'PROCESSING_FAILED_IN_SAFE_MODE', message: zhSafeReason };
        }
    }
}


// 基于 ffmpeg 的 thumbnail 过滤器快速截帧，避免多帧计算造成阻塞
async function generateVideoThumbnail(videoPath, thumbPath) {
    return new Promise((resolve) => {
        const args = [
            '-v', 'error',
            '-y',
            '-i', videoPath,
            // thumbnail=N 选取代表帧，这里给出较大的采样窗口，提高代表性
            '-vf', 'thumbnail=300,scale=320:-2',
            '-frames:v', '1',
            thumbPath
        ];
        execFile('ffmpeg', args, (err) => {
            if (err) return resolve({ success: false, error: err.message });
            resolve({ success: true });
        });
    });
}


parentPort.on('message', async (task) => {
    try {
        const { filePath, relativePath, type, thumbsDir } = task;
        const isVideo = type === 'video';
        const extension = isVideo ? '.jpg' : '.webp';
        const thumbRelPath = relativePath.replace(/\.[^.]+$/, extension);
        const thumbPath = path.join(thumbsDir, thumbRelPath);

        // 如果缩略图已存在，直接跳过（状态写回由主线程统一负责，避免重复写库）
        try {
            await fs.access(thumbPath);
            parentPort.postMessage({ success: true, skipped: true, task, workerId: workerData.workerId });
            return;
        } catch (e) {
            // 文件不存在才继续生成
        }

        // 创建目录
        await fs.mkdir(path.dirname(thumbPath), { recursive: true });
        
        let result;
        if (isVideo) {
            result = await generateVideoThumbnail(filePath, thumbPath);
        } else {
            result = await generateImageThumbnail(filePath, thumbPath);
        }

        parentPort.postMessage({ ...result, task, workerId: workerData.workerId });
    } catch (error) {
        // 捕获到任何未处理的异常
        console.error(`[THUMBNAIL-WORKER] Fatal error processing ${task.relativePath}: ${error.message}`);
        // 向主线程报告失败，以便更新数据库状态并继续处理下一个任务
        parentPort.postMessage({
            success: false,
            error: `Processing failed: ${error.message}`,
            task,
            workerId: workerData.workerId
        });
    }
});
