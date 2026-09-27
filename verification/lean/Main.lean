import Lutron
import Lutron.Packet
import Lutron.Ccx
import Lutron.Leap

def csv (bytes : List Nat) : String := String.intercalate "," (bytes.map toString)

def leapSnapshot (s : Lutron.Leap.State) : String :=
  csv [if s.pending then 1 else 0, if s.subscription then 1 else 0,
    s.resolved, s.rejected, s.pushes, s.unsolicited]

def eventOfNat : Nat → Lutron.Leap.Event
  | 0 => .interim | 1 => .success | 2 => .refusal
  | 3 => .timeout | 4 => .close | _ => .other

/-- Tab-separated executable model output, consumed by check-lean.ts. -/
def main : IO Unit := do
  let out ← IO.getStdout
  for p in [:101] do
    out.putStrLn s!"level\t{p}\t{Lutron.percentToLevel p}"
  for q in [:256] do
    -- Exact quarter-second values are representable in JavaScript binary64.
    out.putStrLn s!"fade\t{q}\t{Lutron.millisecondsToQs (q * 250)}"
  for b in [:256] do
    if h : b < 256 then
      let bits := Lutron.byteToBits ⟨b, h⟩
      let encoded := String.intercalate "," (bits.map toString)
      out.putStrLn s!"bits\t{b}\t{encoded}\t{Lutron.bitsToNat bits}"
  -- Every opcode, every valid body length, and different polynomial states.
  for opcode in [:256] do
    let body := (List.range (opcode % 255)).map fun i => (i * 73 + opcode) % 256
    let wire := Lutron.Cca.wire opcode body
    out.putStrLn s!"cca\t{opcode}\t{csv body}\t{csv wire}"
  let boundaries := [0, 1, 23, 24, 25, 254, 255, 256, 257, 65279,
    65535, 65536, 16777215, 16777216, 2147483647, 2147483648, 4294967295]
  for n in boundaries do
    out.putStrLn s!"ccx\t{n}\t{csv (Lutron.Ccx.uint n)}\t{csv (Lutron.Ccx.levelControl n 65279 n)}"
  for subscribe in [false, true] do
    for a in [:6] do
      for b in [:6] do
        for c in [:6] do
          let events := [a, b, c]
          let mut s := Lutron.Leap.initial subscribe
          let mut snapshots := []
          for e in events do
            s := Lutron.Leap.step s (eventOfNat e)
            snapshots := snapshots ++ [leapSnapshot s]
          out.putStrLn s!"leap\t{if subscribe then 1 else 0}\t{csv events}\t{String.intercalate ";" snapshots}"
  for response in [1, 2] do
    let s := Lutron.Leap.step (Lutron.Leap.initial true) (eventOfNat response)
    let final := Lutron.Leap.step s .success
    out.putStrLn s!"leap-batch\t1\t{response},1\t{leapSnapshot s};{leapSnapshot final}"
  out.putStrLn s!"leap-reset\t0\t{leapSnapshot (Lutron.Leap.initial false)}"
  let detached := [Lutron.Leap.Event.success, .detach, .success].foldl
    Lutron.Leap.step (Lutron.Leap.initial true)
  out.putStrLn s!"leap-detach\t1\t{leapSnapshot detached}"
