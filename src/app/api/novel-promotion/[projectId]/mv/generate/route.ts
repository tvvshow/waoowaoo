import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { submitTask } from '@/lib/task/submitter'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { TASK_TYPE } from '@/lib/task/types'
import { withTaskUiPayload } from '@/lib/task/ui-payload'
import { buildDefaultTaskBillingInfo } from '@/lib/billing'
import { getProjectModelConfig, resolveProjectModelCapabilityGenerationOptions } from '@/lib/config-service'
import { parseModelKeyStrict, type CapabilityValue } from '@/lib/model-config-contract'

type Primitive = string | number | boolean

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function parseString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (lowered === 'true') return true
    if (lowered === 'false') return false
  }
  return fallback
}

function parseCount(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(4, parsed))
}

function toRuntimeSelections(value: unknown): Record<string, CapabilityValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const selections: Record<string, CapabilityValue> = {}
  for (const [field, raw] of Object.entries(record)) {
    if (field === 'aspectRatio') continue
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      selections[field] = raw
    }
  }
  return selections
}

async function resolveEpisodeOrThrow(input: {
  projectDataId: string
  episodeId: string
}) {
  const episode = await prisma.novelPromotionEpisode.findFirst({
    where: {
      id: input.episodeId,
      novelPromotionProjectId: input.projectDataId,
    },
  })
  if (!episode) throw new ApiError('NOT_FOUND')
  return episode
}

async function enqueueVideoTasks(input: {
  userId: string
  locale: ReturnType<typeof resolveRequiredTaskLocale>
  requestId: string | null
  projectId: string
  episodeId: string
  videoModel: string
  generationOptions: Record<string, Primitive>
}) {
  const eligiblePanels = await prisma.novelPromotionPanel.findMany({
    where: {
      storyboard: { episodeId: input.episodeId },
      imageUrl: { not: null },
      OR: [{ videoUrl: null }, { videoUrl: '' }],
    },
    select: { id: true },
  })

  const payloadBase: Record<string, unknown> = {
    videoModel: input.videoModel,
    ...(Object.keys(input.generationOptions).length > 0
      ? { generationOptions: input.generationOptions }
      : {}),
  }

  const tasks = await Promise.all(
    eligiblePanels.map(async (panel) =>
      await submitTask({
        userId: input.userId,
        locale: input.locale,
        requestId: input.requestId,
        projectId: input.projectId,
        episodeId: input.episodeId,
        type: TASK_TYPE.VIDEO_PANEL,
        targetType: 'NovelPromotionPanel',
        targetId: panel.id,
        payload: withTaskUiPayload(payloadBase, {
          intent: 'generate',
          hasOutputAtStart: false,
        }),
        dedupeKey: `video_panel:${panel.id}`,
        billingInfo: buildDefaultTaskBillingInfo(TASK_TYPE.VIDEO_PANEL, payloadBase),
      }),
    ),
  )

  return {
    panelCount: eligiblePanels.length,
    taskIds: tasks.map((task) => task.taskId),
  }
}

/**
 * POST /api/novel-promotion/[projectId]/mv/generate
 *
 * mode=bootstrap:
 * - use text-model pipeline (clips -> script -> storyboard) in background task
 * - then enqueue panel image generation
 *
 * mode=video:
 * - enqueue video tasks for panels already having images
 */
export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuth(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session, project, novelData } = authResult

  if (project.mode !== 'novel-promotion') {
    throw new ApiError('INVALID_PARAMS')
  }

  const body = asRecord(await request.json().catch(() => ({})))
  const locale = resolveRequiredTaskLocale(request, body)
  const requestId = getRequestId(request) ?? null
  const mode = parseString(body.mode).toLowerCase() === 'video' ? 'video' : 'bootstrap'
  const episodeId = parseString(body.episodeId)

  if (!episodeId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const episode = await resolveEpisodeOrThrow({
    projectDataId: novelData.id,
    episodeId,
  })
  const modelConfig = await getProjectModelConfig(projectId, session.user.id)

  if (mode === 'video') {
    const requestedVideoModel = parseString(body.videoModel)
    const videoModel = requestedVideoModel || modelConfig.videoModel || ''
    if (!videoModel || !parseModelKeyStrict(videoModel)) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'VIDEO_MODEL_REQUIRED',
        field: 'videoModel',
      })
    }

    const runtimeSelections = toRuntimeSelections(body.generationOptions)
    const capabilityOptions = await resolveProjectModelCapabilityGenerationOptions({
      projectId,
      userId: session.user.id,
      modelType: 'video',
      modelKey: videoModel,
      runtimeSelections,
    })
    const videoGenerationOptions = {
      ...capabilityOptions,
      ...runtimeSelections,
    }

    const videoQueued = await enqueueVideoTasks({
      userId: session.user.id,
      locale,
      requestId,
      projectId,
      episodeId: episode.id,
      videoModel,
      generationOptions: videoGenerationOptions,
    })

    return NextResponse.json({
      success: true,
      mode: 'video',
      episodeId: episode.id,
      queuedVideoPanels: videoQueued.panelCount,
      videoTaskIds: videoQueued.taskIds,
    })
  }

  const lyrics = parseString(body.lyrics)
  if (!lyrics && !episode.novelText) {
    throw new ApiError('INVALID_PARAMS', {
      message: 'lyrics is required when episode has no novelText',
    })
  }

  const candidateCount = parseCount(body.candidateCount ?? body.count, 1)
  const clearExisting = parseBoolean(body.clearExisting, false)
  const submitImageTasks = parseBoolean(body.submitImageTasks, true)

  const result = await submitTask({
    userId: session.user.id,
    locale,
    requestId,
    projectId,
    episodeId: episode.id,
    type: TASK_TYPE.MV_BOOTSTRAP,
    targetType: 'NovelPromotionEpisode',
    targetId: episode.id,
    payload: {
      episodeId: episode.id,
      lyrics,
      clearExisting,
      submitImageTasks,
      candidateCount,
    },
    dedupeKey: `mv_bootstrap:${episode.id}`,
    priority: 2,
  })

  return NextResponse.json({
    ...result,
    success: true,
    mode: 'bootstrap',
    episodeId: episode.id,
  })
})
