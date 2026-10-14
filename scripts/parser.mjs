import { ABILITIES, ABILITY_ALIASES, CURRENCIES } from "./constants.mjs";

/**
 * Header keywords → field. A line starting with one of these (followed by ":" or a dash)
 * opens a section; following lines without a header continue it.
 */
const HEADERS = {
  name: ["name", "character name", "character"],
  species: ["species", "race", "lineage", "ancestry"],
  class: ["class", "classes", "class & level", "class and level", "class level"],
  subclass: ["subclass", "archetype", "subclasses"],
  background: ["background"],
  rules: ["rules", "ruleset", "edition"],
  level: ["level", "character level"],
  skills: ["skills", "skill proficiencies"],
  expertise: ["expertise"],
  languages: ["languages", "language"],
  tools: ["tools", "tool proficiencies", "tool"],
  armor: ["armor", "armor proficiencies", "armour"],
  weapons: ["weapons", "weapon proficiencies"],
  senses: ["senses"],
  feats: ["feats", "feat", "origin feat"],
  equipment: ["equipment", "inventory", "items", "gear"],
  spells: ["spells", "spells known", "prepared spells", "spellbook", "cantrips"],
  currency: ["currency", "money", "coins", "wealth"],
  ignore: ["saving throws", "saves", "hit points", "hp", "ac", "armor class", "speed", "proficiency bonus",
    "features", "traits", "personality", "ideals", "bonds", "flaws", "alignment", "notes", "attacks"]
};

const HEADER_LOOKUP = Object.entries(HEADERS)
  .flatMap(([field, words]) => words.map(w => [w, field]))
  .sort((a, b) => b[0].length - a[0].length);

/**
 * Parse pasted character text into a plain build object.
 * @param {string} text
 */
export function parseCharacter(text) {
  const out = {
    name: "", species: "", background: "", rules: "", classes: [],
    abilities: {}, skills: [], expertise: [], languages: [], tools: [], armor: [], weapons: [],
    senses: {}, feats: [], equipment: [], spells: [], currency: {}, warnings: []
  };
  const sections = {};
  let current = null;
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");

  for ( let raw of lines ) {
    const line = raw.replace(/^[\s•*\-–]+/, "").trim();
    if ( !line ) continue;

    // Ability scores can appear anywhere, in any layout.
    const abil = parseAbilityLine(line);
    if ( abil ) { Object.assign(out.abilities, abil); current = null; continue; }

    // Coin lines on their own, e.g. "GP: 25".
    const coin = line.match(/^(pp|gp|ep|sp|cp)\s*[:=]?\s*(\d[\d,]*)$/i);
    if ( coin ) { (sections.currency ??= []).push(`${coin[2]} ${coin[1]}`); current = null; continue; }

    const header = matchHeader(line);
    if ( header ) {
      current = header.field;
      if ( current === "cantrips" ) current = "spells";
      (sections[current] ??= []).push(header.rest);
      continue;
    }
    if ( current ) sections[current].push(line);
    else if ( !out.name ) out.name = line;   // First unlabelled line = name
  }

  const joined = f => (sections[f] ?? []).filter(Boolean).join(", ");
  const list = f => splitList(joined(f));

  if ( sections.name ) out.name = joined("name");
  out.species = joined("species");
  out.background = joined("background");
  const rules = joined("rules");
  if ( /2024|5\.5|one ?d&?d|modern/i.test(rules) ) out.rules = "2024";
  else if ( /2014|5e|legacy/i.test(rules) ) out.rules = "2014";

  out.classes = parseClasses(joined("class"), joined("subclass"));
  const lvl = parseInt(joined("level"));
  if ( out.classes.length === 1 && lvl && !out.classes[0].explicitLevel ) out.classes[0].levels = lvl;

  for ( const s of list("skills") ) {
    const expert = /\*|\(expert(ise)?\)|\bexpertise\b/i.test(s);
    const name = cleanName(s.replace(/\*|\(expert(ise)?\)|\bexpertise\b/gi, "").replace(/[+-]\d+/, ""));
    if ( !name ) continue;
    (expert ? out.expertise : out.skills).push(name);
  }
  for ( const s of list("expertise") ) out.expertise.push(cleanName(s));

  out.languages = list("languages").map(cleanName);
  out.tools = list("tools").map(cleanName);
  out.armor = list("armor").map(cleanName);
  out.weapons = list("weapons").map(cleanName);

  for ( const s of list("senses") ) {
    const m = s.match(/([a-z]+)\s*(\d+)/i);
    if ( m ) out.senses[m[1].toLowerCase()] = Number(m[2]);
  }

  out.feats = list("feats").map(s => s.replace(/\s*\(.*?\)\s*$/, "").trim()).filter(Boolean);
  out.equipment = list("equipment").map(parseQuantity).filter(e => e.name);
  out.spells = (sections.spells ?? []).flatMap(l => splitList(stripSpellLevelLabel(l)).map(stripSpellLevelLabel))
    .map(s => cleanName(s.replace(/\s*\((?:prepared|ritual|always|concentration|[a-z ]*pact)\)/gi, "")))
    .filter(Boolean);
  out.currency = parseCurrency(joined("currency"));

  // A "Wood Elf Wizard 3" style one-liner, if nothing else said what the class is.
  if ( !out.classes.length ) {
    const m = String(text).match(/\b([A-Z][a-z]+)\s+(\d{1,2})\b/);
    if ( m ) out.classes.push({ name: m[1], levels: Number(m[2]), subclass: "" });
  }
  if ( !out.classes.length ) out.warnings.push("No class found in the pasted text.");
  return out;
}

