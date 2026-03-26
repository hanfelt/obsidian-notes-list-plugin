import { Plugin, ItemView, WorkspaceLeaf, TFile, TFolder, Menu, debounce, setIcon } from "obsidian";

const VIEW_TYPE = "notes-list-view";

const ICON_PACK_PREFIXES: Record<string, string> = {
  Fas: "font-awesome-solid",
  Ris: "remix-icons",
};

function isEmoji(str: string): boolean {
  // Simple check: emojis are typically 1-2 chars with high code points
  return /^\p{Emoji_Presentation}/u.test(str);
}

class NotesListView extends ItemView {
  private foldersEl: HTMLElement;
  private listEl: HTMLElement;
  private searchEl: HTMLInputElement;
  private searchQuery = "";
  private activeFile: TFile | null = null;
  private selectedFolder: TFolder | null = null;
  private showAllNotes = true;
  private expandedFolders: Set<string> = new Set();
  private pendingInput: { parentPath: string; type: "folder" | "note" } | null = null;
  private folderWidth: number;
  private plugin: NotesListPlugin;
  private iconMap: Record<string, string> = {};

  constructor(leaf: WorkspaceLeaf, plugin: NotesListPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.folderWidth = plugin.settings.folderWidth;
    this.expandedFolders = new Set(plugin.settings.expandedFolders);
    this.showAllNotes = plugin.settings.showAllNotes;
    if (plugin.settings.selectedFolderPath) {
      const f = this.app.vault.getAbstractFileByPath(plugin.settings.selectedFolderPath);
      if (f instanceof TFolder) this.selectedFolder = f;
      if (this.selectedFolder) this.showAllNotes = false;
    }
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Notes";
  }

  getIcon(): string {
    return "file-text";
  }

  async onOpen(): Promise<void> {
    await this.loadIconMap();

    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("notes-list-container");

    // Search bar
    const searchContainer = container.createDiv({ cls: "notes-list-search" });
    this.searchEl = searchContainer.createEl("input", {
      type: "text",
      placeholder: "Search notes...",
      cls: "notes-list-search-input",
    });
    this.searchEl.addEventListener("input", () => {
      this.searchQuery = this.searchEl.value.toLowerCase();
      this.renderNotes();
    });

    // Two-column layout
    const columns = container.createDiv({ cls: "notes-list-columns" });
    this.foldersEl = columns.createDiv({ cls: "notes-list-folders" });
    this.foldersEl.style.width = `${this.folderWidth}px`;

    // Resize handle
    const resizer = columns.createDiv({ cls: "notes-list-resizer" });
    this.setupResizer(resizer);

    this.listEl = columns.createDiv({ cls: "notes-list-files" });

    this.activeFile = this.app.workspace.getActiveFile();
    this.renderFolders();
    await this.renderNotes();
  }

  private setupResizer(resizer: HTMLElement): void {
    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(80, Math.min(500, startWidth + (e.clientX - startX)));
      this.foldersEl.style.width = `${newWidth}px`;
      this.folderWidth = newWidth;
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.removeClass("notes-list-resizing");
      // Save width
      this.plugin.settings.folderWidth = this.folderWidth;
      this.plugin.saveSettings();
    };

    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = this.foldersEl.offsetWidth;
      document.body.addClass("notes-list-resizing");
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  private async loadIconMap(): Promise<void> {
    this.iconMap = {};
    try {
      const path = ".obsidian/plugins/obsidian-icon-folder/data.json";
      const data = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(data);
      for (const [key, value] of Object.entries(parsed)) {
        if (key !== "settings" && typeof value === "string") {
          this.iconMap[key] = value;
        }
      }
    } catch {
      // Icon folder plugin not installed or no data
    }
  }

