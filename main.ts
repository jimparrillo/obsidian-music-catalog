import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  getAllTags,
  requestUrl,
} from "obsidian";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReleaseData {
  upc: string;
  album: string;
  artists: string[];
  label: string;
  catalogNumber: string;
  releaseYear: string;
  genres: string[];
  format: string;
  coverUrl: string;
}

interface CustomField {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "boolean";
}

interface MusicCatalogSettings {
  baseFolder: string;
  notesSubfolder: string;
  discogsToken: string;
  saveAndAddFirst: boolean;
  customFields: CustomField[];
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: MusicCatalogSettings = {
  baseFolder: "Music",
  notesSubfolder: "Notes",
  discogsToken: "",
  saveAndAddFirst: true,
  customFields: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toYamlInline(items: string[]): string {
  if (!items || items.length === 0) return "[]";
  const escaped = items.map((i) => `"${i.replace(/"/g, '\\"')}"`);
  return `[${escaped.join(", ")}]`;
}

function toYamlKey(name: string): string {
  return name.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-_]/g, "").replace(/^-+|-+$/g, "") || "custom-field";
}

const LOWERCASE_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet",
  "at", "by", "in", "of", "on", "to", "up", "as", "is", "it",
]);

function toTitleCase(str: string): string {
  if (!str) return str;
  const words = str.trim().split(/\s+/);
  return words.map((word, index) => {
    if (index === 0 || index === words.length - 1) return capitalizeWord(word);
    const clean = word.toLowerCase().replace(/[^a-z]/g, "");
    if (LOWERCASE_WORDS.has(clean)) return word.toLowerCase();
    return capitalizeWord(word);
  }).join(" ");
}

