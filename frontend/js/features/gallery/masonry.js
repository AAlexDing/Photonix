/**
 * @file 瀑布流布局模块
 * @description 负责处理图片网格的瀑布流布局、响应式列数和动态布局更新
 */

import { elements } from '../../shared/dom-elements.js';
import { getMasonryBreakpoints, getMasonryColumnsConfig, getMasonryConfig, VIRTUAL_SCROLL } from '../../core/constants.js';
import { createModuleLogger } from '../../core/logger.js';
import { safeSetInnerHTML, safeSetStyle, safeClassList } from '../../shared/dom-utils.js';

const masonryLogger = createModuleLogger('Masonry');

// 动态导入懒加载模块，避免循环依赖
let lazyloadModule = null;
/**
 * 异步获取懒加载模块
 * @returns {Promise<Object>} 懒加载模块
 */
const getLazyloadModule = async () => {
    if (!lazyloadModule) {
        lazyloadModule = await import('./lazyload.js');
    }
    return lazyloadModule;
};

// 全局图片懒加载观察器引用
let globalImageObserverRef = null;

/**
 * 获取当前窗口下的瀑布流列数
 * @returns {number} 列数
 */
export function getMasonryColumns() {
    const width = window.innerWidth;
    const breakpoints = getMasonryBreakpoints();
    const columns = getMasonryColumnsConfig();

    // 优先判断大屏
    if (width >= breakpoints['4k']) return columns['4k'];     // 4K+：12列
    if (width >= breakpoints['2_5k']) return columns['2_5k']; // 2.5K/2K：10列
    if (width >= breakpoints['1080p']) return columns['1080p']; // 1080p+：8列

    // 常规断点
    if (width >= breakpoints['2xl']) return columns['2xl'];   // 2xl：6列
    if (width >= breakpoints['xl']) return columns['xl'];     // xl：5列
    if (width >= breakpoints['lg']) return columns['lg'];     // lg：4列
    if (width >= breakpoints['md']) return columns['md'];     // md：3列
    if (width >= breakpoints['sm']) return columns['sm'];     // sm：2列
    return columns['default'];                                 // 默认：2列
}

// 全局记录每列高度
let masonryColumnHeights = [];
// 互斥锁，防止并发布局导致的竞态
let isLayingOut = false;
// 合并频繁布局请求
let layoutScheduled = false;
let layoutScheduleTimer = null;

// 虚拟滚动器实例
let virtualScroller = null;

/**
 * 增量瀑布流布局，仅布局新添加的项目
 * @param {Array|NodeList} newItems 新添加的项目数组
 */
export function applyMasonryLayoutIncremental(newItems) {
    const { contentGrid } = elements;
    if (!safeClassList(contentGrid, 'contains', 'masonry-mode')) return;
    if (!newItems || newItems.length === 0) return;
    if (isLayingOut) return; // 正在布局时丢弃本次请求

    isLayingOut = true;
    try {
        const numColumns = getMasonryColumns();
        const columnGap = getMasonryConfig('COLUMN_GAP');

        // 首次加载或列数变化，重置所有列高度并全量布局
        if (!masonryColumnHeights.length || contentGrid.children.length === newItems.length) {
            masonryColumnHeights = Array(numColumns).fill(0);
            Array.from(contentGrid.children).forEach(item => {
                const itemWidth = (contentGrid.offsetWidth - (numColumns - 1) * columnGap) / numColumns;
                const minColumnIndex = masonryColumnHeights.indexOf(Math.min(...masonryColumnHeights));
                // 设置项目位置和尺寸
                safeSetStyle(item, {
                    position: 'absolute',
                    width: `${itemWidth}px`,
                    left: `${minColumnIndex * (itemWidth + columnGap)}px`,
                    top: `${masonryColumnHeights[minColumnIndex]}px`
                });
                // 更新列高度
                const actualItemHeight = getExpectedItemHeight(item, itemWidth);
                safeSetStyle(item, 'height', `${actualItemHeight}px`);
                masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
            });
        } else {
            // 增量布局：只布局新项目
            newItems.forEach(item => {
                const itemWidth = (contentGrid.offsetWidth - (numColumns - 1) * columnGap) / numColumns;
                const minColumnIndex = masonryColumnHeights.indexOf(Math.min(...masonryColumnHeights));
                safeSetStyle(item, {
                    position: 'absolute',
                    width: `${itemWidth}px`,
                    left: `${minColumnIndex * (itemWidth + columnGap)}px`,
                    top: `${masonryColumnHeights[minColumnIndex]}px`
                });
                const actualItemHeight = getExpectedItemHeight(item, itemWidth);
                safeSetStyle(item, 'height', `${actualItemHeight}px`);
                masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
            });

            // 增量布局时也触发可见图片懒加载（减少频率）
            setTimeout(() => {
                if (!document.querySelector('.lazy-image[style*="opacity"]')) {
                    triggerVisibleImagesLazyLoad();
                }
            }, getMasonryConfig('LAZY_LOAD_DELAY'));
        }
        // 设置容器高度为最高列的高度
        safeSetStyle(contentGrid, 'height', `${Math.max(...masonryColumnHeights)}px`);
    } finally {
        isLayingOut = false;
    }
}

