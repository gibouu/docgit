/** A node in the derived folder tree: subfolders + documents directly inside. */
export interface FolderNode {
  /** Folder segment name ('' for the root node). */
  name: string;
  /** Full folder path. */
  path: string;
  folders: FolderNode[];
  /** Document paths directly in this folder (not in a subfolder). */
  docPaths: string[];
}

export interface FolderTree {
  /** Tree of folders/docs under the workspace root. */
  root: FolderNode;
  /** Document paths that are not under the workspace root. */
  otherLocations: string[];
}

const SEP = '/';

/**
 * Group tracked document paths into a folder tree relative to `workspaceRoot`
 * (single-workspace-root model, #52). Folders are derived from the paths — no
 * stored folder entity. Paths outside the root go to `otherLocations`. Pure and
 * deterministic (folders + docs sorted) so it can be unit-tested and reused by
 * the renderer without pulling the node:sqlite store into the bundle.
 */
export function buildFolderTree(docPaths: string[], workspaceRoot: string): FolderTree {
  const root = workspaceRoot.replace(/\/+$/, ''); // strip trailing slashes
  const tree: FolderNode = { name: '', path: root, folders: [], docPaths: [] };
  const otherLocations: string[] = [];

  if (!root) {
    // No workspace root → everything is "other locations" (flat).
    return { root: tree, otherLocations: [...docPaths].sort() };
  }

  for (const docPath of docPaths) {
    if (!docPath.startsWith(root + SEP)) {
      otherLocations.push(docPath);
      continue;
    }
    const segments = docPath.slice(root.length + 1).split(SEP);
    segments.pop(); // drop the file name; what remains is the folder chain
    let node = tree;
    let prefix = root;
    for (const seg of segments) {
      prefix = `${prefix}${SEP}${seg}`;
      let child = node.folders.find((f) => f.name === seg);
      if (!child) {
        child = { name: seg, path: prefix, folders: [], docPaths: [] };
        node.folders.push(child);
      }
      node = child;
    }
    node.docPaths.push(docPath);
  }

  sortNode(tree);
  otherLocations.sort();
  return { root: tree, otherLocations };
}

function sortNode(node: FolderNode): void {
  node.folders.sort((a, b) => a.name.localeCompare(b.name));
  node.docPaths.sort();
  node.folders.forEach(sortNode);
}
