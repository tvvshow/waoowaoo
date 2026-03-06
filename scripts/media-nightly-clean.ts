import { createScopedLogger } from '@/lib/logging/core'
import { prisma } from '@/lib/prisma'
import { deleteCOSObjects } from '@/lib/cos'
import { resolveStorageKeyFromMediaValue } from '@/lib/media/service'

const logger = createScopedLogger({
  module: 'media.nightly-clean',
})

const BATCH_SIZE = Number.parseInt(process.env.MEDIA_CLEAN_BATCH_SIZE || '200', 10) || 200
const RETENTION_DAYS = Math.max(0, Number.parseInt(process.env.MEDIA_CLEAN_RETENTION_DAYS || '1', 10) || 1)
const DRY_RUN = process.env.MEDIA_CLEAN_DRY_RUN === '1'
const INCLUDE_VOICE = process.env.MEDIA_CLEAN_INCLUDE_VOICE === '1'
const DELETE_BATCH_SIZE = Number.parseInt(process.env.MEDIA_CLEAN_DELETE_BATCH_SIZE || '1000', 10) || 1000

const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

type CleanupStats = {
  scannedRows: number
  cleanedRows: number
  keyCandidates: number
}

function collectStringsDeep(value: unknown, out: string[]) {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringsDeep(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStringsDeep(nested, out)
    }
  }
}

function explodeMediaValue(value: string | null | undefined): string[] {
  if (!value || !value.trim()) return []

  const trimmed = value.trim()
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    return [value]
  }

  try {
    const parsed = JSON.parse(trimmed)
    const out: string[] = []
    collectStringsDeep(parsed, out)
    return out.length > 0 ? out : [value]
  } catch {
    return [value]
  }
}

async function collectStorageKeys(rawValues: Array<string | null | undefined>): Promise<string[]> {
  const dedup = new Set<string>()
  for (const rawValue of rawValues) {
    const candidates = explodeMediaValue(rawValue)
    for (const candidate of candidates) {
      const key = await resolveStorageKeyFromMediaValue(candidate)
      if (key) dedup.add(key)
    }
  }
  return [...dedup]
}

async function cleanupPanels(storageKeys: Set<string>): Promise<CleanupStats> {
  let cursor: string | null = null
  let scannedRows = 0
  let cleanedRows = 0
  let keyCandidates = 0

  while (true) {
    const rows = await prisma.novelPromotionPanel.findMany({
      select: {
        id: true,
        imageUrl: true,
        videoUrl: true,
        lipSyncVideoUrl: true,
        sketchImageUrl: true,
        previousImageUrl: true,
        candidateImages: true,
        imageHistory: true,
      },
      where: {
        updatedAt: { lt: cutoff },
        OR: [
          { imageUrl: { not: null } },
          { videoUrl: { not: null } },
          { lipSyncVideoUrl: { not: null } },
          { sketchImageUrl: { not: null } },
          { previousImageUrl: { not: null } },
          { candidateImages: { not: null } },
          { imageHistory: { not: null } },
        ],
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor
        ? {
          cursor: { id: cursor },
          skip: 1,
        }
        : {}),
    })

    if (!rows.length) break

    for (const row of rows) {
      scannedRows += 1
      const keys = await collectStorageKeys([
        row.imageUrl,
        row.videoUrl,
        row.lipSyncVideoUrl,
        row.sketchImageUrl,
        row.previousImageUrl,
        row.candidateImages,
        row.imageHistory,
      ])
      keyCandidates += keys.length
      for (const key of keys) storageKeys.add(key)

      if (!DRY_RUN) {
        await prisma.novelPromotionPanel.update({
          where: { id: row.id },
          data: {
            imageUrl: null,
            videoUrl: null,
            lipSyncVideoUrl: null,
            sketchImageUrl: null,
            previousImageUrl: null,
            candidateImages: null,
            imageHistory: null,
            imageMediaId: null,
            videoMediaId: null,
            lipSyncVideoMediaId: null,
            sketchImageMediaId: null,
            previousImageMediaId: null,
          },
        })
      }
      cleanedRows += 1
    }

    cursor = rows[rows.length - 1].id
    logger.info(`[panels] batch done scanned=${scannedRows} cleaned=${cleanedRows}`)
  }

  return { scannedRows, cleanedRows, keyCandidates }
}

async function cleanupStoryboards(storageKeys: Set<string>): Promise<CleanupStats> {
  let cursor: string | null = null
  let scannedRows = 0
  let cleanedRows = 0
  let keyCandidates = 0

  while (true) {
    const rows = await prisma.novelPromotionStoryboard.findMany({
      select: {
        id: true,
        storyboardImageUrl: true,
        candidateImages: true,
        imageHistory: true,
      },
      where: {
        updatedAt: { lt: cutoff },
        OR: [
          { storyboardImageUrl: { not: null } },
          { candidateImages: { not: null } },
          { imageHistory: { not: null } },
        ],
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor
        ? {
          cursor: { id: cursor },
          skip: 1,
        }
        : {}),
    })

    if (!rows.length) break

    for (const row of rows) {
      scannedRows += 1
      const keys = await collectStorageKeys([
        row.storyboardImageUrl,
        row.candidateImages,
        row.imageHistory,
      ])
      keyCandidates += keys.length
      for (const key of keys) storageKeys.add(key)

      if (!DRY_RUN) {
        await prisma.novelPromotionStoryboard.update({
          where: { id: row.id },
          data: {
            storyboardImageUrl: null,
            candidateImages: null,
            imageHistory: null,
          },
        })
      }
      cleanedRows += 1
    }

    cursor = rows[rows.length - 1].id
    logger.info(`[storyboards] batch done scanned=${scannedRows} cleaned=${cleanedRows}`)
  }

  return { scannedRows, cleanedRows, keyCandidates }
}

