/**
 * grok-art-proxy 视频生成器
 *
 * 调用 POST /v1/videos/generations 端点
 * 请求：{ image_url, prompt, duration, resolution }
 * 响应：{ created, data: [{ url }] }
 *
 * 注意：grok-art-proxy 的视频端点需要 Grok 原始图片 URL（assets.grok.com）
 * 因为它需要从 URL 提取 Grok postId 用于视频生成 API。
 * 通过 options.grokImageUrl 传入图片生成时保存的原始 Grok URL。
 */

import { BaseVideoGenerator, type GenerateResult, type VideoGenerateParams } from '../base'
import { getProviderConfig, getProviderKey } from '@/lib/api-config'

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
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

        const duration = (options.duration as number | undefined) ?? 6
        const resolution = (options.resolution as string | undefined) ?? '720p'

        // openai-compatible providers have /v1 auto-appended; strip it to build correct endpoint
        const rawUrl = normalizeBaseUrl(config.baseUrl)
        const isOpenAICompatType = getProviderKey(providerId) === 'openai-compatible'
        const apiBaseUrl = isOpenAICompatType ? rawUrl : `${rawUrl}/v1`

        const endpoint = `${apiBaseUrl}/videos/generations`

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                image_url: effectiveImageUrl,
                prompt: prompt.trim() || undefined,
                duration,
                resolution,
            }),
            cache: 'no-store',
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`GROK_ART_PROXY_VIDEO_REQUEST_FAILED (${response.status}): ${errorText}`)
        }

        const data = await response.json() as { created?: number; data?: Array<{ url?: string }> }
        const videoUrl = data?.data?.[0]?.url

        if (!videoUrl) {
            throw new Error('GROK_ART_PROXY_VIDEO_EMPTY_RESPONSE: no video URL in response')
        }

        return { success: true, videoUrl }
    }
}
