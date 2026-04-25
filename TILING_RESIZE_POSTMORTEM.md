# Tiling Resize Postmortem

This document records why the removed draggable tiling resize implementation failed.
It is intentionally blunt so the next implementation starts from a better model.

## What Was Removed

- The renderer-only seam overlay used for drag-resizing pane boundaries.
- T and cross junction picking logic.
- Snap-to-nearby-split logic.
- Geometry-to-layout rebuild logic used during resize previews.
- Playwright tests that validated the removed resize behavior.

The applet spawning, split layout rendering, close/collapse behavior, applet picker, and applet drag placement remain separate features.

## Core Architectural Flaws

1. Visual seams were not first-class layout objects.

   The implementation derived seam handles from rendered leaf rectangles after the layout was already rendered. That meant the UI was trying to infer mutable layout intent from pixels instead of using an explicit layout model that knew which panes belonged to each boundary.

2. The binary layout tree was the wrong mutation surface for complex junctions.

   A visible edge can be local to two panes, a T junction, or a cross junction. The old code often mapped that edge back to a least-common ancestor split in the tree. That ancestor could include panes that were not actually attached to the dragged edge, so unrelated panes moved.

3. The implementation mixed competing models.

   It moved between:

   - persisted binary split tree
   - measured DOM rectangles
   - renderer preview state
   - generated seam segments
   - snap targets
   - reconstructed layout trees

   None of those was authoritative. Each bug fix added another interpretation layer instead of simplifying the source of truth.

4. Cross and T junctions were handled as special cases instead of graph operations.

   Junctions need a constraint graph: edges, panes, adjacency, minimum sizes, and movable groups. The implementation instead tried to group seam segments with tolerances and heuristics. This produced wrong selection, wrong line extents, and dead zones when edges coincided.

5. Snapping was bolted on after hit testing.

   Snap decisions used visible seam coordinates without a stable concept of which boundary was being dragged. When two boundaries coincided, the active seam could snap back to an equivalent target and become impossible to move away from.

6. Layout commits raced the preview state.

   A user could drag, release, and immediately drag another edge while renderer preview, persisted state, and broadcast state were briefly out of sync. Later changes tried to serialize this, but that was compensating for not having one authoritative local transaction model.

7. Tests initially validated isolated gestures, not interaction chains.

   The early tests checked single drags on clean layouts. The real failures came from chained operations: snap, then cross drag, then side drag; asymmetric layouts; spanning panes over grids; and coincident edges. The suite grew only after bugs appeared.

## What I Did Badly

- I patched symptoms too long instead of stopping after the first repeated junction failure and redesigning the model.
- I accepted pattern-specific rotations of the layout tree, which created new topology bugs.
- I let DOM geometry become a source of truth instead of using it only as a render verification signal.
- I added tolerances to hide precision problems, which made hit testing and snapping harder to reason about.
- I did not define invariants before implementation.
- I did not build the stress tests before writing the resize system.
- I let the system keep growing while the user-visible behavior was still not coherent.

