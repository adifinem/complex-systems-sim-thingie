# mindmap

A patcher-style playground for **system dynamics**: sketch what's in your head
as stocks, flows, and dials — press play — and *watch* the graph light up
instead of reading line charts. Pause it, twist a dial or rewrite a formula,
resume, and see whether the system re-balances, sticks at a new level,
oscillates, or spirals away.

Inspired by InsightMaker's modeling semantics, Machinations' live animation,
and FL Studio Patcher / n8n for the canvas feel.

## Quickstart

```sh
./run.sh          # installs deps if needed, starts the dev server, opens a browser
```

Open an example from the **file menu** (top left) — `examples/thermostat` is a
good first run. Press **▶** (or Space). Drag the dials mid-run.

## The core ritual

1. **Sketch**: drag node types from the left rail. Every node is runnable the
   moment it lands (stocks start at 100, flows at rate 1). Drag a pipe from one
   stock to another and a flow appears between them. Reference a name that
   doesn't exist yet and the error offers *create variable X*.
2. **Run**: Space to play. Node borders and glows tint **blue** (below
   baseline) ↔ **gray** (at baseline) ↔ **red** (above). Pipes pulse with flow
   rate and direction; influence wires dim when a conditional isn't reading
   them this tick.
3. **Perturb**: while running or paused — drag dials, *set* a stock's current
   value, **pin** any computed node to a constant (its formula is suspended
   until you release it), or rewrite formulas (they hot-swap without losing
   state). Anything you poked wears an amber dot until shortly after you resume.
4. **Read the outcome**: the inspector's trend chip names the behavior —
   *settling · steady · oscillating · runaway* — and stock sparklines show the
   recent trajectory against the baseline.

## Node types

| type | looks like | meaning |
|---|---|---|
| **stock** | tank | accumulates: `s += dt · (Σin − Σout)` |
| **flow** | valve | a rate, attached to stocks via thick pipes |
| **variable** | pill | a formula re-evaluated every tick |
| **constant** | chip with slider | a dial; the primary perturbation control |
| **module** | IC chip | a whole graph as one node (see below) |
| **input / output** | arrow pills | the ports of a graph used as a module |
| **note** | sticky | commentary; ignored by the engine |

Wires carry values into formulas (the name a wire binds is its **alias**,
default: the source's id). Every socket accepts any number of wires — fan-in
semantics live in the formula, which references whichever aliases it wants.

## Formulas

Arithmetic (`+ - * / % ^`), comparisons, `and or not`,
`if(cond, a, b)` or `if … then … else …` — conditionals evaluate lazily, and
only the wires actually read this tick show as active.

Builtins: `min max abs floor ceil round sqrt exp ln log pow clamp lerp sign
mod sin cos tan` · time: `t dt step(h,t0) pulse(t0,h,w,rep) ramp(slope,t0,t1)`
· memory: `delay(x,τ) delay1(x,τ) delay3(x,τ) smooth(x,τ) previous(x)` ·
noise: `rand() randNormal(m,sd) randBool(p)` (seeded — runs replay exactly).

Feedback loops are the point: cycles are legal through **stocks** or the
memory builtins. A purely algebraic loop is a compile error that names the
cycle and suggests the fix.

## Time

The clock counts **ticks**; named units are ratios to one tick
(`second=1, minute, hour, day, week` by default — redefinable per model).
Give a node a **time unit** and its whole formula speaks that unit: a flow's
rate becomes per-hour, `delay(x, 2)` means two hours, `t` reads in hours.
A module's unit becomes the default for everything inside it. **update every**
makes a node re-evaluate only that often, holding its value in between —
slow subsystems tick at their own pace.

## Modules (IC chips) & tabs

Every tab is a graph; a **module node** instantiates another tab inside this
one — same mechanism as n8n sub-workflows. Instances are independent (two
chips of the same graph have separate state). Wire into the chip's **input
pins**, read from its **output pins**. Double-click a chip to open its graph
*live for that instance* (breadcrumb at the top; Esc goes up).

Three modes per chip:
- **full** — the inner network co-simulates.
- **frozen** — the instance pauses wholesale and its outputs hold; everyone
  else keeps running. Great perturbation: freeze a subsystem, watch the rest
  re-equilibrate, unfreeze.
- **summary** — the inner network isn't simulated at all; each output runs a
  cheap formula you write over the input pins (lower-fidelity abstraction).

## Files

Models are plain JSON in [models/](models/) — hand-editable, git-friendly
(saves are pretty-printed with stable key order). The file menu reads and
writes them through the dev server; there's also export/import, and a
localStorage autosave restores unsaved work after a crash.

## Keyboard

Space play/pause · `.` step one tick · `R` reset · Esc up one module level ·
Ctrl+Z / Ctrl+Shift+Z undo/redo · Ctrl+C/V copy/paste a node (works across
tabs) · Ctrl+D duplicate · Delete/Backspace remove.

## Repo layout

```
packages/engine   pure-TS simulation engine (no DOM) — parser, flattening
                  compiler, deterministic tick loop; 125 vitest tests
apps/studio       React + React Flow canvas; per-tick values reach the DOM
                  through an imperative AnimationBridge, never React state
models/           your graphs (examples/ doubles as the engine's fixtures)
```

Engine guarantees worth knowing: identical model + seed ⇒ bit-identical
trajectories; snapshot/restore resumes exactly; formula edits hot-swap while
preserving all unrelated state; `delay(stock, τ)` samples start-of-tick values
(the record phase runs before integration).

## Development

```sh
pnpm test    # engine test suite
pnpm check   # biome + typecheck
pnpm dev     # studio dev server
```
