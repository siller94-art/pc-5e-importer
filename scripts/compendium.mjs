import { MODULE_ID } from "./constants.mjs";

/**
 * Index of Item compendium entries the importer can draw on, grouped by item type.
 * Built lazily and cached; call `CompendiumIndex.reset()` after packs change.
 */
export class CompendiumIndex {
  static #cache = null;
  static #loading = null;

  /** What the last load found, for the wizard's "nothing found" panel and the console. */
  static stats = null;

  /** True once every pack has been indexed. */
  static get ready() { return !!this.#cache; }

  static FIELDS = [
    "type", "img", "system.identifier", "system.classIdentifier",
    "system.source.rules", "system.source.book", "system.level", "system.type.value"
  ];

  static reset() { this.#cache = null; this.#loading = null; }

  /** Packs the GM allowed in settings (empty = all Item packs). */
  static get packs() {
    const allowed = game.settings.get(MODULE_ID, "packs")
      .split(",").map(s => s.trim()).filter(Boolean);
    return game.packs.filter(p => (p.documentName ?? p.metadata?.type) === "Item"
      && p.visible !== false
      && (!allowed.length || allowed.includes(p.collection)));
  }

  /** @returns {Promise<Record<string, object[]>>} entries keyed by item type */
  static load() {
    if ( this.#cache ) return Promise.resolve(this.#cache);
    // Share one load between every caller, so opening the wizard never indexes packs twice.
    return this.#loading ??= this.#build().then(db => {
      this.#cache = db;
      return db;
    }).finally(() => { this.#loading = null; });
  }

  static async #build() {
    const byType = {};
    const started = performance.now();
    const packs = this.packs;
    const stats = { packs: packs.length, read: 0, failed: [], untyped: 0, entries: 0, counts: {}, ms: 0 };
    await Promise.all(packs.map(async pack => {
      let index;
      try {
        index = await withTimeout(pack.getIndex({ fields: this.FIELDS }), 60000);
      } catch(err) {
        // Retry with the default index fields in case one of ours is rejected.
        try { index = await withTimeout(pack.getIndex(), 60000); }
        catch(err2) {
          stats.failed.push(`${pack.metadata?.label ?? pack.collection}: ${err2?.message ?? err2}`);
          console.warn(`${MODULE_ID} | Skipped compendium ${pack.collection}:`, err2);
          return;
        }
      }
      stats.read++;
      for ( const e of index ) {
        const type = e.type;
        if ( !type ) { stats.untyped++; continue; }
        const entry = {
          uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`,
          name: e.name,
          type,
          img: e.img,
          identifier: e.system?.identifier || slug(e.name),
          classIdentifier: e.system?.classIdentifier ?? "",
          rules: e.system?.source?.rules || "",
          book: e.system?.source?.book || "",
          level: e.system?.level,
          featType: e.system?.type?.value ?? "",
          pack: pack.metadata?.label ?? pack.collection,
          key: normalize(e.name)
        };
        (byType[type] ??= []).push(entry);
        stats.entries++;
      }
    }));
    for ( const list of Object.values(byType) ) list.sort((a, b) => a.name.localeCompare(b.name));
    for ( const t of ["class", "subclass", "race", "background", "feat", "spell"] ) stats.counts[t] = byType[t]?.length ?? 0;
    stats.ms = Math.round(performance.now() - started);
    this.stats = stats;
    console.log(`${MODULE_ID} | Read ${stats.read}/${stats.packs} Item compendiums (${stats.entries} entries) in ${stats.ms} ms`, stats);
    return byType;
  }

  /**
   * Entries of a type filtered to a rules version. Items with no rules recorded are kept for either version.
   * @param {string} type
   * @param {"2014"|"2024"|"any"} rules
   */
  static async list(type, rules="any") {
    const all = (await this.load())[type] ?? [];
    if ( rules === "any" ) return all;
    return all.filter(e => !e.rules || e.rules === rules);
  }

  /**
   * Find the best match for a name.
   * Preference: exact name in matching rules > exact name any rules > "(Legacy)"-stripped > startsWith.
   * @param {string} type      Item type, or array of types.
   * @param {string} name
   * @param {string} rules
   * @param {object} [extra]   Extra filter, e.g. { classIdentifier: "wizard" }
   */
  static async find(type, name, rules="any", extra={}) {
    if ( !name ) return null;
    const types = Array.isArray(type) ? type : [type];
    const db = await this.load();
    let pool = types.flatMap(t => db[t] ?? []);
    for ( const [k, v] of Object.entries(extra) ) if ( v ) pool = pool.filter(e => e[k] === v);
    const key = normalize(name);
    const words = sortedWords(key);
    const cascade = list => list.find(e => e.key === key)
      ?? list.find(e => normalize(e.name.replace(/\(legacy\)/i, "")) === key)
      ?? list.find(e => e.identifier === slug(name))
      ?? list.find(e => sortedWords(e.key) === words)                    // "Wood Elf" ↔ "Elf, Wood"
      ?? list.find(e => key.length >= 3 && e.key.startsWith(key))
      ?? list.find(e => SUBCLASS_ALIASES[key] && e.key === SUBCLASS_ALIASES[key]);
    // Try the requested rules version first, then anything.
    const sameRules = rules === "any" ? pool : pool.filter(e => !e.rules || e.rules === rules);
    return cascade(sameRules) ?? (sameRules === pool ? null : cascade(pool)) ?? null;
  }

  /** Load the full item data for an entry, ready to embed. */
  static async itemData(uuid, overrides={}) {
    const doc = await fromUuid(uuid);
    if ( !doc ) return null;
    const data = doc.toObject();
    delete data._id;
    foundry.utils.setProperty(data, "_stats.compendiumSource", uuid);
    return foundry.utils.mergeObject(data, overrides);
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sortedWords(key) { return key.split(" ").sort().join(" "); }

/** 2014 subclass names whose 2024 versions were renamed. */
const SUBCLASS_ALIASES = {
  "school of abjuration": "abjurer", "school of divination": "diviner",
  "school of evocation": "evoker", "school of illusion": "illusionist",
  "way of the open hand": "warrior of the open hand", "way of shadow": "warrior of shadow",
  "way of the four elements": "warrior of the elements", "draconic bloodline": "draconic sorcery",
  "wild magic": "wild magic sorcery", "the fiend": "fiend patron", "the archfey": "archfey patron",
  "the great old one": "great old one patron", "circle of the land": "circle of the land"
};

export function normalize(s) {
  return String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export function slug(s) {
  return normalize(s).replace(/ /g, "-");
}

/** Work out which rules version a set of compendium entries belongs to. */
export function detectRules(entries) {
  const found = new Set(entries.filter(Boolean).map(e => e.rules).filter(Boolean));
  if ( found.size === 1 ) return { rules: [...found][0], mixed: false };
  if ( found.size > 1 ) return { rules: found.has("2024") ? "2024" : "2014", mixed: true };
  return { rules: defaultRules(), mixed: false };
}

export function defaultRules() {
  try { return game.settings.get("dnd5e", "rulesVersion") === "legacy" ? "2014" : "2024"; }
  catch { return "2024"; }
}