  private async renderIconEl(container: HTMLElement, folderPath: string): Promise<void> {
    const iconValue = this.iconMap[folderPath];
    if (!iconValue) return;

    const iconEl = container.createSpan({ cls: "notes-folder-icon" });

    if (isEmoji(iconValue)) {
      iconEl.textContent = iconValue;
    } else {
      // Parse icon pack prefix and name
      for (const [prefix, packFolder] of Object.entries(ICON_PACK_PREFIXES)) {
        if (iconValue.startsWith(prefix)) {
          const iconName = iconValue.slice(prefix.length);
          try {
            const svgPath = `.obsidian/icons/${packFolder}/${iconName}.svg`;
            const svgContent = await this.app.vault.adapter.read(svgPath);
            const parser = new DOMParser();
            const doc = parser.parseFromString(svgContent, "image/svg+xml");
            const svg = doc.querySelector("svg");
            if (svg) {
              iconEl.empty();
              iconEl.appendChild(iconEl.doc.importNode(svg, true));
            }
          } catch {
            // Icon file not found
          }
          return;
        }
      }
      // Try as lucide icon
      setIcon(iconEl, iconValue.toLowerCase());
    }
  }

  renderFolders(): void {
    this.saveState();
    this.foldersEl.empty();

    // "All notes" item
    const allItem = this.foldersEl.createDiv({
      cls: "notes-folder-item" + (this.showAllNotes ? " is-active" : ""),
    });
    const allCount = this.app.vault.getMarkdownFiles().length;
    const allRow = allItem.createDiv({ cls: "notes-folder-row" });
    allRow.createSpan({ cls: "notes-folder-chevron" });
    allRow.createSpan({ cls: "notes-folder-name", text: "All Notes" });
    allRow.createSpan({ cls: "notes-folder-count", text: String(allCount) });
    allItem.addEventListener("click", () => {
      this.showAllNotes = true;
      this.selectedFolder = null;
      this.renderFolders();
      this.renderNotes();
    });

    const root = this.app.vault.getRoot();
    this.renderFolderChildren(root, this.foldersEl, 0);
  }

