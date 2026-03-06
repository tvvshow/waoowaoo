import { type Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { getArtStylePrompt } from '@/lib/constants'
import { createScopedLogger } from '@/lib/logging/core'
import { type TaskJobData } from '@/lib/task/types'
import { reportTaskProgress } from '../shared'
import {
  assertTaskActive,
  getProjectModels,
  resolveImageSourceFromGeneration,
  uploadImageSourceToCos,
} from '../utils'
import { normalizeReferenceImagesForGeneration } from '@/lib/media/outbound-image'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import {
  AnyObj,
  clampCount,
  collectPanelReferenceImages,
  findCharacterByName,
  parsePanelCharacterReferences,
  pickFirstString,
  resolveNovelData,
} from './image-task-handler-shared'
import { buildPrompt, PROMPT_IDS } from '@/lib/prompt-i18n'

function parseJsonUnknown(raw: string | null | undefined): unknown | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseDescriptionList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  } catch {
    return []
  }
}

function pickAppearanceDescription(appearance: {
  descriptions?: string | null
  description?: string | null
  selectedIndex?: number | null
}): string {
  const descriptions = parseDescriptionList(appearance.descriptions || null)
  if (descriptions.length > 0) {
    const selectedIndex = typeof appearance.selectedIndex === 'number' ? appearance.selectedIndex : 0
    const selected = descriptions[selectedIndex] || descriptions[0]
    if (selected && selected.trim()) return selected.trim()
  }
  if (typeof appearance.description === 'string' && appearance.description.trim()) {
    return appearance.description.trim()
  }
  return '无描述'
}

function buildPanelPromptContext(params: {
  panel: {
    id: string
    shotType: string | null
    cameraMove: string | null
    description: string | null
    videoPrompt: string | null
    location: string | null
    characters: string | null
    srtSegment: string | null
    photographyRules: string | null
    actingNotes: string | null
  }
  projectData: Awaited<ReturnType<typeof resolveNovelData>>
}) {
  const panelCharacters = parsePanelCharacterReferences(params.panel.characters)
  const characterContexts = panelCharacters.map((reference) => {
    const character = findCharacterByName(params.projectData.characters || [], reference.name)
    if (!character) {
      return {
        name: reference.name,
        appearance: reference.appearance || null,
        description: '无角色外貌数据',
      }
    }

    const appearances = character.appearances || []
    const matchedAppearance =
      (reference.appearance
        ? appearances.find((appearance) => (appearance.changeReason || '').toLowerCase() === reference.appearance!.toLowerCase())
        : null) || appearances[0] || null

    return {
      name: character.name,
      appearance: matchedAppearance?.changeReason || null,
      description: matchedAppearance ? pickAppearanceDescription(matchedAppearance) : '无角色外貌数据',
    }
  })

  const locationContext = (() => {
    if (!params.panel.location) return null
    const matchedLocation = (params.projectData.locations || []).find(
      (item) => item.name.toLowerCase() === params.panel.location!.toLowerCase(),
    )
    if (!matchedLocation) return null
    const selectedImage = (matchedLocation.images || []).find((item) => item.isSelected) || matchedLocation.images?.[0]
    return {
      name: matchedLocation.name,
      description: selectedImage?.description || null,
    }
  })()

  return {
    panel: {
      panel_id: params.panel.id,
      shot_type: params.panel.shotType || '',
      camera_move: params.panel.cameraMove || '',
      description: params.panel.description || '',
      video_prompt: params.panel.videoPrompt || '',
      location: params.panel.location || '',
      characters: panelCharacters,
      source_text: params.panel.srtSegment || '',
      photography_rules: parseJsonUnknown(params.panel.photographyRules),
      acting_notes: parseJsonUnknown(params.panel.actingNotes),
    },
    context: {
      character_appearances: characterContexts,
      location_reference: locationContext,
    },
  }
}

