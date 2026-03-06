'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { checkApiResponse } from '@/lib/error-handler'
import { queryKeys } from '@/lib/query/keys'

interface UseStoryboardMvGenerationParams {
  projectId: string
  episodeId: string
}

interface BootstrapMvInput {
  lyrics: string
  clearExisting: boolean
}

export function useStoryboardMvGeneration({
  projectId,
  episodeId,
}: UseStoryboardMvGenerationParams) {
  const queryClient = useQueryClient()

  const bootstrapMutation = useMutation({
    mutationFn: async ({ lyrics, clearExisting }: BootstrapMvInput) => {
      const res = await fetch(`/api/novel-promotion/${projectId}/mv/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'bootstrap',
          episodeId,
          lyrics,
          clearExisting,
          submitImageTasks: true,
        }),
      })
      await checkApiResponse(res)
      return await res.json()
    },
    onMutate: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId), exact: false })
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.episodeData(projectId, episodeId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.storyboards.all(episodeId) }),
      ])
    },
  })

  const queueVideoMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/novel-promotion/${projectId}/mv/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'video',
          episodeId,
        }),
      })
      await checkApiResponse(res)
      return await res.json()
    },
    onMutate: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId), exact: false })
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.episodeData(projectId, episodeId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.storyboards.all(episodeId) }),
      ])
    },
  })

  return {
    isMvBootstrapSubmitting: bootstrapMutation.isPending,
    isMvVideoSubmitting: queueVideoMutation.isPending,
    bootstrapMv: bootstrapMutation.mutateAsync,
    queueMvVideos: queueVideoMutation.mutateAsync,
  }
}
