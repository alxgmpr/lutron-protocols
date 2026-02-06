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
import { useProtocolDefinition } from '../../context/ProtocolDefinitionContext'
import type { Packet } from '../../types'
import './PacketDataTable.css'

interface PacketDataTableProps {
  packets: Packet[]
  paused: boolean
  onTogglePause: () => void
  onClear: () => void
}

export function PacketDataTable({ packets, paused, onTogglePause, onClear }: PacketDataTableProps) {
  const { identifyPacketFromHex, getCategoryColor } = useProtocolDefinition()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [userScrolled, setUserScrolled] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [dirFilter, setDirFilter] = useState<'all' | 'rx' | 'tx'>('all')

  // Collect unique packet types for filter dropdown
  const packetTypes = useMemo(() => {
    const types = new Set<string>()
    for (const p of packets) {
      types.add(p.type)
    }
    return Array.from(types).sort()
  }, [packets])

  // Parse bytes and identify packet type (memoized per packet)
  const enrichedPackets = useMemo(() =>
    packets.map(packet => {
      const bytes = packet.rawBytes?.split(/\s+/).filter(b => b.length > 0) || []
      const identified = identifyPacketFromHex(bytes)
      return { ...packet, bytes, identified }
    }),
    [packets, identifyPacketFromHex]
  )

  // Apply direction filter at data level
  const filteredPackets = useMemo(() => {
    if (dirFilter === 'all') return enrichedPackets
    return enrichedPackets.filter(p => p.direction === dirFilter)
  }, [enrichedPackets, dirFilter])

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
      accessorKey: 'type',
      header: 'Type',
      size: 100,
      filterFn: 'equals',
      cell: ({ row }) => {
        const color = getCategoryColor(row.original.identified.category)
        return (
          <span
            className="pdt-type-badge"
            style={{ backgroundColor: color }}
            title={row.original.identified.description}
          >
            {row.original.identified.typeName}
          </span>
        )
      },
    },
    {
      id: 'hex',
      header: 'Hex',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="pdt-hex-cell">
          <HexByteRow bytes={row.original.bytes} />
        </div>
      ),
    },
  ], [formatTime, getCategoryColor])

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
    // User is "at bottom" if within 50px
    const atBottom = scrollHeight - scrollTop - clientHeight < 50
    setUserScrolled(!atBottom)
  }, [])

  // Handle type filter
  const handleTypeFilter = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value
    const typeColumn = table.getColumn('type')
    if (typeColumn) {
      typeColumn.setFilterValue(value || undefined)
    }
  }, [table])

  const currentTypeFilter = (table.getColumn('type')?.getFilterValue() as string) ?? ''

  // Copy visible packets to clipboard as text
  const handleCopy = useCallback(() => {
    const lines = filteredPackets.map(p => {
      const time = formatTime(p.time)
      const dir = p.direction.toUpperCase()
      const type = p.identified.typeName
      const hex = p.rawBytes || ''
      return `${time} ${dir} ${type} ${hex}`
    })
    navigator.clipboard.writeText(lines.join('\n'))
  }, [filteredPackets, formatTime])

  // Dump visible packets as CSV
  const handleDumpCsv = useCallback(() => {
    const header = 'time,direction,type,raw_hex'
    const rows = filteredPackets.map(p => {
      const time = formatTime(p.time)
      const dir = p.direction
      const type = p.identified.typeName
      const hex = p.rawBytes || ''
      return `${time},${dir},${type},"${hex}"`
    })
    const csv = [header, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cca_packets_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [filteredPackets, formatTime])

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
        </div>

        <select
          className="pdt-type-filter"
          value={currentTypeFilter}
          onChange={handleTypeFilter}
        >
          <option value="">All types</option>
          {packetTypes.map(type => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>

        <div className="pdt-spacer" />

        <span className="pdt-count">
          {filteredPackets.length} packet{filteredPackets.length !== 1 ? 's' : ''}
          {paused ? ' (paused)' : ''}
        </span>

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
