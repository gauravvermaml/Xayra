#!/usr/bin/env python3
"""Standard SFT dataset generator for the Qwen2.5-1.5B extraction model — v8.1
(Hybrid Architecture).

WHY V8.1 REBALANCES RAG AND ADDS INDIRECT-QUESTION COVERAGE
-----------------------------------------------------------
v8 was trained and run through the full 103-case harness: 90.3% (93/103),
the first checkpoint to beat the 83.5% baseline — extraction (dates,
recurrence, contrastive, third-party via the code pre-filter) all held at
or near 100%. But `rag-grounding` dropped to 1/4 (from v7's 2/4) and
`rag-refusal` had one miss.

Diagnosed from the ACTUAL raw model output for all 4 failures (not just the
scoring summary) before touching anything:

  * 3 of 4 (`rag-005`, `rag-006`, `gen-rag-allergy`) are genuine
    OVER-REFUSAL: the model answered "No information found in your notes."
    even though the fact was plainly present in the supplied context. The
    common thread across all three: every one is an INDIRECT question
    ("What did Eli say?", "Do I need to do anything about the gym?", "Is
    there anything I should remember about the dinner?") — a phrasing shape
    `make_rag_factual`'s question pool never trained, which only ever used
    DIRECT fact-lookup phrasing ("When does my gym membership renew?").
  * The 4th (`rag-004`) is a DIFFERENT bug: with genuinely empty context,
    the model did not over-answer — it paraphrased the refusal ("I'm sorry,
    but I couldn't find...") instead of the exact trained string. Worth
    flagging plainly: v8.1 REDUCES refusal training volume (75 -> 25) to
    fix the 3-case over-refusal problem, which could make this specific
    exact-string-robustness issue not improve, or mildly worsen, since it
    is the opposite failure direction on the same axis. Not addressed by
    this file — the fix for it would live in the scoring harness (recognise
    a semantically-correct paraphrase) or a v8.2 that improves refusal
    phrasing robustness specifically, if it recurs.

v8.1 changes:

  1. RAG ratio: 75/75 (50/50) -> 125/25 (85/15) factual/refusal — directly
     reduces how often the model is shown ANY refusal target, addressing
     the over-refusal pattern at the volume level.
  2. Two new `RAG_SUBJECTS` entries modelled directly on the two NEW failure
     SHAPES that weren't in the pool at all before — `recommendation_book`
     (a person recommending something, `rag-005`'s exact shape) and
     `dietary_note` (a fact embedded in an unrelated multi-note context,
     `gen-rag-allergy`'s exact shape) — not speculative additions.
  3. Indirect-question phrasings added to the `gym` subject specifically
     ("do you know if I need to do anything about the gym"-style), since
     `rag-006` is exactly that subject asked exactly that way.

WHY V8 REVERTS TO STANDARD SFT AND DROPS THIRD-PARTY/REFUSAL TRAINING
------------------------------------------------------------------------
Three real ORPO fine-tuning attempts (v5, v6, v7) all failed to teach
third-party attribution and pure-observation refusal reliably, and v7's
attempt to push harder on the SAME lever made the FULL 103-case harness
score WORSE than doing nothing (68.9% vs the 83.5% prompt-only baseline,
still undefeated after five real training attempts). Reading the v7
checkpoint's actual failures on the real corpus was the deciding evidence:
its spurious tasks were near-verbatim reproductions of the hand-authored
`rejected` fabrication strings this file trained it to AVOID ("Have the
plumber come", "Move house", "Collect green waste", "Resurface the
driveway" — literally copied from THIRD_PARTY_ACTIONS/ROUTINE_ORG_ACTIONS
below). Showing the model a small, fixed vocabulary of "wrong" completions,
even in ORPO's disfavoured slot, taught it those phrases are generically
plausible task-shaped outputs — the model was memorising the specific
fabrication vocabulary, not learning "there is no task in a third-party or
observation note." Refusal (pure observation, no third party) regressed the
same way for the same reason: WEATHER_OBS/OPINION_OBS/etc. are similarly
small, fixed pools.

The Hybrid Architecture accepts this as a real ceiling on what fine-tuning
should be asked to do here, rather than continuing to scale the same
mechanism. Third-party/observation refusal is now decided by a
DETERMINISTIC pre-filter in code (`preFilterZeroTaskNotes` in
services/ai/extractionLogic.ts) — verified against the frozen 103-case eval
corpus with ZERO false positives before being written, catching 25 of the
26 known zero-task cases. Fine-tuning is scoped down to exactly the
behaviours every prior run (v5, v6, v7) actually got right every single
time: date resolution, recurrence, STT-noise tolerance, and contrastive
skip-the-distractor extraction — plus RAG grounding/refusal, which held up
reasonably (rag-factual 4/4, rag-refusal 2/3 on the v7 harness run).

Consequences for this file:

  1. Format reverts from ORPO's `{"prompt","chosen","rejected"}` triples
     back to plain SFT `{"messages": [...]}` rows — a system/user/assistant
     list, letting the tokenizer's own chat template (applied in the
     notebook) handle ChatML formatting, rather than this file hand-building
     `<|im_start|>...<|im_end|>` strings. No `rejected` side exists at all;
     there is nothing left for ORPO's preference mechanism to score, so the
     notebook reverts to a standard `SFTTrainer` + `train_on_responses_only`
     (masks the loss to assistant tokens only — see the notebook's own
     section 4 for the exact API, verified against Unsloth's docs before
     writing it, the same discipline `PatchDPOTrainer` got in v4).
  2. `extraction_zero_task_refusal` and `extraction_third_party_refusal` are
     REMOVED from TARGET_DISTRIBUTION entirely — 0 pure-refusal rows, by
     design, not omission. `make_zero_task`/`make_third_party` (and their
     supporting fabrication helpers) are left in this file, UNUSED by
     `build()`, the same "preserve, don't delete" precedent v4 set for
     `make_rag_factual`/`make_rag_refusal` when RAG was dropped — they
     remain genuinely useful as a source of realistic third-party/
     observation note text for testing `preFilterZeroTaskNotes`'s coverage
     independent of training.
  3. The freed-up budget goes to `extraction_positive_other`: 270 (up from
     v7's 184), with date coverage raised to >=70% and recurrence to >=25%
     (both directive targets, up from v7's 60%/20%) — more room now that
     this bucket doesn't have to make space for a refusal bucket at all.
  4. `extraction_contrastive` stays at 80 — this was the one thing v3
     onward always got right (4/4 on every single trained checkpoint), and
     nothing about the failure this responds to implicates it.
  5. RAG (150 rows: 75 factual, 75 refusal) is unaffected structurally, but
     also reverts to a single `answer` per row (no `rejected` side) for the
     same reason as extraction. The refusal string is unchanged:
     byte-identical to `MINIMAL_RAG_SYSTEM_PROMPT`'s own instructed reply,
     "No information found in your notes." — a `v8` implementation directive
     specified a different phrasing ("I couldn't find any information about
     that in your notes."); that was not adopted, since training the model
     to say something OTHER than what its own system prompt instructs would
     reintroduce exactly the byte-mismatch class of bug this file's module
     docstring has warned against since v1 ("TWO SYSTEM PROMPTS, ONE MODEL"
     section, below).

Total dataset stays 500 rows: 350 extraction (270 positive + 80
contrastive, 0 refusal) + 150 RAG (75 factual + 75 refusal).

WHY V7 GOES BIGGER ON THIRD-PARTY (superseded by v8 above; kept for history)
-------------------------------------------------------------------
v6 WAS actually trained (fresh model load confirmed: 18,464,768 trainable
params, 126 steps, loss 3.62 -> 1.04 over 2 epochs) and run through the
20-case sweep. Result: third-party attribution was STILL 1/8, producing
outputs nearly identical to v5's failed checkpoint. This means v6's fix — a
26->36 count bump for third-party plus mixed rejected fabrication shapes —
was real but too WEAK a perturbation: a ~40% relative increase (10 rows out
of 350) barely moved anything against 298 rows reinforcing "there is a
task-shaped sentence, extract it," especially with only 1.18% of the
model's parameters trainable (LoRA r=16) and training loss still visibly
descending at the final step (not plateaued — the run may have been
undertrained in general, not just imbalanced).

v7 responded with FOUR changes together: `extraction_third_party_refusal`
36 -> 70, a `warmup_steps` fallback for trl's dropped `warmup_ratio`, 3
epochs instead of 2, and LoRA r=32 instead of 16. Trained and evaluated
against the full 103-case harness: 68.9% (71/103), third-party STILL 1/8,
refusal collapsed to 5/17 — WORSE than doing nothing. This is the run whose
actual failure output (verbatim reproductions of this file's own
fabrication strings) is what v8 above responds to directly.

WHY V6 REBUILDS THE THIRD-PARTY REJECTED SHAPE (superseded; kept for history)
------------------------------------------------------------------------------
v5 was actually trained and run through the 20-case Colab validation sweep.
Contrastive (4/4), pure-observation refusal (4/4), and dated tasks (4/4) all
held — but third-party attribution, the single most-targeted failure of this
entire multi-week arc, collapsed to 1/8. Crucially, this was NOT the same
failure as Run 3's: reading the actual generated output showed the model no
longer producing v3's bare hallucinated noun ("Garden", "Plumber"). Instead
it paraphrased the third party's own action into a plausible-sounding task —
`"Have plumber come on Thursday"`, `"Read the gas meter"`,
`"Resurface the driveway"` — a DIFFERENT wrong answer than the one v5's
`rejected` side had ever shown it.

Root cause: `extraction_refusal`'s rejected side (`_hallucinated_rejected`)
only ever demonstrated ONE fabrication shape — a bare noun grabbed from
after an article ("the roof" -> "Roof"). ORPO penalises the SPECIFIC
`rejected` example shown for a prompt, not the general principle "don't
invent a task here" — so the model learned to avoid that one narrow pattern
while the broader mistake (extracting anything at all from a third-party
note) re-emerged in an ORPO-unpunished shape.

v6 gave zero-task and third-party separate guaranteed counts, added a 5th
third-party sentence shape (`ROUTINE_ORG_ACTIONS`) modelled on the
validation sweep's own phrasing, and mixed several fabrication shapes per
row instead of one. This dataset was trained (see "WHY V7" above) and the
fix was measured as too weak, then v8 (top of this docstring) abandoned the
whole ORPO-negative-example approach for this behaviour.

WHY V5 RESTORES RAG AND REDESIGNS CONTRASTIVE (kept for history)
-----------------------------------------------
v4 excluded RAG entirely and shipped 350 extraction-only triplets, on the
reasoning that ORPOTrainer needs prompt/chosen/rejected uniformly and no
rejected-answer design for RAG had been specified yet. That scope cut was
rejected: training only on extraction risks catastrophic forgetting of RAG
grounding exactly the way v1's extraction-only SFT run risked (and, for
other behaviours, actually caused) collateral damage elsewhere. v5
re-activated `make_rag_factual`/`make_rag_refusal` (dormant since v4) as
ORPO preference-pair sources. v8 (top of this docstring) keeps RAG active
but reverts its output shape to a single answer, since ORPO itself is gone.

v5 also changed the CONTRASTIVE bucket's `rejected` shape to penalise
leaking the distractor as an extra item specifically. v8 keeps
`make_contrastive`'s NOTE GENERATION unchanged (it was never the problem —
contrastive held 4/4 on every trained checkpoint, v5 through v7) but drops
the `rejected`-side machinery along with the rest of ORPO.

WHY V4 MOVES OFF PLAIN SFT (superseded by v8's own return to SFT; kept for
history — the mechanism v4 fixed for extraction is different from why v8
returns to it: v4 needed negative supervision because a SKEWED RATIO of
positive-vs-refusal plain-SFT examples was pushing the model toward whichever
behaviour dominated the mix. v8 has NO refusal examples at all, so that
seesaw mechanism cannot recur — there is no ratio to skew.)
---------------------------
v2 and v3 both used the same lever — the ratio of positive-to-refusal SFT
examples — and both broke, in opposite directions:

    v2 (50% refusal):  third-party 0/8->8/8, refusal 11/17->17/17  [FIXED]
                        date-resolution 20/20->6/20, recurrence 8/8->1/8 [BROKE]
    v3 (15% refusal):  date-resolution 6/20->19/20, recurrence 1/8->8/8 [FIXED]
                        third-party 8/8->0/8, refusal 17/17->6/17 [BROKE]

Both runs showed the identical mechanism: plain SFT only ever teaches "this
completion is correct," never "this completion is wrong." With no negative
signal, the model's only lever for avoiding one failure mode is seeing MORE
examples of the opposite behaviour — which just pushes it into the other
failure mode once that behaviour dominates the training mix.

ORPO (v4-v7) tried fixing this with negative supervision instead of ratio
tuning. It worked for contrastive (skip-the-distractor) but never
generalised for third-party/refusal specifically — see "WHY V8" at the top
for why that axis is now a code-side guard instead.

WHY V3 EXISTED (kept for history)
-----------------------------------
v2 (500 samples, extraction + RAG) fully fixed both v1 targets — third-party
attribution 0/8 -> 8/8, zero-task refusal 11/17 -> 17/17 — but at a cost that
made the checkpoint unshippable: date-resolution collapsed 20/20 -> 6/20 and
recurrence 8/8 -> 1/8, and attribution ITSELF regressed on cases it used to
pass (attr-001: "Eli recommended The Overstory. His brother Elias is moving
to Perth..." came back "[]", dropping the real task along with the
third-party clause it sat next to).

Root cause, found by reading the actual failing model output rather than
trusting the score alone: every failure showed the identical 2-token bare
"[]" signature. v2's extraction slice was 50% pure refusal (175 samples that
NEVER contained a task) against only 50% positive, and among those
positives, only ONE example anywhere (Ravi/Sapiens, in the few-shot prompt,
not even in this generator) demonstrated "a note can mention someone else
AND still contain a real task for you." The model generalised the
overwhelming signal — mentioning another person/observation means refuse —
rather than the rare one.

v3 changes, directly answering that: extraction rebalanced to 85% positive /
15% pure refusal, and 75+ of the positive samples are now CONTRASTIVE —
built from a distractor clause (third-party or observation) AND a real task
in the same note, so the model sees the actual needed distinction (skip
their part, keep yours) at real volume instead of one prompt example doing
all the work. Date and recurrence coverage are also pushed harder (>150
dated tasks, >50 recurring tasks, both verified by assertion) since the
contrastive bucket is large enough now to matter for those thresholds too,
not just for attribution.

WHY V2 EXISTED (kept for history)
-------------
v1 (450 samples, extraction only) was trained and evaluated against the
103-case harness. The two target failures moved decisively:

    third-party attribution   0/8  (0%)   -> 6/8  (75%)
    zero-task refusal        11/17 (65%)  -> 17/17 (100%)

But four categories that were previously perfect collapsed:

    date-resolution           20/20 (100%) -> 9/20  (73.3% -> actually
                                                accuracy 57.1%)
    recurrence                 8/8  (100%) -> 3/8   (37.5%)
    stt-noise                 23/23 (100%) -> 18/23 (89.9%)
    rag-grounding               3/4  (75%) -> 1/4   (75.0% F1, real miss)

Root cause, found by auditing v1's own training data: every one of its 178
training tasks had `"recurrence": "none"`. The generator never produced a
recurring task, so the model correctly learned that recurrence is always
"none" — catastrophic forgetting of a behaviour the base model already had,
because v1 never showed a single counter-example. Multi-task samples also
only ever attached a date to the FIRST task, an invented rule with no basis
in the schema.

Net result was a WORSE model overall (70.9% vs the 83.5% prompt-only
baseline) despite fixing the two headline bugs. Do not repeat that mistake:
a corrective fine-tune that trades working behaviour for the two behaviours
under test is not a win, it is a different set of bugs.

v2 changes, directly answering that audit:

  * Explicit non-"none" recurrence samples (daily / weekly / monthly / "every
    Monday"-shaped) are now a real, generated subtype — not an omission.
  * RAG Q&A is a first-class sample type, not just extraction. The base
    model's RAG grounding also has to survive this fine-tune; training only
    on extraction and hoping RAG is unaffected is exactly the untested
    assumption that caused the v1 regression elsewhere.
  * Distribution is now 35/35/15/15 across extraction-positive,
    extraction-refusal (zero-task + third-party combined),  RAG-factual and
    RAG-refusal — see `TARGET_DISTRIBUTION` below.

WHY GENERATE RATHER THAN HAND-WRITE
------------------------------------
Unchanged from v1: fragments are combined programmatically so the model sees
varied surface forms rather than memorising a few hundred fixed sentences,
and note+answer are produced from the same template so the answer key cannot
silently be wrong the way two v1 EVALUATION cases were (a car-registration
note said "rego" but the expected task said "registration"; a two-item note
was scored as one task when the prompt explicitly instructs splitting). The
evaluation corpus is never used as training data.

TWO SYSTEM PROMPTS, ONE MODEL
------------------------------
The app runs extraction and RAG as separate completions against the same
shared llama.cpp context — different system prompt per call, same weights.
That is normal for an instruct model and is why this file trains both task
shapes with their own prompt rather than inventing one blended prompt for
both.

`EXTRACTION_SYSTEM_PROMPT` below MUST stay byte-identical to
`MINIMAL_EXTRACTION_SYSTEM_PROMPT` in services/ai/extractionLogic.ts — that is
the prompt the app actually sends when `setExtractionPromptMode("minimal")` is
active, and training against a different string would mean evaluating one
prompt while shipping another.

`RAG_SYSTEM_PROMPT` below MUST stay byte-identical to `MINIMAL_RAG_SYSTEM_PROMPT`
in services/ai/ragPrompt.ts, the same contract EXTRACTION_SYSTEM_PROMPT has
with extractionLogic.ts. Kept as a literal for the same reason: this is a
Python script, that file is TypeScript, and nothing enforces the match
automatically.

The note-context framing (`_note_block` below) mirrors formatNoteContext() in
services/ai/ragFormatting.ts: "--- NOTE N [Recorded: ...] ---" headers, not
the bare "--- NOTE N ---" v2's first draft used. That timestamp is not
decorative — Law 7 of the FULL prompt tells the model to read relative time
phrases from exactly that label, and training the minimal-prompt model on a
context shape the app never actually produces would be silently teaching it
to answer a format nobody sends it.
"""

