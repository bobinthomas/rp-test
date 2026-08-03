# Design Agent Eval Loop
### A UI-generation agent for a 60+ designer team, and how I'd know if it's actually good

## The real problem

A chat agent that generates UI from a prompt isn't hard to demo. It's hard to trust at scale. The moment I hand this to 60 designers, the question stops being "does it work" and becomes "does it keep working, on requests I didn't test, in ways I can measure instead of guess at." That's the problem I scoped for.

Two things have to be true before this is safe to put in front of a team that size:

1. The agent has to actually understand what was asked, grounded in our real design system, not its general training knowledge of what a UI usually looks like.
2. I need a way to know, continuously, whether a change to the prompt made things better or worse, on four axes: accuracy, hallucination, instruction-following, and safety.

I built a thin working slice of both.

## What I built

A prototype where a designer submits a structured request (intent, product surface, and explicit constraints) instead of a bare prompt. The request goes to the model along with the actual approved component list, so the model has something real to be grounded against instead of inventing plausible-sounding components.

Every generation is scored automatically against four checks:

- **Accuracy** — what percentage of the components the model used are real, approved components.
- **Hallucination resistance** — did it invent anything that doesn't exist in the library.
- **Instruction-following** — did it actually obey the constraints the designer checked, like "must include a primary action."
- **Safety** — does the output avoid exposing raw sensitive field names (card numbers, passwords) in generated field lists.

Then, instead of trusting my instinct that a prompt change is an improvement, I run a fixed set of four canned requests through both the old prompt and the new one, and diff the aggregate scores. That diff is the actual answer to "is the new prompt better," not a feeling after skimming a few outputs.

## Why this is AI-native and not AI-assisted

A linter that flags "this isn't a real component" is useful, but it's assistance bolted onto a workflow that already exists. What makes this different: the eval loop is the thing that lets 60 designers use an agent none of us can manually QA one-by-one. The system doesn't just generate, it grades its own output against ground truth and against its own history, which is what makes it safe to iterate on without a human re-reviewing every single case by hand. That's a capability that doesn't exist without the AI doing real evaluative work, not just generative work.

## How I'd answer the four questions in production

- **Did accuracy improve?** Tracked as a rolling score against the fixed eval set on every prompt or context change, not a one-time check.
- **Did hallucinations increase?** Same eval set, plus a live counter on real usage — any component or token referenced that isn't in the current library gets logged and reviewed weekly, since the library itself changes over time.
- **Is the model following instructions consistently?** Scored per-constraint, not as one blended number, because a prompt can get better at one constraint and worse at another, and averaging hides that.
- **Is it safe?** A hard rule layer, not a soft one. Unsafe field names get flagged and, in a real system, the generation would be blocked from shipping, not just scored down.

## How this runs as a loop, not a one-time check

Capture the intent with structure, ground the request against the live design system, generate, run it through automated evals before any human sees it, diff the new prompt against the previous version on the same fixed set, sample real designer sessions weekly for what the fixed set doesn't catch, and log every designer correction as free labeled data that feeds back into the eval set. Ship one change at a time so when a score moves, I know why.

## What I deliberately left out of this slice

I scoped to one path (intent to component selection) rather than full visual layout generation, since the eval methodology is the hard part worth proving first. I didn't build the weekly human-sampling layer or the correction-to-eval-set pipeline, those are logged as an interaction pattern in the prototype but not wired to a real feedback loop yet. Given more time, the fixed eval set should grow from real production disagreements, not just the four cases I wrote by hand.

## What I'd want to know if we shipped this to all 60 designers tomorrow

The honest answer is I don't know yet, and that's the point of the eval loop rather than a launch checklist. What I do know: the failure mode to watch for isn't the agent being obviously wrong, it's the agent being confidently, plausibly wrong in a way a busy designer approves without checking. The eval scores exist to catch that before a person has to.
