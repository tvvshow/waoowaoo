import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { submitTask } from '@/lib/task/submitter'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { TASK_TYPE } from '@/lib/task/types'
import { buildDefaultTaskBillingInfo } from '@/lib/billing'
import { withTaskUiPayload } from '@/lib/task/ui-payload'
import {
  buildImageBillingPayload,
  getProjectModelConfig,
  resolveProjectModelCapabilityGenerationOptions,
} from '@/lib/config-service'
import { parseModelKeyStrict, type CapabilityValue } from '@/lib/model-config-contract'

type Primitive = string | number | boolean

type CharacterRef = {
  name: string
  appearance?: string
}

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

function parsePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

function parseCount(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(4, parsed))
}

function parseSegments(rawSegments: unknown, rawLyrics: unknown, limit: number): string[] {
  const fromArray = Array.isArray(rawSegments)
    ? rawSegments
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    : []

  if (fromArray.length > 0) {
    return fromArray.slice(0, limit)
  }

  const lyrics = parseString(rawLyrics)
  if (!lyrics) return []
  return lyrics
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, limit)
}

function parseCharacters(value: unknown): string | null {
  if (!Array.isArray(value)) return null

  const normalized: CharacterRef[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const name = item.trim()
      if (name) normalized.push({ name })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = parseString(record.name)
    const appearance = parseString(record.appearance)
    if (!name) continue
    normalized.push(appearance ? { name, appearance } : { name })
  }
  return normalized.length > 0 ? JSON.stringify(normalized) : null
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function buildPanelVideoPrompt(input: {
  segment: string
  segmentIndex: number
  segmentTotal: number
  baseVisualPrompt: string
  consistencyHint: string
}): string {
  const lines: string[] = [
    `MV storyboard shot ${input.segmentIndex + 1}/${input.segmentTotal}.`,
    `Lyric or beat: ${input.segment}`,
    'Keep the same main subject identity, face, costume, and cinematic style across all segments.',
  ]
  if (input.baseVisualPrompt) {
    lines.push(`Global visual direction: ${input.baseVisualPrompt}`)
  }
  if (input.consistencyHint) {
    lines.push(`Consistency anchor: ${input.consistencyHint}`)
  }
  lines.push('No text, no subtitles, no watermark.')
  return lines.join('\n')
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
 * MVP for MV adaptation:
 * 1) bootstrap mode: lyrics/segments -> clip/storyboard/panel -> enqueue image tasks
 * 2) video mode: enqueue video tasks for panels that already have images
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

  const modelConfig = await getProjectModelConfig(projectId, session.user.id)

  if (mode === 'video') {
    if (!episodeId) throw new ApiError('INVALID_PARAMS')
    const episode = await resolveEpisodeOrThrow({
      projectDataId: novelData.id,
      episodeId,
    })

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

  const maxSegments = Math.max(1, Math.min(60, Math.floor(Number(body.maxSegments) || 24)))
  const segments = parseSegments(body.segments, body.lyrics, maxSegments)
  if (segments.length === 0) {
    throw new ApiError('INVALID_PARAMS', {
      message: 'segments or lyrics is required',
    })
  }

  const submitImageTasks = parseBoolean(body.submitImageTasks, true)
  const clearExisting = parseBoolean(body.clearExisting, false)
  const panelDuration = parsePositiveNumber(body.panelDuration, 5)
  const candidateCount = parseCount(body.count ?? body.candidateCount, 1)
  const baseVisualPrompt = parseString(body.baseVisualPrompt)
  const consistencyHint = parseString(body.consistencyHint)
  const location = parseString(body.location) || null
  const shotType = parseString(body.shotType) || '中景'
  const cameraMove = parseString(body.cameraMove) || '固定'
  const characters = parseCharacters(body.characters)

  let episode = episodeId
    ? await resolveEpisodeOrThrow({
      projectDataId: novelData.id,
      episodeId,
    })
    : null

  if (!episode) {
    const episodeName = parseString(body.episodeName) || `MV ${new Date().toISOString().slice(0, 10)}`
    const description = parseString(body.description)
    const lyricsText = parseString(body.lyrics)
    const latestEpisode = await prisma.novelPromotionEpisode.findFirst({
      where: { novelPromotionProjectId: novelData.id },
      orderBy: { episodeNumber: 'desc' },
      select: { episodeNumber: true },
    })
    const nextEpisodeNumber = (latestEpisode?.episodeNumber || 0) + 1
    episode = await prisma.novelPromotionEpisode.create({
      data: {
        novelPromotionProjectId: novelData.id,
        episodeNumber: nextEpisodeNumber,
        name: episodeName,
        description: description || null,
        novelText: lyricsText || null,
      },
    })
  }

  await prisma.novelPromotionProject.update({
    where: { id: novelData.id },
    data: { lastEpisodeId: episode.id },
  })

  if (clearExisting) {
    await prisma.$transaction(async (tx) => {
      await tx.novelPromotionPanel.deleteMany({
        where: { storyboard: { episodeId: episode!.id } },
      })
      await tx.novelPromotionStoryboard.deleteMany({
        where: { episodeId: episode!.id },
      })
      await tx.novelPromotionClip.deleteMany({
        where: { episodeId: episode!.id },
      })
    })
  }

  const baseTime = Date.now()
  const createdPanels = await prisma.$transaction(async (tx) => {
    const created: Array<{ panelId: string; storyboardId: string; clipId: string }> = []
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      const clip = await tx.novelPromotionClip.create({
        data: {
          episodeId: episode!.id,
          summary: truncateText(segment, 80),
          content: segment,
          startText: truncateText(segment, 32),
          endText: truncateText(segment, 32),
          location,
          characters,
          createdAt: new Date(baseTime + index * 1000),
        },
      })

      const storyboard = await tx.novelPromotionStoryboard.create({
        data: {
          episodeId: episode!.id,
          clipId: clip.id,
          panelCount: 1,
        },
      })

      const panel = await tx.novelPromotionPanel.create({
        data: {
          storyboardId: storyboard.id,
          panelIndex: 0,
          panelNumber: 1,
          shotType,
          cameraMove,
          description: segment,
          srtSegment: segment,
          duration: panelDuration,
          location,
          characters,
          videoPrompt: buildPanelVideoPrompt({
            segment,
            segmentIndex: index,
            segmentTotal: segments.length,
            baseVisualPrompt,
            consistencyHint,
          }),
        },
      })

      created.push({
        panelId: panel.id,
        storyboardId: storyboard.id,
        clipId: clip.id,
      })
    }
    return created
  })

  const imageTaskIds: string[] = []
  if (submitImageTasks) {
    if (!modelConfig.storyboardModel) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'STORYBOARD_MODEL_NOT_CONFIGURED',
      })
    }

    const baseBillingPayload = await buildImageBillingPayload({
      projectId,
      userId: session.user.id,
      imageModel: modelConfig.storyboardModel,
      basePayload: {
        count: candidateCount,
        candidateCount,
      },
    })

    const imageTasks = await Promise.all(
      createdPanels.map(async (item, index) => {
        const billingPayload = {
          ...baseBillingPayload,
          panelId: item.panelId,
          mvSegmentIndex: index + 1,
          mvSegmentTotal: createdPanels.length,
        }

        return await submitTask({
          userId: session.user.id,
          locale,
          requestId,
          projectId,
          episodeId: episode!.id,
          type: TASK_TYPE.IMAGE_PANEL,
          targetType: 'NovelPromotionPanel',
          targetId: item.panelId,
          payload: withTaskUiPayload(billingPayload, {
            intent: 'generate',
            hasOutputAtStart: false,
          }),
          dedupeKey: `image_panel:${item.panelId}:${candidateCount}`,
          billingInfo: buildDefaultTaskBillingInfo(TASK_TYPE.IMAGE_PANEL, billingPayload),
        })
      }),
    )
    imageTaskIds.push(...imageTasks.map((task) => task.taskId))
  }

  return NextResponse.json({
    success: true,
    mode: 'bootstrap',
    episodeId: episode.id,
    segments: segments.length,
    created: {
      clips: createdPanels.length,
      storyboards: createdPanels.length,
      panels: createdPanels.length,
    },
    queuedImagePanels: imageTaskIds.length,
    imageTaskIds,
    queuedVideoPanels: 0,
    videoTaskIds: [],
  })
})
