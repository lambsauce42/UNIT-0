import type {
  AppletInstance,
  AppletKind,
  AppletSession,
  TemplateCellAssignment,
  Workspace,
  WorkspaceLayoutNode,
  WorkspaceTemplate,
  WorkspaceTemplateLayoutNode
} from "./types";

export type TemplatePlan = {
  assignments: Record<string, TemplateCellAssignment>;
  reusedAppletIds: string[];
  createdCellIds: string[];
  shelfAppletIds: string[];
};

export function planWorkspaceTemplate(
  workspace: Workspace,
  appletSessions: Record<string, AppletSession>,
  template: WorkspaceTemplate
): TemplatePlan {
  const visualAppletIds = workspace.layout ? collectLayoutAppletIds(workspace.layout) : [];
  const orderedApplets = orderWorkspaceApplets(workspace, visualAppletIds);
  const assignedAppletIds = new Set<string>();
  const assignments: Record<string, TemplateCellAssignment> = {};
  const createdCellIds: string[] = [];

  for (const cell of template.cells) {
    const compatibleByOrder = orderedApplets.find((instance) => {
      const session = appletSessions[instance.sessionId];
      return Boolean(session && cell.acceptedKinds.includes(session.kind) && !assignedAppletIds.has(instance.id));
    });
    const exact = orderedApplets.find((instance) => {
      const session = appletSessions[instance.sessionId];
      return session?.kind === cell.preferredKind && !assignedAppletIds.has(instance.id);
    });
    const compatible = cell.acceptedKinds.length > 3 ? compatibleByOrder : exact ?? compatibleByOrder;
    if (compatible) {
      assignments[cell.id] = { mode: "reuse", appletInstanceId: compatible.id };
      assignedAppletIds.add(compatible.id);
      continue;
    }
    assignments[cell.id] = { mode: "create", kind: cell.preferredKind };
    createdCellIds.push(cell.id);
  }

  return {
    assignments,
    reusedAppletIds: [...assignedAppletIds],
    createdCellIds,
    shelfAppletIds: workspace.applets.map((instance) => instance.id).filter((appletId) => !assignedAppletIds.has(appletId))
  };
}

export function orderWorkspaceApplets(workspace: Workspace, visualAppletIds: string[]): AppletInstance[] {
  const byId = new Map(workspace.applets.map((instance) => [instance.id, instance]));
  const orderedIds = [...visualAppletIds, ...workspace.shelfAppletIds, ...workspace.applets.map((instance) => instance.id)];
  const seen = new Set<string>();
  const ordered: AppletInstance[] = [];
  for (const appletId of orderedIds) {
    if (seen.has(appletId)) {
      continue;
    }
    const instance = byId.get(appletId);
    if (!instance) {
      continue;
    }
    seen.add(appletId);
    ordered.push(instance);
  }
  return ordered;
}

export function collectLayoutAppletIds(node: WorkspaceLayoutNode): string[] {
  if (node.type === "leaf") {
    return [node.appletInstanceId];
  }
  return [...collectLayoutAppletIds(node.first), ...collectLayoutAppletIds(node.second)];
}

export function templateLayoutToWorkspaceLayout(
  node: WorkspaceTemplateLayoutNode,
  cellAppletIds: Record<string, string>
): WorkspaceLayoutNode {
  if (node.type === "leaf") {
    const appletInstanceId = cellAppletIds[node.cellId];
    if (!appletInstanceId) {
      throw new Error(`Template cell ${node.cellId} is missing an applet assignment`);
    }
    return {
      id: `leaf-${appletInstanceId}`,
      type: "leaf",
      appletInstanceId
    };
  }
  return {
    id: `template-${node.id}`,
    type: "split",
    direction: node.direction,
    ratio: node.ratio,
    first: templateLayoutToWorkspaceLayout(node.first, cellAppletIds),
    second: templateLayoutToWorkspaceLayout(node.second, cellAppletIds)
  };
}
