import { expect, test } from "@playwright/test";
import {
  MIN_APPLET_SIZE,
  TILE_GUTTER_SIZE,
  completedEdgeGroups,
  computeCanonicalLayout,
  projectResize,
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

test("resize projection clamps using every touching leaf", () => {
  const layout: WorkspaceLayoutNode = {
    id: "root",
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: leaf("left"),
    second: leaf("right")
  };
  const geometry = computeCanonicalLayout(layout, { width: 508, height: 420 });
  const target = resizeTargetAt(geometry, { x: 254, y: 120 });

  expect(target).toBeTruthy();
  const projected = projectResize(geometry, target!, { x: 120, y: 0 }, MIN_APPLET_SIZE);
  expect(projected.dx).toBe(50);
  expect(projected.ratios.root).toBeCloseTo((250 + 50) / 500, 8);
});
