import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
} from '@tanstack/react-table'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { HexByteRow } from './HexByte'
import type { Packet } from '../../types'
import './PacketDataTable.css'

interface PacketDataTableProps {
  packets: Packet[]
  paused: boolean
  onTogglePause: () => void
  onClear: () => void
}

interface RecordingState {
  recording: boolean
  file?: string
  count?: number
}

export function PacketDataTable({ packets, paused, onTogglePause, onClear }: PacketDataTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [userScrolled, setUserScrolled] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [dirFilter, setDirFilter] = useState<'all' | 'rx' | 'tx'>('all')
  const [protoFilter, setProtoFilter] = useState<'all' | 'cca' | 'ccx'>('all')

  // Recording state
  const [recording, setRecording] = useState<RecordingState>({ recording: false })
  const [showRecordInput, setShowRecordInput] = useState(false)
  const [sessionName, setSessionName] = useState('')
  const recordInputRef = useRef<HTMLInputElement>(null)

  // Poll recording status while recording
  useEffect(() => {
    if (!recording.recording) return
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/recording/status')
        const data = await res.json()
        setRecording(data)
      } catch { /* ignore */ }
    }, 1000)
    return () => clearInterval(interval)
  }, [recording.recording])

  // Focus input when it appears
  useEffect(() => {
    if (showRecordInput && recordInputRef.current) {
      recordInputRef.current.focus()
    }
  }, [showRecordInput])

  // Split bytes from raw hex (memoized per packet set)
  const enrichedPackets = useMemo(() =>
    packets.map(packet => {
      const bytes = packet.rawBytes?.split(/\s+/).filter(b => b.length > 0) || []
      return { ...packet, bytes }
    }),
    [packets]
  )

  // Apply direction + protocol filters at data level
  const filteredPackets = useMemo(() => {
    let result = enrichedPackets
    if (dirFilter !== 'all') result = result.filter(p => p.direction === dirFilter)
    if (protoFilter !== 'all') result = result.filter(p => p.protocol === protoFilter)
    return result
  }, [enrichedPackets, dirFilter, protoFilter])

  // Format time as HH:MM:SS.ms
  const formatTime = useCallback((time: string) => {
    if (!time) return ''
    const match = time.match(/(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/)
    if (match) {
      const [, h, m, s, ms] = match
      return ms ? `${h}:${m}:${s}.${ms.padEnd(3, '0').slice(0, 3)}` : `${h}:${m}:${s}`
    }
    return time
  }, [])

  type EnrichedPacket = (typeof enrichedPackets)[number]

  const columns = useMemo<ColumnDef<EnrichedPacket>[]>(() => [
    {
      accessorKey: 'time',
      header: 'Time',
      size: 85,
      cell: ({ row }) => (
        <span className="pdt-time">{formatTime(row.original.time)}</span>
      ),
    },
    {
      accessorKey: 'direction',
      header: 'Dir',
      size: 36,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="pdt-dir-badge" data-dir={row.original.direction}>
          {row.original.direction}
        </span>
      ),
    },
    {
      accessorKey: 'protocol',
      header: 'RF',
      size: 36,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="pdt-proto-badge" data-proto={row.original.protocol}>
          {row.original.protocol === 'ccx' ? 'X' : 'A'}
        </span>
      ),
    },
    {
      accessorKey: 'type',
      header: 'Type',
      size: 40,
      filterFn: 'equals',
      cell: ({ row }) => {
        const rawType = row.original.protocol === 'ccx'
          ? row.original.type
          : (row.original.bytes[0]?.toUpperCase() || '??')
        return (
          <span className="pdt-type-raw">{rawType}</span>
        )
      },
    },
    {
      id: 'seq',
      header: 'Seq',
      size: 30,
      enableSorting: false,
      cell: ({ row }) => {
        if (row.original.protocol !== 'cca' || row.original.bytes.length < 2) return null
        const seq = parseInt(row.original.bytes[1], 16)
        return <span className="pdt-seq">{isNaN(seq) ? '' : seq}</span>
      },
    },
    {
      id: 'data',
      header: 'Data',
      enableSorting: false,
      cell: ({ row }) => {
        if (row.original.protocol === 'ccx') {
          return (
            <div className="pdt-ccx-cbor">
              {row.original.rawBytes || ''}
            </div>
          )
        }
        return (
          <div className="pdt-hex-cell">
            <HexByteRow bytes={row.original.bytes} />
          </div>
        )
      },
    },
  ], [formatTime])

  const table = useReactTable({
    data: filteredPackets,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  // Auto-scroll to bottom for live streaming
  useEffect(() => {
    if (scrollRef.current && !paused && !userScrolled && sorting.length === 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [filteredPackets, paused, userScrolled, sorting])

  // Detect user scroll
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const atBottom = scrollHeight - scrollTop - clientHeight < 50
    setUserScrolled(!atBottom)
  }, [])

  // Copy visible packets to clipboard as text
  const handleCopy = useCallback(() => {
    const lines = filteredPackets.map(p => {
      const time = formatTime(p.time)
      const dir = p.direction.toUpperCase()
      const proto = p.protocol.toUpperCase()
      const data = p.rawBytes || ''
      return `${time} ${proto} ${dir} ${data}`
    })
    navigator.clipboard.writeText(lines.join('\n'))
  }, [filteredPackets, formatTime])

  // Dump visible packets as CSV
  const handleDumpCsv = useCallback(() => {
    const header = 'timestamp,direction,rssi,raw_hex'
    const rows = filteredPackets.map(p => {
      const time = p.time
      const dir = p.direction
      const rssi = ''
      const data = p.rawBytes || ''
      return `${time},${dir},${rssi},${data}`
    })
    const csv = [header, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `packets_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [filteredPackets])

  // Recording controls
  const startRecording = useCallback(async (name: string) => {
    try {
      const res = await fetch('/api/recording/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      setRecording({ recording: true, file: data.file, count: 0 })
      setShowRecordInput(false)
      setSessionName('')
    } catch (e) {
      console.error('Failed to start recording:', e)
    }
  }, [])

  const stopRecording = useCallback(async () => {
    try {
      const res = await fetch('/api/recording/stop', { method: 'POST' })
      const data = await res.json()
      setRecording({ recording: false, file: data.file, count: data.packets_recorded })
    } catch (e) {
      console.error('Failed to stop recording:', e)
    }
  }, [])

  const handleRecordClick = useCallback(() => {
    if (recording.recording) {
      stopRecording()
    } else {
      setShowRecordInput(true)
    }
  }, [recording.recording, stopRecording])

  const handleRecordSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    const name = sessionName.trim() || `session`
    startRecording(name)
  }, [sessionName, startRecording])

  const handleRecordCancel = useCallback(() => {
    setShowRecordInput(false)
    setSessionName('')
  }, [])

  return (
    <div className="packet-data-table">
      {/* Toolbar */}
      <div className="pdt-toolbar">
        <div className="pdt-toolbar-filters">
          <button
            className="pdt-filter-btn"
            data-active={dirFilter === 'all'}
            onClick={() => setDirFilter('all')}
          >
            All
          </button>
          <button
            className="pdt-filter-btn"
            data-active={dirFilter === 'rx'}
            data-variant="rx"
            onClick={() => setDirFilter('rx')}
          >
            RX
          </button>
          <button
            className="pdt-filter-btn"
            data-active={dirFilter === 'tx'}
            data-variant="tx"
            onClick={() => setDirFilter('tx')}
          >
            TX
          </button>

          <span className="pdt-filter-sep" />

          <button
            className="pdt-filter-btn"
            data-active={protoFilter === 'all'}
            onClick={() => setProtoFilter('all')}
          >
            A+X
          </button>
          <button
            className="pdt-filter-btn"
            data-active={protoFilter === 'cca'}
            data-variant="cca"
            onClick={() => setProtoFilter('cca')}
          >
            CCA
          </button>
          <button
            className="pdt-filter-btn"
            data-active={protoFilter === 'ccx'}
            data-variant="ccx"
            onClick={() => setProtoFilter('ccx')}
          >
            CCX
          </button>
        </div>

        <div className="pdt-spacer" />

        <span className="pdt-count">
          {filteredPackets.length} packet{filteredPackets.length !== 1 ? 's' : ''}
          {paused ? ' (paused)' : ''}
        </span>

        {/* Recording inline input */}
        {showRecordInput && (
          <form className="pdt-record-form" onSubmit={handleRecordSubmit}>
            <input
              ref={recordInputRef}
              className="pdt-record-input"
              type="text"
              placeholder="session name..."
              value={sessionName}
              onChange={e => setSessionName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') handleRecordCancel() }}
            />
            <button className="pdt-action-btn" type="submit">Go</button>
            <button className="pdt-action-btn" type="button" onClick={handleRecordCancel}>X</button>
          </form>
        )}

        <button
          className={`pdt-action-btn ${recording.recording ? 'pdt-record-active' : ''}`}
          onClick={handleRecordClick}
        >
          {recording.recording ? (
            <>
              <span className="pdt-record-dot" />
              Stop ({recording.count ?? 0})
            </>
          ) : (
            'Record'
          )}
        </button>
        <button
          className="pdt-action-btn"
          data-active={paused}
          onClick={onTogglePause}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button className="pdt-action-btn" onClick={handleCopy} disabled={filteredPackets.length === 0}>
          Copy
        </button>
        <button className="pdt-action-btn" onClick={handleDumpCsv} disabled={filteredPackets.length === 0}>
          CSV
        </button>
        <button className="pdt-action-btn" onClick={onClear}>
          Clear
        </button>
      </div>

      {/* Table */}
      <div className="pdt-scroll-container" ref={scrollRef} onScroll={handleScroll}>
        {filteredPackets.length === 0 ? (
          <div className="pdt-empty">No packets yet</div>
        ) : (
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map(headerGroup => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map(header => (
                    <TableHead
                      key={header.id}
                      className={`pdt-col-${header.id}`}
                      style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                      onClick={header.column.getCanSort() ? header.column.getToggleSortingHandler() : undefined}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() && (
                        <span className="pdt-sort-indicator">
                          {header.column.getIsSorted() === 'asc' ? '\u25B2' : '\u25BC'}
                        </span>
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map(row => (
                <TableRow
                  key={row.id}
                  className={`pdt-row-${row.original.direction}`}
                >
                  {row.getVisibleCells().map(cell => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
