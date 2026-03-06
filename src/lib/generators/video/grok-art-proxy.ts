/**
 * grok-art-proxy 视频生成器
 *
 * 使用 POST /api/video/generate（SSE）而不是 /v1/videos/generations：
 * 1) /api/video/generate 会返回可直接下载的代理 video_url（/api/proxy/video?...）
 * 2) 可显式传入 parent_post_id（来自生图阶段的 grokJobId）
 * 3) 避免仅返回 assets.grok.com 原始链接导致的后续下载鉴权失败
 */

import { BaseVideoGenerator, type GenerateResult, type VideoGenerateParams } from '../base'
import { getProviderConfig, getProviderKey } from '@/lib/api-config'

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

const GROK_VIDEO_RATIO_BY_SUFFIX: Record<string, string> = {
    '1_1': '1:1',
    '2_3': '2:3',
    '3_2': '3:2',
    '16_9': '16:9',
    '9_16': '9:16',
}

type GrokVideoSseEvent =
    | {
        type: 'complete'
        video_url?: string
        original_url?: string
      }
    | {
        type: 'error'
        message?: string
      }
    | {
        type: 'info'
        message?: string
      }
    | {
        type: 'progress'
      }
    | {
        type: 'done'
      }

function normalizeDuration(value: unknown): 6 | 10 {
    if (value === undefined || value === null) return 6
    if (value === 6 || value === 10) return value
    throw new Error(`GROK_ART_PROXY_VIDEO_INVALID_DURATION: ${String(value)} (allowed: 6, 10)`)
}

function normalizeResolution(value: unknown): '480p' | '720p' {
    if (value === undefined || value === null) return '720p'
    if (value === '480p' || value === '720p') return value
    throw new Error(`GROK_ART_PROXY_VIDEO_INVALID_RESOLUTION: ${String(value)} (allowed: 480p, 720p)`)
}

function resolveAspectRatio(options: Record<string, unknown>): string {
    const modelId = typeof options.modelId === 'string' ? options.modelId.trim() : ''
    const prefix = 'grok-video-'
    if (modelId.startsWith(prefix)) {
        const suffix = modelId.slice(prefix.length)
        const mapped = GROK_VIDEO_RATIO_BY_SUFFIX[suffix]
        if (mapped) return mapped
    }
    const explicitAspectRatio = typeof options.aspectRatio === 'string' ? options.aspectRatio.trim() : ''
    if (explicitAspectRatio) return explicitAspectRatio
    return '16:9'
}

function extractPostIdFromImageUrl(imageUrl: string): string {
    try {
        const parsed = new URL(imageUrl)
        const generatedMatch = parsed.pathname.match(/\/generated\/([a-zA-Z0-9_-]+)(?:\/|$)/i)
        if (generatedMatch?.[1]) return generatedMatch[1]
        const fileMatch = parsed.pathname.match(/\/([a-zA-Z0-9_-]+)\.(png|jpg|jpeg|webp)$/i)
        if (fileMatch?.[1]) return fileMatch[1]
    } catch {
        return ''
    }
    return ''
}

function resolveParentPostId(options: Record<string, unknown>, effectiveImageUrl: string): string {
    const fromImageUrl = extractPostIdFromImageUrl(effectiveImageUrl)
    if (fromImageUrl) return fromImageUrl

    const fromGrokJobId = typeof options.grokJobId === 'string' ? options.grokJobId.trim() : ''
    if (fromGrokJobId) return fromGrokJobId

    const explicit = typeof options.parentPostId === 'string' ? options.parentPostId.trim() : ''
    if (explicit) return explicit
    return ''
}

