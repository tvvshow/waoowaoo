'use client'

import Image from 'next/image'
import type { CSSProperties, ImgHTMLAttributes, MouseEventHandler } from 'react'

export type MediaImageProps = {
  src: string | null | undefined
  alt: string
  className?: string
  style?: CSSProperties
  onClick?: MouseEventHandler<HTMLImageElement>
  fill?: boolean
  width?: number
  height?: number
  sizes?: string
  priority?: boolean
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'width' | 'height'>

function isStableMediaRoute(src: string) {
  return src.startsWith('/m/')
}

export function MediaImage({
  src,
  alt,
  className,
  style,
  onClick,
  fill = false,
  width = 1200,
  height = 1200,
  sizes,
  priority = false,
  ...imgProps
}: MediaImageProps) {
  if (!src) return null

  if (isStableMediaRoute(src)) {
    // unoptimized: bypass /_next/image optimizer which makes a server-side
    // loopback fetch using the external Host header. Inside Docker the
    // container cannot reach its own external URL, causing "received null".
    // With unoptimized the browser fetches /m/... directly from the route
    // handler which reads the file from disk.
    if (fill) {
      return (
        <Image
          src={src}
          alt={alt}
          fill
          unoptimized
          sizes={sizes || '100vw'}
          priority={priority}
          className={className}
          style={style}
          onClick={onClick}
          {...imgProps}
        />
      )
    }

    return (
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        unoptimized
        sizes={sizes}
        priority={priority}
        className={className}
        style={style}
        onClick={onClick}
        {...imgProps}
      />
    )
  }

  return (
    // 外部 URL 兜底，避免 next/image 远程域名限制影响兼容链路
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      onClick={onClick}
      loading={priority ? 'eager' : 'lazy'}
      {...imgProps}
    />
  )
}