function buildPanelPrompt(params: {
  locale: TaskJobData['locale']
  aspectRatio: string
  styleText: string
  sourceText: string
  contextJson: string
}) {
  return buildPrompt({
    promptId: PROMPT_IDS.NP_SINGLE_PANEL_IMAGE,
    locale: params.locale,
    variables: {
      aspect_ratio: params.aspectRatio,
      storyboard_text_json_input: params.contextJson,
      source_text: params.sourceText || '无',
      style: params.styleText,
    },
  })
}

function buildGrokPanelPrompt(params: {
  panel: {
    shotType: string | null
    cameraMove: string | null
    description: string | null
    videoPrompt: string | null
    location: string | null
    characters: string | null
    srtSegment: string | null
  }
  aspectRatio: string
  styleText: string
}): string {
  const parsedCharacters = parsePanelCharacterReferences(params.panel.characters)
  const characterLine = parsedCharacters.length > 0
    ? parsedCharacters
      .map((item) => {
        const appearance = item.appearance && item.appearance.trim().length > 0
          ? `(${item.appearance.trim()})`
          : ''
        return `${item.name}${appearance}`
      })
      .join(', ')
    : 'none'

  const sceneText = [
    params.panel.description || '',
    params.panel.videoPrompt || '',
    params.panel.srtSegment || '',
  ]
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .join(' ')

  return [
    `Create one cinematic storyboard frame in ${params.aspectRatio} ratio.`,
    `Scene: ${sceneText || 'storyboard scene'}.`,
    `Camera: shot=${params.panel.shotType || 'medium shot'}, move=${params.panel.cameraMove || 'static'}.`,
    `Characters: ${characterLine}.`,
    `Location: ${params.panel.location || 'unspecified'}.`,
    `Style: ${params.styleText || 'cinematic realistic'}.`,
    'Hard constraints: no text, no letters, no subtitles, no watermark, no logo, one single frame only.',
  ].join('\n')
}

