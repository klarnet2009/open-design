import { useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import type { ProjectFile, ProjectFileKind } from '../../types';
import styles from './FileTreeExplorer.module.css';

interface Props {
  /** Project files to browse; the caller passes `visibleFiles`. */
  files: ProjectFile[];
  /** Currently-previewed file name, highlighted in the tree. */
  activeFileName: string | null;
  /** Switch the preview to this file (FileWorkspace reuses the active tab). */
  onSelectFile: (name: string) => void;
}

interface FolderNode {
  kind: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}
interface FileNode {
  kind: 'file';
  name: string;
  path: string;
  file: ProjectFile;
}
type TreeNode = FolderNode | FileNode;

// Build a folder tree from `/`-delimited file names. Flat projects (no `/`)
// collapse to a single level, so this handles both shapes the reference image
// shows (nested folders) and a plain design-files project (no folders).
function buildTree(files: ProjectFile[]): TreeNode[] {
  const root: FolderNode = { kind: 'folder', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.name.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let cursor = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        cursor.children.push({ kind: 'file', name: part, path: file.name, file });
        return;
      }
      const path = parts.slice(0, i + 1).join('/');
      let folder = cursor.children.find(
        (c): c is FolderNode => c.kind === 'folder' && c.name === part,
      );
      if (!folder) {
        folder = { kind: 'folder', name: part, path, children: [] };
        cursor.children.push(folder);
      }
      cursor = folder;
    });
  }
  sortNodes(root.children);
  return root.children;
}

function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) if (node.kind === 'folder') sortNodes(node.children);
}

function kindIconName(kind: ProjectFileKind): IconName {
  if (kind === 'html' || kind === 'code') return 'file-code';
  if (kind === 'image') return 'image';
  if (kind === 'sketch') return 'pencil';
  return 'file';
}

/**
 * Toggleable, searchable file-tree explorer docked beside the preview. Unlike
 * the "+" launcher (which opens new tabs), clicking a file here switches the
 * current preview in place (FileWorkspace reuses the active file tab) so
 * browsing the tree doesn't accumulate tabs.
 */
export function FileTreeExplorer({ files, activeFileName, onSelectFile }: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  // Collapsed folders by path. Default: all expanded (empty set). While
  // searching we ignore this and force every matched folder open.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  const filteredFiles = useMemo(
    () => (searching ? files.filter((f) => f.name.toLowerCase().includes(q)) : files),
    [files, q, searching],
  );
  const tree = useMemo(() => buildTree(filteredFiles), [filteredFiles]);

  function toggleFolder(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderNodes(nodes: TreeNode[], depth: number): React.ReactNode {
    return nodes.map((node) => {
      const indent = { paddingLeft: 8 + depth * 14 };
      if (node.kind === 'folder') {
        const isCollapsed = !searching && collapsed.has(node.path);
        return (
          <li key={`d:${node.path}`} className={styles.item}>
            <button
              type="button"
              className={styles.folderRow}
              style={indent}
              onClick={() => toggleFolder(node.path)}
              aria-expanded={!isCollapsed}
            >
              <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
              <Icon name="folder" size={13} />
              <span className={styles.rowName}>{node.name}</span>
            </button>
            {!isCollapsed ? (
              <ul className={styles.list}>{renderNodes(node.children, depth + 1)}</ul>
            ) : null}
          </li>
        );
      }
      const active = node.path === activeFileName;
      return (
        <li key={`f:${node.path}`} className={styles.item}>
          <button
            type="button"
            className={`${styles.fileRow} ${active ? styles.fileRowActive : ''}`}
            style={indent}
            onClick={() => onSelectFile(node.path)}
            title={node.path}
            data-testid="file-tree-file"
            aria-current={active ? 'true' : undefined}
          >
            <Icon name={kindIconName(node.file.kind)} size={13} />
            <span className={styles.rowName}>{node.name}</span>
          </button>
        </li>
      );
    });
  }

  return (
    <aside
      className={styles.root}
      data-testid="file-tree-explorer"
      aria-label={t('workspace.designFiles')}
    >
      <div className={styles.header}>
        <Icon name="folder" size={13} />
        <span className={styles.title}>{t('workspace.designFiles')}</span>
      </div>
      <div className={styles.searchRow}>
        <Icon name="search" size={13} />
        <input
          className={styles.search}
          type="text"
          value={query}
          placeholder={t('workspace.searchFilesPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="file-tree-search"
        />
      </div>
      {tree.length === 0 ? (
        <div className={styles.empty} data-testid="file-tree-empty">
          {t('workspace.noFilesMatch')}
        </div>
      ) : (
        <ul className={styles.list}>{renderNodes(tree, 0)}</ul>
      )}
    </aside>
  );
}