from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path

# Must match services/ai/extractionLogic.ts's MINIMAL_EXTRACTION_SYSTEM_PROMPT
# exactly. Kept as a literal, not imported, because this is a Python script
# and that file is TypeScript — nothing enforces the match automatically, so
# any edit to one requires a manual edit to the other.
EXTRACTION_SYSTEM_PROMPT = (
    "You are an executive task extraction assistant. Extract actionable user "
    "tasks into the requested JSON schema. If no tasks exist for the user, "
    "return []."
)

# Must match services/ai/ragPrompt.ts's MINIMAL_RAG_SYSTEM_PROMPT exactly.
RAG_SYSTEM_PROMPT = (
    "You are Xayra, an on-device notes assistant. Answer the question using "
    "ONLY the note context provided below. If the answer is not in the "
    "notes, reply exactly: \"No information found in your notes.\""
)

# Byte-identical to what MINIMAL_RAG_SYSTEM_PROMPT itself instructs the model
# to reply — NOT the "I couldn't find any information about that in your
# notes." phrasing a v8 implementation directive specified. Training a
# different string than the system prompt's own instruction would be exactly
# the class of byte-mismatch bug this file's "TWO SYSTEM PROMPTS, ONE MODEL"
# section has warned about since v1.
REFUSAL_ANSWER = "No information found in your notes."