async function cleanupShots(storageKeys: Set<string>): Promise<CleanupStats> {
  let cursor: string | null = null
  let scannedRows = 0
  let cleanedRows = 0
  let keyCandidates = 0

  while (true) {
    const rows = await prisma.novelPromotionShot.findMany({
      select: {
        id: true,
        imageUrl: true,
      },
      where: {
        updatedAt: { lt: cutoff },
        imageUrl: { not: null },
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor
        ? {
          cursor: { id: cursor },
          skip: 1,
        }
        : {}),
    })

    if (!rows.length) break

    for (const row of rows) {
      scannedRows += 1
      const keys = await collectStorageKeys([row.imageUrl])
      keyCandidates += keys.length
      for (const key of keys) storageKeys.add(key)

      if (!DRY_RUN) {
        await prisma.novelPromotionShot.update({
          where: { id: row.id },
          data: {
            imageUrl: null,
            imageMediaId: null,
          },
        })
      }
      cleanedRows += 1
    }

    cursor = rows[rows.length - 1].id
    logger.info(`[shots] batch done scanned=${scannedRows} cleaned=${cleanedRows}`)
  }

  return { scannedRows, cleanedRows, keyCandidates }
}

async function cleanupSupplementaryPanels(storageKeys: Set<string>): Promise<CleanupStats> {
  let cursor: string | null = null
  let scannedRows = 0
  let cleanedRows = 0
  let keyCandidates = 0

  while (true) {
    const rows = await prisma.supplementaryPanel.findMany({
      select: {
        id: true,
        imageUrl: true,
      },
      where: {
        updatedAt: { lt: cutoff },
        imageUrl: { not: null },
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor
        ? {
          cursor: { id: cursor },
          skip: 1,
        }
        : {}),
    })

    if (!rows.length) break

    for (const row of rows) {
      scannedRows += 1
      const keys = await collectStorageKeys([row.imageUrl])
      keyCandidates += keys.length
      for (const key of keys) storageKeys.add(key)

      if (!DRY_RUN) {
        await prisma.supplementaryPanel.update({
          where: { id: row.id },
          data: {
            imageUrl: null,
            imageMediaId: null,
          },
        })
      }
      cleanedRows += 1
    }

    cursor = rows[rows.length - 1].id
    logger.info(`[supplementary] batch done scanned=${scannedRows} cleaned=${cleanedRows}`)
  }

  return { scannedRows, cleanedRows, keyCandidates }
}

async function cleanupVoice(storageKeys: Set<string>): Promise<CleanupStats> {
  let cursor: string | null = null
  let scannedRows = 0
  let cleanedRows = 0
  let keyCandidates = 0

  while (true) {
    const rows = await prisma.novelPromotionVoiceLine.findMany({
      select: {
        id: true,
        audioUrl: true,
      },
      where: {
        updatedAt: { lt: cutoff },
        audioUrl: { not: null },
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor
        ? {
          cursor: { id: cursor },
          skip: 1,
        }
        : {}),
    })

    if (!rows.length) break

    for (const row of rows) {
      scannedRows += 1
      const keys = await collectStorageKeys([row.audioUrl])
      keyCandidates += keys.length
      for (const key of keys) storageKeys.add(key)

      if (!DRY_RUN) {
        await prisma.novelPromotionVoiceLine.update({
          where: { id: row.id },
          data: {
            audioUrl: null,
            audioMediaId: null,
          },
        })
      }
      cleanedRows += 1
    }

    cursor = rows[rows.length - 1].id
    logger.info(`[voice] batch done scanned=${scannedRows} cleaned=${cleanedRows}`)
  }

  return { scannedRows, cleanedRows, keyCandidates }
}

async function deleteStorageKeys(keys: string[]) {
  let success = 0
  let failed = 0

  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + DELETE_BATCH_SIZE)
    const result = await deleteCOSObjects(batch)
    success += result.success
    failed += result.failed
    logger.info(`[storage] deleted batch ${Math.floor(i / DELETE_BATCH_SIZE) + 1}, success=${result.success}, failed=${result.failed}`)
  }

  return { success, failed }
}

async function main() {
  const startedAt = Date.now()
  logger.info('nightly clean started', {
    dryRun: DRY_RUN,
    retentionDays: RETENTION_DAYS,
    cutoff: cutoff.toISOString(),
    includeVoice: INCLUDE_VOICE,
    batchSize: BATCH_SIZE,
  })

  const storageKeys = new Set<string>()
  const panel = await cleanupPanels(storageKeys)
  const storyboard = await cleanupStoryboards(storageKeys)
  const shot = await cleanupShots(storageKeys)
  const supplementary = await cleanupSupplementaryPanels(storageKeys)
  const voice = INCLUDE_VOICE ? await cleanupVoice(storageKeys) : { scannedRows: 0, cleanedRows: 0, keyCandidates: 0 }
  const keys = [...storageKeys]

  let storageDeleteResult = { success: 0, failed: 0 }
  if (!DRY_RUN && keys.length > 0) {
    storageDeleteResult = await deleteStorageKeys(keys)
  }

  logger.info('nightly clean finished', {
    durationMs: Date.now() - startedAt,
    dryRun: DRY_RUN,
    retentionDays: RETENTION_DAYS,
    cleaned: {
      panel,
      storyboard,
      shot,
      supplementary,
      voice,
    },
    uniqueStorageKeys: keys.length,
    storageDelete: storageDeleteResult,
  })
}

main()
  .catch((error) => {
    logger.error('[media-nightly-clean] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
