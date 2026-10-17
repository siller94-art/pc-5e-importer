import { MODULE_ID } from "./constants.mjs";

/**
 * Read a character-sheet PDF in the browser and turn it into the labelled text the paste
 * parser understands ("Name: …", "Class: …", "STR 15 DEX 14 …").
 *
 * Fillable sheets (the official 5e sheet, D&D Beyond exports, most form-fillable sheets) are read
 * from their form fields. Anything else falls back to the PDF's text, line by line.
 * Uses Mozilla pdf.js, bundled with the module (lib/pdfjs, Apache 2.0).
 */

let pdfjsPromise = null;

/** Load pdf.js once, relative to this file so it works under any route prefix. */
export function loadPdfJs(base=import.meta.url) {
  // pdf.js writes globalThis.pdfjsLib as it loads; put back whatever another module had there.
  const had = Object.hasOwn(globalThis, "pdfjsLib");
  const previous = globalThis.pdfjsLib;
  pdfjsPromise ??= import(new URL("../lib/pdfjs/pdf.mjs", base).href).then(pdfjs => {
    if ( had ) globalThis.pdfjsLib = previous;
    else delete globalThis.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../lib/pdfjs/pdf.worker.mjs", base).href;
    return pdfjs;
  }).catch(err => { pdfjsPromise = null; throw err; });
  return pdfjsPromise;
}

/**
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<{text: string, source: "form"|"text"|"empty", fields: number, pages: number}>}
 */
export async function readCharacterPdf(data, { pdfjs }={}) {
  pdfjs ??= await loadPdfJs();
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true }).promise;
  try {
    const fields = await readFields(doc);
    const fromForm = fieldsToText(fields);
    if ( fromForm.lines >= 2 ) {
      return { text: fromForm.text, source: "form", fields: Object.keys(fields).length, pages: doc.numPages };
    }
    const text = await readText(doc);
    return { text, source: text.trim() ? "text" : "empty", fields: Object.keys(fields).length, pages: doc.numPages };
  } finally {
    doc.destroy?.();
  }
}

/* -------------------------------------------- */
/*  Form fields                                 */
/* -------------------------------------------- */