SEED = 20260922

# Fraction of the 500-row TOTAL in each bucket. Verified to sum to 1.0 by an
# assertion in `build()` rather than trusted by eye.
#
# v8 (Hybrid Architecture): third-party/observation refusal is REMOVED from
# this distribution entirely — see the module docstring's "WHY V8" section.
# The freed budget goes to extraction_positive_other (184 -> 270), and
# contrastive stays at 80 (the one behaviour every prior run got right).
#
#   extraction_contrastive     80 / 500 = 16.0%  (floor: 75+)
#   extraction_positive_other 270 / 500 = 54.0%  (v8: up from 184 -- no
#                                                  refusal bucket to share
#                                                  the extraction budget with)
#   rag_factual               125 / 500 = 25.0%  (v8.1: up from 75 -- the
#                                                  v8-trained checkpoint
#                                                  over-refused on genuinely
#                                                  answerable INDIRECT
#                                                  questions; see the module
#                                                  docstring's "WHY V8.1")
#   rag_refusal                25 / 500 =  5.0%  (v8.1: down from 75)
#   ------------------------------------------------------------------------
#   extraction total          350 / 500 = 70.0%  (ALL positive -- 0% refusal)
#   rag total                 150 / 500 = 30.0%  (85% factual / 15% refusal)
TARGET_DISTRIBUTION = {
    "extraction_contrastive": 80 / 500,
    "extraction_positive_other": 270 / 500,
    "rag_factual": 125 / 500,
    "rag_refusal": 25 / 500,
}

# --------------------------------------------------------------------------
# Shared fragment pools
# --------------------------------------------------------------------------

TRADES = [
    "plumber", "electrician", "builder", "roofer", "gardener", "cleaner",
    "painter", "locksmith", "surveyor", "glazier", "arborist", "engineer",
    "technician", "inspector", "carpenter", "tiler", "landscaper",
]

THIRD_PARTY_PEOPLE = [
    "my sister", "my brother", "my neighbour", "a colleague", "my cousin",
    "the tenant", "the new manager", "my flatmate", "the previous owner",
    "one of the neighbours", "my brother-in-law", "the delivery driver",
]

THIRD_PARTY_ORGS = [
    "the council", "the gas company", "the water board", "the letting agency",
    "the removal firm", "the courier", "the broadband provider",
    "the insurance assessor", "the waste contractor",
]

VISIT_REASONS = [
    "to look at the boiler", "to check the wiring", "to quote for the roof",
    "to service the heating", "to read the meter", "to inspect the damp",
    "to measure the windows", "to fix the gate", "to assess the tree",
    "to replace the lock", "to survey the loft", "to clear the gutters",
    "to test the alarm", "to repair the fence",
]

# (action_phrase, fabricated_task) pairs. `fabricated_task` is unused in v8
# (no more rejected/fabricated examples get trained), kept only because
# make_third_party — dormant in v8, see its own docstring — still builds
# structured candidates from it for use as test-coverage data outside
# training.
THIRD_PARTY_ACTIONS = [
    ("is moving house", "Move house"),
    ("is starting a new job", "Start the new job"),
    ("is going on holiday", "Go on holiday"),
    ("is selling the flat", "Sell the flat"),
    ("is renovating the kitchen", "Renovate the kitchen"),
    ("is changing jobs", "Change jobs"),
    ("is having the driveway resurfaced", "Resurface the driveway"),
    ("is getting a new car", "Get a new car"),
    ("is redoing the bathroom", "Redo the bathroom"),
    ("is taking a sabbatical", "Take a sabbatical"),
]

# (gerund_phrase, fabricated_task) pairs — same "unused in v8 training, kept
# for dormant make_third_party" status as THIRD_PARTY_ACTIONS above.
ROUTINE_ORG_ACTIONS = [
    ("reading the meter", "Read the meter"),
    ("collecting the recycling", "Collect the recycling"),
    ("collecting the green waste", "Collect the green waste"),
    ("delivering a parcel", "Deliver the parcel"),
    ("servicing the boiler", "Service the boiler"),
    ("inspecting the drains", "Inspect the drains"),
    ("installing the new meter", "Install the new meter"),
    ("carrying out routine maintenance", "Carry out the routine maintenance"),
]

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

VISIT_TIMES = [
    "on {weekday}", "next {weekday}", "this {weekday}", "tomorrow",
    "on the {ord}", "in the morning", "at some point next week",
    "{weekday} afternoon", "early next week",
]

ORDINALS = ["3rd", "5th", "9th", "12th", "14th", "18th", "21st", "23rd", "27th", "30th"]

WEATHER_OBS = [
    "It was much colder than forecast this morning.",
    "The rain finally stopped around lunchtime.",
    "Beautiful clear sky the whole afternoon.",
    "It has been grey and damp for days now.",
    "The wind picked up considerably overnight.",
    "Warmest day of the month by a long way.",
    "There was frost on the grass first thing.",
    "Humidity was unbearable until the storm broke.",
]

OPINION_OBS = [
    "That new series is nowhere near as good as the first one.",
    "The bread from the corner shop is genuinely excellent.",
    "The redesign of the app has made it harder to use.",
    "Best meal I have had out in a long time.",
    "The album grows on you after a couple of listens.",
    "That restaurant is far too expensive for what it is.",
    "The book was slow to start but worth finishing.",
    "The coffee at the station is surprisingly decent.",
]

FEELING_OBS = [
    "Slept badly and felt groggy most of the day.",
    "Feeling much more settled than last week.",
    "Energy levels have been low since the weekend.",
    "Felt genuinely relaxed for the first time in ages.",
    "A bit off colour today, nothing serious.",
    "Much calmer once the deadline passed.",
    "Woke up with a headache that cleared by noon.",
]

EVENT_OBS = [
    "The train was delayed by about twenty minutes.",
    "The shop was closed when I got there.",
    "Traffic was lighter than usual on the way in.",
    "The park was packed because of the fair.",
    "The lift has been out of order all week.",
    "The meeting ran over by nearly an hour.",
    "The parcel arrived earlier than expected.",
]

REFLECTION_OBS = [
    "Thinking the old flat was probably the better location.",
    "Looking back, the timing worked out reasonably well.",
    "Still not sure that was the right call.",
    "It turned out easier than I had expected.",
    "Realised today how long it has been since I visited.",
    "Funny how quickly the year has gone.",
]

TASK_VERBS = [
    ("book", "Book"), ("call", "Call"), ("email", "Email"), ("order", "Order"),
    ("cancel", "Cancel"), ("renew", "Renew"), ("collect", "Collect"),
    ("return", "Return"), ("pay", "Pay"), ("send", "Send"),
    ("confirm", "Confirm"), ("chase", "Chase"), ("arrange", "Arrange"),
    ("replace", "Replace"), ("submit", "Submit"),
]