/**
 * 全量瀑布流布局，用于窗口变化或首次加载时
 */
export function applyMasonryLayout() {
    const { contentGrid } = elements;
    if (!safeClassList(contentGrid, 'contains', 'masonry-mode')) return;
    if (isLayingOut) return;

    const items = Array.from(contentGrid.children);
    if (items.length === 0) return;

    isLayingOut = true;
    try {
        const numColumns = getMasonryColumns();
        const columnGap = getMasonryConfig('COLUMN_GAP');
        masonryColumnHeights = Array(numColumns).fill(0);
        items.forEach(item => {
            const itemWidth = (contentGrid.offsetWidth - (numColumns - 1) * columnGap) / numColumns;
            const minColumnIndex = masonryColumnHeights.indexOf(Math.min(...masonryColumnHeights));
            safeSetStyle(item, {
                position: 'absolute',
                width: `${itemWidth}px`,
                left: `${minColumnIndex * (itemWidth + columnGap)}px`,
                top: `${masonryColumnHeights[minColumnIndex]}px`
            });
            const actualItemHeight = getExpectedItemHeight(item, itemWidth);
            safeSetStyle(item, 'height', `${actualItemHeight}px`);
            masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
        });

        safeSetStyle(contentGrid, 'height', `${Math.max(...masonryColumnHeights)}px`);

        // 虚拟滚动模式下触发可见图片懒加载
        setTimeout(() => {
            const hasVirtualScrollMode = safeClassList(contentGrid, 'contains', 'virtual-scroll-mode');
            const hasUnloadedImages = contentGrid.querySelector('.lazy-image:not(.loaded)');
            if (hasVirtualScrollMode && hasUnloadedImages) {
                triggerVisibleImagesLazyLoad();
            }
        }, getMasonryConfig('LAYOUT_DELAY'));
    } finally {
        isLayingOut = false;
    }
}

/**
 * 合并触发布局请求，节流处理
 */
function scheduleApplyMasonryLayout() {
    if (layoutScheduled) return;
    layoutScheduled = true;
    if (layoutScheduleTimer) clearTimeout(layoutScheduleTimer);
    requestAnimationFrame(() => {
        layoutScheduleTimer = setTimeout(() => {
            layoutScheduled = false;
            applyMasonryLayout();
        }, 80);
    });
}

/**
 * 获取元素的准确高度
 * @param {HTMLElement} element 元素
 * @returns {number} 元素高度
 */
function getElementHeight(element) {
    let height = element.offsetHeight;
    if (height === 0) {
        const computedStyle = window.getComputedStyle(element);
        height = parseInt(computedStyle.height);
        if (isNaN(height) || height === 0) {
            height = getMasonryConfig('DEFAULT_ITEM_HEIGHT');
        }
    }
    return height;
}

/**
 * 根据 data-width/height 预估高度，避免图片加载前后高度跳动
 * @param {HTMLElement} item 项目元素
 * @param {number} itemWidth 项目宽度
 * @returns {number} 预估高度
 */
