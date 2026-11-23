[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mamat9q/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mamat9q/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend: four formats, three tiers, all or nothing

One patch tool for every AI edit format. `mend` reads a patch in any of
four formats — unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches, or text-editor tool calls as JSON — finds the lines
each edit names at the first of three matching tiers, and changes every
file or none.

Built for make.fun competition
**hidden-spec-cli-01-run-20261122** ("Build mend, one patch tool for every
AI edit format", $100, top 10 paid).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Node 22 and its standard library only; no install step, no build step.
The working directory is the root of the tree of text files. `PATCH` is
the patch file, or `-`/absent to read the patch from standard input.
`SPEC.md` in the competition kit is the whole contract; `main.ts`
implements all ten of its sections.

- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a`
  or `json`; `auto` (the default) detects it: `*** Begin Patch` first,
  then JSON, then a `<<<<<<< SEARCH` line, then a unified diff.
- `--check` does everything but write: same output and exit code, no
  file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 lists what changed (`A`/`D`/`M`/`R` lines, then `ok: <n> files`).
Exit 1 lists each failed edit and `failed: <k> of <n> edits`, and writes
nothing. Exit 2 is a single usage / no-patch / format / parse error line.

## The three matching tiers

For each edit, the old lines are found at the first tier where they occur
at least once:

- **tier 0** — every line equal;
- **tier 1** — every line equal once trailing spaces and tabs are removed;
- **tier 2** — every line equal once leading and trailing spaces and tabs
  are removed, with new lines re-indented from the patch's indentation to
  the file's (context lines are always written as the file's own lines).

So a model that drifted whitespace or indentation still lands, and a
unified hunk with wrong line numbers lands on the occurrence nearest to
its header. A SEARCH/REPLACE block whose old lines occur more than once
at their tier fails `ambiguous` instead of guessing.

## All or nothing

Edits apply in patch order to the tree as earlier edits left it, so a
file created, changed, moved or deleted by one edit is seen so by the
next. A failed edit changes nothing and the edits after it still run, so
every failure is reported — and when any edit failed, no file is written
at all. Moves are reported as `R <old> -> <new>`; a file whose bytes end
up unchanged is not listed.

Line breaks are preserved per file (CRLF stays CRLF, a missing final
line break stays missing unless a hunk reaches the end of the file and
no `\ No newline at end of file` follows it). Created files use LF.

## Validation

Measured against the kit's public practice set (100 checks) with the
kit's own env server and scorer — not a hand-rolled harness:

- practice trial-0: **100/100, score 1000** (unified 30/30,
  search_replace 20/20, v4a 20/20, json 15/15, cli 15/15)
- practice trial-1: **100/100, score 1000**
- practice trial-2: **100/100, score 1000**
- determinism: trial-0 run twice produces byte-identical state exports
  (the grader replays each trial; the two runs must agree)
- 104 additional hand-built edge cases from SPEC.md sentences the
  practice set does not show (renames, chained moves, move-then-edit,
  unsafe paths in all four formats, anchor + end-of-file chunks, CRLF
  files, `--check`, `--strict`, self-patching): **104/104**
- a full 100-check trial takes ~24 s wall (~0.24 s per check, limit 10 s)

## Limitations

- The sealed pool (300 checks) tests sentences the practice set does not
  show; a perfect practice score does not prove a perfect sealed score.
  Every sentence of SPEC.md was re-read against the implementation, and
  the edge cases above are the author's reading of the ambiguous ones
  (for example, a V4A anchor names the line before the chunk's old
  lines, and the cursor moves past it).
- A path naming an existing directory is treated as a missing file.
- Deterministic: no clock, no randomness, no network.

## Files

- `main.ts` — the CLI (Node 22, standard library only)
- `runner.ts` — the kit's runner, unchanged; hands a trial over when
  `MAKEFUN_ENV_URL` is set
- `LICENSE` — MIT

---

<sub>Entered on [make.fun](https://make.fun/?ref=fktnkc1k&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