TASK_OBJECTS = [
    "the dentist", "the vet", "the insurance renewal", "the car service",
    "the electricity bill", "the library books", "the gym membership",
    "the delivery slot", "the parking permit", "the passport photos",
    "the broadband contract", "the tyre replacement", "the water filter",
    "the prescription", "the train tickets", "the hotel booking",
    "the window cleaner", "the council tax form",
]

# Deliberately wider than v1's flat list — includes month-boundary and
# deadline-style phrasing, since date-resolution held at 100% on the ones
# already tested and the goal here is not to lose that, not to prove it again
# with the same twelve strings.
RELATIVE_DATES = [
    "tomorrow", "next Monday", "next Friday", "this Thursday", "in three days",
    "in two weeks", "on the 12th", "at the end of the week", "next weekend",
    "first thing Monday", "before Friday", "on the 25th", "in a fortnight",
    "by the end of the month", "this coming Saturday", "on 3 November",
    "before the end of next week", "on the 1st of next month",
]

FILLERS = ["um", "uh", "so yeah", "okay so", "right so", "erm", "like"]

LEAD_INS = [
    "remind me to", "i need to", "i should", "need to", "must remember to",
    "gotta", "have to", "should probably",
]

TYPO_PAIRS = [
    ("libary", "library"), ("farmacy", "pharmacy"), ("insurence", "insurance"),
    ("subscribtion", "subscription"), ("labtop", "laptop"), ("garrage", "garage"),
    ("recipt", "receipt"), ("apointment", "appointment"), ("calender", "calendar"),
    ("adress", "address"), ("dilivery", "delivery"), ("buisness", "business"),
]

TYPO_TASKS = [
    ("cancel the {typo}", "Cancel the {fix}"),
    ("renew the {typo}", "Renew the {fix}"),
    ("check the {typo}", "Check the {fix}"),
    ("update the {typo}", "Update the {fix}"),
    ("find the {typo}", "Find the {fix}"),
    ("print the {typo}", "Print the {fix}"),
]

# Explicit recurrence phrasings, keyed to the schema's three real cadences.
# THIS POOL DID NOT EXIST IN v1, and its absence is the entire reason
# recurrence collapsed 8/8 -> 3/8. `date_phrase` mirrors the app's own
# convention (see FEW_SHOT_EXAMPLES in extractionLogic.ts): the recurrence
# phrase itself is copied into date_phrase, not left empty.
RECURRENCE_PATTERNS = [
    ("take the vitamins", "every morning", "daily"),
    ("check the emails", "every day", "daily"),
    ("go for a run", "every morning", "daily"),
    ("take the tablets", "every night", "daily"),
    ("put the bins out", "every Monday night", "weekly"),
    ("water the office plants", "every Friday", "weekly"),
    ("clean the filter", "every Sunday", "weekly"),
    ("submit the timesheet", "every Friday", "weekly"),
    ("do the food shop", "every Saturday morning", "weekly"),
    ("pay the rent", "on the 1st of every month", "monthly"),
    ("back up the photos", "every month", "monthly"),
    ("review the budget", "every month", "monthly"),
    ("check the smoke alarms", "every quarter", "monthly"),
    ("restock the first aid kit", "every 3 months", "monthly"),
    ("pay the storage fee", "on the 5th of every month", "monthly"),
    # "biweekly"/"fortnightly"/"every other week" all map to "weekly" — the
    # closest of the schema's four values — per the app's own recurrence
    # classification rule (extractionLogic.ts's buildSystemPrompt, FULL-mode
    # prose: "fortnightly", "biweekly" -> weekly is the closest of the four
    # options"). Not a new schema value; new PHRASINGS of an existing one.
    ("pay the cleaner", "every two weeks", "weekly"),
    ("water the office plants", "every fortnight", "weekly"),
    ("review the rota", "biweekly", "weekly"),
    ("check in with the team", "every other week", "weekly"),
]


def extraction_sample(note: str, tasks: list[dict], kind: str = "extraction", **extra) -> dict:
    # v4: this used to build the finished ChatML SFT row directly. v4-v7
    # made it return raw ingredients for an ORPO conversion step instead; v8
    # keeps the raw-ingredients shape (to_sft_extraction_row, below, is now
    # the ONE place (note, tasks, kind) becomes a trainer-ready row) since
    # that separation is still useful, even without ORPO's rejected side.
    #
    # `**extra`: a factory can stash whatever extra structured ingredients it
    # needs — make_contrastive no longer needs this in v8 (no fabrication
    # step to feed), but the dormant make_third_party still uses it for
    # `fabricated_candidates` (see its own docstring). Generic passthrough
    # instead of one named parameter per version avoids editing this
    # function's signature every time a new factory needs to stash
    # something.
    return {"note": note, "tasks": tasks, "kind": kind, **extra}


# --------------------------------------------------------------------------
# (a) Extraction — positive
# --------------------------------------------------------------------------

def make_dated_task(rng: random.Random) -> dict:
    """A single task with an explicit, varied date phrase."""
    verb_lower, verb_title = rng.choice(TASK_VERBS)
    obj = rng.choice(TASK_OBJECTS)
    date_phrase = rng.choice(RELATIVE_DATES)
    note = f"{rng.choice(LEAD_INS).capitalize()} {verb_lower} {obj} {date_phrase}."
    task = {"task": f"{verb_title} {obj}", "date_phrase": date_phrase, "recurrence": "none"}
    return extraction_sample(note, [task])


def make_stt(rng: random.Random) -> dict:
    """Unpunctuated, lowercase, filler-laden, with a mishearing."""
    typo, fix = rng.choice(TYPO_PAIRS)
    template, task_template = rng.choice(TYPO_TASKS)
    body = template.format(typo=typo)
    task = task_template.format(fix=fix)

    parts = []
    if rng.random() < 0.7:
        parts.append(rng.choice(FILLERS))
    parts.append(rng.choice(LEAD_INS))
    parts.append(body)

    date_phrase = ""
    if rng.random() < 0.45:
        date_phrase = rng.choice(RELATIVE_DATES)
        parts.append(date_phrase)

    note = " ".join(parts)  # deliberately no terminal punctuation
    return extraction_sample(note, [{"task": task, "date_phrase": date_phrase, "recurrence": "none"}])


def make_multi_task(rng: random.Random) -> dict:
    """Two or three tasks in one note, at most one carrying a date."""
    count = rng.randint(2, 3)
    chosen: list[tuple[str, str]] = []
    used: set[str] = set()

    while len(chosen) < count:
        verb_lower, verb_title = rng.choice(TASK_VERBS)
        obj = rng.choice(TASK_OBJECTS)
        if obj in used:
            continue
        used.add(obj)
        chosen.append((f"{verb_lower} {obj}", f"{verb_title} {obj}"))

    date_phrase = rng.choice(RELATIVE_DATES) if rng.random() < 0.6 else ""
    phrases = [p for p, _ in chosen]
    joined = ", ".join(phrases[:-1]) + f", and {phrases[-1]}"
    note = f"{rng.choice(LEAD_INS).capitalize()} {joined}"
    note = f"{note} {date_phrase}." if date_phrase else f"{note}."

    tasks = [
        {"task": task, "date_phrase": date_phrase if i == 0 else "", "recurrence": "none"}
        for i, (_, task) in enumerate(chosen)
    ]
    return extraction_sample(note, tasks)


def make_recurring_task(rng: random.Random) -> dict:
    """A task with real, non-'none' recurrence. THE MISSING SHAPE FROM v1."""
    verb_lower, phrase, recurrence = rng.choice(RECURRENCE_PATTERNS)
    lead = rng.choice(LEAD_INS)
    note = f"{lead.capitalize()} {verb_lower} {phrase}."
    task_title = verb_lower[0].upper() + verb_lower[1:]
    return extraction_sample(note, [{"task": task_title, "date_phrase": phrase, "recurrence": recurrence}])


# --------------------------------------------------------------------------
# (b) Extraction — refusal (zero-task + third-party) — DORMANT IN v8
# --------------------------------------------------------------------------
# NOT called by build() in v8 — see the module docstring's "WHY V8" section
# for why third-party/observation refusal training was dropped entirely
# rather than re-tuned again. Kept, not deleted: these remain a useful
# source of realistic third-party/observation note TEXT for testing
# preFilterZeroTaskNotes's coverage independent of training (see
# scripts/dataset/ — used exactly this way while building that pre-filter).
# --------------------------------------------------------------------------

