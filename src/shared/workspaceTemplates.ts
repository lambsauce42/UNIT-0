import type {
  AppletKind,
  WorkspaceTemplate,
  WorkspaceTemplateCell,
  WorkspaceTemplateId,
  WorkspaceTemplateLayoutNode
} from "./types";

const reusableKinds: AppletKind[] = ["terminal", "wslTerminal", "fileViewer", "browser", "chat", "sandbox"];

function cell(id: string, label: string): WorkspaceTemplateCell {
  return { id, label, preferredKind: "terminal", acceptedKinds: reusableKinds };
}

function leaf(cellId: string): WorkspaceTemplateLayoutNode {
  return { id: `template-leaf-${cellId}`, type: "leaf", cellId };
}

function split(
  id: string,
  direction: "row" | "column",
  ratio: number,
  first: WorkspaceTemplateLayoutNode,
  second: WorkspaceTemplateLayoutNode
): WorkspaceTemplateLayoutNode {
  return { id, type: "split", direction, ratio, first, second };
}

function cellIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

function cells(ids: string[]): WorkspaceTemplateCell[] {
  return ids.map((id, index) => cell(id, `Cell ${index + 1}`));
}

function balancedLine(id: string, direction: "row" | "column", ids: string[]): WorkspaceTemplateLayoutNode {
  if (ids.length === 1) {
    return leaf(ids[0]);
  }
  const midpoint = Math.ceil(ids.length / 2);
  return split(
    `${id}-${ids.length}`,
    direction,
    midpoint / ids.length,
    balancedLine(`${id}-first`, direction, ids.slice(0, midpoint)),
    balancedLine(`${id}-second`, direction, ids.slice(midpoint))
  );
}

function grid(id: string, rows: number, cols: number, ids: string[]): WorkspaceTemplateLayoutNode {
  const rowNodes = Array.from({ length: rows }, (_, rowIndex) =>
    balancedLine(`${id}-row-${rowIndex + 1}`, "row", ids.slice(rowIndex * cols, rowIndex * cols + cols))
  );
  return combineNodes(`${id}-rows`, "column", rowNodes);
}

function combineNodes(id: string, direction: "row" | "column", nodes: WorkspaceTemplateLayoutNode[]): WorkspaceTemplateLayoutNode {
  if (nodes.length === 1) {
    return nodes[0];
  }
  const midpoint = Math.ceil(nodes.length / 2);
  return split(
    `${id}-${nodes.length}`,
    direction,
    midpoint / nodes.length,
    combineNodes(`${id}-first`, direction, nodes.slice(0, midpoint)),
    combineNodes(`${id}-second`, direction, nodes.slice(midpoint))
  );
}

function gridTemplate(id: WorkspaceTemplateId, name: string, description: string, rows: number, cols: number): WorkspaceTemplate {
  const ids = cellIds(id, rows * cols);
  return { id, name, description, cells: cells(ids), layout: grid(id, rows, cols, ids) };
}

function sidebarTemplate(
  id: WorkspaceTemplateId,
  name: string,
  description: string,
  side: "left" | "right"
): WorkspaceTemplate {
  const sidebarId = `${id}-sidebar`;
  const gridIds = cellIds(`${id}-grid`, 9);
  const sidebar = leaf(sidebarId);
  const mainGrid = grid(`${id}-main`, 3, 3, gridIds);
  return {
    id,
    name,
    description,
    cells: [cell(sidebarId, side === "left" ? "Left Sidebar" : "Right Sidebar"), ...cells(gridIds)],
    layout: split(`${id}-root`, "row", side === "left" ? 0.24 : 0.76, side === "left" ? sidebar : mainGrid, side === "left" ? mainGrid : sidebar)
  };
}

function rowTemplate(id: WorkspaceTemplateId, name: string, description: string, side: "top" | "bottom"): WorkspaceTemplate {
  const rowIds = cellIds(`${id}-row`, 4);
  const gridIds = cellIds(`${id}-grid`, 9);
  const row = balancedLine(`${id}-strip`, "row", rowIds);
  const mainGrid = grid(`${id}-main`, 3, 3, gridIds);
  return {
    id,
    name,
    description,
    cells: [...cells(rowIds), ...cells(gridIds)],
    layout: split(`${id}-root`, "column", side === "top" ? 0.22 : 0.78, side === "top" ? row : mainGrid, side === "top" ? mainGrid : row)
  };
}

export const workspaceTemplates: WorkspaceTemplate[] = [
  gridTemplate("grid-2x2", "2 x 2 Grid", "Four equal cells. Reuse current applets, fill gaps with terminals.", 2, 2),
  gridTemplate("grid-3x3", "3 x 3 Grid", "Nine equal cells for dense workspace layouts.", 3, 3),
  gridTemplate("grid-4x4", "4 x 4 Grid", "Sixteen compact cells for broad monitoring or session walls.", 4, 4),
  sidebarTemplate("left-sidebar-3x3", "Left Sidebar + 3 x 3", "One fixed left lane beside a 3 x 3 work grid.", "left"),
  sidebarTemplate("right-sidebar-3x3", "3 x 3 + Right Sidebar", "A 3 x 3 work grid with a persistent right lane.", "right"),
  rowTemplate("top-row-3x3", "Top Row + 3 x 3", "A horizontal top strip above a 3 x 3 grid.", "top"),
  rowTemplate("bottom-row-3x3", "3 x 3 + Bottom Row", "A 3 x 3 grid with a horizontal bottom strip.", "bottom")
];

export function workspaceTemplateById(templateId: WorkspaceTemplateId): WorkspaceTemplate {
  const template = workspaceTemplates.find((item) => item.id === templateId);
  if (!template) {
    throw new Error(`Workspace template ${templateId} does not exist`);
  }
  return template;
}
