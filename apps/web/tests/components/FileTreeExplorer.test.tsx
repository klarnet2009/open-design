// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileTreeExplorer } from '../../src/components/workspace/FileTreeExplorer';
import type { ProjectFile } from '../../src/types';

afterEach(cleanup);

function file(name: string): ProjectFile {
  return {
    name,
    size: 100,
    mtime: 0,
    kind: name.endsWith('.html') ? 'html' : 'text',
    mime: 'text/plain',
  };
}

const files: ProjectFile[] = [
  file('index.html'),
  file('todo-intelligence/2026.05.28/实际数据.md'),
  file('todo-intelligence/2026.05.19/notes.md'),
  file('design-system/DESIGN.md'),
];

describe('FileTreeExplorer', () => {
  it('renders a folder tree with nested leaves expanded by default', () => {
    render(<FileTreeExplorer files={files} activeFileName={null} onSelectFile={() => {}} />);
    expect(screen.getByText('todo-intelligence')).toBeTruthy();
    expect(screen.getByText('index.html')).toBeTruthy();
    // Nested leaf is visible because folders default to expanded.
    expect(screen.getByText('实际数据.md')).toBeTruthy();
  });

  it('filters the tree by the search query', () => {
    render(<FileTreeExplorer files={files} activeFileName={null} onSelectFile={() => {}} />);
    fireEvent.change(screen.getByTestId('file-tree-search'), { target: { value: 'DESIGN' } });
    expect(screen.getByText('DESIGN.md')).toBeTruthy();
    expect(screen.queryByText('index.html')).toBeNull();
    expect(screen.queryByText('实际数据.md')).toBeNull();
  });

  it('shows the empty state when nothing matches', () => {
    render(<FileTreeExplorer files={files} activeFileName={null} onSelectFile={() => {}} />);
    fireEvent.change(screen.getByTestId('file-tree-search'), {
      target: { value: 'no-such-file' },
    });
    expect(screen.getByTestId('file-tree-empty')).toBeTruthy();
  });

  it('switches preview in place via onSelectFile with the full path', () => {
    const onSelectFile = vi.fn();
    render(<FileTreeExplorer files={files} activeFileName={null} onSelectFile={onSelectFile} />);
    fireEvent.click(screen.getByText('实际数据.md'));
    expect(onSelectFile).toHaveBeenCalledWith('todo-intelligence/2026.05.28/实际数据.md');
  });

  it('collapses a folder when its row is clicked', () => {
    render(<FileTreeExplorer files={files} activeFileName={null} onSelectFile={() => {}} />);
    expect(screen.getByText('notes.md')).toBeTruthy();
    fireEvent.click(screen.getByText('todo-intelligence'));
    expect(screen.queryByText('实际数据.md')).toBeNull();
    expect(screen.queryByText('notes.md')).toBeNull();
  });
});
