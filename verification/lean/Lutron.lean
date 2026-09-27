import Std

/-!
Offline models for protocol/shared.ts and lib/cca-ota-codec.ts.
Natural-number arithmetic models nonnegative, integral inputs only.
These proofs concern the model; Main and the TypeScript differential runner
check its correspondence with production code on explicitly bounded domains.
-/
namespace Lutron

def levelMax : Nat := 65279

/-- Nearest-integer rounding, ties upward, for integral percentages. -/
def percentToLevel (percent : Nat) : Nat := (percent * levelMax + 50) / 100

theorem level_zero : percentToLevel 0 = 0 := by decide
theorem level_full : percentToLevel 100 = levelMax := by decide

theorem level_bounded (p : Nat) (h : p ≤ 100) : percentToLevel p ≤ levelMax := by
  unfold percentToLevel levelMax
  omega

theorem level_monotone (p q : Nat) (h : p ≤ q) :
    percentToLevel p ≤ percentToLevel q := by
  unfold percentToLevel levelMax
  omega

/-- Rounding error is at most half a level, expressed without floating point. -/
theorem level_rounding_error (p : Nat) :
    100 * percentToLevel p ≤ p * levelMax + 50 ∧
    p * levelMax ≤ 100 * percentToLevel p + 50 := by
  unfold percentToLevel levelMax
  omega

def secondsToQs (seconds : Nat) : Nat := seconds * 4

def millisecondsToQs (milliseconds : Nat) : Nat := (milliseconds + 125) / 250

theorem quarter_seconds_roundtrip (q : Nat) : millisecondsToQs (q * 250) = q := by
  unfold millisecondsToQs
  omega

theorem whole_seconds_roundtrip (s : Nat) : secondsToQs s / 4 = s := by
  simp [secondsToQs]

/-- A byte on the CCA async serial link, least significant bit first. -/
def byteToBits (b : Fin 256) : List Nat :=
  (List.range 8).map fun i => (b.val / 2 ^ i) % 2

def bitsToNat : List Nat → Nat
  | [] => 0
  | b :: bs => b + 2 * bitsToNat bs

set_option maxRecDepth 4096 in
set_option maxHeartbeats 2000000 in
theorem byte_roundtrip : ∀ b : Fin 256, bitsToNat (byteToBits b) = b.val := by
  decide

theorem byte_has_eight_bits (b : Fin 256) : (byteToBits b).length = 8 := by
  simp [byteToBits]

set_option maxRecDepth 4096 in
set_option maxHeartbeats 2000000 in
theorem bits_are_binary : ∀ b : Fin 256, ∀ bit ∈ byteToBits b, bit < 2 := by
  decide

/-- Independent bytes may be serialized and recovered without loss. -/
theorem bytes_roundtrip (bytes : List (Fin 256)) :
    (bytes.map byteToBits).map bitsToNat = bytes.map Fin.val := by
  induction bytes with
  | nil => rfl
  | cons b bs ih => simp [byte_roundtrip, ih]

end Lutron
