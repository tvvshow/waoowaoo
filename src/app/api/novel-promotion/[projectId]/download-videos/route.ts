import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import archiver from 'archiver'
import { getCOSClient, toFetchableUrl } from '@/lib/cos'
import { resolveStorageKeyFromMediaValue } from '@/lib/media/service'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { Readable } from 'stream'

interface PanelData {
  panelIndex: number | null
  description: string | null
  videoUrl: string | null
  lipSyncVideoUrl: string | null
}

interface StoryboardData {
  id: string
  clipId: string
  panels?: PanelData[]
}

interface ClipData {
  id: string
}

interface EpisodeData {
  storyboards?: StoryboardData[]
  clips?: ClipData[]
}

const SINGLE_VIDEO_TIMEOUT_MS = Number(process.env.VIDEO_DOWNLOAD_TIMEOUT_MS || 90_000)

function sanitizeDescription(raw: string): string {
  return raw.slice(0, 50).replace(/[\\/:*?"<>|]/g, '_')
}

async function fetchBufferWithTimeout(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(toFetchableUrl(url), {
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) {
      throw new Error(`fetch failed: ${response.status} ${response.statusText}`)
    }
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

async function cosGetObjectWithTimeout(storageKey: string, timeoutMs: number): Promise<Buffer> {
  const cos = getCOSClient()

  return await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`COS getObject timeout after ${timeoutMs}ms: ${storageKey}`))
    }, timeoutMs)

    cos.getObject(
      {
        Bucket: process.env.COS_BUCKET!,
        Region: process.env.COS_REGION!,
        Key: storageKey,
      },
      (err, data) => {
        clearTimeout(timer)
        if (err) {
          reject(err)
          return
        }
        resolve(data.Body as Buffer)
      },
    )
  })
}

