'use client'

import { useTranslations } from 'next-intl'
import { GlassButton, GlassChip, GlassSurface } from '@/components/ui/primitives'
import TaskStatusInline from '@/components/task/TaskStatusInline'
import { resolveTaskPresentationState } from '@/lib/task/presentation'

interface StoryboardHeaderProps {
  totalSegments: number
  totalPanels: number
  isDownloadingImages: boolean
  runningCount: number
  pendingPanelCount: number
  isBatchSubmitting: boolean
  isMvBootstrapSubmitting: boolean
  isMvVideoSubmitting: boolean
  onDownloadAllImages: () => void
  onGenerateAllPanels: () => void
  onBootstrapMv: (input: { lyrics: string; clearExisting: boolean }) => Promise<unknown>
  onQueueMvVideos: () => Promise<unknown>
  onBack: () => void
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return String(error)
}

export default function StoryboardHeader({
  totalSegments,
  totalPanels,
  isDownloadingImages,
  runningCount,
  pendingPanelCount,
  isBatchSubmitting,
  isMvBootstrapSubmitting,
  isMvVideoSubmitting,
  onDownloadAllImages,
  onGenerateAllPanels,
  onBootstrapMv,
  onQueueMvVideos,
  onBack
}: StoryboardHeaderProps) {
  const t = useTranslations('storyboard')
  const storyboardTaskRunningState = runningCount > 0
    ? resolveTaskPresentationState({
      phase: 'processing',
      intent: 'generate',
      resource: 'image',
      hasOutput: true,
    })
    : null

  const handleBootstrapMv = async () => {
    const lyrics = window.prompt('请输入歌词或提示词（可用换行分段）')
    if (!lyrics || !lyrics.trim()) return

    const clearExisting = window.confirm('是否清空当前分镜并按输入重建？确定=清空重建，取消=保留并追加。')
    try {
      await onBootstrapMv({
        lyrics,
        clearExisting,
      })
    } catch (error) {
      alert(`MV分段生图失败: ${resolveErrorMessage(error)}`)
    }
  }

  const handleQueueMvVideos = async () => {
    try {
      await onQueueMvVideos()
    } catch (error) {
      alert(`MV批量视频排队失败: ${resolveErrorMessage(error)}`)
    }
  }

  return (
    <GlassSurface variant="elevated" className="space-y-4 p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-[var(--glass-text-primary)]">{t('header.storyboardPanel')}</h3>
          <p className="text-sm text-[var(--glass-text-secondary)]">
            {t('header.segmentsCount', { count: totalSegments })}
            {t('header.panelsCount', { count: totalPanels })}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {runningCount > 0 ? (
            <GlassChip tone="info" icon={<span className="h-2 w-2 animate-pulse rounded-full bg-current" />}>
              <span className="inline-flex items-center gap-1.5">
                <TaskStatusInline state={storyboardTaskRunningState} />
                <span>({runningCount})</span>
              </span>
            </GlassChip>
          ) : null}
          <GlassChip tone="neutral">{t('header.concurrencyLimit', { count: 10 })}</GlassChip>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {pendingPanelCount > 0 ? (
          <GlassButton
            variant="primary"
            loading={isBatchSubmitting}
            onClick={onGenerateAllPanels}
            disabled={runningCount > 0}
          >
            {t('header.generateAllPanels')} ({pendingPanelCount})
          </GlassButton>
        ) : null}

        <GlassButton
          variant="secondary"
          loading={isDownloadingImages}
          onClick={onDownloadAllImages}
          disabled={totalPanels === 0}
        >
          {isDownloadingImages ? t('header.downloading') : t('header.downloadAll')}
        </GlassButton>

        <GlassButton
          variant="secondary"
          loading={isMvBootstrapSubmitting}
          onClick={handleBootstrapMv}
          disabled={isMvVideoSubmitting}
        >
          MV分段生图
        </GlassButton>

        <GlassButton
          variant="secondary"
          loading={isMvVideoSubmitting}
          onClick={handleQueueMvVideos}
          disabled={isMvBootstrapSubmitting || totalPanels === 0}
        >
          MV批量生视频
        </GlassButton>

        <GlassButton variant="ghost" onClick={onBack}>{t('header.back')}</GlassButton>
      </div>
    </GlassSurface>
  )
}