function getExpectedItemHeight(item, itemWidth) {
    const dw = parseFloat(item.getAttribute('data-width'));
    const dh = parseFloat(item.getAttribute('data-height'));
    if (!Number.isNaN(dw) && !Number.isNaN(dh) && dw > 0 && dh > 0 && itemWidth > 0) {
        return itemWidth * (dh / dw);
    }
    return getElementHeight(item);
}

/**
 * 计算瀑布流布局信息（不修改DOM）
 * 用于虚拟滚动精确布局
 * @param {HTMLElement} container 容器元素
 * @param {Array} elements 要布局的元素数组
 * @returns {Object} 布局信息对象，键为元素索引，值为 { top, left, width, height }
 */
export function calculateMasonryLayout(container, elements) {
    if (!container || !elements || elements.length === 0) {
        return {};
    }
    const numColumns = getMasonryColumns();
    const columnGap = getMasonryConfig('COLUMN_GAP');
    const containerWidth = container.offsetWidth;
    const itemWidth = (containerWidth - (numColumns - 1) * columnGap) / numColumns;
    const columnHeights = Array(numColumns).fill(0);
    const layoutInfo = {};
    elements.forEach((element, index) => {
        const minColumnIndex = columnHeights.indexOf(Math.min(...columnHeights));
        const left = minColumnIndex * (itemWidth + columnGap);
        const top = columnHeights[minColumnIndex];
        const height = getElementHeight(element);
        layoutInfo[index] = {
            top: top,
            left: left,
            width: itemWidth,
            height: height
        };
        columnHeights[minColumnIndex] += height + columnGap;
    });
    return layoutInfo;
}

/**
 * 初始化虚拟滚动
 * @param {Array} items 数据项数组
 * @param {Function} renderCallback 渲染回调函数
 * @returns {boolean} 是否启用虚拟滚动
 */
export function initializeVirtualScroll(items, renderCallback) {
    // 重置虚拟滚动懒加载器状态
    virtualScrollLazyLoader.reset();
    const { contentGrid } = elements;
    if (!contentGrid) return;

    // 超过阈值启用虚拟滚动
    if (items.length > VIRTUAL_SCROLL.THRESHOLD) {
        if (!virtualScroller) {
            // 动态导入VirtualScroller
            import('./virtual-scroll.js').then(({ VirtualScroller }) => {
                const enhancedRenderCallback = renderCallback || createVirtualScrollRenderCallback;
                virtualScroller = new VirtualScroller(contentGrid, {
                    buffer: 15,
                    renderCallback: enhancedRenderCallback
                });
                virtualScroller.setItems(items);
                safeClassList(contentGrid, 'add', 'virtual-scroll-mode');
                // 添加滚动事件监听，触发懒加载
                setupVirtualScrollLazyLoading();
                // 确保懒加载系统初始化
                setTimeout(() => {
                    if (!globalImageObserverRef) {
                        getLazyloadModule().then(lazyload => {
                            if (!lazyload.globalImageObserver) {
                                lazyload.setupLazyLoading();
                            }
                            globalImageObserverRef = lazyload.globalImageObserver;
                        });
                    }
                }, 100);
            });
        } else {
            virtualScroller.setItems(items);
            safeClassList(contentGrid, 'add', 'virtual-scroll-mode');
            setTimeout(() => {
                if (!globalImageObserverRef) {
                    getLazyloadModule().then(lazyload => {
                        if (!lazyload.globalImageObserver) {
                            lazyload.setupLazyLoading();
                        }
                        globalImageObserverRef = lazyload.globalImageObserver;
                    });
                }
            }, 100);
        }
        return true;
    } else {
        // 项目较少，使用传统瀑布流
        if (virtualScroller) {
            // 清理懒加载事件监听器
            if (virtualScroller._lazyLoadHandler && virtualScroller.container) {
                virtualScroller.container.removeEventListener('scroll', virtualScroller._lazyLoadHandler);
            }
            virtualScroller.destroy();
            virtualScroller = null;
        }
        safeClassList(contentGrid, 'remove', 'virtual-scroll-mode');
        return false;
    }
}

