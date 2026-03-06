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

      // 通过原生 form 直连下载接口，浏览器可直接处理流式附件下载，
      // 避免 fetch + blob 必须等待整包完成导致“长时间转圈”。
      const frameName = 'video-download-frame'
      let iframe = document.querySelector<HTMLIFrameElement>(`iframe[name="${frameName}"]`)
      if (!iframe) {
        iframe = document.createElement('iframe')
        iframe.name = frameName
        iframe.style.display = 'none'
        document.body.appendChild(iframe)
      }

      const form = document.createElement('form')
      form.method = 'POST'
      form.action = `/api/novel-promotion/${projectId}/download-videos`
      form.target = frameName
      form.style.display = 'none'

      const episodeField = document.createElement('input')
      episodeField.type = 'hidden'
      episodeField.name = 'episodeId'
      episodeField.value = episodeId
      form.appendChild(episodeField)

      const preferencesField = document.createElement('input')
      preferencesField.type = 'hidden'
      preferencesField.name = 'panelPreferences'
      preferencesField.value = JSON.stringify(panelPreferences)
      form.appendChild(preferencesField)

      document.body.appendChild(form)
      form.submit()
      document.body.removeChild(form)

      _ulogInfo('[下载视频] 已提交服务端打包请求')
    } catch (error: unknown) {
      _ulogError('[下载视频] 错误:', error)
      alert(`${t('stage.downloadFailed')}: ${getErrorMessage(error) || t('errors.unknownError')}`)
    } finally {
      // 表单提交后下载在浏览器层继续进行，不再等待整包完成再结束 loading。
      window.setTimeout(() => {
        setIsDownloading(false)
        setDownloadProgress(null)
      }, 1200)
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
