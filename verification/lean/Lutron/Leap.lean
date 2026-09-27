import Std

namespace Lutron.Leap

inductive Event where
  | interim | success | refusal | timeout | close | other | detach
  deriving Repr, DecidableEq

/-- One allocated request/tag, optionally opening a subscription.
    Counts describe public promise settlement and callback routing. -/
structure State where
  pending : Bool := true
  subscription : Bool := false
  subscribing : Bool := false
  resolved : Nat := 0
  rejected : Nat := 0
  pushes : Nat := 0
  unsolicited : Nat := 0
  deriving Repr, DecidableEq

def initial (subscribe : Bool) : State :=
  { subscription := subscribe, subscribing := subscribe }

def step (s : State) (event : Event) : State :=
  match event with
  | .other => { s with unsolicited := s.unsolicited + 1 }
  | .detach => { s with subscription := false }
  | .close => { s with
      pending := false
      subscription := false
      rejected := s.rejected + (if s.pending then 1 else 0) }
  | .timeout =>
      if s.pending then { s with
        pending := false
        subscription := false
        rejected := s.rejected + 1 } else s
  | .interim | .success | .refusal =>
      if s.pending then
        if event = .interim then s
        else if event = .refusal ∧ s.subscribing then
          { s with pending := false, subscription := false, rejected := s.rejected + 1 }
        else { s with pending := false, resolved := s.resolved + 1 }
      else if s.subscription then { s with pushes := s.pushes + 1 }
      else { s with unsolicited := s.unsolicited + 1 }

def Invariant (s : State) : Prop :=
  s.resolved + s.rejected + (if s.pending then 1 else 0) = 1

theorem initial_invariant (subscribe : Bool) : Invariant (initial subscribe) := by
  simp [Invariant, initial]

theorem step_invariant (s : State) (event : Event) (h : Invariant s) :
    Invariant (step s event) := by
  cases event <;> simp_all [step, Invariant] <;>
    repeat (first | split | simp_all | omega)
  all_goals assumption

theorem trace_invariant (events : List Event) (subscribe : Bool) :
    Invariant (events.foldl step (initial subscribe)) := by
  have go : ∀ (s : State), Invariant s → Invariant (events.foldl step s) := by
    induction events with
    | nil => simp
    | cons e es ih =>
      intro s hs
      exact ih (step s e) (step_invariant s e hs)
  exact go _ (initial_invariant subscribe)

theorem settles_at_most_once (events : List Event) (subscribe : Bool) :
    let s := events.foldl step (initial subscribe)
    s.resolved + s.rejected ≤ 1 := by
  have h := trace_invariant events subscribe
  unfold Invariant at h
  dsimp
  split at h <;> omega

theorem interim_preserves_pending (s : State) (h : s.pending = true) :
    step s .interim = s := by simp [step, h]

theorem close_clears (s : State) :
    (step s .close).pending = false ∧ (step s .close).subscription = false := by
  simp [step]

theorem refusal_detaches (s : State) (hp : s.pending = true)
    (hs : s.subscribing = true) : (step s .refusal).subscription = false := by
  simp [step, hp, hs]

theorem detached_does_not_push (s : State) (e : Event) (h : s.subscription = false) :
    (step s e).pushes = s.pushes := by
  cases e <;> simp [step, h] <;> repeat (first | split | simp_all)

end Lutron.Leap