function capitalizeWord(word: string): string {
  if (!word) return word;
  if (word === word.toUpperCase() && /^[A-Z]/.test(word) && word.length <= 3) return word;
  if (word.includes("-")) return word.split("-").map((p) => capitalizeWord(p)).join("-");
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function toTitleCaseNames(names: string[]): string[] {
  return names.map((name) => name.split(/(\s+|,\s*)/).map((p) => capitalizeWord(p)).join(""));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Format filter helper ─────────────────────────────────────────────────────

function matchesFormatFilter(format: string, filter: "" | "cd" | "lp"): boolean {
  if (!filter) return true;
  const f = format.toLowerCase();
  if (filter === "cd") return f.includes("cd");
  if (filter === "lp") return f.includes("vinyl") || f === "lp" || f.includes("7\"") || f.includes("10\"") || f.includes("12\"");
  return true;
}

// ─── Path Helpers ─────────────────────────────────────────────────────────────

function getNotesFolder(settings: Pick<MusicCatalogSettings, "baseFolder" | "notesSubfolder">): string {
  if (settings.notesSubfolder.trim()) return `${settings.baseFolder}/${settings.notesSubfolder}`.replace(/\/+/g, "/");
  return settings.baseFolder;
}

function getBasePath(baseFolder: string): string { return `${baseFolder}/Music Catalog.base`; }

// ─── Base File Generator ──────────────────────────────────────────────────────

function generateBaseContent(settings: MusicCatalogSettings): string {
  const notesFolder = getNotesFolder(settings);
  return `filters:
  and:
    - file.hasTag("record")
    - file.inFolder("${notesFolder}")
properties:
  file.name:
    displayName: Album
views:
  - type: table
    name: All Releases
    order:
      - file.name
      - artists
      - label
      - releaseYear
      - format
      - genre
      - condition
      - copies
      - valuation
    sort:
      - property: file.name
        direction: ASC
  - type: table
    name: By Year
    order:
      - file.name
      - artists
      - label
      - releaseYear
      - format
      - condition
      - copies
    sort:
      - property: releaseYear
        direction: ASC
  - type: table
    name: By Artist
    order:
      - file.name
      - artists
      - label
      - releaseYear
      - format
      - copies
    sort:
      - property: artists
        direction: ASC
  - type: table
    name: Needs Condition
    filters:
      and:
        - condition == ""
    order:
      - file.name
      - artists
      - format
      - copies
      - upc
    sort:
      - property: file.name
        direction: ASC
`;
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class MusicCatalogPlugin extends Plugin {
  settings: MusicCatalogSettings;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("music", "Open Music Catalog", () => {
      const baseFile = this.findExistingBaseFile();
      if (baseFile) {
        this.app.workspace.getLeaf(false).openFile(baseFile);
      } else {
        new Notice("Music Catalog.base not found. Create it in Settings → Music Catalog.");
      }
    });

    this.addRibbonIcon("disc", "Add Music", () => new BarcodeModal(this.app, this).open());

    this.addCommand({ id: "add-music", name: "Add music", callback: () => new BarcodeModal(this.app, this).open() });
    this.addCommand({ id: "open-music-catalog", name: "Open Music Catalog", callback: () => {
      const baseFile = this.findExistingBaseFile();
      if (baseFile) this.app.workspace.getLeaf(false).openFile(baseFile);
      else new Notice("Music Catalog.base not found. Create it in Settings → Music Catalog.");
    }});

    this.addSettingTab(new MusicCatalogSettingTab(this.app, this));
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); if (!this.settings.customFields) this.settings.customFields = []; }
  async saveSettings() { await this.saveData(this.settings); }

  async ensureFolder(path: string): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
  }

  collectFiles(folder: TFolder, results: TFile[] = []): TFile[] {
    for (const child of folder.children) {
      if (child instanceof TFile) results.push(child);
      else if (child instanceof TFolder) this.collectFiles(child, results);
    }
    return results;
  }

  scanVaultForReleaseNotes(): TFile[] {
    return this.collectFiles(this.app.vault.getRoot()).filter((f) => {
      if (f.extension !== "md") return false;
      const cache = this.app.metadataCache.getFileCache(f);
      return cache ? (getAllTags(cache)?.includes("#record") ?? false) : false;
    });
  }

  findExistingBaseFile(): TFile | null {
    return this.collectFiles(this.app.vault.getRoot())
      .find((f) => f.extension === "base" && f.name === "Music Catalog.base") ?? null;
  }

  async createBaseFile(): Promise<void> {
    await this.ensureFolder(this.settings.baseFolder);
    const basePath = getBasePath(this.settings.baseFolder);
    const content = generateBaseContent(this.settings);
    const existing = this.app.vault.getAbstractFileByPath(basePath);
    if (existing instanceof TFile) { await this.app.vault.modify(existing, content); new Notice("✅ Music Catalog.base updated."); }
    else { await this.app.vault.create(basePath, content); new Notice("✅ Music Catalog.base created."); }
  }

  async reorganizeFiles(releaseNotes: TFile[]): Promise<void> {
    const newNotesFolder = getNotesFolder(this.settings);
    const newBasePath = getBasePath(this.settings.baseFolder);
    await this.ensureFolder(this.settings.baseFolder);
    if (this.settings.notesSubfolder.trim()) await this.ensureFolder(newNotesFolder);
    let moved = 0;
    for (const file of releaseNotes) {
      const newPath = `${newNotesFolder}/${file.name}`;
      if (file.path !== newPath) { await this.app.vault.rename(file, newPath); moved++; }
    }
    const existingBase = this.findExistingBaseFile();
    if (existingBase && existingBase.path !== newBasePath) await this.app.vault.rename(existingBase, newBasePath);
    await this.createBaseFile(); await this.saveSettings();
    new Notice(`✅ Reorganization complete. ${moved} note${moved !== 1 ? "s" : ""} moved.`);
  }

  // ─── UPC Barcode Lookup ───────────────────────────────────────────────────

  async lookupUPC(upc: string): Promise<ReleaseData | null> {
    const cleanUPC = upc.replace(/[^0-9]/g, "");
    if (this.settings.discogsToken) {
      try { const r = await this.fetchDiscogs(cleanUPC); if (r) return r; } catch (e) { console.warn("Discogs lookup failed:", e); }
    }
    try { const r = await this.fetchMusicBrainz(cleanUPC); if (r) return r; } catch (e) { console.warn("MusicBrainz lookup failed:", e); }
    return null;
  }

  async fetchDiscogs(upc: string): Promise<ReleaseData | null> {
    const url = `https://api.discogs.com/database/search?barcode=${upc}&type=release&token=${this.settings.discogsToken}`;
    const response = await requestUrl({ url, headers: { "User-Agent": "ObsidianMusicCatalog/0.1" } });
    const data = response.json;
    if (!data.results?.length) return null;
    return this.parseDiscogsResult(data.results[0], upc);
  }

  async fetchMusicBrainz(upc: string): Promise<ReleaseData | null> {
    const url = `https://musicbrainz.org/ws/2/release?query=barcode:${upc}&fmt=json&inc=artist-credits+labels+genres+media`;
    const response = await requestUrl({ url, headers: { "User-Agent": "ObsidianMusicCatalog/0.1 (obsidian-plugin)" } });
    const data = response.json;
    if (!data.releases?.length) return null;
    return this.parseMBRelease(data.releases[0], upc);
  }

  // ─── Manual Title/Artist/Label Search ────────────────────────────────────

  async searchReleases(params: {
    title: string;
    artist: string;
    label: string;
    composer: string;
    conductor: string;
    formatFilter: "" | "cd" | "lp";
  }): Promise<ReleaseData[]> {
    const { title, artist, label, composer, conductor, formatFilter } = params;
    const results: ReleaseData[] = [];
    const seenKeys = new Set<string>();
    const dedupeKey = (r: ReleaseData) => `${r.album.toLowerCase().trim()}|${(r.artists[0] || "").toLowerCase().trim()}|${r.releaseYear}`;
    const addResult = (r: ReleaseData) => { const key = dedupeKey(r); if (!seenKeys.has(key)) { seenKeys.add(key); results.push(r); } };
    if (this.settings.discogsToken) {
      try { (await this.searchDiscogs(title, artist, label, composer, conductor, formatFilter)).forEach(addResult); } catch (e) { console.warn("Discogs search failed:", e); }
    }
    try { (await this.searchMusicBrainz(title, artist, composer, conductor, formatFilter)).forEach(addResult); } catch (e) { console.warn("MusicBrainz search failed:", e); }
    return results.slice(0, 30);
  }

  async searchDiscogs(title: string, artist: string, label: string, composer: string, conductor: string, formatFilter: "" | "cd" | "lp"): Promise<ReleaseData[]> {
    const artistTerms = [artist, composer, conductor].filter(Boolean);
    const seen = new Set<string>();
    const results: ReleaseData[] = [];
    const discogsFormat = formatFilter === "cd" ? "CD" : formatFilter === "lp" ? "Vinyl" : "";
    const runQuery = async (artistTerm: string) => {
      let url = `https://api.discogs.com/database/search?release_title=${encodeURIComponent(title)}&type=release&per_page=25&token=${this.settings.discogsToken}`;
      if (artistTerm) url += `&artist=${encodeURIComponent(artistTerm)}`;
      if (label) url += `&label=${encodeURIComponent(label)}`;
      if (discogsFormat) url += `&format=${encodeURIComponent(discogsFormat)}`;
      const response = await requestUrl({ url, headers: { "User-Agent": "ObsidianMusicCatalog/0.1" } });
      const data = response.json;
      for (const result of (data.results || [])) { const id = String(result.id); if (seen.has(id)) continue; seen.add(id); results.push(this.parseDiscogsResult(result, "")); }
    };
    if (artistTerms.length > 0) { for (const term of artistTerms) { try { await runQuery(term); } catch (e) { console.warn(`Discogs search for "${term}" failed:`, e); } } }
    else { try { await runQuery(""); } catch (e) { console.warn("Discogs title search failed:", e); } }
    return results;
  }

  async searchMusicBrainz(title: string, artist: string, composer: string, conductor: string, formatFilter: "" | "cd" | "lp"): Promise<ReleaseData[]> {
    const escapedTitle = title.replace(/"/g, '\\"');
    const baseQuery = `release:"${escapedTitle}"`;
    const artistTerms = [artist, composer, conductor].filter(Boolean);
    const queries: string[] = artistTerms.length > 0 ? artistTerms.map((t) => `${baseQuery} AND artist:"${t.replace(/"/g, '\\"')}"`) : [baseQuery];
    const seen = new Set<string>();
    const results: ReleaseData[] = [];
    for (let i = 0; i < queries.length; i++) {
      if (i > 0) await sleep(1100);
      try {
        const url = `https://musicbrainz.org/ws/2/release?query=${encodeURIComponent(queries[i])}&fmt=json&limit=20&inc=artist-credits+labels+genres+media`;
        const response = await requestUrl({ url, headers: { "User-Agent": "ObsidianMusicCatalog/0.1 (obsidian-plugin)" } });
        const data = response.json;
        for (const r of (data.releases || [])) {
          if (seen.has(r.id)) continue;
          const release = this.parseMBRelease(r, "");
          if (!matchesFormatFilter(release.format, formatFilter)) continue;
          seen.add(r.id); results.push(release);
        }
      } catch (e) { console.warn(`MusicBrainz query "${queries[i]}" failed:`, e); }
    }
    return results;
  }

  // ─── Parsers ──────────────────────────────────────────────────────────────

  parseDiscogsResult(result: any, upc: string): ReleaseData {
    let album = result.title || "Unknown Album";
    let artistFromTitle = "";
    if (album.includes(" - ")) { const parts = album.split(" - "); artistFromTitle = parts[0].trim(); album = parts.slice(1).join(" - ").trim(); }
    const artists = result.artist ? [result.artist] : artistFromTitle ? [artistFromTitle] : [];
    return { upc, album: toTitleCase(album), artists: toTitleCaseNames(artists), label: Array.isArray(result.label) ? result.label[0] : result.label || "", catalogNumber: result.catno || "", releaseYear: result.year?.toString() || "", genres: [...(result.genre || []), ...(result.style || [])].slice(0, 5), format: Array.isArray(result.format) ? result.format[0] : result.format || "", coverUrl: result.cover_image || result.thumb || "" };
  }

  parseMBRelease(r: any, upc: string): ReleaseData {
    const artists = (r["artist-credit"] || []).filter((ac: any) => ac.artist).map((ac: any) => ac.artist.name as string);
    return { upc, album: toTitleCase(r.title || "Unknown Album"), artists: toTitleCaseNames(artists), label: r["label-info"]?.[0]?.label?.name || "", catalogNumber: r["label-info"]?.[0]?.["catalog-number"] || "", releaseYear: r.date ? r.date.substring(0, 4) : "", genres: (r.genres || []).slice(0, 5).map((g: any) => g.name as string), format: r.media?.[0]?.format || "", coverUrl: "" };
  }

  // ─── Note Utilities ───────────────────────────────────────────────────────

  findExistingNote(release: ReleaseData): TFile | null {
    const folder = getNotesFolder(this.settings);
    const safeTitle = release.album.replace(/[\\/:*?"<>|]/g, "").trim();
    const file = this.app.vault.getAbstractFileByPath(`${folder}/${safeTitle}.md`);
    return file instanceof TFile ? file : null;
  }

  async createReleaseNote(release: ReleaseData, condition: string, acquired: string, valuation: string, copies: string, customValues: Record<string, string> = {}): Promise<void> {
    const notesFolder = getNotesFolder(this.settings);
    await this.ensureFolder(this.settings.baseFolder);
    if (this.settings.notesSubfolder.trim()) await this.ensureFolder(notesFolder);
    const safeTitle = release.album.replace(/[\\/:*?"<>|]/g, "").trim();
    await this.app.vault.create(`${notesFolder}/${safeTitle}.md`, this.generateNoteContent(release, condition, acquired, valuation, copies, customValues));
    new Notice(`✅ Release added: ${release.album}`);
  }

  async updateCopies(file: TFile, newCount: number): Promise<void> {
    const content = await this.app.vault.read(file);
    const updated = /^copies:\s*\d+/m.test(content)
      ? content.replace(/^copies:\s*\d+/m, `copies: ${newCount}`)
      : content.replace(/^(---[\s\S]*?)\n---/m, `$1\ncopies: ${newCount}\n---`);
    await this.app.vault.modify(file, updated);
    new Notice(`✅ Copies updated to ${newCount}.`);
  }

  openNote(file: TFile): void { this.app.workspace.getLeaf(false).openFile(file); }

  generateNoteContent(release: ReleaseData, condition: string, acquired: string, valuation: string, copies: string, customValues: Record<string, string> = {}): string {
    const coverLine = release.coverUrl ? `\n<img src="${release.coverUrl}" alt="cover" width="150"/>\n` : "";
    const valuationYaml = valuation ? parseFloat(valuation) || `"${valuation}"` : '""';
    const copiesYaml = copies ? parseInt(copies) || 1 : 1;
    const customLines = this.settings.customFields.map((field) => {
      const raw = customValues[field.id] ?? "";
      const key = toYamlKey(field.name);
      if (field.type === "boolean") return `${key}: ${raw === "true"}`;
      if (field.type === "number") return `${key}: ${parseFloat(raw) || ""}`;
      return `${key}: "${raw.replace(/"/g, '\\"')}"`;
    }).join("\n");
    return `---
album: "${release.album.replace(/"/g, '\\"')}"
artists: ${toYamlInline(release.artists)}
label: "${release.label.replace(/"/g, '\\"')}"
catalogNumber: "${release.catalogNumber.replace(/"/g, '\\"')}"
releaseYear: ${release.releaseYear || '""'}
genre: ${toYamlInline(release.genres)}
format: "${release.format.replace(/"/g, '\\"')}"
upc: "${release.upc}"
cover: "${release.coverUrl}"
condition: "${condition}"
acquired: "${acquired}"
valuation: ${valuationYaml}
copies: ${copiesYaml}${customLines ? "\n" + customLines : ""}
tags: ["record"]
---
${coverLine}
## Notes

`;
  }
}

// ─── Barcode / Search Input Modal ─────────────────────────────────────────────

class BarcodeModal extends Modal {
  plugin: MusicCatalogPlugin;
  constructor(app: App, plugin: MusicCatalogPlugin) { super(app); this.plugin = plugin; }
  onOpen() { this.showScanStep(); }

  showScanStep() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Add Music" });

    const tabBar = contentEl.createDiv();
    tabBar.style.cssText = "display:flex; gap:0.5rem; margin-bottom:1.25rem;";
    const barcodeBtn = tabBar.createEl("button", { text: "📷  Scan / UPC" });
    const searchBtn  = tabBar.createEl("button", { text: "🔍  Search by Title" });
    const activeStyle   = "flex:1; padding:0.4rem; background:var(--interactive-accent); color:var(--text-on-accent); border-radius:4px; font-weight:500; cursor:pointer;";
    const inactiveStyle = "flex:1; padding:0.4rem; background:var(--background-secondary); border-radius:4px; cursor:pointer;";
    const tabContent = contentEl.createDiv();

    const renderBarcodeTab = () => {
      barcodeBtn.style.cssText = activeStyle; searchBtn.style.cssText = inactiveStyle;
      tabContent.empty();
      tabContent.createEl("p", { text: "Scan the UPC barcode with a USB scanner, or type it manually." }).style.cssText = "color:var(--text-muted); font-size:0.9rem; margin:0 0 0.75rem;";
      const inputEl = tabContent.createEl("input", { type: "text", placeholder: "UPC barcode..." });
      inputEl.style.cssText = "width:100%; margin-bottom:0.75rem; font-size:1.1rem; padding:0.5rem;";
      setTimeout(() => inputEl.focus(), 50);
      const statusEl = tabContent.createEl("p", { text: "" });
      statusEl.style.cssText = "color:var(--text-muted); min-height:1.5rem; margin:0 0 0.75rem;";
      const lookupBtn = tabContent.createEl("button", { text: "Look Up Release" });
      lookupBtn.style.cssText = "width:100%; padding:0.5rem;";
      const doLookup = async (upc: string) => {
        if (!upc) { statusEl.setText("Please enter a barcode."); return; }
        lookupBtn.disabled = true; inputEl.disabled = true; statusEl.setText("Looking up release...");
        const release = await this.plugin.lookupUPC(upc);
        if (!release) { statusEl.setText("❌ No release found. Check the barcode and try again."); lookupBtn.disabled = false; inputEl.disabled = false; inputEl.focus(); return; }
        const existing = this.plugin.findExistingNote(release);
        if (existing) { this.showDuplicateStep(release, existing); return; }
        this.showConfirmStep(release);
      };
      inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") doLookup(inputEl.value.trim()); });
      lookupBtn.addEventListener("click", () => doLookup(inputEl.value.trim()));
    };

    const renderSearchTab = () => {
      barcodeBtn.style.cssText = inactiveStyle; searchBtn.style.cssText = activeStyle;
      tabContent.empty();

      tabContent.createEl("p", { text: "Title is required. All other fields are optional." }).style.cssText = "color:var(--text-muted); font-size:0.9rem; margin:0 0 0.75rem;";

      const rowStyle   = "display:flex; align-items:center; gap:0.75rem; margin-bottom:0.5rem;";
      const labelStyle = "min-width:80px; font-weight:500; font-size:0.9rem;";
      const inputStyle = "flex:1; padding:0.35rem;";

      const row = (parent: HTMLElement, lbl: string, placeholder: string): HTMLInputElement => {
        const wrap = parent.createDiv(); wrap.style.cssText = rowStyle;
        wrap.createEl("label", { text: lbl }).style.cssText = labelStyle;
        const el = wrap.createEl("input", { type: "text", placeholder }); el.style.cssText = inputStyle;
        return el;
      };

      const titleEl = row(tabContent, "Title *", "Required");
      setTimeout(() => titleEl.focus(), 50);
      const artistEl     = row(tabContent, "Artist",  "Optional");
      const labelInputEl = row(tabContent, "Label",   "Optional");

      let formatFilter: "" | "cd" | "lp" = "";
      const filterWrap = tabContent.createDiv(); filterWrap.style.cssText = "display:flex; align-items:center; gap:0.75rem; margin-bottom:0.75rem;";
      filterWrap.createEl("span", { text: "Format" }).style.cssText = "min-width:80px; font-weight:500; font-size:0.9rem;";
      const filterBtnGroup = filterWrap.createDiv(); filterBtnGroup.style.cssText = "display:flex; gap:0.3rem;";
      const filterBtnActive   = "padding:0.3rem 0.7rem; border-radius:4px; background:var(--interactive-accent); color:var(--text-on-accent); font-size:0.85rem; cursor:pointer;";
      const filterBtnInactive = "padding:0.3rem 0.7rem; border-radius:4px; background:var(--background-secondary); font-size:0.85rem; cursor:pointer;";
      const anyBtn = filterBtnGroup.createEl("button", { text: "Any" });
      const cdBtn  = filterBtnGroup.createEl("button", { text: "CD Only" });
      const lpBtn  = filterBtnGroup.createEl("button", { text: "LP Only" });
      const updateFilterBtns = () => { anyBtn.style.cssText = formatFilter === "" ? filterBtnActive : filterBtnInactive; cdBtn.style.cssText = formatFilter === "cd" ? filterBtnActive : filterBtnInactive; lpBtn.style.cssText = formatFilter === "lp" ? filterBtnActive : filterBtnInactive; };
      updateFilterBtns();
      anyBtn.addEventListener("click", () => { formatFilter = ""; updateFilterBtns(); });
      cdBtn.addEventListener("click",  () => { formatFilter = "cd"; updateFilterBtns(); });
      lpBtn.addEventListener("click",  () => { formatFilter = "lp"; updateFilterBtns(); });

      const classicalSep = tabContent.createDiv(); classicalSep.style.cssText = "display:flex; align-items:center; gap:0.5rem; margin:0.25rem 0 0.5rem;";
      classicalSep.createEl("hr").style.cssText = "flex:1; border:none; border-top:1px solid var(--background-modifier-border);";
      classicalSep.createEl("span", { text: "Classical / Opera / Soundtrack" }).style.cssText = "font-size:0.78rem; color:var(--text-muted); white-space:nowrap;";
      classicalSep.createEl("hr").style.cssText = "flex:1; border:none; border-top:1px solid var(--background-modifier-border);";

      const composerEl  = row(tabContent, "Composer",  "Optional");
      const conductorEl = row(tabContent, "Conductor", "Optional");
      tabContent.createEl("p", { text: "Composer and conductor are each searched separately and results are merged." }).style.cssText = "color:var(--text-muted); font-size:0.78rem; margin:0.25rem 0 0.75rem;";

      const statusEl = tabContent.createEl("p", { text: "" }); statusEl.style.cssText = "min-height:1.2rem; margin:0 0 0.5rem; font-size:0.85rem;";
      const searchActionBtn = tabContent.createEl("button", { text: "Search Releases" }); searchActionBtn.style.cssText = "width:100%; padding:0.5rem; margin-bottom:0.75rem;";
      const resultsEl = tabContent.createDiv();

      const renderResults = (releases: ReleaseData[]) => {
        resultsEl.empty();
        if (releases.length === 0) { resultsEl.createEl("p", { text: "No results found. Try different search terms." }).style.cssText = "color:var(--text-muted); font-size:0.9rem;"; return; }
        resultsEl.createEl("p", { text: `${releases.length} result${releases.length !== 1 ? "s" : ""} — click to select` }).style.cssText = "font-size:0.8rem; color:var(--text-muted); margin-bottom:0.5rem;";
        releases.forEach((release) => {
          const card = resultsEl.createDiv(); card.style.cssText = "display:flex; gap:0.65rem; padding:0.6rem; border-radius:6px; border:1px solid var(--background-modifier-border); margin-bottom:0.4rem; cursor:pointer; align-items:flex-start;";
          if (release.coverUrl) { const img = card.createEl("img"); img.src = release.coverUrl; img.alt = "cover"; img.style.cssText = "width:40px; height:auto; border-radius:3px; flex-shrink:0;"; }
          else { const ph = card.createDiv(); ph.style.cssText = "width:40px; height:40px; background:var(--background-secondary); border-radius:3px; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:1.2rem;"; ph.createEl("span", { text: "💿" }); }
          const info = card.createDiv(); info.style.cssText = "flex:1; min-width:0;";
          info.createEl("div", { text: release.album }).style.cssText = "font-weight:600; font-size:0.9rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
          if (release.artists.length > 0) info.createEl("div", { text: release.artists.join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.82rem;";
          const meta = [release.label, release.releaseYear, release.format].filter(Boolean).join("  ·  ");
          if (meta) info.createEl("div", { text: meta }).style.cssText = "color:var(--text-muted); font-size:0.82rem;";
          if (release.genres.length > 0) info.createEl("div", { text: release.genres.join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.78rem;";
          card.addEventListener("mouseenter", () => { card.style.background = "var(--background-secondary)"; });
          card.addEventListener("mouseleave", () => { card.style.background = ""; });
          card.addEventListener("click", () => {
            const existing = this.plugin.findExistingNote(release);
            if (existing) { this.showDuplicateStep(release, existing); return; }
            this.showConfirmStep(release);
          });
        });
      };

      const doSearch = async () => {
        const title = titleEl.value.trim();
        if (!title) { statusEl.setText("Please enter a title."); statusEl.style.color = "var(--color-red)"; titleEl.focus(); return; }
        statusEl.style.color = "var(--text-muted)"; searchActionBtn.disabled = true; searchActionBtn.setText("Searching…");
        const hasClassical = composerEl.value.trim() || conductorEl.value.trim();
        statusEl.setText(hasClassical ? "Running separate queries for composer/conductor — this may take a few seconds…" : "Searching…");
        resultsEl.empty();
        const releases = await this.plugin.searchReleases({ title, artist: artistEl.value.trim(), label: labelInputEl.value.trim(), composer: composerEl.value.trim(), conductor: conductorEl.value.trim(), formatFilter });
        statusEl.setText(""); searchActionBtn.disabled = false; searchActionBtn.setText("Search Releases");
        renderResults(releases);
      };

      const onEnter = (e: KeyboardEvent) => { if (e.key === "Enter") doSearch(); };
      [titleEl, artistEl, labelInputEl, composerEl, conductorEl].forEach((el) => el.addEventListener("keydown", onEnter));
      searchActionBtn.addEventListener("click", doSearch);
    };

    barcodeBtn.addEventListener("click", renderBarcodeTab);
    searchBtn.addEventListener("click", renderSearchTab);
    renderBarcodeTab();
  }

  showDuplicateStep(release: ReleaseData, existing: TFile) {
    const { contentEl } = this; contentEl.empty();
    const headerEl = contentEl.createDiv(); headerEl.style.cssText = "display:flex; align-items:center; gap:0.5rem; margin-bottom:1rem;";
    headerEl.createEl("span", { text: "📀" }).style.fontSize = "1.5rem";
    headerEl.createEl("h2", { text: "Already in your catalog" }).style.margin = "0";
    const previewEl = contentEl.createDiv(); previewEl.style.cssText = "display:flex; gap:1rem; margin-bottom:1.25rem; align-items:flex-start;";
    if (release.coverUrl) { const imgEl = previewEl.createEl("img"); imgEl.src = release.coverUrl; imgEl.alt = "cover"; imgEl.style.cssText = "width:80px; height:auto; border-radius:4px; flex-shrink:0;"; }
    const metaEl = previewEl.createDiv(); metaEl.style.cssText = "display:flex; flex-direction:column; gap:0.2rem;";
    metaEl.createEl("strong", { text: release.album });
    if (release.artists.length > 0) metaEl.createEl("span", { text: release.artists.join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";
    if (release.label || release.releaseYear) metaEl.createEl("span", { text: [release.label, release.releaseYear].filter(Boolean).join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";
    if (release.format) metaEl.createEl("span", { text: release.format }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";
    const cache = this.plugin.app.metadataCache.getFileCache(existing);
    const currentCopies: number = cache?.frontmatter?.copies ?? 1;
    const copiesInfoEl = contentEl.createDiv(); copiesInfoEl.style.cssText = "background:var(--background-secondary); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:1.25rem; font-size:0.9rem;";
    copiesInfoEl.createEl("span", { text: "Currently in catalog: " });
    copiesInfoEl.createEl("strong", { text: `${currentCopies} cop${currentCopies === 1 ? "y" : "ies"}` });
    contentEl.createEl("hr").style.marginBottom = "1rem";
    const copiesWrap = contentEl.createDiv(); copiesWrap.style.cssText = "display:flex; align-items:center; gap:0.75rem; margin-bottom:1.25rem;";
    copiesWrap.createEl("label", { text: "Update copies to" }).style.cssText = "min-width:120px; font-weight:500; font-size:0.9rem;";
    const copiesEl = copiesWrap.createEl("input", { type: "number" }); copiesEl.value = String(currentCopies + 1); copiesEl.min = "1"; copiesEl.step = "1"; copiesEl.style.cssText = "flex:1; padding:0.35rem;";
    const btnCol = contentEl.createDiv(); btnCol.style.cssText = "display:flex; flex-direction:column; gap:0.6rem;";
    const updateBtn = btnCol.createEl("button", { text: "✅  Update Copies" }); updateBtn.style.cssText = "width:100%; padding:0.5rem; background:var(--interactive-accent); color:var(--text-on-accent); border-radius:4px;";
    const openBtn = btnCol.createEl("button", { text: "📀  Open Existing Note" }); openBtn.style.cssText = "width:100%; padding:0.5rem;";
    const scanBtn = btnCol.createEl("button", { text: "↩  Search Again" }); scanBtn.style.cssText = "width:100%; padding:0.5rem;";
    updateBtn.addEventListener("click", async () => { const newCount = parseInt(copiesEl.value) || currentCopies + 1; updateBtn.disabled = true; updateBtn.setText("Saving..."); await this.plugin.updateCopies(existing, newCount); this.close(); });
    openBtn.addEventListener("click", () => { this.plugin.openNote(existing); this.close(); });
    scanBtn.addEventListener("click", () => this.showScanStep());
  }

  showConfirmStep(release: ReleaseData) {
    const { contentEl } = this; contentEl.empty();

    const previewEl = contentEl.createDiv(); previewEl.style.cssText = "display:flex; gap:1rem; margin-bottom:1.25rem; align-items:flex-start;";
    if (release.coverUrl) { const imgEl = previewEl.createEl("img"); imgEl.src = release.coverUrl; imgEl.alt = "cover"; imgEl.style.cssText = "width:80px; height:auto; border-radius:4px; flex-shrink:0;"; }
    const metaEl = previewEl.createDiv(); metaEl.style.cssText = "display:flex; flex-direction:column; gap:0.2rem;";
    metaEl.createEl("strong", { text: release.album });
    if (release.artists.length > 0) metaEl.createEl("span", { text: release.artists.join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";
    if (release.label || release.releaseYear) metaEl.createEl("span", { text: [release.label, release.releaseYear].filter(Boolean).join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";
    if (release.format) metaEl.createEl("span", { text: release.format }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";
    if (release.genres.length > 0) metaEl.createEl("span", { text: release.genres.join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";

    contentEl.createEl("hr").style.marginBottom = "1rem";

    const rowStyle   = "display:flex; align-items:center; gap:0.75rem; margin-bottom:0.75rem;";
    const labelStyle = "min-width:80px; font-weight:500;";

    // ── Standard fields ───────────────────────────────────────────────────
    const conditionWrap = contentEl.createDiv(); conditionWrap.style.cssText = rowStyle;
    conditionWrap.createEl("label", { text: "Condition" }).style.cssText = labelStyle;
    const conditionEl = conditionWrap.createEl("select"); conditionEl.style.cssText = "flex:1; padding:0.35rem;";
    ["", "Mint (M)", "Near Mint (NM)", "Very Good Plus (VG+)", "Very Good (VG)", "Good Plus (G+)", "Good (G)", "Fair (F)", "Poor (P)"].forEach((c) => { const opt = conditionEl.createEl("option", { text: c || "— select —" }); opt.value = c; });

    const acquiredWrap = contentEl.createDiv(); acquiredWrap.style.cssText = rowStyle;
    acquiredWrap.createEl("label", { text: "Acquired" }).style.cssText = labelStyle;
    const acquiredEl = acquiredWrap.createEl("input", { type: "date" }); acquiredEl.style.cssText = "flex:1; padding:0.35rem;"; acquiredEl.value = new Date().toISOString().split("T")[0];

    const copiesWrap = contentEl.createDiv(); copiesWrap.style.cssText = rowStyle;
    copiesWrap.createEl("label", { text: "Copies" }).style.cssText = labelStyle;
    const copiesEl = copiesWrap.createEl("input", { type: "number" }); copiesEl.value = "1"; copiesEl.min = "1"; copiesEl.step = "1"; copiesEl.style.cssText = "flex:1; padding:0.35rem;";

    const valuationWrap = contentEl.createDiv(); valuationWrap.style.cssText = rowStyle;
    valuationWrap.createEl("label", { text: "Value (USD)" }).style.cssText = labelStyle;
    const valuationPrefix = valuationWrap.createDiv(); valuationPrefix.style.cssText = "display:flex; align-items:center; flex:1; border:1px solid var(--background-modifier-border); border-radius:4px; overflow:hidden;";
    valuationPrefix.createEl("span", { text: "$" }).style.cssText = "padding:0.35rem 0.5rem; background:var(--background-secondary); color:var(--text-muted); font-weight:500; border-right:1px solid var(--background-modifier-border);";
    const valuationEl = valuationPrefix.createEl("input", { type: "number" }); valuationEl.placeholder = "0.00"; valuationEl.min = "0"; valuationEl.step = "0.01"; valuationEl.style.cssText = "flex:1; padding:0.35rem 0.5rem; border:none; background:transparent; outline:none;";

    // ── Custom fields ─────────────────────────────────────────────────────
    const customGetters: Record<string, () => string> = {};
    if (this.plugin.settings.customFields.length > 0) {
      contentEl.createEl("hr").style.cssText = "margin:0.75rem 0;";
      this.plugin.settings.customFields.forEach((field) => {
        const wrap = contentEl.createDiv(); wrap.style.cssText = rowStyle;
        wrap.createEl("label", { text: field.name }).style.cssText = labelStyle + " font-size:0.9rem;";
        if (field.type === "boolean") {
          const toggleOuter = wrap.createDiv(); toggleOuter.style.cssText = "position:relative; width:40px; height:22px; flex-shrink:0;";
          const toggleInput = toggleOuter.createEl("input", { type: "checkbox" }); toggleInput.style.cssText = "opacity:0; width:0; height:0; position:absolute;";
          const slider = toggleOuter.createDiv(); slider.style.cssText = "position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:var(--background-modifier-border); border-radius:22px; transition:background 0.2s;";
          const knob = slider.createDiv(); knob.style.cssText = "position:absolute; height:16px; width:16px; left:3px; bottom:3px; background:white; border-radius:50%; transition:transform 0.2s;";
          const sync = () => { slider.style.background = toggleInput.checked ? "var(--interactive-accent)" : "var(--background-modifier-border)"; knob.style.transform = toggleInput.checked ? "translateX(18px)" : "translateX(0)"; };
          toggleInput.addEventListener("change", sync);
          slider.addEventListener("click", () => { toggleInput.checked = !toggleInput.checked; sync(); });
          customGetters[field.id] = () => toggleInput.checked ? "true" : "false";
        } else if (field.type === "date") {
          const el = wrap.createEl("input", { type: "date" }); el.style.cssText = "flex:1; padding:0.35rem;";
          customGetters[field.id] = () => el.value;
        } else if (field.type === "number") {
          const el = wrap.createEl("input", { type: "number" }); el.style.cssText = "flex:1; padding:0.35rem;"; el.step = "any";
          customGetters[field.id] = () => el.value;
        } else {
          const el = wrap.createEl("input", { type: "text" }); el.style.cssText = "flex:1; padding:0.35rem;";
          customGetters[field.id] = () => el.value;
        }
      });
    }

    // ── Buttons ───────────────────────────────────────────────────────────
    const saveFirst = this.plugin.settings.saveAndAddFirst;
    const accentStyle  = "background:var(--interactive-accent); color:var(--text-on-accent); padding:0.4rem 1rem; border-radius:4px;";
    const normalStyle  = "padding:0.4rem 1rem;";

    const btnRow = contentEl.createDiv(); btnRow.style.cssText = "display:flex; gap:0.75rem; justify-content:flex-end; margin-top:1.25rem;";
    const backBtn        = btnRow.createEl("button", { text: "← Back" }); backBtn.style.cssText = normalStyle;
    const saveAnotherBtn = btnRow.createEl("button", { text: "Save & Add Another" }); saveAnotherBtn.style.cssText = saveFirst ? accentStyle : normalStyle;
    const saveBtn        = btnRow.createEl("button", { text: "Save Release" }); saveBtn.style.cssText = saveFirst ? normalStyle : accentStyle;

    const collectCustomValues = (): Record<string, string> => {
      const vals: Record<string, string> = {};
      for (const id in customGetters) vals[id] = customGetters[id]();
      return vals;
    };

    backBtn.addEventListener("click", () => this.showScanStep());
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true; saveBtn.setText("Saving...");
      await this.plugin.createReleaseNote(release, conditionEl.value, acquiredEl.value, valuationEl.value, copiesEl.value, collectCustomValues());
      this.close();
    });
    saveAnotherBtn.addEventListener("click", async () => {
      saveAnotherBtn.disabled = true; saveAnotherBtn.setText("Saving...");
      await this.plugin.createReleaseNote(release, conditionEl.value, acquiredEl.value, valuationEl.value, copiesEl.value, collectCustomValues());
      this.showScanStep();
    });
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Reorganize Modal ─────────────────────────────────────────────────────────

class ReorganizeModal extends Modal {
  plugin: MusicCatalogPlugin;
  constructor(app: App, plugin: MusicCatalogPlugin) { super(app); this.plugin = plugin; }
  onOpen() { this.showScanStep(); }

  showScanStep() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl("h2", { text: "Reorganize Catalog Files" });
    contentEl.createEl("p", { text: "Scan your vault to find all release notes regardless of where they currently live." }).style.cssText = "color:var(--text-muted); font-size:0.9rem; margin-bottom:1.25rem;";
    const targetEl = contentEl.createDiv(); targetEl.style.cssText = "background:var(--background-secondary); border-radius:6px; padding:0.75rem 1rem; margin-bottom:1.25rem; font-size:0.85rem;";
    targetEl.createEl("p", { text: "Target location (from your settings):" }).style.cssText = "font-weight:600; margin:0 0 0.4rem;";
    targetEl.createEl("p", { text: `📄 ${getBasePath(this.plugin.settings.baseFolder)}` }).style.cssText = "margin:0 0 0.2rem; color:var(--text-muted);";
    targetEl.createEl("p", { text: `📀 ${getNotesFolder(this.plugin.settings)}/` }).style.cssText = "margin:0; color:var(--text-muted);";
    const resultsEl = contentEl.createDiv(); resultsEl.style.cssText = "min-height:2rem; margin-bottom:1rem;";
    const btnRow = contentEl.createDiv(); btnRow.style.cssText = "display:flex; gap:0.75rem;";
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" }); cancelBtn.style.cssText = "flex:1; padding:0.5rem;";
    const scanBtn = btnRow.createEl("button", { text: "🔍  Scan Vault" }); scanBtn.style.cssText = "flex:1; padding:0.5rem; background:var(--interactive-accent); color:var(--text-on-accent); border-radius:4px;";
    cancelBtn.addEventListener("click", () => this.close());
    scanBtn.addEventListener("click", () => {
      scanBtn.disabled = true; scanBtn.setText("Scanning..."); resultsEl.empty();
      const releaseNotes = this.plugin.scanVaultForReleaseNotes();
      const newNotesFolder = getNotesFolder(this.plugin.settings);
      const notesToMove = releaseNotes.filter((f) => f.path !== `${newNotesFolder}/${f.name}`);
      const existingBase = this.plugin.findExistingBaseFile();
      const newBasePath = getBasePath(this.plugin.settings.baseFolder);
      const baseNeedsMove = !!(existingBase && existingBase.path !== newBasePath);
      const resultBox = resultsEl.createDiv(); resultBox.style.cssText = "background:var(--background-secondary); border-radius:6px; padding:0.75rem 1rem; font-size:0.85rem;";
      resultBox.createEl("p", { text: `✅ Scan complete — found ${releaseNotes.length} release note${releaseNotes.length !== 1 ? "s" : ""} in your vault.` }).style.cssText = "font-weight:600; margin:0 0 0.5rem;";
      if (releaseNotes.length === 0) { resultBox.createEl("p", { text: 'No release notes found. Make sure notes have tags: ["record"] in their frontmatter.' }).style.cssText = "color:var(--text-muted); margin:0;"; scanBtn.disabled = false; scanBtn.setText("🔍  Scan Vault"); return; }
      const byFolder = new Map<string, TFile[]>();
      for (const f of releaseNotes) { const folder = f.parent?.path ?? "(root)"; if (!byFolder.has(folder)) byFolder.set(folder, []); byFolder.get(folder)!.push(f); }
      byFolder.forEach((files, folder) => {
        const alreadyInPlace = folder === newNotesFolder;
        const folderEl = resultBox.createDiv(); folderEl.style.cssText = "margin-bottom:0.3rem;";
        folderEl.createEl("span", { text: `📁 ${folder}/ — ${files.length} note${files.length !== 1 ? "s" : ""}` }).style.cssText = alreadyInPlace ? "color:var(--color-green); font-weight:500;" : "color:var(--text-muted);";
        if (alreadyInPlace) folderEl.createEl("span", { text: " ✓ already in target" }).style.cssText = "color:var(--color-green); font-size:0.8rem;";
      });
      if (existingBase) resultBox.createEl("p", { text: `📄 Music Catalog.base: ${existingBase.path}` }).style.cssText = "margin:0.5rem 0 0; color:var(--text-muted);";
      if (notesToMove.length === 0 && !baseNeedsMove) { resultBox.createEl("p", { text: "✅ Everything is already in the correct location." }).style.cssText = "margin:0.75rem 0 0; font-weight:600; color:var(--color-green);"; scanBtn.disabled = false; scanBtn.setText("🔍  Scan Again"); return; }
      const proceedRow = resultsEl.createDiv(); proceedRow.style.cssText = "display:flex; justify-content:flex-end; margin-top:0.75rem;";
      const proceedBtn = proceedRow.createEl("button", { text: `Review ${notesToMove.length} move${notesToMove.length !== 1 ? "s" : ""} →` });
      proceedBtn.style.cssText = "padding:0.4rem 1rem; background:var(--interactive-accent); color:var(--text-on-accent); border-radius:4px;";
      proceedBtn.addEventListener("click", () => this.showConfirmStep(releaseNotes, notesToMove, existingBase, baseNeedsMove));
      scanBtn.disabled = false; scanBtn.setText("🔍  Scan Again");
    });
  }

  showConfirmStep(allNotes: TFile[], notesToMove: TFile[], existingBase: TFile | null, baseNeedsMove: boolean) {
    const { contentEl } = this; contentEl.empty();
    const s = this.plugin.settings; const newNotesFolder = getNotesFolder(s); const newBasePath = getBasePath(s.baseFolder);
    contentEl.createEl("h2", { text: "Confirm Reorganization" });
    contentEl.createEl("p", { text: "Review the changes below before confirming." }).style.cssText = "color:var(--text-muted); font-size:0.9rem; margin-bottom:1rem;";
    const treeStyle = "background:var(--background-secondary); border-radius:6px; padding:0.75rem 1rem; font-family:monospace; font-size:0.82rem; margin-bottom:0.75rem; line-height:1.8;";
    if (notesToMove.length > 0) {
      contentEl.createEl("p", { text: "Release notes to move:" }).style.cssText = "font-weight:600; margin-bottom:0.25rem;";
      const notesBox = contentEl.createDiv(); notesBox.style.cssText = treeStyle;
      const byFolder = new Map<string, TFile[]>();
      for (const f of notesToMove) { const folder = f.parent?.path ?? "(root)"; if (!byFolder.has(folder)) byFolder.set(folder, []); byFolder.get(folder)!.push(f); }
      byFolder.forEach((files, folder) => {
        notesBox.createEl("div", { text: `📁 ${folder}/` });
        const indent = notesBox.createDiv(); indent.style.cssText = "padding-left:1.2rem;";
        files.slice(0, 4).forEach((f) => indent.createEl("div", { text: `📀 ${f.name}` }).style.cssText = "color:var(--text-muted);");
        if (files.length > 4) indent.createEl("div", { text: `… and ${files.length - 4} more` }).style.cssText = "color:var(--text-muted);";
        notesBox.createEl("div", { text: `↳ → ${newNotesFolder}/` }).style.cssText = "padding-left:1.2rem; color:var(--color-green);";
      });
    }
    if (baseNeedsMove && existingBase) {
      contentEl.createEl("p", { text: "Base file to move:" }).style.cssText = "font-weight:600; margin-bottom:0.25rem;";
      const baseBox = contentEl.createDiv(); baseBox.style.cssText = treeStyle;
      baseBox.createEl("div", { text: `📄 ${existingBase.path}` }).style.cssText = "color:var(--text-muted);";
      baseBox.createEl("div", { text: `↳ → ${newBasePath}` }).style.cssText = "color:var(--color-green);";
    }
    const summaryEl = contentEl.createDiv(); summaryEl.style.cssText = "background:var(--background-modifier-border); border-radius:6px; padding:0.6rem 0.9rem; margin-bottom:1.25rem; font-size:0.85rem;";
    summaryEl.createEl("p", { text: `📀 ${notesToMove.length} note${notesToMove.length !== 1 ? "s" : ""} → ${newNotesFolder}/` }).style.cssText = "margin:0 0 0.2rem;";
    if (baseNeedsMove) summaryEl.createEl("p", { text: `📄 Base → ${newBasePath}` }).style.cssText = "margin:0 0 0.2rem;";
    summaryEl.createEl("p", { text: "📄 Music Catalog.base will be regenerated with updated paths." }).style.cssText = "margin:0;";
    const btnRow = contentEl.createDiv(); btnRow.style.cssText = "display:flex; gap:0.75rem; justify-content:flex-end;";
    const backBtn = btnRow.createEl("button", { text: "← Back" }); backBtn.style.cssText = "padding:0.4rem 1rem;";
    const confirmBtn = btnRow.createEl("button", { text: "Confirm & Move Files" }); confirmBtn.style.cssText = "background:var(--interactive-accent); color:var(--text-on-accent); padding:0.4rem 1rem; border-radius:4px;";
    backBtn.addEventListener("click", () => this.showScanStep());
    confirmBtn.addEventListener("click", async () => { confirmBtn.disabled = true; confirmBtn.setText("Moving files..."); await this.plugin.reorganizeFiles(allNotes); this.close(); });
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class MusicCatalogSettingTab extends PluginSettingTab {
  plugin: MusicCatalogPlugin;
  constructor(app: App, plugin: MusicCatalogPlugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("h2", { text: "Music Catalog Settings" });

    // ── File Organization ─────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "File Organization" });
    containerEl.createEl("p", { text: "Set where the catalog base file and release notes should live in your vault. After changing these paths, use the Reorganize Files section below to move existing files." }).style.cssText = "color:var(--text-muted); font-size:0.85rem; margin-bottom:0.75rem;";
    new Setting(containerEl).setName("Catalog folder").setDesc("The top-level folder where Music Catalog.base will be created. Accepts nested paths, e.g. '03 Resources/Music'.").addText((text) => text.setPlaceholder("Music").setValue(this.plugin.settings.baseFolder).onChange(async (value) => { this.plugin.settings.baseFolder = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Notes subfolder").setDesc("A subfolder inside the catalog folder where individual release notes are stored. Default is 'Notes'. Leave blank to store notes directly in the catalog folder.").addText((text) => text.setPlaceholder("Notes").setValue(this.plugin.settings.notesSubfolder).onChange(async (value) => { this.plugin.settings.notesSubfolder = value.trim(); await this.plugin.saveSettings(); }));
    const previewEl = containerEl.createDiv(); previewEl.style.cssText = "background:var(--background-secondary); border-radius:6px; padding:0.75rem 1rem; margin-bottom:1rem; font-size:0.85rem;";
    const updatePreview = () => { previewEl.empty(); previewEl.createEl("p", { text: "Current target paths:" }).style.cssText = "font-weight:600; margin:0 0 0.4rem;"; previewEl.createEl("p", { text: `📄 Base file: ${getBasePath(this.plugin.settings.baseFolder)}` }).style.cssText = "margin:0 0 0.25rem; color:var(--text-muted);"; previewEl.createEl("p", { text: `📀 Release notes: ${getNotesFolder(this.plugin.settings)}/` }).style.cssText = "margin:0; color:var(--text-muted);"; };
    updatePreview();
    const origSave = this.plugin.saveSettings.bind(this.plugin);
    this.plugin.saveSettings = async () => { await origSave(); updatePreview(); };
    new Setting(containerEl).setName("Create or update base file").setDesc("Creates Music Catalog.base at the path shown above with the correct filters, views, and column layout.").addButton((btn) => btn.setButtonText("Create Base File").setCta().onClick(async () => { await this.plugin.createBaseFile(); }));

    containerEl.createEl("hr").style.margin = "1.5rem 0";

    // ── Reorganize ────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Reorganize Files" });
    containerEl.createEl("p", { text: "Use this after changing your folder settings to move existing release notes and the base file. Scans your entire vault first so manually-moved files are always found." }).style.cssText = "color:var(--text-muted); font-size:0.85rem; margin-bottom:0.75rem;";
    new Setting(containerEl).setName("Scan & reorganize vault").setDesc("Opens a two-step dialog: scans for all release notes, shows what was found, then lets you confirm before moving anything.").addButton((btn) => btn.setButtonText("Scan Vault & Reorganize").setWarning().onClick(() => { new ReorganizeModal(this.app, this.plugin).open(); }));

    containerEl.createEl("hr").style.margin = "1.5rem 0";

    // ── Modal Preferences ─────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Modal Preferences" });
    new Setting(containerEl)
      .setName("Default to Save & Add Another")
      .setDesc("When on, 'Save & Add Another' is the primary (highlighted) button in the confirm step. Turn off to make 'Save Release' the primary button instead.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.saveAndAddFirst).onChange(async (value) => { this.plugin.settings.saveAndAddFirst = value; await this.plugin.saveSettings(); }));

    containerEl.createEl("hr").style.margin = "1.5rem 0";

    // ── Custom Fields ─────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Custom Fields" });
    containerEl.createEl("p", { text: "Add your own fields to the capture modal. Each field is saved to the note's frontmatter using the field name as the YAML key." }).style.cssText = "color:var(--text-muted); font-size:0.85rem; margin-bottom:0.75rem;";

    const fieldListEl = containerEl.createDiv(); fieldListEl.style.cssText = "margin-bottom:1rem;";
    const renderFieldList = () => {
      fieldListEl.empty();
      if (this.plugin.settings.customFields.length === 0) {
        fieldListEl.createEl("p", { text: "No custom fields yet." }).style.cssText = "color:var(--text-muted); font-size:0.85rem; font-style:italic;";
        return;
      }
      const typeBadgeStyle = "font-size:0.75rem; padding:0.1rem 0.4rem; border-radius:3px; background:var(--background-modifier-border); color:var(--text-muted); margin-left:0.5rem;";
      this.plugin.settings.customFields.forEach((field, index) => {
        const row = fieldListEl.createDiv(); row.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:0.4rem 0.6rem; border-radius:4px; margin-bottom:0.3rem; background:var(--background-secondary);";
        const nameEl = row.createDiv(); nameEl.style.cssText = "display:flex; align-items:center;";
        nameEl.createEl("span", { text: field.name }).style.cssText = "font-size:0.9rem;";
        nameEl.createEl("span", { text: field.type }).style.cssText = typeBadgeStyle;
        const deleteBtn = row.createEl("button", { text: "✕" }); deleteBtn.style.cssText = "padding:0.1rem 0.5rem; font-size:0.8rem; color:var(--text-muted);";
        deleteBtn.addEventListener("click", async () => {
          this.plugin.settings.customFields.splice(index, 1);
          await this.plugin.saveSettings();
          renderFieldList();
        });
      });
    };
    renderFieldList();

    const addRow = containerEl.createDiv(); addRow.style.cssText = "display:flex; gap:0.5rem; align-items:center;";
    const nameInput = addRow.createEl("input", { type: "text", placeholder: "Field name" }); nameInput.style.cssText = "flex:1; padding:0.35rem;";
    const typeSelect = addRow.createEl("select"); typeSelect.style.cssText = "padding:0.35rem;";
    (["text", "number", "date", "boolean"] as const).forEach((t) => { const opt = typeSelect.createEl("option", { text: t }); opt.value = t; });
    const addBtn = addRow.createEl("button", { text: "Add Field" }); addBtn.style.cssText = "padding:0.35rem 0.75rem; background:var(--interactive-accent); color:var(--text-on-accent); border-radius:4px;";
    addBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const key = toYamlKey(name);
      if (this.plugin.settings.customFields.some((f) => toYamlKey(f.name) === key)) { new Notice("A field with that name already exists."); return; }
      this.plugin.settings.customFields.push({ id: `cf-${Date.now()}`, name, type: typeSelect.value as CustomField["type"] });
      await this.plugin.saveSettings();
      nameInput.value = "";
      renderFieldList();
    });
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });

    containerEl.createEl("hr").style.margin = "1.5rem 0";

    // ── API ───────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "API" });
    containerEl.createEl("p", { text: "MusicBrainz is always available with no setup required. Discogs provides richer data — pressing details, catalog numbers, and cover art — and is used as the primary source when a token is provided." }).style.cssText = "color:var(--text-muted); font-size:0.85rem; margin-bottom:0.75rem;";
    new Setting(containerEl).setName("Discogs personal access token").setDesc("To generate one: log into Discogs → click your username → Settings → Developers → Generate new token. Do not use your Consumer Key or Consumer Secret — those are for OAuth and will not work.").addText((text) => text.setPlaceholder("Paste your Discogs personal access token here").setValue(this.plugin.settings.discogsToken).onChange(async (value) => { this.plugin.settings.discogsToken = value.trim(); await this.plugin.saveSettings(); }));
  }
}
