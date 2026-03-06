/**
 * grok-art-proxy 图片生成器
 *
 * - 无参考图：POST /api/imagine/generate（SSE 流，返回 job_id 用于视频生成）
 * - 有参考图：POST /api/imagine/img2img（SSE 流，JSON body）
 */

import { BaseImageGenerator, type GenerateResult, type ImageGenerateParams } from '../base'
import { getProviderConfig, getProviderKey } from '@/lib/api-config'

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

/**
 * Rewrite an assets.grok.com URL to go through grok-art-proxy's /api/proxy/assets/ endpoint.
 * This avoids 401 errors when downloading directly from assets.grok.com
 * (which requires Grok SSO cookies, not our API key).
 */
function rewriteToAssetsProxy(url: string, proxyBaseUrl: string): string {
  const ASSETS_HOST = 'https://assets.grok.com'
  if (url.startsWith(ASSETS_HOST)) {
    const path = url.slice(ASSETS_HOST.length)
    return `${proxyBaseUrl}/api/proxy/assets${path}`
  }
  return url
}

interface SSEImageEvent {
  type: 'image'
  url?: string
  job_id?: string
  image_src?: string
}

interface SSEErrorEvent {
  type: 'error'
  message?: string
}

interface SSEDebugEvent {
  type: 'debug'
  message?: string
}


/** OpenAI size → Grok aspect ratio (same mapping as grok-art-proxy /v1/images/generations) */
const SIZE_TO_ASPECT_RATIO: Record<string, string> = {
  '1024x1024': '1:1',
  '1024x1536': '2:3',
  '1536x1024': '3:2',
  '1792x1024': '16:9',
  '1024x1792': '9:16',
}

interface GenerateSSEResult {
  imageBase64: string
  grokImageUrl: string
  grokJobId: string
}

async function collectImagesFromSSE(
    response: Response,
    baseUrl: string,
): Promise<{ urls: string[], parentPostId?: string }> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('GROK_ART_PROXY_IMG2IMG_NO_BODY')

  const decoder = new TextDecoder()
  const imageUrls: string[] = []
  let parentPostId: string | undefined
  let buffer = ''
  let currentEvent = ''
  let currentData = ''
  let errorMessage = ''

  const processEvent = () => {
    if (!currentEvent || !currentData) return
    try {
      const parsed = JSON.parse(currentData)
      
      // Check for debug events first (for parentPostId extraction)
      if (parsed.type === 'debug') {
        const msg = (parsed as SSEDebugEvent).message || ''
        console.log('[GrokArtProxy img2img] Debug event:', msg)
        const match = msg.match(/parentPostId:\s*([a-f0-9-]+)/i)
        if (match && match[1]) {
          parentPostId = match[1]
          console.log('[GrokArtProxy img2img] Extracted parentPostId:', parentPostId)
        }
      } else if (parsed.type === 'image') {
        const raw = (parsed as SSEImageEvent).url || ''
        if (raw) {
          // Proxy URLs are root-relative; prepend base URL so waoowaoo can fetch them
          const url = raw.startsWith('/') ? `${baseUrl}${raw}` : raw
          imageUrls.push(url)
        }
      } else if (parsed.type === 'error') {
        errorMessage = (parsed as SSEErrorEvent).message || 'img2img error'
      }
    } catch { /* ignore malformed data lines */ }
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

  console.log('[GrokArtProxy img2img] Final result:', { 
    urlsCount: imageUrls.length, 
    parentPostId: parentPostId || '(none)' 
  })
  return { urls: imageUrls, parentPostId }
}

/**
 * Download an image URL with grok-art-proxy auth headers and return base64.
 * Proxy URLs under /api/* require cookie auth; direct URLs are tried with auth as well (harmless).
 */
async function fetchImageAsBase64(url: string, apiKey: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Cookie': `auth_token=${apiKey}`,
    },
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`GROK_ART_PROXY_IMAGE_DOWNLOAD_FAILED (${resp.status}): ${errText}`)
  }
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length < 1000) {
    // Sanity check: real images are at least a few KB
    const text = buf.toString('utf-8').trim()
    if (text.startsWith('{')) {
      throw new Error(`GROK_ART_PROXY_IMAGE_DOWNLOAD_NOT_IMAGE: ${text}`)
    }
  }
  return buf.toString('base64')
}

/**
 * Call /api/imagine/generate SSE endpoint for text-to-image.
 * Unlike /v1/images/generations (which discards job_id), this returns the full
 * ImageUpdate including job_id — needed as parent_post_id for video generation.
 */
