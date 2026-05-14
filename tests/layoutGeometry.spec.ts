import { expect, test } from "@playwright/test";
import {
  MIN_APPLET_SIZE,
  TILE_GUTTER_SIZE,
  applyRatioOverrides,
  completedEdgeGroups,
  computeCanonicalLayout,
  projectResize,
  rebuildLayoutFromLeafRects,
  resizeTargetRequiresStructuralResize,
  resizeTargetAt
} from "../src/shared/layoutGeometry";
import type { WorkspaceLayoutNode } from "../src/shared/types";

const leaf = (id: string): WorkspaceLayoutNode => ({
  id: `leaf-${id}`,
  type: "leaf",
  appletInstanceId: id
});

test("canonical split sizes are integer exact with fixed gutter", () => {
  const layout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "row",
    ratio: 0.333,
    first: leaf("left"),
    second: leaf("right")
  };

  const geometry = computeCanonicalLayout(layout, { width: 1001, height: 607 });
  const split = geometry.splits[0];

  expect(Number.isInteger(split.firstSize)).toBe(true);
  expect(Number.isInteger(split.secondSize)).toBe(true);
  expect(split.firstSize + TILE_GUTTER_SIZE + split.secondSize).toBe(1001);
  expect(geometry.leaves.every((item) => Object.values(item.rect).every(Number.isInteger))).toBe(true);
  expect(computeCanonicalLayout(layout, { width: 1001, height: 607 })).toEqual(geometry);
});

test("edge closure does not cross a perpendicular gutter", () => {
  const layout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: {
      id: "left-stack",
      type: "split",
      direction: "column",
      ratio: 0.5,
      first: leaf("left-top"),
      second: leaf("left-bottom")
    },
    second: {
      id: "right-stack",
      type: "split",
      direction: "column",
      ratio: 0.5,
      first: leaf("right-top"),
      second: leaf("right-bottom")
    }
  };
  const geometry = computeCanonicalLayout(layout, { width: 808, height: 608 });
  const rootGroups = completedEdgeGroups(geometry.primitiveEdges, geometry.leaves).filter((group) =>
    group.edges.some((edge) => edge.splitId === "root")
  );

  expect(rootGroups).toHaveLength(2);
  expect(rootGroups.map((group) => [group.start, group.end])).toEqual([
    [0, 300],
    [308, 608]
  ]);
});

test("junction target combines completed vertical and horizontal groups", () => {
  const layout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: {
      id: "left-stack",
      type: "split",
      direction: "column",
      ratio: 0.5,
      first: leaf("left-top"),
      second: leaf("left-bottom")
    },
    second: {
      id: "right-stack",
      type: "split",
      direction: "column",
      ratio: 0.5,
      first: leaf("right-top"),
      second: leaf("right-bottom")
    }
  };
  const geometry = computeCanonicalLayout(layout, { width: 808, height: 608 });
  const target = resizeTargetAt(geometry, { x: 404, y: 304 });

  expect(target?.type).toBe("junction");
  if (target?.type === "junction") {
    expect(target.vertical.edges.length).toBe(2);
    expect(target.horizontal.edges.length).toBe(2);
  }
});

test("edge closure expands through touched applet extents", () => {
  const layout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "column",
    ratio: 0.5,
    first: {
      id: "top-row",
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: leaf("top-left"),
      second: leaf("top-right")
    },
    second: {
      id: "bottom-left-rest",
      type: "split",
      direction: "row",
      ratio: 0.3,
      first: leaf("bottom-left"),
      second: {
        id: "bottom-mid-right",
        type: "split",
        direction: "row",
        ratio: 0.5,
        first: leaf("bottom-mid"),
        second: leaf("bottom-right")
      }
    }
  };
  const geometry = computeCanonicalLayout(layout, { width: 1008, height: 608 });
  const horizontalGroups = completedEdgeGroups(geometry.primitiveEdges, geometry.leaves).filter(
    (group) => group.axis === "horizontal" && group.edges.some((edge) => edge.splitId === "root")
  );

  expect(horizontalGroups).toHaveLength(1);
  expect(horizontalGroups[0].start).toBe(0);
  expect(horizontalGroups[0].end).toBe(1008);
  expect([...new Set(horizontalGroups[0].edges.map((edge) => edge.afterLeafId))].sort()).toEqual([
    "leaf-bottom-left",
    "leaf-bottom-mid",
    "leaf-bottom-right"
  ]);
});

test("structural rebuild can prefer a horizontal cut for vertical edge drags", () => {
  const layout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: {
      id: "left-stack",
      type: "split",
      direction: "column",
      ratio: 0.5,
      first: leaf("top-left"),
      second: leaf("bottom-left")
    },
    second: {
      id: "right-stack",
      type: "split",
      direction: "column",
      ratio: 0.5,
      first: leaf("top-right"),
      second: leaf("bottom-right")
    }
  };
  const leaves = [
    { id: "leaf-top-left", appletInstanceId: "top-left", rect: { left: 0, top: 0, right: 600, bottom: 300 } },
    { id: "leaf-top-right", appletInstanceId: "top-right", rect: { left: 608, top: 0, right: 1008, bottom: 300 } },
    { id: "leaf-bottom-left", appletInstanceId: "bottom-left", rect: { left: 0, top: 308, right: 600, bottom: 608 } },
    { id: "leaf-bottom-right", appletInstanceId: "bottom-right", rect: { left: 608, top: 308, right: 1008, bottom: 608 } }
  ];

  const rebuilt = rebuildLayoutFromLeafRects(layout, leaves, { left: 0, top: 0, right: 1008, bottom: 608 }, TILE_GUTTER_SIZE, "column");

  expect(rebuilt.type).toBe("split");
  if (rebuilt.type === "split") {
    expect(rebuilt.direction).toBe("column");
  }
});