def make_zero_task(rng: random.Random) -> dict:
    pool = rng.choice([WEATHER_OBS, OPINION_OBS, FEELING_OBS, EVENT_OBS, REFLECTION_OBS])
    note = rng.choice(pool)
    if rng.random() < 0.3:
        other = rng.choice(rng.choice([WEATHER_OBS, OPINION_OBS, EVENT_OBS]))
        if other != note:
            note = f"{note[:-1]} and {other[0].lower()}{other[1:]}"
    return extraction_sample(note, [], kind="extraction_zero_task_refusal")


def _reason_to_task(reason: str) -> dict:
    """"to look at the boiler" -> {"task": "Look at the boiler", ...}. Every
    VISIT_REASONS entry starts with "to ", so stripping it and capitalising
    the first letter always produces a grammatical, plausible-looking (but
    wrong) task."""
    stripped = reason[3:] if reason.startswith("to ") else reason
    return {"task": stripped[0].upper() + stripped[1:], "date_phrase": "", "recurrence": "none"}


def make_third_party(rng: random.Random) -> dict:
    """A note about someone/something ELSE's scheduled action — no task for
    the user at all. Dormant in v8 (see the section header above) — kept
    intact rather than simplified so its 5 sentence shapes remain available
    as realistic test-coverage data for preFilterZeroTaskNotes."""
    shape = rng.randint(0, 4)
    time_expr = rng.choice(VISIT_TIMES).format(weekday=rng.choice(WEEKDAYS), ord=rng.choice(ORDINALS))
    candidates: list[dict] = []

    if shape == 0:
        trade = rng.choice(TRADES)
        reason = rng.choice(VISIT_REASONS)
        note = f"The {trade} is coming {time_expr} {reason}."
        candidates.append({"task": f"Have the {trade} come", "date_phrase": "", "recurrence": "none"})
        candidates.append(_reason_to_task(reason))
    elif shape == 1:
        org = rng.choice(THIRD_PARTY_ORGS)
        reason = rng.choice(VISIT_REASONS)
        note = f"{org.capitalize()} is sending someone {time_expr} {reason}."
        candidates.append(_reason_to_task(reason))
    elif shape == 2:
        person = rng.choice(THIRD_PARTY_PEOPLE)
        action_phrase, fabricated_task = rng.choice(THIRD_PARTY_ACTIONS)
        note = f"{person.capitalize()} {action_phrase} {time_expr}."
        candidates.append({"task": fabricated_task, "date_phrase": "", "recurrence": "none"})
    elif shape == 3:
        person = rng.choice(THIRD_PARTY_PEOPLE)
        trade = rng.choice(TRADES)
        note = f"{person.capitalize()} said the {trade} will call round {time_expr}."
        candidates.append({"task": f"Have the {trade} call round", "date_phrase": "", "recurrence": "none"})
    else:
        org = rng.choice(THIRD_PARTY_ORGS)
        gerund, fabricated_task = rng.choice(ROUTINE_ORG_ACTIONS)
        note = f"{org.capitalize()} is {gerund} {time_expr}."
        candidates.append({"task": fabricated_task, "date_phrase": "", "recurrence": "none"})

    candidates.append(_fabricated_task_dict(rng, note))

    return extraction_sample(
        note, [], kind="extraction_third_party_refusal", fabricated_candidates=candidates
    )


# --------------------------------------------------------------------------
# (c)/(d) RAG — factual and refusal
# --------------------------------------------------------------------------
# Each subject is (noun_phrase, detail_template, question_template,
# answer_template), parametrised by date/amount/time/ordinal/city so a
# handful of subjects yields many distinct combinations. `{value}` in
# detail/answer refers to whatever parameter that subject actually needs.

RAG_AMOUNTS = ["$45", "$120", "$18.50", "$310", "$76", "$29.99", "$540"]
RAG_TIMES = ["7:15am", "9:30am", "2pm", "4:45pm", "11am", "6:20pm"]
RAG_CITIES = ["Tokyo", "Lisbon", "Auckland", "Vancouver", "Nairobi", "Osaka"]

RAG_SUBJECTS = [
    {
        "key": "car_rego",
        "detail": "Your car registration expires on {date}.",
        "answer": "Your car registration expires on {date}.",
        "needs": ["date"],
        "questions": [
            "When does my car registration expire?",
            "When's my car rego due?",
            "car rego",
            "expiry date for my car registration",
            "whens the car registration due",
            "do you know when my rego runs out",
            "car registration expiry",
        ],
    },
    {
        "key": "passport",
        "detail": "Your passport renewal is due by {date}.",
        "answer": "Your passport renewal is due by {date}.",
        "needs": ["date"],
        "questions": [
            "When is my passport renewal due?",
            "passport renewal date",
            "when's my passport due for renewal",
            "do i need to renew my passport soon",
            "whens the passport renewal",
        ],
    },
    {
        "key": "gym",
        "detail": "Your gym membership renews automatically on the {ordinal} of each month.",
        "answer": "Your gym membership renews automatically on the {ordinal} of each month.",
        "needs": ["ordinal"],
        "questions": [
            "When does my gym membership renew?",
            "gym renewal date",
            "when does the gym membership come out",
            "whens my gym payment",
            "does the gym renew automatically",
            # v8.1: indirect phrasings -- rag-006 asked exactly this subject
            # this way ("Do I need to do anything about the gym?") and the
            # v8 checkpoint refused despite the fact being in context, since
            # every prior question here was a DIRECT fact lookup.
            "do I need to do anything about the gym",
            "is there anything I should remember about my gym membership",
            "what's going on with my gym membership",
        ],
    },
    {
        "key": "insurance",
        "detail": "Your insurance premium of {amount} is due on {date}.",
        "answer": "Your insurance premium of {amount} is due on {date}.",
        "needs": ["amount", "date"],
        "questions": [
            "How much is my insurance premium and when is it due?",
            "insurance premium amount",
            "how much do i pay for insurance",
            "whens the insurance payment due",
            "what's my insurance premium",
        ],
    },
    {
        "key": "dentist",
        "detail": "Your dentist appointment is booked for {date} at {time}.",
        "answer": "Your dentist appointment is booked for {date} at {time}.",
        "needs": ["date", "time"],
        "questions": [
            "When is my dentist appointment?",
            "dentist appointment time",
            "whens the dentist booked for",
            "what time is the dentist",
            "do i have a dentist appointment coming up",
        ],
    },
    {
        "key": "rent",
        "detail": "Your rent of {amount} is due on the {ordinal}.",
        "answer": "Your rent of {amount} is due on the {ordinal}.",
        "needs": ["amount", "ordinal"],
        "questions": [
            "How much rent do I pay and when?",
            "rent due date",
            "when's rent due",
            "how much is the rent",
            "whens the rent payment",
        ],
    },
    {
        "key": "flight",
        "detail": "Your flight to {city} departs at {time} on {date}.",
        "answer": "Your flight to {city} departs at {time} on {date}.",
        "needs": ["city", "time", "date"],
        "questions": [
            "What time does my flight to {city} leave?",
            "flight to {city} departure time",
            "when's the {city} flight",
            "what time do i fly to {city}",
            "flight time for {city}",
        ],
    },
    {
        "key": "library",
        "detail": "Your library book is due back on {date}.",
        "answer": "Your library book is due back on {date}.",
        "needs": ["date"],
        "questions": [
            "When is my library book due back?",
            "library book due date",
            "when do i need to return the library book",
            "whens the libary book due",
        ],
    },
    {
        "key": "parking",
        "detail": "Your parking permit expires on {date}.",
        "answer": "Your parking permit expires on {date}.",
        "needs": ["date"],
        "questions": [
            "When does my parking permit expire?",
            "parking permit expiry",
            "whens the parking permit due",
            "do i need to renew the parking permit soon",
        ],
    },
    {
        "key": "water_bill",
        "detail": "Your water bill of {amount} is due on {date}.",
        "answer": "Your water bill of {amount} is due on {date}.",
        "needs": ["amount", "date"],
        "questions": [
            "How much is my water bill and when is it due?",
            "water bill amount",
            "whens the water bill due",
            "how much do i owe on water",
        ],
    },
    {
        "key": "storage_unit",
        "detail": "Your storage unit fee of {amount} renews on the {ordinal}.",
        "answer": "Your storage unit fee of {amount} renews on the {ordinal}.",
        "needs": ["amount", "ordinal"],
        "questions": [
            "How much is the storage unit and when does it renew?",
            "storage unit renewal date",
            "whens the storage fee due",
            "how much for the storage unit",
        ],
    },
    {
        "key": "broadband",
        "detail": "Your broadband contract renews on {date} at a new price of {amount}.",
        "answer": "Your broadband contract renews on {date} at a new price of {amount}.",
        "needs": ["date", "amount"],
        "questions": [
            "When does my broadband contract renew?",
            "broadband renewal date",
            "whens the internet contract up",
            "how much will broadband cost after it renews",
        ],
    },
    {
        "key": "vet",
        "detail": "The dog's vet checkup is booked for {date} at {time}.",
        "answer": "The dog's vet checkup is booked for {date} at {time}.",
        "needs": ["date", "time"],
        "questions": [
            "When is the dog's vet appointment?",
            "vet appointment time",
            "whens the dogs checkup",
            "what time is the vet booking",
        ],
    },
    {
        "key": "mot",
        "detail": "The car's MOT is due on {date}.",
        "answer": "The car's MOT is due on {date}.",
        "needs": ["date"],
        "questions": [
            "When is the car's MOT due?",
            "MOT due date",
            "whens the mot",
            "when does the mot expire",
        ],
    },
    # v8.1: two new subjects modelled directly on the two failure SHAPES
    # rag-005/gen-rag-allergy exposed that no prior subject covered at all —
    # a person recommending something, and a fact embedded in an unrelated
    # multi-note context. `needs: []` is deliberate: _rag_params(rng, [])
    # returns {} and `"literal string".format()` is a no-op, so these two
    # slot into make_rag_factual/make_rag_refusal/the distractor-sampling
    # logic unchanged — no code changes needed elsewhere for a subject with
    # no parameters to randomise.
    {
        "key": "recommendation_book",
        "detail": "Eli recommended the book The Overstory.",
        "answer": "Eli recommended The Overstory.",
        "needs": [],
        "questions": [
            "What did Eli say?",
            "what did eli recommend",
            "did eli suggest anything to read",
            "what book did eli mention",
            "is there anything eli told me to check out",
        ],
    },
    {
        "key": "dietary_note",
        "detail": "One of the dinner guests cannot eat peanuts.",
        "answer": "One of the guests cannot eat peanuts.",
        "needs": [],
        "questions": [
            "Is there anything I should remember about the dinner?",
            "anything to know before the dinner",
            "what should i keep in mind for the dinner",
            "do i need to remember anything about dinner",
        ],
    },
]


