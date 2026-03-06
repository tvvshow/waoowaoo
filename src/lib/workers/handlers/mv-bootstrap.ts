import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { submitTask } from '@/lib/task/submitter'
import { TASK_STATUS, TASK_TYPE, type TaskJobData } from '@/lib/task/types'
import { reportTaskProgress } from '@/lib/workers/shared'
import { assertTaskActive } from '@/lib/workers/utils'
import { buildImageBillingPayload, getProjectModelConfig } from '@/lib/config-service'
import { withTaskUiPayload } from '@/lib/task/ui-payload'

type AnyRecord = Record<string, unknown>

function asRecord(value: unknown): AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as AnyRecord
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return fallback
}

function readCount(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(4, n))
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForTaskCompletion(params: {
  taskId: string
  timeoutMs: number
  pollMs: number
}) {
  const startedAt = Date.now()
  for (;;) {
    const task = await prisma.task.findUnique({
      where: { id: params.taskId },
      select: {
        id: true,
        status: true,
        errorCode: true,
        errorMessage: true,
      },
    })

    if (!task) {
      throw new Error(`sub task not found: ${params.taskId}`)
    }

    if (task.status === TASK_STATUS.COMPLETED) {
      return
    }

    if (task.status === TASK_STATUS.FAILED || task.status === TASK_STATUS.DISMISSED) {
      throw new Error(
        `sub task failed: ${params.taskId}, code=${task.errorCode || 'UNKNOWN'}, message=${task.errorMessage || 'unknown'}`,
      )
    }

    if (Date.now() - startedAt > params.timeoutMs) {
      throw new Error(`sub task timeout: ${params.taskId}`)
    }

    await sleep(params.pollMs)
  }
}