/**
 * 为虚拟滚动器设置懒加载机制
 */
function setupVirtualScrollLazyLoading() {
    if (!virtualScroller) return;
    // 清理之前的监听器
    if (virtualScroller._lazyLoadHandler && virtualScroller.container) {
        virtualScroller.container.removeEventListener('scroll', virtualScroller._lazyLoadHandler);
    }
    // 监听虚拟滚动器的滚动事件
    let scrollTriggerTimeout;
    const handleScroll = () => {
        if (scrollTriggerTimeout) {
            clearTimeout(scrollTriggerTimeout);
        }
        scrollTriggerTimeout = setTimeout(() => {
            const { contentGrid } = elements;
            if (!contentGrid) return;
            const unloadedImages = contentGrid.querySelectorAll('.lazy-image:not(.loaded)');
            if (unloadedImages.length > 0) {
                triggerVisibleImagesLazyLoad();
            }
        }, 150);
    };
    const scrollContainer = virtualScroller.container;
    if (scrollContainer) {
        scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
        virtualScroller._lazyLoadHandler = handleScroll;
    }
}

/**
 * 触发瀑布流更新事件，通知其他模块重新布局
 */
export function triggerMasonryUpdate() {
    const event = new CustomEvent('masonry-update');
    document.dispatchEvent(event);
}

/**
 * 监听瀑布流更新事件，在窗口resize、模式切换等情况下重新布局
 */
document.addEventListener('masonry-update', () => {
    scheduleApplyMasonryLayout();
});

/**
 * 虚拟滚动懒加载优化器（智能预测版）
 */
const virtualScrollLazyLoader = {
    lastTriggerTime: 0, // 上次触发时间
    triggerThrottle: 100, // 节流时间
    isProcessing: false, // 是否正在处理中
    processedImages: new Set(), // 已处理图片集合
    scrollDirection: 0, // 滚动方向：1向下，-1向上，0静止
    lastScrollTop: 0, // 上次滚动位置
    scrollSamples: [], // 滚动方向采样

    /**
     * 更新滚动方向
     * @param {number} currentScrollTop 当前滚动位置
     */
    updateScrollDirection(currentScrollTop) {
        const direction = currentScrollTop > this.lastScrollTop ? 1 :
                         currentScrollTop < this.lastScrollTop ? -1 : 0;
        this.scrollSamples.push(direction);
        if (this.scrollSamples.length > 5) {
            this.scrollSamples.shift();
        }
        // 计算主要滚动方向
        const downCount = this.scrollSamples.filter(d => d === 1).length;
        const upCount = this.scrollSamples.filter(d => d === -1).length;
        this.scrollDirection = downCount > upCount ? 1 : upCount > downCount ? -1 : 0;
        this.lastScrollTop = currentScrollTop;
    },

    /**
     * 智能预测加载区域
     * @param {number} viewportHeight 视口高度
     * @param {number} scrollTop 滚动位置
     * @returns {Object} 预测加载区域
     */
    getPredictedLoadArea(viewportHeight, scrollTop) {
        const baseBuffer = getMasonryConfig('BASE_BUFFER_SIZE');
        const scrollVelocity = Math.abs(window.scrollVelocity || 0);
        let dynamicBuffer = baseBuffer;
        if (scrollVelocity > 100) {
            dynamicBuffer = baseBuffer * 2;
        } else if (scrollVelocity > 50) {
            dynamicBuffer = baseBuffer * 1.5;
        }
        let predictedTop = scrollTop - dynamicBuffer;
        let predictedBottom = scrollTop + viewportHeight + dynamicBuffer;
        if (this.scrollDirection === 1) {
            predictedBottom += dynamicBuffer * 0.5;
        } else if (this.scrollDirection === -1) {
            predictedTop -= dynamicBuffer * 0.5;
        }
        return { predictedTop, predictedBottom };
    },

    /**
     * 触发可见图片的懒加载（备用机制，仅在IntersectionObserver失效时使用）
     */
    async trigger() {
        // 节流，避免和IntersectionObserver冲突
        const now = Date.now();
        if (now - this.lastTriggerTime < 1000) {
            return;
        }
        this.lastTriggerTime = now;
        if (this.isProcessing) return;
        this.isProcessing = true;
        try {
            const { contentGrid } = elements;
            if (!contentGrid) return;
            // 检查是否处于虚拟滚动模式
            const isVirtualScroll = safeClassList(contentGrid, 'contains', 'virtual-scroll-mode');
            if (!isVirtualScroll) return;
            // 获取懒加载模块
            const { enqueueLazyImage } = await getLazyloadModule();
            // 计算当前可见区域
            const viewportHeight = window.innerHeight;
            const currentScrollTop = window.scrollY;
            const visibleTop = currentScrollTop;
            const visibleBottom = currentScrollTop + viewportHeight;
            // 只处理当前可见区域内的图片
            const images = Array.from(contentGrid.querySelectorAll('img.lazy-image'));
            let processedCount = 0;
            const maxProcessCount = 5;
            for (const img of images) {
                if (processedCount >= maxProcessCount) break;
                const imgId = img.dataset.src;
                if (this.processedImages.has(imgId)) continue;
                const rect = img.getBoundingClientRect();
                const imgTop = currentScrollTop + rect.top;
                const imgBottom = currentScrollTop + rect.bottom;
                if (imgTop >= visibleTop && imgBottom <= visibleBottom) {
                    if (img.dataset.src && !safeClassList(img, 'contains', 'loaded') && img.dataset.thumbStatus !== 'processing') {
                        masonryLogger.debug('虚拟滚动备用：触发图片懒加载', { src: img.dataset.src });
                        enqueueLazyImage(img, { rect });
                        this.processedImages.add(imgId);
                        processedCount++;
                    }
                }
            }
            // 定期清理已处理图片集合
            if (this.processedImages.size > 50) {
                const recentProcessed = Array.from(this.processedImages).slice(-20);
                this.processedImages.clear();
                recentProcessed.forEach(id => this.processedImages.add(id));
            }
        } catch (error) {
            masonryLogger.error('虚拟滚动懒加载触发失败', error);
        } finally {
            this.isProcessing = false;
        }
    },

    /**
     * 重置处理状态（页面切换等场景）
     */
    reset() {
        this.processedImages.clear();
        this.lastTriggerTime = 0;
        this.isProcessing = false;
    },

    /**
     * 清理资源
     */
    cleanup() {
        this.reset();
    }
};