const norm = k => String(k ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** @returns {Promise<Record<string, string>>} normalised field name → value (non-empty only) */
async function readFields(doc) {
  const out = {};
  let objects = null;
  try { objects = await doc.getFieldObjects?.(); } catch { objects = null; }
  if ( objects ) {
    for ( const [name, list] of Object.entries(objects) ) {
      for ( const f of list ?? [] ) addField(out, name, f.value ?? f.defaultValue, f.type);
    }
  }
  // Older/odd PDFs: fall back to widget annotations.
  if ( !Object.keys(out).length ) {
    for ( let p = 1; p <= doc.numPages; p++ ) {
      const page = await doc.getPage(p);
      for ( const a of await page.getAnnotations() ) {
        if ( a.subtype === "Widget" && a.fieldName ) addField(out, a.fieldName, a.fieldValue, a.fieldType);
      }
    }
  }
  return out;
}

function addField(out, name, value, type) {
  if ( value == null ) return;
  if ( Array.isArray(value) ) value = value.join(", ");
  value = String(value).replace(/\r/g, "\n").trim();
  if ( !value || value === "Off" || value === "--" ) return;
  const key = norm(name);
  if ( !key || out[key] ) return;   // first non-empty wins (e.g. name repeated on page 2)
  out[key] = (type === "checkbox" && /^(yes|on|true|1)$/i.test(value)) ? "Yes" : value;
}

const FIRST = (f, keys) => { for ( const k of keys ) if ( f[k] ) return f[k]; return ""; };
const oneLine = s => String(s ?? "").replace(/\s*\n\s*/g, ", ").replace(/\s+/g, " ")
  .replace(/^[\s,;]+|[\s,;]+$/g, "").replace(/(,\s*){2,}/g, ", ").trim();

const ABILITY_KEYS = {
  STR: ["str", "strength", "strscore"], DEX: ["dex", "dexterity", "dexscore"],
  CON: ["con", "constitution", "conscore"], INT: ["int", "intelligence", "intscore"],
  WIS: ["wis", "wisdom", "wisscore"], CHA: ["cha", "charisma", "chascore"]
};
const SKILLS = ["acrobatics", "animal handling", "arcana", "athletics", "deception", "history", "insight",
  "intimidation", "investigation", "medicine", "nature", "perception", "performance", "persuasion",
  "religion", "sleight of hand", "stealth", "survival"];

/** Turn the sheet's fields into parser-ready labelled lines. */
export function fieldsToText(f) {
  const lines = [];
  const add = (label, value) => { value = oneLine(value); if ( value ) lines.push(`${label}: ${value}`); };

  add("Name", FIRST(f, ["charactername", "name", "charactername2", "pcname"]));
  add("Species", FIRST(f, ["species", "race", "racesubrace", "speciessubspecies", "racespecies", "lineage"]));
  add("Background", FIRST(f, ["background", "backgroundname"]));
  add("Class", FIRST(f, ["classlevel", "classandlevel", "classlevels", "class", "classes"]));

  const scores = [];
  for ( const [abbr, keys] of Object.entries(ABILITY_KEYS) ) {
    const n = parseInt(FIRST(f, keys));
    if ( n >= 1 && n <= 30 ) scores.push(`${abbr} ${n}`);
  }
  if ( scores.length >= 3 ) lines.push(scores.join(" "));

  // Skills: "<Skill>Prof" style markers (D&D Beyond); "E" means expertise.
  const skills = [];
  for ( const s of SKILLS ) {
    const mark = FIRST(f, [`${norm(s)}prof`, `${norm(s)}proficiency`, `${norm(s)}proficient`]);
    if ( !mark ) continue;
    skills.push(/^e/i.test(mark) ? `${titleCase(s)}*` : titleCase(s));
  }
  if ( skills.length ) add("Skills", skills.join(", "));

  // Proficiencies & languages block: "=== ARMOR ===" sections (D&D Beyond) or free text.
  const profs = FIRST(f, ["proficiencieslang", "otherproficienciesandlanguages", "proficienciesandlanguages",
    "otherproficiencies", "proficiencies"]);
  if ( profs ) lines.push(...sectionedText(profs, { armor: "Armor", weapon: "Weapons", tool: "Tools", language: "Languages" }));
  else if ( f.languages ) add("Languages", f.languages);

  add("Senses", FIRST(f, ["additionalsenses", "senses"]));

  // Feats from the features block: a "FEATS" heading followed by "* Name" lines.
  const features = Object.keys(f).filter(k => /^(featurestraits|featuresandtraits|features|feats)\d*$/.test(k))
    .sort().map(k => f[k]).join("\n");
  const feats = featsFrom(features);
  if ( feats.length ) add("Feats", feats.join(", "));

  // Equipment: one block, or numbered name/quantity rows.
  const eq = [];
  const rows = Object.keys(f).map(k => k.match(/^eq(?:uipment)?name(\d+)$/)).filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  for ( const [key, i] of rows ) {
    const qty = parseInt(f[`eqqty${i}`] ?? f[`equipmentqty${i}`] ?? f[`eqquantity${i}`]) || 1;
    eq.push(qty > 1 ? `${qty} ${oneLine(f[key])}` : oneLine(f[key]));
  }
  if ( !eq.length && f.equipment ) eq.push(...f.equipment.split(/\n|,|;/).map(s => s.trim()).filter(Boolean));
  if ( eq.length ) add("Equipment", eq.join(", "));

  // Spells: "Spells 1014…" (official sheet) or "spellName0…" (D&D Beyond).
  const spellKeys = Object.keys(f).filter(k => /^(spells?\d+|spellname\d+|cantrips?\d+)$/.test(k))
    .sort((a, b) => (parseInt(a.replace(/\D/g, "")) || 0) - (parseInt(b.replace(/\D/g, "")) || 0));
  const spells = [...new Set(spellKeys.map(k => cleanSpell(f[k])).filter(Boolean))];
  if ( spells.length ) add("Spells", spells.join(", "));

  const coins = ["pp", "gp", "ep", "sp", "cp"].map(c => [c, parseInt(String(f[c] ?? "").replace(/,/g, ""))])
    .filter(([, n]) => n > 0).map(([c, n]) => `${n} ${c}`);
  if ( coins.length ) add("Currency", coins.join(", "));

  return { text: lines.join("\n"), lines: lines.length };
}

function sectionedText(text, headings) {
  const out = [];
  const parts = String(text).split(/={2,}\s*([A-Z &]+?)\s*={2,}/);
  if ( parts.length > 1 ) {
    for ( let i = 1; i < parts.length; i += 2 ) {
      const head = parts[i].toLowerCase();
      const label = Object.entries(headings).find(([k]) => head.includes(k))?.[1];
      const body = oneLine(parts[i + 1]);
      if ( label && body ) out.push(`${label}: ${body}`);
    }
    return out;
  }
  // Free text: keep labelled lines ("Languages: …", "Armor: …").
  return String(text).split(/\n/).map(s => s.trim()).filter(s => /^[a-z ]+:/i.test(s)).map(oneLine);
}

function featsFrom(text) {
  const m = String(text).split(/={2,}\s*([A-Z &]+?)\s*={2,}/);
  for ( let i = 1; i < m.length; i += 2 ) {
    if ( !/\bfeats?\b/i.test(m[i]) ) continue;   // "FEATS", not "WIZARD FEATURES"
    return m[i + 1].split(/\n/).map(s => s.trim()).filter(s => /^[*•\-]/.test(s))
      .map(s => s.replace(/^[*•\-]\s*/, "").split(/\s+[•|]\s+/)[0].replace(/\s*\(.*?\)\s*$/, "").trim())
      .filter(Boolean);
  }
  return [];
}

function cleanSpell(s) {
  return oneLine(s).replace(/^[•*\-]\s*/, "").replace(/\s*\[.*?\]\s*$/, "").replace(/\s*\((?:R|C|ritual|concentration)\)\s*$/i, "").trim();
}

function titleCase(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }

/* -------------------------------------------- */
/*  Plain text                                  */
/* -------------------------------------------- */

/** Rebuild reading-order lines from the PDF's text runs. */
async function readText(doc) {
  const out = [];
  for ( let p = 1; p <= doc.numPages; p++ ) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = [];
    for ( const item of content.items ) {
      if ( !item.str?.trim() ) continue;
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      let row = rows.find(r => Math.abs(r.y - y) <= 2);
      if ( !row ) rows.push(row = { y, parts: [] });
      row.parts.push({ x, s: item.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for ( const r of rows ) out.push(r.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(" ").replace(/\s+/g, " ").trim());
    page.cleanup?.();
  }
  return out.filter(Boolean).join("\n");
}

export function logPdf(result, name) {
  console.log(`${MODULE_ID} | Read ${name}: ${result.source}, ${result.fields} fields, ${result.pages} pages`);
}