  private renderFolderChildren(parent: TFolder, containerEl: HTMLElement, depth: number): void {
    const subfolders = parent.children
      .filter((c): c is TFolder => c instanceof TFolder)
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const folder of subfolders) {
      const totalCount = this.countFilesRecursive(folder);

      const hasSubfolders = folder.children.some((c) => c instanceof TFolder);
      const isExpanded = this.expandedFolders.has(folder.path);
      const isSelected = !this.showAllNotes && this.selectedFolder?.path === folder.path;

      const wrapper = containerEl.createDiv({ cls: "notes-folder-wrapper" });
      const item = wrapper.createDiv({
        cls: "notes-folder-item" + (isSelected ? " is-active" : ""),
      });

      const row = item.createDiv({ cls: "notes-folder-row" });
      row.style.paddingLeft = `${8 + depth * 16}px`;

      const chevron = row.createSpan({ cls: "notes-folder-chevron" });
      if (hasSubfolders) {
        setIcon(chevron, isExpanded ? "chevron-down" : "chevron-right");
        chevron.addEventListener("click", (e) => {
          e.stopPropagation();
          if (isExpanded) {
            this.expandedFolders.delete(folder.path);
          } else {
            this.expandedFolders.add(folder.path);
          }
          this.renderFolders();
        });
      }

      this.renderIconEl(row, folder.path);
      row.createSpan({ cls: "notes-folder-name", text: folder.name });
      row.createSpan({ cls: "notes-folder-count", text: String(totalCount) });

      item.addEventListener("click", () => {
        this.showAllNotes = false;
        this.selectedFolder = folder;
        if (hasSubfolders && !this.expandedFolders.has(folder.path)) {
          this.expandedFolders.add(folder.path);
        }
        this.renderFolders();
        this.renderNotes();
      });

      // Right-click context menu for folders
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((i) =>
          i.setTitle("New note").setIcon("file-plus").onClick(() => {
            this.expandedFolders.add(folder.path);
            this.pendingInput = { parentPath: folder.path, type: "note" };
            this.renderFolders();
          })
        );
        menu.addItem((i) =>
          i.setTitle("New subfolder").setIcon("folder-plus").onClick(() => {
            this.expandedFolders.add(folder.path);
            this.pendingInput = { parentPath: folder.path, type: "folder" };
            this.renderFolders();
          })
        );
        menu.addSeparator();
        menu.addItem((i) =>
          i.setTitle("Reveal in system explorer").setIcon("folder-open").onClick(() => {
            (this.app as any).showInFolder(folder.path);
          })
        );
        menu.addSeparator();
        menu.addItem((i) =>
          i.setTitle("Rename folder").setIcon("pencil").onClick(async () => {
            const app = this.app as any;
            app.internalPlugins?.getPluginById?.("file-explorer")?.instance?.revealInFolder?.(folder);
          })
        );
        // Let Obsidian and other plugins add their menu items
        this.app.workspace.trigger("file-menu", menu, folder, "notes-list");
        menu.showAtMouseEvent(e);
      });

      if (hasSubfolders && isExpanded) {
        this.renderFolderChildren(folder, wrapper, depth + 1);
      }

      // Show inline input if pending for this folder
      if (this.pendingInput && this.pendingInput.parentPath === folder.path) {
        const pendingType = this.pendingInput.type;
        this.pendingInput = null;
        // Use setTimeout to ensure DOM is ready
        setTimeout(() => {
          this.showInlineInput(folder, wrapper, depth + 1, pendingType);
        }, 0);
      }
    }
  }

  private showInlineInput(parentFolder: TFolder, containerEl: HTMLElement, depth: number, type: "folder" | "note"): void {
    const inputItem = containerEl.createDiv({ cls: "notes-folder-item notes-folder-input-item" });
    const inputRow = inputItem.createDiv({ cls: "notes-folder-row" });
    inputRow.style.paddingLeft = `${8 + depth * 16}px`;
    inputRow.createSpan({ cls: "notes-folder-chevron" });

    const input = inputRow.createEl("input", {
      type: "text",
      cls: "notes-folder-inline-input",
      placeholder: type === "folder" ? "Folder name..." : "Note name...",
    });

    input.focus();

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const name = input.value.trim();
      if (!name) {
        inputItem.remove();
        return;
      }
      try {
        if (type === "folder") {
          const path = `${parentFolder.path}/${name}`;
          if (!this.app.vault.getAbstractFileByPath(path)) {
            await this.app.vault.createFolder(path);
          }
          this.renderFolders();
        } else {
          let path = `${parentFolder.path}/${name}`;
          if (!path.endsWith(".md")) path += ".md";
          if (!this.app.vault.getAbstractFileByPath(path)) {
            const file = await this.app.vault.create(path, "");
            this.app.workspace.getLeaf(false).openFile(file);
          }
          this.renderFolders();
          await this.renderNotes();
        }
      } catch {
        inputItem.remove();
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        committed = true;
        inputItem.remove();
      }
    });

    input.addEventListener("blur", () => {
      commit();
    });
  }

  private countFilesRecursive(folder: TFolder): number {
    let count = 0;
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        count++;
      } else if (child instanceof TFolder) {
        count += this.countFilesRecursive(child);
      }
    }
    return count;
  }

  async renderNotes(): Promise<void> {
    this.listEl.empty();

    let files = this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);

    if (!this.showAllNotes && this.selectedFolder) {
      const folderPath = this.selectedFolder.path;
      files = files.filter((f) => {
        if (f.parent?.path === folderPath) return true;
        return f.path.startsWith(folderPath + "/");
      });
    }

    if (this.searchQuery) {
      files = files.filter((f) => f.basename.toLowerCase().includes(this.searchQuery));
    }

    for (const file of files) {
      const item = this.listEl.createDiv({
        cls: "notes-list-item" + (this.activeFile?.path === file.path ? " is-active" : ""),
      });

      const titleRow = item.createDiv({ cls: "notes-list-title" });
      this.renderIconEl(titleRow, file.path);
      titleRow.createSpan({ text: file.basename });

      const meta = item.createDiv({ cls: "notes-list-meta" });
      meta.createSpan({
        cls: "notes-list-date",
        text: formatDate(file.stat.mtime),
      });

      try {
        const content = await this.app.vault.cachedRead(file);
        const snippet = getSnippet(content, file.basename);
        if (snippet) {
          meta.createSpan({ cls: "notes-list-snippet", text: snippet });
        }
      } catch {
        // file might be unavailable
      }

      item.addEventListener("click", () => {
        this.app.workspace.getLeaf(false).openFile(file);
      });

      // Right-click context menu for files
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((i) =>
          i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => {
            this.app.workspace.getLeaf("tab").openFile(file);
          })
        );
        menu.addItem((i) =>
          i.setTitle("Open to the right").setIcon("separator-vertical").onClick(() => {
            this.app.workspace.getLeaf("split").openFile(file);
          })
        );
        menu.addSeparator();
        menu.addItem((i) =>
          i.setTitle("Delete").setIcon("trash").onClick(async () => {
            await this.app.fileManager.trashFile(file);
          })
        );
        menu.addItem((i) =>
          i.setTitle("Rename").setIcon("pencil").onClick(() => {
            // Open file and trigger rename via Obsidian command
            this.app.workspace.getLeaf(false).openFile(file).then(() => {
              (this.app as any).commands?.executeCommandById?.("workspace:edit-file-title");
            });
          })
        );
        menu.addSeparator();
        menu.addItem((i) =>
          i.setTitle("Reveal in system explorer").setIcon("folder-open").onClick(() => {
            (this.app as any).showInFolder(file.path);
          })
        );
        // Let other plugins add items via the file-menu event
        this.app.workspace.trigger("file-menu", menu, file, "notes-list");
        menu.showAtMouseEvent(e);
      });
    }
  }

  setActiveFile(file: TFile | null): void {
    this.activeFile = file;
    const items = this.listEl.querySelectorAll(".notes-list-item");
    const files = this.getVisibleFiles();
    items.forEach((el, i) => {
      if (i < files.length && files[i].path === file?.path) {
        el.addClass("is-active");
      } else {
        el.removeClass("is-active");
      }
    });
  }

  private getVisibleFiles(): TFile[] {
    let files = this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
    if (!this.showAllNotes && this.selectedFolder) {
      const folderPath = this.selectedFolder.path;
      files = files.filter((f) => f.path.startsWith(folderPath + "/"));
    }
    if (this.searchQuery) {
      files = files.filter((f) => f.basename.toLowerCase().includes(this.searchQuery));
    }
    return files;
  }

  private saveState(): void {
    this.plugin.settings.expandedFolders = Array.from(this.expandedFolders);
    this.plugin.settings.selectedFolderPath = this.selectedFolder?.path ?? null;
    this.plugin.settings.showAllNotes = this.showAllNotes;
    this.plugin.saveSettings();
  }

  async refresh(): Promise<void> {
    await this.loadIconMap();
    this.renderFolders();
    await this.renderNotes();
  }
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "long" });
  } else {
    return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  }
}