def _rag_params(rng: random.Random, needs: list[str]) -> dict:
    params = {}
    if "date" in needs:
        # Every RAG template hardcodes its own preposition before {date}
        # ("expires on {date}", "due by {date}") — RELATIVE_DATES entries
        # like "before Friday" or "on the 12th" already carry their OWN
        # preposition (they're built for extraction's bare
        # "{verb} {obj} {date_phrase}" shape, with no preposition of its
        # own), so plugging one in here produced double-preposition breakage
        # ("expires on before Friday", "expires on on the 12th") — found by
        # spot-checking the actual generated rows, not assumed. A bare
        # absolute date always reads correctly after any of the hardcoded
        # prepositions, so RAG uses that exclusively.
        params["date"] = f"{rng.randint(1, 28)} {rng.choice(['January','March','June','September','November'])}"
    if "ordinal" in needs:
        params["ordinal"] = rng.choice(ORDINALS)
    if "amount" in needs:
        params["amount"] = rng.choice(RAG_AMOUNTS)
    if "time" in needs:
        params["time"] = rng.choice(RAG_TIMES)
    if "city" in needs:
        params["city"] = rng.choice(RAG_CITIES)
    return params


RECORDED_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
RECORDED_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _recorded_timestamp(rng: random.Random) -> str:
    """Matches formatNoteDate()'s real output shape exactly: "Thursday, 14
    Aug 2026 at 09:00". Synthetic but shaped like production data, since the
    minimal RAG prompt has no LAWS block explaining what the label means —
    the model has to have seen the real shape often enough in training to
    use it correctly."""
    weekday = rng.choice(RECORDED_WEEKDAYS)
    day = rng.randint(1, 28)
    month = rng.choice(RECORDED_MONTHS)
    year = rng.choice([2025, 2026])
    hour = rng.randint(0, 23)
    minute = rng.choice([0, 5, 10, 15, 20, 30, 45])
    return f"{weekday}, {day:02d} {month} {year} at {hour:02d}:{minute:02d}"


def _note_block(rng: random.Random, index: int, content: str) -> str:
    """Mirrors formatNoteContext() in services/ai/ragFormatting.ts — see the
    module docstring for why the timestamp is not optional here."""
    return f"--- NOTE {index} [Recorded: {_recorded_timestamp(rng)}] ---\n{content}"


# Applied on top of a chosen base phrasing to multiply the effective question
# pool without hand-writing hundreds more templates. 13 subjects with ~7 fixed
# phrasings each gives only ~90 possible strings — with 150 RAG samples drawn
# from that, the birthday paradox alone guarantees heavy collision (measured:
# 60/150 distinct, 40%, against an 80% target). Wrapping the SAME base
# phrasing in a randomly chosen informal frame turns one template into several
# distinct strings while keeping it a natural-sounding question, which is
# what actually buys the 80% target back without inflating the hand-written
# pool to an unmaintainable size.
_WH_STARTS = ("when", "what", "how", "does", "is", "whens", "when's")
# NOT "do": a base phrasing already starting with "do" ("do i need to renew
# the parking permit soon") produces "do you know do i need..." — the
# auxiliary collides with the wrapper's own "do you know". Confirmed by
# generating and reading a sample of the output, not assumed.


def _is_clause(base: str) -> bool:
    """Whether `base` reads as a question CLAUSE ("when's the rent due") as
    opposed to a noun-phrase fragment ("rent due date"). Only a clause can
    follow "do you know" grammatically — "do you know rent due date" is not
    English, "do you know when the rent is due" is."""
    first_word = base.split(" ", 1)[0].lower().rstrip("?")
    return first_word in _WH_STARTS


QUESTION_WRAPPERS = [
    lambda q: q,
    lambda q: q.rstrip("?"),
    lambda q: q.lower().rstrip("?"),
    lambda q: f"quick one - {q[0].lower()}{q[1:]}",
    lambda q: f"so {q[0].lower()}{q[1:]}",
    lambda q: f"hey {q[0].lower()}{q[1:]}",
    lambda q: f"{q.rstrip('?')} please",
]

# Grammatically requires a clause, not a fragment — kept separate from the
# list above so it is only ever offered when `_is_clause` allows it.
_CLAUSE_ONLY_WRAPPER = lambda q: f"do you know {q[0].lower()}{q[1:].rstrip('?')}"


def _pick_question(rng: random.Random, subject: dict, params: dict) -> str:
    base = rng.choice(subject["questions"]).format(**params)
    wrappers = QUESTION_WRAPPERS + ([_CLAUSE_ONLY_WRAPPER] if _is_clause(base) else [])
    return rng.choice(wrappers)(base)


def make_rag_factual(rng: random.Random) -> dict:
    subject = rng.choice(RAG_SUBJECTS)
    params = _rag_params(rng, subject["needs"])
    fact = subject["detail"].format(**params)
    # A random phrasing per sample, not the subject's first question, is what
    # actually buys generalization: with a fixed question per subject, the
    # model sees the identical sentence every time and can pattern-match on
    # its exact wording rather than learning to answer from the note content.
    question = _pick_question(rng, subject, params)
    answer = subject["answer"].format(**params)

    # One or two distractor notes from OTHER subjects, so the model has to
    # select the right note rather than just echoing "the one note it saw".
    other_subjects = [s for s in RAG_SUBJECTS if s["key"] != subject["key"]]
    distractor_count = rng.choice([1, 1, 2])
    distractors = []
    for s in rng.sample(other_subjects, k=min(distractor_count, len(other_subjects))):
        d_params = _rag_params(rng, s["needs"])
        distractors.append(s["detail"].format(**d_params))

    notes = [fact] + distractors
    rng.shuffle(notes)
    context = "\n\n".join(_note_block(rng, i + 1, n) for i, n in enumerate(notes))
    user_content = f"{context}\n\nQuestion: {question}"

    return {
        "kind": "rag_factual",
        "user_content": user_content,
        "answer": answer,
        "query": question,
        "note": context,
    }


def make_rag_refusal(rng: random.Random) -> dict:
    """Distractor-only context: nothing relevant is present, so the correct
    answer is the fixed refusal string."""
    asked_subject = rng.choice(RAG_SUBJECTS)
    question = _pick_question(rng, asked_subject, _rag_params(rng, asked_subject["needs"]))

    other_subjects = [s for s in RAG_SUBJECTS if s["key"] != asked_subject["key"]]
    distractor_count = rng.choice([1, 2, 2, 3])
    distractors = []
    for s in rng.sample(other_subjects, k=min(distractor_count, len(other_subjects))):
        distractors.append(s["detail"].format(**_rag_params(rng, s["needs"])))

    if distractors:
        context = "\n\n".join(_note_block(rng, i + 1, n) for i, n in enumerate(distractors))
        user_content = f"{context}\n\nQuestion: {question}"
    else:
        # The zero-context case: retrieval found nothing at all.
        user_content = f"No relevant notes were found.\n\nQuestion: {question}"

    return {
        "kind": "rag_refusal",
        "user_content": user_content,
        "answer": REFUSAL_ANSWER,
        "query": question,
        "note": user_content,
    }