/**
 * 触发可见图片的懒加载（对外接口）
 */
async function triggerVisibleImagesLazyLoad() {
    await virtualScrollLazyLoader.trigger();
}

/**
 * 创建虚拟滚动器的渲染回调函数
 * @param {Object} item 数据项
 * @param {HTMLElement} element 渲染的DOM元素
 * @param {number} index 项目索引
 * @returns {HTMLElement} 渲染后的元素
 */
export function createVirtualScrollRenderCallback(item, element, index) {
    if (item.type === 'album') {
        // 相册渲染
        return renderAlbumForVirtualScroll(item.data, element, index);
    } else {
        // 媒体文件渲染（图片或视频）
        return renderMediaForVirtualScroll(item.type, item.data, element, index);
    }
}

/**
 * 虚拟滚动器渲染相册项目
 * @param {Object} albumData 相册数据
 * @param {HTMLElement} element 渲染的DOM元素
 * @param {number} index 项目索引
 * @returns {HTMLElement} 渲染后的元素
 */
function renderAlbumForVirtualScroll(albumData, element, index) {
    // 实现相册渲染逻辑（此处为占位符）
    element.className = 'album-card virtual-item';
    element.textContent = albumData.name || `相册 ${index}`;
    return element;
}

/**
 * 虚拟滚动器渲染媒体项目
 * @param {string} type 媒体类型（'photo' 或 'video'）
 * @param {Object} mediaData 媒体数据
 * @param {HTMLElement} element 渲染的DOM元素
 * @param {number} index 项目索引
 * @returns {HTMLElement} 渲染后的外层容器
 */
