import { MODULE_ID } from "./constants.mjs";

/**
 * Index of Item compendium entries the importer can draw on, grouped by item type.
 * Built lazily and cached; call `CompendiumIndex.reset()` after packs change.
 */
export class CompendiumIndex {
  static #cache = null;

  static FIELDS = [
    "type", "img", "system.identifier", "system.classIdentifier",
    "system.source.rules", "system.source.book", "system.level", "system.type.value"
  ];

  static reset() { this.#cache = null; }

  /** Packs the GM allowed in settings (empty = all Item packs). */
  static get packs() {
    const allowed = game.settings.get(MODULE_ID, "packs")
      .split(",").map(s => s.trim()).filter(Boolean);
    return game.packs.filter(p => p.documentName === "Item"
      && p.visible
      && (!allowed.length || allowed.includes(p.collection)));
  }

  /** @returns {Promise<Record<string, object[]>>} entries keyed by item type */
  static async load() {
    if ( this.#cache ) return this.#cache;
    const byType = {};
    for ( const pack of this.packs ) {
      let index;
      try { index = await pack.getIndex({ fields: this.FIELDS }); }
      catch(err) { console.warn(`${MODULE_ID} | Could not index ${pack.collection}`, err); continue; }
      for ( const e of index ) {
        const entry = {
          uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`,
          name: e.name,
          type: e.type,
          img: e.img,
          identifier: e.system?.identifier || slug(e.name),
          classIdentifier: e.system?.classIdentifier ?? "",
          rules: e.system?.source?.rules || "",
          book: e.system?.source?.book || "",
          level: e.system?.level,
          featType: e.system?.type?.value ?? "",
          pack: pack.metadata.label,
          key: normalize(e.name)
        };
        (byType[e.type] ??= []).push(entry);
      }
    }
    for ( const list of Object.values(byType) ) list.sort((a, b) => a.name.localeCompare(b.name));
    return this.#cache = byType;
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
