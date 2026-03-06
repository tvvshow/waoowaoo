'use client'

import { useCallback, useState } from 'react'
import { logError as _ulogError, logInfo as _ulogInfo } from '@/lib/logging/core'
import type { VideoPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import { getErrorMessage } from './utils'

interface UseVideoDownloadAllParams {
  projectId: string
  episodeId: string
  t: (key: string) => string
  allPanels: VideoPanel[]
  panelVideoPreference: Map<string, boolean>
}

function parseDownloadFileName(contentDisposition: string | null, fallback: string): string {
  if (!contentDisposition) return fallback

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }

  const quotedMatch = contentDisposition.match(/filename="([^"]+)"/i)
  if (quotedMatch?.[1]) return quotedMatch[1]

  return fallback
}

export function useVideoDownloadAll({
  projectId,
  episodeId,
  t,
  allPanels,
  panelVideoPreference,
}: UseVideoDownloadAllParams) {
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<{ current: number; total: number } | null>(null)

  const videosWithUrl = allPanels.filter((panel) => panel.videoUrl).length

  const handleDownloadAllVideos = useCallback(async () => {
    if (videosWithUrl === 0) return
    setIsDownloading(true)
    setDownloadProgress(null)

    try {
      const panelPreferences: Record<string, boolean> = {}
      allPanels.forEach((panel) => {
        const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
        panelPreferences[panelKey] = panelVideoPreference.get(panelKey) ?? true
      })

      _ulogInfo('[下载视频] 请求服务端打包...')
      const response = await fetch(`/api/novel-promotion/${projectId}/download-videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          episodeId,
          panelPreferences,
        }),
      })

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({})) as Record<string, unknown>
        const message = typeof errorPayload.message === 'string' ? errorPayload.message : t('stage.downloadFailed')
        throw new Error(message)
      }

      const zipBlob = await response.blob()
      const fallbackName = `videos_${new Date().toISOString().slice(0, 10)}.zip`
      const fileName = parseDownloadFileName(response.headers.get('content-disposition'), fallbackName)
      const url = window.URL.createObjectURL(zipBlob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(anchor)
      _ulogInfo('[下载视频] 完成!')
    } catch (error: unknown) {
      _ulogError('[下载视频] 错误:', error)
      alert(`${t('stage.downloadFailed')}: ${getErrorMessage(error) || t('errors.unknownError')}`)
    } finally {
      setIsDownloading(false)
      setDownloadProgress(null)
    }
  }, [
    allPanels,
    episodeId,
    panelVideoPreference,
    projectId,
    t,
    videosWithUrl,
  ])

  return {
    isDownloading,
    downloadProgress,
    videosWithUrl,
    handleDownloadAllVideos,
  }
}