async function loadVideoBuffer(videoUrl: string, isLocalStorage: boolean, timeoutMs: number): Promise<Buffer> {
  const storageKey = await resolveStorageKeyFromMediaValue(videoUrl)

  if (videoUrl.startsWith('http://') || videoUrl.startsWith('https://')) {
    return await fetchBufferWithTimeout(videoUrl, timeoutMs)
  }

  if (storageKey) {
    if (isLocalStorage) {
      const { getSignedUrl } = await import('@/lib/cos')
      return await fetchBufferWithTimeout(getSignedUrl(storageKey), timeoutMs)
    }
    return await cosGetObjectWithTimeout(storageKey, timeoutMs)
  }

  return await fetchBufferWithTimeout(videoUrl, timeoutMs)
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> }
) => {
  const { projectId } = await context.params

  // 解析请求体
  const body = await request.json()
  const { episodeId, panelPreferences } = body as {
    episodeId?: string
    panelPreferences?: Record<string, boolean>  // key: panelKey, value: true=口型同步, false=原始
  }

  // 🔐 统一权限验证
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { project } = authResult

  // 根据是否指定 episodeId 来获取数据
  let episodes: EpisodeData[] = []

  if (episodeId) {
    // 只获取指定剧集的数据
    const episode = await prisma.novelPromotionEpisode.findUnique({
      where: { id: episodeId },
      include: {
        storyboards: {
          include: {
            panels: { orderBy: { panelIndex: 'asc' } }
          },
          orderBy: { createdAt: 'asc' }
        },
        clips: {
          orderBy: { createdAt: 'asc' }
        }
      }
    })
    if (episode) {
      episodes = [episode]
    }
  } else {
    // 获取所有剧集的数据
    const npData = await prisma.novelPromotionProject.findFirst({
      where: { projectId },
      include: {
        episodes: {
          include: {
            storyboards: {
              include: {
                panels: { orderBy: { panelIndex: 'asc' } }
              },
              orderBy: { createdAt: 'asc' }
            },
            clips: {
              orderBy: { createdAt: 'asc' }
            }
          }
        }
      }
    })
    episodes = npData?.episodes || []
  }

  if (episodes.length === 0) {
    throw new ApiError('NOT_FOUND')
  }

  // 收集所有有视频的 panel
  interface VideoItem {
    description: string
    videoUrl: string
    clipIndex: number  // 使用 clip 在数组中的索引
    panelIndex: number
  }
  const videos: VideoItem[] = []

  // 从 episodes 中获取所有 storyboards 和 clips
  const allStoryboards: StoryboardData[] = []
  const allClips: ClipData[] = []
  for (const episode of episodes) {
    allStoryboards.push(...(episode.storyboards || []))
    allClips.push(...(episode.clips || []))
  }

  // 遍历所有 storyboard 和 panel
  for (const storyboard of allStoryboards) {
    // 使用 clip 在 clips 数组中的索引来排序（兼容 Agent 模式）
    const clipIndex = allClips.findIndex((clip) => clip.id === storyboard.clipId)

    // 使用独立的 Panel 记录
    const panels = storyboard.panels || []
    for (const panel of panels) {
      // 构建 panelKey 用于查找偏好
      const panelKey = `${storyboard.id}-${panel.panelIndex || 0}`
      // 获取该 panel 的偏好，默认 true（口型同步优先）
      const preferLipSync = panelPreferences?.[panelKey] ?? true

      // 根据用户偏好选择视频类型
      let videoUrl: string | null = null

      if (preferLipSync) {
        // 优先口型同步视频，其次原始视频
        videoUrl = panel.lipSyncVideoUrl || panel.videoUrl
      } else {
        // 优先原始视频，其次口型同步视频（如果只有口型同步视频也下载）
        videoUrl = panel.videoUrl || panel.lipSyncVideoUrl
      }

      if (videoUrl) {
        videos.push({
          description: panel.description || `镜头`,
          videoUrl: videoUrl,
          clipIndex: clipIndex >= 0 ? clipIndex : 999,  // 找不到时排最后
          panelIndex: panel.panelIndex || 0,
        })
      }
    }
  }

  // 按 clipIndex 和 panelIndex 排序
  videos.sort((a, b) => {
    if (a.clipIndex !== b.clipIndex) {
      return a.clipIndex - b.clipIndex
    }
    return a.panelIndex - b.panelIndex
  })

  // 重新分配连续的全局索引
  const indexedVideos = videos.map((v, idx) => ({
    ...v,
    index: idx + 1
  }))

  if (indexedVideos.length === 0) {
    throw new ApiError('INVALID_PARAMS')
  }

  _ulogInfo(`Preparing to download ${indexedVideos.length} videos for project ${projectId}`)

  // 视频本身已压缩，zip 使用 store 模式减少 CPU 开销。
  const archive = archiver('zip', { zlib: { level: 0 } })
  const archiveStream = Readable.toWeb(archive) as ReadableStream

  archive.on('warning', (error) => {
    _ulogError('Archive warning:', error)
  })
  archive.on('error', (error) => {
    _ulogError('Archive error:', error)
  })

  const isLocal = process.env.STORAGE_TYPE === 'local'
  void (async () => {
    const failed: Array<{ index: number; reason: string; url: string }> = []
    let successCount = 0

    for (const video of indexedVideos) {
      try {
        _ulogInfo(`Downloading video ${video.index}: ${video.videoUrl}`)
        const videoData = await loadVideoBuffer(video.videoUrl, isLocal, SINGLE_VIDEO_TIMEOUT_MS)
        const safeDesc = sanitizeDescription(video.description || '镜头')
        const fileName = `${String(video.index).padStart(3, '0')}_${safeDesc}.mp4`
        archive.append(videoData, { name: fileName })
        successCount += 1
        _ulogInfo(`Added ${fileName} to archive`)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failed.push({
          index: video.index,
          reason,
          url: video.videoUrl,
        })
        _ulogError(`Failed to download video ${video.index}: ${reason}`)
      }
    }

    if (failed.length > 0) {
      const lines = [
        `Failed videos: ${failed.length}/${indexedVideos.length}`,
        '',
        ...failed.map((item) => `#${item.index} ${item.reason} | ${item.url}`),
      ]
      archive.append(Buffer.from(lines.join('\n'), 'utf-8'), { name: '_failed_videos.txt' })
      _ulogInfo(`Video archive completed with failures: ${failed.length}`)
    } else {
      _ulogInfo(`Video archive completed successfully: ${successCount}/${indexedVideos.length}`)
    }

    await archive.finalize()
  })().catch((error) => {
    _ulogError('Video archive pipeline failed:', error)
    archive.destroy(error instanceof Error ? error : new Error(String(error)))
  })

  return new Response(archiveStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(project.name)}_videos.zip"`,
      'Cache-Control': 'no-store',
    },
  })
})