# --------------------------------------------------------------------------
# Contrastive mixed samples — a note with BOTH a distractor clause (third
# party or observation) AND a real user task, where the correct answer
# extracts ONLY the real task.
#
# WHY THIS EXISTS. v2's extraction_refusal bucket taught "a note mentioning
# another person/observation -> []" using 175 PURE examples — every single
# one of them had nothing else in it. Only ONE example anywhere in the
# dataset (Ravi/Sapiens, in the few-shot prompt, not even in this generator)
# demonstrated the actually-needed behaviour: extract the real task, skip
# only the unrelated clause. Evaluated on the real corpus, the fine-tuned
# model generalised the overwhelming signal ("mentions someone else -> refuse
# entirely") rather than the rare one ("skip only their part"): attr-001
# ("Eli recommended The Overstory. His brother Elias is moving to Perth...")
# came back "[]", dropping a genuine task along with the third-party clause
# it happened to sit next to.
#
# This bucket has held 4/4 on every trained checkpoint since v3 (v5, v6, v7)
# — nothing about v8's Hybrid Architecture pivot implicates it, so its note
# generation is unchanged from v5 onward.
# --------------------------------------------------------------------------

def _distractor_sentence(rng: random.Random) -> str:
    """One standalone third-party or observation sentence — the part of a
    contrastive note that must NOT appear in the extracted task."""
    if rng.random() < 0.5:
        shape = rng.randint(0, 3)
        time_expr = rng.choice(VISIT_TIMES).format(weekday=rng.choice(WEEKDAYS), ord=rng.choice(ORDINALS))
        if shape == 0:
            return f"The {rng.choice(TRADES)} is coming {time_expr} {rng.choice(VISIT_REASONS)}."
        if shape == 1:
            return f"{rng.choice(THIRD_PARTY_ORGS).capitalize()} is sending someone {time_expr} {rng.choice(VISIT_REASONS)}."
        if shape == 2:
            action_phrase, _ = rng.choice(THIRD_PARTY_ACTIONS)
            return f"{rng.choice(THIRD_PARTY_PEOPLE).capitalize()} {action_phrase} {time_expr}."
        return f"{rng.choice(THIRD_PARTY_PEOPLE).capitalize()} said the {rng.choice(TRADES)} will call round {time_expr}."
    return rng.choice(rng.choice([WEATHER_OBS, OPINION_OBS, FEELING_OBS, EVENT_OBS, REFLECTION_OBS]))


def _task_sentence(rng: random.Random) -> tuple[str, dict]:
    """One standalone sentence containing exactly one real task, plus the
    task dict it must extract to. Weighted toward dated/recurring (0.45/0.30)
    over plain (0.25) specifically because contrastive samples are relied on
    to help clear the date- and recurrence-coverage thresholds, not just the
    attribution fix."""
    kind = rng.choices(["dated", "recurring", "plain"], weights=[0.45, 0.30, 0.25])[0]

    if kind == "recurring":
        verb_lower, phrase, recurrence = rng.choice(RECURRENCE_PATTERNS)
        sentence = f"{rng.choice(LEAD_INS).capitalize()} {verb_lower} {phrase}."
        task_title = verb_lower[0].upper() + verb_lower[1:]
        return sentence, {"task": task_title, "date_phrase": phrase, "recurrence": recurrence}

    verb_lower, verb_title = rng.choice(TASK_VERBS)
    obj = rng.choice(TASK_OBJECTS)
    if kind == "dated":
        date_phrase = rng.choice(RELATIVE_DATES)
        sentence = f"{rng.choice(LEAD_INS).capitalize()} {verb_lower} {obj} {date_phrase}."
        return sentence, {"task": f"{verb_title} {obj}", "date_phrase": date_phrase, "recurrence": "none"}

    sentence = f"{rng.choice(LEAD_INS).capitalize()} {verb_lower} {obj}."
    return sentence, {"task": f"{verb_title} {obj}", "date_phrase": "", "recurrence": "none"}


def make_contrastive(rng: random.Random) -> dict:
    distractor = _distractor_sentence(rng)
    task_sentence, task = _task_sentence(rng)
    # Randomised order: a real note with the distractor after the task is
    # just as plausible as before it, and a model that only ever saw the
    # distractor lead would be learning a position heuristic instead of the
    # actual distinction.
    note = f"{distractor} {task_sentence}" if rng.random() < 0.5 else f"{task_sentence} {distractor}"
    return extraction_sample(note, [task], kind="extraction_contrastive")


# --------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------

# Sub-factories and their share WITHIN the "other positive" bucket (the
# positive samples that are NOT contrastive — see build() for why contrastive
# gets its own explicit, guaranteed count rather than competing for share
# here). Four roughly equal quarters: rich dates, STT noise, multi-task,
# recurrence.
POSITIVE_FACTORIES = [make_dated_task, make_stt, make_multi_task, make_recurring_task]


def _dedupe_key(sample: dict) -> str:
    # RAG samples reuse `note` (their context text) for a distinctness check,
    # since the same context could otherwise be asked about twice.
    return sample.get("note", "") + "||" + sample.get("query", "")


def build(total: int, rng: random.Random) -> list[dict]:
    assert abs(sum(TARGET_DISTRIBUTION.values()) - 1.0) < 1e-9, "TARGET_DISTRIBUTION must sum to 1.0"

    counts = {k: round(total * v) for k, v in TARGET_DISTRIBUTION.items()}
    # Rounding can drop or add one sample versus `total`; reconcile against
    # the largest bucket rather than silently shipping a dataset one sample
    # short of what was requested.
    drift = total - sum(counts.values())
    counts["extraction_positive_other"] += drift

    samples: list[dict] = []
    seen: set[str] = set()

    def add(factories: list, target: int, weights: list[float] | None = None) -> None:
        produced = 0
        attempts = 0
        while produced < target and attempts < target * 80:
            attempts += 1
            factory = rng.choices(factories, weights=weights, k=1)[0] if weights else rng.choice(factories)
            sample = factory(rng)
            key = _dedupe_key(sample)
            if key in seen:
                continue
            seen.add(key)
            samples.append(sample)
            produced += 1
        assert produced == target, (
            f"{[f.__name__ for f in factories]} produced {produced}/{target} distinct "
            "samples — widen the fragment pools"
        )

    # Contrastive gets its OWN guaranteed count rather than competing for a
    # random share inside POSITIVE_FACTORIES — it is the specific, targeted
    # fix for attribution, not optional headroom.
    add([make_contrastive], counts["extraction_contrastive"])
    # v8: recurring share came in at 22.6% on the first seeded run, just
    # under the directive's 25% floor (expected ~26% on average, natural
    # single-seed variance) -- weighting make_recurring_task slightly above
    # the other three's equal share pushes it comfortably over without
    # touching date coverage (still carried by make_dated_task/multi_task,
    # untouched here, plus make_recurring_task always has a non-empty
    # date_phrase too).
    add(POSITIVE_FACTORIES, counts["extraction_positive_other"], weights=[1, 1, 1, 1.4])
    # v8: no zero-task/third-party refusal training at all — see the module
    # docstring's "WHY V8" section. make_zero_task/make_third_party are
    # dormant, not called here.
    add([make_rag_factual], counts["rag_factual"])
    add([make_rag_refusal], counts["rag_refusal"])

    rng.shuffle(samples)
    return samples


# --------------------------------------------------------------------------
# SFT conversion — the one place (note, tasks, kind) becomes a trainer-ready
# {"messages": [...]} row. v8 reverts from ORPO's {"prompt","chosen",
# "rejected"} triples to plain messages, since there is no rejected side any
# more — see the module docstring's "WHY V8" section.
# --------------------------------------------------------------------------

# Words too short/common to plausibly be what a hallucination is "about" —
# kept only because the dormant make_third_party (see its own docstring)
# still calls _fabricated_task_dict below to build test-coverage data; v8's
# actual training rows never use this.
_HALLUCINATION_STOPWORDS = {
    "that", "this", "then", "than", "with", "from", "your", "have", "will",
    "been", "were", "also", "just", "very", "much", "some", "over", "next",
    "first", "second", "third", "last", "previous", "other", "same", "such",
    "whole", "entire", "expected", "long", "better", "worse", "serious",
    "morning", "afternoon", "evening", "day", "days", "week", "weekend",
    "month", "year", "time",
}


