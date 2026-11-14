import { ChevronRight, Folder, FolderGit2, MessageSquareText } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "../lib/cx";
import type { TreeNode } from "../types";

interface VisibleNode {
  node: TreeNode;
  level: number;
  parentId: string | null;
  setSize: number;
  posInSet: number;
}

function flattenVisible(
  nodes: TreeNode[],
  expanded: ReadonlySet<string>,
  level = 1,
  parentId: string | null = null,
): VisibleNode[] {
  return nodes.flatMap((node, index) => {
    const self: VisibleNode = { node, level, parentId, setSize: nodes.length, posInSet: index + 1 };
    const children = node.children ?? [];
    if (children.length > 0 && expanded.has(node.id)) {
      return [self, ...flattenVisible(children, expanded, level + 1, node.id)];
    }
    return [self];
  });
}

function hasChildren(node: TreeNode): boolean {
  return node.kind !== "task" && (node.children?.length ?? 0) > 0;
}

export interface TreeProps {
  /** Accessible name of the tree. */
  label: string;
  nodes: TreeNode[];
  expanded: ReadonlySet<string>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onSelect: (node: TreeNode) => void;
}

/**
 * Keyboard-operable tree (WAI-ARIA APG tree view pattern,
 * https://www.w3.org/WAI/ARIA/apg/patterns/treeview/): one tab stop, arrows move,
 * Right/Left expand and collapse, Home/End jump, Enter/Space select.
 */
export function Tree({ label, nodes, expanded, selectedId, onToggle, onSelect }: TreeProps) {
  const visible = useMemo(() => flattenVisible(nodes, expanded), [nodes, expanded]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  const activeId =
    focusedId && visible.some((v) => v.node.id === focusedId)
      ? focusedId
      : (visible.find((v) => v.node.id === selectedId)?.node.id ?? visible[0]?.node.id ?? null);

  const focusNode = (id: string) => {
    setFocusedId(id);
    itemRefs.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = visible.findIndex((v) => v.node.id === activeId);
    const current = visible[index];
    if (!current) return;
    const { node } = current;
    const open = expanded.has(node.id);
    let handled = true;
    switch (event.key) {
      case "ArrowDown": {
        const next = visible[index + 1];
        if (next) focusNode(next.node.id);
        break;
      }
      case "ArrowUp": {
        const prev = visible[index - 1];
        if (prev) focusNode(prev.node.id);
        break;
      }
      case "ArrowRight":
        if (hasChildren(node)) {
          if (!open) onToggle(node.id);
          else {
            const firstChild = visible[index + 1];
            if (firstChild?.parentId === node.id) focusNode(firstChild.node.id);
          }
        }
        break;
      case "ArrowLeft":
        if (hasChildren(node) && open) onToggle(node.id);
        else if (current.parentId) focusNode(current.parentId);
        break;
      case "Home": {
        const first = visible[0];
        if (first) focusNode(first.node.id);
        break;
      }
      case "End": {
        const last = visible[visible.length - 1];
        if (last) focusNode(last.node.id);
        break;
      }
      case "Enter":
      case " ":
        if (hasChildren(node)) onToggle(node.id);
        else if (node.kind === "task") onSelect(node);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // Flat rendering with aria-level/setsize/posinset (allowed by the APG tree pattern):
  // each treeitem's accessible name is exactly its visible row text.
  return (
    <ul role="tree" aria-label={label} className="tree" onKeyDown={onKeyDown}>
      {visible.map(({ node, level, setSize, posInSet }) => {
        const branch = hasChildren(node);
        const open = branch && expanded.has(node.id);
        const empty = node.kind !== "task" && !branch;
        const Icon =
          node.kind === "project" ? FolderGit2 : node.kind === "folder" ? Folder : MessageSquareText;
        return (
          <li
            key={node.id}
            ref={(el) => {
              if (el) itemRefs.current.set(node.id, el);
              else itemRefs.current.delete(node.id);
            }}
            role="treeitem"
            aria-level={level}
            aria-setsize={setSize}
            aria-posinset={posInSet}
            aria-expanded={branch ? open : undefined}
            aria-selected={node.id === selectedId}
            tabIndex={node.id === activeId ? 0 : -1}
            className={cx("tree-item tree-row", node.id === selectedId && "is-selected")}
            data-level={Math.min(level, 6)}
            onFocus={() => {
              setFocusedId(node.id);
            }}
            onClick={() => {
              focusNode(node.id);
              if (branch) onToggle(node.id);
              else if (node.kind === "task") onSelect(node);
            }}
          >
            <span
              className={cx("tree-chevron", open && "is-open", !branch && "is-hidden")}
              aria-hidden="true"
            >
              <ChevronRight width={14} height={14} />
            </span>
            <Icon className="tree-icon" width={15} height={15} aria-hidden="true" />
            <span className="tree-label">{node.label}</span>
            {empty && <span className="tree-empty-hint">empty</span>}
          </li>
        );
      })}
    </ul>
  );
}