function getSnippet(content: string, title: string): string {
  let text = content.replace(/^---[\s\S]*?---\n?/, "");
  text = text.replace(new RegExp(`^#+ ${escapeRegex(title)}\\s*\n?`), "");
  text = text.replace(/^#+\s/gm, "").replace(/[*_~`>\[\]]/g, "").trim();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const snippet = lines.slice(0, 2).join(" ").trim();
  return snippet.length > 120 ? snippet.slice(0, 120) + "..." : snippet;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface NotesListSettings {
  folderWidth: number;
  expandedFolders: string[];
  selectedFolderPath: string | null;
  showAllNotes: boolean;
}

const DEFAULT_SETTINGS: NotesListSettings = {
  folderWidth: 180,
  expandedFolders: [],
  selectedFolderPath: null,
  showAllNotes: true,
};

export default class NotesListPlugin extends Plugin {
  private view: NotesListView | null = null;
  settings: NotesListSettings = DEFAULT_SETTINGS;
  private debouncedRender = debounce(() => this.view?.refresh(), 500, true);

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => {
      this.view = new NotesListView(leaf, this);
      return this.view;
    });

    this.addRibbonIcon("file-text", "Open Notes List", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-notes-list",
      name: "Open Notes List",
      callback: () => this.activateView(),
    });

    this.registerEvent(this.app.vault.on("create", () => this.debouncedRender()));
    this.registerEvent(this.app.vault.on("delete", () => this.debouncedRender()));
    this.registerEvent(this.app.vault.on("rename", () => this.debouncedRender()));
    this.registerEvent(this.app.vault.on("modify", () => this.debouncedRender()));

    // Watch for icon-folder plugin changes via raw file events
    this.registerEvent(
      (this.app.vault as any).on("raw", (path: string) => {
        if (path.includes("obsidian-icon-folder/data.json")) {
          this.debouncedRender();
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const file = this.app.workspace.getActiveFile();
        this.view?.setActiveFile(file);
      })
    );

    this.app.workspace.onLayoutReady(() => this.activateView());
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    // Create in a new tab in the left sidebar (true = new tab, not replacing existing)
    const leaf = this.app.workspace.getLeftLeaf(true);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  onunload(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
    this.view = null;
  }
}