def _fabricated_task_dict(rng: random.Random, text: str) -> dict:
    """Picks the noun a hallucination would invent a task around — matches
    the ACTUAL on-device failure shape from Run 3 ("Garden", "Plumber",
    "Look at the roof": a bare CONCRETE NOUN or short phrase lifted straight
    from the source text's own words). Dormant support for make_third_party
    only — not used by any v8 training row."""
    after_article = [
        w for w in re.findall(r"\b(?:the|a|an)\s+([A-Za-z]{4,})\b", text, flags=re.IGNORECASE)
        if w.lower() not in _HALLUCINATION_STOPWORDS
    ]
    if after_article:
        candidate = rng.choice(after_article)
    else:
        content_words = [w for w in re.findall(r"[A-Za-z]{4,}", text) if w.lower() not in _HALLUCINATION_STOPWORDS]
        candidate = content_words[-1] if content_words else "Follow up"
    task_title = candidate[0].upper() + candidate[1:].lower()
    return {"task": task_title, "date_phrase": "", "recurrence": "none"}


def to_sft_extraction_row(sample: dict) -> dict:
    """(note, tasks, kind) -> {"messages": [...]}. Every v8 extraction row
    has a non-empty `tasks` list — no refusal examples exist in this
    dataset at all, so there is no "chosen='[]'" branch to write."""
    answer = json.dumps(sample["tasks"], separators=(",", ":"), ensure_ascii=False)
    return {
        "messages": [
            {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
            {"role": "user", "content": sample["note"]},
            {"role": "assistant", "content": answer},
        ],
        "kind": sample["kind"],
        "note": sample["note"],
    }


def to_sft_rag_row(sample: dict) -> dict:
    """(kind, user_content, answer, query, note) -> {"messages": [...]}."""
    return {
        "messages": [
            {"role": "system", "content": RAG_SYSTEM_PROMPT},
            {"role": "user", "content": sample["user_content"]},
            {"role": "assistant", "content": sample["answer"]},
        ],
        "kind": sample["kind"],
        "note": sample["note"],
    }


def print_report(samples: list[dict]) -> None:
    """`samples` are the raw ingredients (note/tasks/kind for extraction,
    user_content/answer/kind for RAG) — used for every balance/coverage
    check, since `tasks` isn't preserved on the written SFT rows (a
    trainer-ready file, not a debug dump)."""
    total = len(samples)

    extraction = [s for s in samples if s["kind"] in ("extraction", "extraction_contrastive")]
    rag = [s for s in samples if s["kind"] in ("rag_factual", "rag_refusal")]
    contrastive = [s for s in extraction if s["kind"] == "extraction_contrastive"]
    positive_other = len(extraction) - len(contrastive)
    all_tasks = [t for s in extraction for t in s["tasks"]]
    recurrence_counts: dict[str, int] = {}
    for t in all_tasks:
        recurrence_counts[t["recurrence"]] = recurrence_counts.get(t["recurrence"], 0) + 1
    with_date = sum(1 for t in all_tasks if t.get("date_phrase"))
    multi = sum(1 for s in extraction if len(s["tasks"]) > 1)

    rag_factual = [s for s in rag if s["kind"] == "rag_factual"]
    rag_refusal = [s for s in rag if s["kind"] == "rag_refusal"]

    print(f"Total rows           : {total}  (target: 500)")
    print(f"Distinct notes/context: {len({s.get('note', '') for s in samples})}")
    print()
    print(f"Extraction samples   : {len(extraction)}  (target: 350; ALL positive -- v8 trains zero refusal examples)")
    print(f"  of which contrastive    : {len(contrastive)}  (target: 80)")
    print(f"  of which positive_other : {positive_other}  (target: 270)")
    print(f"  recurrence values  : {recurrence_counts}")
    non_none = sum(v for k, v in recurrence_counts.items() if k != "none")
    print(f"  non-'none' recurring tasks: {non_none}  (target: >50)")
    print(f"  tasks with date_phrase    : {with_date}/{len(all_tasks)}  (target: >150)")
    print(f"  multi-task samples        : {multi}")

    print()
    print(f"RAG samples          : {len(rag)}  (target: 150)")
    print(f"  rag_factual         : {len(rag_factual)}  (target: 125)")
    print(f"  rag_refusal         : {len(rag_refusal)}  (target: 25)")

    # v1-regression guards: fail loudly rather than ship a dataset that
    # quietly reproduces the bug that made recurrence collapse 8/8 -> 3/8.
    assert non_none > 0, "REGRESSION: no non-'none' recurrence samples generated"
    assert with_date > 0, "REGRESSION: no dated tasks generated"

    # v8 guards: no refusal training at all — every extraction row must
    # carry at least one real task, or the Hybrid Architecture's premise
    # (fine-tuning only ever sees positive examples; the code-side
    # pre-filter owns every zero-task decision) is silently violated.
    assert all(len(s["tasks"]) > 0 for s in extraction), (
        "REGRESSION: an extraction sample has zero tasks -- v8 must contain no refusal examples"
    )
    assert len(contrastive) >= 75, f"REGRESSION: only {len(contrastive)} contrastive samples, need >=75"
    assert positive_other >= 200, f"REGRESSION: only {positive_other} positive_other samples, need >=200"
    assert non_none > 50, f"REGRESSION: only {non_none} non-'none' recurring tasks, need >50"
    assert with_date > 150, f"REGRESSION: only {with_date} dated tasks, need >150"

    dated_positive_samples = sum(1 for s in extraction if any(t.get("date_phrase") for t in s["tasks"]))
    dated_sample_share = dated_positive_samples / len(extraction)
    # v8: raised from v7's 60% floor to the directive's explicit 70% —
    # there's no refusal bucket competing for extraction's budget any more.
    assert dated_sample_share >= 0.70, f"REGRESSION: only {dated_sample_share:.1%} of positive samples carry a date, need >=70%"

    recurring_positive_samples = sum(1 for s in extraction if any(t.get("recurrence") != "none" for t in s["tasks"]))
    recurring_sample_share = recurring_positive_samples / len(extraction)
    # v8: raised from v7's 20% floor to the directive's explicit 25%.
    assert recurring_sample_share >= 0.25, f"REGRESSION: only {recurring_sample_share:.1%} of positive samples are recurring, need >=25%"

    print()
    print(f"  positive samples with a date     : {dated_positive_samples}/{len(extraction)}  ({dated_sample_share:.1%}, target >=70%)")
    print(f"  positive samples with recurrence : {recurring_positive_samples}/{len(extraction)}  ({recurring_sample_share:.1%}, target >=25%)")

    # RAG guards.
    assert len(rag) == 150, f"REGRESSION: {len(rag)} RAG rows, need exactly 150"
    # v8.1: 75/75 -> 125/25 -- see the module docstring's "WHY V8.1" section
    # for why (over-refusal on genuinely-answerable indirect questions).
    assert len(rag_factual) >= 110, f"REGRESSION: only {len(rag_factual)} rag_factual samples, need >=110"
    assert len(rag_refusal) >= 15, f"REGRESSION: only {len(rag_refusal)} rag_refusal samples, need >=15"
    rag_refusal_answer_correct = sum(1 for s in rag_refusal if s["answer"] == REFUSAL_ANSWER)
    assert rag_refusal_answer_correct == len(rag_refusal), "REGRESSION: a rag_refusal sample's answer isn't the fixed refusal string"
    rag_factual_answer_not_refusal = sum(1 for s in rag_factual if s["answer"] != REFUSAL_ANSWER)
    assert rag_factual_answer_not_refusal == len(rag_factual), "REGRESSION: a rag_factual sample's answer is the refusal string, not a grounded answer"

    print()
    print(f"  rag_refusal answer == fixed refusal string : {rag_refusal_answer_correct}/{len(rag_refusal)}")
    print(f"  rag_factual answer != refusal string        : {rag_factual_answer_not_refusal}/{len(rag_factual)}")
    print()
    print("All v1-, v2-, v8-, and v8.1-regression guards passed.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=500, help="total SFT rows (extraction + RAG)")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).parent / "sft_qwen_task_extraction.jsonl",
        help="output JSONL path",
    )
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    samples = build(args.count, rng)

    # "extraction" (from POSITIVE_FACTORIES, always non-empty tasks) is
    # relabelled to "extraction_positive" to match TARGET_DISTRIBUTION's own
    # bucket name, so the notebook's validation cell can independently
    # confirm the balance. "extraction_contrastive"/"rag_factual"/
    # "rag_refusal" are already final, distinct names straight from their
    # factory.
    rows: list[dict] = []
    for sample in samples:
        kind = "extraction_positive" if sample["kind"] == "extraction" else sample["kind"]
        if kind in ("rag_factual", "rag_refusal"):
            row = to_sft_rag_row(sample)
        else:
            row = to_sft_extraction_row(sample)
        row["kind"] = kind
        rows.append(row)

    with args.out.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            out_row = {"messages": row["messages"], "kind": row["kind"]}
            handle.write(json.dumps(out_row, ensure_ascii=False) + "\n")

    print(f"Wrote {len(rows)} SFT rows to {args.out}\n")
    print_report(samples)


if __name__ == "__main__":
    main()