function matchHeader(line) {
  const lower = line.toLowerCase();
  for ( const [word, field] of HEADER_LOOKUP ) {
    if ( !lower.startsWith(word) ) continue;
    const after = line.slice(word.length);
    const m = after.match(/^\s*[:\-–—]\s*(.*)$/) ?? (after.trim() === "" ? [null, ""] : null);
    if ( !m ) continue;
    return { field: word === "cantrips" ? "spells" : field, rest: m[1].trim() };
  }
  return null;
}

function parseAbilityLine(line) {
  const found = {};
  for ( const key of ABILITIES ) {
    for ( const alias of ABILITY_ALIASES[key] ) {
      const re = new RegExp(`\\b${alias}\\b\\s*[:=]?\\s*(\\d{1,2})`, "i");
      const m = line.match(re);
      if ( m ) { found[key] = Number(m[1]); break; }
    }
  }
  // Require at least two abilities on a line, or a line that is only "STR 10"-like.
  const n = Object.keys(found).length;
  if ( n >= 2 ) return found;
  if ( n === 1 && /^[a-z]+\s*[:=]?\s*\d{1,2}(\s*\([+-]?\d+\))?$/i.test(line) ) return found;
  return null;
}

/** "Fighter 3 / Wizard (Evocation) 2", "Rogue: Thief 3", "Cleric 1 (Life Domain)" */
export function parseClasses(classText, subclassText="") {
  const subs = splitList(subclassText);
  const parts = String(classText ?? "").split(/\s*[\/,;]\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
  const classes = [];
  for ( const part of parts ) {
    let name = part, sub = "", levels = 1, explicit = false;
    const lvl = name.match(/\b(?:level\s*)?(\d{1,2})\b/i);
    if ( lvl ) { levels = Number(lvl[1]); explicit = true; name = name.replace(lvl[0], " "); }
    const paren = name.match(/\(([^)]+)\)/);
    if ( paren ) { sub = paren[1].trim(); name = name.replace(paren[0], " "); }
    const colon = name.match(/^([^:]+):\s*(.+)$/);
    if ( colon ) { name = colon[1]; sub ||= colon[2]; }
    name = cleanName(name.replace(/\blevel\b/i, ""));
    if ( !name ) continue;
    classes.push({ name, levels, subclass: sub.trim(), explicitLevel: explicit });
  }
  subs.forEach((s, i) => { if ( classes[i] && !classes[i].subclass ) classes[i].subclass = s; });
  return classes;
}

function splitList(text) {
  // Split on commas/semicolons that are not inside parentheses.
  const out = []; let depth = 0, buf = "";
  for ( const ch of String(text ?? "") ) {
    if ( ch === "(" ) depth++;
    if ( ch === ")" ) depth = Math.max(0, depth - 1);
    if ( (ch === "," || ch === ";") && depth === 0 ) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map(s => s.trim()).filter(s => s && !/^(none|—|-)$/i.test(s));
}

function cleanName(s) {
  return String(s ?? "").replace(/\s+/g, " ").replace(/^[\s.:]+|[\s.:]+$/g, "").trim();
}

function stripSpellLevelLabel(line) {
  return line.replace(/^(cantrips?|(?:\d+(?:st|nd|rd|th)|level\s*\d+)(?:[- ]level)?(?:\s*\(\s*\d+\s*slots?\s*\))?)\s*[:\-–—]?\s*/i, "");
}

export function parseQuantity(s) {
  let name = cleanName(s), quantity = 1;
  let m;
  if ( (m = name.match(/^(\d+)\s*[x×]?\s+(.+)$/i)) ) { quantity = Number(m[1]); name = m[2]; }
  else if ( (m = name.match(/^(.+?)\s*[x×]\s*(\d+)$/i)) ) { name = m[1]; quantity = Number(m[2]); }
  else if ( (m = name.match(/^(.+?)\s*\((\d+)\)$/)) ) { name = m[1]; quantity = Number(m[2]); }
  // Plural "Daggers" → "Dagger" is handled at lookup time.
  return { name: cleanName(name), quantity };
}

function parseCurrency(text) {
  const out = {};
  for ( const c of CURRENCIES ) {
    const m = String(text).match(new RegExp(`(\\d[\\d,]*)\\s*${c}\\b`, "i"))
      ?? String(text).match(new RegExp(`\\b${c}\\s*[:=]?\\s*(\\d[\\d,]*)`, "i"));
    if ( m ) out[c] = Number(m[1].replace(/,/g, ""));
  }
  return out;
}
