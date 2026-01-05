import { useCallback, useState } from 'react'
import type { ApiResponse } from '../types'

export function useApi() {
  const [loading, setLoading] = useState(false)

  const post = useCallback(async (endpoint: string, params: Record<string, string | number>): Promise<ApiResponse> => {
    const url = endpoint + '?' + new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)])
    ).toString()
    
    setLoading(true)
    try {
      const response = await fetch(url, { method: 'POST' })
      return await response.json()
    } finally {
      setLoading(false)
    }
  }, [])

  const postJson = useCallback(async (endpoint: string, body: Record<string, unknown>): Promise<ApiResponse> => {
    setLoading(true)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      return await response.json()
    } finally {
      setLoading(false)
    }
  }, [])

  const get = useCallback(async <T>(endpoint: string): Promise<T> => {
    const response = await fetch(endpoint)
    return response.json()
  }, [])

  const del = useCallback(async (endpoint: string): Promise<ApiResponse> => {
    const response = await fetch(endpoint, { method: 'DELETE' })
    return response.json()
  }, [])

  return { post, postJson, get, del, loading }
}

export function parseHexInt(value: string): number {
  const trimmed = value.trim()
  if (trimmed.toLowerCase().startsWith('0x')) {
    return parseInt(trimmed, 16)
  }
  return parseInt(trimmed, 10)
}

export function toHex(value: number, digits = 8): string {
  return '0x' + value.toString(16).toUpperCase().padStart(digits, '0')
}