export async function handlePanelImageTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as AnyObj
  const panelId = pickFirstString(payload.panelId, job.data.targetId)
  if (!panelId) throw new Error('panelId missing')

  const panel = await prisma.novelPromotionPanel.findUnique({
    where: { id: panelId },
  })

  if (!panel) throw new Error('Panel not found')

  const projectData = await resolveNovelData(job.data.projectId)
  const modelConfig = await getProjectModels(job.data.projectId, job.data.userId)
  const modelKey = modelConfig.storyboardModel
  if (!modelKey) throw new Error('Storyboard model not configured')
  const parsedStoryboardModel = parseModelKeyStrict(modelKey)
  const isGrokArtProxyImageModel =
    parsedStoryboardModel?.provider.startsWith('openai-compatible:') === true
    && parsedStoryboardModel.modelId.startsWith('grok-image')

  const candidateCount = clampCount(payload.candidateCount ?? payload.count, 1, 4, 1)
  const refs = await collectPanelReferenceImages(projectData, panel)
  const normalizedRefs = await normalizeReferenceImagesForGeneration(refs)
  const referenceImagesForGeneration = isGrokArtProxyImageModel ? [] : normalizedRefs

  const logger = createScopedLogger({
    module: 'worker.panel-image',
    action: 'panel_image_generate',
    requestId: job.data.trace?.requestId || undefined,
    taskId: job.data.taskId,
    projectId: job.data.projectId,
    userId: job.data.userId,
  })
  logger.info({
    message: 'panel image generation started',
    details: {
      panelId,
      modelKey,
      candidateCount,
      referenceImagesRawCount: refs.length,
      referenceImagesNormalizedCount: normalizedRefs.length,
      referenceImagesUsedCount: referenceImagesForGeneration.length,
      referenceImagesSuppressedForGrok: isGrokArtProxyImageModel,
      rawUrls: refs.map((u) => u.substring(0, 100)),
      normalizedUrls: normalizedRefs.map((u) => u.substring(0, 100)),
      panelCharacters: panel.characters,
      panelLocation: panel.location,
      artStyle: modelConfig.artStyle,
    },
  })

  const artStyle = getArtStylePrompt(modelConfig.artStyle, job.data.locale)
  if (!projectData.videoRatio) throw new Error('Project videoRatio not configured')
  const aspectRatio = projectData.videoRatio
  const prompt = isGrokArtProxyImageModel
    ? buildGrokPanelPrompt({
      panel: {
        shotType: panel.shotType,
        cameraMove: panel.cameraMove,
        description: panel.description,
        videoPrompt: panel.videoPrompt,
        location: panel.location,
        characters: panel.characters,
        srtSegment: panel.srtSegment,
      },
      aspectRatio,
      styleText: artStyle || 'cinematic realistic',
    })
    : buildPanelPrompt({
      locale: job.data.locale,
      aspectRatio,
      styleText: artStyle || '与参考图风格一致',
      sourceText: panel.srtSegment || panel.description || '',
      contextJson: JSON.stringify(buildPanelPromptContext({
        panel: {
          id: panel.id,
          shotType: panel.shotType,
          cameraMove: panel.cameraMove,
          description: panel.description,
          videoPrompt: panel.videoPrompt,
          location: panel.location,
          characters: panel.characters,
          srtSegment: panel.srtSegment,
          photographyRules: panel.photographyRules,
          actingNotes: panel.actingNotes,
        },
        projectData,
      }), null, 2),
    })
  logger.info({
    message: 'panel image prompt resolved',
    details: {
      promptLength: prompt.length,
      promptMode: isGrokArtProxyImageModel ? 'grok-video-ready-compact' : 'default-structured',
    },
  })

  const candidates: string[] = []
  let lastGrokImageUrl: string | undefined
  let lastGrokJobId: string | undefined

  for (let i = 0; i < candidateCount; i++) {
    await reportTaskProgress(job, 18 + Math.floor((i / Math.max(candidateCount, 1)) * 58), {
      stage: 'generate_panel_candidate',
      candidateIndex: i,
    })

    const { source, metadata } = await resolveImageSourceFromGeneration(job, {
      userId: job.data.userId,
      modelId: modelKey,
      prompt,
      options: {
        referenceImages: referenceImagesForGeneration,
        aspectRatio,
      },
      pollProgress: { start: 30, end: 90 },
    })

    // Capture original Grok image URL for video generation (grok-art-proxy only)
    if (metadata?.grokImageUrl) {
      lastGrokImageUrl = metadata.grokImageUrl
    }
    if (metadata?.grokJobId) {
      lastGrokJobId = metadata.grokJobId
    }
    // Debug log to check metadata
    logger.info({
      message: 'panel image generation metadata received',
      details: {
        hasMetadata: !!metadata,
        metadataKeys: metadata ? Object.keys(metadata) : [],
        hasGrokImageUrl: !!metadata?.grokImageUrl,
        hasGrokJobId: !!metadata?.grokJobId,
        grokJobId: metadata?.grokJobId || '(none)',
      },
    })

    const cosKey = await uploadImageSourceToCos(source, 'panel-candidate', `${panel.id}-${i}`)
    candidates.push(cosKey)
  }

  const isFirstGeneration = !panel.imageUrl

  await assertTaskActive(job, 'persist_panel_image')
  if (isFirstGeneration) {
    await prisma.novelPromotionPanel.update({
      where: { id: panel.id },
      data: {
        imageUrl: candidates[0] || null,
        candidateImages: candidateCount > 1 ? JSON.stringify(candidates) : null,
        ...(lastGrokImageUrl ? { grokImageUrl: lastGrokImageUrl } : {}),
        ...(lastGrokJobId ? { grokJobId: lastGrokJobId } : {}),
      },
    })
  } else {
    await prisma.novelPromotionPanel.update({
      where: { id: panel.id },
      data: {
        previousImageUrl: panel.imageUrl,
        candidateImages: JSON.stringify(candidates),
        ...(lastGrokImageUrl ? { grokImageUrl: lastGrokImageUrl } : {}),
        ...(lastGrokJobId ? { grokJobId: lastGrokJobId } : {}),
      },
    })
  }

  return {
    panelId: panel.id,
    candidateCount: candidates.length,
    imageUrl: isFirstGeneration ? candidates[0] || null : null,
  }
}
