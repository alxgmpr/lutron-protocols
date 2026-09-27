import Std

namespace Lutron.Cca

/-- Bit-at-a-time polynomial reduction, independent of the TS lookup table. -/
def shift (c : UInt16) : UInt16 :=
  (c <<< 1) ^^^ (if c &&& 0x8000 != 0 then 0xca0f else 0)

def crcStep (c : UInt16) (b : Nat) : UInt16 :=
  (Nat.repeat shift 8 c) ^^^ UInt16.ofNat b

def crc (bytes : List Nat) : UInt16 := bytes.foldl crcStep 0

def checksum (bytes : List Nat) : List Nat :=
  let n := (crc bytes).toNat
  [n / 256, n % 256]

theorem checksum_bytes (bytes : List Nat) : ∀ b ∈ checksum bytes, b < 256 := by
  have h := (crc bytes).toNat_lt
  simp only [checksum, List.mem_cons, List.not_mem_nil, or_false]
  intro b hb
  rcases hb with rfl | rfl <;> omega

/-- Comparing two checksum bytes agrees with the TS big-endian integer check. -/
theorem checksum_equivalence (bytes : List Nat) (hi lo : Nat)
    (hlo : lo < 256) :
    hi * 256 + lo = (crc bytes).toNat ↔ [hi, lo] = checksum bytes := by
  simp [checksum]
  omega

def payload (opcode : Nat) (body : List Nat) : List Nat :=
  (body.length + 1) :: opcode :: body

/-- Packet starting at LEN, after the fixed six-byte preamble/sync prefix. -/
def encode (opcode : Nat) (body : List Nat) : List Nat :=
  payload opcode body ++ checksum (payload opcode body)

def wire (opcode : Nat) (body : List Nat) : List Nat :=
  [0x55, 0x55, 0x55, 0xff, 0xfa, 0xde] ++ encode opcode body

/-- Like parseOtaPacket, accept one packet and leave any trailing stream bytes. -/
def parse : List Nat → Option (Nat × List Nat × Nat)
  | len :: opcode :: rest =>
    if len = 0 ∨ rest.length < len + 1 then none
    else
      let body := rest.take (len - 1)
      if (rest.drop (len - 1)).take 2 = checksum (len :: opcode :: body)
      then some (opcode, body, len + 3)
      else none
  | _ => none

theorem encode_length (opcode : Nat) (body : List Nat) :
    (wire opcode body).length = body.length + 10 := by
  simp [wire, encode, payload, checksum]

theorem length_fits (body : List Nat) (h : body.length ≤ 254) :
    1 ≤ body.length + 1 ∧ body.length + 1 ≤ 255 := by omega

theorem wire_bytes (opcode : Nat) (body : List Nat)
    (hop : opcode < 256) (hlen : body.length ≤ 254)
    (hbody : ∀ b ∈ body, b < 256) : ∀ b ∈ wire opcode body, b < 256 := by
  intro b hb
  have hc := checksum_bytes (payload opcode body) b
  simp only [wire, encode, List.mem_append, payload, List.mem_cons,
    List.not_mem_nil, or_false] at hb
  rcases hb with (h | h | h | h | h | h) | (h | h | h) | h
  all_goals first | omega | exact hbody b h | exact hc h

/-- Round-trip any body and opcode, even with an arbitrary trailing stream.
    Byte-validity/maximum length are separate preconditions on callers. -/
theorem parse_encode (opcode : Nat) (body tail : List Nat) :
    parse (encode opcode body ++ tail) = some (opcode, body, body.length + 4) := by
  simp [encode, payload, parse, List.append_assoc, checksum]
  omega

theorem reject_zero (opcode : Nat) (rest : List Nat) :
    parse (0 :: opcode :: rest) = none := by simp [parse]

theorem reject_truncated (len opcode : Nat) (rest : List Nat)
    (h : rest.length < len + 1) : parse (len :: opcode :: rest) = none := by
  simp [parse, h]

theorem reject_bad_crc (opcode : Nat) (body trailer : List Nat)
    (ht : trailer.length = 2) (bad : trailer ≠ checksum (payload opcode body)) :
    parse ((body.length + 1) :: opcode :: (body ++ trailer)) = none := by
  have takeTrailer : trailer.take 2 = trailer := by
    rw [← ht]
    exact List.take_length
  simp [parse, ht, takeTrailer, payload] at *
  exact bad

end Lutron.Cca