test("structural rebuild can prefer a vertical cut for horizontal edge drags", () => {
  const layout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "column",
    ratio: 0.5,
    first: {
      id: "top-row",
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: leaf("top-left"),
      second: leaf("top-right")
    },
    second: {
      id: "bottom-row",
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: leaf("bottom-left"),
      second: leaf("bottom-right")
    }
  };
  const leaves = [
    { id: "leaf-top-left", appletInstanceId: "top-left", rect: { left: 0, top: 0, right: 500, bottom: 400 } },
    { id: "leaf-top-right", appletInstanceId: "top-right", rect: { left: 508, top: 0, right: 1008, bottom: 300 } },
    { id: "leaf-bottom-left", appletInstanceId: "bottom-left", rect: { left: 0, top: 408, right: 500, bottom: 608 } },
    { id: "leaf-bottom-right", appletInstanceId: "bottom-right", rect: { left: 508, top: 308, right: 1008, bottom: 608 } }
  ];

  const rebuilt = rebuildLayoutFromLeafRects(layout, leaves, { left: 0, top: 0, right: 1008, bottom: 608 }, TILE_GUTTER_SIZE, "row");

  expect(rebuilt.type).toBe("split");
  if (rebuilt.type === "split") {
    expect(rebuilt.direction).toBe("row");
  }
});

test("cross-grid edge drags are structural in both resize modes", () => {
  const crossLayout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: {
      id: "left-stack",
      type: "split",
      direction: "column",
      ratio: 0.5,
      first: leaf("top-left"),
      second: leaf("bottom-left")
    },
    second: {
      id: "right-stack",
      type: "split",
      direction: "column",
      ratio: 0.5,
      first: leaf("top-right"),
      second: leaf("bottom-right")
    }
  };
  const crossGeometry = computeCanonicalLayout(crossLayout, { width: 1008, height: 608 });
  const topVertical = resizeTargetAt(crossGeometry, { x: 504, y: 150 });

  expect(topVertical).toBeTruthy();
  expect(resizeTargetRequiresStructuralResize(crossGeometry, topVertical!, "adjacent")).toBe(true);
  expect(resizeTargetRequiresStructuralResize(crossGeometry, topVertical!, "cascade")).toBe(true);

  const flippedLayout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "column",
    ratio: 0.5,
    first: {
      id: "top-row",
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: leaf("top-left"),
      second: leaf("top-right")
    },
    second: {
      id: "bottom-row",
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: leaf("bottom-left"),
      second: leaf("bottom-right")
    }
  };
  const flippedGeometry = computeCanonicalLayout(flippedLayout, { width: 1008, height: 608 });
  const leftHorizontal = resizeTargetAt(flippedGeometry, { x: 250, y: 304 });

  expect(leftHorizontal).toBeTruthy();
  expect(resizeTargetRequiresStructuralResize(flippedGeometry, leftHorizontal!, "adjacent")).toBe(true);
  expect(resizeTargetRequiresStructuralResize(flippedGeometry, leftHorizontal!, "cascade")).toBe(true);
});

test("cascade mode allows same-axis chains", () => {
  const chainLayout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: leaf("left"),
    second: {
      id: "right-row",
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: leaf("middle"),
      second: leaf("right")
    }
  };
  const chainGeometry = computeCanonicalLayout(chainLayout, { width: 308, height: 120 });
  const chainVertical = resizeTargetAt(chainGeometry, { x: 154, y: 60 });

  expect(chainVertical).toBeTruthy();
  expect(resizeTargetRequiresStructuralResize(chainGeometry, chainVertical!, "cascade")).toBe(false);
});

test("resize projection clamps using every touching leaf", () => {
  const layout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: leaf("left"),
    second: leaf("right")
  };
  const geometry = computeCanonicalLayout(layout, { width: 128, height: 120 });
  const target = resizeTargetAt(geometry, { x: 64, y: 60 });

  expect(target).toBeTruthy();
  const projected = projectResize(geometry, target!, { x: 120, y: 0 }, MIN_APPLET_SIZE);
  expect(projected.dx).toBe(10);
  expect(projected.ratios.root).toBeCloseTo((60 + 10) / 120, 8);
});

test("cascading resize keeps connected branch ratios and clamps by propagated leaves", () => {
  const layout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: leaf("left"),
    second: {
      id: "right-row",
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: leaf("middle"),
      second: leaf("right")
    }
  };
  const geometry = computeCanonicalLayout(layout, { width: 308, height: 120 });
  const target = resizeTargetAt(geometry, { x: 154, y: 60 });

  expect(target).toBeTruthy();
  const adjacent = projectResize(geometry, target!, { x: 60, y: 0 }, MIN_APPLET_SIZE);
  const cascade = projectResize(geometry, target!, { x: 60, y: 0 }, MIN_APPLET_SIZE, "cascade");

  expect(adjacent.dx).toBe(21);
  expect(cascade.dx).toBe(42);
  expect(cascade.ratios.root).toBeCloseTo((150 + 42) / 300, 8);
  expect(cascade.ratios).not.toHaveProperty("right-row");

  const cascadedGeometry = computeCanonicalLayout(applyRatioOverrides(layout, cascade.ratios), { width: 308, height: 120 });
  const widths = Object.fromEntries(cascadedGeometry.leaves.map((item) => [item.appletInstanceId, item.rect.right - item.rect.left]));
  expect(widths.left).toBe(192);
  expect(widths.middle).toBe(50);
  expect(widths.right).toBe(50);
});
