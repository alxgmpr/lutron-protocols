import Std

namespace Lutron.Ccx

/-- The unsigned 32-bit subset used by ccx/encoder.ts. -/
def uint (n : Nat) : List Nat :=
  if n < 24 then [n]
  else if n < 256 then [24, n]
  else if n < 65536 then [25, n / 256, n % 256]
  else [26, n / 16777216, (n / 65536) % 256, (n / 256) % 256, n % 256]

def readUint : List Nat → Option Nat
  | [n] => if n < 24 then some n else none
  | [24, n] => some n
  | [25, hi, lo] => some (hi * 256 + lo)
  | [26, a, b, c, d] => some (a * 16777216 + b * 65536 + c * 256 + d)
  | _ => none

theorem uint_roundtrip (n : Nat) : readUint (uint n) = some n := by
  unfold uint
  split
  · simp [readUint, *]
  · split
    · simp [readUint]
    · split
      · simp only [readUint, Option.some.injEq]
        omega
      · simp only [readUint, Option.some.injEq]
        omega

theorem uint_bytes (n : Nat) (h : n < 4294967296) : ∀ b ∈ uint n, b < 256 := by
  unfold uint
  split <;> (try split) <;> (try split) <;>
    simp only [List.mem_cons, List.not_mem_nil, or_false] <;>
    intros <;> omega

/-- Default LEVEL_CONTROL: [0, {0: {0: level, 3: 1}, 1: [16, zone], 5: seq}]. -/
def levelControl (zone level seq : Nat) : List Nat :=
  [0x82, 0, 0xa3, 0, 0xa2, 0] ++ uint level ++
  [3, 1, 1, 0x82, 16] ++ uint zone ++ [5] ++ uint seq

end Lutron.Ccx