async function generateImageViaSSE(
  rootUrl: string,
  apiKey: string,
  prompt: string,
  aspectRatio: string,
): Promise<GenerateSSEResult> {
  const response = await fetch(`${rootUrl}/api/imagine/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Cookie': `auth_token=${apiKey}`,
    },
    body: JSON.stringify({
      prompt: prompt.trim(),
      aspect_ratio: aspectRatio,
      enable_nsfw: true,
      count: 1,
    }),
    cache: 'no-store',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`GROK_ART_PROXY_GENERATE_FAILED (${response.status}): ${errorText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('GROK_ART_PROXY_GENERATE_NO_BODY')

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  let currentData = ''
  let errorMessage = ''
  let result: GenerateSSEResult | null = null

  const processEvent = () => {
    if (!currentEvent || !currentData) return
    try {
      const parsed = JSON.parse(currentData) as SSEImageEvent | SSEErrorEvent
      if (parsed.type === 'image' && !result) {
        const img = parsed as SSEImageEvent
        const grokUrl = img.url || ''
        const jobId = img.job_id || ''
        const imageSrc = img.image_src || ''

        if (grokUrl && imageSrc) {
          // image_src is a data URL (data:image/jpeg;base64,...) or base64
          let base64 = imageSrc
          const marker = ';base64,'
          const markerIdx = imageSrc.indexOf(marker)
          if (markerIdx !== -1) {
            base64 = imageSrc.slice(markerIdx + marker.length)
          }
          result = { imageBase64: base64, grokImageUrl: grokUrl, grokJobId: jobId }
        }
      } else if (parsed.type === 'error') {
        errorMessage = (parsed as SSEErrorEvent).message || 'generate error'
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
      // Stop early once we have a result
      if (result) break
    }
    // flush remaining
    if (!result && buffer.trim()) {
      for (const line of buffer.split('\n')) {
        if (line.startsWith('event: ')) currentEvent = line.slice(7).trim()
        else if (line.startsWith('data: ')) currentData = line.slice(6).trim()
        else if (line.trim() === '') processEvent()
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (errorMessage) {
    throw new Error(`GROK_ART_PROXY_GENERATE_ERROR: ${errorMessage}`)
  }
  if (!result) {
    throw new Error('GROK_ART_PROXY_GENERATE_EMPTY: no image returned from SSE stream')
  }

  return result
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
    // For SSE endpoints we need the root URL (no /v1).
    const isOpenAICompatType = getProviderKey(providerId) === 'openai-compatible'
    const rootUrl = isOpenAICompatType ? rawUrl.replace(/\/v1$/, '') : rawUrl

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

      const sseResult = await collectImagesFromSSE(response, rootUrl)
      if (sseResult.urls.length === 0) {
        throw new Error('GROK_ART_PROXY_IMG2IMG_EMPTY: no images returned')
      }

      // Download the image with auth headers (proxy URLs require cookie auth)
      const imageBase64 = await fetchImageAsBase64(sseResult.urls[0], config.apiKey)

      // Extract original Grok URL from proxy URL for video generation
      // Proxy URLs: {host}/api/imagine/proxy?url={encodedGrokUrl}&token_id=...
      let grokImageUrl = ''
      try {
        const proxyUrl = new URL(sseResult.urls[0])
        grokImageUrl = proxyUrl.searchParams.get('url') || ''
      } catch { /* non-proxy URL, ignore */ }

      const metadata: Record<string, string> = { grokImageUrl }
      if (sseResult.parentPostId) {
        metadata.grokJobId = sseResult.parentPostId
      }

      return {
        success: true, imageBase64,
        imageUrl: `data:image/jpeg;base64,${imageBase64}`,
        metadata,
      }
    } else {
      // text-to-image: use /api/imagine/generate SSE endpoint.
      // This gives us job_id (needed as parent_post_id for video generation).
      // /v1/images/generations discards job_id, so we can't use it.
      const rawSize = (options.size as string | undefined) || (options.resolution as string | undefined)
      const aspectRatio = (rawSize && SIZE_TO_ASPECT_RATIO[rawSize]) || '2:3'

      const sseResult = await generateImageViaSSE(rootUrl, config.apiKey, prompt, aspectRatio)

      const metadata: Record<string, string> = { grokImageUrl: sseResult.grokImageUrl }
      if (sseResult.grokJobId) {
        metadata.grokJobId = sseResult.grokJobId
      }

      return {
        success: true,
        imageBase64: sseResult.imageBase64,
        imageUrl: `data:image/jpeg;base64,${sseResult.imageBase64}`,
        metadata,
      }
    }
  }
}