function renderMediaForVirtualScroll(type, mediaData, element, index) {
    const isVideo = type === 'video';
    // 精确宽高比
    const aspectRatio = (mediaData.height && mediaData.width)
        ? mediaData.width / mediaData.height
        : (isVideo ? 16/9 : 1);

    // 设置基本样式
    element.className = 'photo-item virtual-item group block bg-gray-800 rounded-lg overflow-hidden cursor-pointer';
    safeSetStyle(element, {
        position: 'absolute',
        aspectRatio: aspectRatio
    });

    // 设置尺寸数据
    element.setAttribute('data-width', mediaData.width || 0);
    element.setAttribute('data-height', mediaData.height || 0);
    element.setAttribute('data-aspect-ratio', aspectRatio.toFixed(3));

    // 创建相对定位容器
    const relativeDiv = document.createElement('div');
    relativeDiv.className = 'relative w-full h-full';
    safeSetStyle(relativeDiv, 'aspectRatio', aspectRatio);

    // 占位层
    const placeholder = document.createElement('div');
    placeholder.className = 'image-placeholder absolute inset-0';
    if (!mediaData.height || !mediaData.width) {
        safeClassList(placeholder, 'add', 'min-h-[200px]');
    }
    relativeDiv.appendChild(placeholder);

    // 加载覆盖层
    const loadingOverlay = document.createElement('div');
    loadingOverlay.className = 'loading-overlay';
    const progressHolder = document.createElement('div');
    safeSetInnerHTML(progressHolder, `
        <svg class="progress-circle" viewBox="0 0 36 36" aria-hidden="true">
            <circle class="progress-circle-track" cx="18" cy="18" r="16" stroke-width="4"></circle>
            <circle class="progress-circle-bar" cx="18" cy="18" r="16" stroke-width="4"></circle>
        </svg>
    `);
    loadingOverlay.appendChild(progressHolder);
    relativeDiv.appendChild(loadingOverlay);

    // 图片元素
    const img = document.createElement('img');
    img.className = 'w-full h-full object-cover absolute inset-0 lazy-image transition-opacity duration-300';
    img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E";
    img.alt = isVideo ? '视频缩略图' : '图片缩略图';
    img.dataset.src = mediaData.thumbnailUrl;

    // 图片事件监听
    img.onload = () => {
        safeClassList(img, 'add', 'loaded');
        triggerMasonryUpdate();
    };
    img.onerror = () => {
        safeClassList(img, 'add', 'error');
        triggerMasonryUpdate();
    };
    relativeDiv.appendChild(img);

    // 将新渲染的图片添加到 Intersection Observer
    setTimeout(async () => {
        if (!img._observed && safeClassList(img, 'contains', 'lazy-image')) {
            try {
                if (!globalImageObserverRef) {
                    const lazyload = await getLazyloadModule();
                    globalImageObserverRef = lazyload.globalImageObserver || lazyload.setupLazyLoading();
                }
                globalImageObserverRef.observe(img);
                img._observed = true;
            } catch (error) {
                masonryLogger.warn('添加图片到Intersection Observer失败', error);
            }
        }
    }, 10);

    // 视频添加播放按钮覆盖层
    if (isVideo) {
        const overlay = document.createElement('div');
        overlay.className = 'video-thumbnail-overlay';
        const playBtn = document.createElement('div');
        playBtn.className = 'video-play-button';
        safeSetInnerHTML(playBtn, `
            <svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
                <path d="M24 18v28l24-14-24-14z"></path>
            </svg>
        `);
        overlay.appendChild(playBtn);
        relativeDiv.appendChild(overlay);
    }

    element.appendChild(relativeDiv);

    // 外层容器
    const gridItem = document.createElement('div');
    gridItem.className = 'grid-item photo-link';
    gridItem.setAttribute('data-url', mediaData.originalUrl);
    gridItem.setAttribute('data-index', index);
    gridItem.setAttribute('data-width', mediaData.width || 0);
    gridItem.setAttribute('data-height', mediaData.height || 0);
    gridItem.appendChild(element);

    return gridItem;
}

// 将虚拟滚动懒加载器暴露到全局（便于清理）
if (typeof window !== 'undefined') {
    window.virtualScrollLazyLoader = virtualScrollLazyLoader;
}