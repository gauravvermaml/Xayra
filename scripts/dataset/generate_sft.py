#!/usr/bin/env python3
"""Synthetic SFT dataset generator for the Qwen2.5-1.5B model — v2.

WHY V2 EXISTS
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

REFUSAL_ANSWER = "No information found in your notes."

SEED = 20260922

# Fraction of the 500-sample total in each top-level bucket. Verified to sum
# to 1.0 by an assertion in `build()` rather than trusted by eye.
TARGET_DISTRIBUTION = {
    "extraction_positive": 0.35,
    "extraction_refusal": 0.35,  # zero-task observations + third-party, combined
    "rag_factual": 0.15,
    "rag_refusal": 0.15,
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

THIRD_PARTY_ACTIONS = [
    "is moving house", "is starting a new job", "is going on holiday",
    "is selling the flat", "is renovating the kitchen", "is changing jobs",
    "is having the driveway resurfaced", "is getting a new car",
    "is redoing the bathroom", "is taking a sabbatical",
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
]


def chatml_sample(system_prompt: str, user_content: str, assistant_content: str, **meta) -> dict:
    """One training row, in the ChatML shape Qwen2.5 was instruction-tuned on.

    `text` is the field TRL's SFTTrainer reads. The assistant turn is closed
    with <|im_end|> so the model learns to stop; without it, a fine-tuned
    model happily runs on past its answer.
    """
    text = (
        f"<|im_start|>system\n{system_prompt}<|im_end|>\n"
        f"<|im_start|>user\n{user_content}<|im_end|>\n"
        f"<|im_start|>assistant\n{assistant_content}<|im_end|>"
    )
    return {"text": text, **meta}


def extraction_sample(note: str, tasks: list[dict]) -> dict:
    answer = json.dumps(tasks, separators=(",", ":"), ensure_ascii=False)
    return chatml_sample(
        EXTRACTION_SYSTEM_PROMPT, note, answer,
        kind="extraction", note=note, tasks=tasks,
    )


# --------------------------------------------------------------------------
# (a) Extraction — positive, 35%
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
# (b) Extraction — refusal (zero-task + third-party), 35%
# --------------------------------------------------------------------------

def make_zero_task(rng: random.Random) -> dict:
    pool = rng.choice([WEATHER_OBS, OPINION_OBS, FEELING_OBS, EVENT_OBS, REFLECTION_OBS])
    note = rng.choice(pool)
    if rng.random() < 0.3:
        other = rng.choice(rng.choice([WEATHER_OBS, OPINION_OBS, EVENT_OBS]))
        if other != note:
            note = f"{note[:-1]} and {other[0].lower()}{other[1:]}"
    return extraction_sample(note, [])


def make_third_party(rng: random.Random) -> dict:
    shape = rng.randint(0, 3)
    time_expr = rng.choice(VISIT_TIMES).format(weekday=rng.choice(WEEKDAYS), ord=rng.choice(ORDINALS))

    if shape == 0:
        note = f"The {rng.choice(TRADES)} is coming {time_expr} {rng.choice(VISIT_REASONS)}."
    elif shape == 1:
        note = f"{rng.choice(THIRD_PARTY_ORGS).capitalize()} is sending someone {time_expr} {rng.choice(VISIT_REASONS)}."
    elif shape == 2:
        note = f"{rng.choice(THIRD_PARTY_PEOPLE).capitalize()} {rng.choice(THIRD_PARTY_ACTIONS)} {time_expr}."
    else:
        note = f"{rng.choice(THIRD_PARTY_PEOPLE).capitalize()} said the {rng.choice(TRADES)} will call round {time_expr}."

    return extraction_sample(note, [])


# --------------------------------------------------------------------------
# (c)/(d) RAG — factual and refusal, 15% + 15%
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
]


def _rag_params(rng: random.Random, needs: list[str]) -> dict:
    params = {}
    if "date" in needs:
        params["date"] = rng.choice(RELATIVE_DATES) if rng.random() < 0.3 else f"{rng.randint(1, 28)} {rng.choice(['January','March','June','September','November'])}"
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

    return chatml_sample(
        RAG_SYSTEM_PROMPT, user_content, answer,
        kind="rag_factual", query=question, note=context,
    )


def make_rag_refusal(rng: random.Random) -> dict:
    """Distractor-only context: nothing relevant is present, so the correct
    answer is the fixed refusal string, not a fabricated one."""
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

    return chatml_sample(
        RAG_SYSTEM_PROMPT, user_content, REFUSAL_ANSWER,
        kind="rag_refusal", query=question, note=user_content,
    )


# --------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------

# Sub-factories and their share WITHIN the extraction_positive bucket. Four
# roughly equal quarters: rich dates, STT noise, multi-task, recurrence —
# matching the four things the directive named explicitly.
POSITIVE_FACTORIES = [make_dated_task, make_stt, make_multi_task, make_recurring_task]

# Sub-factories within extraction_refusal: roughly half zero-task, half
# third-party — kept distinct because attr-003/third-party-0-of-8 showed they
# fail for different reasons and both need real coverage, not one standing in
# for the other.
REFUSAL_FACTORIES = [make_zero_task, make_third_party]


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
    counts["extraction_positive"] += drift

    samples: list[dict] = []
    seen: set[str] = set()

    def add(factories: list, target: int) -> None:
        produced = 0
        attempts = 0
        while produced < target and attempts < target * 80:
            attempts += 1
            factory = rng.choice(factories)
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

    add(POSITIVE_FACTORIES, counts["extraction_positive"])
    add(REFUSAL_FACTORIES, counts["extraction_refusal"])
    add([make_rag_factual], counts["rag_factual"])
    add([make_rag_refusal], counts["rag_refusal"])

    rng.shuffle(samples)
    return samples


def print_report(samples: list[dict]) -> None:
    total = len(samples)
    by_kind: dict[str, int] = {}
    for s in samples:
        by_kind[s["kind"]] = by_kind.get(s["kind"], 0) + 1

    print(f"Total samples        : {total}")
    print(f"Distinct text rows   : {len({s['text'] for s in samples})}")
    print()
    print("By kind:")
    for kind, count in sorted(by_kind.items()):
        print(f"  {kind:20s} {count:4d}  ({count / total:5.1%})")

    extraction = [s for s in samples if s["kind"] == "extraction"]
    all_tasks = [t for s in extraction for t in s["tasks"]]
    recurrence_counts: dict[str, int] = {}
    for t in all_tasks:
        recurrence_counts[t["recurrence"]] = recurrence_counts.get(t["recurrence"], 0) + 1
    with_date = sum(1 for t in all_tasks if t.get("date_phrase"))
    multi = sum(1 for s in extraction if len(s["tasks"]) > 1)
    empty = sum(1 for s in extraction if not s["tasks"])

    print()
    print(f"Extraction samples   : {len(extraction)}  (positive {len(extraction) - empty}, refusal {empty})")
    print(f"  recurrence values  : {recurrence_counts}")
    non_none = sum(v for k, v in recurrence_counts.items() if k != "none")
    print(f"  non-'none' recurring tasks: {non_none}  <-- was 0 in v1")
    print(f"  tasks with date_phrase    : {with_date}/{len(all_tasks)}")
    print(f"  multi-task samples        : {multi}")

    rag_factual = [s for s in samples if s["kind"] == "rag_factual"]
    rag_refusal = [s for s in samples if s["kind"] == "rag_refusal"]
    print()
    print(f"RAG factual samples  : {len(rag_factual)}")
    print(f"RAG refusal samples  : {len(rag_refusal)}")
    print(f"  distinct RAG questions: {len({s['query'] for s in rag_factual + rag_refusal})}")

    # Fail loudly rather than ship a dataset that quietly reproduces v1's bug.
    assert non_none > 0, "REGRESSION: no non-'none' recurrence samples generated"
    assert with_date > 0, "REGRESSION: no dated tasks generated"
    assert len(rag_factual) > 0 and len(rag_refusal) > 0, "REGRESSION: RAG samples missing"
    assert 0 < empty < len(extraction), "extraction set collapsed to all-positive or all-refusal"
    print()
    print("All v1-regression guards passed.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=500, help="total samples")
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

    with args.out.open("w", encoding="utf-8", newline="\n") as handle:
        for sample in samples:
            # "extraction" is split into "extraction_positive" /
            # "extraction_refusal" at write time, matching TARGET_DISTRIBUTION's
            # own bucket names. Writing only {"text","kind"} with kind still
            # undifferentiated ("extraction") was tried first and shipped a
            # file the training notebook's OWN validation cell could not read
            # — it needs to independently confirm the positive/refusal split
            # that caused v1's regression, and "extraction" alone throws that
            # signal away. `tasks`/`note` stay dropped; `kind` alone is enough
            # for that check, and keeping them out is what makes this a
            # trainer-ready file rather than a debug dump.
            kind = sample["kind"]
            if kind == "extraction":
                kind = "extraction_refusal" if not sample["tasks"] else "extraction_positive"
            row = {"text": sample["text"], "kind": kind}
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"Wrote {len(samples)} samples to {args.out}\n")
    print_report(samples)


if __name__ == "__main__":
    main()
