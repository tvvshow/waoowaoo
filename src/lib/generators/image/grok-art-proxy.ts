/**
 * grok-art-proxy 图片生成器
 *
 * - 无参考图：POST /v1/images/generations（OpenAI 兼容）
 * - 有参考图：POST /api/imagine/img2img（SSE 流，JSON body）
 */

import OpenAI from 'openai'
import { BaseImageGenerator, type GenerateResult, type ImageGenerateParams } from '../base'
import { getProviderConfig, getProviderKey } from '@/lib/api-config'

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

interface SSEImageEvent {
  type: 'image'
  url?: string
}

interface SSEErrorEvent {
  type: 'error'
  message?: string
}

async function collectImagesFromSSE(
  response: Response,
  baseUrl: string,
): Promise<string[]> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('GROK_ART_PROXY_IMG2IMG_NO_BODY')

  const decoder = new TextDecoder()
  const imageUrls: string[] = []
  let buffer = ''
  let currentEvent = ''
  let currentData = ''
  let errorMessage = ''

  const processEvent = () => {
    if (!currentEvent || !currentData) return
    try {
      const parsed = JSON.parse(currentData) as SSEImageEvent | SSEErrorEvent
      if (parsed.type === 'image') {
        const raw = (parsed as SSEImageEvent).url || ''
        if (raw) {
          // Proxy URLs are root-relative; prepend base URL so waoowaoo can fetch them
          const url = raw.startsWith('/') ? `${baseUrl}${raw}` : raw
          imageUrls.push(url)
        }
      } else if (parsed.type === 'error') {
        errorMessage = (parsed as SSEErrorEvent).message || 'img2img error'
      }
    } catch {
      // ignore malformed data lines
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
    }
    // flush remaining
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data: ')) currentData = line.slice(6).trim()
      }
      processEvent()
    }
  } finally {
    reader.releaseLock()
  }

  if (errorMessage) {
    throw new Error(`GROK_ART_PROXY_IMG2IMG_ERROR: ${errorMessage}`)
  }

  return imageUrls
}

export class GrokArtProxyImageGenerator extends BaseImageGenerator {
  private readonly modelId?: string
  private readonly providerId?: string

  constructor(modelId?: string, providerId?: string) {
    super()
    this.modelId = modelId
    this.providerId = providerId
  }

  protected async doGenerate(params: ImageGenerateParams): Promise<GenerateResult> {
    const { userId, prompt, referenceImages = [], options = {} } = params
    const providerId = this.providerId || 'grok-art-proxy'
    const config = await getProviderConfig(userId, providerId)

    if (!config.baseUrl) {
      throw new Error(`PROVIDER_BASE_URL_MISSING: ${config.id}`)
    }

    const rawUrl = normalizeBaseUrl(config.baseUrl)

    // openai-compatible providers have /v1 auto-appended by normalizeProviderBaseUrl.
    // For img2img we need the root URL (no /v1); for the OpenAI SDK the /v1 must be present.
    // grok-art-proxy provider type stores the raw URL without /v1.
    const isOpenAICompatType = getProviderKey(providerId) === 'openai-compatible'
    const rootUrl = isOpenAICompatType ? rawUrl.replace(/\/v1$/, '') : rawUrl
    const apiBaseUrl = isOpenAICompatType ? rawUrl : `${rawUrl}/v1`

    if (referenceImages.length > 0) {
      // img2img: call /api/imagine/img2img with base64 data URL
      const imageData = referenceImages[0] // already a base64 data URL from normalizeReferenceImagesForGeneration

      const response = await fetch(`${rootUrl}/api/imagine/img2img`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
          'Cookie': `auth_token=${config.apiKey}`,
        },
        body: JSON.stringify({
          image_data: imageData,
          prompt: prompt.trim(),
          count: 1,
        }),
        cache: 'no-store',
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`GROK_ART_PROXY_IMG2IMG_FAILED (${response.status}): ${errorText}`)
      }

      const urls = await collectImagesFromSSE(response, rootUrl)
      if (urls.length === 0) {
        throw new Error('GROK_ART_PROXY_IMG2IMG_EMPTY: no images returned')
      }

      return { success: true, imageUrl: urls[0] }
    } else {
      // text-to-image: use OpenAI-compatible /v1/images/generations
      const rawSize = (options.size as string | undefined) || (options.resolution as string | undefined)

      const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: apiBaseUrl,
      })

      const model = (this.modelId ?? 'grok-imagine-1.0').trim()

      const genResponse = await client.images.generate({
        model,
        prompt,
        response_format: 'url',
        ...(rawSize ? { size: rawSize as '1024x1024' } : {}),
      })

      const imageUrl = genResponse.data?.[0]?.url
      if (!imageUrl) {
        throw new Error('GROK_ART_PROXY_IMAGE_EMPTY: no image URL returned')
      }

      return { success: true, imageUrl }
    }
  }
}
