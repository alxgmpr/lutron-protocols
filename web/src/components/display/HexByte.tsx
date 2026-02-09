import './HexByte.css'

interface HexByteRowProps {
  bytes: string[]
}

export function HexByteRow({ bytes }: HexByteRowProps) {
  return (
    <div className="hex-byte-row">
      {bytes.map((byte, i) => (
        <span
          key={i}
          className={`hex-byte ${i % 8 < 4 ? 'hex-byte-even' : 'hex-byte-odd'}`}
          title={`byte ${i}`}
        >
          {byte.toUpperCase()}
        </span>
      ))}
    </div>
  )
}