export async function handleMvBootstrapTask(job: Job<TaskJobData>) {
  const payload = asRecord(job.data.payload)
  const episodeId = readString(payload.episodeId || job.data.episodeId)
  if (!episodeId) throw new Error('episodeId is required')

  const lyrics = readString(payload.lyrics)
  const clearExisting = readBoolean(payload.clearExisting, false)
  const submitImageTasks = readBoolean(payload.submitImageTasks, true)
  const candidateCount = readCount(payload.candidateCount ?? payload.count)
  const requestId = job.data.trace?.requestId || null

  const project = await prisma.project.findUnique({
    where: { id: job.data.projectId },
    select: { id: true, mode: true },
  })
  if (!project) throw new Error('Project not found')
  if (project.mode !== 'novel-promotion') throw new Error('Not a novel promotion project')

  const novelData = await prisma.novelPromotionProject.findUnique({
    where: { projectId: job.data.projectId },
    select: { id: true },
  })
  if (!novelData) throw new Error('Novel promotion data not found')

  const episode = await prisma.novelPromotionEpisode.findFirst({
    where: {
      id: episodeId,
      novelPromotionProjectId: novelData.id,
    },
    select: {
      id: true,
      novelText: true,
    },
  })
  if (!episode) throw new Error('Episode not found')

  await reportTaskProgress(job, 8, {
    stage: 'mv_bootstrap_prepare',
    stageLabel: 'MV bootstrap prepare',
    displayMode: 'detail',
  })
  await assertTaskActive(job, 'mv_bootstrap_prepare')

  if (clearExisting) {
    await prisma.$transaction(async (tx) => {
      await tx.novelPromotionPanel.deleteMany({
        where: {
          storyboard: { episodeId: episode.id },
        },
      })
      await tx.novelPromotionStoryboard.deleteMany({
        where: { episodeId: episode.id },
      })
      await tx.novelPromotionClip.deleteMany({
        where: { episodeId: episode.id },
      })
    })
  }

  const mergedLyrics = lyrics || episode.novelText || ''
  if (!mergedLyrics.trim()) {
    throw new Error('lyrics or episode.novelText is required')
  }
  await prisma.novelPromotionEpisode.update({
    where: { id: episode.id },
    data: { novelText: mergedLyrics },
  })

  await reportTaskProgress(job, 16, {
    stage: 'mv_bootstrap_clips',
    stageLabel: 'Build clips from lyrics',
    displayMode: 'detail',
  })
  await assertTaskActive(job, 'mv_bootstrap_clips')
  const clipsTask = await submitTask({
    userId: job.data.userId,
    locale: job.data.locale,
    requestId,
    projectId: job.data.projectId,
    episodeId: episode.id,
    type: TASK_TYPE.CLIPS_BUILD,
    targetType: 'NovelPromotionEpisode',
    targetId: episode.id,
    payload: {
      episodeId: episode.id,
      displayMode: 'detail',
    },
    dedupeKey: `mv_bootstrap:${job.data.taskId}:clips`,
    priority: 2,
  })
  await waitForTaskCompletion({
    taskId: clipsTask.taskId,
    timeoutMs: 1000 * 60 * 20,
    pollMs: 1500,
  })

  await reportTaskProgress(job, 36, {
    stage: 'mv_bootstrap_script',
    stageLabel: 'Generate screenplay',
    displayMode: 'detail',
  })
  await assertTaskActive(job, 'mv_bootstrap_script')
  const scriptTask = await submitTask({
    userId: job.data.userId,
    locale: job.data.locale,
    requestId,
    projectId: job.data.projectId,
    episodeId: episode.id,
    type: TASK_TYPE.STORY_TO_SCRIPT_RUN,
    targetType: 'NovelPromotionEpisode',
    targetId: episode.id,
    payload: {
      episodeId: episode.id,
      content: mergedLyrics,
      displayMode: 'detail',
    },
    dedupeKey: `mv_bootstrap:${job.data.taskId}:story_to_script`,
    priority: 2,
  })
  await waitForTaskCompletion({
    taskId: scriptTask.taskId,
    timeoutMs: 1000 * 60 * 25,
    pollMs: 1500,
  })

  await reportTaskProgress(job, 56, {
    stage: 'mv_bootstrap_storyboard',
    stageLabel: 'Generate storyboard panels',
    displayMode: 'detail',
  })
  await assertTaskActive(job, 'mv_bootstrap_storyboard')
  const storyboardTask = await submitTask({
    userId: job.data.userId,
    locale: job.data.locale,
    requestId,
    projectId: job.data.projectId,
    episodeId: episode.id,
    type: TASK_TYPE.SCRIPT_TO_STORYBOARD_RUN,
    targetType: 'NovelPromotionEpisode',
    targetId: episode.id,
    payload: {
      episodeId: episode.id,
      displayMode: 'detail',
    },
    dedupeKey: `mv_bootstrap:${job.data.taskId}:script_to_storyboard`,
    priority: 2,
  })
  await waitForTaskCompletion({
    taskId: storyboardTask.taskId,
    timeoutMs: 1000 * 60 * 30,
    pollMs: 1500,
  })

  if (!submitImageTasks) {
    return {
      episodeId: episode.id,
      clipsTaskId: clipsTask.taskId,
      storyToScriptTaskId: scriptTask.taskId,
      scriptToStoryboardTaskId: storyboardTask.taskId,
      queuedImagePanels: 0,
      imageTaskIds: [] as string[],
    }
  }

  await reportTaskProgress(job, 78, {
    stage: 'mv_bootstrap_images',
    stageLabel: 'Queue panel images',
    displayMode: 'detail',
  })
  await assertTaskActive(job, 'mv_bootstrap_images')

  const modelConfig = await getProjectModelConfig(job.data.projectId, job.data.userId)
  if (!modelConfig.storyboardModel) {
    throw new Error('STORYBOARD_MODEL_NOT_CONFIGURED')
  }

  const billingPayloadBase = await buildImageBillingPayload({
    projectId: job.data.projectId,
    userId: job.data.userId,
    imageModel: modelConfig.storyboardModel,
    basePayload: {
      candidateCount,
      count: candidateCount,
    },
  })

  const panels = await prisma.novelPromotionPanel.findMany({
    where: {
      storyboard: { episodeId: episode.id },
    },
    select: { id: true },
    orderBy: {
      createdAt: 'asc',
    },
  })

  const imageTaskIds: string[] = []
  for (let index = 0; index < panels.length; index += 1) {
    const panel = panels[index]
    const billingPayload = {
      ...billingPayloadBase,
      panelId: panel.id,
      mvSegmentIndex: index + 1,
      mvSegmentTotal: panels.length,
    }
    const imageTask = await submitTask({
      userId: job.data.userId,
      locale: job.data.locale,
      requestId,
      projectId: job.data.projectId,
      episodeId: episode.id,
      type: TASK_TYPE.IMAGE_PANEL,
      targetType: 'NovelPromotionPanel',
      targetId: panel.id,
      payload: withTaskUiPayload(billingPayload, {
        intent: 'generate',
        hasOutputAtStart: false,
      }),
      dedupeKey: `image_panel:${panel.id}:${candidateCount}`,
      priority: 1,
    })
    imageTaskIds.push(imageTask.taskId)
  }

  await reportTaskProgress(job, 96, {
    stage: 'mv_bootstrap_done',
    stageLabel: 'MV bootstrap done',
    displayMode: 'detail',
  })

  return {
    episodeId: episode.id,
    clipsTaskId: clipsTask.taskId,
    storyToScriptTaskId: scriptTask.taskId,
    scriptToStoryboardTaskId: storyboardTask.taskId,
    queuedImagePanels: imageTaskIds.length,
    imageTaskIds,
  }
}