async function parseVideoUrlFromSSE(response: Response, rootUrl: string): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) {
        throw new Error('GROK_ART_PROXY_VIDEO_SSE_NO_BODY')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = ''
    let currentData = ''
    let resolvedVideoUrl = ''
    let errorMessage = ''

    const processEvent = () => {
        if (!currentEvent || !currentData) return
        try {
            const parsed = JSON.parse(currentData) as GrokVideoSseEvent
            if (parsed.type === 'complete') {
                const raw = parsed.video_url || parsed.original_url || ''
                if (raw) {
                    resolvedVideoUrl = raw.startsWith('/') ? `${rootUrl}${raw}` : raw
                }
            } else if (parsed.type === 'error') {
                errorMessage = parsed.message || 'unknown video generation error'
            }
        } catch {
            // Ignore malformed chunks from SSE stream.
        }
        currentEvent = ''
        currentData = ''
    }

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''

            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim()
                } else if (line.startsWith('data: ')) {
                    currentData = line.slice(6).trim()
                } else if (line.trim() === '') {
                    processEvent()
                }
            }

            if (resolvedVideoUrl || errorMessage) break
        }

        if (!resolvedVideoUrl && !errorMessage && buffer.trim()) {
            for (const line of buffer.split('\n')) {
                if (line.startsWith('event: ')) currentEvent = line.slice(7).trim()
                else if (line.startsWith('data: ')) currentData = line.slice(6).trim()
                else if (line.trim() === '') processEvent()
            }
            processEvent()
        }

        // Ensure final event is not lost when stream closes without a trailing blank line.
        if (!resolvedVideoUrl && !errorMessage && currentEvent && currentData) {
            processEvent()
        }
    } finally {
        reader.releaseLock()
    }

    if (errorMessage) {
        throw new Error(`GROK_ART_PROXY_VIDEO_SSE_ERROR: ${errorMessage}`)
    }
    if (!resolvedVideoUrl) {
        throw new Error('GROK_ART_PROXY_VIDEO_SSE_EMPTY_RESPONSE: no video URL received')
    }

    return resolvedVideoUrl
}

export class GrokArtProxyVideoGenerator extends BaseVideoGenerator {
    private readonly providerId?: string

    constructor(providerId?: string) {
        super()
        this.providerId = providerId
    }

    protected async doGenerate(params: VideoGenerateParams): Promise<GenerateResult> {
        const { userId, imageUrl, prompt = '', options = {} } = params
        const providerId = this.providerId || 'grok-art-proxy'
        const config = await getProviderConfig(userId, providerId)

        if (!config.baseUrl) {
            throw new Error(`PROVIDER_BASE_URL_MISSING: ${config.id}`)
        }

        if (!imageUrl) {
            throw new Error('GROK_ART_PROXY_VIDEO_IMAGE_REQUIRED: image_url is required')
        }

        // grok-art-proxy video endpoint needs a Grok-hosted image URL
        // (e.g., https://assets.grok.com/users/{userId}/generated/{uuid}.jpg)
        // because it extracts the postId from the URL for the Grok video API.
        // Priority: grokImageUrl (stored during image generation) > sourceImageHttpUrl > imageUrl
        const grokImageUrl = options.grokImageUrl as string | undefined
        const sourceHttpUrl = options.sourceImageHttpUrl as string | undefined
        const effectiveImageUrl = grokImageUrl || sourceHttpUrl || imageUrl

        if (!grokImageUrl) {
            console.warn(`[GrokArtProxyVideo] No grokImageUrl available, using fallback: ${effectiveImageUrl?.substring(0, 80)}...`)
        }

        const duration = normalizeDuration(options.duration)
        const resolution = normalizeResolution(options.resolution)
        const aspectRatio = resolveAspectRatio(options as Record<string, unknown>)
        const parentPostId = resolveParentPostId(options as Record<string, unknown>, effectiveImageUrl)

        // openai-compatible providers have /v1 auto-appended; strip it for /api/* endpoints
        const rawUrl = normalizeBaseUrl(config.baseUrl)
        const isOpenAICompatType = getProviderKey(providerId) === 'openai-compatible'
        const rootUrl = isOpenAICompatType ? rawUrl.replace(/\/v1$/, '') : rawUrl
        const endpoint = `${rootUrl}/api/video/generate`

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
                'Cookie': `auth_token=${config.apiKey}`,
            },
            body: JSON.stringify({
                image_url: effectiveImageUrl,
                prompt: prompt.trim(),
                parent_post_id: parentPostId,
                aspect_ratio: aspectRatio,
                video_length: duration,
                resolution,
                mode: 'custom',
            }),
            cache: 'no-store',
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`GROK_ART_PROXY_VIDEO_REQUEST_FAILED (${response.status}): ${errorText}`)
        }

        const videoUrl = await parseVideoUrlFromSSE(response, rootUrl)

        return { success: true, videoUrl }
    }
}
