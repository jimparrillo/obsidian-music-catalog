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

// ─── Discogs API types ────────────────────────────────────────────────────────

interface DiscogsResult {
  id: number;
  title?: string;
  artist?: string;
  label?: string | string[];
  catno?: string;
  year?: number;
  genre?: string[];
  style?: string[];
  format?: string | string[];
  cover_image?: string;
  thumb?: string;
}

interface DiscogsSearchResponse {
  results?: DiscogsResult[];
}

// ─── MusicBrainz API types ────────────────────────────────────────────────────

interface MBArtistCredit {
  artist?: { name: string };
}

interface MBLabelInfo {
  label?: { name: string };
  "catalog-number"?: string;
}

interface MBMedia {
  format?: string;
}

interface MBGenre {
  name: string;
}

interface MBRelease {
  id: string;
  title?: string;
  date?: string;
  "artist-credit"?: MBArtistCredit[];
  "label-info"?: MBLabelInfo[];
  media?: MBMedia[];
  genres?: MBGenre[];
}

interface MBSearchResponse {
  releases?: MBRelease[];
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
        void this.app.workspace.getLeaf(false).openFile(baseFile);
      } else {
        new Notice("Music Catalog.base not found. Create it in Settings → Music Catalog.");
      }
    });

    this.addRibbonIcon("disc", "Add music", () => new BarcodeModal(this.app, this).open());

    this.addCommand({
      id: "add-music",
      name: "Add music",
      callback: () => new BarcodeModal(this.app, this).open(),
    });

    this.addCommand({
      id: "open-catalog",
      name: "Open catalog",
      callback: () => {
        const baseFile = this.findExistingBaseFile();
        if (baseFile) void this.app.workspace.getLeaf(false).openFile(baseFile);
        else new Notice("Music Catalog.base not found. Create it in Settings → Music Catalog.");
      },
    });

    this.addSettingTab(new MusicCatalogSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.customFields) this.settings.customFields = [];
  }

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
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      new Notice("✅ Music Catalog.base updated.");
    } else {
      await this.app.vault.create(basePath, content);
      new Notice("✅ Music Catalog.base created.");
    }
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
    await this.createBaseFile();
    await this.saveSettings();
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
    const data = response.json as DiscogsSearchResponse;
    if (!data.results?.length) return null;
    return this.parseDiscogsResult(data.results[0], upc);
  }

  async fetchMusicBrainz(upc: string): Promise<ReleaseData | null> {
    const url = `https://musicbrainz.org/ws/2/release?query=barcode:${upc}&fmt=json&inc=artist-credits+labels+genres+media`;
    const response = await requestUrl({ url, headers: { "User-Agent": "ObsidianMusicCatalog/0.1 (obsidian-plugin)" } });
    const data = response.json as MBSearchResponse;
    if (!data.releases?.length) return null;
    return this.parseMBRelease(data.releases[0], upc);
  }

  // ─── Manual Search ────────────────────────────────────────────────────────

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
    const dedupeKey = (r: ReleaseData) => `${r.album.toLowerCase().trim()}|${(r.artists[0] ?? "").toLowerCase().trim()}|${r.releaseYear}`;
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
      const data = response.json as DiscogsSearchResponse;
      for (const result of (data.results ?? [])) {
        const id = String(result.id);
        if (seen.has(id)) continue;
        seen.add(id);
        results.push(this.parseDiscogsResult(result, ""));
      }
    };
    if (artistTerms.length > 0) {
      for (const term of artistTerms) { try { await runQuery(term); } catch (e) { console.warn(`Discogs search for "${term}" failed:`, e); } }
    } else {
      try { await runQuery(""); } catch (e) { console.warn("Discogs title search failed:", e); }
    }
    return results;
  }

  async searchMusicBrainz(title: string, artist: string, composer: string, conductor: string, formatFilter: "" | "cd" | "lp"): Promise<ReleaseData[]> {
    const escapedTitle = title.replace(/"/g, '\\"');
    const baseQuery = `release:"${escapedTitle}"`;
    const artistTerms = [artist, composer, conductor].filter(Boolean);
    const queries: string[] = artistTerms.length > 0
      ? artistTerms.map((t) => `${baseQuery} AND artist:"${t.replace(/"/g, '\\"')}"`)
      : [baseQuery];
    const seen = new Set<string>();
    const results: ReleaseData[] = [];
    for (let i = 0; i < queries.length; i++) {
      if (i > 0) await sleep(1100);
      try {
        const url = `https://musicbrainz.org/ws/2/release?query=${encodeURIComponent(queries[i])}&fmt=json&limit=20&inc=artist-credits+labels+genres+media`;
        const response = await requestUrl({ url, headers: { "User-Agent": "ObsidianMusicCatalog/0.1 (obsidian-plugin)" } });
        const data = response.json as MBSearchResponse;
        for (const r of (data.releases ?? [])) {
          if (seen.has(r.id)) continue;
          const release = this.parseMBRelease(r, "");
          if (!matchesFormatFilter(release.format, formatFilter)) continue;
          seen.add(r.id);
          results.push(release);
        }
      } catch (e) { console.warn(`MusicBrainz query "${queries[i]}" failed:`, e); }
    }
    return results;
  }

  // ─── Parsers ──────────────────────────────────────────────────────────────

  parseDiscogsResult(result: DiscogsResult, upc: string): ReleaseData {
    let album = result.title ?? "Unknown Album";
    let artistFromTitle = "";
    if (album.includes(" - ")) {
      const parts = album.split(" - ");
      artistFromTitle = parts[0].trim();
      album = parts.slice(1).join(" - ").trim();
    }
    const artists = result.artist ? [result.artist] : artistFromTitle ? [artistFromTitle] : [];
    const label = Array.isArray(result.label) ? result.label[0] : result.label ?? "";
    const format = Array.isArray(result.format) ? result.format[0] : result.format ?? "";
    return {
      upc,
      album: toTitleCase(album),
      artists: toTitleCaseNames(artists),
      label,
      catalogNumber: result.catno ?? "",
      releaseYear: result.year?.toString() ?? "",
      genres: [...(result.genre ?? []), ...(result.style ?? [])].slice(0, 5),
      format,
      coverUrl: result.cover_image ?? result.thumb ?? "",
    };
  }

  parseMBRelease(r: MBRelease, upc: string): ReleaseData {
    const artists = (r["artist-credit"] ?? [])
      .filter((ac) => ac.artist)
      .map((ac) => ac.artist!.name);
    return {
      upc,
      album: toTitleCase(r.title ?? "Unknown Album"),
      artists: toTitleCaseNames(artists),
      label: r["label-info"]?.[0]?.label?.name ?? "",
      catalogNumber: r["label-info"]?.[0]?.["catalog-number"] ?? "",
      releaseYear: r.date ? r.date.substring(0, 4) : "",
      genres: (r.genres ?? []).slice(0, 5).map((g) => g.name),
      format: r.media?.[0]?.format ?? "",
      coverUrl: "",
    };
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

  openNote(file: TFile): void { void this.app.workspace.getLeaf(false).openFile(file); }

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

// ─── Barcode / Search Modal ───────────────────────────────────────────────────

class BarcodeModal extends Modal {
  plugin: MusicCatalogPlugin;
  constructor(app: App, plugin: MusicCatalogPlugin) { super(app); this.plugin = plugin; }
  onOpen() { this.showScanStep(); }

  showScanStep() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Add music" });

    const tabBar = contentEl.createDiv({ cls: "mc-tab-bar" });
    const barcodeBtn = tabBar.createEl("button", { cls: "mc-tab-btn is-active", text: "📷  Scan / UPC" });
    const searchBtn  = tabBar.createEl("button", { cls: "mc-tab-btn", text: "🔍  Search by title" });
    const tabContent = contentEl.createDiv();

    const renderBarcodeTab = () => {
      barcodeBtn.className = "mc-tab-btn is-active";
      searchBtn.className = "mc-tab-btn";
      tabContent.empty();

      tabContent.createEl("p", { cls: "mc-hint", text: "Scan the UPC barcode with a USB scanner, or type it manually." });
      const inputEl = tabContent.createEl("input", { type: "text", placeholder: "UPC barcode..." });
      inputEl.addClass("mc-upc-input");
      setTimeout(() => inputEl.focus(), 50);

      const statusEl = tabContent.createEl("p", { cls: "mc-status", text: "" });
      const lookupBtn = tabContent.createEl("button", { cls: "mc-lookup-btn", text: "Look up release" });

      const doLookup = async (upc: string) => {
        if (!upc) { statusEl.setText("Please enter a barcode."); return; }
        lookupBtn.disabled = true;
        inputEl.disabled = true;
        statusEl.setText("Looking up release...");
        const release = await this.plugin.lookupUPC(upc);
        if (!release) {
          statusEl.setText("❌ No release found. Check the barcode and try again.");
          lookupBtn.disabled = false;
          inputEl.disabled = false;
          inputEl.focus();
          return;
        }
        const existing = this.plugin.findExistingNote(release);
        if (existing) { this.showDuplicateStep(release, existing); return; }
        this.showConfirmStep(release);
      };

      inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") void doLookup(inputEl.value.trim()); });
      lookupBtn.addEventListener("click", () => void doLookup(inputEl.value.trim()));
    };

    const renderSearchTab = () => {
      barcodeBtn.className = "mc-tab-btn";
      searchBtn.className = "mc-tab-btn is-active";
      tabContent.empty();

      tabContent.createEl("p", { cls: "mc-hint", text: "Title is required. All other fields are optional." });

      const row = (parent: HTMLElement, lbl: string, placeholder: string): HTMLInputElement => {
        const wrap = parent.createDiv({ cls: "mc-form-row" });
        wrap.createEl("label", { cls: "mc-form-label", text: lbl });
        const el = wrap.createEl("input", { type: "text", placeholder });
        el.addClass("mc-form-input");
        return el;
      };

      const titleEl    = row(tabContent, "Title *",   "Required");
      setTimeout(() => titleEl.focus(), 50);
      const artistEl    = row(tabContent, "Artist",    "Optional");
      const labelInputEl = row(tabContent, "Label",    "Optional");

      // Format filter
      let formatFilter: "" | "cd" | "lp" = "";
      const filterWrap = tabContent.createDiv({ cls: "mc-filter-row" });
      filterWrap.createEl("span", { cls: "mc-filter-label", text: "Format" });
      const filterBtnGroup = filterWrap.createDiv({ cls: "mc-filter-btn-group" });
      const anyBtn = filterBtnGroup.createEl("button", { cls: "mc-filter-btn is-active", text: "Any" });
      const cdBtn  = filterBtnGroup.createEl("button", { cls: "mc-filter-btn", text: "CD only" });
      const lpBtn  = filterBtnGroup.createEl("button", { cls: "mc-filter-btn", text: "LP only" });
      const updateFilterBtns = () => {
        anyBtn.className = formatFilter === ""   ? "mc-filter-btn is-active" : "mc-filter-btn";
        cdBtn.className  = formatFilter === "cd" ? "mc-filter-btn is-active" : "mc-filter-btn";
        lpBtn.className  = formatFilter === "lp" ? "mc-filter-btn is-active" : "mc-filter-btn";
      };
      anyBtn.addEventListener("click", () => { formatFilter = ""; updateFilterBtns(); });
      cdBtn.addEventListener("click",  () => { formatFilter = "cd"; updateFilterBtns(); });
      lpBtn.addEventListener("click",  () => { formatFilter = "lp"; updateFilterBtns(); });

      // Classical section
      const classicalSep = tabContent.createDiv({ cls: "mc-classical-sep" });
      classicalSep.createEl("hr", { cls: "mc-classical-hr" });
      classicalSep.createEl("span", { cls: "mc-classical-label", text: "Classical / Opera / Soundtrack" });
      classicalSep.createEl("hr", { cls: "mc-classical-hr" });

      const composerEl  = row(tabContent, "Composer",  "Optional");
      const conductorEl = row(tabContent, "Conductor", "Optional");
      tabContent.createEl("p", { cls: "mc-classical-note", text: "Composer and conductor are each searched separately and results are merged." });

      const statusEl = tabContent.createEl("p", { cls: "mc-status-search", text: "" });
      const searchActionBtn = tabContent.createEl("button", { cls: "mc-search-btn", text: "Search releases" });
      const resultsEl = tabContent.createDiv();

      const renderResults = (releases: ReleaseData[]) => {
        resultsEl.empty();
        if (releases.length === 0) {
          resultsEl.createEl("p", { cls: "mc-hint", text: "No results found. Try different search terms." });
          return;
        }
        resultsEl.createEl("p", { cls: "mc-result-count", text: `${releases.length} result${releases.length !== 1 ? "s" : ""} — click to select` });
        releases.forEach((release) => {
          const card = resultsEl.createDiv({ cls: "mc-result-card" });
          if (release.coverUrl) {
            const img = card.createEl("img");
            img.src = release.coverUrl;
            img.alt = "cover";
            img.addClass("mc-result-thumb");
          } else {
            const ph = card.createDiv({ cls: "mc-result-thumb-placeholder" });
            ph.createEl("span", { text: "💿" });
          }
          const info = card.createDiv({ cls: "mc-result-info" });
          info.createEl("div", { cls: "mc-result-title", text: release.album });
          if (release.artists.length > 0) info.createEl("div", { cls: "mc-result-meta", text: release.artists.join(", ") });
          const meta = [release.label, release.releaseYear, release.format].filter(Boolean).join("  ·  ");
          if (meta) info.createEl("div", { cls: "mc-result-meta", text: meta });
          if (release.genres.length > 0) info.createEl("div", { cls: "mc-result-genre", text: release.genres.join(", ") });
          card.addEventListener("click", () => {
            const existing = this.plugin.findExistingNote(release);
            if (existing) { this.showDuplicateStep(release, existing); return; }
            this.showConfirmStep(release);
          });
        });
      };

      const doSearch = async () => {
        const title = titleEl.value.trim();
        if (!title) {
          statusEl.setText("Please enter a title.");
          statusEl.addClass("is-error");
          titleEl.focus();
          return;
        }
        statusEl.removeClass("is-error");
        searchActionBtn.disabled = true;
        searchActionBtn.setText("Searching…");
        const hasClassical = composerEl.value.trim() || conductorEl.value.trim();
        statusEl.setText(hasClassical ? "Running separate queries for composer/conductor — this may take a few seconds…" : "Searching…");
        resultsEl.empty();
        const releases = await this.plugin.searchReleases({ title, artist: artistEl.value.trim(), label: labelInputEl.value.trim(), composer: composerEl.value.trim(), conductor: conductorEl.value.trim(), formatFilter });
        statusEl.setText("");
        searchActionBtn.disabled = false;
        searchActionBtn.setText("Search releases");
        renderResults(releases);
      };

      const onEnter = (e: KeyboardEvent) => { if (e.key === "Enter") void doSearch(); };
      [titleEl, artistEl, labelInputEl, composerEl, conductorEl].forEach((el) => el.addEventListener("keydown", onEnter));
      searchActionBtn.addEventListener("click", () => void doSearch());
    };

    barcodeBtn.addEventListener("click", renderBarcodeTab);
    searchBtn.addEventListener("click", renderSearchTab);
    renderBarcodeTab();
  }

  showDuplicateStep(release: ReleaseData, existing: TFile) {
    const { contentEl } = this;
    contentEl.empty();

    const headerEl = contentEl.createDiv({ cls: "mc-dup-header" });
    headerEl.createEl("span", { cls: "mc-dup-emoji", text: "📀" });
    headerEl.createEl("h2", { text: "Already in your catalog" });

    const previewEl = contentEl.createDiv({ cls: "mc-preview" });
    if (release.coverUrl) {
      const imgEl = previewEl.createEl("img");
      imgEl.src = release.coverUrl;
      imgEl.alt = "cover";
      imgEl.addClass("mc-preview-img");
    }
    const metaEl = previewEl.createDiv({ cls: "mc-preview-meta" });
    metaEl.createEl("strong", { text: release.album });
    if (release.artists.length > 0) metaEl.createEl("span", { cls: "mc-preview-detail", text: release.artists.join(", ") });
    if (release.label || release.releaseYear) metaEl.createEl("span", { cls: "mc-preview-detail", text: [release.label, release.releaseYear].filter(Boolean).join(", ") });
    if (release.format) metaEl.createEl("span", { cls: "mc-preview-detail", text: release.format });

    const cache = this.plugin.app.metadataCache.getFileCache(existing);
    const currentCopies: number = cache?.frontmatter?.copies ?? 1;
    const copiesInfoEl = contentEl.createDiv({ cls: "mc-copies-info" });
    copiesInfoEl.createEl("span", { text: "Currently in catalog: " });
    copiesInfoEl.createEl("strong", { text: `${currentCopies} cop${currentCopies === 1 ? "y" : "ies"}` });

    contentEl.createEl("hr");

    const copiesWrap = contentEl.createDiv({ cls: "mc-copies-row" });
    copiesWrap.createEl("label", { cls: "mc-copies-label", text: "Update copies to" });
    const copiesEl = copiesWrap.createEl("input", { type: "number" });
    copiesEl.value = String(currentCopies + 1);
    copiesEl.min = "1";
    copiesEl.step = "1";
    copiesEl.addClass("mc-copies-input");

    const btnCol = contentEl.createDiv({ cls: "mc-btn-col" });
    const updateBtn = btnCol.createEl("button", { cls: "mc-btn-full-primary", text: "✅  Update copies" });
    const openBtn   = btnCol.createEl("button", { cls: "mc-btn-full", text: "📀  Open existing note" });
    const scanBtn   = btnCol.createEl("button", { cls: "mc-btn-full", text: "↩  Search again" });

    updateBtn.addEventListener("click", () => {
      const newCount = parseInt(copiesEl.value) || currentCopies + 1;
      updateBtn.disabled = true;
      updateBtn.setText("Saving...");
      void this.plugin.updateCopies(existing, newCount).then(() => this.close());
    });
    openBtn.addEventListener("click", () => { this.plugin.openNote(existing); this.close(); });
    scanBtn.addEventListener("click", () => this.showScanStep());
  }

  showConfirmStep(release: ReleaseData) {
    const { contentEl } = this;
    contentEl.empty();

    const previewEl = contentEl.createDiv({ cls: "mc-preview" });
    if (release.coverUrl) {
      const imgEl = previewEl.createEl("img");
      imgEl.src = release.coverUrl;
      imgEl.alt = "cover";
      imgEl.addClass("mc-preview-img");
    }
    const metaEl = previewEl.createDiv({ cls: "mc-preview-meta" });
    metaEl.createEl("strong", { text: release.album });
    if (release.artists.length > 0) metaEl.createEl("span", { cls: "mc-preview-detail", text: release.artists.join(", ") });
    if (release.label || release.releaseYear) metaEl.createEl("span", { cls: "mc-preview-detail", text: [release.label, release.releaseYear].filter(Boolean).join(", ") });
    if (release.format) metaEl.createEl("span", { cls: "mc-preview-detail", text: release.format });
    if (release.genres.length > 0) metaEl.createEl("span", { cls: "mc-preview-detail", text: release.genres.join(", ") });

    contentEl.createEl("hr");

    // ── Standard fields ───────────────────────────────────────────────────
    const conditionRow = contentEl.createDiv({ cls: "mc-field-row" });
    conditionRow.createEl("label", { cls: "mc-field-label", text: "Condition" });
    const conditionEl = conditionRow.createEl("select");
    conditionEl.addClass("mc-field-select");
    ["", "Mint (M)", "Near Mint (NM)", "Very Good Plus (VG+)", "Very Good (VG)", "Good Plus (G+)", "Good (G)", "Fair (F)", "Poor (P)"].forEach((c) => {
      const opt = conditionEl.createEl("option", { text: c || "— select —" });
      opt.value = c;
    });

    const acquiredRow = contentEl.createDiv({ cls: "mc-field-row" });
    acquiredRow.createEl("label", { cls: "mc-field-label", text: "Acquired" });
    const acquiredEl = acquiredRow.createEl("input", { type: "date" });
    acquiredEl.addClass("mc-field-input");
    acquiredEl.value = new Date().toISOString().split("T")[0];

    const copiesRow = contentEl.createDiv({ cls: "mc-field-row" });
    copiesRow.createEl("label", { cls: "mc-field-label", text: "Copies" });
    const copiesEl = copiesRow.createEl("input", { type: "number" });
    copiesEl.addClass("mc-field-input");
    copiesEl.value = "1";
    copiesEl.min = "1";
    copiesEl.step = "1";

    const valuationRow = contentEl.createDiv({ cls: "mc-field-row" });
    valuationRow.createEl("label", { cls: "mc-field-label", text: "Value (USD)" });
    const valuationWrap = valuationRow.createDiv({ cls: "mc-valuation-wrap" });
    valuationWrap.createEl("span", { cls: "mc-valuation-prefix", text: "$" });
    const valuationEl = valuationWrap.createEl("input", { type: "number" });
    valuationEl.addClass("mc-valuation-input");
    valuationEl.placeholder = "0.00";
    valuationEl.min = "0";
    valuationEl.step = "0.01";

    // ── Custom fields ─────────────────────────────────────────────────────
    const customGetters: Record<string, () => string> = {};
    if (this.plugin.settings.customFields.length > 0) {
      contentEl.createEl("hr", { cls: "mc-custom-divider" });
      this.plugin.settings.customFields.forEach((field) => {
        const wrap = contentEl.createDiv({ cls: "mc-field-row" });
        wrap.createEl("label", { cls: "mc-field-label", text: field.name });
        if (field.type === "boolean") {
          const toggleOuter = wrap.createDiv({ cls: "mc-toggle-outer" });
          const toggleInput = toggleOuter.createEl("input", { type: "checkbox" });
          toggleInput.addClass("mc-toggle-input");
          const slider = toggleOuter.createDiv({ cls: "mc-toggle-slider" });
          slider.createDiv({ cls: "mc-toggle-knob" });
          const sync = () => { slider.toggleClass("is-on", toggleInput.checked); };
          toggleInput.addEventListener("change", sync);
          slider.addEventListener("click", () => { toggleInput.checked = !toggleInput.checked; sync(); });
          customGetters[field.id] = () => toggleInput.checked ? "true" : "false";
        } else if (field.type === "date") {
          const el = wrap.createEl("input", { type: "date" });
          el.addClass("mc-field-input");
          customGetters[field.id] = () => el.value;
        } else if (field.type === "number") {
          const el = wrap.createEl("input", { type: "number" });
          el.addClass("mc-field-input");
          el.step = "any";
          customGetters[field.id] = () => el.value;
        } else {
          const el = wrap.createEl("input", { type: "text" });
          el.addClass("mc-field-input");
          customGetters[field.id] = () => el.value;
        }
      });
    }

    // ── Buttons ───────────────────────────────────────────────────────────
    const saveFirst = this.plugin.settings.saveAndAddFirst;
    const btnRow = contentEl.createDiv({ cls: "mc-btn-row" });
    const backBtn        = btnRow.createEl("button", { cls: "mc-btn-secondary", text: "← Back" });
    const saveAnotherBtn = btnRow.createEl("button", { text: "Save & add another" });
    const saveBtn        = btnRow.createEl("button", { text: "Save release" });
    saveAnotherBtn.addClass(saveFirst ? "mc-btn-primary" : "mc-btn-secondary");
    saveBtn.addClass(saveFirst ? "mc-btn-secondary" : "mc-btn-primary");

    const collectCustomValues = (): Record<string, string> => {
      const vals: Record<string, string> = {};
      for (const id in customGetters) vals[id] = customGetters[id]();
      return vals;
    };

    backBtn.addEventListener("click", () => this.showScanStep());
    saveBtn.addEventListener("click", () => {
      saveBtn.disabled = true;
      saveBtn.setText("Saving...");
      void this.plugin.createReleaseNote(release, conditionEl.value, acquiredEl.value, valuationEl.value, copiesEl.value, collectCustomValues())
        .then(() => this.close());
    });
    saveAnotherBtn.addEventListener("click", () => {
      saveAnotherBtn.disabled = true;
      saveAnotherBtn.setText("Saving...");
      void this.plugin.createReleaseNote(release, conditionEl.value, acquiredEl.value, valuationEl.value, copiesEl.value, collectCustomValues())
        .then(() => this.showScanStep());
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
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Reorganize catalog files" });
    contentEl.createEl("p", { cls: "mc-reorg-hint", text: "Scan your vault to find all release notes regardless of where they currently live." });

    const targetEl = contentEl.createDiv({ cls: "mc-target-box" });
    targetEl.createEl("p", { cls: "mc-target-heading", text: "Target location (from your settings):" });
    targetEl.createEl("p", { cls: "mc-target-path", text: `📄 ${getBasePath(this.plugin.settings.baseFolder)}` });
    targetEl.createEl("p", { cls: "mc-target-path-last", text: `📀 ${getNotesFolder(this.plugin.settings)}/` });

    const resultsEl = contentEl.createDiv({ cls: "mc-results-area" });
    const btnRow = contentEl.createDiv({ cls: "mc-reorg-btn-row" });
    const cancelBtn = btnRow.createEl("button", { cls: "mc-reorg-cancel-btn", text: "Cancel" });
    const scanBtn   = btnRow.createEl("button", { cls: "mc-reorg-scan-btn", text: "🔍  Scan vault" });

    cancelBtn.addEventListener("click", () => this.close());
    scanBtn.addEventListener("click", () => {
      scanBtn.disabled = true;
      scanBtn.setText("Scanning...");
      resultsEl.empty();

      const releaseNotes = this.plugin.scanVaultForReleaseNotes();
      const newNotesFolder = getNotesFolder(this.plugin.settings);
      const notesToMove = releaseNotes.filter((f) => f.path !== `${newNotesFolder}/${f.name}`);
      const existingBase = this.plugin.findExistingBaseFile();
      const newBasePath = getBasePath(this.plugin.settings.baseFolder);
      const baseNeedsMove = !!(existingBase && existingBase.path !== newBasePath);

      const resultBox = resultsEl.createDiv({ cls: "mc-result-box" });
      resultBox.createEl("p", { cls: "mc-result-box-heading", text: `✅ Scan complete — found ${releaseNotes.length} release note${releaseNotes.length !== 1 ? "s" : ""} in your vault.` });

      if (releaseNotes.length === 0) {
        resultBox.createEl("p", { cls: "mc-folder-name", text: 'No release notes found. Make sure notes have tags: ["record"] in their frontmatter.' });
        scanBtn.disabled = false;
        scanBtn.setText("🔍  Scan vault");
        return;
      }

      const byFolder = new Map<string, TFile[]>();
      for (const f of releaseNotes) {
        const folder = f.parent?.path ?? "(root)";
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder)!.push(f);
      }

      byFolder.forEach((files, folder) => {
        const alreadyInPlace = folder === newNotesFolder;
        const folderEl = resultBox.createDiv({ cls: "mc-folder-row" });
        const nameEl = folderEl.createEl("span", { text: `📁 ${folder}/ — ${files.length} note${files.length !== 1 ? "s" : ""}` });
        nameEl.addClass(alreadyInPlace ? "mc-folder-name is-ok" : "mc-folder-name");
        if (alreadyInPlace) folderEl.createEl("span", { cls: "mc-folder-ok-badge", text: " ✓ already in target" });
      });

      if (existingBase) resultBox.createEl("p", { cls: "mc-base-path", text: `📄 Music Catalog.base: ${existingBase.path}` });

      if (notesToMove.length === 0 && !baseNeedsMove) {
        resultBox.createEl("p", { cls: "mc-all-ok", text: "✅ Everything is already in the correct location." });
        scanBtn.disabled = false;
        scanBtn.setText("🔍  Scan again");
        return;
      }

      const proceedRow = resultsEl.createDiv({ cls: "mc-proceed-row" });
      const proceedBtn = proceedRow.createEl("button", { cls: "mc-proceed-btn", text: `Review ${notesToMove.length} move${notesToMove.length !== 1 ? "s" : ""} →` });
      proceedBtn.addEventListener("click", () => this.showConfirmStep(releaseNotes, notesToMove, existingBase, baseNeedsMove));
      scanBtn.disabled = false;
      scanBtn.setText("🔍  Scan again");
    });
  }

  showConfirmStep(allNotes: TFile[], notesToMove: TFile[], existingBase: TFile | null, baseNeedsMove: boolean) {
    const { contentEl } = this;
    contentEl.empty();
    const s = this.plugin.settings;
    const newNotesFolder = getNotesFolder(s);
    const newBasePath = getBasePath(s.baseFolder);

    contentEl.createEl("h2", { text: "Confirm reorganization" });
    contentEl.createEl("p", { cls: "mc-reorg-confirm-hint", text: "Review the changes below before confirming." });

    if (notesToMove.length > 0) {
      contentEl.createEl("p", { cls: "mc-section-label", text: "Release notes to move:" });
      const notesBox = contentEl.createDiv({ cls: "mc-tree-box" });
      const byFolder = new Map<string, TFile[]>();
      for (const f of notesToMove) {
        const folder = f.parent?.path ?? "(root)";
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder)!.push(f);
      }
      byFolder.forEach((files, folder) => {
        notesBox.createEl("div", { text: `📁 ${folder}/` });
        const indent = notesBox.createDiv({ cls: "mc-tree-indent" });
        files.slice(0, 4).forEach((f) => indent.createEl("div", { cls: "mc-tree-item", text: `📀 ${f.name}` }));
        if (files.length > 4) indent.createEl("div", { cls: "mc-tree-item", text: `… and ${files.length - 4} more` });
        notesBox.createEl("div", { cls: "mc-tree-dest", text: `↳ → ${newNotesFolder}/` });
      });
    }

    if (baseNeedsMove && existingBase) {
      contentEl.createEl("p", { cls: "mc-section-label", text: "Base file to move:" });
      const baseBox = contentEl.createDiv({ cls: "mc-tree-box" });
      baseBox.createEl("div", { cls: "mc-tree-item", text: `📄 ${existingBase.path}` });
      baseBox.createEl("div", { cls: "mc-tree-dest", text: `↳ → ${newBasePath}` });
    }

    const summaryEl = contentEl.createDiv({ cls: "mc-summary-box" });
    summaryEl.createEl("p", { cls: "mc-summary-line", text: `📀 ${notesToMove.length} note${notesToMove.length !== 1 ? "s" : ""} → ${newNotesFolder}/` });
    if (baseNeedsMove) summaryEl.createEl("p", { cls: "mc-summary-line", text: `📄 Base → ${newBasePath}` });
    summaryEl.createEl("p", { cls: "mc-summary-line-last", text: "📄 Music Catalog.base will be regenerated with updated paths." });

    const btnRow = contentEl.createDiv({ cls: "mc-confirm-btn-row" });
    const backBtn    = btnRow.createEl("button", { cls: "mc-btn-secondary", text: "← Back" });
    const confirmBtn = btnRow.createEl("button", { cls: "mc-btn-primary", text: "Confirm & move files" });

    backBtn.addEventListener("click", () => this.showScanStep());
    confirmBtn.addEventListener("click", () => {
      confirmBtn.disabled = true;
      confirmBtn.setText("Moving files...");
      void this.plugin.reorganizeFiles(allNotes).then(() => this.close());
    });
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class MusicCatalogSettingTab extends PluginSettingTab {
  plugin: MusicCatalogPlugin;
  constructor(app: App, plugin: MusicCatalogPlugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── File organization ─────────────────────────────────────────────────
    new Setting(containerEl).setName("File organization").setHeading();
    containerEl.createEl("p", { cls: "mc-hint", text: "Set where the catalog base file and release notes should live. After changing these, use Reorganize files below to move existing files." });

    new Setting(containerEl)
      .setName("Catalog folder")
      .setDesc("The top-level folder where Music Catalog.base will be created. Accepts nested paths, e.g. '03 Resources/Music'.")
      .addText((text) => text.setPlaceholder("Music").setValue(this.plugin.settings.baseFolder).onChange(async (value) => {
        this.plugin.settings.baseFolder = value.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Notes subfolder")
      .setDesc("A subfolder inside the catalog folder where individual release notes are stored. Leave blank to store notes directly in the catalog folder.")
      .addText((text) => text.setPlaceholder("Notes").setValue(this.plugin.settings.notesSubfolder).onChange(async (value) => {
        this.plugin.settings.notesSubfolder = value.trim();
        await this.plugin.saveSettings();
      }));

    const previewEl = containerEl.createDiv({ cls: "mc-path-preview" });
    const updatePreview = () => {
      previewEl.empty();
      previewEl.createEl("p", { cls: "mc-path-line", text: `📄 Base file: ${getBasePath(this.plugin.settings.baseFolder)}` });
      previewEl.createEl("p", { cls: "mc-path-line-last", text: `📀 Release notes: ${getNotesFolder(this.plugin.settings)}/` });
    };
    updatePreview();
    const origSave = this.plugin.saveSettings.bind(this.plugin);
    this.plugin.saveSettings = async () => { await origSave(); updatePreview(); };

    new Setting(containerEl)
      .setName("Create or update base file")
      .setDesc("Creates Music Catalog.base at the path shown above with the correct filters, views, and column layout.")
      .addButton((btn) => btn.setButtonText("Create base file").setCta().onClick(async () => { await this.plugin.createBaseFile(); }));

    containerEl.createEl("hr");

    // ── Reorganize files ──────────────────────────────────────────────────
    new Setting(containerEl).setName("Reorganize files").setHeading();
    containerEl.createEl("p", { cls: "mc-hint", text: "Use this after changing your folder settings to move existing release notes and the base file. Scans your entire vault first so manually-moved files are always found." });

    new Setting(containerEl)
      .setName("Scan & reorganize vault")
      .setDesc("Opens a two-step dialog: scans for all release notes, shows what was found, then lets you confirm before moving anything.")
      .addButton((btn) => btn.setButtonText("Scan vault & reorganize").setWarning().onClick(() => { new ReorganizeModal(this.app, this.plugin).open(); }));

    containerEl.createEl("hr");

    // ── Modal preferences ─────────────────────────────────────────────────
    new Setting(containerEl).setName("Modal preferences").setHeading();

    new Setting(containerEl)
      .setName("Default to save & add another")
      .setDesc("When on, 'Save & add another' is the primary (highlighted) button in the confirm step. Turn off to make 'Save release' the primary button instead.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.saveAndAddFirst).onChange(async (value) => {
        this.plugin.settings.saveAndAddFirst = value;
        await this.plugin.saveSettings();
      }));

    containerEl.createEl("hr");

    // ── Custom fields ─────────────────────────────────────────────────────
    new Setting(containerEl).setName("Custom fields").setHeading();
    containerEl.createEl("p", { cls: "mc-hint", text: "Add your own fields to the capture modal. Each field is saved to the note's frontmatter using the field name as the YAML key." });

    const fieldListEl = containerEl.createDiv({ cls: "mc-field-list" });
    const renderFieldList = () => {
      fieldListEl.empty();
      if (this.plugin.settings.customFields.length === 0) {
        fieldListEl.createEl("p", { cls: "mc-field-empty", text: "No custom fields yet." });
        return;
      }
      this.plugin.settings.customFields.forEach((field, index) => {
        const row = fieldListEl.createDiv({ cls: "mc-field-item" });
        const nameEl = row.createDiv({ cls: "mc-field-name-wrap" });
        nameEl.createEl("span", { cls: "mc-field-name", text: field.name });
        nameEl.createEl("span", { cls: "mc-type-badge", text: field.type });
        const deleteBtn = row.createEl("button", { cls: "mc-field-delete", text: "✕" });
        deleteBtn.addEventListener("click", () => {
          this.plugin.settings.customFields.splice(index, 1);
          void this.plugin.saveSettings().then(() => renderFieldList());
        });
      });
    };
    renderFieldList();

    const addRow = containerEl.createDiv({ cls: "mc-add-row" });
    const nameInput = addRow.createEl("input", { type: "text", placeholder: "Field name" });
    nameInput.addClass("mc-add-name-input");
    const typeSelect = addRow.createEl("select");
    typeSelect.addClass("mc-add-type-select");
    (["text", "number", "date", "boolean"] as const).forEach((t) => {
      const opt = typeSelect.createEl("option", { text: t });
      opt.value = t;
    });
    const addBtn = addRow.createEl("button", { cls: "mc-add-btn", text: "Add field" });
    addBtn.addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const key = toYamlKey(name);
      if (this.plugin.settings.customFields.some((f) => toYamlKey(f.name) === key)) {
        new Notice("A field with that name already exists.");
        return;
      }
      this.plugin.settings.customFields.push({ id: `cf-${Date.now()}`, name, type: typeSelect.value as CustomField["type"] });
      nameInput.value = "";
      void this.plugin.saveSettings().then(() => renderFieldList());
    });
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });

    containerEl.createEl("hr");

    // ── API ───────────────────────────────────────────────────────────────
    new Setting(containerEl).setName("API").setHeading();
    containerEl.createEl("p", { cls: "mc-hint", text: "MusicBrainz is always available with no setup required. Discogs provides richer data — pressing details, catalog numbers, and cover art — and is used as the primary source when a token is provided." });

    new Setting(containerEl)
      .setName("Discogs personal access token")
      .setDesc("Log into Discogs → click your username → Settings → Developers → Generate new token. Do not use your Consumer Key or Consumer Secret — those are for OAuth and will not work.")
      .addText((text) => text.setPlaceholder("Paste your Discogs personal access token here").setValue(this.plugin.settings.discogsToken).onChange(async (value) => {
        this.plugin.settings.discogsToken = value.trim();
        await this.plugin.saveSettings();
      }));
  }
}
