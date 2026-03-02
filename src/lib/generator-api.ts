import { logInfo as _ulogInfo } from '@/lib/logging/core'
/**
 * 生成器统一入口（增强版）
 * 
 * 支持：
 * - 严格使用 model_key（provider::modelId）
 * - 用户自定义模型的动态路由（仅通过配置中心）
 * - 统一错误处理
 */

import { createAudioGenerator, createImageGenerator, createVideoGenerator } from './generators/factory'
import type { GenerateResult, ImageGenerator } from './generators/base'
import { resolveModelSelection, getProviderKey, getProviderConfig } from './api-config'
import { GrokArtProxyImageGenerator } from './generators/image/grok-art-proxy'

/**
 * 生成图片（简化版）
 * 
 * @param userId 用户 ID
 * @param modelKey 模型唯一键（provider::modelId）
 * @param prompt 提示词
 * @param options 生成选项
 */
export async function generateImage(
    userId: string,
    modelKey: string,
    prompt: string,
    options?: {
        referenceImages?: string[]
        aspectRatio?: string
        resolution?: string
        outputFormat?: string
        keepOriginalAspectRatio?: boolean  // 🔥 编辑时保持原图比例
        size?: string  // 🔥 直接指定像素尺寸如 "5016x3344"（优先于 aspectRatio）
    }
): Promise<GenerateResult> {
    const selection = await resolveModelSelection(userId, modelKey, 'image')
    _ulogInfo(`[generateImage] resolved model selection: ${selection.modelKey}`)

    // When an openai-compatible provider is actually serving grok-art-proxy, the standard
    // OpenAI SDK path calls /v1/images/edits for img2img which doesn't exist there.
    // Detect by model ID containing 'grok' (fast, no extra DB query), or fall back to
    // checking the provider name.
    let generator: ImageGenerator
    const providerKey = getProviderKey(selection.provider)
    if (providerKey === 'openai-compatible') {
        let useGrokArtProxy = selection.modelId.toLowerCase().includes('grok')
        if (!useGrokArtProxy) {
            const cfg = await getProviderConfig(userId, selection.provider)
            useGrokArtProxy = cfg.name.toLowerCase().includes('grok-art-proxy')
        }
        generator = useGrokArtProxy
            ? new GrokArtProxyImageGenerator(selection.modelId, selection.provider)
            : createImageGenerator(selection.provider, selection.modelId)
    } else {
        generator = createImageGenerator(selection.provider, selection.modelId)
    }

    // 调用生成（提取 referenceImages 单独传递，其余选项合并进 options）
    const { referenceImages, ...generatorOptions } = options || {}
    return generator.generate({
        userId,
        prompt,
        referenceImages,
        options: {
            ...generatorOptions,
            provider: selection.provider,
            modelId: selection.modelId,
            modelKey: selection.modelKey,
        }
    })
}

/**
 * 生成视频（增强版）
 * 
 * @param userId 用户 ID
 * @param modelKey 模型唯一键（provider::modelId）
 * @param imageUrl 输入图片 URL
 * @param options 生成选项
 */
export async function generateVideo(
    userId: string,
    modelKey: string,
    imageUrl: string,
    options?: {
        prompt?: string
        duration?: number
        fps?: number
        resolution?: string      // '720p' | '1080p'
        aspectRatio?: string     // '16:9' | '9:16'
        generateAudio?: boolean  // 仅 Seedance 1.5 Pro 支持
        lastFrameImageUrl?: string  // 首尾帧模式的尾帧图片
        [key: string]: string | number | boolean | undefined
    }
): Promise<GenerateResult> {
    const selection = await resolveModelSelection(userId, modelKey, 'video')
    const generator = createVideoGenerator(selection.provider)
    _ulogInfo(`[generateVideo] resolved model selection: ${selection.modelKey}`)

    const { prompt, ...providerOptions } = options || {}

    return generator.generate({
        userId,
        imageUrl,
        prompt,
        options: {
            ...providerOptions,
            provider: selection.provider,
            modelId: selection.modelId,
            modelKey: selection.modelKey,
        }
    })
}

/**
 * 生成语音
 */
export async function generateAudio(
    userId: string,
    modelKey: string,
    text: string,
    options?: {
        voice?: string
        rate?: number
    }
): Promise<GenerateResult> {
    const selection = await resolveModelSelection(userId, modelKey, 'audio')
    const generator = createAudioGenerator(selection.provider)

    return generator.generate({
        userId,
        text,
        voice: options?.voice,
        rate: options?.rate,
        options: {
            provider: selection.provider,
            modelId: selection.modelId,
            modelKey: selection.modelKey,
        },
    })
}
